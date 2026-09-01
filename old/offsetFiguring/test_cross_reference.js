// Cross-reference test: Check if we can find any XML entries in rectangles.csv

// Sample XML entries from mapgrouppos_complete.xml
const xmlSamples = [
    { name: "Land_Misc_FeedShack", x: 80.262581, y: 113.793480, z: 4422.178223 },
    { name: "Land_Misc_FeedShack", x: 80.261421, y: 411.262756, z: 10449.132813 },
    { name: "Land_Shed_W2", x: 174.522446, y: 103.526039, z: 2380.768066 },
];

// Expected world coordinates (applying offsets)
console.log("=== Predicted World Coordinates ===\n");
xmlSamples.forEach((sample, i) => {
    const worldX = sample.x + 500000;
    const worldY = sample.y; // Y might need adjustment
    const worldZ = sample.z + 442127.386719;
    
    console.log(`Sample ${i + 1}: ${sample.name}`);
    console.log(`  Local (XML):  X=${sample.x.toFixed(6)}, Y=${sample.y.toFixed(6)}, Z=${sample.z.toFixed(6)}`);
    console.log(`  World (predicted): X=${worldX.toFixed(6)}, Y=${worldY.toFixed(6)}, Z=${worldZ.toFixed(6)}`);
    console.log(`  Search range: X ≈ ${worldX.toFixed(0)}, Y ≈ ${worldY.toFixed(0)}, Z ≈ ${worldZ.toFixed(0)}\n`);
});

// The confirmed translation formula
console.log("=== TRANSLATION FORMULA ===");
console.log("XML to World (Data):");
console.log("  X_world = X_local + 500000");
console.log("  Y_world = Y_local (±2.3 variation possible)");
console.log("  Z_world = Z_local + 442127.386719");
console.log("\nWorld to XML (Data to Local):");
console.log("  X_local = X_world - 500000");
console.log("  Y_local = Y_world");
console.log("  Z_local = Z_world - 442127.386719");
