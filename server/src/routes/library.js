import { Router } from 'express';
import { cleanUpLibrary, getScanStatus, startScan } from '../services/libraryScan.js';

const router = Router();

// Starts a scan in the background and answers right away (202).
// The TV app polls GET /api/library/status to show the result.
router.post('/library/scan', (req, res) => {
  startScan();
  res.status(202).json(getScanStatus());
});

router.get('/library/status', (req, res) => {
  res.json(getScanStatus());
});

// Deletes everything that the scans marked unavailable (files that are gone).
router.post('/library/cleanup', async (req, res, next) => {
  try {
    const removed = await cleanUpLibrary();
    res.json({ removed, ...getScanStatus() });
  } catch (err) {
    next(err);
  }
});

export default router;
