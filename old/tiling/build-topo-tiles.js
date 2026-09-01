// Variant of build-tiles.js that bakes the elevation-contour "topographic"
// background (topo-index.js) in as the base of every tile, underneath the
// same Map Objects categories - i.e. a flat raster version of what
// map-with-contours.html shows live as displayTopographic() + vectorTileLayer,
// for embedding as a single tile source (JinieBotInterface's "Top" layer has
// no separate base/overlay compositing - one PNG per tile).
//
// Usage:
//   node tools/tiling/build-topo-tiles.js [--native-zoom 7] [--out out/tiles/topo]
//                                          [--only cat1,cat2] [--skip cat3]

const path = require('path');
const fs = require('fs');
const { loadStyleConfig } = require('./style-config-loader');
const { buildPointIndex } = require('./point-index');
const { buildPolygonIndex } = require('./polygon-index');
const { buildCategoryStyles, renderNativeTile } = require('./render-tile');
const { buildOverviewLevel, writeTile } = require('./build-overview');
const { tilesPerSide } = require('./coords');
const { loadElevationGrid } = require('./elevation');
const { buildTopoPolygons } = require('./topo-index');

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
  const outArg = getArg(args, '--out', 'out/tiles/topo');
  const cellSize = parseInt(getArg(args, '--cell-size', '100'), 10);
  const marginUnits = parseInt(getArg(args, '--margin', '10'), 10);
  const dark = args.includes('--dark');

  const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const skip = skipArg ? new Set(skipArg.split(',').map((s) => s.trim()).filter(Boolean)) : new Set();

  const { ROOT, mapStyles, config, bboxCache, drawingOrder: fullDrawingOrder } = loadStyleConfig();

  const drawingOrder = fullDrawingOrder.filter((name) => {
    if (only && !only.includes(name)) return false;
    if (skip.has(name)) return false;
    return true;
  });

  if (drawingOrder.length === 0) {
    console.error('[build-topo-tiles] No categories selected.');
    process.exit(1);
  }

  console.log(`[build-topo-tiles] Categories: ${drawingOrder.join(', ')}`);
  console.log(`[build-topo-tiles] Native zoom: ${nativeZoom}, cellSize: ${cellSize}, margin: ${marginUnits}`);

  const outDir = path.isAbsolute(outArg) ? outArg : path.join(ROOT, outArg);
  fs.mkdirSync(outDir, { recursive: true });

  const topo = buildTopoPolygons(ROOT);
  // Only the topographic base (land/water fill) has a dark variant defined in
  // mapStyles.topographic - object categories (roads, buildings, trees, ...)
  // use the same colors in both modes, same as displayTopographic() in
  // map-core.js. The contour-band OUTLINE color does need its own dark
  // variant though (landStrokeDark/waterStrokeDark) - reusing the light
  // mode's muted brown/blue stroke against the dark fills leaves almost no
  // contrast, so the elevation bands become invisible and it reads as one
  // flat color instead of layered topography.
  const topoColors = dark
    ? {
        landColor: mapStyles.topographic?.landDarkColor || '#505545',
        landStroke: mapStyles.topographic?.landStrokeDark || '#A8B0A0',
        waterColor: mapStyles.topographic?.waterDarkColor || '#08316eff',
        waterStroke: mapStyles.topographic?.waterStrokeDark || '#A8B0A0',
      }
    : {
        landColor: mapStyles.topographic?.landColor || '#E6E1D2',
        landStroke: mapStyles.topographic?.landStroke || '#786E50',
        waterColor: mapStyles.topographic?.waterColor || '#97b5ffff',
        waterStroke: mapStyles.topographic?.waterStroke || '#3282C8',
      };
  console.log(`[build-topo-tiles] Mode: ${dark ? 'dark' : 'light'}`);

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
      console.warn(`[build-topo-tiles] Unknown drawType for ${name}: ${cfg.drawType}, skipping`);
    }
  }
  console.log(`[build-topo-tiles] Indexes built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const categoryStyles = buildCategoryStyles(mapStyles, drawingOrder);

  let elevGrid = null;
  try {
    elevGrid = loadElevationGrid(ROOT);
  } catch (e) {
    console.warn(`[build-topo-tiles] Elevation heightmap not loaded (${e.message}); depression water will use plain fill.`);
  }

  const n = tilesPerSide(nativeZoom);
  const totalTiles = n * n;
  console.log(`[build-topo-tiles] Rendering native zoom ${nativeZoom}: ${n}x${n} = ${totalTiles} candidate tiles`);

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
        topo,
        topoColors,
      });
      if (buf) {
        await writeTile(outDir, nativeZoom, x, y, buf);
        nativeCoords.push([x, y]);
        written++;
      }
    }
    if (y % 8 === 0 || y === n - 1) {
      const pct = (((y + 1) * n) / totalTiles * 100).toFixed(1);
      console.log(`[build-topo-tiles] row ${y + 1}/${n} (${pct}%), tiles written so far: ${written}`);
    }
  }

  console.log(
    `[build-topo-tiles] Native zoom ${nativeZoom} done: ${written}/${totalTiles} tiles written in ${(
      (Date.now() - tRenderStart) / 1000
    ).toFixed(1)}s`
  );

  const perZoomCounts = { [nativeZoom]: written };
  let childCoords = nativeCoords;
  for (let z = nativeZoom; z > 0; z--) {
    const tOv = Date.now();
    const parentCoords = await buildOverviewLevel(outDir, z, childCoords);
    perZoomCounts[z - 1] = parentCoords.length;
    console.log(
      `[build-topo-tiles] Overview zoom ${z - 1}: ${parentCoords.length} tiles in ${(
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
    hasTopoBase: true,
    dark,
    perZoomTileCounts: perZoomCounts,
  };
  fs.writeFileSync(path.join(outDir, 'tile-meta.json'), JSON.stringify(meta, null, 2));
  console.log(`[build-topo-tiles] Done. Meta written to ${path.join(outDir, 'tile-meta.json')}`);
}

main().catch((err) => {
  console.error('[build-topo-tiles] Fatal error:', err);
  process.exit(1);
});
