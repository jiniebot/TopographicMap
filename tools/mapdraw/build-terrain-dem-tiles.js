#!/usr/bin/env node
// Builds a raster-dem tile pyramid (Mapbox Terrain-RGB encoding) from the
// raw float32 elevation grids under data/<Map>/*_elevation.bin, for
// MapLibre's map.setTerrain()/hillshade. These grids are the same source
// old/contours/generateContours.js reads to build the 10m contour lines -
// row-major float32, no header, southwest origin (row 0 = z=0, col 0 = x=0),
// cell spacing = mapSize/(width-1).
//
// Tile z/x/y bounds are computed directly in DayZ-meters (no need to route
// through the Mercator round-trip build-local-mvt.js uses for vector tiles)
// because both the longitude and the tile-y pixel space our custom
// dayzToLngLat() mapping produces are already linear in DayZ x/z - see the
// maplibre-viewer.html coordinate-system comment for the derivation. So a
// tile's DayZ-meters bounds are just a straight fraction of the map size.
const fs = require('fs');
const path = require('path');
const { encodeRgbPng } = require('./lib/write-png');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
const mapId = arg('--map');
const elevationFile = path.resolve(arg('--elevation-file'));
const gridWidth = Number(arg('--width'));
const gridHeight = Number(arg('--height'));
const mapSize = Number(arg('--map-size'));
const minZoom = Number(arg('--min-zoom', 0));
const maxZoom = Number(arg('--max-zoom', 6));
const tileSize = Number(arg('--tile-size', 256));
const out = path.resolve(arg('--out', path.join(__dirname, '..', '..', 'out', 'mapdraw', 'dem', mapId)));

if (!mapId || !elevationFile || !gridWidth || !gridHeight || !mapSize) {
  throw new Error('Required: --map --elevation-file --width --height --map-size');
}

const buf = fs.readFileSync(elevationFile);
const grid = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
if (grid.length !== gridWidth * gridHeight) {
  throw new Error(`Grid size mismatch: expected ${gridWidth * gridHeight}, got ${grid.length}`);
}
const cellSize = mapSize / (gridWidth - 1);

function sampleBilinear(x, z) {
  // x/z in DayZ meters -> fractional grid col/row, clamped to the grid edge
  // (satellite/vector tiles can extend a hair past the data bounds at tile
  // seams; clamping avoids reading garbage rather than crashing on it).
  const colF = Math.min(gridWidth - 1, Math.max(0, x / cellSize));
  const rowF = Math.min(gridHeight - 1, Math.max(0, z / cellSize));
  const c0 = Math.floor(colF), r0 = Math.floor(rowF);
  const c1 = Math.min(gridWidth - 1, c0 + 1), r1 = Math.min(gridHeight - 1, r0 + 1);
  const fc = colF - c0, fr = rowF - r0;
  const v00 = grid[r0 * gridWidth + c0], v10 = grid[r0 * gridWidth + c1];
  const v01 = grid[r1 * gridWidth + c0], v11 = grid[r1 * gridWidth + c1];
  const top = v00 + (v10 - v00) * fc, bottom = v01 + (v11 - v01) * fc;
  return top + (bottom - top) * fr;
}

// Mapbox Terrain-RGB: elevation = -10000 + (R*65536 + G*256 + B) * 0.1
function encodeElevation(elev) {
  const n = Math.round((elev + 10000) / 0.1);
  return [(n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

let tilesWritten = 0;
for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
  const side = 2 ** zoom, tileWorld = mapSize / side;
  for (let ty = 0; ty < side; ty++) {
    const zMax = mapSize - ty * tileWorld, zMin = zMax - tileWorld;
    for (let tx = 0; tx < side; tx++) {
      const xMin = tx * tileWorld;
      const rgb = Buffer.alloc(tileSize * tileSize * 3);
      for (let py = 0; py < tileSize; py++) {
        const z = zMax - ((py + 0.5) / tileSize) * tileWorld;
        for (let px = 0; px < tileSize; px++) {
          const x = xMin + ((px + 0.5) / tileSize) * tileWorld;
          const elev = sampleBilinear(x, z);
          const [r, g, b] = encodeElevation(elev);
          const o = (py * tileSize + px) * 3;
          rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
        }
      }
      const dir = path.join(out, String(zoom), String(tx));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ty}.png`), encodeRgbPng(rgb, tileSize, tileSize));
      tilesWritten++;
    }
  }
  console.log(`[dem] ${mapId} zoom ${zoom}: ${side * side} tiles`);
}
console.log(`[dem] ${mapId} done: ${tilesWritten} tiles -> ${out}`);
