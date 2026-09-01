const fs = require('fs');
const path = require('path');

// Count lines in a CSV file (excluding headers)
function countCsvLines(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim().length > 0);
        return Math.max(0, lines.length - 1); // Subtract 1 for header
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error.message);
        return 0;
    }
}

// Get all CSV files in a directory
function getCsvFiles(dirPath) {
    try {
        return fs.readdirSync(dirPath)
            .filter(file => file.endsWith('.csv'))
            .map(file => path.join(dirPath, file));
    } catch (error) {
        console.error(`Error reading directory ${dirPath}:`, error.message);
        return [];
    }
}

const sourcePath = path.join(__dirname, 'data/TBData/source');
const categorizedPath = path.join(__dirname, 'data/TBData/categorized');

// Count source files
const circlesFile = path.join(sourcePath, 'circles_local_coords.csv');
const rectanglesFile = path.join(sourcePath, 'rectangles_local_coords.csv');

const circlesCount = countCsvLines(circlesFile);
const rectanglesCount = countCsvLines(rectanglesFile);
const sourceTotal = circlesCount + rectanglesCount;

console.log('SOURCE FILES:');
console.log(`  circles_local_coords.csv: ${circlesCount}`);
console.log(`  rectangles_local_coords.csv: ${rectanglesCount}`);
console.log(`  TOTAL: ${sourceTotal}`);
console.log('');

// Count categorized files
console.log('CATEGORIZED FILES:');
const categorizedFiles = getCsvFiles(categorizedPath);
let categorizedTotal = 0;

const categoryCounts = {};
categorizedFiles.forEach(file => {
    const count = countCsvLines(file);
    const fileName = path.basename(file);
    categoryCounts[fileName] = count;
    categorizedTotal += count;
    console.log(`  ${fileName}: ${count}`);
});

console.log(`  TOTAL: ${categorizedTotal}`);
console.log('');

// Verification
console.log('VERIFICATION:');
console.log(`Source Total: ${sourceTotal}`);
console.log(`Categorized Total: ${categorizedTotal}`);

if (sourceTotal === categorizedTotal) {
    console.log('✓ SUCCESS: All objects were categorized!');
} else {
    console.log(`✗ MISMATCH: Difference of ${Math.abs(sourceTotal - categorizedTotal)} objects`);
    if (sourceTotal > categorizedTotal) {
        console.log(`  ${sourceTotal - categorizedTotal} objects are missing from categorized files`);
    } else {
        console.log(`  ${categorizedTotal - sourceTotal} extra objects in categorized files`);
    }
}
