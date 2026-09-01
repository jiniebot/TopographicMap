#!/usr/bin/env node
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const {loadMapManifest,PROJECT_ROOT}=require('../../tools/mapdraw/map-build-config');
function option(name,fallback){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback}
const manifest=loadMapManifest(option('--manifest','configs/maps/livonia.json'));
const converter=option('--converter','C:\\Program Files (x86)\\Mikero\\DePboTools\\bin\\ConvertWrp.exe');
const outputDir=path.resolve(PROJECT_ROOT,option('--out-dir','out/mapdraw/wrp8-transform'));
const staged=path.join(outputDir,`${manifest.world}.wrp`),output=path.join(outputDir,`${manifest.world}_8WVR.wrp`);
if(!fs.existsSync(manifest.wrp))throw new Error(`Source WRP missing: ${manifest.wrp}`);
if(!fs.existsSync(converter))throw new Error(`ConvertWrp missing: ${converter}`);
fs.mkdirSync(outputDir,{recursive:true});
if(!fs.existsSync(staged)||fs.statSync(staged).size!==fs.statSync(manifest.wrp).size)fs.copyFileSync(manifest.wrp,staged);
if(fs.existsSync(output)&&fs.readFileSync(output).subarray(0,4).toString()==='8WVR'){console.log(`8WVR cache hit: ${output}`);process.exit(0)}
const result=spawnSync(converter,['-P',staged,'8'],{cwd:outputDir,stdio:'inherit',windowsHide:true});
if(result.status!==0)throw new Error(`ConvertWrp exited with ${result.status}`);
if(!fs.existsSync(output)||fs.readFileSync(output).subarray(0,4).toString()!=='8WVR')throw new Error(`Expected converted output missing: ${output}`);
console.log(`8WVR ready: ${output}`);
