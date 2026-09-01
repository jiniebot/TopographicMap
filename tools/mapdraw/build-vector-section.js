#!/usr/bin/env node

// Places every model intersecting a bounded section. Supported P3Ds use their
// true projected silhouette; unsupported models receive an explicit fallback
// symbol instead of silently disappearing. Water footprints are candidate
// extents and are clipped against terrain at each placement's own elevation.

const fs = require('fs');
const path = require('path');
const { loadMapManifest } = require('./map-build-config');
const { openTransformIndex } = require('./transform-index');
const { loadElevationGrid } = require('../tiling/elevation');
const { union } = require('polyclip-ts');

const ROOT = path.resolve(__dirname, '..', '..');
function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
function geometryBBox(coordinates) {
  const box=[Infinity,Infinity,-Infinity,-Infinity];
  for(const polygon of coordinates)for(const ring of polygon)for(const [x,z] of ring){box[0]=Math.min(box[0],x);box[1]=Math.min(box[1],z);box[2]=Math.max(box[2],x);box[3]=Math.max(box[3],z)}
  return box;
}
function overlaps(a,b){return a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1]}
function boxesNear(a,b,gap){return a[0]<=b[2]+gap&&a[2]>=b[0]-gap&&a[1]<=b[3]+gap&&a[3]>=b[1]-gap}
function clusterNearby(surfaces,gap=10){
  const boxes=surfaces.map(surface=>geometryBBox(surface.coordinates)),seen=new Uint8Array(surfaces.length),groups=[];
  for(let seed=0;seed<surfaces.length;seed++)if(!seen[seed]){
    const indexes=[],queue=[seed];seen[seed]=1;
    while(queue.length){const i=queue.pop();indexes.push(i);for(let j=0;j<surfaces.length;j++)if(!seen[j]&&boxesNear(boxes[i],boxes[j],gap)){seen[j]=1;queue.push(j)}}
    groups.push(indexes.map(i=>surfaces[i]));
  }
  return groups;
}
// ODOL vertices that describe a shared nominal edge can differ by a few
// centimetres after placement transforms. Quantize water only, before union,
// so those authored joins become mathematically identical.
function snapGeometry(coordinates,step=.25){return coordinates.map(polygon=>polygon.map(ring=>ring.map(([x,z])=>[
  Math.round(x/step)*step,Math.round(z/step)*step
]))) }
// ice_sea\ice_sea_(piece|square|triangle)*.p3d are floating iceberg chunks
// with real vertical relief (up to ~3m, per cached footprint minY/maxY) -
// not a flat water-surface plane like ice_lake/ice_underlayer/water_volcanic
// (all minY===maxY===0 or near it). Treating them as water meant they were
// silently folded into the water mask instead of ever being rendered as
// their own visible object.
function isIcebergChunkModel(model){return /(?:^|\\)water_sakhal\\ice_sea\\ice_sea_(?:piece|square|triangle)/i.test(model)}
function isWaterModel(model){if(isIcebergChunkModel(model))return false;return /(?:^|\\)water(?:_(?:bliss|sakhal))?\\/i.test(model)||/(?:^|\\)(?:pond|river|lake)[^\\]*\.p3d$/i.test(model)}
function isSupplementalWaterModel(model){return /(?:^|\\)water_sakhal\\ice_lake\\sakhal_50x50_ice_lake_clear\.p3d$/i.test(model)}
function isGroundPanel(model){return /\\roads\\panels\\panels?_concrete/i.test(model)}
// Rail track pieces (dz\structures\rail\tracks\rail_track[e]_*.p3d, straight
// and l/r-curve segments analogous to road pieces) are never WRP-flagged as
// road (isRoad checks record.flags&1 - confirmed empirically: every rail
// track placement has flags=2, every road curve placement has flags=3), so
// they never got the road-only center-placement transform or union merge,
// leaving each piece placed at its raw bbox center and rendered standalone -
// visually disjointed at every joint instead of a continuous line.
function isRailModel(model){return /(?:^|\\)rail\\tracks\\/i.test(model)}
function isRockModel(model){return /(?:^|\\)(?:rocks?|rockformations?)(?:\\|_)|(?:^|\\)[^\\]*(?:rock|boulder)[^\\]*\.p3d$/i.test(model)&&!/wall/i.test(model)}
function pointInRing(x,z,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside}return inside}
function signedRingArea(ring){let area=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++)area+=ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1];return area/2}
function normalizePolygonWinding(polygon){return polygon.map((ring,index)=>{
  const shouldBeCounterClockwise=index===0;
  const isCounterClockwise=signedRingArea(ring)>0;
  return shouldBeCounterClockwise===isCounterClockwise?ring:ring.slice().reverse();
})}
function pointInGeometry(x,z,geometry){for(const polygon of geometry){if(!pointInRing(x,z,polygon[0]))continue;let hole=false;for(const ring of polygon.slice(1))if(pointInRing(x,z,ring)){hole=true;break}if(!hole)return true}return false}
function sampleTerrainMesh(elevation,x,z){
  const {grid,width,height,step}=elevation,fx=x/step,fz=z/step,c=Math.floor(fx),r=Math.floor(fz);
  if(c<0||r<0||c+1>=width||r+1>=height)return null;
  const tx=fx-c,tz=fz-r,v00=grid[r*width+c],v10=grid[r*width+c+1],v01=grid[(r+1)*width+c],v11=grid[(r+1)*width+c+1];
  // Terrain cells are planar triangles, not bilinear patches. Interpolate on
  // the two triangles sharing v00-v11 so shore occlusion matches the mesh.
  return tx>=tz?v00+tx*(v10-v00)+tz*(v11-v10):v00+tz*(v01-v00)+tx*(v11-v01);
}
function mergeRenderClass(features,predicate,properties){
  const selected=features.filter(predicate);if(selected.length<2)return features;
  try{
    const geometry=union(...selected.map(feature=>feature.geometry.coordinates));
    const retained=features.filter(feature=>!predicate(feature));
    retained.push({type:'Feature',properties:{...properties,sourcePlacements:selected.length},geometry:{type:'MultiPolygon',coordinates:geometry}});
    return retained;
  }catch(error){console.warn(`Unable to union ${properties.renderClass}: ${error.message}`);return features}
}

// Remove one-cell islands and narrow shoreline spurs introduced when a broad
// rectangular water P3D overlaps nearby terrain that happens to sit below the
// water plane. A cross-shaped opening is deliberately conservative: erosion
// removes features narrower than roughly two mask cells, then dilation restores
// the boundary of the coherent water body.
function cleanWaterMask(values,width,height){
  // Close one-cell cracks first (dilate then erode), then remove isolated
  // one-cell shoreline noise. Closing restores the original outer extent but
  // joins candidate surfaces separated only by raster/float precision.
  const dilated=new Float32Array(values.length),closed=new Float32Array(values.length);
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;
    if(values[i]||values[i-1]||values[i+1]||values[i-width]||values[i+width])dilated[i]=1;
  }
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;
    if(dilated[i]&&dilated[i-1]&&dilated[i+1]&&dilated[i-width]&&dilated[i+width])closed[i]=1;
  }
  const eroded=new Float32Array(values.length),cleaned=new Float32Array(values.length);
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;
    if(closed[i]&&closed[i-1]&&closed[i+1]&&closed[i-width]&&closed[i+width])eroded[i]=1;
  }
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;
    if(eroded[i]||eroded[i-1]||eroded[i+1]||eroded[i-width]||eroded[i+width])cleaned[i]=1;
  }
  return cleaned;
}

function closeMask(values,width,height,iterations){
  let current=values;
  for(let pass=0;pass<iterations;pass++){
    const next=new Float32Array(values.length);
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){const i=y*width+x;if(current[i]||current[i-1]||current[i+1]||current[i-width]||current[i+width])next[i]=1}
    current=next;
  }
  for(let pass=0;pass<iterations;pass++){
    const next=new Float32Array(values.length);
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){const i=y*width+x;if(current[i]&&current[i-1]&&current[i+1]&&current[i-width]&&current[i+width])next[i]=1}
    current=next;
  }
  return current;
}

async function maskWater(coordinates, surfaces, elevation, fixedWaterElevation=null) {
  const bbox=geometryBBox(coordinates), cell=1,pad=12;
  bbox[0]-=pad;bbox[1]-=pad;bbox[2]+=pad;bbox[3]+=pad;
  const width=Math.max(2,Math.ceil((bbox[2]-bbox[0])/cell)),height=Math.max(2,Math.ceil((bbox[3]-bbox[1])/cell));
  const candidates=new Float32Array(width*height),values=new Float32Array(width*height);
  for(let gy=0;gy<height;gy++)for(let gx=0;gx<width;gx++){
    const wx=bbox[0]+(gx+.5)/width*(bbox[2]-bbox[0]),wz=bbox[1]+(gy+.5)/height*(bbox[3]-bbox[1]);
    if(pointInGeometry(wx,wz,coordinates))candidates[gy*width+gx]=1;
  }
  // Jantar tiles are nominally contiguous but their visual LOD silhouettes
  // can stop several metres short. Bridge that candidate-only gap first;
  // terrain masking below still prevents the bridge from painting dry banks.
  const joinedCandidates=closeMask(candidates,width,height,10);
  for(let gy=0;gy<height;gy++)for(let gx=0;gx<width;gx++){
    if(!joinedCandidates[gy*width+gx])continue;
    const wx=bbox[0]+(gx+.5)/width*(bbox[2]-bbox[0]),wz=bbox[1]+(gy+.5)/height*(bbox[3]-bbox[1]);
    const terrain=sampleTerrainMesh(elevation,wx,wz);if(terrain===null)continue;
    let waterElevation=fixedWaterElevation;
    if(waterElevation==null){
      const contributors=surfaces.filter(surface=>pointInGeometry(wx,wz,surface.coordinates));
      if(!contributors.length)continue;
      let sumWeight=0,sumElevation=0;
      for(const surface of contributors){const distance2=(wx-surface.x)**2+(wz-surface.z)**2;const weight=1/Math.max(1,distance2);sumWeight+=weight;sumElevation+=surface.elevation*weight}
      waterElevation=sumElevation/sumWeight;
    }
    if(terrain<=waterElevation+.2)values[gy*width+gx]=1;
  }
  const cleaned=cleanWaterMask(values,width,height);
  const { contours }=await import('d3-contour');
  const result=contours().size([width,height]).thresholds([.5]).smooth(true)(cleaned)[0];
  if(!result?.coordinates?.length)return [];
  return result.coordinates.map(polygon=>normalizePolygonWinding(polygon.map(ring=>ring.map(([gx,gy])=>[
    bbox[0]+gx/width*(bbox[2]-bbox[0]),bbox[1]+gy/height*(bbox[3]-bbox[1])
  ]))));
}

async function main(){
  const manifest=loadMapManifest(arg('--manifest',path.join(ROOT,'configs','maps','livonia.json')));
  const x=Number(arg('--x',6600)),z=Number(arg('--z',8930)),meters=Number(arg('--meters',400));
  const waterPadding=Number(arg('--water-padding',400));
  const aggregateCell=Number(arg('--aggregate-cell',0));
  const output=path.resolve(ROOT,arg('--out',`out/mapdraw/vector-tests/section-${x}-${z}-${meters}m.geojson`));
  if(![x,z,meters].every(Number.isFinite)||meters<=0)throw new Error('Invalid section coordinates');
  const index=openTransformIndex(manifest.transformIndex);
  const statePath=path.join(ROOT,'out','mapdraw','vector-cache',manifest.world,'cache-state.json');
  const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
  const footprints=new Map();
  for(const [model,entry] of Object.entries(state.models))if(entry.status==='complete')footprints.set(model,JSON.parse(fs.readFileSync(path.join(ROOT,entry.footprint),'utf8')));
  const elevation=loadElevationGrid(ROOT,{file:manifest.elevation.file,width:manifest.elevation.width,height:manifest.elevation.height,step:manifest.mapSize/(manifest.elevation.width-1)});
  const h=meters/2,bounds=[x-h,z-h,x+h,z+h],waterBounds=[bounds[0]-waterPadding,bounds[1]-waterPadding,bounds[2]+waterPadding,bounds[3]+waterPadding],tileWorld=manifest.mapSize/index.meta.side;
  const tx0=Math.max(0,Math.floor(bounds[0]/tileWorld)-1),tx1=Math.min(index.meta.side-1,Math.floor(bounds[2]/tileWorld)+1);
  const ty0=Math.max(0,Math.floor((manifest.mapSize-bounds[3])/tileWorld)-1),ty1=Math.min(index.meta.side-1,Math.floor((manifest.mapSize-bounds[1])/tileWorld)+1);
  const members=new Set();for(let ty=ty0;ty<=ty1;ty++)for(let tx=tx0;tx<=tx1;tx++)for(const i of index.membersForTile(tx,ty))members.add(i);
  const wtx0=Math.max(0,Math.floor(waterBounds[0]/tileWorld)-1),wtx1=Math.min(index.meta.side-1,Math.floor(waterBounds[2]/tileWorld)+1);
  const wty0=Math.max(0,Math.floor((manifest.mapSize-waterBounds[3])/tileWorld)-1),wty1=Math.min(index.meta.side-1,Math.floor((manifest.mapSize-waterBounds[1])/tileWorld)+1);
  for(let ty=wty0;ty<=wty1;ty++)for(let tx=wtx0;tx<=wtx1;tx++)for(const i of index.membersForTile(tx,ty)){
    const record=index.readRecord(i),model=index.meta.models[record.modelIndex]?.model||'';
    if(isWaterModel(model))members.add(i);
  }
  const features=[];const waterCandidates=[];let unsupportedPlacements=0,waterCount=0,aggregatedPlacements=0;
  const aggregateSide=aggregateCell>0?Math.ceil(meters/aggregateCell):0,aggregateGrid=aggregateCell>0?new Array(aggregateSide*aggregateSide):null;
  function aggregateFeature(model,properties,coordinates,box){
    const minCx=Math.max(0,Math.floor((box[0]-bounds[0])/aggregateCell)),maxCx=Math.min(aggregateSide-1,Math.floor((box[2]-bounds[0])/aggregateCell));
    const minCz=Math.max(0,Math.floor((box[1]-bounds[1])/aggregateCell)),maxCz=Math.min(aggregateSide-1,Math.floor((box[3]-bounds[1])/aggregateCell));let marked=0;
    for(let cz=minCz;cz<=maxCz;cz++)for(let cx=minCx;cx<=maxCx;cx++){const wx=bounds[0]+(cx+.5)*aggregateCell,wz=bounds[1]+(cz+.5)*aggregateCell;if(!pointInGeometry(wx,wz,coordinates))continue;const index=cz*aggregateSide+cx,prior=aggregateGrid[index];if(!prior||properties.topElevation>=prior.properties.topElevation)aggregateGrid[index]={model,properties:{...properties,geometrySource:'low-zoom-topmost-coverage',sourcePlacements:(prior?.properties.sourcePlacements||0)+1},cx,cz};else prior.properties.sourcePlacements=(prior.properties.sourcePlacements||0)+1;marked++}
    if(!marked){const centerX=(box[0]+box[2])/2,centerZ=(box[1]+box[3])/2,cx=Math.max(0,Math.min(aggregateSide-1,Math.floor((centerX-bounds[0])/aggregateCell))),cz=Math.max(0,Math.min(aggregateSide-1,Math.floor((centerZ-bounds[1])/aggregateCell))),index=cz*aggregateSide+cx,prior=aggregateGrid[index];if(!prior||properties.topElevation>=prior.properties.topElevation)aggregateGrid[index]={model,properties:{...properties,geometrySource:'low-zoom-topmost-coverage',sourcePlacements:(prior?.properties.sourcePlacements||0)+1},cx,cz};else prior.properties.sourcePlacements=(prior.properties.sourcePlacements||0)+1}
    aggregatedPlacements++;
  }
  for(const recordIndex of members){
    const record=index.readRecord(recordIndex),modelInfo=index.meta.models[record.modelIndex],model=modelInfo.model,footprint=footprints.get(model),b=record.basis;
    let coordinates,maxY,geometrySource;
    if(footprint){
      const isRoad=(record.flags&1)!==0,isWaterPlacement=isWaterModel(model),isRail=isRailModel(model);
      const localBounds=geometryBBox(footprint.geometry.coordinates);
      // WRP water records place the visual center of the compiled surface,
      // including the irregular Jantar mosaic pieces. This is the placement
      // rule used by the last known-good v5 output. Union tolerance is handled
      // separately and must not alter this transform. Rail pieces use the
      // same origin-at-center authoring convention as road pieces even
      // though the WRP road flag isn't set on them.
      const centerPlaced=isRoad||isWaterPlacement||isRail;
      const centerX=centerPlaced?(localBounds[0]+localBounds[2])/2:0;
      const centerZ=centerPlaced?(localBounds[1]+localBounds[3])/2:0;
      const reverseRoad=isRoad&&/konec\.p3d$/i.test(model);
      coordinates=footprint.geometry.coordinates.map(polygon=>polygon.map(ring=>ring.map(([lx,lz])=>{
        let localX=lx-centerX,localZ=lz-centerZ;
        if(reverseRoad){localX=-localX;localZ=-localZ}
        // Match the proven satellite Canvas transform exactly. Its screen-Y
        // inversion means the effective world X/Z projection uses b0,b6 for
        // X and b2,b8 for Z (the off-diagonal terms are transposed versus a
        // naive row-major interpretation of the stored 8WVR basis).
        return [record.x+b[0]*localX+b[6]*localZ,record.z+b[2]*localX+b[8]*localZ];
      })));
      maxY=footprint.properties.maxY;geometrySource='p3d';
    }else{if(record.x>=bounds[0]&&record.x<=bounds[2]&&record.z>=bounds[1]&&record.z<=bounds[3])unsupportedPlacements++;continue}
    const placedBox=geometryBBox(coordinates);
    if(!overlaps(placedBox,isWaterModel(model)?waterBounds:bounds))continue;
    const isRoad=(record.flags&1)!==0;
    const isRail=isRailModel(model);
    const isWater=isWaterModel(model);
    if(isWater){
      // Maps with authoritative elevation-derived water do not also render
      // broad water P3Ds; that would duplicate and distort their coastlines.
      if(manifest.water?.source!=='terrain-elevation'||isSupplementalWaterModel(model)){waterCandidates.push({coordinates:snapGeometry(coordinates),elevation:record.y,x:record.x,z:record.z,id:record.id,waterType:/ice_lake/i.test(model)?'ice':/moss/i.test(model)?'moss':'regular'});waterCount++}
      continue;
    }
    const groundPanel=isGroundPanel(model),rock=isRockModel(model);
    const forcedElevation=groundPanel?-150000:rock?-120000:null;
    const properties={id:record.id,model,modelIndex:record.modelIndex,geometrySource,isWater,isRoad,isRail,isGroundPanel:groundPanel,isRock:rock,baseElevation:forcedElevation??record.y,topElevation:forcedElevation??record.y+Math.abs(b[4])*maxY};
    const size=Math.max(placedBox[2]-placedBox[0],placedBox[3]-placedBox[1]);
    if(aggregateCell>0&&!isRoad&&!isRail&&!groundPanel&&!/\\rail\\|rail_track|railway/i.test(model)&&size<=aggregateCell*2.5)aggregateFeature(model,properties,coordinates,placedBox);
    else features.push({type:'Feature',properties,geometry:{type:'MultiPolygon',coordinates}});
  }
  if(aggregateGrid)for(const cell of aggregateGrid)if(cell){const x0=bounds[0]+cell.cx*aggregateCell,z0=bounds[1]+cell.cz*aggregateCell,x1=Math.min(bounds[2],x0+aggregateCell),z1=Math.min(bounds[3],z0+aggregateCell);features.push({type:'Feature',properties:cell.properties,geometry:{type:'MultiPolygon',coordinates:[[[[x0,z0],[x1,z0],[x1,z1],[x0,z1],[x0,z0]]]]}})}
  let candidateWaterPolygons=0,maskedWaterPolygons=0;
  if(waterCandidates.length){
    for(const waterType of [...new Set(waterCandidates.map(surface=>surface.waterType))]){
      const allOfType=waterCandidates.filter(surface=>surface.waterType===waterType),groups=clusterNearby(allOfType,10);
      const masked=[];
      for(const group of groups){
        const component=group.flatMap(surface=>surface.coordinates);
        // This union only feeds the informational candidateWaterPolygons
        // count below - the real output geometry comes from maskWater()
        // just after. polyclip-ts can throw on numerically degenerate rings
        // (e.g. a near-zero-width sliver), which must not abort the whole
        // tile over a logging count; fall back to the unmerged polygon count.
        try{candidateWaterPolygons+=union(...group.map(surface=>surface.coordinates)).length}
        catch(error){console.warn(`Unable to union water candidates (${group.length} polygons): ${error.message}`);candidateWaterPolygons+=group.length}
        const elevations=group.map(surface=>surface.elevation).sort((a,b)=>a-b);
        const bodyElevation=elevations.length?elevations[Math.floor(elevations.length/2)]:null;
        masked.push(...await maskWater(component,group,elevation,bodyElevation));
      }
      maskedWaterPolygons+=masked.length;
      if(masked.length)features.push({type:'Feature',properties:{model:`__merged_water_${waterType}__`,isWater:true,isRoad:false,waterType,geometrySource:'p3d-near-union+terrain-mask',renderClass:'water',sourcePlacements:allOfType.length,topElevation:-200000,baseElevation:-200000},geometry:{type:'MultiPolygon',coordinates:masked}});
    }
  }
  let renderFeatures=mergeRenderClass(features,feature=>feature.properties.isRoad,{model:'__merged_roads__',isWater:false,isRoad:true,geometrySource:'p3d-union',renderClass:'roads',topElevation:-100000,baseElevation:-100000});
  renderFeatures=mergeRenderClass(renderFeatures,feature=>feature.properties.isRail,{model:'__merged_rail__',isWater:false,isRoad:false,isRail:true,geometrySource:'p3d-union',renderClass:'rail',topElevation:-100000,baseElevation:-100000});
  renderFeatures.sort((a,b)=>{
    const rank=feature=>feature.properties.isWater?0:feature.properties.isGroundPanel?1:feature.properties.isRock?2:feature.properties.isRoad||feature.properties.isRail?3:4;
    return rank(a)-rank(b)||a.properties.topElevation-b.properties.topElevation;
  });
  const collectionProperties={map:manifest.id,bounds,cachedModels:footprints.size,unsupportedPlacements,maskedWaterFeatures:waterCount,candidateWaterPolygons,maskedWaterPolygons,aggregatedPlacements,aggregateCell,sourceFeatures:features.length};
  fs.mkdirSync(path.dirname(output),{recursive:true});
  // A dense tile (thousands of individually-placed rocks/trees, each with a
  // full-precision footprint) can produce a combined feature array well
  // past V8's ~536M-character single-string limit - JSON.stringify(collection)
  // in one call throws "Invalid string length" long before running out of
  // actual memory. Writing feature-by-feature keeps every individual
  // JSON.stringify call small regardless of how many features there are,
  // producing the exact same file on disk (byte-for-byte equivalent
  // FeatureCollection JSON) without that ceiling.
  const fd=fs.openSync(output,'w');
  fs.writeSync(fd,`{"type":"FeatureCollection","properties":${JSON.stringify(collectionProperties)},"features":[`);
  renderFeatures.forEach((feature,index)=>{fs.writeSync(fd,`${index?',':''}${JSON.stringify(feature)}`)});
  fs.writeSync(fd,']}\n');
  fs.closeSync(fd);
  console.log(`Vector section: ${output}`);
  console.log(`${features.length.toLocaleString()} placed footprints -> ${renderFeatures.length.toLocaleString()} render features; ${unsupportedPlacements} unsupported placements omitted; ${waterCount} locally masked water (${members.size.toLocaleString()} candidates)`);
}
main().catch(error=>{console.error(error.stack||error.message);process.exit(1)});
