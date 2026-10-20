// External subtitles: matching files to videos, detecting the encoding (many Bulgarian
// .srt files are Windows-1251) and parsing SRT / WebVTT into clean JSON cues.
import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import jschardet from 'jschardet';

export const SUBTITLE_EXTENSIONS = ['.srt', '.vtt'];

export function isSubtitleFile(filePath) {
  return SUBTITLE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

// --- language from the file name ------------------------------------------------------

const LANGUAGE_NAMES = {
  bg: ['bg', 'bul', 'bulgarian', 'български', 'bgr'],
  en: ['en', 'eng', 'english'],
  ru: ['ru', 'rus', 'russian'],
  de: ['de', 'ger', 'deu', 'german'],
  fr: ['fr', 'fre', 'fra', 'french'],
  es: ['es', 'spa', 'spanish'],
  it: ['it', 'ita', 'italian'],
  tr: ['tr', 'tur', 'turkish'],
  el: ['el', 'gre', 'ell', 'greek'],
  sr: ['sr', 'srp', 'scc', 'serbian'],
  mk: ['mk', 'mac', 'mkd', 'macedonian'],
  ro: ['ro', 'rum', 'ron', 'romanian'],
  pl: ['pl', 'pol', 'polish'],
  pt: ['pt', 'por', 'portuguese'],
  nl: ['nl', 'dut', 'nld', 'dutch'],
  uk: ['uk', 'ukr', 'ukrainian'],
  hr: ['hr', 'hrv', 'croatian'],
};
const LANGUAGE_BY_TOKEN = {};
for (const code of Object.keys(LANGUAGE_NAMES)) {
  for (const name of LANGUAGE_NAMES[code]) LANGUAGE_BY_TOKEN[name] = code;
}
const TAG_BY_TOKEN = { forced: 'forced', sdh: 'sdh', cc: 'sdh', hi: 'sdh' };

// ISO 639-2 codes used in video containers, for languages not listed above. These aren't
// matched in file names, where two-letter codes like "is", "no" or "he" are ordinary words.
const CONTAINER_LANGUAGES = {
  dan: 'da', est: 'et', lav: 'lv', lit: 'lt', hun: 'hu', nor: 'no', nob: 'no', nno: 'no', slo: 'sk', slk: 'sk',
  slv: 'sl', fin: 'fi', swe: 'sv', ice: 'is', isl: 'is', cze: 'cs', ces: 'cs', jpn: 'ja', chi: 'zh', zho: 'zh',
  kor: 'ko', ara: 'ar', heb: 'he', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms', cat: 'ca',
  alb: 'sq', sqi: 'sq', bos: 'bs', per: 'fa', fas: 'fa', fil: 'fil', baq: 'eu', eus: 'eu', glg: 'gl',
};

/** A container's language tag ("bul", "eng", "pt-BR", "und") -> ISO 639-1 ("bg", "en", "pt") or null. */
export function languageFromCode(code) {
  if (!code) return null;
  const token = String(code).toLowerCase().split(/[-_]/)[0];
  if (!token || token === 'und' || token === 'unk' || token === 'mul' || token === 'zxx') return null;
  if (CONTAINER_LANGUAGES[token]) return CONTAINER_LANGUAGES[token];
  const known = LANGUAGE_BY_TOKEN[token];
  if (known && token.length <= 3) return known;
  return token.length === 2 ? token : null;
}

// Folders that hold the subtitles of the video in the folder above them.
const SUBTITLE_FOLDERS = ['subs', 'sub', 'subtitles', 'субтитри'];

function readTokens(tokens) {
  let language = null;
  const tags = [];
  for (const raw of tokens) {
    const token = raw.toLocaleLowerCase();
    if (!language && LANGUAGE_BY_TOKEN[token]) language = LANGUAGE_BY_TOKEN[token];
    else if (TAG_BY_TOKEN[token] && !tags.includes(TAG_BY_TOKEN[token])) tags.push(TAG_BY_TOKEN[token]);
  }
  return { language, tags };
}

/** Language/tag tokens at the end of a name: "Movie.1999.1080p.bg.forced" -> ["bg", "forced"]. */
function trailingTokens(name) {
  const tokens = name.split(/[.\s_-]+/);
  const result = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i].toLocaleLowerCase();
    if (!LANGUAGE_BY_TOKEN[token] && !TAG_BY_TOKEN[token]) break;
    result.unshift(token);
  }
  return result;
}

/**
 * Finds the video a subtitle file belongs to.
 *   Movie.srt, Movie.bg.srt, Movie.bulgarian.forced.srt  -> "Movie.mkv" in the same folder
 *   Subs/English.srt                                     -> the only video in the folder above
 *   Movie.1999.1080p.BluRay.bg.srt                       -> the only video in the folder
 * @param subtitlePath
 * @param videosByFolder  Map: folder path -> video paths in it
 * @returns {{ videoPath, language, tags } | null}
 */
export function matchSubtitle(subtitlePath, videosByFolder) {
  const folder = path.dirname(subtitlePath);
  const name = path.basename(subtitlePath, path.extname(subtitlePath));
  const inSubsFolder = SUBTITLE_FOLDERS.includes(path.basename(folder).toLocaleLowerCase());
  const videoFolder = inSubsFolder ? path.dirname(folder) : folder;
  const videos = videosByFolder.get(videoFolder) || [];
  if (!videos.length) return null;

  // Same base name, optionally followed by ".bg", ".en.forced", ... - the longest match wins.
  const lowerName = name.toLocaleLowerCase();
  let best = null;
  for (const video of videos) {
    const base = path.basename(video, path.extname(video)).toLocaleLowerCase();
    const matches = lowerName === base || (lowerName.startsWith(base) && lowerName.charAt(base.length) === '.');
    if (matches && (!best || base.length > best.base.length)) best = { video, base };
  }
  if (best) {
    const rest = name.slice(best.base.length + 1);
    return { videoPath: best.video, ...readTokens(rest ? rest.split('.') : []) };
  }

  // A differently named subtitle belongs to the only video of its folder.
  if (videos.length === 1) {
    // In a "Subs" folder the whole name describes the subtitle ("2_English.srt");
    // elsewhere only trailing tokens do, so a title like "It.2017.srt" isn't Italian.
    const tokens = inSubsFolder ? name.split(/[.\s_-]+/) : trailingTokens(name);
    return { videoPath: videos[0], ...readTokens(tokens) };
  }
  return null;
}

// --- encoding ---------------------------------------------------------------------------

// Tried in this order; the first one wins a tie, so Windows-1251 is the default for Cyrillic.
const CYRILLIC_ENCODINGS = ['windows-1251', 'maccyrillic', 'koi8-r', 'ibm866', 'iso-8859-5'];
const NON_LATIN_SINGLE_BYTE = /1253|8859-7|greek|1255|8859-8|hebrew|1256|arabic|874|tis-620|thai/i;

// Approximate letter frequencies (%) in Bulgarian/Russian text. A wrong Cyrillic code page
// still produces Cyrillic letters, but shuffled ones, so the right decoding is the one whose
// letters are the most common. This works the same for lowercase and ALL CAPS text.
const CYRILLIC_FREQUENCY = {
  о: 10, е: 8.5, а: 8.5, и: 7.5, н: 6.7, т: 6.3, с: 5.5, р: 4.7, в: 4.5, л: 4.4, к: 3.5, м: 3.2,
  д: 3, п: 2.8, у: 2.6, я: 2, ы: 1.9, ъ: 1.8, ь: 1.7, г: 1.7, з: 1.6, б: 1.6, ч: 1.4, й: 1.2,
  х: 1, ж: 0.9, ш: 0.7, ю: 0.6, ц: 0.5, щ: 0.4, э: 0.3, ф: 0.3, ё: 0.1, ѝ: 0.1,
};
const NEUTRAL = /[ «»–-…№]/; // nbsp « » dashes, quotes, … №

const isLower = (ch) => ch !== ch.toUpperCase();
const isUpper = (ch) => ch !== ch.toLowerCase();

/**
 * How much a decoding looks like real Cyrillic text:
 *   { score, average (per non-ASCII character), flipRatio (case flips per word) }.
 * Besides letter frequency, a lowercase letter followed by a capital inside a word
 * ("йАКГЛщЯА") is penalised: real text almost never does that, wrong code pages often do.
 */
function cyrillicScore(text) {
  let score = 0;
  let count = 0;
  let flips = 0;
  let words = 0;
  let previous = '';
  for (const ch of text) {
    const letter = isLower(ch) || isUpper(ch);
    if (letter && !(isLower(previous) || isUpper(previous))) words++;
    if (isLower(previous) && isUpper(ch)) {
      score -= 8;
      flips++;
    }
    previous = ch;
    if (ch.charCodeAt(0) < 0x80 || NEUTRAL.test(ch)) continue;
    const frequency = CYRILLIC_FREQUENCY[ch.toLowerCase()];
    score += frequency !== undefined ? frequency : -10;
    count++;
  }
  return { score, average: count ? score / count : 0, flipRatio: words ? flips / words : 0 };
}

// Real Cyrillic text averages ~5.5 per letter (shuffled text from a wrong code page ~3)
// and has (almost) no words like "йАКГЛщЯА".
function looksLikeRealCyrillic(result) {
  return result.average >= 4 && result.flipRatio < 0.05;
}

/** Decodes with every Cyrillic code page and keeps the most plausible result. */
function bestCyrillicDecoding(buffer) {
  const results = CYRILLIC_ENCODINGS.map((encoding) => {
    const text = iconv.decode(buffer, encoding);
    return { text, encoding, ...cyrillicScore(text) };
  });
  // Windows-1251 is by far the most common for Bulgarian subtitles: another code page
  // has to be clearly better to win (this also settles tiny files, where statistics can't).
  const preferred = results[0];
  let best = preferred;
  for (const result of results.slice(1)) {
    if (result.score > preferred.score * 1.1 + 5 && result.score > best.score) best = result;
  }
  return best;
}

/**
 * Decodes a subtitle file to a string. Returns { text, encoding }.
 * Order: BOM -> valid UTF-8 -> mostly high bytes (Cyrillic and friends) -> chardet guess.
 */
export function decodeSubtitle(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.toString('utf8', 3), encoding: 'utf-8' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: iconv.decode(buffer.subarray(2), 'utf-16le'), encoding: 'utf-16le' };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return { text: iconv.decode(buffer.subarray(2), 'utf-16be'), encoding: 'utf-16be' };

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    // not UTF-8
  }

  const detected = jschardet.detect(buffer);
  const guess = detected && detected.encoding ? detected.encoding.toLowerCase() : null;

  // In Cyrillic (and Greek, Hebrew...) text almost every letter is a byte >= 0x80;
  // in Western European text only the accented ones are.
  let high = 0;
  let asciiLetters = 0;
  for (const byte of buffer) {
    if (byte >= 0x80) high++;
    else if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)) asciiLetters++;
  }
  const mostlyHigh = high / Math.max(1, high + asciiLetters) > 0.3;

  if (mostlyHigh) {
    // chardet often can't tell Windows-1251 from MacCyrillic (or even from Greek) on
    // subtitle-sized files, so decide by how real the decoded Cyrillic text looks.
    const cyrillic = bestCyrillicDecoding(buffer);
    const otherScript = guess && NON_LATIN_SINGLE_BYTE.test(guess) && iconv.encodingExists(guess);
    if (!otherScript || looksLikeRealCyrillic(cyrillic)) {
      return { text: cyrillic.text, encoding: cyrillic.encoding };
    }
    return { text: iconv.decode(buffer, guess), encoding: guess };
  }

  const encoding = guess && guess !== 'ascii' && iconv.encodingExists(guess) ? guess : 'windows-1252';
  return { text: iconv.decode(buffer, encoding), encoding };
}

// --- language from the text ---------------------------------------------------------------

const ENGLISH_WORDS = new Set(['the', 'you', 'and', 'to', 'is', 'what', 'it', 'i', 'a', 'of', 'that', 'in', 'me', 'we', 'this']);

/** Best guess of a subtitle's language from its text, for files named without one. */
export function guessLanguage(text) {
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length < 20) return null;
  const cyrillic = letters.filter((ch) => /[Ѐ-ӿ]/.test(ch)).length;

  if (cyrillic / letters.length > 0.5) {
    const count = (re) => (text.match(re) || []).length;
    const share = (n) => n / cyrillic;
    if (share(count(/[ыэЫЭ]/g)) > 0.003) return 'ru'; // letters Bulgarian doesn't have
    if (share(count(/[іїєІЇЄ]/g)) > 0.003) return 'uk';
    if (share(count(/[ѓќѕЃЌЅ]/g)) > 0.001) return 'mk';
    if (share(count(/[јљњћђЈЉЊЋЂ]/g)) > 0.003) return 'sr';
    return 'bg';
  }

  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  if (words.length >= 20) {
    const common = words.filter((w) => ENGLISH_WORDS.has(w)).length;
    if (common / words.length > 0.08) return 'en';
  }
  return null;
}

// --- SRT / WebVTT parsing ------------------------------------------------------------------

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

function parseTime(text) {
  const m = TIME.exec(text);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One subtitle line -> safe HTML where only <i> and <b> remain.
 * Drops other tags (<font>, <u>, <c.yellow>, <v Name>, karaoke timestamps) and
 * ASS-style override codes like {\an8}.
 */
export function cleanLine(line) {
  const ALLOWED_OPEN = '\u0001';
  const ALLOWED_CLOSE = '\u0002';
  let text = line
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<(\/?)([ib])(?:\s[^>]*)?>/gi, `${ALLOWED_OPEN}$1$2${ALLOWED_CLOSE}`)
    .replace(/<[^>]*>/g, '');
  text = escapeHtml(decodeEntities(text));
  return text
    .replace(new RegExp(`${ALLOWED_OPEN}(/?)([ib])${ALLOWED_CLOSE}`, 'gi'), (m, slash, tag) => `<${slash}${tag.toLowerCase()}>`)
    .trim();
}

/**
 * Parses SRT or WebVTT text into [{ start, end, text }] (seconds, text with "\n" between lines).
 * Line-based, so it copes with common breakage: missing blank lines, cue numbers glued to the
 * previous cue, "." instead of ",", missing hours, VTT headers, NOTE and STYLE blocks.
 */
export function parseSubtitles(input) {
  const lines = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  let cue = null;

  function finish() {
    if (!cue) return;
    const text = cue.lines.map(cleanLine).filter(Boolean).join('\n');
    if (text) cues.push({ start: Math.round(cue.start * 1000) / 1000, end: Math.round(cue.end * 1000) / 1000, text });
  }

  for (const line of lines) {
    if (line.includes('-->')) {
      const [left, right] = line.split('-->');
      const start = parseTime(left);
      const end = parseTime(right);
      if (start !== null && end !== null && end > start) {
        // A cue number written right after the previous cue's text, without a blank line.
        if (cue && !cue.closed && cue.lines.length && /^\s*\d+\s*$/.test(cue.lines[cue.lines.length - 1])) cue.lines.pop();
        finish();
        cue = { start, end, lines: [], closed: false };
        continue;
      }
    }
    if (!cue || cue.closed) continue; // headers, NOTE/STYLE blocks, cue ids, numbers
    if (!line.trim()) cue.closed = true;
    else cue.lines.push(line);
  }
  finish();

  return cues.sort((a, b) => a.start - b.start);
}

// --- reading files -----------------------------------------------------------------------------

const cache = new Map(); // path -> { size, mtimeMs, result }
const CACHE_SIZE = 20;

/** Reads, decodes and parses a subtitle file. Returns { encoding, cues }. Cached per file version. */
export async function readSubtitleFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  const hit = cache.get(filePath);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.result;

  const { text, encoding } = decodeSubtitle(await fs.promises.readFile(filePath));
  const result = { encoding, cues: parseSubtitles(text) };

  cache.delete(filePath);
  cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, result });
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return result;
}

/** Decodes a file and guesses its language from the text (for names without a language). */
export async function detectLanguageFromFile(filePath) {
  const { text } = decodeSubtitle(await fs.promises.readFile(filePath));
  return guessLanguage(text);
}
