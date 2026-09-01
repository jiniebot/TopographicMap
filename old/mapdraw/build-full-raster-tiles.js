#!/usr/bin/env node
// Full indexed compositor for all WRP placements. Uses the raw X/Z projection
// of the 8WVR basis, retaining rotation, independent scale and terrain tilt.
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { openTransformIndex } = require('./transform-index');
const { MAP_CONFIGS } = require('../map-config');
const { localToPixel, tileToLocalBBox } = require('../tiling/coords');
const { buildOverviewLevel } = require('../tiling/build-overview');
const { resolveStoredPath } = require('./map-build-config');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_DIR = path.join(ROOT, 'out', 'mapdraw', 'index', 'enoch');
const TILE_SIZE = 256;
function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }

function isWaterModel(modelPath) {
  return /(?:^|\\)water(?:_(?:bliss|sakhal))?\\/i.test(modelPath) || /enoch_(?:river|pond|lake)/i.test(modelPath);
}
function isGroundPanel(modelPath){return /\\roads\\panels\\panels?_concrete/i.test(modelPath)}
function isRockModel(modelPath){return /(?:^|\\)(?:rocks?|rockformations?)(?:\\|_)|(?:^|\\)[^\\]*(?:rock|boulder)[^\\]*\.p3d$/i.test(modelPath)&&!/wall/i.test(modelPath)}

async function main() {
  const index = openTransformIndex(INDEX_DIR), zoom = index.meta.nativeZoom;
  const config = { ...MAP_CONFIGS.livonia, tileSize: TILE_SIZE };
  const output = path.resolve(ROOT, arg('--out', 'out/tiles/livonia-raster-local-only'));
  const onlyTile = arg('--tile', null)?.split(',').map(Number);
  const resume = process.argv.includes('--resume');
  const imageCache = new Map(), metadataCache = new Map();
  const modelRuntime = index.meta.models.map(model => {
    if (model.status !== 'complete') return null;
    const metadataPath = resolveStoredPath(ROOT, model.metadata);
    const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return { ...model, meta, imagePath: resolveStoredPath(ROOT, model.image) };
  });

  async function getImage(model) {
    let image = imageCache.get(model.index);
    if (!image) { image = await loadImage(model.imagePath); imageCache.set(model.index, image); }
    return image;
  }

  async function renderTile(tx, ty) {
    const bbox = tileToLocalBBox(config, zoom, tx, ty, 80);
    const candidates = index.membersForTile(tx, ty, 1);
    const objects = [];
    for (const recordIndex of candidates) {
      const record = index.readRecord(recordIndex), model = modelRuntime[record.modelIndex];
      if (!model) continue;
      const b = model.meta.bounds;
      const radius = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) * Math.max(
        Math.hypot(record.basis[0], record.basis[1], record.basis[2]),
        Math.hypot(record.basis[6], record.basis[7], record.basis[8]),
      );
      if (record.x + radius < bbox.minX || record.x - radius > bbox.maxX || record.z + radius < bbox.minZ || record.z - radius > bbox.maxZ) continue;
      const isRoad = (record.flags & 1) !== 0;
      const groundPanel=isGroundPanel(model.model),rock=isRockModel(model.model);
      const isWater = isWaterModel(model.model);
      // Satellite raster uses the supplied satellite imagery for water.
      // Water P3Ds belong only to the topographic vector pipeline.
      if (isWater) continue;
      objects.push({ record, model, isRoad, groundPanel, rock, top: record.y + b.maxY + (groundPanel ? -30000 : rock ? -20000 : isRoad ? -10000 : 0) });
    }
    objects.sort((a, b) => a.top - b.top);
    const canvas = createCanvas(TILE_SIZE, TILE_SIZE), ctx = canvas.getContext('2d');
    const pixelsPerMeter = TILE_SIZE * 2 ** zoom / config.mapSize;
    if (!objects.length) return false;
    for (const object of objects) {
      const { record, model, isRoad } = object;
      const image = await getImage(model);
      const b = model.meta.bounds;
      const imageWidthMeters = image.width * model.meta.metersPerPixel;
      const imageHeightMeters = image.height * model.meta.metersPerPixel;
      const centerX = isRoad ? 0 : (b.minX + b.maxX) / 2;
      const centerZ = isRoad ? 0 : (b.minZ + b.maxZ) / 2;
      const [px, py] = localToPixel(config, record.x, record.z, zoom);
      let a = record.basis[0], bb = -record.basis[2], c = -record.basis[6], d = record.basis[8];
      if (isRoad && /konec\.p3d$/i.test(model.model)) { a = -a; bb = -bb; c = -c; d = -d; }
      const drawCtx = ctx;
      drawCtx.save();
      drawCtx.translate(px - tx * TILE_SIZE, py - ty * TILE_SIZE);
      drawCtx.transform(a, bb, c, d, 0, 0);
      drawCtx.translate(centerX * pixelsPerMeter, -centerZ * pixelsPerMeter);
      drawCtx.drawImage(image, -imageWidthMeters * pixelsPerMeter / 2, -imageHeightMeters * pixelsPerMeter / 2,
        imageWidthMeters * pixelsPerMeter, imageHeightMeters * pixelsPerMeter);
      drawCtx.restore();
    }
    const dir = path.join(output, String(zoom), String(tx));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ty}.png`), canvas.toBuffer('image/png'));
    return true;
  }

  const nativeCoords = [];
  if (onlyTile) {
    if (await renderTile(onlyTile[0], onlyTile[1])) nativeCoords.push(onlyTile);
  } else {
    for (let ty = 0; ty < index.meta.side; ty++) {
      for (let tx = 0; tx < index.meta.side; tx++) {
        const existing = path.join(output, String(zoom), String(tx), `${ty}.png`);
        if (resume && fs.existsSync(existing)) nativeCoords.push([tx, ty]);
        else if (await renderTile(tx, ty)) nativeCoords.push([tx, ty]);
      }
      if (ty % 4 === 0) console.log(`[full-raster] row ${ty}/${index.meta.side}, ${nativeCoords.length} tiles`);
    }
  }
  if (!onlyTile) {
    let children = nativeCoords;
    for (let z = zoom; z > 0; z--) { children = await buildOverviewLevel(output, z, children); console.log(`[full-raster] overview ${z - 1}: ${children.length}`); }
  }
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'tile-meta.json'), JSON.stringify({ map: 'livonia', style: 'full-raster', nativeZoom: zoom, objects: index.meta.objectCount, nativeTiles: nativeCoords.length, proofTile: onlyTile || null }, null, 2));
  console.log(`[full-raster] wrote ${nativeCoords.length} native tiles -> ${path.relative(ROOT, output)}`);
}
main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
