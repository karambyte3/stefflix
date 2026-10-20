// Small OpenSubtitles.com REST API client (https://opensubtitles.stoplight.io/docs/opensubtitles-api).
// Every request carries the API key and the app's User-Agent; with a username/password the client
// logs in once a day, which raises the download limit. Searching is free, only downloads count.
import fs from 'node:fs';
import { config } from '../config.js';

const REQUEST_TIMEOUT_MS = 20000;
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // tokens are valid for 24 hours
// The API allows ~5 requests a second; one at a time with a short gap is plenty for a TV remote.
const MIN_INTERVAL_MS = 250;

export class OpenSubtitlesError extends Error {
  /** code: not_configured | auth | quota | unavailable */
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export function isConfigured() {
  return !!config.openSubtitlesApiKey;
}

let session = null; // { token, baseUrl, expiresAt }
let lastRequest = 0;
let chain = Promise.resolve();

/** Runs requests one after another, at most one per MIN_INTERVAL_MS. */
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequest = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

async function send(url, { method = 'GET', body, token } = {}) {
  const headers = {
    'Api-Key': config.openSubtitlesApiKey,
    'User-Agent': config.openSubtitlesUserAgent,
    Accept: 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await throttled(() =>
      fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    );
  } catch (err) {
    throw new OpenSubtitlesError('unavailable', `OpenSubtitles is not reachable: ${err.message}`);
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data: data || {} };
}

function errorMessage(data, fallback) {
  return (data && (data.message || (data.errors && data.errors.join(', ')))) || fallback;
}

/** Logs in with the configured account (once a day). Returns the token, or null without an account. */
async function login(force) {
  if (!config.openSubtitlesUsername) return null;
  if (!force && session && session.expiresAt > Date.now()) return session.token;

  const { status, data } = await send(`${config.openSubtitlesUrl}/login`, {
    method: 'POST',
    body: { username: config.openSubtitlesUsername, password: config.openSubtitlesPassword },
  });
  if (status === 401 || status === 403) {
    session = null;
    throw new OpenSubtitlesError('auth', `OpenSubtitles login failed: ${errorMessage(data, `HTTP ${status}`)}`);
  }
  if (status !== 200 || !data.token) {
    throw new OpenSubtitlesError('unavailable', `OpenSubtitles login failed: ${errorMessage(data, `HTTP ${status}`)}`);
  }
  // VIP accounts are told to use another host ("vip-api.opensubtitles.com").
  let baseUrl = config.openSubtitlesUrl;
  if (data.base_url && /(^|\.)opensubtitles\.com$/.test(data.base_url) && /opensubtitles\.com/.test(baseUrl)) {
    baseUrl = `https://${data.base_url}/api/v1`;
  }
  session = { token: data.token, baseUrl, expiresAt: Date.now() + TOKEN_TTL_MS };
  return session.token;
}

/** An API call with login and one re-login when the token has expired. */
async function call(path, options) {
  if (!isConfigured()) throw new OpenSubtitlesError('not_configured', 'OPENSUBTITLES_API_KEY is not set');
  let token = await login(false);
  let base = session && token ? session.baseUrl : config.openSubtitlesUrl;
  let result = await send(base + path, { ...options, token });
  if (result.status === 401 && token) {
    token = await login(true);
    base = session.baseUrl;
    result = await send(base + path, { ...options, token });
  }
  if (result.status === 401 || result.status === 403) {
    throw new OpenSubtitlesError('auth', `OpenSubtitles rejected the API key: ${errorMessage(result.data, `HTTP ${result.status}`)}`);
  }
  return result;
}

/**
 * GET /subtitles. The API wants the parameters sorted and lowercase (it redirects otherwise).
 * Returns the raw `data` array.
 */
export async function searchSubtitles(params) {
  const query = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${encodeURIComponent(String(params[key]).toLowerCase())}`)
    .join('&');
  const { status, data } = await call(`/subtitles?${query}`);
  if (status === 429) throw new OpenSubtitlesError('unavailable', 'OpenSubtitles: too many requests, try again in a moment');
  if (status !== 200) throw new OpenSubtitlesError('unavailable', `OpenSubtitles search failed: ${errorMessage(data, `HTTP ${status}`)}`);
  return data.data || [];
}

/**
 * POST /download, then fetches the file. Counts against the daily quota.
 * Returns { content: Buffer, remaining, resetTime }.
 */
export async function downloadSubtitle(fileId) {
  const { status, data } = await call('/download', { method: 'POST', body: { file_id: fileId, sub_format: 'srt' } });
  // 406: the daily download limit is used up.
  if (status === 406 || (status === 200 && !data.link && data.remaining !== undefined && data.remaining <= 0)) {
    throw new OpenSubtitlesError('quota', errorMessage(data, 'Daily download limit reached'), {
      resetTime: data.reset_time_utc || null,
    });
  }
  if (status !== 200 || !data.link) {
    throw new OpenSubtitlesError('unavailable', `OpenSubtitles download failed: ${errorMessage(data, `HTTP ${status}`)}`);
  }

  let res;
  try {
    res = await fetch(data.link, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new OpenSubtitlesError('unavailable', `Subtitle file download failed: ${err.message}`);
  }
  if (!res.ok) throw new OpenSubtitlesError('unavailable', `Subtitle file download failed: HTTP ${res.status}`);
  return {
    content: Buffer.from(await res.arrayBuffer()),
    remaining: typeof data.remaining === 'number' ? data.remaining : null,
    resetTime: data.reset_time_utc || null,
  };
}

/**
 * The OpenSubtitles "movie hash": file size plus the 64-bit little-endian words of the first and
 * last 64 KB, modulo 2^64, as 16 hex digits. It finds subtitles timed for this exact release.
 */
export async function movieHash(filePath) {
  const CHUNK = 64 * 1024;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < CHUNK) return null;
    const head = Buffer.alloc(CHUNK);
    const tail = Buffer.alloc(CHUNK);
    await handle.read(head, 0, CHUNK, 0);
    await handle.read(tail, 0, CHUNK, size - CHUNK);
    let hash = BigInt(size);
    for (const buffer of [head, tail]) {
      for (let i = 0; i < CHUNK; i += 8) hash += buffer.readBigUInt64LE(i);
    }
    return BigInt.asUintN(64, hash).toString(16).padStart(16, '0');
  } finally {
    await handle.close();
  }
}

/** For tests: forget the login. */
export function resetSession() {
  session = null;
}
