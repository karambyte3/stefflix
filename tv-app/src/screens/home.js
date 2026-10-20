// Home: a hero banner with a featured title plus horizontal rows from /api/home.
import * as api from '../api.js';
import * as focus from '../focus.js';
import * as router from '../router.js';
import { artHtml, cardHtml } from '../components/card.js';
import * as modal from '../components/modal.js';
import { bindNavbar, navbarHtml } from '../components/navbar.js';
import { t } from '../i18n/bg.js';
import { loadCached, openItem } from '../navigation.js';
import { escapeHtml, formatRating, joinMeta } from '../utils/format.js';
import { observeImages } from '../utils/images.js';

// The server rescans by itself when files are added (folder watcher); the home screen
// checks this often whether the library changed and refreshes its rows.
const LIBRARY_POLL_MS = 15000;

/** Changes whenever a scan finishes or the TMDB pass starts/ends. */
function libraryKey(status) {
  const scan = status.lastScan || {};
  const metadata = status.metadata || {};
  return [scan.finishedAt, status.scanning, metadata.running].join('|');
}

function rowTitle(row) {
  if (row.key === 'continueWatching') return t.rowContinue;
  if (row.key === 'recentMovies') return t.rowRecentMovies;
  if (row.key === 'recentEpisodes') return t.rowRecentEpisodes;
  if (row.key === 'series') return t.rowSeries;
  if (row.key === 'videos') return t.rowVideos(row.category);
  return '';
}

function rowId(row) {
  return row.key + (row.category ? '-' + row.category : '');
}

function heroHtml(featured) {
  const isMovie = featured.type === 'movie';
  return `
    <section class="hero" data-scroll-anchor data-scroll-to="0">
      ${featured.backdrop ? artHtml(featured.backdrop, '', 'hero-backdrop') : '<div class="hero-backdrop hero-backdrop-empty"></div>'}
      <div class="hero-content">
        <p class="hero-kicker">${isMovie ? t.kindMovie : t.kindSeries}</p>
        <h1 class="hero-title">${escapeHtml(featured.title)}</h1>
        <p class="hero-meta">${escapeHtml(joinMeta([featured.year, formatRating(featured.rating), featured.genres.slice(0, 3).join(', ')]))}</p>
        ${featured.overview ? `<p class="hero-overview">${escapeHtml(featured.overview)}</p>` : ''}
        <div class="button-row">
          ${
            isMovie
              ? `<button class="btn btn-primary" data-focusable data-focus-id="hero-play" data-autofocus data-action="play">${t.play}</button>
                 <button class="btn" data-focusable data-focus-id="hero-info" data-action="info">${t.moreInfo}</button>`
              : `<button class="btn btn-primary" data-focusable data-focus-id="hero-info" data-autofocus data-action="info">${t.toSeries}</button>`
          }
        </div>
      </div>
    </section>`;
}

function rowHtml(row, index) {
  const id = rowId(row);
  return `
    <section class="row" data-scroll-anchor ${index === 0 ? 'data-scroll-to="0"' : ''} data-focus-group="row-${escapeHtml(id)}">
      <h2 class="row-title">${escapeHtml(rowTitle(row))}</h2>
      <div class="row-viewport">
        <div class="row-track" data-scroll-row>
          ${row.items
            .map((item, i) =>
              // Continue watching uses wide cards for everything, movies included.
              cardHtml(item, `${id}-${item.type}-${item.id}`, `data-row="${index}" data-index="${i}"`, {
                landscape: row.key === 'continueWatching',
              })
            )
            .join('')}
        </div>
      </div>
    </section>`;
}

export function homeScreen(params) {
  let alive = true;
  let root;
  let data = null;
  let pollTimer = null;
  let lastLibraryKey = null;

  function messageHtml(text, withRetry) {
    return `
      <div class="message-box">
        <p class="message-text">${escapeHtml(text)}</p>
        <div class="button-row">
          ${withRetry ? `<button class="btn btn-primary" data-focusable data-focus-id="retry" data-autofocus data-action="retry">${t.retry}</button>` : ''}
          <button class="btn" data-focusable data-focus-id="settings" ${withRetry ? '' : 'data-autofocus'} data-action="settings">${t.navSettings}</button>
        </div>
      </div>`;
  }

  function show(bodyHtml) {
    root.innerHTML = `
      <div class="home">
        ${navbarHtml('home')}
        <div class="page-viewport">
          <div class="page" data-scroll-page="top" data-scroll-margin="140">${bodyHtml}</div>
        </div>
      </div>`;
    bindNavbar(root, 'home');
    observeImages(root);
    focus.ensureFocus();
  }

  function render(home) {
    data = home;
    if (!home.featured && !home.rows.length) {
      show(messageHtml(t.homeEmpty, false));
      return;
    }
    show((home.featured ? heroHtml(home.featured) : '<div class="hero-spacer"></div>') + home.rows.map(rowHtml).join(''));
  }

  function load() {
    loadCached(params, api.getHome, {
      render,
      error: () => show(messageHtml(t.serverUnreachable, true)),
      isAlive: () => alive,
    });
  }

  function pollLibrary() {
    pollTimer = null;
    api.getLibraryStatus().then(
      (status) => {
        if (!alive) return;
        const key = libraryKey(status);
        // Not while a dialog is open: re-rendering would move the focus behind it.
        if (lastLibraryKey !== null && key !== lastLibraryKey && !modal.isOpen()) load();
        if (!modal.isOpen()) lastLibraryKey = key;
        schedulePoll();
      },
      () => alive && schedulePoll()
    );
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollLibrary, LIBRARY_POLL_MS);
  }

  function onClick(event) {
    const card = event.target.closest('[data-row]');
    if (card) {
      const row = data.rows[Number(card.getAttribute('data-row'))];
      const item = row.items[Number(card.getAttribute('data-index'))];
      // Continue watching plays right away, from where the user stopped.
      if (row.key === 'continueWatching') router.navigate('player', { id: item.id });
      else openItem(item);
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.getAttribute('data-action');
    if (action === 'retry') load();
    else if (action === 'settings') router.navigate('settings');
    else if (action === 'play') router.navigate('player', { id: data.featured.id });
    else if (action === 'info') openItem(data.featured);
  }

  return {
    mount(el) {
      root = el;
      root.addEventListener('click', onClick);
      if (!params.cache) root.innerHTML = `<p class="loading">${t.loading}</p>`;
      load();
      pollLibrary();
    },
    unmount() {
      alive = false;
      clearTimeout(pollTimer);
    },
  };
}
