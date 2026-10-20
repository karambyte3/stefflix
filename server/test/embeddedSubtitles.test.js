import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { isFfmpegAvailable } from '../src/services/embeddedSubtitles.js';
import { isFfprobeAvailable, probePendingMedia } from '../src/services/probe.js';
import { scanLibrary } from '../src/services/scanner.js';
import { languageFromCode } from '../src/services/subtitles.js';

test('container language tags become ISO 639-1 codes', () => {
  assert.equal(languageFromCode('bul'), 'bg');
  assert.equal(languageFromCode('eng'), 'en');
  assert.equal(languageFromCode('ger'), 'de');
  assert.equal(languageFromCode('cze'), 'cs');
  assert.equal(languageFromCode('pt-BR'), 'pt');
  assert.equal(languageFromCode('und'), null);
  assert.equal(languageFromCode(null), null);
  assert.equal(languageFromCode('xyz'), null);
});

// The rest needs ffmpeg + ffprobe on PATH (or FFMPEG_PATH / FFPROBE_PATH).
const tools = (await isFfprobeAvailable()) && (await isFfmpegAvailable());
const skip = tools ? false : 'ffmpeg/ffprobe not installed';

const BG_SRT =
  '1\r\n00:00:00,500 --> 00:00:01,500\r\nЗдравей, как си?\r\n\r\n' +
  '2\r\n00:00:02,000 --> 00:00:03,000\r\n<i>Всичко ще бъде наред.</i>\r\n';
const EN_ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment
Style: Default,Arial,20,&H00FFFFFF,0,0,2

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,{\\an8}Hello there
Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,{\\i1}General Kenobi{\\i0}
`;

let tmp;
let db;
let server;
let base;
let cacheDir;
const originalCacheDir = config.subtitleCacheDir;

function ffmpeg(args) {
  execFileSync(config.ffmpegPath, ['-v', 'error', '-y', ...args], { windowsHide: true });
}

before(async () => {
  if (!tools) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-embedded-'));
  // Opening media details starts a storyboard; keep it out of the real cache.
  config.storyboardCacheDir = path.join(tmp, 'storyboards');
  cacheDir = path.join(tmp, 'cache');
  config.subtitleCacheDir = cacheDir;

  const movies = path.join(tmp, 'Movies');
  fs.mkdirSync(movies);
  const bgSrt = path.join(tmp, 'bg.srt');
  const enAss = path.join(tmp, 'en.ass');
  fs.writeFileSync(bgSrt, iconv.encode(BG_SRT, 'win1251')); // stored as-is, like in old MKVs
  fs.writeFileSync(enAss, EN_ASS);
  const video = ['-f', 'lavfi', '-i', 'color=c=black:s=64x36:d=4:r=5'];

  // MKV: Windows-1251 SubRip (bg, forced) + ASS (en)
  ffmpeg([
    ...video, '-i', bgSrt, '-i', enAss,
    '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-c:s:0', 'copy', '-c:s:1', 'copy',
    '-metadata:s:s:0', 'language=bul', '-disposition:s:0', 'forced',
    '-metadata:s:s:1', 'language=eng', '-metadata:s:s:1', 'title=English SDH',
    path.join(movies, 'Heat (1995).mkv'),
  ]);
  // MP4: mov_text (en)
  ffmpeg([
    ...video, '-i', enAss, '-map', '0', '-map', '1', '-c:v', 'libx264', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=eng', path.join(movies, 'Ronin (1998).mp4'),
  ]);

  db = initDb(':memory:');
  await scanLibrary(db, { movie: [movies], episode: [], video: [] });
  await probePendingMedia(db);

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  config.subtitleCacheDir = originalCacheDir;
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function mediaId(title) {
  return db.prepare('SELECT id FROM media WHERE title = ?').get(title).id;
}

async function getJson(url) {
  const res = await fetch(base + url);
  return { status: res.status, body: await res.json() };
}

test('text subtitle streams are listed in the media details', { skip }, async () => {
  const { body } = await getJson(`/api/media/${mediaId('Heat')}`);
  const subs = body.subtitles.map((s) => ({ language: s.language, tags: s.tags, embedded: s.embedded, title: s.title }));
  assert.deepEqual(subs, [
    { language: 'bg', tags: ['forced'], embedded: true, title: null },
    { language: 'en', tags: ['sdh'], embedded: true, title: 'English SDH' },
  ]);
});

test('an embedded Windows-1251 SubRip stream is extracted and decoded', { skip }, async () => {
  const { body: details } = await getJson(`/api/media/${mediaId('Heat')}`);
  const res = await fetch(`${base}/api/subtitles/${details.subtitles[0].id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-subtitle-encoding'), 'windows-1251');
  assert.deepEqual(await res.json(), [
    { start: 0.5, end: 1.5, text: 'Здравей, как си?' },
    { start: 2, end: 3, text: '<i>Всичко ще бъде наред.</i>' },
  ]);
  // Every text stream of the file was extracted in the same pass.
  assert.equal(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.srt')).length, 2);
});

test('ASS and MP4 mov_text streams are converted to plain cues', { skip }, async () => {
  const { body: heat } = await getJson(`/api/media/${mediaId('Heat')}`);
  const ass = await getJson(`/api/subtitles/${heat.subtitles[1].id}`);
  assert.deepEqual(ass.body.map((c) => c.text), ['Hello there', '<i>General Kenobi</i>']);

  const { body: ronin } = await getJson(`/api/media/${mediaId('Ronin')}`);
  assert.equal(ronin.subtitles.length, 1);
  const movText = await getJson(`/api/subtitles/${ronin.subtitles[0].id}`);
  assert.deepEqual(movText.body.map((c) => [c.start, c.end]), [[0.5, 1.5], [2, 3]]);
});

test('rescans keep embedded rows and their ids', { skip }, async () => {
  const before = db.prepare('SELECT id FROM subtitles WHERE stream_index IS NOT NULL ORDER BY id').all();
  await scanLibrary(db, { movie: [path.join(tmp, 'Movies')], episode: [], video: [] });
  db.prepare('UPDATE media SET probed_mtime = NULL').run();
  await probePendingMedia(db);
  const after = db.prepare('SELECT id, available FROM subtitles WHERE stream_index IS NOT NULL ORDER BY id').all();
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id));
  assert.ok(after.every((r) => r.available === 1));
});
