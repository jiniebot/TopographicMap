#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const projectRoot = path.resolve(__dirname, '..', '..');
const modelPath = path.resolve(process.argv[2] || path.join(projectRoot, 'out', 'mapdraw', 'house_1w03_mlod.p3d'));
const outputPath = path.resolve(process.argv[3] || path.join(projectRoot, 'out', 'mapdraw', `${path.basename(modelPath, '.p3d')}-top.png`));
const size = Number(process.argv[4] || 1024);
const renderMode = (process.argv[5] || 'textured').toLowerCase();
const p3dModulePath = path.join(projectRoot, 'vendor', 'BIS-Toolkit', 'packages', 'p3d', 'dist', 'index.js');
const paaModulePath = path.join(projectRoot, 'vendor', 'BIS-Toolkit', 'packages', 'paa', 'dist', 'index.js');

function resolveAsset(asset) {
  return path.join('P:\\', ...asset.replaceAll('/', '\\').split('\\'));
}

function proceduralColor(texture) {
  const match = texture.match(/color\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)/i);
  if (!match) return [150, 150, 150, 255];
  return match.slice(1, 5).map((value) => Math.max(0, Math.min(255, Math.round(Number(value) * 255))));
}

function edge(ax, ay, bx, by, px, py) {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

function heightColor(value) {
  const t = Math.max(0, Math.min(1, value));
  if (t < 0.33) return [0, Math.round(t / 0.33 * 255), 255, 255];
  if (t < 0.66) return [Math.round((t - 0.33) / 0.33 * 255), 255, Math.round((0.66 - t) / 0.33 * 255), 255];
  return [255, Math.round((1 - t) / 0.34 * 255), 0, 255];
}

async function main() {
  if (!Number.isInteger(size) || size < 64 || size > 4096) throw new Error('Image size must be an integer from 64 to 4096.');
  if (!fs.existsSync(modelPath)) throw new Error(`MLOD model not found: ${modelPath}`);
  const [{ Mlod }, { Paa }] = await Promise.all([
    import(pathToFileURL(p3dModulePath)),
    import(pathToFileURL(paaModulePath)),
  ]);
  const model = Mlod.fromBuffer(fs.readFileSync(modelPath));
  const lod = model.lods
    .filter((candidate) => candidate.resolution >= 0 && candidate.resolution < 1000 && candidate.facesCount > 0)
    .sort((left, right) => left.resolution - right.resolution)[0];
  if (!lod) throw new Error('No visual resolution LOD found.');

  const bounds = lod.vertices.reduce((box, point) => ({
    minX: Math.min(box.minX, point.x), maxX: Math.max(box.maxX, point.x),
    minY: Math.min(box.minY, point.y), maxY: Math.max(box.maxY, point.y),
    minZ: Math.min(box.minZ, point.z), maxZ: Math.max(box.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const widthMeters = bounds.maxX - bounds.minX;
  const heightMeters = bounds.maxZ - bounds.minZ;
  const margin = Math.max(widthMeters, heightMeters) * 0.04;
  const scale = Math.min(size / (widthMeters + margin * 2), size / (heightMeters + margin * 2));
  const offsetX = (size - widthMeters * scale) / 2;
  const offsetY = (size - heightMeters * scale) / 2;

  const materialDefinitions = new Map();
  const textureNames = new Set(lod.textures);
  for (const materialName of lod.materials) {
    const materialPath = resolveAsset(materialName);
    if (!materialName || !fs.existsSync(materialPath)) continue;
    const materialText = fs.readFileSync(materialPath, 'utf8');
    const candidates = [...materialText.matchAll(/texture\s*=\s*"([^"]+)"/gi)].map((match) => match[1].toLowerCase());
    const layers = candidates.filter((candidate) => candidate.endsWith('_co.paa')).slice(0, 4);
    const mask = candidates.find((candidate) => candidate.endsWith('_mask.paa'));
    if (layers.length) {
      materialDefinitions.set(materialName.toLowerCase(), { layers, mask });
      layers.forEach((layer) => textureNames.add(layer));
      if (mask) textureNames.add(mask);
    }
  }

  const textures = new Map();
  for (const textureName of textureNames) {
    if (!textureName || textureName.startsWith('#')) {
      textures.set(textureName, { color: proceduralColor(textureName || '') });
      continue;
    }
    const texturePath = resolveAsset(textureName);
    if (!textureName.toLowerCase().endsWith('.paa') || !fs.existsSync(texturePath)) {
      textures.set(textureName, { color: [165, 165, 165, 255] });
      continue;
    }
    try {
      const source = fs.readFileSync(texturePath);
      const paa = new Paa();
      paa.read(source);
      // BIS Toolkit exposes decoded PAA pixels as BGRA. The raster buffer and
      // texture sampler below are RGBA, so normalize once at decode time.
      const bgra=paa.getArgb32PixelData(source,0),rgba=new Uint8Array(bgra.length);
      for(let i=0;i<bgra.length;i+=4){rgba[i]=bgra[i+2];rgba[i+1]=bgra[i+1];rgba[i+2]=bgra[i];rgba[i+3]=bgra[i+3]}
      textures.set(textureName, {
        width: paa.mipmaps[0].width,
        height: paa.mipmaps[0].height,
        pixels: rgba,
      });
    } catch (error) {
      console.warn(`Texture decode failed (${textureName}): ${error.message}`);
      textures.set(textureName, { color: [190, 80, 190, 255] });
    }
  }

  const pixels = Buffer.alloc(size * size * 4);
  const depth = new Float32Array(size * size);
  depth.fill(-Infinity);
  let triangles = 0;
  let roofOverrideTriangles = 0;

  function project(vertex) {
    const point = lod.vertices[vertex.pointIndex];
    return {
      x: offsetX + (point.x - bounds.minX) * scale,
      y: offsetY + (bounds.maxZ - point.z) * scale,
      depth: point.y,
      u: vertex.u,
      v: vertex.v,
    };
  }

  function sample(texture, u, v) {
    if (texture.layers) {
      const layerColors = texture.layers.map((layer) => sample(layer, u, v));
      if (!texture.mask) return layerColors[0];
      const weights = sample(texture.mask, u, v);
      const total = Math.max(1, weights.slice(0, layerColors.length).reduce((sum, weight) => sum + weight, 0));
      return [0, 1, 2, 3].map((channel) => Math.round(layerColors.reduce(
        (sum, color, index) => sum + color[channel] * weights[index], 0,
      ) / total));
    }
    if (texture.color) return texture.color;
    u = ((u % 1) + 1) % 1;
    v = ((v % 1) + 1) % 1;
    const tx = Math.min(texture.width - 1, Math.floor(u * texture.width));
    const ty = Math.min(texture.height - 1, Math.floor((1 - v) * texture.height));
    const index = (ty * texture.width + tx) * 4;
    return [texture.pixels[index], texture.pixels[index + 1], texture.pixels[index + 2], texture.pixels[index + 3]];
  }

  function rasterize(a, b, c, texture) {
    const area = edge(a.x, a.y, b.x, b.y, c.x, c.y);
    if (Math.abs(area) < 0.0001) return;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = edge(b.x, b.y, c.x, c.y, px, py) / area;
        const w1 = edge(c.x, c.y, a.x, a.y, px, py) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.00001 || w1 < -0.00001 || w2 < -0.00001) continue;
        const z = w0 * a.depth + w1 * b.depth + w2 * c.depth;
        const pixelIndex = y * size + x;
        if (z < depth[pixelIndex]) continue;
        const color = renderMode === 'height'
          ? heightColor((z - bounds.minY) / (bounds.maxY - bounds.minY))
          : sample(texture, w0 * a.u + w1 * b.u + w2 * c.u, w0 * a.v + w1 * b.v + w2 * c.v);
        if (color[3] < 32) continue;
        depth[pixelIndex] = z;
        const target = pixelIndex * 4;
        pixels[target] = color[0];
        pixels[target + 1] = color[1];
        pixels[target + 2] = color[2];
        pixels[target + 3] = color[3];
      }
    }
  }

  for (const face of lod.faces) {
    const faceVertices = face.getUsedVertices();
    const vertices = faceVertices.map(project);
    if (vertices.length < 3) continue;
    const definition = materialDefinitions.get(face.material.toLowerCase());
    const materialTexture = definition ? {
      layers: definition.layers.map((name) => textures.get(name)).filter(Boolean),
      mask: definition.mask ? textures.get(definition.mask) : null,
    } : null;
    for (let index = 1; index < vertices.length - 1; index += 1) {
      let texture = (face.texture ? textures.get(face.texture) : materialTexture) || { color: [165, 165, 165, 255] };
      if (!face.texture && definition) {
        const pa = lod.vertices[faceVertices[0].pointIndex];
        const pb = lod.vertices[faceVertices[index].pointIndex];
        const pc = lod.vertices[faceVertices[index + 1].pointIndex];
        const ab = { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z };
        const ac = { x: pc.x - pa.x, y: pc.y - pa.y, z: pc.z - pa.z };
        const normal = {
          x: ab.y * ac.z - ab.z * ac.y,
          y: ab.z * ac.x - ab.x * ac.z,
          z: ab.x * ac.y - ab.y * ac.x,
        };
        const normalLength = Math.hypot(normal.x, normal.y, normal.z) || 1;
        const upwardness = Math.abs(normal.y) / normalLength;
        const averageHeight = (pa.y + pb.y + pc.y) / 3;
        const highSurface = averageHeight > bounds.minY + (bounds.maxY - bounds.minY) * 0.55;
        const roofLayer = definition.layers.find((name) => name.includes('roof'));
        if (roofLayer && highSurface && upwardness > 0.25) {
          texture = textures.get(roofLayer) || texture;
          roofOverrideTriangles += 1;
        }
      }
      rasterize(vertices[0], vertices[index], vertices[index + 1], texture);
      triangles += 1;
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const ffmpeg = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba',
    '-video_size', `${size}x${size}`, '-i', 'pipe:0', '-frames:v', '1', outputPath,
  ], { input: pixels, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (ffmpeg.error) throw ffmpeg.error;
  if (ffmpeg.status !== 0) throw new Error(ffmpeg.stderr.toString());

  const metadataPath = outputPath.replace(/\.png$/i, '.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    schemaVersion: 1, model: modelPath, lodResolution: lod.resolution, imageSize: size, renderMode,
    triangles, roofOverrideTriangles, textureCount: textures.size, widthMeters, heightMeters,
    bounds, metersPerPixel: 1 / scale, colorChannels:'rgba-v2',
  }, null, 2)}\n`);
  console.log(`Rendered:  ${outputPath}`);
  console.log(`LOD:       ${lod.resolutionName} (${triangles.toLocaleString()} triangles)`);
  console.log(`Footprint: ${widthMeters.toFixed(2)}m x ${heightMeters.toFixed(2)}m`);
  console.log(`Textures:  ${textures.size}`);
  console.log(`Roof guess: ${roofOverrideTriangles.toLocaleString()} triangles`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
