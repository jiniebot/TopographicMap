#!/usr/bin/env node
// Creates map-wide water polygons from a manifest's elevation-water rule.
// Elevation rows use world Z order: row zero is the southwest/bottom edge.
const fs=require('fs');
const path=require('path');
const {loadMapManifest,PROJECT_ROOT}=require('./map-build-config');
const {loadElevationGrid}=require('../tiling/elevation');
function arg(name,fallback){const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
function signedArea(ring){let area=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++)area+=ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1];return area/2}
function normalize(polygon){return polygon.map((ring,i)=>((signedArea(ring)>0)===(i===0)?ring:ring.slice().reverse()))}
async function main(){
  const manifest=loadMapManifest(arg('--manifest','configs/maps/chernarus.json'));
  if(manifest.water?.source!=='terrain-elevation'||!Number.isFinite(manifest.water.belowElevation))throw new Error('Manifest has no terrain-elevation water rule');
  const output=path.resolve(PROJECT_ROOT,arg('--out',`out/mapdraw/topographic-base/${manifest.id}/water.geojson`));
  const elevation=loadElevationGrid(PROJECT_ROOT,{file:manifest.elevation.file,width:manifest.elevation.width,height:manifest.elevation.height,step:manifest.mapSize/(manifest.elevation.width-1)});
  const {grid,width,height}=elevation,mask=Float32Array.from(grid,value=>value<manifest.water.belowElevation?1:0);
  const {contours}=await import('d3-contour'),result=contours().size([width,height]).thresholds([.5]).smooth(true)(mask)[0];
  const coordinates=(result?.coordinates||[]).map(polygon=>normalize(polygon.map(ring=>ring.map(([px,py])=>[
    px/(width-1)*manifest.mapSize,py/(height-1)*manifest.mapSize
  ]))));
  const collection={type:'FeatureCollection',properties:{map:manifest.id,source:'terrain-elevation',belowElevation:manifest.water.belowElevation},features:coordinates.length?[{type:'Feature',properties:{model:'__terrain_water__',isWater:true,waterType:'regular',renderClass:'water',topElevation:-200000,baseElevation:-200000},geometry:{type:'MultiPolygon',coordinates}}]:[]};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,`${JSON.stringify(collection)}\n`);
  console.log(`Elevation water: ${coordinates.length} polygons -> ${output}`);
}
main().catch(error=>{console.error(error.stack||error.message);process.exit(1)});
