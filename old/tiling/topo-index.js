// Spatial index for the elevation-contour base layer (out/chernarus_contours_10m.geojson),
// used to bake a topographic "land/water by elevation band" background into tiles - the
// same visual as displayTopographic() in map-core.js, but rasterized ahead of time instead
// of drawn live as an SVG overlay, so it can be composited as the base of a flat PNG tile
// pyramid (see build-topo-tiles.js).
//
// IMPORTANT: this geojson uses a DIFFERENT (non-flipped) Y convention than every other
// category in this pipeline - see topoLocalToPixel below and displayTopographic's own
// coordsToLatLng in map-core.js, which this file's coordinates were generated to match.
// Do NOT reuse coords.js's localToPixel (which flips Y) for these.

const fs = require('fs');
const path = require('path');
const { worldPxAtZoom } = require('./coords');

function topoLocalToPixel(config, x, z, zoom) {
  const worldPx = worldPxAtZoom(config, zoom);
  const px = (x / config.mapSize) * worldPx;
  const py = (z / config.mapSize) * worldPx; // no flip - matches coordsToLatLng in map-core.js
  return [px, py];
}

// Flattens every (Multi)Polygon feature into individual polygon pieces - a MultiPolygon's
// disjoint parts get their own bbox each, which culls far better per-tile than one bbox for
// the whole feature (a single elevation band, e.g. "0m+", can span the entire island as many
// separate pieces). Holes (rings after the first) stay attached to their outer ring so they
// can be filled in one path together (canvas's default nonzero fill rule handles GeoJSON's
// outer-CCW/hole-CW winding convention correctly).
function buildTopoPolygons(ROOT, contoursFile = 'out/chernarus_contours_10m.geojson') {
  const filePath = path.isAbsolute(contoursFile) ? contoursFile : path.join(ROOT, contoursFile);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const polys = [];
  for (const feature of raw.features) {
    const elev = Number.isFinite(feature.properties?.elev)
      ? feature.properties.elev
      : Number.isFinite(feature.properties?.elevation)
        ? feature.properties.elevation
        : 0;
    const geom = feature.geometry;
    if (!geom) continue;
    const polyList = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    for (const rings of polyList) {
      if (!rings || !rings[0] || rings[0].length < 3) continue;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of rings[0]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      polys.push({ elev, rings, bbox: [minX, minZ, maxX, maxZ] });
    }
  }
  // Ascending elevation, matching displayTopographic's own draw order so higher
  // (later) bands correctly paint over lower ones where they nest.
  polys.sort((a, b) => a.elev - b.elev);

  const cellSize = 300;
  const buckets = new Map(); // Map-keyed, not a fixed-size array - no per-map size bound needed
  const cellKey = (cx, cz) => cx + ',' + cz;
  polys.forEach((poly, i) => {
    const [minX, minZ, maxX, maxZ] = poly.bbox;
    const cx0 = Math.floor(minX / cellSize), cx1 = Math.floor(maxX / cellSize);
    const cz0 = Math.floor(minZ / cellSize), cz1 = Math.floor(maxZ / cellSize);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cellKey(cx, cz);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
      }
    }
  });

  console.log(`[TopoIndex] ${polys.length} polygon pieces from ${raw.features.length} elevation bands`);
  return { polys, buckets, cellSize, cellKey };
}

// Returns polygon indices (in ascending-elevation draw order, deduped) whose bbox
// overlaps the given local-unit box.
function queryTopoIndex(index, minX, minZ, maxX, maxZ) {
  const { buckets, cellSize, cellKey } = index;
  const cx0 = Math.floor(minX / cellSize), cx1 = Math.floor(maxX / cellSize);
  const cz0 = Math.floor(minZ / cellSize), cz1 = Math.floor(maxZ / cellSize);
  const seen = new Set();
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const bucket = buckets.get(cellKey(cx, cz));
      if (!bucket) continue;
      for (const idx of bucket) seen.add(idx);
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}

module.exports = { buildTopoPolygons, queryTopoIndex, topoLocalToPixel };
