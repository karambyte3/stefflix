// The server settings of the desktop app, kept in %APPDATA%\Stefflix\config.json and edited in
// the window. They reach the server as the same environment variables server/.env sets.
// No Electron imports here, so this file can be tested with plain `node --test`.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export const MEDIA_TYPES = ['movies', 'series', 'videos'];

export const DEFAULT_SETTINGS = {
  port: 3000,
  folders: { movies: [], series: [], videos: [] },
  tmdbApiKey: '',
  // Empty: ffprobe/ffmpeg are looked up on PATH.
  ffprobePath: '',
  watchFolders: true,
  // Prepare the seek preview thumbnails for the whole library (not only when a file is opened).
  storyboardsForAll: false,
  openSubtitles: { apiKey: '', username: '', password: '' },
};

const FALSE = /^(0|false|no|off)$/i;

/**
 * Reads config.json. On the first start there is none: the settings are taken over from
 * server/.env (what `npm run server` used), so nothing has to be entered again.
 * `envFile` is null for the installed app (no project folder): it starts with the defaults.
 */
export function loadSettings(file, envFile) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8'))).settings;
  } catch (err) {
    // A broken file (edited by hand?) is kept aside and the settings start over.
    if (err instanceof SyntaxError) fs.renameSync(file, file.replace(/\.json$/, '.broken.json'));
    else if (err.code !== 'ENOENT') throw err;
  }
  const settings = envFile && fs.existsSync(envFile) ? settingsFromEnv(dotenv.parse(fs.readFileSync(envFile))) : DEFAULT_SETTINGS;
  saveSettings(file, settings);
  return settings;
}

/** Writes config.json (through a temporary file, so a crash never leaves half a file). */
export function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

/** Maps the variables of a server/.env file to settings. */
export function settingsFromEnv(env) {
  const list = (value) => (value || '').split(';').map((p) => p.trim()).filter(Boolean);
  return normalizeSettings({
    port: env.PORT,
    folders: { movies: list(env.MEDIA_MOVIES), series: list(env.MEDIA_SERIES), videos: list(env.MEDIA_VIDEOS) },
    tmdbApiKey: env.TMDB_API_KEY,
    ffprobePath: env.FFPROBE_PATH,
    watchFolders: !FALSE.test((env.WATCH_FOLDERS || '').trim()),
    storyboardsForAll: /^all$/i.test((env.STORYBOARDS || '').trim()),
    openSubtitles: {
      apiKey: env.OPENSUBTITLES_API_KEY,
      username: env.OPENSUBTITLES_USERNAME,
      password: env.OPENSUBTITLES_PASSWORD,
    },
  }).settings;
}

/** The environment variables the server reads (see server/src/config.js). */
export function settingsToEnv(settings) {
  return {
    PORT: String(settings.port),
    MEDIA_MOVIES: settings.folders.movies.join(';'),
    MEDIA_SERIES: settings.folders.series.join(';'),
    MEDIA_VIDEOS: settings.folders.videos.join(';'),
    TMDB_API_KEY: settings.tmdbApiKey,
    FFPROBE_PATH: settings.ffprobePath,
    WATCH_FOLDERS: String(settings.watchFolders),
    STORYBOARDS: settings.storyboardsForAll ? 'all' : '',
    OPENSUBTITLES_API_KEY: settings.openSubtitles.apiKey,
    OPENSUBTITLES_USERNAME: settings.openSubtitles.username,
    OPENSUBTITLES_PASSWORD: settings.openSubtitles.password,
  };
}

/** "D:/Media/Movies/" -> "D:\Media\Movies"; a drive root keeps its slash ("D:" alone means another folder). */
function cleanFolder(folder) {
  const normalized = path.normalize(folder);
  return /^[a-z]:[\\/]$/i.test(normalized) ? normalized : normalized.replace(/[\\/]+$/, '');
}

/**
 * Cleans up settings coming from the window or a file: fills in defaults, trims text,
 * removes duplicate folders. Returns { settings, errors } - errors are keys like 'port'.
 */
export function normalizeSettings(input = {}) {
  const errors = [];
  const text = (value) => (typeof value === 'string' ? value.trim() : '');

  let port = DEFAULT_SETTINGS.port;
  if (input.port !== undefined && input.port !== '') {
    port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push('port');
      port = DEFAULT_SETTINGS.port;
    }
  }

  const folders = {};
  for (const type of MEDIA_TYPES) {
    const seen = new Set();
    folders[type] = [];
    const given = input.folders?.[type];
    for (const folder of Array.isArray(given) ? given : []) {
      const clean = text(folder) && cleanFolder(text(folder));
      if (!clean || seen.has(clean.toLowerCase())) continue; // Windows paths ignore case
      seen.add(clean.toLowerCase());
      folders[type].push(clean);
    }
  }

  const os = input.openSubtitles || {};
  return {
    errors,
    settings: {
      port,
      folders,
      tmdbApiKey: text(input.tmdbApiKey),
      ffprobePath: text(input.ffprobePath),
      watchFolders: input.watchFolders !== false,
      storyboardsForAll: input.storyboardsForAll === true,
      // The password is kept as typed - spaces can be part of it.
      openSubtitles: { apiKey: text(os.apiKey), username: text(os.username), password: os.password || '' },
    },
  };
}
