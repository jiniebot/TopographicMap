#!/usr/bin/env node
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const {loadMapManifest,PROJECT_ROOT}=require('./map-build-config');
const BUILD_VERSION='terrainx-effective-six-channel-palette-v34-lowzoom-lod';

function arg(name,fallback){const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
function run(script,args){
  // This was 8192 (8GB) per process - fine for one worker, but with N
  // concurrent pool workers each potentially running this stage at once,
  // worst-case memory is N*8GB, which exceeds total system RAM on both
  // this machine (~31GB, 8 workers) and the Mac (48GB, 12 workers) - the
  // Mac hit exactly this, spiking to 18GB+ and crashing the whole machine
  // rather than just this one process. First dropped this to 2048 (2GB),
  // but measured RSS on live tiles peaks around 1.3-1.4GB - close enough
  // to a 2GB ceiling that V8's incremental GC ramps up well before the
  // limit, causing heavy GC-thrashing slowdown (a z6 tile going from
  // seconds to ~2 minutes). 4096 (4GB) leaves real headroom above observed
  // peak usage while still keeping worst-case (N*4GB) far below available
  // RAM on either machine given actual usage, so a genuinely pathological
  // tile still OOMs its own process instead of taking down the fleet.
  // Configurable per-machine via env since the safe value depends on
  // worker count and total RAM, which differ per machine (e.g. the Mac
  // dropping from 12 to 5 concurrent workers freed enough headroom to
  // safely raise this well above the shared 4096 default without risking
  // the same system-wide OOM again).
  const heapMb=Number(process.env.VECTOR_SECTION_HEAP_MB)||4096;
  const nodeArgs=script==='build-vector-section.js'?[`--max-old-space-size=${heapMb}`]:[];
  const result=spawnSync(process.execPath,[...nodeArgs,path.join(__dirname,script),...args],{cwd:PROJECT_ROOT,stdio:'inherit',windowsHide:true});
  if(result.status!==0)throw new Error(`${script} failed with exit code ${result.status}`);
}

const manifest=loadMapManifest(arg('--manifest','configs/maps/livonia.json'));
const x=Number(arg('--x',manifest.preview?.x??manifest.mapSize/2));
const z=Number(arg('--z',manifest.preview?.z??manifest.mapSize/2));
const meters=Number(arg('--meters',manifest.preview?.meters??1000));
const minZoom=Number(arg('--min-zoom',5)),maxZoom=Number(arg('--max-zoom',8));
const output=path.resolve(PROJECT_ROOT,arg('--out',path.join(manifest.output,'topographic-previews',`${x}-${z}-${meters}m`)));
if(![x,z,meters,minZoom,maxZoom].every(Number.isFinite)||meters<=0||meters>manifest.mapSize||minZoom<0||maxZoom<minZoom||maxZoom>8)throw new Error('Invalid preview bounds or zoom range');
const half=meters/2,bounds=[x-half,z-half,x+half,z+half].join(',');
const surfaceGeojson=path.join(output,'surfaces.geojson');
const objectGeojson=path.join(output,'objects.geojson');
const terrainGeojson=path.join(PROJECT_ROOT,'out',`${manifest.id}_contours_10m.geojson`);
const elevationWaterGeojson=path.join(PROJECT_ROOT,'out','mapdraw','topographic-base',manifest.id,'water.geojson');
if(!fs.existsSync(terrainGeojson))throw new Error(`Terrain contours missing: ${terrainGeojson}`);
fs.mkdirSync(output,{recursive:true});
const previewManifest=path.join(output,'preview.json');
if(fs.existsSync(previewManifest)){
  const cached=JSON.parse(fs.readFileSync(previewManifest,'utf8'));
  if(cached.buildVersion===BUILD_VERSION&&cached.map===manifest.id&&cached.x===x&&cached.z===z&&cached.meters===meters&&cached.minZoom===minZoom&&cached.maxZoom===maxZoom&&fs.existsSync(path.join(output,'objects','tile-meta.json'))&&fs.existsSync(path.join(output,'surfaces','tile-meta.json'))){
    console.log(`Topographic preview cache hit: ${output}`);
    console.log(`Topographic preview ready: ${output}`);
    process.exit(0);
  }
}

// Ensure every unique model intersecting this preview has a projected footprint.
console.log('[topo-stage] 0/7 Model footprint cache');
run('build-vector-model-cache.js',['--manifest',manifest.manifestPath,'--section',`${x},${z},${meters}`]);
const surfaceCell=Math.max(2,manifest.mapSize/(256*2**maxZoom));
console.log('[topo-stage] 1/7 Categorical TerrainX surfaces');
run('vectorize-wrp-surface-section.js',['--manifest',manifest.manifestPath,'--x',String(x),'--z',String(z),'--meters',String(meters),'--out',surfaceGeojson,'--cell',String(surfaceCell)]);
console.log('[topo-stage] 2/7 Object placement, water masking and unions');
// z<=4 objects are aggregated into flat grid-cell boxes instead of real
// footprints, to keep low-zoom tiles cheap. (Tried dropping this - z3/z4
// render fine with real geometry, but z1/z2 hard-crash build-vector-
// section-tiles.js with a V8 OOM abort processing every object footprint
// across that much area at once. Reverted rather than leave the tile set
// in a mixed state; revisit as a deliberate, separately-tested change.)
const objectArgs=['--manifest',manifest.manifestPath,'--x',String(x),'--z',String(z),'--meters',String(meters),'--water-padding','400','--out',objectGeojson];
if(maxZoom<=4)objectArgs.push('--aggregate-cell',String(manifest.mapSize/(256*2**maxZoom)));
run('build-vector-section.js',objectArgs);

const common=['--map-size',String(manifest.mapSize),'--min-zoom',String(minZoom),'--max-zoom',String(maxZoom),'--bounds',bounds];
console.log('[topo-stage] 3/7 Encoding terrain contours');
run('build-local-mvt.js',['--input',terrainGeojson,'--out',path.join(output,'terrain'),'--layer','terrain',...common]);
console.log('[topo-stage] 4/7 Encoding categorical surfaces');
run('build-local-mvt.js',['--input',surfaceGeojson,'--out',path.join(output,'surfaces'),'--layer','surfaces',...common]);
if(manifest.water?.source==='terrain-elevation'){
  console.log('[topo-stage] 5/7 Encoding water');
  if(!fs.existsSync(elevationWaterGeojson))run('vectorize-elevation-water.js',['--manifest',manifest.manifestPath,'--out',elevationWaterGeojson]);
  run('build-local-mvt.js',['--input',elevationWaterGeojson,'--out',path.join(output,'water'),'--layer','water',...common]);
}
console.log('[topo-stage] 6/7 Encoding placed objects and roads');
run('build-vector-section-tiles.js',['--input',objectGeojson,'--out',path.join(output,'objects'),'--layer','objects',...common]);
fs.writeFileSync(previewManifest,`${JSON.stringify({buildVersion:BUILD_VERSION,map:manifest.id,x,z,meters,bounds:[x-half,z-half,x+half,z+half],minZoom,maxZoom},null,2)}\n`);
console.log(`Topographic preview ready: ${output}`);
