// Storyboards ("trickplay" thumbnails) for the seek preview in the TV player. ffmpeg takes one
// frame every few seconds and tiles the frames into JPEG sheets of 5x5 thumbnails. The TV shows
// the thumbnail of the seek target from a sheet it has already loaded, so the preview is instant.
//
// Only keyframes are decoded (-skip_frame nokey), so a 1080p HEVC movie takes ~30 s. A file's
// storyboard is generated when it is opened (details or player); STORYBOARDS=all also prepares
// the whole library in the background. One file at a time, at a low process priority.
//
// Until a storyboard is ready, the player asks for single frames (frameStream) instead.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { isFfmpegAvailable } from './embeddedSubtitles.js';

export const THUMB_WIDTH = 320;
export const THUMB_HEIGHT = 180;
const COLUMNS = 5;
const ROWS = 5;
const MIN_INTERVAL_S = 10;
const MAX_THUMBS = 1000; // very long files get a longer interval
const GENERATE_TIMEOUT_MS = 30 * 60 * 1000;
const FRAME_TIMEOUT_MS = 15000;
const MAX_FRAME_JOBS = 2;

// HDR frames look grey and washed out as plain JPEGs; this maps them to normal (SDR) colours.
// It runs after the downscale, so it costs next to nothing. Needs ffmpeg with zimg (zscale).
const TONEMAP_FILTER =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=full';

/**
 * Letterboxed to a fixed size, so every thumbnail has the same place in its sheet.
 * Converted to full-range YUV, which the JPEG encoder requires (it refuses some files otherwise).
 */
function thumbFilter(hdr) {
  const fit = `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=decrease`;
  const pad = `pad=${THUMB_WIDTH}:${THUMB_HEIGHT}:(ow-iw)/2:(oh-ih)/2`;
  return hdr ? `${fit},${TONEMAP_FILTER},format=yuvj420p,${pad}` : `${fit}:out_range=full,format=yuvj420p,${pad}`;
}

const hdrByPath = new Map(); // file path -> promise of true/false

/** Whether the video stream is HDR (PQ or HLG), from ffprobe; false when it can't tell. */
function isHdr(filePath) {
  if (!hdrByPath.has(filePath)) {
    const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer', '-of', 'csv=p=0', filePath];
    hdrByPath.set(
      filePath,
      new Promise((resolve) => {
        execFile(config.ffprobePath, args, { timeout: 10000, windowsHide: true }, (err, stdout) => {
          resolve(!err && /smpte2084|arib-std-b67/.test(String(stdout)));
        });
      })
    );
  }
  return hdrByPath.get(filePath);
}

// HDR files whose tone mapping failed (ffmpeg without zscale) get plain thumbnails from then on.
const tonemapFailed = new Set();

async function useTonemap(filePath) {
  return !tonemapFailed.has(filePath) && (await isHdr(filePath));
}

/** The cache folder of one version of a file: "12-1712345678901" (a replaced file gets a new one). */
function dirName(media) {
  return `${media.id}-${media.mtime_ms}`;
}

function intervalFor(duration) {
  if (!duration) return MIN_INTERVAL_S;
  // Short clips still get ~10 thumbnails (a clip shorter than the interval would get none).
  if (duration < MIN_INTERVAL_S * 6) return Math.max(1, Math.floor(duration / 10));
  return Math.max(MIN_INTERVAL_S, Math.ceil(duration / MAX_THUMBS));
}

function lowerPriority(child) {
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not allowed or already exited - it just runs at normal priority.
  }
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    lowerPriority(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
    });
  });
}

// --- reading -------------------------------------------------------------------------------

const manifests = new Map(); // dir name -> manifest (they never change once written)

function readManifest(media) {
  const name = dirName(media);
  if (manifests.has(name)) return manifests.get(name);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(config.storyboardCacheDir, name, 'manifest.json'), 'utf8'));
    manifests.set(name, manifest);
    return manifest;
  } catch {
    return null;
  }
}

/** What the TV needs to cut a thumbnail out of a sheet. */
function publicManifest(media, manifest) {
  const name = dirName(media);
  return {
    status: 'ready',
    interval: manifest.interval,
    width: manifest.width,
    height: manifest.height,
    columns: manifest.columns,
    rows: manifest.rows,
    count: manifest.count,
    sheets: manifest.sheets.map((file) => `/storyboards/${name}/${file}`),
  };
}

function mediaRow(db, mediaId) {
  return db.prepare('SELECT id, path, mtime_ms, duration FROM media WHERE id = ? AND available = 1').get(mediaId);
}

/**
 * The storyboard of a media file: { status: 'ready', interval, width, height, columns, rows, count, sheets }.
 * When it isn't generated yet, generation is started (ahead of the background queue) and
 * { status: 'pending' } is returned; { status: 'unavailable' } without ffmpeg or when it failed.
 */
export async function getStoryboard(db, mediaId) {
  const media = mediaRow(db, mediaId);
  if (!media) return null;
  const manifest = readManifest(media);
  if (manifest) return publicManifest(media, manifest);
  if (!(await isFfmpegAvailable()) || failed.has(dirName(media))) return { status: 'unavailable' };
  requestStoryboard(db, media.id);
  return { status: 'pending' };
}

/** Full path of a sheet, or null if the name isn't one of ours. */
export function sheetPath(dir, file) {
  if (!/^\d+-[\d.]+$/.test(dir) || !/^\d+\.jpg$/.test(file)) return null;
  const full = path.join(config.storyboardCacheDir, dir, file);
  return fs.existsSync(full) ? full : null;
}

// --- generating ----------------------------------------------------------------------------

const queue = []; // media ids, the next one first
let running = false;
const failed = new Set(); // dir names ffmpeg failed on - not retried until the server restarts

/** Deletes the storyboards of earlier versions of a file and leftovers of interrupted runs. */
async function removeStale(media) {
  const keep = dirName(media);
  const names = await fs.promises.readdir(config.storyboardCacheDir).catch(() => []);
  for (const name of names) {
    if (name !== keep && (name.startsWith(`${media.id}-`) || name === `${keep}.part`)) {
      await fs.promises.rm(path.join(config.storyboardCacheDir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function generate(media) {
  const final = path.join(config.storyboardCacheDir, dirName(media));
  const temp = final + '.part'; // renamed when complete, so a crash never leaves half a storyboard
  await removeStale(media);
  await fs.promises.mkdir(temp, { recursive: true });

  const interval = intervalFor(media.duration);
  const started = Date.now();
  const run = (hdr) =>
    runFfmpeg(
      [
        '-nostdin', '-v', 'error', '-skip_frame', 'nokey', '-i', media.path,
        '-an', '-sn', '-dn',
        '-vf', `fps=1/${interval},${thumbFilter(hdr)},tile=${COLUMNS}x${ROWS}`,
        '-q:v', '7', '-y', path.join(temp, '%d.jpg'),
      ],
      GENERATE_TIMEOUT_MS
    );
  try {
    if (await useTonemap(media.path)) {
      try {
        await run(true);
      } catch (err) {
        console.warn(`HDR tone mapping failed for ${path.basename(media.path)} (${err.message}) - using plain thumbnails`);
        tonemapFailed.add(media.path);
        await run(false);
      }
    } else {
      await run(false);
    }
    const sheets = (await fs.promises.readdir(temp))
      .filter((name) => /^\d+\.jpg$/.test(name))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    if (!sheets.length) throw new Error('no frames');

    const perSheet = COLUMNS * ROWS;
    const count = media.duration
      ? Math.min(Math.ceil(media.duration / interval), sheets.length * perSheet)
      : sheets.length * perSheet;
    const manifest = { interval, width: THUMB_WIDTH, height: THUMB_HEIGHT, columns: COLUMNS, rows: ROWS, count, sheets };
    await fs.promises.writeFile(path.join(temp, 'manifest.json'), JSON.stringify(manifest));
    await fs.promises.rename(temp, final);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`Storyboard for ${path.basename(media.path)}: ${count} thumbnails in ${seconds}s`);
  } catch (err) {
    failed.add(dirName(media));
    console.warn(`Storyboard failed for ${media.path}: ${err.message}`);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

async function runQueue(db) {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const media = mediaRow(db, queue.shift());
      if (media && !readManifest(media) && !failed.has(dirName(media))) await generate(media);
    }
  } finally {
    running = false;
  }
}

/** Puts a file at the front of the queue (it was just opened) and starts the queue. */
export function requestStoryboard(db, mediaId) {
  const media = mediaRow(db, mediaId);
  if (!media || readManifest(media) || failed.has(dirName(media))) return;
  const index = queue.indexOf(mediaId);
  if (index !== -1) queue.splice(index, 1);
  queue.unshift(mediaId);
  isFfmpegAvailable().then((available) => {
    if (available) runQueue(db).catch((err) => console.error('Storyboard queue failed:', err));
    else queue.length = 0;
  });
}

/** STORYBOARDS=all: queues every available file that has no storyboard yet (after a scan). */
export async function queueAllStoryboards(db) {
  if (!(await isFfmpegAvailable())) return;
  const rows = db.prepare('SELECT id, path, mtime_ms, duration FROM media WHERE available = 1 ORDER BY added_at DESC').all();
  let added = 0;
  for (const media of rows) {
    if (queue.indexOf(media.id) === -1 && !readManifest(media) && !failed.has(dirName(media))) {
      queue.push(media.id);
      added++;
    }
  }
  if (added) console.log(`Storyboards: ${added} file(s) queued`);
  runQueue(db).catch((err) => console.error('Storyboard queue failed:', err));
}

/** Deletes the storyboards of files that are no longer in the library (after a cleanup). */
export async function pruneStoryboards(db) {
  const known = new Set(db.prepare('SELECT id, mtime_ms FROM media').all().map(dirName));
  const names = await fs.promises.readdir(config.storyboardCacheDir).catch(() => []);
  let removed = 0;
  for (const name of names) {
    if (known.has(name) || /\.part$/.test(name)) continue;
    await fs.promises.rm(path.join(config.storyboardCacheDir, name), { recursive: true, force: true }).catch(() => {});
    manifests.delete(name);
    removed++;
  }
  return removed;
}

// --- single frames -----------------------------------------------------------------------

let frameJobs = 0;

/**
 * One thumbnail at `time` (seconds) as a JPEG stream, for the seek preview while the storyboard
 * is still being generated. Takes the keyframe before `time` (~0.5 s even for 1080p HEVC).
 * Returns null when ffmpeg is busy with other frames; the caller should answer 503.
 */
export async function frameStream(mediaPath, time) {
  if (frameJobs >= MAX_FRAME_JOBS) return null;
  frameJobs++;
  const hdr = await useTonemap(mediaPath);
  const child = spawn(
    config.ffmpegPath,
    [
      '-nostdin', '-v', 'error', '-noaccurate_seek', '-ss', String(Math.max(0, time)), '-i', mediaPath,
      '-frames:v', '1', '-an', '-sn', '-dn', '-vf', thumbFilter(hdr), '-q:v', '5', '-f', 'mjpeg', 'pipe:1',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const timer = setTimeout(() => child.kill(), FRAME_TIMEOUT_MS);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    frameJobs--;
    clearTimeout(timer);
  };
  child.on('close', finish);
  child.on('error', finish);
  return child;
}
