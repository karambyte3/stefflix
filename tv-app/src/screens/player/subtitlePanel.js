// The player's "Субтитри" panel: track selection, sync (offset) adjustment and the online
// search in one place. It sits on the right without dimming the video, so the effect of a
// change is visible while the video keeps playing.
import * as focus from '../../focus.js';
import * as modal from '../../components/modal.js';
import { formatOffset } from '../../components/subtitles.js';
import { t } from '../../i18n/bg.js';
import { escapeHtml } from '../../utils/format.js';

/**
 * @param options.tracks     [{ value, label }] - value null is "Off"
 * @param options.selected   value of the current track
 * @param options.offset     current offset in seconds
 * @param options.online     whether "Search online" is offered
 * @param options.onSelect(value)
 * @param options.onShift(delta) -> the new offset
 * @param options.onReset() -> the new offset
 * @param options.onSearchOnline()  called after the panel has closed
 * @param options.onKey(action)     color buttons etc.; return true if handled
 * @returns {{ setOffset(seconds), close() }}
 */
export function openSubtitlePanel(options) {
  const el = document.createElement('div');
  el.className = 'modal-backdrop modal-right subtitle-panel-backdrop';
  el.innerHTML = `
    <div class="menu subtitle-menu">
      <h2 class="menu-title">${t.subtitlesMenuTitle}</h2>
      <div class="menu-viewport">
        <div class="menu-list" data-scroll-page="visible" data-scroll-margin="24">
          <div data-focus-group="subtitle-tracks">
            ${options.tracks
              .map(
                (track, i) => `
              <button class="menu-option${track.value === options.selected ? ' is-selected' : ''}"
                data-focusable data-focus-id="track-${i}" data-track="${i}">${escapeHtml(track.label)}</button>`
              )
              .join('')}
          </div>
          <h3 class="subtitle-menu-heading">${t.subtitleSync}</h3>
          <div class="subtitle-sync" data-focus-group="subtitle-sync">
            <button class="subtitle-sync-btn" data-focusable data-focus-id="sync-minus" data-shift="-1">−0.25 s</button>
            <span class="subtitle-sync-value"></span>
            <button class="subtitle-sync-btn" data-focusable data-focus-id="sync-plus" data-shift="1">+0.25 s</button>
          </div>
          <button class="menu-option subtitle-sync-reset" data-focusable data-focus-id="sync-reset">${t.subtitleSyncReset}</button>
          ${
            options.online
              ? `<button class="menu-option subtitle-online" data-focusable data-focus-id="online">${t.onlineSearchOption}</button>`
              : ''
          }
          <p class="subtitle-menu-hint">${t.subtitlePanelHint}</p>
        </div>
      </div>
    </div>`;

  const valueEl = el.querySelector('.subtitle-sync-value');
  let searchAfterClose = false;

  function setOffset(seconds) {
    valueEl.textContent = formatOffset(seconds);
  }

  el.addEventListener('click', (event) => {
    const target = event.target.closest('[data-focusable]');
    if (!target) return;
    if (target.hasAttribute('data-track')) {
      const index = Number(target.getAttribute('data-track'));
      const current = el.querySelector('.menu-option.is-selected');
      if (current) current.classList.remove('is-selected');
      target.classList.add('is-selected');
      options.onSelect(options.tracks[index].value);
    } else if (target.hasAttribute('data-shift')) {
      setOffset(options.onShift(Number(target.getAttribute('data-shift'))));
    } else if (target.classList.contains('subtitle-sync-reset')) {
      setOffset(options.onReset());
    } else if (target.classList.contains('subtitle-online')) {
      searchAfterClose = true;
      modal.close();
    }
  });

  setOffset(options.offset);
  modal.open(
    el,
    () => {
      if (options.onClose) options.onClose();
      if (searchAfterClose) options.onSearchOnline();
    },
    options.onKey
  );
  focus.focus(el.querySelector('.menu-option.is-selected') || el.querySelector('[data-focusable]'), { instant: true });

  return {
    setOffset,
    close() {
      if (document.body.contains(el)) modal.close();
    },
  };
}
