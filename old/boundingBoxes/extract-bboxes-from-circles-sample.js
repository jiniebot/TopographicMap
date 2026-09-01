import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import pLimit from "p-limit";

// -------------------- HARD-CODED PATHS --------------------
const CIRCLES_CSV_PATH = path.resolve("./data/TB Data/circles.csv");
const DEP3D_EXE = "C:\\Program Files (x86)\\Mikero\\DePboTools\\bin\\DeP3d.exe";
const DZ_ROOT = "D:\\DayZ Projects\\DZ";
const OUT_DIR = path.resolve("./out");
const SAMPLE_SIZE = 50; // Only process first 50 unique circle types
// ----------------------------------------------------------

const OUT_BBOX = path.join(OUT_DIR, "bboxCache.circles.sample.json");
const OUT_MISSES = path.join(OUT_DIR, "bboxCache.circles.sample.misses.json");
const OUT_ERRORS = path.join(OUT_DIR, "bboxCache.circles.sample.errors.json");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function readText(p) {
  return fs.readFileSync(p, "utf8");
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

/** Parse CSV and extract unique object names from first column (sample only) */
function extractObjectNamesFromCSVSample(filePath, sampleSize) {
  const names = new Set();
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  
  return new Promise((resolve, reject) => {
    let lineNum = 0;
    let buffer = "";
    
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete line
      
      for (const line of lines) {
        lineNum++;
        if (lineNum === 1) continue; // Skip header
        
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        const parts = trimmed.split(";");
        if (parts.length > 0) {
          const name = parts[0].trim().replace(/^"|"$/g, "");
          if (name) {
            names.add(name);
            if (names.size >= sampleSize) {
              stream.destroy();
              resolve([...names]);
              return;
            }
          }
        }
      }
    });
    
    stream.on("end", () => {
      resolve([...names]);
    });
    
    stream.on("error", reject);
  });
}

/** Index all .p3d by basename stem */
function indexP3DsByStem(rootDir) {
  const index = new Map();
  const stack = [rootDir];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".p3d")) {
        const stem = path.parse(ent.name).name.toLowerCase();
        if (!index.has(stem)) index.set(stem, []);
        index.get(stem).push(full);
      }
    }
  }

  return index;
}

/** Generate candidate stems from object name */
function candidateStemsFromObjectName(objectName) {
  const raw = String(objectName).trim();
  const lower = raw.toLowerCase();
  
  const c = new Set();
  
  // Direct match
  c.add(lower);
  
  // Try without underscores
  c.add(lower.replace(/[_-]/g, ""));
  
  // Split and try last parts
  const parts = lower.split(/[_-]/);
  if (parts.length > 1) {
    c.add(parts[parts.length - 1]);
    c.add(parts.slice(-2).join("_"));
  }
  
  // Try with numbers removed
  c.add(lower.replace(/\d+/g, ""));
  
  return [...c];
}

/** Pick best candidate path */
function pickBestCandidate(candidates) {
  if (candidates.length === 1) return candidates[0];

  return candidates
    .map((p) => {
      const pl = p.toLowerCase();
      let score = 0;
      if (pl.includes("\\structures\\")) score += 50;
      if (pl.includes("\\residential\\")) score += 10;
      if (pl.includes("\\buildings\\")) score += 5;
      score += Math.max(0, 250 - pl.length);
      return { p, score };
    })
    .sort((a, b) => b.score - a.score)[0].p;
}

function runDep3d(modelPath) {
  return new Promise((resolve) => {
    const child = spawn(DEP3D_EXE, ["-P", "-LB", modelPath], {
      windowsHide: true,
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function parseBBox(output) {
  const lines = output.replace(/\r/g, "").split("\n");
  const float3 =
    /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)[,\s]+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)[,\s]+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i;

  let min = null;
  let max = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const low = line.toLowerCase();

    if (!min && low.includes("min")) {
      const m = line.match(float3);
      if (m) min = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    if (!max && low.includes("max")) {
      const m = line.match(float3);
      if (m) max = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
  }

  if (!min || !max) return null;

  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ],
  };
}

// -------------------- MAIN --------------------
(async () => {
  ensureDir(OUT_DIR);

  if (!fs.existsSync(DZ_ROOT)) {
    console.error("DZ_ROOT does not exist:", DZ_ROOT);
    process.exit(1);
  }
  if (!fs.existsSync(DEP3D_EXE)) {
    console.error("DEP3D_EXE does not exist:", DEP3D_EXE);
    process.exit(1);
  }
  if (!fs.existsSync(CIRCLES_CSV_PATH)) {
    console.error("CIRCLES_CSV_PATH does not exist:", CIRCLES_CSV_PATH);
    process.exit(1);
  }

  const existing = fs.existsSync(OUT_BBOX)
    ? JSON.parse(fs.readFileSync(OUT_BBOX, "utf8"))
    : {};
  const misses = fs.existsSync(OUT_MISSES)
    ? JSON.parse(fs.readFileSync(OUT_MISSES, "utf8"))
    : {};
  const errors = fs.existsSync(OUT_ERRORS)
    ? JSON.parse(fs.readFileSync(OUT_ERRORS, "utf8"))
    : {};

  console.log(`Parsing circles.csv (first ${SAMPLE_SIZE} unique objects)...`);
  const objectNames = await extractObjectNamesFromCSVSample(CIRCLES_CSV_PATH, SAMPLE_SIZE);

  console.log(`\nFound ${objectNames.length} unique circle object names:`);
  console.log(objectNames);

  console.log("\nIndexing DZ .p3d by stem...");
  const p3dIndex = indexP3DsByStem(DZ_ROOT);
  console.log(`Indexed ${p3dIndex.size} unique .p3d stems`);

  const limit = pLimit(2);

  await Promise.all(
    objectNames.map((objectName) =>
      limit(async () => {
        if (existing[objectName] || misses[objectName] || errors[objectName]) {
          return;
        }

        const stems = candidateStemsFromObjectName(objectName);

        let candidates = null;
        let usedStem = null;

        for (const stem of stems) {
          const hit = p3dIndex.get(stem);
          if (hit && hit.length) {
            candidates = hit;
            usedStem = stem;
            break;
          }
        }

        console.log(`\n[LOOKUP] ${objectName}`);
        console.log(`  tried stems: ${stems.slice(0, 5).join(", ")}${stems.length > 5 ? "..." : ""}`);

        if (!candidates) {
          console.log("  ❌ no match");
          misses[objectName] = { reason: "P3D_NOT_FOUND", triedStems: stems };
          return;
        }

        const modelPath = pickBestCandidate(candidates);
        console.log(`  ✅ matched stem: ${usedStem}`);
        console.log(`  ✅ modelPath: ${modelPath}`);

        const { code, out, err } = await runDep3d(modelPath);
        const bbox = parseBBox(out);

        if (!bbox) {
          console.log("  ⚠️ DeP3d ran but bbox parse failed");
          console.log("  Output preview:", out.slice(0, 500));
          errors[objectName] = {
            reason: "BBOX_PARSE_FAILED",
            modelPath,
            matchedStem: usedStem,
            exitCode: code,
            stdoutPreview: out.slice(0, 1000),
            stderrTail: err.slice(-500),
          };
          return;
        }

        existing[objectName] = {
          objectName,
          modelPath,
          matchedStem: usedStem,
          ...bbox,
        };

        console.log(
          `  📦 bbox size: ${bbox.size.map((n) => n.toFixed(3)).join(", ")}`
        );
        console.log(
          `     center: ${bbox.center.map((n) => n.toFixed(3)).join(", ")}`
        );
      })
    )
  );

  writeJson(OUT_BBOX, existing);
  writeJson(OUT_MISSES, misses);
  writeJson(OUT_ERRORS, errors);

  console.log("\n=== SUMMARY ===");
  console.log(`Total objects processed: ${objectNames.length}`);
  console.log(`Successfully extracted: ${Object.keys(existing).length}`);
  console.log(`Missed (P3D not found): ${Object.keys(misses).length}`);
  console.log(`Errors (parse failed): ${Object.keys(errors).length}`);
  console.log("\nOutput files:");
  console.log(`  - ${OUT_BBOX}`);
  console.log(`  - ${OUT_MISSES}`);
  console.log(`  - ${OUT_ERRORS}`);
  console.log("\nDONE");
})();
