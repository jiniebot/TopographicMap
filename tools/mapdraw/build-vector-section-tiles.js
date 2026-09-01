#!/usr/bin/env node

// Encode a bounded world-coordinate footprint GeoJSON as local-CRS MVT tiles.

const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');
const { intersection } = require('polyclip-ts');
const vtpbf = require('vt-pbf');
const { readLargeFeatureCollection } = require('./lib/read-large-feature-collection');

const ROOT = path.resolve(__dirname, '..', '..');
function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
const input = path.resolve(ROOT, arg('--input', 'out/mapdraw/vector-tests/section-6600-8930-400m.geojson'));
const output = path.resolve(ROOT, arg('--out', 'out/mapdraw/vector-tests/tiles'));
const mapSize = Number(arg('--map-size', 12800));
const minZoom = Number(arg('--min-zoom', 6));
const maxZoom = Number(arg('--max-zoom', 8));
const layerName = arg('--layer', 'objects');
const extent = 4096;
if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
if (![mapSize, minZoom, maxZoom].every(Number.isFinite) || minZoom < 0 || maxZoom < minZoom || maxZoom > 10) throw new Error('Invalid tiling arguments');

// A dense z6 tile's objects.geojson can exceed 500MB (measured up to
// 680MB+ in practice) - fs.readFileSync(...,'utf8') tries to materialize
// the whole file as one JS string and throws ERR_STRING_TOO_LONG well
// before running out of actual memory. Stream it in and split out each
// feature individually instead (mirrors build-vector-section.js's
// streaming writer on the way in).
const source = readLargeFeatureCollection(input);
const boundsArg = arg('--bounds', null);
const sourceBounds = boundsArg ? boundsArg.split(',').map(Number) : (source.properties?.bounds || [0, 0, mapSize, mapSize]);
if (sourceBounds.length !== 4 || !sourceBounds.every(Number.isFinite)) throw new Error('Invalid --bounds minX,minZ,maxX,maxZ');

function rectangle(minX, minZ, maxX, maxZ) {
  return [[[[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ], [minX, minZ]]]];
}
function bboxOfGeometry(geometry) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const polygon of geometry.coordinates) for (const ring of polygon) for (const [x, z] of ring) {
    minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  }
  return [minX, minZ, maxX, maxZ];
}
function overlaps(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

function cleanRing(ring) {
  const points = [];
  for (const point of ring) {
    const prior = points[points.length - 1];
    if (!prior || prior[0] !== point[0] || prior[1] !== point[1]) points.push(point);
  }
  if (points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) points.pop();
  if (new Set(points.map(point => `${point[0]},${point[1]}`)).size < 3) return null;
  points.push([...points[0]]);
  return points;
}
function cleanFeature(feature) {
  const polygons = [];
  for (const polygon of feature.geometry.coordinates) {
    const outer = cleanRing(polygon[0] || []);
    if (!outer) continue;
    const rings = [outer];
    for (const hole of polygon.slice(1)) { const cleaned = cleanRing(hole); if (cleaned) rings.push(cleaned); }
    polygons.push(rings);
  }
  return polygons.length ? { ...feature, geometry: { type: 'MultiPolygon', coordinates: polygons } } : null;
}

const features = source.features.map(cleanFeature).filter(Boolean).map(feature => ({ feature, bbox: bboxOfGeometry(feature.geometry) }));
const counts = {};
for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
  fs.rmSync(path.join(output,String(zoom)),{recursive:true,force:true});
  const side = 2 ** zoom;
  const tileWorld = mapSize / side;
  const tolerance = tileWorld / 256 * 0.5;
  const tx0 = Math.max(0, Math.floor(sourceBounds[0] / tileWorld));
  const tx1 = Math.min(side - 1, Math.floor(sourceBounds[2] / tileWorld));
  const ty0 = Math.max(0, Math.floor((mapSize - sourceBounds[3]) / tileWorld));
  const ty1 = Math.min(side - 1, Math.floor((mapSize - sourceBounds[1]) / tileWorld));
  let written = 0, encodedFeatures = 0, encodedBytes = 0;
  const zoomFeatures = features.map(candidate => {
    let feature;
    try { feature = turf.simplify(candidate.feature, { tolerance, highQuality: false, mutate: false }); }
    catch { feature = candidate.feature; }
    return { feature, bbox: bboxOfGeometry(feature.geometry) };
  });

  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const minX = tx * tileWorld, maxX = minX + tileWorld;
    const maxZ = mapSize - ty * tileWorld, minZ = maxZ - tileWorld;
    const tileBBox = [minX, minZ, maxX, maxZ];
    const tileFeatures = [];
    for (const candidate of zoomFeatures) {
      if (!overlaps(candidate.bbox, tileBBox)) continue;
      let clipped;
      // polyclip-ts can throw on a numerically degenerate ring (e.g. a
      // near-zero-width sliver from an odd placement). One bad feature must
      // not drop every other feature in this output tile - skip just it.
      try { clipped = intersection(candidate.feature.geometry.coordinates, rectangle(minX, minZ, maxX, maxZ)); }
      catch (error) { console.warn(`Unable to clip feature ${candidate.feature.properties?.id ?? '(unknown)'} to tile ${zoom}/${tx}/${ty}: ${error.message}`); continue; }
      if (!clipped.length) continue;
      const rings = [];
      for (const polygon of clipped) for (const ring of polygon) {
        if (ring.length < 4) continue;
        rings.push(ring.map(([wx, wz]) => [
          Math.max(0, Math.min(extent, Math.round((wx - minX) / tileWorld * extent))),
          Math.max(0, Math.min(extent, Math.round((maxZ - wz) / tileWorld * extent))),
        ]));
      }
      if (!rings.length) continue;
      tileFeatures.push({
        id: candidate.feature.properties.id,
        type: 3,
        geometry: rings,
        tags: candidate.feature.properties,
      });
    }
    if (!tileFeatures.length) continue;
    // Elevation order remains deterministic in the encoded feature stream.
    tileFeatures.sort((a, b) => a.tags.topElevation - b.tags.topElevation);
    const buffer = vtpbf.fromGeojsonVt({ [layerName]: { features: tileFeatures } }, { version: 2, extent });
    const dir = path.join(output, String(zoom), String(tx));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ty}.pbf`), buffer);
    written++; encodedFeatures += tileFeatures.length; encodedBytes += buffer.length;
  }
  counts[zoom] = { tiles: written, features: encodedFeatures, bytes: encodedBytes, toleranceMeters: tolerance };
  console.log(`z${zoom}: ${written} tiles, ${encodedFeatures} clipped features, ${(encodedBytes / 1024).toFixed(1)} KiB`);
}
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'tile-meta.json'), `${JSON.stringify({ schemaVersion: 1, format: 'mvt', layer: layerName, mapSize, extent, minZoom, maxZoom, sourceBounds, counts }, null, 2)}\n`);
console.log(`MVT section: ${output}`);
