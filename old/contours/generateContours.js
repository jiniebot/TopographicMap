const fs = require("fs");
const path = require("path");
const { contours } = require("d3-contour");
const { MAP_CONFIGS } = require("../map-config");

const ROOT = path.join(__dirname, "..", "..");
const STEP_METERS = 10;

function loadFloat32Grid(absPath, width, height) {
  const buf = fs.readFileSync(absPath);
  // IMPORTANT: assumes the file is raw float32 little-endian packed with no header
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (arr.length !== width * height) {
    throw new Error(`Grid size mismatch. Expected ${width * height}, got ${arr.length}`);
  }
  return arr;
}

// Convert d3-contour output to GeoJSON MultiPolygon in world meters (x,z)
function contourToFeature(c, stepMeters, height, flipY = false) {
  // d3-contour returns polygon rings in grid coordinates (col,row)
  // Elevation grids use the renderer's southwest origin: row zero is world
  // Z=0 and increasing rows move north. Only web tile Y is north-to-south;
  // flipping here mirrors contour geometry independently of the terrain.
  const coords = c.coordinates.map(poly =>
    poly.map(ring =>
      ring.map(([col, row]) => {
        const x = col * stepMeters;
        const z = (flipY ? (height - 1 - row) : row) * stepMeters; // flip if your raster origin is top-left
        // GeoJSON expects [lng, lat]; for CRS.Simple you can treat that as [x, z]
        return [x, z];
      })
    )
  );

  return {
    type: "Feature",
    properties: { elev: c.value },
    geometry: { type: "MultiPolygon", coordinates: coords }
  };
}

function generate(mapName, intervalMeters = STEP_METERS) {
  const cfg = MAP_CONFIGS[mapName];
  if (!cfg) throw new Error(`Unknown map: ${mapName}`);
  const outPath = path.join(ROOT, cfg.contoursFile);

  const abs = path.join(ROOT, cfg.elevationFile);
  const grid = loadFloat32Grid(abs, cfg.elevationWidth, cfg.elevationHeight);

  // Threshold range computed from this map's own data instead of a fixed
  // -50..1000 - maps don't share a common elevation datum (Chernarus/Sakhal
  // dip below 0 at their coastline, Livonia's lowest point is still +146,
  // see the water-cutoff note in topo-index.js), so a fixed range either
  // wastes thousands of empty out-of-range bands or - worse - silently
  // clips off real terrain above/below a range tuned for a different map.
  let dataMin = Infinity, dataMax = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }
  const rangeStart = Math.floor(dataMin / intervalMeters) * intervalMeters - intervalMeters;
  const rangeEnd = Math.ceil(dataMax / intervalMeters) * intervalMeters + intervalMeters;
  console.log(`[generateContours] ${mapName}: data range ${dataMin.toFixed(1)}..${dataMax.toFixed(1)}, thresholds ${rangeStart}..${rangeEnd}`);
  const thresholds = [];
  for (let t = rangeStart; t <= rangeEnd; t += intervalMeters) thresholds.push(t);

  const gen = contours().size([cfg.elevationWidth, cfg.elevationHeight]).thresholds(thresholds);
  const cs = gen(grid); // array of contour polygons

  const fc = {
    type: "FeatureCollection",
    features: cs.map(c => contourToFeature(c, STEP_METERS, cfg.elevationHeight, false))
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(fc), "utf8");
  console.log(`Wrote ${fc.features.length} contours → ${outPath}`);
}

const targetArg = process.argv[2];
const targets = targetArg ? [targetArg] : Object.keys(MAP_CONFIGS);
for (const mapName of targets) generate(mapName);
