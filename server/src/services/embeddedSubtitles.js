// Subtitles stored inside the video file (MKV, MP4). ffprobe lists the streams (services/probe.js),
// and ffmpeg extracts the text ones to .srt files in server/cache/subtitles the first time they
// are needed. From then on they are read like any external subtitle file.
//
// Extraction is fast (ffmpeg skips the video and audio data, ~1-3 s for a movie on an SSD), but it
// still reads through the file, so it starts as soon as the TV opens an item's details - by the
// time the player asks for the cues they are usually ready.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { languageFromCode, readSubtitleFile } from './subtitles.js';

// Text formats ffmpeg can turn into SRT. Picture-based ones (PGS from Blu-ray, VobSub from DVD)
// would need OCR, so they are not listed.
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
// SubRip is copied byte for byte, so its encoding is detected like an external .srt's (older MKVs
// carry Windows-1251 text, which ffmpeg would mangle as UTF-8). Other formats are converted.
const COPY_CODECS = new Set(['subrip', 'srt']);

const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

let ffmpegAvailable = null; // null = not checked yet

export async function isFfmpegAvailable() {
  if (ffmpegAvailable === null) {
    ffmpegAvailable = await new Promise((resolve) => {
      execFile(config.ffmpegPath, ['-version'], { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
    });
    if (!ffmpegAvailable) {
      console.warn('! ffmpeg not found - subtitles embedded in MKV/MP4 files are not available. Install FFmpeg or set FFMPEG_PATH.');
    }
  }
  return ffmpegAvailable;
}

/** ["forced"], ["sdh"] from the stream's flags and title ("English SDH", "Forced"). */
function streamTags(stream) {
  const title = (stream.title || '').toLowerCase();
  const tags = [];
  if (stream.forced || /\bforced\b/.test(title)) tags.push('forced');
  if (stream.hearingImpaired || /\b(sdh|cc)\b|hearing/.test(title)) tags.push('sdh');
  return tags;
}

/**
 * Makes the subtitles table list the text subtitle streams ffprobe found in a media file.
 * Rows are keyed by stream index, so their ids stay the same across re-probes.
 * @param media    { id, size, mtime_ms }
 * @param streams  probe info's `subtitles`: [{ index, codec, language, title, forced, hearingImpaired }]
 */
export function syncEmbeddedSubtitles(db, media, streams) {
  const text = (streams || []).filter((s) => Number.isInteger(s.index) && TEXT_CODECS.has(s.codec));
  const upsert = db.prepare(`
    INSERT INTO subtitles (media_id, stream_index, title, format, language, tags, size, mtime_ms, available, added_at)
    VALUES (@mediaId, @index, @title, @codec, @language, @tags, @size, @mtimeMs, 1, @now)
    ON CONFLICT (media_id, stream_index) DO UPDATE SET
      title = excluded.title, format = excluded.format, language = excluded.language, tags = excluded.tags,
      size = excluded.size, mtime_ms = excluded.mtime_ms, available = 1`);
  const existing = db.prepare('SELECT id, stream_index FROM subtitles WHERE media_id = ? AND stream_index IS NOT NULL');
  const remove = db.prepare('DELETE FROM subtitles WHERE id = ?');

  db.transaction(() => {
    const now = Date.now();
    for (const stream of text) {
      upsert.run({
        mediaId: media.id,
        index: stream.index,
        title: stream.title || null,
        codec: stream.codec,
        language: languageFromCode(stream.language),
        tags: JSON.stringify(streamTags(stream)),
        size: media.size,
        mtimeMs: media.mtime_ms,
        now,
      });
    }
    const kept = new Set(text.map((s) => s.index));
    for (const row of existing.all(media.id)) {
      if (!kept.has(row.stream_index)) remove.run(row.id);
    }
  })();
  return text.length;
}

// --- extraction ----------------------------------------------------------------------------

/** The cache file of one stream. The file's mtime is in the name, so a replaced video re-extracts. */
function cachePath(media, streamIndex) {
  return path.join(config.subtitleCacheDir, `${media.id}-${streamIndex}-${media.mtime_ms}.srt`);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(config.ffmpegPath, args, { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr && String(stderr).trim().split('\n').pop()) || err.message));
      else resolve();
    });
  });
}

/** One ffmpeg run that writes every given stream to its cache file (the video is read once). */
async function extractStreams(media, rows) {
  const args = ['-nostdin', '-v', 'error', '-y', '-i', media.path];
  const outputs = [];
  for (const row of rows) {
    const final = cachePath(media, row.stream_index);
    const temp = final + '.part'; // renamed when complete, so a crash never leaves a half file
    outputs.push({ temp, final });
    args.push('-map', `0:${row.stream_index}`, '-c:s', COPY_CODECS.has(row.format) ? 'copy' : 'srt', '-f', 'srt', temp);
  }
  try {
    await runFfmpeg(args);
    for (const { temp, final } of outputs) await fs.promises.rename(temp, final);
  } finally {
    for (const { temp } of outputs) fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}

/** Deletes the extracted files of earlier versions of a video. */
async function removeStaleFiles(media) {
  const prefix = `${media.id}-`;
  const suffix = `-${media.mtime_ms}.srt`;
  const names = await fs.promises.readdir(config.subtitleCacheDir).catch(() => []);
  for (const name of names) {
    if (name.startsWith(prefix) && !name.endsWith(suffix) && /^\d+-\d+-\d+\.srt(\.part)?$/.test(name)) {
      await fs.promises.rm(path.join(config.subtitleCacheDir, name), { force: true }).catch(() => {});
    }
  }
}

async function extractMissing(media, rows) {
  await fs.promises.mkdir(config.subtitleCacheDir, { recursive: true });
  await removeStaleFiles(media);
  const started = Date.now();
  try {
    await extractStreams(media, rows);
  } catch (err) {
    if (rows.length === 1) throw err;
    // One broken stream fails the whole run; extract the rest one by one.
    console.warn(`Subtitle extraction failed for ${media.path} (${err.message}) - retrying stream by stream`);
    for (const row of rows) {
      await extractStreams(media, [row]).catch((e) =>
        console.warn(`  stream ${row.stream_index} (${row.format}) cannot be extracted: ${e.message}`)
      );
    }
  }
  let extracted = 0;
  for (const row of rows) {
    if (fs.existsSync(cachePath(media, row.stream_index))) extracted++;
    else unextractable.add(cachePath(media, row.stream_index)); // don't run ffmpeg for it again
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Extracted ${extracted} of ${rows.length} embedded subtitle(s) from ${path.basename(media.path)} in ${seconds}s`);
}

const inFlight = new Map(); // "mediaId-mtime" -> promise
const unextractable = new Set(); // cache paths of streams ffmpeg failed on

/** Extracts every not-yet-extracted text subtitle stream of a media file. Concurrent calls share one run. */
async function ensureExtracted(db, mediaId) {
  if (!(await isFfmpegAvailable())) throw new Error('ffmpeg is not available');
  const media = db.prepare('SELECT id, path, mtime_ms FROM media WHERE id = ? AND available = 1').get(mediaId);
  if (!media) throw new Error('Media file is not available');

  const key = `${media.id}-${media.mtime_ms}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const rows = db
    .prepare('SELECT stream_index, format FROM subtitles WHERE media_id = ? AND stream_index IS NOT NULL AND available = 1')
    .all(media.id)
    .map((row) => ({ ...row, file: cachePath(media, row.stream_index) }))
    .filter((row) => !unextractable.has(row.file) && !fs.existsSync(row.file));
  if (!rows.length) return media;

  const run = extractMissing(media, rows)
    .then(() => media)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/** Cues of an embedded subtitle row: { encoding, cues }. Extracts the file's streams first if needed. */
export async function readEmbeddedSubtitle(db, row) {
  const media = await ensureExtracted(db, row.media_id);
  return readSubtitleFile(cachePath(media, row.stream_index));
}

/** Starts extracting a media file's embedded subtitles in the background (no-op when there are none). */
export function prefetchEmbeddedSubtitles(db, mediaId) {
  const has = db.prepare('SELECT 1 FROM subtitles WHERE media_id = ? AND stream_index IS NOT NULL AND available = 1 LIMIT 1');
  if (!has.get(mediaId)) return;
  ensureExtracted(db, mediaId).catch((err) => console.warn(`Subtitle extraction failed for media ${mediaId}: ${err.message}`));
}
