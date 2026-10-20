// Selection menu (genre, sort, category): a panel with a vertical list of options.
import * as focus from '../focus.js';
import * as modal from './modal.js';
import { escapeHtml } from '../utils/format.js';

/**
 * @param {string} title
 * @param {Array<{ value: any, label: string, detail?: string }>} options  detail: a smaller second line
 * @param {any} selected  value of the currently selected option
 * @returns {Promise<{ value: any } | null>}  null when closed with Back
 */
export function select(title, options, selected) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal-backdrop modal-right';
    el.innerHTML = `
      <div class="menu">
        <h2 class="menu-title">${escapeHtml(title)}</h2>
        <div class="menu-viewport">
          <div class="menu-list" data-scroll-page="visible" data-scroll-margin="24">
            ${options
              .map(
                (option, i) => `
              <button class="menu-option${option.value === selected ? ' is-selected' : ''}"
                data-focusable data-focus-id="option-${i}" data-index="${i}">${escapeHtml(option.label)}${
                  option.detail ? `<span class="menu-option-detail">${escapeHtml(option.detail)}</span>` : ''
                }</button>`
              )
              .join('')}
          </div>
        </div>
      </div>`;

    el.querySelector('.menu-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-index]');
      if (button) modal.close({ value: options[Number(button.getAttribute('data-index'))].value });
    });

    modal.open(el, (result) => resolve(result || null));
    focus.focus(el.querySelector('.is-selected') || el.querySelector('.menu-option'), { instant: true });
  });
}
