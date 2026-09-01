#!/usr/bin/env node
// Renders exactly one tile's worth of output (satellite PNG and/or the 4
// topographic PBFs) for the distributed render pool. Mirrors the per-tile
// math and script orchestration in build-final-zoom.js's renderTile() -
// same underlying scripts, same output shape - but is a standalone
// single-tile entry point so a remote worker can run it without depending
// on build-final-zoom.js's shared job/resume state, which only makes sense
// on the coordinator that owns that state.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadMapManifest, PROJECT_ROOT } = require('./map-build-config');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
function run(script, args) {
  const nodeArgs = script === 'build-vector-section.js' ? ['--max-old-space-size=8192'] : [];
  const result = spawnSync(process.execPath, [...nodeArgs, path.join(__dirname, script), ...args], { cwd: PROJECT_ROOT, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${script} failed: ${(result.stderr || result.stdout || '').slice(-2000)}`);
  return result.stdout;
}

const manifest = loadMapManifest(arg('--manifest'));
const zoom = Number(arg('--zoom')), tx = Number(arg('--tx')), ty = Number(arg('--ty'));
const modes = arg('--modes', 'satellite,topographic').split(',').filter(Boolean);
const out = path.resolve(arg('--out', path.join(PROJECT_ROOT, 'out', 'mapdraw', 'remote-tile-work')));
if (![zoom, tx, ty].every(Number.isInteger)) throw new Error('--zoom/--tx/--ty must be integers');
if (!modes.length || modes.some(mode => !['satellite', 'topographic'].includes(mode))) throw new Error('Invalid --modes');

const side = 2 ** zoom, tileMeters = manifest.mapSize / side,
  centerX = (tx + 0.5) * tileMeters, centerZ = manifest.mapSize - (ty + 0.5) * tileMeters;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const produced = [];

if (modes.includes('satellite')) {
  const terrainWork = path.join(out, 'satellite-terrain');
  const common = ['--manifest', manifest.manifestPath, '--x', String(centerX), '--z', String(centerZ), '--meters', String(tileMeters), '--size', '256'];
  run('render-hires-terrain-section.js', [...common, '--detail-strength', String(manifest.preview?.detailStrength ?? 0.5), '--out', terrainWork]);
  const satTarget = path.join(out, 'satellite.png');
  run('render-hires-object-section.js', [...common, '--base', path.join(terrainWork, 'enhanced.png'), '--out', satTarget]);
  produced.push('satellite.png');
}
if (modes.includes('topographic')) {
  const topoWork = path.join(out, 'topographic');
  run('build-topographic-preview.js', ['--manifest', manifest.manifestPath, '--x', String(centerX), '--z', String(centerZ), '--meters', String(tileMeters), '--min-zoom', String(zoom), '--max-zoom', String(zoom), '--out', topoWork]);
  for (const layer of ['terrain', 'surfaces', 'water', 'objects']) {
    const source = path.join(topoWork, layer, String(zoom), String(tx), `${ty}.pbf`);
    const target = path.join(out, `${layer}.pbf`);
    if (fs.existsSync(source)) { fs.copyFileSync(source, target); produced.push(`${layer}.pbf`); }
  }
}
console.log(`@@REMOTE_TILE_RESULT ${JSON.stringify({ zoom, tx, ty, produced })}`);
