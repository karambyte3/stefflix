import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/db/index.js';
import { scanLibrary } from '../src/services/scanner.js';
import { getHome, getMediaDetails, getSeriesDetails, listMovies, listSeries, listVideos } from '../src/services/library.js';

let tmp;
let db;
let roots;

function file(rel, size = 1000) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size, 1));
  return full;
}

function mediaByPath(rel) {
  return db.prepare('SELECT * FROM media WHERE path = ?').get(path.join(tmp, rel));
}

function scan() {
  return scanLibrary(db, roots);
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-scan-'));
  roots = {
    movie: [path.join(tmp, 'Movies')],
    episode: [path.join(tmp, 'Series')],
    video: [path.join(tmp, 'Videos')],
  };

  file('Movies/The Matrix (1999)/The Matrix (1999).mkv', 1001);
  file('Movies/Heat (1995).mp4', 1002);
  file('Movies/Inception.2010.1080p.BluRay.x264.mkv', 1003);
  file('Movies/Some Movie (2001)/sample.mkv', 10);
  file('Movies/readme.txt');

  file('Series/Breaking Bad/Season 01/Breaking Bad S01E01.mkv', 2001);
  file("Series/Breaking Bad/Season 01/Breaking Bad S01E02 - Cat's in the Bag.mkv", 2002);
  file('Series/Breaking Bad/Season 02/breaking.bad.2x01.mkv', 2003);
  file('Series/Breaking Bad/Specials/Breaking Bad S00E01.mkv', 2004);
  file('Series/Loose Show S01E01.mkv', 2005);
  file('Series/Bad Show/notes.mkv', 2006);

  file('Videos/Travel/Greece 2023.mp4', 3001);
  file('Videos/Travel/2024/Alps.mp4', 3002);
  file('Videos/clip.webm', 3003);

  db = initDb(':memory:');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('first scan finds and parses everything', async () => {
  const stats = await scan();
  assert.equal(stats.added, 11);
  assert.equal(stats.skipped, 2); // sample + episode without numbering

  assert.deepEqual(
    listMovies({ sort: 'title' }).map((m) => [m.title, m.year]),
    [['Heat', 1995], ['Inception', 2010], ['The Matrix', 1999]]
  );

  const series = listSeries({ sort: 'title' });
  assert.deepEqual(series.map((s) => [s.title, s.episodeCount]), [['Breaking Bad', 4], ['Loose Show', 1]]);

  const bb = getSeriesDetails(series[0].id);
  assert.deepEqual(bb.seasons.map((s) => s.seasonNumber), [1, 2, 0]); // specials last
  assert.equal(bb.seasons[0].episodes[1].title, "Cat's in the Bag");

  const travel = listVideos({ category: 'Travel', sort: 'title' });
  assert.deepEqual(travel.map((v) => v.title), ['Alps', 'Greece 2023']);
  assert.deepEqual(listVideos({ category: '' }).map((v) => v.title), ['clip']);
});

test('re-scan without changes keeps everything', async () => {
  const before = db.prepare('SELECT id, path FROM media ORDER BY id').all();
  const stats = await scan();
  assert.equal(stats.added + stats.moved + stats.removed + stats.restored + stats.updated, 0);
  assert.deepEqual(db.prepare('SELECT id, path FROM media ORDER BY id').all(), before);
});

test('a moved file keeps its id', async () => {
  const { id } = mediaByPath('Movies/Heat (1995).mp4');
  fs.mkdirSync(path.join(tmp, 'Movies/Heat (1995)'));
  fs.renameSync(path.join(tmp, 'Movies/Heat (1995).mp4'), path.join(tmp, 'Movies/Heat (1995)/Heat (1995).mp4'));

  const stats = await scan();
  assert.equal(stats.moved, 1);
  assert.equal(stats.added, 0);
  assert.equal(mediaByPath('Movies/Heat (1995)/Heat (1995).mp4').id, id);
});

test('missing files become unavailable and come back with the same id', async () => {
  const clip = mediaByPath('Videos/clip.webm');
  const loose = mediaByPath('Series/Loose Show S01E01.mkv');
  fs.renameSync(path.join(tmp, 'Videos/clip.webm'), path.join(tmp, 'clip.webm.bak'));
  fs.rmSync(path.join(tmp, 'Series/Loose Show S01E01.mkv'));

  let stats = await scan();
  assert.equal(stats.removed, 2);
  assert.equal(mediaByPath('Videos/clip.webm').available, 0);
  assert.equal(getMediaDetails(clip.id).available, false);
  assert.deepEqual(listVideos({ category: '' }), []);
  // A series without any available episode disappears from the lists.
  assert.deepEqual(listSeries().map((s) => s.title), ['Breaking Bad']);
  assert.equal(db.prepare('SELECT available FROM series WHERE id = ?').get(loose.series_id).available, 0);

  fs.renameSync(path.join(tmp, 'clip.webm.bak'), path.join(tmp, 'Videos/clip.webm'));
  stats = await scan();
  assert.equal(stats.restored, 1);
  assert.equal(mediaByPath('Videos/clip.webm').id, clip.id);
});

test('home rows and media details', () => {
  const home = getHome();
  const keys = home.rows.map((r) => r.key + (r.category !== undefined ? ':' + r.category : ''));
  assert.deepEqual(keys.slice(0, 3), ['recentMovies', 'recentEpisodes', 'series']);
  // Video categories are ordered by their newest file, which depends on file times.
  assert.deepEqual(keys.slice(3).sort(), ['videos:Travel', 'videos:null']);
  assert.ok(home.featured);

  const matrix = mediaByPath('Movies/The Matrix (1999)/The Matrix (1999).mkv');
  const details = getMediaDetails(matrix.id);
  assert.equal(details.fileName, 'The Matrix (1999).mkv');
  assert.deepEqual(details.compatibility, { probed: false, warnings: [] });

  const episode = getMediaDetails(mediaByPath('Series/Breaking Bad/Season 02/breaking.bad.2x01.mkv').id);
  assert.equal(episode.series.title, 'Breaking Bad');
  assert.equal(episode.seasonNumber, 2);
});
