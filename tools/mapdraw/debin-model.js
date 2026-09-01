#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const inputPath = path.resolve(process.argv[2] || 'P:\\DZ\\structures\\residential\\houses\\house_1w03.p3d');
const defaultName = `${path.basename(inputPath, path.extname(inputPath))}_mlod.p3d`;
const outputPath = path.resolve(process.argv[3] || path.join(projectRoot, 'out', 'mapdraw', defaultName));
const agenticRoot = path.join(projectRoot, 'vendor', 'Agentic-Z');
const pythonPath = path.join(agenticRoot, '.venv', 'Scripts', 'python.exe');
const converterPath = path.join(agenticRoot, '.claude', 'skills', 'dayz-p3d-debin', 'scripts', 'odol_to_mlod.py');

for (const requiredPath of [inputPath, pythonPath, converterPath]) {
  if (!fs.existsSync(requiredPath)) throw new Error(`Required path not found: ${requiredPath}`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const result = spawnSync(pythonPath, [converterPath, inputPath, outputPath], {
  cwd: path.dirname(converterPath),
  encoding: 'utf8',
  windowsHide: true,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
