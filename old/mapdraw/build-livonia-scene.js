// Builds the first transform-complete Livonia object scene by joining the exact
// XYZ/rotation records in mapgrouppos.xml to DeWrp's model paths. DeWrp rounded
// X/Z to whole metres, so the join key deliberately uses rounded coordinates.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { MAP_CONFIGS } = require('../map-config');
const { loadMapElevationGrid, sampleElevation } = require('../tiling/elevation');

const ROOT = path.resolve(__dirname, '..', '..');
const XML = path.join(ROOT, 'data', 'Livonia', 'mapgrouppos.xml');
const PLACEMENTS = path.join(ROOT, 'out', 'mapdraw', 'enoch-placements.ndjson');
const STATE = path.join(ROOT, 'out', 'mapdraw', 'cache', 'enoch', 'cache-state.json');
const OUTPUT = path.join(ROOT, 'out', 'mapdraw', 'enoch-scene.json');

function attrs(text) {
  const result = {};
  for (const match of text.matchAll(/(\w+)="([^"]*)"/g)) result[match[1]] = match[2];
  return result;
}

async function main() {
  const groups = [];
  const buckets = new Map();
  for (const match of fs.readFileSync(XML, 'utf8').matchAll(/<group\s+([^>]+)\/>/g)) {
    const a = attrs(match[1]);
    const pos = a.pos.split(/\s+/).map(Number);
    const rpy = a.rpy.split(/\s+/).map(Number);
    const group = { className: a.name, x: pos[0], elevation: pos[1], z: pos[2], pitch: rpy[0], roll: rpy[1], yaw: rpy[2] };
    groups.push(group);
    const key = `${Math.round(group.x)},${Math.round(group.z)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(group);
  }

  const input = readline.createInterface({ input: fs.createReadStream(PLACEMENTS), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line) continue;
    const p = JSON.parse(line);
    const candidates = buckets.get(`${p.x},${p.z}`);
    if (!candidates) continue;
    let best = null;
    let bestD2 = Infinity;
    for (const group of candidates) {
      if (group.model) continue;
      const d2 = (group.x - p.x) ** 2 + (group.z - p.z) ** 2;
      if (d2 < bestD2) { best = group; bestD2 = d2; }
    }
    if (best && bestD2 <= 0.55) { best.id = p.id; best.model = p.model; best.joinDistance = Math.sqrt(bestD2); }
  }

  const mapConfig = MAP_CONFIGS.livonia;
  const elev = loadMapElevationGrid(ROOT, mapConfig);
  const cache = JSON.parse(fs.readFileSync(STATE, 'utf8')).models;
  const modelMetadata = new Map();
  for (const [model, entry] of Object.entries(cache)) {
    if (entry.status !== 'complete') continue;
    modelMetadata.set(model, JSON.parse(fs.readFileSync(path.join(ROOT, entry.metadata), 'utf8')));
  }
  const objects = groups.filter(g => g.model && cache[g.model]?.status === 'complete').map(g => {
    const c = cache[g.model];
    const meta = modelMetadata.get(g.model);
    return {
      ...g,
      terrainElevation: sampleElevation(elev, g.x, g.z),
      cacheKey: c.key,
      image: c.image.replaceAll('\\', '/'),
      widthMeters: c.widthMeters,
      heightMeters: c.heightMeters,
      metersPerPixel: meta.metersPerPixel,
      bounds: meta.bounds,
    };
  });
  const result = {
    schemaVersion: 1,
    map: 'livonia',
    mapSize: mapConfig.mapSize,
    occlusion: 'objects are painter-sorted by absolute top elevation; per-pixel model height is the next refinement',
    sourceGroups: groups.length,
    joinedGroups: groups.filter(g => g.model).length,
    drawableObjects: objects.length,
    objects,
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(result));
  console.log(`[scene] ${result.joinedGroups}/${result.sourceGroups} groups joined; ${result.drawableObjects} drawable`);
  console.log(`[scene] ${path.relative(ROOT, OUTPUT)}`);
}

main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
