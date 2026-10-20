import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/db/index.js';
import { countUnavailable, removeUnavailable } from '../src/services/cleanup.js';
import { scanLibrary } from '../src/services/scanner.js';

let tmp;
let db;
let roots;

function file(rel, size = 1000) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size, 1));
  return full;
}

function idOf(rel) {
  return db.prepare('SELECT id FROM media WHERE path = ?').get(path.join(tmp, rel)).id;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-cleanup-'));
  roots = { movie: [path.join(tmp, 'Movies')], episode: [path.join(tmp, 'Series')], video: [] };
  file('Movies/Heat (1995).mp4', 1001);
  file('Series/Show/Season 01/Show S01E01.mkv', 2001);
  file('Series/Show/Season 01/Show S01E01 - Copy.mkv', 2002);
  file('Series/Show/Season 02/Show S02E01.mkv', 2003);
  file('Series/Gone Show/Season 01/Gone Show S01E01.mkv', 2004);
  db = initDb(':memory:');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('removes missing files with their progress, and seasons and series left empty', async () => {
  await scanLibrary(db, roots);
  const copyId = idOf('Series/Show/Season 01/Show S01E01 - Copy.mkv');
  const keptId = idOf('Series/Show/Season 01/Show S01E01.mkv');
  db.prepare('INSERT INTO progress (media_id, position, duration, updated_at) VALUES (?, 10, 100, 1)').run(copyId);
  db.prepare('INSERT INTO progress (media_id, position, duration, updated_at) VALUES (?, 20, 100, 1)').run(keptId);

  fs.rmSync(path.join(tmp, 'Series/Show/Season 01/Show S01E01 - Copy.mkv'));
  fs.rmSync(path.join(tmp, 'Series/Show/Season 02'), { recursive: true });
  fs.rmSync(path.join(tmp, 'Series/Gone Show'), { recursive: true });
  await scanLibrary(db, roots);
  assert.equal(countUnavailable(db), 3);

  const removed = removeUnavailable(db);
  assert.deepEqual(removed, { media: 3, subtitles: 0, seasons: 2, series: 1 });
  assert.equal(countUnavailable(db), 0);

  // What's still on disk is untouched, progress included.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get().n, 2);
  assert.equal(db.prepare('SELECT position FROM progress WHERE media_id = ?').get(keptId).position, 20);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress WHERE media_id = ?').get(copyId).n, 0);
  const seasons = db.prepare('SELECT season_number FROM seasons').all().map((s) => s.season_number);
  assert.deepEqual(seasons, [1]);
  assert.deepEqual(db.prepare('SELECT title FROM series').all().map((s) => s.title), ['Show']);
});
