// Custom subtitle renderer (no <track>): shows the cues active at video time + offset,
// styled from the subtitle settings. Also used for the preview in Settings.
import { t } from '../i18n/bg.js';

// On the 1920x1080 stage.
const FONT_SIZES = { S: 38, M: 48, L: 60, XL: 74 };

/** Applies size / colour / background / position from the server settings to a .subtitles element. */
export function applySubtitleStyle(el, settings) {
  el.style.bottom = settings.position + '%';
  el.style.fontSize = (FONT_SIZES[settings.size] || FONT_SIZES.M) + 'px';
  el.style.color = settings.color;
  el.setAttribute('data-background', settings.background);
}

/** Cue text from the server is HTML with only <i>/<b>; lines are separated by "\n". */
export function cueHtml(text) {
  return `<div class="subtitle-line"><span class="subtitle-text">${text.replace(/\n/g, '<br>')}</span></div>`;
}

/** "Български", "Английски" */
export function languageName(subtitle) {
  return (subtitle.language && t.languages[subtitle.language]) || subtitle.language || t.unknownLanguage;
}

/** "Български", "Английски (принудителни, вградени)", "Неизвестен език" */
export function subtitleLabel(subtitle) {
  const tags = (subtitle.tags || []).map((tag) => t.subtitleTags[tag]).filter(Boolean);
  if (subtitle.embedded) tags.push(t.subtitleEmbedded);
  return tags.length ? `${languageName(subtitle)} (${tags.join(', ')})` : languageName(subtitle);
}

/** "+0.75 s", "-0.25 s", "0.00 s" */
export function formatOffset(seconds) {
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
  return `${sign}${Math.abs(seconds).toFixed(2)} s`;
}

export function createSubtitleRenderer(el) {
  let cues = [];
  let offset = 0;
  let shown = ''; // indexes of the cues on screen, to touch the DOM only on change

  /** Indexes of the cues active at `time` (overlapping cues are shown together). */
  function activeAt(time) {
    // Binary search for the last cue that starts at or before `time`.
    let lo = 0;
    let hi = cues.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= time) {
        last = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const active = [];
    // A few earlier cues may still be running (long cue + short overlapping one).
    for (let i = last; i >= 0 && i > last - 8; i--) {
      if (cues[i].end > time) active.unshift(i);
    }
    return active;
  }

  function render(indexes) {
    const key = indexes.join(',');
    if (key === shown) return;
    shown = key;
    el.innerHTML = indexes.map((i) => cueHtml(cues[i].text)).join('');
  }

  return {
    setCues(list) {
      cues = list || [];
      shown = null;
      render([]);
    },
    setOffset(seconds) {
      offset = seconds;
    },
    getOffset() {
      return offset;
    },
    /** Call with video.currentTime: on every animation frame while playing, and after seeks. */
    update(currentTime) {
      render(cues.length ? activeAt(currentTime + offset) : []);
    },
  };
}
