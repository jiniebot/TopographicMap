// =============================================================================
// Polygon Processing and Refinement
// Functions for processing, filtering, and refining polygon coordinates
// =============================================================================

// ===== Leaflet Polygon Creation =====
function createLeafletPolygonFromLocal(coordsOrRings, catConfig, opts = {}) {
  const rings = Array.isArray(coordsOrRings[0]?.[0])
    ? coordsOrRings
    : [coordsOrRings];

  const latlngRings = rings.map((ring) =>
    ring.map((p) => convertLocalToLatLng(p[0], p[1], config, WORLD_SIZE, map))
  );

  const fillColor = opts.fillColor || catConfig.fillColor;
  const strokeColor = opts.strokeColor || catConfig.strokeColor;

  return L.polygon(latlngRings, {
    color: strokeColor,
    weight: opts.weight !== undefined ? opts.weight : catConfig.strokeWeight,
    opacity: catConfig.strokeOpacity,
    fill: true,
    fillColor: fillColor,
    fillOpacity: opts.fillOpacity !== undefined ? opts.fillOpacity : catConfig.fillOpacity,
    smooth: false,
  });
}

// ===== Feature Removal =====
function removeSmallFeatures(coords, minDistance = 0.00004) {
  const filtered = [];

  for (let i = 0; i < coords.length; i++) {
    let skip = false;

    for (let j = 0; j < i; j++) {
      const dist = Math.sqrt(
        Math.pow(coords[i][0] - coords[j][0], 2) +
          Math.pow(coords[i][1] - coords[j][1], 2)
      );

      if (dist < minDistance) {
        skip = true;
        break;
      }
    }

    if (!skip) {
      filtered.push(coords[i]);
    }
  }

  return filtered;
}

// ===== Point-to-Line Distance =====
function pointToLineDistance(point, lineStart, lineEnd) {
  const [px, py] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;

  const A = py - y1;
  const B = px - x1;
  const C = y2 - y1;
  const D = x2 - x1;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;

  let param = -1;
  if (lenSq !== 0) param = dot / lenSq;

  let xx, yy;

  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * D;
    yy = y1 + param * C;
  }

  const dx = px - xx;
  const dy = py - yy;

  return Math.sqrt(dx * dx + dy * dy);
}

// ===== Perimeter Calculation =====
function calculatePerimeter(coordinates) {
  let perimeter = 0;

  for (let i = 0; i < coordinates.length; i++) {
    const curr = coordinates[i];
    const next = coordinates[(i + 1) % coordinates.length];

    const dx = next[0] - curr[0];
    const dy = next[1] - curr[1];
    perimeter += Math.sqrt(dx * dx + dy * dy);
  }

  return perimeter;
}

// ===== Corner Rounding =====
function roundCorners(coords, cornerRadius = 0.00008) {
  const rounded = [];

  for (let i = 0; i < coords.length; i++) {
    const prev = coords[i === 0 ? coords.length - 1 : i - 1];
    const curr = coords[i];
    const next = coords[(i + 1) % coords.length];

    const dx1 = curr[0] - prev[0];
    const dy1 = curr[1] - prev[1];
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;

    const dx2 = next[0] - curr[0];
    const dy2 = next[1] - curr[1];
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;

    const p1x = curr[0] - (dx1 / len1) * cornerRadius;
    const p1y = curr[1] - (dy1 / len1) * cornerRadius;

    const p2x = curr[0] + (dx2 / len2) * cornerRadius;
    const p2y = curr[1] + (dy2 / len2) * cornerRadius;

    rounded.push([p1x, p1y]);

    const steps = 4;
    const angle1 = Math.atan2(-dy1, -dx1);
    const angle2 = Math.atan2(dy2, dx2);

    for (let step = 1; step <= steps; step++) {
      const t = step / (steps + 1);
      const angle = angle1 + (angle2 - angle1) * t;

      const cx = curr[0] + Math.cos(angle) * cornerRadius;
      const cy = curr[1] + Math.sin(angle) * cornerRadius;

      rounded.push([cx, cy]);
    }
  }

  return rounded;
}

// ===== Edge Smoothing =====
function smoothPolygonEdges(coords, tension = 0.5, aggressive = false) {
  const smoothed = [];

  for (let i = 0; i < coords.length; i++) {
    const p0 = coords[i === 0 ? coords.length - 1 : i - 1];
    const p1 = coords[i];
    const p2 = coords[(i + 1) % coords.length];
    const p3 = coords[(i + 2) % coords.length];

    // Catmull-Rom interpolation
    const steps = aggressive ? 3 : 2;

    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      const t2 = t * t;
      const t3 = t2 * t;

      const a = -t3 + 2 * t2 - t;
      const b = 3 * t3 - 5 * t2 + 2;
      const c = -3 * t3 + 4 * t2 + t;
      const d = t3 - t2;

      const x = (a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0]) * (tension / 2);
      const y = (a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]) * (tension / 2);

      smoothed.push([x, y]);
    }
  }

  return smoothed;
}

// ===== Utility Conversion =====
function convertLocalToLatLng(cx, cz, config, WORLD_SIZE, map) {
  const px = (cx / config.mapSize) * WORLD_SIZE;
  const pz = (cz / config.mapSize) * WORLD_SIZE;
  const py = WORLD_SIZE - pz;
  return map.unproject(L.point(px, py), config.tileMaxZoom);
}
