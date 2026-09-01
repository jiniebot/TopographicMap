const fs = require('fs');

// Based on the known pair validation:
// CSV X position = XML X + 500000
// CSV Y position = XML Z + 442127.386719
// CSV Absolute elevation = XML Y

const X_OFFSET = 500000;
const Z_OFFSET = 442127.386719;

console.log("=== CSV to Local Coordinates Conversion ===\n");
console.log("Conversion formulas:");
console.log("  Local X = CSV X position - 500000");
console.log("  Local Z = CSV Y position - 442127.386719");
console.log("  (Y elevation = CSV Absolute elevation)\n");

// Read circles.csv
const csvPath = './data/TB Data/circles.csv';
const content = fs.readFileSync(csvPath, 'utf8');
const lines = content.split('\n');

// Create output with converted coordinates
const output = [];
output.push('Name;Local_X;Local_Z;World_X;World_Z;Absolute_Elevation;Yaw');

let convertedCount = 0;

for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const parts = line.split(';').map(p => p.trim().replace(/"/g, ''));
    
    if (parts.length >= 9) {
        const name = parts[0];
        const worldX = parseFloat(parts[1]);  // CSV X position
        const worldZ = parseFloat(parts[2]);  // CSV Y position
        const yaw = parseFloat(parts[3]);
        const absElev = parseFloat(parts[8]); // Absolute elevation
        
        if (!isNaN(worldX) && !isNaN(worldZ) && !isNaN(absElev)) {
            // Convert to local
            const localX = worldX - X_OFFSET;
            const localZ = worldZ - Z_OFFSET;
            
            output.push(`"${name}";${localX.toFixed(6)};${localZ.toFixed(6)};${worldX.toFixed(6)};${worldZ.toFixed(6)};${absElev.toFixed(6)};${yaw.toFixed(6)}`);
            convertedCount++;
        }
    }
    
    // Show progress
    if (convertedCount % 50000 === 0 && convertedCount > 0) {
        console.log(`Converted ${convertedCount} entries...`);
    }
}

console.log(`\nTotal entries converted: ${convertedCount}`);

// Write output file
const outputPath = './data/TB Data/circles_local_coords.csv';
fs.writeFileSync(outputPath, output.join('\n'), 'utf8');
console.log(`\n✓ Saved to: ${outputPath}`);

// Show sample
console.log("\n=== Sample Conversions (first 10) ===\n");
output.slice(1, 11).forEach((line, idx) => {
    const parts = line.split(';');
    console.log(`${idx + 1}. ${parts[0]}`);
    console.log(`   Local coords:  X=${parts[1]}, Z=${parts[2]}`);
    console.log(`   World coords:  X=${parts[3]}, Z=${parts[4]}`);
    console.log(`   Elevation: ${parts[5]}, Yaw: ${parts[6]}\n`);
});
