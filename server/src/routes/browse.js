import { Router } from 'express';
import {
  getHome,
  getSeriesDetails,
  listGenres,
  listMovies,
  listSeries,
  listVideoCategories,
  listVideos,
} from '../services/library.js';
import { MetadataError, setSeriesTmdbId } from '../services/metadata.js';
import { profileId } from '../profiles.js';

const router = Router();

function listQuery(req) {
  return {
    profileId: profileId(req),
    genre: typeof req.query.genre === 'string' && req.query.genre ? req.query.genre : undefined,
    sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
  };
}

router.get('/home', (req, res) => {
  res.json(getHome(profileId(req)));
});

router.get('/movies', (req, res) => {
  res.json(listMovies(listQuery(req)));
});

router.get('/series', (req, res) => {
  res.json(listSeries(listQuery(req)));
});

router.get('/series/:id', (req, res) => {
  const series = getSeriesDetails(Number(req.params.id), profileId(req));
  if (!series) {
    res.status(404).json({ error: 'Series not found' });
    return;
  }
  res.json(series);
});

// Fixes a wrong TMDB match: { "tmdbId": 1396 } (a TMDB TV id).
router.put('/series/:id/tmdb', async (req, res) => {
  const tmdbId = Number(req.body && req.body.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    res.status(400).json({ error: 'Body must be { "tmdbId": <positive integer> }' });
    return;
  }
  try {
    await setSeriesTmdbId(Number(req.params.id), tmdbId);
  } catch (err) {
    if (!(err instanceof MetadataError)) throw err;
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.json(getSeriesDetails(Number(req.params.id), profileId(req)));
});

// ?category=Travel, or ?category= (empty) for videos directly in the root folder.
router.get('/videos', (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  res.json(listVideos({ category, sort: listQuery(req).sort, profileId: profileId(req) }));
});

router.get('/videos/categories', (req, res) => {
  res.json(listVideoCategories());
});

// ?type=movie|series
router.get('/genres', (req, res) => {
  res.json(listGenres(req.query.type === 'series' ? 'series' : 'movie'));
});

export default router;
