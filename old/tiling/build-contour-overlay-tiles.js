// Builds a transparent-background tile pyramid of JUST the elevation-contour
// band boundary lines (no fill, no Map Objects categories) - meant to be
// overlaid on TOP of an existing base layer (e.g. satellite imagery) rather
// than replacing it, unlike build-topo-tiles.js's filled land/water base.
// Much lighter than build-topo-tiles.js since it skips all 38 object-category
// spatial indexes entirely - only the ~106 contour bands are needed.
//
// Usage:
//   node tools/tiling/build-contour-overlay-tiles.js [--native-zoom 7] [--out out/tiles/contour-lines]
//                                                      [--line-width 1.5]

const path = require('path');
const fs = require('fs');
const { loadStyleConfig } = require('./style-config-loader');
const { renderNativeTile } = require('./render-tile');
const { buildOverviewLevel, writeTile } = require('./build-overview');
const { tilesPerSide } = require('./coords');
const { buildTopoPolygons } = require('./topo-index');

function getArg(args, name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const nativeZoom = parseInt(getArg(args, '--native-zoom', '7'), 10);
  const outArg = getArg(args, '--out', 'out/tiles/contour-lines');
  const lineWidth = parseFloat(getArg(args, '--line-width', '1.5'));

  const { ROOT, mapStyles, config } = loadStyleConfig();
  const outDir = path.isAbsolute(outArg) ? outArg : path.join(ROOT, outArg);
  fs.mkdirSync(outDir, { recursive: true });

  const topo = buildTopoPolygons(ROOT);
  const topoColors = {
    landStroke: mapStyles.topographic?.landStroke || '#786E50',
    waterStroke: mapStyles.topographic?.waterStroke || '#3282C8',
  };
  console.log(`[build-contour-overlay] Native zoom: ${nativeZoom}, lineWidth: ${lineWidth}, out: ${outDir}`);

  const n = tilesPerSide(nativeZoom);
  const totalTiles = n * n;
  console.log(`[build-contour-overlay] Rendering native zoom ${nativeZoom}: ${n}x${n} = ${totalTiles} candidate tiles`);

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
        topoLinesOnly: true,
        topoLineWidth: lineWidth,
      });
      if (buf) {
        await writeTile(outDir, nativeZoom, x, y, buf);
        nativeCoords.push([x, y]);
        written++;
      }
    }
    if (y % 8 === 0 || y === n - 1) {
      const pct = (((y + 1) * n) / totalTiles * 100).toFixed(1);
      console.log(`[build-contour-overlay] row ${y + 1}/${n} (${pct}%), tiles written so far: ${written}`);
    }
  }

  console.log(
    `[build-contour-overlay] Native zoom ${nativeZoom} done: ${written}/${totalTiles} tiles written in ${(
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
      `[build-contour-overlay] Overview zoom ${z - 1}: ${parentCoords.length} tiles in ${(
        (Date.now() - tOv) / 1000
      ).toFixed(1)}s`
    );
    childCoords = parentCoords;
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    nativeZoom,
    linesOnly: true,
    lineWidth,
    perZoomTileCounts: perZoomCounts,
  };
  fs.writeFileSync(path.join(outDir, 'tile-meta.json'), JSON.stringify(meta, null, 2));
  console.log(`[build-contour-overlay] Done. Meta written to ${path.join(outDir, 'tile-meta.json')}`);
}

main().catch((err) => {
  console.error('[build-contour-overlay] Fatal error:', err);
  process.exit(1);
});
