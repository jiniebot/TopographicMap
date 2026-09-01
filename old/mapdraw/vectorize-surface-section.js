#!/usr/bin/env node

// Convert a sectional material-classes.png into categorical surface polygons.
// The input classification currently comes from the enhanced terrain pass;
// this stage is independent of how classifications are produced, so the exact
// TerrainX control-mask decoder can replace it without changing MVT output.

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '..', '..');
function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
const inputDir = path.resolve(ROOT, arg('--input', 'out/mapdraw/builds/livonia/previews/6600-8930-400m-z8'));
const output = path.resolve(ROOT, arg('--out', 'out/mapdraw/vector-tests/surfaces-6600-8930-400m.geojson'));
const cellMeters = Number(arg('--cell', 2));
const materials = ['en_deforested','en_flowers1','en_flowers2','en_flowers3','en_forest_con','en_forest_dec','en_grass1','en_grass2','en_soil','en_stones','en_stubble','en_tarmac_old'];
const palette = [[230,70,70],[70,210,90],[70,110,230],[220,190,60],[80,210,210],[210,80,210],[235,130,40],[130,235,40],[130,90,50],[150,150,150],[225,210,130],[70,70,70]];

async function main() {
  const meta = JSON.parse(fs.readFileSync(path.join(inputDir, 'meta.json'), 'utf8'));
  const image = await loadImage(path.join(inputDir, 'material-classes.png'));
  const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  const grid = Math.max(8, Math.ceil(meta.meters / cellMeters));
  const labels = new Uint8Array(grid * grid);
  for (let gy = 0; gy < grid; gy++) for (let gx = 0; gx < grid; gx++) {
    const px = Math.min(image.width - 1, Math.floor((gx + 0.5) / grid * image.width));
    const py = Math.min(image.height - 1, Math.floor((gy + 0.5) / grid * image.height));
    const o = (py * image.width + px) * 4;
    let best = 0, distance = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const d = (pixels[o]-palette[i][0])**2+(pixels[o+1]-palette[i][1])**2+(pixels[o+2]-palette[i][2])**2;
      if (d < distance) { distance = d; best = i; }
    }
    labels[gy * grid + gx] = best;
  }

  const { contours } = await import('d3-contour');
  const minX = meta.centerX - meta.meters / 2, maxZ = meta.centerZ + meta.meters / 2;
  const features = [];
  for (let materialIndex = 0; materialIndex < materials.length; materialIndex++) {
    const values = Float32Array.from(labels, value => value === materialIndex ? 1 : 0);
    const result = contours().size([grid, grid]).thresholds([0.5]).smooth(true)(values)[0];
    if (!result?.coordinates?.length) continue;
    const coordinates = result.coordinates.map(polygon => polygon.map(ring => ring.map(([gx, gy]) => [
      minX + gx / grid * meta.meters,
      maxZ - gy / grid * meta.meters,
    ])));
    features.push({ type: 'Feature', properties: { material: materials[materialIndex], classIndex: materialIndex }, geometry: { type: 'MultiPolygon', coordinates } });
  }
  const collection = { type: 'FeatureCollection', properties: { map: 'livonia', bounds: [minX, maxZ-meta.meters, minX+meta.meters, maxZ], cellMeters, classification: 'enhanced-terrain-v1' }, features };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(collection)}\n`);
  console.log(`Surface vectors: ${output}`);
  console.log(`${features.length} material classes on ${grid}x${grid} grid (${cellMeters}m target cells)`);
}
main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
