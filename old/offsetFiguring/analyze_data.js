const fs = require('fs');

// Parse XML to extract group entries
function parseXML() {
    const xmlPath = './data/mapgrouppos_complete.xml';
    const content = fs.readFileSync(xmlPath, 'utf8');
    
    const entries = [];
    const regex = /<group name="([^"]+)" pos="([0-9.\s-]+)"/g;
    
    let match;
    let count = 0;
    while ((match = regex.exec(content)) !== null && count < 50) {
        const name = match[1];
        const posStr = match[2];
        const [x, y, z] = posStr.trim().split(/\s+/).map(Number);
        
        entries.push({ name, x, y, z });
        count++;
    }
    
    return entries;
}

// Parse CSV with better handling
function parseCSV() {
    const csvPath = './data/TB Data/rectangles.csv';
    const content = fs.readFileSync(csvPath, 'utf8');
    
    const lines = content.split('\n');
    const entries = [];
    
    for (let i = 1; i < Math.min(2000, lines.length); i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const parts = line.split(';').map(p => p.trim().replace(/"/g, ''));
        if (parts.length >= 4) {
            const name = parts[0];
            const x = parseFloat(parts[1]);
            const y = parseFloat(parts[2]);
            const z = parseFloat(parts[3]);
            
            if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
                entries.push({ name, x, y, z });
            }
        }
    }
    
    return entries;
}

const xmlEntries = parseXML();
const csvEntries = parseCSV();

console.log("=== Sample XML Entries ===");
xmlEntries.slice(0, 5).forEach((e, i) => {
    const predX = e.x + 500000;
    const predZ = e.z + 442127.386719;
    console.log(`${i+1}. ${e.name}`);
    console.log(`   Local: X=${e.x.toFixed(1)}, Y=${e.y.toFixed(1)}, Z=${e.z.toFixed(1)}`);
    console.log(`   Predicted World: X=${predX.toFixed(1)}, Y=${e.y.toFixed(1)}, Z=${predZ.toFixed(1)}`);
});

console.log("\n=== Sample CSV Entries (first 2000 lines) ===");
csvEntries.slice(0, 5).forEach((e, i) => {
    console.log(`${i+1}. ${e.name}: X=${e.x.toFixed(1)}, Y=${e.y.toFixed(1)}, Z=${e.z.toFixed(1)}`);
});

console.log("\n=== CSV X Range ===");
const xValues = csvEntries.map(e => e.x);
console.log(`Min X: ${Math.min(...xValues).toFixed(1)}`);
console.log(`Max X: ${Math.max(...xValues).toFixed(1)}`);

console.log("\n=== CSV Z Range ===");
const zValues = csvEntries.map(e => e.z);
console.log(`Min Z: ${Math.min(...zValues).toFixed(1)}`);
console.log(`Max Z: ${Math.max(...zValues).toFixed(1)}`);

console.log("\n=== Predicted XML Z to World Z ===");
const predictedZValues = xmlEntries.map(e => e.z + 442127.386719);
console.log(`Min predicted Z: ${Math.min(...predictedZValues).toFixed(1)}`);
console.log(`Max predicted Z: ${Math.max(...predictedZValues).toFixed(1)}`);

console.log("\n=== Object Type Names Comparison ===");
const xmlNames = [...new Set(xmlEntries.map(e => e.name))];
const csvNames = [...new Set(csvEntries.map(e => e.name))];

console.log(`Unique XML object types: ${xmlNames.length}`);
console.log(`Unique CSV object types: ${csvNames.length}`);
console.log("\nFirst 10 XML names:");
xmlNames.slice(0, 10).forEach(n => console.log(`  - ${n}`));
console.log("\nFirst 10 CSV names:");
csvNames.slice(0, 10).forEach(n => console.log(`  - ${n}`));
