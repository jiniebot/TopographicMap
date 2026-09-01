#!/usr/bin/env node
// Diagnostic: draw a compiled TerrainX control mask with the WRP-selected
// six-slot RVMAT palette for every material cell overlaid on top.
const fs=require('fs'),path=require('path'),{pathToFileURL}=require('url');
const {createCanvas,ImageData}=require('@napi-rs/canvas');
const {loadMapManifest}=require('./map-build-config');
const ROOT=path.resolve(__dirname,'..','..'),PAA_MODULE=path.join(ROOT,'vendor','BIS-Toolkit','packages','paa','dist','index.js');
function arg(name,fallback){const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
function readLzoStrings(wrp,offset){const count=wrp.readUInt32LE(offset);offset+=4;const values=[];for(let i=0;i<count;i++){let value='';for(;;){const n=wrp.readUInt32LE(offset);offset+=4;if(!n)break;value+=wrp.subarray(offset,offset+n).toString().replace(/\0+$/,'');offset+=n}values.push(value)}return values}
function rvmatSlots(file){const text=fs.readFileSync(file,'utf8');return [4,6,8,10,12,14].map(stage=>{const block=text.match(new RegExp(`class Stage${stage}\\s*\\{([\\s\\S]*?)\\};`,'i'))?.[1]||'',texture=block.match(/texture="([^"]*)"/i)?.[1]||'';return texture.match(/\\([^\\"]+)_ca\.paa$/i)?.[1]?.toLowerCase()||'—'})}
async function main(){
  const manifest=loadMapManifest(arg('--manifest','configs/maps/chernarus.json')),wx=Number(arg('--x',3324)),wz=Number(arg('--z',15144)),size=Number(arg('--size',1536)),alphaTransform=arg('--alpha-transform','identity');
  const wrpPath=path.resolve(ROOT,arg('--wrp',`out/mapdraw/wrp8-transform/${manifest.world}_8WVR.wrp`)),wrp=fs.readFileSync(wrpPath),tx=wrp.readUInt32LE(4),ty=wrp.readUInt32LE(8),gx=wrp.readUInt32LE(12),gy=wrp.readUInt32LE(16);
  let offset=24+gx*gy*4;const grid=new Uint16Array(wrp.buffer,wrp.byteOffset+offset,tx*ty);offset+=tx*ty*2;const materials=readLzoStrings(wrp,offset);
  const materialWidth=manifest.satellite.materialGridWidth||tx/2,materialHeight=manifest.satellite.materialGridHeight||ty,cellX=manifest.mapSize/materialWidth,cellZ=manifest.mapSize/materialHeight,layerWorld=manifest.satellite.directTileWorldSize||manifest.satellite.layerWorldSize||manifest.mapSize/manifest.satellite.layerGrid,cellsX=Math.round(layerWorld/cellX),cellsZ=Math.round(layerWorld/cellZ),tileX=Number(arg('--tile-x',Math.floor(wx/layerWorld))),southTileZ=Number(arg('--tile-z',Math.floor(wz/layerWorld))),northTileZ=(manifest.satellite.directNorthRows||manifest.satellite.layerGrid)-1-southTileZ;
  const maskFile=path.join(manifest.satellite.layerDirectory,`m_${String(tileX).padStart(3,'0')}_${String(northTileZ).padStart(3,'0')}_lca.paa`),{Paa}=await import(pathToFileURL(PAA_MODULE)),source=fs.readFileSync(maskFile),paa=new Paa();paa.read(source);const mip=paa.mipmaps[0],bgra=paa.getArgb32PixelData(source,0),rgba=new Uint8ClampedArray(bgra.length),alphaRgba=new Uint8ClampedArray(bgra.length);
  // Show RGB literally; alpha is represented by a white-to-black strip below.
  for(let i=0;i<bgra.length;i+=4){rgba[i]=bgra[i+2];rgba[i+1]=bgra[i+1];rgba[i+2]=bgra[i];rgba[i+3]=255;alphaRgba[i]=alphaRgba[i+1]=alphaRgba[i+2]=bgra[i+3];alphaRgba[i+3]=255}
  const canvas=createCanvas(size,size),ctx=canvas.getContext('2d'),raw=createCanvas(mip.width,mip.height),rawCtx=raw.getContext('2d'),border=manifest.satellite.sourceBorderPixels||0,sourceSize=manifest.satellite.sourceTilePixels||mip.width,content=sourceSize-border*2;rawCtx.putImageData(new ImageData(rgba,mip.width,mip.height),0,0);ctx.imageSmoothingEnabled=false;
  // RVMAT cells describe the 480x480 content area. The surrounding 16-pixel
  // overlap is only a sampling gutter and must not participate in the grid.
  ctx.drawImage(raw,border,border,content,content,0,0,size,size);
  const cw=size/cellsX,ch=size/cellsZ,codes=['K','R','G','B','A128','A0'],paletteCache=new Map();ctx.textBaseline='top';
  for(let screenRow=0;screenRow<cellsZ;screenRow++)for(let col=0;col<cellsX;col++){
    const worldLocalRow=cellsZ-1-screenRow,rawCy=southTileZ*cellsZ+worldLocalRow,cy=rawCy,cx=tileX*cellsX+col,index=grid[Math.max(0,Math.min(materialHeight-1,cy))*tx+Math.max(0,Math.min(materialWidth-1,cx))],rvmat=materials[index],file=path.join(manifest.assetRoot,...rvmat.split('\\')),slots=[...(paletteCache.get(file)||rvmatSlots(file))];paletteCache.set(file,slots);
    for(let slot=0;slot<6;slot++)if(slots[slot]==='—'){const scores=new Map();for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const nx=cx+dx,ny=cy+dy;if(nx<0||nx>=materialWidth||ny<0||ny>=materialHeight)continue;const neighbor=materials[grid[ny*tx+nx]];if(!neighbor)continue;const neighborFile=path.join(manifest.assetRoot,...neighbor.split('\\')),neighborSlots=paletteCache.get(neighborFile)||rvmatSlots(neighborFile);paletteCache.set(neighborFile,neighborSlots);const value=neighborSlots[slot];if(value!=='—')scores.set(value,(scores.get(value)||0)+1/(Math.abs(dx)+Math.abs(dy)))}if(scores.size)slots[slot]=`— → ${[...scores].sort((a,b)=>b[1]-a[1])[0][0]}`}
    const px=col*cw,py=screenRow*ch;ctx.fillStyle='rgba(0,0,0,.48)';ctx.fillRect(px+2,py+2,cw-4,ch-4);ctx.strokeStyle=(wx>=tileX*layerWorld+col*cellX&&wx<tileX*layerWorld+(col+1)*cellX&&wz>=southTileZ*layerWorld+worldLocalRow*cellZ&&wz<southTileZ*layerWorld+(worldLocalRow+1)*cellZ)?'#ffff00':'#ff35d3';ctx.lineWidth=4;ctx.strokeRect(px+2,py+2,cw-4,ch-4);ctx.fillStyle='#fff';ctx.font='bold 18px sans-serif';ctx.fillText(`WRP ${cx},${cy}`,px+10,py+8);ctx.font='16px monospace';for(let i=0;i<6;i++)ctx.fillText(`${codes[i].padEnd(4)} ${slots[i]}`,px+10,py+34+i*22);
  }
  const pointX=(wx-tileX*layerWorld)/layerWorld*size,pointY=(1-(wz-southTileZ*layerWorld)/layerWorld)*size;ctx.strokeStyle='#ffff00';ctx.lineWidth=5;ctx.beginPath();ctx.arc(pointX,pointY,13,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(pointX-22,pointY);ctx.lineTo(pointX+22,pointY);ctx.moveTo(pointX,pointY-22);ctx.lineTo(pointX,pointY+22);ctx.stroke();
  const output=path.resolve(ROOT,arg('--out',`out/mapdraw/diagnostics/${manifest.id}-terrainx-rvmat-${Math.round(wx)}-${Math.round(wz)}.png`));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,canvas.toBuffer('image/png'));
  const alphaRaw=createCanvas(mip.width,mip.height),alphaRawCtx=alphaRaw.getContext('2d');alphaRawCtx.putImageData(new ImageData(alphaRgba,mip.width,mip.height),0,0);const alphaCanvas=createCanvas(size,size),alphaCtx=alphaCanvas.getContext('2d');alphaCtx.imageSmoothingEnabled=false;
  // Transform candidates are diagnostic unless the same selection is later
  // wired into production sampling.
  if(alphaTransform==='flip-y-local-x'){
    const vertical=createCanvas(size,size),vctx=vertical.getContext('2d');vctx.imageSmoothingEnabled=false;vctx.translate(0,size);vctx.scale(1,-1);vctx.drawImage(alphaRaw,border,border,content,content,0,0,size,size);
    for(let row=0;row<cellsZ;row++)for(let col=0;col<cellsX;col++){alphaCtx.save();alphaCtx.translate((col+1)*cw,row*ch);alphaCtx.scale(-1,1);alphaCtx.drawImage(vertical,col*cw,row*ch,cw,ch,0,0,cw,ch);alphaCtx.restore()}
  }else{
    alphaCtx.save();
    if(alphaTransform==='flip-x'){alphaCtx.translate(size,0);alphaCtx.scale(-1,1)}
    else if(alphaTransform==='flip-y'){alphaCtx.translate(0,size);alphaCtx.scale(1,-1)}
    else if(alphaTransform==='rotate-180'){alphaCtx.translate(size,size);alphaCtx.scale(-1,-1)}
    alphaCtx.drawImage(alphaRaw,border,border,content,content,0,0,size,size);alphaCtx.restore();
  }
  alphaCtx.strokeStyle='#ff35d3';alphaCtx.lineWidth=4;for(let c=0;c<=cellsX;c++){alphaCtx.beginPath();alphaCtx.moveTo(c*cw,0);alphaCtx.lineTo(c*cw,size);alphaCtx.stroke()}for(let r=0;r<=cellsZ;r++){alphaCtx.beginPath();alphaCtx.moveTo(0,r*ch);alphaCtx.lineTo(size,r*ch);alphaCtx.stroke()}alphaCtx.strokeStyle='#ffff00';alphaCtx.lineWidth=5;alphaCtx.beginPath();alphaCtx.arc(pointX,pointY,13,0,Math.PI*2);alphaCtx.stroke();alphaCtx.font='bold 28px sans-serif';alphaCtx.fillStyle='#ffff00';alphaCtx.fillText(`Alpha candidate ${alphaTransform}: 0 black, 128 gray, 255 white`,18,18);const alphaOutput=output.replace(/\.png$/i,'-alpha.png');fs.writeFileSync(alphaOutput,alphaCanvas.toBuffer('image/png'));
  console.log(JSON.stringify({output,alphaOutput,maskFile,tile:[tileX,northTileZ],worldBounds:[tileX*layerWorld,southTileZ*layerWorld,(tileX+1)*layerWorld,(southTileZ+1)*layerWorld],point:[wx,wz]},null,2));
}
main().catch(error=>{console.error(error.stack||error);process.exit(1)});
