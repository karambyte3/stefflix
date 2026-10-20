// "Start with Windows": a Run entry in the registry (HKCU), set through Electron.
// The app then starts hidden in the tray (--hidden).
import { app } from 'electron';

export const HIDDEN_ARG = '--hidden';

// Windows matches the entry by executable and arguments, so reading and writing must use the same ones.
// During development the executable is electron.exe, which needs the app folder as its first argument.
function loginItem() {
  const args = app.isPackaged ? [] : [app.getAppPath()];
  return { path: process.execPath, args: [...args, HIDDEN_ARG] };
}

export function isAutostartEnabled() {
  return app.getLoginItemSettings(loginItem()).openAtLogin;
}

export function setAutostart(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItem() });
}
