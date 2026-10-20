import { Router } from 'express';
import { getDb } from '../db/index.js';
import { profileId } from '../profiles.js';
import { readEmbeddedSubtitle } from '../services/embeddedSubtitles.js';
import { readSubtitleFile } from '../services/subtitles.js';
import {
  getSubtitleOffset,
  getSubtitleSettings,
  setSubtitleOffset,
  updateSubtitleSettings,
  ValidationError,
} from '../services/userSettings.js';

const router = Router();

// Cues as [{ start, end, text }] - seconds, and text as HTML with only <i>/<b> and "\n" between lines.
// A subtitle embedded in the video is extracted on first use, which can take a few seconds.
router.get('/subtitles/:id', async (req, res) => {
  const db = getDb();
  const row = db
    .prepare('SELECT media_id, path, stream_index FROM subtitles WHERE id = ? AND available = 1')
    .get(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Subtitle not found' });
    return;
  }
  let result;
  try {
    result = row.stream_index === null ? await readSubtitleFile(row.path) : await readEmbeddedSubtitle(db, row);
  } catch (err) {
    if (row.stream_index !== null) console.warn(`Embedded subtitle ${row.stream_index} of media ${row.media_id}: ${err.message}`);
    res.status(404).json({ error: 'Subtitle file is not available' });
    return;
  }
  res.setHeader('X-Subtitle-Encoding', result.encoding);
  res.json(result.cues);
});

router.get('/settings/subtitles', (req, res) => {
  res.json(getSubtitleSettings(profileId(req)));
});

router.put('/settings/subtitles', (req, res) => {
  try {
    res.json(updateSubtitleSettings(profileId(req), req.body));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

function mediaExists(id) {
  return !!getDb().prepare('SELECT 1 FROM media WHERE id = ?').get(id);
}

router.get('/subtitle-offset/:mediaId', (req, res) => {
  const mediaId = Number(req.params.mediaId);
  if (!mediaExists(mediaId)) {
    res.status(404).json({ error: 'Media not found' });
    return;
  }
  res.json({ mediaId, offset: getSubtitleOffset(profileId(req), mediaId) });
});

// { "offset": 0.75 } - seconds; positive shows subtitles earlier.
router.put('/subtitle-offset/:mediaId', (req, res) => {
  const mediaId = Number(req.params.mediaId);
  if (!mediaExists(mediaId)) {
    res.status(404).json({ error: 'Media not found' });
    return;
  }
  try {
    const offset = setSubtitleOffset(profileId(req), mediaId, req.body && req.body.offset);
    res.json({ mediaId, offset });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

export default router;
