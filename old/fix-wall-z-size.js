const fs = require('fs');
const path = require('path');

const cacheFile = path.join(__dirname, 'out', 'bboxCache.rectangles.json');
const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

let updated = 0;

// Find all walls with z size 0.38 and change to 0.19
Object.entries(data).forEach(([name, obj]) => {
  if (name.includes('wall') && obj.size && obj.size[2] === 0.38) {
    console.log(`Updating ${name}: [${obj.size[0]}, ${obj.size[1]}, 0.38] -> [${obj.size[0]}, ${obj.size[1]}, 0.19]`);
    obj.size[2] = 0.19;
    updated++;
  }
});

// Write back to file
fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf8');

console.log(`\nTotal updated: ${updated} walls`);
