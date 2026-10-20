// The "Добави" tab: drop video files/folders (or pick them), check the proposed names and
// places, then copy or move them into the library. The server does the work
// (/api/admin/import/*, server/src/services/importer.js); this file is the list and its edits.
// Loaded before app.js, which calls setUpImport().
// eslint-disable-next-line no-unused-vars
function setUpImport(api, text, { getView, showTab, matchDialog }) {
  const POLL_MS = 500;
  const $ = (id) => document.getElementById(id);
  const format = (key, values) => text(key).replace(/\{(\w+)\}/g, (m, name) => (name in values ? values[name] : m));

  let items = []; // as the server resolved them, plus the user's edits
  let roots = { movie: [], episode: [], video: [] };
  const cards = new Map(); // item id -> card
  let nextId = 1;
  let running = false;
  let pollTimer = null;

  // --- helpers -----------------------------------------------------------------------

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  }

  const baseName = (p) => p.split(/[\\/]/).pop();
  const withYear = (title, year) => (year ? `${title} (${year})` : title);

  function formatSize(bytes) {
    const gb = bytes / 1024 ** 3;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${bytes ? Math.max(1, Math.round(bytes / 1024 ** 2)) : 0} MB`; // a small file isn't "0 MB"
  }

  /** Same rule as nameFromMatch in server/src/services/importer.js: Latin original titles are kept. */
  function nameFromMatch(match) {
    const original = match.originalTitle;
    return original && /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]+$/u.test(original) ? original : match.title;
  }

  const importable = (item) => !item.error && !item.exists;

  function relativeTarget(item) {
    if (!item.target) return '';
    const root = item.root || '';
    return item.target.startsWith(root) ? item.target.slice(root.length).replace(/^[\\/]/, '') : item.target;
  }

  // --- adding files ----------------------------------------------------------------------

  async function add(paths) {
    if (running || !paths.length) return;
    showTab('import');
    setEmptyMessage(text('import.analyzing'));
    setMessage(text('import.analyzing'));
    const res = await api.request('POST', '/api/admin/import/plan', { paths });
    if (res.status === 0) {
      setEmptyMessage(text('library.offline'), 'error');
      setMessage(text('library.offline'));
      return;
    }
    if (!res.ok) {
      setEmptyMessage((res.body && res.body.error) || String(res.status), 'error');
      return;
    }
    roots = res.body.roots;
    const known = new Set(items.map((i) => i.source.toLowerCase()));
    for (const item of res.body.items) {
      if (known.has(item.source.toLowerCase())) continue;
      item.id = nextId++;
      items.push(item);
    }
    const notes = [];
    if (res.body.ignored) notes.push(format('import.ignored', { count: res.body.ignored }));
    if (!res.body.items.length) notes.push(text('import.noVideos'));
    setEmptyMessage(notes.join(' '));
    setMessage(notes.join(' '));
    renderList();
  }

  function setEmptyMessage(message, kind = '') {
    $('import-empty-message').textContent = message;
    $('import-empty-message').dataset.kind = kind;
  }

  function setMessage(message) {
    $('import-message').textContent = message;
  }

  // Dropping files anywhere in the window adds them.
  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    dragDepth++;
    $('drop-overlay').hidden = running;
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-overlay').hidden = true;
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault(); // never let Chromium open the file in the window
    dragDepth = 0;
    $('drop-overlay').hidden = true;
    const paths = [...event.dataTransfer.files].map((file) => api.pathOf(file)).filter(Boolean);
    add(paths);
  });

  $('import-files').addEventListener('click', async () => add(await api.pickImport('files')));
  $('import-folder').addEventListener('click', async () => add(await api.pickImport('folder')));
  $('import-add-more').addEventListener('click', async () => add(await api.pickImport('files')));

  // --- the list -------------------------------------------------------------------------

  function renderList() {
    $('import-empty').hidden = items.length > 0;
    $('import-view').hidden = items.length === 0;
    const list = $('import-list');
    for (const [id, card] of cards) {
      if (!items.some((i) => i.id === id)) {
        card.node.remove();
        cards.delete(id);
      }
    }
    for (const item of items) {
      if (!cards.has(item.id)) {
        const card = createCard(item);
        cards.set(item.id, card);
        list.append(card.node);
      }
      cards.get(item.id).update(item, { fields: true });
    }
    renderSummary();
  }

  function renderSummary() {
    const ready = items.filter(importable);
    const bytes = ready.reduce((sum, item) => sum + (item.size || 0), 0);
    $('import-summary').textContent = format('import.summary', { count: ready.length, size: formatSize(bytes) });
    $('import-start').disabled = running || !ready.length;
  }

  function createCard(item) {
    const node = el('li', 'import-item');

    // Header: poster of the match, the file and where it goes.
    const head = el('div', 'import-head');
    const thumb = el('img', 'thumb');
    thumb.alt = '';
    const paths = el('div', 'item-info');
    const source = el('div', 'item-path');
    const target = el('div', 'import-target');
    paths.append(source, target);
    const status = el('span', 'import-status');
    const remove = el('button', 'link remove', '✕');
    remove.type = 'button';
    remove.title = text('import.remove');
    remove.addEventListener('click', () => {
      items = items.filter((i) => i.id !== item.id);
      renderList();
    });
    head.append(thumb, paths, status, remove);

    // Fields.
    const fields = el('div', 'import-fields');
    const kind = el('select', 'kind-select');
    for (const value of ['movie', 'episode', 'video']) {
      const option = el('option', '', text(`import.kinds.${value}`));
      option.value = value;
      kind.append(option);
    }
    const input = (name, type, className) => {
      const label = el('label', `field ${className || ''}`);
      const caption = el('span', '', text(`import.fields.${name}`));
      const control = el('input');
      control.type = type;
      control.spellcheck = false;
      label.append(caption, control);
      return { label, control, caption };
    };
    const title = input('title', 'text', 'grow');
    const year = input('year', 'number', 'small');
    const season = input('season', 'number', 'small');
    const episode = input('episode', 'number', 'small');
    const category = input('category', 'text', 'grow');
    const rootLabel = el('label', 'field');
    rootLabel.append(el('span', '', text('import.fields.root')));
    const root = el('select');
    rootLabel.append(root);
    const kindLabel = el('label', 'field');
    kindLabel.append(el('span', '', ' '), kind);
    fields.append(kindLabel, title.label, year.label, season.label, episode.label, category.label, rootLabel);

    // TMDB match and subtitles.
    const meta = el('div', 'import-meta');
    const matchText = el('span');
    const matchChange = el('button', 'link');
    matchChange.type = 'button';
    const matchClear = el('button', 'link', text('import.tmdbClear'));
    matchClear.type = 'button';
    const matchLine = el('span', 'import-match');
    matchLine.append(matchText, matchChange, matchClear);
    const subtitles = el('span', 'hint');
    meta.append(matchLine, subtitles);

    const warning = el('div', 'import-warning');
    node.append(head, fields, meta, warning);

    // Edits.
    const edit = (change) => {
      const current = items.find((i) => i.id === item.id);
      change(current);
      scheduleResolve(current);
      update(current);
    };
    kind.addEventListener('change', () => {
      edit((i) => {
        i.kind = kind.value;
        // A video's title is its file name ("Rila 2024"), not a parsed movie title ("Rila").
        if (i.kind === 'video') i.title = baseName(i.source).replace(/\.[^.]+$/, '');
      });
      title.control.value = items.find((i) => i.id === item.id).title;
    });
    title.control.addEventListener('input', () => edit((i) => (i.title = title.control.value)));
    year.control.addEventListener('input', () => edit((i) => (i.year = year.control.value)));
    season.control.addEventListener('input', () => edit((i) => (i.season = season.control.value)));
    episode.control.addEventListener('input', () => edit((i) => (i.episode = episode.control.value)));
    category.control.addEventListener('input', () => edit((i) => (i.category = category.control.value)));
    root.addEventListener('change', () => edit((i) => (i.root = root.value)));
    matchClear.addEventListener('click', () => edit((i) => (i.match = null)));
    matchChange.addEventListener('click', () => {
      const current = items.find((i) => i.id === item.id);
      openMatch(current);
    });

    function update(current, { fields: refreshFields = false } = {}) {
      item = current;
      source.textContent = `${baseName(current.source)} · ${formatSize(current.size || 0)}`;
      source.title = current.source;
      target.textContent = current.target ? `→ ${relativeTarget(current)}` : '';

      if (current.match && current.match.poster) {
        thumb.src = current.match.poster;
        thumb.classList.remove('empty');
      } else {
        thumb.removeAttribute('src');
        thumb.classList.add('empty');
      }

      if (refreshFields) {
        kind.value = current.kind;
        title.control.value = current.title || '';
        year.control.value = current.year || '';
        season.control.value = current.season ?? '';
        episode.control.value = current.episode ?? '';
        category.control.value = current.category || '';
      }
      title.caption.textContent = text(current.kind === 'episode' ? 'import.fields.show' : 'import.fields.title');
      year.label.hidden = current.kind !== 'movie';
      season.label.hidden = episode.label.hidden = current.kind !== 'episode';
      category.label.hidden = current.kind !== 'video';

      const options = roots[current.kind] || [];
      root.replaceChildren(
        ...options.map((r) => {
          const option = el('option', '', r);
          option.value = r;
          return option;
        })
      );
      root.value = current.root || options[0] || '';
      rootLabel.hidden = options.length < 2 || current.existingShow;

      matchLine.hidden = current.kind === 'video';
      if (current.match) {
        matchText.textContent = format('import.tmdbMatch', { title: withYear(current.match.title, current.match.year) });
        matchChange.textContent = text('import.tmdbChange');
      } else {
        matchText.textContent = text('import.tmdbNone');
        matchChange.textContent = text('import.tmdbFind');
      }
      matchClear.hidden = !current.match;

      const languages = (current.subtitles || []).map((s) => s.language || text('import.subtitleUnknown'));
      subtitles.textContent = languages.length ? format('import.subtitles', { list: languages.join(', ') }) : '';

      const notes = [];
      if (current.error) notes.push(['error', text(`import.errors.${current.error}`)]);
      else if (current.exists) notes.push(['warn', text('import.exists')]);
      if (current.existingShow && !current.error) notes.push(['info', text('import.existingShow')]);
      warning.replaceChildren(...notes.map(([kindName, message]) => el('div', `note note-${kindName}`, message)));

      node.classList.toggle('skipped', !importable(current));
    }

    /** The import progress of this file: { status, reason } from the server, or null. */
    function setStatus(state) {
      status.dataset.status = state ? state.status : '';
      if (!state) {
        status.textContent = '';
        return;
      }
      // Known reasons have a text; others are error codes (EACCES, ENOSPC...) shown as they are.
      const reasonKey = `import.reasons.${state.reason}`;
      const reason = state.reason && (text(reasonKey) !== reasonKey ? text(reasonKey) : state.reason);
      status.textContent = text(`import.status.${state.status}`) + (reason ? ` (${reason})` : '');
    }

    return { node, update, setStatus };
  }

  // --- resolving edits on the server ----------------------------------------------------------

  const resolveTimers = new Map();

  function scheduleResolve(item) {
    clearTimeout(resolveTimers.get(item.id));
    resolveTimers.set(item.id, setTimeout(() => resolve([item]), 250));
    renderSummary();
  }

  async function resolve(changed) {
    const res = await api.request('POST', '/api/admin/import/resolve', { items: changed });
    if (!res.ok) return;
    roots = res.body.roots;
    for (const resolved of res.body.items) {
      const index = items.findIndex((i) => i.id === resolved.id);
      if (index === -1) continue;
      // Keep what the user is typing (the server trims it); take everything the server worked out.
      const typed = items[index];
      items[index] = { ...resolved, title: typed.title, year: typed.year, season: typed.season, episode: typed.episode, category: typed.category };
      cards.get(resolved.id)?.update(items[index]);
    }
    renderSummary();
  }

  // --- TMDB match ---------------------------------------------------------------------------

  /** Picking a match renames the item - and every other episode of the same show. */
  function openMatch(item) {
    const kind = item.kind === 'episode' ? 'series' : 'movie';
    const tmdbId = item.match && item.match.tmdbId;
    matchDialog.open({ kind, title: item.title, year: item.kind === 'movie' ? item.year : null, tmdbId }, async (result) => {
      const oldTitle = item.title;
      const changed = items.filter((i) => i.id === item.id || (item.kind === 'episode' && i.kind === 'episode' && i.title === oldTitle));
      for (const i of changed) {
        i.match = result;
        i.title = nameFromMatch(result);
        if (i.kind === 'movie' && result.year) i.year = result.year;
        cards.get(i.id)?.update(i, { fields: true });
      }
      await resolve(changed);
      return null;
    });
  }

  // --- running ------------------------------------------------------------------------------

  function mode() {
    return document.querySelector('input[name="import-mode"]:checked').value;
  }

  function setRunning(isRunning) {
    running = isRunning;
    $('import-list').classList.toggle('locked', isRunning);
    $('import-list').querySelectorAll('input, select, button').forEach((control) => (control.disabled = isRunning));
    document.querySelectorAll('input[name="import-mode"]').forEach((radio) => (radio.disabled = isRunning));
    $('import-start').hidden = isRunning;
    $('import-cancel').hidden = !isRunning;
    $('import-clear').disabled = isRunning;
    $('import-add-more').disabled = isRunning;
    $('import-progress').hidden = !isRunning;
    renderSummary();
  }

  $('import-start').addEventListener('click', async () => {
    const res = await api.request('POST', '/api/admin/import/start', { items: items.filter(importable), mode: mode() });
    if (!res.ok) {
      setMessage((res.body && res.body.error) || text('library.offline'));
      return;
    }
    for (const card of cards.values()) card.setStatus(null);
    setRunning(true);
    follow(res.body);
  });

  $('import-cancel').addEventListener('click', () => api.request('POST', '/api/admin/import/cancel'));

  function follow(job) {
    for (const state of job.items) cards.get(state.id)?.setStatus(state);
    const percent = job.totalBytes ? Math.floor((job.doneBytes / job.totalBytes) * 100) : 100;
    $('import-progress-fill').style.transform = `scaleX(${percent / 100})`;
    const doneCount = job.items.filter((i) => ['done', 'skipped', 'error'].includes(i.status)).length;
    const current = job.items.find((i) => i.id === job.current);
    $('import-progress-text').textContent =
      format('import.progress', { done: doneCount, total: job.items.length, percent }) +
      (current ? ` · ${format('import.working', { name: baseName(current.source) })}` : '');

    if (job.running) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(async () => {
        const res = await api.request('GET', '/api/admin/import/status');
        if (res.ok) follow(res.body);
        else setRunning(false);
      }, POLL_MS);
      return;
    }

    setRunning(false);
    const count = (status) => job.items.filter((i) => i.status === status).length;
    setMessage(format('import.finished', { done: count('done'), skipped: count('skipped'), errors: count('error') }));
    // What was imported is gone from the list; skipped and failed files stay to be fixed.
    const finished = new Set(job.items.filter((i) => i.status === 'done').map((i) => i.id));
    items = items.filter((i) => !finished.has(i.id));
    renderList();
    for (const state of job.items) cards.get(state.id)?.setStatus(state);
    if (!items.length) {
      $('import-empty').hidden = false;
      setEmptyMessage(format('import.finished', { done: count('done'), skipped: count('skipped'), errors: count('error') }), 'ok');
    }
  }

  $('import-clear').addEventListener('click', () => {
    items = [];
    setMessage('');
    setEmptyMessage('');
    renderList();
  });

  return {
    /** The server restarted (new settings): the library folders may have changed. */
    serverChanged() {
      if (items.length && getView().status === 'running') resolve(items);
    },
  };
}
