#!/usr/bin/env node
/**
 * Dev loop for the desktop shell: `npm run dev:desktop`.
 *
 * `npm run desktop` is the production path — it builds everything and runs the
 * result, so every edit costs a full rebuild and a relaunch. This is the other
 * one. Three processes, split by what each half of the app needs:
 *
 *   vite      serves the renderer at :4318 with HMR, proxying /api to the port
 *             the real config says the server listens on
 *   tsc -w    recompiles the main process and the server into dist/ on save
 *   electron  loads :4318 instead of its own bundle (TRAICKER_DEV_URL), and is
 *             restarted here whenever tsc writes new non-renderer output
 *
 * So a .tsx/.css change lands in the open window without a reload, and a change
 * under src/server or src/desktop relaunches the shell by itself. The database
 * and the API are the same ones the packaged app uses — this only changes where
 * the HTML comes from.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITE_PORT = 4318;
const DEV_URL = `http://localhost:${VITE_PORT}`;

/** npm ships .cmd shims on Windows; spawn without a shell needs the real name. */
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const children = new Set();

function run(command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

/**
 * Read the port out of the user's own config rather than assuming the default:
 * a custom `serverPort` would otherwise leave Vite proxying /api into nothing,
 * which looks like every request failing for no reason.
 */
function apiPort() {
  return new Promise((resolve) => {
    const child = spawn(
      npx,
      ['tsx', '-e', "import('./src/core/config.ts').then(m => console.log(m.loadConfig().serverPort));"],
      { cwd: root, shell: process.platform === 'win32' },
    );
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('exit', () => {
      const port = Number.parseInt(out.trim().split(/\s+/).pop() ?? '', 10);
      resolve(Number.isFinite(port) ? port : 4317);
    });
    child.on('error', () => resolve(4317));
  });
}

/** Electron loading the dev server before Vite answers gets a blank window. */
async function waitForVite() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(DEV_URL, { method: 'HEAD' });
      if (response.ok || response.status === 404) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.warn('Vite did not answer in 20s — starting Electron anyway.');
}

/**
 * Killing the tree matters on Windows: `electron .` runs behind a shim, and
 * killing only that leaves the real Electron holding the server port, which the
 * next launch then reports as "already in use" and attaches to a dead process.
 */
function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  });
}

const port = await apiPort();
console.log(`trAIcker dev: renderer on ${DEV_URL}, API proxied to :${port}`);

run(npx, ['vite', '--port', String(VITE_PORT), '--strictPort'], { TRAICKER_API_PORT: String(port) });
run(npx, ['tsc', '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput']);

/** First run after a clean checkout: dist/ only appears once tsc has written it. */
async function waitForMain() {
  const main = path.join(root, 'dist', 'desktop', 'main.js');
  for (let attempt = 0; attempt < 300 && !existsSync(main); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

await Promise.all([waitForVite(), waitForMain()]);
mkdirSync(path.join(root, 'dist'), { recursive: true });

let electron = null;
let restarting = false;
let missed = false;

async function launch() {
  const startedAt = Date.now();
  electron = run(npx, ['electron', '.'], { TRAICKER_DEV_URL: DEV_URL });
  // Electron's single-instance lock makes a second launch quit without printing
  // anything, so a tray-resident trAIcker looks exactly like a broken script.
  electron.once('exit', () => {
    if (!restarting && Date.now() - startedAt < 3000) {
      console.warn('Electron exited at once — quit the trAIcker already in the tray, then rerun.');
    }
  });
}

async function restart() {
  // Serialised on purpose: the new process must not bind the server port until
  // the old one has released it, and Electron's single-instance lock would make
  // an overlapping launch quit immediately.
  if (restarting) {
    // A save landing mid-restart would otherwise be dropped: the launch already
    // under way started from the older dist/.
    missed = true;
    return;
  }
  restarting = true;
  console.log('main process changed — restarting Electron');
  if (electron) await stop(electron);
  await launch();
  restarting = false;
  if (missed) {
    missed = false;
    await restart();
  }
}

await launch();

// dist/web is Vite's own output and never triggers a relaunch; everything else
// under dist/ is code this Electron process actually loaded at startup.
let pending = null;
watch(path.join(root, 'dist'), { recursive: true }, (_event, file) => {
  const name = String(file ?? '').replace(/\\/g, '/');
  if (!name.endsWith('.js') || name.startsWith('web/')) return;
  clearTimeout(pending);
  pending = setTimeout(() => void restart(), 300);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void Promise.all([...children].map(stop)).then(() => process.exit(0));
  });
}
