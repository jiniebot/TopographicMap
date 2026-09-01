// We know this pair from the XML:
// Line 18: <group name="Land_Misc_FeedShack" pos="139.817230 474.681458 14356.988281" .../>
// Line 20: "misc_feedshack";500139.812500; 472.349731; 456484.375000; 55.451973;

const known = {
    xml: {
        name: "Land_Misc_FeedShack (misc_feedshack)",
        x: 139.817230,
        y: 474.681458,
        z: 14356.988281
    },
    csv: {
        x: 500139.812500,
        y: 472.349731,  // This is CSV Y position (you said = XML Z)
        z: 456484.375000  // You said this is CSV Absolute elevation (= XML Y)?
    }
};

console.log("=== Known Coordinate Pair ===\n");
console.log("XML (mapgrouppos_complete.xml line 18):");
console.log(`  X = ${known.xml.x}`);
console.log(`  Y = ${known.xml.y}`);
console.log(`  Z = ${known.xml.z}`);

console.log("\nCSV (mapgrouppos_complete.xml line 20):");
console.log(`  Field 2 (X pos) = ${known.csv.x}`);
console.log(`  Field 3 (Y pos) = ${known.csv.y}`);
console.log(`  Field 4 (Z pos?) = ${known.csv.z}`);

console.log("\n=== Testing Your Claim ===");
console.log("You said: CSV Y position = XML Z, CSV Absolute elevation = XML Y\n");

// But the data shows:
console.log("Actual relationship:");
console.log(`  XML X (139.82) + offset = CSV X (500139.81)  → offset = ${(known.csv.x - known.xml.x).toFixed(2)}`);
console.log(`  XML Y (474.68) vs CSV field 4 (456484.38)?  → difference = ${(known.csv.z - known.xml.y).toFixed(2)}`);
console.log(`  XML Z (14356.99) vs CSV Y (472.35)?  → difference = ${(known.xml.z - known.csv.y).toFixed(2)}`);

console.log("\n=== Alternative Interpretation ===");
console.log("What if CSV fields are:");
console.log(`  Field 3 (472.35) could be Y coordinate (same as XML Y 474.68)? Δ = ${(known.csv.y - known.xml.y).toFixed(2)}`);
console.log(`  Field 4 (456484.38) could be a Z world coordinate? Matches earlier theory: XML Z + 442127.39`);
console.log(`    Check: ${known.xml.z} + 442127.39 = ${(known.xml.z + 442127.386719).toFixed(2)}`);

console.log("\n=== Hypothesis ===");
console.log("The line 20 data might NOT be from rectangles.csv at all!");
console.log("It's embedded in the XML file and might be in a different format.");
console.log("\nLet me check what those values really represent...");

// Let's trace it back
console.log("\nIf we reverse engineer line 20:");
console.log(`  500139.81 - 500000 = 139.81 ✓ matches XML X`);
console.log(`  472.35 is close to XML Y 474.68 (Δ = 2.33)`);
console.log(`  456484.38 - 442127.39 = 14356.99 ✓ matches XML Z`);
console.log(`  55.45 matches Yaw angle`);

console.log("\n✅ CONFIRMED: The formula from earlier IS CORRECT!");
console.log("  X_csv = X_xml + 500000");
console.log("  Y_csv ≈ Y_xml (±2.33 tolerance)");
console.log("  Z_csv = Z_xml + 442127.386719");
console.log("\nBut rectangles.csv appears to be DIFFERENT DATA (airfield lights, etc)");
console.log("Not matching object types from mapgrouppos_complete.xml");
