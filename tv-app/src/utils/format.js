import { t } from '../i18n/bg.js';

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 2052.4 -> "34:12", 4000 -> "1:06:40" */
export function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** A time of day, 24-hour: "23:47", "00:18" */
export function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Runtime in minutes (metadata) or duration in seconds (ffprobe) -> "2 ч 15 мин" */
export function formatRuntime(runtimeMinutes, durationSeconds) {
  const minutes = runtimeMinutes || (durationSeconds ? Math.round(durationSeconds / 60) : 0);
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return t.minutes(m);
  return m ? `${t.hours(h)} ${t.minutes(m)}` : t.hours(h);
}

export function formatRating(rating) {
  return rating ? `★ ${rating.toFixed(1)}` : '';
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i >= 3 ? 2 : 0)} ${units[i]}`;
}

/** Joins the non-empty parts with " · " */
export function joinMeta(parts) {
  return parts.filter(Boolean).join(' · ');
}

/** Turns compatibility warnings from the server into one readable line, or '' if there are none. */
export function formatWarnings(compatibility) {
  if (!compatibility || !compatibility.warnings.length) return '';
  const parts = compatibility.warnings.map((w) => {
    if (w.code === 'container') return t.warnContainer(w.value);
    if (w.code === 'video') return t.warnVideo(w.value);
    return t.warnAudio(w.value);
  });
  return `${t.mayNotPlay} ${parts.join(', ')}`;
}

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
