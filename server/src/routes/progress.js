import { Router } from 'express';
import { getDb } from '../db/index.js';
import { profileId } from '../profiles.js';
import { prefetchEmbeddedSubtitles } from '../services/embeddedSubtitles.js';
import { getContinueWatching, getNextEpisode } from '../services/library.js';
import { ProgressError, saveProgress, setSeriesWatched, setWatched } from '../services/progress.js';

const router = Router();

function handle(res, fn) {
  try {
    res.json(fn());
  } catch (err) {
    if (!(err instanceof ProgressError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

function watchedFlag(body) {
  if (!body || typeof body.watched !== 'boolean') throw new ProgressError(400, 'Body must be { "watched": true | false }');
  return body.watched;
}

// { mediaId, position, duration } - sent by the player every 10 s, on pause and on exit.
router.post('/progress', (req, res) => {
  const body = req.body || {};
  handle(res, () => saveProgress(profileId(req), Number(body.mediaId), body.position, body.duration));
});

router.get('/continue-watching', (req, res) => {
  res.json(getContinueWatching(profileId(req)));
});

// The next episode across season boundaries, or null.
router.get('/episodes/:id/next', (req, res) => {
  const next = getNextEpisode(Number(req.params.id), profileId(req));
  if (next) prefetchEmbeddedSubtitles(getDb(), next.id);
  res.json(next);
});

// Manual toggle: { "watched": true | false }
router.put('/media/:id/watched', (req, res) => {
  handle(res, () => setWatched(profileId(req), Number(req.params.id), watchedFlag(req.body)));
});

router.put('/series/:id/watched', (req, res) => {
  handle(res, () => {
    setSeriesWatched(profileId(req), Number(req.params.id), watchedFlag(req.body));
    return { seriesId: Number(req.params.id), watched: req.body.watched };
  });
});

export default router;
