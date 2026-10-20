// API for the desktop app (desktop/) only - mounted at /api/admin.
import path from 'node:path';
import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  ImportError,
  cancelImport,
  getImportStatus,
  importRoots,
  planImport,
  resolveItem,
  startImport,
} from '../services/importer.js';
import { getScanStatus } from '../services/libraryScan.js';
import { getLibraryReport } from '../services/libraryReport.js';
import { MetadataError, searchTmdb } from '../services/metadata.js';
import { isFfprobeAvailable } from '../services/probe.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Only the desktop app on this PC gets in: never another device on the LAN (the TV),
 * and never a web page open on this PC - browsers always send an Origin header with
 * such requests, the desktop app's main process doesn't.
 */
export function desktopOnly(req, res, next) {
  if (!LOOPBACK.has(req.socket.remoteAddress) || req.headers.origin !== undefined) {
    res.status(403).json({ error: 'Only the Stefflix desktop app can use this' });
    return;
  }
  next();
}

const router = Router();
router.use(desktopOnly);

router.get('/library', async (req, res) => {
  res.json({
    ...getLibraryReport(getDb()),
    scan: getScanStatus(),
    ffprobe: await isFfprobeAvailable(),
  });
});

// ?kind=movie|series&query=<title, TMDB id or link>&year=
router.get('/tmdb/search', async (req, res) => {
  const kind = req.query.kind === 'series' ? 'series' : 'movie';
  const year = Number(req.query.year) || null;
  try {
    res.json(await searchTmdb(kind, req.query.query, year));
  } catch (err) {
    if (!(err instanceof MetadataError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

// --- import ("Добави" tab) ---------------------------------------------------------

function sendImportError(res, err) {
  if (!(err instanceof ImportError)) throw err;
  res.status(err.status).json({ error: err.message });
}

// { paths: [file or folder, ...] } -> { items, ignored, roots }
router.post('/import/plan', async (req, res) => {
  const paths = req.body && req.body.paths;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) {
    res.status(400).json({ error: 'Body must be { "paths": [<absolute path>, ...] }' });
    return;
  }
  res.json({ ...(await planImport(paths)), roots: importRoots() });
});

// { items } -> { items, roots } with target paths worked out again after the user edited them
router.post('/import/resolve', (req, res) => {
  const items = req.body && req.body.items;
  if (!Array.isArray(items)) {
    res.status(400).json({ error: 'Body must be { "items": [...] }' });
    return;
  }
  res.json({ items: items.map(resolveItem), roots: importRoots() });
});

// { items, mode: "copy" | "move" } -> 202 and the job status (GET /import/status to follow it)
router.post('/import/start', (req, res) => {
  const { items, mode } = req.body || {};
  try {
    res.status(202).json(startImport(Array.isArray(items) ? items : [], mode));
  } catch (err) {
    sendImportError(res, err);
  }
});

router.get('/import/status', (req, res) => {
  res.json(getImportStatus());
});

router.post('/import/cancel', (req, res) => {
  cancelImport();
  res.json(getImportStatus());
});

export default router;
