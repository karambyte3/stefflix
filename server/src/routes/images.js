import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ensureImage, placeholderSvg } from '../services/images.js';

const router = Router();

// Generated poster for items without artwork: /images/placeholder/movie/12.svg
router.get('/images/placeholder/:kind/:file', (req, res) => {
  const table = { movie: 'media', series: 'series', video: 'media' }[req.params.kind];
  const id = Number(String(req.params.file).replace(/\.svg$/, ''));
  const row = table && getDb().prepare(`SELECT title, year FROM ${table} WHERE id = ?`).get(id);
  if (!row) {
    res.status(404).end();
    return;
  }
  // The URL carries a version derived from the title, so it can be cached.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('image/svg+xml').send(placeholderSvg(row.title, row.year));
});

// TMDB artwork, downloaded on first use and then served from server/cache/images.
router.get('/images/:size/:file', async (req, res) => {
  const file = await ensureImage(req.params.size, req.params.file);
  if (!file) {
    res.status(404).end();
    return;
  }
  // TMDB file names are unique per image, so they never change.
  res.sendFile(file, { maxAge: '365d', immutable: true });
});

export default router;
