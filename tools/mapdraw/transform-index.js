const fs = require('fs');
const path = require('path');

function openTransformIndex(directory) {
  const meta = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'));
  const transforms = fs.readFileSync(path.join(directory, meta.files.transforms));
  const tiles = fs.readFileSync(path.join(directory, meta.files.tiles));
  if (tiles.subarray(0, 4).toString() !== 'MTIX' || tiles.readUInt32LE(4) !== 1) throw new Error('Unsupported tile index');
  const tileCount = tiles.readUInt32LE(12), objectCount = tiles.readUInt32LE(16);
  if (objectCount !== meta.objectCount || transforms.length !== objectCount * meta.recordSize) throw new Error('Transform index size mismatch');
  const offsetsByte = 20;
  const membersByte = offsetsByte + (tileCount + 1) * 4;

  function membersForTile(x, y, radius = 0) {
    const result = [];
    for (let ty = Math.max(0, y - radius); ty <= Math.min(meta.side - 1, y + radius); ty++) {
      for (let tx = Math.max(0, x - radius); tx <= Math.min(meta.side - 1, x + radius); tx++) {
        const tile = ty * meta.side + tx;
        const begin = tiles.readUInt32LE(offsetsByte + tile * 4);
        const end = tiles.readUInt32LE(offsetsByte + (tile + 1) * 4);
        for (let i = begin; i < end; i++) result.push(tiles.readUInt32LE(membersByte + i * 4));
      }
    }
    return result;
  }

  function readRecord(index) {
    if (index < 0 || index >= objectCount) throw new RangeError(`Object index ${index}`);
    const o = index * meta.recordSize;
    const basis = [];
    for (let i = 0; i < 9; i++) basis.push(transforms.readFloatLE(o + 20 + i * 4));
    return { index, id: transforms.readUInt32LE(o), modelIndex: transforms.readUInt16LE(o + 4),
      flags: transforms.readUInt16LE(o + 6), x: transforms.readFloatLE(o + 8),
      y: transforms.readFloatLE(o + 12), z: transforms.readFloatLE(o + 16), basis };
  }
  return { meta, membersForTile, readRecord };
}

module.exports = { openTransformIndex };
