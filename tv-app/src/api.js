// Thin client for the home-stream server API.
import { getServerUrl } from './config.js';

const DEFAULT_TIMEOUT_MS = 8000;

// Chromium 53 has no AbortController, so a timeout is a race against a timer.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function request(baseUrl, path, options) {
  const opts = options || {};
  const res = await withTimeout(
    fetch(baseUrl + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
    opts.timeout || DEFAULT_TIMEOUT_MS
  );
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    // Error bodies are { error: "quota", message, ... } - the code lets screens explain what happened.
    const data = await res.json().catch(() => null);
    err.code = data && data.error ? data.error : null;
    err.data = data;
    throw err;
  }
  return res.json();
}

function base() {
  const url = getServerUrl();
  if (!url) throw new Error('Server address is not configured');
  return url;
}

function get(path) {
  return request(base(), path);
}

/** { genre: 'Драма', sort: 'title' } -> "?genre=%D0%94...&sort=title" (empty values are skipped) */
function query(params) {
  const parts = [];
  for (const key in params) {
    const value = params[key];
    if (value !== undefined && value !== null) parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/** Checks a server address before it is saved. */
export function testConnection(serverUrl) {
  return request(serverUrl, '/api/health', { timeout: 5000 }).then((data) => {
    if (!data || data.ok !== true) throw new Error('Unexpected response');
    return data;
  });
}

export const getHome = () => get('/api/home');
export const getMovies = (params) => get('/api/movies' + query(params || {}));
export const getSeriesList = (params) => get('/api/series' + query(params || {}));
export const getSeries = (id) => get(`/api/series/${encodeURIComponent(id)}`);
export const getVideos = (params) => get('/api/videos' + query(params || {}));
export const getVideoCategories = () => get('/api/videos/categories');
export const getGenres = (type) => get('/api/genres' + query({ type }));
export const getMedia = (id) => get(`/api/media/${encodeURIComponent(id)}`);

// Subtitles embedded in a large video are extracted on first use, which can take a while.
export const getSubtitles = (id) => request(base(), `/api/subtitles/${encodeURIComponent(id)}`, { timeout: 180000 });
// OpenSubtitles: searching is free, a download counts against the server's daily limit.
export const searchOnlineSubtitles = (mediaId, languages) =>
  request(base(), `/api/media/${encodeURIComponent(mediaId)}/subtitles/online` + query({ languages: languages.join(',') }), {
    timeout: 30000,
  });
export const downloadOnlineSubtitle = (mediaId, result) =>
  request(base(), `/api/media/${encodeURIComponent(mediaId)}/subtitles/online`, {
    method: 'POST',
    body: { fileId: result.fileId, language: result.language, tags: result.tags },
    timeout: 60000,
  });
export const getSubtitleSettings = () => get('/api/settings/subtitles');
export const updateSubtitleSettings = (patch) => request(base(), '/api/settings/subtitles', { method: 'PUT', body: patch });
export const getSubtitleOffset = (mediaId) => get(`/api/subtitle-offset/${encodeURIComponent(mediaId)}`);
export const setSubtitleOffset = (mediaId, offset) =>
  request(base(), `/api/subtitle-offset/${encodeURIComponent(mediaId)}`, { method: 'PUT', body: { offset } });

export const saveProgress = (mediaId, position, duration) =>
  request(base(), '/api/progress', { method: 'POST', body: { mediaId, position, duration } });
export const getNextEpisode = (id) => get(`/api/episodes/${encodeURIComponent(id)}/next`);
export const setWatched = (mediaId, watched) =>
  request(base(), `/api/media/${encodeURIComponent(mediaId)}/watched`, { method: 'PUT', body: { watched } });
export const setSeriesWatched = (seriesId, watched) =>
  request(base(), `/api/series/${encodeURIComponent(seriesId)}/watched`, { method: 'PUT', body: { watched } });

export const startLibraryScan = () => request(base(), '/api/library/scan', { method: 'POST' });
export const getLibraryStatus = () => get('/api/library/status');
export const cleanUpLibrary = () => request(base(), '/api/library/cleanup', { method: 'POST' });

export function streamUrl(mediaId) {
  return `${base()}/api/stream/${encodeURIComponent(mediaId)}`;
}

/** Seek preview thumbnails: { status: 'ready', interval, width, height, columns, rows, count, sheets } or { status: 'pending' | 'unavailable' }. */
export const getStoryboard = (mediaId) => get(`/api/media/${encodeURIComponent(mediaId)}/storyboard`);

/** A single preview thumbnail, for when the storyboard isn't ready yet. */
export function frameUrl(mediaId, seconds) {
  return `${base()}/api/media/${encodeURIComponent(mediaId)}/frame?t=${Math.round(seconds)}`;
}

/** Server image paths ("/images/...") become absolute URLs; null stays null. */
export function imageUrl(path) {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : base() + path;
}
