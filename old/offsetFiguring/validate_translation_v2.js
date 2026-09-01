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

// Parse CSV with CORRECT COLUMNS
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
            const x = parseFloat(parts[1]);  // X position
            const y = parseFloat(parts[2]);  // Y position
            const yaw = parseFloat(parts[3]); // Yaw
            const relElev = parseFloat(parts[7]); // Relative elevation
            const absElev = parseFloat(parts[8]); // Absolute elevation
            
            if (!isNaN(x) && !isNaN(y) && !isNaN(absElev)) {
                entries.push({ name, x, y, yaw, relElev, absElev });
            }
        }
    }
    
    return entries;
}

const xmlEntries = parseXML();
const csvEntries = parseCSV();

console.log(`\nLoaded ${xmlEntries.length} XML entries`);
console.log(`Loaded ${csvEntries.length} CSV entries\n`);

const X_OFFSET = 500000;
const Z_OFFSET = 442127.386719;

console.log("=== Testing Translation with Correct Columns ===\n");

let matches = [];

for (let i = 0; i < xmlEntries.length; i++) {
    const xmlEntry = xmlEntries[i];
    
    // Calculate predicted world coordinates
    const predictedX = xmlEntry.x + X_OFFSET;
    const predictedY = xmlEntry.y;
    const predictedAbsElev = xmlEntry.z + Z_OFFSET;
    
    // Search for matching entry in CSV by coordinates
    for (let j = 0; j < csvEntries.length; j++) {
        const csvEntry = csvEntries[j];
        
        // Calculate distance
        const dx = Math.abs(csvEntry.x - predictedX);
        const dy = Math.abs(csvEntry.y - predictedY);
        const dz = Math.abs(csvEntry.absElev - predictedAbsElev);
        
        // Very tight tolerance for testing
        if (dx < 10 && dy < 10 && dz < 10) {
            matches.push({
                xmlName: xmlEntry.name,
                csvName: csvEntry.name,
                xmlLocal: { x: xmlEntry.x, y: xmlEntry.y, z: xmlEntry.z },
                csvWorld: { x: csvEntry.x, y: csvEntry.y, absElev: csvEntry.absElev },
                predicted: { x: predictedX, y: predictedY, z: predictedAbsElev },
                distance: dx + dy + dz
            });
        }
    }
}

console.log(`Found ${matches.length} potential matches\n`);

// Show best matches
matches.sort((a, b) => a.distance - b.distance);
matches.slice(0, 15).forEach((m, idx) => {
    console.log(`Match ${idx + 1}:`);
    console.log(`  XML: ${m.xmlName} @ local (${m.xmlLocal.x.toFixed(1)}, ${m.xmlLocal.y.toFixed(1)}, ${m.xmlLocal.z.toFixed(1)})`);
    console.log(`  CSV: ${m.csvName} @ world (${m.csvWorld.x.toFixed(1)}, ${m.csvWorld.y.toFixed(1)}, ${m.csvWorld.absElev.toFixed(1)})`);
    console.log(`  Predicted: (${m.predicted.x.toFixed(1)}, ${m.predicted.y.toFixed(1)}, ${m.predicted.z.toFixed(1)})`);
    console.log(`  Distance: ${m.distance.toFixed(2)}\n`);
});
