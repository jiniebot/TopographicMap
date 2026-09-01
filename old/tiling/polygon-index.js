// Spatial index for "rectangle" drawType categories (roads, walls, houses,
// etc.). Reuses the EXISTING out/prebuilt/<cat>-prebuilt.geojson files as-is
// (they already contain correct rotated-rectangle/custom-drawer geometry) -
// unlike point categories, these files are small (walls, the largest, is
// 46MB/139K features), so a one-shot JSON.parse is fine.
//
// Flattens into typed arrays to shed per-feature JSON object overhead, then
// buckets each feature into every grid cell its bbox overlaps (a feature can
// span multiple cells, so cells store indices, not copies of the geometry).

const fs = require('fs');
const path = require('path');

async function buildPolygonIndex(categoryName, { ROOT, cellSize = 100, mapSize }) {
  const filePath = path.join(ROOT, 'out', 'prebuilt', `${categoryName}-prebuilt.geojson`);
  if (!fs.existsSync(filePath)) {
    console.warn(`[PolygonIndex] Missing prebuilt geojson for ${categoryName}: ${filePath}`);
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const features = raw.features || [];

  // First pass: figure out total vertex count so we can allocate one flat
  // Float32Array instead of growing arrays per feature.
  let totalVerts = 0;
  const ringsPerFeature = []; // array of arrays of vertex coords (kept only transiently)
  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom || !geom.coordinates) {
      ringsPerFeature.push(null);
      continue;
    }
    // Only outer ring is needed for a filled draw (holes not used by this app's data).
    const ring = geom.type === 'Polygon' ? geom.coordinates[0] : null;
    if (!ring || ring.length < 3) {
      ringsPerFeature.push(null);
      continue;
    }
    ringsPerFeature.push(ring);
    totalVerts += ring.length;
  }

  const count = features.length;
  const vertexData = new Float32Array(totalVerts * 2); // [x,z, x,z, ...]
  const ringOffsets = new Uint32Array(count + 1); // vertex-index (not coord-index) start per feature
  const bbox = new Float32Array(count * 4); // minX,minZ,maxX,maxZ per feature
  const valid = new Uint8Array(count);
  // Terrain-masked features (ponds/lakes/streams/rivers sitting in a
  // depression - only visible where surrounding terrain is actually below
  // the water's own elevation) vs. plain filled features (everything else).
  const elev = new Float32Array(count).fill(NaN);
  // Per-vertex elevation (parallel to vertexData) - snap-connectors.js
  // averages elev across whichever features share a welded vertex, so two
  // joined pieces agree exactly at their now-shared edge instead of each
  // using its own flat elevation and leaving a threshold-mismatch gap right
  // at the seam. Falls back to the feature's scalar elev where a vertex
  // wasn't part of any weld (or the category was never snapped at all).
  const vertexElev = new Float32Array(totalVerts).fill(NaN);
  const masked = new Uint8Array(count);
  const maskedNamePattern = /^(pond|lake|stream|river)/i;
  // Streams/rivers run down sloped creek beds - their single placement
  // elevation doesn't represent the whole footprint the way a round,
  // bowl-shaped pond/lake's does, so they get a masking tolerance the
  // flat water bodies don't (see WATER_MASK_TOLERANCE in render-tile.js).
  const sloped = new Uint8Array(count);
  const slopedNamePattern = /^(stream|river)/i;

  let vCursor = 0; // vertex index (not coord index)
  let maxDiagonal = 0;

  for (let i = 0; i < count; i++) {
    const ring = ringsPerFeature[i];
    ringOffsets[i] = vCursor;
    const props = features[i].properties || {};
    if (Number.isFinite(props.elev)) elev[i] = props.elev;
    if (maskedNamePattern.test(props.objectName || '') && Number.isFinite(props.elev)) masked[i] = 1;
    if (slopedNamePattern.test(props.objectName || '')) sloped[i] = 1;
    if (!ring) {
      continue;
    }
    valid[i] = 1;
    const vertexElevList = props.vertexElev;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < ring.length; k++) {
      const x = ring[k][0], z = ring[k][1];
      vertexData[vCursor * 2 + 0] = x;
      vertexData[vCursor * 2 + 1] = z;
      const vElev = vertexElevList && Number.isFinite(vertexElevList[k]) ? vertexElevList[k] : props.elev;
      if (Number.isFinite(vElev)) vertexElev[vCursor] = vElev;
      vCursor += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    bbox[i * 4 + 0] = minX;
    bbox[i * 4 + 1] = minZ;
    bbox[i * 4 + 2] = maxX;
    bbox[i * 4 + 3] = maxZ;
    const dx = maxX - minX;
    const dz = maxZ - minZ;
    const diag = Math.sqrt(dx * dx + dz * dz);
    if (diag > maxDiagonal) maxDiagonal = diag;
  }
  ringOffsets[count] = vCursor;

  // Bucket features into every grid cell their bbox overlaps.
  const cellsPerSide = Math.max(1, Math.ceil(mapSize / cellSize));
  const buckets = new Array(cellsPerSide * cellsPerSide);

  for (let i = 0; i < count; i++) {
    if (!valid[i]) continue;
    const minX = bbox[i * 4 + 0];
    const minZ = bbox[i * 4 + 1];
    const maxX = bbox[i * 4 + 2];
    const maxZ = bbox[i * 4 + 3];

    let cx0 = Math.max(0, Math.min(cellsPerSide - 1, Math.floor(minX / cellSize)));
    let cx1 = Math.max(0, Math.min(cellsPerSide - 1, Math.floor(maxX / cellSize)));
    let cz0 = Math.max(0, Math.min(cellsPerSide - 1, Math.floor(minZ / cellSize)));
    let cz1 = Math.max(0, Math.min(cellsPerSide - 1, Math.floor(maxZ / cellSize)));

    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = cz * cellsPerSide + cx;
        if (!buckets[cell]) buckets[cell] = [];
        buckets[cell].push(i);
      }
    }
  }

  const maskedCount = masked.reduce((s, v) => s + v, 0);
  console.log(`[PolygonIndex] ${categoryName}: ${count} features, ${totalVerts} verts, maxDiagonal=${maxDiagonal.toFixed(2)}, terrain-masked=${maskedCount}`);

  return { cellSize, cellsPerSide, buckets, vertexData, ringOffsets, bbox, valid, maxDiagonal, count, elev, vertexElev, masked, sloped };
}

// Returns an array of feature indices (deduped) whose bbox overlaps
// [minX,maxX] x [minZ,maxZ], expanded by the index's maxDiagonal/2 margin.
function queryPolygonIndex(idx, minX, minZ, maxX, maxZ) {
  if (!idx || idx.count === 0) return [];
  const { cellSize, cellsPerSide, buckets, maxDiagonal } = idx;
  const margin = maxDiagonal / 2;

  let cx0 = Math.max(0, Math.min(cellsPerSide - 1, Math.floor((minX - margin) / cellSize)));
  let cx1 = Math.max(0, Math.min(cellsPerSide - 1, Math.floor((maxX + margin) / cellSize)));
  let cz0 = Math.max(0, Math.min(cellsPerSide - 1, Math.floor((minZ - margin) / cellSize)));
  let cz1 = Math.max(0, Math.min(cellsPerSide - 1, Math.floor((maxZ + margin) / cellSize)));

  const seen = new Set();
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const cell = cz * cellsPerSide + cx;
      const bucket = buckets[cell];
      if (!bucket) continue;
      for (const featIdx of bucket) seen.add(featIdx);
    }
  }
  return Array.from(seen);
}

// Returns the ring for a given feature index as an array of [x,z] pairs.
function getRing(idx, featIdx) {
  const start = idx.ringOffsets[featIdx];
  const end = idx.ringOffsets[featIdx + 1];
  const ring = new Array(end - start);
  for (let i = start; i < end; i++) {
    ring[i - start] = [idx.vertexData[i * 2 + 0], idx.vertexData[i * 2 + 1]];
  }
  return ring;
}

// Returns the per-vertex elevation for a given feature index, aligned 1:1
// with getRing's output (NaN entries fall back to the feature's scalar elev).
function getVertexElev(idx, featIdx) {
  const start = idx.ringOffsets[featIdx];
  const end = idx.ringOffsets[featIdx + 1];
  const out = new Array(end - start);
  for (let i = start; i < end; i++) {
    const v = idx.vertexElev[i];
    out[i - start] = Number.isFinite(v) ? v : idx.elev[featIdx];
  }
  return out;
}

module.exports = { buildPolygonIndex, queryPolygonIndex, getRing, getVertexElev };
