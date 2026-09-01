const fs = require('fs');
const path = require('path');

const bboxCachePath = path.join(__dirname, '../../out/bboxCache.rectangles.json');

console.log('Analyzing wall z sizes...');
const data = JSON.parse(fs.readFileSync(bboxCachePath, 'utf8'));

const zSizes = new Map();

// Iterate through all objects
for (const objectName in data) {
  const obj = data[objectName];
  
  if (obj.category === 'walls' && obj.size) {
    const zSize = obj.size[2];
    if (!zSizes.has(zSize)) {
      zSizes.set(zSize, []);
    }
    zSizes.get(zSize).push(objectName);
  }
}

console.log('Z sizes found in walls:');
const sorted = Array.from(zSizes.entries()).sort((a, b) => a[0] - b[0]);
sorted.forEach(([size, objs]) => {
  console.log(`  ${size}: ${objs.length} objects`);
  if (objs.length <= 5) {
    objs.forEach(name => console.log(`    - ${name}`));
  }
});
