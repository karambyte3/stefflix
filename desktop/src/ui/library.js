// The "Библиотека" tab: counts, problems (no TMDB match, files the TV may not play, missing
// files), every movie and series, and the dialog that fixes a TMDB match.
// The TMDB search dialog is matchDialog.js. Data comes from the server's /api/admin/library through the main process (api.request).
// Loaded before app.js, which calls setUpLibrary().
// eslint-disable-next-line no-unused-vars
function setUpLibrary(api, text, { getView, openSettings, matchDialog }) {
  const MAX_TITLES = 300;
  const POLL_MS = 3000;
  const $ = (id) => document.getElementById(id);

  let report = null;
  let visible = false;
  let pollTimer = null;

  const format = (key, values) => text(key).replace(/\{(\w+)\}/g, (m, name) => (name in values ? values[name] : m));

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  }

  function button(label, onClick, className) {
    const node = el('button', className || '', label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function imageUrl(src) {
    if (!src) return null;
    if (/^https?:/.test(src)) return src;
    const { serverUrl } = getView();
    return serverUrl ? serverUrl + src : null;
  }

  function poster(src, className = 'thumb') {
    const url = imageUrl(src);
    if (!url) return el('span', `${className} empty`);
    const img = el('img', className);
    img.loading = 'lazy';
    img.alt = '';
    img.src = url;
    return img;
  }

  const withYear = (title, year) => (year ? `${title} (${year})` : title);

  // --- data ----------------------------------------------------------------------

  async function load() {
    const res = await api.request('GET', '/api/admin/library');
    const online = res.status !== 0;
    $('library-offline').hidden = online;
    $('library-content').hidden = !online;
    if (!res.ok) return;
    report = res.body;
    render();

    // While a scan or the TMDB matching runs the numbers change - follow them.
    clearTimeout(pollTimer);
    const busy = report.scan.scanning || report.scan.metadata.running;
    if (busy && visible) pollTimer = setTimeout(load, POLL_MS);
  }

  function render() {
    renderStats();
    renderUnmatched();
    renderIncompatible();
    renderMissing();
    renderTitles();
  }

  // --- stats -------------------------------------------------------------------------

  function renderStats() {
    const { counts, scan } = report;
    const tile = (value, label, sub) => {
      const node = el('div', 'stat');
      node.append(el('span', 'stat-value', value), el('span', 'stat-label', label));
      if (sub) node.append(el('span', 'stat-sub', sub));
      return node;
    };
    $('library-stats').replaceChildren(
      tile(counts.movies, text('library.stats.movies')),
      tile(counts.series, text('library.stats.series'), format('library.stats.episodes', { count: counts.episodes })),
      tile(counts.videos, text('library.stats.videos')),
      tile(formatSize(counts.totalBytes), text('library.stats.size'))
    );

    const parts = [];
    if (scan.scanning) parts.push(text('library.scanning'));
    else if (scan.lastScan && scan.lastScan.finishedAt) {
      parts.push(format('library.lastScan', { time: timeAgo(scan.lastScan.finishedAt) }));
    }
    if (scan.metadata.running) parts.push(format('library.tmdbProgress', scan.metadata));
    if (scan.metadata.error) parts.push(text('library.tmdbError'));
    $('library-scan').textContent = parts.join(' · ');
  }

  function formatSize(bytes) {
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(gb >= 100 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  function timeAgo(time) {
    const rtf = new Intl.RelativeTimeFormat('bg', { numeric: 'auto' });
    const minutes = Math.round((time - Date.now()) / 60000);
    if (minutes > -60) return rtf.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    return hours > -24 ? rtf.format(hours, 'hour') : rtf.format(Math.round(hours / 24), 'day');
  }

  // --- problems ------------------------------------------------------------------

  /** A movie or series row: poster, title, file, source badge and actions. */
  function titleRow(item) {
    const row = el('li', 'item');
    row.append(poster(item.poster));

    const info = el('div', 'item-info');
    const name = el('div', 'item-title', withYear(item.title, item.year));
    const kind = el('span', 'kind', text(`library.kind.${item.kind}`));
    name.prepend(kind);
    info.append(name);
    if (item.originalTitle && item.originalTitle !== item.title) info.append(el('div', 'item-sub', item.originalTitle));
    if (item.path) info.append(el('div', 'item-path', item.path));
    row.append(info);

    row.append(el('span', `source source-${item.source}`, text(`library.source.${item.source}`)));
    const actions = el('div', 'item-actions');
    if (item.path) actions.append(button(text('library.showFile'), () => api.showFile(item.path), 'link'));
    if (report.scan.metadata.configured) {
      const label = item.source === 'filename' ? 'library.findInTmdb' : 'library.changeMatch';
      actions.append(button(text(label), () => openMatch(item)));
    }
    row.append(actions);
    return row;
  }

  /** A file row: name, path and (for codec problems) the reasons. */
  function fileRow(item, chips) {
    const row = el('li', 'item');
    const info = el('div', 'item-info');
    info.append(el('div', 'item-title', item.title), el('div', 'item-path', item.path));
    if (chips && chips.length) {
      const list = el('div', 'chips');
      for (const chip of chips) list.append(el('span', 'chip', chip));
      info.append(list);
    }
    row.append(info);
    return row;
  }

  function renderUnmatched() {
    const unmatched = report.titles.filter((t) => t.source === 'filename');
    const configured = report.scan.metadata.configured;
    $('unmatched-card').hidden = !unmatched.length;
    $('unmatched-count').textContent = unmatched.length;
    $('no-tmdb-key').hidden = configured;
    $('unmatched-list').replaceChildren(...unmatched.slice(0, MAX_TITLES).map(titleRow));
  }

  function renderIncompatible() {
    const { incompatible, counts, ffprobe } = report;
    $('incompatible-card').hidden = !incompatible.length;
    $('incompatible-count').textContent = incompatible.length;
    $('incompatible-list').replaceChildren(
      ...incompatible.map((item) => {
        const chips = item.warnings.map((w) => format(`library.warning.${w.code}`, { value: w.value }));
        const row = fileRow(item, chips);
        row.append(button(text('library.showFile'), () => api.showFile(item.path), 'link'));
        return row;
      })
    );

    const note = !ffprobe ? text('library.noFfprobe') : counts.unprobed ? format('library.unprobed', { count: counts.unprobed }) : '';
    $('probe-note').hidden = !note;
    $('probe-note').textContent = note;
  }

  function renderMissing() {
    const { missing, counts } = report;
    $('missing-card').hidden = !counts.missing;
    $('missing-count').textContent = counts.missing;
    const rows = missing.map((item) => fileRow(item));
    if (counts.missing > missing.length) {
      rows.push(el('li', 'item more', format('library.missingMore', { count: counts.missing - missing.length })));
    }
    $('missing-list').replaceChildren(...rows);
  }

  $('clean-up').addEventListener('click', async () => {
    if (!window.confirm(format('library.cleanUpConfirm', { count: report.counts.missing }))) return;
    $('clean-up').disabled = true;
    await api.request('POST', '/api/library/cleanup');
    $('clean-up').disabled = false;
    load();
  });

  $('add-tmdb-key').addEventListener('click', openSettings);

  // --- all titles ------------------------------------------------------------------

  function renderTitles() {
    const filter = $('title-filter').value.trim().toLowerCase();
    const matches = report.titles.filter(
      (t) => !filter || [t.title, t.originalTitle, t.path].some((v) => v && v.toLowerCase().includes(filter))
    );
    $('title-list').replaceChildren(...matches.slice(0, MAX_TITLES).map(titleRow));

    let note = '';
    if (!report.titles.length) note = text('library.empty');
    else if (!matches.length) note = text('library.nothingFound');
    else if (matches.length > MAX_TITLES) note = format('library.shownFirst', { count: MAX_TITLES });
    $('title-list-note').textContent = note;
  }

  $('title-filter').placeholder = text('library.filterPlaceholder');
  $('title-filter').addEventListener('input', () => report && renderTitles());

  // --- TMDB match ----------------------------------------------------------------------

  /** Fixes the match on the server right away. */
  function openMatch(item) {
    matchDialog.open(item, async (result) => {
      const url = item.kind === 'series' ? `/api/series/${item.id}/tmdb` : `/api/media/${item.id}/tmdb`;
      const res = await api.request('PUT', url, { tmdbId: result.tmdbId });
      if (!res.ok) return (res.body && res.body.error) || String(res.status);
      load();
      return null;
    });
  }

  return {
    /** The tab was opened or closed. */
    setVisible(isVisible) {
      visible = isVisible;
      if (visible) load();
      else clearTimeout(pollTimer);
    },
    /** The server state changed (e.g. it restarted): reload if the tab is open. */
    serverChanged() {
      if (visible) load();
    },
  };
}
