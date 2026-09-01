#!/usr/bin/env node
// Builds a downloadable zip containing everything a new machine needs to
// join the render pool: scripts, manifests, the trimmed PAA/P3D decoders,
// and the precomputed map data (WRP transforms, transform index, contours,
// model caches for all worlds, elevation grids) that isn't served over the
// asset HTTP endpoint.
//
// Streams directly from source paths into the zip via archiver (no staging
// copy/hardlink step) - PowerShell's Compress-Archive was tried first and
// stalled indefinitely on this dataset (tens of thousands of small files in
// the model thumbnail cache, worsened by disk contention with active render
// workers); archiver's streaming zip writer handles this in a couple of
// minutes instead of getting stuck.
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT = path.resolve(__dirname, '..');
const PARENT = path.resolve(ROOT, '..');
const ZIP_PATH = path.join(ROOT, 'out', 'mapdraw', 'worker-package', 'dayz-render-worker.zip');

function log(message) { console.log(`[package] ${message}`); }

function addTree(archive, srcDir, destDir) {
  if (!fs.existsSync(srcDir)) { log(`skip (not found): ${srcDir}`); return; }
  archive.directory(srcDir, destDir);
}
function addFile(archive, src, destRelative) {
  if (!fs.existsSync(src)) { log(`skip (not found): ${src}`); return; }
  archive.file(src, { name: destRelative });
}

async function main() {
  fs.mkdirSync(path.dirname(ZIP_PATH), { recursive: true });
  fs.rmSync(ZIP_PATH, { force: true });

  const output = fs.createWriteStream(ZIP_PATH);
  // Most of this data (WRP terrain, PNG thumbnails, PAA-derived images) is
  // already compressed binary - spending CPU re-compressing it barely
  // shrinks it. Low compression level trades a slightly larger zip for
  // dramatically faster packaging, which matters far more on a LAN.
  const archive = archiver('zip', { zlib: { level: 1 } });
  let lastLoggedMiB = 0;
  archive.on('progress', (progress) => {
    const mib = Math.floor(progress.fs.processedBytes / 1024 / 1024);
    if (mib - lastLoggedMiB >= 100) { lastLoggedMiB = mib; log(`...${mib} MiB processed (${progress.entries.processed}/${progress.entries.total} entries)`); }
  });
  archive.on('warning', (err) => log(`warning: ${err.message}`));
  const done = new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(output);

  log('adding scripts and config...');
  addTree(archive, path.join(ROOT, 'tools'), 'tools');
  addTree(archive, path.join(ROOT, 'configs'), 'configs');
  addTree(archive, path.join(ROOT, 'vendor', 'BIS-Toolkit', 'packages', 'paa', 'dist'), 'vendor/BIS-Toolkit/packages/paa/dist');
  addFile(archive, path.join(ROOT, 'vendor', 'BIS-Toolkit', 'packages', 'paa', 'package.json'), 'vendor/BIS-Toolkit/packages/paa/package.json');
  addTree(archive, path.join(ROOT, 'vendor', 'BIS-Toolkit', 'packages', 'p3d', 'dist'), 'vendor/BIS-Toolkit/packages/p3d/dist');
  addFile(archive, path.join(ROOT, 'vendor', 'BIS-Toolkit', 'packages', 'p3d', 'package.json'), 'vendor/BIS-Toolkit/packages/p3d/package.json');
  addFile(archive, path.join(PARENT, 'package.json'), 'package.json');

  log('adding precomputed map data (this is the bulk of the size)...');
  addTree(archive, path.join(ROOT, 'out', 'mapdraw', 'wrp8-transform'), 'out/mapdraw/wrp8-transform');
  addTree(archive, path.join(ROOT, 'out', 'mapdraw', 'index'), 'out/mapdraw/index');
  addTree(archive, path.join(ROOT, 'out', 'mapdraw', 'topographic-base'), 'out/mapdraw/topographic-base');
  for (const world of ['chernarusplus', 'enoch', 'sakhal'])
    addTree(archive, path.join(ROOT, 'out', 'mapdraw', 'cache', world), `out/mapdraw/cache/${world}`);
  for (const entry of fs.readdirSync(path.join(ROOT, 'out')))
    if (entry.endsWith('_contours_10m.geojson')) addFile(archive, path.join(ROOT, 'out', entry), `out/${entry}`);
  for (const entry of fs.readdirSync(path.join(ROOT, 'out', 'mapdraw')))
    if (entry.endsWith('-models.json')) addFile(archive, path.join(ROOT, 'out', 'mapdraw', entry), `out/mapdraw/${entry}`);
  for (const dir of fs.readdirSync(path.join(ROOT, 'data'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of fs.readdirSync(path.join(ROOT, 'data', dir.name)))
      if (file.endsWith('_elevation.bin')) addFile(archive, path.join(ROOT, 'data', dir.name, file), `data/${dir.name}/${file}`);
  }

  archive.append(`DayZ render pool worker package
================================

Setup (one time):
  1. Install Node.js if not already present (any recent version).
  2. From this folder, run:  npm install
  3. Launch workers:         node tools/launch-workers.js --coordinator http://<coordinator-ip>:8080 --count 8

That's it - the workers will register, start pulling tiles, and render
them using the data bundled in this package plus source game assets
fetched on demand from the coordinator (cached locally after first use).

To stop workers: find "render-pool-agent" node processes and kill them.
Logs are written to worker-logs/ next to this folder.
`, { name: 'README.txt' });

  log('finalizing archive...');
  await archive.finalize();
  await done;

  const { size } = fs.statSync(ZIP_PATH);
  log(`done: ${ZIP_PATH} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`@@PACKAGE_READY ${JSON.stringify({ path: ZIP_PATH, sizeBytes: size })}`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
