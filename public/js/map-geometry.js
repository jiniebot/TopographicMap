// =============================================================================
// Geometry Creation and Calculations
// Functions for creating and manipulating geometric shapes and polygons
// =============================================================================

// ===== Coordinate Utilities =====
function snapToGrid(x, z, gridSize = 0.5) {
  return [
    Math.round(x / gridSize) * gridSize,
    Math.round(z / gridSize) * gridSize,
  ];
}

function applyCornerOrder(x, z, halfX, halfZ) {
  return [
    [x - halfX, z - halfZ],
    [x + halfX, z - halfZ],
    [x + halfX, z + halfZ],
    [x - halfX, z + halfZ],
  ];
}

// ===== Road Rectangle Creation =====
function createRoadRectangle(x, z, sizeX, sizeZ, yaw, scale = 1.0) {
  const scaledSizeX = sizeX * scale;
  const scaledSizeZ = sizeZ * scale;

  const halfX = scaledSizeX / 2;
  const halfZ = scaledSizeZ / 2;

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
  const widthOnX = sizeX <= sizeZ;
  const currentWidth = widthOnX ? sizeX : sizeZ;
  const currentLength = widthOnX ? sizeZ : sizeX;

  const refWidth = referenceObjectName
    ? getLineWidthFromReference(referenceObjectName, bboxCache)
    : 0;

  let targetWidth;
  if (catConfig.uniformWidth) {
    targetWidth = catConfig.uniformWidth;
  } else {
    targetWidth = refWidth > 0 ? refWidth : currentWidth;
  }

  const applyCurveDrawer = curveAngleDeg !== 0;
  const scaledWidth = targetWidth * scale;
  const scaledLength = currentLength * scale;

  const adjustedSizeX = widthOnX ? scaledWidth : scaledLength;
  const adjustedSizeZ = widthOnX ? scaledLength : scaledWidth;

  const centerX = x;
  const centerZ = z;

  // For curves, build a polygonal arc using bbox length and parsed angle
  if (applyCurveDrawer && typeof curveAngleDeg === "number" && curveAngleDeg !== 0) {
    let curvePoly = createCurvePolygon(centerX, centerZ, curveAngleDeg, scaledWidth, scaledLength);
    
    const bounds = computeBoundsFromCorners(curvePoly);
    if (bounds) {
      const curveCenterX = (bounds.minX + bounds.maxX) / 2;
      const curveCenterZ = (bounds.minZ + bounds.maxZ) / 2;
      const deltaX = centerX - curveCenterX;
      const deltaZ = centerZ - curveCenterZ;
      curvePoly = curvePoly.map(([cx, cz]) => [cx + deltaX, cz + deltaZ]);
      curvePoly._centerShift = [deltaX, deltaZ];
    }

    curvePoly._rotationCenter = [centerX, centerZ];
    curvePoly._extraYawDeg = 180 + curveAngleDeg / 2;
    curvePoly._noSnap = true;
    curvePoly._isCurve = true;
    curvePoly._curveAngle = curveAngleDeg;
    curvePoly._curveCenter = [centerX, centerZ];
    curvePoly._curveWidth = scaledWidth;
    curvePoly._curveLength = scaledLength;
    return curvePoly;
  }

  const rect = createRoadRectangle(centerX, centerZ, adjustedSizeX, adjustedSizeZ, yaw, 1.0);
  return rect;
}

// ===== Curve Polygon Creation =====
function createCurvePolygon(centerX, centerZ, curveAngleDeg, width, length) {
  const halfChord = length / 2;
  const halfWidth = width / 2;
  const angleRad = (curveAngleDeg * Math.PI) / 180;

  const radius = halfChord / Math.sin(angleRad / 2);
  const centerOffsetX = radius * Math.cos(angleRad / 2);
  const circleCenter = { x: centerX - centerOffsetX, z: centerZ };

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

  const startA = -angleRad / 2;
  const endA = angleRad / 2;
  const segments = 12;
  const outerArc = buildArc(radius + halfWidth, startA, endA, segments);
  const innerRadius = Math.max(radius - halfWidth, 0.1);
  const innerArc = buildArc(innerRadius, endA, startA, segments);

  return [...outerArc, ...innerArc];
}

// ===== Circle Polygon Creation =====
function createCirclePolygon(centerX, centerZ, radiusLocalUnits, points = 64) {
  const polygon = [];

  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const localX = centerX + radiusLocalUnits * Math.cos(angle);
    const localZ = centerZ + radiusLocalUnits * Math.sin(angle);

    const px = (localX / config.mapSize) * WORLD_SIZE;
    const pz = (localZ / config.mapSize) * WORLD_SIZE;
    const py = WORLD_SIZE - pz;

    const latlng = map.unproject(L.point(px, py), config.tileMaxZoom);
    polygon.push([latlng.lat, latlng.lng]);
  }

  return polygon;
}

function createCircleFromBBox(x, z, bbox) {
  if (!bbox || !bbox.size) {
    return createCirclePolygon(x, z, 5);
  }

  const [sizeX, sizeY, sizeZ] = bbox.size;
  const radiusLocalUnits = Math.min(sizeX, sizeZ) / 2;
  return createCirclePolygon(x, z, radiusLocalUnits);
}

// ===== Diagonal-Aligned Rectangle =====
function createDiagonalAlignedRectangle(x1, z1, x2, z2, lineWidth, flipCorners = false) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.sqrt(dx * dx + dz * dz);

  if (len < 1e-6) return [[x1, z1]];

  const ux = dx / len;
  const uz = dz / len;

  let px = -uz;
  let pz = ux;

  if (flipCorners) {
    px = -px;
    pz = -pz;
  }

  const halfWidth = lineWidth / 2;
  const c1 = [x1 + px * halfWidth, z1 + pz * halfWidth];
  const c2 = [x2 + px * halfWidth, z2 + pz * halfWidth];
  const c3 = [x2 - px * halfWidth, z2 - pz * halfWidth];
  const c4 = [x1 - px * halfWidth, z1 - pz * halfWidth];

  return [c1, c2, c3, c4];
}

// ===== Bounds Calculation =====
function computeBoundsFromCorners(corners) {
  if (!corners || corners.length === 0) return null;

  let minX = corners[0][0];
  let maxX = corners[0][0];
  let minZ = corners[0][1];
  let maxZ = corners[0][1];

  for (let i = 1; i < corners.length; i++) {
    minX = Math.min(minX, corners[i][0]);
    maxX = Math.max(maxX, corners[i][0]);
    minZ = Math.min(minZ, corners[i][1]);
    maxZ = Math.max(maxZ, corners[i][1]);
  }

  return { minX, maxX, minZ, maxZ };
}

// ===== Ring Analysis Utilities =====
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

  return Math.acos(Math.max(-1, Math.min(1, dot / (mag1 * mag2))));
}

function ringOrientation(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    area += p1[0] * p2[1] - p2[0] * p1[1];
  }
  return area > 0 ? 1 : -1;
}

function expandRing(ring, delta) {
  const orientation = ringOrientation(ring);
  const offsetPerp = orientation > 0 ? (dx, dz) => [-dz, dx] : (dx, dz) => [dz, -dx];

  const expanded = [];

  for (let i = 0; i < ring.length; i++) {
    const prev = ring[i === 0 ? ring.length - 1 : i - 1];
    const curr = ring[i];
    const next = ring[(i + 1) % ring.length];

    const [e1x, e1z] = [curr[0] - prev[0], curr[1] - prev[1]];
    const len1 = Math.sqrt(e1x * e1x + e1z * e1z) || 1;
    const [n1x, n1z] = offsetPerp(e1x / len1, e1z / len1);

    const [e2x, e2z] = [next[0] - curr[0], next[1] - curr[1]];
    const len2 = Math.sqrt(e2x * e2x + e2z * e2z) || 1;
    const [n2x, n2z] = offsetPerp(e2x / len2, e2z / len2);

    const nx = (n1x + n2x) / 2;
    const nz = (n1z + n2z) / 2;
    const nlen = Math.sqrt(nx * nx + nz * nz) || 1;

    expanded.push([curr[0] + (nx / nlen) * delta, curr[1] + (nz / nlen) * delta]);
  }

  return expanded;
}

// ===== Ring Smoothing =====
function cleanupShortSegments(rings, threshold = 3.0) {
  const result = [];
  const thr2 = threshold * threshold;

  for (const ring of rings) {
    const pts = [...ring];

    let improved = true;
    while (improved && pts.length > 3) {
      improved = false;

      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 2; j < pts.length; j++) {
          if (distSquared(pts[i], pts[j]) < thr2) {
            const angleI = angleAt(i, pts);
            const angleJ = angleAt(j, pts);

            if (angleI > Math.PI * 0.7 && angleJ > Math.PI * 0.7) {
              pts.splice(i + 1, j - i - 1);
              improved = true;
              break;
            }
          }
        }

        if (improved) break;
      }
    }

    result.push(pts);
  }

  return result;
}

function smoothRing(ring, iterations = 1, rightAngleToleranceDeg = 12) {
  let pts = [...ring];
  const rightAngleRad = (rightAngleToleranceDeg * Math.PI) / 180;

  for (let iter = 0; iter < iterations; iter++) {
    const smoothed = [];

    for (let i = 0; i < pts.length; i++) {
      const prev = pts[i === 0 ? pts.length - 1 : i - 1];
      const curr = pts[i];
      const next = pts[(i + 1) % pts.length];

      const ang = angleAt(i, pts);
      const isRightAngle = Math.abs(ang - Math.PI / 2) < rightAngleRad;

      if (isRightAngle) {
        smoothed.push(curr);
      } else {
        const px = (prev[0] + curr[0] + next[0]) / 3;
        const pz = (prev[1] + curr[1] + next[1]) / 3;
        smoothed.push([px, pz]);
      }
    }

    pts = smoothed;
  }

  return pts;
}
