#!/usr/bin/env node

// Renders cached P3D top-down sprites directly into a high-resolution section.
// Unlike scaling the zoom-7 object tiles, this samples the original 512px model
// cache at the requested section resolution.

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { openTransformIndex } = require('./transform-index');
const { loadMapManifest, resolveStoredPath } = require('./map-build-config');

const ROOT = path.resolve(__dirname, '..', '..');
let INDEX_DIR = path.join(ROOT, 'out', 'mapdraw', 'index', 'enoch');
let MAP_SIZE = 12800;
let INDEX_TILE_METERS = 100;

function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
// See build-vector-section.js's isIcebergChunkModel for why these are
// excluded - real floating relief, not a flat water-surface plane.
function isIcebergChunkModel(modelPath) { return /(?:^|\\)water_sakhal\\ice_sea\\ice_sea_(?:piece|square|triangle)/i.test(modelPath); }
function isWaterModel(modelPath) { if (isIcebergChunkModel(modelPath)) return false; return /(?:^|\\)water(?:_(?:bliss|sakhal))?\\/i.test(modelPath) || /enoch_(?:river|pond|lake)/i.test(modelPath); }
function isGroundPanel(modelPath){return /\\roads\\panels\\panels?_concrete/i.test(modelPath)}
// See build-vector-section.js's isRailModel for why rail track pieces need
// the same origin-at-center placement as road pieces despite not carrying
// the WRP road flag.
function isRailModel(modelPath){return /(?:^|\\)rail\\tracks\\/i.test(modelPath)}
function isRockModel(modelPath){return /(?:^|\\)(?:rocks?|rockformations?)(?:\\|_)|(?:^|\\)[^\\]*(?:rock|boulder)[^\\]*\.p3d$/i.test(modelPath)&&!/wall/i.test(modelPath)}

async function main() {
  const manifestPath = arg('--manifest', null);
  if (manifestPath) {
    const map = loadMapManifest(manifestPath);
    INDEX_DIR = map.transformIndex;
    MAP_SIZE = map.mapSize;
  }
  const centerX = Number(arg('--x', 6600));
  const centerZ = Number(arg('--z', 8930));
  const meters = Number(arg('--meters', 1000));
  const size = Number(arg('--size', 5120));
  const basePath = path.resolve(ROOT, arg('--base', 'out/mapdraw/hires-tests/section-6600-8930-z8/enhanced.png'));
  const output = path.resolve(ROOT, arg('--out', 'out/mapdraw/hires-tests/section-6600-8930-z8/combined.png'));
  if (![centerX, centerZ, meters, size].every(Number.isFinite) || meters <= 0 || size < 64 || size > 8192) throw new Error('Invalid section arguments');
  if (!fs.existsSync(basePath)) throw new Error(`Base image not found: ${basePath}`);

  const index = openTransformIndex(INDEX_DIR);
  INDEX_TILE_METERS = MAP_SIZE / index.meta.side;
  const runtime = index.meta.models.map(model => {
    if (model.status !== 'complete') return null;
    return { ...model, meta: JSON.parse(fs.readFileSync(resolveStoredPath(ROOT, model.metadata), 'utf8')), imagePath: resolveStoredPath(ROOT, model.image) };
  });
  const minX = centerX - meters / 2, maxX = centerX + meters / 2;
  const minZ = centerZ - meters / 2, maxZ = centerZ + meters / 2;
  const pixelsPerMeter = size / meters;
  const tx0 = Math.max(0, Math.floor(minX / INDEX_TILE_METERS) - 1);
  const tx1 = Math.min(index.meta.side - 1, Math.floor(maxX / INDEX_TILE_METERS) + 1);
  const ty0 = Math.max(0, Math.floor((MAP_SIZE - maxZ) / INDEX_TILE_METERS) - 1);
  const ty1 = Math.min(index.meta.side - 1, Math.floor((MAP_SIZE - minZ) / INDEX_TILE_METERS) + 1);
  const candidateSet = new Set();
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    for (const recordIndex of index.membersForTile(tx, ty)) candidateSet.add(recordIndex);
  }

  const objects = [];
  for (const recordIndex of candidateSet) {
    const record = index.readRecord(recordIndex), model = runtime[record.modelIndex];
    if (!model || isWaterModel(model.model)) continue; // satellite base already carries water; avoid gray water P3Ds
    const b = model.meta.bounds;
    const radius = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) * Math.max(
      Math.hypot(record.basis[0], record.basis[1], record.basis[2]),
      Math.hypot(record.basis[6], record.basis[7], record.basis[8]),
    );
    if (record.x + radius < minX || record.x - radius > maxX || record.z + radius < minZ || record.z - radius > maxZ) continue;
    const isRoad = (record.flags & 1) !== 0;
    const isRail = isRailModel(model.model);
    const groundPanel=isGroundPanel(model.model),rock=isRockModel(model.model);
    objects.push({ record, model, isRoad, isRail, groundPanel, rock, top: record.y + b.maxY + (groundPanel ? -30000 : rock ? -20000 : isRoad||isRail ? -10000 : 0) });
  }
  objects.sort((a, b) => a.top - b.top);

  const canvas = createCanvas(size, size), ctx = canvas.getContext('2d');
  ctx.drawImage(await loadImage(basePath), 0, 0, size, size);
  const imageCache = new Map();
  for (let i = 0; i < objects.length; i++) {
    const { record, model, isRoad, isRail } = objects[i];
    let image = imageCache.get(model.index);
    if (!image) { image = await loadImage(model.imagePath); imageCache.set(model.index, image); }
    const b = model.meta.bounds;
    const widthMeters = image.width * model.meta.metersPerPixel;
    const heightMeters = image.height * model.meta.metersPerPixel;
    const centerModelX = isRoad||isRail ? 0 : (b.minX + b.maxX) / 2;
    const centerModelZ = isRoad||isRail ? 0 : (b.minZ + b.maxZ) / 2;
    const px = (record.x - minX) * pixelsPerMeter;
    const py = (maxZ - record.z) * pixelsPerMeter;
    let a = record.basis[0], bb = -record.basis[2], c = -record.basis[6], d = record.basis[8];
    if (isRoad && /konec\.p3d$/i.test(model.model)) { a = -a; bb = -bb; c = -c; d = -d; }
    ctx.save();
    ctx.translate(px, py);
    ctx.transform(a, bb, c, d, 0, 0);
    ctx.translate(centerModelX * pixelsPerMeter, -centerModelZ * pixelsPerMeter);
    ctx.drawImage(image, -widthMeters * pixelsPerMeter / 2, -heightMeters * pixelsPerMeter / 2,
      widthMeters * pixelsPerMeter, heightMeters * pixelsPerMeter);
    ctx.restore();
    if (i % Math.max(1,Math.floor(objects.length/20)) === 0) console.log(`[hires-objects] ${i}/${objects.length}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, canvas.toBuffer('image/png'));
  const previewSize = Math.min(1280, size);
  const preview = createCanvas(previewSize, previewSize), previewCtx = preview.getContext('2d');
  previewCtx.drawImage(canvas, 0, 0, previewSize, previewSize);
  fs.writeFileSync(path.join(path.dirname(output), 'combined-preview.png'), preview.toBuffer('image/png'));
  fs.writeFileSync(path.join(path.dirname(output), 'combined-meta.json'), JSON.stringify({ centerX, centerZ, meters, size, metersPerPixel: meters / size, objects: objects.length, uniqueImages: imageCache.size, base: path.relative(ROOT, basePath) }, null, 2));
  console.log(`[hires-objects] wrote ${output}; ${objects.length} objects, ${imageCache.size} model images`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
