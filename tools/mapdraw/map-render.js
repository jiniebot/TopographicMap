#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadMapManifest, inspectMapManifest, PROJECT_ROOT } = require('./map-build-config');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: PROJECT_ROOT, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`${script} failed with exit code ${result.status}`);
}

function usage() {
  console.log('Usage:');
  console.log('  node tools/mapdraw/map-render.js inspect <manifest>');
  console.log('  node tools/mapdraw/map-render.js preview <manifest> [--x N --z N --meters N --zoom N]');
  console.log('  node tools/mapdraw/map-render.js build <manifest> --approve-full-build');
}

const command = (process.argv[2] || '').toLowerCase();
const manifestArg = process.argv[3];
if (!command || !manifestArg) { usage(); process.exit(1); }
const config = loadMapManifest(manifestArg);
const inspection = inspectMapManifest(config);

if (command === 'inspect') {
  console.log(`${config.displayName || config.id} (${config.world}), ${config.mapSize}m`);
  for (const item of inspection.checks) console.log(`${item.ok ? '[ok]' : '[missing]'} ${item.name}: ${item.target}`);
  process.exitCode = inspection.ok ? 0 : 2;
} else if (command === 'preview') {
  if (!inspection.ok) throw new Error('Manifest inspection failed; run the inspect command for details');
  if (config.satellite?.type !== 'compiled-layers') throw new Error(`Unsupported satellite source type: ${config.satellite?.type}`);
  const x = Number(arg('--x', config.preview?.x ?? config.mapSize / 2));
  const z = Number(arg('--z', config.preview?.z ?? config.mapSize / 2));
  const meters = Number(arg('--meters', config.preview?.meters ?? 1000));
  const zoom = Number(arg('--zoom', config.preview?.zoom ?? 8));
  const size = Math.round(meters * 256 * 2 ** zoom / config.mapSize);
  const detailStrength = Number(arg('--detail-strength', config.preview?.detailStrength ?? 0.22));
  const previewDir = path.join(config.output, 'previews', `${x}-${z}-${meters}m-z${zoom}`);
  fs.mkdirSync(previewDir, { recursive: true });
  const common = ['--manifest', config.manifestPath, '--x', String(x), '--z', String(z), '--meters', String(meters), '--size', String(size)];
  run('render-hires-terrain-section.js', [...common, '--detail-strength', String(detailStrength), '--out', previewDir]);
  run('render-hires-object-section.js', [...common, '--base', path.join(previewDir, 'enhanced.png'), '--out', path.join(previewDir, 'combined.png')]);
  fs.writeFileSync(path.join(previewDir, 'preview-build.json'), JSON.stringify({ map: config.id, x, z, meters, zoom, size, metersPerPixel: meters / size, approved: false }, null, 2));
  console.log(`Preview ready: ${previewDir}`);
} else if (command === 'build') {
  if (!process.argv.includes('--approve-full-build')) throw new Error('Full build requires --approve-full-build after reviewing previews');
  throw new Error('Full map tile orchestration is the next implementation stage; preview workflow is ready');
} else {
  usage(); process.exit(1);
}
