#!/usr/bin/env node
// One-off maintenance pass: simplifies footprint.geojson files already sitting
// in a map's vector-cache (out/mapdraw/vector-cache/<world>/) that were
// extracted before extract-model-footprint.js started simplifying at
// extraction time. Rewrites each oversized footprint in place with a 5cm
// tolerance (matching the extraction-time default) and updates the matching
// vertexCount/vertices fields in both the footprint file and cache-state.json,
// so no re-debin/re-extraction from source .p3d is needed.
const fs = require('fs');
const path = require('path');
const { simplify } = require('@turf/turf');

const ROOT = path.resolve(__dirname, '..');
const world = process.argv[2];
if (!world) throw new Error('Usage: node tools/simplify-footprint-cache.js <world> [--min-vertices N]');
const minVerticesArg = process.argv.indexOf('--min-vertices');
const MIN_VERTICES = minVerticesArg >= 0 ? Number(process.argv[minVerticesArg + 1]) : 200;
const SIMPLIFY_TOLERANCE = 0.05;

const cacheDir = path.join(ROOT, 'out', 'mapdraw', 'vector-cache', world);
const statePath = path.join(cacheDir, 'cache-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

function vertexCount(multiPolygon) {
  return multiPolygon.reduce((sum, polygon) => sum + polygon.reduce((n, ring) => n + ring.length, 0), 0);
}

let touched = 0, savedVertices = 0, skippedDegenerate = 0;
for (const [model, entry] of Object.entries(state.models)) {
  if (entry.status !== 'complete' || !entry.vertices || entry.vertices < MIN_VERTICES) continue;
  const footprintPath = path.resolve(ROOT, entry.footprint);
  if (!fs.existsSync(footprintPath)) continue;
  const feature = JSON.parse(fs.readFileSync(footprintPath, 'utf8'));
  const before = vertexCount(feature.geometry.coordinates);
  let simplified;
  try {
    simplified = simplify(feature.geometry, { tolerance: SIMPLIFY_TOLERANCE, highQuality: true });
  } catch (error) {
    // turf's internal clean-coords throws outright on some already-degenerate
    // rings (e.g. a sliver polygon under 4 points) rather than returning an
    // unsimplified result - leave that model's footprint exactly as extracted.
    console.warn(`${model}: simplify failed (${error.message}), leaving as-is`);
    skippedDegenerate++; continue;
  }
  if (!simplified.coordinates.every(polygon => polygon.every(ring => ring.length >= 4))) { skippedDegenerate++; continue; }
  const after = vertexCount(simplified.coordinates);
  feature.geometry.coordinates = simplified.coordinates;
  feature.properties.vertexCount = after;
  feature.properties.simplifiedTolerance = SIMPLIFY_TOLERANCE;
  fs.writeFileSync(footprintPath, `${JSON.stringify(feature)}\n`);
  entry.vertices = after;
  touched++; savedVertices += before - after;
  console.log(`${model}: ${before.toLocaleString()} -> ${after.toLocaleString()} vertices (x${entry.placementCount} placements)`);
}
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(`\nDone: ${touched} models simplified, ${skippedDegenerate} skipped (would degenerate), ${savedVertices.toLocaleString()} total vertices removed.`);
