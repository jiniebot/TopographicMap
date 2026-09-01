#!/usr/bin/env node
// Builds a compact fixed-record transform store and native-tile membership
// index directly from 8WVR. The transform store remains model-complete; cache
// availability is metadata, not a reason to discard placements.
const fs = require('fs');
const path = require('path');
const { loadMapManifest } = require('../../tools/mapdraw/map-build-config');

const ROOT = path.resolve(__dirname, '..', '..');
function option(name,fallback){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback}
const manifest=loadMapManifest(option('--manifest','configs/maps/livonia.json'));
const WRP = path.resolve(ROOT,option('--wrp8',path.join('out','mapdraw','wrp8-transform',`${manifest.world}_8WVR.wrp`)));
const CACHE = path.join(ROOT, 'out', 'mapdraw', 'cache', manifest.world, 'cache-state.json');
const OUT = manifest.transformIndex;
const MAP_SIZE = manifest.mapSize, ZOOM = Number(option('--zoom',7)), SIDE = 2 ** ZOOM, RECORD_SIZE = 56;

function objectOffset(buffer) {
  if (buffer.subarray(0, 4).toString() !== '8WVR') throw new Error('Expected 8WVR');
  const tx = buffer.readUInt32LE(4), ty = buffer.readUInt32LE(8);
  const gx = buffer.readUInt32LE(12), gy = buffer.readUInt32LE(16);
  let o = 24 + gx * gy * 4 + tx * ty * 2;
  const materials = buffer.readUInt32LE(o); o += 4;
  for (let i = 0; i < materials; i++) while (true) { const n = buffer.readUInt32LE(o); o += 4; if (!n) break; o += n; }
  return o;
}

function countObjects(buffer, start) {
  let o = start, count = 0;
  while (o + 56 <= buffer.length) {
    o += 48 + 4;
    const n = buffer.readUInt32LE(o); o += 4;
    if (!n) break;
    o += n; count++;
  }
  return count;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const source = fs.readFileSync(WRP);
  const start = objectOffset(source);
  const objectCount = countObjects(source, start);
  const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')).models;
  const modelNames = Object.keys(cache);
  const modelIndex = new Map(modelNames.map((name, i) => [name, i]));
  if (modelNames.length > 65535) throw new Error('Model table exceeds uint16');

  const records = Buffer.allocUnsafe(objectCount * RECORD_SIZE);
  const tileIds = new Uint16Array(objectCount);
  const tileCounts = new Uint32Array(SIDE * SIDE);
  let o = start, recordIndex = 0;
  while (recordIndex < objectCount) {
    const m = [];
    for (let i = 0; i < 12; i++, o += 4) m.push(source.readFloatLE(o));
    const id = source.readUInt32LE(o); o += 4;
    const n = source.readUInt32LE(o); o += 4;
    const model = source.subarray(o, o + n).toString().replace(/\0+$/, '').toLowerCase(); o += n;
    const mi = modelIndex.get(model);
    if (mi === undefined) throw new Error(`Model absent from cache inventory: ${model}`);
    const flags = (/\\roads(?:_bliss)?\\parts\\/i.test(model) ? 1 : 0) | (cache[model].status === 'complete' ? 2 : 0);
    const ro = recordIndex * RECORD_SIZE;
    records.writeUInt32LE(id, ro);
    records.writeUInt16LE(mi, ro + 4);
    records.writeUInt16LE(flags, ro + 6);
    records.writeFloatLE(m[9], ro + 8); records.writeFloatLE(m[10], ro + 12); records.writeFloatLE(m[11], ro + 16);
    for (let i = 0; i < 9; i++) records.writeFloatLE(m[i], ro + 20 + i * 4);
    const tx = Math.max(0, Math.min(SIDE - 1, Math.floor(m[9] / MAP_SIZE * SIDE)));
    const ty = Math.max(0, Math.min(SIDE - 1, Math.floor((MAP_SIZE - m[11]) / MAP_SIZE * SIDE)));
    const tile = ty * SIDE + tx;
    tileIds[recordIndex] = tile; tileCounts[tile]++; recordIndex++;
    if (recordIndex % 500000 === 0) console.log(`[index] ${recordIndex.toLocaleString()} records`);
  }

  const offsets = new Uint32Array(tileCounts.length + 1);
  for (let i = 0; i < tileCounts.length; i++) offsets[i + 1] = offsets[i] + tileCounts[i];
  const cursors = offsets.slice(0, -1);
  const members = new Uint32Array(objectCount);
  for (let i = 0; i < objectCount; i++) members[cursors[tileIds[i]]++] = i;

  fs.writeFileSync(path.join(OUT, 'transforms.bin'), records);
  const indexHeader = Buffer.alloc(20);
  indexHeader.write('MTIX', 0); indexHeader.writeUInt32LE(1, 4); indexHeader.writeUInt32LE(ZOOM, 8);
  indexHeader.writeUInt32LE(SIDE * SIDE, 12); indexHeader.writeUInt32LE(objectCount, 16);
  fs.writeFileSync(path.join(OUT, 'tiles.bin'), Buffer.concat([
    indexHeader, Buffer.from(offsets.buffer), Buffer.from(members.buffer),
  ]));
  const models = modelNames.map((model, index) => ({ index, model, ...cache[model] }));
  const meta = { schemaVersion: 1, map: manifest.world, mapSize: MAP_SIZE, nativeZoom: ZOOM, side: SIDE,
    objectCount, modelCount: models.length, recordSize: RECORD_SIZE,
    recordLayout: { id: 'u32@0', modelIndex: 'u16@4', flags: 'u16@6 bit0=roadnet bit1=drawable', position: 'f32x3@8', basis: 'f32x9@20' },
    files: { transforms: 'transforms.bin', tiles: 'tiles.bin' }, models };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(meta));
  console.log(`[index] ${objectCount.toLocaleString()} objects, ${models.length} models, ${SIDE * SIDE} tile buckets -> ${path.relative(ROOT, OUT)}`);
}
try { main(); } catch (err) { console.error(err.stack || err); process.exitCode = 1; }
