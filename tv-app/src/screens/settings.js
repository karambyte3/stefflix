// Settings / first-run screen: server address, connection test, library scan and cleanup.
// (Subtitle style settings and the TMDB notice arrive in later phases.)
import * as api from '../api.js';
import * as focus from '../focus.js';
import * as router from '../router.js';
import { confirm } from '../components/dialog.js';
import { getServerUrl, normalizeServerAddress, setServerUrl, suggestedServerAddress } from '../config.js';
import { t } from '../i18n/bg.js';
import { escapeHtml } from '../utils/format.js';
import { bindSubtitlePanel, subtitlePanelHtml } from './subtitleSettingsPanel.js';

const SCAN_POLL_MS = 1000;

function addressForInput(serverUrl) {
  return serverUrl ? serverUrl.replace(/^http:\/\//, '') : '';
}

export function settingsScreen(params) {
  let alive = true;
  let root;
  let input;
  let status;
  let scanStatus;
  let tmdbStatus;
  let pollTimer = null;
  let unavailable = 0; // missing files the scans marked unavailable

  function setStatus(el, text, kind) {
    el.textContent = text || '';
    el.classList.remove('status-ok', 'status-error');
    if (kind) el.classList.add('status-' + kind);
  }

  function check() {
    const url = normalizeServerAddress(input.value);
    if (!url) {
      setStatus(status, t.invalidAddress, 'error');
      return Promise.resolve(null);
    }
    setStatus(status, t.testing);
    return api.testConnection(url).then(
      () => {
        if (alive) setStatus(status, t.connectionOk, 'ok');
        return url;
      },
      () => {
        if (alive) setStatus(status, t.connectionFailed, 'error');
        return null;
      }
    );
  }

  function save() {
    check().then((url) => {
      if (!url || !alive) return;
      input.value = addressForInput(url);
      setServerUrl(url);
      // First run: settings is the only screen in the stack, so swap it for home.
      if (params.firstRun || !router.back()) router.replace('home');
    });
  }

  function showMetadataStatus(metadata) {
    if (!metadata.configured) setStatus(tmdbStatus, t.tmdbNotConfigured);
    else if (metadata.error) setStatus(tmdbStatus, t.tmdbKeyRejected, 'error');
    else if (metadata.running) setStatus(tmdbStatus, t.tmdbRunning(metadata.done, metadata.total));
    else setStatus(tmdbStatus, t.tmdbReady, 'ok');
  }

  /** The cleanup button shows how many missing files it would remove. */
  function showUnavailable(count) {
    unavailable = count || 0;
    const button = root.querySelector('[data-focus-id="cleanup"]');
    if (button) button.textContent = t.cleanUpLibrary(unavailable);
  }

  function showScanStatus(state) {
    showUnavailable(state.unavailable);
    if (state.scanning) {
      setStatus(scanStatus, t.scanRunning);
    } else if (state.lastScan && state.lastScan.error) {
      setStatus(scanStatus, t.scanFailed, 'error');
    } else if (state.lastScan) {
      setStatus(scanStatus, t.scanResult(state.lastScan), 'ok');
    }
    showMetadataStatus(state.metadata);
    // TMDB matching runs right after the scan; keep polling until both are done.
    if (state.scanning || state.metadata.running) pollTimer = setTimeout(pollScan, SCAN_POLL_MS);
  }

  function pollScan() {
    api.getLibraryStatus().then(
      (state) => alive && showScanStatus(state),
      () => alive && setStatus(scanStatus, t.serverUnreachable, 'error')
    );
  }

  function scan() {
    if (!getServerUrl()) {
      setStatus(scanStatus, t.connectionFailed, 'error');
      return;
    }
    clearTimeout(pollTimer);
    setStatus(scanStatus, t.scanRunning);
    api.startLibraryScan().then(
      (state) => alive && showScanStatus(state),
      () => alive && setStatus(scanStatus, t.serverUnreachable, 'error')
    );
  }

  function cleanUp() {
    if (!unavailable) {
      setStatus(scanStatus, t.cleanUpNothing, 'ok');
      return;
    }
    confirm(t.cleanUpConfirm(unavailable)).then((yes) => {
      if (!yes || !alive) return;
      clearTimeout(pollTimer);
      setStatus(scanStatus, t.cleanUpRunning);
      api.cleanUpLibrary().then(
        (state) => {
          if (!alive) return;
          showScanStatus(state);
          setStatus(scanStatus, t.cleanUpResult(state.removed), 'ok');
        },
        () => alive && setStatus(scanStatus, t.cleanUpFailed, 'error')
      );
    });
  }

  return {
    mount(el) {
      root = el;
      const initial = addressForInput(getServerUrl()) || suggestedServerAddress();

      root.innerHTML = `
        <div class="settings">
          <h1 class="page-title">${t.settingsTitle}</h1>
          <div class="settings-columns">
          <div class="settings-column">
          <section class="panel">
            <h2 class="panel-title">${t.serverSection}</h2>
            <label class="field-label" for="server-address">${t.serverAddressLabel}</label>
            <input id="server-address" class="text-input" type="text" autocomplete="off" spellcheck="false"
              data-focusable data-focus-id="address" data-autofocus
              placeholder="${t.serverAddressPlaceholder}" value="${escapeHtml(initial)}">
            <p class="hint">${t.serverAddressHint}</p>
            <div class="button-row">
              <button class="btn" data-focusable data-focus-id="test">${t.testConnection}</button>
              <button class="btn btn-primary" data-focusable data-focus-id="save">${t.save}</button>
            </div>
            <p class="status server-status"></p>
          </section>
          ${
            params.firstRun
              ? ''
              : `
          <section class="panel">
            <h2 class="panel-title">${t.librarySection}</h2>
            <div class="button-row">
              <button class="btn" data-focusable data-focus-id="scan">${t.scanLibrary}</button>
            </div>
            <div class="button-row library-cleanup">
              <button class="btn btn-small" data-focusable data-focus-id="cleanup">${t.cleanUpLibrary(0)}</button>
            </div>
            <p class="status scan-status"></p>
            <p class="status tmdb-status"></p>
            <p class="attribution">${t.tmdbAttribution}</p>
          </section>`
          }
          </div>
          ${params.firstRun ? '' : `<div class="settings-column">${subtitlePanelHtml()}</div>`}
          </div>
        </div>`;

      input = root.querySelector('#server-address');
      status = root.querySelector('.server-status');
      scanStatus = root.querySelector('.scan-status');
      tmdbStatus = root.querySelector('.tmdb-status');
      root.querySelector('[data-focus-id="test"]').addEventListener('click', check);
      root.querySelector('[data-focus-id="save"]').addEventListener('click', save);
      if (scanStatus) {
        root.querySelector('[data-focus-id="scan"]').addEventListener('click', scan);
        root.querySelector('[data-focus-id="cleanup"]').addEventListener('click', cleanUp);
        pollScan(); // show the result of the last scan (or one that is running)
        bindSubtitlePanel(root, () => alive);
      }

      // Enter on the TV keyboard / desktop: finish editing and jump to "Save".
      input.addEventListener('keydown', (event) => {
        if (event.keyCode === 13) {
          event.preventDefault();
          event.stopPropagation();
          input.blur();
          focus.focus(root.querySelector('[data-focus-id="save"]'));
        }
      });
    },

    unmount() {
      alive = false;
      clearTimeout(pollTimer);
    },
  };
}
