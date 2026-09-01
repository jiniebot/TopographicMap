#!/usr/bin/env node

// Efficiently tile DayZ local X/Z GeoJSON with geojson-vt. Coordinates are
// temporarily mapped into Web Mercator so its z/x/y subdivision is exactly
// equivalent to our CRS.Simple tile grid; encoded MVT geometry is tile-local.

const fs = require('fs');
const path = require('path');
const vtpbf = require('vt-pbf');
const { intersection } = require('polyclip-ts');

const ROOT = path.resolve(__dirname, '..', '..');
function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
const input = path.resolve(ROOT, arg('--input', 'out/livonia_contours_10m.geojson'));
const output = path.resolve(ROOT, arg('--out', 'out/mapdraw/vector-tests/terrain-tiles'));
const mapSize = Number(arg('--map-size', 12800));
const minZoom = Number(arg('--min-zoom', 6)), maxZoom = Number(arg('--max-zoom', 8));
const layer = arg('--layer', 'terrain');
const tolerance = Number(arg('--tolerance', layer === 'objects' ? 0 : 3));
const bounds = arg('--bounds', `0,0,${mapSize},${mapSize}`).split(',').map(Number);

function localToMercator([x, z]) {
  const lon = x / mapSize * 360 - 180;
  const tileY = (mapSize - z) / mapSize;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY))) * 180 / Math.PI;
  return [lon, lat];
}
function mapCoordinates(value) {
  if (typeof value[0] === 'number') return localToMercator(value);
  return value.map(mapCoordinates);
}
function boundsPolygon([minX,minZ,maxX,maxZ]) {
  return [[[[minX,minZ],[maxX,minZ],[maxX,maxZ],[minX,maxZ],[minX,minZ]]]];
}

async function main() {
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
  const geojson = JSON.parse(fs.readFileSync(input, 'utf8'));
  // Clip large world-spanning polygon sources before WebMercator conversion
  // and indexing. Preview bounds otherwise retain the complete terrain data
  // in geojson-vt and can consume several gigabytes at higher zoom levels.
  const clip= boundsPolygon(bounds);
  geojson.features=geojson.features.flatMap(feature=>{
    if(feature.geometry.type!=='Polygon'&&feature.geometry.type!=='MultiPolygon')return [feature];
    const coordinates=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;
    let clipped;
    try{clipped=intersection(coordinates,clip)}catch{return []}
    return clipped.length?[{...feature,geometry:{type:'MultiPolygon',coordinates:clipped}}]:[];
  });
  for (const feature of geojson.features) feature.geometry.coordinates = mapCoordinates(feature.geometry.coordinates);
  const geojsonVt = (await import('geojson-vt')).default;
  const index = geojsonVt(geojson, { maxZoom, indexMaxZoom: maxZoom, indexMaxPoints: 0, tolerance, extent: 4096, buffer: 32, promoteId: 'id' });
  const counts = {};
  for (let zoom = minZoom; zoom <= maxZoom; zoom++) {
    // A rebuild must remove tiles that existed in an older geometry set but
    // are empty now. Otherwise stale PBFs survive indefinitely and render
    // phantom objects at only the zoom levels where those files remain.
    const zoomDir = path.join(output, String(zoom));
    fs.rmSync(zoomDir, { recursive: true, force: true });
    const side = 2 ** zoom, tileWorld = mapSize / side;
    const tx0 = Math.max(0, Math.floor(bounds[0] / tileWorld)), tx1 = Math.min(side - 1, Math.floor(bounds[2] / tileWorld));
    const ty0 = Math.max(0, Math.floor((mapSize - bounds[3]) / tileWorld)), ty1 = Math.min(side - 1, Math.floor((mapSize - bounds[1]) / tileWorld));
    let tiles = 0, features = 0, bytes = 0;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const tile = index.getTile(zoom, tx, ty);
      if (!tile || !tile.features.length) continue;
      tile.features.sort((a, b) => {
        const rank = feature => feature.tags?.isWater ? 0 : feature.tags?.isGroundPanel ? 1 : feature.tags?.isRock ? 2 : feature.tags?.isRoad ? 3 : 4;
        return rank(a) - rank(b) || Number(a.tags?.topElevation ?? a.tags?.elev ?? 0) - Number(b.tags?.topElevation ?? b.tags?.elev ?? 0);
      });
      const buffer = vtpbf.fromGeojsonVt({ [layer]: tile }, { version: 2, extent: 4096 });
      const dir = path.join(output, String(zoom), String(tx));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ty}.pbf`), buffer);
      tiles++; features += tile.features.length; bytes += buffer.length;
    }
    counts[zoom] = { tiles, features, bytes };
    console.log(`z${zoom}: ${tiles} tiles, ${features} clipped features, ${(bytes / 1024).toFixed(1)} KiB`);
  }
  fs.mkdirSync(output, { recursive: true });
  for(const entry of fs.readdirSync(output,{withFileTypes:true})){
    if(!entry.isDirectory()||!/^\d+$/.test(entry.name))continue;
    const zoom=Number(entry.name);
    if(zoom<minZoom||zoom>maxZoom)fs.rmSync(path.join(output,entry.name),{recursive:true,force:true});
  }
  fs.writeFileSync(path.join(output, 'tile-meta.json'), `${JSON.stringify({ schemaVersion: 1, format: 'mvt', layer, mapSize, minZoom, maxZoom, tolerance, bounds, counts }, null, 2)}\n`);
  console.log(`MVT: ${output}`);
}
main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
