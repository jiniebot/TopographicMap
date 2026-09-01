#!/usr/bin/env node

// Recover a vector footprint by tracing the alpha channel of an already
// successful top-down raster cache entry. This is used when exact triangle
// polygon clipping fails; it preserves visible geometry without inventing a
// bounding-box placeholder.
const fs=require('fs');
const path=require('path');
const {createCanvas,loadImage}=require('@napi-rs/canvas');

async function main(){
  const imagePath=path.resolve(process.argv[2]||'');
  const metadataPath=path.resolve(process.argv[3]||'');
  const outputPath=path.resolve(process.argv[4]||'');
  if(!fs.existsSync(imagePath)||!fs.existsSync(metadataPath))throw new Error('Usage: extract-raster-footprint.js <top.png> <top.json> <output.geojson>');
  const metadata=JSON.parse(fs.readFileSync(metadataPath,'utf8')),image=await loadImage(imagePath);
  const canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
  const pixels=ctx.getImageData(0,0,image.width,image.height).data,values=new Float32Array(image.width*image.height);
  for(let i=0;i<values.length;i++)values[i]=pixels[i*4+3]>=32?1:0;
  const {contours}=await import('d3-contour');
  const shape=contours().size([image.width,image.height]).thresholds([.5]).smooth(true)(values)[0];
  if(!shape?.coordinates?.length)throw new Error('Raster cache has no visible alpha silhouette');
  const b=metadata.bounds,width=b.maxX-b.minX,height=b.maxZ-b.minZ,margin=Math.max(width,height)*.04;
  const scale=Math.min(image.width/(width+margin*2),image.height/(height+margin*2));
  const offsetX=(image.width-width*scale)/2,offsetY=(image.height-height*scale)/2;
  const coordinates=shape.coordinates.map(polygon=>polygon.map(ring=>ring.map(([px,py])=>[
    b.minX+(px-offsetX)/scale,
    b.maxZ-(py-offsetY)/scale,
  ])));
  const vertexCount=coordinates.reduce((sum,polygon)=>sum+polygon.reduce((n,ring)=>n+ring.length,0),0);
  const feature={type:'Feature',properties:{schemaVersion:1,model:metadata.model,source:imagePath,lodResolution:metadata.lodResolution,footprintMethod:'raster-alpha-recovery',polygonCount:coordinates.length,vertexCount,minY:b.minY,maxY:b.maxY},geometry:{type:'MultiPolygon',coordinates}};
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,`${JSON.stringify(feature)}\n`);
  console.log(`Recovered raster footprint: ${outputPath} (${coordinates.length} polygons, ${vertexCount} vertices)`);
}
main().catch(error=>{console.error(error.stack||error.message);process.exit(1)});
