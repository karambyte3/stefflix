// Imports video files into the library folders under the names the scanner expects
// (used by the desktop app's "Добави" tab):
//
//   Movies:  <movies root>/Title (2010)/Title (2010).mkv
//   Series:  <series root>/Show/Season 01/Show S01E02.mkv   (or the folder of a show already in the library)
//   Videos:  <videos root>/<category>/<file name>.mp4
//
// Subtitles next to a video (Movie.bg.srt, Subs/English.srt, ...) go along, renamed to match.
// Files are written as "<name>.part" first (the folder watcher ignores those) and renamed when complete.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { isVideoFile } from '../utils/mime.js';
import { startFreshScan } from './libraryScan.js';
import { searchTmdb, setMediaTmdbId, setSeriesTmdbId } from './metadata.js';
import { parseEpisode, parseMovie, parseSeasonFolder, parseTitleYear } from './parsers.js';
import { isSubtitleFile, matchSubtitle } from './subtitles.js';
import { isConfigured as tmdbConfigured } from './tmdb.js';

export const KINDS = ['movie', 'episode', 'video'];
const SUBTITLE_FOLDERS = ['subs', 'sub', 'subtitles', 'субтитри'];
const SAMPLE = /(^|[\s._-])sample([\s._-]|$)/i;
const SAMPLE_MAX_SIZE = 300 * 1024 * 1024;

export class ImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function importRoots() {
  return { movie: config.mediaMovies, episode: config.mediaSeries, video: config.mediaVideos };
}

// --- names ---------------------------------------------------------------------------

/** A title made safe for a Windows file name: "Mission: Impossible?" -> "Mission - Impossible". */
export function safeName(text) {
  return String(text || '')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[<>"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // Windows drops trailing dots and spaces
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Latin-script original titles are kept ("The Matrix"); others use the Bulgarian title. */
function nameFromMatch(match) {
  const original = match.originalTitle;
  return original && /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]+$/u.test(original) ? original : match.title;
}

// --- finding the files ---------------------------------------------------------------

async function listFolder(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Video files under the given files/folders. Returns [{ source, size, fromFolder }] and how many were ignored. */
async function gatherVideos(paths) {
  const videos = [];
  let ignored = 0;

  async function addFile(file, fromFolder) {
    if (!isVideoFile(file)) {
      if (!isSubtitleFile(file)) ignored++;
      return;
    }
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) return;
    if (SAMPLE.test(path.basename(file)) && stat.size < SAMPLE_MAX_SIZE) return;
    videos.push({ source: file, size: stat.size, fromFolder });
  }

  async function walk(dir) {
    for (const entry of await listFolder(dir)) {
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) await addFile(full, true);
    }
  }

  for (const input of paths) {
    const stat = await fs.promises.stat(input).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) await walk(input);
    else await addFile(input, false);
  }

  const seen = new Set();
  return { videos: videos.filter((v) => !seen.has(v.source) && seen.add(v.source)), ignored };
}

/** Subtitle files that belong to `video`, from its folder and a "Subs" folder next to it. */
async function subtitlesOf(video) {
  const folder = path.dirname(video);
  const entries = await listFolder(folder);
  // Samples don't count: "Subs/English.srt" next to "Movie.mkv" + "sample.mkv" still belongs to the movie.
  const videosHere = entries
    .filter((e) => e.isFile() && isVideoFile(e.name) && !SAMPLE.test(e.name))
    .map((e) => path.join(folder, e.name));
  const candidates = entries.filter((e) => e.isFile() && isSubtitleFile(e.name)).map((e) => path.join(folder, e.name));
  for (const entry of entries) {
    if (entry.isDirectory() && SUBTITLE_FOLDERS.includes(entry.name.toLocaleLowerCase())) {
      const sub = path.join(folder, entry.name);
      for (const e of await listFolder(sub)) if (e.isFile() && isSubtitleFile(e.name)) candidates.push(path.join(sub, e.name));
    }
  }

  const videosByFolder = new Map([[folder, videosHere]]);
  const result = [];
  for (const file of candidates) {
    const match = matchSubtitle(file, videosByFolder);
    if (match && match.videoPath === video) result.push({ source: file, language: match.language, tags: match.tags });
  }
  return result;
}

// --- planning --------------------------------------------------------------------------

/** What the file name says: kind, title, year, season and episode. */
export function guessFromName(source, fromFolder) {
  const ext = path.extname(source);
  const base = path.basename(source, ext);
  const parent = path.basename(path.dirname(source));
  const grandparent = path.basename(path.dirname(path.dirname(source)));

  const folderSeason = parseSeasonFolder(parent);
  const ep = parseEpisode(base, folderSeason);
  if (ep) {
    // The show: from the file name, else the folder ("Show/Season 1/S01E02.mkv").
    const showName = ep.showPart || (folderSeason != null ? grandparent : parent);
    const show = parseTitleYear(showName);
    return { kind: 'episode', title: show.title, year: show.year, season: ep.season, episode: ep.episode, category: null };
  }
  const movie = parseMovie(base, parent);
  return {
    kind: 'movie',
    title: movie.title,
    year: movie.year,
    season: null,
    episode: null,
    // Used if the file is switched to "video": the folder it came from becomes the category.
    category: fromFolder ? parent : null,
  };
}

async function suggestMatch(kind, title, year, cache) {
  if (!tmdbConfigured() || kind === 'video' || !title) return null;
  const key = `${kind}|${title.toLowerCase()}|${year || ''}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      searchTmdb(kind === 'episode' ? 'series' : 'movie', title, kind === 'movie' ? year : null)
        .then((results) => results[0] || null)
        .catch(() => null)
    );
  }
  return cache.get(key);
}

/**
 * Looks at dropped files/folders and proposes where each video goes.
 * Returns { items, ignored } - items are resolved (see resolveItem).
 */
export async function planImport(paths) {
  const { videos, ignored } = await gatherVideos(paths);
  const tmdbCache = new Map();

  const items = [];
  for (const [index, video] of videos.entries()) {
    const guess = guessFromName(video.source, video.fromFolder);
    const match = await suggestMatch(guess.kind, guess.title, guess.year, tmdbCache);
    const item = {
      id: index + 1,
      source: video.source,
      size: video.size,
      ...guess,
      root: null,
      match,
      subtitleSources: await subtitlesOf(video.source),
    };
    if (match) {
      item.title = nameFromMatch(match);
      if (guess.kind === 'movie') item.year = match.year || guess.year;
    }
    items.push(resolveItem(item));
  }
  return { items, ignored };
}

// --- target paths ------------------------------------------------------------------------

/** A show already in the library with this TMDB id or name: new episodes go into its folder. */
function existingShowFolder(title, tmdbId) {
  const db = getDb();
  const rows = db
    .prepare('SELECT folder_key FROM series WHERE (tmdb_id = ? AND ? IS NOT NULL) OR lower(title) = lower(?)')
    .all(tmdbId || null, tmdbId || null, title);
  for (const { folder_key: folder } of rows) {
    const root = path.dirname(folder);
    if (!path.basename(folder).startsWith('#') && config.mediaSeries.includes(root) && fs.existsSync(folder)) {
      return { root, folder: path.basename(folder) };
    }
  }
  return null;
}

/**
 * Works out the target path of an item from its (possibly edited) fields and checks it.
 * `error` (blocking): noRoot | noTitle | noEpisode. `exists`: the target is already there.
 */
export function resolveItem(input) {
  const roots = importRoots();
  const kind = KINDS.includes(input.kind) ? input.kind : 'movie';
  const item = {
    ...input,
    kind,
    title: String(input.title || '').trim(),
    year: Number(input.year) || null,
    season: input.season === '' || input.season == null ? null : Number(input.season),
    episode: input.episode === '' || input.episode == null ? null : Number(input.episode),
    category: String(input.category || '').trim() || null,
    target: null,
    existingShow: false,
    subtitles: [],
    exists: false,
    error: null,
  };
  const ext = path.extname(item.source).toLowerCase();
  const name = safeName(item.title);

  let root = roots[kind].includes(input.root) ? input.root : roots[kind][0];
  if (!root) item.error = 'noRoot';
  else if (!name) item.error = 'noTitle';
  else if (kind === 'episode' && !(Number.isInteger(item.season) && Number.isInteger(item.episode))) item.error = 'noEpisode';

  if (!item.error) {
    if (kind === 'movie') {
      const folder = item.year ? `${name} (${item.year})` : name;
      item.target = path.join(root, folder, folder + ext);
    } else if (kind === 'episode') {
      const existing = existingShowFolder(item.title, item.match && item.match.tmdbId);
      if (existing) {
        root = existing.root;
        item.existingShow = true;
      }
      const showFolder = existing ? existing.folder : name;
      const file = `${name} S${pad2(item.season)}E${pad2(item.episode)}${ext}`;
      item.target = path.join(root, showFolder, `Season ${pad2(item.season)}`, file);
    } else {
      const category = safeName(item.category);
      item.target = path.join(root, category, name + ext);
    }
    item.exists = fs.existsSync(item.target);
    item.subtitles = subtitleTargets(item.target, input.subtitleSources || []);
  }
  item.root = root || null;
  return item;
}

/** "Title (2010).bg.srt", "Title (2010).en.forced.srt"; a second one without a language gets ".2". */
function subtitleTargets(videoTarget, sources) {
  const base = videoTarget.slice(0, -path.extname(videoTarget).length);
  const used = new Set();
  return sources.map((sub) => {
    const suffix = [sub.language, ...(sub.tags || [])].filter(Boolean).map((t) => `.${t}`).join('');
    const ext = path.extname(sub.source).toLowerCase();
    let target = `${base}${suffix}${ext}`;
    for (let n = 2; used.has(target.toLowerCase()); n++) target = `${base}${suffix}.${n}${ext}`;
    used.add(target.toLowerCase());
    return { source: sub.source, target, language: sub.language };
  });
}

// --- copying / moving ------------------------------------------------------------------

const job = {
  running: false,
  mode: null,
  totalBytes: 0,
  doneBytes: 0,
  current: null, // item id
  items: [], // { id, source, target, size, status: pending|working|done|skipped|error, reason }
  finishedAt: null,
};
let abort = null;

export function getImportStatus() {
  return job;
}

export function cancelImport() {
  if (abort) abort.abort();
}

/** Starts copying (mode 'copy') or moving (mode 'move') the items; returns at once. */
export function startImport(items, mode) {
  if (job.running) throw new ImportError(409, 'An import is already running');
  if (!['copy', 'move'].includes(mode)) throw new ImportError(400, 'mode must be "copy" or "move"');

  const resolved = items.map(resolveItem);
  Object.assign(job, {
    running: true,
    mode,
    current: null,
    finishedAt: null,
    doneBytes: 0,
    items: resolved.map((item) => ({
      id: item.id,
      source: item.source,
      target: item.target,
      size: item.size || 0,
      status: item.error || item.exists ? 'skipped' : 'pending',
      reason: item.error || (item.exists ? 'exists' : null),
    })),
  });
  job.totalBytes = job.items.filter((i) => i.status === 'pending').reduce((sum, i) => sum + i.size, 0);
  abort = new AbortController();

  run(resolved, mode, abort.signal).finally(() => {
    job.running = false;
    job.current = null;
    job.finishedAt = Date.now();
    abort = null;
  });
  return job;
}

async function run(items, mode, signal) {
  for (const item of items) {
    const state = job.items.find((i) => i.id === item.id);
    if (state.status !== 'pending') continue;
    if (signal.aborted) {
      state.status = 'skipped';
      state.reason = 'cancelled';
      continue;
    }
    job.current = item.id;
    state.status = 'working';
    const before = job.doneBytes;
    try {
      await transfer(item.source, item.target, mode, signal, (bytes) => (job.doneBytes = before + bytes));
      for (const sub of item.subtitles) {
        if (!fs.existsSync(sub.target)) await transfer(sub.source, sub.target, mode, signal, () => {});
      }
      state.status = 'done';
    } catch (err) {
      state.status = signal.aborted ? 'skipped' : 'error';
      state.reason = signal.aborted ? 'cancelled' : err.code || err.message;
      if (!signal.aborted) console.error(`Import failed for ${item.source}: ${err.message}`);
    }
    job.doneBytes = before + item.size;
  }

  const done = items.filter((item) => job.items.find((i) => i.id === item.id).status === 'done');
  if (!done.length) return;
  console.log(`Imported ${done.length} file(s) (${mode})`);
  await startFreshScan();
  await applyChosenMatches(done);
}

/** Moves (rename when on the same drive) or copies `source` to `target` through "<target>.part". */
async function transfer(source, target, mode, signal, onProgress) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) throw Object.assign(new Error('Target exists'), { code: 'exists' });

  if (mode === 'move') {
    try {
      await fs.promises.rename(source, target);
      return;
    } catch (err) {
      if (err.code !== 'EXDEV') throw err; // another drive: copy, then delete
    }
  }

  const part = `${target}.part`;
  let copied = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      copied += chunk.length;
      onProgress(copied);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(source, { highWaterMark: 4 * 1024 * 1024 }),
      counter,
      fs.createWriteStream(part),
      { signal }
    );
    await fs.promises.rename(part, target);
  } catch (err) {
    await fs.promises.rm(part, { force: true });
    throw err;
  }
  if (mode === 'move') await fs.promises.unlink(source);
}

/** The match picked in the import list is applied, so a scan can't pick a different one. */
async function applyChosenMatches(items) {
  const db = getDb();
  for (const item of items) {
    if (!item.match || !item.match.tmdbId || !tmdbConfigured()) continue;
    const row = db.prepare('SELECT id, series_id, metadata_source, tmdb_id FROM media WHERE path = ?').get(item.target);
    if (!row) continue;
    try {
      if (item.kind === 'movie' && row.tmdb_id !== item.match.tmdbId) {
        await setMediaTmdbId(row.id, item.match.tmdbId);
      } else if (item.kind === 'episode' && row.series_id) {
        const series = db.prepare('SELECT tmdb_id FROM series WHERE id = ?').get(row.series_id);
        if (series.tmdb_id !== item.match.tmdbId) await setSeriesTmdbId(row.series_id, item.match.tmdbId);
      }
    } catch (err) {
      console.warn(`Import: could not set the TMDB match of ${item.target}: ${err.message}`);
    }
  }
}
