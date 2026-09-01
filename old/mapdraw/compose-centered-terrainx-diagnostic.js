#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
function arg(name,fallback){const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
async function main(){
  const left=await loadImage(arg('--left')),right=await loadImage(arg('--right')),tileWorld=Number(arg('--tile-world',480)),leftTileX=Number(arg('--left-tile-x',6)),x=Number(arg('--x',3324)),z=Number(arg('--z',15144)),tileZ=Number(arg('--tile-z',31)),meters=Number(arg('--meters',240)),size=Number(arg('--size',1536));
  const stitched=createCanvas(left.width*2,left.height),s=stitched.getContext('2d');s.drawImage(left,0,0);s.drawImage(right,left.width,0);
  const minWorldX=leftTileX*tileWorld,minWorldZ=tileZ*tileWorld,sourceX=(x-meters/2-minWorldX)/tileWorld*left.width,sourceY=(tileWorld-(z+meters/2-minWorldZ))/tileWorld*left.height,sourceSize=meters/tileWorld*left.width;
  const out=createCanvas(size,size),ctx=out.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.drawImage(stitched,sourceX,sourceY,sourceSize,sourceSize,0,0,size,size);ctx.strokeStyle='#ffff00';ctx.lineWidth=6;ctx.beginPath();ctx.arc(size/2,size/2,15,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(size/2-26,size/2);ctx.lineTo(size/2+26,size/2);ctx.moveTo(size/2,size/2-26);ctx.lineTo(size/2,size/2+26);ctx.stroke();ctx.fillStyle='#ffff00';ctx.font='bold 26px sans-serif';ctx.fillText(`${x}, ${z} · ${meters}m centered`,18,34);
  const output=path.resolve(arg('--out','out/mapdraw/diagnostics/chernarus-terrainx-centered-3324-15144.png'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,out.toBuffer('image/png'));console.log(output);
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
