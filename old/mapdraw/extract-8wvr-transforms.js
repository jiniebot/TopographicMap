#!/usr/bin/env node
// Extracts every object transform from Mikero's unbinarized 8WVR conversion.
// Output is NDJSON so multi-million-object worlds can be streamed downstream
// without constructing a multi-gigabyte in-memory JSON scene.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const input = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'mapdraw', 'wrp8-transform', 'enoch_8WVR.wrp'));
const output = path.resolve(process.argv[3] || path.join(ROOT, 'out', 'mapdraw', 'enoch-transforms.ndjson'));
const summaryPath = output.replace(/\.ndjson$/i, '-summary.json');

function findObjectOffset(buffer) {
  if (buffer.subarray(0, 4).toString() !== '8WVR') throw new Error('Expected an 8WVR file');
  const textureX = buffer.readUInt32LE(4), textureY = buffer.readUInt32LE(8);
  const terrainX = buffer.readUInt32LE(12), terrainY = buffer.readUInt32LE(16);
  let offset = 24 + terrainX * terrainY * 4 + textureX * textureY * 2;
  const materialCount = buffer.readUInt32LE(offset); offset += 4;
  for (let i = 0; i < materialCount; i++) {
    while (true) {
      const length = buffer.readUInt32LE(offset); offset += 4;
      if (!length) break;
      offset += length;
    }
  }
  return { offset, textureX, textureY, terrainX, terrainY, materialCount };
}

async function writeLine(stream, line) {
  if (!stream.write(line)) await new Promise(resolve => stream.once('drain', resolve));
}

async function main() {
  const buffer = fs.readFileSync(input);
  const header = findObjectOffset(buffer);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stream = fs.createWriteStream(output);
  const modelCounts = new Map();
  let offset = header.offset, count = 0;
  while (offset + 56 <= buffer.length) {
    const matrix = [];
    for (let i = 0; i < 12; i++, offset += 4) matrix.push(buffer.readFloatLE(offset));
    const id = buffer.readUInt32LE(offset); offset += 4;
    const nameLength = buffer.readUInt32LE(offset); offset += 4;
    if (!nameLength) break;
    if (nameLength > 4096 || offset + nameLength > buffer.length) throw new Error(`Invalid model name length ${nameLength} at ${offset - 4}`);
    const model = buffer.subarray(offset, offset + nameLength).toString().replace(/\0+$/, '').toLowerCase();
    offset += nameLength;
    const xScale = Math.hypot(matrix[0], matrix[1], matrix[2]);
    const yScale = Math.hypot(matrix[3], matrix[4], matrix[5]);
    const zScale = Math.hypot(matrix[6], matrix[7], matrix[8]);
    const record = {
      id, model, x: matrix[9], y: matrix[10], z: matrix[11],
      yaw: Math.atan2(-matrix[2], matrix[0]) * 180 / Math.PI,
      scaleX: xScale, scaleY: yScale, scaleZ: zScale,
      // Preserve the complete normalized basis for slope/tilt-aware placement.
      basis: [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5], matrix[6], matrix[7], matrix[8]],
    };
    await writeLine(stream, `${JSON.stringify(record)}\n`);
    modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    count++;
    if (count % 250000 === 0) console.log(`[8wvr] ${count.toLocaleString()} transforms`);
  }
  await new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve()));
  const summary = {
    schemaVersion: 1, source: input, output, objectOffset: header.offset,
    objectCount: count, uniqueModelCount: modelCounts.size,
    textureGrid: [header.textureX, header.textureY], terrainGrid: [header.terrainX, header.terrainY],
    materialCount: header.materialCount, endedAt: offset, sourceBytes: buffer.length,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[8wvr] ${count.toLocaleString()} objects, ${modelCounts.size.toLocaleString()} models -> ${path.relative(ROOT, output)}`);
}
main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
