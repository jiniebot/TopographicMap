#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const projectRoot = path.resolve(__dirname, '..', '..');
const modelPath = path.resolve(process.argv[2] || 'P:\\DZ\\structures\\residential\\houses\\house_1w03.p3d');
const outputPath = path.join(projectRoot, 'out', 'mapdraw', `${path.basename(modelPath, '.p3d')}-inspection.json`);
const deP3dPath = process.env.DEP3D_PATH || 'C:\\Program Files (x86)\\Mikero\\DePboTools\\bin\\DeP3d.exe';
const paaModulePath = path.join(projectRoot, 'vendor', 'BIS-Toolkit', 'packages', 'paa', 'dist', 'index.js');

function runDeP3d(option) {
  const result = spawnSync(deP3dPath, ['-P', option, modelPath], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function resolveAsset(assetPath) {
  return path.join('P:\\', ...assetPath.replaceAll('/', '\\').split('\\'));
}

async function main() {
  if (!fs.existsSync(modelPath)) throw new Error(`Model not found: ${modelPath}`);
  if (!fs.existsSync(deP3dPath)) throw new Error(`DeP3d not found: ${deP3dPath}`);

  const header = Buffer.alloc(8);
  const descriptor = fs.openSync(modelPath, 'r');
  fs.readSync(descriptor, header, 0, header.length, 0);
  fs.closeSync(descriptor);
  const signature = header.subarray(0, 4).toString('ascii');
  const formatVersion = header.readUInt32LE(4);

  const lodText = runDeP3d('-LL');
  const boundsText = runDeP3d('-LB');
  const filesText = runDeP3d('-FL');
  const virtualModelPath = modelPath.replace(/^P:\\/i, '').toLowerCase();
  const virtualModelDirectory = path.win32.dirname(virtualModelPath);
  const references = [...new Set(filesText.match(/[a-z0-9_ .-]+(?:\\[a-z0-9_ .-]+)+\.(?:paa|edds|rvmat|bisurf|p3d)/gi) || [])]
    .map((asset) => asset.trim())
    .filter((asset) => asset.toLowerCase() !== virtualModelPath)
    .map((asset) => ({
      asset: asset.toLowerCase(),
      resolvedPath: resolveAsset(asset),
      exists: fs.existsSync(resolveAsset(asset)),
    }));

  const boundsMatch = boundsText.match(/size:\s*([\d.]+)\s*x\s*([\d.]+)/i);
  const lods = [...lodText.matchAll(/Lod(\d+):\s*<([^>]+)>/gi)].map((match) => ({
    index: Number(match[1]),
    resolution: match[2],
  }));

  const diffuse = references.find(({ asset }) =>
    asset.startsWith(`${virtualModelDirectory}\\data\\`) && asset.endsWith('_co.paa'),
  ) || references.find(({ asset }) => asset.endsWith('_co.paa'));
  let textureProbe = null;
  if (diffuse) {
    if (!fs.existsSync(paaModulePath)) throw new Error('Build BIS Toolkit first with `npm run build`.');
    const { Paa } = await import(pathToFileURL(paaModulePath));
    const source = fs.readFileSync(diffuse.resolvedPath);
    const paa = new Paa();
    paa.read(source);
    const rgba = paa.getArgb32PixelData(source, 0);
    textureProbe = {
      asset: diffuse.asset,
      width: paa.mipmaps[0].width,
      height: paa.mipmaps[0].height,
      mipCount: paa.mipmaps.length,
      hasAlpha: paa.isAlpha,
      rgbaBytes: rgba.length,
    };
  }

  const report = {
    schemaVersion: 1,
    model: modelPath,
    bytes: fs.statSync(modelPath).size,
    signature,
    formatVersion,
    bisToolkitGeometrySupport: signature === 'MLOD',
    lods,
    footprintMeters: boundsMatch ? {
      width: Number(boundsMatch[1]),
      height: Number(boundsMatch[2]),
    } : null,
    references,
    referenceCounts: {
      total: references.length,
      resolved: references.filter(({ exists }) => exists).length,
      unresolved: references.filter(({ exists }) => !exists).length,
    },
    textureProbe,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Model:      ${signature} v${formatVersion} ${modelPath}`);
  console.log(`LODs:       ${lods.length}`);
  console.log(`References: ${report.referenceCounts.resolved}/${references.length} resolved`);
  console.log(`Texture:    ${textureProbe ? `${textureProbe.width}x${textureProbe.height}, ${textureProbe.rgbaBytes.toLocaleString()} RGBA bytes` : 'none decoded'}`);
  console.log(`Report:     ${outputPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
