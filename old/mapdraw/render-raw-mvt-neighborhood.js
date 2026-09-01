#!/usr/bin/env node
const fs=require('fs');
const path=require('path');
const {createCanvas}=require('@napi-rs/canvas');

const ROOT=path.resolve(__dirname,'..','..');
function arg(name,fallback){const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}

async function main(){
  const {VectorTile}=await import('@mapbox/vector-tile');
  const Pbf=(await import('pbf')).default;
  const root=path.resolve(ROOT,arg('--tiles','out/mapdraw/vector-tests/object-tiles-fast'));
  const zoom=Number(arg('--zoom',8)),worldX=Number(arg('--x',6657)),worldZ=Number(arg('--z',8920));
  const mapSize=Number(arg('--map-size',12800)),tileWorld=mapSize/2**zoom;
  const centerX=Math.floor(worldX/tileWorld),centerY=Math.floor((mapSize-worldZ)/tileWorld);
  const size=256,canvas=createCanvas(size*3,size*3),ctx=canvas.getContext('2d');
  ctx.fillStyle='#e8eadf';ctx.fillRect(0,0,canvas.width,canvas.height);
  for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
    const tx=centerX+ox,ty=centerY+oy,file=path.join(root,String(zoom),String(tx),`${ty}.pbf`);
    const dx=(ox+1)*size,dy=(oy+1)*size;
    if(fs.existsSync(file)){
      const layer=new VectorTile(new Pbf(fs.readFileSync(file))).layers.objects;
      if(layer)for(let i=0;i<layer.length;i++){
        const feature=layer.feature(i),water=feature.properties.isWater===true||feature.properties.isWater===1;
        const road=feature.properties.isRoad===true||feature.properties.isRoad===1;
        ctx.beginPath();
        for(const ring of feature.loadGeometry()){
          for(let p=0;p<ring.length;p++){
            const x=dx+ring[p].x/4096*size,y=dy+ring[p].y/4096*size;
            if(p===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
          }
          ctx.closePath();
        }
        ctx.fillStyle=water?'#76a9d4':road?'#555957':'rgba(65,72,66,.34)';
        ctx.fill('evenodd');
      }
    }
    ctx.strokeStyle='rgba(190,40,40,.8)';ctx.lineWidth=1;ctx.strokeRect(dx+.5,dy+.5,size-1,size-1);
    ctx.fillStyle='#9b2020';ctx.font='13px sans-serif';ctx.fillText(`z${zoom} ${tx}/${ty}`,dx+6,dy+17);
  }
  const px=(worldX/tileWorld-centerX+1)*size,py=((mapSize-worldZ)/tileWorld-centerY+1)*size;
  ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.beginPath();ctx.arc(px,py,7,0,Math.PI*2);ctx.stroke();
  const output=path.resolve(ROOT,arg('--out',`out/mapdraw/vector-tests/raw-z${zoom}-${worldX}-${worldZ}.png`));
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,canvas.toBuffer('image/png'));
  console.log(output);
}
main().catch(error=>{console.error(error.stack||error);process.exit(1)});
