import { Router } from 'express';
import { getDb } from '../db/index.js';
import { prefetchEmbeddedSubtitles } from '../services/embeddedSubtitles.js';
import { getMediaDetails } from '../services/library.js';
import { requestStoryboard } from '../services/storyboard.js';
import { MetadataError, setMediaTmdbId } from '../services/metadata.js';
import { profileId } from '../profiles.js';

const router = Router();

router.get('/media/:id', (req, res) => {
  const media = getMediaDetails(Number(req.params.id), profileId(req));
  if (!media) {
    res.status(404).json({ error: 'Media not found' });
    return;
  }
  // Details (or the player) are open - the user is likely to turn subtitles on soon.
  prefetchEmbeddedSubtitles(getDb(), media.id);
  // ...and to seek, which needs the preview thumbnails.
  requestStoryboard(getDb(), media.id);
  res.json(media);
});

/**
 * Fixes a wrong TMDB match: { "tmdbId": 603 }.
 * For a movie this is a TMDB movie id; for an episode it is the TV id of its series.
 */
router.put('/media/:id/tmdb', async (req, res) => {
  const tmdbId = Number(req.body && req.body.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    res.status(400).json({ error: 'Body must be { "tmdbId": <positive integer> }' });
    return;
  }
  try {
    await setMediaTmdbId(Number(req.params.id), tmdbId);
  } catch (err) {
    if (!(err instanceof MetadataError)) throw err;
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.json(getMediaDetails(Number(req.params.id), profileId(req)));
});

export default router;
