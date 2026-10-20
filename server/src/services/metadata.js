// Matches library items with TMDB and stores their metadata.
//
// - Movies are matched by title + year, series by name (+ year from the folder, if any).
// - Text is fetched in Bulgarian (bg-BG); empty or auto-generated fields fall back to English.
// - Matched items are never re-matched by a scan; items that weren't found are retried
//   after RETRY_MS. A wrong match is fixed with setMediaTmdbId / setSeriesTmdbId.
// - Without an API key nothing happens: items keep their file-name data and get a
//   generated placeholder poster (see services/images.js).
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { localImage, prefetchImages } from './images.js';
import { sortTitle } from './parsers.js';
import { isConfigured, tmdbGet, TmdbAuthError } from './tmdb.js';

const LANGUAGE = 'bg-BG';
const FALLBACK_LANGUAGE = 'en';
const RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const CAST_SIZE = 10;

// TMDB returns "Епизод 5" / "Episode 5" when an episode has no translated name.
const GENERIC_EPISODE_NAME = /^(episode|епизод|серия)\s*\d+$/i;

const status = { running: false, done: 0, total: 0, error: null };

export function getMetadataStatus() {
  return { configured: isConfigured(), ...status };
}

// --- helpers -------------------------------------------------------------------------

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function yearOf(date) {
  return date ? Number(String(date).slice(0, 4)) || null : null;
}

function rating(item) {
  return item.vote_count && item.vote_average ? Math.round(item.vote_average * 10) / 10 : null;
}

function normalize(text) {
  return (text || '')
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The English translation from append_to_response=translations, or {}. */
function fallbackTranslation(details) {
  const list = (details.translations && details.translations.translations) || [];
  const found = list.find((t) => t.iso_639_1 === FALLBACK_LANGUAGE && t.iso_3166_1 === 'US') ||
    list.find((t) => t.iso_639_1 === FALLBACK_LANGUAGE);
  return (found && found.data) || {};
}

function castOf(details) {
  const cast = (details.credits && details.credits.cast) || [];
  return cast.slice(0, CAST_SIZE).map((person) => ({
    name: person.name,
    character: person.character || null,
    profile: localImage('profile', person.profile_path),
  }));
}

function genresOf(details) {
  return (details.genres || []).map((g) => g.name).filter(Boolean);
}

/**
 * Picks the search result that best matches a title and year.
 * With a known year, only results within ±1 year or with the exact title are accepted,
 * so "Heat (1995)" never becomes a different "Heat". Without a year, TMDB's own
 * relevance order decides, but an exact title still wins.
 */
export function pickBest(results, title, year, { titleKeys, dateKey }) {
  const wanted = normalize(title);
  let best = null;
  let bestScore = -Infinity;

  results.forEach((result, index) => {
    const exactTitle = titleKeys.some((key) => normalize(result[key]) === wanted);
    const resultYear = yearOf(result[dateKey]);
    const yearDiff = year && resultYear ? Math.abs(resultYear - year) : null;
    if (year && !exactTitle && (yearDiff === null || yearDiff > 1)) return;

    let score = -index * 0.1;
    if (exactTitle) score += 2;
    if (yearDiff === 0) score += 3;
    else if (yearDiff === 1) score += 1;
    else if (yearDiff !== null) score -= 2;

    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  });
  return best;
}

async function search(kind, title, year) {
  const path = kind === 'movie' ? '/search/movie' : '/search/tv';
  const yearParam = kind === 'movie' ? 'year' : 'first_air_date_year';
  const options = kind === 'movie'
    ? { titleKeys: ['title', 'original_title'], dateKey: 'release_date' }
    : { titleKeys: ['name', 'original_name'], dateKey: 'first_air_date' };
  const params = { query: title, language: LANGUAGE, include_adult: 'false' };

  if (year) {
    const withYear = await tmdbGet(path, { ...params, [yearParam]: year });
    const best = pickBest((withYear && withYear.results) || [], title, year, options);
    if (best) return best;
  }
  // The file year can be off (or the TMDB year can be), so try again without it.
  const any = await tmdbGet(path, params);
  return pickBest((any && any.results) || [], title, year, options);
}

// --- movies ----------------------------------------------------------------------------

function fetchMovie(tmdbId) {
  return tmdbGet(`/movie/${tmdbId}`, { language: LANGUAGE, append_to_response: 'credits,translations' }, { ttlDays: 30 });
}

function applyMovie(db, mediaId, details, source) {
  const en = fallbackTranslation(details);
  const title = firstText(details.title, en.title, details.original_title);
  const current = db.prepare('SELECT year FROM media WHERE id = ?').get(mediaId);
  db.prepare(
    `UPDATE media SET
       title = @title, original_title = @originalTitle, sort_title = @sortTitle, year = @year,
       overview = @overview, rating = @rating, runtime = @runtime, genres = @genres,
       poster = @poster, backdrop = @backdrop, credits = @credits,
       tmdb_id = @tmdbId, metadata_source = @source, tmdb_checked_at = @now
     WHERE id = @id`
  ).run({
    id: mediaId,
    title,
    originalTitle: details.original_title || null,
    sortTitle: sortTitle(title),
    year: yearOf(details.release_date) || current.year,
    overview: firstText(details.overview, en.overview),
    rating: rating(details),
    runtime: details.runtime || null,
    genres: JSON.stringify(genresOf(details)),
    poster: localImage('poster', details.poster_path),
    backdrop: localImage('backdrop', details.backdrop_path),
    credits: JSON.stringify(castOf(details)),
    tmdbId: details.id,
    source,
    now: Date.now(),
  });
}

async function matchMovie(db, row) {
  const found = await search('movie', row.title, row.year);
  const details = found ? await fetchMovie(found.id) : null;
  if (details) applyMovie(db, row.id, details, 'tmdb');
  else db.prepare('UPDATE media SET tmdb_checked_at = ? WHERE id = ?').run(Date.now(), row.id);
  return !!details;
}

// --- series ----------------------------------------------------------------------------

function fetchSeries(tmdbId) {
  return tmdbGet(`/tv/${tmdbId}`, { language: LANGUAGE, append_to_response: 'credits,translations' }, { ttlDays: 7 });
}

function applySeries(db, seriesId, details, source) {
  const en = fallbackTranslation(details);
  const title = firstText(details.name, en.name, details.original_name);
  const current = db.prepare('SELECT year FROM series WHERE id = ?').get(seriesId);
  db.prepare(
    `UPDATE series SET
       title = @title, original_title = @originalTitle, sort_title = @sortTitle, year = @year,
       overview = @overview, rating = @rating, genres = @genres,
       poster = @poster, backdrop = @backdrop, credits = @credits,
       tmdb_id = @tmdbId, metadata_source = @source, tmdb_checked_at = @now
     WHERE id = @id`
  ).run({
    id: seriesId,
    title,
    originalTitle: details.original_name || null,
    sortTitle: sortTitle(title),
    year: yearOf(details.first_air_date) || current.year,
    overview: firstText(details.overview, en.overview),
    rating: rating(details),
    genres: JSON.stringify(genresOf(details)),
    poster: localImage('poster', details.poster_path),
    backdrop: localImage('backdrop', details.backdrop_path),
    credits: JSON.stringify(castOf(details)),
    tmdbId: details.id,
    source,
    now: Date.now(),
  });
}

async function matchSeries(db, row) {
  const found = await search('tv', row.title, row.year);
  const details = found ? await fetchSeries(found.id) : null;
  if (details) applySeries(db, row.id, details, 'tmdb');
  else db.prepare('UPDATE series SET tmdb_checked_at = ? WHERE id = ?').run(Date.now(), row.id);
  return !!details;
}

function episodeName(name) {
  return name && !GENERIC_EPISODE_NAME.test(name.trim()) ? name : null;
}

/** Fills in season and episode metadata for episodes of a matched series that don't have it yet. */
async function updateEpisodes(db, series) {
  const now = Date.now();
  const episodes = db
    .prepare(
      `SELECT id, season_number, episode_number, title FROM media
       WHERE series_id = ? AND type = 'episode' AND metadata_source = 'filename'
         AND (tmdb_checked_at IS NULL OR tmdb_checked_at < ?)`
    )
    .all(series.id, now - RETRY_MS);
  if (!episodes.length) return;

  const updateSeason = db.prepare(
    'UPDATE seasons SET title = ?, overview = ?, poster = ? WHERE series_id = ? AND season_number = ?'
  );
  const updateEpisode = db.prepare(
    `UPDATE media SET title = @title, overview = @overview, still = @still, runtime = @runtime,
       rating = @rating, year = @year, tmdb_id = @tmdbId, metadata_source = 'tmdb', tmdb_checked_at = @now
     WHERE id = @id`
  );
  const markChecked = db.prepare('UPDATE media SET tmdb_checked_at = ? WHERE id = ?');

  const seasonNumbers = [...new Set(episodes.map((e) => e.season_number))];
  for (const seasonNumber of seasonNumbers) {
    const path = `/tv/${series.tmdb_id}/season/${seasonNumber}`;
    // Short cache: running shows get new episodes.
    const local = await tmdbGet(path, { language: LANGUAGE }, { ttlDays: 3 });
    const inSeason = episodes.filter((e) => e.season_number === seasonNumber);
    if (!local) {
      inSeason.forEach((e) => markChecked.run(now, e.id));
      continue;
    }

    const localEpisodes = local.episodes || [];
    const needsFallback = !local.overview || localEpisodes.some((e) => !episodeName(e.name) || !e.overview);
    const english = needsFallback ? await tmdbGet(path, { language: 'en-US' }, { ttlDays: 3 }) : null;
    const englishEpisodes = (english && english.episodes) || [];

    updateSeason.run(
      firstText(local.name, english && english.name),
      firstText(local.overview, english && english.overview),
      localImage('poster', local.poster_path),
      series.id,
      seasonNumber
    );

    db.transaction(() => {
      for (const episode of inSeason) {
        const tm = localEpisodes.find((e) => e.episode_number === episode.episode_number);
        if (!tm) {
          markChecked.run(now, episode.id);
          continue;
        }
        const en = englishEpisodes.find((e) => e.episode_number === episode.episode_number) || {};
        updateEpisode.run({
          id: episode.id,
          // A real name from TMDB, else the title from the file name, else none.
          title: firstText(episodeName(tm.name), episodeName(en.name), episode.title),
          overview: firstText(tm.overview, en.overview),
          still: localImage('still', tm.still_path),
          runtime: tm.runtime || null,
          rating: rating(tm),
          year: yearOf(tm.air_date),
          tmdbId: tm.id,
          now,
        });
      }
    })();
  }
}

// --- library refresh ------------------------------------------------------------------

// A scan that finishes while a refresh is running (e.g. files added by the folder watcher)
// asks for another pass, so its new items don't wait for the next scan.
let refreshAgain = false;

/** Matches everything that hasn't been matched yet. Runs after every scan, in the background. */
export async function refreshLibraryMetadata(db) {
  if (!isConfigured()) return;
  if (status.running) {
    refreshAgain = true;
    return;
  }
  refreshAgain = false;
  status.running = true;
  status.done = 0;
  status.error = null;

  const cutoff = Date.now() - RETRY_MS;
  const movies = db
    .prepare(
      `SELECT id, title, year FROM media WHERE type = 'movie' AND available = 1 AND metadata_source = 'filename'
       AND (tmdb_checked_at IS NULL OR tmdb_checked_at < ?)`
    )
    .all(cutoff);
  const series = db
    .prepare(
      `SELECT id, title, year FROM series WHERE available = 1 AND metadata_source = 'filename'
       AND (tmdb_checked_at IS NULL OR tmdb_checked_at < ?)`
    )
    .all(cutoff);
  status.total = movies.length + series.length;
  if (status.total) console.log(`TMDB: matching ${movies.length} movie(s) and ${series.length} series...`);

  let matched = 0;
  try {
    for (const row of movies) {
      if (await safely(() => matchMovie(db, row), row.title)) matched++;
      status.done++;
    }
    for (const row of series) {
      if (await safely(() => matchSeries(db, row), row.title)) matched++;
      status.done++;
    }
    const matchedSeries = db
      .prepare(`SELECT id, title, tmdb_id FROM series WHERE tmdb_id IS NOT NULL AND available = 1`)
      .all();
    for (const row of matchedSeries) {
      await safely(() => updateEpisodes(db, row), row.title);
    }
    if (status.total) console.log(`TMDB: matched ${matched} of ${status.total}.`);
  } catch (err) {
    // Only an invalid API key gets here; there's no point in continuing.
    status.error = err.message;
    console.error(`TMDB: ${err.message}. Check TMDB_API_KEY in server/.env.`);
  } finally {
    status.running = false;
  }

  // Posters and backdrops are small enough to fetch up front, so browsing is fast.
  const artwork = db
    .prepare(
      `SELECT poster, backdrop FROM media WHERE poster IS NOT NULL AND available = 1
       UNION ALL SELECT poster, backdrop FROM series WHERE poster IS NOT NULL AND available = 1`
    )
    .all();
  prefetchImages(artwork.flatMap((a) => [a.poster, a.backdrop])).catch(() => {});

  if (refreshAgain) await refreshLibraryMetadata(db);
}

/** Runs one item's TMDB work; network errors are logged and the item is retried next scan. */
async function safely(fn, label) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TmdbAuthError) throw err;
    console.warn(`TMDB: failed for "${label}": ${err.message}`);
    return false;
  }
}

// --- manual correction ----------------------------------------------------------------

export class MetadataError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Points a series at a TMDB TV id and refreshes all of its episodes. */
export async function setSeriesTmdbId(seriesId, tmdbId) {
  const db = getDb();
  if (!isConfigured()) throw new MetadataError(503, 'TMDB_API_KEY is not set');
  const series = db.prepare('SELECT id FROM series WHERE id = ?').get(seriesId);
  if (!series) throw new MetadataError(404, 'Series not found');

  const details = await fetchSeries(tmdbId);
  if (!details) throw new MetadataError(404, `TMDB TV id ${tmdbId} not found`);
  applySeries(db, seriesId, details, 'manual');

  // Episode data came from the old match: fetch it again for the new one.
  db.prepare(
    `UPDATE media SET metadata_source = 'filename', tmdb_checked_at = NULL, overview = NULL, still = NULL, tmdb_id = NULL
     WHERE series_id = ? AND metadata_source = 'tmdb'`
  ).run(seriesId);
  db.prepare('UPDATE seasons SET title = NULL, overview = NULL, poster = NULL WHERE series_id = ?').run(seriesId);
  await updateEpisodes(db, { id: seriesId, tmdb_id: details.id });
}

/** Points a movie at a TMDB movie id; for an episode, its series is corrected (TV id). */
export async function setMediaTmdbId(mediaId, tmdbId) {
  const db = getDb();
  const row = db.prepare('SELECT id, type, series_id FROM media WHERE id = ?').get(mediaId);
  if (!row) throw new MetadataError(404, 'Media not found');
  if (row.type === 'video') throw new MetadataError(400, 'Videos have no TMDB metadata');
  if (row.type === 'episode') return setSeriesTmdbId(row.series_id, tmdbId);

  if (!isConfigured()) throw new MetadataError(503, 'TMDB_API_KEY is not set');
  const details = await fetchMovie(tmdbId);
  if (!details) throw new MetadataError(404, `TMDB movie id ${tmdbId} not found`);
  applyMovie(db, mediaId, details, 'manual');
}

// --- search for a manual correction (desktop app) ----------------------------------

// A link copied from the TMDB website: https://www.themoviedb.org/movie/603-the-matrix
const TMDB_LINK = /themoviedb\.org\/(movie|tv)\/(\d+)/i;

function searchResult(item) {
  return {
    tmdbId: item.id,
    title: item.title || item.name || item.original_title || item.original_name,
    originalTitle: item.original_title || item.original_name || null,
    year: yearOf(item.release_date || item.first_air_date),
    overview: item.overview || '',
    // Small thumbnails straight from TMDB: only the desktop app shows these, never the TV.
    poster: item.poster_path ? `${config.tmdbImageUrl}/w92${item.poster_path}` : null,
  };
}

/**
 * Candidates for a manual match. `kind` is 'movie' or 'series'; `query` is a title,
 * a TMDB id or a link from themoviedb.org. Returns at most 20 results, best first.
 */
export async function searchTmdb(kind, query, year) {
  if (!isConfigured()) throw new MetadataError(503, 'TMDB_API_KEY is not set');
  const tv = kind === 'series';
  const text = String(query || '').trim();
  if (!text) return [];

  const results = [];
  const link = TMDB_LINK.exec(text);
  const id = link ? Number(link[2]) : /^\d+$/.test(text) ? Number(text) : null;
  if (id && (!link || (link[1].toLowerCase() === 'tv') === tv)) {
    const details = await (tv ? fetchSeries(id) : fetchMovie(id));
    if (details) results.push(searchResult(details));
  }
  // Titles can be numbers too ("1917"), so a number is also searched as a title.
  if (!link) {
    const found = await tmdbGet(
      tv ? '/search/tv' : '/search/movie',
      { query: text, language: LANGUAGE, include_adult: 'false', [tv ? 'first_air_date_year' : 'year']: year || undefined },
      { ttlDays: 1 }
    );
    for (const item of (found && found.results) || []) {
      if (!results.some((r) => r.tmdbId === item.id)) results.push(searchResult(item));
    }
  }
  return results.slice(0, 20);
}
