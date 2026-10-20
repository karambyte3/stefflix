import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import {
  getImportStatus,
  guessFromName,
  planImport,
  resolveItem,
  safeName,
  startImport,
} from '../src/services/importer.js';
import { setSeriesTmdbId } from '../src/services/metadata.js';
import { scanLibrary } from '../src/services/scanner.js';
import { FAKE_API_KEY, startFakeTmdb } from './helpers/fakeTmdb.js';

let tmp;
let db;
let fake;
let lib;
let downloads;

function file(full, size = 1000) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size, 7));
  return full;
}

async function importFinished() {
  for (let i = 0; i < 200 && getImportStatus().running; i++) await new Promise((r) => setTimeout(r, 25));
  return getImportStatus();
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-import-'));
  lib = path.join(tmp, 'Lib');
  downloads = path.join(tmp, 'Downloads');
  fake = await startFakeTmdb();
  Object.assign(config, {
    tmdbApiKey: FAKE_API_KEY,
    tmdbApiUrl: fake.apiUrl,
    tmdbImageUrl: fake.imageUrl,
    imageCacheDir: path.join(tmp, 'cache', 'images'),
    storyboardCacheDir: path.join(tmp, 'cache', 'storyboards'),
    mediaMovies: [path.join(lib, 'Movies')],
    mediaSeries: [path.join(lib, 'Series')],
    mediaVideos: [path.join(lib, 'Videos')],
  });

  // A show already in the library, in a folder whose name isn't the show's title.
  file(path.join(lib, 'Series', 'BB', 'Season 01', 'BB S01E01.mkv'));
  fs.mkdirSync(path.join(lib, 'Movies'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'Videos'), { recursive: true });

  const release = path.join(downloads, 'The.Matrix.1999.1080p.BluRay.x264');
  file(path.join(release, 'The.Matrix.1999.1080p.BluRay.x264.mkv'), 5000);
  file(path.join(release, 'The.Matrix.1999.1080p.BluRay.x264.bg.srt'), 10);
  file(path.join(release, 'Subs', 'English.srt'), 10);
  file(path.join(release, 'sample.mkv'), 10); // skipped
  file(path.join(downloads, 'Breaking.Bad.S01E02.720p.mkv'));
  file(path.join(downloads, 'Nothing Like This 2001.mp4'));
  file(path.join(downloads, 'notes.txt'), 5); // ignored

  db = initDb(':memory:');
  await scanLibrary(db, { movie: config.mediaMovies, episode: config.mediaSeries, video: config.mediaVideos });
  await setSeriesTmdbId(db.prepare('SELECT id FROM series').get().id, 1396);
});

after(async () => {
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('guessFromName reads movies and episodes', () => {
  assert.deepEqual(guessFromName('D:\\dl\\Heat.1995.1080p.mkv', false), {
    kind: 'movie', title: 'Heat', year: 1995, season: null, episode: null, category: null,
  });
  const ep = guessFromName(path.join('D:', 'dl', 'Dark', 'Season 2', 'S02E03.mkv'), true);
  assert.deepEqual([ep.kind, ep.title, ep.season, ep.episode], ['episode', 'Dark', 2, 3]);
  assert.equal(guessFromName(path.join('D:', 'Trips', 'Rila.mp4'), true).category, 'Trips');
});

test('safeName makes titles valid Windows file names', () => {
  assert.equal(safeName('Mission: Impossible?'), 'Mission - Impossible');
  assert.equal(safeName('AC/DC "Live" ...'), 'ACDC Live');
});

test('planImport proposes names, TMDB matches and subtitles', async () => {
  const plan = await planImport([downloads]);
  assert.equal(plan.items.length, 3); // sample.mkv is skipped
  assert.equal(plan.ignored, 1); // notes.txt

  const matrix = plan.items.find((i) => i.source.includes('Matrix'));
  assert.equal(matrix.kind, 'movie');
  assert.equal(matrix.title, 'The Matrix'); // the Latin original title, not "Матрицата"
  assert.equal(matrix.year, 1999);
  assert.equal(matrix.match.tmdbId, 603);
  assert.equal(matrix.target, path.join(lib, 'Movies', 'The Matrix (1999)', 'The Matrix (1999).mkv'));
  assert.deepEqual(
    matrix.subtitles.map((s) => path.basename(s.target)).sort(),
    ['The Matrix (1999).bg.srt', 'The Matrix (1999).en.srt']
  );

  const episode = plan.items.find((i) => i.source.includes('Breaking'));
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.existingShow, true);
  assert.equal(episode.target, path.join(lib, 'Series', 'BB', 'Season 01', 'Breaking Bad S01E02.mkv'));

  const unknown = plan.items.find((i) => i.source.includes('Nothing'));
  assert.equal(unknown.match, null);
  assert.equal(unknown.target, path.join(lib, 'Movies', 'Nothing Like This (2001)', 'Nothing Like This (2001).mp4'));
});

test('resolveItem follows edits and reports problems', () => {
  const source = path.join(downloads, 'Nothing Like This 2001.mp4');
  const asVideo = resolveItem({ source, kind: 'video', title: 'Clip', category: 'Trips' });
  assert.equal(asVideo.target, path.join(lib, 'Videos', 'Trips', 'Clip.mp4'));

  assert.equal(resolveItem({ source, kind: 'episode', title: 'Show', season: 1 }).error, 'noEpisode');
  assert.equal(resolveItem({ source, kind: 'movie', title: '  ' }).error, 'noTitle');

  const saved = config.mediaVideos;
  config.mediaVideos = [];
  try {
    assert.equal(resolveItem({ source, kind: 'video', title: 'Clip' }).error, 'noRoot');
  } finally {
    config.mediaVideos = saved;
  }
});

test('startImport copies with subtitles, applies the match and skips what exists', async () => {
  const { items } = await planImport([path.join(downloads, 'The.Matrix.1999.1080p.BluRay.x264')]);
  startImport(items, 'copy');
  const status = await importFinished();
  assert.deepEqual(status.items.map((i) => i.status), ['done']);
  assert.equal(status.doneBytes, 5000);

  const target = items[0].target;
  assert.equal(fs.statSync(target).size, 5000);
  assert.ok(fs.existsSync(target.replace(/\.mkv$/, '.bg.srt')));
  assert.ok(fs.existsSync(target.replace(/\.mkv$/, '.en.srt')));
  assert.ok(fs.existsSync(items[0].source), 'copy keeps the source');
  assert.ok(!fs.existsSync(`${target}.part`));

  const row = db.prepare('SELECT tmdb_id, metadata_source FROM media WHERE path = ?').get(target);
  assert.equal(row.tmdb_id, 603);

  // The same file again: already there.
  startImport(items, 'copy');
  const again = await importFinished();
  assert.deepEqual(again.items.map((i) => [i.status, i.reason]), [['skipped', 'exists']]);
});

test('startImport moves files', async () => {
  const source = path.join(downloads, 'Nothing Like This 2001.mp4');
  const { items } = await planImport([source]);
  startImport(items, 'move');
  const status = await importFinished();
  assert.equal(status.items[0].status, 'done');
  assert.ok(!fs.existsSync(source));
  assert.ok(fs.existsSync(items[0].target));
});
