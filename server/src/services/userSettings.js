// Per-profile user settings: subtitle style and per-file subtitle offsets.
import { getDb, parseJson } from '../db/index.js';

export class ValidationError extends Error {}

export const SUBTITLE_DEFAULTS = {
  size: 'M', // S | M | L | XL
  color: '#ffffff',
  background: 'semi', // none | semi | solid
  position: 8, // distance from the bottom of the screen, % of its height
  language: 'bg', // preferred subtitle language (ISO 639-1), or "off"
};

const SIZES = ['S', 'M', 'L', 'XL'];
const BACKGROUNDS = ['none', 'semi', 'solid'];
const MAX_OFFSET_SECONDS = 3600;

function validateSubtitleSettings(patch) {
  const clean = {};
  if (patch.size !== undefined) {
    if (!SIZES.includes(patch.size)) throw new ValidationError(`size must be one of ${SIZES.join(', ')}`);
    clean.size = patch.size;
  }
  if (patch.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(patch.color)) throw new ValidationError('color must be a hex colour like #ffffff');
    clean.color = patch.color.toLowerCase();
  }
  if (patch.background !== undefined) {
    if (!BACKGROUNDS.includes(patch.background)) throw new ValidationError(`background must be one of ${BACKGROUNDS.join(', ')}`);
    clean.background = patch.background;
  }
  if (patch.position !== undefined) {
    const position = Number(patch.position);
    if (!Number.isFinite(position) || position < 0 || position > 40) throw new ValidationError('position must be 0-40');
    clean.position = position;
  }
  if (patch.language !== undefined) {
    if (patch.language !== 'off' && !/^[a-z]{2}$/.test(patch.language)) throw new ValidationError('language must be a 2-letter code or "off"');
    clean.language = patch.language;
  }
  return clean;
}

export function getSubtitleSettings(profileId) {
  const row = getDb().prepare("SELECT value FROM settings WHERE profile_id = ? AND key = 'subtitles'").get(profileId);
  return { ...SUBTITLE_DEFAULTS, ...parseJson(row && row.value, {}) };
}

/** Merges a partial update into the stored settings and returns the full result. */
export function updateSubtitleSettings(profileId, patch) {
  if (!patch || typeof patch !== 'object') throw new ValidationError('Expected a JSON object');
  const settings = { ...getSubtitleSettings(profileId), ...validateSubtitleSettings(patch) };
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (profile_id, key, value) VALUES (?, 'subtitles', ?)")
    .run(profileId, JSON.stringify(settings));
  return settings;
}

export function getSubtitleOffset(profileId, mediaId) {
  const row = getDb()
    .prepare('SELECT offset_seconds FROM subtitle_offsets WHERE profile_id = ? AND media_id = ?')
    .get(profileId, mediaId);
  return row ? row.offset_seconds : 0;
}

/** Stores the offset for one media file; 0 removes it. */
export function setSubtitleOffset(profileId, mediaId, offset) {
  const value = Number(offset);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_OFFSET_SECONDS) {
    throw new ValidationError(`offset must be a number of seconds between -${MAX_OFFSET_SECONDS} and ${MAX_OFFSET_SECONDS}`);
  }
  const rounded = Math.round(value * 1000) / 1000;
  const db = getDb();
  if (rounded === 0) {
    db.prepare('DELETE FROM subtitle_offsets WHERE profile_id = ? AND media_id = ?').run(profileId, mediaId);
  } else {
    db.prepare(
      'INSERT OR REPLACE INTO subtitle_offsets (profile_id, media_id, offset_seconds, updated_at) VALUES (?, ?, ?, ?)'
    ).run(profileId, mediaId, rounded, Date.now());
  }
  return rounded;
}
