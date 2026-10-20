// Watch progress (write side). Reading it into lists, details and "Continue watching"
// happens in services/library.js.
import { getDb } from '../db/index.js';

// Past 90% (or past the start of the credits) an item counts as watched.
export const WATCHED_RATIO = 0.9;
// "Continue watching" shows items between 5% and 90%.
export const CONTINUE_MIN_RATIO = 0.05;
// The player resumes only if at least this much was watched (less is just a peek).
export const RESUME_MIN_SECONDS = 10;

export class ProgressError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Where playback should start for a progress row: the saved position, or 0. */
export function resumePosition(progress, mediaDuration) {
  if (!progress || progress.position < RESUME_MIN_SECONDS) return 0;
  const duration = progress.duration || mediaDuration;
  if (duration && progress.position / duration >= WATCHED_RATIO) return 0;
  return progress.position;
}

function isFinished(position, duration, creditsAt) {
  if (creditsAt && position >= creditsAt) return true;
  return !!duration && position / duration >= WATCHED_RATIO;
}

/**
 * Stores the player's position. Past 90% (or the credits) the item is marked watched
 * and its position reset to 0, so it starts from the beginning next time.
 */
export function saveProgress(profileId, mediaId, position, duration) {
  const pos = Number(position);
  const dur = duration === undefined || duration === null ? null : Number(duration);
  if (!Number.isFinite(pos) || pos < 0) throw new ProgressError(400, 'position must be a number of seconds >= 0');
  if (dur !== null && (!Number.isFinite(dur) || dur <= 0)) throw new ProgressError(400, 'duration must be a positive number');

  const db = getDb();
  const media = db.prepare('SELECT duration, credits_at FROM media WHERE id = ?').get(mediaId);
  if (!media) throw new ProgressError(404, 'Media not found');

  const total = dur || media.duration || null;
  const existing = db.prepare('SELECT * FROM progress WHERE profile_id = ? AND media_id = ?').get(profileId, mediaId);
  const now = Date.now();

  if (isFinished(pos, total, media.credits_at)) {
    // Count a viewing once, not for every report the player sends during the credits.
    const alreadyCounted = existing && existing.watched && existing.position === 0;
    db.prepare(
      `INSERT INTO progress (profile_id, media_id, position, duration, watched, watched_at, play_count, updated_at)
       VALUES (@profileId, @mediaId, 0, @total, 1, @now, 1, @now)
       ON CONFLICT (profile_id, media_id) DO UPDATE SET
         position = 0, duration = @total, watched = 1, watched_at = @now, updated_at = @now,
         play_count = play_count + @increment`
    ).run({ profileId, mediaId, total, now, increment: alreadyCounted ? 0 : 1 });
  } else {
    db.prepare(
      `INSERT INTO progress (profile_id, media_id, position, duration, updated_at)
       VALUES (@profileId, @mediaId, @pos, @total, @now)
       ON CONFLICT (profile_id, media_id) DO UPDATE SET
         position = @pos, duration = COALESCE(@total, duration), updated_at = @now`
    ).run({ profileId, mediaId, pos, total, now });
  }
  return getProgress(profileId, mediaId);
}

export function getProgress(profileId, mediaId) {
  const row = getDb().prepare('SELECT * FROM progress WHERE profile_id = ? AND media_id = ?').get(profileId, mediaId);
  if (!row) return { mediaId, position: 0, duration: null, watched: false };
  return { mediaId, position: row.position, duration: row.duration, watched: !!row.watched };
}

function writeWatched(db, profileId, mediaIds, watched) {
  const now = Date.now();
  const statement = watched
    ? db.prepare(
        `INSERT INTO progress (profile_id, media_id, position, watched, watched_at, play_count, updated_at)
         VALUES (?, ?, 0, 1, ?, 1, ?)
         ON CONFLICT (profile_id, media_id) DO UPDATE SET
           position = 0, watched = 1, watched_at = excluded.watched_at, updated_at = excluded.updated_at`
      )
    : db.prepare(
        // "Unwatched" also forgets the position, but keeps the row's history (play_count).
        `UPDATE progress SET position = 0, watched = 0, watched_at = NULL, updated_at = ?
         WHERE profile_id = ? AND media_id = ?`
      );
  db.transaction(() => {
    for (const mediaId of mediaIds) {
      if (watched) statement.run(profileId, mediaId, now, now);
      else statement.run(now, profileId, mediaId);
    }
  })();
}

/** Manual watched / unwatched toggle for one movie, episode or video. */
export function setWatched(profileId, mediaId, watched) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM media WHERE id = ?').get(mediaId)) throw new ProgressError(404, 'Media not found');
  writeWatched(db, profileId, [mediaId], watched);
  return getProgress(profileId, mediaId);
}

/** Marks every available episode of a series watched or unwatched. */
export function setSeriesWatched(profileId, seriesId, watched) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM series WHERE id = ?').get(seriesId)) throw new ProgressError(404, 'Series not found');
  const ids = db
    .prepare("SELECT id FROM media WHERE series_id = ? AND type = 'episode' AND available = 1")
    .all(seriesId)
    .map((row) => row.id);
  writeWatched(db, profileId, ids, watched);
}
