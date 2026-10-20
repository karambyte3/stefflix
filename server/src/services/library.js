// Read-side queries for the browse API. Rows are turned into plain JSON objects here,
// so routes stay thin and the TV app gets the same shapes everywhere.
// Everything that shows watch progress takes the profile id.
import path from 'node:path';
import { getDb, parseJson } from '../db/index.js';
import { DEFAULT_PROFILE_ID } from '../profiles.js';
import { checkCompatibility } from './compatibility.js';
import { placeholderUrl } from './images.js';
import { isConfigured as onlineSubtitlesConfigured } from './openSubtitles.js';
import { CONTINUE_MIN_RATIO, resumePosition, WATCHED_RATIO } from './progress.js';

const HOME_ROW_LIMIT = 20;

// --- progress ------------------------------------------------------------------

/** All progress rows of a profile: media id -> row. (The table only holds what was played.) */
function progressMap(db, profileId) {
  const map = new Map();
  for (const row of db.prepare('SELECT * FROM progress WHERE profile_id = ?').all(profileId)) {
    map.set(row.media_id, row);
  }
  return map;
}

/**
 * Card fields: progress (0-1, set exactly when the player would resume - like the red bar
 * on a YouTube thumbnail) and watched.
 */
function progressFields(progress, mediaDuration) {
  if (!progress) return { progress: null, watched: false };
  const duration = progress.duration || mediaDuration;
  const resumeAt = resumePosition(progress, mediaDuration);
  return {
    progress: resumeAt && duration ? Math.max(0.01, Math.round((resumeAt / duration) * 1000) / 1000) : null,
    watched: !!progress.watched,
  };
}

/** Length in seconds for the card's duration badge: the file's, else TMDB's runtime. */
function lengthOf(row) {
  return row.duration || (row.runtime ? row.runtime * 60 : null);
}

/** Details field: { position, duration, watched, resumeAt }. */
function progressDetails(progress, mediaDuration) {
  return {
    position: progress ? progress.position : 0,
    duration: (progress && progress.duration) || mediaDuration || null,
    watched: !!(progress && progress.watched),
    resumeAt: resumePosition(progress, mediaDuration),
  };
}

// --- item shapes -------------------------------------------------------------

function movieItem(row, progress) {
  return {
    id: row.id,
    type: 'movie',
    title: row.title,
    year: row.year,
    rating: row.rating,
    poster: row.poster || placeholderUrl('movie', row.id, row.title, row.year),
    backdrop: row.backdrop,
    genres: parseJson(row.genres, []),
    duration: lengthOf(row),
    ...progressFields(progress, row.duration),
  };
}

function seriesItem(row) {
  return {
    id: row.id,
    type: 'series',
    title: row.title,
    year: row.year,
    rating: row.rating,
    poster: row.poster || placeholderUrl('series', row.id, row.title, row.year),
    backdrop: row.backdrop,
    genres: parseJson(row.genres, []),
    episodeCount: row.episode_count,
  };
}

function episodeItem(row, progress) {
  return {
    id: row.id,
    type: 'episode',
    title: row.title,
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    still: row.still,
    poster: row.series_poster,
    backdrop: row.series_backdrop,
    duration: lengthOf(row),
    ...progressFields(progress, row.duration),
  };
}

function videoItem(row, progress) {
  return {
    id: row.id,
    type: 'video',
    title: row.title,
    category: row.category,
    duration: row.duration,
    still: row.still,
    ...progressFields(progress, row.duration),
  };
}

// --- lists -------------------------------------------------------------------

const SORTS = {
  title: 'sort_title ASC',
  year: 'year DESC NULLS LAST, sort_title ASC',
  rating: 'rating DESC NULLS LAST, sort_title ASC',
  added: 'added_at DESC, sort_title ASC',
};

function orderBy(sort, fallback) {
  return SORTS[sort] || SORTS[fallback];
}

const GENRE_FILTER = 'EXISTS (SELECT 1 FROM json_each(genres) WHERE json_each.value = @genre)';

export function listMovies({ genre, sort, profileId = DEFAULT_PROFILE_ID } = {}) {
  const db = getDb();
  const where = ["type = 'movie'", 'available = 1'];
  if (genre) where.push(GENRE_FILTER);
  const rows = db
    .prepare(`SELECT * FROM media WHERE ${where.join(' AND ')} ORDER BY ${orderBy(sort, 'added')}`)
    .all({ genre });
  const progress = progressMap(db, profileId);
  return rows.map((row) => movieItem(row, progress.get(row.id)));
}

const SERIES_SELECT = `
  SELECT series.*, (SELECT COUNT(*) FROM media WHERE media.series_id = series.id AND media.available = 1) AS episode_count
  FROM series`;

export function listSeries({ genre, sort } = {}) {
  const where = ['available = 1'];
  if (genre) where.push(GENRE_FILTER);
  // For series, "added" means "has new episodes".
  const order = sort === 'added' || !SORTS[sort] ? 'updated_at DESC, sort_title ASC' : orderBy(sort);
  const rows = getDb()
    .prepare(`${SERIES_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order}`)
    .all({ genre });
  return rows.map(seriesItem);
}

export function listVideos({ category, sort, profileId = DEFAULT_PROFILE_ID } = {}) {
  const db = getDb();
  const where = ["type = 'video'", 'available = 1'];
  const params = {};
  if (category === '') {
    where.push('category IS NULL');
  } else if (category) {
    where.push('category = @category');
    params.category = category;
  }
  // Videos have no year or rating: those sorts fall back to "added".
  const order = sort === 'title' ? SORTS.title : SORTS.added;
  const rows = db.prepare(`SELECT * FROM media WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(params);
  const progress = progressMap(db, profileId);
  return rows.map((row) => videoItem(row, progress.get(row.id)));
}

export function listGenres(type) {
  const table = type === 'series' ? 'series' : 'media';
  // Qualified: json_each() has a "type" column of its own.
  const typeFilter = type === 'series' ? '' : "AND media.type = 'movie'";
  return getDb()
    .prepare(
      `SELECT DISTINCT json_each.value AS genre FROM ${table}, json_each(${table}.genres)
       WHERE ${table}.available = 1 ${typeFilter} ORDER BY genre`
    )
    .all()
    .map((row) => row.genre);
}

export function listVideoCategories() {
  return getDb()
    .prepare(
      `SELECT category, COUNT(*) AS count, MAX(added_at) AS latest FROM media
       WHERE type = 'video' AND available = 1 GROUP BY category ORDER BY latest DESC`
    )
    .all()
    .map((row) => ({ category: row.category, count: row.count }));
}

// --- episodes in order --------------------------------------------------------------

const EPISODE_SELECT = `
  SELECT media.*, series.title AS series_title, series.poster AS series_poster, series.backdrop AS series_backdrop
  FROM media JOIN series ON series.id = media.series_id`;

/**
 * The episode after `episode`, across season boundaries. Specials (season 0) only
 * lead to the next special; the last regular episode has no next one.
 */
function nextEpisodeRow(db, episode) {
  return (
    db
      .prepare(
        `${EPISODE_SELECT}
         WHERE media.type = 'episode' AND media.series_id = @seriesId AND media.available = 1
           AND ((media.season_number = @season AND media.episode_number > @episode)
             OR (@season > 0 AND media.season_number > @season))
         ORDER BY media.season_number, media.episode_number LIMIT 1`
      )
      .get({ seriesId: episode.series_id, season: episode.season_number, episode: episode.episode_number }) || null
  );
}

/** The first episode after `episode` that hasn't been watched (or null). */
function nextUnwatchedRow(db, episode, progress) {
  let next = nextEpisodeRow(db, episode);
  while (next && progress.has(next.id) && progress.get(next.id).watched) next = nextEpisodeRow(db, next);
  return next;
}

/** GET /api/episodes/:id/next */
export function getNextEpisode(id, profileId = DEFAULT_PROFILE_ID) {
  const db = getDb();
  const episode = db.prepare("SELECT * FROM media WHERE id = ? AND type = 'episode'").get(id);
  if (!episode) return null;
  const next = nextEpisodeRow(db, episode);
  return next ? episodeItem(next, progressMap(db, profileId).get(next.id)) : null;
}

/**
 * What "Play" on a series should start: the episode in progress, else the one after the
 * last finished episode, else the first unwatched one. { row, resumeAt } or null.
 */
function seriesUpNext(db, profileId, seriesId, progress) {
  const latest = db
    .prepare(
      `SELECT media.* FROM progress JOIN media ON media.id = progress.media_id
       WHERE progress.profile_id = @profileId AND media.series_id = @seriesId AND media.available = 1
       ORDER BY progress.updated_at DESC LIMIT 1`
    )
    .get({ profileId, seriesId });

  if (latest) {
    const p = progress.get(latest.id);
    const finished = p.watched && p.position === 0;
    if (!finished) return { row: latest, resumeAt: resumePosition(p, latest.duration) };
    const next = nextUnwatchedRow(db, latest, progress);
    if (next) return { row: next, resumeAt: resumePosition(progress.get(next.id), next.duration) };
  }

  const episodes = db
    .prepare(
      `SELECT * FROM media WHERE series_id = ? AND type = 'episode' AND available = 1
       ORDER BY season_number = 0, season_number, episode_number`
    )
    .all(seriesId);
  const first = episodes.find((e) => !(progress.has(e.id) && progress.get(e.id).watched)) || episodes[0];
  return first ? { row: first, resumeAt: resumePosition(progress.get(first.id), first.duration) } : null;
}

// --- continue watching -----------------------------------------------------------------

/**
 * Items to continue, most recently watched first:
 * - movies and videos between 5% and 90%
 * - per series one episode: the one in progress, or the next unwatched one after the
 *   episode that was just finished (marked nextUp)
 */
export function getContinueWatching(profileId = DEFAULT_PROFILE_ID, limit = HOME_ROW_LIMIT) {
  const db = getDb();
  const progress = progressMap(db, profileId);
  const rows = db
    .prepare(
      `SELECT media.* FROM progress JOIN media ON media.id = progress.media_id
       WHERE progress.profile_id = ? AND media.available = 1
       ORDER BY progress.updated_at DESC`
    )
    .all(profileId);
  const episodeById = db.prepare(`${EPISODE_SELECT} WHERE media.id = ?`);

  const items = [];
  const seriesSeen = new Set();
  for (const row of rows) {
    if (items.length >= limit) break;
    const p = progress.get(row.id);
    const duration = p.duration || row.duration;
    const ratio = duration ? p.position / duration : 0;
    const inProgress = ratio >= CONTINUE_MIN_RATIO && ratio < WATCHED_RATIO;

    if (row.type === 'movie') {
      if (inProgress) items.push(movieItem(row, p));
      continue;
    }
    if (row.type === 'video') {
      if (inProgress) items.push(videoItem(row, p));
      continue;
    }

    // Episodes: only the latest activity of each series counts.
    if (seriesSeen.has(row.series_id)) continue;
    seriesSeen.add(row.series_id);

    const finished = p.watched && p.position === 0;
    if (!finished) {
      // In progress, or just started: continue with this episode.
      items.push({ ...episodeItem(episodeById.get(row.id), p), nextUp: !inProgress });
      continue;
    }
    const next = nextUnwatchedRow(db, row, progress);
    if (next) items.push({ ...episodeItem(next, progress.get(next.id)), nextUp: true });
  }
  return items;
}

// --- home ----------------------------------------------------------------------

function pickFeatured(db) {
  const movies = db
    .prepare(`SELECT * FROM media WHERE type = 'movie' AND available = 1 ORDER BY added_at DESC LIMIT 10`)
    .all()
    .map((row) => movieItem(row));
  const series = db
    .prepare(`${SERIES_SELECT} WHERE available = 1 ORDER BY updated_at DESC LIMIT 10`)
    .all()
    .map(seriesItem);
  const candidates = movies.concat(series);
  if (!candidates.length) return null;

  // Items with a backdrop make a better banner.
  const withBackdrop = candidates.filter((item) => item.backdrop);
  const pool = withBackdrop.length ? withBackdrop : candidates;
  // Rotates every 30 minutes instead of on every request, so the home screen
  // doesn't change each time the user comes back to it.
  const picked = pool[Math.floor(Date.now() / (30 * 60 * 1000)) % pool.length];

  const overview =
    picked.type === 'movie'
      ? db.prepare('SELECT overview FROM media WHERE id = ?').get(picked.id).overview
      : db.prepare('SELECT overview FROM series WHERE id = ?').get(picked.id).overview;
  return { ...picked, overview };
}

export function getHome(profileId = DEFAULT_PROFILE_ID) {
  const db = getDb();
  const progress = progressMap(db, profileId);
  const rows = [];

  rows.push({ key: 'continueWatching', items: getContinueWatching(profileId) });

  rows.push({
    key: 'recentMovies',
    items: db
      .prepare(`SELECT * FROM media WHERE type = 'movie' AND available = 1 ORDER BY added_at DESC LIMIT ${HOME_ROW_LIMIT}`)
      .all()
      .map((row) => movieItem(row, progress.get(row.id))),
  });

  rows.push({
    key: 'recentEpisodes',
    items: db
      .prepare(`${EPISODE_SELECT} WHERE media.available = 1 ORDER BY media.added_at DESC LIMIT ${HOME_ROW_LIMIT}`)
      .all()
      .map((row) => episodeItem(row, progress.get(row.id))),
  });

  rows.push({
    key: 'series',
    items: db
      .prepare(`${SERIES_SELECT} WHERE available = 1 ORDER BY updated_at DESC LIMIT ${HOME_ROW_LIMIT}`)
      .all()
      .map(seriesItem),
  });

  const videosIn = db.prepare(
    `SELECT * FROM media WHERE type = 'video' AND available = 1 AND category IS @category
     ORDER BY added_at DESC LIMIT ${HOME_ROW_LIMIT}`
  );
  for (const { category } of listVideoCategories()) {
    rows.push({ key: 'videos', category, items: videosIn.all({ category }).map((row) => videoItem(row, progress.get(row.id))) });
  }

  return {
    featured: pickFeatured(db),
    rows: rows.filter((row) => row.items.length > 0),
  };
}

// --- details -------------------------------------------------------------------

// Preferred languages first; unknown language last.
const SUBTITLE_ORDER = ['bg', 'en'];

function subtitleRank(language) {
  const index = SUBTITLE_ORDER.indexOf(language);
  if (index !== -1) return index;
  return language ? SUBTITLE_ORDER.length : SUBTITLE_ORDER.length + 1;
}

/** External files first (the user put them there on purpose), then embedded streams in file order. */
function subtitlesOf(db, mediaId) {
  return db
    .prepare(
      `SELECT id, language, format, tags, stream_index, title FROM subtitles WHERE media_id = ? AND available = 1
       ORDER BY stream_index IS NOT NULL, path, stream_index`
    )
    .all(mediaId)
    .map((row) => ({
      id: row.id,
      language: row.language,
      format: row.format,
      tags: parseJson(row.tags, []),
      embedded: row.stream_index !== null,
      title: row.title,
    }))
    .sort((a, b) => subtitleRank(a.language) - subtitleRank(b.language));
}

/** Full details of one playable item (movie, episode or video). */
export function getMediaDetails(id, profileId = DEFAULT_PROFILE_ID) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!row) return null;

  const probe = parseJson(row.probe, null);
  const progress = db.prepare('SELECT * FROM progress WHERE profile_id = ? AND media_id = ?').get(profileId, id);
  const details = {
    id: row.id,
    type: row.type,
    title: row.title,
    originalTitle: row.original_title,
    year: row.year,
    overview: row.overview,
    rating: row.rating,
    runtime: row.runtime,
    genres: parseJson(row.genres, []),
    poster: row.poster || (row.type === 'movie' ? placeholderUrl('movie', row.id, row.title, row.year) : null),
    backdrop: row.backdrop,
    still: row.still,
    cast: parseJson(row.credits, []),
    tmdbId: row.tmdb_id,
    metadataSource: row.metadata_source,
    available: !!row.available,
    addedAt: row.added_at,
    duration: row.duration,
    creditsAt: row.credits_at,
    fileName: path.basename(row.path),
    size: row.size,
    category: row.category,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    series: null,
    tech: probe,
    compatibility: checkCompatibility(row.path, probe),
    subtitles: subtitlesOf(db, row.id),
    // "Search online" (OpenSubtitles) is offered only when the server has an API key.
    onlineSubtitles: onlineSubtitlesConfigured(),
    progress: progressDetails(progress, row.duration),
  };

  if (row.type === 'episode') {
    const series = db.prepare('SELECT id, title, poster, backdrop FROM series WHERE id = ?').get(row.series_id);
    details.series = series || null;
  }
  return details;
}

/** A series with its seasons, episodes (with progress) and the episode "Play" should start. */
export function getSeriesDetails(id, profileId = DEFAULT_PROFILE_ID) {
  const db = getDb();
  const row = db.prepare(`${SERIES_SELECT} WHERE id = ?`).get(id);
  if (!row) return null;

  const progress = progressMap(db, profileId);
  const episodes = db
    .prepare('SELECT * FROM media WHERE series_id = ? ORDER BY season_number, episode_number')
    .all(id);
  const seasonRows = db.prepare('SELECT * FROM seasons WHERE series_id = ?').all(id);

  const seasons = seasonRows
    .map((season) => ({
      seasonNumber: season.season_number,
      title: season.title,
      overview: season.overview,
      poster: season.poster,
      episodes: episodes
        .filter((ep) => ep.season_number === season.season_number)
        .map((ep) => ({
          id: ep.id,
          seasonNumber: ep.season_number,
          episodeNumber: ep.episode_number,
          title: ep.title,
          overview: ep.overview,
          still: ep.still,
          runtime: ep.runtime,
          duration: ep.duration,
          available: !!ep.available,
          ...progressFields(progress.get(ep.id), ep.duration),
        })),
    }))
    .filter((season) => season.episodes.length > 0)
    .sort((a, b) => (a.seasonNumber === 0 ? 1 : b.seasonNumber === 0 ? -1 : a.seasonNumber - b.seasonNumber));

  const available = episodes.filter((ep) => ep.available);
  const upNext = seriesUpNext(db, profileId, id, progress);

  return {
    ...seriesItem(row),
    originalTitle: row.original_title,
    overview: row.overview,
    cast: parseJson(row.credits, []),
    tmdbId: row.tmdb_id,
    metadataSource: row.metadata_source,
    available: !!row.available,
    watched: available.length > 0 && available.every((ep) => progress.has(ep.id) && progress.get(ep.id).watched),
    upNext: upNext
      ? {
          id: upNext.row.id,
          seasonNumber: upNext.row.season_number,
          episodeNumber: upNext.row.episode_number,
          title: upNext.row.title,
          resumeAt: upNext.resumeAt,
        }
      : null,
    seasons,
  };
}

/** What the stream endpoint needs. Returns null for unknown or missing files. */
export function getPlayableFile(id) {
  const row = getDb().prepare('SELECT id, path, available FROM media WHERE id = ?').get(id);
  if (!row || !row.available) return null;
  return { id: row.id, path: row.path };
}
