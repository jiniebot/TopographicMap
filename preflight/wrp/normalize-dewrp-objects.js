#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const projectRoot = path.resolve(__dirname, '..', '..');
function option(name,fallback){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback}
const world=option('--world','enoch').toLowerCase();
const inputPath = path.resolve(projectRoot,option('--input',path.join('out','mapdraw',`${world}-dewrp-objects.txt`)));
const outputDir = path.resolve(projectRoot,option('--out-dir',path.dirname(inputPath)));
const placementsPath = path.join(outputDir, `${world}-placements.ndjson`);
const modelsPath = path.join(outputDir, `${world}-models.json`);

const modelPattern = /^\s*\["([^"]+\.p3d)",\s*$/i;
const placementPattern = /^\s*\[(\d+),\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]\],?\s*$/;
const declaredCountPattern = /^nObjects=(\d+)\s*$/;

async function writeLine(stream, value) {
  if (!stream.write(value)) {
    await new Promise((resolve) => stream.once('drain', resolve));
  }
}

async function main() {
  if (!fs.existsSync(inputPath)) throw new Error(`DeWrp output not found: ${inputPath}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const input = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const placements = fs.createWriteStream(placementsPath, { encoding: 'utf8' });
  const models = new Map();
  let currentModel = null;
  let declaredPlacements = null;
  let placementCount = 0;

  for await (const line of lines) {
    const declaredMatch = line.match(declaredCountPattern);
    if (declaredMatch) declaredPlacements = Number(declaredMatch[1]);

    const modelMatch = line.match(modelPattern);
    if (modelMatch) {
      currentModel = modelMatch[1].toLowerCase();
      if (!models.has(currentModel)) models.set(currentModel, 0);
      continue;
    }

    const placementMatch = line.match(placementPattern);
    if (!placementMatch || !currentModel) continue;
    const record = {
      id: Number(placementMatch[1]),
      model: currentModel,
      x: Number(placementMatch[2]),
      z: Number(placementMatch[3]),
    };
    await writeLine(placements, `${JSON.stringify(record)}\n`);
    models.set(currentModel, models.get(currentModel) + 1);
    placementCount += 1;
  }

  await new Promise((resolve, reject) => placements.end((error) => error ? reject(error) : resolve()));
  if (declaredPlacements !== null && placementCount !== declaredPlacements) {
    throw new Error(`Parsed ${placementCount} placements, but DeWrp declared ${declaredPlacements}`);
  }

  const modelInventory = [...models.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((left, right) => right.count - left.count || left.model.localeCompare(right.model));
  const summary = {
    schemaVersion: 1,
    source: inputPath,
    placementCount,
    uniqueModelCount: modelInventory.length,
    models: modelInventory,
  };
  fs.writeFileSync(modelsPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Placements:    ${placementCount.toLocaleString()} -> ${placementsPath}`);
  console.log(`Unique models: ${modelInventory.length.toLocaleString()} -> ${modelsPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
