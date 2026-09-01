// Loads the raw Chernarus elevation heightmap (data/chernarus_elevation.bin) and
// samples real terrain elevation at any local (x, z) coordinate.
//
// Format: raw Float32Array, 1537x1537, no header, 10m grid step. Verified against
// several known object placements (water objects' own Absolute_Elevation column in
// the source CSVs, which should equal real ground height at their position):
//   col = round(x / 10), row = round(z / 10)   <- NO Y-flip
// This is the RAW grid's own indexing - note tools/contours/generateContours.js
// applies a Z-flip when converting grid -> world coords for ITS OWN output
// convention; that flip is internal to that script and does not apply when
// reading the raw grid directly (confirmed by cross-checking sampled values
// against several water objects' CSV elevations, which matched to ~1m without
// the flip and were wildly wrong - e.g. 550 vs 45 - with it).

const fs = require('fs');
const path = require('path');

function loadElevationGrid(ROOT, { width = 1537, height = 1537, step = 10, file = null } = {}) {
  const filePath = path.resolve(ROOT, file || path.join('data', 'Chernarus', 'chernarus_elevation.bin'));
  const buf = fs.readFileSync(filePath);
  const grid = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (grid.length !== width * height) {
    throw new Error(`[elevation] Grid size mismatch: expected ${width * height}, got ${grid.length}`);
  }
  return { grid, width, height, step };
}

function loadMapElevationGrid(ROOT, mapConfig) {
  if (!mapConfig?.elevationFile) throw new Error('[elevation] Map configuration has no elevationFile');
  const stepX = mapConfig.mapSize / (mapConfig.elevationWidth - 1);
  const stepZ = mapConfig.mapSize / (mapConfig.elevationHeight - 1);
  if (Math.abs(stepX - stepZ) > 1e-6) throw new Error('[elevation] Non-square elevation cells are unsupported');
  return loadElevationGrid(ROOT, {
    file: mapConfig.elevationFile,
    width: mapConfig.elevationWidth,
    height: mapConfig.elevationHeight,
    step: stepX,
  });
}

// Bilinear-interpolated terrain elevation at local (x, z). Returns null if
// outside the grid.
function sampleElevation(elev, x, z) {
  const { grid, width, height, step } = elev;
  const fx = x / step;
  const fz = z / step;
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fz);
  const c1 = c0 + 1;
  const r1 = r0 + 1;
  if (c0 < 0 || r0 < 0 || c1 >= width || r1 >= height) return null;

  const tx = fx - c0;
  const tz = fz - r0;

  const v00 = grid[r0 * width + c0];
  const v10 = grid[r0 * width + c1];
  const v01 = grid[r1 * width + c0];
  const v11 = grid[r1 * width + c1];

  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * tz;
}

module.exports = { loadElevationGrid, loadMapElevationGrid, sampleElevation };
