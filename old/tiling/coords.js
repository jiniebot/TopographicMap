// Pure tiling math - no Leaflet/canvas dependency.
//
// Mirrors the local-unit -> pixel formula used everywhere an object is placed
// on the map client-side (see public/js/map-polygon.js:186-191,
// public/js/map-core.js:206-211 and every inline duplicate). That formula
// flips Z:
//   px = (x / mapSize) * worldPx
//   pz = (z / mapSize) * worldPx
//   py = worldPx - pz
//
// NOTE: this is deliberately different from displayTopographic()'s contour
// formula (map-core.js:2627-2634), which has no Z flip and is unrelated to
// object placement - do not copy that one.

function worldPxAtZoom(config, zoom) {
  return config.tileSize * Math.pow(2, zoom);
}

// local DayZ (x, z) -> pixel (px, py) at a given zoom level
function localToPixel(config, x, z, zoom) {
  const worldPx = worldPxAtZoom(config, zoom);
  const px = (x / config.mapSize) * worldPx;
  const pz = (z / config.mapSize) * worldPx;
  const py = worldPx - pz;
  return [px, py];
}

// inverse of localToPixel
function pixelToLocal(config, px, py, zoom) {
  const worldPx = worldPxAtZoom(config, zoom);
  const x = (px / worldPx) * config.mapSize;
  const pz = worldPx - py;
  const z = (pz / worldPx) * config.mapSize;
  return [x, z];
}

// The local-unit bounding box a given tile (z, x, y) covers, expanded by
// marginUnits on every side (for stroke/circle-radius bleed across tile
// edges). Returns {minX, minZ, maxX, maxZ} in local DayZ units.
function tileToLocalBBox(config, z, x, y, marginUnits = 0) {
  const px0 = x * config.tileSize;
  const px1 = (x + 1) * config.tileSize;
  const py0 = y * config.tileSize;
  const py1 = (y + 1) * config.tileSize;

  // py increases downward (tile Y), and py = worldPx - pz, so as py grows,
  // pz shrinks -> local Z decreases. Top of tile (py0) = higher Z.
  const [xAtPx0, zAtPy0] = pixelToLocal(config, px0, py0, z);
  const [xAtPx1, zAtPy1] = pixelToLocal(config, px1, py1, z);

  const minX = Math.min(xAtPx0, xAtPx1) - marginUnits;
  const maxX = Math.max(xAtPx0, xAtPx1) + marginUnits;
  const minZ = Math.min(zAtPy0, zAtPy1) - marginUnits;
  const maxZ = Math.max(zAtPy0, zAtPy1) + marginUnits;

  return { minX, minZ, maxX, maxZ };
}

// Number of tiles per side at a given zoom (standard XYZ pyramid)
function tilesPerSide(zoom) {
  return Math.pow(2, zoom);
}

module.exports = {
  worldPxAtZoom,
  localToPixel,
  pixelToLocal,
  tileToLocalBBox,
  tilesPerSide,
};
