import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
// Shared by every map manifest (configs/maps/*.json all set assetRoot to
// this same value) - the single DayZ asset tree that remote render workers
// need read access to (WRP/RVMAT/PAA/P3D). Served read-only, by relative
// path, so a remote worker never needs a raw network drive mount.
const ASSET_ROOT = path.resolve(process.env.DAYZ_ASSET_ROOT || 'P:\\');
const jobs = new Map();
const objectInspectionCache = new Map();
const manifestsDir = path.join(__dirname, 'configs', 'maps');
const stylesDir = path.join(__dirname, 'configs', 'styles');
const finalRoot = path.join(__dirname, 'out', 'mapdraw', 'final');
const finalStateFile = path.join(finalRoot, 'active-versions.json');
const currentSurfaceVersion = 'terrainx-effective-six-channel-palette-v18';
const finalJobsFile = path.join(finalRoot, 'jobs.json');
const jobProcesses = new Map();
// Distributed render pool (separate from the local final-build job system
// above - deliberately decoupled so this stays zero-risk to a currently
// running local build). One active distributed job at a time, tasks leased
// out to registered workers, results written to the same out/mapdraw/final
// layout local builds use so the normal tile-serving routes and viewer
// don't need to know or care where a tile actually came from.
const poolWorkers = new Map(); // workerId -> { id, label, joinedAt, lastSeen }
const distributedJobs = new Map(); // jobId -> job record (see createDistributedJob)
// Rolling feed of the most recently completed tiles across all jobs/maps,
// for the "recent tiles" reviewer panel - lets someone watch tiles land as
// remote workers finish them, to spot-check a machine's output visually
// instead of only trusting the pool's pass/fail counts.
const RECENT_TILES_LIMIT = 60;
const recentTiles = [];
// Low-zoom tiles cover far more area (4x per zoom level down) and can
// genuinely take several minutes on a dense map - a flat timeout tuned for
// fast high-zoom tiles was killing legitimately-slow low-zoom renders and
// marking them "broken" after repeated false-timeout failures. Lease time
// must stay ahead of the agent's own matching per-zoom timeout (see
// render-pool-agent.js) so an agent kills and retries a genuinely slow
// task itself before the coordinator reassigns it out from under it.
// Kept ~1 minute above render-pool-agent.js's agentTimeoutMsForZoom, same
// margin as before - see that function for why these were widened.
function poolLeaseMsForZoom(zoom) {
  if (zoom <= 1) return 26 * 60 * 1000;
  if (zoom === 2) return 19 * 60 * 1000;
  if (zoom === 3) return 15 * 60 * 1000;
  if (zoom === 4) return 11 * 60 * 1000;
  if (zoom === 5) return 9 * 60 * 1000;
  return 7 * 60 * 1000;
}
const POOL_MAX_FAILURES = 3;
// A worker's lastSeen only updates on lease/complete/fail - there's no
// separate heartbeat - so a worker legitimately grinding through one long
// task (z1 tasks can now run up to 25 minutes, see agentTimeoutMsForZoom in
// render-pool-agent.js) goes quiet for the whole duration. This was 2
// minutes, tuned back when tasks finished in seconds; it was hiding busy,
// perfectly healthy workers from the active list (and their tile counts)
// well before they'd actually gone stale. Set comfortably above the
// longest legitimate single-task duration.
const POOL_WORKER_STALE_MS = 30 * 60 * 1000;
const WORKER_PACKAGE_ZIP = path.join(__dirname, 'out', 'mapdraw', 'worker-package', 'dayz-render-worker.zip');
let workerPackageJob = null; // { status: 'building'|'ready'|'failed', progress: string[], startedAt, finishedAt, error, sizeBytes }
function activeWorkers() {
  const cutoff = Date.now() - POOL_WORKER_STALE_MS;
  return [...poolWorkers.values()].filter(w => new Date(w.lastSeen).getTime() >= cutoff);
}
function activeDistributedJob() {
  for (const job of distributedJobs.values()) if (job.status === 'running') return job;
  return null;
}
function createDistributedJob({ mapId, manifest, zooms, modes, version }) {
  const tasks = [];
  let skipped = 0;
  for (const zoom of zooms) {
    const side = 2 ** zoom;
    for (let ty = 0; ty < side; ty++) for (let tx = 0; tx < side; tx++) {
      const task = { id: `${zoom}-${tx}-${ty}`, zoom, tx, ty, modes, status: 'pending', leaseWorkerId: null, leaseExpires: 0, failures: 0 };
      // Resuming into an existing version (e.g. one a local final-build job
      // was already partway through, or a prior distributed run) - skip
      // tiles whose mandatory output already exists instead of re-rendering
      // work that's already done, the same way the local build's --resume
      // does via render-state.json.
      if (mandatoryTargetsExist(mapId, version, task)) { task.status = 'complete'; skipped++; }
      tasks.push(task);
    }
  }
  const job = { id: randomUUID(), mapId, manifestFile: manifest.manifest, manifestPath: path.join(manifestsDir, manifest.manifest), zooms, modes, version, tasks, status: 'running', createdAt: new Date().toISOString(), skippedAlreadyDone: skipped, recentCompletions: [] };
  distributedJobs.set(job.id, job);
  finalizeDistributedJobIfComplete(job);
  return job;
}
function poolTaskOutputTargets(job, task) {
  return poolTaskOutputTargetsFor(job.mapId, job.version, task);
}
function poolTaskOutputTargetsFor(mapId, version, task) {
  const targets = [];
  if (task.modes.includes('satellite')) targets.push({ file: 'satellite', path: path.join(finalRoot, mapId, version, 'satellite', String(task.zoom), String(task.tx), `${task.ty}.png`) });
  if (task.modes.includes('topographic'))
    for (const layer of ['terrain', 'surfaces', 'water', 'objects'])
      targets.push({ file: layer, path: path.join(finalRoot, mapId, version, 'topographic', layer, String(task.zoom), String(task.tx), `${task.ty}.pbf`) });
  return targets;
}
// 'surfaces' is deliberately not mandatory: a tile with no TerrainX
// material data in its footprint (e.g. open sea/ice) legitimately produces
// no surfaces.pbf at all - that's a valid empty result, not a failure, and
// treating it as required would make such a tile fail every retry forever.
const POOL_MANDATORY_FILES = new Set(['satellite', 'terrain']);
function mandatoryTargetsExist(mapId, version, task) {
  return poolTaskOutputTargetsFor(mapId, version, task).filter(t => POOL_MANDATORY_FILES.has(t.file)).every(t => fs.existsSync(t.path));
}
function finalizeDistributedJobIfComplete(job) {
  if (job.tasks.some(t => t.status !== 'complete' && t.status !== 'broken')) return;
  job.status = job.tasks.some(t => t.status === 'broken') ? 'complete-with-errors' : 'complete';
  const state = readFinalState(); state.maps = state.maps || {};
  const prior = state.maps[job.mapId]?.version === job.version ? state.maps[job.mapId] : null, coverage = { ...(prior?.coverage || {}) };
  for (const mode of job.modes) coverage[mode] = [...new Set([...(coverage[mode] || []), ...job.zooms])].sort((a, b) => a - b);
  state.maps[job.mapId] = { version: job.version, updatedAt: new Date().toISOString(), modes: Object.keys(coverage), zooms: [...new Set(Object.values(coverage).flat())].sort((a, b) => a - b), coverage };
  writeFinalState(state);
}
const ETA_WINDOW_MS = 10 * 60 * 1000;
function jobSummary(job) {
  const counts = { pending: 0, leased: 0, complete: 0, broken: 0 };
  for (const task of job.tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  // Rolling-window throughput, not an all-time average: worker count and
  // per-tile cost both drift over a run (zoom mix changes, machines join/
  // leave), so recent completions predict what's coming next far better
  // than "total complete / time since job started" would.
  const now = Date.now();
  if (job.recentCompletions) while (job.recentCompletions.length && now - job.recentCompletions[0] > ETA_WINDOW_MS) job.recentCompletions.shift();
  const remaining = counts.pending + counts.leased;
  let etaSeconds = null, tilesPerMinute = null;
  if (job.recentCompletions?.length >= 3) {
    const elapsedSeconds = Math.max(1, (now - job.recentCompletions[0]) / 1000);
    const rate = job.recentCompletions.length / elapsedSeconds;
    tilesPerMinute = rate * 60;
    if (rate > 0) etaSeconds = remaining / rate;
  }
  return { id: job.id, mapId: job.mapId, zooms: job.zooms, modes: job.modes, version: job.version, status: job.status, totalTasks: job.tasks.length, skippedAlreadyDone: job.skippedAlreadyDone || 0, counts, createdAt: job.createdAt, tilesPerMinute, etaSeconds };
}
function publicJob(job){const value={...job};delete value.lastRendererError;return value}
function persistJobs(){fs.mkdirSync(finalRoot,{recursive:true});const temp=`${finalJobsFile}.${process.pid}.tmp`;fs.writeFileSync(temp,`${JSON.stringify([...jobs.values()].filter(j=>j.type==='final-build').slice(-30).map(publicJob),null,2)}\n`);try{fs.renameSync(temp,finalJobsFile)}catch{fs.copyFileSync(temp,finalJobsFile);fs.rmSync(temp,{force:true})}}
try{for(const job of JSON.parse(fs.readFileSync(finalJobsFile,'utf8'))){if(job.status==='running'){job.status='interrupted';job.error='Server restarted. Retry will resume completed tiles.';job.finishedAt=new Date().toISOString()}jobs.set(job.id,job)}persistJobs()}catch{}

// For layers:'auto' requests - scans disk (not render-state.json, which can
// mark a tile "complete" even when a non-mandatory layer like water was
// never written for it - see POOL_MANDATORY_FILES) to find which
// topographic layers actually have at least one missing tile within the
// requested zoom range for a map. Early-exits per layer on first miss found.
function missingLayersForMap(mapId, version, zooms) {
  const root = path.join(finalRoot, mapId, version, 'topographic');
  const missingLayers = [];
  for (const layer of ['terrain', 'surfaces', 'water', 'objects']) {
    let missing = false;
    for (const zoom of zooms) {
      const side = 2 ** zoom;
      for (let ty = 0; ty < side && !missing; ty++)
        for (let tx = 0; tx < side && !missing; tx++)
          if (!fs.existsSync(path.join(root, layer, String(zoom), String(tx), `${ty}.pbf`))) missing = true;
      if (missing) break;
    }
    if (missing) missingLayers.push(layer);
  }
  return missingLayers;
}
// Counts distinct (zoom,tx,ty) tiles where at least one of the given layers
// is absent - the same "any forced layer missing" test build-final-zoom.js's
// --missing-only applies, so this matches the real task count a repair run
// will actually process for this map, not the full tile pyramid size.
function missingTileCountForMap(mapId, version, zooms, layers) {
  if (!layers.length) return 0;
  const root = path.join(finalRoot, mapId, version, 'topographic');
  let count = 0;
  for (const zoom of zooms) {
    const side = 2 ** zoom;
    for (let ty = 0; ty < side; ty++)
      for (let tx = 0; tx < side; tx++)
        if (layers.some((layer) => !fs.existsSync(path.join(root, layer, String(zoom), String(tx), `${ty}.pbf`)))) count++;
  }
  return count;
}

function readFinalState() {
  try { return JSON.parse(fs.readFileSync(finalStateFile, 'utf8')); } catch { return { schemaVersion: 1, maps: {} }; }
}
function writeFinalState(state) {
  fs.mkdirSync(finalRoot, { recursive: true });
  fs.writeFileSync(finalStateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function availableMaps() {
  if (!fs.existsSync(manifestsDir)) return [];
  return fs.readdirSync(manifestsDir).filter(name => name.endsWith('.json')).map(name => {
    const manifestPath = path.join(manifestsDir, name);
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const activeFinal=readFinalState().maps?.[value.id]||null;
    return { id: value.id, displayName: value.displayName || value.id, world: value.world,
      mapSize: value.mapSize, coordinateSystem: value.coordinateSystem || { origin: 'southwest', xAxis: 'east', zAxis: 'north' },
      water: value.water || null, preview: value.preview || {}, web: value.web || {}, manifest: name,
      // Per-map TerrainX material list (e.g. en_*/cp_*/sakhal_* surface
      // texture keys) - lets style-editor UIs scope the surface color
      // picker to materials this specific map actually uses, instead of
      // showing the full cross-map union.
      materials: value.satellite?.materials || [],
      activeFinalVersion: activeFinal?.version || null, activeFinalCoverage: activeFinal?.coverage || {} };
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) reject(new Error('Request body too large')); else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) reject(new Error('Body too large')); else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function pointInGeometry(x, z, coordinates) {
  for (const polygon of coordinates) {
    if (!pointInRing(x, z, polygon[0])) continue;
    if (!polygon.slice(1).some(ring => pointInRing(x, z, ring))) return true;
  }
  return false;
}
function geometryBounds(coordinates) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of coordinates) for (const ring of polygon) for (const point of ring) {
    bounds[0] = Math.min(bounds[0], point[0]); bounds[1] = Math.min(bounds[1], point[1]);
    bounds[2] = Math.max(bounds[2], point[0]); bounds[3] = Math.max(bounds[3], point[1]);
  }
  return bounds;
}

async function handleApi(req, res, requestPath) {
  if (req.method === 'GET' && requestPath === '/api/map-render/maps') {
    sendJson(res, 200, { maps: availableMaps() }); return true;
  }
  if (req.method === 'GET' && requestPath === '/api/map-render/final-builds') {
    sendJson(res, 200, readFinalState()); return true;
  }
  if (req.method === 'GET' && requestPath === '/api/map-render/final-jobs') {
    sendJson(res,200,{jobs:[...jobs.values()].filter(job=>job.type==='final-build').slice(-20).reverse().map(publicJob)});return true;
  }
  if(req.method==='POST'&&requestPath==='/api/map-render/clear-tiles'){
    try{const body=await readBody(req),allMaps=availableMaps(),selectedMaps=body.maps==='all'?allMaps.map(map=>map.id):Array.isArray(body.maps)?body.maps:[],zooms=Array.isArray(body.zooms)?body.zooms.map(Number):[],modes=Array.isArray(body.modes)?body.modes:[],version=String(body.version||'').trim();
      if(!selectedMaps.length||selectedMaps.some(id=>!allMaps.some(map=>map.id===id)))throw new Error('Invalid map selection');if(!zooms.length||zooms.some(z=>!Number.isInteger(z)||z<0||z>8))throw new Error('Select one or more zoom levels');if(!modes.length||modes.some(mode=>!['satellite','topographic'].includes(mode)))throw new Error('Invalid mode selection');if(!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version))throw new Error('Invalid version');
      if([...jobs.values()].some(job=>job.status==='running'&&job.maps.some(id=>selectedMaps.includes(id))))throw new Error('Cancel the active render for this map before clearing tiles');
      const removed=[];for(const mapId of selectedMaps){const versionRoot=path.join(finalRoot,mapId,version);for(const zoom of zooms)for(const mode of modes){if(mode==='satellite'){const target=path.join(versionRoot,'satellite',String(zoom));if(fs.existsSync(target)){fs.rmSync(target,{recursive:true,force:true});removed.push(path.relative(__dirname,target))}}else for(const layer of ['terrain','surfaces','water','objects']){const target=path.join(versionRoot,'topographic',layer,String(zoom));if(fs.existsSync(target)){fs.rmSync(target,{recursive:true,force:true});removed.push(path.relative(__dirname,target))}}}
        const renderStateFile=path.join(versionRoot,'render-state.json');if(fs.existsSync(renderStateFile)){const state=JSON.parse(fs.readFileSync(renderStateFile,'utf8'));for(const key of Object.keys(state.completed||{})){const [zoom,,,mode]=key.split('/');if(zooms.includes(Number(zoom))&&modes.includes(mode))delete state.completed[key]}for(const key of Object.keys(state.failures||{})){const [zoom,,,mode]=key.split('/');if(zooms.includes(Number(zoom))&&(modes.includes(mode)||mode?.startsWith('layers:')))delete state.failures[key]}if(modes.includes('topographic'))for(const key of Object.keys(state.surfaceCompleted||{}))if(zooms.includes(Number(key.split('/')[0])))delete state.surfaceCompleted[key];fs.writeFileSync(renderStateFile,`${JSON.stringify(state,null,2)}\n`)}
      }
      const active=readFinalState();for(const mapId of selectedMaps){const entry=active.maps?.[mapId];if(entry?.version!==version)continue;entry.coverage=entry.coverage||{};for(const mode of modes)entry.coverage[mode]=(entry.coverage[mode]||[]).filter(z=>!zooms.includes(z));entry.modes=Object.keys(entry.coverage).filter(mode=>entry.coverage[mode]?.length);entry.zooms=[...new Set(Object.values(entry.coverage).flat())].sort((a,b)=>a-b);entry.updatedAt=new Date().toISOString()}writeFinalState(active);sendJson(res,200,{removed,maps:selectedMaps,zooms,modes,version});return true
    }catch(error){sendJson(res,400,{error:error.message});return true}
  }
  if (req.method === 'POST' && requestPath === '/api/map-render/final-build') {
    try {
      const body=await readBody(req),allMaps=availableMaps();
      const selectedMaps=body.maps==='all'?allMaps.map(map=>map.id):Array.isArray(body.maps)?body.maps:[];
      const zooms=body.zooms==='all'?[0,1,2,3,4,5,6,7,8]:Array.isArray(body.zooms)?body.zooms.map(Number):[];
      const modes=body.modes==='all'?['satellite','topographic']:Array.isArray(body.modes)?body.modes:[];
      const version=String(body.version||'').trim();
      const workers=Number(body.workers??6);
      const layersAuto=body.layers==='auto';
      const layers=layersAuto?[]:Array.isArray(body.layers)?body.layers:[];
      const missingOnly=Boolean(body.missingOnly);
      if(!selectedMaps.length||selectedMaps.some(id=>!allMaps.some(map=>map.id===id)))throw new Error('Invalid map selection');
      if(!zooms.length||zooms.some(z=>!Number.isInteger(z)||z<0||z>8))throw new Error('Invalid zoom selection');
      if(!modes.length||modes.some(mode=>!['satellite','topographic'].includes(mode)))throw new Error('Invalid mode selection');
      if(!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version))throw new Error('Version must use letters, numbers, dots, dashes, or underscores');
      if(!Number.isInteger(workers)||workers<1||workers>16)throw new Error('Concurrent renderers must be between 1 and 16');
      if(!layersAuto&&layers.some(layer=>!['terrain','surfaces','water','objects'].includes(layer)))throw new Error('Invalid topographic layer selection');
      if(!missingOnly&&!layersAuto&&layers.length&&(!modes.includes('topographic')||zooms.length!==1))throw new Error('Specific layer regeneration requires Topographic mode and one selected zoom level');
      if(!layersAuto&&layers.length&&!modes.includes('topographic'))throw new Error('Layer selection requires Topographic mode');
      if(layersAuto&&!missingOnly)throw new Error('layers:"auto" requires missingOnly');
      if(missingOnly&&!layersAuto&&!layers.length)throw new Error('missingOnly requires one or more selected layers, or layers:"auto"');
      if(layersAuto)modes.splice(0,modes.length,'topographic');
      fs.mkdirSync(finalRoot,{recursive:true});const disk=fs.statfsSync(finalRoot),freeBytes=disk.bavail*disk.bsize;if(freeBytes<2*1024**3)throw new Error(`Insufficient free disk space (${(freeBytes/1024**3).toFixed(1)} GiB available; 2 GiB minimum)`);
      if([...jobs.values()].some(job=>job.type==='final-build'&&job.status==='running'&&job.maps.some(id=>selectedMaps.includes(id))))throw new Error('A final build is already running for one of the selected maps');
      const state=readFinalState();
      for(const mapId of selectedMaps){
        const previous=state.maps?.[mapId]?.version;
        const resumableTarget=path.join(finalRoot,mapId,version,'render-state.json');
        if(previous&&previous!==version&&!fs.existsSync(resumableTarget)){
          const target=path.join(finalRoot,mapId);
          if(path.dirname(target)===finalRoot)fs.rmSync(target,{recursive:true,force:true});
        }
      }
      // For missingOnly jobs, plan each map's forced-layer set and its real
      // missing-tile count up front - the progress denominator and the
      // actual spawn args are derived from this same snapshot. Layers are
      // kept grouped into one build-final-zoom.js call per map (not split
      // per layer): build-topographic-preview.js always runs the full
      // per-tile pipeline (model footprint cache, surface vectorization,
      // object placement/water masking) regardless of which layer's output
      // is actually kept - that cost is paid once per tile no matter how
      // many layers you ask for, so grouping is free and splitting would
      // instead pay that cost again for every extra layer on a shared tile.
      // The real (and only) measure of work is DISTINCT TILES touched, i.e.
      // tiles missing at least one of the forced layers - not a per-layer
      // sum, which would double-count tiles missing more than one layer.
      const plannedLayersByMap={},plannedMissingByMap={};
      let missingOnlyTotal=0;
      if(missingOnly)for(const mapId of selectedMaps){
        const forceLayers=layersAuto?missingLayersForMap(mapId,version,zooms):layers;
        plannedLayersByMap[mapId]=forceLayers;
        const count=missingTileCountForMap(mapId,version,zooms,forceLayers);
        plannedMissingByMap[mapId]=count;
        missingOnlyTotal+=count;
      }
      const tileCount=zooms.reduce((sum,zoom)=>sum+4**zoom,0);
      const topoTotal=missingOnly?missingOnlyTotal:selectedMaps.length*tileCount;
      const byMode=Object.fromEntries(modes.map(mode=>[mode,{completed:0,total:mode==='topographic'?topoTotal:selectedMaps.length*tileCount}]));
      const id=randomUUID(),job={id,type:'final-build',maps:selectedMaps,zooms,modes,layers:layersAuto?'auto':layers,layersAuto,autoLayers:plannedLayersByMap,missingOnly,version,workers,status:'running',createdAt:new Date().toISOString(),progress:[],progressSummary:{completed:0,total:Object.values(byMode).reduce((n,v)=>n+v.total,0),byMode},current:null,workerStates:{},live:null,error:null};
      jobs.set(id,job);
      if(missingOnly&&!missingOnlyTotal){
        job.progress.push('[auto-missing] no missing topographic tiles found in the requested zoom range for any selected map - nothing to do');
        job.status='complete';job.finishedAt=new Date().toISOString();persistJobs();sendJson(res,202,publicJob(job));return true;
      }
      const mapsToProcess=missingOnly?selectedMaps.filter(mapId=>plannedMissingByMap[mapId]>0):selectedMaps;
      const queue=[...mapsToProcess];
      const runNext=()=>{
        const mapId=queue.shift();
        if(!mapId){
          const next=readFinalState();next.maps=next.maps||{};
          for(const id of selectedMaps){const prior=next.maps[id]?.version===version?next.maps[id]:null,coverage={...(prior?.coverage||{})};for(const mode of modes)coverage[mode]=[...new Set([...(coverage[mode]||[]),...zooms])].sort((a,b)=>a-b);next.maps[id]={version,updatedAt:new Date().toISOString(),modes:Object.keys(coverage),zooms:[...new Set(Object.values(coverage).flat())].sort((a,b)=>a-b),coverage}}
          writeFinalState(next);job.status='complete';job.finishedAt=new Date().toISOString();persistJobs();return;
        }
        const map=allMaps.find(item=>item.id===mapId);
        const forceLayers=missingOnly?plannedLayersByMap[mapId]:(layersAuto?missingLayersForMap(mapId,version,zooms):layers);
        if(missingOnly){
          job.progress.push(`[auto-missing] ${mapId}: repairing layers ${forceLayers.join(', ')} (${plannedMissingByMap[mapId]} tile${plannedMissingByMap[mapId]===1?'':'s'})`);
          if(job.progress.length>160)job.progress.shift();
        }
        const child=spawn(process.execPath,[path.join(__dirname,'tools','mapdraw','build-final-zoom.js'),'--manifest',path.join(manifestsDir,map.manifest),'--version',version,'--zooms',zooms.join(','),'--modes',modes.join(','),'--workers',String(workers),'--resume',...(forceLayers.length?['--layers',forceLayers.join(',')]:[]),...(missingOnly?['--missing-only']:[])],{cwd:__dirname,windowsHide:true});jobProcesses.set(job.id,child);
        let outputBuffer='';
        const consumeLine=line=>{
          if(!line)return;job.progress.push(line);if(job.progress.length>160)job.progress.shift();
          // For missingOnly jobs this line's resumedByMode counts every tile
          // already marked "topographic complete" in render-state.json -
          // nearly the whole pyramid, since that's the exact bookkeeping gap
          // this repair exists to fix (a tile can be marked complete with a
          // layer silently missing). That number is not repair progress, so
          // it's intentionally ignored here; completed only advances via
          // actual [final-layer] tile writes below.
          if(line.startsWith('@@FINAL_RESUME ')){if(missingOnly){persistJobs();return}try{const value=JSON.parse(line.slice(15));for(const [mode,count] of Object.entries(value.resumedByMode||{})){const prior=job.progressSummary.byMode[mode].completed;job.progressSummary.byMode[mode].completed=Math.max(prior,Number(count)||0)}job.progressSummary.completed=Object.values(job.progressSummary.byMode).reduce((n,v)=>n+v.completed,0)}catch{}persistJobs();return}
          if(line.startsWith('@@FINAL_STATUS ')){
            try{const value=JSON.parse(line.slice(15)),modeKey=value.mode==='satellite'?value.mode:modes.find(mode=>value.mode.includes(mode)),current={...value,tileCompleted:modeKey?job.progressSummary.byMode[modeKey].completed:job.progressSummary.completed,tileTotal:modeKey?job.progressSummary.byMode[modeKey].total:job.progressSummary.total,detail:'',updatedAt:new Date().toISOString()};job.workerStates[value.worker]=current;job.current=current;const preferredMode=modes.find(mode=>job.progressSummary.byMode[mode].completed<job.progressSummary.byMode[mode].total);if(modeKey&&modeKey===preferredMode)job.live={mapId:value.mapId,mode:modeKey,zoom:value.zoom,version,updatedAt:current.updatedAt}}catch{}return;
          }
          let childContext=null,childLine=line;if(line.startsWith('@@FINAL_CHILD ')){try{childContext=JSON.parse(line.slice(14));childLine=childContext.line}catch{return}}
          const current=childContext?job.workerStates[childContext.worker]:job.current;
          const workerCountLine=childLine.match(/^\[final-workers\]\s+(\d+)/);if(workerCountLine)job.workers=Number(workerCountLine[1]);
          if(/FATAL ERROR|heap out of memory/i.test(childLine))job.lastRendererError=childLine.trim();else if(!job.lastRendererError&&/Error:|failed with exit code/i.test(childLine))job.lastRendererError=childLine.trim();
          const complete=childLine.match(/^\[final-build\]\s+\S+\s+(satellite|topographic)\s+z\d+:/);if(complete){job.progressSummary.completed++;job.progressSummary.byMode[complete[1]].completed++;if(current){current.completed=current.total;current.detail='Tile written'}}
          if(complete)job.liveRevision=(job.liveRevision||0)+1;
          if(/^\[final-layer\]\s+/.test(childLine)){job.liveRevision=(job.liveRevision||0)+1;if(current){current.completed=current.total;current.detail='Selected layer tile written'}if(missingOnly){job.progressSummary.completed++;job.progressSummary.byMode.topographic.completed++}}
          const terrain=childLine.match(/^\[hires-terrain\]\s+row\s+(\d+)\/(\d+)/);if(terrain&&current){current.stage='terrain';current.label='Synthesizing satellite terrain and surface detail';current.completed=Number(terrain[1]);current.total=Number(terrain[2]);current.detail=`Raster row ${terrain[1]} of ${terrain[2]}`}
          if(/^\[hires-terrain\] wrote /.test(childLine)&&current&&current.stage==='terrain'){current.completed=current.total;current.detail='Terrain and surface raster complete'}
          const objects=childLine.match(/^\[hires-objects\]\s+(\d+)\/(\d+)/);if(objects&&current){current.stage='objects';current.label='Compositing all intersecting P3D objects';current.completed=Number(objects[1]);current.total=Math.max(1,Number(objects[2]));current.detail=`Object ${Number(objects[1]).toLocaleString()} of ${Number(objects[2]).toLocaleString()}`}
          if(/^\[hires-objects\] wrote /.test(childLine)&&current&&current.stage==='objects'){current.completed=current.total;current.detail='Object composite complete'}
          const topo=childLine.match(/^\[topo-stage\]\s+(\d+)\/(\d+)\s+(.+)/);if(topo&&current){current.stage='topographic';current.label=topo[3];current.completed=Number(topo[1]);current.total=Number(topo[2]);current.detail=`Topographic stage ${Number(topo[1])+1} of ${Number(topo[2])}`}
          const models=childLine.match(/^\[(\d+)\/(\d+)\]\s+(.+?)\s+\.\.\./);if(models&&current){current.stage='models';current.label='Preparing model footprints';current.completed=Number(models[1]);current.total=Number(models[2]);current.detail=models[3]}
          const required=childLine.match(/^Section requires\s+(\d+)\s+unique models/);if(required&&current){current.stage='models';current.label='Checking model footprint cache';current.completed=0;current.total=Math.max(1,Number(required[1]));current.detail=`${required[1]} unique models required`}
          const placed=childLine.match(/^([\d,]+) placed footprints -> ([\d,]+) render features/);if(placed&&current)current.detail=`${placed[1]} placements reduced to ${placed[2]} render features`;
          const blended=childLine.match(/^(\d+) blend signatures on (\d+)x(\d+) grid/);if(blended&&current)current.detail=`${Number(blended[1]).toLocaleString()} surface blends on ${blended[2]}×${blended[3]} samples`;
        };
        const consume=chunk=>{outputBuffer+=chunk.toString();const lines=outputBuffer.split(/\r?\n/);outputBuffer=lines.pop()||'';for(const line of lines)consumeLine(line)};
        child.stdout.on('data',consume);child.stderr.on('data',consume);
        child.on('error',error=>{job.status='failed';job.error=error.message;job.finishedAt=new Date().toISOString();persistJobs()});
        child.on('close',code=>{jobProcesses.delete(job.id);if(job.status==='cancelled'||job.status==='failed'){persistJobs();return}if(code!==0){job.status='failed';job.error=job.lastRendererError||`Final renderer exited with code ${code}`;job.finishedAt=new Date().toISOString();persistJobs();return}runNext();persistJobs()});
      };
      persistJobs();runNext();sendJson(res,202,publicJob(job));return true;
    }catch(error){sendJson(res,400,{error:error.message});return true}
  }
  if (req.method === 'POST' && requestPath === '/api/render-pool/jobs') {
    try {
      if (activeDistributedJob()) throw new Error('A distributed render job is already running');
      const body = await readBody(req), allMaps = availableMaps();
      const mapId = String(body.mapId || ''), zooms = Array.isArray(body.zooms) ? body.zooms.map(Number) : [], modes = Array.isArray(body.modes) ? body.modes : [], version = String(body.version || '').trim();
      const manifest = allMaps.find(m => m.id === mapId);
      if (!manifest) throw new Error('Invalid map selection');
      if (!zooms.length || zooms.some(z => !Number.isInteger(z) || z < 0 || z > 8)) throw new Error('Invalid zoom selection');
      if (!modes.length || modes.some(mode => !['satellite', 'topographic'].includes(mode))) throw new Error('Invalid mode selection');
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version)) throw new Error('Version must use letters, numbers, dots, dashes, or underscores');
      const job = createDistributedJob({ mapId, manifest, zooms, modes, version });
      sendJson(res, 202, { jobId: job.id, taskCount: job.tasks.length }); return true;
    } catch (error) { sendJson(res, 400, { error: error.message }); return true }
  }
  if (req.method === 'POST' && requestPath === '/api/render-pool/workers/join') {
    try {
      const body = await readBody(req), id = randomUUID(), label = String(body.label || id).slice(0, 80);
      // Labels are meant to be stable per logical worker slot (e.g.
      // "Local-3" reused across restarts) - drop any prior registration
      // under the same label so restarts/rejoins don't pile up ghost
      // entries under old workerIds forever.
      for (const [existingId, existing] of poolWorkers) if (existing.label === label) poolWorkers.delete(existingId);
      poolWorkers.set(id, { id, label, joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), currentTask: null, tasksCompleted: 0, tasksFailed: 0 });
      sendJson(res, 200, { workerId: id }); return true;
    } catch (error) { sendJson(res, 400, { error: error.message }); return true }
  }
  if (req.method === 'GET' && requestPath === '/api/render-pool/lease') {
    const workerId = new URL(req.url, 'http://localhost').searchParams.get('workerId'), worker = poolWorkers.get(workerId);
    if (!worker) { sendJson(res, 404, { error: 'Unknown worker - join first' }); return true; }
    worker.lastSeen = new Date().toISOString();
    const job = activeDistributedJob();
    if (!job) { sendJson(res, 200, { task: null }); return true; }
    const now = Date.now();
    const task = job.tasks.find(t => t.status === 'pending' || (t.status === 'leased' && t.leaseExpires < now));
    if (!task) { sendJson(res, 200, { task: null }); return true; }
    task.status = 'leased'; task.leaseWorkerId = workerId; task.leaseExpires = now + poolLeaseMsForZoom(task.zoom);
    worker.currentTask = { jobId: job.id, mapId: job.mapId, zoom: task.zoom, tx: task.tx, ty: task.ty, modes: task.modes, startedAt: new Date().toISOString() };
    sendJson(res, 200, { jobId: job.id, taskId: task.id, task: { zoom: task.zoom, tx: task.tx, ty: task.ty, modes: task.modes }, manifestFile: job.manifestFile }); return true;
  }
  const poolSubmitMatch = requestPath.match(/^\/api\/render-pool\/jobs\/([a-f0-9-]+)\/submit$/i);
  if (req.method === 'POST' && poolSubmitMatch) {
    try {
      const job = distributedJobs.get(poolSubmitMatch[1]);
      const params = new URL(req.url, 'http://localhost').searchParams, workerId = params.get('workerId'), taskId = params.get('taskId'), file = params.get('file');
      if (!job) throw new Error('Unknown job');
      const task = job.tasks.find(t => t.id === taskId);
      if (!task || task.status !== 'leased' || task.leaseWorkerId !== workerId) throw new Error('Task is not leased to this worker');
      const target = poolTaskOutputTargets(job, task).find(t => t.file === file);
      if (!target) throw new Error(`Unexpected file for this task's modes: ${file}`);
      const body = await readRawBody(req, 16 * 1024 * 1024);
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      fs.writeFileSync(target.path, body);
      sendJson(res, 200, { ok: true }); return true;
    } catch (error) { sendJson(res, 400, { error: error.message }); return true }
  }
  const poolCompleteMatch = requestPath.match(/^\/api\/render-pool\/jobs\/([a-f0-9-]+)\/complete$/i);
  if (req.method === 'POST' && poolCompleteMatch) {
    const job = distributedJobs.get(poolCompleteMatch[1]);
    const params = new URL(req.url, 'http://localhost').searchParams, workerId = params.get('workerId'), taskId = params.get('taskId');
    if (!job) { sendJson(res, 404, { error: 'Unknown job' }); return true; }
    const task = job.tasks.find(t => t.id === taskId);
    if (!task || task.leaseWorkerId !== workerId) { sendJson(res, 400, { error: 'Task is not leased to this worker' }); return true; }
    // Only terrain/surfaces (topographic) and satellite are ever guaranteed
    // to have content for a given tile - water/objects are legitimately
    // absent wherever a tile has none, exactly like the local build's
    // copyIfPresent-based writes, so those aren't required here.
    if (!mandatoryTargetsExist(job.mapId, job.version, task)) { sendJson(res, 400, { error: 'Missing required output for this task' }); return true; }
    task.status = 'complete'; task.leaseWorkerId = null;
    const worker = poolWorkers.get(workerId);
    if (worker) { worker.currentTask = null; worker.tasksCompleted = (worker.tasksCompleted || 0) + 1; worker.lastSeen = new Date().toISOString(); }
    // Recorded for the ETA estimate in jobSummary() - a rolling window of
    // actual render completions, not the instant dedup-skipped ones (those
    // would wildly inflate the apparent rate right after a job is created).
    job.recentCompletions.push(Date.now());
    recentTiles.unshift({
      mapId: job.mapId, version: job.version, zoom: task.zoom, tx: task.tx, ty: task.ty, modes: task.modes,
      workerLabel: worker?.label || workerId, completedAt: new Date().toISOString(),
    });
    if (recentTiles.length > RECENT_TILES_LIMIT) recentTiles.length = RECENT_TILES_LIMIT;
    finalizeDistributedJobIfComplete(job);
    sendJson(res, 200, { ok: true, jobStatus: job.status }); return true;
  }
  const poolFailMatch = requestPath.match(/^\/api\/render-pool\/jobs\/([a-f0-9-]+)\/fail$/i);
  if (req.method === 'POST' && poolFailMatch) {
    const job = distributedJobs.get(poolFailMatch[1]);
    const params = new URL(req.url, 'http://localhost').searchParams, workerId = params.get('workerId'), taskId = params.get('taskId');
    if (!job) { sendJson(res, 404, { error: 'Unknown job' }); return true; }
    const task = job.tasks.find(t => t.id === taskId);
    if (!task || task.leaseWorkerId !== workerId) { sendJson(res, 400, { error: 'Task is not leased to this worker' }); return true; }
    task.failures = (task.failures || 0) + 1;
    task.status = task.failures >= POOL_MAX_FAILURES ? 'broken' : 'pending';
    task.leaseWorkerId = null; task.leaseExpires = 0;
    const failedWorker = poolWorkers.get(workerId);
    if (failedWorker) { failedWorker.currentTask = null; failedWorker.tasksFailed = (failedWorker.tasksFailed || 0) + 1; failedWorker.lastSeen = new Date().toISOString(); }
    finalizeDistributedJobIfComplete(job);
    sendJson(res, 200, { ok: true }); return true;
  }
  if (req.method === 'GET' && requestPath === '/api/render-pool/jobs') {
    sendJson(res, 200, { jobs: [...distributedJobs.values()].map(jobSummary).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1) }); return true;
  }
  const poolJobMatch = requestPath.match(/^\/api\/render-pool\/jobs\/([a-f0-9-]+)$/i);
  if (req.method === 'GET' && poolJobMatch) {
    const job = distributedJobs.get(poolJobMatch[1]);
    if (!job) { sendJson(res, 404, { error: 'Unknown job' }); return true; }
    sendJson(res, 200, { ...jobSummary(job), workers: activeWorkers() }); return true;
  }
  if (req.method === 'GET' && requestPath === '/api/render-pool/status') {
    const job = activeDistributedJob();
    sendJson(res, 200, { activeJobId: job?.id || null, workers: activeWorkers() }); return true;
  }
  if (req.method === 'GET' && requestPath === '/api/render-pool/recent-tiles') {
    sendJson(res, 200, { tiles: recentTiles }); return true;
  }
  if (req.method === 'POST' && requestPath === '/api/render-pool/package/build') {
    if (workerPackageJob?.status === 'building') { sendJson(res, 409, { error: 'A package build is already running' }); return true; }
    workerPackageJob = { status: 'building', progress: [], startedAt: new Date().toISOString(), finishedAt: null, error: null, sizeBytes: null };
    const child = spawn(process.execPath, [path.join(__dirname, 'tools', 'build-worker-package.js')], { cwd: __dirname, windowsHide: true });
    let buffer = '';
    const consume = chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        workerPackageJob.progress.push(line); if (workerPackageJob.progress.length > 200) workerPackageJob.progress.shift();
        const ready = line.match(/^@@PACKAGE_READY (.+)$/);
        if (ready) { try { workerPackageJob.sizeBytes = JSON.parse(ready[1]).sizeBytes; } catch {} }
      }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', error => { workerPackageJob.status = 'failed'; workerPackageJob.error = error.message; workerPackageJob.finishedAt = new Date().toISOString(); });
    child.on('close', code => {
      workerPackageJob.finishedAt = new Date().toISOString();
      if (code === 0) { workerPackageJob.status = 'ready'; if (workerPackageJob.sizeBytes == null && fs.existsSync(WORKER_PACKAGE_ZIP)) workerPackageJob.sizeBytes = fs.statSync(WORKER_PACKAGE_ZIP).size; }
      else { workerPackageJob.status = 'failed'; workerPackageJob.error = `build-worker-package.js exited with code ${code}`; }
    });
    sendJson(res, 202, workerPackageJob); return true;
  }
  if (req.method === 'GET' && requestPath === '/api/render-pool/package/status') {
    if (!workerPackageJob && fs.existsSync(WORKER_PACKAGE_ZIP)) {
      const stat = fs.statSync(WORKER_PACKAGE_ZIP);
      sendJson(res, 200, { status: 'ready', progress: [], startedAt: null, finishedAt: stat.mtime.toISOString(), error: null, sizeBytes: stat.size }); return true;
    }
    sendJson(res, 200, workerPackageJob || { status: 'none', progress: [], sizeBytes: null }); return true;
  }
  if (req.method === 'GET' && requestPath === '/api/render-pool/package/download') {
    if (!fs.existsSync(WORKER_PACKAGE_ZIP)) { sendJson(res, 404, { error: 'No package built yet' }); return true; }
    const stat = fs.statSync(WORKER_PACKAGE_ZIP);
    // This file is ~1.6GB - a dropped connection partway through a LAN
    // transfer is a real possibility, and without Range support the browser
    // has no way to resume, only restart from zero. fs.createReadStream's
    // {start,end} maps directly onto Range semantics.
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return true;
      }
      res.writeHead(206, { 'Content-Type': 'application/zip', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'attachment; filename="dayz-render-worker.zip"', 'Cache-Control': 'no-store' });
      fs.createReadStream(WORKER_PACKAGE_ZIP, { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Content-Disposition': 'attachment; filename="dayz-render-worker.zip"', 'Cache-Control': 'no-store' });
    fs.createReadStream(WORKER_PACKAGE_ZIP).pipe(res);
    return true;
  }
  const styleMatch = requestPath.match(/^\/api\/map-render\/styles\/([a-z0-9_-]+)$/i);
  if (styleMatch && req.method === 'GET') {
    const mapId = styleMatch[1];
    if (!availableMaps().some(map => map.id === mapId)) { sendJson(res, 404, { error: 'Unknown map' }); return true; }
    const file = path.join(stylesDir, `${mapId}.json`);
    sendJson(res, 200, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { mapId, colors: {} }); return true;
  }
  if (styleMatch && req.method === 'POST') {
    try {
      const mapId = styleMatch[1];
      if (!availableMaps().some(map => map.id === mapId)) { sendJson(res, 404, { error: 'Unknown map' }); return true; }
      const body = await readBody(req), variants = body.variants;
      if (!variants || typeof variants !== 'object' || Array.isArray(variants)) throw new Error('Invalid color variants');
      for (const variant of ['light', 'dark']) {
        const colors = variants[variant];
        if (!colors || typeof colors !== 'object' || Array.isArray(colors)) throw new Error(`Invalid ${variant} color profile`);
        for (const [key, value] of Object.entries(colors)) {
          if (!/^[a-z0-9_.-]+$/i.test(key) || typeof value !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) throw new Error(`Invalid ${variant} style entry: ${key}`);
        }
      }
      const profile = { schemaVersion: 3, mapId, variants, updatedAt: new Date().toISOString() };
      fs.mkdirSync(stylesDir, { recursive: true });
      fs.writeFileSync(path.join(stylesDir, `${mapId}.json`), `${JSON.stringify(profile, null, 2)}\n`);
      let publishedVersions=0;const mapFinal=path.join(finalRoot,mapId);if(fs.existsSync(mapFinal))for(const version of fs.readdirSync(mapFinal)){const versionDir=path.join(mapFinal,version);if(!fs.statSync(versionDir).isDirectory())continue;const targetDir=path.join(versionDir,'styles');fs.mkdirSync(targetDir,{recursive:true});for(const variant of ['light','dark'])fs.writeFileSync(path.join(targetDir,`topographic-${variant}.json`),`${JSON.stringify({variant,colors:variants[variant]},null,2)}\n`);publishedVersions++}
      sendJson(res, 200, {...profile,publishedVersions}); return true;
    } catch (error) { sendJson(res, 400, { error: error.message }); return true; }
  }
  const cancelMatch=requestPath.match(/^\/api\/map-render\/jobs\/([^/]+)\/cancel$/);
  if(req.method==='POST'&&cancelMatch){const job=jobs.get(cancelMatch[1]);if(!job){sendJson(res,404,{error:'Job not found'});return true}if(job.status!=='running'){sendJson(res,409,{error:`Job is ${job.status}`});return true}job.status='cancelled';job.error='Cancelled. Retry will resume completed tiles.';job.finishedAt=new Date().toISOString();const child=jobProcesses.get(job.id);if(child?.pid)spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true});persistJobs();sendJson(res,200,publicJob(job));return true}
  const deleteJobMatch=requestPath.match(/^\/api\/map-render\/jobs\/([^/]+)$/);
  if(req.method==='DELETE'&&deleteJobMatch){const job=jobs.get(deleteJobMatch[1]);if(!job){sendJson(res,404,{error:'Job not found'});return true}if(job.status==='running'){sendJson(res,409,{error:'Cancel the running job before clearing it'});return true}jobs.delete(job.id);persistJobs();sendJson(res,200,{removed:job.id});return true}
  if (req.method === 'GET' && requestPath.startsWith('/api/map-render/jobs/')) {
    const job = jobs.get(requestPath.split('/').pop());
    sendJson(res, job ? 200 : 404, job || { error: 'Job not found' }); return true;
  }
  if (req.method === 'POST' && requestPath === '/api/map-render/inspect-object') {
    try {
      const body = await readBody(req), x = Number(body.x), z = Number(body.z),source=body.source==='surfaces'?'surfaces':'objects';
      if (!Number.isFinite(x) || !Number.isFinite(z) || typeof body.previewUrl !== 'string') throw new Error('Invalid inspection request');
      const previewRoot = path.resolve(__dirname, 'out', 'mapdraw', 'builds');
      const previewDir = path.resolve(__dirname, body.previewUrl.replace(/^\/+/, ''));
      if (!previewDir.startsWith(`${previewRoot}${path.sep}`)) throw new Error('Invalid preview path');
      const file = path.join(previewDir, `${source}.geojson`);
      if (!fs.existsSync(file)) { sendJson(res, 404, { error: 'Preview object geometry not found' }); return true; }
      const stat = fs.statSync(file); let cached = objectInspectionCache.get(file);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        const collection = JSON.parse(fs.readFileSync(file, 'utf8'));
        cached = { mtimeMs: stat.mtimeMs, features: collection.features.map(feature => ({ feature, bounds: geometryBounds(feature.geometry.coordinates) })) };
        objectInspectionCache.set(file, cached);
      }
      let match = null;
      for (const candidate of cached.features) {
        const b = candidate.bounds;
        if (x < b[0] || z < b[1] || x > b[2] || z > b[3]) continue;
        if (pointInGeometry(x, z, candidate.feature.geometry.coordinates)) match = candidate.feature;
      }
      sendJson(res, 200, { found: Boolean(match), properties: match?.properties || null }); return true;
    } catch (error) { sendJson(res, 400, { error: error.message }); return true; }
  }
  if (req.method === 'POST' && requestPath === '/api/map-render/preview') {
    try {
      const body = await readBody(req);
      const map = availableMaps().find(item => item.id === body.mapId);
      if (!map) { sendJson(res, 400, { error: 'Unknown map' }); return true; }
      const numeric = ['x', 'z', 'meters', 'zoom', 'detailStrength'];
      for (const key of numeric) if (!Number.isFinite(Number(body[key]))) { sendJson(res, 400, { error: `Invalid ${key}` }); return true; }
      const x = Number(body.x), z = Number(body.z), meters = Number(body.meters), zoom = Number(body.zoom), detailStrength = Number(body.detailStrength);
      if (x < 0 || z < 0 || x > map.mapSize || z > map.mapSize || meters < 100 || meters > 2000 || zoom < 6 || zoom > 8 || detailStrength < 0 || detailStrength > 1) {
        sendJson(res, 400, { error: 'Preview settings outside allowed range' }); return true;
      }
      const outputPixels = Math.round(meters * 256 * 2 ** zoom / map.mapSize);
      if (outputPixels > 8192) {
        sendJson(res, 400, { error: `Preview would be ${outputPixels} × ${outputPixels}px; reduce the area to stay at or below 8192px` }); return true;
      }
      const viewMode = body.viewMode === 'topographic' ? 'topographic' : 'satellite';
      const id = randomUUID();
      const job = { id, type: 'preview', viewMode, mapId: map.id, status: 'running', createdAt: new Date().toISOString(), progress: [], outputUrl: null, error: null };
      jobs.set(id, job);
      const previewDir = path.join('out', 'mapdraw', 'builds', map.id, 'topographic-previews', `${x}-${z}-${meters}m-terrainx-v12`);
      const childArgs = viewMode === 'topographic'
        ? [path.join(__dirname, 'tools', 'mapdraw', 'build-topographic-preview.js'), '--manifest', path.join(manifestsDir, map.manifest), '--x', String(x), '--z', String(z), '--meters', String(meters), '--out', previewDir]
        : [path.join(__dirname, 'tools', 'mapdraw', 'map-render.js'), 'preview', path.join(manifestsDir, map.manifest), '--x', String(x), '--z', String(z), '--meters', String(meters), '--zoom', String(zoom), '--detail-strength', String(detailStrength)];
      const child = spawn(process.execPath, childArgs,
      { cwd: __dirname, windowsHide: true });
      const consume = chunk => {
        for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
          job.progress.push(line); if (job.progress.length > 80) job.progress.shift();
          const match = line.match(/^Preview ready:\s+(.+)$/);
          if (match) job.outputUrl = `/${path.relative(__dirname, match[1]).replaceAll('\\', '/')}`;
          const topoMatch = line.match(/^Topographic preview ready:\s+(.+)$/);
          if (topoMatch) job.outputUrl = `/${path.relative(__dirname, topoMatch[1]).replaceAll('\\', '/')}`;
        }
      };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.on('error', error => { job.status = 'failed'; job.error = error.message; job.finishedAt = new Date().toISOString(); });
      child.on('close', code => { job.status = code === 0 ? 'complete' : 'failed'; if (code !== 0) job.error = `Renderer exited with code ${code}`; job.finishedAt = new Date().toISOString(); });
      sendJson(res, 202, job); return true;
    } catch (error) { sendJson(res, 400, { error: error.message }); return true; }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // This is a local development UI; always expose current HTML/CSS/JS edits.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Resolve only the URL pathname so cache-busting query parameters do not
  // become part of the filesystem name (e.g. tile.png?v=water-171-r2).
  const requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const liveTileMatch=requestPath.match(/^\/api\/map-render\/live-tile\/([a-f0-9-]+)\/([a-z0-9_-]+)\/(satellite|topographic)(?:\/(terrain|surfaces|water|objects))?\/(\d+)\/(\d+)\/(\d+)\.(png|pbf)$/i);
  if(liveTileMatch){
    const [,jobId,mapId,mode,layerName,zoom,x,y,extension]=liveTileMatch,job=jobs.get(jobId);
    if(!job||job.type!=='final-build'||!job.maps.includes(mapId)){res.writeHead(404);res.end();return}
    let file=path.join(finalRoot,mapId,job.version,mode,...(layerName?[layerName]:[]),zoom,x,`${y}.${extension}`);
    if(mode==='topographic'&&layerName==='surfaces'){
      try{const renderState=JSON.parse(fs.readFileSync(path.join(finalRoot,mapId,job.version,'render-state.json'),'utf8')),key=`${zoom}/${x}/${y}/surfaces`;if(renderState.surfaceCompleted?.[key]!==currentSurfaceVersion)file=null}catch{file=null}
    }
    // Live builds are progressive overlays: a completed tile wins, otherwise
    // retain the active production tile, then the original map fallback.
    if(!file||!fs.existsSync(file)){
      const activeVersion=readFinalState().maps?.[mapId]?.version;
      const activeFile=activeVersion?path.join(finalRoot,mapId,activeVersion,mode,...(layerName?[layerName]:[]),zoom,x,`${y}.${extension}`):null;
      if(activeFile&&fs.existsSync(activeFile))file=activeFile;
      else{const displayDir=mapId==='chernarus'?'Chernarus':mapId==='livonia'?'Livonia':mapId==='sakhal'?'Sakhal':null;file=mode==='satellite'&&displayDir?path.join(__dirname,'data',displayDir,'Sat',zoom,x,`${y}.png`):layerName?path.join(__dirname,'out','mapdraw','topographic-base',mapId,layerName,zoom,x,`${y}.pbf`):null}
    }
    if(!file||!fs.existsSync(file)){res.writeHead(404,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Tile not available');return}
    fs.readFile(file,(error,content)=>{if(error){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':extension==='png'?'image/png':'application/x-protobuf','Cache-Control':'no-store'});res.end(content)});return;
  }
  const finalTileMatch=requestPath.match(/^\/api\/map-render\/final-tile\/([a-z0-9_-]+)\/(satellite|topographic)(?:\/(terrain|surfaces|water|objects))?\/(\d+)\/(\d+)\/(\d+)\.(png|pbf)$/i);
  if(finalTileMatch){
    const [,mapId,mode,layerName,zoom,x,y,extension]=finalTileMatch,state=readFinalState(),version=state.maps?.[mapId]?.version;
    let file=version?path.join(finalRoot,mapId,version,mode,...(layerName?[layerName]:[]),zoom,x,`${y}.${extension}`):null;
    // Versioned tiles are content-addressed - the version segment only
    // changes when a new final-build publishes, so a tile at this exact path
    // never changes underneath the same URL. Long+immutable lets the browser
    // (and any CDN in front of this) skip the request entirely on repeat
    // pans/zooms instead of re-hitting disk every time. The raw-source
    // fallback below (pre-final-build data) is also effectively static but
    // not path-versioned, so it gets a shorter cache instead of immutable.
    const cacheControl=file&&fs.existsSync(file)?'public, max-age=31536000, immutable':'public, max-age=3600';
    if(!file||!fs.existsSync(file)){
      const displayDir=mapId==='chernarus'?'Chernarus':mapId==='livonia'?'Livonia':mapId==='sakhal'?'Sakhal':null;
      file=mode==='satellite'&&displayDir?path.join(__dirname,'data',displayDir,'Sat',zoom,x,`${y}.png`):layerName?path.join(__dirname,'out','mapdraw','topographic-base',mapId,layerName,zoom,x,`${y}.pbf`):null;
    }
    if(!file||!fs.existsSync(file)){res.writeHead(404,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Tile not found');return}
    fs.readFile(file,(error,content)=>{if(error){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':extension==='png'?'image/png':'application/x-protobuf','Cache-Control':cacheControl});res.end(content)});return;
  }
  function resolveAssetPath(relative) {
    // path.resolve() on a bare drive root ("P:\\") already returns a
    // trailing separator, so appending another one below would produce a
    // string ("p:\\\\") that never matches - normalize before comparing.
    const rootResolved = path.resolve(ASSET_ROOT).replace(/[\\/]+$/, '');
    const resolved = path.resolve(ASSET_ROOT, relative);
    const withinRoot = resolved.toLowerCase() === rootResolved.toLowerCase()
      || resolved.toLowerCase().startsWith(rootResolved.toLowerCase() + path.sep);
    return withinRoot ? resolved : null;
  }
  const assetListMatch = requestPath.match(/^\/api\/assets-list\/(.*)$/);
  if (assetListMatch) {
    // Most render scripts only ever read specific known files under the
    // asset root, which /api/assets/* covers - but the WRP-less fallback
    // path in vectorize-wrp-surface-section.js scans a layers directory
    // with fs.readdirSync when a map's compiled 8WVR wasn't generated
    // (true for sakhal). That call worked fine locally (real P:\ drive) but
    // threw outright on a remote worker with no such path to scan at all.
    const resolved = resolveAssetPath(decodeURIComponent(assetListMatch[1]));
    if (!resolved) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Invalid asset path'); return; }
    fs.readdir(resolved, { withFileTypes: true }, (error, entries) => {
      if (error) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Directory not found'); return; }
      sendJson(res, 200, entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() })));
    });
    return;
  }
  const assetMatch = requestPath.match(/^\/api\/assets\/(.+)$/);
  if (assetMatch) {
    const resolved = resolveAssetPath(assetMatch[1]);
    if (!resolved) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Invalid asset path'); return; }
    fs.readFile(resolved, (error, content) => {
      if (error) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Asset not found'); return; }
      // Compiled DayZ game data is immutable for a given install - safe to
      // let a remote worker cache these aggressively once fetched.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(content);
    });
    return;
  }
  if (requestPath.startsWith('/api/') && await handleApi(req, res, requestPath)) return;
  let filePath = path.join(__dirname, requestPath);

  // Handle directory requests
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'map-with-contours.html');
  }

  // Default to index or requested file
  if (!filePath.includes('.')) {
    filePath = path.join(__dirname, 'map-with-contours.html');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    // Determine content type
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.csv': 'text/csv',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.geojson': 'application/json',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(content);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`📍 Open http://localhost:${PORT}/map-with-contours.html in your browser\n`);
});
