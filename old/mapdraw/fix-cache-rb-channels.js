#!/usr/bin/env node
const fs=require('fs');
const path=require('path');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const {loadMapManifest,PROJECT_ROOT}=require('./map-build-config');
function option(name,fallback){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback}
async function main(){
  const manifest=loadMapManifest(option('--manifest','configs/maps/chernarus.json'));
  const statePath=path.join(PROJECT_ROOT,'out','mapdraw','cache',manifest.world,'cache-state.json');
  const state=JSON.parse(fs.readFileSync(statePath,'utf8')),seen=new Set();let fixed=0,skipped=0;
  for(const entry of Object.values(state.models)){
    if(entry.status!=='complete'||!entry.image||!entry.metadata)continue;
    const imagePath=path.resolve(PROJECT_ROOT,entry.image),metadataPath=path.resolve(PROJECT_ROOT,entry.metadata);
    if(seen.has(imagePath)){skipped++;continue}seen.add(imagePath);
    const metadata=JSON.parse(fs.readFileSync(metadataPath,'utf8'));
    if(metadata.colorChannels==='rgba-v2'){skipped++;continue}
    const image=await loadImage(imagePath),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const frame=ctx.getImageData(0,0,image.width,image.height),pixels=frame.data;
    for(let i=0;i<pixels.length;i+=4){const red=pixels[i];pixels[i]=pixels[i+2];pixels[i+2]=red}
    ctx.putImageData(frame,0,0);fs.writeFileSync(imagePath,canvas.toBuffer('image/png'));
    metadata.colorChannels='rgba-v2';fs.writeFileSync(metadataPath,`${JSON.stringify(metadata,null,2)}\n`);fixed++;
    if(fixed%100===0)console.log(`[channels] ${fixed} corrected`);
  }
  console.log(`[channels] ${manifest.id}: ${fixed} corrected, ${skipped} already corrected/shared`);
}
main().catch(error=>{console.error(error.stack||error.message);process.exit(1)});
