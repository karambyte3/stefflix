// A virtualised card grid: only the rows around the visible area exist in the DOM,
// so large libraries stay fast on the TV. The focused row is scrolled to the top.
//
// Spatial navigation still works through the focus manager: there is always one
// rendered row above and below the visible ones, and scrolling to a newly focused
// row renders the next one before the user can move again.
import { setScroll } from '../focus.js';
import { observeImages } from '../utils/images.js';

const BUFFER_ROWS = 1;
// Room above the first row, so a scaled-up focused card isn't clipped.
const TOP_PADDING = 24;

/**
 * @param viewport      element with a fixed height and overflow: hidden
 * @param options.items
 * @param options.columns
 * @param options.rowHeight     px, including the gap between rows
 * @param options.renderCard    (item, index) -> HTML string; the card must have data-index="index"
 * @param options.onSelect      (item) -> void
 * @param options.focusIdOf     (item) -> focus id, used to scroll to a remembered card
 */
export function createVirtualGrid(viewport, options) {
  const { items, columns, rowHeight, renderCard, onSelect, focusIdOf } = options;
  const rowCount = Math.ceil(items.length / columns);
  const viewportHeight = viewport.clientHeight;
  const contentHeight = TOP_PADDING + rowCount * rowHeight;
  const rows = {}; // row index -> element

  const content = document.createElement('div');
  content.className = 'grid-content';
  content.style.height = contentHeight + 'px';
  viewport.appendChild(content);

  let scrollY = 0;

  function renderRow(r) {
    const el = document.createElement('div');
    el.className = 'grid-row';
    el.style.top = TOP_PADDING + r * rowHeight + 'px';
    let html = '';
    for (let i = r * columns; i < Math.min(items.length, (r + 1) * columns); i++) {
      html += renderCard(items[i], i);
    }
    el.innerHTML = html;
    return el;
  }

  function renderWindow() {
    const first = Math.max(0, Math.floor(scrollY / rowHeight) - BUFFER_ROWS);
    const last = Math.min(rowCount - 1, Math.ceil((scrollY + viewportHeight) / rowHeight) + BUFFER_ROWS);

    for (const key in rows) {
      const r = Number(key);
      if (r < first || r > last) {
        content.removeChild(rows[key]);
        delete rows[key];
      }
    }
    for (let r = first; r <= last; r++) {
      if (!rows[r]) {
        rows[r] = renderRow(r);
        content.appendChild(rows[r]);
        observeImages(rows[r]);
      }
    }
  }

  function scrollToRow(r, instant) {
    const maxScroll = Math.max(0, contentHeight - viewportHeight);
    scrollY = Math.max(0, Math.min(maxScroll, r * rowHeight));
    setScroll(content, 0, scrollY, instant);
    renderWindow();
  }

  viewport.addEventListener('tvfocus', (event) => {
    const card = event.target.closest('[data-index]');
    if (card) scrollToRow(Math.floor(Number(card.getAttribute('data-index')) / columns), event.detail.instant);
  });

  content.addEventListener('click', (event) => {
    const card = event.target.closest('[data-index]');
    if (card) onSelect(items[Number(card.getAttribute('data-index'))]);
  });

  return {
    /** Renders the area around the card with this focus id (or the top), before focus is restored. */
    revealFocusId(focusId) {
      let index = -1;
      if (focusId) {
        for (let i = 0; i < items.length; i++) {
          if (focusIdOf(items[i]) === focusId) {
            index = i;
            break;
          }
        }
      }
      scrollToRow(index === -1 ? 0 : Math.floor(index / columns), true);
    },
  };
}
