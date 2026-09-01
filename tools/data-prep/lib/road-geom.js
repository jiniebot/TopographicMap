// Shared road geometry helpers (Node-friendly).
// Sourced from public/js/map-core.js so build scripts and the browser can stay in sync.

function snapToGrid(x, z, gridSize = 0.5) {
  return [Math.round(x / gridSize) * gridSize, Math.round(z / gridSize) * gridSize];
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
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        if (distSquared(pts[i], pts[j]) < thr2) {
          const angleI = angleAt(i, pts);
          const angleJ = angleAt(j, pts);
          if (angleI >= angleJ) {
            pts[i] = [...pts[j]];
          } else {
            pts[j] = [...pts[i]];
          }
          changed = true;
        }
      }
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
  const orientation = ringOrientation(ring);
  const len = ring.length;
  const normals = [];

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

  const outRing = [];
  for (let i = 0; i < len; i++) {
    const [n1x, n1z] = normals[(i - 1 + len) % len];
    const [n2x, n2z] = normals[i];
    const avgx = (n1x + n2x) / 2;
    const avgz = (n1z + n2z) / 2;
    const mag = Math.sqrt(avgx * avgx + avgz * avgz) || 1e-6;
    outRing.push([
      ring[i][0] + (avgx / mag) * delta,
      ring[i][1] + (avgz / mag) * delta,
    ]);
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

function computeBoundsFromCorners(corners) {
  if (!corners || corners.length === 0) return null;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  corners.forEach(([cx, cz]) => {
    if (cx < minX) minX = cx;
    if (cz < minZ) minZ = cz;
    if (cx > maxX) maxX = cx;
    if (cz > maxZ) maxZ = cz;
  });
  return { minX, minZ, maxX, maxZ };
}

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

function closeRing(ring) {
  if (!ring || ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

const RoadGeom = {
  snapToGrid,
  distSquared,
  angleAt,
  cleanupShortSegments,
  ringOrientation,
  expandRing,
  smoothRing,
  computeBoundsFromCorners,
  createCurvePolygon,
  closeRing,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = RoadGeom;
} else if (typeof window !== "undefined") {
  window.RoadGeom = RoadGeom;
}
