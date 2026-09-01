#!/usr/bin/env node
// Build categorical, color-editable surface vectors from TerrainX. A control
// texel selects exactly one of the six material slots in its RVMAT.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {pathToFileURL}=require('url');
const {loadMapManifest}=require('./map-build-config');

const ROOT=path.resolve(__dirname,'..','..');
const PAA_MODULE=path.join(ROOT,'vendor','BIS-Toolkit','packages','paa','dist','index.js');
function arg(name,fallback){const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
function maskSlot(r,g,b,a){
  // TerrainX uses alpha as a bank selector for slots 5/6. RGB data remains
  // present in those texels, so a generic RGBA nearest-colour test mistakes
  // blue-looking alpha-bank pixels for slot 4.
  if(a<64)return 5;
  if(a<192)return 4;
  const rgb=[[0,0,0],[255,0,0],[0,255,0],[0,0,255]];let winner=0,best=Infinity;
  for(let i=0;i<4;i++){const q=rgb[i],d=(r-q[0])**2+(g-q[1])**2+(b-q[2])**2;if(d<best){best=d;winner=i}}
  return winner;
}

async function main(){
  const {Paa}=await import(pathToFileURL(PAA_MODULE));
  const manifest=loadMapManifest(arg('--manifest','configs/maps/livonia.json'));
  const wrpPath=path.resolve(ROOT,arg('--wrp',`out/mapdraw/wrp8-transform/${manifest.world}_8WVR.wrp`));
  const x=Number(arg('--x',manifest.preview?.x??manifest.mapSize/2)),z=Number(arg('--z',manifest.preview?.z??manifest.mapSize/2)),meters=Number(arg('--meters',400)),cellMeters=Number(arg('--cell',2)),paddingCells=Math.max(0,Math.floor(Number(arg('--padding-cells',2))));
  const output=path.resolve(ROOT,arg('--out',`out/mapdraw/vector-tests/blended-surfaces-${x}-${z}-${meters}m.geojson`));
  const hasWrp=fs.existsSync(wrpPath);
  const wrp=hasWrp?fs.readFileSync(wrpPath):null;
  const tx=hasWrp?wrp.readUInt32LE(4):0,ty=hasWrp?wrp.readUInt32LE(8):0,gx=hasWrp?wrp.readUInt32LE(12):0,gy=hasWrp?wrp.readUInt32LE(16):0;
  // 8WVR stores 128 active X material cells in a 256-entry row stride;
  // Z has all 256 rows. Rows run from world south to north.
  // TerrainX's material grid already runs south-to-north in world space even
  // though the referenced compiled layer filenames use north-origin rows.
  // This is distinct from the detail-texture UV grid used by the satellite
  // enhancer and must not inherit its wrpFlipGridY setting.
  const materialWidth=manifest.satellite.materialGridWidth||tx/2,materialHeight=manifest.satellite.materialGridHeight||ty,materialCellX=manifest.mapSize/materialWidth,materialCellZ=manifest.mapSize/materialHeight,flipMaterialY=manifest.satellite.surfaceFlipGridY===true;
  let materialGrid=null,materialPaths=[];
  if(hasWrp){let offset=24+gx*gy*4;materialGrid=new Uint16Array(wrp.buffer,wrp.byteOffset+offset,tx*ty);offset+=tx*ty*2;const materialCount=wrp.readUInt32LE(offset);offset+=4;
    for(let i=0;i<materialCount;i++){let value='';while(true){const length=wrp.readUInt32LE(offset);offset+=4;if(!length)break;value+=wrp.subarray(offset,offset+length).toString().replace(/\0+$/,'');offset+=length}materialPaths.push(value)}}
  const paaCache=new Map(),rvmatCache=new Map(),effectivePaletteCache=new Map(),layerRvmatByTile=new Map(),cacheDir=path.join(ROOT,'out','mapdraw','cache','terrainx-alpha-bank-slots-v2');
  if(!hasWrp)for(const name of fs.readdirSync(manifest.satellite.layerDirectory)){const match=name.match(/^(p_\d+-\d+)_.*\.rvmat$/i);if(match&&!layerRvmatByTile.has(match[1]))layerRvmatByTile.set(match[1],name)}
  function decodeMask(file){let value=paaCache.get(file);if(value)return value;const stat=fs.statSync(file),key=crypto.createHash('sha1').update(`${path.resolve(file).toLowerCase()}|${stat.size}|${stat.mtimeMs}`).digest('hex'),cached=path.join(cacheDir,`${key}.bin`);
    if(fs.existsSync(cached)){const data=fs.readFileSync(cached);if(data.length>=8&&data.subarray(0,4).toString()==='TXS1'){const width=data.readUInt16LE(4),height=data.readUInt16LE(6);if(data.length===8+width*height){value={width,height,slots:data.subarray(8)};paaCache.set(file,value);return value}}}
    const source=fs.readFileSync(file),paa=new Paa();paa.read(source);const mip=paa.mipmaps[0],pixels=paa.getArgb32PixelData(source,0),slots=Buffer.allocUnsafe(mip.width*mip.height);for(let i=0;i<slots.length;i++){const o=i*4;slots[i]=maskSlot(pixels[o+2],pixels[o+1],pixels[o],pixels[o+3])}value={width:mip.width,height:mip.height,slots};paaCache.set(file,value);
    fs.mkdirSync(cacheDir,{recursive:true});const data=Buffer.allocUnsafe(8+slots.length);data.write('TXS1',0);data.writeUInt16LE(value.width,4);data.writeUInt16LE(value.height,6);slots.copy(data,8);const temp=`${cached}.${process.pid}.tmp`;fs.writeFileSync(temp,data);try{fs.renameSync(temp,cached)}catch{fs.rmSync(temp,{force:true})}return value}
  function parseRvmat(name){let value=rvmatCache.get(name);if(value)return value;const file=path.isAbsolute(name)?name:path.join(manifest.assetRoot,...name.split('\\')),text=fs.readFileSync(file,'utf8');const slots=[4,6,8,10,12,14].map(stage=>{const block=text.match(new RegExp(`class Stage${stage}\\s*\\{([\\s\\S]*?)\\};`,'i'))?.[1]||'',texture=block.match(/texture="([^"]*)"/i)?.[1]||'',material=texture.match(/\\([^\\"]+)_ca\.paa$/i);return material?material[1].toLowerCase():null});const tile=path.basename(name).match(/p_(\d+)-(\d+)_/i);if(!tile)throw new Error(`Cannot resolve terrain mask from ${name}`);value={slots,mask:decodeMask(path.join(manifest.satellite.layerDirectory,`m_${tile[1]}_${tile[2]}_lca.paa`))};rvmatCache.set(name,value);return value}
  function sampleSlot(texture,u,v){
    // The compiled mask (m_XXX_YYY_lca.paa) encodes a discrete 6-color
    // palette (black/red/green/blue/128-alpha/0-alpha - one canonical color
    // per slot, per BI's TerrainX format; no true blending support). Two
    // distinct artifacts show up at material boundaries and both need
    // outvoting by neighbors: (1) DXT compression bleed produces off-palette
    // values (e.g. alpha 176 instead of the legal 0/128/255) right at hard
    // edges; (2) at soft transitions BI's own mask generator dithers between
    // two *legal* slot values pixel-by-pixel (verified directly: alternating
    // exact alpha 128/255 texels at a sparse1/dense1 boundary) so it blends
    // visually under normal mip sampling. Nearest-neighbor sampling defeats
    // both compensations, so vote over a 5x5 neighborhood for the modal slot
    // - wide enough to resolve a fine dither, not just single-pixel noise.
    const px=Math.max(0,Math.min(texture.width-1,Math.floor(u*texture.width))),py=Math.max(0,Math.min(texture.height-1,Math.floor(v*texture.height)));
    const counts=new Map();
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      const sx=Math.max(0,Math.min(texture.width-1,px+dx)),sy=Math.max(0,Math.min(texture.height-1,py+dy));
      const slot=texture.slots[sy*texture.width+sx],weight=(dx===0&&dy===0)?2:1;
      counts.set(slot,(counts.get(slot)||0)+weight);
    }
    let best=texture.slots[py*texture.width+px],bestCount=-1;
    for(const [slot,count] of counts)if(count>bestCount){bestCount=count;best=slot}
    return best;
  }
  function inheritedSlot(cx,cy,slot){
    // Terrain Builder caps each compiled RVMAT at 6 materials; a bank that's
    // genuinely used by the shared mask (e.g. a thin road strip) can still
    // lose its slot in one specific cell's RVMAT if the compiler picked
    // other materials as more prevalent there, even though every immediate
    // neighbor consistently uses that same bank number for that material
    // (verified directly against Chernarus RVMATs: cx=25,26,28,29 all carry
    // cp_dirt in slot 3 while cx=27 alone has it empty, in a straight line
    // under a road). Vote only among the immediate 8 neighbors (radius 1) -
    // a longer reach previously let unrelated materials (e.g. conifer) bleed
    // into cells that never bordered them.
    if(!hasWrp)return null;
    const scores=new Map();
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(!dx&&!dy)continue;
      const nx=cx+dx,ny=cy+dy;
      if(nx<0||nx>=materialWidth||ny<0||ny>=materialHeight)continue;
      const name=materialPaths[materialGrid[ny*tx+nx]];if(!name)continue;
      const material=parseRvmat(name).slots[slot];if(!material)continue;
      scores.set(material,(scores.get(material)||0)+1);
    }
    if(!scores.size)return null;
    return [...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0];
  }
  function effectivePalette(cx,cy,info){
    const key=`${cx},${cy}`;let value=effectivePaletteCache.get(key);if(value)return value;
    value=info.slots.map((material,slot)=>material||inheritedSlot(cx,cy,slot));
    effectivePaletteCache.set(key,value);return value}
  // Sample a world-aligned halo around the requested section. d3-contour
  // considers cells outside its grid empty; without this halo it forces every
  // surface polygon to terminate independently at every production tile edge.
  // The MVT encoder clips the resulting shared geometry back to exact bounds.
  const innerGrid=Math.max(8,Math.round(meters/cellMeters)),actualCell=meters/innerGrid,grid=innerGrid+paddingCells*2,labels=new Uint16Array(grid*grid),signatures=[],signatureIndex=new Map(),minX=x-meters/2-paddingCells*actualCell,maxZ=z+meters/2+paddingCells*actualCell,sampledMeters=grid*actualCell,layerWorld=manifest.satellite.directTileWorldSize||manifest.satellite.layerWorldSize||manifest.mapSize/manifest.satellite.layerGrid,directNorthRows=manifest.satellite.directNorthRows||manifest.satellite.layerGrid,directFlipLocalY=manifest.satellite.surfaceFlipLocalY!==false;
  for(let py=0;py<grid;py++)for(let px=0;px<grid;px++){
    const wx=minX+(px+.5)*actualCell,wz=maxZ-(py+.5)*actualCell,cx=Math.max(0,Math.min(materialWidth-1,Math.floor(wx/materialCellX))),rawCy=Math.max(0,Math.min(materialHeight-1,Math.floor(wz/materialCellZ))),cy=flipMaterialY?materialHeight-1-rawCy:rawCy;
    let layerX=Math.max(0,Math.min(manifest.satellite.layerGrid-1,Math.floor(wx/layerWorld))),layerZ=Math.max(0,Math.min(manifest.satellite.layerGrid-1,directNorthRows-1-Math.floor(wz/layerWorld))),rvmatName;
    if(hasWrp)rvmatName=materialPaths[materialGrid[cy*tx+cx]];
    else {
      const prefix=`p_${String(layerX).padStart(3,'0')}-${String(layerZ).padStart(3,'0')}`;
      const candidate=layerRvmatByTile.get(prefix);
      rvmatName=candidate?path.join(manifest.satellite.layerDirectory,candidate):null;
    }
    if(!rvmatName||!fs.existsSync(path.isAbsolute(rvmatName)?rvmatName:path.join(manifest.assetRoot,...rvmatName.split('\\'))))continue;const info=parseRvmat(rvmatName);
    const border=manifest.satellite.sourceBorderPixels||0,sourceSize=manifest.satellite.sourceTilePixels||info.mask.width,content=sourceSize-border*2;
    const localX=((wx%layerWorld)+layerWorld)%layerWorld,localZ=((wz%layerWorld)+layerWorld)%layerWorld;
    const u=(border+localX/layerWorld*content)/sourceSize,v=(border+(directFlipLocalY?layerWorld-localZ:localZ)/layerWorld*content)/sourceSize;
    const selectedSlot=sampleSlot(info.mask,u,v),surface=effectivePalette(cx,cy,info)[selectedSlot];if(!surface)continue;let index=signatureIndex.get(surface);if(index==null){index=signatures.length+1;signatureIndex.set(surface,index);signatures.push(surface)}labels[py*grid+px]=index;
  }
  // Soften hard category boundaries with a narrow ordered-dither transition
  // band, the same technique BI's own compiled mask uses at real material
  // transitions (verified directly against Chernarus source data: a sparse1/
  // dense1 boundary alternates *exact* canonical alpha values 128/255 pixel
  // by pixel). Categorical vector polygons can't alpha-blend across an edge,
  // but a few-cell-wide zone of tiny alternating polygons between the two
  // colors reads as a soft blend at normal zoom instead of a flat seam,
  // while staying fully inside the vector model - no rasterization needed.
  {
    const ditherRadius=2,bayer4=[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]],original=labels.slice();
    for(let py=0;py<grid;py++)for(let px=0;px<grid;px++){
      const ownLabel=original[py*grid+px];if(!ownLabel)continue;
      let bestDist=Infinity,bestLabel=0;
      for(let dy=-ditherRadius;dy<=ditherRadius;dy++)for(let dx=-ditherRadius;dx<=ditherRadius;dx++){
        if(!dx&&!dy)continue;
        const nx=px+dx,ny=py+dy;if(nx<0||nx>=grid||ny<0||ny>=grid)continue;
        const neighborLabel=original[ny*grid+nx];if(!neighborLabel||neighborLabel===ownLabel)continue;
        const dist=Math.max(Math.abs(dx),Math.abs(dy));
        if(dist<bestDist){bestDist=dist;bestLabel=neighborLabel}
      }
      if(bestDist===Infinity)continue;
      const weight=(ditherRadius+1-bestDist)/(ditherRadius+1),threshold=(bayer4[py&3][px&3]+.5)/16;
      if(weight>threshold)labels[py*grid+px]=bestLabel;
    }
  }
  const {contours}=await import('d3-contour'),features=[];
  for(let signature=0;signature<signatures.length;signature++){
    const value=signature+1,mask=Float32Array.from(labels,label=>label===value?1:0),result=contours().size([grid,grid]).thresholds([.5]).smooth(true)(mask)[0];if(!result?.coordinates?.length)continue;
    const coordinates=result.coordinates.map(polygon=>polygon.map(ring=>ring.map(([px,py])=>[minX+px*actualCell,maxZ-py*actualCell])));
    const surface=signatures[signature];features.push({type:'Feature',properties:{surface,dominantMaterial:surface,renderClass:'surface'},geometry:{type:'MultiPolygon',coordinates}});
  }
  const collection={type:'FeatureCollection',properties:{map:manifest.id,bounds:[minX,maxZ-sampledMeters,minX+sampledMeters,maxZ],requestedBounds:[x-meters/2,z-meters/2,x+meters/2,z+meters/2],cellMeters:actualCell,paddingCells,materialGrid:[materialWidth,materialHeight],flipMaterialY,layerWorld,directNorthRows,directFlipLocalY,classification:hasWrp?'wrp-confirmed-geometry-alpha-null-inherit-v1':'compiled-terrainx-six-slot-v1'},features};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,`${JSON.stringify(collection)}\n`);console.log(`Categorical surface vectors: ${output}`);console.log(`${features.length} materials on ${grid}x${grid} grid`);
}
main().catch(error=>{console.error(error.stack||error.message);process.exit(1)});
