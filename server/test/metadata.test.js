import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { ensureImage, placeholderSvg } from '../src/services/images.js';
import { getMediaDetails, getSeriesDetails, listGenres, listMovies } from '../src/services/library.js';
import { pickBest, refreshLibraryMetadata, setMediaTmdbId } from '../src/services/metadata.js';
import { scanLibrary } from '../src/services/scanner.js';
import { FAKE_API_KEY, startFakeTmdb } from './helpers/fakeTmdb.js';

let tmp;
let db;
let fake;

function file(rel) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(1000 + rel.length, 1));
}

function movie(title) {
  return db.prepare("SELECT * FROM media WHERE type = 'movie' AND path LIKE ?").get(`%${title}%`);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-tmdb-'));
  fake = await startFakeTmdb();
  config.tmdbApiKey = FAKE_API_KEY;
  config.tmdbApiUrl = fake.apiUrl;
  config.tmdbImageUrl = fake.imageUrl;
  config.imageCacheDir = path.join(tmp, 'cache');

  file('Movies/The Matrix (1999)/The Matrix (1999).mkv');
  file('Movies/Heat (1995).mp4');
  file('Movies/Nothing Like This (2001).mp4');
  file('Series/Breaking Bad/Season 01/Breaking Bad S01E01.mkv');
  file('Series/Breaking Bad/Season 01/Breaking Bad S01E02 - From The File.mkv');
  file('Series/Breaking Bad/Season 01/Breaking Bad S01E11.mkv'); // not on TMDB

  db = initDb(':memory:');
  await scanLibrary(db, {
    movie: [path.join(tmp, 'Movies')],
    episode: [path.join(tmp, 'Series')],
    video: [],
  });
});

after(async () => {
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pickBest prefers the right year and rejects wrong ones', () => {
  const options = { titleKeys: ['title', 'original_title'], dateKey: 'release_date' };
  const results = [
    { id: 1, title: 'Heat', original_title: 'Heat', release_date: '1986-01-01' },
    { id: 2, title: 'Жега', original_title: 'Heat', release_date: '1995-12-15' },
  ];
  assert.equal(pickBest(results, 'Heat', 1995, options).id, 2);
  assert.equal(pickBest(results, 'Heat', null, options).id, 1); // no year: TMDB order
  assert.equal(pickBest([{ id: 3, title: 'Other', release_date: '1970-01-01' }], 'Heat', 1995, options), null);
  assert.equal(pickBest([{ id: 4, title: 'Other', release_date: '1996-01-01' }], 'Heat', 1995, options).id, 4);
});

test('movies are matched in Bulgarian with English fallback', async () => {
  await refreshLibraryMetadata(db);

  const matrix = getMediaDetails(movie('Matrix').id);
  assert.equal(matrix.title, 'Матрицата');
  assert.equal(matrix.originalTitle, 'The Matrix');
  assert.equal(matrix.overview, 'A hacker learns the truth about his reality.'); // bg empty -> en
  assert.deepEqual(matrix.genres, ['Екшън', 'Научна фантастика']);
  assert.equal(matrix.runtime, 136);
  assert.equal(matrix.rating, 8.2);
  assert.equal(matrix.poster, '/images/w342/matrix.jpg');
  assert.equal(matrix.backdrop, '/images/w1280/matrix-bd.jpg');
  assert.equal(matrix.cast.length, 10);
  assert.deepEqual(matrix.cast[0], { name: 'Киану Рийвс', character: 'Роля 1', profile: '/images/w185/person1.jpg' });
  assert.equal(matrix.metadataSource, 'tmdb');

  const heat = getMediaDetails(movie('Heat').id);
  assert.equal(heat.title, 'Жега'); // the 1995 film, not the 1986 one
  assert.equal(heat.year, 1995);

  const unknown = getMediaDetails(movie('Nothing Like This').id);
  assert.equal(unknown.title, 'Nothing Like This'); // file-name data stays
  assert.equal(unknown.metadataSource, 'filename');
  assert.match(unknown.poster, /^\/images\/placeholder\/movie\/\d+\.svg\?v=/);

  // Sorting uses the TMDB title.
  assert.deepEqual(listMovies({ sort: 'title' }).map((m) => m.title), ['Nothing Like This', 'Жега', 'Матрицата']);

  // Genre list and filter.
  assert.deepEqual(listGenres('movie'), ['Драма', 'Екшън', 'Криминален', 'Научна фантастика']);
  assert.deepEqual(listMovies({ genre: 'Драма' }).map((m) => m.title), ['Жега']);
});

test('series, seasons and episodes get metadata, with fallbacks', () => {
  const seriesId = db.prepare('SELECT series_id FROM media WHERE type = ?').get('episode').series_id;
  const bb = getSeriesDetails(seriesId);
  assert.equal(bb.title, 'Breaking Bad');
  assert.deepEqual(bb.genres, ['Драма', 'Криминален']);
  assert.equal(bb.cast.length, 3);

  const season = bb.seasons[0];
  assert.equal(season.overview, 'English overview of season 1.');
  assert.equal(season.poster, '/images/w342/season-1396-1.jpg');

  const [e1, e2, e11] = season.episodes;
  assert.equal(e1.title, 'Пилотен епизод');
  assert.equal(e1.overview, 'Описание на първия епизод.');
  assert.equal(e1.still, '/images/w300/still-1396-1-1.jpg');
  assert.equal(e2.title, 'Chapter 2'); // "Епизод 2" is generic -> English name
  assert.equal(e2.overview, 'English overview of episode 2.');
  assert.equal(e11.title, null); // not on TMDB, no title in the file name
  assert.equal(e11.still, null);
});

test('a second refresh and a re-scan make no API calls', async () => {
  const before = fake.requests.length;
  await scanLibrary(db, { movie: [path.join(tmp, 'Movies')], episode: [path.join(tmp, 'Series')], video: [] });
  await refreshLibraryMetadata(db);
  assert.equal(fake.requests.length, before);
  // ...and the re-scan kept the TMDB titles.
  assert.equal(getMediaDetails(movie('Matrix').id).title, 'Матрицата');
});

test('a wrong match can be corrected by TMDB id', async () => {
  const id = movie('Nothing Like This').id;
  await setMediaTmdbId(id, 550);
  const fixed = getMediaDetails(id);
  assert.equal(fixed.title, 'Боен клуб');
  assert.equal(fixed.metadataSource, 'manual');

  await assert.rejects(() => setMediaTmdbId(id, 999999), /not found/);
});

test('images are downloaded once and cached', async () => {
  const first = await ensureImage('w342', 'matrix.jpg');
  assert.ok(first && fs.existsSync(first));
  const mtime = fs.statSync(first).mtimeMs;
  assert.equal(await ensureImage('w342', 'matrix.jpg'), first);
  assert.equal(fs.statSync(first).mtimeMs, mtime);

  assert.equal(await ensureImage('w342', '../../etc/passwd'), null); // path traversal
  assert.equal(await ensureImage('original', 'matrix.jpg'), null); // size not allowed
});

test('placeholder posters are valid SVG with escaped text', () => {
  const svg = placeholderSvg('Tom & Jerry <Movie>', 1992);
  assert.match(svg, /^<svg/);
  assert.match(svg, /Tom &amp; Jerry/);
  assert.match(svg, /&lt;Movie&gt;/);
  assert.match(svg, />1992</);
});
