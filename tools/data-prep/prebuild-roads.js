/**
 * Prebuild map-wide road polygons (unioned + overlap masks) for all road categories.
 *
 * Outputs GeoJSON with:
 *  - type: "road" features: unioned/smoothed polygons per road prefix/category
 *  - type: "overlap" features: intersection polygons between different road categories,
 *    with fill colors for gradient rendering and strokeOpacity 0.
 *
 * Process (mimics map-core.js):
 *  1. Draw all polygons with custom curve segment handling
 *  2. Apply buffer expansion to bring near-touching segments together
 *  3. Boolean union all polygons per prefix/category using tiled approach
 *  4. Cleanup short segments with category-specific thresholds (asf=3.0, city=4.0, others=2.0)
 *  5. Smooth the rings with 2 iterations
 *  6. Output as cleaned GeoJSON
 *
 * Key fixes from original:
 *  - Apply short segment threshold based on category file (matches map-core logic)
 *  - Proper cleanup and smoothing after union operations
 *  - Better error logging for union failures
 *  - Tiled union approach to handle large polygon sets without memory issues
 *
 * Run: node tools/prebuild-roads.js
 * Requires: @turf/turf (npm install @turf/turf)
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const turf = require("@turf/turf");
const RoadGeom = require("./lib/road-geom");

// --- Load mapStyles from public/js/map-styles.js (without touching the DOM) ---
const mapStylesPath = path.join(
  __dirname,
  "..",
  "..",
  "public",
  "js",
  "map-styles.js"
);
const mapStylesCode = fs.readFileSync(mapStylesPath, "utf-8");
const mapStylesSandbox = { console };
vm.createContext(mapStylesSandbox);
vm.runInContext(
  mapStylesCode + "\n;this.__mapStylesExport = mapStyles;",
  mapStylesSandbox
);
const mapStyles = mapStylesSandbox.__mapStylesExport;

// Road categories to prebuild
const ROAD_CATEGORIES = [
  "asf_roads",
  "city_roads",
  "mud_roads",
  "grav_roads",
];

// Load bbox cache
const bboxCacheRect = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "out", "bboxCache.rectangles.json"),
    "utf-8"
  )
);

// --- Helpers copied from map-core (Node-safe) ---
function getLineWidthFromReference(referenceObjectName, bboxCache) {
  if (bboxCache && bboxCache[referenceObjectName]) {
    const bbox = bboxCache[referenceObjectName];
    if (bbox.size) {
      const [sizeX, , sizeZ] = bbox.size;
      return Math.min(sizeX, sizeZ);
    }
  }
  return 0;
}

function parseCurveSpec(objectName) {
  if (!objectName) return { angle: 0 };
  const match = objectName.match(/_(\d+)\s+(\d+)/);
  return match ? { angle: parseFloat(match[1]) } : { angle: 0 };
}

function createRoadRectangle(x, z, sizeX, sizeZ) {
  const halfX = sizeX / 2;
  const halfZ = sizeZ / 2;
  return [
    [x - halfX, z - halfZ],
    [x + halfX, z - halfZ],
    [x + halfX, z + halfZ],
    [x - halfX, z + halfZ],
  ];
}

function createNormalizedRoadRectangle(
  x,
  z,
  yaw,
  bbox,
  catConfig,
  bboxCache,
  referenceObjectName,
  drawerPrefix = null,
  curveAngleDeg = 0
) {
  if (!bbox || !bbox.size) return null;

  const [sizeX, , sizeZ] = bbox.size;
  const scale = catConfig.sizeScale || 1.0;
  const widthOnX = sizeX <= sizeZ;
  const currentWidth = widthOnX ? sizeX : sizeZ;
  const currentLength = widthOnX ? sizeZ : sizeX;

  const refWidth = referenceObjectName
    ? getLineWidthFromReference(referenceObjectName, bboxCache)
    : 0;
  const targetWidth = refWidth > 0 ? refWidth : currentWidth;

  const applyCurveDrawer = curveAngleDeg !== 0;

  const widthMultiplier = 1.0;
  const posXOffset = 0;
  const posZOffset = 0;
  const scaleXDebug = 1.0;
  const scaleZDebug = 1.0;
  const angleOffset = 0;
  const effectiveCurveAngle = curveAngleDeg + angleOffset;

  const scaledWidth = targetWidth * scale * widthMultiplier * scaleXDebug;
  const scaledLength = currentLength * scale * scaleZDebug;

  const adjustedSizeX = widthOnX ? scaledWidth : scaledLength;
  const adjustedSizeZ = widthOnX ? scaledLength : scaledWidth;

  const centerX = x + posXOffset;
  const centerZ = z + posZOffset;

  if (
    applyCurveDrawer &&
    typeof effectiveCurveAngle === "number" &&
    effectiveCurveAngle !== 0
  ) {
    let curvePoly = RoadGeom.createCurvePolygon(
      centerX,
      centerZ,
      effectiveCurveAngle,
      scaledWidth,
      scaledLength
    );
    const bounds = RoadGeom.computeBoundsFromCorners(curvePoly);
    if (bounds) {
      const curveCenterX = (bounds.minX + bounds.maxX) / 2;
      const curveCenterZ = (bounds.minZ + bounds.maxZ) / 2;
      const deltaX = centerX - curveCenterX;
      const deltaZ = centerZ - curveCenterZ;
      curvePoly = curvePoly.map(([cx, cz]) => [cx + deltaX, cz + deltaZ]);
      curvePoly._centerShift = [deltaX, deltaZ];
    }
    curvePoly._rotationCenter = [centerX, centerZ];
    curvePoly._extraYawDeg = 180 + effectiveCurveAngle / 2;
    curvePoly._noSnap = true;
    curvePoly._isCurve = true;
    curvePoly._curveAngle = effectiveCurveAngle;
    curvePoly._curveCenter = [centerX, centerZ];
    curvePoly._curveWidth = scaledWidth;
    curvePoly._curveLength = scaledLength;
    return curvePoly;
  }

  const rect = createRoadRectangle(
    centerX,
    centerZ,
    adjustedSizeX,
    adjustedSizeZ
  );
  rect._rotationCenter = [centerX, centerZ];
  return rect;
}

function createDiagonalAlignedRectangle(
  startX,
  startZ,
  endX,
  endZ,
  lineWidth,
  flipCorners = false
) {
  // Snap start and end points to grid for alignment with adjacent polygons
  const gridSize = 0.5;
  const snappedStartX = Math.round(startX / gridSize) * gridSize;
  const snappedStartZ = Math.round(startZ / gridSize) * gridSize;
  const snappedEndX = Math.round(endX / gridSize) * gridSize;
  const snappedEndZ = Math.round(endZ / gridSize) * gridSize;

  // Direction vector and distance
  const dx = snappedEndX - snappedStartX;
  const dz = snappedEndZ - snappedStartZ;
  const distance = Math.sqrt(dx * dx + dz * dz);

  // If distance is zero, return a minimal rectangle
  if (distance === 0) {
    const halfWidth = lineWidth / 2;
    return [
      [snappedStartX - halfWidth, snappedStartZ - halfWidth],
      [snappedStartX + halfWidth, snappedStartZ - halfWidth],
      [snappedStartX + halfWidth, snappedStartZ + halfWidth],
      [snappedStartX - halfWidth, snappedStartZ + halfWidth],
    ];
  }

  // Unit direction vector
  const ux = dx / distance;
  const uz = dz / distance;

  // Unit perpendicular vector (rotated 90 degrees)
  const px = -uz;
  const pz = ux;

  // Rectangle corners: start and end are opposite diagonal corners
  if (flipCorners) {
    return [
      [snappedStartX, snappedStartZ],
      [snappedStartX - px * lineWidth, snappedStartZ - pz * lineWidth],
      [snappedEndX, snappedEndZ],
      [snappedEndX + px * lineWidth, snappedEndZ + pz * lineWidth],
    ];
  } else {
    return [
      [snappedStartX, snappedStartZ],
      [snappedStartX + px * lineWidth, snappedStartZ + pz * lineWidth],
      [snappedEndX, snappedEndZ],
      [snappedEndX - px * lineWidth, snappedEndZ - pz * lineWidth],
    ];
  }
}

function makeRoadDrawer(
  referenceObjectName,
  drawerPrefix = null,
  objectNameForAngle = null
) {
  const { angle: curveAngle } = objectNameForAngle
    ? parseCurveSpec(objectNameForAngle)
    : { angle: 0 };
  return function (x, z, yaw, bbox, catConfig, bboxCache) {
    return createNormalizedRoadRectangle(
      x,
      z,
      yaw,
      bbox,
      catConfig,
      bboxCache,
      referenceObjectName,
      drawerPrefix,
      curveAngle
    );
  };
}

// Road-only custom drawers (as in map-core)
const customObjectDrawers = {
  // ===== ROAD DRAWERS =====
  // All roads use axis-aligned rectangles with grid snapping

  // asf1 road variants (Asphalt Road type 1)
  "asf1_1 1000": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_1 1000"),
  "asf1_7 100": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_7 100"),
  "asf1_10 100": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_10 100"),
  "asf1_10 25": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_10 25"),
  "asf1_10 50": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_10 50"),
  "asf1_10 75": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_10 75"),
  "asf1_15 75": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_15 75"),
  "asf1_22 50": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_22 50"),
  "asf1_30 25": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_30 25"),
  "asf1_60 10": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_60 10"),
  // asf2 road variants (Asphalt Road type 2)
  "asf2_1 1000": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_1 1000"),
  "asf2_7 100": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_7 100"),
  "asf2_10 100": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_10 100"),
  "asf2_10 25": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_10 25"),
  "asf2_10 50": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_10 50"),
  "asf2_10 75": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_10 75"),
  "asf2_15 75": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_15 75"),
  "asf2_22 50": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_22 50"),
  "asf2_30 25": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_30 25"),
  "asf2_60 10": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_60 10"),
  // asf3 road variants (Asphalt Road type 3)
  "asf3_1 1000": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_1 1000"),
  "asf3_7 100": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_7 100"),
  "asf3_10 100": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_10 100"),
  "asf3_10 25": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_10 25"),
  "asf3_10 50": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_10 50"),
  "asf3_10 75": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_10 75"),
  "asf3_15 75": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_15 75"),
  "asf3_22 50": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_22 50"),
  "asf3_30 25": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_30 25"),
  "asf3_60 10": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_60 10"),

  // city road variants (City Road)
  "city_1 1000": makeRoadDrawer("city_0 2000", "city", "city_1 1000"),
  "city_7 100": makeRoadDrawer("city_0 2000", "city", "city_7 100"),
  "city_10 100": makeRoadDrawer("city_0 2000", "city", "city_10 100"),
  "city_10 25": makeRoadDrawer("city_0 2000", "city", "city_10 25"),
  "city_10 50": makeRoadDrawer("city_0 2000", "city", "city_10 50"),
  "city_10 75": makeRoadDrawer("city_0 2000", "city", "city_10 75"),
  "city_15 75": makeRoadDrawer("city_0 2000", "city", "city_15 75"),
  "city_22 50": makeRoadDrawer("city_0 2000", "city", "city_22 50"),
  "city_30 25": makeRoadDrawer("city_0 2000", "city", "city_30 25"),
  "city_60 10": makeRoadDrawer("city_0 2000", "city", "city_60 10"),
  // grav road variants (Gravel Road)
  "grav_1 1000": makeRoadDrawer("grav_0 2000", "grav", "grav_1 1000"),
  "grav_7 100": makeRoadDrawer("grav_0 2000", "grav", "grav_7 100"),
  "grav_10 100": makeRoadDrawer("grav_0 2000", "grav", "grav_10 100"),
  "grav_10 25": makeRoadDrawer("grav_0 2000", "grav", "grav_10 25"),
  "grav_10 50": makeRoadDrawer("grav_0 2000", "grav", "grav_10 50"),
  "grav_10 75": makeRoadDrawer("grav_0 2000", "grav", "grav_10 75"),
  "grav_15 75": makeRoadDrawer("grav_0 2000", "grav", "grav_15 75"),
  "grav_22 50": makeRoadDrawer("grav_0 2000", "grav", "grav_22 50"),
  "grav_30 25": makeRoadDrawer("grav_0 2000", "grav", "grav_30 25"),
  "grav_60 10": makeRoadDrawer("grav_0 2000", "grav", "grav_60 10"),
  // mud road variants (Mud Road)
  "mud_1 1000": makeRoadDrawer("mud_0 2000", "mud", "mud_1 1000"),
  "mud_7 100": makeRoadDrawer("mud_0 2000", "mud", "mud_7 100"),
  "mud_10 100": makeRoadDrawer("mud_0 2000", "mud", "mud_10 100"),
  "mud_10 25": makeRoadDrawer("mud_0 2000", "mud", "mud_10 25"),
  "mud_10 50": makeRoadDrawer("mud_0 2000", "mud", "mud_10 50"),
  "mud_10 75": makeRoadDrawer("mud_0 2000", "mud", "mud_10 75"),
  "mud_15 75": makeRoadDrawer("mud_0 2000", "mud", "mud_15 75"),
  "mud_22 50": makeRoadDrawer("mud_0 2000", "mud", "mud_22 50"),
  "mud_30 25": makeRoadDrawer("mud_0 2000", "mud", "mud_30 25"),
  "mud_60 10": makeRoadDrawer("mud_0 2000", "mud", "mud_60 10"),
  // ===== POWER LINE DRAWERS =====
  // All power lines use diagonal-aligned rectangles (bent features)
  power_hv_line_turn: function (x, z, yaw, bbox, catConfig, bboxCache) {
    if (!bbox || !bbox.size) return null;

    const [sizeX, sizeY, sizeZ] = bbox.size;
    const halfX = sizeX / 2;
    const halfZ = sizeZ / 2;

    // Get straight line width for the rectangle
    let lineWidth = Math.min(sizeX, sizeZ);
    const refWidth = getLineWidthFromReference("power_hv_line", bboxCache);
    if (refWidth > 0) lineWidth = refWidth;

    return createDiagonalAlignedRectangle(
      x - halfX,
      z - halfZ,
      x + halfX,
      z + halfZ,
      lineWidth,
      false
    );
  },

  // Power line turn right - rectangle rotated to align with diagonal
  power_hv_line_turnr: function (x, z, yaw, bbox, catConfig, bboxCache) {
    if (!bbox || !bbox.size) return null;

    const [sizeX, sizeY, sizeZ] = bbox.size;
    const halfX = sizeX / 2;
    const halfZ = sizeZ / 2;

    // Get straight line width for the rectangle
    let lineWidth = Math.min(sizeX, sizeZ);
    const refWidth = getLineWidthFromReference("power_hv_line", bboxCache);
    if (refWidth > 0) lineWidth = refWidth;

    return createDiagonalAlignedRectangle(
      x - halfX,
      z - halfZ,
      x + halfX,
      z + halfZ,
      lineWidth,
      false
    );
  },

  // Power line turn left - rectangle rotated to align with diagonal
  power_hv_line_turnl: function (x, z, yaw, bbox, catConfig, bboxCache) {
    if (!bbox || !bbox.size) return null;

    const [sizeX, sizeY, sizeZ] = bbox.size;
    const halfX = sizeX / 2;
    const halfZ = sizeZ / 2;

    // Get straight line width for the rectangle
    let lineWidth = Math.min(sizeX, sizeZ);
    const refWidth = getLineWidthFromReference("power_hv_line", bboxCache);
    if (refWidth > 0) lineWidth = refWidth;

    return createDiagonalAlignedRectangle(
      x + halfX,
      z - halfZ,
      x - halfX,
      z + halfZ,
      lineWidth,
      true
    );
  },

  // ===== ROAD CURVE DRAWERS =====
  // Curves use diagonal-aligned rectangles similar to power lines
  path_dirt_curve: function (x, z, yaw, bbox, catConfig, bboxCache) {
    if (!bbox || !bbox.size) return null;

    const [sizeX, sizeY, sizeZ] = bbox.size;
    const halfX = sizeX / 2;
    const halfZ = sizeZ / 2;

    // Get curve width from config or derive from size
    let curveWidth = Math.min(sizeX, sizeZ);
    const scale = catConfig.sizeScale || 1.0;
    curveWidth = curveWidth * scale;

    // Use diagonal alignment for curves (top-left to bottom-right)
    return createDiagonalAlignedRectangle(
      x - halfX,
      z - halfZ,
      x + halfX,
      z + halfZ,
      curveWidth,
      false
    );
  },

  path_rock_curve: function (x, z, yaw, bbox, catConfig, bboxCache) {
    if (!bbox || !bbox.size) return null;

    const [sizeX, sizeY, sizeZ] = bbox.size;
    const halfX = sizeX / 2;
    const halfZ = sizeZ / 2;

    // Get curve width from config or derive from size
    let curveWidth = Math.min(sizeX, sizeZ);
    const scale = catConfig.sizeScale || 1.0;
    curveWidth = curveWidth * scale;

    // Use diagonal alignment for curves (top-left to bottom-right)
    return createDiagonalAlignedRectangle(
      x - halfX,
      z - halfZ,
      x + halfX,
      z + halfZ,
      curveWidth,
      false
    );
  },
};

// --- CSV parsing (semicolon-delimited) ---
function readCsvRows(filePath) {
  const text = fs.readFileSync(filePath, "utf-8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    if (parts.length < 7) continue;
    const [rawName, x, z, , , , yaw] = parts;
    const name = rawName.replace(/^"+|"+$/g, "").trim();
    rows.push({
      name: name.trim(),
      x: parseFloat(x),
      z: parseFloat(z),
      yaw: parseFloat(yaw),
    });
  }
  return rows;
}

function rotateIfNeeded(corners, yawDeg, rotationCenter, extraYawDeg = 0) {
  const rotationRad = -((yawDeg + extraYawDeg) * Math.PI) / 180;
  if ((yawDeg !== 0 || extraYawDeg !== 0) && !corners._alreadyRotated) {
    return corners.map(([cx, cz]) => {
      const dx = cx - rotationCenter[0];
      const dz = cz - rotationCenter[1];
      const rotX = dx * Math.cos(rotationRad) - dz * Math.sin(rotationRad);
      const rotZ = dx * Math.sin(rotationRad) + dz * Math.cos(rotationRad);
      return [rotationCenter[0] + rotX, rotationCenter[1] + rotZ];
    });
  }
  return corners;
}

function isValidRing(ring) {
  return Array.isArray(ring) && ring.length >= 3;
}

function buildPolygonForRow(row, catConfig) {
  const { name, x, z, yaw } = row;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const bbox = bboxCacheRect[name];
  if (!bbox) return null;

  let corners = null;
  const custom = customObjectDrawers[name];
  if (custom) {
    corners = custom(x, z, yaw, bbox, catConfig, bboxCacheRect);
    if (!row._stats) row._stats = {};
    row._stats.usedCustom = true;
  }
  if (!corners) {
    const scale = catConfig.sizeScale || 1.0;
    const [sizeX, , sizeZ] = bbox.size;
    const halfX = (sizeX * scale) / 2;
    const halfZ = (sizeZ * scale) / 2;
    corners = [
      [x - halfX, z - halfZ],
      [x + halfX, z - halfZ],
      [x + halfX, z + halfZ],
      [x - halfX, z + halfZ],
    ];
  }

  // Snap unless disabled
  if (!corners._noSnap) {
    corners = corners.map(([cx, cz]) => RoadGeom.snapToGrid(cx, cz, 0.5));
  }

  const rotationCenter = corners._rotationCenter || [x, z];
  const extraYaw = corners._extraYawDeg || 0;
  let rotatedCorners = rotateIfNeeded(corners, yaw, rotationCenter, extraYaw);

  if (corners._isCurve) {
    const bounds = RoadGeom.computeBoundsFromCorners(rotatedCorners);
    if (bounds) {
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cz = (bounds.minZ + bounds.maxZ) / 2;
      const dx = x - cx;
      const dz = z - cz;
      rotatedCorners = rotatedCorners.map(([px, pz]) => [px + dx, pz + dz]);
    }
    if (!row._stats) row._stats = {};
    row._stats.isCurve = true;
  }

  return {
    type: "road",
    objectName: name,
    category: catConfig.name || "",
    prefix: name.split("_")[0],
    rings: [rotatedCorners],
  };
}

// Union per prefix (Node version of applyUnionForRoadPrefixesV2)
function unionByPrefix(polys, catConfig, prefixes, bufferDist = 0.5) {
  const unions = [];

  prefixes.forEach((prefix) => {
    const matched = polys.filter(
      (p) =>
        p.objectName &&
        p.objectName.startsWith(prefix) &&
        isValidRing(p.rings?.[0])
    );
    if (matched.length < 2) return;
    console.log(`[Union] ${prefix}: ${matched.length} polys before union`);

    const turfPolys = matched
      .map((p) => {
        const ring = p.rings[0];
        if (!isValidRing(ring)) return null;
        const expanded =
          bufferDist > 0 ? RoadGeom.expandRing(ring, bufferDist) : ring;
        const closed = RoadGeom.closeRing(expanded);
        if (!closed || closed.length < 4) return null;
        const poly = turf.polygon([closed]);
        const area = turf.area(poly);
        if (!Number.isFinite(area) || area < 0.25) return null;
        return poly;
      })
      .filter(Boolean);
    if (turfPolys.length < 2) return;

    console.log(
      `[Union] ${prefix}: ${turfPolys.length} turf polys after buffer/close`
    );
    // Chunked pairwise union to handle large sets
    const hasGeom = (f) => f && f.geometry && f.geometry.type;
    const unionTwo = (a, b) => {
      if (!hasGeom(a)) return hasGeom(b) ? b : null;
      if (!hasGeom(b)) return hasGeom(a) ? a : null;
      try {
        return turf.union(a, b);
      } catch (e) {
        console.warn("[Union] pairwise failed", e?.message || e);
        return a;
      }
    };

    let queue = turfPolys.filter(hasGeom);
    if (queue.length === 0) {
      console.warn(`[Union] ${prefix}: no valid geometries after filtering`);
      return;
    }
    const batchSize = 50;
    let step = 0;
    while (queue.length > 1) {
      const nextQueue = [];
      for (let i = 0; i < queue.length; i += batchSize) {
        const batch = queue.slice(i, i + batchSize);
        if (batch.length === 0) continue;
        let merged = batch[0];
        for (let j = 1; j < batch.length; j++) {
          merged = unionTwo(merged, batch[j]);
        }
        if (hasGeom(merged)) nextQueue.push(merged);
      }
      queue = nextQueue;
      step++;
      console.log(`[Union] ${prefix}: batch reduce step ${step}, queue size ${queue.length}`);
      if (queue.length === 1) break;
      if (step > 20) {
        console.warn(`[Union] ${prefix}: stopping batch union after ${step} steps, queue size ${queue.length}`);
        break;
      }
    }

    // Determine short segment threshold based on category file (matches map-core logic)
    let shortSegmentThreshold = 2.0;
    if (catConfig.file === "asf_roads_local_coords.csv") {
      shortSegmentThreshold = 3.0;
    } else if (catConfig.file === "city_roads_local_coords.csv") {
      shortSegmentThreshold = 4.0;
    }

    const mergedFeatures = [];
    const finalMerged = queue[0];
    if (finalMerged && finalMerged.geometry) {
      mergedFeatures.push({ type: "Feature", geometry: finalMerged.geometry, properties: {} });
      console.log(`[Union] ${prefix}: final merged type ${finalMerged.geometry.type}`);
    } else {
      console.warn(`[Union] ${prefix}: no merged geometry produced`);
    }

    const addGeo = (rings) => {
      const cleaned = RoadGeom.cleanupShortSegments(rings, shortSegmentThreshold).map((r) =>
        RoadGeom.smoothRing(r, 2)
      );
      cleaned.forEach((ring) => {
        unions.push({
          type: "road",
          objectName: `${prefix}_union`,
          category: catConfig.name || "",
          prefix,
          rings: [ring],
        });
      });
    };

    mergedFeatures.forEach((feat) => {
      const geom = feat && feat.geometry;
      if (!geom) return;
      if (geom.type === "Polygon") {
        const rings = geom.coordinates;
        if (rings && rings.length > 0) {
          addGeo(rings.map((r) => r.map(([x, z]) => [x, z])));
        }
      } else if (geom.type === "MultiPolygon") {
        geom.coordinates.forEach((polyCoords) => {
          if (polyCoords && polyCoords[0]) {
            addGeo(polyCoords.map((r) => r.map(([x, z]) => [x, z])));
          }
        });
      } else if (geom.type === "GeometryCollection" && Array.isArray(geom.geometries)) {
        geom.geometries.forEach((g) => {
          if (g.type === "Polygon") {
            addGeo(g.coordinates.map((r) => r.map(([x, z]) => [x, z])));
          } else if (g.type === "MultiPolygon") {
            g.coordinates.forEach((polyCoords) => {
              addGeo(polyCoords.map((r) => r.map(([x, z]) => [x, z])));
            });
          }
        });
      }
    });
  });

  return unions;
}

// Tile-based union to avoid huge boolean ops
function unionByPrefixTiled(polys, catConfig, prefixes, bufferDist = 0.5, tileSize = 1000) {
  const unions = [];
  
  // Determine short segment threshold based on category file (matches map-core logic)
  let shortSegmentThreshold = 2.0;
  if (catConfig.file === "asf_roads_local_coords.csv") {
    shortSegmentThreshold = 3.0;
  } else if (catConfig.file === "city_roads_local_coords.csv") {
    shortSegmentThreshold = 4.0;
  }
  
  const hasGeom = (f) => f && f.geometry && f.geometry.type;
  const unionTwo = (a, b) => {
    if (!hasGeom(a)) return hasGeom(b) ? b : null;
    if (!hasGeom(b)) return hasGeom(a) ? a : null;
    try {
      return turf.union(a, b);
    } catch {
      return a;
    }
  };
  const ringCentroid = (ring) => {
    let sx = 0;
    let sz = 0;
    ring.forEach(([x, z]) => {
      sx += x;
      sz += z;
    });
    const n = ring.length || 1;
    return [sx / n, sz / n];
  };
  const addGeo = (rings, tag) => {
    const cleaned = RoadGeom.cleanupShortSegments(rings, shortSegmentThreshold).map((r) =>
      RoadGeom.smoothRing(r, 2)
    );
    cleaned.forEach((ring) => {
      unions.push({
        type: "road",
        objectName: tag,
        category: catConfig.name || "",
        prefix: tag.split("_")[0],
        rings: [ring],
      });
    });
  };

  prefixes.forEach((prefix) => {
    const matched = polys.filter(
      (p) =>
        p.objectName &&
        p.objectName.startsWith(prefix) &&
        isValidRing(p.rings?.[0])
    );
    if (matched.length < 2) return;
    console.log(`[UnionTile] ${prefix}: ${matched.length} polys before union`);

    const buckets = new Map();
    matched.forEach((p) => {
      const ring = p.rings[0];
      if (!isValidRing(ring)) return;
      const expanded = bufferDist > 0 ? RoadGeom.expandRing(ring, bufferDist) : ring;
      const closed = RoadGeom.closeRing(expanded);
      if (!closed || closed.length < 4) return;
      let poly;
      try {
        poly = turf.polygon([closed]);
      } catch {
        return;
      }
      const area = turf.area(poly);
      if (!Number.isFinite(area) || area < 0.25) return;
      const [cx, cz] = ringCentroid(closed);
      const tx = Math.floor(cx / tileSize);
      const tz = Math.floor(cz / tileSize);
      const key = `${tx},${tz}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(poly);
    });

    console.log(`[UnionTile] ${prefix}: ${buckets.size} tiles`);

    buckets.forEach((polyList, key) => {
      if (!polyList || polyList.length === 0) return;
      if (polyList.length === 1) {
        const g = polyList[0].geometry;
        if (g?.type === "Polygon") {
          addGeo(
            g.coordinates.map((r) => r.map(([x, z]) => [x, z])),
            `${prefix}_union_tile_${key}`
          );
        } else if (g?.type === "MultiPolygon") {
          g.coordinates.forEach((polyCoords) => {
            addGeo(
              polyCoords.map((r) => r.map(([x, z]) => [x, z])),
              `${prefix}_union_tile_${key}`
            );
          });
        }
        return;
      }

      let queue = polyList.filter(hasGeom);
      let steps = 0;
      while (queue.length > 1 && steps < 30) {
        const next = [];
        for (let i = 0; i < queue.length; i += 2) {
          const a = queue[i];
          const b = queue[i + 1];
          if (b) {
            const merged = unionTwo(a, b);
            if (hasGeom(merged)) next.push(merged);
          } else if (hasGeom(a)) {
            next.push(a);
          }
        }
        queue = next;
        steps++;
        if (steps % 5 === 0) {
          console.log(
            `[UnionTile] ${prefix} tile ${key}: reduce step ${steps}, queue size ${queue.length}`
          );
        }
      }
      if (steps > 0 && steps % 5 !== 0) {
        console.log(
          `[UnionTile] ${prefix} tile ${key}: completed after ${steps} steps, final queue size ${queue.length}`
        );
      }

      const finalMerged = queue[0];
      if (finalMerged && finalMerged.geometry) {
        const g = finalMerged.geometry;
        if (g.type === "Polygon") {
          addGeo(
            g.coordinates.map((r) => r.map(([x, z]) => [x, z])),
            `${prefix}_union_tile_${key}`
          );
        } else if (g.type === "MultiPolygon") {
          g.coordinates.forEach((polyCoords) => {
            addGeo(
              polyCoords.map((r) => r.map(([x, z]) => [x, z])),
              `${prefix}_union_tile_${key}`
            );
          });
        }
      } else {
        console.warn(
          `[UnionTile] ${prefix} tile ${key}: no valid merged geometry produced after ${steps} steps`
        );
      }
    });
  });

  return unions;
}

function buildCategoryOverlaps(allPolys) {
  const overlaps = [];
  const byCat = {};
  allPolys.forEach((p) => {
    byCat[p.category] = byCat[p.category] || [];
    byCat[p.category].push(p);
  });

  const cats = Object.keys(byCat);
  for (let i = 0; i < cats.length; i++) {
    for (let j = i + 1; j < cats.length; j++) {
      const catA = cats[i];
      const catB = cats[j];
      const polysA = byCat[catA];
      const polysB = byCat[catB];
      console.log(
        `[Overlap] ${catA} x ${catB}: ${polysA.length} x ${polysB.length}`
      );
      polysA.forEach((pa, idxA) => {
        polysB.forEach((pb, idxB) => {
          if (!isValidRing(pa.rings?.[0]) || !isValidRing(pb.rings?.[0]))
            return;
          try {
            const ringA = pa.rings[0];
            const ringB = pb.rings[0];
            const closedA = RoadGeom.closeRing(ringA);
            const closedB = RoadGeom.closeRing(ringB);
            if (
              !closedA ||
              closedA.length < 4 ||
              !closedB ||
              closedB.length < 4
            )
              return;
            const area = (r) => {
              let sum = 0;
              for (let i = 0; i < r.length; i++) {
                const [x1, y1] = r[i];
                const [x2, y2] = r[(i + 1) % r.length];
                sum += x1 * y2 - x2 * y1;
              }
              return Math.abs(sum) / 2;
            };
            if (area(closedA) < 0.01 || area(closedB) < 0.01) return;
            // Apply a small buffer to bring near-touching rings together (matches runtime expand)
            const bufA = RoadGeom.expandRing(closedA, 0.5);
            const bufB = RoadGeom.expandRing(closedB, 0.5);
            const geomA =
              bufA && bufA.length >= 4
                ? turf.polygon([RoadGeom.closeRing(bufA)])
                : null;
            const geomB =
              bufB && bufB.length >= 4
                ? turf.polygon([RoadGeom.closeRing(bufB)])
                : null;
            if (!geomA || !geomB) return;
            const inter = turf.intersect(geomA, geomB);
            if (inter && inter.geometry) {
              const fillA = mapStyles.categories[catA]?.fillColor || "#888";
              const fillB = mapStyles.categories[catB]?.fillColor || "#aaa";
              if (inter.geometry.type === "Polygon") {
                overlaps.push({
                  type: "overlap",
                  catA,
                  catB,
                  fillA,
                  fillB,
                  rings: inter.geometry.coordinates.map((r) =>
                    r.map(([x, z]) => [x, z])
                  ),
                });
              } else if (inter.geometry.type === "MultiPolygon") {
                inter.geometry.coordinates.forEach((polyCoords) => {
                  overlaps.push({
                    type: "overlap",
                    catA,
                    catB,
                    fillA,
                    fillB,
                    rings: polyCoords.map((r) => r.map(([x, z]) => [x, z])),
                  });
                });
              }
            }
          } catch (e) {
            if (idxA % 50 === 0 && idxB === 0) {
              console.warn("[Overlap] intersect error", e?.message || e);
            }
          }
        });
        if (idxA % 200 === 0) {
          console.log(
            `[Overlap] Progress ${catA} ${idxA + 1}/${polysA.length}`
          );
        }
      });
    }
  }
  return overlaps;
}

function polygonToFeature(poly) {
  const geom =
    poly.rings.length === 1
      ? {
          type: "Polygon",
          coordinates: poly.rings.map((r) => RoadGeom.closeRing(r)),
        }
      : {
          type: "MultiPolygon",
          coordinates: poly.rings.map((r) => [RoadGeom.closeRing(r)]),
        };
  return {
    type: "Feature",
    properties: {
      type: poly.type,
      objectName: poly.objectName,
      category: poly.category,
      prefix: poly.prefix,
      isUnion: poly.objectName?.includes("_union") ? 1 : 0,
      catA: poly.catA,
      catB: poly.catB,
      fillA: poly.fillA,
      fillB: poly.fillB,
      strokeOpacity: poly.type === "overlap" ? 0 : 1,
    },
    geometry: geom,
  };
}

// --- Main build ---
(function main() {
  const allPolys = [];
  const ENABLE_OVERLAPS = false; // disable cross-category overlaps for prebuild (avoids intersect errors)
  const AREA_FILTER = {
    enabled: false,
    centerX: 6476,
    centerZ: 2906,
    size: 500,
  }; // set enabled:true to limit scope
  console.log(
    `[Prebuild] Area filter enabled=${AREA_FILTER.enabled} size=${AREA_FILTER.size}`
  );
  const stats = {};

  ROAD_CATEGORIES.forEach((catName) => {
    const catConfig = { ...mapStyles.categories[catName], name: catName };
    if (!catConfig || !catConfig.file) return;
    const filePath = path.join(
      __dirname,
      "..",
      "..",
      "data",
      "TBData",
      "Chernarus",
      "categorized",
      catConfig.file
    );
    console.log(`[Prebuild] Reading ${catName} from ${filePath}`);
    const rows = readCsvRows(filePath);
    const rawPolys = [];
    rows.forEach((row) => {
      if (AREA_FILTER.enabled) {
        const half = AREA_FILTER.size / 2;
        if (!Number.isFinite(row.x) || !Number.isFinite(row.z)) return;
        if (
          row.x < AREA_FILTER.centerX - half ||
          row.x > AREA_FILTER.centerX + half ||
          row.z < AREA_FILTER.centerZ - half ||
          row.z > AREA_FILTER.centerZ + half
        ) {
          return;
        }
      }
      const poly = buildPolygonForRow(row, catConfig);
      if (poly) rawPolys.push(poly);
      if (row._stats) {
        const s = (stats[catName] = stats[catName] || { custom: 0, curve: 0 });
        if (row._stats.usedCustom) s.custom += 1;
        if (row._stats.isCurve) s.curve += 1;
      }
    });
    console.log(`[Prebuild] ${catName}: ${rawPolys.length} raw polys`);

    // Debug: show prefix counts
    const prefixes = ["asf1", "asf2", "asf3", "city", "grav", "mud"];
    const prefixCounts = {};
    prefixes.forEach((prefix) => {
      const count = rawPolys.filter((p) => p.objectName && p.objectName.startsWith(prefix)).length;
      if (count > 0) {
        prefixCounts[prefix] = count;
      }
    });
    if (Object.keys(prefixCounts).length > 0) {
      console.log(`[Prebuild] ${catName} prefix breakdown:`, prefixCounts);
    }

    // Union per prefix using tiled approach to avoid huge merges
    const unioned = unionByPrefixTiled(rawPolys, catConfig, prefixes, 0.5, 1000);
    console.log(`[Prebuild] ${catName}: ${unioned.length} union polys`);

    if (unioned.length > 0) {
      allPolys.push(...unioned);
      console.log(`[Prebuild] ${catName}: using unioned polys for output`);
    } else {
      allPolys.push(...rawPolys);
      console.log(`[Prebuild] ${catName}: no unions, using raw polys for output`);
    }
  });

  // Build overlaps between categories (for gradient stroke masking) on unioned polys only
  const overlaps = [];
  console.log(
    "[Prebuild] Overlaps disabled for prebuild (ENABLE_OVERLAPS=false)"
  );

  const features = [...allPolys, ...overlaps].map(polygonToFeature);
  const out = {
    type: "FeatureCollection",
    features,
    meta: {
      generatedAt: new Date().toISOString(),
      categories: ROAD_CATEGORIES,
    },
  };

  const outDir = path.join(__dirname, "..", "..", "out", "prebuilt");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "roads-prebuilt.geojson");
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`Wrote ${features.length} features to ${outPath}`);
  Object.entries(stats).forEach(([cat, s]) => {
    console.log(
      `[Prebuild] Stats ${cat}: custom drawers ${s.custom || 0}, curves ${
        s.curve || 0
      }`
    );
  });
})();
