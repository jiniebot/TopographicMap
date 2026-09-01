import fs from "fs";
import path from "path";
import readline from "readline";
const CIRCLES_CSV_PATH = path.resolve("./data/TB Data/circles.csv");
const OUT_PATH = path.resolve("./data/TB Data/circles_local_coords.csv");
// -----------------------------------------------

const X_OFFSET = 500000;
const Z_OFFSET = 442127.386719;

console.log("=== Converting circles.csv to Local Coordinates ===\n");
console.log("Input:  " + CIRCLES_CSV_PATH);
console.log("Output: " + OUT_PATH + "\n");

// Read circles.csv line by line and convert
const input = fs.createReadStream(CIRCLES_CSV_PATH, { encoding: "utf8" });
const output = fs.createWriteStream(OUT_PATH, { encoding: "utf8" });

// Write header
output.write('Name;Local_X;Local_Z;World_X;World_Z;Absolute_Elevation;Yaw\n');

let lineNum = 0;
let convertedCount = 0;
let errorCount = 0;

const rl = readline.createInterface({
  input: input,
  crlfDelay: Infinity
});

rl.on("line", (line) => {
  lineNum++;
  if (lineNum === 1) return; // Skip header
  
  const trimmed = line.trim();
  if (!trimmed) return;
  
  try {
    const parts = trimmed.split(";").map(p => p.trim().replace(/"/g, ""));
    
    if (parts.length >= 4) {
      const name = parts[0];
      const worldX = parseFloat(parts[1]);  // CSV X position
      const worldZ = parseFloat(parts[2]);  // CSV Y position
      const yaw = parseFloat(parts[3]);
      const absElev = parseFloat(parts[8] || "0");
      
      if (!isNaN(worldX) && !isNaN(worldZ)) {
        const localX = worldX - X_OFFSET;
        const localZ = worldZ - Z_OFFSET;
        
        output.write(
          `"${name}";${localX.toFixed(6)};${localZ.toFixed(6)};${worldX.toFixed(6)};${worldZ.toFixed(6)};${absElev.toFixed(6)};${yaw.toFixed(6)}\n`
        );
        
        convertedCount++;
        
        if (convertedCount % 100000 === 0) {
          console.log(`Converted ${convertedCount} entries...`);
        }
      }
    }
  } catch (err) {
    errorCount++;
  }
});

rl.on("close", () => {
  output.end();
  console.log(`\n✓ Conversion complete!`);
  console.log(`  Total lines processed: ${lineNum}`);
  console.log(`  Successfully converted: ${convertedCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log(`\n✓ Output saved to: ${OUT_PATH}`);
});
