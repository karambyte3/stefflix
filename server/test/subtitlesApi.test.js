import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { scanLibrary } from '../src/services/scanner.js';

let tmp;
let db;
let server;
let base;
let roots;
let movieId;

const BG_SRT =
  '1\r\n00:00:01,000 --> 00:00:03,000\r\nЗдравей, как си?\r\n\r\n' +
  '2\r\n00:00:04,000 --> 00:00:06,000\r\n<i>Всичко ще бъде наред.</i>\r\n';
const EN_TEXT = Array.from({ length: 6 }, (_, i) =>
  `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\nWhat are you doing here? I told you to wait in the car.\n`
).join('\n');

function write(rel, content) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-subs-'));
  // Opening media details starts a storyboard; keep it out of the real cache.
  config.storyboardCacheDir = path.join(tmp, 'storyboards');
  write('Movies/Heat (1995)/Heat (1995).mkv', Buffer.alloc(2000, 1));
  write('Movies/Heat (1995)/Heat (1995).bg.srt', iconv.encode(BG_SRT, 'win1251'));
  write('Movies/Heat (1995)/Heat (1995).srt', EN_TEXT); // language guessed from the text
  write('Movies/Heat (1995)/Subs/German.vtt', 'WEBVTT\n\n00:01.000 --> 00:02.000\nHallo');
  write('Movies/Orphan.srt', BG_SRT); // no video -> ignored

  roots = { movie: [path.join(tmp, 'Movies')], episode: [], video: [] };
  db = initDb(':memory:');
  const stats = await scanLibrary(db, roots);
  assert.equal(stats.subtitles, 3);
  movieId = db.prepare("SELECT id FROM media WHERE type = 'movie'").get().id;

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the stream is never cached by the browser', async () => {
  const res = await fetch(`${base}/api/stream/${movieId}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  await res.arrayBuffer();
});

test('media details list the subtitles, Bulgarian first', async () => {
  const { body } = await api('GET', `/api/media/${movieId}`);
  assert.deepEqual(body.subtitles.map((s) => [s.language, s.format]), [['bg', 'srt'], ['en', 'srt'], ['de', 'vtt']]);
});

test('a Windows-1251 file is served as clean UTF-8 cues', async () => {
  const { body: media } = await api('GET', `/api/media/${movieId}`);
  const { status, headers, body } = await api('GET', `/api/subtitles/${media.subtitles[0].id}`);
  assert.equal(status, 200);
  assert.equal(headers.get('x-subtitle-encoding'), 'windows-1251');
  assert.deepEqual(body, [
    { start: 1, end: 3, text: 'Здравей, как си?' },
    { start: 4, end: 6, text: '<i>Всичко ще бъде наред.</i>' },
  ]);
});

test('re-scans keep subtitle ids; deleted files disappear', async () => {
  const before = db.prepare('SELECT id, path FROM subtitles ORDER BY id').all();
  await scanLibrary(db, roots);
  assert.deepEqual(db.prepare('SELECT id, path FROM subtitles ORDER BY id').all(), before);

  const german = before.find((s) => s.path.endsWith('German.vtt'));
  fs.rmSync(german.path);
  await scanLibrary(db, roots);
  assert.equal((await api('GET', `/api/subtitles/${german.id}`)).status, 404);
  assert.equal((await api('GET', `/api/media/${movieId}`)).body.subtitles.length, 2);
});

test('subtitle settings: defaults, partial update, validation', async () => {
  assert.deepEqual((await api('GET', '/api/settings/subtitles')).body, {
    size: 'M',
    color: '#ffffff',
    background: 'semi',
    position: 8,
    language: 'bg',
  });
  const updated = await api('PUT', '/api/settings/subtitles', { size: 'XL', color: '#FFEB3B' });
  assert.equal(updated.body.size, 'XL');
  assert.equal(updated.body.color, '#ffeb3b');
  assert.equal(updated.body.background, 'semi');
  assert.equal((await api('GET', '/api/settings/subtitles')).body.size, 'XL');

  assert.equal((await api('PUT', '/api/settings/subtitles', { size: 'huge' })).status, 400);
  assert.equal((await api('PUT', '/api/settings/subtitles', { color: 'red' })).status, 400);
  assert.equal((await api('PUT', '/api/settings/subtitles', { position: 99 })).status, 400);
});

test('subtitle offset is stored per media file', async () => {
  assert.deepEqual((await api('GET', `/api/subtitle-offset/${movieId}`)).body, { mediaId: movieId, offset: 0 });
  assert.deepEqual((await api('PUT', `/api/subtitle-offset/${movieId}`, { offset: 0.75 })).body, { mediaId: movieId, offset: 0.75 });
  assert.equal((await api('GET', `/api/subtitle-offset/${movieId}`)).body.offset, 0.75);

  await api('PUT', `/api/subtitle-offset/${movieId}`, { offset: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subtitle_offsets').get().n, 0);

  assert.equal((await api('PUT', `/api/subtitle-offset/${movieId}`, { offset: 'soon' })).status, 400);
  assert.equal((await api('GET', '/api/subtitle-offset/999999')).status, 404);
});
