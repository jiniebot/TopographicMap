const fs = require('fs');

function parseXML() {
    const xmlPath = './data/mapgrouppos_complete.xml';
    const content = fs.readFileSync(xmlPath, 'utf8');
    
    const entries = [];
    const regex = /<group name="([^"]+)" pos="([0-9.\s-]+)"/g;
    
    let match;
    let count = 0;
    while ((match = regex.exec(content)) !== null && count < 100) {
        const name = match[1];
        const posStr = match[2];
        const [x, y, z] = posStr.trim().split(/\s+/).map(Number);
        entries.push({ name, x, y, z });
        count++;
    }
    return entries;
}

function parseCSV() {
    const csvPath = './data/TB Data/rectangles.csv';
    const content = fs.readFileSync(csvPath, 'utf8');
    
    const lines = content.split('\n');
    const entries = [];
    
    for (let i = 1; i < Math.min(20000, lines.length); i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const parts = line.split(';').map(p => p.trim().replace(/"/g, ''));
        if (parts.length >= 9) {
            const csvX = parseFloat(parts[1]);
            const csvY = parseFloat(parts[2]);
            const absElev = parseFloat(parts[8]);
            
            if (!isNaN(csvX) && !isNaN(csvY) && !isNaN(absElev)) {
                entries.push({ csvX, csvY, absElev });
            }
        }
    }
    return entries;
}

const xmlEntries = parseXML();
const csvEntries = parseCSV();

console.log("=== XML Z Range ===");
const xmlZValues = xmlEntries.map(e => e.z);
console.log(`Min: ${Math.min(...xmlZValues).toFixed(1)}`);
console.log(`Max: ${Math.max(...xmlZValues).toFixed(1)}`);

console.log("\n=== CSV Y Position Range ===");
const csvYValues = csvEntries.map(e => e.csvY);
console.log(`Min: ${Math.min(...csvYValues).toFixed(1)}`);
console.log(`Max: ${Math.max(...csvYValues).toFixed(1)}`);

console.log("\n=== Analysis ===");
const minXmlZ = Math.min(...xmlZValues);
const maxXmlZ = Math.max(...xmlZValues);
const minCsvY = Math.min(...csvYValues);
const maxCsvY = Math.max(...csvYValues);

console.log(`XML Z range: ${(maxXmlZ - minXmlZ).toFixed(1)}`);
console.log(`CSV Y range: ${(maxCsvY - minCsvY).toFixed(1)}`);

// Check if there's an offset
const estimatedOffsets = [
    (minCsvY - minXmlZ),
    (maxCsvY - maxXmlZ),
    (minCsvY - maxXmlZ),
    (maxCsvY - minXmlZ)
];

console.log("\n=== Potential Z Offsets ===");
estimatedOffsets.forEach((offset, i) => {
    console.log(`Offset option ${i+1}: ${offset.toFixed(1)}`);
});

// Show actual first few entries
console.log("\n=== First 5 XML entries ===");
xmlEntries.slice(0, 5).forEach(e => {
    console.log(`  X=${e.x.toFixed(1)}, Y=${e.y.toFixed(1)}, Z=${e.z.toFixed(1)}`);
});

console.log("\n=== First 5 CSV entries ===");
csvEntries.slice(0, 5).forEach(e => {
    console.log(`  X=${e.csvX.toFixed(1)}, Y=${e.csvY.toFixed(1)}, AbsElev=${e.absElev.toFixed(1)}`);
});
