// Artwork: TMDB images are downloaded once into server/cache/images/<size>/ and served
// from /images/<size>/<file> - the TV never talks to TMDB. Items without artwork get a
// generated SVG placeholder poster.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// One size per use, matched to how big the TV shows it (see tv-app CSS).
export const IMAGE_SIZES = {
  poster: 'w342',
  backdrop: 'w1280',
  profile: 'w185',
  still: 'w300',
};
const ALLOWED_SIZES = Object.values(IMAGE_SIZES);
const FILE_NAME = /^[A-Za-z0-9_-]+\.(jpg|jpeg|png)$/;
const MAX_DOWNLOADS = 6;

/** TMDB file path ("/abc.jpg") -> local URL path ("/images/w342/abc.jpg"), or null. */
export function localImage(kind, tmdbPath) {
  if (!tmdbPath) return null;
  return `/images/${IMAGE_SIZES[kind]}/${tmdbPath.replace(/^\//, '')}`;
}

export function isValidImage(size, file) {
  return ALLOWED_SIZES.includes(size) && FILE_NAME.test(file);
}

// --- download-once cache ----------------------------------------------------------

const inFlight = new Map(); // "size/file" -> Promise<string|null>
let activeDownloads = 0;
const waiting = [];

async function withDownloadSlot(fn) {
  if (activeDownloads >= MAX_DOWNLOADS) await new Promise((resolve) => waiting.push(resolve));
  activeDownloads++;
  try {
    return await fn();
  } finally {
    activeDownloads--;
    const next = waiting.shift();
    if (next) next();
  }
}

async function download(size, file, target) {
  const res = await fetch(`${config.tmdbImageUrl}/${size}/${file}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  const data = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  // Write to a temp file first, so a half-written image is never served.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, target);
  return target;
}

/**
 * Returns the absolute path of a cached image, downloading it from TMDB the first time.
 * Returns null if it can't be found or downloaded.
 */
export async function ensureImage(size, file) {
  if (!isValidImage(size, file)) return null;
  const target = path.join(config.imageCacheDir, size, file);
  if (fs.existsSync(target)) return target;

  const key = `${size}/${file}`;
  if (!inFlight.has(key)) {
    const job = withDownloadSlot(() => download(size, file, target))
      .catch((err) => {
        console.warn(`Image download failed (${key}): ${err.message}`);
        return null;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return inFlight.get(key);
}

/** Downloads images in the background, e.g. posters right after matching, so browsing is fast. */
export async function prefetchImages(localPaths) {
  for (const localPath of localPaths) {
    if (!localPath) continue;
    const [, , size, file] = localPath.split('/'); // "/images/w342/abc.jpg"
    await ensureImage(size, file);
  }
}

// --- placeholder posters -----------------------------------------------------------

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

function hashOf(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** Splits a title into lines of at most ~`width` characters (max 5 lines). */
function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 5) {
    lines.length = 5;
    lines[4] += '…';
  }
  return lines;
}

/** A 2:3 SVG poster with the title (and year) on a colour derived from the title. */
export function placeholderSvg(title, year) {
  const h = hashOf(title || '') % 360;
  const lines = wrap(title || '?', 12);
  const lineHeight = 46;
  const top = 256 - (lines.length * lineHeight) / 2 + 30;
  const text = lines
    .map((line, i) => `<text x="171" y="${top + i * lineHeight}">${escapeXml(line)}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513" viewBox="0 0 342 513">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
    <stop offset="0" stop-color="hsl(${h},35%,30%)"/><stop offset="1" stop-color="hsl(${h},40%,10%)"/>
  </linearGradient></defs>
  <rect width="342" height="513" fill="url(#g)"/>
  <g font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="700" fill="#fff" text-anchor="middle">${text}</g>
  ${year ? `<text x="171" y="470" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="rgba(255,255,255,0.7)" text-anchor="middle">${year}</text>` : ''}
</svg>`;
}

/** Placeholder URL for an item without a poster; the hash changes when the title does. */
export function placeholderUrl(kind, id, title, year) {
  return `/images/placeholder/${kind}/${id}.svg?v=${hashOf(`${title}|${year}`).toString(36)}`;
}
