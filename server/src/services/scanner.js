// Library scanner: walks the media folders and reconciles what it finds with SQLite.
//
// Re-scans are incremental:
// - known paths keep their id (and therefore their progress, offsets, etc.)
// - a file that disappeared and reappeared elsewhere with the same name and size is
//   treated as moved and keeps its id
// - files that are gone are marked unavailable, never deleted
// External subtitle files (.srt, .vtt) are found in the same walk and attached to their video.
import fs from 'node:fs';
import path from 'node:path';
import { isVideoFile } from '../utils/mime.js';
import { cleanName, parseEpisode, parseMovie, parseSeasonFolder, parseTitleYear, sortTitle } from './parsers.js';
import { detectLanguageFromFile, isSubtitleFile, matchSubtitle } from './subtitles.js';

const SKIP_DIRS = new Set(['system volume information', '@eadir', 'sample', 'samples', 'extrafanart']);
const SAMPLE_FILE = /(^|[\s._-])sample([\s._-]|$)/i;
const SAMPLE_MAX_SIZE = 300 * 1024 * 1024;

async function walk(dir, out, subtitles) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`! Cannot read folder ${dir}: ${err.code || err.message}`);
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') || name.startsWith('$')) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(name.toLowerCase())) await walk(full, out, subtitles);
    } else if (entry.isFile() && isVideoFile(name)) {
      out.push(full);
    } else if (entry.isFile() && isSubtitleFile(name)) {
      subtitles.push(full);
    }
  }
}

async function statAll(files) {
  const results = [];
  const BATCH = 32;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const stats = await Promise.all(batch.map((f) => fs.promises.stat(f).catch(() => null)));
    batch.forEach((file, j) => {
      if (stats[j]) results.push({ file, stat: stats[j] });
    });
  }
  return results;
}

/** Builds the parsed description of one file, or null if it should be skipped. */
function describe(type, root, file, stat) {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const parts = path.relative(root, file).split(path.sep);
  const parentFolder = parts.length > 1 ? parts[parts.length - 2] : null;

  if (SAMPLE_FILE.test(base) && stat.size < SAMPLE_MAX_SIZE) return null;

  const common = {
    type,
    path: file,
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
    // Creation time on NTFS is when the file was copied into the library,
    // which is what "recently added" should mean on the first scan.
    addedAt: Math.floor(Math.min(stat.birthtimeMs || stat.mtimeMs, Date.now())),
  };

  if (type === 'movie') {
    const { title, year } = parseMovie(base, parentFolder);
    return { ...common, title, year };
  }

  if (type === 'video') {
    return { ...common, title: cleanName(base) || base, year: null, category: parts.length > 1 ? parts[0] : null };
  }

  // Episode: Series/Show Name/Season 01/Show Name S01E02.mkv
  const showFolder = parts.length > 1 ? parts[0] : null;
  const folderSeason = parts.length > 2 ? parseSeasonFolder(parentFolder) : null;
  const ep = parseEpisode(base, folderSeason);
  if (!ep) {
    console.warn(`! Skipping episode without SxxEyy / 1x02 numbering: ${file}`);
    return null;
  }
  const show = showFolder ? parseTitleYear(showFolder) : ep.showPart ? parseTitleYear(ep.showPart) : null;
  if (!show) {
    console.warn(`! Skipping episode without a show folder or show name: ${file}`);
    return null;
  }

  return {
    ...common,
    title: ep.title,
    year: null,
    seasonNumber: ep.season,
    episodeNumber: ep.episode,
    show: {
      title: show.title,
      year: show.year,
      folderKey: showFolder ? path.join(root, showFolder) : path.join(root, '#' + sortTitle(show.title)),
    },
  };
}

async function collect(roots) {
  const found = [];
  const seen = new Set();
  const subtitleFiles = [];
  let skipped = 0;

  for (const type of ['movie', 'episode', 'video']) {
    for (const root of roots[type] || []) {
      if (!fs.existsSync(root)) {
        console.warn(`! Media folder not found: ${root}`);
        continue;
      }
      const files = [];
      await walk(root, files, subtitleFiles);
      for (const { file, stat } of await statAll(files)) {
        if (seen.has(file)) continue; // overlapping folders in .env: the first type wins
        seen.add(file);
        const entry = describe(type, root, file, stat);
        if (entry) found.push(entry);
        else skipped++;
      }
    }
  }
  return { found, skipped, subtitleFiles };
}

/**
 * Attaches subtitle files to the videos found. A file named without a language
 * ("Movie.srt") gets one guessed from its text - only when it is new or changed.
 */
async function collectSubtitles(db, found, subtitleFiles) {
  const videosByFolder = new Map();
  for (const entry of found) {
    const folder = path.dirname(entry.path);
    if (!videosByFolder.has(folder)) videosByFolder.set(folder, []);
    videosByFolder.get(folder).push(entry.path);
  }

  const known = db.prepare('SELECT language, size, mtime_ms FROM subtitles WHERE path = ?');
  const subtitles = [];
  for (const { file, stat } of await statAll(subtitleFiles)) {
    const match = matchSubtitle(file, videosByFolder);
    if (!match) continue;
    let language = match.language;
    if (!language) {
      const row = known.get(file);
      const unchanged = row && row.size === stat.size && row.mtime_ms === Math.floor(stat.mtimeMs);
      language = unchanged ? row.language : await detectLanguageFromFile(file).catch(() => null);
    }
    subtitles.push({
      path: file,
      videoPath: match.videoPath,
      format: path.extname(file).slice(1).toLowerCase(),
      language,
      tags: match.tags,
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    });
  }
  return subtitles;
}

function reconcileSubtitles(db, subtitles, now) {
  const mediaIds = new Map(db.prepare('SELECT id, path FROM media').all().map((row) => [row.path, row.id]));
  // Only external files - embedded streams are kept in sync by the probe (services/probe.js).
  const existing = new Map(
    db.prepare('SELECT id, path FROM subtitles WHERE path IS NOT NULL').all().map((row) => [row.path, row.id])
  );
  const update = db.prepare(`
    UPDATE subtitles SET media_id = @mediaId, format = @format, language = @language, tags = @tags,
      size = @size, mtime_ms = @mtimeMs, available = 1
    WHERE id = @id`);
  const insert = db.prepare(`
    INSERT INTO subtitles (media_id, path, format, language, tags, size, mtime_ms, available, added_at)
    VALUES (@mediaId, @path, @format, @language, @tags, @size, @mtimeMs, 1, @now)`);

  const seen = new Set();
  for (const sub of subtitles) {
    const mediaId = mediaIds.get(sub.videoPath);
    if (!mediaId) continue;
    const params = { ...sub, mediaId, tags: JSON.stringify(sub.tags), now };
    if (existing.has(sub.path)) update.run({ ...params, id: existing.get(sub.path) });
    else insert.run(params);
    seen.add(sub.path);
  }

  const markMissing = db.prepare('UPDATE subtitles SET available = 0 WHERE id = ?');
  for (const [subPath, id] of existing) {
    if (!seen.has(subPath)) markMissing.run(id);
  }
  return seen.size;
}

function moveKey(type, filePath, size) {
  return `${type}|${path.basename(filePath).toLowerCase()}|${size}`;
}

function reconcile(db, found, subtitles) {
  const now = Date.now();
  const stats = { added: 0, updated: 0, moved: 0, restored: 0, removed: 0, total: found.length };

  const existing = db.prepare('SELECT id, type, path, size, mtime_ms, available FROM media').all();
  const byPath = new Map(existing.map((row) => [row.path, row]));
  const foundPaths = new Set(found.map((f) => f.path));

  // Files that are no longer at their old path - candidates for "moved".
  const vanished = new Map();
  for (const row of existing) {
    if (foundPaths.has(row.path)) continue;
    const key = moveKey(row.type, row.path, row.size);
    if (!vanished.has(key)) vanished.set(key, []);
    vanished.get(key).push(row);
  }

  const findSeries = db.prepare('SELECT id FROM series WHERE folder_key = ?');
  const insertSeries = db.prepare(`
    INSERT INTO series (folder_key, title, sort_title, year, added_at, updated_at)
    VALUES (@folderKey, @title, @sortTitle, @year, @now, @now)`);
  const updateSeriesName = db.prepare(`
    UPDATE series SET title = @title, sort_title = @sortTitle, year = @year
    WHERE id = @id AND metadata_source = 'filename'`);
  const ensureSeason = db.prepare('INSERT OR IGNORE INTO seasons (series_id, season_number) VALUES (?, ?)');

  const insertMedia = db.prepare(`
    INSERT INTO media (type, path, size, mtime_ms, available, added_at, last_seen_at,
                       title, sort_title, year, series_id, season_number, episode_number, category)
    VALUES (@type, @path, @size, @mtimeMs, 1, @addedAt, @now,
            @title, @sortTitle, @year, @seriesId, @seasonNumber, @episodeNumber, @category)`);
  const updateMedia = db.prepare(`
    UPDATE media SET
      type = @type, path = @path, size = @size, mtime_ms = @mtimeMs, available = 1, last_seen_at = @now,
      series_id = @seriesId, season_number = @seasonNumber, episode_number = @episodeNumber, category = @category,
      title      = CASE WHEN metadata_source = 'filename' THEN @title ELSE title END,
      sort_title = CASE WHEN metadata_source = 'filename' THEN @sortTitle ELSE sort_title END,
      year       = CASE WHEN metadata_source = 'filename' THEN @year ELSE year END
    WHERE id = @id`);
  const markUnavailable = db.prepare('UPDATE media SET available = 0 WHERE id = ?');

  const seriesIds = new Map();
  function seriesIdFor(show) {
    if (seriesIds.has(show.folderKey)) return seriesIds.get(show.folderKey);
    const params = { folderKey: show.folderKey, title: show.title, sortTitle: sortTitle(show.title), year: show.year, now };
    const row = findSeries.get(show.folderKey);
    let id;
    if (row) {
      id = row.id;
      updateSeriesName.run({ ...params, id });
    } else {
      id = insertSeries.run(params).lastInsertRowid;
    }
    seriesIds.set(show.folderKey, id);
    return id;
  }

  db.transaction(() => {
    for (const entry of found) {
      let seriesId = null;
      if (entry.type === 'episode') {
        seriesId = seriesIdFor(entry.show);
        ensureSeason.run(seriesId, entry.seasonNumber);
      }
      const params = {
        type: entry.type,
        path: entry.path,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        addedAt: entry.addedAt,
        now,
        title: entry.title,
        sortTitle: entry.title ? sortTitle(entry.title) : null,
        year: entry.year,
        seriesId,
        seasonNumber: entry.seasonNumber ?? null,
        episodeNumber: entry.episodeNumber ?? null,
        category: entry.category ?? null,
      };

      const known = byPath.get(entry.path);
      if (known) {
        if (!known.available) stats.restored++;
        else if (known.size !== entry.size || known.mtime_ms !== entry.mtimeMs) stats.updated++;
        updateMedia.run({ ...params, id: known.id });
        continue;
      }

      const candidates = vanished.get(moveKey(entry.type, entry.path, entry.size));
      if (candidates && candidates.length) {
        const moved = candidates.shift();
        updateMedia.run({ ...params, id: moved.id });
        stats.moved++;
        continue;
      }

      insertMedia.run(params);
      stats.added++;
    }

    for (const rows of vanished.values()) {
      for (const row of rows) {
        if (row.available) {
          markUnavailable.run(row.id);
          stats.removed++;
        }
      }
    }

    db.exec(`
      UPDATE series SET
        available  = EXISTS (SELECT 1 FROM media WHERE media.series_id = series.id AND media.available = 1),
        updated_at = COALESCE((SELECT MAX(added_at) FROM media WHERE media.series_id = series.id AND media.available = 1), updated_at)
    `);

    stats.subtitles = reconcileSubtitles(db, subtitles, now);
  })();

  return stats;
}

/**
 * True while another program still writes the file. Windows (Explorer, Copy-Item, robocopy)
 * creates the copy at its full size right away but keeps it locked until the copy ends,
 * so the size alone can't tell a finished file from a half-copied one.
 */
async function isBeingWritten(file) {
  try {
    const handle = await fs.promises.open(file, 'r');
    await handle.close();
    return false;
  } catch (err) {
    return err.code === 'EBUSY';
  }
}

/** Drops new files that are still being copied; the next scan (or the folder watcher) adds them. */
async function withoutFilesInProgress(db, found) {
  const knownPaths = new Set(db.prepare('SELECT path FROM media').pluck().all());
  const ready = [];
  let inProgress = 0;
  for (const entry of found) {
    if (!knownPaths.has(entry.path) && (await isBeingWritten(entry.path))) {
      console.log(`  still being copied, skipped for now: ${entry.path}`);
      inProgress++;
    } else {
      ready.push(entry);
    }
  }
  return { ready, inProgress };
}

/**
 * Scans the given folders and updates the database.
 * @param roots { movie: string[], episode: string[], video: string[] }
 */
export async function scanLibrary(db, roots) {
  const { found, skipped, subtitleFiles } = await collect(roots);
  const { ready, inProgress } = await withoutFilesInProgress(db, found);
  const subtitles = await collectSubtitles(db, ready, subtitleFiles);
  return { ...reconcile(db, ready, subtitles), skipped, inProgress };
}
