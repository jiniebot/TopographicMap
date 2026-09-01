// Shared loader for map-styles.js / config.js / map-core.js's coreCustomObjectDrawers
// and bboxCache.rectangles.json, reusing the same vm.runInContext sandboxing approach
// already proven in tools/prebuild-categories.js, so style/config values are never
// hand-duplicated between the browser client and Node build scripts.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

function loadStyleConfig() {
  const mapStylesPath = path.join(ROOT, 'public', 'js', 'map-styles.js');
  const mapStylesCode = fs.readFileSync(mapStylesPath, 'utf-8');
  const mapStylesSandbox = { console, window: {} };
  vm.createContext(mapStylesSandbox);
  vm.runInContext(mapStylesCode + '\n;this.__mapStylesExport = mapStyles;', mapStylesSandbox);
  const mapStyles = mapStylesSandbox.__mapStylesExport;

  const configPath = path.join(ROOT, 'public', 'js', 'config.js');
  const configCode = fs.readFileSync(configPath, 'utf-8');
  const configSandbox = { console };
  vm.createContext(configSandbox);
  vm.runInContext(configCode + '\n;this.__configExport = config; this.__worldSizeExport = WORLD_SIZE;', configSandbox);
  const config = configSandbox.__configExport;
  const WORLD_SIZE = configSandbox.__worldSizeExport;

  const mapCorePath = path.join(ROOT, 'public', 'js', 'map-core.js');
  const mapCoreCode = fs.readFileSync(mapCorePath, 'utf-8');
  const coreSandbox = {
    console,
    mapStyles,
    config,
    WORLD_SIZE,
    window: {},
    document: { readyState: 'loading', addEventListener: () => {} },
    setTimeout: () => {},
    clearTimeout: () => {},
  };
  vm.createContext(coreSandbox);
  vm.runInContext(
    mapCoreCode +
      "\n;this.__coreCustomObjectDrawers = typeof coreCustomObjectDrawers !== 'undefined' ? coreCustomObjectDrawers : null;",
    coreSandbox
  );
  const coreCustomObjectDrawers = coreSandbox.__coreCustomObjectDrawers || null;

  const bboxCachePath = path.join(ROOT, 'out', 'bboxCache.rectangles.json');
  const bboxCache = fs.existsSync(bboxCachePath)
    ? JSON.parse(fs.readFileSync(bboxCachePath, 'utf-8'))
    : {};

  // mapStyles.drawingOrder contains category names that don't exist in
  // mapStyles.categories (e.g. "roads") - filter down to real categories.
  const drawingOrder = (mapStyles.drawingOrder || []).filter(
    (name) => mapStyles.categories && mapStyles.categories[name]
  );

  return { ROOT, mapStyles, config, WORLD_SIZE, coreCustomObjectDrawers, bboxCache, drawingOrder };
}

module.exports = { loadStyleConfig, ROOT };
