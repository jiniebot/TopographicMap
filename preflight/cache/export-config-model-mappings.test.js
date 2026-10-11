const test=require('node:test'),assert=require('node:assert/strict');
const {resolveMappings}=require('./export-config-model-mappings');
test('resolves inherited models without guessing and rejects ambiguous or cyclic definitions',()=>{
  const definitions=new Map([
    ['base',[{model:'\\DZ/structures/House.p3d'}]],
    ['child',[{base:'BASE'}]],
    ['override',[{base:'child',model:'dz/other.p3d'}]],
    ['empty',[{base:'base',model:''}]],
    ['conflict',[{model:'dz/a.p3d'},{model:'dz/b.p3d'}]],
    ['conflictchild',[{base:'conflict'}]],
    ['cyclea',[{base:'cycleb'}]],['cycleb',[{base:'cyclea'}]],
    ['unknown',[{base:'missing'}]]
  ]);
  assert.deepEqual(resolveMappings(definitions),{base:'dz\\structures\\house.p3d',child:'dz\\structures\\house.p3d',override:'dz\\other.p3d'});
});
