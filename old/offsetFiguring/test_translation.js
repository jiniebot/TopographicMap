// Test translation between coordinate systems

// From mapgrouppos_complete.xml line 18
const xml_pos = {
    x: 139.817230,
    y: 474.681458,
    z: 14356.988281,
    yaw: 55.451973
};

// From mapgrouppos_complete.xml line 20 (data format)
const data_coords = {
    x: 500139.812500,
    y: 472.349731,
    z: 456484.375000,
    yaw: 55.451973
};

console.log("=== Coordinate System Translation Analysis ===\n");
console.log("XML Format (local coordinates):", xml_pos);
console.log("Data Format (world coordinates):", data_coords);

// Calculate differences
const x_diff = data_coords.x - xml_pos.x;
const y_diff = data_coords.y - xml_pos.y;
const z_diff = data_coords.z - xml_pos.z;
const yaw_diff = data_coords.yaw - xml_pos.yaw;

console.log("\n=== Differences ===");
console.log(`X difference: ${data_coords.x} - ${xml_pos.x} = ${x_diff}`);
console.log(`Y difference: ${data_coords.y} - ${xml_pos.y} = ${y_diff}`);
console.log(`Z difference: ${data_coords.z} - ${xml_pos.z} = ${z_diff}`);
console.log(`Yaw difference: ${data_coords.yaw} - ${xml_pos.yaw} = ${yaw_diff}`);

// Test simple offset theory
console.log("\n=== Testing Simple Offset Theory ===");
console.log("If X offset = 500000:");
const calc_xml_x = data_coords.x - 500000;
console.log(`  Data X (500139.812500) - 500000 = ${calc_xml_x} (actual XML X: ${xml_pos.x}) - Match: ${Math.abs(calc_xml_x - xml_pos.x) < 0.01 ? "YES" : "NO"}`);

console.log("If Z offset = 442127.386719:");
const z_offset = z_diff;
const calc_xml_z = data_coords.z - z_offset;
console.log(`  Data Z (456484.375000) - ${z_offset} = ${calc_xml_z} (actual XML Z: ${xml_pos.z}) - Match: ${Math.abs(calc_xml_z - xml_pos.z) < 0.01 ? "YES" : "NO"}`);

// Y analysis
console.log("\nY coordinate analysis:");
console.log(`  Simple offset would be: ${y_diff}`);
console.log(`  But difference is negative (Y data < Y xml), which is unusual`);
console.log(`  Possible: Different axis orientation or different coordinate system altogether?`);

// Check if Z might be inverted or on different scale
console.log("\n=== Analyzing Z coordinate relationship ===");
const z_ratio = data_coords.z / xml_pos.z;
console.log(`Z ratio (data/xml): ${z_ratio.toFixed(6)}`);
console.log(`Z might be: different scale or completely different axis`);

// Let's check if there's a pattern with Z and X
console.log("\n=== Cross-axis analysis ===");
console.log(`Does Z = some_function(X, Y)?`);
console.log(`Z in data (456484.375) / X offset (500000) = ${(data_coords.z / 500000).toFixed(6)}`);
