// Reads duration and stream info with ffprobe, if it is installed.
// Without ffprobe everything still works - media just has no duration/codec info.
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { isFfmpegAvailable, syncEmbeddedSubtitles } from './embeddedSubtitles.js';

let ffprobeAvailable = null; // null = not checked yet

function run(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(config.ffprobePath, args, { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function isFfprobeAvailable() {
  if (ffprobeAvailable === null) {
    try {
      await run(['-version'], 5000);
      ffprobeAvailable = true;
    } catch {
      ffprobeAvailable = false;
      console.warn('! ffprobe not found - duration and codec info will be missing. Install FFmpeg or set FFPROBE_PATH.');
    }
  }
  return ffprobeAvailable;
}

function streamLanguage(stream) {
  return (stream.tags && stream.tags.language) || null;
}

function streamTitle(stream) {
  return (stream.tags && (stream.tags.title || stream.tags.TITLE)) || null;
}

const flag = (stream, name) => !!(stream.disposition && stream.disposition[name]);

/** Runs ffprobe on a file and returns { duration, info } with only the fields the app uses. */
export async function probeFile(filePath) {
  const stdout = await run(
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    30000
  );
  const data = JSON.parse(stdout);
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));

  const info = {
    container: (data.format && data.format.format_name) || null,
    video: video
      ? {
          codec: video.codec_name || null,
          profile: video.profile || null,
          width: video.width || null,
          height: video.height || null,
          pixFmt: video.pix_fmt || null,
        }
      : null,
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({
        codec: s.codec_name || null,
        channels: s.channels || null,
        language: streamLanguage(s),
        default: !!(s.disposition && s.disposition.default),
      })),
    subtitles: streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({
        index: s.index,
        codec: s.codec_name || null,
        language: streamLanguage(s),
        title: streamTitle(s),
        default: flag(s, 'default'),
        forced: flag(s, 'forced'),
        hearingImpaired: flag(s, 'hearing_impaired'),
      })),
  };

  const duration = Number(data.format && data.format.duration);
  return { duration: isFinite(duration) && duration > 0 ? duration : null, info };
}

let queueRunning = false;
let queueAgain = false;

/**
 * Probes every available file that hasn't been probed since it last changed.
 * Runs in the background, one file at a time, so the PC stays responsive.
 * A call while the queue runs (a scan found new files) makes it run once more afterwards.
 */
export async function probePendingMedia(db) {
  if (queueRunning) {
    queueAgain = true;
    return;
  }
  if (!(await isFfprobeAvailable())) return;
  queueRunning = true;
  try {
    do {
      queueAgain = false;
      await probeQueue(db);
    } while (queueAgain);
  } finally {
    queueRunning = false;
  }
}

async function probeQueue(db) {
  // Embedded subtitles are listed only if ffmpeg can extract them.
  const withSubtitles = await isFfmpegAvailable();
  const pending = db
    .prepare(
      'SELECT id, path, size, mtime_ms FROM media WHERE available = 1 AND (probed_mtime IS NULL OR probed_mtime != mtime_ms)'
    )
    .all();
  const save = db.prepare('UPDATE media SET duration = ?, probe = ?, probed_mtime = ? WHERE id = ?');

  if (pending.length) console.log(`Probing ${pending.length} file(s) with ffprobe...`);
  for (const item of pending) {
    try {
      const { duration, info } = await probeFile(item.path);
      save.run(duration, JSON.stringify(info), item.mtime_ms, item.id);
      syncEmbeddedSubtitles(db, item, withSubtitles ? info.subtitles : []);
    } catch (err) {
      // Remember the failure so the file isn't re-probed on every scan.
      save.run(null, null, item.mtime_ms, item.id);
      syncEmbeddedSubtitles(db, item, []);
      console.warn(`ffprobe failed for ${item.path}: ${err.message.split('\n')[0]}`);
    }
  }
  if (pending.length) console.log('Probing finished.');
}
