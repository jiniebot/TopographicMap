// One-off targeted tile rebuild for a local-coordinate region, used to verify
// a fix quickly without waiting on a full-map rebuild. Renders every category
// (a tile is a flat composite - regenerating with a category subset would
// erase everything else already baked into those tiles) but only for the
// native tiles intersecting the region, then patches just the affected
// overview chain up to zoom 0.

const path = require('path');
const { loadStyleConfig } = require('./style-config-loader');
const { buildPointIndex } = require('./point-index');
const { buildPolygonIndex } = require('./polygon-index');
const { buildCategoryStyles, renderNativeTile } = require('./render-tile');
const { buildOverviewLevel, writeTile } = require('./build-overview');
const { localToPixel } = require('./coords');
const { loadElevationGrid } = require('./elevation');

const CX = parseFloat(process.argv[2]);
const CZ = parseFloat(process.argv[3]);
const MARGIN = parseFloat(process.argv[4] || '600');
const NATIVE_ZOOM = 7;
const OUT_DIR_ARG = process.argv[5] || 'out/tiles/vector';

(async () => {
  const { ROOT, mapStyles, config, bboxCache, drawingOrder } = loadStyleConfig();
  const outDir = path.join(ROOT, OUT_DIR_ARG);

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
  console.log(`[rebuild-region] Indexes built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  let elevGrid = null;
  try { elevGrid = loadElevationGrid(ROOT); } catch (e) { console.warn('[rebuild-region] no elevation grid:', e.message); }

  const categoryStyles = buildCategoryStyles(mapStyles, drawingOrder);

  const [px1, py1] = localToPixel(config, CX - MARGIN, CZ + MARGIN, NATIVE_ZOOM);
  const [px2, py2] = localToPixel(config, CX + MARGIN, CZ - MARGIN, NATIVE_ZOOM);
  const tx0 = Math.floor(Math.min(px1, px2) / 256), tx1 = Math.ceil(Math.max(px1, px2) / 256);
  const ty0 = Math.floor(Math.min(py1, py2) / 256), ty1 = Math.ceil(Math.max(py1, py2) / 256);
  console.log(`[rebuild-region] Native tile range: (${tx0},${ty0}) to (${tx1},${ty1})`);

  const nativeCoords = [];
  let written = 0;
  for (let x = tx0; x <= tx1; x++) {
    for (let y = ty0; y <= ty1; y++) {
      const buf = renderNativeTile(NATIVE_ZOOM, x, y, {
        config, drawingOrder, categoryStyles, pointIndexes, polygonIndexes, elevGrid,
      });
      if (buf) {
        await writeTile(outDir, NATIVE_ZOOM, x, y, buf);
        nativeCoords.push([x, y]);
        written++;
      }
    }
  }
  console.log(`[rebuild-region] Native zoom ${NATIVE_ZOOM}: ${written}/${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} tiles written`);

  let childCoords = nativeCoords;
  for (let z = NATIVE_ZOOM; z > 0; z--) {
    const parentCoords = await buildOverviewLevel(outDir, z, childCoords);
    console.log(`[rebuild-region] Overview zoom ${z - 1}: ${parentCoords.length} tiles patched`);
    childCoords = parentCoords;
  }
  console.log('[rebuild-region] Done.');
})();
