// Canonical per-map configuration shared by the contour generator
// (tools/contours/generateContours.js) and the tile-rendering pipeline
// (topo-index.js, build-topo-tiles.js, build-contour-overlay-tiles.js) -
// one place to define each map's elevation grid and "water level"
// convention, since maps don't share a common elevation datum: Chernarus
// and Sakhal's heightmaps dip below 0 at the coastline (0 = real sea
// level), but Livonia's never goes below +146 - its heightmap uses a
// different vertical reference entirely. waterElevCutoff is the elevation
// value below which the topographic base renders as water for that map.
const MAP_CONFIGS = {
  chernarus: {
    mapSize: 15360,
    elevationFile: 'data/Chernarus/chernarus_elevation.bin',
    elevationWidth: 1537,
    elevationHeight: 1537,
    contoursFile: 'out/chernarus_contours_10m.geojson',
    waterElevCutoff: 0,
  },
  sakhal: {
    mapSize: 15360,
    elevationFile: 'data/Sakhal/sakhal_elevation.bin',
    elevationWidth: 1537,
    elevationHeight: 1537,
    contoursFile: 'out/sakhal_contours_10m.geojson',
    waterElevCutoff: 0,
  },
  livonia: {
    mapSize: 12800,
    elevationFile: 'data/Livonia/livonia_elevation.bin',
    elevationWidth: 1281,
    elevationHeight: 1281,
    contoursFile: 'out/livonia_contours_10m.geojson',
    waterElevCutoff: 171, // Livonia's water datum (its heightmap uses an offset vertical reference)
  },
};

module.exports = { MAP_CONFIGS };
