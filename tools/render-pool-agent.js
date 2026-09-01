#!/usr/bin/env node
// Remote render-pool worker. Registers with a coordinator server, then
// repeatedly leases a tile task, renders it locally (fetching DayZ source
// assets through the coordinator's asset server + a local cache instead of
// needing a direct network drive mount), and submits the result files back
// over HTTP. Run this on any machine that should join the render pool -
// requires only Node and curl, both already present on Windows 10+/macOS.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
// Mirrors server.js's poolLeaseMsForZoom, minus a minute of margin, so this
// worker kills and retries a genuinely slow task on its own before the
// coordinator's lease would expire and reassign it out from under it.
// Originally tuned while the pool-worker model-footprint cache had a
// widespread bug that made most placed objects silently skip as
// "unsupported" (see cache-state.json fix) - tiles finished in seconds
// because they were barely doing any real work. Now that objects actually
// render, a z6 tile alone can take ~2 minutes, i.e. right at (or past) the
// old ceiling - the agent's own timeout was killing legitimately-still-
// working renders (signal-killed, "exit code null") and the coordinator
// counted that as a failure, not a timing problem. Widened with real
// headroom across the board.
function agentTimeoutMsForZoom(zoom) {
  if (zoom <= 1) return 25 * 60 * 1000;
  if (zoom === 2) return 18 * 60 * 1000;
  if (zoom === 3) return 14 * 60 * 1000;
  if (zoom === 4) return 10 * 60 * 1000;
  if (zoom === 5) return 8 * 60 * 1000;
  return 6 * 60 * 1000;
}
const COORDINATOR = arg('--coordinator', 'http://localhost:8080').replace(/\/+$/, '');
const LABEL = arg('--label', os.hostname());
// The distributed queue can move from map to map over time (chernarus done
// -> livonia active -> sakhal next). A worker fixed to one --manifest would
// silently render the wrong map's math once the active job switches. Resolve
// the manifest per-lease instead, from the manifestFile the coordinator
// already returns - a --manifest override is still accepted for one-off runs
// pinned to a single map.
const MANIFEST_OVERRIDE = arg('--manifest');
const MANIFESTS_DIR = path.resolve(arg('--manifests-dir', path.join(__dirname, '..', 'configs', 'maps')));
const ASSET_ROOT = arg('--asset-root', 'P:\\');
const WORK_DIR = path.resolve(arg('--work-dir', path.join(os.tmpdir(), 'render-pool-work')));
const CACHE_DIR = path.resolve(arg('--cache-dir', path.join(os.tmpdir(), 'dayz-asset-cache')));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function curlJson(method, urlPath, body) {
  const result = spawnSync('curl', [
    '-fsSL', '-X', method,
    ...(body !== undefined ? ['-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body)] : []),
    `${COORDINATOR}${urlPath}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error(`${method} ${urlPath} failed: ${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : null;
}
function submitFile(jobId, taskId, workerId, layer, filePath) {
  const result = spawnSync('curl', [
    '-fsSL', '-X', 'POST', '--data-binary', `@${filePath}`,
    `${COORDINATOR}/api/render-pool/jobs/${jobId}/submit?workerId=${workerId}&taskId=${taskId}&file=${layer}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error(`submit ${layer} failed: ${result.stderr}`);
}

// spawnSync's built-in `timeout` option only signals the *immediate* child -
// it has no concept of the process tree that child goes on to spawn (render-
// remote-tile.js -> build-topographic-preview.js -> build-vector-section.js,
// several levels deep). Killing just the top of that chain leaves whatever
// it had already spawned running orphaned (reparented to PID 1/launchd),
// invisible to this agent from then on - confirmed on a live Mac worker: an
// orphaned build-topographic-preview.js still running 10+ minutes after its
// task should have timed out, with its own child still chained beneath it.
// Spawning detached (POSIX: new process group, child becomes group leader)
// and killing the whole group with a negative PID on timeout takes the
// entire tree down together. Windows has no equivalent to negative-PID
// group kill, so `taskkill /T` (kill process tree) is used there instead.
function killTree(child) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    catch { /* already exited */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { /* already exited, or never got its own group */ }
  }
}
function runRenderWithTimeout(args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env, windowsHide: true, detached: process.platform !== 'win32',
    });
    let stdout = '', stderr = '', settled = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { killTree(child); }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: stderr || error.message });
    });
    child.on('close', (status, signal) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}
function join() {
  const { workerId } = curlJson('POST', '/api/render-pool/workers/join', { label: LABEL });
  console.log(`[agent] joined as ${workerId} (${LABEL}) -> ${COORDINATOR}`);
  return workerId;
}
async function main() {
  let workerId = join();
  let idleTicks = 0;
  for (;;) {
    let lease;
    try { lease = curlJson('GET', `/api/render-pool/lease?workerId=${workerId}`); }
    catch (error) {
      // Worker registrations live only in the coordinator's memory - a
      // coordinator restart (picking up new code, etc.) wipes them, and a
      // stale workerId would otherwise loop failing forever. Re-join
      // unconditionally on any lease error; it's a cheap no-op if the
      // failure was something else transient (network blip, etc.).
      console.error(`[agent] lease request failed: ${error.message} - rejoining`);
      try { workerId = join(); } catch (joinError) { console.error(`[agent] rejoin failed: ${joinError.message}`); }
      await sleep(5000); continue;
    }
    if (!lease?.task) { idleTicks++; await sleep(Math.min(10000, 1000 * idleTicks)); continue; }
    idleTicks = 0;
    const { jobId, taskId, task, manifestFile } = lease;
    const manifest = MANIFEST_OVERRIDE || path.join(MANIFESTS_DIR, manifestFile);
    console.log(`[agent] leased ${taskId}: z${task.zoom} ${task.tx}/${task.ty} (${task.modes.join(',')}) manifest=${manifestFile} timeoutMs=${agentTimeoutMsForZoom(task.zoom)} startedAt=${new Date().toISOString()}`);
    const tileOut = path.join(WORK_DIR, taskId);
    try {
      // render-remote-tile.js spawns each pipeline stage as its own node
      // process, and those in turn spawn further stages (build-topographic-
      // preview.js -> build-vector-model-cache.js -> extract-model-
      // footprint.js, etc.) - a plain "-r" on this one command wouldn't
      // reach any of them. NODE_OPTIONS is inherited by every spawned
      // child's environment by default, so setting --require here activates
      // the shim through the entire nested spawn tree with no changes
      // needed to any of the pipeline scripts' own spawn calls.
      const shimPath = path.join(__dirname, 'mapdraw', 'remote-asset-shim.js');
      const env = {
        ...process.env,
        ASSET_SERVER_URL: COORDINATOR, REMOTE_ASSET_ROOT: ASSET_ROOT, ASSET_CACHE_DIR: CACHE_DIR,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(shimPath)}`.trim(),
      };
      // Without a timeout, a single pathological tile can hang this call
      // forever - the coordinator's lease still expires and reassigns the
      // task to another worker eventually, but this worker's slot would
      // stay permanently stuck rather than recovering to pick up other
      // work. Low-zoom tiles cover far more area (4x per zoom level down)
      // and can legitimately take several minutes on a dense map, so this
      // must scale with zoom - a flat timeout tuned for fast high-zoom
      // tiles was killing genuinely-slow low-zoom renders and marking them
      // "broken" after repeated false-timeout failures. Mirrors (and stays
      // a minute under) the coordinator's poolLeaseMsForZoom in server.js,
      // so this worker self-recovers before the coordinator would reassign.
      const result = await runRenderWithTimeout([
        path.join(__dirname, 'mapdraw', 'render-remote-tile.js'),
        '--manifest', manifest, '--zoom', String(task.zoom), '--tx', String(task.tx), '--ty', String(task.ty),
        '--modes', task.modes.join(','), '--out', tileOut,
      ], env, agentTimeoutMsForZoom(task.zoom));
      if (result.signal) throw new Error(`render timed out or was killed (signal ${result.signal})`);
      if (result.status !== 0) {
        const full = result.stderr || result.stdout || 'render failed';
        try {
          const errLog = path.join(WORK_DIR, 'last-error.log');
          fs.mkdirSync(WORK_DIR, { recursive: true });
          fs.writeFileSync(errLog, `taskId=${taskId} at ${new Date().toISOString()}\n\n${full}`);
        } catch { /* best-effort diagnostic only */ }
        throw new Error(full.slice(-2000));
      }
      const resultLine = (result.stdout || '').split(/\r?\n/).find(line => line.startsWith('@@REMOTE_TILE_RESULT '));
      const produced = resultLine ? JSON.parse(resultLine.slice(21)).produced : [];
      for (const file of produced) submitFile(jobId, taskId, workerId, file.replace(/\.(png|pbf)$/, ''), path.join(tileOut, file));
      curlJson('POST', `/api/render-pool/jobs/${jobId}/complete?workerId=${workerId}&taskId=${taskId}`);
      console.log(`[agent] completed ${taskId}`);
    } catch (error) {
      console.error(`[agent] task ${taskId} failed at ${new Date().toISOString()}: ${error.message}`);
      try { curlJson('POST', `/api/render-pool/jobs/${jobId}/fail?workerId=${workerId}&taskId=${taskId}`); } catch {}
    } finally {
      fs.rmSync(tileOut, { recursive: true, force: true });
    }
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
