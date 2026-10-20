import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { isFfmpegAvailable } from '../src/services/embeddedSubtitles.js';
import { isFfprobeAvailable, probePendingMedia } from '../src/services/probe.js';
import { scanLibrary } from '../src/services/scanner.js';
import { pruneStoryboards } from '../src/services/storyboard.js';

// Needs ffmpeg + ffprobe on PATH (or FFMPEG_PATH / FFPROBE_PATH).
const tools = (await isFfprobeAvailable()) && (await isFfmpegAvailable());
const skip = tools ? false : 'ffmpeg/ffprobe not installed';

let tmp;
let db;
let server;
let base;
const originalCacheDir = config.storyboardCacheDir;

before(async () => {
  if (!tools) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-storyboard-'));
  config.storyboardCacheDir = path.join(tmp, 'cache');

  const movies = path.join(tmp, 'Movies');
  fs.mkdirSync(movies);
  const video = (seconds, name) =>
    execFileSync(
      config.ffmpegPath,
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=128x72:d=${seconds}:r=5`, '-c:v', 'libx264', '-g', '10',
        path.join(movies, name)],
      { windowsHide: true }
    );
  // 75 s with a keyframe every 2 s: 8 thumbnails at the 10 s interval, one 5x5 sheet.
  video(75, 'Heat (1995).mp4');
  // Shorter than the usual interval.
  video(8, 'Ronin (1998).mp4');

  db = initDb(':memory:');
  await scanLibrary(db, { movie: [movies], episode: [], video: [] });
  await probePendingMedia(db);

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  config.storyboardCacheDir = originalCacheDir;
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function mediaId(title = 'Heat') {
  return db.prepare('SELECT id FROM media WHERE title = ?').get(title).id;
}

async function waitForStoryboard(id) {
  for (let i = 0; i < 100; i++) {
    const body = await (await fetch(`${base}/api/media/${id}/storyboard`)).json();
    if (body.status !== 'pending') return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('storyboard was not generated');
}

test('a storyboard is generated on request and its sheets are served', { skip }, async () => {
  const storyboard = await waitForStoryboard(mediaId());
  assert.equal(storyboard.status, 'ready');
  assert.equal(storyboard.interval, 10);
  assert.equal(storyboard.count, 8);
  assert.deepEqual([storyboard.width, storyboard.height, storyboard.columns, storyboard.rows], [320, 180, 5, 5]);
  assert.equal(storyboard.sheets.length, 1);

  const res = await fetch(base + storyboard.sheets[0]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8]);
});

test('a clip shorter than the interval gets thumbnails every second', { skip }, async () => {
  const storyboard = await waitForStoryboard(mediaId('Ronin'));
  assert.equal(storyboard.status, 'ready');
  assert.equal(storyboard.interval, 1);
  assert.equal(storyboard.count, 8);
});

test('a single frame is returned as a JPEG', { skip }, async () => {
  const res = await fetch(`${base}/api/media/${mediaId()}/frame?t=30`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 1000);
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8]);
});

test('sheet names outside the cache folder are refused', { skip }, async () => {
  assert.equal((await fetch(`${base}/storyboards/..%2F..%2Fdata/1.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/storyboards/1-1/manifest.json`)).status, 404);
});

test('storyboards of removed files are pruned', { skip }, async () => {
  await waitForStoryboard(mediaId('Heat'));
  await waitForStoryboard(mediaId('Ronin'));
  assert.equal(fs.readdirSync(config.storyboardCacheDir).length, 2);
  db.prepare('DELETE FROM media').run();
  assert.equal(await pruneStoryboards(db), 2);
  assert.equal(fs.readdirSync(config.storyboardCacheDir).length, 0);
});
