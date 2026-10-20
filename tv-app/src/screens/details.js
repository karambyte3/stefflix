// Details of a movie or a series (with a season selector and the episode list).
// params: { kind: 'movie' | 'series', id, season?, focusEpisode? }
// The main button resumes ("Продължи от 34:12") when there is progress; the yellow
// button marks the focused episode watched / unwatched.
import * as api from '../api.js';
import * as focus from '../focus.js';
import * as router from '../router.js';
import { artHtml, progressHtml } from '../components/card.js';
import { languageName } from '../components/subtitles.js';
import { t } from '../i18n/bg.js';
import { loadCached } from '../navigation.js';
import {
  escapeHtml,
  formatBytes,
  formatRating,
  formatRuntime,
  formatTime,
  formatWarnings,
  joinMeta,
} from '../utils/format.js';
import { observeImages } from '../utils/images.js';

function episodeName(episode) {
  return episode.title || t.episode(episode.episodeNumber);
}

/** A Netflix-style episode card in the horizontal row: still with progress, code and title. */
function episodeCardHtml(episode, autofocus) {
  return `
    <div class="card card-landscape episode-card${episode.available ? '' : ' is-unavailable'}" data-focusable
      data-focus-id="ep-${episode.id}" data-episode="${episode.id}" ${autofocus ? 'data-autofocus' : ''}>
      ${artHtml(episode.still, String(episode.episodeNumber), 'art-landscape', progressHtml(episode))}
      <div class="card-caption">
        <div class="card-line2">${escapeHtml(t.episodeCode(episode.seasonNumber, episode.episodeNumber))}</div>
        <div class="card-line1">${escapeHtml(episodeName(episode))}</div>
      </div>
    </div>`;
}

/** Title, meta and overview of the focused episode, shown under the row. */
function episodeInfoHtml(episode) {
  if (!episode) return '';
  const meta = joinMeta([
    t.episodeCode(episode.seasonNumber, episode.episodeNumber),
    formatRuntime(episode.runtime, episode.duration),
    episode.watched ? t.watched : '',
    episode.available ? '' : t.unavailable,
  ]);
  return `
    <h3 class="episode-info-title">${escapeHtml(episodeName(episode))}</h3>
    <p class="episode-info-meta">${escapeHtml(meta)}</p>
    ${episode.overview ? `<p class="episode-info-overview">${escapeHtml(episode.overview)}</p>` : ''}`;
}

/**
 * Top-billed cast. For movies it sits right under the hero and isn't focusable (it fits on
 * one line, 10 x 172px). For series it's below the episodes, so it's focusable: otherwise
 * the page would never scroll down to it.
 */
function castHtml(cast, focusable) {
  if (!cast || !cast.length) return '';
  return `
    <section class="cast" data-scroll-anchor ${focusable ? 'data-focus-group="cast"' : ''}>
      <h2 class="section-title">${t.cast}</h2>
      <div class="cast-list">
        ${cast
          .map(
            (person, i) => `
          <div class="cast-member" ${focusable ? `data-focusable data-focus-id="cast-${i}"` : ''}>
            ${artHtml(person.profile, initials(person.name), 'cast-photo')}
            <div class="cast-name">${escapeHtml(person.name)}</div>
            ${person.character ? `<div class="cast-character">${escapeHtml(person.character)}</div>` : ''}
          </div>`
          )
          .join('')}
      </div>
    </section>`;
}

const SUBTITLE_SUMMARY_LANGUAGES = 4;

/** "Субтитри: Български, Английски, Датски, Немски и още 20" for a movie with subtitles, '' otherwise. */
function subtitleSummary(item) {
  if (!item.subtitles || !item.subtitles.length) return '';
  const names = [];
  item.subtitles.forEach((track) => {
    const name = languageName(track);
    if (names.indexOf(name) === -1) names.push(name);
  });
  const shown = names.slice(0, SUBTITLE_SUMMARY_LANGUAGES).join(', ');
  const more = names.length - SUBTITLE_SUMMARY_LANGUAGES;
  return t.subtitlesList(more > 0 ? shown + t.subtitlesMore(more) : shown);
}

function initials(name) {
  return (name || '')
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join('');
}

function button(focusId, label, attrs, primary, autofocus) {
  return `<button class="btn${primary ? ' btn-primary' : ' btn-small'}" data-focusable data-focus-id="${focusId}"
    ${autofocus ? 'data-autofocus' : ''} ${attrs}>${escapeHtml(label)}</button>`;
}

/** Play / resume / from-the-start / watched-toggle buttons. */
function movieButtons(item) {
  if (!item.available) return '';
  const resumeAt = item.progress.resumeAt;
  const play = resumeAt
    ? button('play', t.resumeFrom(formatTime(resumeAt)), `data-play="${item.id}" data-start="${resumeAt}"`, true, true) +
      button('restart', t.fromStart, `data-play="${item.id}" data-start="0"`)
    : button('play', t.play, `data-play="${item.id}" data-start="0"`, true, true);
  const toggle = button('watched', item.progress.watched ? t.markUnwatched : t.markWatched, 'data-toggle-watched');
  return play + toggle;
}

function seriesButtons(item, autofocus) {
  const next = item.upNext;
  let play = '';
  if (next) {
    const label = next.resumeAt
      ? t.resumeEpisode(next.seasonNumber, next.episodeNumber, formatTime(next.resumeAt))
      : t.playEpisode(next.seasonNumber, next.episodeNumber);
    play = button('play', label, `data-play="${next.id}" data-start="${next.resumeAt}"`, true, autofocus);
  }
  return play + button('watched', item.watched ? t.markSeriesUnwatched : t.markSeriesWatched, 'data-toggle-watched');
}

/** "Остават 45 мин" under the buttons of a partly watched movie. */
function remainingHtml(item) {
  const progress = item.progress;
  if (!progress || !progress.resumeAt || !progress.duration) return '';
  const ratio = Math.min(1, progress.resumeAt / progress.duration);
  return `
    <div class="details-progress">
      <div class="progress-bar"><div class="progress-bar-fill" style="transform: scaleX(${ratio})"></div></div>
      <span class="details-remaining">${escapeHtml(t.remaining(formatRuntime(null, progress.duration - progress.resumeAt)))}</span>
    </div>`;
}

export function detailsScreen(params) {
  const isSeries = params.kind === 'series';
  let alive = true;
  let root;
  let data = null;
  let rowPrepared = false;

  function selectedSeason() {
    const seasons = data.seasons;
    return seasons.filter((s) => s.seasonNumber === params.season)[0] || seasons[0];
  }

  function findEpisode(id) {
    return selectedSeason().episodes.filter((ep) => ep.id === id)[0] || null;
  }

  /** The episode the row starts at: "up next" if it's in this season, else the first unwatched one. */
  function defaultEpisode() {
    const episodes = selectedSeason().episodes;
    return (
      (params.focusEpisode && findEpisode(params.focusEpisode)) ||
      (data.upNext && findEpisode(data.upNext.id)) ||
      episodes.filter((ep) => !ep.watched)[0] ||
      episodes[0] ||
      null
    );
  }

  function episodesHtml() {
    const season = selectedSeason();
    return season.episodes.map((ep) => episodeCardHtml(ep, ep.id === params.focusEpisode)).join('');
  }

  function showEpisodeInfo(episode) {
    const info = root.querySelector('.episode-info');
    if (info) info.innerHTML = episodeInfoHtml(episode);
  }

  /** Scrolls the row to the default episode and makes Down from the buttons land on it. */
  function prepareRow() {
    const episode = defaultEpisode();
    if (!episode) return;
    focus.rememberInGroup('episodes', 'ep-' + episode.id);
    focus.revealInRow(root.querySelector(`[data-focus-id="ep-${episode.id}"]`));
    showEpisodeInfo(episode);
  }

  function seriesSectionHtml(item) {
    if (!item.seasons.length) return '';
    return `
      <section class="episodes-section" data-scroll-anchor>
        <div class="seasons" data-focus-group="seasons">
          ${item.seasons
            .map(
              (s) => `
            <button class="season-tab${s.seasonNumber === params.season ? ' is-active' : ''}" data-focusable
              data-focus-id="season-${s.seasonNumber}" data-season="${s.seasonNumber}">${t.season(s.seasonNumber)}</button>`
            )
            .join('')}
          <span class="episodes-hint">${t.episodesHint}</span>
        </div>
        <div class="episodes-viewport">
          <div class="episodes-track" data-scroll-row data-focus-group="episodes">${episodesHtml()}</div>
        </div>
        <div class="episode-info"></div>
      </section>`;
  }

  function render(item) {
    data = item;
    const warning = isSeries ? '' : formatWarnings(item.compatibility);
    const watched = isSeries ? item.watched : item.progress.watched;
    const meta = joinMeta([
      item.year,
      formatRating(item.rating),
      isSeries ? t.episodeCount(item.episodeCount) : formatRuntime(item.runtime, item.duration),
      item.genres.join(', '),
      watched ? t.watched : '',
    ]);
    const buttons = isSeries ? seriesButtons(item, !params.focusEpisode) : movieButtons(item);

    // Open on the season of the episode "Play" would start.
    if (isSeries && params.season === undefined && item.seasons.length) {
      params.season = item.upNext ? item.upNext.seasonNumber : item.seasons[0].seasonNumber;
    }

    root.innerHTML = `
      <div class="details${isSeries ? ' details-series' : ''}">
        ${item.backdrop ? artHtml(item.backdrop, '', 'details-backdrop') : ''}
        <div class="details-shade"></div>
        <div class="page-viewport">
          <div class="page" data-scroll-page="visible" data-scroll-margin="60">
            <section class="details-hero" data-scroll-anchor data-scroll-to="0">
              ${artHtml(item.poster, item.title, 'details-poster')}
              <div class="details-info">
                <h1 class="details-title">${escapeHtml(item.title)}</h1>
                ${item.originalTitle && item.originalTitle !== item.title ? `<p class="details-original">${escapeHtml(item.originalTitle)}</p>` : ''}
                <p class="details-meta">${escapeHtml(meta)}</p>
                ${item.overview ? `<p class="details-overview">${escapeHtml(item.overview)}</p>` : ''}
                ${warning ? `<p class="details-warning">${escapeHtml(warning)}</p>` : ''}
                <div class="button-row">${buttons}</div>
                ${isSeries ? '' : remainingHtml(item)}
                <p class="details-file">${escapeHtml(
                  joinMeta([
                    isSeries ? '' : item.fileName,
                    isSeries ? '' : formatBytes(item.size),
                    !isSeries && !item.available ? t.unavailable : '',
                    isSeries ? '' : subtitleSummary(item),
                    item.tmdbId ? t.tmdbId(item.tmdbId) : '',
                  ])
                )}</p>
              </div>
            </section>
            ${isSeries ? seriesSectionHtml(item) + castHtml(item.cast, true) : castHtml(item.cast, false)}
          </div>
        </div>
      </div>`;

    if (isSeries && item.seasons.length) {
      // Moving into the season tabs lands on the selected season.
      focus.rememberInGroup('seasons', 'season-' + params.season);
      // Only on the first render: a reload (after marking watched) keeps the row where it was.
      if (!rowPrepared) {
        rowPrepared = true;
        prepareRow();
      }
    }
    observeImages(root);
    focus.ensureFocus();
    if (isSeries) {
      const current = focus.getCurrent();
      const focused = current && current.hasAttribute('data-episode') && findEpisode(Number(current.getAttribute('data-episode')));
      if (focused) showEpisodeInfo(focused);
      else if (!root.querySelector('.episode-info:not(:empty)')) showEpisodeInfo(defaultEpisode());
    }
  }

  function selectSeason(number) {
    if (number === params.season) return;
    params.season = number;
    Array.prototype.forEach.call(root.querySelectorAll('.season-tab'), (tab) => {
      tab.classList.toggle('is-active', Number(tab.getAttribute('data-season')) === number);
    });
    const track = root.querySelector('.episodes-track');
    track.innerHTML = episodesHtml();
    focus.setScroll(track, 0, 0, true);
    prepareRow();
    observeImages(track);
  }

  // The panel under the row describes the focused episode.
  function onFocus(event) {
    const card = event.target.closest && event.target.closest('[data-episode]');
    if (card) showEpisodeInfo(findEpisode(Number(card.getAttribute('data-episode'))));
  }

  function fetchDetails() {
    return isSeries ? api.getSeries(params.id) : api.getMedia(params.id);
  }

  /** Re-renders with fresh data after a change; focus stays on the same element. */
  function reload() {
    fetchDetails().then(
      (item) => {
        if (!alive) return;
        params.cache = item;
        render(item);
      },
      () => {}
    );
  }

  function toggleWatched() {
    const request = isSeries
      ? api.setSeriesWatched(params.id, !data.watched)
      : api.setWatched(params.id, !data.progress.watched);
    request.then(reload, () => {});
  }

  function toggleEpisodeWatched(episodeId) {
    const episode = findEpisode(episodeId);
    if (episode) api.setWatched(episodeId, !episode.watched).then(reload, () => {});
  }

  function onClick(event) {
    const play = event.target.closest('[data-play]');
    if (play) {
      router.navigate('player', { id: Number(play.getAttribute('data-play')), start: Number(play.getAttribute('data-start')) });
      return;
    }
    if (event.target.closest('[data-toggle-watched]')) {
      toggleWatched();
      return;
    }
    const season = event.target.closest('[data-season]');
    if (season) {
      selectSeason(Number(season.getAttribute('data-season')));
      return;
    }
    const episode = event.target.closest('[data-episode]');
    // An episode resumes where it was left (no "start": the player uses the saved position).
    if (episode && !episode.classList.contains('is-unavailable')) {
      router.navigate('player', { id: Number(episode.getAttribute('data-episode')) });
    }
  }

  return {
    mount(el) {
      root = el;
      root.addEventListener('click', onClick);
      if (isSeries) root.addEventListener('tvfocus', onFocus);
      if (!params.cache) root.innerHTML = `<p class="loading">${t.loading}</p>`;
      loadCached(params, fetchDetails, {
        render,
        error: () => {
          root.innerHTML = `
            <div class="message-box">
              <p class="message-text">${t.serverUnreachable}</p>
              <div class="button-row"><button class="btn btn-primary" data-focusable data-focus-id="back">${t.back}</button></div>
            </div>`;
          root.querySelector('[data-focus-id="back"]').addEventListener('click', () => router.back());
          focus.focusInitial();
        },
        isAlive: () => alive,
      });
    },
    unmount() {
      alive = false;
    },

    onKey(action) {
      if (action !== 'yellow' || !isSeries) return false;
      const current = focus.getCurrent();
      if (current && current.hasAttribute('data-episode')) toggleEpisodeWatched(Number(current.getAttribute('data-episode')));
      return true;
    },
  };
}
