// Region-scoped variant of build-topo-tiles.js (mirrors _rebuild-region.js) -
// bakes the elevation-contour base + Map Objects into just the tiles
// intersecting a local-coordinate region, to preview/verify quickly without
// waiting on the full ~20min/16384-tile map build.
//
// Usage: node tools/tiling/_rebuild-topo-region.js <CX> <CZ> [MARGIN] [OUT_DIR] [--dark]

const path = require('path');
const { loadStyleConfig } = require('./style-config-loader');
const { buildPointIndex } = require('./point-index');
const { buildPolygonIndex } = require('./polygon-index');
const { buildCategoryStyles, renderNativeTile } = require('./render-tile');
const { buildOverviewLevel, writeTile } = require('./build-overview');
const { localToPixel } = require('./coords');
const { loadElevationGrid } = require('./elevation');
const { buildTopoPolygons } = require('./topo-index');

const args = process.argv.slice(2);
const dark = args.includes('--dark');
const positional = args.filter((a) => a !== '--dark');
const CX = parseFloat(positional[0]);
const CZ = parseFloat(positional[1]);
const MARGIN = parseFloat(positional[2] || '600');
const NATIVE_ZOOM = 7;
const OUT_DIR_ARG = positional[3] || (dark ? 'out/tiles/topo-dark' : 'out/tiles/topo');

(async () => {
  const { ROOT, mapStyles, config, bboxCache, drawingOrder } = loadStyleConfig();
  const outDir = path.join(ROOT, OUT_DIR_ARG);

  const topo = buildTopoPolygons(ROOT);
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
  console.log(`[rebuild-topo-region] Mode: ${dark ? 'dark' : 'light'}, out: ${outDir}`);

  const pointIndexes = {};
  const polygonIndexes = {};
  const t0 = Date.now();
  for (const name of drawingOrder) {
    const cfg = mapStyles.categories[name];
    if (cfg.drawType === 'circle') {
      pointIndexes[name] = await buildPointIndex(name, cfg, { ROOT, bboxCache, cellSize: 100, mapSize: config.mapSize });
    } else if (cfg.drawType === 'rectangle') {
      polygonIndexes[name] = await buildPolygonIndex(name, { ROOT, cellSize: 100, mapSize: config.mapSize });
    }
  }
  console.log(`[rebuild-topo-region] Indexes built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  let elevGrid = null;
  try { elevGrid = loadElevationGrid(ROOT); } catch (e) { console.warn('[rebuild-topo-region] no elevation grid:', e.message); }

  const categoryStyles = buildCategoryStyles(mapStyles, drawingOrder);

  const [px1, py1] = localToPixel(config, CX - MARGIN, CZ + MARGIN, NATIVE_ZOOM);
  const [px2, py2] = localToPixel(config, CX + MARGIN, CZ - MARGIN, NATIVE_ZOOM);
  const tx0 = Math.floor(Math.min(px1, px2) / 256), tx1 = Math.ceil(Math.max(px1, px2) / 256);
  const ty0 = Math.floor(Math.min(py1, py2) / 256), ty1 = Math.ceil(Math.max(py1, py2) / 256);
  console.log(`[rebuild-topo-region] Native tile range: (${tx0},${ty0}) to (${tx1},${ty1})`);

  const nativeCoords = [];
  let written = 0;
  for (let x = tx0; x <= tx1; x++) {
    for (let y = ty0; y <= ty1; y++) {
      const buf = renderNativeTile(NATIVE_ZOOM, x, y, {
        config, drawingOrder, categoryStyles, pointIndexes, polygonIndexes, elevGrid, topo, topoColors,
      });
      if (buf) {
        await writeTile(outDir, NATIVE_ZOOM, x, y, buf);
        nativeCoords.push([x, y]);
        written++;
      }
    }
  }
  console.log(`[rebuild-topo-region] Native zoom ${NATIVE_ZOOM}: ${written}/${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} tiles written`);

  let childCoords = nativeCoords;
  for (let z = NATIVE_ZOOM; z > 0; z--) {
    const parentCoords = await buildOverviewLevel(outDir, z, childCoords);
    console.log(`[rebuild-topo-region] Overview zoom ${z - 1}: ${parentCoords.length} tiles patched`);
    childCoords = parentCoords;
  }
  console.log('[rebuild-topo-region] Done.');
})();
