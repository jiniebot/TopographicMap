// CLI orchestrator for the vector-to-raster tile pipeline.
//
// Usage:
//   node tools/tiling/build-tiles.js [--native-zoom 7] [--only cat1,cat2] [--skip cat3]
//                                     [--out out/tiles/vector] [--cell-size 100] [--margin 10]
//
// Renders one native-zoom tile pyramid directly from the spatial indexes
// (point-index.js for "circle" categories, polygon-index.js for "rectangle"
// categories), then generates every coarser zoom level by compositing
// (build-overview.js) instead of re-querying geometry.

const path = require('path');
const fs = require('fs');
const { loadStyleConfig } = require('./style-config-loader');
const { buildPointIndex } = require('./point-index');
const { buildPolygonIndex } = require('./polygon-index');
const { buildCategoryStyles, renderNativeTile } = require('./render-tile');
const { buildOverviewLevel, writeTile } = require('./build-overview');
const { tilesPerSide } = require('./coords');
const { loadElevationGrid } = require('./elevation');

function getArg(args, name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const nativeZoom = parseInt(getArg(args, '--native-zoom', '7'), 10);
  const onlyArg = getArg(args, '--only', null);
  const skipArg = getArg(args, '--skip', null);
  const outArg = getArg(args, '--out', 'out/tiles/vector');
  const cellSize = parseInt(getArg(args, '--cell-size', '100'), 10);
  const marginUnits = parseInt(getArg(args, '--margin', '10'), 10);

  const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const skip = skipArg ? new Set(skipArg.split(',').map((s) => s.trim()).filter(Boolean)) : new Set();

  const { ROOT, mapStyles, config, bboxCache, drawingOrder: fullDrawingOrder } = loadStyleConfig();

  const drawingOrder = fullDrawingOrder.filter((name) => {
    if (only && !only.includes(name)) return false;
    if (skip.has(name)) return false;
    return true;
  });

  if (drawingOrder.length === 0) {
    console.error('[build-tiles] No categories selected.');
    process.exit(1);
  }

  console.log(`[build-tiles] Categories: ${drawingOrder.join(', ')}`);
  console.log(`[build-tiles] Native zoom: ${nativeZoom}, cellSize: ${cellSize}, margin: ${marginUnits}`);

  const outDir = path.isAbsolute(outArg) ? outArg : path.join(ROOT, outArg);
  fs.mkdirSync(outDir, { recursive: true });

  // Each tile is a single flattened PNG containing every requested category composited
  // together - there is no per-category layering. Running with --only against an output
  // directory that already holds tiles from a FULLER previous build (more categories than
  // this run) would silently overwrite those tiles with an image missing everything except
  // the categories requested here. Refuse unless the caller explicitly acknowledges this.
  const metaPath = path.join(outDir, 'tile-meta.json');
  const allowPartialOverwrite = args.includes('--allow-partial-overwrite');
  if (fs.existsSync(metaPath) && !allowPartialOverwrite) {
    const prevMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const prevCategories = new Set(prevMeta.categories || []);
    const missingFromThisRun = [...prevCategories].filter((c) => !drawingOrder.includes(c));
    if (missingFromThisRun.length > 0) {
      console.error(
        `[build-tiles] REFUSING TO RUN: ${outDir} already contains tiles built with ${prevCategories.size} categories, ` +
          `but this run only includes ${drawingOrder.length}. Categories that would be silently erased from overlapping tiles: ${missingFromThisRun.join(', ')}.\n` +
          `Either omit --only to rebuild all categories, target a fresh --out directory, or pass --allow-partial-overwrite if this is intentional.`
      );
      process.exit(1);
    }
  }

  // Build spatial indexes
  const pointIndexes = {};
  const polygonIndexes = {};
  const t0 = Date.now();
  for (const name of drawingOrder) {
    const cfg = mapStyles.categories[name];
    if (cfg.drawType === 'circle') {
      pointIndexes[name] = await buildPointIndex(name, cfg, { ROOT, bboxCache, cellSize, mapSize: config.mapSize });
    } else if (cfg.drawType === 'rectangle') {
      polygonIndexes[name] = await buildPolygonIndex(name, { ROOT, cellSize, mapSize: config.mapSize });
    } else {
      console.warn(`[build-tiles] Unknown drawType for ${name}: ${cfg.drawType}, skipping`);
    }
  }
  console.log(`[build-tiles] Indexes built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const categoryStyles = buildCategoryStyles(mapStyles, drawingOrder);

  // Only needed for terrain-masked depression water (ponds/lakes) - load once
  // if the heightmap is available; render-tile.js falls back to a plain fill
  // for masked features when this is null (e.g. water category not requested).
  let elevGrid = null;
  try {
    elevGrid = loadElevationGrid(ROOT);
  } catch (e) {
    console.warn(`[build-tiles] Elevation heightmap not loaded (${e.message}); depression water will use plain fill.`);
  }

  // Render native zoom
  const n = tilesPerSide(nativeZoom);
  const totalTiles = n * n;
  console.log(`[build-tiles] Rendering native zoom ${nativeZoom}: ${n}x${n} = ${totalTiles} candidate tiles`);

  const nativeCoords = [];
  let written = 0;
  const tRenderStart = Date.now();

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const buf = renderNativeTile(nativeZoom, x, y, {
        config,
        drawingOrder,
        categoryStyles,
        pointIndexes,
        polygonIndexes,
        marginUnits,
        elevGrid,
      });
      if (buf) {
        await writeTile(outDir, nativeZoom, x, y, buf);
        nativeCoords.push([x, y]);
        written++;
      }
    }
    if (y % 8 === 0 || y === n - 1) {
      const pct = (((y + 1) * n) / totalTiles * 100).toFixed(1);
      console.log(`[build-tiles] row ${y + 1}/${n} (${pct}%), tiles written so far: ${written}`);
    }
  }

  console.log(
    `[build-tiles] Native zoom ${nativeZoom} done: ${written}/${totalTiles} tiles written in ${(
      (Date.now() - tRenderStart) / 1000
    ).toFixed(1)}s`
  );

  // Overview pyramid
  const perZoomCounts = { [nativeZoom]: written };
  let childCoords = nativeCoords;
  for (let z = nativeZoom; z > 0; z--) {
    const tOv = Date.now();
    const parentCoords = await buildOverviewLevel(outDir, z, childCoords);
    perZoomCounts[z - 1] = parentCoords.length;
    console.log(
      `[build-tiles] Overview zoom ${z - 1}: ${parentCoords.length} tiles in ${(
        (Date.now() - tOv) / 1000
      ).toFixed(1)}s`
    );
    childCoords = parentCoords;
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    nativeZoom,
    categories: drawingOrder,
    cellSize,
    marginUnits,
    perZoomTileCounts: perZoomCounts,
  };
  fs.writeFileSync(path.join(outDir, 'tile-meta.json'), JSON.stringify(meta, null, 2));
  console.log(`[build-tiles] Done. Meta written to ${path.join(outDir, 'tile-meta.json')}`);
}

main().catch((err) => {
  console.error('[build-tiles] Fatal error:', err);
  process.exit(1);
});
