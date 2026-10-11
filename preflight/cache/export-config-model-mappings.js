'use strict';
// Read actual CfgVehicles definitions, including inherited models; never infer
// class names from P3D filenames. Conflicting definitions remain unresolved.
const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const normalize = value => String(value).replace(/\//g,'\\').replace(/^\\+/,'').toLowerCase();
function resolveMappings(definitions) {
  const memo = new Map();
  function resolve(name, stack = new Set()) {
    name = name.toLowerCase();
    if (stack.has(name)) return null;
    if (memo.has(name)) return memo.get(name);
    const entries = definitions.get(name);
    if (!entries) return null;
    const next = new Set(stack); next.add(name);
    const values = entries.map(entry => entry.model !== undefined ? normalize(entry.model) : entry.base ? resolve(entry.base,next) : null);
    const value = values.every(v => v && v === values[0]) && /\.p3d$/i.test(values[0]) ? values[0] : null;
    memo.set(name,value); return value;
  }
  return Object.fromEntries([...definitions.keys()].sort().map(name => [name,resolve(name)]).filter(([,model]) => model));
}
async function exportMappings(assetRoot, output) {
  const {Parser} = await import(pathToFileURL(path.resolve(__dirname,'../../vendor/BIS-Toolkit/packages/cppparser/dist/index.js')).href);
  const files = [];
  function walk(dir) { for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const name = path.join(dir,item.name);
    if (item.isDirectory()) walk(name); else if (item.name.toLowerCase()==='config.cpp') files.push(name);
  } }
  walk(path.join(assetRoot,'DZ'));
  const definitions = new Map(), errors = [];
  for (const file of files.sort()) {
    try {
      const text = fs.readFileSync(file,'utf8');
      if (!/class\s+CfgVehicles\b/.test(text)) continue;
      if (/^\s*#/m.test(text)) throw Error('Preprocessor directives require a runtime export');
      const ast = new Parser(text,file).parse();
      for (const section of ast.statements.filter(s => s.kind==='class' && s.name.toLowerCase()==='cfgvehicles')) {
        for (const entry of section.properties.values()) {
          if (entry.kind!=='class') continue;
          const name=entry.name.toLowerCase(), model=entry.properties.get('model');
          if (model && (model.kind!=='variable' || typeof model.value!=='string')) throw Error('Non-string model '+name);
          if (!definitions.has(name)) definitions.set(name,[]);
          definitions.get(name).push({model:model?.value,base:entry.baseClassName,file});
        }
      }
    } catch(error) { errors.push({file,error:error.message}); }
  }
  const mappings=resolveMappings(definitions);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify(mappings,null,2));
  const report={source:assetRoot,configFiles:files.length,classes:definitions.size,mapped:Object.keys(mappings).length,errors};
  fs.writeFileSync(output.replace(/\.json$/,'.report.json'),JSON.stringify(report,null,2));
  return report;
}
if (require.main===module) exportMappings(path.resolve(process.argv[2] || 'P:/'),path.resolve(process.argv[3] || 'out/mapdraw/inventory-class-models.json'))
  .then(report=>console.log(JSON.stringify(report))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={resolveMappings,exportMappings};
