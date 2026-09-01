#!/usr/bin/env node
// Resumable map staging pipeline. Each child stage owns its cache and can be
// safely rerun after interruption.
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const {loadMapManifest,PROJECT_ROOT}=require('../tools/mapdraw/map-build-config');
function option(name,fallback){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback}
const manifest=loadMapManifest(option('--manifest','configs/maps/livonia.json'));
function run(scriptRelPath,args=[]){console.log(`\n[stage-map] ${scriptRelPath}`);const r=spawnSync(process.execPath,[path.join(__dirname,scriptRelPath),...args],{cwd:PROJECT_ROOT,stdio:'inherit',windowsHide:true});if(r.status!==0)throw new Error(`${scriptRelPath} failed (${r.status})`)}
const common=['--manifest',manifest.manifestPath];
if(manifest.placements?.type==='runtime-export'){
  run('runtime-export/import-runtime-model-inventory.js',['--world',manifest.world,'--summary',manifest.placements.summary]);
}else{
  run('wrp/discover-world.js',[manifest.world]);
  run('wrp/convert-wrp-8wvr.js',common);
  run('wrp/extract-wrp-objects.js',common);
  run('wrp/normalize-dewrp-objects.js',['--world',manifest.world]);
}
run('cache/build-model-cache.js',common);
run(manifest.placements?.type==='runtime-export'?'cache/build-runtime-transform-index.js':'cache/build-transform-index.js',common);
run(path.join('..','tools','mapdraw','build-vector-model-cache.js'),common);
console.log(`\n[stage-map] ${manifest.displayName||manifest.id} object staging complete.`);
