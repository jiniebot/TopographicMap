#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const WORLD = (process.argv[2] || 'enoch').toLowerCase();
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'out', 'mapdraw');

function existingFile(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function readPboMetadata(metadataPath) {
  if (!metadataPath || !fs.existsSync(metadataPath)) return {};
  return Object.fromEntries(
    fs.readFileSync(metadataPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return separator < 0
          ? [line, '']
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const dayzRoots = [
  process.env.DAYZ_ROOT,
  'J:\\SteamLibrary\\steamapps\\common\\DayZ',
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\DayZ',
  'C:\\Program Files\\Steam\\steamapps\\common\\DayZ',
].filter(Boolean);

const workRoots = [process.env.DAYZ_WORKDRIVE, 'P:\\'].filter(Boolean);
const wrpPath = existingFile(workRoots.map((root) =>
  path.join(root, 'DZ', 'worlds', WORLD, 'world', `${WORLD}.wrp`),
));
const pboPath = existingFile(dayzRoots.map((root) =>
  path.join(root, 'Addons', `worlds_${WORLD}.pbo`),
));
const eboPath = existingFile(dayzRoots.map((root) =>
  path.join(root, WORLD, 'Addons', `worlds_${WORLD}.ebo`),
));
const metadataPath = existingFile(workRoots.map((root) =>
  path.join(root, 'DZ', `worlds_${WORLD}.txt`),
));

if (!wrpPath && !pboPath && !eboPath) {
  console.error(`Could not find ${WORLD}.wrp, worlds_${WORLD}.pbo, or worlds_${WORLD}.ebo.`);
  console.error('Set DAYZ_WORKDRIVE and/or DAYZ_ROOT when using non-standard locations.');
  process.exit(1);
}

let wrp = null;
if (wrpPath) {
  const descriptor = fs.openSync(wrpPath, 'r');
  const header = Buffer.alloc(8);
  fs.readSync(descriptor, header, 0, header.length, 0);
  fs.closeSync(descriptor);
  const signature = header.subarray(0, 4).toString('ascii');
  if (signature !== 'OPRW') {
    throw new Error(`Unexpected WRP signature ${JSON.stringify(signature)} in ${wrpPath}`);
  }
  const stats = fs.statSync(wrpPath);
  wrp = {
    path: wrpPath,
    bytes: stats.size,
    signature,
    formatVersion: header.readUInt32LE(4),
    modifiedUtc: stats.mtime.toISOString(),
  };
}

const manifest = {
  schemaVersion: 1,
  world: WORLD,
  discoveredUtc: new Date().toISOString(),
  status: wrp ? 'ready-to-parse' : eboPath ? 'encrypted-ebo-needs-authorized-wrp-source' : 'needs-extraction',
  wrp,
  sourcePbo: pboPath ? {
    path: pboPath,
    bytes: fs.statSync(pboPath).size,
    modifiedUtc: fs.statSync(pboPath).mtime.toISOString(),
  } : null,
  sourceEbo: eboPath ? {
    path: eboPath,
    bytes: fs.statSync(eboPath).size,
    modifiedUtc: fs.statSync(eboPath).mtime.toISOString(),
  } : null,
  pboMetadata: readPboMetadata(metadataPath),
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const outputPath = path.join(OUTPUT_DIR, `${WORLD}-discovery.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`World:       ${manifest.world}`);
console.log(`Status:      ${manifest.status}`);
console.log(`WRP:         ${wrp ? `${wrp.path} (${wrp.bytes.toLocaleString()} bytes, ${wrp.signature} v${wrp.formatVersion})` : 'not unpacked'}`);
console.log(`Source PBO:  ${manifest.sourcePbo?.path || 'not found'}`);
console.log(`Source EBO:  ${manifest.sourceEbo?.path || 'not found'}`);
console.log(`Manifest:    ${outputPath}`);
