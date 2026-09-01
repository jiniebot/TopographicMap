#!/usr/bin/env node
// Build the standard MTIX spatial index from row-segmented runtime placement TSV.
const fs=require('fs'),path=require('path'),readline=require('readline');
const {loadMapManifest}=require('../../tools/mapdraw/map-build-config');
const ROOT=path.resolve(__dirname,'../..');
function option(name,fallback){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback}
function vector(value){const n=value.replace(/[<>]/g,'').split(',').map(Number);if(n.length!==3||!n.every(Number.isFinite))throw new Error(`Invalid vector: ${value}`);return n}
async function main(){
  const manifest=loadMapManifest(option('--manifest','configs/maps/sakhal.json'));
  const sourceDir=path.resolve(ROOT,option('--source','ebo/runtime-export/profile'));
  const inventory=JSON.parse(fs.readFileSync(path.join(ROOT,'out','mapdraw',`${manifest.world}-models.json`),'utf8'));
  const cachePath=path.join(ROOT,'out','mapdraw','cache',manifest.world,'cache-state.json');
  const cache=fs.existsSync(cachePath)?JSON.parse(fs.readFileSync(cachePath,'utf8')).models:{};
  const zoom=Number(option('--zoom',7)),side=2**zoom,count=inventory.placementCount,recordSize=56;
  const names=inventory.models.map(item=>item.model),modelIndex=new Map(names.map((name,index)=>[name,index]));
  const records=Buffer.allocUnsafe(count*recordSize),tileIds=new Uint16Array(count),tileCounts=new Uint32Array(side*side);
  const files=fs.readdirSync(sourceDir).map(name=>({name,match:name.match(/^sakhal-placement-row-(\d+)\.tsv$/)})).filter(x=>x.match).sort((a,b)=>Number(a.match[1])-Number(b.match[1]));
  if(files.length!==78)throw new Error(`Expected 78 placement rows, found ${files.length}`);
  let index=0;
  for(const entry of files){
    const lines=readline.createInterface({input:fs.createReadStream(path.join(sourceDir,entry.name)),crlfDelay:Infinity});let header=true;
    for await(const line of lines){if(header){header=false;continue}if(!line)continue;const f=line.split('\t'),model=f[0].toLowerCase(),mi=modelIndex.get(model);if(mi===undefined)throw new Error(`Model absent from inventory: ${model}`);
      const r0=vector(f[2]),r1=vector(f[3]),r2=vector(f[4]),position=vector(f[5]),ro=index*recordSize;
      records.writeUInt32LE(index+1,ro);records.writeUInt16LE(mi,ro+4);
      const drawable=cache[model]?.status==='complete',road=/\\roads(?:_bliss)?\\parts\\/i.test(model);
      records.writeUInt16LE((road?1:0)|(drawable?2:0),ro+6);
      records.writeFloatLE(position[0],ro+8);records.writeFloatLE(position[1],ro+12);records.writeFloatLE(position[2],ro+16);
      [...r0,...r1,...r2].forEach((value,i)=>records.writeFloatLE(value,ro+20+i*4));
      const tx=Math.max(0,Math.min(side-1,Math.floor(position[0]/manifest.mapSize*side))),ty=Math.max(0,Math.min(side-1,Math.floor((manifest.mapSize-position[2])/manifest.mapSize*side))),tile=ty*side+tx;
      tileIds[index]=tile;tileCounts[tile]++;index++;
    }
    console.log(`[runtime-index] row ${entry.match[1]}: ${index.toLocaleString()} placements`);
  }
  if(index!==count)throw new Error(`Placement mismatch: expected ${count}, read ${index}`);
  const offsets=new Uint32Array(tileCounts.length+1);for(let i=0;i<tileCounts.length;i++)offsets[i+1]=offsets[i]+tileCounts[i];
  const cursors=offsets.slice(0,-1),members=new Uint32Array(count);for(let i=0;i<count;i++)members[cursors[tileIds[i]]++]=i;
  const out=manifest.transformIndex;fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'transforms.bin'),records);
  const header=Buffer.alloc(20);header.write('MTIX',0);header.writeUInt32LE(1,4);header.writeUInt32LE(zoom,8);header.writeUInt32LE(side*side,12);header.writeUInt32LE(count,16);
  fs.writeFileSync(path.join(out,'tiles.bin'),Buffer.concat([header,Buffer.from(offsets.buffer),Buffer.from(members.buffer)]));
  const models=names.map((model,i)=>({index:i,model,...(cache[model]||{status:'pending',placementCount:inventory.models[i].count})}));
  const meta={schemaVersion:1,map:manifest.world,mapSize:manifest.mapSize,nativeZoom:zoom,side,objectCount:count,modelCount:models.length,recordSize,sourceType:'dayz-runtime-static-placement-export',recordLayout:{id:'u32@0',modelIndex:'u16@4',flags:'u16@6 bit0=roadnet bit1=drawable',position:'f32x3@8',basis:'f32x9@20'},files:{transforms:'transforms.bin',tiles:'tiles.bin'},models};
  fs.writeFileSync(path.join(out,'index.json'),JSON.stringify(meta));console.log(`[runtime-index] ${count.toLocaleString()} objects, ${models.length} models -> ${path.relative(ROOT,out)}`);
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
