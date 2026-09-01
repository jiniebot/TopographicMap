#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const {openTransformIndex}=require('./transform-index');
const ROOT=path.resolve(__dirname,'..','..'),index=openTransformIndex(path.join(ROOT,'out/mapdraw/index/enoch'));
const baseDir=path.join(ROOT,'out/mapdraw/builds/livonia/previews/6600-8930-1000m-z8');
const footprint=JSON.parse(fs.readFileSync(path.join(ROOT,'out/mapdraw/vector-cache/enoch/enoch_50x50_moss-c39c93a6ee/footprint.geojson'),'utf8'));
const minX=6100,maxZ=9430,ppm=5120/1000;
function point(record,lx,lz,centered,transposed){
  const b=record.basis,cx=centered?-25:0,cz=centered?25:0;lx-=cx;lz-=cz;
  return transposed?[record.x+b[0]*lx+b[6]*lz,record.z+b[2]*lx+b[8]*lz]:[record.x+b[0]*lx+b[2]*lz,record.z+b[6]*lx+b[8]*lz];
}
(async()=>{
  const image=await loadImage(path.join(baseDir,'native-satellite.png')),canvas=createCanvas(5120,5120),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
  const hypotheses=[['corner-transposed','#ff3030',false,true],['center-transposed','#30ffff',true,true],['corner-direct','#ffe030',false,false],['center-direct','#ff30ff',true,false]];
  const records=[];for(let ty=35;ty<=40;ty++)for(let tx=62;tx<=70;tx++)for(const i of index.membersForTile(tx,ty)){const r=index.readRecord(i),m=index.meta.models[r.modelIndex].model;if(m.includes('enoch_50x50_moss')&&r.x>=6100&&r.x<=7100&&r.z>=8430&&r.z<=9430)records.push(r)}
  ctx.lineWidth=3;
  for(const [name,color,centered,transposed] of hypotheses){ctx.strokeStyle=color;ctx.beginPath();for(const record of records){const ring=footprint.geometry.coordinates[0][0];ring.forEach(([lx,lz],i)=>{const [x,z]=point(record,lx,lz,centered,transposed),px=(x-minX)*ppm,py=(maxZ-z)*ppm;i?ctx.lineTo(px,py):ctx.moveTo(px,py)});}ctx.stroke();}
  ctx.font='32px sans-serif';let y=40;for(const [name,color] of hypotheses){ctx.fillStyle=color;ctx.fillText(name,30,y);y+=38}
  const out=path.join(ROOT,'out/mapdraw/vector-tests/water-placement-hypotheses.png');fs.writeFileSync(out,canvas.toBuffer('image/png'));console.log(out,records.length);
})().catch(e=>{console.error(e);process.exit(1)});
