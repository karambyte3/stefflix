// Poster (2:3) and landscape (16:9) cards used in rows and grids.
// Without an image a coloured placeholder with the title is shown.
import { imageUrl } from '../api.js';
import { t } from '../i18n/bg.js';
import { escapeHtml, formatTime } from '../utils/format.js';

/** A stable, muted colour per title, so placeholders are easy to tell apart. */
function placeholderHue(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/** `overlayHtml` is drawn on top of the image (progress bar, watched tick). */
export function artHtml(imagePath, placeholderText, extraClass, overlayHtml) {
  const hue = placeholderHue(placeholderText || '');
  const src = imageUrl(imagePath);
  return `
    <div class="art ${extraClass || ''}" style="background: linear-gradient(160deg, hsl(${hue}, 35%, 28%), hsl(${hue}, 40%, 12%))">
      <span class="art-placeholder">${escapeHtml(placeholderText)}</span>
      ${src ? `<img class="art-img" data-src="${escapeHtml(src)}" alt="">` : ''}
      ${overlayHtml || ''}
    </div>`;
}

/** Text shown on and under a card. */
function cardText(item) {
  if (item.type === 'episode') {
    const code = t.episodeCode(item.seasonNumber, item.episodeNumber);
    return {
      placeholder: item.seriesTitle,
      line1: item.seriesTitle,
      line2: item.title ? `${code} · ${item.title}` : code,
    };
  }
  if (item.type === 'video') {
    // The length is on the thumbnail (duration badge).
    return { placeholder: item.title, line1: item.title, line2: item.category || '' };
  }
  return { placeholder: item.title, line1: item.title, line2: item.year ? String(item.year) : '' };
}

export function isLandscape(item) {
  return item.type === 'episode' || item.type === 'video';
}

/**
 * YouTube-style overlay: a red bar along the bottom edge up to where playback will resume
 * (a full one once watched), the length in the corner ("43:17") and a tick when watched.
 */
export function progressHtml(item) {
  let html = '';
  const ratio = item.progress || (item.watched ? 1 : 0);
  if (ratio) {
    html += `<div class="progress-bar"><div class="progress-bar-fill" style="transform: scaleX(${ratio})"></div></div>`;
  }
  if (item.duration) html += `<span class="duration-badge">${formatTime(item.duration)}</span>`;
  if (item.watched) html += '<span class="watched-badge"></span>';
  return html;
}

/**
 * @param item      list item from the API (movie / series / episode / video)
 * @param focusId   unique within the screen
 * @param attrs     extra attributes, e.g. 'data-index="3"'
 * @param options   { landscape: true } to show a movie with its backdrop (Continue watching)
 */
export function cardHtml(item, focusId, attrs, options) {
  const landscape = isLandscape(item) || !!(options && options.landscape);
  const text = cardText(item);
  const image = landscape ? item.still || item.backdrop : item.poster;
  return `
    <div class="card ${landscape ? 'card-landscape' : 'card-poster'}" data-focusable
      data-focus-id="${escapeHtml(focusId)}" ${attrs || ''}>
      ${artHtml(image, text.placeholder, landscape ? 'art-landscape' : 'art-poster', progressHtml(item))}
      <div class="card-caption">
        <div class="card-line1">${escapeHtml(text.line1)}</div>
        ${text.line2 ? `<div class="card-line2">${escapeHtml(text.line2)}</div>` : ''}
      </div>
    </div>`;
}
