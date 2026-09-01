// Welds nearby vertices across DIFFERENT features (e.g. a curve piece's
// endpoint and the next segment's start) that are meant to connect but land
// slightly apart due to per-piece geometry-approximation differences (each
// curve/endcap type has its own small quirk - missing width normalization,
// a chord-length formula that's a worse fit for near-square bboxes, etc).
// Rather than chasing each quirk individually, this closes any small visible
// gap generically: vertices from different features within `tolerance` of
// each other are clustered and pulled to their shared centroid.
//
// Tolerance must stay well under the category's own road/path width, or
// vertices on the long (side) edges of two genuinely separate, nearby-but-
// parallel segments could get welded together instead of just endpoints.

// extendedTolerance (optional, defaults to tolerance = no-op) widens the
// search radius, but ONLY between a feature pair that already got a
// confident weld at the base tolerance. Rectangular pieces connect along a
// whole shared edge (2 corners), but per-vertex tolerance matching alone
// sometimes only catches the closer of the two - e.g. when adjacent pieces
// are slightly rotated relative to each other - leaving the far corner
// unwelded and producing a lopsided pinch/bowtie instead of a clean joint.
// Gating the wider radius on "this pair already has one confirmed corner
// match" catches that far corner without loosening matching for vertices
// that just happen to be somewhat close elsewhere on the map.
function snapConnectorVertices(features, tolerance = 1.0, extendedTolerance = tolerance) {
  const cellSize = tolerance;
  const cellKey = (cx, cz) => cx + ',' + cz;

  // A curve ring (createCurvePolygon: outer arc + inner arc) only has TWO
  // real connector corners per end - the many interior arc-width vertices
  // between them exist purely to shape the bend, spaced just 1-3m apart,
  // and were never meant to touch a neighbor. Treating them as weld
  // candidates too (indistinguishable from real endpoints once flattened
  // into a plain vertex list) lets an unrelated nearby piece's interior
  // point drag one of them sideways, visibly denting the curve into a
  // spike/triangle - worse the wider the tolerance. `eligible` restricts
  // matching to the ring's actual endpoints for isCurve features; straight
  // (non-curve) rings are unaffected - every one of their corners is a
  // legitimate potential connector, as before.
  const allVerts = []; // flat list: {fi, vi, x, z, eligible}
  features.forEach((f, fi) => {
    const ring = f.geometry.coordinates[0];
    const isCurve = f.properties && f.properties.isCurve;
    const openLen = ring.length - 1; // last point duplicates the first (closed ring)
    const mid = Math.floor(openLen / 2);
    ring.forEach((pt, vi) => {
      const eligible = !isCurve || vi === 0 || vi === mid - 1 || vi === mid || vi === openLen - 1 || vi === ring.length - 1;
      allVerts.push({ fi, vi, x: pt[0], z: pt[1], eligible });
    });
  });

  const grid = new Map();
  for (let i = 0; i < allVerts.length; i++) {
    const v = allVerts[i];
    if (!v.eligible) continue;
    const key = cellKey(Math.floor(v.x / cellSize), Math.floor(v.z / cellSize));
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }

  const parent = new Int32Array(allVerts.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Pass 1: weld vertices within the base tolerance - the confident,
  // unambiguous matches.
  const tol2 = tolerance * tolerance;
  for (let i = 0; i < allVerts.length; i++) {
    const v = allVerts[i];
    if (!v.eligible) continue;
    const cx = Math.floor(v.x / cellSize), cz = Math.floor(v.z / cellSize);
    for (let dcz = -1; dcz <= 1; dcz++) {
      for (let dcx = -1; dcx <= 1; dcx++) {
        const bucket = grid.get(cellKey(cx + dcx, cz + dcz));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const w = allVerts[j];
          if (w.fi === v.fi) continue; // only weld across different features
          const dx = w.x - v.x, dz = w.z - v.z;
          if (dx * dx + dz * dz <= tol2) union(i, j);
        }
      }
    }
  }

  // Pass 2: for feature pairs that already share a pass-1 weld, widen the
  // search radius to extendedTolerance to catch the other corner of that
  // same connector edge - see comment on the function signature.
  if (extendedTolerance > tolerance) {
    const confirmedPairs = new Set();
    const clusterFeatures = new Map();
    for (let i = 0; i < allVerts.length; i++) {
      const r = find(i);
      let fset = clusterFeatures.get(r);
      if (!fset) { fset = new Set(); clusterFeatures.set(r, fset); }
      fset.add(allVerts[i].fi);
    }
    for (const fset of clusterFeatures.values()) {
      if (fset.size < 2) continue;
      const arr = Array.from(fset);
      for (let a = 0; a < arr.length; a++) {
        for (let b = a + 1; b < arr.length; b++) {
          confirmedPairs.add(arr[a] + ':' + arr[b]);
          confirmedPairs.add(arr[b] + ':' + arr[a]);
        }
      }
    }

    const extTol2 = extendedTolerance * extendedTolerance;
    const extCellRadius = Math.ceil(extendedTolerance / cellSize);
    for (let i = 0; i < allVerts.length; i++) {
      const v = allVerts[i];
      if (!v.eligible) continue;
      const cx = Math.floor(v.x / cellSize), cz = Math.floor(v.z / cellSize);
      for (let dcz = -extCellRadius; dcz <= extCellRadius; dcz++) {
        for (let dcx = -extCellRadius; dcx <= extCellRadius; dcx++) {
          const bucket = grid.get(cellKey(cx + dcx, cz + dcz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const w = allVerts[j];
            if (w.fi === v.fi) continue;
            if (find(i) === find(j)) continue;
            if (!confirmedPairs.has(v.fi + ':' + w.fi)) continue;
            const dx = w.x - v.x, dz = w.z - v.z;
            if (dx * dx + dz * dz <= extTol2) union(i, j);
          }
        }
      }
    }
  }

  const clusterSum = new Map(); // root -> {sx, sz, count}
  for (let i = 0; i < allVerts.length; i++) {
    const r = find(i);
    let c = clusterSum.get(r);
    if (!c) { c = { sx: 0, sz: 0, count: 0 }; clusterSum.set(r, c); }
    c.sx += allVerts[i].x;
    c.sz += allVerts[i].z;
    c.count++;
  }

  // Also propagate a per-vertex "elev" attribute (masked water features'
  // placement elevation) through the same weld clusters. Each feature only
  // carries ONE elevation for its whole footprint - with no native
  // per-corner data - so two welded-together pieces can still disagree on
  // where the elevation-mask cutoff sits right at their now-shared edge,
  // leaving a gap exactly at the seam even though the geometry itself is
  // perfectly joined. Averaging elev across whichever features meet at each
  // vertex (same clusters as position) and outputting it as vertexElev lets
  // the render step interpolate a smooth per-pixel threshold across each
  // piece's footprint instead of using one flat number, so neighbors agree
  // exactly at the boundary they now share.
  const hasElev = features.some((f) => Number.isFinite(f.properties && f.properties.elev));
  let vertexElevOut = null;
  if (hasElev) {
    const elevClusterSum = new Map(); // root -> {sum, count}
    for (let i = 0; i < allVerts.length; i++) {
      const v = allVerts[i];
      const fElev = features[v.fi].properties && features[v.fi].properties.elev;
      if (!Number.isFinite(fElev)) continue;
      const r = find(i);
      let c = elevClusterSum.get(r);
      if (!c) { c = { sum: 0, count: 0 }; elevClusterSum.set(r, c); }
      c.sum += fElev;
      c.count++;
    }
    vertexElevOut = features.map((f) => {
      const fElev = f.properties && f.properties.elev;
      const fallback = Number.isFinite(fElev) ? fElev : NaN;
      return f.geometry.coordinates[0].map(() => fallback);
    });
    for (let i = 0; i < allVerts.length; i++) {
      const v = allVerts[i];
      const fElev = features[v.fi].properties && features[v.fi].properties.elev;
      if (!Number.isFinite(fElev)) continue;
      const r = find(i);
      const c = elevClusterSum.get(r);
      if (c.count > 1) vertexElevOut[v.fi][v.vi] = c.sum / c.count;
    }
  }

  const newRings = features.map((f) => f.geometry.coordinates[0].map((pt) => [pt[0], pt[1]]));
  let snappedVertexCount = 0;
  let touchedFeatures = new Set();
  for (let i = 0; i < allVerts.length; i++) {
    const r = find(i);
    const c = clusterSum.get(r);
    if (c.count <= 1) continue;
    const v = allVerts[i];
    const nx = c.sx / c.count, nz = c.sz / c.count;
    if (nx !== v.x || nz !== v.z) {
      snappedVertexCount++;
      touchedFeatures.add(v.fi);
    }
    newRings[v.fi][v.vi] = [nx, nz];
  }

  const snapped = features.map((f, fi) => ({
    ...f,
    properties: vertexElevOut ? { ...f.properties, vertexElev: vertexElevOut[fi] } : f.properties,
    geometry: { ...f.geometry, coordinates: [newRings[fi]] },
  }));

  return { features: snapped, snappedVertexCount, touchedFeatureCount: touchedFeatures.size };
}

module.exports = { snapConnectorVertices };
