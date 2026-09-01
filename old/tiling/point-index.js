// Spatial index for "circle" drawType categories (trees, bushes, plants, etc.)
// Reads the RAW source CSV directly - never the bloated 32-vertex-polygon
// out/prebuilt/<cat>-prebuilt.geojson files (e.g. trees-prebuilt.geojson is
// 2.56GB for 1.89M points that only need an [x, z, radius] triple each).
//
// Stores points in a flat CSR-style grid: a Float32Array of [x, z, radius]
// triples, bucketed into uniform cells via a prefix-summed Uint32Array, so a
// tile query only scans the handful of cells it overlaps.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function parseCsvLine(line, header) {
  const parts = line.split(';').map((p) => p.trim().replace(/"/g, ''));
  const row = {};
  header.forEach((h, idx) => {
    const val = parts[idx];
    if (val === undefined) return;
    row[h] = isNaN(val) ? val : parseFloat(val);
  });
  return row;
}

function getNumber(val) {
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : null;
  }
  return Number.isFinite(val) ? val : null;
}

function findBBox(bboxCache, name) {
  if (!name) return null;
  let bbox = bboxCache[name];
  if (bbox) return bbox;
  const nameLower = name.toLowerCase();
  bbox = bboxCache[nameLower];
  if (bbox) return bbox;
  const nameWithoutNum = name.replace(/_\d+$/, '');
  bbox = bboxCache[nameWithoutNum];
  if (bbox) return bbox;
  if (name.includes('-')) {
    bbox = bboxCache[name.replace(/-/g, '_')];
    if (bbox) return bbox;
  }
  if (name.includes('_')) {
    bbox = bboxCache[name.replace(/_/g, '-')];
    if (bbox) return bbox;
  }
  return null;
}

function radiusFor(bboxCache, cfg, name) {
  const bbox = findBBox(bboxCache, name);
  if (bbox && bbox.size) {
    const [sizeX, , sizeZ] = bbox.size;
    const scale = cfg.sizeScale || 1.0;
    return (Math.min(sizeX, sizeZ) / 2) * scale;
  }
  return 5;
}

async function forEachRow(filePath, onRow) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let header = null;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!header) {
      header = trimmed.split(';').map((h) => h.trim().replace(/"/g, ''));
      continue;
    }
    const item = parseCsvLine(trimmed, header);
    const name = item.name || item.Name || item.ObjectName || item.objectName;
    if (!name) continue;
    const x = getNumber(item.x ?? item.Local_X);
    const z = getNumber(item.z ?? item.Local_Z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    onRow(name, x, z);
  }
}

// cellSize: uniform grid cell size in local DayZ units
async function buildPointIndex(categoryName, cfg, { ROOT, bboxCache, cellSize = 100, mapSize }) {
  const filePath = path.join(ROOT, 'data', 'TBData', 'categorized', cfg.file);
  if (!fs.existsSync(filePath)) {
    console.warn(`[PointIndex] Missing CSV for ${categoryName}: ${filePath}`);
    return null;
  }

  const cellsPerSide = Math.max(1, Math.ceil(mapSize / cellSize));
  const numCells = cellsPerSide * cellsPerSide;

  const cellOf = (x, z) => {
    let cx = Math.floor(x / cellSize);
    let cz = Math.floor(z / cellSize);
    if (cx < 0) cx = 0;
    if (cz < 0) cz = 0;
    if (cx >= cellsPerSide) cx = cellsPerSide - 1;
    if (cz >= cellsPerSide) cz = cellsPerSide - 1;
    return cz * cellsPerSide + cx;
  };

  // Pass 1: histogram
  const counts = new Uint32Array(numCells);
  let total = 0;
  let maxRadius = 0;
  await forEachRow(filePath, (name, x, z) => {
    counts[cellOf(x, z)] += 1;
    total += 1;
  });

  if (total === 0) {
    console.warn(`[PointIndex] No points found for ${categoryName}`);
    return { cellSize, cellsPerSide, cellStart: new Uint32Array(numCells + 1), data: new Float32Array(0), maxRadius: 0, count: 0 };
  }

  // Prefix sum -> cellStart
  const cellStart = new Uint32Array(numCells + 1);
  for (let i = 0; i < numCells; i++) {
    cellStart[i + 1] = cellStart[i] + counts[i];
  }

  // Pass 2: fill data using a write-cursor copy of cellStart
  const cursor = cellStart.slice(0, numCells);
  const data = new Float32Array(total * 3);
  await forEachRow(filePath, (name, x, z) => {
    const radius = radiusFor(bboxCache, cfg, name);
    if (radius > maxRadius) maxRadius = radius;
    const cell = cellOf(x, z);
    const slot = cursor[cell]++;
    data[slot * 3 + 0] = x;
    data[slot * 3 + 1] = z;
    data[slot * 3 + 2] = radius;
  });

  console.log(`[PointIndex] ${categoryName}: ${total} points, maxRadius=${maxRadius.toFixed(2)}`);

  return { cellSize, cellsPerSide, cellStart, data, maxRadius, count: total };
}

// Query all points whose bbox (center +/- radius) may overlap [minX,maxX] x [minZ,maxZ].
// Expands the query bounds by the index's maxRadius so points centered just
// outside the tile but bleeding in via their circle are still returned.
function queryPointIndex(idx, minX, minZ, maxX, maxZ) {
  if (!idx || idx.count === 0) return [];
  const { cellSize, cellsPerSide, cellStart, data, maxRadius } = idx;

  const qMinX = minX - maxRadius;
  const qMaxX = maxX + maxRadius;
  const qMinZ = minZ - maxRadius;
  const qMaxZ = maxZ + maxRadius;

  let cx0 = Math.floor(qMinX / cellSize);
  let cx1 = Math.floor(qMaxX / cellSize);
  let cz0 = Math.floor(qMinZ / cellSize);
  let cz1 = Math.floor(qMaxZ / cellSize);

  cx0 = Math.max(0, Math.min(cellsPerSide - 1, cx0));
  cx1 = Math.max(0, Math.min(cellsPerSide - 1, cx1));
  cz0 = Math.max(0, Math.min(cellsPerSide - 1, cz0));
  cz1 = Math.max(0, Math.min(cellsPerSide - 1, cz1));

  const results = [];
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const cell = cz * cellsPerSide + cx;
      const start = cellStart[cell];
      const end = cellStart[cell + 1];
      for (let i = start; i < end; i++) {
        results.push(data[i * 3 + 0], data[i * 3 + 1], data[i * 3 + 2]);
      }
    }
  }
  return results; // flat [x,z,radius, x,z,radius, ...]
}

module.exports = { buildPointIndex, queryPointIndex };
