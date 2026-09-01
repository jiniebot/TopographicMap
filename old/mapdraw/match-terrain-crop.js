#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const ROOT=path.resolve(__dirname,'../..');
async function main(){
  const tileRoot=path.join(ROOT,'data/Chernarus/Sat/6');
  const scale=32, grid=64, canvas=createCanvas(scale*grid,scale*grid),ctx=canvas.getContext('2d');
  for(let y=0;y<grid;y++)for(let x=0;x<grid;x++){
    const f=path.join(tileRoot,String(x),`${y}.png`); if(!fs.existsSync(f))continue;
    ctx.drawImage(await loadImage(f),x*scale,y*scale,scale,scale);
  }
  const src=await loadImage(path.join(ROOT,'out/mapdraw/vector-tests/diag-480-no-yflip/native-satellite.png'));
  const tc=createCanvas(120,120),tx=tc.getContext('2d');tx.drawImage(src,0,0,120,120);
  const a=ctx.getImageData(0,0,2048,2048).data,b=tx.getImageData(0,0,120,120).data;
  // Compare local luminance gradients so different colour grading does not dominate.
  function lum(p,o){return (p[o]*3+p[o+1]*6+p[o+2])*.1}
  const scores=[];
  for(let oy=0;oy<=1928;oy+=2)for(let ox=0;ox<=1928;ox+=2){let ab=0,aa=0,bb=0,n=0;
    for(let y=2;y<118;y+=4)for(let x=2;x<118;x+=4){
      const bo=(y*120+x)*4,ao=((oy+y)*2048+ox+x)*4;
      const db=lum(b,bo)-lum(b,bo-8),da=lum(a,ao)-lum(a,ao-8);ab+=da*db;aa+=da*da;bb+=db*db;n++;
    } const s=ab/Math.sqrt(Math.max(1,aa*bb)); if(scores.length<12||s>scores[0].s){scores.push({s,ox,oy});scores.sort((q,r)=>q.s-r.s);if(scores.length>12)scores.shift();}
  }
  console.log(scores.reverse().map(v=>({...v,worldX:(v.ox+60)*7.5,worldZ:15360-(v.oy+60)*7.5})));
}
main().catch(e=>{console.error(e);process.exitCode=1});
