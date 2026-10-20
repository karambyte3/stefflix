import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { getPlayableFile } from '../services/library.js';
import { videoMimeType } from '../utils/mime.js';
import { parseRange } from '../utils/range.js';

const router = Router();

// GET (and HEAD, which Express routes to the same handler) /api/stream/:mediaId
router.get('/stream/:mediaId', async (req, res) => {
  const media = getPlayableFile(Number(req.params.mediaId));
  if (!media) {
    res.status(404).json({ error: 'Media not found or file not available' });
    return;
  }

  let stat;
  try {
    stat = await fs.promises.stat(media.path);
  } catch {
    res.status(404).json({ error: 'File is not available' });
    return;
  }

  const size = stat.size;
  const range = parseRange(req.headers.range, size);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', videoMimeType(media.path));
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  // Never cache video in the browser: it's huge, and a replaced file keeps the same URL.
  res.setHeader('Cache-Control', 'no-store');

  if (range.type === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }

  let start = 0;
  let end = size - 1;

  if (range.type === 'range') {
    start = range.start;
    end = range.end;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }

  res.setHeader('Content-Length', size === 0 ? 0 : end - start + 1);

  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }

  const fileStream = fs.createReadStream(media.path, {
    start,
    end,
    highWaterMark: 256 * 1024,
  });

  try {
    await pipeline(fileStream, res);
  } catch (err) {
    // The player aborts the current request on every seek - that's normal, not an error.
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error(`Stream error for media ${media.id}:`, err.message);
    }
  }
});

export default router;
