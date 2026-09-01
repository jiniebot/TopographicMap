const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const { snapConnectorVertices } = require('./snap-connectors');

// Categories where adjacent placed pieces (curve-to-curve, curve-to-straight,
// endcap-to-curve) are meant to connect edge-to-edge but can land a small gap
// apart due to per-piece geometry-approximation quirks - see snap-connectors.js.
// Buffered in memory (instead of streamed straight to disk) so nearby vertices
// across different features can be found and welded before writing.
const SNAP_CATEGORIES = new Set(['asf_roads', 'city_roads', 'grav_roads', 'mud_roads', 'paths', 'sidewalks', 'water']);
const DEFAULT_SNAP_TOLERANCE = { tolerance: 1.0, extendedTolerance: 1.0 };
// Water pieces are much wider than roads/sidewalks (streams 14m, rivers
// 24m), and their curve-chord approximation is less refined, so the same
// geometry-approximation gaps land proportionally larger in absolute terms -
// measured median ~1.4m, 90th percentile ~3.6m between two curve pieces'
// nearest cross-feature vertices, well above the 1.0 default. 4.0 catches
// the large majority of real joints while staying well under half the
// narrowest water piece's width (stream, 14m), so it shouldn't weld two
// genuinely separate, merely-nearby strands together.
//
// Straight pieces connect along a whole shared edge (2 corners), but when
// two adjacent pieces are slightly rotated relative to each other, the base
// tolerance alone often only catches the closer of the two corners - the
// far corner lands 5-9m out, well past 4.0 - producing a lopsided
// pinch/bowtie instead of a clean joint. extendedTolerance (see
// snap-connectors.js's pass 2) widens the search radius, but only for a
// feature pair that already has one confirmed weld, so it doesn't loosen
// matching for vertices that just happen to be near unrelated pieces.
const SNAP_TOLERANCE_BY_CATEGORY = { water: { tolerance: 4.0, extendedTolerance: 12.0 } };
// Only water gets a raised tolerance - road categories stay at the
// conservative default. A per-category width-scaled tolerance was tried
// here and reverted: it visibly distorted the shortest/sharpest road curve
// pieces, and touched every road on the map to chase what turned out to be
// a narrow problem with just those pieces.
function snapToleranceFor(categoryName) {
  return SNAP_TOLERANCE_BY_CATEGORY[categoryName] ?? DEFAULT_SNAP_TOLERANCE;
}

// Thin cosmetic edging pieces (e.g. sidewalk3_border, ~1m wide - comparable to
// SNAP_TOLERANCE itself) aren't meant to weld end-to-end like walkway/road
// segments; they run alongside a path, and welding them pulls their own
// opposite short-edge corners together across unrelated nearby features,
// collapsing the rectangle into a degenerate sliver. Exclude them from the
// snap buffer entirely - write them as-is.
function shouldSnapFeature(categoryName, objectName) {
  if (categoryName === 'sidewalks' && /border/i.test(objectName)) return false;
  return true;
}

const ROOT = path.join(__dirname, '..', '..');

const mapStylesPath = path.join(ROOT, 'public', 'js', 'map-styles.js');
const mapStylesCode = fs.readFileSync(mapStylesPath, 'utf-8');
const mapStylesSandbox = { console, window: {} };
vm.createContext(mapStylesSandbox);
vm.runInContext(mapStylesCode + '\n;this.__mapStylesExport = mapStyles;', mapStylesSandbox);
const mapStyles = mapStylesSandbox.__mapStylesExport;

const configPath = path.join(ROOT, 'public', 'js', 'config.js');
const configCode = fs.readFileSync(configPath, 'utf-8');
const configSandbox = { console };
vm.createContext(configSandbox);
vm.runInContext(configCode + '\n;this.__configExport = config; this.__worldSizeExport = WORLD_SIZE;', configSandbox);
const config = configSandbox.__configExport;
const WORLD_SIZE = configSandbox.__worldSizeExport;

function loadCoreCustomDrawers() {
  const mapCorePath = path.join(ROOT, 'public', 'js', 'map-core.js');
  const mapCoreCode = fs.readFileSync(mapCorePath, 'utf-8');
  const coreSandbox = {
    console,
    mapStyles,
    config,
    WORLD_SIZE,
    window: {},
    document: { readyState: 'loading', addEventListener: () => {} },
    setTimeout: () => {},
    clearTimeout: () => {},
  };
  vm.createContext(coreSandbox);
  vm.runInContext(
    mapCoreCode +
      "\n;this.__coreCustomObjectDrawers = typeof coreCustomObjectDrawers !== 'undefined' ? coreCustomObjectDrawers : null;",
    coreSandbox
  );
  return coreSandbox.__coreCustomObjectDrawers || null;
}

const coreCustomObjectDrawers = loadCoreCustomDrawers();

const bboxCachePath = path.join(ROOT, 'out', 'bboxCache.rectangles.json');
const bboxCache = fs.existsSync(bboxCachePath)
  ? JSON.parse(fs.readFileSync(bboxCachePath, 'utf-8'))
  : {};

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
};
const onlyArg = getArg('--only');
const skipArg = getArg('--skip');
const circlePointsArg = getArg('--circle-points');
const circlePoints = circlePointsArg ? Math.max(8, parseInt(circlePointsArg, 10) || 32) : 32;

const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
const skip = skipArg ? new Set(skipArg.split(',').map((s) => s.trim()).filter(Boolean)) : new Set();

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

function findBBox(name) {
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

function snapRing(ring, gridSize = 0.5) {
  return ring.map(([x, z]) => [
    Math.round(x / gridSize) * gridSize,
    Math.round(z / gridSize) * gridSize,
  ]);
}

function rotateRing(ring, yawDeg, center) {
  if (!yawDeg) return ring;
  const rad = (-(yawDeg) * Math.PI) / 180;
  return ring.map(([x, z]) => {
    const dx = x - center[0];
    const dz = z - center[1];
    const rotX = dx * Math.cos(rad) - dz * Math.sin(rad);
    const rotZ = dx * Math.sin(rad) + dz * Math.cos(rad);
    return [center[0] + rotX, center[1] + rotZ];
  });
}

function computeBounds(ring) {
  if (!ring || ring.length === 0) return null;
  let minX = ring[0][0];
  let maxX = ring[0][0];
  let minZ = ring[0][1];
  let maxZ = ring[0][1];
  for (let i = 1; i < ring.length; i++) {
    minX = Math.min(minX, ring[i][0]);
    maxX = Math.max(maxX, ring[i][0]);
    minZ = Math.min(minZ, ring[i][1]);
    maxZ = Math.max(maxZ, ring[i][1]);
  }
  return { minX, maxX, minZ, maxZ };
}

function createCircleRing(x, z, radius, points = 32) {
  const ring = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    ring.push([x + radius * Math.cos(angle), z + radius * Math.sin(angle)]);
  }
  return ring;
}

function toFeature(categoryName, objectName, rings, elev, isCurve) {
  const geom = {
    type: 'Polygon',
    coordinates: rings.map((r) => {
      const closed = [...r, r[0]];
      return closed;
    }),
  };
  const properties = {
    category: categoryName,
    objectName: objectName || `${categoryName}_object`,
    isUnion: 0,
  };
  if (Number.isFinite(elev)) properties.elev = elev;
  // Curve pieces (createCurvePolygon: outer arc + inner arc, densely
  // subdivided to approximate the bend) only have TWO real connector
  // corners per end - the many interior arc-width vertices between them
  // exist purely to shape the curve, not to touch a neighbor. Flagging this
  // lets snap-connectors.js restrict cross-feature welding to just the true
  // endpoints (see there for what goes wrong otherwise).
  if (isCurve) properties.isCurve = true;
  return {
    type: 'Feature',
    properties,
    geometry: geom,
  };
}

const categories = Object.entries(mapStyles.categories)
  .map(([name, cfg]) => ({ name, cfg }))
  .filter(({ name }) => (only ? only.includes(name) : true))
  .filter(({ name }) => !skip.has(name));

if (categories.length === 0) {
  console.error('[Prebuild] No categories selected.');
  process.exit(1);
}

const outDir = path.join(ROOT, 'out', 'prebuilt');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

async function processCategory(categoryName, cfg) {
  if (!cfg || !cfg.file) return;
  const filePath = path.join(ROOT, 'data', 'TBData', 'Chernarus', 'categorized', cfg.file);
  if (!fs.existsSync(filePath)) {
    console.warn(`[Prebuild] Missing file for ${categoryName}: ${filePath}`);
    return;
  }

  console.log(`[Prebuild] ${categoryName} -> ${filePath}`);

  const shouldSnap = SNAP_CATEGORIES.has(categoryName);
  const snapBuffer = [];

  const outPath = path.join(outDir, `${categoryName}-prebuilt.geojson`);
  const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
  stream.write('{"type":"FeatureCollection","features":[');
  let wroteAny = false;
  let featureCount = 0;

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

    const x = getNumber(item.x ?? item.Local_X) ?? null;
    const z = getNumber(item.z ?? item.Local_Z) ?? null;
    const yaw = getNumber(item.yaw ?? item.Yaw) ?? 0;
    const elev = getNumber(item.Absolute_Elevation ?? item.absolute_elevation);

    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;

    const bbox = findBBox(name);

    let customCorners = null;
    let usedCustom = false;
    let isCurve = false;
    if (bbox && coreCustomObjectDrawers && coreCustomObjectDrawers[name]) {
      try {
        customCorners = coreCustomObjectDrawers[name](x, z, yaw, bbox, cfg, bboxCache);
        if (customCorners && customCorners.length >= 3) {
          usedCustom = true;
          // Captured now, before ring gets reassigned by snapRing/rotateRing
          // below (Array.prototype.map() returns a plain new array and
          // drops this custom property, so checking ring._isCurve AFTER
          // those reassignments would silently see undefined instead).
          isCurve = !!customCorners._isCurve;
        }
      } catch (e) {
        console.warn(`[Prebuild] Custom drawer failed for ${name}:`, e?.message || e);
      }
    }

    let feature = null;

    if (cfg.drawType === 'circle') {
      if (usedCustom) {
        let ring = customCorners;
        const rotationCenter = ring._rotationCenter || [x, z];
        const extraYaw = ring._extraYawDeg || 0;
        if (!ring._noSnap) ring = snapRing(ring, 0.5);
        if ((yaw || extraYaw) && !ring._alreadyRotated) {
          ring = rotateRing(ring, yaw + extraYaw, rotationCenter);
        }
        if (isCurve) {
          const bounds = computeBounds(ring);
          if (bounds) {
            const cx = (bounds.minX + bounds.maxX) / 2;
            const cz = (bounds.minZ + bounds.maxZ) / 2;
            const dx = x - cx;
            const dz = z - cz;
            ring = ring.map(([px, pz]) => [px + dx, pz + dz]);
          }
        }
        feature = toFeature(categoryName, name, [ring], elev, isCurve);
      } else {
        let radius = 5;
        if (bbox?.size) {
          const [sizeX, , sizeZ] = bbox.size;
          const scale = cfg.sizeScale || 1.0;
          radius = (Math.min(sizeX, sizeZ) / 2) * scale;
        }
        const ring = createCircleRing(x, z, radius, circlePoints);
        feature = toFeature(categoryName, name, [ring], elev);
      }
    } else if (usedCustom) {
      let ring = customCorners;
      const rotationCenter = ring._rotationCenter || [x, z];
      const extraYaw = ring._extraYawDeg || 0;
      if (!ring._noSnap) ring = snapRing(ring, 0.5);
      if ((yaw || extraYaw) && !ring._alreadyRotated) {
        ring = rotateRing(ring, yaw + extraYaw, rotationCenter);
      }
      if (isCurve) {
        const bounds = computeBounds(ring);
        if (bounds) {
          const cx = (bounds.minX + bounds.maxX) / 2;
          const cz = (bounds.minZ + bounds.maxZ) / 2;
          const dx = x - cx;
          const dz = z - cz;
          ring = ring.map(([px, pz]) => [px + dx, pz + dz]);
        }
      }
      feature = toFeature(categoryName, name, [ring], elev, isCurve);
    } else if (!bbox?.size) {
      const ring = createCircleRing(x, z, 5, circlePoints);
      feature = toFeature(categoryName, name, [ring], elev);
    } else {
      const [sizeX, , sizeZ] = bbox.size;
      const scale = cfg.sizeScale || 1.0;
      const scaleX = cfg.sizeScaleX || 1.0;
      const scaleZ = cfg.sizeScaleZ || 1.0;

      let scaledSizeX = sizeX * scale * scaleX;
      let scaledSizeZ = sizeZ * scale * scaleZ;

      if (categoryName === 'walls' || categoryName === 'barriers') {
        const minWidth = 2.0;
        if (scaledSizeX < minWidth) scaledSizeX = minWidth;
        if (scaledSizeZ < minWidth) scaledSizeZ = minWidth;
      }

      const halfX = scaledSizeX / 2;
      const halfZ = scaledSizeZ / 2;

      let ring = [
        [x - halfX, z - halfZ],
        [x + halfX, z - halfZ],
        [x + halfX, z + halfZ],
        [x - halfX, z + halfZ],
      ];

      ring = snapRing(ring, 0.5);
      ring = rotateRing(ring, yaw, [x, z]);
      feature = toFeature(categoryName, name, [ring], elev);
    }

    if (feature) {
      if (shouldSnap && shouldSnapFeature(categoryName, name)) {
        snapBuffer.push(feature);
      } else {
        if (wroteAny) stream.write(',');
        stream.write(JSON.stringify(feature));
        wroteAny = true;
      }
      featureCount += 1;
    }
  }

  let snapStats = null;
  if (shouldSnap) {
    const { tolerance, extendedTolerance } = snapToleranceFor(categoryName);
    const { features: snapped, snappedVertexCount, touchedFeatureCount } = snapConnectorVertices(
      snapBuffer,
      tolerance,
      extendedTolerance
    );
    snapStats = { snappedVertexCount, touchedFeatureCount, tolerance, extendedTolerance };
    for (const feature of snapped) {
      if (wroteAny) stream.write(',');
      stream.write(JSON.stringify(feature));
      wroteAny = true;
    }
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    category: categoryName,
    totalFeatures: featureCount,
    ...(snapStats ? { connectorSnap: snapStats } : {}),
  };
  stream.write(`],"meta":${JSON.stringify(meta)}}`);
  stream.end();
  if (snapStats) {
    console.log(
      `[Prebuild] ${categoryName}: snapped ${snapStats.snappedVertexCount} vertices across ${snapStats.touchedFeatureCount} features (tolerance ${snapStats.tolerance})`
    );
  }

  console.log(`[Prebuild] Wrote ${featureCount} features -> ${outPath}`);
}

(async function main() {
  for (const { name: categoryName, cfg } of categories) {
    await processCategory(categoryName, cfg);
  }
})();
