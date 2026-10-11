'use strict';
// Enumerate only the current shared assets; never publish previews or stale files.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
function manifest(dir) {
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  const names = new Set();
  for (const [id, sprite] of Object.entries(catalog.sprites)) {
    if (!/^[a-f0-9]{24}$/.test(id) || sprite.image !== `${id}.png` || (sprite.topographic && sprite.topographic !== `${id}.json`)) throw Error('Invalid asset filename');
    names.add(sprite.image);
    if (sprite.topographic) names.add(sprite.topographic);
  }
  // Publish the catalog last, after every immutable asset is available.
  const files = [...names].sort().concat('catalog.json').map(name => {
    const bytes = fs.readFileSync(path.join(dir, name));
    return { name, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex'),
      contentType:name.endsWith('.png') ? 'image/png' : 'application/json',
      cacheControl:name === 'catalog.json' ? 'public, max-age=60' : 'public, max-age=31536000, immutable' };
  });
  return { version:catalog.version, bytes:files.reduce((sum, f) => sum + f.bytes, 0), files };
}
if (require.main === module) {
  const dir = path.resolve(process.argv[2] || 'out/mapdraw/inventory-sprites');
  const result = manifest(dir);
  const output = path.join(dir, 'publish-manifest.json');
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, version:result.version, files:result.files.length, bytes:result.bytes }));
}
module.exports = { manifest };
