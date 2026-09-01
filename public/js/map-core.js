// DayZ Map Core Functions
// ============================================================================
// NOTE: This file has been refactored for better code organization.
// Many functions have been moved to separate, specialized modules:
//
// - map-geometry.js: Geometry creation (shapes, curves, rings, bounds, etc.)
// - map-roads.js: Road/path drawing (custom drawers, width references, etc.)
// - map-polygon.js: Polygon processing (creation, refinement, conversion)
// - map-unions.js: Union/merge operations (boolean unions, masking, smart merging)
// - map-render.js: Rendering (stroke scaling, zoom effects, layer ordering)
// - map-utils.js: General utilities (contours, GeoJSON, topographic, collection)
// - map-export.js: Export functions (GeoJSON, SVG output)
//
// The functions remain here for backward compatibility but may be overridden by
// the corresponding module versions loaded before this file. New code should use
// the appropriately organized modules.
// ============================================================================

// ===== Zoom-Aware Stroke Scaling =====
// Calculate stroke weight based on current zoom level to maintain visual consistency
// At low zoom levels, scales down the stroke width to prevent overly thick lines
let currentZoomLevel = 7; // Default zoom level
function calculateScaledStrokeWeight(baseWeight) {
  // Scale formula: at zoom 1-3 (zoomed out), reduce weight significantly
  // At zoom 7+ (normal), use base weight
  // Linear interpolation: weight = baseWeight * (zoomLevel / 7)^0.6 (smoother scaling)
  const zoomFactor = Math.pow(currentZoomLevel / 7, 0.6);
  return Math.max(0.1, baseWeight * zoomFactor);
}

// ===== Helper: Create diagonal-aligned rectangle =====
// Creates a rectangle where a diagonal line bisects it from corner to corner
// Parameters:
//   - startX, startZ: first diagonal corner
//   - endX, endZ: opposite diagonal corner
//   - lineWidth: perpendicular width of the rectangle
//   - flipCorners: if true, flips the perpendicular offset direction (default: false)
// ===== Helper: Snap coordinates to a grid for alignment =====
// Ensures adjacent polygons naturally share vertices by snapping to grid
function snapToGrid(x, z, gridSize = 0.5) {
  return [
    Math.round(x / gridSize) * gridSize,
    Math.round(z / gridSize) * gridSize,
  ];
}

function createRoadRectangle(x, z, sizeX, sizeZ, yaw, scale = 1.0) {
  // For roads, create a simple rectangle aligned with the bounding box
  // not a diagonal-aligned parallelogram

  // Apply size scaling
  const scaledSizeX = sizeX * scale;
  const scaledSizeZ = sizeZ * scale;

  const halfX = scaledSizeX / 2;
  const halfZ = scaledSizeZ / 2;

  // Don't snap to grid here - let the caller handle grid snapping
  // This ensures consistency with default rectangle rendering

  // Create 4 corners of axis-aligned rectangle
  return [
    [x - halfX, z - halfZ],
    [x + halfX, z - halfZ],
    [x + halfX, z + halfZ],
    [x - halfX, z + halfZ],
  ];
}

// Normalize road width to a reference straight segment so curves match straight pieces
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
  // Which axis is "width" vs "length" should be a property of the road
  // family (all pieces share one local-axis convention), not each piece's
  // own bbox - short stub/endcap pieces (e.g. "asf1_6", 12x6.24) can be wider
  // than they are long, which flips this heuristic if computed from their
  // own bbox and rotates the piece 90 degrees off from every other segment
  // in the same family. Prefer the reference straight piece's orientation
  // when available; it's always safely elongated (e.g. "asf1_0 2000",
  // 12.08x17.5) since it's the piece everything else normalizes width against.
  const refBBox = referenceObjectName && bboxCache ? bboxCache[referenceObjectName] : null;
  const widthOnX = refBBox && refBBox.size ? refBBox.size[0] <= refBBox.size[2] : sizeX <= sizeZ;
  const currentWidth = widthOnX ? sizeX : sizeZ;
  const currentLength = widthOnX ? sizeZ : sizeX;

  const refWidth = referenceObjectName
    ? getLineWidthFromReference(referenceObjectName, bboxCache)
    : 0;

  // Check for enforced width first, then reference width, then current width
  let targetWidth;
  if (catConfig.uniformWidth) {
    targetWidth = catConfig.uniformWidth;
  } else {
    targetWidth = refWidth > 0 ? refWidth : currentWidth;
  }

  const applyCurveDrawer = curveAngleDeg !== 0;

  const widthMultiplier = 1.0;
  const posXOffset = 0;
  const posZOffset = 0;
  const scaleXDebug = 1.0;
  const scaleZDebug = 1.0;
  const angleOffset = 0;
  const effectiveCurveAngle = curveAngleDeg;

  const scaledWidth = targetWidth * scale * widthMultiplier * scaleXDebug;
  // Use the bbox-provided length for curves; ignore the suffix number which is unreliable
  const scaledLength = currentLength * scale * scaleZDebug;

  const adjustedSizeX = widthOnX ? scaledWidth : scaledLength;
  const adjustedSizeZ = widthOnX ? scaledLength : scaledWidth;

  const centerX = x + posXOffset;
  const centerZ = z + posZOffset;

  // For curves, build a polygonal arc using bbox length and parsed angle.
  if (
    applyCurveDrawer &&
    typeof effectiveCurveAngle === "number" &&
    effectiveCurveAngle !== 0
  ) {
    // A single bbox axis is a good proxy for chord length only while the
    // piece stays clearly elongated. As the turn gets tighter the bbox
    // approaches square (e.g. "asf1_60 10" measures 14.00 x 13.86) and a
    // single axis badly overestimates the true chord - same root cause as
    // the water l90/r90 fix, just less extreme and far more widespread
    // across the road curve families (found on ~17 pieces spanning every
    // prefix, not just one). Blend toward the bbox diagonal as the aspect
    // ratio approaches 1:1; stays exactly the old axis-only behavior for
    // clearly elongated pieces (ratio comfortably above the blend range).
    const aspectRatio = Math.max(sizeX, sizeZ) / Math.max(0.01, Math.min(sizeX, sizeZ));
    const blendStart = 1.15; // ratio at/above which we trust the axis length fully
    const blendEnd = 1.0; // ratio at which we trust the diagonal fully (square)
    const blendT = Math.max(0, Math.min(1, (blendStart - aspectRatio) / (blendStart - blendEnd)));
    const diagonalLength = Math.sqrt(sizeX * sizeX + sizeZ * sizeZ) * scale * scaleZDebug;
    const curveChordLength = scaledLength + (diagonalLength - scaledLength) * blendT;

    let curvePoly = createCurvePolygon(
      centerX,
      centerZ,
      effectiveCurveAngle,
      scaledWidth,
      curveChordLength
    );
    // Align curve polygon center to bbox center to counter radius-dependent drift
    const bounds = computeBoundsFromCorners(curvePoly);
    if (bounds) {
      const curveCenterX = (bounds.minX + bounds.maxX) / 2;
      const curveCenterZ = (bounds.minZ + bounds.maxZ) / 2;
      const targetCenterX = centerX;
      const targetCenterZ = centerZ;
      const deltaX = targetCenterX - curveCenterX;
      const deltaZ = targetCenterZ - curveCenterZ;
      curvePoly = curvePoly.map(([cx, cz]) => [cx + deltaX, cz + deltaZ]);
      curvePoly._centerShift = [deltaX, deltaZ];
    }
    // Rotate around the generated center; apply a 180° flip plus half-angle for orientation
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
    adjustedSizeZ,
    yaw,
    1.0
  );

  rect._rotationCenter = [centerX, centerZ];
  return rect;
}

// Approximate a curved road as a trapezoid that blends entry/exit tangents
function createCurvePolygon(centerX, centerZ, curveAngleDeg, width, length) {
  const halfChord = length / 2;
  const halfWidth = width / 2;
  // curveAngleDeg's sign selects which side the arc bulges toward (e.g. water's
  // left/right turn pieces); the radius/sweep magnitude only ever depends on
  // the unsigned angle. Roads only ever pass positive angles, so this is a
  // no-op for them (sign=1, absAngleRad===angleRad) - only negative-angle
  // callers (water curves) take the mirrored branch.
  const angleRad = (curveAngleDeg * Math.PI) / 180;
  const sign = curveAngleDeg < 0 ? -1 : 1;
  const absAngleRad = Math.abs(angleRad);

  // Radius from chord length and angle: chord = 2 R sin(theta/2)
  const radius = halfChord / Math.sin(absAngleRad / 2);
  const centerOffsetX = sign * radius * Math.cos(absAngleRad / 2); // distance from chord midpoint to circle center
  const circleCenter = { x: centerX - centerOffsetX, z: centerZ };

  // Angles sweep from -angle/2 to +angle/2 relative to center
  function buildArc(r, startA, endA, segments) {
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const a = startA + t * (endA - startA);
      const px = circleCenter.x + r * Math.cos(a);
      const pz = circleCenter.z + r * Math.sin(a);
      pts.push([px, pz]);
    }
    return pts;
  }

  const startA = -absAngleRad / 2;
  const endA = absAngleRad / 2;
  const segments = 12;
  const outerArc = buildArc(radius + halfWidth, startA, endA, segments);
  const innerRadius = Math.max(radius - halfWidth, 0.1);
  const innerArc = buildArc(innerRadius, endA, startA, segments); // reverse direction to close polygon

  return [...outerArc, ...innerArc];
}

function convertLocalToLatLng(cx, cz, config, WORLD_SIZE, map) {
  const px = (cx / config.mapSize) * WORLD_SIZE;
  const pz = (cz / config.mapSize) * WORLD_SIZE;
  const py = WORLD_SIZE - pz;
  return map.unproject(L.point(px, py), config.tileMaxZoom);
}

function distSquared(a, b) {
  const dx = a[0] - b[0];
  const dz = a[1] - b[1];
  return dx * dx + dz * dz;
}

function angleAt(idx, ring) {
  const n = ring.length;
  if (n < 3) return Math.PI;
  const prev = ring[(idx - 1 + n) % n];
  const curr = ring[idx];
  const next = ring[(idx + 1) % n];
  const v1 = [prev[0] - curr[0], prev[1] - curr[1]];
  const v2 = [next[0] - curr[0], next[1] - curr[1]];
  const dot = v1[0] * v2[0] + v1[1] * v2[1];
  const mag1 = Math.sqrt(v1[0] * v1[0] + v1[1] * v1[1]) || 1e-6;
  const mag2 = Math.sqrt(v2[0] * v2[0] + v2[1] * v2[1]) || 1e-6;
  const cosA = Math.min(1, Math.max(-1, dot / (mag1 * mag2)));
  return Math.acos(cosA);
}

function cleanupShortSegments(rings, threshold = 3.0) {
  const thr2 = threshold * threshold;
  return rings.map((ring) => {
    const pts = [...ring];
    // iterate until stable or 10 passes to avoid infinite loops
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        if (distSquared(pts[i], pts[j]) < thr2) {
          // Decide which vertex to collapse: keep the one with smaller interior angle change
          const angleI = angleAt(i, pts);
          const angleJ = angleAt(j, pts);
          if (angleI >= angleJ) {
            // move i to j
            pts[i] = [...pts[j]];
          } else {
            // move j to i
            pts[j] = [...pts[i]];
          }
          changed = true;
        }
      }
      // remove consecutive duplicates
      for (let k = pts.length - 1; k >= 0; k--) {
        const next = pts[(k + 1) % pts.length];
        if (pts[k][0] === next[0] && pts[k][1] === next[1]) {
          pts.splice(k, 1);
        }
      }
      if (!changed || pts.length < 3) break;
    }
    return pts;
  });
}

function ringOrientation(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += (x2 - x1) * (y2 + y1);
  }
  return sum >= 0 ? 1 : -1; // 1 for CCW, -1 for CW
}

function expandRing(ring, delta) {
  if (delta === 0 || ring.length < 3) return ring;
  const orientation = ringOrientation(ring); // CCW => outward is (-dy, dx)
  const len = ring.length;
  const normals = [];

  // compute edge normals
  for (let i = 0; i < len; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % len];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const mag = Math.sqrt(dx * dx + dz * dz) || 1e-6;
    const nx = (orientation > 0 ? -dz : dz) / mag;
    const nz = (orientation > 0 ? dx : -dx) / mag;
    normals.push([nx, nz]);
  }

  // vertex normals = average of adjacent edge normals
  const outRing = [];
  for (let i = 0; i < len; i++) {
    const [n1x, n1z] = normals[(i - 1 + len) % len];
    const [n2x, n2z] = normals[i];
    let nx = n1x + n2x;
    let nz = n1z + n2z;
    const mag = Math.sqrt(nx * nx + nz * nz) || 1e-6;
    nx /= mag;
    nz /= mag;
    const [px, pz] = ring[i];
    outRing.push([px + nx * delta, pz + nz * delta]);
  }
  return outRing;
}

function smoothRing(ring, iterations = 1, rightAngleToleranceDeg = 12) {
  if (!ring || ring.length < 3) return ring;
  const tolRad = (rightAngleToleranceDeg * Math.PI) / 180;
  let pts = [...ring];
  for (let it = 0; it < iterations; it++) {
    const nextPts = [];
    for (let i = 0; i < pts.length; i++) {
      const ang = angleAt(i, pts);
      // Preserve near-right angles to keep sharp corners
      if (
        Math.abs(ang - Math.PI / 2) < tolRad ||
        Math.abs(ang - (3 * Math.PI) / 2) < tolRad
      ) {
        nextPts.push(pts[i]);
      } else {
        const prev = pts[(i - 1 + pts.length) % pts.length];
        const curr = pts[i];
        const next = pts[(i + 1) % pts.length];
        nextPts.push([
          0.25 * prev[0] + 0.5 * curr[0] + 0.25 * next[0],
          0.25 * prev[1] + 0.5 * curr[1] + 0.25 * next[1],
        ]);
      }
    }
    pts = nextPts;
  }
  return pts;
}

function createLeafletPolygonFromLocal(coordsOrRings, catConfig, opts = {}) {
  // Accept a single ring or an array of rings (for holes)
  const rings = Array.isArray(coordsOrRings[0][0])
    ? coordsOrRings
    : [coordsOrRings];

  const latlngRings = rings.map((ring) =>
    ring.map(([cx, cz]) =>
      convertLocalToLatLng(cx, cz, config, WORLD_SIZE, map)
    )
  );

  // Use zoom-aware scaled stroke weight
  const scaledWeight = calculateScaledStrokeWeight(catConfig.strokeWeight);

  return L.polygon(latlngRings, {
    color:
      (opts.strokeOpacityOverride ?? catConfig.strokeOpacity) === 0
        ? "transparent"
        : catConfig.strokeColor,
    weight: scaledWeight,
    opacity: opts.strokeOpacityOverride ?? catConfig.strokeOpacity,
    fill: true,
    fillColor: opts.fillColorOverride ?? catConfig.fillColor,
    fillOpacity: opts.fillOpacityOverride ?? catConfig.fillOpacity,
    smooth: false, // Disable Leaflet's path smoothing to preserve all vertices at all zoom levels
  });
}

// Add fill-only mask over intersections between different road prefixes to hide overlapping strokes
function applyOverlapMaskForRoads(layer, catConfig, prefixes = []) {
  const roadPolys = [];
  layer.eachLayer((poly) => {
    if (!poly._objectName) return;
    const prefix = poly._objectPrefix || poly._objectName.split("_")[0];
    if (prefixes.includes(prefix)) {
      const coords = poly._localRings?.[0] || poly._rotatedCorners || [];
      if (coords && coords.length >= 3) {
        const ring = [...coords, coords[0]];
        roadPolys.push({
          prefix,
          turf: turf.polygon([ring]),
        });
      }
    }
  });

  if (roadPolys.length < 2) return;

  const intersections = [];
  for (let i = 0; i < roadPolys.length; i++) {
    for (let j = i + 1; j < roadPolys.length; j++) {
      if (roadPolys[i].prefix === roadPolys[j].prefix) continue;
      try {
        const inter = turf.intersect(roadPolys[i].turf, roadPolys[j].turf);
        if (inter && inter.geometry) {
          intersections.push(inter);
        }
      } catch (e) {
        console.warn("[ROAD OVERLAP] intersect failed", e);
      }
    }
  }

  if (intersections.length === 0) return;

  const addGeo = (rings) => {
    const cleaned = cleanupShortSegments(rings, 1.0);
    const leafletPoly = createLeafletPolygonFromLocal(cleaned, catConfig, {
      strokeOpacityOverride: 0, // hide strokes in overlap
    });
    layer.addLayer(leafletPoly);
  };

  intersections.forEach((feat) => {
    const geom = feat.geometry;
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
    }
  });
}

// Hide strokes only where different road categories overlap (e.g., asf vs city vs mud)
function applyOverlapMaskForRoadCategories(
  layer,
  catConfig,
  categoryName,
  categoryLayers,
  categories = []
) {
  const otherCategories = categories.filter((c) => c !== categoryName);
  if (otherCategories.length === 0) return;

  const toTurfPoly = (poly) => {
    const rings =
      poly._localRings ||
      (poly._rotatedCorners ? [poly._rotatedCorners] : null);
    if (!rings || !rings.length) return null;
    const closed = rings
      .map((r) => {
        if (!r || r.length < 3) return null;
        const first = r[0];
        const last = r[r.length - 1];
        if (first[0] === last[0] && first[1] === last[1]) return r;
        return [...r, first];
      })
      .filter(Boolean);
    if (!closed.length) return null;
    return turf.polygon(closed);
  };

  const currentPolys = [];
  layer.eachLayer((poly) => {
    const turfPoly = toTurfPoly(poly);
    if (turfPoly)
      currentPolys.push({ turf: turfPoly, color: catConfig.fillColor });
  });
  if (currentPolys.length === 0) return;

  const otherPolys = [];
  otherCategories.forEach((cat) => {
    const otherLayer = categoryLayers[cat];
    const otherCatConfig = mapStyles?.categories?.[cat];
    if (!otherLayer) return;
    otherLayer.eachLayer((poly) => {
      const turfPoly = toTurfPoly(poly);
      const color =
        poly._catConfig?.fillColor ||
        otherCatConfig?.fillColor ||
        catConfig.fillColor;
      if (turfPoly) otherPolys.push({ turf: turfPoly, color });
    });
  });
  if (otherPolys.length === 0) return;

  const intersections = [];
  currentPolys.forEach((a) => {
    otherPolys.forEach((b) => {
      try {
        const inter = turf.intersect(a.turf, b.turf);
        if (inter && inter.geometry) {
          intersections.push({
            geometry: inter.geometry,
            colorA: a.color,
            colorB: b.color,
          });
        }
      } catch (e) {
        console.warn("[ROAD CATEGORY OVERLAP] intersect failed", e);
      }
    });
  });

  if (intersections.length === 0) return;

  intersections.forEach((feat) => {
    const geom = feat.geometry;
    // Gradient drawing disabled - use solid color instead
    const opts = {
      strokeOpacityOverride: 0,
      fillColorOverride: feat.colorA, // Use solid colorA instead of gradient
      fillOpacityOverride: 1,
    };
    if (geom.type === "Polygon") {
      const rings = geom.coordinates;
      if (rings && rings.length > 0) {
        const cleaned = cleanupShortSegments(
          rings.map((r) => r.map(([x, z]) => [x, z])),
          1.0
        );
        const leafletPoly = createLeafletPolygonFromLocal(
          cleaned,
          catConfig,
          opts
        );
        layer.addLayer(leafletPoly);
      }
    } else if (geom.type === "MultiPolygon") {
      geom.coordinates.forEach((polyCoords) => {
        if (polyCoords && polyCoords[0]) {
          const cleaned = cleanupShortSegments(
            polyCoords.map((r) => r.map(([x, z]) => [x, z])),
            1.0
          );
          const leafletPoly = createLeafletPolygonFromLocal(
            cleaned,
            catConfig,
            opts
          );
          layer.addLayer(leafletPoly);
        }
      });
    }
  });
}

// Apply stroke masking at intersections between different road prefixes
// When roads of different types overlap, hide the stroke in both where they intersect
function applyIntersectionStrokeMasking(layer, catConfig, prefixes = []) {
  const roadsByPrefix = {};
  const roadsToMask = new Set(); // Track which roads have overlaps

  // Collect polygons by road prefix
  prefixes.forEach((prefix) => {
    roadsByPrefix[prefix] = [];
  });

  layer.eachLayer((poly) => {
    if (!poly._objectPrefix && !poly._objectName) return;

    // Find which prefix this polygon belongs to
    const prefix =
      poly._objectPrefix ||
      prefixes.find((p) => poly._objectName?.startsWith(p)) ||
      null;

    if (prefix && roadsByPrefix[prefix]) {
      roadsByPrefix[prefix].push(poly);
    }
  });

  console.log(
    "Road prefixes found:",
    Object.keys(roadsByPrefix)
      .map((k) => `${k}(${roadsByPrefix[k].length})`)
      .join(", ")
  );

  // Check for overlaps between different prefixes and create coverage masks
  const prefixList = Object.keys(roadsByPrefix).filter(
    (k) => roadsByPrefix[k].length > 0
  );
  let maskCount = 0;

  for (let i = 0; i < prefixList.length; i++) {
    for (let j = i + 1; j < prefixList.length; j++) {
      const prefix1 = prefixList[i];
      const prefix2 = prefixList[j];
      const polys1 = roadsByPrefix[prefix1];
      const polys2 = roadsByPrefix[prefix2];

      if (polys1.length === 0 || polys2.length === 0) continue;

      // Check each pair of polygons for overlap
      polys1.forEach((p1) => {
        const latlngs1 = p1.getLatLngs();
        if (!latlngs1 || !latlngs1[0]) return;

        polys2.forEach((p2) => {
          const latlngs2 = p2.getLatLngs();
          if (!latlngs2 || !latlngs2[0]) return;

          try {
            // Convert Leaflet polygons to turf format
            const coords1 = (
              Array.isArray(latlngs1[0]) ? latlngs1[0] : latlngs1
            ).map((ll) => [ll.lng, ll.lat]);
            const coords2 = (
              Array.isArray(latlngs2[0]) ? latlngs2[0] : latlngs2
            ).map((ll) => [ll.lng, ll.lat]);

            // Close the rings for turf
            if (
              coords1[0][0] !== coords1[coords1.length - 1][0] ||
              coords1[0][1] !== coords1[coords1.length - 1][1]
            ) {
              coords1.push(coords1[0]);
            }
            if (
              coords2[0][0] !== coords2[coords2.length - 1][0] ||
              coords2[0][1] !== coords2[coords2.length - 1][1]
            ) {
              coords2.push(coords2[0]);
            }

            const poly1 = turf.polygon([coords1]);
            const poly2 = turf.polygon([coords2]);

            // Get actual intersection area
            const intersection = turf.intersect(poly1, poly2);
            if (!intersection || !intersection.geometry) return;

            // Buffer the intersection generously to cover stroke at all zoom levels
            // Use a larger fixed buffer that accounts for stroke width across zoom range
            const bufferedIntersection = turf.buffer(intersection, 0.0002, {
              units: "degrees",
            });

            // Create mask polygon from buffered intersection geometry using p1's fill color
            const maskCoords =
              bufferedIntersection.geometry.type === "Polygon"
                ? bufferedIntersection.geometry.coordinates[0] // Use outer ring only
                : bufferedIntersection.geometry.coordinates.flatMap(
                    (p) => p[0]
                  ); // For multipolygon, use first ring of each

            const maskLatLngs = maskCoords.map(([lng, lat]) =>
              L.latLng(lat, lng)
            );

            // Use the fill color of the first road (p1) for the mask
            const maskFillColor = p1.options.fillColor || "#ffffff";

            const maskPoly = L.polygon(maskLatLngs, {
              stroke: false,
              fillColor: maskFillColor,
              fillOpacity: 1.0,
              className: "stroke-mask",
              smooth: false, // Disable path smoothing to preserve all vertices
            });
            layer.addLayer(maskPoly);
            maskCount++;
          } catch (e) {
            // Silently ignore intersection errors
          }
        });
      });
    }
  }

  console.log(
    `Created ${maskCount} stroke coverage masks for overlapping roads`
  );
}

// Enforce uniform width on line-type polygons while preserving length AND orientation/yaw
// If catConfig.uniformWidth is set, use that; otherwise use smallest dimension across all polygons
function enforceUniformWidth(layer, prefixes = [], catConfig = null) {
  const matched = [];
  const customDrawerMatched = [];

  // Collect all polygons for the prefixes, separating custom drawer segments
  prefixes.forEach((prefix) => {
    layer.eachLayer((poly) => {
      if (!poly._objectName) return;
      if (poly._objectName.startsWith(prefix)) {
        // Check if this object was drawn by a custom drawer
        if (coreCustomObjectDrawers[poly._objectName]) {
          customDrawerMatched.push(poly);
        } else {
          matched.push(poly);
        }
      }
    });
  });

  // Only proceed if we have non-custom segments to analyze
  if (matched.length === 0 && customDrawerMatched.length === 0) return;

  let targetWidth = catConfig?.uniformWidth || null;

  // If not specified, find the smallest dimension across all non-custom polygons
  if (targetWidth === null || targetWidth === undefined) {
    let minDimension = Infinity;
    // Use all segments (custom + non-custom) for width calculation
    const allSegments = [...matched, ...customDrawerMatched];
    allSegments.forEach((poly) => {
      const rings =
        poly._localRings ||
        (poly._rotatedCorners ? [poly._rotatedCorners] : null);
      if (!rings) return;

      rings.forEach((ring) => {
        if (!ring || ring.length < 2) return;

        // Calculate bounds
        const xs = ring.map(([x, z]) => x);
        const zs = ring.map(([x, z]) => z);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minZ = Math.min(...zs);
        const maxZ = Math.max(...zs);

        const width = maxX - minX;
        const length = maxZ - minZ;
        const smallest = Math.min(width, length);

        if (smallest > 0 && smallest < minDimension) {
          minDimension = smallest;
        }
      });
    });

    if (minDimension === Infinity) return;
    targetWidth = minDimension;
  }

  // Store the calculated target width in catConfig for custom drawers to use
  if (catConfig) {
    catConfig.uniformWidth = targetWidth;
  }

  // Normalize only non-custom polygons to the target width while preserving rotation
  matched.forEach((poly) => {
    // Check if this is one of the problematic objects that need dimension flipping
    const needsDimensionFlip =
      poly._objectName === "asf1_6konec" ||
      poly._objectName === "asf2_6konec" ||
      poly._objectName === "asf3_6konec" ||
      poly._objectName === "city_6konec" ||
      //poly._objectName === "mud_6konec" ||
      //poly._objectName === "grav_6konec" ||
      poly._objectName === "asf1_6" ||
      poly._objectName === "asf2_6" ||
      poly._objectName === "asf3_6" ||
      poly._objectName === "city_6" ||
      //      poly._objectName === "mud_6" ||
      //poly._objectName === "grav_6" ||
      poly._objectName === "rail_track_sp" ||
      poly._objectName === "rail_tracke_8" ||
      poly._objectName === "rail_tracke_4" ||
      poly._objectName === "rail_tracke_2";

    if (needsDimensionFlip) {
      console.log(`[DIMENSION FLIP] Processing ${poly._objectName}`);
    }

    const rings =
      poly._localRings ||
      (poly._rotatedCorners ? [poly._rotatedCorners] : null);
    if (!rings) return;

    const newRings = rings.map((ring) => {
      if (!ring || ring.length < 4) return ring; // Need at least 4 corners for a rectangle

      // For a rotated rectangle, find the longest side (length) and shortest side (width)
      const p0 = ring[0];
      const p1 = ring[1];
      const p2 = ring[2];
      const p3 = ring[3];

      const dist01 = Math.sqrt(
        Math.pow(p1[0] - p0[0], 2) + Math.pow(p1[1] - p0[1], 2)
      );
      const dist12 = Math.sqrt(
        Math.pow(p2[0] - p1[0], 2) + Math.pow(p2[1] - p1[1], 2)
      );
      const dist23 = Math.sqrt(
        Math.pow(p3[0] - p2[0], 2) + Math.pow(p3[1] - p2[1], 2)
      );
      const dist30 = Math.sqrt(
        Math.pow(p0[0] - p3[0], 2) + Math.pow(p0[1] - p3[1], 2)
      );

      // Determine which edges are length vs width
      const side1Length = dist01;
      const side2Length = dist12;

      let lengthEdgeIdx, lengthDist, widthDist;
      // For problematic rail objects, flip the dimension logic
      if (needsDimensionFlip) {
        if (side1Length <= side2Length) {
          lengthEdgeIdx = 0;
          lengthDist = side1Length;
          widthDist = side2Length;
        } else {
          lengthEdgeIdx = 1;
          lengthDist = side2Length;
          widthDist = side1Length;
        }
      } else {
        if (side1Length > side2Length) {
          lengthEdgeIdx = 0;
          lengthDist = side1Length;
          widthDist = side2Length;
        } else {
          lengthEdgeIdx = 1;
          lengthDist = side2Length;
          widthDist = side1Length;
        }
      }

      // Get the direction vectors for length and width
      const lengthDir =
        lengthEdgeIdx === 0
          ? [(p1[0] - p0[0]) / lengthDist, (p1[1] - p0[1]) / lengthDist]
          : [(p2[0] - p1[0]) / lengthDist, (p2[1] - p1[1]) / lengthDist];

      // Width direction is perpendicular to length
      const widthDir = [-lengthDir[1], lengthDir[0]];

      // Center of the polygon
      const centerX = (p0[0] + p1[0] + p2[0] + p3[0]) / 4;
      const centerZ = (p0[1] + p1[1] + p2[1] + p3[1]) / 4;

      // Create new rectangle with target width, preserving length and orientation
      const halfLength = lengthDist / 2;
      const halfWidth = targetWidth / 2;

      const newP0 = [
        centerX - lengthDir[0] * halfLength - widthDir[0] * halfWidth,
        centerZ - lengthDir[1] * halfLength - widthDir[1] * halfWidth,
      ];
      const newP1 = [
        centerX + lengthDir[0] * halfLength - widthDir[0] * halfWidth,
        centerZ + lengthDir[1] * halfLength - widthDir[1] * halfWidth,
      ];
      const newP2 = [
        centerX + lengthDir[0] * halfLength + widthDir[0] * halfWidth,
        centerZ + lengthDir[1] * halfLength + widthDir[1] * halfWidth,
      ];
      const newP3 = [
        centerX - lengthDir[0] * halfLength + widthDir[0] * halfWidth,
        centerZ - lengthDir[1] * halfLength + widthDir[1] * halfWidth,
      ];

      return [newP0, newP1, newP2, newP3];
    });

    // Update the polygon with normalized rings
    poly._localRings = newRings;
    if (poly._rotatedCorners) {
      poly._rotatedCorners = newRings[0]; // Update display corners
    }

    // Redraw the polygon
    const leafletCorners = newRings[0].map(([cx, cz]) => {
      const px = (cx / config.mapSize) * WORLD_SIZE;
      const pz = (cz / config.mapSize) * WORLD_SIZE;
      const py = WORLD_SIZE - pz;
      return map.unproject(L.point(px, py), config.tileMaxZoom);
    });

    poly.setLatLngs(leafletCorners);
  });

  console.log(
    `Enforced uniform width (${targetWidth}) on ${matched.length} rail polygons`
  );
}

// Smart union for rails - only merge on short sides (width), not long sides (length)
function applySmartUnionForRails(
  layer,
  catConfig,
  prefixes = [],
  smallFeatureThreshold = 0.5
) {
  prefixes.forEach((prefix) => {
    const matched = [];
    layer.eachLayer((poly) => {
      if (!poly._objectName) return;
      if (poly._objectName.startsWith(prefix)) {
        matched.push(poly);
      }
    });

    if (matched.length < 2) return;

    // Group segments by which ones should merge (touching on short sides)
    const mergeGroups = [];
    const processed = new Set();

    matched.forEach((poly, idx) => {
      if (processed.has(idx)) return;

      const group = [poly];
      processed.add(idx);
      const ring = poly._rotatedCorners || [];

      // For each segment, find others it connects with on short sides
      for (let i = idx + 1; i < matched.length; i++) {
        if (processed.has(i)) continue;
        const otherRing = matched[i]._rotatedCorners || [];

        // Check if this segment connects to the group on short sides
        if (shouldMergeRailSegments(ring, otherRing)) {
          group.push(matched[i]);
          processed.add(i);
        }
      }

      mergeGroups.push(group);
    });

    // Now merge each group
    mergeGroups.forEach((group) => {
      if (group.length === 1) return; // Skip single segments

      const turfPolys = group
        .map((poly) => {
          const coords = poly._rotatedCorners || [];
          if (!coords || coords.length < 3) return null;
          const ring = [...coords, coords[0]];
          return turf.polygon([ring]);
        })
        .filter(Boolean);

      if (turfPolys.length < 2) return;

      let merged = turfPolys[0];
      for (let i = 1; i < turfPolys.length; i++) {
        try {
          merged = turf.union(merged, turfPolys[i]);
        } catch (e) {
          console.warn("Rail union failed", e);
        }
      }

      if (!merged || !merged.geometry) return;

      // Remove originals
      group.forEach((p) => layer.removeLayer(p));

      const addGeo = (rings) => {
        const cleaned = cleanupShortSegments(rings, smallFeatureThreshold).map(
          (r) => smoothRing(r, 1.0)
        );
        const leafletPoly = createLeafletPolygonFromLocal(cleaned, catConfig);
        leafletPoly._objectName = `${prefix}_union`;
        leafletPoly._objectPrefix = prefix;
        leafletPoly._localRings = cleaned;
        layer.addLayer(leafletPoly);
      };

      if (merged.geometry.type === "Polygon") {
        const rings = merged.geometry.coordinates;
        if (rings && rings.length > 0) {
          addGeo(rings.map((r) => r.map(([x, z]) => [x, z])));
        }
      } else if (merged.geometry.type === "MultiPolygon") {
        merged.geometry.coordinates.forEach((polyCoords) => {
          if (polyCoords && polyCoords[0]) {
            addGeo(polyCoords.map((r) => r.map(([x, z]) => [x, z])));
          }
        });
      }
    });
  });
}

// Check if two rail segments should merge (touching on short sides, not long sides)
function shouldMergeRailSegments(ring1, ring2) {
  if (!ring1 || !ring2 || ring1.length < 4 || ring2.length < 4) return false;

  // Get bounds for both rings
  const getBounds = (ring) => {
    const xs = ring.map(([x]) => x);
    const zs = ring.map(([, z]) => z);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    };
  };

  const b1 = getBounds(ring1);
  const b2 = getBounds(ring2);

  // Calculate dimensions
  const w1 = b1.maxX - b1.minX;
  const l1 = b1.maxZ - b1.minZ;
  const w2 = b2.maxX - b2.minX;
  const l2 = b2.maxZ - b2.minZ;

  // Identify which is width vs length (width is smaller)
  const isWidth1X = w1 < l1;
  const isWidth2X = w2 < l2;

  const tolerance = 0.2; // Tolerance for touching

  // If rectangles are axis-aligned differently, check for overlap
  if (isWidth1X === isWidth2X) {
    // Same orientation - check for short-side touching
    if (isWidth1X) {
      // Width is X dimension, length is Z
      // Check if they touch on Z ends (short sides)
      const touchOnZ =
        Math.abs(b1.maxZ - b2.minZ) < tolerance ||
        Math.abs(b2.maxZ - b1.minZ) < tolerance;
      // Check they overlap in X (width dimension)
      const overlapX = b1.maxX > b2.minX && b1.minX < b2.maxX;

      return touchOnZ && overlapX;
    } else {
      // Width is Z dimension, length is X
      // Check if they touch on X ends (short sides)
      const touchOnX =
        Math.abs(b1.maxX - b2.minX) < tolerance ||
        Math.abs(b2.maxX - b1.minX) < tolerance;
      // Check they overlap in Z (width dimension)
      const overlapZ = b1.maxZ > b2.minZ && b1.minZ < b2.maxZ;

      return touchOnX && overlapZ;
    }
  }

  return false;
}

// Per-prefix union with metadata for downstream overlap masking
function applyUnionForRoadPrefixesV2(
  layer,
  catConfig,
  prefixes = [],
  bufferDist = 0.5,
  smallFeatureThreshold = 0.5
) {
  prefixes.forEach((prefix) => {
    const matched = [];
    layer.eachLayer((poly) => {
      if (!poly._objectName) return;
      // Include both road segments starting with prefix AND intersection segments for this prefix
      if (
        poly._objectName.startsWith(prefix) ||
        (poly._isIntersection && poly._intersectionPrefix === prefix)
      ) {
        matched.push(poly);
      }
    });

    if (matched.length < 2) return;

    const turfPolys = matched
      .map((poly) => {
        const coords = poly._rotatedCorners || [];
        if (!coords || coords.length < 3) return null;
        const expandedRing =
          bufferDist > 0 ? expandRing(coords, bufferDist) : coords;
        const ring = [...expandedRing, expandedRing[0]];
        return turf.polygon([ring]);
      })
      .filter(Boolean);

    if (turfPolys.length < 2) return;

    let merged = turfPolys[0];
    for (let i = 1; i < turfPolys.length; i++) {
      try {
        merged = turf.union(merged, turfPolys[i]);
      } catch (e) {
        console.warn("Union failed for road piece", e);
      }
    }

    if (!merged || !merged.geometry) return;

    // Remove originals of this prefix
    matched.forEach((p) => layer.removeLayer(p));

    const addGeo = (rings) => {
      const cleaned = cleanupShortSegments(rings, smallFeatureThreshold).map(
        (r) => smoothRing(r, bufferDist * 4) // Scale smoothing with buffer distance
      );
      const leafletPoly = createLeafletPolygonFromLocal(cleaned, catConfig);
      leafletPoly._objectName = `${prefix}_union`;
      leafletPoly._objectPrefix = prefix;
      leafletPoly._localRings = cleaned;
      layer.addLayer(leafletPoly);
    };

    if (merged.geometry.type === "Polygon") {
      const rings = merged.geometry.coordinates;
      if (rings && rings.length > 0) {
        addGeo(rings.map((r) => r.map(([x, z]) => [x, z])));
      }
    } else if (merged.geometry.type === "MultiPolygon") {
      merged.geometry.coordinates.forEach((polyCoords) => {
        if (polyCoords && polyCoords[0]) {
          addGeo(polyCoords.map((r) => r.map(([x, z]) => [x, z])));
        }
      });
    } else {
      console.warn(
        "[ROAD UNION] Unexpected geometry type:",
        merged.geometry.type
      );
    }
  });
}

// Async version of applyUnionForRoadPrefixesV2 - yields to browser during union operations
function applyUnionForRoadPrefixesV3(
  layer,
  catConfig,
  prefixes = [],
  bufferDist = 0.5,
  smallFeatureThreshold = 0.5
) {
  console.log(
    `[V3 UNION] Starting async union for prefixes: ${prefixes.join(", ")}`
  );
  let prefixIndex = 0;

  function processNextPrefix() {
    if (prefixIndex >= prefixes.length) {
      console.log(`[V3 UNION] All prefixes processed`);
      return;
    }

    const prefix = prefixes[prefixIndex];
    prefixIndex++;
    console.log(
      `[V3 UNION] Processing prefix ${prefixIndex}/${prefixes.length}: '${prefix}'`
    );

    const matched = [];
    layer.eachLayer((poly) => {
      if (!poly._objectName) return;
      if (
        poly._objectName.startsWith(prefix) ||
        (poly._isIntersection && poly._intersectionPrefix === prefix)
      ) {
        matched.push(poly);
      }
    });

    console.log(
      `[V3 UNION] Found ${matched.length} polygons for prefix '${prefix}'`
    );

    if (matched.length < 2) {
      console.log(
        `[V3 UNION] Skipping '${prefix}' - need at least 2 polygons, found ${matched.length}`
      );
      setTimeout(processNextPrefix, 10);
      return;
    }

    const turfPolys = matched
      .map((poly) => {
        const coords = poly._rotatedCorners || [];
        if (!coords || coords.length < 3) return null;
        const expandedRing =
          bufferDist > 0 ? expandRing(coords, bufferDist) : coords;
        const ring = [...expandedRing, expandedRing[0]];
        return turf.polygon([ring]);
      })
      .filter(Boolean);

    console.log(
      `[V3 UNION] Created ${turfPolys.length} turf polygons for '${prefix}'`
    );

    if (turfPolys.length < 2) {
      console.log(
        `[V3 UNION] Skipping '${prefix}' - insufficient valid turf polygons`
      );
      setTimeout(processNextPrefix, 10);
      return;
    }

    // Perform union asynchronously using tree approach
    console.log(
      `[V3 UNION] Starting tree-based async union for '${prefix}' with ${turfPolys.length} polygons`
    );
    performUnionAsyncTree(
      turfPolys,
      prefix,
      matched,
      layer,
      catConfig,
      bufferDist,
      smallFeatureThreshold,
      () => {
        console.log(`[V3 UNION] Finished '${prefix}', moving to next`);
        setTimeout(processNextPrefix, 10);
      }
    );
  }

  processNextPrefix();
}

// Tree-based async union - divide and conquer for better performance
// Divides polygons into batches, unions each batch, then unions the batch results
function performUnionAsyncTree(
  turfPolys,
  prefix,
  matched,
  layer,
  catConfig,
  bufferDist,
  smallFeatureThreshold,
  callback
) {
  console.log(
    `[V3 UNION] performUnionAsyncTree starting for '${prefix}' with ${turfPolys.length} polygons`
  );

  const batchSize = 10; // Union 10 polygons per batch
  let currentLevel = turfPolys.map((poly, idx) => ({ poly, idx }));
  let levelNumber = 0;

  function processLevel() {
    console.log(
      `[V3 UNION] Level ${levelNumber}: Processing ${currentLevel.length} items for '${prefix}'`
    );

    if (currentLevel.length === 1) {
      // Final result reached
      const finalMerged = currentLevel[0].poly;
      console.log(`[V3 UNION] Tree union complete for '${prefix}'`);
      finalizeUnion(
        finalMerged,
        prefix,
        matched,
        layer,
        catConfig,
        bufferDist,
        smallFeatureThreshold,
        callback
      );
      return;
    }

    const nextLevel = [];
    let batchIndex = 0;

    function processBatch() {
      if (batchIndex >= currentLevel.length) {
        // Move to next level
        levelNumber++;
        currentLevel = nextLevel;
        setTimeout(processLevel, 10); // Yield to browser between levels
        return;
      }

      // Take up to batchSize items and merge them
      const batchEnd = Math.min(batchIndex + batchSize, currentLevel.length);
      const batchItems = currentLevel.slice(batchIndex, batchEnd);

      console.log(
        `[V3 UNION] Level ${levelNumber} batch: items ${
          batchIndex + 1
        }-${batchEnd}/${currentLevel.length} for '${prefix}'`
      );

      let batchResult = batchItems[0].poly;
      for (let i = 1; i < batchItems.length; i++) {
        try {
          batchResult = turf.union(batchResult, batchItems[i].poly);
          console.log(
            `[V3 UNION] Level ${levelNumber}: Merged item ${
              batchIndex + i + 1
            }/${currentLevel.length}`
          );
        } catch (e) {
          console.warn(`[V3 UNION] Union failed at level ${levelNumber}:`, e);
        }
      }

      nextLevel.push({ poly: batchResult, idx: batchIndex });
      batchIndex = batchEnd;

      // Process next batch immediately (within same level)
      setTimeout(processBatch, 10);
    }

    processBatch();
  }

  processLevel();
}

// Async union helper - processes union operations in chunks with browser yields
function performUnionAsync(
  turfPolys,
  prefix,
  matched,
  layer,
  catConfig,
  bufferDist,
  smallFeatureThreshold,
  callback
) {
  console.log(`[V3 UNION] performUnionAsync starting for '${prefix}'`);
  let merged = null;
  let index = 0;

  function processNextChunk() {
    const chunkSize = 3;
    const endIndex = Math.min(index + chunkSize, turfPolys.length);

    console.log(
      `[V3 UNION] Processing chunk for '${prefix}': ${index + 1}-${endIndex}/${
        turfPolys.length
      }`
    );

    for (let i = index; i < endIndex; i++) {
      try {
        if (merged === null) {
          merged = turfPolys[i];
          console.log(`[V3 UNION] Initialized merged with polygon ${i}`);
        } else {
          merged = turf.union(merged, turfPolys[i]);
          console.log(
            `[V3 UNION] Union complete: ${i + 1}/${turfPolys.length}`
          );
        }
      } catch (e) {
        console.warn(
          `[V3 UNION] Union failed for '${prefix}' at polygon ${i}:`,
          e
        );
      }
    }

    index = endIndex;

    if (index < turfPolys.length) {
      setTimeout(processNextChunk, 10);
    } else {
      console.log(
        `[V3 UNION] All unions complete for '${prefix}', finalizing...`
      );
      finalizeUnion(
        merged,
        prefix,
        matched,
        layer,
        catConfig,
        bufferDist,
        smallFeatureThreshold,
        callback
      );
    }
  }

  processNextChunk();
}

// Finalize union result and add to layer
function finalizeUnion(
  merged,
  prefix,
  matched,
  layer,
  catConfig,
  bufferDist,
  smallFeatureThreshold,
  callback
) {
  console.log(`[V3 UNION] finalizeUnion for '${prefix}'`);

  if (!merged || !merged.geometry) {
    console.warn(`[V3 UNION] No valid merged geometry for '${prefix}'`);
    if (callback) callback();
    return;
  }

  console.log(
    `[V3 UNION] Merged geometry type for '${prefix}': ${merged.geometry.type}`
  );
  console.log(
    `[V3 UNION] Removing ${matched.length} original polygons for '${prefix}'`
  );

  matched.forEach((p) => layer.removeLayer(p));

  let geoCount = 0;
  const addGeo = (rings) => {
    geoCount++;
    const cleaned = cleanupShortSegments(rings, smallFeatureThreshold).map(
      (r) => smoothRing(r, bufferDist * 4)
    );
    const leafletPoly = createLeafletPolygonFromLocal(cleaned, catConfig);
    leafletPoly._objectName = `${prefix}_union`;
    leafletPoly._objectPrefix = prefix;
    leafletPoly._localRings = cleaned;
    layer.addLayer(leafletPoly);
  };

  if (merged.geometry.type === "Polygon") {
    const rings = merged.geometry.coordinates;
    if (rings && rings.length > 0) {
      console.log(
        `[V3 UNION] Adding Polygon with ${rings.length} rings for '${prefix}'`
      );
      addGeo(rings.map((r) => r.map(([x, z]) => [x, z])));
    }
  } else if (merged.geometry.type === "MultiPolygon") {
    console.log(
      `[V3 UNION] Adding MultiPolygon with ${merged.geometry.coordinates.length} sub-polygons for '${prefix}'`
    );
    merged.geometry.coordinates.forEach((polyCoords) => {
      if (polyCoords && polyCoords[0]) {
        addGeo(polyCoords.map((r) => r.map(([x, z]) => [x, z])));
      }
    });
  } else {
    console.warn(
      "[ROAD UNION] Unexpected geometry type:",
      merged.geometry.type
    );
  }

  console.log(`[V3 UNION] Added ${geoCount} merged geometries for '${prefix}'`);
  if (callback) callback();
}

function createDiagonalAlignedRectangle(
  startX,
  startZ,
  endX,
  endZ,
  lineWidth,
  flipCorners = false
) {
  // Apply debug offsets if available
  let adjStartX = startX;
  let adjStartZ = startZ;
  let adjEndX = endX;
  let adjEndZ = endZ;
  let adjFlipCorners = flipCorners;

  if (typeof roadDebug !== "undefined" && roadDebug.enabled) {
    adjStartX += roadDebug.startXOffset;
    adjStartZ += roadDebug.startZOffset;
    adjEndX += roadDebug.endXOffset;
    adjEndZ += roadDebug.endZOffset;
    adjFlipCorners = roadDebug.flipCorners || flipCorners;
  }

  // Snap start and end points to grid for alignment with adjacent polygons
  const gridSize = 0.5;
  const snappedStartX = Math.round(adjStartX / gridSize) * gridSize;
  const snappedStartZ = Math.round(adjStartZ / gridSize) * gridSize;
  const snappedEndX = Math.round(adjEndX / gridSize) * gridSize;
  const snappedEndZ = Math.round(adjEndZ / gridSize) * gridSize;

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
  if (adjFlipCorners) {
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

function computeBoundsFromCorners(corners) {
  if (!corners || corners.length === 0) return null;
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  corners.forEach(([cx, cz]) => {
    if (cx < minX) minX = cx;
    if (cz < minZ) minZ = cz;
    if (cx > maxX) maxX = cx;
    if (cz > maxZ) maxZ = cz;
  });
  return { minX, minZ, maxX, maxZ };
}

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

// Stream/river curve pieces are named "<prefix>_<width>_<baseLength>_l<deg>" or
// "..._r<deg>" (e.g. "stream_14_24_l45", "river_24_24_r30") - the turn angle is
// given directly, unlike roads' "_<radius> <lengthCode>" convention. Sign is a
// guess (l = positive, r = negative) to be verified against real placements.
function parseWaterCurveSpec(objectName) {
  if (!objectName) return { angle: 0 };
  const match = objectName.match(/_([lr])(\d+)$/i);
  if (!match) return { angle: 0 };
  const deg = parseFloat(match[2]);
  return { angle: match[1].toLowerCase() === 'l' ? deg : -deg };
}

// Factory to build stream/river curve drawers, reusing the same normalized-
// rectangle/arc machinery as roads (createNormalizedRoadRectangle), just with
// water's own curve-name parsing.
function makeWaterCurveDrawer(referenceObjectName, objectNameForAngle) {
  const { angle: curveAngle } = parseWaterCurveSpec(objectNameForAngle);
  return function (x, z, yaw, bbox, catConfig, bboxCache) {
    return createNormalizedRoadRectangle(
      x,
      z,
      yaw,
      bbox,
      catConfig,
      bboxCache,
      referenceObjectName,
      null,
      curveAngle
    );
  };
}

// createNormalizedRoadRectangle treats a curve piece's own bbox Z-extent as
// its chord length, which is a good approximation for gentle bends (bbox stays
// mostly elongated) but badly overestimates it for a tight ~90 degree turn,
// where the bbox is nearly SQUARE (e.g. stream_14_16_l90/r90 measure ~18.4 x
// 18.4) - the axis extent alone is much longer than the true straight-line
// entry-to-exit distance. Using the bbox diagonal instead is a much closer
// proxy at wide turn angles. Mirrors createNormalizedRoadRectangle's own
// recentering/rotation bookkeeping so the two stay visually consistent.
// Shared by any "tight turn" piece whose own bbox is nearly square (so a
// single axis-extent badly overestimates true chord length - see the
// water l90/r90 investigation). Uses the bbox diagonal as chord length
// instead, and mirrors createNormalizedRoadRectangle's own curve-branch
// recentering/rotation bookkeeping so all these curve drawers stay visually
// consistent with each other.
function createDiagonalChordCurve(x, z, curveAngleDeg, bbox, catConfig, bboxCache, referenceObjectName) {
  if (!bbox || !bbox.size || !curveAngleDeg) return null;
  const [sizeX, , sizeZ] = bbox.size;
  const scale = catConfig.sizeScale || 1.0;
  const refWidth = getLineWidthFromReference(referenceObjectName, bboxCache);
  const width = (refWidth > 0 ? refWidth : Math.min(sizeX, sizeZ)) * scale;
  const diagonalChord = Math.sqrt(sizeX * sizeX + sizeZ * sizeZ) * scale;

  let curvePoly = createCurvePolygon(x, z, curveAngleDeg, width, diagonalChord);
  const bounds = computeBoundsFromCorners(curvePoly);
  if (bounds) {
    const curveCenterX = (bounds.minX + bounds.maxX) / 2;
    const curveCenterZ = (bounds.minZ + bounds.maxZ) / 2;
    const deltaX = x - curveCenterX;
    const deltaZ = z - curveCenterZ;
    curvePoly = curvePoly.map(([cx, cz]) => [cx + deltaX, cz + deltaZ]);
    curvePoly._centerShift = [deltaX, deltaZ];
  }
  curvePoly._rotationCenter = [x, z];
  curvePoly._extraYawDeg = 180 + curveAngleDeg / 2;
  curvePoly._noSnap = true;
  curvePoly._isCurve = true;
  return curvePoly;
}

function makeWaterRightAngleCurveDrawer(referenceObjectName, objectNameForAngle) {
  const { angle: curveAngle } = parseWaterCurveSpec(objectNameForAngle);
  return function (x, z, yaw, bbox, catConfig, bboxCache) {
    return createDiagonalChordCurve(x, z, curveAngle, bbox, catConfig, bboxCache, referenceObjectName);
  };
}

// Sidewalk turn pieces are named "sidewalk<N>_turn_<deg>deg" with a single,
// consistent bend direction - unlike water there's no "_l"/"_r" suffix; both
// turn directions come from the placement's own yaw, not the piece name.
function parseSidewalkTurnSpec(objectName) {
  if (!objectName) return { angle: 0 };
  const match = objectName.match(/_turn_(\d+)deg$/i);
  return match ? { angle: parseFloat(match[1]) } : { angle: 0 };
}

function makeSidewalkCurveDrawer(referenceObjectName, objectNameForAngle) {
  const { angle: curveAngle } = parseSidewalkTurnSpec(objectNameForAngle);
  return function (x, z, yaw, bbox, catConfig, bboxCache) {
    return createNormalizedRoadRectangle(x, z, yaw, bbox, catConfig, bboxCache, referenceObjectName, null, curveAngle);
  };
}

// sidewalk*_corner has a near-square bbox (one fixed ~90 degree bend, no
// "_turn_Ndeg" suffix at all) - same diagonal-chord treatment as water's l90/r90.
function makeRightAngleCurveDrawer(referenceObjectName, fixedAngleDeg) {
  return function (x, z, yaw, bbox, catConfig, bboxCache) {
    return createDiagonalChordCurve(x, z, fixedAngleDeg, bbox, catConfig, bboxCache, referenceObjectName);
  };
}

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
const coreCustomObjectDrawers = {
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
  // asf1 straight/endcap variants (no curve suffix - previously fell through to raw
  // mesh-bbox width instead of the normalized uniformWidth, causing visible bulges)
  "asf1_0 2000": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_0 2000"),
  "asf1_6": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_6"),
  "asf1_12": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_12"),
  "asf1_25": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_25"),
  "asf1_6konec": makeRoadDrawer("asf1_0 2000", "asf1", "asf1_6konec"),
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
  // asf2 straight/endcap variants (see asf1 note above)
  "asf2_0 2000": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_0 2000"),
  "asf2_6": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_6"),
  "asf2_12": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_12"),
  "asf2_25": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_25"),
  "asf2_6konec": makeRoadDrawer("asf2_0 2000", "asf2", "asf2_6konec"),
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
  // asf3 straight/endcap variants (see asf1 note above)
  "asf3_0 2000": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_0 2000"),
  "asf3_6": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_6"),
  "asf3_12": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_12"),
  "asf3_25": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_25"),
  "asf3_6konec": makeRoadDrawer("asf3_0 2000", "asf3", "asf3_6konec"),

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
  // city straight/endcap variants (see asf1 note above)
  "city_0 2000": makeRoadDrawer("city_0 2000", "city", "city_0 2000"),
  "city_6": makeRoadDrawer("city_0 2000", "city", "city_6"),
  "city_12": makeRoadDrawer("city_0 2000", "city", "city_12"),
  "city_25": makeRoadDrawer("city_0 2000", "city", "city_25"),
  "city_6konec": makeRoadDrawer("city_0 2000", "city", "city_6konec"),
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
  // grav straight/endcap variants (see asf1 note above)
  "grav_0 2000": makeRoadDrawer("grav_0 2000", "grav", "grav_0 2000"),
  "grav_6": makeRoadDrawer("grav_0 2000", "grav", "grav_6"),
  "grav_12": makeRoadDrawer("grav_0 2000", "grav", "grav_12"),
  "grav_25": makeRoadDrawer("grav_0 2000", "grav", "grav_25"),
  "grav_6konec": makeRoadDrawer("grav_0 2000", "grav", "grav_6konec"),
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
  // mud straight/endcap variants (see asf1 note above)
  "mud_0 2000": makeRoadDrawer("mud_0 2000", "mud", "mud_0 2000"),
  "mud_6": makeRoadDrawer("mud_0 2000", "mud", "mud_6"),
  "mud_12": makeRoadDrawer("mud_0 2000", "mud", "mud_12"),
  "mud_25": makeRoadDrawer("mud_0 2000", "mud", "mud_25"),
  "mud_6konec": makeRoadDrawer("mud_0 2000", "mud", "mud_6konec"),

  // ===== STREAM / RIVER CURVE DRAWERS =====
  // Unlike roads, plain-rectangle stream/river segments already connect fine
  // (pivot is centered on the mesh bbox) - only the curved turn pieces need a
  // real arc instead of a crude bounding-box blob. Width reference is the
  // matching straight piece for each width family (all stream_14_* share
  // width 14, all river_24_* share width 24 - "stream_14_16" itself has no
  // plain-straight variant, so it borrows the "stream_14_24" reference).
  "stream_14_24_l10": makeWaterCurveDrawer("stream_14_24", "stream_14_24_l10"),
  "stream_14_24_r10": makeWaterCurveDrawer("stream_14_24", "stream_14_24_r10"),
  "stream_14_24_l30": makeWaterCurveDrawer("stream_14_24", "stream_14_24_l30"),
  "stream_14_24_r30": makeWaterCurveDrawer("stream_14_24", "stream_14_24_r30"),
  "stream_14_24_l45": makeWaterCurveDrawer("stream_14_24", "stream_14_24_l45"),
  "stream_14_24_r45": makeWaterCurveDrawer("stream_14_24", "stream_14_24_r45"),
  "stream_14_16_l45": makeWaterCurveDrawer("stream_14_24", "stream_14_16_l45"),
  "stream_14_16_r45": makeWaterCurveDrawer("stream_14_24", "stream_14_16_r45"),
  "stream_14_16_l90": makeWaterRightAngleCurveDrawer("stream_14_24", "stream_14_16_l90"),
  "stream_14_16_r90": makeWaterRightAngleCurveDrawer("stream_14_24", "stream_14_16_r90"),
  "river_24_24_l10": makeWaterCurveDrawer("river_24_24", "river_24_24_l10"),
  "river_24_24_r10": makeWaterCurveDrawer("river_24_24", "river_24_24_r10"),
  "river_24_24_l30": makeWaterCurveDrawer("river_24_24", "river_24_24_l30"),
  "river_24_24_r30": makeWaterCurveDrawer("river_24_24", "river_24_24_r30"),

  // ===== SIDEWALK CURVE DRAWERS =====
  // Straight sidewalk pieces (sidewalk1_1m/5m/10m, sidewalk3_*_4m/12m, etc.)
  // are left on the default rectangle path - their own bbox already matches
  // width consistently across each family, and (unlike roads) the default
  // path has no width/length axis-reassignment logic to go wrong for short
  // pieces. Only the curve/corner pieces need a real drawer.
  "sidewalk1_turn_5deg": makeSidewalkCurveDrawer("sidewalk1_10m", "sidewalk1_turn_5deg"),
  "sidewalk1_turn_10deg": makeSidewalkCurveDrawer("sidewalk1_10m", "sidewalk1_turn_10deg"),
  "sidewalk1_turn_30deg": makeSidewalkCurveDrawer("sidewalk1_10m", "sidewalk1_turn_30deg"),
  // sidewalk1_corner/sidewalk3_*_corner have no explicit angle in the name (a
  // single fixed ~90 degree bend, mirrored via placement yaw) and a near-
  // square bbox like water's l90/r90, so they need the diagonal-chord drawer.
  "sidewalk1_corner": makeRightAngleCurveDrawer("sidewalk1_10m", 90),
  "sidewalk3_narrow_corner": makeRightAngleCurveDrawer("sidewalk3_narrow_12m", 90),
  "sidewalk3_wide_corner": makeRightAngleCurveDrawer("sidewalk3_wide_12m", 90),

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

// Helper: Reorder all visible layers on the map according to drawingOrder config
function reorderLayersOnMap() {
  if (!mapStyles.drawingOrder || !Array.isArray(mapStyles.drawingOrder)) {
    return;
  }

  const visibleCategories = mapStyles.drawingOrder.filter(
    (catName) => categoryLayers[catName] && categoryLayers[catName] !== null
  );

  // Remove all visible layers from map
  visibleCategories.forEach((catName) => {
    if (categoryLayers[catName]) {
      map.removeLayer(categoryLayers[catName]);
    }
  });

  // Re-add them in the correct order (first in array = drawn first = behind)
  visibleCategories.forEach((catName) => {
    if (categoryLayers[catName]) {
      categoryLayers[catName].addTo(map);
    }
  });

  console.log(`Layer order updated: ${visibleCategories.join(", ")}`);
}

// Helper: Reorder road layers according to road drawing priority
function reorderRoadLayers() {
  if (
    !mapStyles.roadDrawingOrder ||
    !Array.isArray(mapStyles.roadDrawingOrder)
  ) {
    return;
  }

  const visibleRoadCategories = mapStyles.roadDrawingOrder.filter(
    (catName) => categoryLayers[catName] && categoryLayers[catName] !== null
  );

  if (visibleRoadCategories.length === 0) return;

  // Remove all visible road layers from map
  visibleRoadCategories.forEach((catName) => {
    if (categoryLayers[catName]) {
      map.removeLayer(categoryLayers[catName]);
    }
  });

  // Re-add them in the correct order (first in array = drawn first = behind)
  visibleRoadCategories.forEach((catName) => {
    if (categoryLayers[catName]) {
      categoryLayers[catName].addTo(map);
    }
  });

  console.log(`Road layer order updated: ${visibleRoadCategories.join(", ")}`);
}

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
  if (coreCustomObjectDrawers[objectName]) {
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

    const result = coreCustomObjectDrawers[objectName](
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

// Helper: Create 64-point polygon circle in DayZ local coordinates
function createCirclePolygon(centerX, centerZ, radiusLocalUnits, points = 64) {
  const polygon = [];

  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const localX = centerX + radiusLocalUnits * Math.cos(angle);
    const localZ = centerZ + radiusLocalUnits * Math.sin(angle);

    // Convert to pixel coordinates
    const px = (localX / config.mapSize) * WORLD_SIZE;
    const pz = (localZ / config.mapSize) * WORLD_SIZE;
    const py = WORLD_SIZE - pz;

    // Convert to lat/lng
    const latlng = map.unproject(L.point(px, py), config.tileMaxZoom);
    polygon.push([latlng.lat, latlng.lng]);
  }

  return polygon;
}

// Non-blocking boolean union that yields to the browser periodically
// Allows the page to remain responsive during heavy computation
function applyBooleanUnionRenderingAsync(layer, catConfig) {
  const polygons = [];

  // Collect all polygon coordinates from the layer
  layer.eachLayer((polygon) => {
    if (polygon.getLatLngs && polygon.getLatLngs()[0]) {
      const latlngs = polygon.getLatLngs()[0];
      if (latlngs.length >= 3) {
        // Convert Leaflet LatLng to GeoJSON coordinates [lng, lat]
        const coords = latlngs.map((ll) => [ll.lng, ll.lat]);
        // Close the ring
        if (
          coords[0][0] !== coords[coords.length - 1][0] ||
          coords[0][1] !== coords[coords.length - 1][1]
        ) {
          coords.push(coords[0]);
        }

        polygons.push({
          type: "Polygon",
          coordinates: [coords],
        });
      }
    }
  });

  console.log(
    `Boolean union (async): starting with ${polygons.length} polygons`
  );

  if (polygons.length === 0) {
    console.warn("No valid polygons found for boolean union");
    return;
  }

  if (polygons.length === 1) {
    console.log("Only 1 polygon, skipping union");
    return;
  }

  // Process in phases with yields to browser
  let phase = 0;

  function processPhase() {
    if (phase === 0) {
      // Phase 0: Find intersections
      console.log("Finding intersection zones...");
      phase = 1;
      setTimeout(processPhase, 10); // Yield to browser
    } else if (phase === 1) {
      // Phase 1: Buffer polygons
      const bufferDistance = 0.0005;
      console.log(
        `Buffering polygons by ${bufferDistance} degrees to merge nearby segments...`
      );

      const bufferedPolygons = [];
      for (let i = 0; i < polygons.length; i++) {
        try {
          const buffered = turf.buffer(
            turf.feature(polygons[i]),
            bufferDistance,
            { units: "degrees" }
          );
          if (buffered && buffered.geometry) {
            bufferedPolygons.push(buffered);
          }
        } catch (e) {
          bufferedPolygons.push(turf.feature(polygons[i]));
        }
      }

      // Perform boolean union in chunks with yields
      phase = 2;
      performUnionInChunks(bufferedPolygons, 0, null, processPhase);
    }
  }

  // Helper: Perform union operations in chunks
  function performUnionInChunks(bufferedPolygons, index, merged, callback) {
    if (index === 0) {
      merged = bufferedPolygons[0];
    }

    // Process 5 polygons at a time
    const chunkSize = 5;
    const endIndex = Math.min(index + chunkSize, bufferedPolygons.length);

    for (let i = index + 1; i < endIndex; i++) {
      try {
        merged = turf.union(merged, bufferedPolygons[i]);
      } catch (e) {
        console.warn(`Union failed at index ${i}:`, e);
      }

      if (i % 10 === 0) {
        console.log(`  Merged ${i}/${bufferedPolygons.length} polygons`);
      }
    }

    if (endIndex < bufferedPolygons.length) {
      // More to process, yield to browser
      setTimeout(() => {
        performUnionInChunks(bufferedPolygons, endIndex, merged, callback);
      }, 10);
    } else {
      // Union complete, continue post-processing
      console.log(
        `Boolean union complete, merged geometry type: ${merged.geometry.type}`
      );
      finishUnionProcessing(merged, layer);
    }
  }

  // Helper: Finish union processing (simplify, erode/dilate, render)
  function finishUnionProcessing(merged, layer) {
    console.log("Simplifying geometry...");
    merged = turf.simplify(merged, { tolerance: 0.00001, highQuality: true });

    console.log(
      "Removing small transition segments with aggressive erosion/dilation..."
    );
    const erosionBuffer = -0.0005;
    const dilationBuffer = 0.0005;

    try {
      let cleaned = merged;

      if (cleaned.geometry.type === "Polygon") {
        cleaned = turf.buffer(cleaned, erosionBuffer, { units: "degrees" });
      } else if (cleaned.geometry.type === "MultiPolygon") {
        console.log(
          `MultiPolygon detected with ${cleaned.geometry.coordinates.length} sub-polygons`
        );
        cleaned = turf.buffer(cleaned, erosionBuffer, { units: "degrees" });
      }

      if (cleaned && cleaned.geometry) {
        cleaned = turf.buffer(cleaned, dilationBuffer, { units: "degrees" });
        merged = cleaned;
        console.log(
          `Erosion/dilation complete - result type: ${merged.geometry.type}`
        );
      }
    } catch (e) {
      console.warn("Erosion/dilation failed, using original geometry:", e);
    }

    // Remove original polygons and render merged result
    const originalLayers = [];
    layer.eachLayer((polygon) => {
      if (polygon.getLatLngs) {
        originalLayers.push(polygon);
      }
    });

    originalLayers.forEach((polygon) => {
      layer.removeLayer(polygon);
    });

    // Render merged geometry
    const geojsonLayer = L.geoJSON(merged, {
      coordsToLatLng: function (coords) {
        const x = coords[0];
        const y = coords[1];
        const pixelX = (x / WORLD_SIZE) * WORLD_SIZE;
        const pixelY = (y / WORLD_SIZE) * WORLD_SIZE;
        return map.unproject(L.point(pixelX, pixelY), config.tileMaxZoom);
      },
      style: {
        color: catConfig.strokeColor,
        weight: catConfig.strokeWeight,
        opacity: catConfig.strokeOpacity,
        fill: true,
        fillColor: catConfig.fillColor,
        fillOpacity: catConfig.fillOpacity,
      },
    });

    geojsonLayer.eachLayer((l) => layer.addLayer(l));
    console.log("Boolean union rendering complete");
  }

  // Start processing
  processPhase();
}

// Boolean union rendering: Merge all overlapping polygons in a layer to create unified boundary
// This creates a single clean stroke around the entire merged geometry
function applyBooleanUnionRendering(layer, catConfig) {
  const polygons = [];

  // Collect all polygon coordinates from the layer
  layer.eachLayer((polygon) => {
    if (polygon.getLatLngs && polygon.getLatLngs()[0]) {
      const latlngs = polygon.getLatLngs()[0];
      if (latlngs.length >= 3) {
        // Convert Leaflet LatLng to GeoJSON coordinates [lng, lat]
        const coords = latlngs.map((ll) => [ll.lng, ll.lat]);
        // Close the ring
        if (
          coords[0][0] !== coords[coords.length - 1][0] ||
          coords[0][1] !== coords[coords.length - 1][1]
        ) {
          coords.push(coords[0]);
        }

        polygons.push({
          type: "Polygon",
          coordinates: [coords],
        });
      }
    }
  });

  console.log(`Boolean union: starting with ${polygons.length} polygons`);

  if (polygons.length === 0) {
    console.warn("No valid polygons found for boolean union");
    return;
  }

  if (polygons.length === 1) {
    console.log("Only 1 polygon, skipping union");
    return;
  }

  // Find and remove small intersection zones (artifacts from overlapping road segments)
  // These are the transition segments that create visual artifacts
  console.log("Finding intersection zones...");
  const intersectionPolygons = [];

  for (let i = 0; i < polygons.length; i++) {
    for (let j = i + 1; j < polygons.length; j++) {
      try {
        const poly1 = turf.feature(polygons[i]);
        const poly2 = turf.feature(polygons[j]);
        const intersection = turf.intersect(poly1, poly2);

        if (intersection && intersection.geometry) {
          // Calculate perimeter to filter out small intersections
          const perimeter = calculatePerimeter(
            intersection.geometry.coordinates
          );

          // Keep intersections with perimeter > 5 meters (0.00005 degrees)
          if (perimeter > 0.00005) {
            intersectionPolygons.push(intersection);
          }
        }
      } catch (e) {
        // Ignore intersection errors
      }
    }
  }

  console.log(
    `Found ${intersectionPolygons.length} significant intersection zones`
  );

  // Remove the small intersections from original polygons by splitting them
  // (This is complex, so we'll handle it by just proceeding with union - the erosion will remove them)

  try {
    // Buffer polygons to merge nearby ones (distance in degrees, ~0.0005 ≈ 50 meters at equator)
    const bufferDistance = 0.0005;
    console.log(
      `Buffering polygons by ${bufferDistance} degrees to merge nearby segments...`
    );

    let bufferedPolygons = [];
    for (let i = 0; i < polygons.length; i++) {
      try {
        const buffered = turf.buffer(
          turf.feature(polygons[i]),
          bufferDistance,
          { units: "degrees" }
        );
        if (buffered && buffered.geometry) {
          bufferedPolygons.push(buffered);
        }
      } catch (e) {
        // If buffer fails, use original polygon
        bufferedPolygons.push(turf.feature(polygons[i]));
      }
    }

    // Perform boolean union on buffered polygons
    let merged = bufferedPolygons[0];

    for (let i = 1; i < bufferedPolygons.length; i++) {
      merged = turf.union(merged, bufferedPolygons[i]);

      if (i % 10 === 0) {
        console.log(`  Merged ${i}/${bufferedPolygons.length} polygons`);
      }
    }

    console.log(
      `Boolean union complete, merged geometry type: ${merged.geometry.type}`
    );

    // Lightly simplify to remove noise but preserve important corners
    // Must use high tolerance to avoid destroying right angles
    console.log("Simplifying geometry...");
    merged = turf.simplify(merged, { tolerance: 0.00001, highQuality: true });

    // Aggressively remove thin slivers and transition segments by eroding then dilating
    // This eliminates small protrusions where overlapping road segments meet at angles
    console.log(
      "Removing small transition segments with aggressive erosion/dilation..."
    );
    const erosionBuffer = -0.0005; // Shrink by ~50 meters (aggressive)
    const dilationBuffer = 0.0005; // Expand back by ~50 meters

    try {
      let cleaned = merged;

      // Erode (shrink inward) - removes small protrusions and transition zones
      if (cleaned.geometry.type === "Polygon") {
        cleaned = turf.buffer(cleaned, erosionBuffer, { units: "degrees" });
      } else if (cleaned.geometry.type === "MultiPolygon") {
        // For MultiPolygon, apply buffer to the entire feature (will merge or keep separate)
        // Turf's buffer can convert MultiPolygon to Polygon if buffers overlap
        console.log(
          `MultiPolygon detected with ${cleaned.geometry.coordinates.length} sub-polygons`
        );
        cleaned = turf.buffer(cleaned, erosionBuffer, { units: "degrees" });
      }

      // Dilate (expand back outward) - restores size while keeping smooth curves
      if (cleaned && cleaned.geometry) {
        cleaned = turf.buffer(cleaned, dilationBuffer, { units: "degrees" });
        merged = cleaned;
        console.log(
          `Erosion/dilation complete - result type: ${merged.geometry.type}`
        );
      }
    } catch (e) {
      console.warn("Erosion/dilation failed, using original geometry:", e);
    }

    // Remove original polygons from layer (hide them)
    const originalLayers = [];
    layer.eachLayer((polygon) => {
      if (polygon.getLatLngs) {
        originalLayers.push(polygon);
      }
    });

    originalLayers.forEach((poly) => layer.removeLayer(poly));
    console.log(
      `Removed ${originalLayers.length} original polygons from layer`
    );

    // Add the merged polygon(s) with stroke AND fill
    if (merged.geometry.type === "Polygon") {
      // Single polygon - may have holes
      addMergedPolygonToLayer(merged.geometry.coordinates, catConfig, layer);
    } else if (merged.geometry.type === "MultiPolygon") {
      // Multiple disconnected polygons from union
      merged.geometry.coordinates.forEach((ringArray) => {
        addMergedPolygonToLayer(ringArray, catConfig, layer);
      });
    }

    console.log("Boolean union rendering complete");
  } catch (e) {
    console.error("Error during boolean union:", e);
  }
}

// Helper: Add a merged polygon to the layer with smoothing
function addMergedPolygonToLayer(ringArray, catConfig, layer) {
  // ringArray[0] is outer ring, ringArray[1+] are holes

  // Round corners on outer ring for a polished look
  const outerRing = ringArray[0];
  const roundedOuter = roundCorners(outerRing, 0.00008); // ~8 meter radius
  const outerLatlngs = roundedOuter.map(([lng, lat]) => L.latLng(lat, lng));

  // Convert holes (if any) and smooth them AGGRESSIVELY to make roundabouts circular
  const holes = [];
  for (let i = 1; i < ringArray.length; i++) {
    const holeCoords = ringArray[i];
    // Aggressively smooth holes (roundabouts) - smooth ALL corners
    const smoothedHole = smoothPolygonEdges(holeCoords, 0.8, true);
    const holeLatlngs = smoothedHole.map(([lng, lat]) => L.latLng(lat, lng));
    holes.push(holeLatlngs);
  }

  // Create the merged polygon with both stroke and fill
  const mergedPoly = L.polygon(
    holes.length > 0 ? [outerLatlngs, ...holes] : outerLatlngs,
    {
      color: catConfig.strokeColor,
      weight: catConfig.strokeWeight,
      opacity: catConfig.strokeOpacity,
      fill: true,
      fillColor: catConfig.fillColor,
      fillOpacity: catConfig.fillOpacity,
      smooth: false, // Disable path smoothing to preserve all vertices
      interactive: false,
    }
  );

  mergedPoly.addTo(layer);
  console.log(`Added merged polygon with ${holes.length} holes to layer`);
}

// Calculate perpendicular distance from point to line
function pointToLineDistance(point, lineStart, lineEnd) {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  const numerator = Math.abs(
    dy * point[0] -
      dx * point[1] +
      lineEnd[0] * lineStart[1] -
      lineEnd[1] * lineStart[0]
  );
  const denominator = Math.sqrt(dx * dx + dy * dy);

  if (denominator === 0) return 0;
  return numerator / denominator;
}

// Calculate perimeter of a polygon (in degrees)
function calculatePerimeter(coordinates) {
  let perimeter = 0;
  const ring = coordinates[0]; // Use outer ring

  if (!ring || ring.length < 2) return 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    perimeter += Math.sqrt(dx * dx + dy * dy);
  }

  return perimeter;
}

// Round all corners of a polygon with a circular arc of given radius
function roundCorners(coords, cornerRadius = 0.00008) {
  if (coords.length < 4) return coords; // Need at least 3 unique points

  const rounded = [];
  const n = coords.length - 1; // Last point is duplicate of first

  for (let i = 0; i < n; i++) {
    const prev = coords[(i - 1 + n) % n];
    const curr = coords[i];
    const next = coords[(i + 1) % n];

    // Create vectors from current point
    const v1x = prev[0] - curr[0];
    const v1y = prev[1] - curr[1];
    const v2x = next[0] - curr[0];
    const v2y = next[1] - curr[1];

    // Normalize vectors
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);

    if (len1 === 0 || len2 === 0) {
      rounded.push(curr);
      continue;
    }

    const u1x = v1x / len1;
    const u1y = v1y / len1;
    const u2x = v2x / len2;
    const u2y = v2y / len2;

    // Calculate angle between vectors
    const dotProduct = u1x * u2x + u1y * u2y;
    const angle = Math.acos(Math.max(-1, Math.min(1, dotProduct)));

    // Distance along each edge to the corner rounding start point
    const dist = cornerRadius / Math.tan(angle / 2);

    // Skip if distance is too large
    if (dist > Math.min(len1, len2)) {
      rounded.push(curr);
      continue;
    }

    // Points where the arc starts and ends
    const startx = curr[0] + u1x * dist;
    const starty = curr[1] + u1y * dist;
    const endx = curr[0] + u2x * dist;
    const endy = curr[1] + u2y * dist;

    // Add start of arc
    rounded.push([startx, starty]);

    // Create circular arc using multiple points
    const steps = Math.max(3, Math.ceil(Math.abs(angle) / 0.1)); // ~0.1 radian steps

    for (let step = 1; step < steps; step++) {
      const t = step / steps;
      const theta = (1 - t) * angle;

      // Rotate u1 towards u2 by theta
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);
      const ux = u1x * cosTheta - u1y * sinTheta;
      const uy = u1x * sinTheta + u1y * cosTheta;

      // Point on arc
      const arcx = curr[0] + ux * dist;
      const arcy = curr[1] + uy * dist;
      rounded.push([arcx, arcy]);
    }

    // Add end of arc
    rounded.push([endx, endy]);
  }

  // Close the ring
  rounded.push(rounded[0]);
  return rounded;
}

// Smooth polygon edges using Catmull-Rom spline interpolation
// aggressive=false: Only smooths CONVEX (outside) corners, preserves sharp concave (inside) corners
// aggressive=true: Smooths ALL corners (for holes/roundabouts to make them circular)
function smoothPolygonEdges(coords, tension = 0.5, aggressive = false) {
  if (coords.length < 4) {
    return coords; // Can't smooth with fewer than 4 points
  }

  const smoothed = [];
  const n = coords.length - 1; // Last point is duplicate of first

  for (let i = 0; i < n; i++) {
    // Get 4 points for interpolation (wrapping around for circular array)
    const p0 = coords[(i - 1 + n) % n];
    const p1 = coords[i];
    const p2 = coords[(i + 1) % n];
    const p3 = coords[(i + 2) % n];

    let shouldSmooth = false;

    if (aggressive) {
      // For holes (roundabouts), smooth ALL corners to make them circular
      shouldSmooth = true;
    } else {
      // For outer boundary, only smooth CONVEX corners
      // Use cross product to determine: positive = convex, negative = concave
      const v1x = p1[0] - p0[0];
      const v1y = p1[1] - p0[1];
      const v2x = p2[0] - p1[0];
      const v2y = p2[1] - p1[1];
      const crossProduct = v1x * v2y - v1y * v2x;

      shouldSmooth = crossProduct > 0; // Assuming CCW winding
    }

    // Generate smooth interpolation where appropriate
    if (shouldSmooth) {
      // Generate intermediate points using Catmull-Rom formula
      // Use finer steps (0.2) for better quality, especially on holes
      const stepSize = aggressive ? 0.15 : 0.3;
      for (let t = 0; t < 1; t += stepSize) {
        const t2 = t * t;
        const t3 = t2 * t;

        const v0 = (p2[0] - p0[0]) * tension;
        const v1 = (p3[0] - p1[0]) * tension;
        const x =
          p1[0] +
          v0 * t +
          (3 * (p2[0] - p1[0]) - 2 * v0 - v1) * t2 +
          (2 * (p1[0] - p2[0]) + v0 + v1) * t3;

        const v0y = (p2[1] - p0[1]) * tension;
        const v1y = (p3[1] - p1[1]) * tension;
        const y =
          p1[1] +
          v0y * t +
          (3 * (p2[1] - p1[1]) - 2 * v0y - v1y) * t2 +
          (2 * (p1[1] - p2[1]) + v0y + v1y) * t3;

        smoothed.push([x, y]);
      }
    }

    // Always add the current point (either at end of smooth segment or sharp corner)
    smoothed.push(p2);
  }

  // Close the ring
  smoothed.push(smoothed[0]);
  return smoothed;
}

// Status display
function setStatus(message, type = "normal") {
  const statusElement = document.getElementById("status");
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.classList.remove("loading", "error");
    if (type === "loading") statusElement.classList.add("loading");
    if (type === "error") statusElement.classList.add("error");
  }
}

// GeoJSON loading
function loadGeoJSON(url) {
  setStatus("Loading topographic data...", "loading");
  return fetch(url, { cache: "no-store" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((geojson) => {
      if (!geojson.features || !Array.isArray(geojson.features)) {
        throw new Error("Invalid GeoJSON: missing features array");
      }
      return geojson;
    })
    .catch((err) => {
      setStatus(`Error loading topographic data: ${err.message}`, "error");
      throw err;
    });
}

// Update all layers when zoom changes
function updateLayerStrokesOnZoom() {
  Object.entries(categoryLayers).forEach(([categoryName, layer]) => {
    if (!layer) return;
    const catConfig = mapStyles.categories[categoryName];
    if (!catConfig) return;

    layer.eachLayer((polygon) => {
      const scaledWeight = calculateScaledStrokeWeight(catConfig.strokeWeight);
      polygon.setStyle({ weight: scaledWeight });
    });
  });
}

// Display topographic map
// waterElevCutoff: elevation below which a contour band renders as water.
// Maps don't share a common elevation datum - Chernarus/Sakhal use real sea
// level (0), but Livonia's heightmap never dips below +146, so it needs its
// own cutoff (170, confirmed against the actual coastline/river shape in
// the data - see tools/map-config.js, the Node-side equivalent of this).
//
// colorOverrides: optional per-map tint (landColor/waterColor/landDarkColor/
// waterDarkColor) - e.g. Sakhal's arctic land gets a slightly icier blue
// cast, Livonia's a slightly greener one - falls back to the shared
// mapStyles.topographic palette for whatever isn't overridden.
function displayTopographic(geojson, waterElevCutoff = 0, colorOverrides = {}) {
  // Remove existing topo layer if present
  if (topoLayer) {
    map.removeLayer(topoLayer);
    topoLayer = null;
  }

  topoLayer = L.featureGroup();

  // Sort features by elevation (ascending) so we draw lower elevations first
  const sortedFeatures = [...geojson.features].sort(
    (a, b) => (a?.properties?.elev || 0) - (b?.properties?.elev || 0)
  );

  for (const feature of sortedFeatures) {
    const elevation =
      feature?.properties?.elev || feature?.properties?.elevation || 0;
    const isWater = elevation < waterElevCutoff;

    const topoStyles = mapStyles?.topographic || {};
    const colorPalette = config?.colors?.[config.darkMode ? "dark" : "light"] || {};
    let color, fillColor;
    if (isWater) {
      fillColor = config.darkMode
        ? colorOverrides.waterDarkColor || topoStyles.waterDarkColor || colorPalette.waterFill
        : colorOverrides.waterColor || topoStyles.waterColor || colorPalette.waterFill;
      color = topoStyles.waterStroke || colorPalette.waterStroke;
    } else {
      fillColor = config.darkMode
        ? colorOverrides.landDarkColor || topoStyles.landDarkColor || colorPalette.landFill
        : colorOverrides.landColor || topoStyles.landColor || colorPalette.landFill;
      color = topoStyles.landStroke || colorPalette.landStroke;
    }

    const polygon = L.geoJSON(feature, {
      coordsToLatLng: function (coords) {
        const x = coords[0];
        const z = coords[1];
        const pixelX = (x / config.mapSize) * WORLD_SIZE;
        const pixelY = (z / config.mapSize) * WORLD_SIZE;
        return map.unproject(L.point(pixelX, pixelY), config.tileMaxZoom);
      },
      style: {
        color: color,
        weight: 0.5,
        opacity: 1.0,
        fill: true,
        fillColor: fillColor,
        fillOpacity: 1.0,
      },
      onEachFeature: function (feature, layer) {
        const allowPopup =
          (mapStyles?.topographic?.popupEnabled ??
            mapStyles?.popupEnabled) === true;
        if (allowPopup) {
          layer.bindPopup(`Elevation: ${elevation}m`);
        }
      },
    });

    polygon.eachLayer((layer) => topoLayer.addLayer(layer));
  }

  topoLayer.addTo(map);
  const topoBounds = topoLayer.getBounds();
  if (topoBounds && topoBounds.isValid()) {
    map.fitBounds(topoBounds, { padding: [20, 20] });
  }
  setStatus(`Topographic mode loaded: ${geojson.features.length} zones`);
}

// CSV parsing
function parseCSV(text) {
  const lines = text.split("\n");
  const header = lines[0].split(";").map((h) => h.trim().replace(/"/g, ""));
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(";").map((p) => p.trim().replace(/"/g, ""));
    const row = {};
    header.forEach((h, idx) => {
      const val = parts[idx];
      row[h] = isNaN(val) ? val : parseFloat(val);
    });
    data.push(row);
  }

  return data;
}

// Area utilities
function updateAreaDisplay() {
  const halfSize = areaSelection.size / 2;
  const minX = areaSelection.centerX - halfSize;
  const maxX = areaSelection.centerX + halfSize;
  const minZ = areaSelection.centerZ - halfSize;
  const maxZ = areaSelection.centerZ + halfSize;
  const areaDisplay = document.getElementById("areaDisplay");
  if (areaDisplay) {
    areaDisplay.textContent = `X: ${minX.toFixed(0)}-${maxX.toFixed(
      0
    )} | Z: ${minZ.toFixed(0)}-${maxZ.toFixed(0)}`;
  }
}

function isInArea(x, z) {
  const halfSize = areaSelection.size / 2;
  return (
    Math.abs(x - areaSelection.centerX) <= halfSize &&
    Math.abs(z - areaSelection.centerZ) <= halfSize
  );
}

// Initialize category toggles UI
function initializeCategoryToggles() {
  console.log("[TOGGLES] Function called");
  console.log("[TOGGLES] window.categories =", window.categories);
  
  const container = document.getElementById("categoryToggles");
  console.log("[TOGGLES] container found?", !!container);
  
  if (!container) {
    console.warn("[TOGGLES] ERROR: Container #categoryToggles not found");
    return;
  }

  // Check if categories array exists (from map-styles.js)
  const cats = window.categories;
  console.log("[TOGGLES] cats =", cats);
  
  if (typeof cats === "undefined" || !Array.isArray(cats)) {
    console.warn("[TOGGLES] ERROR: Categories array not defined or not an array. Type:", typeof cats);
    // Try fallback - maybe it wasn't set up yet
    if (typeof mapStyles !== "undefined" && mapStyles.categories) {
      console.log("[TOGGLES] FALLBACK: Building categories from mapStyles.categories");
      window.categories = Object.entries(mapStyles.categories).map(([key, val]) => ({
        name: key,
        label: val.label,
        color: val.fillColor,
        file: val.file,
      }));
      return initializeCategoryToggles(); // Retry with rebuilt array
    }
    return;
  }

  console.log(`[TOGGLES] Initializing ${cats.length} category toggles`);
  container.innerHTML = "";

  cats.forEach((cat, idx) => {
    console.log(`[TOGGLES] Creating toggle for: ${cat.name} (${idx + 1}/${cats.length})`);
    
    const div = document.createElement("div");
    div.className = "checkbox-group";
    div.style.paddingLeft = "6px";
    div.style.marginBottom = "4px";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `cat-${cat.name}`;
    checkbox.checked = false;

    const label = document.createElement("label");
    label.htmlFor = `cat-${cat.name}`;
    label.style.flex = "1";

    const colorDot = document.createElement("span");
    colorDot.style.display = "inline-block";
    colorDot.style.width = "10px";
    colorDot.style.height = "10px";
    colorDot.style.backgroundColor = cat.color;
    colorDot.style.borderRadius = "2px";
    colorDot.style.marginRight = "6px";
    colorDot.style.verticalAlign = "middle";

    label.appendChild(colorDot);
    label.appendChild(document.createTextNode(cat.label));

    checkbox.addEventListener("change", async (e) => {
      if (e.target.checked) {
        await loadCategory(cat.name);
      } else {
        clearCategory(cat.name);
      }
    });

    div.appendChild(checkbox);
    div.appendChild(label);
    container.appendChild(div);
  });

  console.log(`[TOGGLES] Successfully created ${container.children.length} toggle elements`);
}

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

// Load a single category
async function loadCategory(categoryName) {
  const catConfig = mapStyles.categories[categoryName];
  if (!catConfig) return;

  try {
    setStatus(`Loading ${catConfig.label}...`, "loading");

    // Fast-path: try to load prebuilt geometry for ANY category
    const prebuilt = await (window.loadPrebuiltCategory
      ? window.loadPrebuiltCategory(categoryName)
      : null);
    if (prebuilt && prebuilt.features && prebuilt.features.length > 0) {
      if (categoryLayers[categoryName]) {
        map.removeLayer(categoryLayers[categoryName]);
      }
      const layer = L.featureGroup();
      const added = window.addPrebuiltCategory
        ? window.addPrebuiltCategory(layer, catConfig, categoryName)
        : 0;
      layer.addTo(map);
      categoryLayers[categoryName] = layer;
      if (mapStyles.drawingOrder && Array.isArray(mapStyles.drawingOrder)) {
        reorderLayersOnMap();
      }
      setStatus(
        `Loaded ${catConfig.label}: ${added} prebuilt polygons (fast path)`
      );
      return; // Successfully loaded from prebuilt, exit
    }
    // Prebuilt file not found, continue with normal CSV processing below
    console.log(
      `[Prebuilt] No prebuilt file for ${categoryName}, falling back to CSV processing`
    );

    const response = await fetch(`./data/TBData/Chernarus/categorized/${catConfig.file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const csvText = await response.text();
    const csvData = parseCSV(csvText);

    if (categoryLayers[categoryName]) {
      map.removeLayer(categoryLayers[categoryName]);
    }

    const layer = L.featureGroup();

    // Filter objects within the selected area
    const objectsInArea = csvData.filter((item) => {
      const x = parseFloat(item.Local_X || item.x || 0);
      const z = parseFloat(item.Local_Z || item.z || 0);
      return isInArea(x, z);
    });

    console.log(
      `${categoryName}: Found ${objectsInArea.length} objects in area (out of ${csvData.length} total)`
    );

    // Load bbox cache for rectangle drawing
    let bboxCache = {};
    try {
      const bboxResponse = await fetch("./out/bboxCache.rectangles.json");
      if (bboxResponse.ok) {
        bboxCache = await bboxResponse.json();
        console.log(
          `Loaded ${
            Object.keys(bboxCache).length
          } bbox entries for ${categoryName}`
        );
      }
    } catch (e) {
      console.warn("Could not load bbox cache for category:", categoryName, e);
    }

    let addedCount = 0;
    let fallbackCount = 0;

    for (let i = 0; i < objectsInArea.length; i++) {
      const item = objectsInArea[i];
      if (!item || (!item.name && !item.Name)) continue;

      // Handle both lowercase (x, z) and capitalized (Local_X, Local_Z) column names
      const x =
        typeof (item.x || item.Local_X) === "string"
          ? parseFloat(item.x || item.Local_X)
          : item.x || item.Local_X;
      const z =
        typeof (item.z || item.Local_Z) === "string"
          ? parseFloat(item.z || item.Local_Z)
          : item.z || item.Local_Z;
      const yaw =
        item.yaw || item.Yaw
          ? typeof (item.yaw || item.Yaw) === "string"
            ? parseFloat(item.yaw || item.Yaw)
            : item.yaw || item.Yaw
          : 0;
      const name = item.name || item.Name;

      if (!x || !z || isNaN(x) || isNaN(z)) continue;

      // Try to find bbox
      let bbox = bboxCache[name];

      // If not found, try variations
      if (!bbox && name) {
        const nameLower = name.toLowerCase();
        bbox = bboxCache[nameLower];

        if (!bbox) {
          const nameWithoutNum = name.replace(/_\d+$/, "");
          bbox = bboxCache[nameWithoutNum];
        }

        if (!bbox && name.includes("-")) {
          bbox = bboxCache[name.replace(/-/g, "_")];
        }
        if (!bbox && name.includes("_")) {
          bbox = bboxCache[name.replace(/_/g, "-")];
        }
      }

      if (catConfig.drawType === "rectangle") {
        // Draw as rotated rectangle with bbox
        if (bbox) {
          // Extract bbox dimensions first
          const [sizeX, sizeY, sizeZ] = bbox.size;

          // Debug: log power line names
          if (name && name.includes("power")) {
            console.log(`Power line object: "${name}"`);
          }

          // Check for custom drawer first
          let customResult = getCustomObjectCorners(
            name,
            x,
            z,
            yaw,
            bbox,
            catConfig,
            bboxCache
          );
          let corners = null;
          let usedCustomDrawer = false;

          if (customResult) {
            corners = customResult;
            usedCustomDrawer = true;
          } else if (name && /asf[123]_[1-9]|asf[123]_\d{2}/.test(name)) {
            // Curve object but custom drawer returned null - debug
            console.warn(
              `[CURVE] Custom drawer returned null for curve object: ${name}`,
              { bbox: bbox?.size }
            );
          }

          // Fall back to default rectangle if no custom drawer
          if (!corners) {
            // Apply size scaling if configured for this category
            const scale = catConfig.sizeScale || 1.0;
            let scaledSizeX = sizeX * scale;
            let scaledSizeZ = sizeZ * scale;

            // For walls and similar linear structures, enforce minimum width
            if (categoryName === "walls" || categoryName === "barriers") {
              const minWidth = 2.0; // Minimum wall width in local units
              if (scaledSizeZ < minWidth) {
                scaledSizeZ = minWidth;
              }
              if (scaledSizeX < minWidth) {
                scaledSizeX = minWidth;
              }
            }

            const halfX = scaledSizeX / 2;
            const halfZ = scaledSizeZ / 2;

            corners = [
              [x - halfX, z - halfZ],
              [x + halfX, z - halfZ],
              [x + halfX, z + halfZ],
              [x - halfX, z + halfZ],
            ];
          }

          // Preserve any metadata attached by custom drawers
          const cornerMeta = {
            rotationCenter: corners._rotationCenter,
            alreadyRotated: corners._alreadyRotated,
          };

          // Snap all corners to grid for vertex alignment (skip if custom drawer opts out)
          if (!corners._noSnap) {
            const gridSize = 0.5;
            corners = corners.map(([cx, cz]) => [
              Math.round(cx / gridSize) * gridSize,
              Math.round(cz / gridSize) * gridSize,
            ]);
          }
          corners._rotationCenter = cornerMeta.rotationCenter;
          corners._alreadyRotated = cornerMeta.alreadyRotated;

          const rotationCenter = corners._rotationCenter || [x, z];
          const extraYaw = corners._extraYawDeg || 0;
          const rotationRad = (-(yaw + extraYaw) * Math.PI) / 180;
          let rotatedCorners =
            (yaw !== 0 || extraYaw !== 0) && !corners._alreadyRotated
              ? corners.map(([cx, cz]) => {
                  const dx = cx - rotationCenter[0];
                  const dz = cz - rotationCenter[1];
                  const rotX =
                    dx * Math.cos(rotationRad) - dz * Math.sin(rotationRad);
                  const rotZ =
                    dx * Math.sin(rotationRad) + dz * Math.cos(rotationRad);
                  return [rotationCenter[0] + rotX, rotationCenter[1] + rotZ];
                })
              : corners;

          // For curves, final-align the rotated polygon center to the original object center
          if (corners._isCurve) {
            const bounds = computeBoundsFromCorners(rotatedCorners);
            if (bounds) {
              const cx = (bounds.minX + bounds.maxX) / 2;
              const cz = (bounds.minZ + bounds.maxZ) / 2;
              const dx = x - cx;
              const dz = z - cz;
              rotatedCorners = rotatedCorners.map(([px, pz]) => [
                px + dx,
                pz + dz,
              ]);
            }
          }

          // Debug log for curve polygons (limited)
          if (corners._isCurve) {
            window._curveDebugCounter = (window._curveDebugCounter || 0) + 1;
            if (window._curveDebugCounter <= 15) {
              const beforeBounds = computeBoundsFromCorners(corners);
              const afterBounds = computeBoundsFromCorners(rotatedCorners);
              console.log("[CURVE DEBUG]", name, {
                yaw,
                rotationCenter,
                curveAngle: corners._curveAngle,
                curveCenter: corners._curveCenter,
                curveWidth: corners._curveWidth,
                curveLength: corners._curveLength,
                boundsBefore: beforeBounds,
                boundsAfter: afterBounds,
              });
            }
          }

          const leafletCorners = rotatedCorners.map(([cx, cz]) => {
            const px = (cx / config.mapSize) * WORLD_SIZE;
            const pz = (cz / config.mapSize) * WORLD_SIZE;
            const py = WORLD_SIZE - pz;
            return map.unproject(L.point(px, py), config.tileMaxZoom);
          });

          const polygon = L.polygon(leafletCorners, {
            color:
              catConfig.strokeOpacity === 0
                ? "transparent"
                : catConfig.strokeColor,
            weight: catConfig.strokeWeight,
            opacity: catConfig.strokeOpacity,
            fill: true,
            fillColor: catConfig.fillColor,
            fillOpacity: catConfig.fillOpacity,
            smooth: false, // Disable path smoothing to preserve all vertices
          });

          // Store bbox info for updating size on zoom
          polygon._bboxData = { x, z, sizeX, sizeZ, yaw };
          polygon._catConfig = catConfig;
          polygon._rotatedCorners = rotatedCorners;
          polygon._customDrawer = usedCustomDrawer; // Mark if from custom drawer
          polygon._objectName = name;
          polygon._roadCategory = categoryName;

          // Mark intersection segments (kr_X, kr_t) with the prefix they belong to
          if (name && name.includes("kr_")) {
            polygon._isIntersection = true;
            polygon._intersectionPrefix = getIntersectionRoadPrefix(name);
          }

          if ((catConfig.popupEnabled ?? mapStyles?.popupEnabled) === true) {
            polygon.bindPopup(
              `<strong>${name}</strong><br/>Category: ${catConfig.label}`
            );
          }
          layer.addLayer(polygon);
          addedCount++;
        } else {
          // Fallback to circle if bbox not found
          fallbackCount++;
          const px = (x / config.mapSize) * WORLD_SIZE;
          const pz = (z / config.mapSize) * WORLD_SIZE;
          const py = WORLD_SIZE - pz;
          const latlng = map.unproject(L.point(px, py), config.tileMaxZoom);

          const marker = L.circleMarker(latlng, {
            radius: 3,
            fillColor: catConfig.fillColor,
            color: catConfig.strokeColor,
            weight: catConfig.strokeWeight,
            opacity: catConfig.strokeOpacity,
            fillOpacity: catConfig.fillOpacity,
          });

          if ((catConfig.popupEnabled ?? mapStyles?.popupEnabled) === true) {
            marker.bindPopup(
              `<strong>${name}</strong><br/>Category: ${catConfig.label}`
            );
          }
          layer.addLayer(marker);
          addedCount++;
        }
      } else {
        // Draw as circle polygon based on bbox
        const px = (x / config.mapSize) * WORLD_SIZE;
        const pz = (z / config.mapSize) * WORLD_SIZE;
        const py = WORLD_SIZE - pz;
        const latlng = map.unproject(L.point(px, py), config.tileMaxZoom);

        // Use smallest bbox dimension as radius
        let radiusLocalUnits = 5; // fallback in local units
        if (bbox && bbox.size) {
          const [sizeX, sizeY, sizeZ] = bbox.size;
          const smallerDim = Math.min(sizeX, sizeZ);
          radiusLocalUnits = smallerDim / 2; // half of smallest dimension
        }

        const circlePoints = createCirclePolygon(x, z, radiusLocalUnits);
        const polygon = L.polygon(circlePoints, {
          color:
            catConfig.strokeOpacity === 0
              ? "transparent"
              : catConfig.strokeColor,
          weight: catConfig.strokeWeight,
          opacity: catConfig.strokeOpacity,
          fill: true,
          fillColor: catConfig.fillColor,
          fillOpacity: catConfig.fillOpacity,
          smooth: false, // Disable path smoothing to preserve all vertices
        });

        if ((catConfig.popupEnabled ?? mapStyles?.popupEnabled) === true) {
          polygon.bindPopup(
            `<strong>${name}</strong><br/>Category: ${catConfig.label}`
          );
        }
        layer.addLayer(polygon);
        addedCount++;
      }
    }

    // Setup zoom handler for rectangle resizing
    const updateRectangleSizes = () => {
      layer.eachLayer((polygon) => {
        if (polygon._bboxData && polygon._rotatedCorners) {
          const leafletCorners = polygon._rotatedCorners.map(([cx, cz]) => {
            const px = (cx / config.mapSize) * WORLD_SIZE;
            const pz = (cz / config.mapSize) * WORLD_SIZE;
            const py = WORLD_SIZE - pz;
            return map.unproject(L.point(px, py), config.tileMaxZoom);
          });
          polygon.setLatLngs(leafletCorners);
        }
      });
    };

    if (catConfig.drawType === "rectangle") {
      map.on("zoom", updateRectangleSizes);
      layer._zoomHandler = updateRectangleSizes;
    }

    // Apply boolean union + cleanup/smoothing for road variants to remove tiny gaps/overlaps
    console.log(`Loaded ${addedCount} objects for category: ${categoryName}`);
    if (categoryName.includes("roads")) {
      setTimeout(() => {
        const roadPrefixes = ["asf1", "asf2", "asf3", "city", "grav", "mud"];
        // First enforce uniform width across all road segments
        enforceUniformWidth(layer, roadPrefixes, catConfig);
        // Then apply union
        applyUnionForRoadPrefixesV3(layer, catConfig, roadPrefixes, 0.5);
        // After union, add overlap masks across categories/prefixes to hide strokes only where different types overlap
        //  applyOverlapMaskForRoads(layer, catConfig, roadPrefixes);
        // Apply stroke masking at intersections between different road prefixes
        // applyIntersectionStrokeMasking(layer, catConfig, roadPrefixes);
        // applyOverlapMaskForRoadCategories(
        //   layer,
        //   catConfig,
        //   categoryName,
        //   categoryLayers,
        //   ["asf_roads", "city_roads", "mud_roads", "grav_roads"]
        // );
        // Reorder road layers according to drawing priority
        reorderRoadLayers();
      }, 50);
    } else if (categoryName === "paths") {
      setTimeout(() => {
        const pathPrefixes = ["path_dirt"];
        enforceUniformWidth(layer, pathPrefixes, catConfig);
        const smallFeatureThreshold =
          catConfig.unionSmallFeatureThreshold || 0.3;
        const smoothingLevel = catConfig.unionSmoothingLevel || 0.5;
        applyUnionForRoadPrefixesV3(
          layer,
          catConfig,
          pathPrefixes,
          smoothingLevel,
          smallFeatureThreshold
        );
        // applyIntersectionStrokeMasking(layer, catConfig, pathPrefixes);
      }, 50);
    } else if (categoryName === "sidewalks") {
      setTimeout(() => {
        console.log(
          `[SIDEWALK UNION] Starting union for sidewalks, layer has ${
            layer._layers ? Object.keys(layer._layers).length : 0
          } features`
        );
        const sidewalkPrefixes = ["sidewalk"];
        const smallFeatureThreshold = catConfig.unionSmallFeatureThreshold || 1;
        const smoothingLevel = catConfig.unionSmoothingLevel || 0;
        applyUnionForRoadPrefixesV3(
          layer,
          catConfig,
          sidewalkPrefixes,
          smoothingLevel,
          smallFeatureThreshold
        );
        //applyIntersectionStrokeMasking(layer, catConfig, sidewalkPrefixes);
      }, 50);
    } else if (categoryName === "rail") {
      setTimeout(() => {
        const railPrefixes = ["rail", "mine"];
        // First enforce uniform width across all rail segments
        enforceUniformWidth(layer, railPrefixes, catConfig);
        // Then apply smart union (only merge on short sides)
        const smallFeatureThreshold =
          catConfig.unionSmallFeatureThreshold || 2.5;

        applyUnionForRoadPrefixesV3(
          layer,
          catConfig,
          railPrefixes,
          0.5,
          smallFeatureThreshold
        );

        // applySmartUnionForRails(
        //   layer,
        //   catConfig,
        //   railPrefixes,
        //   smallFeatureThreshold
        // );
      }, 50);
    } else if (categoryName === "walls") {
      setTimeout(() => {
        const wallPrefixes = ["wall", "busstation_wall"];
        // First enforce uniform width across all rail segments
        //enforceUniformWidth(layer, wallPrefixes, catConfig);
        // Then apply smart union (only merge on short sides)
        applyUnionForRoadPrefixesV3(layer, catConfig, wallPrefixes, 0.5);

        // applySmartUnionForRails(
        //   layer,
        //   catConfig,
        //   railPrefixes,
        //   smallFeatureThreshold
        // );
      }, 50);
    }

    // Add layer to map and store reference
    layer.addTo(map);
    categoryLayers[categoryName] = layer;

    // Align road vertices: curved to straight (anchor), curved to curved (average)
    // DISABLED - starting from scratch
    /*
    if (catConfig.drawType === 'rectangle') {
      console.log(`Aligning road vertices in ${categoryName}`);
      setTimeout(() => {
        alignRoadVertices(layer, 1.0);
      }, 100);
    }
    */

    // Apply boolean union rendering for line-type categories
    // Merges all overlapping segments into a single unified shape with clean outline
    // TEMPORARILY DISABLED - working on base polygon rendering
    /*
    const lineCategories = ['roads', 'sidewalks', 'paths', 'rail', 'walls'];
    if (lineCategories.includes(categoryName) && catConfig.drawType === 'rectangle') {
      console.log(`Applying boolean union to ${categoryName}`);
      // Use setTimeout to ensure all polygons are added and rendered first
      setTimeout(() => {
        applyBooleanUnionRendering(layer, catConfig);
      }, 100);
    }
    */

    // Re-order all visible layers according to drawingOrder config
    if (mapStyles.drawingOrder && Array.isArray(mapStyles.drawingOrder)) {
      reorderLayersOnMap();
    }

    if (catConfig.drawType === "rectangle" && fallbackCount > 0) {
      const rectanglesPercent = (
        ((addedCount - fallbackCount) / addedCount) *
        100
      ).toFixed(1);
      setStatus(
        `Loaded ${catConfig.label}: ${addedCount} objects (${rectanglesPercent}% rects)`
      );
    } else {
      setStatus(`Loaded ${catConfig.label}: ${addedCount} objects`);
    }
  } catch (err) {
    setStatus(`Error loading ${catConfig.label}: ${err.message}`, "error");
    console.error(err);
    const checkbox = document.getElementById(`cat-${categoryName}`);
    if (checkbox) checkbox.checked = false;
  }
}

// Clear a single category
function clearCategory(categoryName) {
  if (categoryLayers[categoryName]) {
    const layer = categoryLayers[categoryName];
    // Remove zoom handler if it exists
    if (layer._zoomHandler) {
      map.off("zoom", layer._zoomHandler);
    }
    map.removeLayer(layer);
    categoryLayers[categoryName] = null;

    // Reorder remaining visible layers if drawingOrder is configured
    if (mapStyles.drawingOrder && Array.isArray(mapStyles.drawingOrder)) {
      reorderLayersOnMap();
    }
  }
}

// Load all categories
async function loadAllCategories() {
  setStatus("Loading all categories...", "loading");
  for (const category of categories) {
    const checkbox = document.getElementById(`cat-${category.name}`);
    if (checkbox) checkbox.checked = true;
    await loadCategory(category.name);
  }
  setStatus("All categories loaded", "normal");
}

// Clear all categories
function clearAllCategories() {
  categories.forEach((cat) => {
    const checkbox = document.getElementById(`cat-${cat.name}`);
    if (checkbox) checkbox.checked = false;
    clearCategory(cat.name);
  });
  setStatus("All categories cleared", "normal");
}

// === Export Functions ===
// Collect all rendered polygons from map and convert to GeoJSON, grouped by category
function collectPolygonsByCategory() {
  const byCategory = {};

  // Iterate through all loaded categories
  Object.entries(categoryLayers).forEach(([categoryName, layer]) => {
    if (!layer) return;

    const catConfig = mapStyles.categories[categoryName];
    if (!catConfig) return;

    const features = [];
    let featureCount = 0;

    layer.eachLayer((polygon) => {
      if (!polygon.getLatLngs) return;

      const latlngs = polygon.getLatLngs();
      if (!latlngs || !latlngs.length) return;

      // Handle both simple rings and rings with holes
      let rings = Array.isArray(latlngs[0]) ? latlngs : [latlngs];

      // Always convert from current lat/lng rendering to local coordinates
      // This ensures we export exactly what's being displayed
      const coordinates = rings.map((ring) =>
        ring.map((ll) => {
          // Convert lat/lng back to local (x, z)
          const point = map.project(ll, config.tileMaxZoom);
          const localX = (point.x / WORLD_SIZE) * config.mapSize;
          const localZ = ((WORLD_SIZE - point.y) / WORLD_SIZE) * config.mapSize;
          return [localX, localZ];
        })
      );

      // Ensure the ring is closed
      coordinates.forEach((ring) => {
        if (ring.length > 0) {
          const first = ring[0];
          const last = ring[ring.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) {
            ring.push(first);
          }
        }
      });

      const feature = {
        type: "Feature",
        properties: {
          type: categoryName,
          objectName: polygon._objectName || "unknown",
          category: categoryName,
          categoryLabel: catConfig.label || categoryName,
          isUnion: polygon._objectName?.includes("_union") ? 1 : 0,
        },
        geometry: {
          type: "Polygon",
          coordinates: coordinates,
        },
      };

      features.push(feature);
      featureCount++;
    });

    if (features.length > 0) {
      byCategory[categoryName] = {
        type: "FeatureCollection",
        features: features,
        meta: {
          generatedAt: new Date().toISOString(),
          totalFeatures: featureCount,
          category: categoryName,
          categoryLabel: catConfig.label || categoryName,
        },
      };
    }
  });

  return byCategory;
}

// Export geometries as separate GeoJSON files per category
function exportGeometriesAsGeoJSON() {
  const byCategory = collectPolygonsByCategory();

  const categoryNames = Object.keys(byCategory);
  if (categoryNames.length === 0) {
    alert("No geometries loaded. Please load categories first.");
    setStatus("Export failed: No geometries loaded", "error");
    return;
  }

  let totalFeatures = 0;
  const dateStr = new Date().toISOString().slice(0, 10);

  // Export each category as a separate file
  categoryNames.forEach((categoryName) => {
    const geojson = byCategory[categoryName];
    totalFeatures += geojson.features.length;

    const jsonString = JSON.stringify(geojson, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${categoryName}-prebuilt.geojson`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    console.log(
      `Exported ${geojson.features.length} features for ${categoryName}`
    );
  });

  setStatus(
    `Exported ${totalFeatures} features across ${categoryNames.length} categories`,
    "normal"
  );
}

// Export roads as SVG file
function exportRoadsAsSVG() {
  const geojson = collectRoadPolygonsAsGeoJSON();

  if (geojson.features.length === 0) {
    alert("No roads loaded. Please load road categories first.");
    setStatus("Export failed: No roads loaded", "error");
    return;
  }

  // Calculate bounds from all features
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;

  geojson.features.forEach((feature) => {
    const geom = feature.geometry;
    const coords = geom.coordinates;

    // Handle both Polygon and MultiPolygon geometries
    const polygons = geom.type === "Polygon" ? [coords] : coords;

    polygons.forEach((polyCoords) => {
      // polyCoords is either a ring (array of [lng, lat]) or array of rings
      // polyCoords[0] is the outer ring
      if (Array.isArray(polyCoords) && Array.isArray(polyCoords[0])) {
        // It's an array of rings
        polyCoords.forEach((ring) => {
          ring.forEach(([lng, lat]) => {
            if (typeof lng === "number" && typeof lat === "number") {
              minLat = Math.min(minLat, lat);
              maxLat = Math.max(maxLat, lat);
              minLng = Math.min(minLng, lng);
              maxLng = Math.max(maxLng, lng);
            }
          });
        });
      }
    });
  });

  if (
    !isFinite(minLat) ||
    !isFinite(minLng) ||
    minLat === maxLat ||
    minLng === maxLng
  ) {
    alert("Could not determine bounds for SVG export");
    return;
  }

  // SVG dimensions
  const padding = 40;
  const svgWidth = 1200;
  const svgHeight = 1200;

  // Calculate scale to fit bounds
  const lngRange = maxLng - minLng;
  const latRange = maxLat - minLat;
  const scale = Math.min(
    (svgWidth - padding * 2) / lngRange,
    (svgHeight - padding * 2) / latRange
  );

  // Conversion functions
  const lngToSvgX = (lng) => (lng - minLng) * scale + padding;
  const latToSvgY = (lat) => (maxLat - lat) * scale + padding;

  // Build SVG
  let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .road { fill-opacity: 0.7; stroke-width: 1.5; }
      .asf_roads { fill: #cc6666; stroke: #990000; }
      .city_roads { fill: #ffcc99; stroke: #ff9900; }
      .mud_roads { fill: #cc9966; stroke: #996633; }
      .grav_roads { fill: #99cc99; stroke: #669900; }
    </style>
  </defs>
  <rect width="${svgWidth}" height="${svgHeight}" fill="white"/>
`;

  // Add road features
  geojson.features.forEach((feature) => {
    const category = feature.properties.category;
    const className = `road ${category}`;
    const coords = feature.geometry.coordinates;

    // Handle both Polygon and MultiPolygon
    const polygons = feature.geometry.type === "Polygon" ? [coords] : coords;

    polygons.forEach((polyCoords) => {
      // polyCoords[0] is outer ring, polyCoords[1+] are holes
      if (polyCoords && polyCoords[0]) {
        const outerRing = polyCoords[0];
        const holes = polyCoords.slice(1);

        // Build path data
        let pathData = "M ";
        outerRing.forEach(([lng, lat], idx) => {
          const x = lngToSvgX(lng);
          const y = latToSvgY(lat);
          pathData += `${x.toFixed(2)},${y.toFixed(2)} `;
        });
        pathData += "Z ";

        // Add holes
        holes.forEach((hole) => {
          pathData += " M ";
          hole.forEach(([lng, lat]) => {
            const x = lngToSvgX(lng);
            const y = latToSvgY(lat);
            pathData += `${x.toFixed(2)},${y.toFixed(2)} `;
          });
          pathData += "Z ";
        });

        svgContent += `  <path class="${className}" d="${pathData}" />\n`;
      }
    });
  });

  // Add bounds rectangle for reference
  const boundsX = lngToSvgX(minLng);
  const boundsY = latToSvgY(maxLat);
  const boundsW = (maxLng - minLng) * scale;
  const boundsH = (maxLat - minLat) * scale;

  svgContent += `  <rect x="${boundsX.toFixed(2)}" y="${boundsY.toFixed(
    2
  )}" width="${boundsW.toFixed(2)}" height="${boundsH.toFixed(
    2
  )}" fill="none" stroke="gray" stroke-width="2" stroke-dasharray="5,5"/>\n`;

  svgContent += `</svg>`;

  // Download SVG
  const blob = new Blob([svgContent], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `roads-export-${new Date().toISOString().slice(0, 10)}.svg`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  setStatus(
    `Exported ${geojson.features.length} road features as SVG`,
    "normal"
  );
}

// Backup initialization - ensure toggles are created once DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    console.log("[INIT] DOMContentLoaded - calling initializeCategoryToggles as backup");
    if (typeof initializeCategoryToggles === "function") {
      setTimeout(() => initializeCategoryToggles(), 100);
    }
  });
} else {
  // DOM already loaded
  console.log("[INIT] DOM already loaded - calling initializeCategoryToggles as backup");
  if (typeof initializeCategoryToggles === "function") {
    setTimeout(() => initializeCategoryToggles(), 100);
  }
}


