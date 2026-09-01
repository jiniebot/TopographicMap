const fs = require('fs');

// Parse XML to extract group entries
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

// Parse CSV 
function parseCSV() {
    const csvPath = './data/TB Data/rectangles.csv';
    const content = fs.readFileSync(csvPath, 'utf8');
    
    const lines = content.split('\n');
    const entries = [];
    
    // CSV Columns: Name;X position;Y position;Yaw;Pitch;Roll;Scale;Relative elevation;Absolute elevation;ID
    for (let i = 1; i < Math.min(20000, lines.length); i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const parts = line.split(';').map(p => p.trim().replace(/"/g, ''));
        if (parts.length >= 9) {
            const name = parts[0];
            const csvX = parseFloat(parts[1]);  // X position
            const csvY = parseFloat(parts[2]);  // Y position (= XML Z)
            const yaw = parseFloat(parts[3]);
            const relElev = parseFloat(parts[7]);
            const absElev = parseFloat(parts[8]); // Absolute elevation (= XML Y)
            
            if (!isNaN(csvX) && !isNaN(csvY) && !isNaN(absElev)) {
                entries.push({ name, csvX, csvY, yaw, relElev, absElev });
            }
        }
    }
    
    return entries;
}

const xmlEntries = parseXML();
const csvEntries = parseCSV();

console.log(`Loaded ${xmlEntries.length} XML entries`);
console.log(`Loaded ${csvEntries.length} CSV entries\n`);

const X_OFFSET = 500000;

console.log("=== Correct Coordinate Mapping ===");
console.log("XML -> CSV:");
console.log("  XML X + 500000 = CSV X position");
console.log("  XML Y = CSV Absolute elevation");
console.log("  XML Z + offset? = CSV Y position\n");

console.log("=== Testing Translation ===\n");

let matches = [];

for (let i = 0; i < xmlEntries.length; i++) {
    const xmlEntry = xmlEntries[i];
    
    // Calculate predicted CSV coordinates
    const predictedCsvX = xmlEntry.x + X_OFFSET;
    const predictedAbsElev = xmlEntry.y;  // XML Y = CSV Absolute elevation
    const predictedCsvY = xmlEntry.z;     // Testing if XML Z = CSV Y directly
    
    // Search for matching entry in CSV by coordinates
    for (let j = 0; j < csvEntries.length; j++) {
        const csvEntry = csvEntries[j];
        
        // Calculate distance
        const dx = Math.abs(csvEntry.csvX - predictedCsvX);
        const dy = Math.abs(csvEntry.csvY - predictedCsvY);
        const dElev = Math.abs(csvEntry.absElev - predictedAbsElev);
        
        // Tolerance
        if (dx < 15 && dy < 15 && dElev < 15) {
            matches.push({
                xmlName: xmlEntry.name,
                csvName: csvEntry.name,
                xmlPos: { x: xmlEntry.x, y: xmlEntry.y, z: xmlEntry.z },
                csvPos: { x: csvEntry.csvX, y: csvEntry.csvY, absElev: csvEntry.absElev },
                predicted: { x: predictedCsvX, y: predictedCsvY, elev: predictedAbsElev },
                dx, dy, dElev,
                distance: dx + dy + dElev
            });
        }
    }
}

console.log(`Found ${matches.length} matches\n`);

matches.sort((a, b) => a.distance - b.distance);
matches.slice(0, 20).forEach((m, idx) => {
    console.log(`${idx + 1}. ${m.xmlName} ↔ ${m.csvName}`);
    console.log(`   XML local:  (${m.xmlPos.x.toFixed(1)}, Y=${m.xmlPos.y.toFixed(1)}, ${m.xmlPos.z.toFixed(1)})`);
    console.log(`   Predicted:  (${m.predicted.x.toFixed(1)}, Y=${m.predicted.elev.toFixed(1)}, ${m.predicted.y.toFixed(1)})`);
    console.log(`   CSV world:  (${m.csvPos.x.toFixed(1)}, Y=${m.csvPos.absElev.toFixed(1)}, ${m.csvPos.y.toFixed(1)})`);
    console.log(`   Deltas:     ΔX=${m.dx.toFixed(2)}, ΔY_elev=${m.dElev.toFixed(2)}, ΔY_pos=${m.dy.toFixed(2)}\n`);
});

// Summary
if (matches.length > 0) {
    const avgDist = matches.reduce((a, b) => a + b.distance, 0) / matches.length;
    const perfect = matches.filter(m => m.distance < 5).length;
    console.log(`\n=== Summary ===`);
    console.log(`Total matches: ${matches.length}/${xmlEntries.length}`);
    console.log(`Perfect (distance < 5): ${perfect}`);
    console.log(`Average distance: ${avgDist.toFixed(2)}`);
}
