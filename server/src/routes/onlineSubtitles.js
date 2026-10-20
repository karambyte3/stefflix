import { Router } from 'express';
import { downloadOnline, OnlineSubtitlesError, searchOnline } from '../services/onlineSubtitles.js';

const router = Router();

function sendError(res, err) {
  if (!(err instanceof OnlineSubtitlesError)) throw err;
  res.status(err.status).json({ error: err.code, message: err.message, resetTime: err.resetTime || null });
}

// GET /api/media/12/subtitles/online?languages=bg,en -> [{ fileId, language, tags, release, downloads,
// hashMatch, machineTranslated, downloaded }], best first. Searching doesn't use the download quota.
router.get('/media/:id/subtitles/online', async (req, res) => {
  const languages = String(req.query.languages || 'bg,en').split(',');
  try {
    res.json(await searchOnline(Number(req.params.id), languages));
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/media/12/subtitles/online { fileId, language, tags } -> { subtitle, remaining, resetTime }
// Saves the file next to the video; `subtitle` can be loaded with GET /api/subtitles/:id at once.
router.post('/media/:id/subtitles/online', async (req, res) => {
  try {
    res.json(await downloadOnline(Number(req.params.id), req.body || {}));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
