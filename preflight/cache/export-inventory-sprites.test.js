const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {exportSprites} = require('./export-inventory-sprites');

test('rock path expansion retains the base release and only adds complete cached rocks', async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'inventory-rocks-'));
  const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));return file;};
  try {
    const id='a'.repeat(24), base={schemaVersion:1,version:'old',classes:{house:{footprint:id}},sprites:{[id]:{image:`${id}.png`,topographic:`${id}.json`}}};
    const baseCatalog=write('base/catalog.json',base);
    write(`base/${id}.png`,'existing pixels');write(`base/${id}.json`,{type:'MultiPolygon',coordinates:[]});
    write('rock.png','rock pixels');
    write('rock-meta.json',{imageSize:100,metersPerPixel:.1,bounds:{minX:0,maxX:10,minY:0,maxY:10,minZ:0,maxZ:10}});
    const geometry={type:'MultiPolygon',coordinates:[[[[0,0],[10,0],[0,10],[0,0]]]]};
    write('rock-vector.json',{geometry});
    const models={};
    for(const name of ['DZ/rocks/rock1.p3d','dz/rocks_bliss/rock2.p3d','dz/rocks_sakhal/rock3.p3d','dz/structures/house.p3d'])
      models[name]={status:'complete',image:'rock.png',metadata:'rock-meta.json'};
    models['dz/rocks/missing.p3d']={status:'failed'};
    write('out/mapdraw/cache/chernarusplus/cache-state.json',{models});
    write('out/mapdraw/vector-cache/chernarusplus/cache-state.json',{models:Object.fromEntries(Object.keys(models).map(n=>[n,{status:'complete',footprint:'rock-vector.json'}]))});
    const output=path.join(root,'release');
    const result=await exportSprites({root,baseCatalog,rockPaths:true,output});
    const catalog=JSON.parse(fs.readFileSync(path.join(output,'catalog.json')));
    assert.equal(result.classes,4);assert.deepEqual(catalog.classes.house,base.classes.house);
    for(const model of ['dz\\rocks\\rock1.p3d','dz\\rocks_bliss\\rock2.p3d','dz\\rocks_sakhal\\rock3.p3d']) {
      const sprite=catalog.sprites[catalog.classes[model].footprint];
      assert.equal(catalog.classes[model].status,'ready');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,sprite.topographic))),geometry);
    }
    assert.equal(fs.readFileSync(path.join(output,`${id}.png`),'utf8'),'existing pixels');
    assert.deepEqual(JSON.parse(fs.readFileSync(baseCatalog)),base,'base release remains unchanged');
    assert.equal(catalog.classes['dz\\structures\\house.p3d'],undefined);
    assert.equal(catalog.classes['dz\\rocks\\missing.p3d'],undefined);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('NoLC and regular classes and paths share sprites in either cache direction',()=>{
 const {shareNoLcSprites}=require('./export-inventory-sprites');
 for(const cached of ['wall','wall_nolc']) {
  const model='dz\\walls\\'+cached+'.p3d',entry={model,footprint:'sprite',status:'ready'};
  const catalog={classes:{[cached]:entry,other:{model:'dz/other.p3d',footprint:'other',status:'ready'}},sprites:{sprite:{},other:{}}};
  shareNoLcSprites(catalog,new Map([['wall','dz/walls/wall.p3d'],['wall_nolc','dz/walls/wall_nolc.p3d'],['wall_turn','dz/walls/wall_turn.p3d']]));
  for(const name of ['wall','wall_nolc','dz\\walls\\wall.p3d','dz\\walls\\wall_nolc.p3d'])assert.equal(catalog.classes[name].footprint,'sprite');
  assert.equal(catalog.classes.wall_turn,undefined);assert.equal(catalog.classes.other.footprint,'other');
 }
});
