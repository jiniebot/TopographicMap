#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadMapManifest } = require('../../tools/mapdraw/map-build-config');

const projectRoot = path.resolve(__dirname, '..', '..');
function option(name,fallback){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback}
const manifest=loadMapManifest(option('--manifest','configs/maps/livonia.json'));
const discoveryPath = path.join(projectRoot, 'out', 'mapdraw', `${manifest.world}-discovery.json`);
const outputPath = path.resolve(projectRoot,option('--out',path.join('out','mapdraw',`${manifest.world}-dewrp-objects.txt`)));
const dewrpCandidates = [
  process.env.DEWRP_PATH,
  'C:\\Program Files (x86)\\Mikero\\DePboTools\\bin\\DeWrp.exe',
  'C:\\Program Files\\Mikero\\DePboTools\\bin\\DeWrp.exe',
].filter(Boolean);

if (!fs.existsSync(discoveryPath)) {
  throw new Error(`Run \`node tools/mapdraw/discover-world.js ${manifest.world}\` first.`);
}
const { wrp } = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
if (!wrp?.path || !fs.existsSync(wrp.path)) throw new Error('Discovery manifest has no usable WRP.');
const dewrpPath = dewrpCandidates.find(fs.existsSync);
if (!dewrpPath) throw new Error('DeWrp.exe not found; set DEWRP_PATH.');

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const output = fs.createWriteStream(outputPath);
const child = spawn(dewrpPath, ['-P', '-O', wrp.path], { windowsHide: true });
child.stdout.pipe(output);
child.stderr.pipe(process.stderr);
child.on('error', (error) => { throw error; });
child.on('close', (code) => {
  output.end(() => {
    const tailSize = Math.min(4096, fs.statSync(outputPath).size);
    const descriptor = fs.openSync(outputPath, 'r');
    const tail = Buffer.alloc(tailSize);
    fs.readSync(descriptor, tail, 0, tailSize, fs.statSync(outputPath).size - tailSize);
    fs.closeSync(descriptor);
    if (!tail.toString('utf8').trimEnd().endsWith('];')) {
      console.error(`DeWrp output is incomplete (exit code ${code}).`);
      process.exitCode = 1;
      return;
    }
    console.log(`DeWrp object export complete: ${outputPath}`);
  });
});
