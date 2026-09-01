#!/usr/bin/env node

// Experimental Livonia high-resolution terrain reconstruction.
// Rebuilds the compiled, overlap-corrected s_*_lco satellite source and adds
// real DayZ surface _ca detail while preserving the satellite's macro colour.
// This is intentionally sectional: use it to validate the material synthesis
// before attempting a complete zoom-7/8 pyramid.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createCanvas, ImageData } = require('@napi-rs/canvas');
const { loadMapManifest } = require('./map-build-config');

const ROOT = path.resolve(__dirname, '..', '..');
const PAA_MODULE = path.join(ROOT, 'vendor', 'BIS-Toolkit', 'packages', 'paa', 'dist', 'index.js');
let LAYERS = 'P:\\DZ\\worlds\\enoch\\data\\layers';
let SURFACES = 'P:\\DZ\\surfaces_bliss\\data\\terrain';
let MAP_SIZE = 12800;
let LAYER_GRID = 32;
let LAYER_WORLD_SIZE = MAP_SIZE / LAYER_GRID;
let LAYER_ROW_ORIGIN = 'northwest';
let LAYER_ORIGIN_X = 0;
let LAYER_ORIGIN_Z = 0;
let TRANSPARENT_NO_DATA = false;
let LAYER_SWAP_AXES = false;
let LAYER_FLIP_X = false;
let LAYER_FLIP_Y = false;
let LAYER_LOCAL_FLIP_X = false;
let LAYER_LOCAL_FLIP_Y = false;
let SOURCE_SIZE = 512;
let SOURCE_BORDER = 16;
let SOURCE_CONTENT = SOURCE_SIZE - SOURCE_BORDER * 2;
let DETAIL_WORLD_SIZE = 4;
let USE_WRP_MATERIAL_UV = false;
let WRP_PATH = null;
let MATERIAL_GRID_WIDTH = null;
let MATERIAL_GRID_HEIGHT = null;
let WRP_FLIP_GRID_Y = true;
let WRP_FLIP_TEXTURE_V = true;
let WRP_TEXTURE_V_OFFSET = 0;
let DIRECT_TILE_WORLD_SIZE = null;
let DIRECT_NORTH_ROWS = null;
let DIRECT_FLIP_LOCAL_Y = true;

let MATERIALS = [
  'en_deforested', 'en_flowers1', 'en_flowers2', 'en_flowers3',
  'en_forest_con', 'en_forest_dec', 'en_grass1', 'en_grass2',
  'en_soil', 'en_stones', 'en_stubble', 'en_tarmac_old',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mod(v, n) { return ((v % n) + n) % n; }

async function main() {
  const manifestPath = arg('--manifest', null);
  if (manifestPath) {
    const map = loadMapManifest(manifestPath);
    if (map.satellite?.type !== 'compiled-layers') throw new Error('Section renderer requires compiled-layers satellite input');
    MAP_SIZE = map.mapSize;
    LAYERS = map.satellite.layerDirectory;
    SURFACES = map.satellite.surfaceDirectory;
    LAYER_GRID = map.satellite.layerGrid;
    LAYER_ROW_ORIGIN = map.satellite.layerRowOrigin || 'northwest';
    LAYER_ORIGIN_X = map.satellite.layerOriginX || 0;
    LAYER_ORIGIN_Z = map.satellite.layerOriginZ || 0;
    TRANSPARENT_NO_DATA = map.satellite.transparentNoDataColors === true;
    LAYER_SWAP_AXES = map.satellite.layerSwapAxes === true;
    LAYER_FLIP_X = map.satellite.layerFlipX === true;
    LAYER_FLIP_Y = map.satellite.layerFlipY === true;
    LAYER_LOCAL_FLIP_X = map.satellite.layerLocalFlipX === true;
    LAYER_LOCAL_FLIP_Y = map.satellite.layerLocalFlipY === true;
    SOURCE_SIZE = map.satellite.sourceTilePixels;
    SOURCE_BORDER = map.satellite.sourceBorderPixels;
    SOURCE_CONTENT = SOURCE_SIZE - SOURCE_BORDER * 2;
    LAYER_WORLD_SIZE = map.satellite.layerWorldSize || MAP_SIZE / LAYER_GRID;
    DETAIL_WORLD_SIZE = map.satellite.detailWorldSize;
    MATERIALS = map.satellite.materials;
    USE_WRP_MATERIAL_UV = map.satellite.useWrpMaterialUv === true;
    WRP_PATH = path.resolve(ROOT, map.satellite.wrp8 || `out/mapdraw/wrp8-transform/${map.world}_8WVR.wrp`);
    MATERIAL_GRID_WIDTH = map.satellite.materialGridWidth || null;
    MATERIAL_GRID_HEIGHT = map.satellite.materialGridHeight || null;
    WRP_FLIP_GRID_Y = map.satellite.wrpFlipGridY !== false;
    WRP_FLIP_TEXTURE_V = map.satellite.wrpFlipTextureV !== false;
    DIRECT_TILE_WORLD_SIZE = map.satellite.directTileWorldSize || null;
    DIRECT_NORTH_ROWS = map.satellite.directNorthRows || null;
    DIRECT_FLIP_LOCAL_Y = map.satellite.directFlipLocalY !== false;
  }
  const centerX = Number(arg('--x', 6600));
  const centerZ = Number(arg('--z', 8930));
  const meters = Number(arg('--meters', 400));
  const size = Number(arg('--size', 2048));
  const detailStrength = Number(arg('--detail-strength', 0.38));
  LAYER_ROW_ORIGIN = arg('--layer-row-origin', LAYER_ROW_ORIGIN);
  LAYER_WORLD_SIZE = Number(arg('--layer-world-size', LAYER_WORLD_SIZE));
  LAYER_ORIGIN_X = Number(arg('--layer-origin-x', LAYER_ORIGIN_X));
  LAYER_ORIGIN_Z = Number(arg('--layer-origin-z', LAYER_ORIGIN_Z));
  LAYER_SWAP_AXES = arg('--layer-swap-axes', String(LAYER_SWAP_AXES)) === 'true';
  LAYER_FLIP_X = arg('--layer-flip-x', String(LAYER_FLIP_X)) === 'true';
  LAYER_FLIP_Y = arg('--layer-flip-y', String(LAYER_FLIP_Y)) === 'true';
  LAYER_LOCAL_FLIP_X = arg('--layer-local-flip-x', String(LAYER_LOCAL_FLIP_X)) === 'true';
  LAYER_LOCAL_FLIP_Y = arg('--layer-local-flip-y', String(LAYER_LOCAL_FLIP_Y)) === 'true';
  WRP_FLIP_GRID_Y = arg('--wrp-flip-grid-y', String(WRP_FLIP_GRID_Y)) === 'true';
  WRP_FLIP_TEXTURE_V = arg('--wrp-flip-texture-v', String(WRP_FLIP_TEXTURE_V)) === 'true';
  WRP_TEXTURE_V_OFFSET = Number(arg('--wrp-texture-v-offset', WRP_TEXTURE_V_OFFSET));
  const output = path.resolve(ROOT, arg('--out', `out/mapdraw/hires-terrain-${centerX}-${centerZ}`));
  if (![centerX, centerZ, meters, size, detailStrength].every(Number.isFinite)) throw new Error('Arguments must be numeric');
  if (meters <= 0 || size < 64 || size > 8192) throw new Error('Invalid --meters or --size');

  const { Paa } = await import(pathToFileURL(PAA_MODULE));
  const cache = new Map();
  let materialUvAt = null;
  function decodePaa(file) {
    let decoded = cache.get(file);
    if (decoded) return decoded;
    const source = fs.readFileSync(file);
    const paa = new Paa();
    paa.read(source);
    // BIS Toolkit normalizes PAA data to BGRA (see FormatConverter), whereas
    // Canvas ImageData and the sampling code here expect RGBA.
    const bgra = paa.getArgb32PixelData(source, 0);
    const pixels = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      pixels[i] = bgra[i + 2];
      pixels[i + 1] = bgra[i + 1];
      pixels[i + 2] = bgra[i];
      pixels[i + 3] = bgra[i + 3];
    }
    decoded = { width: paa.mipmaps[0].width, height: paa.mipmaps[0].height, pixels };
    cache.set(file, decoded);
    return decoded;
  }

  if (USE_WRP_MATERIAL_UV) {
    const wrp = fs.readFileSync(WRP_PATH), tx = wrp.readUInt32LE(4), ty = wrp.readUInt32LE(8);
    const gx = wrp.readUInt32LE(12), gy = wrp.readUInt32LE(16), activeWidth = MATERIAL_GRID_WIDTH || tx / 2, activeHeight = MATERIAL_GRID_HEIGHT || ty;
    let o = 24 + gx * gy * 4;
    const grid = new Uint16Array(wrp.buffer, wrp.byteOffset + o, tx * ty); o += tx * ty * 2;
    const count = wrp.readUInt32LE(o); o += 4; const paths = [];
    for (let i = 0; i < count; i++) { let s = ''; while (true) { const n = wrp.readUInt32LE(o); o += 4; if (!n) break; s += wrp.subarray(o, o + n).toString().replace(/\0+$/, ''); o += n; } paths.push(s); }
    const infoCache = new Map(), cellX = MAP_SIZE / activeWidth, cellZ = MAP_SIZE / activeHeight;
    function info(name) {
      let hit = infoCache.get(name); if (hit) return hit;
      const text = fs.readFileSync(path.join('P:\\', ...name.split('\\')), 'utf8');
      const texture = text.match(/class Stage0\s*\{[\s\S]*?texture="([^"]+_lco\.paa)"/i)?.[1];
      const aside = text.match(/aside\[\]\s*=\s*\{([^}]+)\}/i)?.[1].split(',').map(Number);
      const up = text.match(/up\[\]\s*=\s*\{([^}]+)\}/i)?.[1].split(',').map(Number);
      const pos = text.match(/pos\[\]\s*=\s*\{([^}]+)\}/i)?.[1].split(',').map(Number);
      if (!texture || !aside || !up || !pos) throw new Error(`Incomplete terrain UV data: ${name}`);
      hit = { texture: path.join('P:\\', ...texture.split('\\')), aside, up, pos }; infoCache.set(name, hit); return hit;
    }
    materialUvAt = (x, z) => {
      const cx = clamp(Math.floor(x / cellX), 0, activeWidth - 1);
      const rawCy = clamp(Math.floor(z / cellZ), 0, activeHeight - 1);
      const cy = WRP_FLIP_GRID_Y ? activeHeight - 1 - rawCy : rawCy;
      const name = paths[grid[cy * tx + cx]]; if (!name) return null;
      const hit = info(name);
      return { texture: decodePaa(hit.texture), u: x * hit.aside[0] + z * hit.aside[2] + hit.pos[0], v: x * hit.up[0] + z * hit.up[2] + hit.pos[1] };
    };
  }

  function sampleNearest(texture, u, v) {
    const x = clamp(Math.floor(mod(u, 1) * texture.width), 0, texture.width - 1);
    const y = clamp(Math.floor(mod(v, 1) * texture.height), 0, texture.height - 1);
    const o = (y * texture.width + x) * 4;
    return [texture.pixels[o], texture.pixels[o + 1], texture.pixels[o + 2], texture.pixels[o + 3]];
  }

  function sampleSatellite(x, z) {
    if (DIRECT_TILE_WORLD_SIZE && DIRECT_NORTH_ROWS) {
      const tileX = clamp(Math.floor(x / DIRECT_TILE_WORLD_SIZE), 0, LAYER_GRID - 1);
      const southRow = Math.floor(z / DIRECT_TILE_WORLD_SIZE);
      const tileY = clamp(DIRECT_NORTH_ROWS - 1 - southRow, 0, LAYER_GRID - 1);
      const localX = mod(x, DIRECT_TILE_WORLD_SIZE), localZ = mod(z, DIRECT_TILE_WORLD_SIZE);
      const texture = decodePaa(path.join(LAYERS, `s_${String(tileX).padStart(3,'0')}_${String(tileY).padStart(3,'0')}_lco.paa`));
      const px = SOURCE_BORDER + localX;
      const py = SOURCE_BORDER + (DIRECT_FLIP_LOCAL_Y ? DIRECT_TILE_WORLD_SIZE - localZ : localZ);
      const color = sampleNearest(texture, px / SOURCE_SIZE, py / SOURCE_SIZE);
      if (TRANSPARENT_NO_DATA) { const [r,g,b]=color,magenta=r>95&&b>100&&g<105,orange=r>110&&g>45&&g<125&&b<70;if(magenta||orange)color[3]=0; }
      return color;
    }
    if (materialUvAt) {
      const hit = materialUvAt(x, z);
      const textureV = (WRP_FLIP_TEXTURE_V ? -hit.v : hit.v) + WRP_TEXTURE_V_OFFSET / hit.texture.height;
      const color = sampleNearest(hit.texture, hit.u, textureV);
      if (TRANSPARENT_NO_DATA) { const [r,g,b]=color,magenta=r>95&&b>100&&g<105,orange=r>110&&g>45&&g<125&&b<70;if(magenta||orange)color[3]=0; }
      return color;
    }
    const sourceX=x-LAYER_ORIGIN_X,sourceZ=z-LAYER_ORIGIN_Z;
    const ix = clamp(Math.floor(sourceX / LAYER_WORLD_SIZE), 0, LAYER_GRID - 1);
    // Layer-row origin is a source-format property. World coordinates always
    // remain southwest-origin; only the source texture lookup changes.
    const vertical = LAYER_ROW_ORIGIN === 'southwest' ? sourceZ : (MAP_SIZE-LAYER_ORIGIN_Z)-z;
    const iz = clamp(Math.floor(vertical / LAYER_WORLD_SIZE), 0, LAYER_GRID - 1);
    const localX = clamp(sourceX - ix * LAYER_WORLD_SIZE, 0, LAYER_WORLD_SIZE);
    const localVertical = clamp(vertical - iz * LAYER_WORLD_SIZE, 0, LAYER_WORLD_SIZE);
    const tileX = LAYER_FLIP_X ? LAYER_GRID - 1 - ix : ix;
    const tileY = LAYER_FLIP_Y ? LAYER_GRID - 1 - iz : iz;
    const fileX = LAYER_SWAP_AXES ? tileY : tileX;
    const fileY = LAYER_SWAP_AXES ? tileX : tileY;
    const file = path.join(LAYERS, `s_${String(fileX).padStart(3, '0')}_${String(fileY).padStart(3, '0')}_lco.paa`);
    const texture = decodePaa(file);
    const sampleX = LAYER_LOCAL_FLIP_X ? LAYER_WORLD_SIZE - localX : localX;
    const sampleY = LAYER_LOCAL_FLIP_Y ? LAYER_WORLD_SIZE - localVertical : localVertical;
    const px = SOURCE_BORDER + sampleX / LAYER_WORLD_SIZE * SOURCE_CONTENT;
    // BIS' decoded PAA row order follows the TerrainX layer coordinate for
    // this source. Do not apply a second within-tile inversion here.
    const sourceY = sampleY;
    const py = SOURCE_BORDER + sourceY / LAYER_WORLD_SIZE * SOURCE_CONTENT;
    const color=sampleNearest(texture, px / SOURCE_SIZE, py / SOURCE_SIZE);
    if(TRANSPARENT_NO_DATA){
      const [r,g,b]=color,magenta=r>95&&b>100&&g<105,orange=r>110&&g>45&&g<125&&b<70;
      if(magenta||orange)color[3]=0;
    }
    return color;
  }

  const metersPerPixel=meters/size;
  // Approximate mipmapped sampling in world space. The compiled satellite
  // source is roughly metre-scale; sampling only the pixel center aliases
  // roads, vegetation and water edges badly once an output pixel spans many
  // source texels.
  function sampleSatelliteFiltered(x,z){
    if(metersPerPixel<=1.25)return sampleSatellite(x,z);
    const samples=Math.min(4,Math.max(2,Math.ceil(metersPerPixel/6))),sum=[0,0,0,0];
    for(let sy=0;sy<samples;sy++)for(let sx=0;sx<samples;sx++){
      const ox=((sx+.5)/samples-.5)*metersPerPixel,oz=((sy+.5)/samples-.5)*metersPerPixel,c=sampleSatellite(clamp(x+ox,0,MAP_SIZE-.0001),clamp(z+oz,0,MAP_SIZE-.0001));
      for(let channel=0;channel<4;channel++)sum[channel]+=c[channel];
    }
    return sum.map(value=>value/(samples*samples));
  }

  function sampleDetailFiltered(texture,x,z){
    if(metersPerPixel<=1)return sampleNearest(texture,x/DETAIL_WORLD_SIZE,-z/DETAIL_WORLD_SIZE);
    const samples=Math.min(4,Math.max(2,Math.ceil(metersPerPixel/DETAIL_WORLD_SIZE))),sum=[0,0,0,0];
    for(let sy=0;sy<samples;sy++)for(let sx=0;sx<samples;sx++){
      const ox=((sx+.5)/samples-.5)*metersPerPixel,oz=((sy+.5)/samples-.5)*metersPerPixel,c=sampleNearest(texture,(x+ox)/DETAIL_WORLD_SIZE,-(z+oz)/DETAIL_WORLD_SIZE);
      for(let channel=0;channel<4;channel++)sum[channel]+=c[channel];
    }
    return sum.map(value=>value/(samples*samples));
  }

  const materials = MATERIALS.map(name => {
    const texture = decodePaa(path.join(SURFACES, `${name}_ca.paa`));
    let r = 0, g = 0, b = 0, n = 0;
    const step = Math.max(1, Math.floor(texture.width / 64));
    for (let y = 0; y < texture.height; y += step) {
      for (let x = 0; x < texture.width; x += step) {
        const o = (y * texture.width + x) * 4;
        r += texture.pixels[o]; g += texture.pixels[o + 1]; b += texture.pixels[o + 2]; n++;
      }
    }
    return { name, texture, mean: [r / n, g / n, b / n] };
  });

  function chooseMaterial(base) {
    let best = materials[0], bestDistance = Infinity;
    const sum = Math.max(1, base[0] + base[1] + base[2]);
    const normalized = base.slice(0, 3).map(v => v / sum);
    for (const material of materials) {
      const ms = Math.max(1, material.mean[0] + material.mean[1] + material.mean[2]);
      const d = material.mean.reduce((acc, v, i) => acc + (v / ms - normalized[i]) ** 2, 0);
      if (d < bestDistance) { bestDistance = d; best = material; }
    }
    return best;
  }

  const basePixels = new Uint8ClampedArray(size * size * 4);
  const enhancedPixels = new Uint8ClampedArray(size * size * 4);
  const classPixels = new Uint8ClampedArray(size * size * 4);
  const palette = [[230,70,70],[70,210,90],[70,110,230],[220,190,60],[80,210,210],[210,80,210],[235,130,40],[130,235,40],[130,90,50],[150,150,150],[225,210,130],[70,70,70]];
  const counts = Object.fromEntries(MATERIALS.map(name => [name, 0]));
  const minX = centerX - meters / 2, maxZ = centerZ + meters / 2;

  for (let py = 0; py < size; py++) {
    const z = maxZ - (py + 0.5) / size * meters;
    for (let px = 0; px < size; px++) {
      const x = minX + (px + 0.5) / size * meters;
      const base = sampleSatelliteFiltered(x, z);
      const material = chooseMaterial(base);
      counts[material.name]++;
      // Detail is useful while the repeating texture is resolved (z6-8), but
      // must converge to its mean below that point like a real mip chain.
      const detailVisibility=clamp((4-metersPerPixel)/3,0,1);
      const effectiveDetailStrength=detailStrength*detailVisibility;
      let modulation=1;
      if(effectiveDetailStrength>0){const detail=sampleDetailFiltered(material.texture,x,z),meanLum=Math.max(1,(material.mean[0]+material.mean[1]+material.mean[2])/3),detailLum=(detail[0]+detail[1]+detail[2])/3;modulation=clamp(1+(detailLum/meanLum-1)*effectiveDetailStrength,.55,1.55)}
      const o = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        basePixels[o + c] = base[c];
        enhancedPixels[o + c] = clamp(Math.round(base[c] * modulation), 0, 255);
        classPixels[o + c] = palette[MATERIALS.indexOf(material.name) % palette.length][c];
      }
      basePixels[o + 3] = enhancedPixels[o + 3] = base[3];classPixels[o + 3] = 255;
    }
    if (py % Math.max(1,Math.floor(size/20)) === 0) console.log(`[hires-terrain] row ${py}/${size}`);
  }

  fs.mkdirSync(output, { recursive: true });
  for (const [name, pixels] of [['native-satellite', basePixels], ['enhanced', enhancedPixels], ['material-classes', classPixels]]) {
    const canvas = createCanvas(size, size), ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(pixels, size, size), 0, 0);
    fs.writeFileSync(path.join(output, `${name}.png`), canvas.toBuffer('image/png'));
  }
  fs.writeFileSync(path.join(output, 'meta.json'), JSON.stringify({ centerX, centerZ, meters, size, metersPerPixel, detailStrength, effectiveDetailStrength:detailStrength*clamp((4-metersPerPixel)/3,0,1),filter:'world-footprint box sampling',counts }, null, 2));
  console.log(`[hires-terrain] wrote ${output} at ${(meters / size).toFixed(4)} m/px`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
