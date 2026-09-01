// =============================================================================
// Road and Path Drawing
// Specialized functions for rendering roads, paths, curves, and power lines
// =============================================================================

// ===== Width Reference Functions =====
function getLineWidthFromReference(referenceObjectName, bboxCache) {
  if (bboxCache && bboxCache[referenceObjectName]) {
    const bbox = bboxCache[referenceObjectName];
    if (bbox.size) {
      const [sizeX, sizeY, sizeZ] = bbox.size;
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

// ===== Road Drawer Factory =====
// Factory to build road drawers that normalize width using a straight reference piece
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

// ===== Custom Object Drawers =====
// Modular system for objects that need special drawing rules
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
    let curveWidth = catConfig.uniformWidth
      ? catConfig.uniformWidth
      : Math.min(sizeX, sizeZ);
    const scale = catConfig.sizeScale || 1.0;
    curveWidth = curveWidth * scale;

    // Use diagonal alignment for curves (top-left to bottom-right)
    return createDiagonalAlignedRectangle(
      x - halfX,
      z - halfZ,
      x + halfX,
      z + halfZ,
      curveWidth,
      true
    );
  },

  path_rock_curve: function (x, z, yaw, bbox, catConfig, bboxCache) {
    if (!bbox || !bbox.size) return null;

    const [sizeX, sizeY, sizeZ] = bbox.size;
    const halfX = sizeX / 2;
    const halfZ = sizeZ / 2;

    // Get curve width from config or derive from size
    let curveWidth = catConfig.uniformWidth
      ? catConfig.uniformWidth
      : Math.min(sizeX, sizeZ);
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

// ===== Circle Creation =====
// Helper: Create circle from bounding box (for poles and towers)
function createCircleFromBBox(x, z, bbox) {
  if (!bbox || !bbox.size) return null;

  const [sizeX, sizeY, sizeZ] = bbox.size;
  const radius = Math.min(sizeX, sizeZ) / 2;

  // Generate 32 points for circle polygon
  const corners = [];
  const numPoints = 32;

  for (let i = 0; i < numPoints; i++) {
    const angle = (i / numPoints) * Math.PI * 2;
    const px = x + radius * Math.cos(angle);
    const pz = z + radius * Math.sin(angle);
    corners.push([px, pz]);
  }

  return corners;
}

// ===== Custom Object Dispatcher =====
// Helper: Get custom corners for an object, or return null for default handling
function getCustomObjectCorners(
  objectName,
  x,
  z,
  yaw,
  bbox,
  catConfig,
  bboxCache
) {
  // Check if this is a road/path and debug overrides are set
  const isRoad = catConfig && catConfig.name === "roads";

  // If roads debug panel says to disable custom drawer for roads, skip it
  if (
    isRoad &&
    typeof roadDebug !== "undefined" &&
    !roadDebug.useCustomDrawer
  ) {
    console.log(`[Road Debug] Skipping custom drawer for: ${objectName}`);
    return null;
  }

  // Check for exact match in custom drawers
  if (customObjectDrawers[objectName]) {
    // Log road geometry details for debugging
    if (isRoad) {
      const isCurve = /[1-9]|[1-6][0-9]/.test(objectName.split("_")[1]);
      console.log(`[ROAD DRAWER] ${objectName}`, {
        position: { x, z },
        bbox: bbox?.size,
        hasCustomDrawer: true,
        isCurve,
      });
    }

    // For roads, apply width multiplier from debug panel
    if (
      isRoad &&
      typeof roadDebug !== "undefined" &&
      roadDebug.widthMultiplier !== 1.0
    ) {
      console.log(
        `[Road Debug] Custom drawer for ${objectName} with multiplier ${roadDebug.widthMultiplier}`
      );
    }

    const result = customObjectDrawers[objectName](
      x,
      z,
      yaw,
      bbox,
      catConfig,
      bboxCache
    );

    // Log result for roads
    if (isRoad && result) {
      console.log(`[ROAD RESULT] ${objectName}`, {
        corners: result,
        cornerCount: result.length,
      });
    }

    return result;
  }

  // Check if object name includes "pole" or "tower" - draw as circle
  if (objectName.includes("pole") || objectName.includes("tower")) {
    console.log(`Drawing as circle for: ${objectName}`);
    return createCircleFromBBox(x, z, bbox);
  }

  return null;
}

// ===== Intersection Helper =====
// Helper: Determine which road prefix an intersection object (kr_X, kr_t) belongs to
function getIntersectionRoadPrefix(objectName) {
  // kr_X objects have format: kr_X_asf1_asf2 or kr_t_city_asf3 etc
  // We connect to the first road type mentioned
  if (!objectName || !objectName.includes("kr_")) return null;

  const parts = objectName.split("_");
  // kr_X_asf1_asf2 => parts = [kr, X, asf1, asf2]
  if (parts.length >= 3) {
    // Try to find first valid road prefix (asf1, asf2, asf3, city, grav, mud)
    for (let i = 2; i < parts.length; i++) {
      const roadTypes = ["asf1", "asf2", "asf3", "city", "grav", "mud"];
      if (roadTypes.includes(parts[i])) {
        return parts[i];
      }
    }
  }
  return null;
}
