const fs = require('fs');
const path = require('path');

const bboxCachePath = path.join(__dirname, '../../out/bboxCache.rectangles.json');

console.log('Reading bbox cache...');
const data = JSON.parse(fs.readFileSync(bboxCachePath, 'utf8'));

let count = 0;

// Iterate through all objects
for (const objectName in data) {
  const obj = data[objectName];
  
  // Check if it's a wall and has z size of 0.038
  if (obj.category === 'walls' && obj.size && obj.size[2] === 0.038) {
    console.log(`Found: ${objectName} - changing z size from 0.038 to 0.19`);
    obj.size[2] = 0.19;
    count++;
  }
}

console.log(`\nTotal walls updated: ${count}`);

// Write back to file
fs.writeFileSync(bboxCachePath, JSON.stringify(data, null, 2));
console.log('Updated bbox cache saved!');
