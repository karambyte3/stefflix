// "Search online" from the TV: finds subtitles for one movie / episode / video on OpenSubtitles.com
// and saves the chosen one next to the video ("Movie.bg.opensubtitles-123456.srt"), where the
// scanner picks it up like any other external subtitle file.
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { startFreshScan } from './libraryScan.js';
import { downloadSubtitle, movieHash, OpenSubtitlesError, searchSubtitles } from './openSubtitles.js';
import { decodeSubtitle, parseSubtitles } from './subtitles.js';

const MAX_RESULTS = 40;
const SEARCH_CACHE_MS = 10 * 60 * 1000;
const FILE_TAG = 'opensubtitles';

export class OnlineSubtitlesError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const STATUS_BY_CODE = { not_configured: 503, auth: 502, quota: 429, unavailable: 502 };

/** OpenSubtitles errors -> HTTP-ready errors for the route. */
function wrap(err) {
  if (err instanceof OpenSubtitlesError) {
    return new OnlineSubtitlesError(STATUS_BY_CODE[err.code] || 502, err.code, err.message, { resetTime: err.resetTime });
  }
  return err;
}

function mediaRow(db, mediaId) {
  const row = db
    .prepare(
      `SELECT media.*, series.title AS series_title, series.tmdb_id AS series_tmdb_id
       FROM media LEFT JOIN series ON series.id = media.series_id WHERE media.id = ?`
    )
    .get(mediaId);
  if (!row) throw new OnlineSubtitlesError(404, 'not_found', 'Media not found');
  if (!row.available) throw new OnlineSubtitlesError(404, 'not_found', 'Media file is not available');
  return row;
}

/** Search parameters: TMDB ids when the item is matched, otherwise its title. */
function searchParams(row, languages, hash) {
  const params = { languages: languages.join(','), moviehash: hash || undefined };
  if (row.type === 'episode') {
    Object.assign(params, { type: 'episode', season_number: row.season_number, episode_number: row.episode_number });
    if (row.series_tmdb_id) params.parent_tmdb_id = row.series_tmdb_id;
    else params.query = row.series_title;
  } else if (row.type === 'movie') {
    params.type = 'movie';
    if (row.tmdb_id) params.tmdb_id = row.tmdb_id;
    else Object.assign(params, { query: row.title, year: row.year || undefined });
  } else {
    params.query = row.title;
  }
  return params;
}

/** The API's language codes are ISO 639-1, sometimes with a region ("pt-br", "zh-cn"). */
function baseLanguage(code) {
  return code ? String(code).toLowerCase().split('-')[0] : null;
}

function toResult(item, languages) {
  const a = item.attributes || {};
  const files = a.files || [];
  if (files.length !== 1) return null; // multi-CD releases don't fit one video file
  const tags = [];
  if (a.hearing_impaired) tags.push('sdh');
  if (a.foreign_parts_only) tags.push('forced');
  return {
    fileId: files[0].file_id,
    language: baseLanguage(a.language),
    tags,
    release: a.release || files[0].file_name || '',
    downloads: a.download_count || 0,
    hashMatch: !!a.moviehash_match,
    machineTranslated: !!(a.ai_translated || a.machine_translated),
    trusted: !!a.from_trusted,
    languageRank: languages.indexOf(baseLanguage(a.language)),
  };
}

/** Preferred language first, then subtitles timed for this exact file, then the most downloaded. */
function compareResults(a, b) {
  const rank = (r) => (r.languageRank === -1 ? 99 : r.languageRank);
  return (
    rank(a) - rank(b) ||
    Number(b.hashMatch) - Number(a.hashMatch) ||
    Number(a.machineTranslated) - Number(b.machineTranslated) ||
    b.downloads - a.downloads
  );
}

const searchCache = new Map(); // "mediaId|languages" -> { at, results }

/**
 * Subtitles for a media item on OpenSubtitles, best first:
 * [{ fileId, language, tags, release, downloads, hashMatch, machineTranslated, downloaded }]
 */
export async function searchOnline(mediaId, languages) {
  const db = getDb();
  const row = mediaRow(db, mediaId);
  const langs = languages.map(baseLanguage).filter(Boolean);
  if (!langs.length) throw new OnlineSubtitlesError(400, 'bad_request', 'No languages given');

  const key = `${mediaId}|${langs.join(',')}`;
  const cached = searchCache.get(key);
  let results;
  if (cached && cached.at > Date.now() - SEARCH_CACHE_MS) {
    results = cached.results;
  } else {
    const hash = await movieHash(row.path).catch(() => null);
    try {
      // Two searches (they don't count against the quota): by file hash, for subtitles timed to
      // this exact release, and by TMDB id / title for everything else.
      const byHash = hash ? await searchSubtitles(searchParams(row, langs, hash)) : [];
      const byId = await searchSubtitles(searchParams(row, langs, null));
      const merged = new Map();
      for (const result of byHash.concat(byId).map((item) => toResult(item, langs)).filter(Boolean)) {
        const known = merged.get(result.fileId);
        if (known) known.hashMatch = known.hashMatch || result.hashMatch;
        else merged.set(result.fileId, result);
      }
      results = Array.from(merged.values())
        .sort(compareResults)
        .slice(0, MAX_RESULTS)
        .map(({ languageRank, trusted, ...result }) => result);
    } catch (err) {
      throw wrap(err);
    }
    searchCache.set(key, { at: Date.now(), results });
  }

  // Mark the ones already saved next to the video (choosing them again costs no download).
  return results.map((result) => ({ ...result, downloaded: fs.existsSync(targetPath(row, result)) }));
}

/** "D:\Movies\Heat (1995).mkv" -> "D:\Movies\Heat (1995).bg.sdh.opensubtitles-123.srt" */
function targetPath(row, result) {
  const base = row.path.slice(0, row.path.length - path.extname(row.path).length);
  const parts = [base, result.language || 'und'].concat(result.tags, `${FILE_TAG}-${result.fileId}`, 'srt');
  return parts.join('.');
}

/** The subtitles row of a file, in the shape of the media details' `subtitles`. */
function subtitleOf(db, filePath) {
  const row = db.prepare('SELECT id, language, format, tags FROM subtitles WHERE path = ? AND available = 1').get(filePath);
  if (!row) return null;
  return { id: row.id, language: row.language, format: row.format, tags: JSON.parse(row.tags), embedded: false, title: null };
}

/**
 * Downloads one search result and saves it next to the video. `choice` is a result from
 * searchOnline ({ fileId, language, tags }). Returns { subtitle, remaining, resetTime }.
 */
export async function downloadOnline(mediaId, choice) {
  const db = getDb();
  const row = mediaRow(db, mediaId);
  const fileId = Number(choice && choice.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) throw new OnlineSubtitlesError(400, 'bad_request', 'fileId is required');
  const result = {
    fileId,
    language: baseLanguage(choice.language),
    tags: (Array.isArray(choice.tags) ? choice.tags : []).filter((tag) => tag === 'sdh' || tag === 'forced'),
  };
  const target = targetPath(row, result);

  let remaining = null;
  let resetTime = null;
  if (!fs.existsSync(target)) {
    let download;
    try {
      download = await downloadSubtitle(fileId);
    } catch (err) {
      throw wrap(err);
    }
    remaining = download.remaining;
    resetTime = download.resetTime;

    const { text } = decodeSubtitle(download.content);
    if (!parseSubtitles(text).length) {
      throw new OnlineSubtitlesError(502, 'unavailable', 'The downloaded file has no subtitles in it');
    }
    try {
      // Always saved as UTF-8, whatever the uploader used.
      await fs.promises.writeFile(target, text, 'utf8');
    } catch (err) {
      const readOnly = err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS';
      throw new OnlineSubtitlesError(readOnly ? 409 : 500, readOnly ? 'read_only' : 'write_failed', `Cannot save ${target}: ${err.message}`);
    }
    console.log(`Downloaded subtitles from OpenSubtitles: ${target}`);
  }

  // The folder watcher would notice the file too; scanning now lets the TV use it right away.
  await startFreshScan();
  const subtitle = subtitleOf(db, target);
  if (!subtitle) throw new OnlineSubtitlesError(500, 'write_failed', 'The subtitle file was saved but not picked up by the scan');
  return { subtitle, remaining, resetTime };
}
