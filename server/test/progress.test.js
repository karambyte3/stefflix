import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { scanLibrary } from '../src/services/scanner.js';

let tmp;
let db;
let server;
let base;
const ids = {};

function file(rel) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(1000 + rel.length, 1));
}

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const report = (mediaId, position, duration) => api('POST', '/api/progress', { mediaId, position, duration });
const continueIds = async () => (await api('GET', '/api/continue-watching')).body.map((i) => `${i.type}:${i.id}${i.nextUp ? '*' : ''}`);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-progress-'));
  // Opening media details starts a storyboard; keep it out of the real cache.
  config.storyboardCacheDir = path.join(tmp, 'storyboards');
  file('Movies/Heat (1995).mkv');
  file('Movies/Alien (1979).mkv');
  file('Series/Show/Season 01/Show S01E01.mkv');
  file('Series/Show/Season 01/Show S01E02.mkv');
  file('Series/Show/Season 01/Show S01E03.mkv');
  file('Series/Show/Season 02/Show S02E01.mkv');
  file('Series/Show/Specials/Show S00E01.mkv');
  file('Videos/Trip/beach.mp4');

  db = initDb(':memory:');
  await scanLibrary(db, {
    movie: [path.join(tmp, 'Movies')],
    episode: [path.join(tmp, 'Series')],
    video: [path.join(tmp, 'Videos')],
  });
  for (const row of db.prepare('SELECT id, path FROM media').all()) {
    ids[path.basename(row.path, path.extname(row.path))] = row.id;
  }
  ids.series = db.prepare('SELECT id FROM series').get().id;

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a movie in progress shows up in Continue watching and resumes', async () => {
  const heat = ids['Heat (1995)'];
  assert.deepEqual((await report(heat, 600, 6000)).body, { mediaId: heat, position: 600, duration: 6000, watched: false });
  assert.deepEqual(await continueIds(), [`movie:${heat}`]);

  const details = (await api('GET', `/api/media/${heat}`)).body;
  assert.deepEqual(details.progress, { position: 600, duration: 6000, watched: false, resumeAt: 600 });

  const card = (await api('GET', '/api/movies')).body.find((m) => m.id === heat);
  assert.equal(card.progress, 0.1);
  assert.equal(card.watched, false);
});

test('below 5% a movie is not in Continue watching; below 10 s it does not resume', async () => {
  const alien = ids['Alien (1979)'];
  await report(alien, 8, 6000);
  assert.equal((await api('GET', `/api/media/${alien}`)).body.progress.resumeAt, 0);
  assert.equal((await api('GET', '/api/movies')).body.find((m) => m.id === alien).progress, null);
  await report(alien, 120, 6000); // 2%
  assert.equal((await api('GET', `/api/media/${alien}`)).body.progress.resumeAt, 120);
  assert.equal((await api('GET', '/api/movies')).body.find((m) => m.id === alien).progress, 0.02); // bar on the card
  assert.ok(!(await continueIds()).includes(`movie:${alien}`));
});

test('past 90% a movie is watched, starts from 0 and is counted once', async () => {
  const heat = ids['Heat (1995)'];
  assert.deepEqual((await report(heat, 5450, 6000)).body, { mediaId: heat, position: 0, duration: 6000, watched: true });
  await report(heat, 5800, 6000); // more reports during the credits
  await report(heat, 6000, 6000); // ended
  assert.equal(db.prepare('SELECT play_count FROM progress WHERE media_id = ?').get(heat).play_count, 1);
  assert.ok(!(await continueIds()).includes(`movie:${heat}`));
  assert.equal((await api('GET', `/api/media/${heat}`)).body.progress.resumeAt, 0);

  // Watching it again and finishing it counts a second time; it stays "watched" meanwhile.
  assert.equal((await report(heat, 3000, 6000)).body.watched, true);
  assert.ok((await continueIds()).includes(`movie:${heat}`));
  await report(heat, 5900, 6000);
  assert.equal(db.prepare('SELECT play_count FROM progress WHERE media_id = ?').get(heat).play_count, 2);
});

test('the start of the credits counts as finished when it is known', async () => {
  const alien = ids['Alien (1979)'];
  db.prepare('UPDATE media SET credits_at = 5000 WHERE id = ?').run(alien);
  assert.equal((await report(alien, 5000, 6000)).body.watched, true); // 83%, but past the credits
  assert.equal((await api('GET', `/api/media/${alien}`)).body.creditsAt, 5000);
});

test('series: in-progress episode, then the next one, across seasons', async () => {
  const [e1, e2, e3, s2e1] = ['Show S01E01', 'Show S01E02', 'Show S01E03', 'Show S02E01'].map((n) => ids[n]);

  await report(e1, 1000, 3000);
  assert.ok((await continueIds()).includes(`episode:${e1}`));
  let series = (await api('GET', `/api/series/${ids.series}`)).body;
  assert.deepEqual(series.upNext, { id: e1, seasonNumber: 1, episodeNumber: 1, title: null, resumeAt: 1000 });
  assert.equal(series.seasons[0].episodes[0].progress, 0.333);

  await report(e1, 2900, 3000); // finished -> the next episode is "up next"
  assert.ok((await continueIds()).includes(`episode:${e2}*`));
  series = (await api('GET', `/api/series/${ids.series}`)).body;
  assert.equal(series.upNext.id, e2);
  assert.equal(series.seasons[0].episodes[0].watched, true);

  await api('PUT', `/api/media/${e2}/watched`, { watched: true }); // skip ahead manually
  assert.ok((await continueIds()).includes(`episode:${e3}*`));

  await report(e3, 2950, 3000);
  assert.ok((await continueIds()).includes(`episode:${s2e1}*`)); // across the season boundary
  assert.equal((await api('GET', `/api/series/${ids.series}`)).body.upNext.id, s2e1);
});

test('only the latest activity per series is shown', async () => {
  const items = (await api('GET', '/api/continue-watching')).body.filter((i) => i.type === 'episode');
  assert.equal(items.length, 1);
});

test('next episode endpoint', async () => {
  assert.equal((await api('GET', `/api/episodes/${ids['Show S01E03']}/next`)).body.id, ids['Show S02E01']);
  assert.equal((await api('GET', `/api/episodes/${ids['Show S02E01']}/next`)).body, null); // last regular episode
  assert.equal((await api('GET', `/api/episodes/${ids['Show S00E01']}/next`)).body, null); // specials don't lead into seasons
  const next = (await api('GET', `/api/episodes/${ids['Show S01E01']}/next`)).body;
  assert.equal(next.seriesTitle, 'Show');
  assert.equal(next.watched, true);
});

test('a whole series can be marked watched and unwatched', async () => {
  await api('PUT', `/api/series/${ids.series}/watched`, { watched: true });
  let series = (await api('GET', `/api/series/${ids.series}`)).body;
  assert.equal(series.watched, true);
  assert.ok(!(await continueIds()).some((id) => id.startsWith('episode:'))); // nothing left to watch

  await api('PUT', `/api/series/${ids.series}/watched`, { watched: false });
  series = (await api('GET', `/api/series/${ids.series}`)).body;
  assert.equal(series.watched, false);
  assert.ok(series.seasons.every((s) => s.episodes.every((e) => !e.watched && e.progress === null)));
});

test('videos and the watched toggle for single items', async () => {
  const beach = ids.beach;
  await report(beach, 30, 100);
  assert.ok((await continueIds()).includes(`video:${beach}`));
  assert.equal((await api('PUT', `/api/media/${beach}/watched`, { watched: true })).body.watched, true);
  assert.ok(!(await continueIds()).includes(`video:${beach}`));
  assert.equal((await api('PUT', `/api/media/${beach}/watched`, { watched: false })).body.watched, false);
});

test('validation', async () => {
  assert.equal((await report(ids.beach, 'soon', 100)).status, 400);
  assert.equal((await report(ids.beach, -5, 100)).status, 400);
  assert.equal((await report(ids.beach, 5, 0)).status, 400);
  assert.equal((await report(999999, 5, 100)).status, 404);
  assert.equal((await api('PUT', `/api/media/${ids.beach}/watched`, { watched: 'yes' })).status, 400);
  assert.equal((await api('PUT', '/api/series/999999/watched', { watched: true })).status, 404);
});
