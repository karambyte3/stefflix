import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The desktop app (desktop/) passes every setting itself, from the settings in its window.
if (process.env.DESKTOP_APP !== '1') {
  dotenv.config({ path: path.join(serverRoot, '.env'), quiet: true });
}

// Resolves to the real on-disk casing on Windows ("d:/movies" -> "D:\Movies"),
// so a change in how the path is typed in .env doesn't create duplicate library entries.
function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function splitPaths(value) {
  if (!value) return [];
  return value
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => realPath(path.resolve(p)));
}

// ffmpeg usually sits next to ffprobe, so FFPROBE_PATH alone is enough.
function ffmpegNextTo(ffprobePath) {
  if (!/[\\/]/.test(ffprobePath)) return 'ffmpeg';
  return path.join(path.dirname(ffprobePath), /\.exe$/i.test(ffprobePath) ? 'ffmpeg.exe' : 'ffmpeg');
}

const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

// Where the database and the caches live. The desktop app points this to %APPDATA%\Stefflix,
// because an installed program can't write next to its own code.
const dataRoot = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : serverRoot;

export const config = {
  port: Number(process.env.PORT) || 3000,
  serverRoot,
  dataRoot,
  dbFile: process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataRoot, 'data', 'homestream.db'),

  mediaMovies: splitPaths(process.env.MEDIA_MOVIES),
  mediaSeries: splitPaths(process.env.MEDIA_SERIES),
  mediaVideos: splitPaths(process.env.MEDIA_VIDEOS),
  // Rescan automatically when files are added to or removed from the media folders.
  watchFolders: !/^(0|false|no|off)$/i.test((process.env.WATCH_FOLDERS || '').trim()),

  // Optional: full path to ffprobe.exe if it isn't on PATH.
  ffprobePath,
  // Optional: full path to ffmpeg.exe - used only to extract subtitles embedded in MKV/MP4 files.
  ffmpegPath: process.env.FFMPEG_PATH || ffmpegNextTo(ffprobePath),

  // TMDB: a v3 API key or a v4 "API Read Access Token" both work.
  tmdbApiKey: (process.env.TMDB_API_KEY || '').trim(),
  tmdbApiUrl: process.env.TMDB_API_URL || 'https://api.themoviedb.org/3',
  tmdbImageUrl: process.env.TMDB_IMAGE_URL || 'https://image.tmdb.org/t/p',
  imageCacheDir: process.env.IMAGE_CACHE_DIR
    ? path.resolve(process.env.IMAGE_CACHE_DIR)
    : path.join(dataRoot, 'cache', 'images'),

  // OpenSubtitles.com: searching and downloading subtitles from the TV. The API key comes from
  // https://www.opensubtitles.com/consumers; the account is optional, but raises the daily download limit.
  openSubtitlesApiKey: (process.env.OPENSUBTITLES_API_KEY || '').trim(),
  openSubtitlesUsername: (process.env.OPENSUBTITLES_USERNAME || '').trim(),
  openSubtitlesPassword: process.env.OPENSUBTITLES_PASSWORD || '',
  openSubtitlesUrl: process.env.OPENSUBTITLES_API_URL || 'https://api.opensubtitles.com/api/v1',
  // OpenSubtitles asks every app to identify itself with "<App name> v<version>".
  openSubtitlesUserAgent: process.env.OPENSUBTITLES_USER_AGENT || 'HomeStream v1.0',

  // Embedded subtitles extracted to .srt files.
  subtitleCacheDir: path.join(dataRoot, 'cache', 'subtitles'),

  // Thumbnail sheets for the seek preview in the player (needs ffmpeg). They are made when a file
  // is opened; STORYBOARDS=all also prepares the whole library in the background after a scan.
  storyboardCacheDir: path.join(dataRoot, 'cache', 'storyboards'),
  storyboardsForAll: /^all$/i.test((process.env.STORYBOARDS || '').trim()),
};
