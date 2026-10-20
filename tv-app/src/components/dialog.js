// Yes/no confirmation dialog.
import * as focus from '../focus.js';
import * as modal from './modal.js';
import { t } from '../i18n/bg.js';
import { escapeHtml } from '../utils/format.js';

/** Resolves to true for "yes". "No" is focused by default. */
export function confirm(title) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal-backdrop modal-center';
    el.innerHTML = `
      <div class="dialog">
        <h2 class="dialog-title">${escapeHtml(title)}</h2>
        <div class="button-row">
          <button class="btn" data-focusable data-focus-id="yes">${t.yes}</button>
          <button class="btn" data-focusable data-focus-id="no">${t.no}</button>
        </div>
      </div>`;
    el.querySelector('[data-focus-id="yes"]').addEventListener('click', () => modal.close(true));
    el.querySelector('[data-focus-id="no"]').addEventListener('click', () => modal.close(false));

    modal.open(el, (result) => resolve(result === true));
    focus.focus(el.querySelector('[data-focus-id="no"]'), { instant: true });
  });
}
