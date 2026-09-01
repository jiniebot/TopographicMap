#!/usr/bin/env node
const fs=require('fs');
const path=require('path');
const {pathToFileURL}=require('url');
const {createCanvas,ImageData}=require('@napi-rs/canvas');

const ROOT=path.resolve(__dirname,'..','..');
const PAA_MODULE=path.join(ROOT,'vendor','BIS-Toolkit','packages','paa','dist','index.js');
function arg(name,fallback){const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
const COLORS={en_deforested:[200,189,145],en_flowers1:[184,205,131],en_flowers2:[174,205,121],en_flowers3:[197,207,134],en_forest_con:[120,146,99],en_forest_dec:[145,169,110],en_grass1:[199,211,148],en_grass2:[184,201,134],en_soil:[178,154,115],en_stones:[170,169,155],en_stubble:[210,197,140],en_tarmac_old:[170,168,160]};
const ANCHORS=[[0,0,0,255],[255,0,0,255],[0,255,0,255],[0,0,255,255],[0,0,0,128],[0,0,0,0]];

async function main(){
  const {Paa}=await import(pathToFileURL(PAA_MODULE));
  const wrp=fs.readFileSync(path.resolve(ROOT,arg('--wrp','out/mapdraw/wrp8-transform/enoch_8WVR.wrp')));
  const layers=arg('--layers','P:\\DZ\\worlds\\enoch\\data\\layers'),x0=Number(arg('--x',6600)),z0=Number(arg('--z',8930)),meters=Number(arg('--meters',400)),size=Number(arg('--size',800));
  const tx=wrp.readUInt32LE(4),ty=wrp.readUInt32LE(8),gx=wrp.readUInt32LE(12),gy=wrp.readUInt32LE(16),mapSize=12800,materialWidth=tx/2,cellX=mapSize/materialWidth,cellZ=mapSize/ty;
  let offset=24+gx*gy*4;const materialGrid=new Uint16Array(wrp.buffer,wrp.byteOffset+offset,tx*ty);offset+=tx*ty*2;
  const count=wrp.readUInt32LE(offset);offset+=4;const materials=[];
  for(let i=0;i<count;i++){let value='';while(true){const n=wrp.readUInt32LE(offset);offset+=4;if(!n)break;value+=wrp.subarray(offset,offset+n).toString().replace(/\0+$/,'');offset+=n}materials.push(value)}
  const paaCache=new Map(),rvmatCache=new Map();
  function decode(file){let hit=paaCache.get(file);if(hit)return hit;const source=fs.readFileSync(file),paa=new Paa();paa.read(source);const mip=paa.mipmaps[0];hit={width:mip.width,height:mip.height,pixels:paa.getArgb32PixelData(source,0)};paaCache.set(file,hit);return hit}
  function rvmatInfo(name){let hit=rvmatCache.get(name);if(hit)return hit;const file=path.join('P:\\',...name.split('\\'));const text=fs.readFileSync(file,'utf8');const slots=[...text.matchAll(/class Stage(?:4|6|8|10|12|14)\s*\{[\s\S]*?texture="[^"]*\\([^\\"]+)_ca\.paa"/gi)].map(m=>m[1].toLowerCase());const tile=name.match(/p_(\d+)-(\d+)_/i);const mask=decode(path.join(layers,`m_${tile[1]}_${tile[2]}_lca.paa`));hit={slots,mask};rvmatCache.set(name,hit);return hit}
  function sample(texture,u,v){const px=Math.max(0,Math.min(texture.width-1,Math.floor(u*texture.width))),py=Math.max(0,Math.min(texture.height-1,Math.floor(v*texture.height))),o=(py*texture.width+px)*4;return [texture.pixels[o+2],texture.pixels[o+1],texture.pixels[o],texture.pixels[o+3]]}
  function weights(mask){const raw=ANCHORS.map(anchor=>Math.exp(-anchor.reduce((s,v,i)=>s+(mask[i]-v)**2,0)/(2*72**2))),sum=raw.reduce((a,b)=>a+b,0);return raw.map(v=>v/sum)}
  const blended=new Uint8ClampedArray(size*size*4),hard=new Uint8ClampedArray(size*size*4),minX=x0-meters/2,maxZ=z0+meters/2;
  for(let py=0;py<size;py++)for(let px=0;px<size;px++){
    const x=minX+(px+.5)/size*meters,z=maxZ-(py+.5)/size*meters,cx=Math.max(0,Math.min(materialWidth-1,Math.floor(x/cellX))),cy=Math.max(0,Math.min(ty-1,Math.floor(z/cellZ)));
    const info=rvmatInfo(materials[materialGrid[cy*tx+cx]]),layerX=Math.floor(x/400),layerZ=Math.floor(z/400),u=(16+(x-layerX*400)/400*480)/512,v=(16+(400-(z-layerZ*400))/400*480)/512;
    const w=weights(sample(info.mask,u,v)),best=w.indexOf(Math.max(...w)),o=(py*size+px)*4;
    for(let c=0;c<3;c++){blended[o+c]=Math.round(w.reduce((sum,value,i)=>sum+value*(COLORS[info.slots[i]]||[194,204,154])[c],0));hard[o+c]=(COLORS[info.slots[best]]||[194,204,154])[c]}
    blended[o+3]=hard[o+3]=255;
  }
  const output=path.resolve(ROOT,arg('--out','out/mapdraw/vector-tests/terrain-blend-test'));fs.mkdirSync(output,{recursive:true});
  for(const [name,pixels] of [['hard-mask',hard],['blended-mask',blended]]){const canvas=createCanvas(size,size),ctx=canvas.getContext('2d');ctx.putImageData(new ImageData(pixels,size,size),0,0);fs.writeFileSync(path.join(output,`${name}.png`),canvas.toBuffer('image/png'))}
  console.log(`Terrain blend test: ${output}`);
}
main().catch(error=>{console.error(error.stack||error);process.exit(1)});
