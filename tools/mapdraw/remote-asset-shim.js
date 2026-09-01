// Preload module (`node -r remote-asset-shim.js script.js`) that
// transparently redirects filesystem reads for paths under the DayZ asset
// root through a local on-disk cache, fetching from the coordinator's
// asset server on a cache miss. Existing render scripts are untouched -
// they keep calling fs.readFileSync/existsSync/statSync exactly as before;
// this only intercepts what those calls resolve to.
//
// No-op unless both ASSET_SERVER_URL and REMOTE_ASSET_ROOT are set, so
// local/coordinator-side runs (which read the real P:\ directly) are
// completely unaffected.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ASSET_SERVER_URL = process.env.ASSET_SERVER_URL;
const REMOTE_ASSET_ROOT = process.env.REMOTE_ASSET_ROOT;

if (ASSET_SERVER_URL && REMOTE_ASSET_ROOT) {
  const CACHE_DIR = process.env.ASSET_CACHE_DIR || path.join(os.tmpdir(), 'dayz-asset-cache');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // Every path this pipeline touches under the asset root is a Windows-style
  // backslash string by construction (game data paths, manifest fields like
  // surfaceDirectory/layerDirectory baked in as literal "P:\..." strings,
  // WRP material path tables, etc.). path.join/path.resolve are USELESS for
  // recognizing these on a non-Windows host: POSIX's path.join doesn't
  // treat backslash as a separator at all, so "P:\DZ\foo" passed through it
  // comes out as one mangled literal segment instead of an absolute path.
  // Match and strip the root as plain strings instead of relying on any
  // platform's path semantics - correct on both Windows and macOS/Linux.
  const rootLower = REMOTE_ASSET_ROOT.toLowerCase();

  function relativeUnderRoot(targetPath) {
    // Normalize forward slashes to backslash first: POSIX path.join may
    // have stitched multiple call arguments together with '/' even though
    // each individual segment is itself backslash-delimited, producing a
    // mixed-separator string like "P:\DZ\surfaces\..\terrain/file.paa".
    const normalized = targetPath.replace(/\//g, '\\');
    if (!normalized.toLowerCase().startsWith(rootLower)) return null;
    return normalized.slice(REMOTE_ASSET_ROOT.length).split('\\').filter(Boolean).join('/');
  }
  function cachePathFor(relative) {
    const key = crypto.createHash('sha1').update(relative.toLowerCase()).digest('hex');
    return path.join(CACHE_DIR, `${key}${path.extname(relative)}`);
  }
  function dirListCachePathFor(relative) {
    const key = crypto.createHash('sha1').update(`dir:${relative.toLowerCase()}`).digest('hex');
    return path.join(CACHE_DIR, `${key}.dirlist.json`);
  }
  // Node has no built-in synchronous HTTP client, and every render script
  // in this pipeline reads assets synchronously (fs.readFileSync). Shelling
  // out to curl for a blocking fetch is a pragmatic way to stay in sync
  // land without rewriting the whole pipeline as async - curl ships by
  // default on both Windows 10+ and macOS.
  function fetchToCache(relative) {
    const cached = cachePathFor(relative);
    if (fs.existsSync(cached)) return cached;
    const url = `${ASSET_SERVER_URL}/api/assets/${relative.split('/').map(encodeURIComponent).join('/')}`;
    const temp = `${cached}.${process.pid}.tmp`;
    execFileSync('curl', ['-fsSL', '-o', temp, url], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    fs.renameSync(temp, cached);
    return cached;
  }
  function resolveLocal(targetPath) {
    const relative = relativeUnderRoot(targetPath);
    if (relative === null) return targetPath;
    return fetchToCache(relative);
  }
  // Most render scripts only ever read specific known files under the asset
  // root, but there's at least one legitimate directory-scan fallback (used
  // when a map's compiled 8WVR index wasn't generated, e.g. sakhal) that
  // enumerates a layers folder with fs.readdirSync. That works fine locally
  // against the real P:\ drive but has nothing to scan at all on a remote
  // worker, so it needs the same fetch-and-cache treatment as file reads.
  function fetchListingToCache(relative) {
    const cached = dirListCachePathFor(relative);
    if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
    const url = `${ASSET_SERVER_URL}/api/assets-list/${relative.split('/').map(encodeURIComponent).join('/')}`;
    const temp = `${cached}.${process.pid}.tmp`;
    execFileSync('curl', ['-fsSL', '-o', temp, url], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    fs.renameSync(temp, cached);
    return JSON.parse(fs.readFileSync(cached, 'utf8'));
  }

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function (targetPath, ...rest) {
    if (typeof targetPath === 'string') targetPath = resolveLocal(targetPath);
    return originalReadFileSync.call(fs, targetPath, ...rest);
  };
  const originalExistsSync = fs.existsSync;
  fs.existsSync = function (targetPath) {
    if (typeof targetPath === 'string' && relativeUnderRoot(targetPath) !== null) {
      try { resolveLocal(targetPath); return true; }
      catch { return false; }
    }
    return originalExistsSync.call(fs, targetPath);
  };
  const originalStatSync = fs.statSync;
  fs.statSync = function (targetPath, ...rest) {
    if (typeof targetPath === 'string') targetPath = resolveLocal(targetPath);
    return originalStatSync.call(fs, targetPath, ...rest);
  };
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = function (targetPath, options) {
    if (typeof targetPath === 'string') {
      const relative = relativeUnderRoot(targetPath);
      if (relative !== null) {
        const entries = fetchListingToCache(relative);
        if (options && options.withFileTypes) {
          return entries.map(e => ({
            name: e.name,
            isDirectory: () => e.isDirectory,
            isFile: () => !e.isDirectory,
            isSymbolicLink: () => false,
            isBlockDevice: () => false,
            isCharacterDevice: () => false,
            isFIFO: () => false,
            isSocket: () => false,
          }));
        }
        return entries.map(e => e.name);
      }
    }
    return originalReaddirSync.call(fs, targetPath, options);
  };

  console.error(`[remote-asset-shim] active: ${REMOTE_ASSET_ROOT} -> ${ASSET_SERVER_URL} (cache: ${CACHE_DIR})`);
}
