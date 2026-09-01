#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadMapManifest } = require('../../tools/mapdraw/map-build-config');

const projectRoot = path.resolve(__dirname, '..', '..');
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const manifest=loadMapManifest(option('--manifest','configs/maps/livonia.json'));
const inventoryPath = path.join(projectRoot, 'out', 'mapdraw', `${manifest.world}-models.json`);
const cacheRoot = path.join(projectRoot, 'out', 'mapdraw', 'cache', manifest.world);
const statePath = path.join(cacheRoot, 'cache-state.json');
const tempRoot = path.join(cacheRoot, '.tmp');
function isInvisibleHelper(model){return /_ghost\d*\.p3d$/i.test(model)||/(?:^|\\)signs(?:_sakhal)?\\.*\\sign_decal_[^\\]+\.p3d$/i.test(model)||/(?:^|\\)plants_bliss\\building\\ivy_[^\\]+\.p3d$/i.test(model)}

const limit = Number(option('--limit', Infinity));
const size = Number(option('--size', 512));
const keepMlod = process.argv.includes('--keep-mlod');
const match = option('--match', null);
if (!(limit > 0) || !Number.isInteger(size) || size < 64 || size > 4096) {
  throw new Error('Usage: build-model-cache.js [--limit N] [--size 64..4096] [--keep-mlod]');
}

function cacheKey(model) {
  const base = path.win32.basename(model, '.p3d').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  return `${base}-${crypto.createHash('sha1').update(model).digest('hex').slice(0, 10)}`;
}

function saveState(state) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  try{fs.renameSync(temporaryPath,statePath)}catch(error){
    if(error.code!=='EPERM'&&error.code!=='EACCES')throw error;
    fs.copyFileSync(temporaryPath,statePath);fs.rmSync(temporaryPath,{force:true});
  }
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

if (!fs.existsSync(inventoryPath)) throw new Error(`Inventory not found: ${inventoryPath}`);
fs.mkdirSync(cacheRoot, { recursive: true });
fs.mkdirSync(tempRoot, { recursive: true });
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const priorState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
const state = priorState || {
  schemaVersion: 1,
  world: manifest.world,
  imageSize: size,
  inventoryCount: inventory.uniqueModelCount,
  models: {},
};
if (state.imageSize !== size) throw new Error(`Existing cache uses ${state.imageSize}px; requested ${size}px.`);
const sharedStates=[];
const cacheParent=path.dirname(cacheRoot);
if(fs.existsSync(cacheParent))for(const entry of fs.readdirSync(cacheParent,{withFileTypes:true})){
  const candidate=path.join(cacheParent,entry.name,'cache-state.json');
  if(entry.isDirectory()&&entry.name!==manifest.world&&fs.existsSync(candidate))sharedStates.push(JSON.parse(fs.readFileSync(candidate,'utf8')));
}

const mapdrawDir = path.join(__dirname, '..', '..', 'tools', 'mapdraw');
const debinScript = path.join(mapdrawDir, 'debin-model.js');
const renderScript = path.join(mapdrawDir, 'render-model-top.js');
const selected = inventory.models.filter(item=>!match||item.model.toLowerCase().includes(match.toLowerCase())).slice(0, Number.isFinite(limit) ? limit : undefined);
let completedThisRun = 0;
let skipped = 0;
let failed = 0;

for (let index = 0; index < selected.length; index += 1) {
  const item = selected[index];
  const key = cacheKey(item.model);
  const outputDir = path.join(cacheRoot, key);
  const imagePath = path.join(outputDir, 'top.png');
  const metadataPath = path.join(outputDir, 'top.json');
  const mlodPath = path.join(tempRoot, `${key}.p3d`);
  const sourcePath = path.join(manifest.assetRoot, ...item.model.split('\\'));
  if(isInvisibleHelper(item.model)){
    state.models[item.model]={status:'ignored',key,placementCount:item.count,reason:'invisible ghost/helper model'};
    saveState(state);skipped++;continue;
  }
  if(!state.models[item.model]){
    const shared=sharedStates.map(candidate=>candidate.models?.[item.model]).find(entry=>entry?.status==='complete'&&fs.existsSync(path.resolve(projectRoot,entry.image))&&fs.existsSync(path.resolve(projectRoot,entry.metadata)));
    if(shared)state.models[item.model]={...shared,placementCount:item.count,reusedFromSharedCache:true};
  }
  const cached=state.models[item.model],cachedImage=cached?.image?path.resolve(projectRoot,cached.image):imagePath,cachedMetadata=cached?.metadata?path.resolve(projectRoot,cached.metadata):metadataPath;
  if (cached?.status === 'complete' && fs.existsSync(cachedImage) && fs.existsSync(cachedMetadata)) {
    const metadata = JSON.parse(fs.readFileSync(cachedMetadata, 'utf8'));
    if (metadata.model !== item.model) {
      metadata.model = item.model;
      metadata.sourcePath = sourcePath;
      fs.writeFileSync(cachedMetadata, `${JSON.stringify(metadata, null, 2)}\n`);
    }
    skipped += 1;
    continue;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const started = Date.now();
  process.stdout.write(`[${index + 1}/${selected.length}] ${item.model} ... `);
  try {
    if (!fs.existsSync(sourcePath)) throw new Error(`Source not found: ${sourcePath}`);
    const conversion = run(debinScript, [sourcePath, mlodPath]);
    let render;
    if(conversion.status!==0&&/\\roads\\panels\\panels?_concrete(?:_(?:1|2|dam))?(?:_lc|_legacy)?\.p3d$/i.test(item.model)){
      render=run(path.join(mapdrawDir,'render-native-panel-top.js'),[sourcePath,imagePath,String(size)]);
    }else{
      if (conversion.status !== 0) throw new Error(`debin failed: ${(conversion.stderr || conversion.stdout).trim()}`);
      render = run(renderScript, [mlodPath, imagePath, String(size)]);
    }
    if (render.status !== 0) throw new Error(`render failed: ${(render.stderr || render.stdout).trim()}`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.model = item.model;
    metadata.sourcePath = sourcePath;
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    state.models[item.model] = {
      status: 'complete', key, placementCount: item.count,
      image: path.relative(projectRoot, imagePath),
      metadata: path.relative(projectRoot, metadataPath),
      triangles: metadata.triangles,
      widthMeters: metadata.widthMeters,
      heightMeters: metadata.heightMeters,
      durationMs: Date.now() - started,
    };
    completedThisRun += 1;
    console.log(`ok (${state.models[item.model].durationMs}ms)`);
  } catch (error) {
    state.models[item.model] = {
      status: 'failed', key, placementCount: item.count,
      error: error.message.slice(0, 8000), durationMs: Date.now() - started,
    };
    failed += 1;
    console.log(`FAILED: ${error.message.split(/\r?\n/)[0]}`);
  } finally {
    if (!keepMlod && fs.existsSync(mlodPath)) fs.rmSync(mlodPath);
    state.updatedUtc = new Date().toISOString();
    state.summary = {
      complete: Object.values(state.models).filter((entry) => entry.status === 'complete').length,
      failed: Object.values(state.models).filter((entry) => entry.status === 'failed').length,
      remaining: inventory.uniqueModelCount - Object.values(state.models).filter((entry) => entry.status === 'complete').length,
    };
    saveState(state);
  }
}

console.log(`Run complete: ${completedThisRun} rendered, ${skipped} cached, ${failed} failed.`);
console.log(`State: ${statePath}`);
