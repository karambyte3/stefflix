// The library overview for the desktop app's "Библиотека" tab: counts, every movie and
// series with its TMDB match, and the problems worth fixing (no match, files the TV
// may not play, files that are gone).
import { parseJson } from '../db/index.js';
import { checkCompatibility } from './compatibility.js';
import { placeholderUrl } from './images.js';

const MAX_MISSING = 200;

function countOf(db, sql) {
  return db.prepare(sql).get().n;
}

/** How each episode is named in lists: "Show S01E02 · Title". */
function episodeLabel(row) {
  const code = `S${String(row.season_number).padStart(2, '0')}E${String(row.episode_number).padStart(2, '0')}`;
  return [row.series_title, code, row.title].filter(Boolean).join(' · ');
}

function labelOf(row) {
  return row.type === 'episode' ? episodeLabel(row) : row.title;
}

const MEDIA_WITH_SERIES = `
  SELECT m.id, m.type, m.title, m.year, m.path, m.probe, m.season_number, m.episode_number,
         s.title AS series_title
  FROM media m LEFT JOIN series s ON s.id = m.series_id`;

export function getLibraryReport(db) {
  const counts = {
    movies: countOf(db, "SELECT COUNT(*) AS n FROM media WHERE type = 'movie' AND available = 1"),
    series: countOf(db, 'SELECT COUNT(*) AS n FROM series WHERE available = 1'),
    episodes: countOf(db, "SELECT COUNT(*) AS n FROM media WHERE type = 'episode' AND available = 1"),
    videos: countOf(db, "SELECT COUNT(*) AS n FROM media WHERE type = 'video' AND available = 1"),
    missing: countOf(db, 'SELECT COUNT(*) AS n FROM media WHERE available = 0'),
    // Files ffprobe hasn't looked at yet (or can't, without ffprobe): no codec check for them.
    unprobed: countOf(db, 'SELECT COUNT(*) AS n FROM media WHERE available = 1 AND probe IS NULL'),
    totalBytes: countOf(db, 'SELECT COALESCE(SUM(size), 0) AS n FROM media WHERE available = 1'),
  };

  // Movies and series, the things a TMDB match belongs to. `source`: tmdb | manual | filename.
  const movies = db
    .prepare(
      `SELECT id, title, original_title, year, poster, tmdb_id, metadata_source, path FROM media
       WHERE type = 'movie' AND available = 1`
    )
    .all()
    .map((row) => ({
      kind: 'movie',
      id: row.id,
      title: row.title,
      originalTitle: row.original_title,
      year: row.year,
      poster: row.poster || placeholderUrl('movie', row.id, row.title, row.year),
      tmdbId: row.tmdb_id,
      source: row.metadata_source,
      path: row.path,
    }));
  const series = db
    .prepare(
      // `path` is the first episode (a show folder isn't always a real folder - see scanner.js).
      `SELECT id, title, original_title, year, poster, tmdb_id, metadata_source,
              (SELECT path FROM media WHERE series_id = series.id AND available = 1
               ORDER BY season_number, episode_number LIMIT 1) AS path
       FROM series WHERE available = 1`
    )
    .all()
    .map((row) => ({
      kind: 'series',
      id: row.id,
      title: row.title,
      originalTitle: row.original_title,
      year: row.year,
      poster: row.poster || placeholderUrl('series', row.id, row.title, row.year),
      tmdbId: row.tmdb_id,
      source: row.metadata_source,
      path: row.path,
    }));
  const titles = [...movies, ...series].sort((a, b) => (a.title || '').localeCompare(b.title || '', 'bg'));

  const incompatible = [];
  for (const row of db.prepare(`${MEDIA_WITH_SERIES} WHERE m.available = 1`).all()) {
    const { warnings } = checkCompatibility(row.path, parseJson(row.probe, null));
    if (warnings.length) incompatible.push({ id: row.id, type: row.type, title: labelOf(row), path: row.path, warnings });
  }

  const missing = db
    .prepare(`${MEDIA_WITH_SERIES} WHERE m.available = 0 ORDER BY m.path LIMIT ?`)
    .all(MAX_MISSING)
    .map((row) => ({ id: row.id, type: row.type, title: labelOf(row), path: row.path }));

  return { counts, titles, incompatible, missing };
}
