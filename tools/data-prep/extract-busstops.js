const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2] || 'data/TBData/source/rectangles_local_coords.csv';
const outPathArgIndex = process.argv.indexOf('--out');
const outPath =
  outPathArgIndex !== -1
    ? process.argv[outPathArgIndex + 1]
    : 'out/busstops.csv';

if (!fs.existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, 'utf8');
const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
if (lines.length === 0) {
  console.error('No data in input file.');
  process.exit(1);
}

const header = lines[0].split(';');
const nameIndex = header.indexOf('Name');
if (nameIndex === -1) {
  console.error('Header missing Name column.');
  process.exit(1);
}

const targets = new Set([
  'busstop_city',
  'busstop_village',
  'busstop_village2',
  // Include common typo just in case.
  'busttop_village',
]);

const outLines = [header.join(';')];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  const parts = line.split(';');
  if (parts.length < header.length) continue;
  const nameRaw = parts[nameIndex].trim();
  const name = nameRaw.replace(/^"|"$/g, '');
  if (targets.has(name)) {
    outLines.push(parts.join(';'));
  }
}

const output = outLines.join('\n');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, output, 'utf8');
console.log(`Wrote ${outLines.length - 1} rows to ${outPath}`);
