// The bubble above the progress bar while seeking: a thumbnail of the target scene, its time
// and how far the jump is ("+1:30").
//
// Thumbnails come from the server's storyboard: JPEG sheets of 5x5 frames, one frame every
// ~10 s. A sheet is loaded once and the bubble shows the right frame with background-position,
// so moving the target is instant. Until the storyboard is generated (on the first watch of a
// file), single frames are requested instead, once the target stops moving.
import * as api from '../../api.js';
import { formatTime } from '../../utils/format.js';

// Thumbnails are 320x180 on the server, shown a bit larger.
const THUMB_WIDTH = 400;
const THUMB_HEIGHT = 225;
const STORYBOARD_RETRY_MS = 10000;
const FRAME_DELAY_MS = 300;
// Sheets kept loaded around the current one (each is ~1600x900 px once decoded).
const SHEETS_AROUND = 1;

/** "+1:30", "−0:40" */
function formatDelta(seconds) {
  const sign = seconds < 0 ? '−' : '+';
  return sign + formatTime(Math.abs(Math.round(seconds)));
}

/**
 * @param el       the .seek-preview element
 * @param mediaId
 */
export function createSeekPreview(el, mediaId) {
  const thumb = el.querySelector('.seek-thumb');
  const sheetEl = el.querySelector('.seek-sheet');
  const frameEl = el.querySelector('.seek-frame');
  const timeEl = el.querySelector('.seek-time');
  const deltaEl = el.querySelector('.seek-delta');

  let destroyed = false;
  let storyboard = null;
  let retryTimer = null;
  let frameTimer = null;
  let frameFailures = 0;
  let shownSheet = -1;
  const loaded = {}; // sheet index -> Image, so the browser keeps the sheets near the target

  function loadStoryboard() {
    retryTimer = null;
    api.getStoryboard(mediaId).then(
      (result) => {
        if (destroyed) return;
        if (result.status === 'ready' && result.sheets.length) {
          storyboard = result;
          preloadAround(0);
        } else if (result.status === 'pending') {
          retryTimer = setTimeout(loadStoryboard, STORYBOARD_RETRY_MS);
        }
      },
      () => {}
    );
  }

  function preloadAround(sheet) {
    for (let i = sheet - SHEETS_AROUND; i <= sheet + SHEETS_AROUND; i++) {
      if (i >= 0 && i < storyboard.sheets.length && !loaded[i]) {
        const img = new Image();
        img.src = api.imageUrl(storyboard.sheets[i]);
        loaded[i] = img;
      }
    }
    for (const key in loaded) {
      if (Math.abs(Number(key) - sheet) > SHEETS_AROUND) delete loaded[key];
    }
  }

  function showStoryboardFrame(time) {
    const sb = storyboard;
    const index = Math.max(0, Math.min(sb.count - 1, Math.floor(time / sb.interval)));
    const perSheet = sb.columns * sb.rows;
    const sheet = Math.min(sb.sheets.length - 1, Math.floor(index / perSheet));
    const cell = index - sheet * perSheet;
    const scaleX = THUMB_WIDTH / sb.width;
    const scaleY = THUMB_HEIGHT / sb.height;

    if (sheet !== shownSheet) {
      shownSheet = sheet;
      sheetEl.style.backgroundImage = `url("${api.imageUrl(sb.sheets[sheet])}")`;
      sheetEl.style.backgroundSize = `${sb.columns * THUMB_WIDTH}px ${sb.rows * THUMB_HEIGHT}px`;
      preloadAround(sheet);
    }
    const x = (cell % sb.columns) * sb.width * scaleX;
    const y = Math.floor(cell / sb.columns) * sb.height * scaleY;
    sheetEl.style.backgroundPosition = `${-x}px ${-y}px`;
  }

  function requestFrame(time) {
    clearTimeout(frameTimer);
    frameEl.classList.add('is-stale');
    frameTimer = setTimeout(() => {
      frameTimer = null;
      frameEl.src = api.frameUrl(mediaId, time);
    }, FRAME_DELAY_MS);
  }

  frameEl.addEventListener('load', () => {
    frameFailures = 0;
    frameEl.classList.remove('is-stale');
    frameEl.classList.add('is-loaded');
  });
  frameEl.addEventListener('error', () => {
    // No ffmpeg on the server (or the file can't be decoded): show just the time.
    if (++frameFailures >= 2) el.classList.add('no-thumb');
  });

  loadStoryboard();

  return {
    /**
     * @param time      target position (seconds)
     * @param delta     target minus the position seeking started from
     * @param fraction  time / duration, places the bubble along the bar
     */
    show(time, delta, fraction) {
      if (storyboard) {
        el.classList.add('has-storyboard');
        showStoryboardFrame(time);
      } else if (frameFailures < 2) {
        requestFrame(time);
      }
      timeEl.textContent = formatTime(time);
      deltaEl.textContent = formatDelta(delta);

      // Centred over the target, but never past the ends of the bar.
      const barWidth = el.parentNode.offsetWidth;
      const width = thumb.offsetWidth || THUMB_WIDTH;
      const x = Math.max(0, Math.min(barWidth - width, fraction * barWidth - width / 2));
      el.style.transform = `translate3d(${x}px, 0, 0)`;
      el.classList.add('is-visible');
    },

    hide() {
      clearTimeout(frameTimer);
      frameTimer = null;
      el.classList.remove('is-visible');
    },

    destroy() {
      destroyed = true;
      clearTimeout(retryTimer);
      clearTimeout(frameTimer);
      frameEl.removeAttribute('src');
      for (const key in loaded) delete loaded[key];
    },
  };
}
