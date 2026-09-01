#!/usr/bin/env node
// Cross-platform launcher for render-pool-agent.js. Spawns N detached
// worker processes against a coordinator and exits, leaving them running
// in the background - no nohup/Start-Process wrangling needed on either
// platform. Usage:
//   node tools/launch-workers.js --coordinator http://10.0.0.8:8080 --count 8 [--label-prefix Worker]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
const COORDINATOR = arg('--coordinator');
const COUNT = Number(arg('--count', 8));
const LABEL_PREFIX = arg('--label-prefix', os.hostname());
if (!COORDINATOR || !Number.isInteger(COUNT) || COUNT < 1) {
  console.error('Usage: node tools/launch-workers.js --coordinator <url> --count <n> [--label-prefix name]');
  process.exit(1);
}

const logsDir = path.join(__dirname, '..', 'worker-logs');
fs.mkdirSync(logsDir, { recursive: true });

for (let i = 1; i <= COUNT; i++) {
  const label = `${LABEL_PREFIX}-${i}`;
  const logFile = path.join(logsDir, `${label}.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'render-pool-agent.js'),
    '--coordinator', COORDINATOR,
    '--label', label,
  ], {
    cwd: path.join(__dirname, '..'),
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  console.log(`started ${label} (pid ${child.pid}, log: ${logFile})`);
}
console.log(`\n${COUNT} workers launched against ${COORDINATOR}.`);
console.log(`Logs: ${logsDir}`);
console.log(`To stop them: find "render-pool-agent" processes and kill them (e.g. pkill -f render-pool-agent.js on macOS/Linux, or Stop-Process on Windows).`);
