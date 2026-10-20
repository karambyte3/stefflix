// The only bridge between the window (no Node.js access) and the main process.
// CommonJS, because sandboxed preload scripts can't be ES modules.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('stefflix', {
  /** { strings, view, logs } */
  init: () => ipcRenderer.invoke('init'),
  copyAddress: () => ipcRenderer.invoke('copy-address'),
  scan: () => ipcRenderer.invoke('scan'),
  restart: () => ipcRenderer.invoke('restart'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  openLogFile: () => ipcRenderer.invoke('open-log-file'),
  setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', Boolean(enabled)),

  /** { settings, folderStatus } */
  getSettings: () => ipcRenderer.invoke('get-settings'),
  /** { ok, errors } or { ok, restarted, settings, folderStatus } */
  saveSettings: (draft) => ipcRenderer.invoke('save-settings', draft),
  /** Windows folder dialog: { folders, folderStatus } */
  pickFolders: () => ipcRenderer.invoke('pick-folders'),
  pickFfprobe: () => ipcRenderer.invoke('pick-ffprobe'),
  findFfprobe: () => ipcRenderer.invoke('find-ffprobe'),
  checkFfprobe: (ffprobePath) => ipcRenderer.invoke('check-ffprobe', ffprobePath),
  /** 'ok' | 'invalid' | 'network' */
  testTmdb: (key) => ipcRenderer.invoke('test-tmdb', key),
  /** 'tmdb' | 'opensubtitles' */
  openLink: (name) => ipcRenderer.invoke('open-link', name),

  /** Server API call through the main process: resolves { ok, status, body } (status 0 = offline). */
  request: (method, apiPath, body) => ipcRenderer.invoke('server-request', method, apiPath, body),
  /** Explorer with the file selected (files inside the media folders only). */
  showFile: (filePath) => ipcRenderer.invoke('show-file', filePath),

  /** Full path of a file or folder dropped into the window. */
  pathOf: (file) => webUtils.getPathForFile(file),
  /** Windows dialog for importing: what = 'files' | 'folder'. Resolves [path, ...]. */
  pickImport: (what) => ipcRenderer.invoke('pick-import', what),

  onView: (callback) => ipcRenderer.on('view', (event, view) => callback(view)),
  onLog: (callback) => ipcRenderer.on('log', (event, lines) => callback(lines)),
});
