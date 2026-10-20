// Runs library scans one at a time and keeps their status for the API.
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { countUnavailable, removeUnavailable } from './cleanup.js';
import { getMetadataStatus, refreshLibraryMetadata } from './metadata.js';
import { probePendingMedia } from './probe.js';
import { scanLibrary } from './scanner.js';
import { pruneStoryboards, queueAllStoryboards } from './storyboard.js';

const status = {
  scanning: false,
  startedAt: null,
  lastScan: null, // { startedAt, finishedAt, added, updated, moved, restored, removed, skipped, total } or { error }
};

let current = null;

export function getScanStatus() {
  return { ...status, metadata: getMetadataStatus(), unavailable: countUnavailable(getDb()) };
}

/** Starts a scan unless one is already running. Returns the scan's promise either way. */
export function startScan() {
  if (current) return current;

  const startedAt = Date.now();
  status.scanning = true;
  status.startedAt = startedAt;
  console.log('Library scan started...');

  current = scanLibrary(getDb(), {
    movie: config.mediaMovies,
    episode: config.mediaSeries,
    video: config.mediaVideos,
  })
    .then((result) => {
      status.lastScan = { startedAt, finishedAt: Date.now(), ...result };
      console.log(
        `Library scan finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ` +
          `${result.total} files, ${result.added} new, ${result.moved} moved, ` +
          `${result.restored} restored, ${result.removed} missing, ${result.skipped} skipped` +
          (result.inProgress ? `, ${result.inProgress} still copying` : '')
      );
      // Codec/duration info and TMDB metadata are filled in afterwards, in the background.
      // Storyboards come after probing, which gives them the duration.
      probePendingMedia(getDb())
        .then(() => config.storyboardsForAll && queueAllStoryboards(getDb()))
        .catch((err) => console.error('Probe queue failed:', err));
      refreshLibraryMetadata(getDb()).catch((err) => console.error('TMDB refresh failed:', err));
      return status.lastScan;
    })
    .catch((err) => {
      console.error('Library scan failed:', err);
      status.lastScan = { startedAt, finishedAt: Date.now(), error: err.message };
      return status.lastScan;
    })
    .finally(() => {
      status.scanning = false;
      current = null;
    });

  return current;
}

/**
 * Like startScan, but never reuses a scan that started before the call (it may have read the
 * folders before the change being reported): waits for that one, then starts a new one.
 */
export async function startFreshScan() {
  if (current) await current;
  return startScan();
}

/** Forgets missing files. Waits for a running scan, so it never races its reconcile step. */
export async function cleanUpLibrary() {
  if (current) await current;
  const removed = removeUnavailable(getDb());
  removed.storyboards = await pruneStoryboards(getDb());
  console.log(
    `Library cleanup: removed ${removed.media} missing files, ${removed.subtitles} subtitles, ${removed.series} series`
  );
  return removed;
}
