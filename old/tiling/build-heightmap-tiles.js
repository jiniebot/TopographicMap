// Builds a height-map-only tile pyramid (elevation-contour base, no Map
// Objects) for any map defined in tools/map-config.js - unlike
// build-topo-tiles.js, this doesn't need any object-placement CSVs, so it
// works for maps we only have a heightmap for so far (Sakhal/Livonia).
// Once object data exists for a map, build-topo-tiles.js/--map can take
// over for the combined base+objects pyramid.
//
// Usage:
//   node tools/tiling/build-heightmap-tiles.js --map sakhal [--dark] [--native-zoom 7] [--out out/tiles/sakhal-topo]

const path = require('path');
const fs = require('fs');
const { loadStyleConfig } = require('./style-config-loader');
const { renderNativeTile } = require('./render-tile');
const { buildOverviewLevel, writeTile } = require('./build-overview');
const { tilesPerSide } = require('./coords');
const { buildTopoPolygons } = require('./topo-index');
const { MAP_CONFIGS } = require('../map-config');

function getArg(args, name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const mapName = getArg(args, '--map', null);
  if (!mapName || !MAP_CONFIGS[mapName]) {
    console.error(`[build-heightmap-tiles] --map is required and must be one of: ${Object.keys(MAP_CONFIGS).join(', ')}`);
    process.exit(1);
  }
  const mapCfg = MAP_CONFIGS[mapName];
  const dark = args.includes('--dark');
  const nativeZoom = parseInt(getArg(args, '--native-zoom', '7'), 10);
  const outArg = getArg(args, '--out', `out/tiles/${mapName}-topo${dark ? '-dark' : ''}`);

  const { ROOT, mapStyles, config: baseConfig } = loadStyleConfig();
  // Override mapSize for this map - config.js is Chernarus-hardcoded (the
  // only map with object-category data so far), but the coordinate math
  // (localToPixel/worldPxAtZoom/etc.) is otherwise map-agnostic.
  const config = { ...baseConfig, mapSize: mapCfg.mapSize };

  const outDir = path.isAbsolute(outArg) ? outArg : path.join(ROOT, outArg);
  fs.mkdirSync(outDir, { recursive: true });

  const topo = buildTopoPolygons(ROOT, mapCfg.contoursFile);
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
  console.log(`[build-heightmap-tiles] Map: ${mapName} (mapSize ${mapCfg.mapSize}, waterElevCutoff ${mapCfg.waterElevCutoff}), mode: ${dark ? 'dark' : 'light'}, out: ${outDir}`);

  const n = tilesPerSide(nativeZoom);
  const totalTiles = n * n;
  console.log(`[build-heightmap-tiles] Rendering native zoom ${nativeZoom}: ${n}x${n} = ${totalTiles} candidate tiles`);

  const nativeCoords = [];
  let written = 0;
  const tRenderStart = Date.now();

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const buf = renderNativeTile(nativeZoom, x, y, {
        config,
        drawingOrder: [],
        categoryStyles: {},
        pointIndexes: {},
        polygonIndexes: {},
        topo,
        topoColors,
        topoWaterElevCutoff: mapCfg.waterElevCutoff,
      });
      if (buf) {
        await writeTile(outDir, nativeZoom, x, y, buf);
        nativeCoords.push([x, y]);
        written++;
      }
    }
    if (y % 8 === 0 || y === n - 1) {
      const pct = (((y + 1) * n) / totalTiles * 100).toFixed(1);
      console.log(`[build-heightmap-tiles] row ${y + 1}/${n} (${pct}%), tiles written so far: ${written}`);
    }
  }

  console.log(
    `[build-heightmap-tiles] Native zoom ${nativeZoom} done: ${written}/${totalTiles} tiles written in ${(
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
      `[build-heightmap-tiles] Overview zoom ${z - 1}: ${parentCoords.length} tiles in ${(
        (Date.now() - tOv) / 1000
      ).toFixed(1)}s`
    );
    childCoords = parentCoords;
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    map: mapName,
    mapSize: mapCfg.mapSize,
    waterElevCutoff: mapCfg.waterElevCutoff,
    nativeZoom,
    dark,
    hasObjects: false,
    perZoomTileCounts: perZoomCounts,
  };
  fs.writeFileSync(path.join(outDir, 'tile-meta.json'), JSON.stringify(meta, null, 2));
  console.log(`[build-heightmap-tiles] Done. Meta written to ${path.join(outDir, 'tile-meta.json')}`);
}

main().catch((err) => {
  console.error('[build-heightmap-tiles] Fatal error:', err);
  process.exit(1);
});
