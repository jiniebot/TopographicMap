const fs = require('fs');
const path = require('path');

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
        
        entries.push({ name, x, y, z, line: count + 3 });
        count++;
    }
    
    return entries;
}

// Parse CSV to extract coordinate data
function parseCSV() {
    const csvPath = './data/TB Data/rectangles.csv';
    const content = fs.readFileSync(csvPath, 'utf8');
    
    const lines = content.split('\n');
    const entries = [];
    
    // Skip header
    for (let i = 1; i < Math.min(10000, lines.length); i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Parse semicolon-separated format
        const parts = line.split(';').map(p => p.trim().replace(/"/g, ''));
        if (parts.length >= 4) {
            const name = parts[0];
            const x = parseFloat(parts[1]);
            const y = parseFloat(parts[2]);
            const z = parseFloat(parts[3]);
            
            if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
                entries.push({ name, x, y, z, line: i + 1 });
            }
        }
    }
    
    return entries;
}

console.log("=== Loading data ===\n");
const xmlEntries = parseXML();
const csvEntries = parseCSV();

console.log(`Loaded ${xmlEntries.length} entries from mapgrouppos_complete.xml`);
console.log(`Loaded ${csvEntries.length} entries from rectangles.csv\n`);

// Translation formula
const X_OFFSET = 500000;
const Z_OFFSET = 442127.386719;
const Y_TOLERANCE = 3.0; // Increased tolerance for Y

// Test translation on sample entries
console.log("=== Testing Translation Formula ===\n");

let matchCount = 0;
let testResults = [];

for (let i = 0; i < xmlEntries.length; i++) {
    const xmlEntry = xmlEntries[i];
    
    // Calculate predicted world coordinates
    const predictedX = xmlEntry.x + X_OFFSET;
    const predictedY = xmlEntry.y;
    const predictedZ = xmlEntry.z + Z_OFFSET;
    
    // Search for matching entry in CSV
    let bestMatch = null;
    let bestDistance = Infinity;
    
    for (let j = 0; j < csvEntries.length; j++) {
        const csvEntry = csvEntries[j];
        
        // Calculate distance
        const dx = Math.abs(csvEntry.x - predictedX);
        const dy = Math.abs(csvEntry.y - predictedY);
        const dz = Math.abs(csvEntry.z - predictedZ);
        
        // Distance tolerance (rough match)
        if (dx < 5 && dy < Y_TOLERANCE && dz < 10) {
            const distance = dx + dy + dz;
            if (distance < bestDistance) {
                bestDistance = distance;
                bestMatch = csvEntry;
            }
        }
    }
    
    if (bestMatch) {
        matchCount++;
        testResults.push({
            xmlName: xmlEntry.name,
            csvName: bestMatch.name,
            xmlPos: { x: xmlEntry.x, y: xmlEntry.y, z: xmlEntry.z },
            csvPos: { x: bestMatch.x, y: bestMatch.y, z: bestMatch.z },
            predicted: { x: predictedX, y: predictedY, z: predictedZ },
            distance: bestDistance,
            match: bestDistance < 1
        });
    }
}

console.log(`\n=== Match Results: ${matchCount}/${xmlEntries.length} entries found ===\n`);

// Show detailed results for first 10 matches
testResults.slice(0, 10).forEach((result, idx) => {
    console.log(`\nMatch ${idx + 1}:`);
    console.log(`  XML Name: ${result.xmlName}`);
    console.log(`  CSV Name: ${result.csvName}`);
    console.log(`  XML Local:     X=${result.xmlPos.x.toFixed(3)}, Y=${result.xmlPos.y.toFixed(3)}, Z=${result.xmlPos.z.toFixed(3)}`);
    console.log(`  Predicted:     X=${result.predicted.x.toFixed(3)}, Y=${result.predicted.y.toFixed(3)}, Z=${result.predicted.z.toFixed(3)}`);
    console.log(`  CSV World:     X=${result.csvPos.x.toFixed(3)}, Y=${result.csvPos.y.toFixed(3)}, Z=${result.csvPos.z.toFixed(3)}`);
    console.log(`  Difference:    ΔX=${(result.csvPos.x - result.predicted.x).toFixed(3)}, ΔY=${(result.csvPos.y - result.predicted.y).toFixed(3)}, ΔZ=${(result.csvPos.z - result.predicted.z).toFixed(3)}`);
    console.log(`  Distance: ${result.distance.toFixed(3)} ${result.match ? "✓ PERFECT" : "~ CLOSE"}`);
});

// Summary statistics
if (testResults.length > 0) {
    const distances = testResults.map(r => r.distance);
    const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
    const maxDistance = Math.max(...distances);
    const perfectMatches = testResults.filter(r => r.match).length;
    
    console.log(`\n=== Summary Statistics ===`);
    console.log(`Total matches found: ${matchCount}/${xmlEntries.length}`);
    console.log(`Perfect matches (distance < 1): ${perfectMatches}`);
    console.log(`Average distance: ${avgDistance.toFixed(3)}`);
    console.log(`Max distance: ${maxDistance.toFixed(3)}`);
    console.log(`\n✅ Translation formula appears ${avgDistance < 5 ? "ACCURATE" : "NEEDS ADJUSTMENT"}`);
}
