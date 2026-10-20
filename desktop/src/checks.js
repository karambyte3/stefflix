// Checks behind the buttons of the settings screen: folders, ffprobe and the TMDB key.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

/** { [folder]: true | false } - whether each folder exists (an unplugged drive doesn't). */
export function folderStatus(folders) {
  const status = {};
  for (const folder of folders) {
    try {
      status[folder] = fs.statSync(folder).isDirectory();
    } catch {
      status[folder] = false;
    }
  }
  return status;
}

/** Runs `ffprobe -version`. Resolves { ok: true, version } or { ok: false }. */
export function checkFfprobe(ffprobePath) {
  return new Promise((resolve) => {
    execFile(ffprobePath || 'ffprobe', ['-version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      const version = /ffprobe version (\S+)/.exec(stdout)?.[1] || '';
      resolve({ ok: true, version });
    });
  });
}

/** Full path of ffprobe.exe on PATH (e.g. installed with `winget install Gyan.FFmpeg`), or null. */
export function findFfprobe() {
  return new Promise((resolve) => {
    execFile('where.exe', ['ffprobe'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.split(/\r?\n/).find((line) => /\.exe$/i.test(line.trim()))?.trim() || null);
    });
  });
}

/**
 * Tries the TMDB key. Same rule as the server: a long v4 "Read Access Token" goes in a
 * Bearer header, a v3 API key in ?api_key=. Resolves 'ok' | 'invalid' | 'network'.
 */
export async function testTmdbKey(key) {
  const url = new URL('https://api.themoviedb.org/3/configuration');
  const headers = {};
  if (key.length > 40) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (res.ok) return 'ok';
    return res.status === 401 ? 'invalid' : 'network';
  } catch {
    return 'network';
  }
}
