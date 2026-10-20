// The desktop app keeps the server's database and caches in %APPDATA%\Stefflix
// (an installed program can't write into its own folder). Chromium's own files go to a
// sub folder, so they don't mix with ours:
//
//   %APPDATA%\Stefflix\config.json            settings from the window (settings.js)
//   %APPDATA%\Stefflix\data\homestream.db
//   %APPDATA%\Stefflix\cache\images | subtitles | storyboards
//   %APPDATA%\Stefflix\logs\server.log
//   %APPDATA%\Stefflix\electron\...
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** Must run before the app is ready. Returns the folders the app uses. */
export function setUpDataDirs() {
  const dataDir = app.getPath('userData');
  app.setPath('sessionData', path.join(dataDir, 'electron'));
  return {
    dataDir,
    settingsFile: path.join(dataDir, 'config.json'),
    logFile: path.join(dataDir, 'logs', 'server.log'),
  };
}

/**
 * First start of the desktop app: takes over the library of `npm run server`
 * (server/data and server/cache), so watch progress, TMDB matches and images aren't lost.
 * Returns log lines describing what was copied.
 */
export async function importServerFolderData(serverDir, dataDir) {
  const oldDb = path.join(serverDir, 'data', 'homestream.db');
  const newDb = path.join(dataDir, 'data', 'homestream.db');
  if (fs.existsSync(newDb) || !fs.existsSync(oldDb)) return [];

  const lines = [];
  fs.mkdirSync(path.dirname(newDb), { recursive: true });

  // SQLite's backup makes a consistent copy even if the old server is still running
  // (copying the .db/.db-wal files by hand could catch it in the middle of a write).
  // Copied under a temporary name first, so an interrupted copy isn't mistaken for a library.
  // (Loaded only here: the installed app never runs this, so it doesn't ship better-sqlite3.)
  const { default: Database } = await import('better-sqlite3');
  const source = new Database(oldDb, { readonly: true });
  try {
    await source.backup(`${newDb}.importing`);
  } finally {
    source.close();
  }
  fs.renameSync(`${newDb}.importing`, newDb);
  lines.push(`Copied the library database from ${oldDb}`);

  const oldCache = path.join(serverDir, 'cache');
  if (fs.existsSync(oldCache)) {
    fs.cpSync(oldCache, path.join(dataDir, 'cache'), { recursive: true, force: false });
    lines.push(`Copied the image and subtitle cache from ${oldCache}`);
  }
  return lines;
}
