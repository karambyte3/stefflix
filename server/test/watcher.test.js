import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/db/index.js';
import { scanLibrary } from '../src/services/scanner.js';
import { watchMediaFolders } from '../src/services/watcher.js';

const QUIET_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-watch-'));
}

/** Watches `root` and counts the rescans; `waitForScans(n)` resolves once n scans ran. */
function watchAndCount(root) {
  let scans = 0;
  const stop = watchMediaFolders([root], async () => scans++, { quietMs: QUIET_MS });
  return {
    stop,
    get scans() {
      return scans;
    },
    async waitForScans(n, timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      while (scans < n && Date.now() < until) await sleep(25);
      return scans;
    },
  };
}

test('a new video triggers one rescan after the burst of events', async () => {
  const root = tempDir();
  const watch = watchAndCount(root);
  try {
    fs.mkdirSync(path.join(root, 'Show', 'Season 01'), { recursive: true });
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(root, 'Show', 'Season 01', `Show S01E0${i}.mkv`), 'x');
    }
    assert.equal(await watch.waitForScans(1), 1);
    await sleep(QUIET_MS * 3);
    assert.equal(watch.scans, 1, 'the whole burst is one scan');
  } finally {
    watch.stop();
  }
});

test('unrelated files and downloads in progress do not trigger a rescan', async () => {
  const root = tempDir();
  const watch = watchAndCount(root);
  try {
    fs.writeFileSync(path.join(root, 'movie.nfo'), 'x');
    fs.writeFileSync(path.join(root, 'poster.jpg'), 'x');
    fs.writeFileSync(path.join(root, 'Movie (2020).mkv.part'), 'x');
    await sleep(QUIET_MS * 4);
    assert.equal(watch.scans, 0);

    // ...until the download gets its real name.
    fs.renameSync(path.join(root, 'Movie (2020).mkv.part'), path.join(root, 'Movie (2020).mkv'));
    assert.equal(await watch.waitForScans(1), 1);
  } finally {
    watch.stop();
  }
});

test('removing a folder triggers a rescan', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'Old Movie (1990)'));
  fs.writeFileSync(path.join(root, 'Old Movie (1990)', 'Old Movie (1990).mp4'), 'x');
  const watch = watchAndCount(root);
  try {
    fs.rmSync(path.join(root, 'Old Movie (1990)'), { recursive: true });
    assert.equal(await watch.waitForScans(1), 1);
  } finally {
    watch.stop();
  }
});

test('a change during a scan schedules another scan', async () => {
  const root = tempDir();
  let scans = 0;
  let releaseFirst;
  const stop = watchMediaFolders(
    [root],
    () => {
      scans++;
      return scans === 1 ? new Promise((resolve) => (releaseFirst = resolve)) : Promise.resolve();
    },
    { quietMs: QUIET_MS }
  );
  try {
    fs.writeFileSync(path.join(root, 'A (2001).mp4'), 'x');
    while (scans < 1) await sleep(25);
    fs.writeFileSync(path.join(root, 'B (2002).mp4'), 'x'); // arrives while scan 1 is running
    await sleep(QUIET_MS * 2);
    assert.equal(scans, 1, 'no overlapping scans');
    releaseFirst();
    const until = Date.now() + 5000;
    while (scans < 2 && Date.now() < until) await sleep(25);
    assert.equal(scans, 2);
  } finally {
    stop();
  }
});

test('the scanner skips a new file that is still locked by the program copying it', { skip: process.platform !== 'win32' }, async () => {
  const root = tempDir();
  const movies = path.join(root, 'Movies');
  fs.mkdirSync(movies);
  const copying = path.join(movies, 'Copying (2020).mp4');
  fs.writeFileSync(copying, Buffer.alloc(1000));
  fs.writeFileSync(path.join(movies, 'Done (2019).mp4'), Buffer.alloc(1000));

  // Hold the file open with no sharing, like Explorer / Copy-Item do while copying.
  const locker = spawn('powershell', [
    '-NoProfile',
    '-Command',
    `$f = [IO.File]::Open('${copying}', 'Open', 'ReadWrite', 'None'); Write-Output locked; [Console]::In.ReadLine() | Out-Null; $f.Close()`,
  ]);
  await new Promise((resolve, reject) => {
    locker.stdout.on('data', (d) => d.toString().includes('locked') && resolve());
    locker.on('exit', () => reject(new Error('locker exited early')));
  });

  const db = initDb(':memory:');
  const roots = { movie: [movies], episode: [], video: [] };
  try {
    const first = await scanLibrary(db, roots);
    assert.equal(first.added, 1);
    assert.equal(first.inProgress, 1);
    assert.deepEqual(db.prepare('SELECT title FROM media').pluck().all(), ['Done']);
  } finally {
    locker.stdin.end('\n');
    await new Promise((resolve) => locker.on('close', resolve));
  }

  const second = await scanLibrary(db, roots);
  assert.equal(second.added, 1);
  assert.equal(second.inProgress, 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM media').pluck().get(), 2);
});
