// Adds roads using authoritative 4x3 transforms from an unbinarized 8WVR
// conversion of Livonia's OPRW. No heading inference is used.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WRP = path.join(ROOT, 'out', 'mapdraw', 'wrp8-transform', 'enoch_8WVR.wrp');
const inputScene = path.join(ROOT, 'out', 'mapdraw', 'enoch-scene.json');
const statePath = path.join(ROOT, 'out', 'mapdraw', 'cache', 'enoch', 'cache-state.json');
const output = path.join(ROOT, 'out', 'mapdraw', 'enoch-scene-roads.json');
const ROAD_RE = /\\roads(?:_bliss)?\\|\\roadway\\/i;

function objectOffset(buffer) {
  if (buffer.subarray(0, 4).toString() !== '8WVR') throw new Error('Expected an 8WVR file');
  const textureX = buffer.readUInt32LE(4), textureY = buffer.readUInt32LE(8);
  const terrainX = buffer.readUInt32LE(12), terrainY = buffer.readUInt32LE(16);
  let offset = 24 + terrainX * terrainY * 4 + textureX * textureY * 2;
  const materialCount = buffer.readUInt32LE(offset); offset += 4;
  for (let i = 0; i < materialCount; i++) {
    while (true) {
      const length = buffer.readUInt32LE(offset); offset += 4;
      if (length === 0) break;
      offset += length;
    }
  }
  return offset;
}

function main() {
  const base = JSON.parse(fs.readFileSync(inputScene, 'utf8'));
  const cache = JSON.parse(fs.readFileSync(statePath, 'utf8')).models;
  const metadata = new Map();
  const buffer = fs.readFileSync(WRP);
  let offset = objectOffset(buffer);
  const roads = [];
  while (offset + 56 <= buffer.length) {
    const matrix = [];
    for (let i = 0; i < 12; i++, offset += 4) matrix.push(buffer.readFloatLE(offset));
    const id = buffer.readUInt32LE(offset); offset += 4;
    const nameLength = buffer.readUInt32LE(offset); offset += 4;
    if (nameLength === 0) break;
    if (nameLength > 4096 || offset + nameLength > buffer.length) throw new Error(`Invalid model name length ${nameLength}`);
    const model = buffer.subarray(offset, offset + nameLength).toString().replace(/\0+$/, '').toLowerCase();
    offset += nameLength;
    const entry = cache[model];
    if (!ROAD_RE.test(model) || entry?.status !== 'complete') continue;
    if (!metadata.has(model)) metadata.set(model, JSON.parse(fs.readFileSync(path.join(ROOT, entry.metadata), 'utf8')));
    const meta = metadata.get(model);
    // Matrix positions are X, elevation, Z in elements 9..11. Comparison
    // against house_1w03's mapgrouppos yaw proves atan2(-m02,m00).
    let yaw = Math.atan2(-matrix[2], matrix[0]) * 180 / Math.PI;
    // `konec` (road-end/fade) assets use the opposite local longitudinal
    // convention from ordinary road pieces. Straight geometry hides this,
    // but the directional fade points outward unless its basis is reversed.
    if (/konec\.p3d$/i.test(model)) yaw += 180;
    const scale = Math.hypot(matrix[0], matrix[2]);
    roads.push({
      id, className: null, model, x: matrix[9], elevation: matrix[10], z: matrix[11],
      terrainElevation: matrix[10], pitch: 0, roll: 0, yaw, scale,
      transformSource: '8wvr-matrix', cacheKey: entry.key,
      image: entry.image.replaceAll('\\', '/'), widthMeters: entry.widthMeters,
      heightMeters: entry.heightMeters, metersPerPixel: meta.metersPerPixel, bounds: meta.bounds,
    });
  }
  const result = { ...base, schemaVersion: 3, authoritativeRoadObjects: roads.length, inferredRoadObjects: 0, drawableObjects: base.objects.length + roads.length, objects: [...roads, ...base.objects] };
  fs.writeFileSync(output, JSON.stringify(result));
  console.log(`[roads] ${roads.length} authoritative 8WVR road/decal transforms`);
  console.log(`[roads] ${path.relative(ROOT, output)}`);
}
try { main(); } catch (err) { console.error(err.stack || err); process.exitCode = 1; }
