// Rasterizes one native-zoom tile from the spatial indexes built by
// point-index.js / polygon-index.js, in the flattened drawingOrder.
//
// Phase-1 seam handling: every category is drawn fill-only (never stroked),
// AND all of a category's features on a tile are combined into a single
// Path2D-equivalent (one beginPath()/…/fill() pair) instead of one fill()
// call per feature. Canvas fills a path's union exactly once per pixel
// regardless of how many overlapping subpaths it contains, so this avoids
// double-alpha-blending seams both for translucent scatter categories
// (trees/bushes at fillOpacity 0.1, which would otherwise darken visibly
// where circles overlap) and for opaque road-like categories (which would
// otherwise show a faint antialiasing seam at abutting segment edges).
// Exact stroke fidelity (matching the live client's Turf.js union pass in
// map-unions.js) is an explicit, separate Phase 2 - not attempted here.

const { createCanvas } = require('@napi-rs/canvas');
const { localToPixel, pixelToLocal, tileToLocalBBox, worldPxAtZoom } = require('./coords');
const { toRgba, parseColor } = require('./color');
const { queryPointIndex } = require('./point-index');
const { queryPolygonIndex, getRing, getVertexElev } = require('./polygon-index');
const { sampleElevation } = require('./elevation');
const { queryTopoIndex } = require('./topo-index');

function buildCategoryStyles(mapStyles, drawingOrder) {
  const styles = {};
  for (const name of drawingOrder) {
    const cfg = mapStyles.categories[name];
    if (!cfg) continue;
    const parsed = parseColor(cfg.fillColor);
    const opacity = cfg.fillOpacity ?? 1;
    styles[name] = {
      drawType: cfg.drawType,
      fill: toRgba(cfg.fillColor, opacity),
      fillRgba: { r: parsed.r, g: parsed.g, b: parsed.b, a: Math.max(0, Math.min(1, parsed.a * opacity)) },
    };
  }
  return styles;
}

// Point-in-polygon via ray casting. `ring` is an array of [x, z] local-unit
// vertices (closed or not - a duplicate closing vertex doesn't affect the result).
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1];
    const xj = ring[j][0], zj = ring[j][1];
    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const lenSq = dx * dx + dz * dz;
  let t = lenSq > 0 ? ((px - x1) * dx + (pz - z1) * dz) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cz = z1 + t * dz;
  const ex = px - cx, ez = pz - cz;
  return Math.sqrt(ex * ex + ez * ez);
}

// Welded vertices guarantee two adjacent water pieces share an exact corner
// point, but nothing forces their EDGES to be collinear through it - if the
// pieces meet at even a slightly different angle, a thin wedge of space
// outside BOTH rings opens up right at that corner (distinct from the
// terrain-elevation notches the despeckle pass handles: this one is a real
// gap in the polygon union, so no amount of blurring an isolated feature's
// own mask can ever reach it - the pixel is never "inside" either ring to
// begin with). Treating "within margin of the boundary" as inside as well
// dilates each piece by a small, fixed amount - invisible on a normal edge,
// but enough to bridge that wedge at a joint.
const RING_DILATE_MARGIN = 1.0;
function pointInOrNearRing(x, z, ring, margin) {
  if (pointInRing(x, z, ring)) return true;
  if (margin <= 0) return false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (distanceToSegment(x, z, ring[j][0], ring[j][1], ring[i][0], ring[i][1]) <= margin) return true;
  }
  return false;
}

// Each water piece only carries ONE placement elevation (its CSV
// Absolute_Elevation), but stream/river pieces sitting on a sloped creek bed
// span ~14-24m where the real terrain - and the true water surface - can
// drop several meters across that single footprint. Comparing every pixel
// against that one flat elevation value clips off the upstream (higher)
// half of each piece, leaving only a small downstream sliver visible and
// producing a broken/disconnected look up a slope. Ponds/lakes and the
// 50x50 tiles are flat and sit in a proper bowl-shaped depression, so their
// single elevation value IS representative of the whole footprint - giving
// them the same tolerance would just blur their depression edges outward
// for no reason, so only stream/river pieces (idx.sloped) get it.
const STREAM_RIVER_MASK_TOLERANCE = 2.5;
const POND_LAKE_MASK_TOLERANCE = 0;

// The underlying heightmap is only a 10m grid (bilinearly interpolated), so
// the raw per-pixel elevation test produces small isolated blobs/notches at
// the mask boundary that don't correspond to any real creek/bank feature -
// just grid-cell-scale noise - plus a hard pixel-grid staircase edge. Fixed
// with a small despeckle pass (blur the raw boolean mask, re-threshold at
// 0.5 - drops anything smaller than roughly the kernel) followed by a
// lighter blur used as a soft alpha, so the final edge anti-aliases instead
// of stair-stepping. Both are in native-tile pixels (~0.47m/px at zoom 7).
const MASK_DESPECKLE_RADIUS = 4;
const MASK_EDGE_SOFTEN_RADIUS = 1;

// Separable box blur (two 1D passes) - O(w*h) regardless of radius via a
// sliding window sum, unlike a naive O(w*h*radius^2) 2D kernel.
function boxBlur1D(src, w, h, radius, horizontal) {
  const out = new Float32Array(w * h);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      let sum = 0, count = 0;
      for (let x = -radius; x <= radius; x++) {
        if (x >= 0 && x < w) { sum += src[rowOff + x]; count++; }
      }
      out[rowOff] = sum / count;
      for (let x = 1; x < w; x++) {
        const addX = x + radius, remX = x - radius - 1;
        if (addX < w) { sum += src[rowOff + addX]; count++; }
        if (remX >= 0) { sum -= src[rowOff + remX]; count--; }
        out[rowOff + x] = sum / count;
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let y = -radius; y <= radius; y++) {
        if (y >= 0 && y < h) { sum += src[y * w + x]; count++; }
      }
      out[x] = sum / count;
      for (let y = 1; y < h; y++) {
        const addY = y + radius, remY = y - radius - 1;
        if (addY < h) { sum += src[addY * w + x]; count++; }
        if (remY >= 0) { sum -= src[remY * w + x]; count--; }
        out[y * w + x] = sum / count;
      }
    }
  }
  return out;
}
function boxBlur2D(src, w, h, radius) {
  if (radius <= 0) return src;
  return boxBlur1D(boxBlur1D(src, w, h, radius, true), w, h, radius, false);
}

// Inverse-distance-weighted water-surface elevation at (lx, lz) from a
// feature's per-vertex elevations (see snap-connectors.js: vertices welded
// to a neighbor got averaged with it, everything else falls back to the
// feature's own flat elev). This is what lets two welded-together pieces
// agree exactly at their shared edge - each samples the SAME nearby corner
// values - instead of each using one flat number and disagreeing right at
// the seam.
function interpolateVertexElev(lx, lz, ring, vertexElevs) {
  let sumW = 0, sumWE = 0;
  for (let i = 0; i < ring.length; i++) {
    const dx = lx - ring[i][0], dz = lz - ring[i][1];
    const d2 = dx * dx + dz * dz;
    if (d2 < 1e-6) return vertexElevs[i];
    const w = 1 / d2;
    sumW += w;
    sumWE += w * vertexElevs[i];
  }
  return sumW > 0 ? sumWE / sumW : NaN;
}

// Draws one terrain-masked feature (a pond/lake sitting in a depression):
// only paints pixels that are (a) inside the feature's own footprint and
// (b) where real terrain elevation is below the water-surface elevation
// interpolated at that point (plus a tolerance for sloped stream/river
// pieces - see above) - i.e. only where it would actually be visible as
// submerged ground in-game, instead of a flat, unconditioned rectangle/square.
function drawElevationMaskedFeature(ctx, config, elevGrid, z, originPx, originPy, tileSize, ring, vertexElevs, rgba, tolerance) {
  let minPx = Infinity, minPy = Infinity, maxPx = -Infinity, maxPy = -Infinity;
  for (const [lx, lz] of ring) {
    const [px, py] = localToPixel(config, lx, lz, z);
    const tx = px - originPx;
    const ty = py - originPy;
    if (tx < minPx) minPx = tx;
    if (tx > maxPx) maxPx = tx;
    if (ty < minPy) minPy = ty;
    if (ty > maxPy) maxPy = ty;
  }
  // Expand the crop by the dilation margin (in pixels at this zoom) so the
  // dilated containment test near the ring's own edge isn't clipped off.
  const pixelMargin = RING_DILATE_MARGIN * (worldPxAtZoom(config, z) / config.mapSize);
  const x0 = Math.max(0, Math.floor(minPx - pixelMargin));
  const y0 = Math.max(0, Math.floor(minPy - pixelMargin));
  const x1 = Math.min(tileSize, Math.ceil(maxPx + pixelMargin));
  const y1 = Math.min(tileSize, Math.ceil(maxPy + pixelMargin));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return false;

  // Pass 1: raw per-pixel terrain test. insideRing is the feature's actual
  // geometric footprint (a hard boundary, never smoothed/despeckled - only
  // the terrain-driven edge inside it should get softened); raw is 1 only
  // where insideRing AND terrain is below the water-surface threshold.
  const insideRing = new Uint8Array(w * h);
  const raw = new Float32Array(w * h);
  for (let py = 0; py < h; py++) {
    const tileY = y0 + py;
    const rowOff = py * w;
    for (let px = 0; px < w; px++) {
      const tileX = x0 + px;
      const [lx, lz] = pixelToLocal(config, tileX + originPx, tileY + originPy, z);
      if (!pointInOrNearRing(lx, lz, ring, RING_DILATE_MARGIN)) continue;
      insideRing[rowOff + px] = 1;
      const terrainElev = sampleElevation(elevGrid, lx, lz);
      const targetElev = interpolateVertexElev(lx, lz, ring, vertexElevs);
      if (terrainElev !== null && Number.isFinite(targetElev) && terrainElev < targetElev + tolerance) raw[rowOff + px] = 1;
    }
  }

  // Pass 2: despeckle (blur + re-threshold drops anything smaller than
  // roughly the kernel), then a lighter blur for a soft, anti-aliased edge.
  const despeckledFloat = boxBlur2D(raw, w, h, MASK_DESPECKLE_RADIUS);
  const despeckled = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) despeckled[i] = despeckledFloat[i] >= 0.5 ? 1 : 0;
  const alphaMask = boxBlur2D(despeckled, w, h, MASK_EDGE_SOFTEN_RADIUS);

  // Read-modify-write (not a blank ImageData) so untouched pixels - anything
  // already drawn by an earlier category on this tile, or just background -
  // are preserved exactly. putImageData has no alpha blending of its own; it
  // replaces pixels outright, so painting only the masked-in pixels here and
  // leaving the rest as read is what avoids clobbering the rest of the tile.
  const imgData = ctx.getImageData(x0, y0, w, h);
  const data = imgData.data;
  let paintedAny = false;
  const baseA = rgba.a;

  for (let py = 0; py < h; py++) {
    const rowOff = py * w;
    for (let px = 0; px < w; px++) {
      const i = rowOff + px;
      if (!insideRing[i]) continue;
      const maskAlpha = alphaMask[i];
      if (maskAlpha <= 0.01) continue;
      const srcA = baseA * maskAlpha;
      const di = i * 4;
      const dstA = data[di + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) continue;
      data[di] = (rgba.r * srcA + data[di] * dstA * (1 - srcA)) / outA;
      data[di + 1] = (rgba.g * srcA + data[di + 1] * dstA * (1 - srcA)) / outA;
      data[di + 2] = (rgba.b * srcA + data[di + 2] * dstA * (1 - srcA)) / outA;
      data[di + 3] = Math.round(outA * 255);
      paintedAny = true;
    }
  }

  if (!paintedAny) return false;
  ctx.putImageData(imgData, x0, y0);
  return true;
}

// Draws the elevation-contour "topographic" background (see topo-index.js) for
// one tile: every polygon piece whose bbox overlaps the tile, in ascending
// elevation order, filled/stroked exactly like displayTopographic() in
// map-core.js. Uses topoLocalToPixel's own (non-flipped) convention - NOT
// localToPixel - since that's the convention the source geojson matches.
//
// strokeOnly (for the "overlay topography on satellite" tile set) skips the
// fill entirely - just the contour-band boundary lines, transparent
// everywhere else, so the satellite imagery underneath stays visible.
//
// waterElevCutoff: elevation below which a band renders as water. Maps
// don't share a common elevation datum - Chernarus/Sakhal use real sea
// level (0), but Livonia's heightmap never dips below +146, so it needs
// its own cutoff (170, confirmed against the actual coastline/river shape
// in the data - see tools/map-config.js).
function drawTopoBase(ctx, config, topo, colors, z, originPx, originPy, tileSize, strokeOnly = false, lineWidth = 1, waterElevCutoff = 0) {
  const worldPx = worldPxAtZoom(config, z);
  const scale = worldPx / config.mapSize;
  const tileMinX = originPx / scale, tileMaxX = (originPx + tileSize) / scale;
  const tileMinZ = originPy / scale, tileMaxZ = (originPy + tileSize) / scale;
  const indices = queryTopoIndex(topo, tileMinX, tileMinZ, tileMaxX, tileMaxZ);
  let drew = false;
  for (const i of indices) {
    const poly = topo.polys[i];
    const isWater = poly.elev < waterElevCutoff;
    ctx.beginPath();
    for (const ring of poly.rings) {
      ring.forEach(([x, zc], vi) => {
        const px = x * scale - originPx;
        const py = zc * scale - originPy;
        if (vi === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
    }
    if (!strokeOnly) {
      ctx.fillStyle = isWater ? colors.waterColor : colors.landColor;
      ctx.fill();
    }
    ctx.strokeStyle = isWater ? colors.waterStroke : colors.landStroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    drew = true;
  }
  return drew;
}

// Renders one tile. Returns a PNG Buffer, or null if nothing was drawn
// (caller should skip writing a file for empty tiles - sparse pyramid).
// `topo` (optional) is a topo-index.js index - when present, the elevation-
// contour background is drawn first, underneath every category below.
// `topoLinesOnly` renders JUST the contour lines on a transparent
// background (no fill, no object categories) - for overlaying on top of an
// existing base layer (e.g. satellite imagery) instead of replacing it.
function renderNativeTile(
  z,
  x,
  y,
  { config, drawingOrder, categoryStyles, pointIndexes, polygonIndexes, tileSize = 256, marginUnits = 10, elevGrid = null, topo = null, topoColors = null, topoLinesOnly = false, topoLineWidth = 1, topoWaterElevCutoff = 0 }
) {
  const bbox = tileToLocalBBox(config, z, x, y, marginUnits);
  const worldPx = worldPxAtZoom(config, z);
  const scale = worldPx / config.mapSize; // pixels per local unit at this zoom

  const canvas = createCanvas(tileSize, tileSize);
  const ctx = canvas.getContext('2d');
  const originPx = x * tileSize;
  const originPy = y * tileSize;

  let drewAnything = false;

  if (topo) {
    if (drawTopoBase(ctx, config, topo, topoColors, z, originPx, originPy, tileSize, topoLinesOnly, topoLineWidth, topoWaterElevCutoff)) drewAnything = true;
  }

  if (topoLinesOnly) {
    return drewAnything ? canvas.toBuffer('image/png') : null;
  }

  for (const name of drawingOrder) {
    const style = categoryStyles[name];
    if (!style) continue;

    if (style.drawType === 'circle') {
      const idx = pointIndexes[name];
      if (!idx) continue;
      const pts = queryPointIndex(idx, bbox.minX, bbox.minZ, bbox.maxX, bbox.maxZ);
      if (pts.length === 0) continue;

      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 3) {
        const lx = pts[i];
        const lz = pts[i + 1];
        const r = pts[i + 2];
        const [px, py] = localToPixel(config, lx, lz, z);
        const tx = px - originPx;
        const ty = py - originPy;
        const pr = Math.max(0.5, r * scale);
        ctx.moveTo(tx + pr, ty);
        ctx.arc(tx, ty, pr, 0, Math.PI * 2);
      }
      ctx.fillStyle = style.fill;
      ctx.fill();
      drewAnything = true;
    } else if (style.drawType === 'rectangle') {
      const idx = polygonIndexes[name];
      if (!idx) continue;
      const featIndices = queryPolygonIndex(idx, bbox.minX, bbox.minZ, bbox.maxX, bbox.maxZ);
      if (featIndices.length === 0) continue;

      const normalIndices = [];
      for (const featIdx of featIndices) {
        if (idx.masked && idx.masked[featIdx]) {
          if (!elevGrid) {
            normalIndices.push(featIdx); // no heightmap loaded - fall back to a plain fill
            continue;
          }
          const ring = getRing(idx, featIdx);
          const vertexElevs = getVertexElev(idx, featIdx);
          const tolerance = idx.sloped && idx.sloped[featIdx] ? STREAM_RIVER_MASK_TOLERANCE : POND_LAKE_MASK_TOLERANCE;
          const painted = drawElevationMaskedFeature(
            ctx, config, elevGrid, z, originPx, originPy, tileSize, ring, vertexElevs, style.fillRgba, tolerance
          );
          if (painted) drewAnything = true;
        } else {
          normalIndices.push(featIdx);
        }
      }

      if (normalIndices.length > 0) {
        ctx.beginPath();
        for (const featIdx of normalIndices) {
          const ring = getRing(idx, featIdx);
          for (let i = 0; i < ring.length; i++) {
            const [lx, lz] = ring[i];
            const [px, py] = localToPixel(config, lx, lz, z);
            const tx = px - originPx;
            const ty = py - originPy;
            if (i === 0) ctx.moveTo(tx, ty);
            else ctx.lineTo(tx, ty);
          }
          ctx.closePath();
        }
        ctx.fillStyle = style.fill;
        ctx.fill();
        drewAnything = true;
      }
    }
  }

  if (!drewAnything) return null;
  return canvas.toBuffer('image/png');
}

module.exports = { buildCategoryStyles, renderNativeTile };
