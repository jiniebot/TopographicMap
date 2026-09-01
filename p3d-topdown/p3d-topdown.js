#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCanvas, loadImage, ImageData } = require('@napi-rs/canvas');

const DEFAULT_P3D2BMP = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\DayZ Tools\\Bin\\TerrainBuilder\\p3d2bmp.exe';

function usage() {
  console.log(`Usage: node p3d-topdown.js <model.p3d> [options]

Options:
  --out <file>            GeoJSON output path
  --png                   Also write a transparent PNG
  --png-out <file>        PNG output path (implies --png)
  --size <64..4096>       Projection resolution (default: 1024)
  --lod <number>          p3d2bmp visual LOD (default: 0)
  --width-meters <n>      Known model X span
  --depth-meters <n>      Known model Z span
  --simplify-pixels <n>   Simplification tolerance (default: 1.5)
  --asset-root <path>     DayZ asset root (default: P:\\)
  --p3d2bmp <file>        Override p3d2bmp.exe
  --help                  Show this help`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const input = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
  const value = (name, fallback = null) => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
    return argv[index + 1];
  };
  return {
    input,
    output: value('--out'),
    png: argv.includes('--png') || argv.includes('--png-out'),
    pngOutput: value('--png-out'),
    size: Number(value('--size', 1024)),
    lod: Number(value('--lod', 0)),
    widthMeters: value('--width-meters') == null ? null : Number(value('--width-meters')),
    depthMeters: value('--depth-meters') == null ? null : Number(value('--depth-meters')),
    simplifyPixels: Number(value('--simplify-pixels', 1.5)),
    assetRoot: value('--asset-root', process.env.DAYZ_ASSET_ROOT || 'P:\\'),
    p3d2bmp: value('--p3d2bmp', process.env.P3D2BMP_PATH || DEFAULT_P3D2BMP),
  };
}

function colorDistance(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
}

function edgePalette(pixels, width, height) {
  const counts = new Map();
  const add = (x, y) => {
    const offset = (y * width + x) * 4;
    const color = [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
    const key = color.join(',');
    const entry = counts.get(key) || { color, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  };
  for (let x = 0; x < width; x += 1) { add(x, 0); add(x, height - 1); }
  for (let y = 1; y < height - 1; y += 1) { add(0, y); add(width - 1, y); }
  const minimum = Math.max(2, Math.floor((width + height) * 0.01));
  return [...counts.values()].filter(entry => entry.count >= minimum).sort((a, b) => b.count - a.count).slice(0, 8).map(entry => entry.color);
}

function buildMask(pixels, width, height) {
  const backgrounds = edgePalette(pixels, width, height);
  if (!backgrounds.length) throw new Error('Could not determine projection background from image edges');
  const mask = new Uint8Array(width * height);
  let minX = width; let minY = height; let maxX = -1; let maxY = -1; let visible = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const color = [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
      const background = color[3] < 16 || backgrounds.some(candidate => colorDistance(color, candidate) <= 8);
      if (background) continue;
      mask[y * width + x] = 255;
      visible += 1;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (!visible) throw new Error('The selected LOD produced no visible top-down pixels');
  return { mask, bounds: { minX, minY, maxX, maxY }, visible, backgrounds };
}

function pointSegmentDistance(point, start, end) {
  const dx = end[0] - start[0]; const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

function simplifyOpen(points, tolerance) {
  if (points.length <= 2 || tolerance <= 0) return points;
  let index = -1; let distance = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const candidate = pointSegmentDistance(points[i], points[0], points[points.length - 1]);
    if (candidate > distance) { distance = candidate; index = i; }
  }
  if (distance <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplifyOpen(points.slice(0, index + 1), tolerance);
  const right = simplifyOpen(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

function simplifyRing(ring, tolerance) {
  if (ring.length < 5 || tolerance <= 0) return ring;
  const open = ring.slice(0, -1);
  let split = 1;
  for (let i = 2; i < open.length; i += 1) {
    if (Math.hypot(open[i][0] - open[0][0], open[i][1] - open[0][1]) > Math.hypot(open[split][0] - open[0][0], open[split][1] - open[0][1])) split = i;
  }
  const first = simplifyOpen(open.slice(0, split + 1), tolerance);
  const second = simplifyOpen(open.slice(split).concat([open[0]]), tolerance);
  const result = first.slice(0, -1).concat(second);
  if (result.length < 4) return ring;
  result[result.length - 1] = [...result[0]];
  return result;
}

async function trace(mask, width, height, tolerance) {
  const values = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) values[i] = mask[i] / 255;
  const { contours } = await import('d3-contour');
  const result = contours().size([width, height]).thresholds([0.5]).smooth(true)(values)[0];
  if (!result?.coordinates?.length) throw new Error('Unable to trace the projected silhouette');
  return result.coordinates.map(polygon => polygon.map(ring => simplifyRing(ring, tolerance)));
}

function transformGeometry(coordinates, bounds, widthMeters, depthMeters) {
  const pixelWidth = Math.max(1, bounds.maxX - bounds.minX);
  const pixelHeight = Math.max(1, bounds.maxY - bounds.minY);
  const metric = widthMeters != null;
  return coordinates.map(polygon => polygon.map(ring => ring.map(([x, y]) => {
    const nx = (x - bounds.minX) / pixelWidth - 0.5;
    const nz = 0.5 - (y - bounds.minY) / pixelHeight;
    return metric ? [nx * widthMeters, nz * depthMeters] : [nx, nz];
  })));
}

function vertexCount(coordinates) {
  return coordinates.reduce((total, polygon) => total + polygon.reduce((sum, ring) => sum + ring.length, 0), 0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (!options.input) throw new Error('A .p3d input path is required; use --help for usage');
  const input = path.resolve(options.input);
  if (path.extname(input).toLowerCase() !== '.p3d') throw new Error('Input must have a .p3d extension');
  if (!fs.existsSync(input)) throw new Error(`P3D not found: ${input}`);
  if (!fs.existsSync(options.p3d2bmp)) throw new Error(`p3d2bmp.exe not found: ${options.p3d2bmp}`);
  if (!Number.isInteger(options.size) || options.size < 64 || options.size > 4096) throw new Error('--size must be an integer from 64 to 4096');
  if (!Number.isFinite(options.lod) || options.lod < 0) throw new Error('--lod must be a non-negative number');
  if (!Number.isFinite(options.simplifyPixels) || options.simplifyPixels < 0) throw new Error('--simplify-pixels must be non-negative');
  const dimensions = [options.widthMeters, options.depthMeters];
  if (dimensions.some(value => value != null) && !dimensions.every(value => Number.isFinite(value) && value > 0)) throw new Error('Supply both --width-meters and --depth-meters as positive numbers');

  const outputDir = path.resolve(__dirname, 'output');
  const base = path.basename(input, path.extname(input));
  const geojsonPath = path.resolve(options.output || path.join(outputDir, `${base}-topdown.geojson`));
  const pngPath = path.resolve(options.pngOutput || path.join(path.dirname(geojsonPath), `${path.basename(geojsonPath, path.extname(geojsonPath))}.png`));
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-topdown-'));
  const bmpPath = path.join(temporaryDir, 'projection.bmp');
  try {
    const projection = spawnSync(options.p3d2bmp, [input, '-A0', '-Z90', `-L${options.lod}`, `-W${options.size}`, `-h${options.size}`, '-p', '-i', `-B${options.assetRoot}`, `-O${bmpPath}`], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    if (projection.error) throw projection.error;
    if (projection.status !== 0 || !fs.existsSync(bmpPath)) throw new Error(`p3d2bmp failed (${projection.status}): ${projection.stderr || projection.stdout || 'no output'}`);

    const image = await loadImage(bmpPath);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const source = context.getImageData(0, 0, image.width, image.height).data;
    const { mask, bounds, visible, backgrounds } = buildMask(source, image.width, image.height);
    const pixelGeometry = await trace(mask, image.width, image.height, options.simplifyPixels);
    const geometry = transformGeometry(pixelGeometry, bounds, options.widthMeters, options.depthMeters);
    const units = options.widthMeters == null ? 'normalized-model-bounds' : 'meters';
    const feature = {
      type: 'Feature',
      properties: {
        schemaVersion: 1,
        sourceModel: input,
        projection: 'top-down-xz',
        selectedLod: options.lod,
        coordinateUnits: units,
        widthMeters: options.widthMeters,
        depthMeters: options.depthMeters,
        imageSize: [image.width, image.height],
        visiblePixelBounds: bounds,
        visiblePixels: visible,
        polygonCount: geometry.length,
        vertexCount: vertexCount(geometry),
        simplifyPixels: options.simplifyPixels,
        renderer: options.p3d2bmp,
        assetRoot: options.assetRoot,
        detectedBackgroundColors: backgrounds.map(color => `rgba(${color.join(',')})`),
      },
      geometry: { type: 'MultiPolygon', coordinates: geometry },
    };
    fs.mkdirSync(path.dirname(geojsonPath), { recursive: true });
    fs.writeFileSync(geojsonPath, `${JSON.stringify(feature, null, 2)}\n`);

    if (options.png) {
      const transparent = new Uint8ClampedArray(source.length);
      for (let i = 0; i < mask.length; i += 1) {
        if (!mask[i]) continue;
        const offset = i * 4;
        transparent[offset] = source[offset]; transparent[offset + 1] = source[offset + 1]; transparent[offset + 2] = source[offset + 2]; transparent[offset + 3] = source[offset + 3];
      }
      const outputCanvas = createCanvas(image.width, image.height);
      outputCanvas.getContext('2d').putImageData(new ImageData(transparent, image.width, image.height), 0, 0);
      fs.mkdirSync(path.dirname(pngPath), { recursive: true });
      fs.writeFileSync(pngPath, outputCanvas.toBuffer('image/png'));
    }

    console.log(`Shape:    ${geojsonPath}`);
    if (options.png) console.log(`PNG:      ${pngPath}`);
    console.log(`Geometry: ${geometry.length} polygon(s), ${feature.properties.vertexCount} vertices, ${units}`);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
