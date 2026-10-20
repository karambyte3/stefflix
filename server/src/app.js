import express from 'express';
import cors from 'cors';
import adminRoutes from './routes/admin.js';
import healthRoutes from './routes/health.js';
import imageRoutes from './routes/images.js';
import browseRoutes from './routes/browse.js';
import libraryRoutes from './routes/library.js';
import mediaRoutes from './routes/media.js';
import onlineSubtitleRoutes from './routes/onlineSubtitles.js';
import progressRoutes from './routes/progress.js';
import storyboardRoutes from './routes/storyboards.js';
import streamRoutes from './routes/stream.js';
import subtitleRoutes from './routes/subtitles.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // LAN-only app: allow every origin. The packaged TV app runs from file://,
  // which sends "Origin: null", so a whitelist wouldn't work anyway.
  app.use(
    cors({
      exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'X-Subtitle-Encoding'],
    })
  );
  app.use(express.json());

  app.use(imageRoutes);
  app.use(storyboardRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api', healthRoutes);
  app.use('/api', browseRoutes);
  app.use('/api', libraryRoutes);
  app.use('/api', mediaRoutes);
  app.use('/api', onlineSubtitleRoutes);
  app.use('/api', progressRoutes);
  app.use('/api', streamRoutes);
  app.use('/api', subtitleRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
