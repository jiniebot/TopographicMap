#!/usr/bin/env node
// Convert a runtime placement-export summary into the model inventory consumed
// by the existing raster/vector P3D cache builders.
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'../..');
function option(name,fallback){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback}
const world=option('--world','sakhal');
const input=path.resolve(ROOT,option('--summary','ebo/runtime-export/profile/sakhal-placement-summary.tsv'));
const output=path.resolve(ROOT,option('--out',`out/mapdraw/${world}-models.json`));
if(!fs.existsSync(input))throw new Error(`Runtime summary missing: ${input}`);
let placementCount=0,roads=0,vegetation=0;const models=[];
for(const line of fs.readFileSync(input,'utf8').split(/\r?\n/)){
  if(!line)continue;const fields=line.split('\t');
  if(fields[0]==='objects')placementCount=Number(fields[1]);
  else if(fields[0]==='roads')roads=Number(fields[1]);
  else if(fields[0]==='vegetation')vegetation=Number(fields[1]);
  else if(fields[0]==='shape')models.push({model:fields.slice(2).join('\t').toLowerCase(),count:Number(fields[1])});
}
models.sort((a,b)=>b.count-a.count||a.model.localeCompare(b.model));
if(models.reduce((sum,item)=>sum+item.count,0)!==placementCount)throw new Error('Shape counts do not equal placement total');
const inventory={schemaVersion:1,source:input,sourceType:'dayz-runtime-static-placement-export',centralEconomyInitialized:false,placementCount,uniqueModelCount:models.length,roads,vegetation,models};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,`${JSON.stringify(inventory,null,2)}\n`);
console.log(`[runtime-inventory] ${placementCount.toLocaleString()} placements, ${models.length.toLocaleString()} models -> ${path.relative(ROOT,output)}`);
