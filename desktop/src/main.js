// Stefflix desktop app: runs the media server in the background with an icon in the tray,
// so it starts like any other program (and optionally with Windows) - no terminal needed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, shell } from 'electron';
import { HIDDEN_ARG, isAutostartEnabled, setAutostart } from './autostart.js';
import { checkFfprobe, findFfprobe, folderStatus, testTmdbKey } from './checks.js';
import { importServerFolderData, setUpDataDirs } from './dataDir.js';
import { bg, format } from './i18n/bg.js';
import { ServerProcess } from './serverProcess.js';
import {
  DEFAULT_SETTINGS,
  MEDIA_TYPES,
  loadSettings,
  normalizeSettings,
  saveSettings,
  settingsToEnv,
} from './settings.js';
import { APP_USER_MODEL_ID, createShortcuts } from './shortcut.js';
import { createTray } from './tray.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Development (`npm run desktop`): the server folder of the project, with its .env and data.
// Installed: none - the server is bundled into resources/server (scripts/build-server.mjs).
const projectServerDir = app.isPackaged ? null : path.resolve(appDir, '..', 'server');
const serverEntry = app.isPackaged
  ? path.join(process.resourcesPath, 'server', 'server.mjs')
  : path.join(projectServerDir, 'src', 'index.js');
const assets = path.join(appDir, 'assets');
// What the server streams (server/src/utils/mime.js).
const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'm4v', 'webm', 'mov', 'avi'];

app.setAppUserModelId(APP_USER_MODEL_ID);
const { dataDir, settingsFile, logFile } = setUpDataDirs();

// Pages the settings screen links to (the window can't open arbitrary addresses).
const LINKS = {
  tmdb: 'https://www.themoviedb.org/settings/api',
  opensubtitles: 'https://www.opensubtitles.com/consumers',
};

if (process.argv.includes('--create-shortcut')) {
  app.whenReady().then(createShortcutsAndQuit);
} else if (!app.requestSingleInstanceLock()) {
  // Already running: the first instance shows its window (see 'second-instance').
  app.quit();
} else {
  run();
}

function run() {
  const startupLog = [];
  let settings;
  try {
    settings = loadSettings(settingsFile, projectServerDir && path.join(projectServerDir, '.env'));
  } catch (err) {
    startupLog.push(`Could not read ${settingsFile}: ${err.message} - using the defaults`);
    settings = DEFAULT_SETTINGS;
  }

  const server = new ServerProcess({
    entry: serverEntry,
    getEnv: () => ({ ...settingsToEnv(settings), DATA_DIR: dataDir, DESKTOP_APP: '1' }),
    logFile,
  });
  let tray = null;
  let window = null;
  let quitting = false;

  /** What the tray and the window show. */
  function view() {
    const { status, port, addresses } = server.state;
    const lanAddress = (address) => `${address}:${port}`;
    return {
      status,
      tvAddress: status === 'running' && addresses.length ? lanAddress(addresses[0].address) : null,
      otherAddresses: status === 'running' ? addresses.slice(1).map((a) => ({ name: a.name, address: lanAddress(a.address) })) : [],
      autostart: isAutostartEnabled(),
      hasFolders: MEDIA_TYPES.some((type) => settings.folders[type].length > 0),
      // For the posters in the "Библиотека" tab.
      serverUrl: status === 'running' ? `http://127.0.0.1:${port}` : null,
    };
  }

  function allFolders(current) {
    return MEDIA_TYPES.flatMap((type) => current.folders[type]);
  }

  /** Saves the settings from the window; the server restarts only when something it uses changed. */
  async function saveFromWindow(draft) {
    const { settings: next, errors } = normalizeSettings(draft);
    if (errors.length) return { ok: false, errors };

    saveSettings(settingsFile, next);
    const changed = JSON.stringify(settingsToEnv(next)) !== JSON.stringify(settingsToEnv(settings));
    settings = next;
    if (changed) await server.restart();
    refresh();
    return { ok: true, restarted: changed, settings, folderStatus: folderStatus(allFolders(settings)) };
  }

  async function pickFolders(event) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      properties: ['openDirectory', 'multiSelections'],
    });
    if (result.canceled) return { folders: [], folderStatus: {} };
    return { folders: result.filePaths, folderStatus: folderStatus(result.filePaths) };
  }

  /** Files or folders to import ("Добави" tab). */
  async function pickImport(event, what) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      properties: what === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters: what === 'folder' ? [] : [{ name: bg.importDialogFilter, extensions: VIDEO_EXTENSIONS }],
    });
    return result.canceled ? [] : result.filePaths;
  }

  async function pickFfprobe(event) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      properties: ['openFile'],
      filters: [{ name: 'ffprobe', extensions: ['exe'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  }

  function refresh() {
    const current = view();
    tray?.update(current);
    window?.webContents.send('view', current);
  }

  function showWindow() {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    window = new BrowserWindow({
      width: 880,
      height: 700,
      minWidth: 640,
      minHeight: 520,
      title: bg.appName,
      icon: path.join(assets, 'icon.png'),
      backgroundColor: '#141414',
      show: false,
      webPreferences: {
        preload: path.join(appDir, 'src', 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window.loadFile(path.join(appDir, 'src', 'ui', 'index.html'));
    window.once('ready-to-show', () => window.show());
    // The window only shows our own page.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    // Closing destroys the window (it's cheap to recreate); the server keeps running in the tray.
    window.on('closed', () => {
      window = null;
    });
  }

  function copyAddress() {
    const { tvAddress } = view();
    if (tvAddress) clipboard.writeText(tvAddress);
  }

  /**
   * A request to the server's API, made here rather than in the window: the /api/admin
   * routes only answer requests without an Origin header (see server/src/routes/admin.js).
   * Resolves { ok, status, body }; status 0 means the server isn't reachable.
   */
  async function serverRequest(method, apiPath, body) {
    const { status, port } = server.state;
    if (status !== 'running' || !/^\/api\//.test(apiPath) || !['GET', 'POST', 'PUT'].includes(method)) {
      return { ok: false, status: 0, body: null };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return { ok: false, status: 0, body: null };
    }
  }

  async function scan() {
    return (await serverRequest('POST', '/api/library/scan')).ok;
  }

  /** Opens Explorer with the file selected - only for files inside the media folders. */
  function showFile(filePath) {
    const file = path.resolve(String(filePath || '')).toLowerCase();
    const inLibrary = allFolders(settings).some((folder) => {
      const root = path.resolve(folder).toLowerCase();
      return file.startsWith(root.endsWith(path.sep) ? root : root + path.sep); // "D:\" already ends in one
    });
    if (inLibrary) shell.showItemInFolder(path.resolve(filePath));
    return inLibrary;
  }

  function toggleAutostart(enabled) {
    setAutostart(enabled);
    refresh();
  }

  function quit() {
    app.quit();
  }

  app.on('second-instance', showWindow);
  // No window doesn't mean "quit" - the app lives in the tray.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    server.stop().finally(() => app.quit());
  });

  ipcMain.handle('init', () => ({ strings: bg, view: view(), logs: server.getLogs() }));
  ipcMain.handle('copy-address', copyAddress);
  ipcMain.handle('scan', scan);
  ipcMain.handle('restart', () => server.restart());
  ipcMain.handle('open-data-dir', () => shell.openPath(dataDir));
  ipcMain.handle('open-log-file', () => shell.openPath(logFile));
  ipcMain.handle('set-autostart', (event, enabled) => toggleAutostart(enabled));

  ipcMain.handle('get-settings', () => ({ settings, folderStatus: folderStatus(allFolders(settings)) }));
  ipcMain.handle('save-settings', (event, draft) => saveFromWindow(draft));
  ipcMain.handle('pick-folders', pickFolders);
  ipcMain.handle('pick-ffprobe', pickFfprobe);
  ipcMain.handle('find-ffprobe', () => findFfprobe());
  ipcMain.handle('check-ffprobe', (event, ffprobePath) => checkFfprobe(String(ffprobePath || '')));
  ipcMain.handle('test-tmdb', (event, key) => testTmdbKey(String(key || '').trim()));
  ipcMain.handle('open-link', (event, name) => LINKS[name] && shell.openExternal(LINKS[name]));

  ipcMain.handle('server-request', (event, method, apiPath, body) => serverRequest(method, String(apiPath), body));
  ipcMain.handle('show-file', (event, filePath) => showFile(filePath));
  ipcMain.handle('pick-import', pickImport);

  server.on('state', refresh);
  server.on('log', (lines) => window?.webContents.send('log', lines));

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    tray = createTray(path.join(assets, 'tray.png'), {
      open: showWindow,
      copyAddress,
      scan,
      restart: () => server.restart(),
      setAutostart: toggleAutostart,
      quit,
    });
    refresh();

    server.appendLog(startupLog);
    if (projectServerDir) {
      try {
        server.appendLog(await importServerFolderData(projectServerDir, dataDir));
      } catch (err) {
        server.appendLog([`Could not copy the library from ${projectServerDir}: ${err.message}`]);
      }
    }
    server.start();

    // Started with Windows: stay in the tray. Started by the user: show the window.
    if (!process.argv.includes(HIDDEN_ARG)) showWindow();
  });
}

function createShortcutsAndQuit() {
  try {
    createShortcuts({ iconPng: path.join(assets, 'icon.png'), dataDir });
    dialog.showMessageBoxSync({ type: 'info', title: bg.appName, message: bg.dialogs.shortcutCreated });
  } catch (err) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: bg.appName,
      message: format(bg.dialogs.shortcutFailed, { error: err.message }),
    });
  }
  app.quit();
}
