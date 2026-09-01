const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Manifest fields like wrp/surfaceDirectory/layerDirectory store Windows
// drive-letter paths (e.g. "P:\DZ\...") by construction - this is DayZ game
// data, always authored as Windows paths regardless of what platform the
// renderer itself runs on. path.isAbsolute() is platform-dependent and
// returns false for a drive-letter path on macOS/Linux, which would
// otherwise make this treat an already-absolute path as relative and
// resolve it against the manifest's own directory - producing a garbled,
// nonexistent path. Recognize Windows absolute paths explicitly first.
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
function absoluteFrom(base, value) {
  if (!value) return null;
  if (WINDOWS_ABSOLUTE.test(value)) return value;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}
// Same problem, different data source: transform-index/model-cache records
// store relative paths (model.metadata/model.image) as backslash-delimited
// strings baked in at index-build time, always on Windows. path.resolve()
// treats a whole such string as one opaque segment on POSIX instead of
// splitting it, producing a garbled path like "root/out\mapdraw\cache\...".
// Split on either separator explicitly before rejoining with the host's
// native path.join so this resolves correctly regardless of platform.
function resolveStoredPath(root, value) {
  if (!value) return null;
  if (WINDOWS_ABSOLUTE.test(value)) return value;
  return path.join(root, ...value.split(/[\\/]+/).filter(Boolean));
}

function loadMapManifest(manifestPath) {
  const file = path.resolve(PROJECT_ROOT, manifestPath);
  if (!fs.existsSync(file)) throw new Error(`Map manifest not found: ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.dirname(file);
  const required = ['id', 'world', 'mapSize', 'assetRoot', 'transformIndex'];
  for (const key of required) if (raw[key] == null || raw[key] === '') throw new Error(`Manifest is missing ${key}`);
  if (!Number.isFinite(raw.mapSize) || raw.mapSize <= 0) throw new Error('mapSize must be positive');
  const coordinates = raw.coordinateSystem || { origin: 'southwest', xAxis: 'east', zAxis: 'north' };
  if (coordinates.origin !== 'southwest' || coordinates.xAxis !== 'east' || coordinates.zAxis !== 'north') {
    throw new Error('Renderer coordinates must use southwest origin, +X east and +Z north');
  }
  const config = {
    ...raw,
    coordinateSystem: coordinates,
    manifestPath: file,
    wrp: absoluteFrom(base, raw.wrp),
    placements: raw.placements ? { ...raw.placements,
      sourceDirectory: absoluteFrom(base, raw.placements.sourceDirectory),
      summary: absoluteFrom(base, raw.placements.summary),
      exporter: absoluteFrom(base, raw.placements.exporter),
    } : { type: 'wrp' },
    assetRoot: absoluteFrom(base, raw.assetRoot),
    transformIndex: absoluteFrom(base, raw.transformIndex),
    elevation: raw.elevation ? { ...raw.elevation, file: absoluteFrom(base, raw.elevation.file) } : null,
    satellite: raw.satellite ? {
      ...raw.satellite,
      layerDirectory: absoluteFrom(base, raw.satellite.layerDirectory),
      surfaceDirectory: absoluteFrom(base, raw.satellite.surfaceDirectory),
    } : null,
    output: absoluteFrom(base, raw.output || `../../out/mapdraw/builds/${raw.id}`),
  };
  return config;
}

function inspectMapManifest(config) {
  const checks = [];
  function check(name, target, kind = 'file', required = true) {
    const exists = Boolean(target && fs.existsSync(target));
    const correctKind = exists && (kind === 'directory' ? fs.statSync(target).isDirectory() : fs.statSync(target).isFile());
    checks.push({ name, target, required, ok: correctKind, kind });
  }
  if(config.placements?.type==='runtime-export'){
    check('Runtime placement rows',config.placements.sourceDirectory,'directory');
    check('Runtime placement summary',config.placements.summary);
  }else check('WRP', config.wrp);
  check('Asset root', config.assetRoot, 'directory');
  check('Transform index', config.transformIndex, 'directory');
  if (config.elevation) check('Elevation grid', config.elevation.file);
  if (config.satellite?.type === 'compiled-layers') {
    check('Satellite layers', config.satellite.layerDirectory, 'directory');
    check('Surface textures', config.satellite.surfaceDirectory, 'directory');
  }
  return { ok: checks.every(item => !item.required || item.ok), checks };
}

module.exports = { PROJECT_ROOT, loadMapManifest, inspectMapManifest, resolveStoredPath };
