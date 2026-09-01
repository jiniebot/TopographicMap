#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const {spawnSync}=require('child_process');
const {createCanvas,loadImage,ImageData}=require('@napi-rs/canvas');
const {pathToFileURL}=require('url');
const ROOT=path.resolve(__dirname,'..','..');
const P3D2BMP='C:\\Program Files (x86)\\Steam\\steamapps\\common\\DayZ Tools\\Bin\\TerrainBuilder\\p3d2bmp.exe';
const PAA_MODULE=path.join(ROOT,'vendor','BIS-Toolkit','packages','paa','dist','index.js');
function run(exe,args){return spawnSync(exe,args,{cwd:ROOT,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024})}
async function main(){
  const source=path.resolve(process.argv[2]||''),output=path.resolve(process.argv[3]||''),size=Number(process.argv[4]||512);
  if(!/\\roads\\panels\\panels?_concrete(?:_(?:1|2|dam))?(?:_lc|_legacy)?\.p3d$/i.test(source))throw new Error('Native textured fallback is limited to the verified concrete-panel family');
  if(!fs.existsSync(P3D2BMP)||!fs.existsSync(source))throw new Error('Native renderer or source model missing');
  const infoRun=run('python',[path.join(__dirname,'extract-odol-model-info.py'),source]);if(infoRun.status!==0)throw new Error(infoRun.stderr||infoRun.stdout);
  const info=JSON.parse(infoRun.stdout),bmin=info.bboxMin,bmax=info.bboxMax,width=bmax.x-bmin.x,height=bmax.z-bmin.z;
  const tempBmp=path.join(path.dirname(output),`.native-${process.pid}.bmp`);fs.mkdirSync(path.dirname(output),{recursive:true});
  const native=run(P3D2BMP,[source,'-A0','-Z90','-L0',`-W${size}`,`-h${size}`,'-p','-i','-BP:\\',`-O${tempBmp}`]);
  if(native.status!==0||!fs.existsSync(tempBmp))throw new Error(`p3d2bmp failed: ${native.stderr||native.stdout}`);
  const maskImage=await loadImage(tempBmp);fs.rmSync(tempBmp,{force:true});const maskCanvas=createCanvas(size,size),maskCtx=maskCanvas.getContext('2d');maskCtx.drawImage(maskImage,0,0,size,size);const mask=maskCtx.getImageData(0,0,size,size).data;
  let mx0=size,my0=size,mx1=-1,my1=-1;for(let y=0;y<size;y++)for(let x=0;x<size;x++){const o=(y*size+x)*4,r=mask[o],g=mask[o+1],bl=mask[o+2];if(r>235&&bl>235&&g<40)continue;if(r<15&&g<15&&bl<15)continue;mx0=Math.min(mx0,x);my0=Math.min(my0,y);mx1=Math.max(mx1,x);my1=Math.max(my1,y)}
  if(mx1<mx0)throw new Error('Native silhouette is empty');
  const lower=source.toLowerCase(),textureName=lower.includes('_dam')?'concrete_panel_dam_co.paa':lower.includes('_2')?'concrete_panel_2_co.paa':'concrete_panel_co.paa';
  const texturePath=path.join(path.dirname(source),'data',textureName),{Paa}=await import(pathToFileURL(PAA_MODULE)),paaSource=fs.readFileSync(texturePath),paa=new Paa();paa.read(paaSource);const mip=paa.mipmaps[0],bgra=paa.getArgb32PixelData(paaSource,0);
  const span=Math.max(width,height),margin=span*.04,scale=Math.min(size/(width+2*margin),size/(height+2*margin)),ox=(size-width*scale)/2,oy=(size-height*scale)/2,out=new Uint8ClampedArray(size*size*4);
  for(let y=Math.max(0,Math.floor(oy));y<Math.min(size,Math.ceil(oy+height*scale));y++)for(let x=Math.max(0,Math.floor(ox));x<Math.min(size,Math.ceil(ox+width*scale));x++){
    const u=(x-ox)/(width*scale),v=(y-oy)/(height*scale),sx=Math.max(mx0,Math.min(mx1,Math.round(mx0+u*(mx1-mx0)))),sy=Math.max(my0,Math.min(my1,Math.round(my0+v*(my1-my0)))),mo=(sy*size+sx)*4,mr=mask[mo],mg=mask[mo+1],mb=mask[mo+2];if((mr>235&&mb>235&&mg<40)||(mr<15&&mg<15&&mb<15))continue;
    const tx=Math.min(mip.width-1,Math.max(0,Math.floor(u*mip.width))),ty=Math.min(mip.height-1,Math.max(0,Math.floor(v*mip.height))),to=(ty*mip.width+tx)*4,o=(y*size+x)*4;out[o]=bgra[to+2];out[o+1]=bgra[to+1];out[o+2]=bgra[to];out[o+3]=bgra[to+3];
  }
  const canvas=createCanvas(size,size),ctx=canvas.getContext('2d');ctx.putImageData(new ImageData(out,size,size),0,0);fs.writeFileSync(output,canvas.toBuffer('image/png'));
  const metadata={schemaVersion:1,model:null,lodResolution:0,imageSize:size,renderMode:'native-p3d2bmp-textured-mask',triangles:null,textureCount:1,widthMeters:width,heightMeters:height,bounds:{minX:bmin.x,maxX:bmax.x,minY:bmin.y,maxY:bmax.y,minZ:bmin.z,maxZ:bmax.z},metersPerPixel:1/scale,sourcePath:source,colorChannels:'rgba-v2',nativeFallback:true,texturePath};
  fs.writeFileSync(output.replace(/\.png$/i,'.json'),`${JSON.stringify(metadata,null,2)}\n`);console.log(`Native textured panel: ${output}`);
}
main().catch(error=>{console.error(error.stack||error.message);process.exit(1)});
