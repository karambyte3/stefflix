import { Router } from 'express';

const router = Router();

// Used by the TV app's "Test connection" button.
router.get('/health', (req, res) => {
  res.json({ ok: true, name: 'home-stream', version: '0.1.0' });
});

export default router;
