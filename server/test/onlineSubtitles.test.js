import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { movieHash, resetSession } from '../src/services/openSubtitles.js';
import { scanLibrary } from '../src/services/scanner.js';
import { FAKE_OS_KEY, FAKE_OS_USER, startFakeOpenSubtitles } from './helpers/fakeOpenSubtitles.js';

let tmp;
let db;
let fake;
let server;
let base;
let matrixId;
let episodeId;
let matrixPath;
const saved = {};

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
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-os-'));
  // Opening media details starts a storyboard; keep it out of the real cache.
  config.storyboardCacheDir = path.join(tmp, 'storyboards');
  matrixPath = write('Movies/The Matrix (1999)/The Matrix (1999).mkv', crypto.randomBytes(200 * 1024));
  write('Series/Show/Season 01/Show S01E02.mkv', crypto.randomBytes(100 * 1024));

  for (const key of ['openSubtitlesApiKey', 'openSubtitlesUsername', 'openSubtitlesPassword', 'openSubtitlesUrl', 'tmdbApiKey', 'mediaMovies', 'mediaSeries', 'mediaVideos', 'ffprobePath', 'ffmpegPath']) {
    saved[key] = config[key];
  }
  fake = await startFakeOpenSubtitles();
  config.openSubtitlesApiKey = FAKE_OS_KEY;
  config.openSubtitlesUrl = fake.url;
  config.openSubtitlesUsername = '';
  config.tmdbApiKey = ''; // no real TMDB calls from the scans
  config.ffprobePath = path.join(tmp, 'no-ffprobe');
  config.ffmpegPath = path.join(tmp, 'no-ffmpeg');
  config.mediaMovies = [path.join(tmp, 'Movies')];
  config.mediaSeries = [path.join(tmp, 'Series')];
  config.mediaVideos = [];

  db = initDb(':memory:');
  await scanLibrary(db, { movie: config.mediaMovies, episode: config.mediaSeries, video: [] });
  matrixId = db.prepare("SELECT id FROM media WHERE type = 'movie'").get().id;
  episodeId = db.prepare("SELECT id FROM media WHERE type = 'episode'").get().id;
  db.prepare('UPDATE media SET tmdb_id = 603 WHERE id = ?').run(matrixId);
  db.prepare('UPDATE series SET tmdb_id = 1399').run();
  fake.state.hash = await movieHash(matrixPath);

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  Object.assign(config, saved);
  server.close();
  fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fake.requests.length = 0;
});

test('movie hash: size + 64-bit sums of the first and last 64 KB', async () => {
  // Independent 32-bit implementation of the same algorithm.
  const data = fs.readFileSync(matrixPath);
  let lo = data.length >>> 0;
  let hi = Math.floor(data.length / 2 ** 32);
  for (const offset of [0, data.length - 65536]) {
    for (let i = 0; i < 65536; i += 8) {
      const sum = lo + data.readUInt32LE(offset + i);
      lo = sum >>> 0;
      hi = (hi + data.readUInt32LE(offset + i + 4) + Math.floor(sum / 2 ** 32)) >>> 0;
    }
  }
  const expected = hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
  assert.equal(await movieHash(matrixPath), expected);
  assert.equal(await movieHash(write('tiny.mkv', Buffer.alloc(1000))), null);
});

test('media details say whether online search is available', async () => {
  assert.equal((await api('GET', `/api/media/${matrixId}`)).body.onlineSubtitles, true);
});

test('search: by hash and by TMDB id, sorted language > hash match > human > downloads', async () => {
  const { status, body } = await api('GET', `/api/media/${matrixId}/subtitles/online?languages=bg,en`);
  assert.equal(status, 200);
  assert.deepEqual(
    body.map((r) => [r.fileId, r.language, r.hashMatch, r.machineTranslated]),
    [
      [102, 'bg', true, false], // timed for this file
      [101, 'bg', false, false],
      [104, 'bg', false, true], // more downloads, but machine translated
      [103, 'en', false, false],
    ]
  );
  // Sent the way the API wants it: key + app User-Agent, sorted lowercase parameters.
  const searches = fake.requests.filter((r) => r.path === '/api/v1/subtitles');
  assert.equal(searches.length, 2);
  assert.equal(searches[0].query.moviehash, fake.state.hash);
  assert.deepEqual(searches[1].query, { languages: 'bg,en', tmdb_id: '603', type: 'movie' });
});

test('search for an episode uses the series TMDB id, season and episode', async () => {
  const { body } = await api('GET', `/api/media/${episodeId}/subtitles/online?languages=bg`);
  assert.deepEqual(body.map((r) => [r.fileId, r.tags]), [[201, ['sdh']]]);
  const query = fake.requests.find((r) => r.path === '/api/v1/subtitles' && !r.query.moviehash).query;
  assert.deepEqual(query, { episode_number: '2', languages: 'bg', parent_tmdb_id: '1399', season_number: '1', type: 'episode' });
});

test('download saves the file next to the video and returns a playable subtitle', async () => {
  const { status, body } = await api('POST', `/api/media/${matrixId}/subtitles/online`, { fileId: 102, language: 'bg', tags: [] });
  assert.equal(status, 200);
  assert.equal(body.remaining, 0);
  assert.equal(body.subtitle.language, 'bg');
  const target = path.join(tmp, 'Movies/The Matrix (1999)/The Matrix (1999).bg.opensubtitles-102.srt');
  assert.ok(fs.existsSync(target));

  const cues = await api('GET', `/api/subtitles/${body.subtitle.id}`);
  assert.deepEqual(cues.body[1], { start: 3, end: 4, text: '<i>Следвай белия заек.</i>' });

  // It is listed with the movie's subtitles and marked as downloaded in the search.
  const details = (await api('GET', `/api/media/${matrixId}`)).body;
  assert.ok(details.subtitles.some((s) => s.id === body.subtitle.id));
  const search = (await api('GET', `/api/media/${matrixId}/subtitles/online?languages=bg,en`)).body;
  assert.equal(search.find((r) => r.fileId === 102).downloaded, true);
});

test('choosing an already downloaded subtitle costs no download', async () => {
  const { status, body } = await api('POST', `/api/media/${matrixId}/subtitles/online`, { fileId: 102, language: 'bg', tags: [] });
  assert.equal(status, 200);
  assert.equal(body.remaining, null);
  assert.equal(fake.requests.filter((r) => r.path === '/api/v1/download').length, 0);
});

test('a used-up quota is reported with its reset time', async () => {
  const { status, body } = await api('POST', `/api/media/${matrixId}/subtitles/online`, { fileId: 101, language: 'bg', tags: [] });
  assert.equal(status, 429);
  assert.equal(body.error, 'quota');
  assert.equal(body.resetTime, '2026-10-20T00:00:00Z');
});

test('with an account the client logs in once and downloads with the token', async () => {
  config.openSubtitlesUsername = FAKE_OS_USER.username;
  config.openSubtitlesPassword = FAKE_OS_USER.password;
  resetSession();
  try {
    const first = await api('POST', `/api/media/${episodeId}/subtitles/online`, { fileId: 201, language: 'bg', tags: ['sdh'] });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.subtitle.tags, ['sdh']);
    assert.equal(first.body.remaining, 4);
    const second = await api('POST', `/api/media/${matrixId}/subtitles/online`, { fileId: 101, language: 'bg', tags: [] });
    assert.equal(second.status, 200);
    assert.equal(fake.requests.filter((r) => r.path === '/api/v1/login').length, 1);
    assert.ok(fake.requests.filter((r) => r.path === '/api/v1/download').every((r) => r.headers.authorization === 'Bearer user-token'));
  } finally {
    config.openSubtitlesUsername = '';
    resetSession();
  }
});

test('a file without cues is not saved', async () => {
  fake.state.anonymousDownloads = 5;
  const { status, body } = await api('POST', `/api/media/${matrixId}/subtitles/online`, { fileId: 999, language: 'bg', tags: [] });
  assert.equal(status, 502);
  assert.equal(body.error, 'unavailable');
  assert.ok(!fs.existsSync(path.join(tmp, 'Movies/The Matrix (1999)/The Matrix (1999).bg.opensubtitles-999.srt')));
});

test('a wrong API key and a missing key are reported', async () => {
  config.openSubtitlesApiKey = 'wrong';
  let res = await api('GET', `/api/media/${matrixId}/subtitles/online?languages=bg`);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'auth');

  config.openSubtitlesApiKey = '';
  res = await api('GET', `/api/media/${matrixId}/subtitles/online?languages=en`);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'not_configured');
  assert.equal((await api('GET', `/api/media/${matrixId}`)).body.onlineSubtitles, false);
  config.openSubtitlesApiKey = FAKE_OS_KEY;
});
