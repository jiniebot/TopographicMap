#!/usr/bin/env node

// Concurrent full production tile renderer. Each worker renders complete tile
// stacks and emits structured status events consumed by the local web UI.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { loadMapManifest, PROJECT_ROOT } = require("./map-build-config");
const RENDER_VERSION = "shared-topographic-v1";
const SURFACE_VERSION = "terrainx-effective-six-channel-palette-v18";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}
function status(value) {
  console.log(
    `@@FINAL_STATUS ${JSON.stringify({ mapId: manifest.id, ...value })}`,
  );
}
function run(script, args, context) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, script), ...args],
      { cwd: PROJECT_ROOT, windowsHide: true },
    );
    const consume = (stream) => {
      let pending = "";
      stream.on("data", (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines)
          if (line)
            console.log(
              `@@FINAL_CHILD ${JSON.stringify({ ...context, line })}`,
            );
      });
      stream.on("end", () => {
        if (pending)
          console.log(
            `@@FINAL_CHILD ${JSON.stringify({ ...context, line: pending })}`,
          );
      });
    };
    consume(child.stdout);
    consume(child.stderr);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${script} failed with exit code ${code}`)),
    );
  });
}
function copyIfPresent(source, target) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}
function writeStyles(output) {
  const styleFile = path.join(
    PROJECT_ROOT,
    "configs",
    "styles",
    `${manifest.id}.json`,
  );
  let variants = { light: {}, dark: {} };
  if (fs.existsSync(styleFile)) {
    const profile = JSON.parse(fs.readFileSync(styleFile, "utf8"));
    variants = profile.variants || {
      light: profile.colors || {},
      dark: profile.colors || {},
    };
  }
  const dir = path.join(output, "styles");
  fs.mkdirSync(dir, { recursive: true });
  for (const variant of ["light", "dark"])
    fs.writeFileSync(
      path.join(dir, `topographic-${variant}.json`),
      `${JSON.stringify({ variant, colors: variants[variant] || {} }, null, 2)}\n`,
    );
}

const manifest = loadMapManifest(arg("--manifest"));
const version = arg("--version"),
  zooms = arg("--zooms", "").split(",").filter(Boolean).map(Number),
  modes = arg("--modes", "").split(",").filter(Boolean);
const requestedWorkers = Number(
  arg(
    "--workers",
    Math.max(
      1,
      Math.min(6, (os.availableParallelism?.() || os.cpus().length) - 2),
    ),
  ),
);
const forceLayers = arg("--layers", "").split(",").filter(Boolean);
const resume = process.argv.includes("--resume");
// With --layers set, only queue tiles where at least one forced layer's
// output file is actually absent on disk - lets a targeted run repair
// specific holes (e.g. one missing low-zoom tile) without re-rendering an
// entire zoom level's worth of tiles that already have valid output.
// Requires --layers; meaningless (and ignored) without it.
const missingOnly = process.argv.includes("--missing-only");
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version))
  throw new Error("Invalid version");
if (!zooms.length || zooms.some((z) => !Number.isInteger(z) || z < 0 || z > 8))
  throw new Error("Invalid zoom selection");
if (
  !modes.length ||
  modes.some((mode) => !["satellite", "topographic"].includes(mode))
)
  throw new Error("Invalid mode selection");
if (
  !Number.isInteger(requestedWorkers) ||
  requestedWorkers < 1 ||
  requestedWorkers > 16
)
  throw new Error("Workers must be between 1 and 16");
if (
  forceLayers.some(
    (layer) => !["terrain", "surfaces", "water", "objects"].includes(layer),
  )
)
  throw new Error("Invalid topographic layer selection");
const output = path.join(
    PROJECT_ROOT,
    "out",
    "mapdraw",
    "final",
    manifest.id,
    version,
  ),
  work = path.join(output, ".work");
const wantsSatellite = modes.includes("satellite"),
  wantsTopographic = modes.includes("topographic"),
  topoModes = wantsTopographic ? ["topographic"] : [];
const stateFile = path.join(output, "render-state.json");
let renderState;
function saveState() {
  renderState.updatedAt = new Date().toISOString();
  fs.mkdirSync(output, { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(renderState, null, 2)}\n`);
  try {
    fs.renameSync(temp, stateFile);
  } catch {
    fs.copyFileSync(temp, stateFile);
    fs.rmSync(temp, { force: true });
  }
}
if (resume && fs.existsSync(stateFile)) {
  renderState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (renderState.mapId !== manifest.id || renderState.version !== version)
    throw new Error("Existing render state does not match this map/version");
} else
  renderState = {
    schemaVersion: 1,
    mapId: manifest.id,
    version,
    createdAt: new Date().toISOString(),
    completed: {},
    failures: {},
  };
renderState.renderVersion = RENDER_VERSION;
renderState.surfaceCompleted = renderState.surfaceCompleted || {};
renderState.request = { zooms, modes, requestedWorkers, layers: forceLayers };
if (wantsTopographic) writeStyles(output);
const tasks = [];
const completionKey = (zoom, tx, ty, mode) => `${zoom}/${tx}/${ty}/${mode}`;
for (const zoom of zooms) {
  const side = 2 ** zoom;
  if (!resume)
    for (const mode of modes) {
      if (mode === "satellite")
        fs.rmSync(path.join(output, mode, String(zoom)), {
          recursive: true,
          force: true,
        });
      else
        for (const layer of ["terrain", "surfaces", "water", "objects"])
          fs.rmSync(path.join(output, mode, layer, String(zoom)), {
            recursive: true,
            force: true,
          });
    }
  for (let ty = 0; ty < side; ty++)
    for (let tx = 0; tx < side; tx++) {
      if (forceLayers.length && missingOnly) {
        const anyLayerMissing = forceLayers.some(
          (layer) =>
            !fs.existsSync(
              path.join(
                output,
                "topographic",
                layer,
                String(zoom),
                String(tx),
                `${ty}.pbf`,
              ),
            ),
        );
        if (anyLayerMissing) tasks.push({ zoom, tx, ty });
        continue;
      }
      if (
        forceLayers.length ||
        modes.some(
          (mode) => !renderState.completed[completionKey(zoom, tx, ty, mode)],
        ) ||
        (wantsTopographic &&
          renderState.surfaceCompleted[
            completionKey(zoom, tx, ty, "surfaces")
          ] !== SURFACE_VERSION)
      )
        tasks.push({ zoom, tx, ty });
    }
}
for (const key of Object.keys(renderState.failures))
  if (
    modes.some((mode) => key.endsWith(`/${mode}`)) ||
    (forceLayers.length && key.includes("/layers:"))
  )
    delete renderState.failures[key];
saveState();
const resumedByMode = Object.fromEntries(
  modes.map((mode) => [
    mode,
    zooms.reduce((count, zoom) => {
      const side = 2 ** zoom;
      for (let y = 0; y < side; y++)
        for (let x = 0; x < side; x++)
          if (renderState.completed[completionKey(zoom, x, y, mode)]) count++;
      return count;
    }, 0),
  ]),
);
console.log(
  `@@FINAL_RESUME ${JSON.stringify({ resumedByMode, remainingTiles: tasks.length })}`,
);

async function refreshSurface({
  zoom,
  tx,
  ty,
  tileMeters,
  centerX,
  centerZ,
  tileWork,
  context,
}) {
  const surfaceWork = path.join(tileWork, "surface-refresh"),
    geojson = path.join(surfaceWork, "surfaces.geojson"),
    tiles = path.join(surfaceWork, "tiles"),
    cell = Math.max(2, manifest.mapSize / (256 * 2 ** zoom));
  fs.mkdirSync(surfaceWork, { recursive: true });
  status({
    ...context,
    mode: "topographic",
    stage: "surfaces",
    label: "Refreshing seamless terrain surfaces only",
    completed: 0,
    total: 2,
  });
  await run(
    "vectorize-wrp-surface-section.js",
    [
      "--manifest",
      manifest.manifestPath,
      "--x",
      String(centerX),
      "--z",
      String(centerZ),
      "--meters",
      String(tileMeters),
      "--out",
      geojson,
      "--cell",
      String(cell),
    ],
    { ...context, mode: "topographic" },
  );
  const half = tileMeters / 2,
    bounds = [
      centerX - half,
      centerZ - half,
      centerX + half,
      centerZ + half,
    ].join(",");
  status({
    ...context,
    mode: "topographic",
    stage: "surfaces",
    label: "Encoding seamless terrain surface PBF",
    completed: 1,
    total: 2,
  });
  await run(
    "build-local-mvt.js",
    [
      "--input",
      geojson,
      "--out",
      tiles,
      "--layer",
      "surfaces",
      "--map-size",
      String(manifest.mapSize),
      "--min-zoom",
      String(zoom),
      "--max-zoom",
      String(zoom),
      "--bounds",
      bounds,
    ],
    { ...context, mode: "topographic" },
  );
  const target = path.join(
    output,
    "topographic",
    "surfaces",
    String(zoom),
    String(tx),
    `${ty}.pbf`,
  );
  fs.rmSync(target, { force: true });
  copyIfPresent(
    path.join(tiles, String(zoom), String(tx), `${ty}.pbf`),
    target,
  );
  renderState.surfaceCompleted[completionKey(zoom, tx, ty, "surfaces")] =
    SURFACE_VERSION;
  saveState();
}
async function refreshSelectedLayers(info) {
  const { zoom, tx, ty, tileMeters, centerX, centerZ, tileWork, context } =
    info;
  if (forceLayers.length === 1 && forceLayers[0] === "surfaces")
    return refreshSurface(info);
  const targeted = path.join(tileWork, "targeted-layers");
  status({
    ...context,
    mode: "topographic",
    stage: "layers",
    label: `Regenerating selected layers: ${forceLayers.join(", ")}`,
    completed: 0,
    total: forceLayers.length,
  });
  await run(
    "build-topographic-preview.js",
    [
      "--manifest",
      manifest.manifestPath,
      "--x",
      String(centerX),
      "--z",
      String(centerZ),
      "--meters",
      String(tileMeters),
      "--min-zoom",
      String(zoom),
      "--max-zoom",
      String(zoom),
      "--out",
      targeted,
    ],
    { ...context, mode: "topographic" },
  );
  for (let i = 0; i < forceLayers.length; i++) {
    const layer = forceLayers[i],
      target = path.join(
        output,
        "topographic",
        layer,
        String(zoom),
        String(tx),
        `${ty}.pbf`,
      );
    fs.rmSync(target, { force: true });
    copyIfPresent(
      path.join(targeted, layer, String(zoom), String(tx), `${ty}.pbf`),
      target,
    );
    status({
      ...context,
      mode: "topographic",
      stage: "layers",
      label: `Writing selected layer: ${layer}`,
      completed: i + 1,
      total: forceLayers.length,
    });
  }
  if (forceLayers.includes("surfaces"))
    renderState.surfaceCompleted[completionKey(zoom, tx, ty, "surfaces")] =
      SURFACE_VERSION;
  saveState();
  console.log(
    `[final-layer] ${manifest.id} topographic z${zoom}: ${tx}/${ty} ${forceLayers.join(",")}`,
  );
}

async function renderTile(task, worker) {
  const { zoom, tx, ty } = task,
    side = 2 ** zoom,
    tileMeters = manifest.mapSize / side,
    centerX = (tx + 0.5) * tileMeters,
    centerZ = manifest.mapSize - (ty + 0.5) * tileMeters,
    tileWork = path.join(work, String(zoom), String(tx), String(ty));
  const context = { worker, mapId: manifest.id, zoom, x: tx, y: ty };
  const topoPending =
      wantsTopographic &&
      !renderState.completed[completionKey(zoom, tx, ty, "topographic")],
    surfaceStale =
      wantsTopographic &&
      renderState.surfaceCompleted[completionKey(zoom, tx, ty, "surfaces")] !==
        SURFACE_VERSION;
  if (
    wantsSatellite &&
    !renderState.completed[completionKey(zoom, tx, ty, "satellite")]
  ) {
    const terrainWork = path.join(tileWork, "satellite");
    fs.mkdirSync(terrainWork, { recursive: true });
    const common = [
      "--manifest",
      manifest.manifestPath,
      "--x",
      String(centerX),
      "--z",
      String(centerZ),
      "--meters",
      String(tileMeters),
      "--size",
      "256",
    ];
    status({
      ...context,
      mode: "satellite",
      stage: "terrain",
      label: "Synthesizing satellite terrain",
      completed: 0,
      total: 256,
    });
    await run(
      "render-hires-terrain-section.js",
      [
        ...common,
        "--detail-strength",
        String(manifest.preview?.detailStrength ?? 0.5),
        "--out",
        terrainWork,
      ],
      { ...context, mode: "satellite" },
    );
    const target = path.join(
      output,
      "satellite",
      String(zoom),
      String(tx),
      `${ty}.png`,
    );
    status({
      ...context,
      mode: "satellite",
      stage: "objects",
      label: "Loading and compositing P3D objects",
      completed: 0,
      total: 1,
    });
    await run(
      "render-hires-object-section.js",
      [
        ...common,
        "--base",
        path.join(terrainWork, "enhanced.png"),
        "--out",
        target,
      ],
      { ...context, mode: "satellite" },
    );
    renderState.completed[completionKey(zoom, tx, ty, "satellite")] = {
      completedAt: new Date().toISOString(),
      file: path.relative(PROJECT_ROOT, target),
    };
    saveState();
    console.log(`[final-build] ${manifest.id} satellite z${zoom}: ${tx}/${ty}`);
  }
  if (forceLayers.length) {
    await refreshSelectedLayers({
      zoom,
      tx,
      ty,
      tileMeters,
      centerX,
      centerZ,
      tileWork,
      context,
    });
    fs.rmSync(tileWork, { recursive: true, force: true });
    status({
      ...context,
      mode: "idle",
      stage: "complete",
      label: "Selected layers complete",
      completed: 1,
      total: 1,
    });
    return;
  }
  if (!topoPending && surfaceStale)
    await refreshSurface({
      zoom,
      tx,
      ty,
      tileMeters,
      centerX,
      centerZ,
      tileWork,
      context,
    });
  if (topoPending) {
    const mode = "topographic",
      topoWork = path.join(tileWork, mode);
    status({
      ...context,
      mode,
      stage: "topographic",
      label: "Building complete topographic geometry",
      completed: 0,
      total: 7,
    });
    await run(
      "build-topographic-preview.js",
      [
        "--manifest",
        manifest.manifestPath,
        "--x",
        String(centerX),
        "--z",
        String(centerZ),
        "--meters",
        String(tileMeters),
        "--min-zoom",
        String(zoom),
        "--max-zoom",
        String(zoom),
        "--out",
        topoWork,
      ],
      { ...context, mode },
    );
    const layers = ["terrain", "surfaces", "water", "objects"],
      written = [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      status({
        ...context,
        mode,
        stage: "writing",
        label: `Writing topographic ${layer}`,
        completed: i,
        total: layers.length,
      });
      const target = path.join(
        output,
        mode,
        layer,
        String(zoom),
        String(tx),
        `${ty}.pbf`,
      );
      if (
        copyIfPresent(
          path.join(topoWork, layer, String(zoom), String(tx), `${ty}.pbf`),
          target,
        )
      )
        written.push(path.relative(PROJECT_ROOT, target));
    }
    renderState.completed[completionKey(zoom, tx, ty, mode)] = {
      completedAt: new Date().toISOString(),
      files: written,
    };
    renderState.surfaceCompleted[completionKey(zoom, tx, ty, "surfaces")] =
      SURFACE_VERSION;
    saveState();
    console.log(`[final-build] ${manifest.id} ${mode} z${zoom}: ${tx}/${ty}`);
  }
  fs.rmSync(tileWork, { recursive: true, force: true });
  status({
    ...context,
    mode: "idle",
    stage: "complete",
    label: "Tile complete",
    completed: 1,
    total: 1,
  });
}

async function runPool(poolTasks, workerCount, workerOffset) {
  let next = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async (_, index) => {
      const worker = workerOffset + index + 1;
      while (true) {
        const position = next++;
        if (position >= poolTasks.length) return;
        const task = poolTasks[position];
        try {
          await renderTile(task, worker);
        } catch (error) {
          if (forceLayers.length)
            renderState.failures[
              `${task.zoom}/${task.tx}/${task.ty}/layers:${forceLayers.join("+")}`
            ] = { failedAt: new Date().toISOString(), error: error.message };
          for (const mode of modes)
            if (
              !renderState.completed[
                completionKey(task.zoom, task.tx, task.ty, mode)
              ]
            )
              renderState.failures[
                completionKey(task.zoom, task.tx, task.ty, mode)
              ] = { failedAt: new Date().toISOString(), error: error.message };
          saveState();
          status({
            worker,
            mode: "failed",
            zoom: task.zoom,
            x: task.tx,
            y: task.ty,
            stage: "failed",
            label: "Tile failed",
            completed: 0,
            total: 1,
            error: error.message,
          });
          console.error(
            `[final-tile-failed] z${task.zoom} ${task.tx}/${task.ty}: ${error.message}`,
          );
        }
      }
    }),
  );
}
async function main() {
  // A zoom<=1 topographic tile can cover the whole map (huge object-union
  // cost, up to 8GB heap in build-vector-section.js) so that tier is capped
  // to 2 concurrent workers as a memory safety valve. That cap must only
  // apply to the zoom<=1 tasks themselves - applying it to the whole batch
  // (the previous behavior) silently throttled the 93%+ of tasks at z7/z8
  // down to 2-way parallelism any time zoom 0 or 1 was included in the same
  // run. Run the heavy tier and the rest as separate pools instead.
  const memoryHeavyTopo = topoModes.length,
    heavyTasks = memoryHeavyTopo ? tasks.filter((t) => t.zoom <= 1) : [],
    normalTasks = memoryHeavyTopo
      ? tasks.filter((t) => t.zoom > 1)
      : tasks;
  if (heavyTasks.length) {
    const heavyWorkers = Math.min(2, heavyTasks.length);
    console.log(
      `[final-workers] ${heavyWorkers} concurrent renderers for ${heavyTasks.length} zoom<=1 tiles (memory-safe low-zoom topographic cap)`,
    );
    await runPool(heavyTasks, heavyWorkers, 0);
  }
  if (normalTasks.length) {
    const normalWorkers = Math.min(
      requestedWorkers,
      Math.max(1, normalTasks.length),
    );
    console.log(
      `[final-workers] ${normalWorkers} concurrent renderers for ${normalTasks.length} remaining tiles`,
    );
    await runPool(normalTasks, normalWorkers, heavyTasks.length ? 2 : 0);
  }
  const failureKeys = Object.keys(renderState.failures);
  const summary = {
    schemaVersion: 4,
    mapId: manifest.id,
    version,
    createdAt: new Date().toISOString(),
    zooms,
    modes,
    workers: Math.min(requestedWorkers, Math.max(1, tasks.length)),
    requestedWorkers,
    completedEntries: Object.keys(renderState.completed).length,
    failedEntries: failureKeys.length,
    renderStack: [
      "enhanced-terrain",
      "surface-blending",
      "contours",
      "water",
      "all-supported-p3ds",
      "roads",
      "elevation-ordering",
    ],
  };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(
    path.join(output, "build.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  status({
    worker: 0,
    mode: "all",
    stage: "cleanup",
    label: "Finalizing version",
    completed: 0,
    total: 1,
  });
  if (!failureKeys.length) fs.rmSync(work, { recursive: true, force: true });
  status({
    worker: 0,
    mode: "all",
    stage: failureKeys.length ? "failed" : "cleanup",
    label: failureKeys.length
      ? `${failureKeys.length} tile outputs failed`
      : "Version finalized",
    completed: failureKeys.length ? 0 : 1,
    total: 1,
  });
  if (failureKeys.length)
    throw new Error(
      `${failureKeys.length} tile outputs failed; retry will resume completed work`,
    );
  console.log(`Final build ready: ${output}`);
}
main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
