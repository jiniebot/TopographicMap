// Generates all zoom levels below the native render zoom by compositing each
// parent tile from its (up to 4) existing children, instead of re-querying
// geometry - standard tile-pyramid overview generation (same approach as
// gdal2tiles/mbutil). Cheap image ops only; the pyramid stays sparse (a
// parent is only written if at least one child exists).

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

function tilePath(outDir, z, x, y) {
  return path.join(outDir, String(z), String(x), `${y}.png`);
}

async function writeTile(outDir, z, x, y, buffer) {
  const dir = path.join(outDir, String(z), String(x));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${y}.png`), buffer);
}

// childCoords: array of [x, y] tile coordinates that exist at zoom `zoomFrom`.
// Returns array of [x, y] tile coordinates written at zoom `zoomFrom - 1`.
async function buildOverviewLevel(outDir, zoomFrom, childCoords, tileSize = 256) {
  const zoomTo = zoomFrom - 1;
  if (zoomTo < 0) return [];

  // Collect the distinct set of parent coordinates touched by existing children.
  const parents = new Map(); // "x,y" -> [x, y]
  for (const [cx, cy] of childCoords) {
    const px = Math.floor(cx / 2);
    const py = Math.floor(cy / 2);
    parents.set(`${px},${py}`, [px, py]);
  }

  const writtenCoords = [];
  const half = tileSize / 2;

  for (const [px, py] of parents.values()) {
    const quadrants = [
      { cx: px * 2, cy: py * 2, dx: 0, dy: 0 }, // top-left
      { cx: px * 2 + 1, cy: py * 2, dx: half, dy: 0 }, // top-right
      { cx: px * 2, cy: py * 2 + 1, dx: 0, dy: half }, // bottom-left
      { cx: px * 2 + 1, cy: py * 2 + 1, dx: half, dy: half }, // bottom-right
    ];

    let anyChild = false;
    const canvas = createCanvas(tileSize, tileSize);
    const ctx = canvas.getContext('2d');

    for (const q of quadrants) {
      const childFile = tilePath(outDir, zoomFrom, q.cx, q.cy);
      if (!fs.existsSync(childFile)) continue;
      anyChild = true;
      const img = await loadImage(childFile);
      ctx.drawImage(img, q.dx, q.dy, half, half);
    }

    if (!anyChild) continue;

    const buf = canvas.toBuffer('image/png');
    await writeTile(outDir, zoomTo, px, py, buf);
    writtenCoords.push([px, py]);
  }

  return writtenCoords;
}

module.exports = { buildOverviewLevel, tilePath, writeTile };
