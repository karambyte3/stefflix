// The "Subtitles" panel of the Settings screen: style options with a live preview.
import * as api from '../api.js';
import * as focus from '../focus.js';
import { select } from '../components/menu.js';
import { applySubtitleStyle, cueHtml } from '../components/subtitles.js';
import { t } from '../i18n/bg.js';

const PREFERRED_LANGUAGES = ['bg', 'en', 'ru', 'de', 'fr', 'es', 'it'];

const ROWS = [
  {
    key: 'size',
    label: t.settingSize,
    options: () => ['S', 'M', 'L', 'XL'].map((value) => ({ value, label: t.sizes[value] })),
  },
  { key: 'color', label: t.settingColor, options: () => t.colors },
  {
    key: 'background',
    label: t.settingBackground,
    options: () => ['none', 'semi', 'solid'].map((value) => ({ value, label: t.backgrounds[value] })),
  },
  { key: 'position', label: t.settingPosition, options: () => t.positions },
  {
    key: 'language',
    label: t.settingLanguage,
    options: () =>
      PREFERRED_LANGUAGES.map((value) => ({ value, label: t.languages[value] })).concat([{ value: 'off', label: t.subtitlesOff }]),
  },
];

function valueLabel(row, value) {
  const option = row.options().filter((o) => o.value === value)[0];
  if (option) return option.label;
  if (row.key === 'position') return `${value}%`;
  return value === undefined ? '…' : String(value);
}

export function subtitlePanelHtml() {
  return `
    <section class="panel subtitle-panel">
      <h2 class="panel-title">${t.subtitlesSection}</h2>
      <div class="setting-list" data-focus-group="subtitle-settings">
        ${ROWS.map(
          (row) => `
          <button class="setting-row" data-focusable data-focus-id="sub-${row.key}" data-setting="${row.key}">
            <span class="setting-name">${row.label}</span>
            <span class="setting-value">…</span>
          </button>`
        ).join('')}
      </div>
      <div class="subtitle-preview">
        <div class="subtitle-preview-stage">
          <div class="subtitles">${cueHtml(t.subtitlePreview)}</div>
        </div>
      </div>
      <p class="status subtitle-status"></p>
    </section>`;
}

/** Loads the settings into the panel and wires the rows. */
export function bindSubtitlePanel(root, isAlive) {
  const panel = root.querySelector('.subtitle-panel');
  const preview = panel.querySelector('.subtitles');
  const status = panel.querySelector('.subtitle-status');
  let settings = null;

  // Coming in from the left column lands on the first row, not the nearest one.
  focus.rememberInGroup('subtitle-settings', 'sub-' + ROWS[0].key);

  function render() {
    ROWS.forEach((row) => {
      panel.querySelector(`[data-setting="${row.key}"] .setting-value`).textContent = valueLabel(row, settings[row.key]);
    });
    applySubtitleStyle(preview, settings);
  }

  function choose(row) {
    if (!settings) return;
    select(row.label, row.options(), settings[row.key]).then((choice) => {
      if (!choice || choice.value === settings[row.key] || !isAlive()) return;
      api.updateSubtitleSettings({ [row.key]: choice.value }).then(
        (saved) => {
          if (!isAlive()) return;
          settings = saved;
          status.textContent = '';
          render();
        },
        () => isAlive() && (status.textContent = t.settingsSaveFailed)
      );
    });
  }

  panel.querySelector('.setting-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-setting]');
    if (button) choose(ROWS.filter((row) => row.key === button.getAttribute('data-setting'))[0]);
  });

  api.getSubtitleSettings().then(
    (loaded) => {
      if (!isAlive()) return;
      settings = loaded;
      render();
    },
    () => isAlive() && (status.textContent = t.serverUnreachable)
  );
}
