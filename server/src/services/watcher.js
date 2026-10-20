// Watches the media folders and rescans the library when videos, subtitles or folders
// are added, renamed or removed, so new files show up without a manual scan.
//
// A scan is cheap (it only stats files), so the watcher doesn't track individual files:
// it waits until the events stop for a moment and then runs a normal incremental scan.
// Files that are still being copied are skipped by the scanner; the event Windows fires
// when the copy finishes triggers the scan that adds them.
import fs from 'node:fs';
import path from 'node:path';
import { isVideoFile } from '../utils/mime.js';
import { isSubtitleFile } from './subtitles.js';

// Copying a whole season fires a burst of events - one scan after the burst is enough.
const QUIET_MS = 3000;
// A watched folder that is missing or broke (e.g. an unplugged USB drive) is retried this often.
const RETRY_MS = 60 * 1000;

// Downloads in progress use these names and get renamed to the real one when complete.
const TEMP_FILE = /\.(part|partial|crdownload|download|tmp|!qb|!ut|bc!)$/i;

/** Whether a change to `filename` (relative to the watched root) can affect the library. */
function isRelevant(root, eventType, filename) {
  if (!filename) return true; // Windows drops the names when its event buffer overflows
  const name = path.basename(filename);
  if (name.startsWith('.') || name.startsWith('$') || TEMP_FILE.test(name)) return false;

  // "change" on a video is how a finished copy announces itself.
  if (isVideoFile(name) || isSubtitleFile(name)) return true;

  // Added, renamed or removed folders carry their whole contents with them. Folders also get
  // "change" events whenever something inside them is written - those are covered above.
  if (eventType !== 'rename') return false;
  try {
    return fs.statSync(path.join(root, filename)).isDirectory();
  } catch {
    return true; // gone - it may have been a folder full of videos
  }
}

/**
 * Starts watching `roots` and calls `rescan()` after relevant changes.
 * `rescan` must return a promise that resolves when the scan has finished.
 * Returns a function that stops all watchers.
 */
export function watchMediaFolders(roots, rescan, { quietMs = QUIET_MS } = {}) {
  const watchers = new Map(); // root -> fs.FSWatcher
  const retryTimers = new Set();
  let quietTimer = null;
  let scanning = false;
  let changedDuringScan = false;
  let stopped = false;

  function scheduleScan() {
    if (stopped) return;
    if (scanning) {
      changedDuringScan = true; // the running scan may have read the folder before this change
      return;
    }
    clearTimeout(quietTimer);
    quietTimer = setTimeout(runScan, quietMs);
  }

  async function runScan() {
    quietTimer = null;
    scanning = true;
    changedDuringScan = false;
    try {
      await rescan();
    } catch (err) {
      console.error('Rescan after folder change failed:', err);
    } finally {
      scanning = false;
      if (changedDuringScan) scheduleScan();
    }
  }

  function retryLater(root) {
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      // Whatever happened while the folder was unavailable is picked up by a scan.
      if (watch(root)) scheduleScan();
    }, RETRY_MS);
    retryTimers.add(timer);
  }

  function watch(root) {
    if (stopped) return false;
    let watcher;
    try {
      watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (isRelevant(root, eventType, filename)) scheduleScan();
      });
    } catch (err) {
      console.warn(`! Cannot watch ${root} (${err.code || err.message}), retrying every ${RETRY_MS / 1000}s`);
      retryLater(root);
      return false;
    }
    watcher.on('error', (err) => {
      console.warn(`! Stopped watching ${root} (${err.code || err.message}), retrying every ${RETRY_MS / 1000}s`);
      watcher.close();
      watchers.delete(root);
      scheduleScan(); // the folder itself may be gone - mark its files unavailable
      retryLater(root);
    });
    watchers.set(root, watcher);
    return true;
  }

  for (const root of new Set(roots)) watch(root);
  if (watchers.size) console.log(`Watching ${watchers.size} media folder(s) for new files`);

  return function stop() {
    stopped = true;
    clearTimeout(quietTimer);
    for (const timer of retryTimers) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
