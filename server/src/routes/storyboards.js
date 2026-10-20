import { Router } from 'express';
import { getDb } from '../db/index.js';
import { isFfmpegAvailable } from '../services/embeddedSubtitles.js';
import { frameStream, getStoryboard, sheetPath } from '../services/storyboard.js';

const router = Router();

// The seek preview's thumbnail sheets, or { status: 'pending' | 'unavailable' }.
router.get('/api/media/:id/storyboard', async (req, res) => {
  const storyboard = await getStoryboard(getDb(), Number(req.params.id));
  if (!storyboard) {
    res.status(404).json({ error: 'Media not found' });
    return;
  }
  res.json(storyboard);
});

// A single thumbnail at ?t=<seconds>, while the storyboard isn't ready yet.
router.get('/api/media/:id/frame', async (req, res) => {
  const time = Number(req.query.t);
  const media = getDb().prepare('SELECT path FROM media WHERE id = ? AND available = 1').get(Number(req.params.id));
  if (!media || !isFinite(time) || !(await isFfmpegAvailable())) {
    res.status(404).end();
    return;
  }
  const child = await frameStream(media.path, time);
  if (!child) {
    res.status(503).end();
    return;
  }
  // The TV drops the request when the seek target moves on - stop ffmpeg too.
  res.on('close', () => child.kill());
  res.type('image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  child.stdout.pipe(res);
});

// The sheets' folder name contains the file's mtime, so a URL always means the same image.
router.get('/storyboards/:dir/:file', (req, res) => {
  const file = sheetPath(req.params.dir, req.params.file);
  if (!file) {
    res.status(404).end();
    return;
  }
  res.sendFile(file, { maxAge: '365d', immutable: true });
});

export default router;
