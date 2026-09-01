const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./out/bboxCache.rectangles.json', 'utf8'));

let count = 0;
for (const key in data) {
  if (key.startsWith('wall_')) {
    data[key].size[2] = 0.38;
    count++;
  }
}

fs.writeFileSync('./out/bboxCache.rectangles.json', JSON.stringify(data, null, 2));
console.log(`Updated ${count} wall_ entries with Z size of 0.38`);
