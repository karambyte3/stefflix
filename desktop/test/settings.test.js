import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  settingsFromEnv,
  settingsToEnv,
} from '../src/settings.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stefflix-settings-'));
}

test('takes over server/.env on the first start and writes config.json', () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(
    envFile,
    [
      'PORT=3100',
      'MEDIA_MOVIES=D:/Media/Movies',
      'MEDIA_VIDEOS=D:/Media/Videos; E:/Phone Videos/',
      'TMDB_API_KEY= abc ',
      'FFPROBE_PATH=C:/ffmpeg/bin/ffprobe.exe',
      'WATCH_FOLDERS=false',
      'STORYBOARDS=all',
      'OPENSUBTITLES_PASSWORD=" p w "',
    ].join('\n')
  );

  const settings = loadSettings(configFile, envFile);

  assert.equal(settings.port, 3100);
  assert.deepEqual(settings.folders, {
    movies: [path.normalize('D:/Media/Movies')],
    series: [],
    videos: [path.normalize('D:/Media/Videos'), path.normalize('E:/Phone Videos')],
  });
  assert.equal(settings.tmdbApiKey, 'abc');
  assert.equal(settings.ffprobePath, 'C:/ffmpeg/bin/ffprobe.exe');
  assert.equal(settings.watchFolders, false);
  assert.equal(settings.storyboardsForAll, true);
  assert.equal(settings.openSubtitles.password, ' p w ');
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), settings);

  // Later starts read config.json - .env no longer matters.
  fs.writeFileSync(envFile, 'PORT=9999');
  assert.equal(loadSettings(configFile, envFile).port, 3100);
});

test('starts with the defaults when there is no .env', () => {
  const dir = tempDir();
  assert.deepEqual(loadSettings(path.join(dir, 'config.json'), path.join(dir, '.env')), DEFAULT_SETTINGS);
});

test('a broken config.json is kept aside instead of stopping the app', () => {
  const dir = tempDir();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, '{ "port": 31');
  assert.deepEqual(loadSettings(configFile, path.join(dir, '.env')), DEFAULT_SETTINGS);
  assert.ok(fs.existsSync(path.join(dir, 'config.broken.json')));
});

test('normalizeSettings rejects a bad port and cleans up folders', () => {
  for (const port of [0, 70000, 'abc', 3.5]) {
    assert.deepEqual(normalizeSettings({ port }).errors, ['port'], `port ${port}`);
  }
  assert.deepEqual(normalizeSettings({ port: '8080' }).errors, []);

  const { settings } = normalizeSettings({
    folders: { movies: ['D:\\Movies\\', 'd:\\movies', '  ', 'D:\\'], series: 'not a list' },
  });
  assert.deepEqual(settings.folders.movies, ['D:\\Movies', 'D:\\']);
  assert.deepEqual(settings.folders.series, []);
});

test('settingsToEnv gives the variables server/src/config.js reads', () => {
  const env = settingsToEnv({
    ...DEFAULT_SETTINGS,
    folders: { movies: ['D:\\Movies', 'E:\\Movies'], series: [], videos: [] },
    watchFolders: false,
  });
  assert.equal(env.PORT, '3000');
  assert.equal(env.MEDIA_MOVIES, 'D:\\Movies;E:\\Movies');
  assert.equal(env.MEDIA_SERIES, '');
  assert.equal(env.WATCH_FOLDERS, 'false');
  assert.equal(env.STORYBOARDS, '');

  // .env -> settings -> env keeps the meaning.
  const back = settingsToEnv(settingsFromEnv({ PORT: '3001', STORYBOARDS: 'all', MEDIA_SERIES: 'D:\\Series' }));
  assert.equal(back.PORT, '3001');
  assert.equal(back.STORYBOARDS, 'all');
  assert.equal(back.MEDIA_SERIES, 'D:\\Series');
});
