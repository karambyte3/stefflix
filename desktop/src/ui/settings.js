// The "Настройки" tab: edits a draft of the server settings; "Запази" sends it to the main
// process, which writes config.json and restarts the server when needed.
// Loaded before app.js, which calls setUpSettings().
// eslint-disable-next-line no-unused-vars
function setUpSettings(api, text) {
  const MEDIA_TYPES = ['movies', 'series', 'videos'];
  const $ = (id) => document.getElementById(id);

  let saved = null; // the settings the server runs with
  let draft = null; // what the form shows
  let folderStatus = {};
  let message = null; // { key, kind } shown in the save bar until the next change

  const copy = (value) => JSON.parse(JSON.stringify(value));
  const isDirty = () => JSON.stringify(draft) !== JSON.stringify(saved);

  // --- folders -----------------------------------------------------------------

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function renderFolders() {
    const groups = $('folder-groups');
    groups.replaceChildren();

    for (const type of MEDIA_TYPES) {
      const group = el('div', 'folder-group');
      const head = el('div', 'folder-group-head');
      head.append(el('h3', '', text(`settings.types.${type}`)), el('span', 'pattern', text(`settings.typeHints.${type}`)));

      const list = el('ul', 'folder-list');
      if (!draft.folders[type].length) list.append(el('li', 'folder empty', text('settings.noFolders')));
      draft.folders[type].forEach((folder, index) => {
        const item = el('li', 'folder');
        item.append(el('span', 'folder-path', folder));
        if (folderStatus[folder] === false) item.append(el('span', 'badge', text('settings.missing')));
        const remove = el('button', 'link', text('settings.remove'));
        remove.type = 'button';
        remove.addEventListener('click', () => {
          draft.folders[type].splice(index, 1);
          changed();
        });
        item.append(remove);
        list.append(item);
      });

      const add = el('button', 'add-folder', text('settings.addFolder'));
      add.type = 'button';
      add.addEventListener('click', async () => {
        const result = await api.pickFolders();
        Object.assign(folderStatus, result.folderStatus);
        const known = new Set(draft.folders[type].map((f) => f.toLowerCase()));
        for (const folder of result.folders) {
          if (!known.has(folder.toLowerCase())) draft.folders[type].push(folder);
        }
        if (result.folders.length) changed();
      });

      group.append(head, list, add);
      groups.append(group);
    }
  }

  // --- form fields ---------------------------------------------------------------

  // [element id, read from draft, write to draft]
  const fields = [
    ['tmdb-key', (d) => d.tmdbApiKey, (d, v) => (d.tmdbApiKey = v)],
    ['port', (d) => d.port, (d, v) => (d.port = v === '' ? '' : Number(v))],
    ['watch-folders', (d) => d.watchFolders, (d, v) => (d.watchFolders = v)],
    ['ffprobe-path', (d) => d.ffprobePath, (d, v) => (d.ffprobePath = v)],
    ['storyboards-all', (d) => d.storyboardsForAll, (d, v) => (d.storyboardsForAll = v)],
    ['os-api-key', (d) => d.openSubtitles.apiKey, (d, v) => (d.openSubtitles.apiKey = v)],
    ['os-username', (d) => d.openSubtitles.username, (d, v) => (d.openSubtitles.username = v)],
    ['os-password', (d) => d.openSubtitles.password, (d, v) => (d.openSubtitles.password = v)],
  ];

  function renderFields() {
    for (const [id, read] of fields) {
      const input = $(id);
      if (input.type === 'checkbox') input.checked = read(draft);
      else input.value = read(draft);
    }
  }

  for (const [id, , write] of fields) {
    const input = $(id);
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
      write(draft, input.type === 'checkbox' ? input.checked : input.value);
      if (id === 'ffprobe-path') scheduleFfprobeCheck();
      if (id === 'tmdb-key') $('tmdb-result').textContent = '';
      changed(false);
    });
  }

  // --- save bar ------------------------------------------------------------------

  function renderSaveBar() {
    const dirty = isDirty();
    $('settings-save').disabled = !dirty;
    $('settings-cancel').disabled = !dirty;
    const bar = $('save-message');
    if (message) {
      bar.textContent = text(message.key);
      bar.dataset.kind = message.kind;
    } else {
      bar.textContent = dirty ? text('settings.unsaved') : '';
      bar.dataset.kind = '';
    }
  }

  /** After any edit. `rerenderFields` is false while typing, so the caret isn't disturbed. */
  function changed(rerenderFields = true) {
    message = null;
    renderFolders();
    if (rerenderFields) renderFields();
    renderSaveBar();
  }

  function load(result) {
    saved = result.settings;
    draft = copy(saved);
    folderStatus = result.folderStatus;
    renderFolders();
    renderFields();
    renderSaveBar();
    checkFfprobe();
  }

  $('settings-save').addEventListener('click', async () => {
    $('settings-save').disabled = true;
    const result = await api.saveSettings(draft);
    if (!result.ok) {
      message = { key: `settings.errors.${result.errors[0]}`, kind: 'error' };
      renderSaveBar();
      return;
    }
    load(result);
    message = { key: result.restarted ? 'settings.savedRestarted' : 'settings.saved', kind: 'ok' };
    renderSaveBar();
  });

  $('settings-cancel').addEventListener('click', () => {
    draft = copy(saved);
    changed();
    checkFfprobe();
  });

  // --- TMDB ----------------------------------------------------------------------

  $('tmdb-show').addEventListener('click', () => {
    const input = $('tmdb-key');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('tmdb-show').textContent = text(input.type === 'password' ? 'settings.show' : 'settings.hide');
  });

  $('tmdb-test').addEventListener('click', async () => {
    const result = $('tmdb-result');
    if (!draft.tmdbApiKey.trim()) return;
    result.textContent = text('settings.testing');
    result.dataset.kind = '';
    const outcome = await api.testTmdb(draft.tmdbApiKey);
    result.textContent = text(`settings.tmdbResult.${outcome}`);
    result.dataset.kind = outcome === 'ok' ? 'ok' : 'error';
  });

  $('tmdb-link').addEventListener('click', () => api.openLink('tmdb'));
  $('os-link').addEventListener('click', () => api.openLink('opensubtitles'));

  // --- ffprobe -------------------------------------------------------------------

  let ffprobeTimer = null;
  function scheduleFfprobeCheck() {
    clearTimeout(ffprobeTimer);
    ffprobeTimer = setTimeout(checkFfprobe, 500);
  }

  async function checkFfprobe() {
    const checkedPath = draft.ffprobePath;
    const result = await api.checkFfprobe(checkedPath);
    if (checkedPath !== draft.ffprobePath) return; // the path changed meanwhile
    const line = $('ffprobe-result');
    line.textContent = result.ok
      ? text('settings.ffprobeFound').replace('{version}', result.version)
      : text('settings.ffprobeMissing');
    line.dataset.kind = result.ok ? 'ok' : 'warn';
  }

  function setFfprobePath(value) {
    draft.ffprobePath = value;
    changed();
    checkFfprobe();
  }

  $('ffprobe-browse').addEventListener('click', async () => {
    const file = await api.pickFfprobe();
    if (file) setFfprobePath(file);
  });

  $('ffprobe-find').addEventListener('click', async () => {
    const file = await api.findFfprobe();
    if (file) {
      setFfprobePath(file);
    } else {
      $('ffprobe-result').textContent = text('settings.ffprobeNotOnPath');
      $('ffprobe-result').dataset.kind = 'warn';
    }
  });

  return {
    load: async () => load(await api.getSettings()),
  };
}
