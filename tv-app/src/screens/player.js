// Video player: HTML5 <video> streaming from the server, with YouTube-style overlay controls,
// a custom subtitle renderer, progress reporting and the "next episode" card.
// params: { id, start? } - start in seconds; without it playback resumes from the saved progress.
//
// Keys work in three modes:
// - watching (controls hidden): OK = pause/play, ◀ ▶ = seeking mode, ▼ = control bar, ▲ = progress bar.
// - seeking: the video pauses and ◀ ▶ move a target with a preview thumbnail of that scene;
//   OK or 2.5 s without a press jumps there (playing again if it was playing), Back cancels.
// - control bar: the video keeps playing; ◀ ▶ move focus between the buttons
//   (play/pause on the left, next episode and subtitles on the right), ▲ goes to the progress
//   bar, where ◀ ▶ seek like above. ▼ below the buttons, Back or a few seconds without a press
//   hide it.
// Back hides the controls when they are on screen (also while paused) and leaves the player
// when they are not. After 30 s on pause, a Netflix-style pause screen shows the title and overview.
// Color buttons work in every mode: Red/Green subtitle sync, Yellow online search, Blue subtitles.
import * as api from '../api.js';
import * as focus from '../focus.js';
import * as modal from '../components/modal.js';
import * as router from '../router.js';
import { artHtml } from '../components/card.js';
import { ICON_NEXT, ICON_PAUSE, ICON_PLAY, ICON_SUBTITLES } from '../components/icons.js';
import { select } from '../components/menu.js';
import { applySubtitleStyle, createSubtitleRenderer, formatOffset, subtitleLabel } from '../components/subtitles.js';
import { t } from '../i18n/bg.js';
import { escapeHtml, formatClock, formatRating, formatRuntime, formatTime, formatWarnings, joinMeta } from '../utils/format.js';
import { observeImages } from '../utils/images.js';
import { createSeekPreview } from './player/seekPreview.js';
import { openSubtitlePanel } from './player/subtitlePanel.js';

const OVERLAY_HIDE_MS = 4000;
const BAR_HIDE_MS = 6000;
// Seeking: the step grows while a direction is held or pressed quickly in a row.
const SEEK_STEPS = [
  { presses: 0, step: 10 },
  { presses: 6, step: 30 },
  { presses: 16, step: 60 },
];
const SEEK_REPEAT_MS = 700; // presses closer than this count as "in a row"
const SEEK_COMMIT_MS = 2500; // the jump happens this long after the last press
const WARNING_VISIBLE_MS = 8000;
const INDICATOR_VISIBLE_MS = 2500;
const OFFSET_STEP_S = 0.25;
// Offset changes are saved once the user stops pressing the button.
const OFFSET_SAVE_DELAY_MS = 800;
// Loading cues for longer than this shows "preparing subtitles".
const SLOW_SUBTITLES_MS = 1500;
const PROGRESS_INTERVAL_MS = 10000;
// The next-episode card appears this long before the end (or at the credits, when known).
const NEXT_CARD_LEAD_S = 30;
const NEXT_COUNTDOWN_S = 10;
const PAUSE_SCREEN_MS = 30000;

/** "Series · С1 Е2 · Title" for episodes, the plain title otherwise. */
function playerTitle(media) {
  if (media.type !== 'episode') return media.title || media.fileName;
  const parts = [media.series ? media.series.title : '', t.episodeCode(media.seasonNumber, media.episodeNumber), media.title];
  return parts.filter(Boolean).join(' · ');
}

function seekStep(presses) {
  let step = SEEK_STEPS[0].step;
  SEEK_STEPS.forEach((s) => {
    if (presses >= s.presses) step = s.step;
  });
  return step;
}

export function playerScreen(params) {
  let alive = true;
  let root;
  let playerEl;
  let video;
  let overlay;
  let progressEl;
  let progressFill;
  let progressBuffer;
  let progressKnob;
  let creditsMark;
  let currentTimeEl;
  let durationEl;
  let endsAtEl;
  let playButton;
  let nextButton;
  let subtitlesButton;
  let spinner;
  let errorPanel;
  let warningEl;
  let indicatorEl;
  let preview;

  let hideTimer = null;
  let warningTimer = null;
  let indicatorTimer = null;
  let failed = false;

  // Controls
  let barOpen = false; // the buttons have focus (otherwise the overlay is only shown)
  let panel = null; // the open subtitle panel

  // Seeking
  let scrub = null; // { target, origin, wasPlaying, direction, presses, lastPress } while choosing a target
  let scrubTimer = null;
  let seekTarget = null; // seconds, from the jump until the video has got there

  // Subtitles
  let renderer;
  let subtitles = []; // tracks available for this media
  let selected = null; // the selected track, or null for "off"
  let settings = null; // subtitle style + preferred language
  let cuesLoaded = false;
  let cueRequest = 0; // ignores responses for a track that is no longer selected
  let frame = null;
  let offsetChanged = false;
  let offsetSaveTimer = null;

  // Resume + progress
  let media = null;
  let startAt = params.start; // undefined until the saved progress is known
  let started = false; // true once playback began at the right position
  let progressTimer = null;
  let lastReported = null;
  let reportedFinished = false; // after that, later reports would only undo it
  let endsAtText = '';

  // Next episode
  let next = null;
  let nextVisible = false;
  let nextDismissed = false;
  let countdownTimer = null;
  let countdownLeft = 0;
  let nextCardEl;

  // Pause screen
  let pauseScreenEl;
  let pauseScreenTimer = null;
  let pauseScreenVisible = false;

  // --- overlay -----------------------------------------------------------

  function setControlsVisible(visible) {
    overlay.classList.toggle('is-visible', visible);
    // Subtitles move up while the controls are on screen.
    playerEl.classList.toggle('controls-visible', visible);
    if (!visible) setBarOpen(false);
  }

  function setBarOpen(open) {
    barOpen = open;
    playerEl.classList.toggle('bar-open', open);
  }

  /** Shows the controls and (re)starts the timer that hides them while the video plays. */
  function showOverlay() {
    // The subtitle panel keeps the controls out of the way until it closes.
    if (panel) return;
    setControlsVisible(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(
      () => {
        if (!video.paused && !scrub && !panel) setControlsVisible(false);
      },
      barOpen ? BAR_HIDE_MS : OVERLAY_HIDE_MS
    );
  }

  /** Gives the buttons focus; `focusId` picks the button (null keeps the current focus). */
  function openBar(focusId) {
    setBarOpen(true);
    showOverlay();
    if (focusId) focus.focus(root.querySelector(`[data-focus-id="${focusId}"]`));
    else if (!focus.getCurrent() || !overlay.contains(focus.getCurrent())) focus.focus(playButton);
  }

  /** ▼ / Back: hides the controls right away, also while paused (the video stays paused). */
  function hideControls() {
    clearTimeout(hideTimer);
    setControlsVisible(false);
  }

  function controlsVisible() {
    return overlay.classList.contains('is-visible');
  }

  // --- pause screen --------------------------------------------------------

  // Like Netflix: after a while on pause, the title and overview fade in over the dimmed video.
  // Any key (or the pointer) brings back the controls; OK / Play also resume.

  function renderPauseScreen() {
    const isEpisode = media.type === 'episode';
    const title = isEpisode && media.series ? media.series.title : media.title || media.fileName;
    const meta = isEpisode
      ? joinMeta([t.episodeCode(media.seasonNumber, media.episodeNumber), media.title])
      : joinMeta([media.year, formatRuntime(media.runtime, media.duration), formatRating(media.rating), media.category]);
    pauseScreenEl.querySelector('.pause-screen-title').textContent = title;
    pauseScreenEl.querySelector('.pause-screen-meta').textContent = meta;
    pauseScreenEl.querySelector('.pause-screen-overview').textContent = media.overview || '';
  }

  /** (Re)starts the wait for the pause screen; does nothing while playing. */
  function schedulePauseScreen() {
    clearTimeout(pauseScreenTimer);
    pauseScreenTimer = null;
    if (!video.paused || failed) return;
    pauseScreenTimer = setTimeout(() => {
      pauseScreenTimer = null;
      // Not over a menu, while seeking, or before the details have loaded - try again later.
      if (scrub || panel || modal.isOpen() || !media) schedulePauseScreen();
      else if (video.paused && !failed) showPauseScreen();
    }, PAUSE_SCREEN_MS);
  }

  function showPauseScreen() {
    pauseScreenVisible = true;
    hideControls();
    playerEl.classList.add('pause-screen-visible');
  }

  function hidePauseScreen() {
    if (!pauseScreenVisible) return;
    pauseScreenVisible = false;
    playerEl.classList.remove('pause-screen-visible');
  }

  /** A short message in the corner; `sticky` keeps it until the next one (for "searching..."). */
  function showIndicator(text, sticky) {
    indicatorEl.textContent = text;
    indicatorEl.classList.add('is-visible');
    clearTimeout(indicatorTimer);
    if (!sticky) indicatorTimer = setTimeout(hideIndicator, INDICATOR_VISIBLE_MS);
  }

  function hideIndicator() {
    clearTimeout(indicatorTimer);
    indicatorEl.classList.remove('is-visible');
  }

  function hasDuration() {
    return isFinite(video.duration) && video.duration > 0;
  }

  /** The position the controls show: the seek target while there is one. */
  function shownPosition() {
    if (scrub) return scrub.target;
    return seekTarget !== null ? seekTarget : video.currentTime;
  }

  function updateProgress() {
    const duration = video.duration;
    const position = shownPosition();
    const fraction = hasDuration() ? Math.min(1, position / duration) : 0;

    progressFill.style.transform = `scaleX(${fraction})`;
    progressKnob.style.transform = `translate3d(${fraction * progressEl.offsetWidth}px, 0, 0)`;
    currentTimeEl.textContent = formatTime(position);
    durationEl.textContent = hasDuration() ? formatTime(duration) : '--:--';

    if (hasDuration() && video.buffered.length) {
      // Show the buffered range that contains the current position.
      let bufferedEnd = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime + 0.5) bufferedEnd = video.buffered.end(i);
      }
      progressBuffer.style.transform = `scaleX(${Math.min(1, bufferedEnd / duration)})`;
    }
    updateEndsAt(position);
    updateCreditsMark();
  }

  /** "Свършва в 23:47" - the clock time the video ends if watched from `position` on. */
  function updateEndsAt(position) {
    const text = hasDuration() ? t.endsAt(formatClock(new Date(Date.now() + (video.duration - position) * 1000))) : '';
    if (text !== endsAtText) {
      endsAtText = text;
      endsAtEl.textContent = text;
    }
  }

  function updateCreditsMark() {
    if (creditsMark.style.display === 'block' || !media || !media.creditsAt || !hasDuration()) return;
    if (media.creditsAt >= video.duration) return;
    creditsMark.style.left = `${(media.creditsAt / video.duration) * 100}%`;
    creditsMark.style.display = 'block';
  }

  function updatePlayButton() {
    playButton.innerHTML = video.paused ? ICON_PLAY : ICON_PAUSE;
  }

  function setLoading(isLoading) {
    spinner.classList.toggle('is-visible', isLoading);
  }

  // --- seeking -------------------------------------------------------------

  /** ◀ ▶ / RW FF: starts seeking mode or moves its target. `direction` is -1 or 1. */
  function scrubStep(direction) {
    if (!hasDuration() || !started) return;
    const now = Date.now();
    if (!scrub) {
      const origin = seekTarget !== null ? seekTarget : video.currentTime;
      scrub = { target: origin, origin, wasPlaying: !video.paused, direction, presses: 0, lastPress: 0 };
      playerEl.classList.add('scrubbing');
      if (!video.paused) video.pause();
    }
    const inRow = scrub.direction === direction && now - scrub.lastPress < SEEK_REPEAT_MS;
    scrub.presses = inRow ? scrub.presses + 1 : 0;
    scrub.direction = direction;
    scrub.lastPress = now;

    const target = scrub.target + direction * seekStep(scrub.presses);
    scrub.target = Math.max(0, Math.min(video.duration - 1, target));
    updateProgress();
    preview.show(scrub.target, scrub.target - scrub.origin, scrub.target / video.duration);
    showOverlay();

    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => commitScrub(scrub.wasPlaying), SEEK_COMMIT_MS);
  }

  function endScrub() {
    clearTimeout(scrubTimer);
    scrubTimer = null;
    const ended = scrub;
    scrub = null;
    playerEl.classList.remove('scrubbing');
    preview.hide();
    return ended;
  }

  /** Jumps to the chosen target; `resume` plays from there. */
  function commitScrub(resume) {
    const ended = endScrub();
    if (!ended) return;
    if (Math.abs(ended.target - video.currentTime) > 0.5) {
      seekTarget = ended.target;
      video.currentTime = ended.target;
    }
    if (resume) play();
    updateProgress();
    renderer.update(shownPosition());
    showOverlay();
  }

  /** Back while seeking: stays where it was. */
  function cancelScrub() {
    const ended = endScrub();
    if (ended && ended.wasPlaying) play();
    updateProgress();
    showOverlay();
  }

  // --- subtitles -------------------------------------------------------------

  // While playing, cues are matched on every animation frame (timeupdate fires only
  // ~4 times a second, which is too coarse). The loop runs only when cues are loaded.
  function tick() {
    frame = null;
    renderer.update(video.currentTime);
    if (alive && cuesLoaded && !video.paused) frame = requestAnimationFrame(tick);
  }

  function startSubtitleLoop() {
    if (frame === null && cuesLoaded && !video.paused) frame = requestAnimationFrame(tick);
  }

  function stopSubtitleLoop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function updateSubtitlesButton() {
    subtitlesButton.classList.toggle('is-on', !!selected);
  }

  function selectSubtitle(track) {
    selected = track;
    cuesLoaded = false;
    stopSubtitleLoop();
    renderer.setCues([]);
    updateSubtitlesButton();
    if (!track) return;

    const request = ++cueRequest;
    // Embedded subtitles may need a few seconds to be extracted on the PC the first time.
    const slowTimer = setTimeout(() => {
      if (alive && request === cueRequest) showIndicator(t.subtitlesPreparing);
    }, SLOW_SUBTITLES_MS);
    api.getSubtitles(track.id).then(
      (cues) => {
        clearTimeout(slowTimer);
        if (!alive || request !== cueRequest) return;
        renderer.setCues(cues);
        cuesLoaded = true;
        renderer.update(video.currentTime);
        startSubtitleLoop();
      },
      () => {
        clearTimeout(slowTimer);
        if (alive && request === cueRequest) showIndicator(t.subtitleLoadFailed);
      }
    );
  }

  /** Picks the track for the preferred language once both the media and the settings are known. */
  function selectDefaultSubtitle() {
    if (!settings || selected) return;
    if (settings.language === 'off') return;
    // Forced tracks (only the foreign-language lines) are the fallback, not the first choice.
    const inLanguage = subtitles.filter((s) => s.language === settings.language);
    const full = inLanguage.filter((s) => (s.tags || []).indexOf('forced') === -1);
    const preferred = full[0] || inLanguage[0];
    if (preferred) selectSubtitle(preferred);
  }

  /** The panel's track list: "Off" first, then the tracks with labels that tell them apart. */
  function trackOptions() {
    const seen = {};
    const labelCount = {};
    subtitles.forEach((track) => {
      const label = subtitleLabel(track);
      labelCount[label] = (labelCount[label] || 0) + 1;
    });
    const isDuplicate = (track) => labelCount[subtitleLabel(track)] > 1;
    return [{ value: null, label: t.subtitlesOff }].concat(
      subtitles.map((track) => {
        let label = subtitleLabel(track);
        seen[label] = (seen[label] || 0) + 1;
        // Same language twice: the track title tells them apart ("Spanish (Latin America)").
        if (track.title && isDuplicate(track)) label += ` – ${track.title}`;
        else if (seen[label] > 1) label += ` (${seen[label]})`;
        return { value: track.id, label };
      })
    );
  }

  /** Chooses a track from the panel and remembers its language as the preferred one. */
  function chooseTrack(id) {
    const track = subtitles.filter((s) => s.id === id)[0] || null;
    if (track === selected) return;
    selectSubtitle(track);
    // A track of unknown language changes nothing.
    const language = track ? track.language : 'off';
    if (language) {
      if (settings) settings.language = language;
      api.updateSubtitleSettings({ language }).catch(() => {});
    }
  }

  function openPanel() {
    if (panel || failed) return;
    clearTimeout(hideTimer);
    // The controls step aside, so the subtitles show where they normally are.
    setControlsVisible(false);
    playerEl.classList.add('panel-open');
    panel = openSubtitlePanel({
      tracks: trackOptions(),
      selected: selected ? selected.id : null,
      offset: renderer.getOffset(),
      online: !!(media && media.onlineSubtitles),
      onSelect: chooseTrack,
      onShift: (direction) => shiftOffset(direction * OFFSET_STEP_S),
      onReset: () => shiftOffset(-renderer.getOffset()),
      onSearchOnline: searchOnline,
      onKey: (action) => {
        if (action === 'red' || action === 'green') {
          panel.setOffset(shiftOffset(action === 'green' ? OFFSET_STEP_S : -OFFSET_STEP_S));
          return true;
        }
        if (action === 'blue') {
          panel.close();
          return true;
        }
        if (action === 'yellow') {
          panel.close();
          searchOnline();
          return true;
        }
        return false;
      },
      onClose: () => {
        panel = null;
        if (!alive) return;
        playerEl.classList.remove('panel-open');
        if (!failed) openBar('player-subs');
      },
    });
  }

  // --- OpenSubtitles ------------------------------------------------------------

  let onlineBusy = false;

  /** The preferred subtitle language first, English as the fallback. */
  function onlineLanguages() {
    const preferred = settings && settings.language && settings.language !== 'off' ? settings.language : 'bg';
    return preferred === 'en' ? ['en'] : [preferred, 'en'];
  }

  function onlineErrorText(err) {
    return t.onlineErrors[(err && err.code) || 'default'] || t.onlineErrors.default;
  }

  /** "Български (за хора с увреден слух) · точно за този файл" + "Release.Name · 1 234 изтегляния" */
  function onlineOption(result, index) {
    const marks = [subtitleLabel(result)];
    if (result.hashMatch) marks.push(t.onlineHashMatch);
    if (result.machineTranslated) marks.push(t.onlineMachine);
    if (result.downloaded) marks.push(t.onlineAlreadyDownloaded);
    const downloads = t.onlineDownloads(String(result.downloads).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
    return { value: index, label: marks.join(' · '), detail: result.release ? `${result.release} · ${downloads}` : downloads };
  }

  /** Yellow button / "Search online": lists OpenSubtitles results, downloads the chosen one and shows it. */
  function searchOnline() {
    if (!media) return;
    if (!media.onlineSubtitles) {
      showIndicator(t.onlineErrors.not_configured);
      return;
    }
    if (onlineBusy) return;
    onlineBusy = true;
    showIndicator(t.onlineSearching, true);
    api.searchOnlineSubtitles(params.id, onlineLanguages()).then(
      (results) => {
        onlineBusy = false;
        if (!alive) return;
        if (!results.length) {
          showIndicator(t.onlineNothingFound);
          return;
        }
        hideIndicator();
        select(t.onlineMenuTitle, results.map(onlineOption), null).then((choice) => {
          if (choice && alive) downloadOnline(results[choice.value]);
        });
      },
      (err) => {
        onlineBusy = false;
        if (alive) showIndicator(onlineErrorText(err));
      }
    );
  }

  function downloadOnline(result) {
    onlineBusy = true;
    showIndicator(t.onlineDownloading, true);
    api.downloadOnlineSubtitle(params.id, result).then(
      (response) => {
        onlineBusy = false;
        if (!alive) return;
        const track = response.subtitle;
        const known = subtitles.filter((s) => s.id === track.id)[0];
        if (!known) subtitles.push(track);
        selectSubtitle(known || track);
        showIndicator(response.remaining === null ? t.onlineDownloaded : t.onlineDownloadedLeft(response.remaining));
      },
      (err) => {
        onlineBusy = false;
        if (alive) showIndicator(onlineErrorText(err));
      }
    );
  }

  function saveOffset() {
    offsetSaveTimer = null;
    api.setSubtitleOffset(params.id, renderer.getOffset()).catch(() => {});
  }

  /** Moves the subtitles by `delta` seconds; returns the new offset. */
  function shiftOffset(delta) {
    offsetChanged = true;
    const value = Math.round((renderer.getOffset() + delta) * 100) / 100;
    renderer.setOffset(value);
    renderer.update(video.currentTime);
    const text = t.subtitleOffset(formatOffset(value));
    showIndicator(selected ? text : `${t.subtitlesAreOff} · ${text}`);
    clearTimeout(offsetSaveTimer);
    offsetSaveTimer = setTimeout(saveOffset, OFFSET_SAVE_DELAY_MS);
    return value;
  }

  function loadSubtitleSetup() {
    api.getSubtitleSettings().then(
      (loaded) => {
        if (!alive) return;
        settings = loaded;
        applySubtitleStyle(root.querySelector('.subtitles'), settings);
        selectDefaultSubtitle();
      },
      () => {}
    );
    api.getSubtitleOffset(params.id).then(
      (result) => {
        // Don't overwrite an adjustment the user made while this was loading.
        if (alive && !offsetChanged) renderer.setOffset(result.offset);
      },
      () => {}
    );
  }

  // --- resume & progress -------------------------------------------------------

  /** Starts playback once both the video metadata and the start position are known. */
  function begin() {
    if (started || failed || startAt === undefined || video.readyState < 1) return;
    started = true;
    if (startAt > 0 && startAt < video.duration - 5) video.currentTime = startAt;
    play();
  }

  /** Sends the position to the server; `finished` reports the very end (marks it watched). */
  function reportProgress(finished) {
    // Before `begin` the position is 0 and would overwrite the saved one.
    if (!started || failed || reportedFinished) return;
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) return;
    // While a target is being chosen, the video is still at the old position.
    const position = finished ? duration : seekTarget !== null ? seekTarget : video.currentTime;
    if (lastReported !== null && Math.abs(position - lastReported) < 1) return;
    lastReported = position;
    if (finished) reportedFinished = true;
    api.saveProgress(params.id, position, duration).catch(() => {});
  }

  // --- next episode ---------------------------------------------------------------

  function nextCardThreshold() {
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) return Infinity;
    return media && media.creditsAt ? media.creditsAt : duration - NEXT_CARD_LEAD_S;
  }

  function renderCountdown() {
    nextCardEl.querySelector('.next-card-countdown').textContent = t.nextStartsIn(countdownLeft);
    nextCardEl.querySelector('.next-card-bar-fill').style.transform = `scaleX(${countdownLeft / NEXT_COUNTDOWN_S})`;
  }

  function showNextCard() {
    nextVisible = true;
    countdownLeft = NEXT_COUNTDOWN_S;
    const code = t.episodeCode(next.seasonNumber, next.episodeNumber);
    nextCardEl.innerHTML = `
      ${artHtml(next.still || next.backdrop, code, 'next-card-art')}
      <div class="next-card-body">
        <p class="next-card-label">${t.nextEpisode}</p>
        <p class="next-card-title">${escapeHtml(next.title ? `${code} · ${next.title}` : code)}</p>
        <p class="next-card-countdown"></p>
        <div class="next-card-bar"><div class="next-card-bar-fill"></div></div>
        <p class="next-card-hint">${t.nextHint}</p>
      </div>`;
    renderCountdown();
    observeImages(nextCardEl);
    nextCardEl.classList.add('is-visible');
    countdownTimer = setInterval(() => {
      if (video.paused) return; // the countdown waits while paused
      countdownLeft--;
      renderCountdown();
      if (countdownLeft <= 0) playNext();
    }, 1000);
  }

  function hideNextCard() {
    nextVisible = false;
    clearInterval(countdownTimer);
    countdownTimer = null;
    nextCardEl.classList.remove('is-visible');
  }

  /** Shows the card near the end, hides it again after a seek back. */
  function updateNextCard() {
    if (!next || nextDismissed || failed) return;
    const position = seekTarget !== null ? seekTarget : video.currentTime;
    const show = video.duration > NEXT_CARD_LEAD_S * 2 && position >= nextCardThreshold();
    if (show && !nextVisible) showNextCard();
    else if (!show && nextVisible) hideNextCard();
  }

  function showNextButton() {
    nextButton.style.display = '';
  }

  function playNext() {
    if (!next) return;
    hideNextCard();
    // Moving on to the next episode means this one is done, even if the credits still run.
    reportProgress(true);
    // Replace, so Back from the next episode returns to the series, not to this episode.
    router.replace('player', { id: next.id });
  }

  function cancelNext() {
    nextDismissed = true;
    hideNextCard();
  }

  // --- playback ------------------------------------------------------------

  function togglePlay() {
    if (video.paused) play();
    else video.pause();
  }

  function play() {
    const result = video.play();
    // play() returns a promise in newer engines; a rejection here is reported via the "error" event anyway.
    if (result && result.catch) result.catch(() => {});
  }

  /** Mouse click on the progress bar (desktop browser / Magic Remote pointer): jumps there. */
  function seekToPointer(event) {
    if (!hasDuration() || !started || failed) return;
    const rect = progressEl.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    endScrub();
    seekTarget = fraction * video.duration;
    video.currentTime = seekTarget;
    updateProgress();
    showOverlay();
  }

  function showError(message) {
    failed = true;
    clearTimeout(hideTimer);
    endScrub();
    if (panel) panel.close();
    setLoading(false);
    setControlsVisible(false);
    // Hidden for the focus manager too, so the arrows stay on the error's button.
    overlay.style.display = 'none';
    stopSubtitleLoop();
    renderer.setCues([]);
    hideNextCard();
    clearTimeout(pauseScreenTimer);
    hidePauseScreen();
    errorPanel.querySelector('.player-error-text').textContent = message;
    errorPanel.classList.add('is-visible');
    focus.focus(errorPanel.querySelector('button'));
  }

  function handleVideoError() {
    const err = video.error;
    if (!err || err.code === 1 /* MEDIA_ERR_ABORTED */) return;

    if (err.code === 2) {
      showError(t.playerErrorNetwork);
    } else if (err.code === 3) {
      showError(t.playerErrorDecode);
    } else {
      // Code 4 is reported both for unsupported files and for unreachable URLs,
      // so ask the server whether it's still there to tell the two apart.
      api.getMedia(params.id).then(
        () => alive && showError(t.playerErrorUnsupported),
        () => alive && showError(t.playerErrorNetwork)
      );
    }
  }

  function onVisibilityChange() {
    // The TV's Home button sends the app to the background: don't keep playing.
    if (document.hidden && video && !video.paused) video.pause();
  }

  // --- keys ------------------------------------------------------------------

  /** Keys that do the same in every mode. Returns true if handled. */
  function onCommonKey(action) {
    switch (action) {
      case 'play':
        play();
        showOverlay();
        return true;
      case 'pause':
        video.pause();
        return true;
      case 'playpause':
        togglePlay();
        showOverlay();
        return true;
      case 'rw':
        scrubStep(-1);
        return true;
      case 'ff':
        scrubStep(1);
        return true;
      case 'green':
        shiftOffset(OFFSET_STEP_S);
        return true;
      case 'red':
        shiftOffset(-OFFSET_STEP_S);
        return true;
      case 'yellow':
        searchOnline();
        return true;
      case 'blue':
        openPanel();
        return true;
      default:
        return false;
    }
  }

  function onScrubKey(action) {
    switch (action) {
      case 'left':
      case 'rw':
        scrubStep(-1);
        break;
      case 'right':
      case 'ff':
        scrubStep(1);
        break;
      case 'enter':
        commitScrub(scrub.wasPlaying);
        break;
      case 'play':
      case 'playpause':
        commitScrub(true);
        break;
      case 'pause':
        commitScrub(false);
        break;
      case 'back':
        cancelScrub();
        break;
      default:
        break; // the arrows up/down and color buttons wait until the jump is done
    }
    return true;
  }

  function onBarKey(action) {
    const onProgress = focus.getCurrent() === progressEl;
    switch (action) {
      case 'left':
      case 'right':
        if (onProgress) scrubStep(action === 'left' ? -1 : 1);
        else focus.move(action);
        break;
      case 'up':
        // Above the progress bar there is nothing: ▲ hides the controls.
        if (!focus.move('up')) {
          hideControls();
          return true;
        }
        break;
      case 'down':
        // Below the buttons there is nothing: ▼ hides the controls.
        if (!focus.move('down')) {
          hideControls();
          return true;
        }
        break;
      case 'enter':
        if (onProgress) togglePlay();
        else focus.activate();
        break;
      case 'back':
        hideControls();
        return true;
      default:
        return onCommonKey(action);
    }
    showOverlay(); // restarts the auto-hide timer
    return true;
  }

  function onWatchKey(action) {
    switch (action) {
      case 'enter':
        togglePlay();
        showOverlay();
        return true;
      case 'left':
        scrubStep(-1);
        return true;
      case 'right':
        scrubStep(1);
        return true;
      case 'down':
        // Paused with the controls up: ▼ hides them, so the frame can be seen in full.
        if (video.paused && controlsVisible()) hideControls();
        else openBar('player-play');
        return true;
      case 'up':
        openBar('player-progress');
        return true;
      case 'back':
        // The first Back hides the controls, the next one leaves the player.
        if (controlsVisible()) hideControls();
        else router.back();
        return true;
      default:
        return onCommonKey(action) || true;
    }
  }

  // --- screen lifecycle ----------------------------------------------------

  return {
    mount(el) {
      root = el;
      root.innerHTML = `
        <div class="player controls-visible">
          <video class="player-video" preload="auto"></video>
          <div class="subtitles"></div>
          <div class="player-spinner is-visible"><div class="spinner"></div></div>
          <div class="player-overlay is-visible">
            <div class="player-top">
              <h1 class="player-title"></h1>
            </div>
            <div class="player-bottom">
              <div class="player-seek">
                <div class="seek-preview">
                  <div class="seek-thumb">
                    <div class="seek-sheet"></div>
                    <img class="seek-frame" alt="">
                  </div>
                  <div class="seek-label"><span class="seek-time"></span><span class="seek-delta"></span></div>
                </div>
              </div>
              <div class="player-progress" data-focusable data-focus-id="player-progress">
                <div class="player-progress-track">
                  <div class="player-progress-buffer"></div>
                  <div class="player-progress-fill"></div>
                  <div class="player-progress-credits"></div>
                </div>
                <div class="player-progress-knob"></div>
              </div>
              <div class="player-controls" data-focus-group="player-controls">
                <button class="player-btn player-btn-play" data-focusable data-focus-id="player-play">${ICON_PLAY}</button>
                <span class="player-time"><span class="player-current">0:00</span> / <span class="player-duration">--:--</span></span>
                <span class="player-ends"></span>
                <span class="player-controls-spacer"></span>
                <button class="player-btn player-btn-next" data-focusable data-focus-id="player-next" style="display: none">
                  ${ICON_NEXT}<span class="player-btn-label">${t.nextEpisode}</span>
                </button>
                <button class="player-btn player-btn-subs" data-focusable data-focus-id="player-subs">
                  ${ICON_SUBTITLES}<span class="player-btn-label">${t.playerSubtitles}</span>
                </button>
              </div>
            </div>
          </div>
          <div class="player-warning"></div>
          <div class="player-indicator"></div>
          <div class="next-card"></div>
          <div class="pause-screen">
            <div class="pause-screen-body">
              <p class="pause-screen-label">${t.pauseWatching}</p>
              <h1 class="pause-screen-title"></h1>
              <p class="pause-screen-meta"></p>
              <p class="pause-screen-overview"></p>
            </div>
            <p class="pause-screen-paused">${t.pausePaused}</p>
          </div>
          <div class="player-error">
            <h2 class="player-error-title">${t.playerErrorTitle}</h2>
            <p class="player-error-text"></p>
            <div class="button-row">
              <button class="btn btn-primary" data-focusable data-focus-id="error-back">${t.back}</button>
            </div>
          </div>
        </div>`;

      playerEl = root.querySelector('.player');
      video = root.querySelector('video');
      overlay = root.querySelector('.player-overlay');
      progressEl = root.querySelector('.player-progress');
      progressFill = root.querySelector('.player-progress-fill');
      progressBuffer = root.querySelector('.player-progress-buffer');
      progressKnob = root.querySelector('.player-progress-knob');
      creditsMark = root.querySelector('.player-progress-credits');
      currentTimeEl = root.querySelector('.player-current');
      durationEl = root.querySelector('.player-duration');
      endsAtEl = root.querySelector('.player-ends');
      playButton = root.querySelector('.player-btn-play');
      nextButton = root.querySelector('.player-btn-next');
      subtitlesButton = root.querySelector('.player-btn-subs');
      spinner = root.querySelector('.player-spinner');
      errorPanel = root.querySelector('.player-error');
      warningEl = root.querySelector('.player-warning');
      indicatorEl = root.querySelector('.player-indicator');
      nextCardEl = root.querySelector('.next-card');
      pauseScreenEl = root.querySelector('.pause-screen');
      renderer = createSubtitleRenderer(root.querySelector('.subtitles'));
      preview = createSeekPreview(root.querySelector('.seek-preview'), params.id);

      nextCardEl.addEventListener('click', playNext);
      errorPanel.querySelector('button').addEventListener('click', () => router.back());
      video.addEventListener('click', () => !failed && (togglePlay(), showOverlay()));
      playButton.addEventListener('click', () => (togglePlay(), showOverlay()));
      nextButton.addEventListener('click', playNext);
      subtitlesButton.addEventListener('click', openPanel);
      progressEl.addEventListener('click', seekToPointer);
      // A moving pointer (Magic Remote, mouse) brings the controls up.
      playerEl.addEventListener('mousemove', () => {
        if (failed || panel || scrub) return;
        hidePauseScreen();
        schedulePauseScreen();
        openBar(null);
      });

      video.addEventListener('loadedmetadata', () => {
        updateProgress();
        begin();
      });
      video.addEventListener('durationchange', updateProgress);
      video.addEventListener('timeupdate', () => {
        if (!scrub) updateProgress();
        // Also covers the time while animation frames are paused (e.g. a hidden page).
        renderer.update(video.currentTime);
        updateNextCard();
      });
      video.addEventListener('progress', updateProgress);
      video.addEventListener('waiting', () => setLoading(true));
      video.addEventListener('playing', () => {
        setLoading(false);
        startSubtitleLoop();
      });
      video.addEventListener('canplay', () => setLoading(false));
      video.addEventListener('play', () => {
        clearTimeout(pauseScreenTimer);
        hidePauseScreen();
        updatePlayButton();
        showOverlay();
      });
      video.addEventListener('pause', () => {
        // However it was paused: OK, the Pause key, the button or the pointer.
        schedulePauseScreen();
        reportProgress();
        updatePlayButton();
        showOverlay();
        stopSubtitleLoop();
        renderer.update(video.currentTime);
      });
      video.addEventListener('seeking', () => setLoading(true));
      video.addEventListener('seeked', () => {
        seekTarget = null;
        setLoading(false);
        updateProgress();
        renderer.update(video.currentTime);
      });
      video.addEventListener('ended', () => {
        reportProgress();
        if (next && !nextDismissed) playNext();
        else router.back();
      });
      video.addEventListener('error', handleVideoError);
      document.addEventListener('visibilitychange', onVisibilityChange);

      // Title, saved position, "may not be supported" warning, subtitle tracks and the next
      // episode. Playback waits for this only when no explicit start position was given.
      api.getMedia(params.id).then(
        (loaded) => {
          if (!alive) return;
          media = loaded;
          if (startAt === undefined) startAt = media.progress ? media.progress.resumeAt : 0;
          begin();
          if (media.type === 'episode') {
            api.getNextEpisode(params.id).then((episode) => {
              if (!alive || !episode) return;
              next = episode;
              showNextButton();
            }, () => {});
          }
          root.querySelector('.player-title').textContent = playerTitle(media);
          renderPauseScreen();
          const warning = formatWarnings(media.compatibility);
          if (warning) {
            warningEl.textContent = warning;
            warningEl.classList.add('is-visible');
            warningTimer = setTimeout(() => warningEl.classList.remove('is-visible'), WARNING_VISIBLE_MS);
          }
          subtitles = media.subtitles || [];
          selectDefaultSubtitle();
          updateProgress();
        },
        () => {
          // Without details (no saved position known), just start from the beginning.
          if (startAt === undefined) startAt = 0;
          begin();
        }
      );
      loadSubtitleSetup();

      progressTimer = setInterval(() => {
        if (!video.paused) reportProgress();
      }, PROGRESS_INTERVAL_MS);

      try {
        // Playback starts in begin(), once the start position is known.
        video.src = api.streamUrl(params.id);
      } catch (e) {
        showError(t.playerErrorNetwork);
      }
    },

    unmount() {
      reportProgress();
      alive = false;
      if (panel) panel.close();
      clearInterval(progressTimer);
      clearInterval(countdownTimer);
      clearTimeout(hideTimer);
      clearTimeout(scrubTimer);
      clearTimeout(pauseScreenTimer);
      clearTimeout(warningTimer);
      clearTimeout(indicatorTimer);
      stopSubtitleLoop();
      preview.destroy();
      // Don't lose an offset change made just before leaving.
      if (offsetSaveTimer) {
        clearTimeout(offsetSaveTimer);
        saveOffset();
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // Release the hardware decoder and stop the HTTP stream right away.
      video.pause();
      video.removeAttribute('src');
      video.load();
    },

    onKey(action) {
      if (action === 'stop') {
        router.back();
        return true;
      }
      // In the error state the default navigation handles the "Back" button.
      if (failed) {
        if (action === 'back') router.back();
        return action === 'back';
      }
      if (pauseScreenVisible) {
        // Any key brings the controls back; OK / Play also resume (the keys go on below).
        hidePauseScreen();
        schedulePauseScreen();
        if (action !== 'enter' && action !== 'play' && action !== 'playpause') {
          showOverlay();
          return true;
        }
      } else if (pauseScreenTimer) {
        schedulePauseScreen(); // any press restarts the wait
      }
      if (scrub) return onScrubKey(action);
      if (nextVisible && !barOpen) {
        if (action === 'enter') {
          playNext();
          return true;
        }
        if (action === 'back') {
          cancelNext();
          return true;
        }
      }
      if (barOpen) return onBarKey(action);
      return onWatchKey(action);
    },
  };
}
