import { BrowserWindow, Menu, Tray, app, nativeImage, shell } from 'electron';
import type { NativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../core/env.js';
import { startServer, type RunningServer } from '../server/app.js';
import { sync } from '../sync.js';

/**
 * The desktop shell.
 *
 * It embeds the dashboard rather than talking to a separate one: the Express
 * app and the SQLite handle live in this process, so launching the app is the
 * whole setup — no `traicker serve` to remember, nothing to restart after a
 * reboot. The window is a view onto that server over http, exactly like a
 * browser tab, which is why the phone-over-Tailscale case keeps working
 * unchanged: it is the same process answering both.
 *
 * The CLI is untouched and still works standalone against the same database.
 * `busy_timeout` (see openDb) is what makes the overlap safe — a CLI `sync`
 * running while this app holds the database waits rather than failing.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root when running from dist/desktop, so packaged and dev agree. */
const appRoot = path.resolve(here, '..', '..');

/**
 * Fully transparent, which is what lets the window's backdrop material show
 * through: vibrancy on macOS, acrylic on Windows 11. The page paints its own
 * near-opaque background over it (see `.is-desktop body`), so this is not a
 * see-through window — and `show: false` until `ready-to-show` covers the gap
 * where an unpainted transparent window would otherwise be visible.
 */
const BACKGROUND = '#00000000';

/** Tint for the system-drawn window control glyphs — the dashboard's --muted. */
const CONTROL_SYMBOL = '#8b949e';

/**
 * Set by `npm run dev:desktop` to Vite's URL. When present the window loads the
 * dev server instead of the bundle the embedded Express serves, which is what
 * makes an edit to a .tsx file show up here without a rebuild — Vite's HMR
 * pushes it. The API still comes from this process: Vite proxies /api back to
 * `serverPort` (see vite.config.ts), so there is still only one server and one
 * database. Empty in a packaged app, where the variable is never set.
 */
const devUrl = process.env['TRAICKER_DEV_URL'];

let running: RunningServer | null = null;
/** What the window and the tray open — the dev server in dev, our own otherwise. */
let viewUrl = '';
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Set only by the tray's Quit item — a plain window close hides instead. */
let quitting = false;

/** The two images `tray.setImage()` swaps between; built once in `buildTray`. */
let idleTrayImage: NativeImage | null = null;
let activeTrayImage: NativeImage | null = null;
let trayPollTimer: ReturnType<typeof setInterval> | null = null;

/** How often the tray checks whether anything is currently being tracked. */
const TRAY_POLL_MS = 60_000;
/** Tray icons are small; captured larger so the down-resize stays clean. */
const TRAY_CAPTURE_SIZE = 256;
/** Same green the dashboard uses for "billable" (styles.css --billable). */
const TRAY_DOT_COLOR = '#3fb950';
/** Dashboard panel background, doubling as a ring so the dot reads against
 *  both light and dark tray backgrounds instead of blending into either. */
const TRAY_RING_COLOR = '#0d1117';

function iconPath(): string {
  return path.join(appRoot, 'public', 'logo.png');
}

/**
 * Composites a status dot onto the tray icon by rendering HTML through this
 * process's own Chromium, rather than hand-rolling pixel math against
 * `nativeImage`'s raw bitmap buffer — its format is undocumented and
 * platform-dependent (Electron's own docs: "the specific format is
 * platform-dependent"), so guessing at it would risk a wrong-channel-order
 * icon on macOS while looking fine here. `capturePage()` on an offscreen
 * window sidesteps that with no new dependency.
 */
async function buildActiveTrayImage(): Promise<NativeImage> {
  // Inlined as a data URI rather than a `file://` src: Electron blocks
  // local-file subresource loads from a `data:` document, which silently
  // dropped the dog and left only the dot (its own inline CSS, no fetch)
  // painted on a transparent background.
  const logoUrl = `data:image/png;base64,${fs.readFileSync(iconPath()).toString('base64')}`;
  const dot = (radius: number, color: string, inset: number): string => {
    const d = radius * 2;
    return `position:absolute;right:${inset}px;bottom:${inset}px;width:${d}px;height:${d}px;border-radius:50%;background:${color};`;
  };
  const html = `<!doctype html><html><body style="margin:0;width:${TRAY_CAPTURE_SIZE}px;height:${TRAY_CAPTURE_SIZE}px;position:relative;background:transparent;">
    <img src="${logoUrl}" style="width:${TRAY_CAPTURE_SIZE}px;height:${TRAY_CAPTURE_SIZE}px;display:block;">
    <div style="${dot(48, TRAY_RING_COLOR, 18)}"></div>
    <div style="${dot(40, TRAY_DOT_COLOR, 26)}"></div>
  </body></html>`;

  const win = new BrowserWindow({
    width: TRAY_CAPTURE_SIZE,
    height: TRAY_CAPTURE_SIZE,
    show: false,
    frame: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  try {
    await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    // Offscreen rendering paints asynchronously; give the image a moment to
    // decode and the layout to settle before grabbing a frame.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return await win.webContents.capturePage();
  } finally {
    win.destroy();
  }
}

/**
 * A crashed session's span can stay labelled `open` forever once its
 * liveness evidence stops advancing (see `subagentCeiling` /
 * `livenessCeiling` in aggregate/agent.ts): its `end_utc` freezes in the
 * past rather than reclassifying. `open` alone would make the dot latch on
 * from a session that died days ago, so this also requires the span to still
 * be reaching toward the present.
 */
const TRAY_ACTIVE_WINDOW_MS = 3 * 60_000;

/** Whether any focus or agent span is still genuinely running right now. */
function isTrackingNow(db: RunningServer['db']): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM spans
       WHERE bucket IN ('focus', 'agent') AND truncated_by = 'open' AND end_utc >= ?
       LIMIT 1`,
    )
    .get(new Date(Date.now() - TRAY_ACTIVE_WINDOW_MS).toISOString());
  return row !== undefined;
}

async function pollTrayState(): Promise<void> {
  if (!tray || !running || !idleTrayImage || !activeTrayImage) return;
  try {
    sync(running.db, running.config);
  } catch {
    // A background poll failing must not crash the tray or spam the user;
    // the dashboard's own refresh surfaces real sync problems on its own terms.
  }
  tray.setImage(isTrackingNow(running.db) ? activeTrayImage : idleTrayImage);
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: BACKGROUND,
    icon: iconPath(),
    // The Apple-side of the look. On macOS `hiddenInset` keeps the real
    // traffic lights but drops the title bar, so the content runs to the top
    // edge; on Windows `titleBarOverlay` gets the same edge-to-edge content
    // with system-drawn controls tinted to match. Both are native chrome
    // rather than buttons we draw, so there is no IPC and no preload script to
    // keep secure — the renderer stays a plain web page.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const, trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: { color: BACKGROUND, symbolColor: CONTROL_SYMBOL, height: 40 }, backgroundMaterial: 'acrylic' as const }),
    webPreferences: {
      // Nothing here needs Node: the renderer is the same bundle the browser
      // gets, and it reaches the database only through /api.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  void win.loadURL(url);

  // Dev only, and detached so it does not fight the layout for the window we
  // are usually here to look at.
  if (devUrl) win.webContents.openDevTools({ mode: 'detach' });

  // Paint once, not twice — `show: false` plus this is what avoids the white
  // flash that an immediately-shown window gives while the SPA boots.
  win.once('ready-to-show', () => win.show());

  // A tray app's close button means "get out of my way", not "stop tracking".
  // Quitting on close would silently take the dashboard down with it.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    window = null;
  });

  // Anything not on our own origin belongs in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  return win;
}

function showWindow(url: string): void {
  if (!window) {
    window = createWindow(url);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function buildTray(url: string): Promise<void> {
  // Resized here because the source is a single large PNG; a tray icon has to
  // be small and, on macOS, template-rendered to follow the menu bar theme.
  idleTrayImage = nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 });
  // Built from the live app's own renderer rather than a checked-in asset, so
  // it never drifts from public/logo.png. See buildActiveTrayImage for why.
  activeTrayImage = (await buildActiveTrayImage()).resize({ width: 18, height: 18 });

  tray = new Tray(idleTrayImage);
  tray.setToolTip('trAIcker');

  const refreshMenu = (): void => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open trAIcker', click: () => showWindow(url) },
        { type: 'separator' },
        { label: running ? `Serving on port ${running.port}` : 'Server not running', enabled: false },
        {
          label: 'Start at login',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
            refreshMenu();
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  };

  refreshMenu();
  tray.on('click', () => showWindow(url));

  // Reflects live tracking state even while the window is hidden, which is
  // most of the time for a tray app. Cleared before re-created so the
  // EADDRINUSE retry path (buildTray called a second time) never doubles up.
  if (trayPollTimer) clearInterval(trayPollTimer);
  trayPollTimer = setInterval(() => void pollTrayState(), TRAY_POLL_MS);
  void pollTrayState();
}

function start(): void {
  loadEnvFile();

  const started = startServer();
  running = started;
  const url = `http://localhost:${started.port}`;
  viewUrl = devUrl ?? url;

  started.server.on('listening', () => {
    showWindow(viewUrl);
    void buildTray(viewUrl);
  });

  started.server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      // Almost always the user's own `traicker serve` from a terminal. That
      // server answers the same routes off the same database, so showing it
      // beats refusing to launch — unlike the CLI, which must complain,
      // because there the whole point of the command was to be that server.
      console.warn(`Port ${started.port} already in use — attaching to the server already there.`);
      running = null;
      started.db.close();
      showWindow(viewUrl);
      void buildTray(viewUrl);
      return;
    }
    console.error(`Could not start the embedded server: ${error.message}`);
    app.exit(1);
  });
}

// A second launch should surface the window that already exists rather than
// start a second server against the same database file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (viewUrl) showWindow(viewUrl);
  });

  void app.whenReady().then(start);

  // The tray is the app's real lifetime, so an empty screen is not the end of
  // it — on every platform, closing the last window leaves it running.
  app.on('window-all-closed', () => {
    /* deliberately empty: the tray keeps the app alive */
  });

  app.on('activate', () => {
    if (viewUrl) showWindow(viewUrl);
  });

  app.on('before-quit', () => {
    quitting = true;
    if (trayPollTimer) clearInterval(trayPollTimer);
    running?.server.close();
    running?.db.close();
  });
}
