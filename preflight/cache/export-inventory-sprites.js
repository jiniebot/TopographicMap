#!/usr/bin/env node
// Publish only verified class/model mappings and already-rendered top-down sprites.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createHash } = require('crypto');
const ROOT = path.resolve(__dirname, '../..');
const normalize = value => String(value).replace(/\//g, '\\').replace(/^\\+/, '').toLowerCase();
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

async function exportSprites({ root = ROOT, mappings, runtime, output }) {
  const classes = new Map(), conflicts = new Set();
  const add = (name, model) => {
    if (!name || !model || name === 'class') return;
    name = name.toLowerCase(); model = normalize(model);
    if (classes.has(name) && classes.get(name) !== model) conflicts.add(name);
    classes.set(name, model);
  };
  if (runtime) for (const file of fs.readdirSync(runtime).filter(n => /^.*placement-row-\d+\.tsv$/.test(n)).sort()) {
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(runtime, file)), crlfDelay: Infinity });
    for await (const line of lines) { const [model, name] = line.split('\t', 2); add(name, model); }
  }
  if (mappings) for (const [name, model] of Object.entries(JSON.parse(fs.readFileSync(mappings, 'utf8')))) add(name, model);
  const models = new Map(), vectors = new Map();
  for (const world of ['chernarusplus', 'enoch', 'sakhal']) {
    const state = path.join(root, 'out/mapdraw/cache', world, 'cache-state.json');
    if (!fs.existsSync(state)) continue;
    for (const [model, entry] of Object.entries(JSON.parse(fs.readFileSync(state, 'utf8')).models)) {
      if (entry.status === 'complete' && !models.has(normalize(model))) models.set(normalize(model), entry);
    }
    const vectorState = path.join(root, 'out/mapdraw/vector-cache', world, 'cache-state.json');
    if (fs.existsSync(vectorState)) for (const [model, entry] of Object.entries(JSON.parse(fs.readFileSync(vectorState, 'utf8')).models)) {
      if (entry.status === 'complete' && !vectors.has(normalize(model))) vectors.set(normalize(model), entry);
    }
  }
  fs.mkdirSync(output, { recursive: true });
  const catalog = { schemaVersion: 1, classes: {}, sprites: {} };
  let bytes = 0;
  for (const [name, model] of [...classes].sort(([a], [b]) => a.localeCompare(b))) {
    if (conflicts.has(name)) continue;
    const entry = models.get(model);
    if (!entry) continue;
    const resolve = value => path.resolve(root, value.replace(/[\\/]/g, path.sep));
    const imagePath = resolve(entry.image), metaPath = resolve(entry.metadata);
    if (!fs.existsSync(imagePath) || !fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')), b = meta.bounds;
    if (!b || !['minX','maxX','minY','maxY','minZ','maxZ'].every(k => Number.isFinite(b[k])) || !(meta.metersPerPixel > 0) || !(meta.imageSize > 0 && meta.imageSize <= 1024)) continue;
    const image = fs.readFileSync(imagePath);
    let geometry = null;
    const vector = vectors.get(model);
    if (vector && fs.existsSync(resolve(vector.footprint))) {
      const candidate = JSON.parse(fs.readFileSync(resolve(vector.footprint), 'utf8')).geometry;
      const points = candidate?.type === 'MultiPolygon' ? candidate.coordinates.flat(2) : [];
      if (points.length && points.length <= 20000 && points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) geometry = candidate;
    }
    // ID covers pixels AND origin/scale, so either change invalidates all caches.
    const id = digest(Buffer.concat([image, Buffer.from(JSON.stringify({meta,geometry}))]));
    if (!catalog.sprites[id]) {
      catalog.sprites[id] = { image: `${id}.png`, model, topographic: geometry ? `${id}.json` : null, vertices: geometry ? geometry.coordinates.flat(2).length : 0, width: meta.imageSize, height: meta.imageSize, metersPerPixel: meta.metersPerPixel, bounds: b };
      const target = path.join(output, `${id}.png`);
      if (!fs.existsSync(target)) fs.copyFileSync(imagePath, target);
      if (geometry) fs.writeFileSync(path.join(output, `${id}.json`), JSON.stringify(geometry));
      bytes += image.length;
    }
    catalog.classes[name] = { model, footprint: id, status: 'ready' };
  }
  if (!Object.keys(catalog.classes).length) throw Error('No verified classes with cached sprites');
  catalog.version = digest(JSON.stringify(catalog));
  const temporary = path.join(output, `catalog.${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(catalog));
  fs.renameSync(temporary, path.join(output, 'catalog.json'));
  return { version: catalog.version, classes: Object.keys(catalog.classes).length, sprites: Object.keys(catalog.sprites).length, bytes, conflicts: [...conflicts].sort() };
}
if (require.main === module) {
  const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  exportSprites({ mappings: option('--classes'), runtime: option('--runtime'), output: path.resolve(option('--out') || path.join(ROOT, 'out/mapdraw/inventory-sprites')) })
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { exportSprites };
