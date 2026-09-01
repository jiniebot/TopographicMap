#!/usr/bin/env node

// Resumable unique-model cache for topographic vector footprints.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { openTransformIndex } = require('./transform-index');
const { loadMapManifest, resolveStoredPath } = require('./map-build-config');

const ROOT = path.resolve(__dirname, '..', '..');
function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const manifestArg=option('--manifest','configs/maps/livonia.json');
const manifest=loadMapManifest(manifestArg);
const inventoryPath = path.join(ROOT, 'out', 'mapdraw', `${manifest.world}-models.json`);
const cacheRoot = path.join(ROOT, 'out', 'mapdraw', 'vector-cache', manifest.world);
const statePath = path.join(cacheRoot, 'cache-state.json');
const tempRoot = path.join(cacheRoot, '.tmp');
function isInvisibleHelper(model){return /_ghost\d*\.p3d$/i.test(model)||/(?:^|\\)signs(?:_sakhal)?\\.*\\sign_decal_[^\\]+\.p3d$/i.test(model)||/(?:^|\\)plants_bliss\\building\\ivy_[^\\]+\.p3d$/i.test(model)}
function allowsRasterRecovery(model){return !/(?:^|\\)clutter(?:\\|$)/i.test(model)&&!isInvisibleHelper(model)}
const rasterStatePath=path.join(ROOT,'out','mapdraw','cache',manifest.world,'cache-state.json');
const rasterState=fs.existsSync(rasterStatePath)?JSON.parse(fs.readFileSync(rasterStatePath,'utf8')):null;
function keyFor(model) {
  const base = path.win32.basename(model, '.p3d').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  return `${base}-${crypto.createHash('sha1').update(model).digest('hex').slice(0, 10)}`;
}
function run(script, args) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000,
  });
}
function save(state) {
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  try{fs.renameSync(temp,statePath)}catch(error){
    if(error.code!=='EPERM'&&error.code!=='EACCES')throw error;
    fs.copyFileSync(temp,statePath);fs.rmSync(temp,{force:true});
  }
}

const limit = Number(option('--limit', Infinity));
const match = option('--match', null);
const section = option('--section', null);
const retryFailed = process.argv.includes('--retry-failed');
const onlyFailed = process.argv.includes('--only-failed');
if (!(limit > 0)) throw new Error('Usage: build-vector-model-cache.js [--limit N]');
if (!fs.existsSync(inventoryPath)) throw new Error(`Inventory not found: ${inventoryPath}`);
fs.mkdirSync(cacheRoot, { recursive: true });
fs.mkdirSync(tempRoot, { recursive: true });

const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {
  schemaVersion: 1, world: manifest.world, inventoryCount: inventory.uniqueModelCount, models: {},
};
const sharedStates=[];
const cacheParent=path.dirname(cacheRoot);
if(fs.existsSync(cacheParent))for(const entry of fs.readdirSync(cacheParent,{withFileTypes:true})){
  const candidate=path.join(cacheParent,entry.name,'cache-state.json');
  if(entry.isDirectory()&&entry.name!==manifest.world&&fs.existsSync(candidate))sharedStates.push(JSON.parse(fs.readFileSync(candidate,'utf8')));
}
let requiredModels = null;
if (section) {
  const values = section.split(',').map(Number);
  if (values.length !== 3 || !values.every(Number.isFinite) || values[2] <= 0) throw new Error('--section must be x,z,meters');
  const [cx, cz, meters] = values, half = meters / 2;
  const index = openTransformIndex(manifest.transformIndex);
  const tileWorld = index.meta.mapSize / index.meta.side;
  const tx0 = Math.max(0, Math.floor((cx-half)/tileWorld)-1), tx1 = Math.min(index.meta.side-1, Math.floor((cx+half)/tileWorld)+1);
  const ty0 = Math.max(0, Math.floor((index.meta.mapSize-(cz+half))/tileWorld)-1), ty1 = Math.min(index.meta.side-1, Math.floor((index.meta.mapSize-(cz-half))/tileWorld)+1);
  requiredModels = new Set();
  const seen = new Set();
  for (let ty=ty0;ty<=ty1;ty++) for(let tx=tx0;tx<=tx1;tx++) for(const recordIndex of index.membersForTile(tx,ty)) {
    if (seen.has(recordIndex)) continue; seen.add(recordIndex);
    const record=index.readRecord(recordIndex), modelInfo=index.meta.models[record.modelIndex];
    const radius=Math.hypot(modelInfo.widthMeters||0,modelInfo.heightMeters||0)/2;
    if(record.x+radius>=cx-half&&record.x-radius<=cx+half&&record.z+radius>=cz-half&&record.z-radius<=cz+half) requiredModels.add(modelInfo.model);
  }
  console.log(`Section requires ${requiredModels.size} unique models (${cx}, ${cz}, ${meters}m)`);
}
const selected = inventory.models.filter(item => (!match || item.model.toLowerCase().includes(match.toLowerCase())) && (!requiredModels || requiredModels.has(item.model)) && (!onlyFailed || state.models[item.model]?.status==='failed'))
  .slice(0, Number.isFinite(limit) ? limit : undefined);
let completed = 0, skipped = 0, skippedFailed = 0, failed = 0;

for (let i = 0; i < selected.length; i++) {
  const item = selected[i];
  const key = keyFor(item.model);
  const dir = path.join(cacheRoot, key);
  const footprint = path.join(dir, 'footprint.geojson');
  const mlod = path.join(tempRoot, `${key}-${process.pid}.p3d`);
  const lock = path.join(dir, '.extract.lock');
  const source = path.join(manifest.assetRoot, ...item.model.split('\\'));
  if(isInvisibleHelper(item.model)){
    state.models[item.model]={status:'ignored',key,placementCount:item.count,reason:'invisible ghost/helper model'};
    state.updatedUtc=new Date().toISOString();save(state);skipped++;continue;
  }
  if(!state.models[item.model]){
    const shared=sharedStates.map(candidate=>candidate.models?.[item.model]).find(entry=>entry?.status==='complete'&&fs.existsSync(path.resolve(ROOT,entry.footprint)));
    if(shared)state.models[item.model]={...shared,placementCount:item.count,reusedFromSharedCache:true};
  }
  const cachedFootprint=state.models[item.model]?.footprint?path.resolve(ROOT,state.models[item.model].footprint):footprint;
  if (state.models[item.model]?.status === 'complete' && fs.existsSync(cachedFootprint)) { skipped++; continue; }
  if (state.models[item.model]?.status === 'failed' && !retryFailed) { skippedFailed++; continue; }
  if(state.models[item.model]?.status==='failed'&&retryFailed&&/debin failed:/i.test(state.models[item.model].error||'')&&rasterState?.models?.[item.model]?.status!=='complete'){
    skippedFailed++;continue;
  }
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  process.stdout.write(`[${i + 1}/${selected.length}] ${item.model} ... `);
  let lockFd = null;
  try {
    try { lockFd=fs.openSync(lock,'wx'); }
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      const deadline=Date.now()+125000;
      while(Date.now()<deadline&&!fs.existsSync(footprint))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
      if(!fs.existsSync(footprint))throw new Error('Timed out waiting for concurrent model extraction');
      const feature=JSON.parse(fs.readFileSync(footprint,'utf8'));
      state.models[item.model]={status:'complete',key,placementCount:item.count,footprint:path.relative(ROOT,footprint),polygons:feature.properties.polygonCount,vertices:feature.properties.vertexCount,minY:feature.properties.minY,maxY:feature.properties.maxY,durationMs:Date.now()-started,reusedConcurrentExtraction:true};
      completed++;console.log('ok (reused concurrent extraction)');continue;
    }
    const priorFailure=state.models[item.model]?.status==='failed';
    const priorRaster=rasterState?.models?.[item.model];
    const priorRasterImage=priorRaster?.image?resolveStoredPath(ROOT,priorRaster.image):null;
    const priorRasterMetadata=priorRaster?.metadata?resolveStoredPath(ROOT,priorRaster.metadata):null;
    if(retryFailed&&priorFailure&&allowsRasterRecovery(item.model)&&priorRaster?.status==='complete'&&fs.existsSync(priorRasterImage)&&fs.existsSync(priorRasterMetadata)){
      const recovery=run('extract-raster-footprint.js',[priorRasterImage,priorRasterMetadata,footprint]);
      if(recovery.status!==0)throw new Error(`raster recovery failed: ${(recovery.stderr||recovery.stdout).trim()}`);
      const feature=JSON.parse(fs.readFileSync(footprint,'utf8'));feature.properties.model=item.model;feature.properties.source=source;fs.writeFileSync(footprint,`${JSON.stringify(feature)}\n`);
      state.models[item.model]={status:'complete',key,placementCount:item.count,footprint:path.relative(ROOT,footprint),polygons:feature.properties.polygonCount,vertices:feature.properties.vertexCount,minY:feature.properties.minY,maxY:feature.properties.maxY,durationMs:Date.now()-started,recoveredFromRaster:true};
      completed++;console.log(`ok (raster recovery, ${feature.properties.vertexCount} vertices)`);continue;
    }
    if (!fs.existsSync(source)) throw new Error(`Source not found: ${source}`);
    const conversion = run('debin-model.js', [source, mlod]);
    if (conversion.status !== 0) throw new Error(`debin failed: ${(conversion.stderr || conversion.stdout).trim()}`);
    const extractionArgs=[mlod,footprint];
    if(/(?:^|\\)plants(?:\\|$)/i.test(item.model))extractionArgs.push('--force-convex-hull');
    const extraction = run('extract-model-footprint.js', extractionArgs);
    if (extraction.status !== 0) {
      const raster=rasterState?.models?.[item.model];
      const rasterImage=raster?.image?resolveStoredPath(ROOT,raster.image):null;
      const rasterMetadata=raster?.metadata?resolveStoredPath(ROOT,raster.metadata):null;
      if(allowsRasterRecovery(item.model)&&raster?.status==='complete'&&fs.existsSync(rasterImage)&&fs.existsSync(rasterMetadata)){
        const recovery=run('extract-raster-footprint.js',[rasterImage,rasterMetadata,footprint]);
        if(recovery.status!==0)throw new Error(`extract failed: ${(extraction.stderr||extraction.stdout).trim()}\nraster recovery failed: ${(recovery.stderr||recovery.stdout).trim()}`);
      }else throw new Error(`extract failed: ${(extraction.stderr || extraction.stdout).trim()}`);
    }
    const feature = JSON.parse(fs.readFileSync(footprint, 'utf8'));
    feature.properties.model = item.model;
    feature.properties.source = source;
    fs.writeFileSync(footprint, `${JSON.stringify(feature)}\n`);
    state.models[item.model] = {
      status: 'complete', key, placementCount: item.count,
      footprint: path.relative(ROOT, footprint), polygons: feature.properties.polygonCount,
      vertices: feature.properties.vertexCount, minY: feature.properties.minY,
      maxY: feature.properties.maxY, durationMs: Date.now() - started,
    };
    completed++; console.log(`ok (${state.models[item.model].vertices} vertices, ${state.models[item.model].durationMs}ms)`);
  } catch (error) {
    state.models[item.model] = { status: 'failed', key, placementCount: item.count, error: error.message.slice(0, 8000), durationMs: Date.now() - started };
    failed++; console.log(`FAILED: ${error.message.split(/\r?\n/)[0]}`);
  } finally {
    if(lockFd!==null){fs.closeSync(lockFd);fs.rmSync(lock,{force:true})}
    if (fs.existsSync(mlod)) fs.rmSync(mlod);
    state.updatedUtc = new Date().toISOString();
    state.summary = {
      complete: Object.values(state.models).filter(v => v.status === 'complete').length,
      failed: Object.values(state.models).filter(v => v.status === 'failed').length,
      remaining: inventory.uniqueModelCount - Object.values(state.models).filter(v => v.status === 'complete').length,
    };
    save(state);
  }
}
console.log(`Run complete: ${completed} extracted, ${skipped} cached, ${skippedFailed} known failures skipped, ${failed} failed.`);
console.log(`State: ${statePath}`);
