// Small TMDB API client: throttled, retried on 429, and cached in SQLite.
// https://developer.themoviedb.org/docs
import { config } from '../config.js';
import { getDb } from '../db/index.js';

// TMDB allows roughly 50 requests/second per IP; stay well below that.
const MAX_CONCURRENT = 4;
const MIN_INTERVAL_MS = 60;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class TmdbAuthError extends Error {}

export function isConfigured() {
  return !!config.tmdbApiKey;
}

// v4 "API Read Access Tokens" are long JWTs sent as a Bearer header;
// v3 API keys are 32 hex characters sent as ?api_key=.
function isBearerToken() {
  return config.tmdbApiKey.length > 40;
}

// --- throttling ------------------------------------------------------------------

const queue = [];
let active = 0;
let lastStart = 0;
let timer = null;

function pump() {
  if (timer) return;
  while (queue.length && active < MAX_CONCURRENT) {
    const wait = lastStart + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, wait);
      return;
    }
    const job = queue.shift();
    active++;
    lastStart = Date.now();
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

function throttled(run) {
  return new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    pump();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- requests ----------------------------------------------------------------------

function sortedQuery(params) {
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== '') search.set(key, String(params[key]));
  }
  return search;
}

async function request(path, params) {
  const url = new URL(config.tmdbApiUrl + path);
  url.search = sortedQuery(params).toString();
  const headers = { Accept: 'application/json' };
  if (isBearerToken()) headers.Authorization = `Bearer ${config.tmdbApiKey}`;
  else url.searchParams.set('api_key', config.tmdbApiKey);

  for (let attempt = 0; ; attempt++) {
    const res = await throttled(() => fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
      continue;
    }
    if (res.status === 401) throw new TmdbAuthError('TMDB rejected the API key (401)');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`TMDB ${path}: HTTP ${res.status}`);
    return res.json();
  }
}

/**
 * GET from the TMDB API, answered from the SQLite cache while it's younger than `ttlDays`.
 * Returns null for a 404 (also cached, so missing IDs aren't asked for again and again).
 */
export async function tmdbGet(path, params, options) {
  const ttlDays = (options && options.ttlDays) || 14;
  const key = `${path}?${sortedQuery(params || {}).toString()}`;
  const db = getDb();

  const cached = db.prepare('SELECT body, fetched_at FROM tmdb_cache WHERE key = ?').get(key);
  if (cached && Date.now() - cached.fetched_at < ttlDays * DAY_MS) return JSON.parse(cached.body);

  const data = await request(path, params || {});
  db.prepare('INSERT OR REPLACE INTO tmdb_cache (key, body, fetched_at) VALUES (?, ?, ?)').run(
    key,
    JSON.stringify(data),
    Date.now()
  );
  return data;
}
