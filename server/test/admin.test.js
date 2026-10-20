import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { desktopOnly } from '../src/routes/admin.js';
import { refreshLibraryMetadata } from '../src/services/metadata.js';
import { scanLibrary } from '../src/services/scanner.js';
import { FAKE_API_KEY, startFakeTmdb } from './helpers/fakeTmdb.js';

let tmp;
let db;
let fake;
let server;
let base;
let roots;

function file(rel) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(1000, 1));
  return full;
}

async function get(url, headers) {
  const res = await fetch(base + url, { headers });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-admin-'));
  fake = await startFakeTmdb();
  config.tmdbApiKey = FAKE_API_KEY;
  config.tmdbApiUrl = fake.apiUrl;
  config.tmdbImageUrl = fake.imageUrl;
  config.imageCacheDir = path.join(tmp, 'cache');

  file('Movies/The Matrix (1999)/The Matrix (1999).mkv');
  file('Movies/Nothing Like This (2001).avi'); // not on TMDB, and AVI is a risky container
  file('Series/Breaking Bad/Season 01/Breaking Bad S01E01.mkv');

  roots = { movie: [path.join(tmp, 'Movies')], episode: [path.join(tmp, 'Series')], video: [] };
  db = initDb(':memory:');
  await scanLibrary(db, roots);
  await refreshLibraryMetadata(db);

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('GET /api/admin/library lists titles with their match, and the problems', async () => {
  const { status, body } = await get('/api/admin/library');
  assert.equal(status, 200);
  assert.deepEqual(
    { movies: body.counts.movies, series: body.counts.series, episodes: body.counts.episodes, missing: body.counts.missing },
    { movies: 2, series: 1, episodes: 1, missing: 0 }
  );
  assert.equal(body.counts.totalBytes, 3000);

  const byTitle = Object.fromEntries(body.titles.map((t) => [t.originalTitle || t.title, t]));
  assert.equal(byTitle['The Matrix'].source, 'tmdb');
  assert.equal(byTitle['The Matrix'].tmdbId, 603);
  assert.equal(byTitle['Breaking Bad'].kind, 'series');
  assert.match(byTitle['Breaking Bad'].path, /Breaking Bad S01E01\.mkv$/);
  assert.equal(byTitle['Nothing Like This'].source, 'filename');
  assert.match(byTitle['Nothing Like This'].poster, /^\/images\/placeholder\/movie\//);

  assert.equal(body.incompatible.length, 1);
  assert.match(body.incompatible[0].path, /\.avi$/);
  assert.deepEqual(body.incompatible[0].warnings, [{ code: 'container', value: 'avi' }]);
  assert.equal(typeof body.scan.scanning, 'boolean');
  assert.equal(typeof body.ffprobe, 'boolean');
});

test('missing files are listed with the episode name', async () => {
  const episode = path.join(tmp, 'Series/Breaking Bad/Season 01/Breaking Bad S01E01.mkv');
  fs.renameSync(episode, `${episode}.bak`);
  await scanLibrary(db, roots);
  try {
    const { body } = await get('/api/admin/library');
    assert.equal(body.counts.missing, 1);
    assert.equal(body.missing[0].type, 'episode');
    assert.match(body.missing[0].title, /S01E01/);
  } finally {
    fs.renameSync(`${episode}.bak`, episode);
    await scanLibrary(db, roots);
  }
});

test('GET /api/admin/tmdb/search finds by title, id and themoviedb.org link', async () => {
  const byTitle = await get('/api/admin/tmdb/search?kind=movie&query=matrix');
  assert.equal(byTitle.status, 200);
  assert.equal(byTitle.body[0].tmdbId, 603);
  assert.equal(byTitle.body[0].year, 1999);
  assert.equal(byTitle.body[0].originalTitle, 'The Matrix');

  const byId = await get('/api/admin/tmdb/search?kind=movie&query=603');
  assert.equal(byId.body[0].tmdbId, 603);
  assert.match(byId.body[0].poster, /\/w92\/matrix\.jpg$/);

  const byLink = await get(`/api/admin/tmdb/search?kind=series&query=${encodeURIComponent('https://www.themoviedb.org/tv/1396-breaking-bad')}`);
  assert.deepEqual(byLink.body.map((r) => r.tmdbId), [1396]);

  // A movie link doesn't fit a series.
  const wrongKind = await get(`/api/admin/tmdb/search?kind=series&query=${encodeURIComponent('https://www.themoviedb.org/movie/603')}`);
  assert.deepEqual(wrongKind.body, []);
});

test('web pages and other devices are refused', async () => {
  const fromPage = await get('/api/admin/library', { Origin: 'https://example.com' });
  assert.equal(fromPage.status, 403);

  let status = null;
  const res = { status: (code) => ((status = code), { json: () => {} }) };
  desktopOnly({ socket: { remoteAddress: '192.168.1.20' }, headers: {} }, res, () => assert.fail('let a LAN device in'));
  assert.equal(status, 403);

  let passed = false;
  desktopOnly({ socket: { remoteAddress: '::1' }, headers: {} }, res, () => (passed = true));
  assert.ok(passed);
});
