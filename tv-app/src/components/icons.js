// Inline SVG icons (Material Icons paths), so they don't depend on the TV's fonts.
// They take the text colour (currentColor), so focus styles recolour them.

function icon(path) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
}

export const ICON_PLAY = icon('M8 5v14l11-7z');
export const ICON_PAUSE = icon('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
export const ICON_NEXT = icon('M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z');
export const ICON_SUBTITLES = icon(
  'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7' +
    'c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4' +
    'c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z'
);
