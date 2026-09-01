// Composites cached top-down model imagery into sparse Livonia XYZ tiles.
// Objects are ordered by absolute top elevation so higher objects occlude
// lower objects. A later cache revision will replace this object-level order
// with the renderer's per-pixel model-height buffer.
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { MAP_CONFIGS } = require('../map-config');
const { localToPixel } = require('../tiling/coords');
const { buildOverviewLevel } = require('../tiling/build-overview');

const ROOT = path.resolve(__dirname, '..', '..');
const TILE_SIZE = 256;
function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }

async function main() {
  const zoom = Number(arg('--zoom', 7));
  const limit = Number(arg('--limit', Infinity));
  const sceneFile = path.resolve(ROOT, arg('--scene', 'out/mapdraw/enoch-scene.json'));
  const scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8'));
  const config = { ...MAP_CONFIGS.livonia, tileSize: TILE_SIZE };
  const output = path.resolve(ROOT, arg('--out', 'out/tiles/livonia-raster'));
  const tileObjects = new Map();

  for (const object of scene.objects.slice(0, limit)) {
    const [px, py] = localToPixel(config, object.x, object.z, zoom);
    const radiusPx = Math.hypot(object.bounds.maxX - object.bounds.minX, object.bounds.maxZ - object.bounds.minZ) * TILE_SIZE * 2 ** zoom / config.mapSize;
    const minTx = Math.floor((px - radiusPx) / TILE_SIZE), maxTx = Math.floor((px + radiusPx) / TILE_SIZE);
    const minTy = Math.floor((py - radiusPx) / TILE_SIZE), maxTy = Math.floor((py + radiusPx) / TILE_SIZE);
    // Road/decal models are terrain surfaces. Some visual LODs contain tall
    // helper/edge geometry whose maxY must not make the road occlude a house.
    const layerBias = object.transformSource === '8wvr-matrix' ? -10000 : 0;
    object.topElevation = object.elevation + object.bounds.maxY + layerBias;
    for (let ty = minTy; ty <= maxTy; ty++) for (let tx = minTx; tx <= maxTx; tx++) {
      if (tx < 0 || ty < 0 || tx >= 2 ** zoom || ty >= 2 ** zoom) continue;
      const key = `${tx},${ty}`;
      if (!tileObjects.has(key)) tileObjects.set(key, []);
      tileObjects.get(key).push(object);
    }
  }

  const images = new Map();
  let written = 0;
  const nativeCoords = [];
  for (const [key, objects] of tileObjects) {
    const [tx, ty] = key.split(',').map(Number);
    const canvas = createCanvas(TILE_SIZE, TILE_SIZE), ctx = canvas.getContext('2d');
    objects.sort((a, b) => a.topElevation - b.topElevation);
    for (const object of objects) {
      let image = images.get(object.cacheKey);
      if (!image) {
        image = await loadImage(path.join(ROOT, object.image));
        images.set(object.cacheKey, image);
      }
      const [px, py] = localToPixel(config, object.x, object.z, zoom);
      const pixelsPerMeter = TILE_SIZE * 2 ** zoom / config.mapSize;
      const imageMeters = image.width * object.metersPerPixel;
      const imageHeightMeters = image.height * object.metersPerPixel;
      const isRoadPart = /\\roads(?:_bliss)?\\parts\\/i.test(object.model);
      // Individually rasterized road sprites meet exactly at their mesh ends,
      // but transparent-edge filtering can erase that subpixel contact when
      // overview tiles are downsampled. Extend only the longitudinal image
      // axis by a small amount so adjacent surfaces overlap by >1 native pixel.
      const roadSeamBleedMeters = 0;
      const drawHeightMeters = imageHeightMeters + roadSeamBleedMeters * 2;
      // Compiled RoadNet transforms store the average of RoadPositions (the
      // segment center), even though road P3D visual vertices commonly run
      // from local Z=0 to +length. Ordinary object transforms use model-local
      // origin semantics. Do not apply the P3D bounds-center offset twice to
      // RoadNet-derived roads.
      const isRoadNet = object.transformSource === '8wvr-matrix' && /\\roads(?:_bliss)?\\parts\\/i.test(object.model);
      const centerX = isRoadNet ? 0 : (object.bounds.minX + object.bounds.maxX) / 2;
      const centerZ = isRoadNet ? 0 : (object.bounds.minZ + object.bounds.maxZ) / 2;
      ctx.save();
      ctx.translate(px - tx * TILE_SIZE, py - ty * TILE_SIZE);
      // The 8WVR basis maps local +Z to world heading +yaw. Canvas Y points
      // downward while world Z points upward on the map, so applying +yaw to
      // the cached X/right, Z/up image reproduces the matrix. Using -yaw looks
      // plausible for symmetric straight strips but mirrors curved pieces.
      ctx.rotate(object.yaw * Math.PI / 180);
      if (object.scale && object.scale !== 1) ctx.scale(object.scale, object.scale);
      ctx.translate(centerX * pixelsPerMeter, -centerZ * pixelsPerMeter);
      ctx.drawImage(image, -imageMeters * pixelsPerMeter / 2, -drawHeightMeters * pixelsPerMeter / 2,
        imageMeters * pixelsPerMeter, drawHeightMeters * pixelsPerMeter);
      ctx.restore();
    }
    const dir = path.join(output, String(zoom), String(tx));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ty}.png`), canvas.toBuffer('image/png'));
    nativeCoords.push([tx, ty]);
    written++;
  }
  const perZoomTileCounts = { [zoom]: written };
  let childCoords = nativeCoords;
  for (let childZoom = zoom; childZoom > 0; childZoom--) {
    childCoords = await buildOverviewLevel(output, childZoom, childCoords);
    perZoomTileCounts[childZoom - 1] = childCoords.length;
    console.log(`[raster] overview zoom ${childZoom - 1}: ${childCoords.length} tiles`);
  }
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'tile-meta.json'), JSON.stringify({ map: 'livonia', style: 'raster', nativeZoom: zoom, perZoomTileCounts, objects: Math.min(limit, scene.objects.length), occlusion: 'absolute object top elevation' }, null, 2));
  console.log(`[raster] ${written} sparse zoom-${zoom} tiles from ${Math.min(limit, scene.objects.length)} objects -> ${path.relative(ROOT, output)}`);
}
main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
