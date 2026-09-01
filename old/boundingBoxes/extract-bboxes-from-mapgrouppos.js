import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import pLimit from "p-limit";

// -------------------- HARD-CODED PATHS --------------------
const MAPGROUPPOS_PATH = path.resolve("./data/mapgrouppos_complete.xml"); // small test file is fine
const DEP3D_EXE = "C:\\Program Files (x86)\\Mikero\\DePboTools\\bin\\DeP3d.exe";
const DZ_ROOT = "D:\\DayZ Projects\\DZ";
const OUT_DIR = path.resolve("./out");
// ----------------------------------------------------------

const OUT_BBOX = path.join(OUT_DIR, "bboxCache.byClassName.json");
const OUT_MISSES = path.join(OUT_DIR, "bboxCache.misses.json");
const OUT_ERRORS = path.join(OUT_DIR, "bboxCache.errors.json");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function readText(p) {
  return fs.readFileSync(p, "utf8");
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

/** Line-scan: works even if file isn't valid XML */
function extractGroupNamesFromMapGroupPos(text) {
  const re = /<group\b[^>]*\bname="([^"]+)"/gi;
  const names = new Set();
  let m;
  while ((m = re.exec(text)) !== null) names.add(m[1]);
  return [...names];
}

/** Index all .p3d by basename stem: "misc_feedshack" -> full path(s) */
function indexP3DsByStem(rootDir) {
  const index = new Map();
  const stack = [rootDir];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".p3d")) {
        const stem = path.parse(ent.name).name.toLowerCase();
        if (!index.has(stem)) index.set(stem, []);
        index.get(stem).push(full);
      }
    }
  }

  return index;
}

/** Heuristic: generate candidate stems from a classname like Land_Misc_FeedShack */
function candidateStemsFromClassName(className) {
  const raw = String(className).trim();
  const parts = raw.split("_").filter(Boolean);
  const partsLower = parts.map((p) => p.toLowerCase());

  const dropPrefixes = new Set([
    "land",
    "house",
    "wreck",
    "ruin",
    "bld",
    "bldg",
  ]);
  const noPrefix = partsLower.filter((p) => !dropPrefixes.has(p));

  const c = new Set();

  // full and no-prefix
  c.add(partsLower.join("_")); // land_misc_feedshack
  if (noPrefix.length) c.add(noPrefix.join("_")); // misc_feedshack

  // last 2, last 1
  if (noPrefix.length >= 2) c.add(noPrefix.slice(-2).join("_")); // misc_feedshack
  if (noPrefix.length >= 1) c.add(noPrefix.slice(-1).join("_")); // feedshack

  // drop misc if present
  if (noPrefix[0] === "misc" && noPrefix.length >= 2)
    c.add(noPrefix.slice(1).join("_")); // feedshack

  // collapsed (rare but cheap)
  c.add(raw.toLowerCase().replace(/[^a-z0-9_]/g, ""));
  c.add(raw.toLowerCase().replace(/[^a-z0-9]/g, "")); // landmiscfeedshack

  return [...c];
}

/** Pick best candidate path when multiple .p3d share stem */
function pickBestCandidate(candidates) {
  if (candidates.length === 1) return candidates[0];

  return candidates
    .map((p) => {
      const pl = p.toLowerCase();
      let score = 0;
      if (pl.includes("\\structures\\")) score += 50;
      if (pl.includes("\\residential\\")) score += 10;
      score += Math.max(0, 250 - pl.length);
      return { p, score };
    })
    .sort((a, b) => b.score - a.score)[0].p;
}

function runDep3d(modelPath) {
  return new Promise((resolve) => {
    const child = spawn(DEP3D_EXE, ["-P", "-LB", modelPath], {
      windowsHide: true,
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function parseBBox(output) {
  const lines = output.replace(/\r/g, "").split("\n");
  const float3 =
    /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)[,\s]+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)[,\s]+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i;

  let min = null;
  let max = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const low = line.toLowerCase();

    if (!min && low.includes("min")) {
      const m = line.match(float3);
      if (m) min = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    if (!max && low.includes("max")) {
      const m = line.match(float3);
      if (m) max = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
  }

  if (!min || !max) return null;

  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ],
  };
}

// -------------------- MAIN --------------------
(async () => {
  ensureDir(OUT_DIR);

  if (!fs.existsSync(DZ_ROOT)) {
    console.error("DZ_ROOT does not exist:", DZ_ROOT);
    process.exit(1);
  }
  if (!fs.existsSync(DEP3D_EXE)) {
    console.error("DEP3D_EXE does not exist:", DEP3D_EXE);
    process.exit(1);
  }
  if (!fs.existsSync(MAPGROUPPOS_PATH)) {
    console.error("MAPGROUPPOS_PATH does not exist:", MAPGROUPPOS_PATH);
    process.exit(1);
  }

  const existing = fs.existsSync(OUT_BBOX)
    ? JSON.parse(fs.readFileSync(OUT_BBOX, "utf8"))
    : {};
  const misses = fs.existsSync(OUT_MISSES)
    ? JSON.parse(fs.readFileSync(OUT_MISSES, "utf8"))
    : {};
  const errors = fs.existsSync(OUT_ERRORS)
    ? JSON.parse(fs.readFileSync(OUT_ERRORS, "utf8"))
    : {};

  console.log("Parsing mapgrouppos (line scan)...");
  const text = readText(MAPGROUPPOS_PATH);
  const classNames = extractGroupNamesFromMapGroupPos(text);

  console.log(`Unique class names: ${classNames.length}`);
  console.log("Class names:", classNames);

  console.log("Indexing DZ .p3d by stem...");
  const p3dIndex = indexP3DsByStem(DZ_ROOT);
  console.log(`Indexed ${p3dIndex.size} unique .p3d stems`);
  // quick sanity peek
  console.log("Sample stems:", [...p3dIndex.keys()].slice(0, 10));

  const limit = pLimit(2);

  await Promise.all(
    classNames.map((className) =>
      limit(async () => {
        if (existing[className] || misses[className] || errors[className]) {
          console.log(`[SKIP] ${className} already processed`);
          return;
        }

        const stems = candidateStemsFromClassName(className);

        let candidates = null;
        let usedStem = null;

        for (const stem of stems) {
          const hit = p3dIndex.get(stem);
          if (hit && hit.length) {
            candidates = hit;
            usedStem = stem;
            break;
          }
        }

        console.log(`\n[LOOKUP] ${className}`);
        console.log(`  tried stems: ${stems.join(", ")}`);

        if (!candidates) {
          console.log("  ❌ no match");
          misses[className] = { reason: "P3D_NOT_FOUND", triedStems: stems };
          return;
        }

        const modelPath = pickBestCandidate(candidates);
        console.log(`  ✅ matched stem: ${usedStem}`);
        console.log(`  ✅ modelPath: ${modelPath}`);

        const { code, out, err } = await runDep3d(modelPath);
        const bbox = parseBBox(out);

        if (!bbox) {
          console.log("  ⚠️ DeP3d ran but bbox parse failed");
          errors[className] = {
            reason: "BBOX_PARSE_FAILED",
            modelPath,
            matchedStem: usedStem,
            exitCode: code,
            stdoutTail: out.slice(-1500),
            stderrTail: err.slice(-1500),
          };
          return;
        }

        existing[className] = {
          className,
          modelPath,
          matchedStem: usedStem,
          ...bbox,
        };

        console.log(
          `  📦 bbox size: ${bbox.size.map((n) => n.toFixed(3)).join(", ")}`
        );
      })
    )
  );

  writeJson(OUT_BBOX, existing);
  writeJson(OUT_MISSES, misses);
  writeJson(OUT_ERRORS, errors);

  console.log("\nDONE");
})();
