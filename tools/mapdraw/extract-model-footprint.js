#!/usr/bin/env node

// Extract a reusable, true top-down vector silhouette from a debinarized MLOD.
// Every non-degenerate triangle in the selected visual LOD is projected onto
// model-local X/Z, then polygon-unioned. The result is suitable for applying
// WRP placement transforms and encoding into topographic vector tiles.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { union } = require('polyclip-ts');
const { createCanvas } = require('@napi-rs/canvas');
const { simplify } = require('@turf/turf');

const ROOT = path.resolve(__dirname, '..', '..');
const input = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'mapdraw', 'house_1w03_mlod.p3d'));
const output = path.resolve(process.argv[3] || input.replace(/\.p3d$/i, '-footprint.geojson'));
const P3D_MODULE = path.join(ROOT, 'vendor', 'BIS-Toolkit', 'packages', 'p3d', 'dist', 'index.js');
const MIN_PROJECTED_AREA = 1e-7;
const UNION_BATCH = 250;
const MAX_UNION_TRIANGLES = 300;
const UNION_COORDINATE_STEP = 1e-4;
const FORCE_CONVEX_HULL = process.argv.includes('--force-convex-hull');

function convexHull(points) {
  const unique = [...new Map(points.map(point => [`${point[0]},${point[1]}`, point])).values()]
    .sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  if (unique.length < 3) return unique;
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lower=[]; for(const p of unique){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p)}
  const upper=[]; for(const p of [...unique].reverse()){while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p)}
  lower.pop();upper.pop();const hull=lower.concat(upper);hull.push([...hull[0]]);return hull;
}

async function rasterSilhouette(triangles, bounds) {
  const size=256, spanX=Math.max(1e-6,bounds.maxX-bounds.minX), spanZ=Math.max(1e-6,bounds.maxZ-bounds.minZ);
  const canvas=createCanvas(size,size),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';
  for(const triangle of triangles){const ring=triangle[0][0];ctx.beginPath();for(let i=0;i<ring.length;i++){const px=(ring[i][0]-bounds.minX)/spanX*(size-1),py=(bounds.maxZ-ring[i][1])/spanZ*(size-1);if(i)ctx.lineTo(px,py);else ctx.moveTo(px,py)}ctx.fill()}
  const pixels=ctx.getImageData(0,0,size,size).data,values=new Float32Array(size*size);for(let i=0;i<values.length;i++)values[i]=pixels[i*4+3]/255;
  const {contours}=await import('d3-contour'),shape=contours().size([size,size]).thresholds([.5]).smooth(true)(values)[0];
  return (shape?.coordinates||[]).map(poly=>poly.map(ring=>ring.map(([px,py])=>[bounds.minX+px/(size-1)*spanX,bounds.maxZ-py/(size-1)*spanZ])));
}

function signedArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return area / 2;
}

function vertexCount(multiPolygon) {
  return multiPolygon.reduce((sum, polygon) => sum + polygon.reduce((n, ring) => n + ring.length, 0), 0);
}

async function main() {
  if (!fs.existsSync(input)) throw new Error(`MLOD not found: ${input}`);
  const { Mlod } = await import(pathToFileURL(P3D_MODULE));
  const model = Mlod.fromBuffer(fs.readFileSync(input));
  const lod = model.lods
    .filter(candidate => candidate.resolution >= 0 && candidate.resolution < 1000 && candidate.facesCount > 0)
    .sort((a, b) => a.resolution - b.resolution)[0];
  if (!lod) throw new Error('No visual LOD with faces found');

  const bounds = lod.vertices.reduce((box, point) => ({
    minX: Math.min(box.minX, point.x), maxX: Math.max(box.maxX, point.x),
    minY: Math.min(box.minY, point.y), maxY: Math.max(box.maxY, point.y),
    minZ: Math.min(box.minZ, point.z), maxZ: Math.max(box.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });

  const triangles = [];
  for (const face of lod.faces) {
    const used = face.getUsedVertices();
    if (used.length < 3) continue;
    for (let i = 1; i < used.length - 1; i++) {
      const points = [used[0], used[i], used[i + 1]].map(v => lod.vertices[v.pointIndex]);
      // Thin rails commonly contain coincident authored edges whose decoded
      // floats differ by tiny amounts. Quantize before clipping so polyclip
      // sees those shared edges as identical rather than open micro-segments.
      const ring = points.map(p => [
        Math.round(p.x / UNION_COORDINATE_STEP) * UNION_COORDINATE_STEP,
        Math.round(p.z / UNION_COORDINATE_STEP) * UNION_COORDINATE_STEP,
      ]);
      if (Math.abs(signedArea(ring)) < MIN_PROJECTED_AREA) continue;
      ring.push([...ring[0]]);
      triangles.push([[ring]]);
    }
  }
  if (!triangles.length) throw new Error('Visual LOD has no non-degenerate top-down triangles');

  // Incremental batches avoid passing tens of thousands of arguments to the
  // clipping library for detailed buildings while producing the same union.
  let geometry = [], method = 'triangle-union';
  if (FORCE_CONVEX_HULL) {
    const hull=convexHull(lod.vertices.map(point=>[point.x,point.z]));
    if(hull.length<4)throw new Error('Unable to construct projected convex hull');
    geometry=[[[...hull]]];method='convex-hull-vegetation';
  } else if (triangles.length > MAX_UNION_TRIANGLES) {
    geometry=await rasterSilhouette(triangles,bounds);method='rasterized-silhouette-complexity-fallback';
  } else {
    try {
      for (let i = 0; i < triangles.length; i += UNION_BATCH) {
        const batch = triangles.slice(i, i + UNION_BATCH);
        geometry = geometry.length ? union(geometry, ...batch) : union(...batch);
      }
    } catch (error) {
      geometry=await rasterSilhouette(triangles,bounds);
      method='rasterized-silhouette-union-fallback';
      if(!geometry.length)throw error;
    }
  }

  // The raster-silhouette fallback in particular (marching squares over a
  // 256px canvas, with smoothing) can produce 1000+ vertices for a single
  // rock/plant model's outline - a level of detail well past what's ever
  // visually distinguishable. Every placement of that model re-embeds the
  // full uncompressed polygon into its tile's output, so this compounds:
  // one over-detailed footprint placed hundreds of times across a dense
  // forest tile is exactly what pushed a single z5 tile's combined GeoJSON
  // past V8's string-length limit downstream. Simplifying once here, at the
  // per-model cache layer, caps every placement's contribution cheaply
  // instead of needing to fix it per-tile. 5cm tolerance is far below
  // rendered/pixel significance at any zoom this pipeline targets.
  const SIMPLIFY_TOLERANCE = 0.05;
  if (geometry.length) {
    try {
      // turf's internal clean-coords throws outright on some already-
      // degenerate rings (e.g. a sliver polygon under 4 points) instead of
      // returning an unsimplified result - fall back to the un-simplified
      // geometry rather than losing this model's footprint entirely.
      const simplified = simplify({ type: 'MultiPolygon', coordinates: geometry }, { tolerance: SIMPLIFY_TOLERANCE, highQuality: true });
      if (simplified.coordinates.every(polygon => polygon.every(ring => ring.length >= 4))) geometry = simplified.coordinates;
    } catch (error) {
      console.warn(`Simplify failed (${error.message}), keeping unsimplified footprint`);
    }
  }

  const feature = {
    type: 'Feature',
    properties: {
      schemaVersion: 1,
      source: input,
      lodResolution: lod.resolution,
      sourceFaces: lod.faces.length,
      projectedTriangles: triangles.length,
      footprintMethod: method,
      polygonCount: geometry.length,
      vertexCount: vertexCount(geometry),
      minY: bounds.minY,
      maxY: bounds.maxY,
    },
    geometry: { type: 'MultiPolygon', coordinates: geometry },
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(feature)}\n`);
  console.log(`Footprint: ${output}`);
  console.log(`LOD ${lod.resolutionName}; ${triangles.length.toLocaleString()} projected triangles -> ${geometry.length.toLocaleString()} polygons / ${feature.properties.vertexCount.toLocaleString()} vertices`);
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
