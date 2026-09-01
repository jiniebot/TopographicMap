#!/usr/bin/env node
// One-off: finds every (zoom,tx,ty) render tile whose bounds contain at
// least one placement of a model matching --model-pattern, for zooms
// --zooms. Used to target a re-render at only the tiles actually affected
// by a placement-classification fix, instead of rebuilding a whole map.
const path = require('path');
const { openTransformIndex } = require('./mapdraw/transform-index');
const { loadMapManifest } = require('./mapdraw/map-build-config');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
const manifest = loadMapManifest(arg('--manifest'));
const pattern = new RegExp(arg('--model-pattern'), 'i');
const zooms = arg('--zooms', '1,2,3,4,5,6').split(',').map(Number);
const buffer = Number(arg('--buffer', 60)); // metres of slack around each tile's bounds

const index = openTransformIndex(manifest.transformIndex);
const matchingModelIndexes = new Set(index.meta.models.filter(m => pattern.test(m.model)).map(m => m.index));

const points = [];
for (let i = 0; i < index.meta.objectCount; i++) {
  const r = index.readRecord(i);
  if (matchingModelIndexes.has(r.modelIndex)) points.push([r.x, r.z]);
}

const result = {};
for (const zoom of zooms) {
  const side = 2 ** zoom, tileMeters = manifest.mapSize / side;
  const tiles = new Set();
  for (const [x, z] of points) {
    const cx0 = Math.floor((x - buffer) / tileMeters), cx1 = Math.floor((x + buffer) / tileMeters);
    const cz0 = Math.floor((manifest.mapSize - (z + buffer)) / tileMeters), cz1 = Math.floor((manifest.mapSize - (z - buffer)) / tileMeters);
    for (let tx = Math.max(0, cx0); tx <= Math.min(side - 1, cx1); tx++)
      for (let ty = Math.max(0, cz0); ty <= Math.min(side - 1, cz1); ty++)
        tiles.add(`${tx},${ty}`);
  }
  result[zoom] = [...tiles].map(s => s.split(',').map(Number));
}
console.log(JSON.stringify({ placementCount: points.length, tilesByZoom: Object.fromEntries(Object.entries(result).map(([z, t]) => [z, t.length])) }, null, 2));
require('fs').writeFileSync(path.join(__dirname, '..', 'out', 'mapdraw', 'iceberg-affected-tiles.json'), JSON.stringify(result));
