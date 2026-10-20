import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import iconv from 'iconv-lite';
import { cleanLine, decodeSubtitle, guessLanguage, matchSubtitle, parseSubtitles } from '../src/services/subtitles.js';

const BG_TEXT = 'Здравей! Как си? Всичко ще бъде наред, обещавам ти.\nЩе се видим утре в шест часа.';

test('decodes Windows-1251 (short and long), even where chardet is unsure', () => {
  for (const text of ['Здравей, как си?', 'Я', BG_TEXT, 'ЖЕГА\nЩЕ ТЕ НАМЕРЯ']) {
    const result = decodeSubtitle(iconv.encode(text, 'win1251'));
    assert.equal(result.text, text);
    assert.equal(result.encoding, 'windows-1251');
  }
});

test('decodes UTF-8 (with and without BOM) and UTF-16', () => {
  assert.equal(decodeSubtitle(Buffer.from(BG_TEXT, 'utf8')).text, BG_TEXT);
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BG_TEXT)])).text, BG_TEXT);
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(BG_TEXT, 'utf-16le')])).text, BG_TEXT);
  assert.equal(decodeSubtitle(Buffer.from('Plain ASCII only')).encoding, 'utf-8');
});

test('Western European text is not mistaken for Cyrillic', () => {
  const text = "C'est déjà l'été. Où êtes-vous allés? Ça va très bien, merci beaucoup pour votre aide.";
  assert.equal(decodeSubtitle(iconv.encode(text, 'win1252')).text, text);
});

test('KOI8-R and CP866 files are recognised', () => {
  const text = 'Привет, как дела? Всё хорошо, спасибо большое.';
  assert.equal(decodeSubtitle(iconv.encode(text, 'koi8-r')).text, text);
  assert.equal(decodeSubtitle(iconv.encode(text.toUpperCase(), 'koi8-r')).text, text.toUpperCase());
  assert.equal(decodeSubtitle(iconv.encode(text, 'cp866')).text, text);
});

test('Greek files are still decoded as Greek', () => {
  const text = 'Καλημέρα, τι κάνεις; Είμαι καλά, ευχαριστώ πολύ. Θα σε δω αύριο το πρωί στο σπίτι σου.';
  assert.equal(decodeSubtitle(iconv.encode(text, 'win1253')).text, text);
});

test('parses SRT', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:04,500\r\nПърви ред\r\nВтори ред\r\n\r\n2\r\n00:00:05,000 --> 00:00:07,000\r\n<i>Курсив</i>\r\n';
  assert.deepEqual(parseSubtitles(srt), [
    { start: 1, end: 4.5, text: 'Първи ред\nВтори ред' },
    { start: 5, end: 7, text: '<i>Курсив</i>' },
  ]);
});

test('parses broken SRT: no blank lines, dots, missing hours, extra spaces', () => {
  const srt = '1\n00:00:01.5 --> 00:00:02,000\nA\n2\n00:02,000 --> 00:03,250\nB\n\n\n\n3\n 00:00:04,000  -->  00:00:05,000 X1:10 X2:20\nC';
  assert.deepEqual(parseSubtitles(srt), [
    { start: 1.5, end: 2, text: 'A' },
    { start: 2, end: 3.25, text: 'B' },
    { start: 4, end: 5, text: 'C' },
  ]);
});

test('skips invalid and empty cues and sorts by start', () => {
  const srt = '1\n00:00:09,000 --> 00:00:10,000\nLater\n\n2\n00:00:05,000 --> 00:00:04,000\nBackwards\n\n3\n00:00:01,000 --> 00:00:02,000\n<font color="red"></font>\n\n4\n00:00:03,000 --> 00:00:04,000\nEarlier';
  assert.deepEqual(parseSubtitles(srt).map((c) => c.text), ['Earlier', 'Later']);
});

test('parses WebVTT with header, NOTE, STYLE, ids and settings', () => {
  const vtt = [
    'WEBVTT - some title',
    '',
    'STYLE',
    '::cue { color: yellow }',
    '',
    'NOTE this is a comment',
    '',
    'intro',
    '00:01.000 --> 00:04.000 line:90% align:center',
    '<v Roger>Hi &amp; welcome</v>',
    '',
    '00:00:05.000 --> 00:00:06.000',
    '<c.yellow>Coloured</c> <b>bold</b> &lt;3',
  ].join('\n');
  assert.deepEqual(parseSubtitles(vtt), [
    { start: 1, end: 4, text: 'Hi &amp; welcome' },
    { start: 5, end: 6, text: 'Coloured <b>bold</b> &lt;3' },
  ]);
});

test('cleanLine keeps only <i> and <b> and escapes everything else', () => {
  assert.equal(cleanLine('<I>Italic</I> <B class="x">bold</B>'), '<i>Italic</i> <b>bold</b>');
  assert.equal(cleanLine('<font color="#ff0">Yellow</font> <u>under</u>'), 'Yellow under');
  assert.equal(cleanLine('{\\an8}On top'), 'On top');
  assert.equal(cleanLine('<script>alert(1)</script>Tom & Jerry'), 'alert(1)Tom &amp; Jerry');
});

test('matches subtitle files to videos and reads the language', () => {
  const dir = path.join('D:', 'Movies', 'Heat (1995)');
  const video = path.join(dir, 'Heat (1995).mkv');
  const videos = new Map([[dir, [video]]]);
  const match = (name) => matchSubtitle(path.join(dir, name), videos);

  assert.deepEqual(match('Heat (1995).srt'), { videoPath: video, language: null, tags: [] });
  assert.deepEqual(match('Heat (1995).bg.srt'), { videoPath: video, language: 'bg', tags: [] });
  assert.deepEqual(match('Heat (1995).Bulgarian.srt'), { videoPath: video, language: 'bg', tags: [] });
  assert.deepEqual(match('Heat (1995).en.forced.vtt'), { videoPath: video, language: 'en', tags: ['forced'] });
  assert.deepEqual(match('Heat.1995.1080p.BluRay.BG.srt'), { videoPath: video, language: 'bg', tags: [] }); // only video
  assert.deepEqual(match('It.2017.srt'), { videoPath: video, language: null, tags: [] }); // "It" isn't Italian
  assert.deepEqual(matchSubtitle(path.join(dir, 'Subs', '2_English.srt'), videos), { videoPath: video, language: 'en', tags: [] });
});

test('with several videos in a folder, only matching names are attached', () => {
  const dir = path.join('D:', 'Series', 'Show', 'Season 01');
  const e1 = path.join(dir, 'Show S01E01.mkv');
  const e10 = path.join(dir, 'Show S01E10.mkv');
  const videos = new Map([[dir, [e1, e10]]]);
  assert.equal(matchSubtitle(path.join(dir, 'Show S01E10.bg.srt'), videos).videoPath, e10);
  assert.equal(matchSubtitle(path.join(dir, 'Show S01E01.srt'), videos).videoPath, e1);
  assert.equal(matchSubtitle(path.join(dir, 'random.srt'), videos), null);
});

test('guesses the language of the text', () => {
  assert.equal(guessLanguage(BG_TEXT + BG_TEXT), 'bg');
  assert.equal(guessLanguage('Это просто тест. Мы были здесь вчера, и это было очень хорошо. Это всё.'), 'ru');
  const english = "What are you doing here? I told you to wait in the car. It is not safe for us. ";
  assert.equal(guessLanguage(english + english), 'en');
  assert.equal(guessLanguage('short'), null);
});
