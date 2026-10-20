// The window: "Статус", "Библиотека" (library.js), "Добави" (import.js) and "Настройки" (settings.js) tabs.
// Everything that needs the system goes through window.stefflix (preload.cjs).
(function () {
  const api = window.stefflix;
  const MAX_LOG_LINES = 500;
  const TABS = ['status', 'library', 'import', 'settings'];
  let strings = null;
  let view = null;
  let library = null;
  let importer = null;

  const $ = (id) => document.getElementById(id);

  function text(key) {
    return key.split('.').reduce((obj, part) => (obj ? obj[part] : undefined), strings) ?? key;
  }

  function render(next) {
    const serverChanged = view && (view.status !== next.status || view.serverUrl !== next.serverUrl);
    view = next;
    if (serverChanged) {
      library?.serverChanged();
      importer?.serverChanged();
    }
    $('status').dataset.status = view.status;
    $('status-text').textContent = strings.status[view.status] || view.status;

    const address = $('tv-address');
    address.textContent = view.tvAddress || (view.status === 'running' ? text('window.noAddress') : '—');
    address.classList.toggle('empty', !view.tvAddress);
    $('copy').disabled = !view.tvAddress;

    $('other-addresses').textContent = view.otherAddresses.length
      ? `${text('window.otherAddresses')} ${view.otherAddresses.map((a) => `${a.address} (${a.name})`).join(', ')}`
      : '';

    const alert = view.status === 'port-in-use' ? 'window.portInUse' : view.status === 'crashed' ? 'window.crashed' : null;
    $('alert').hidden = !alert;
    $('alert').textContent = alert ? text(alert) : '';

    $('no-folders').hidden = view.hasFolders;

    $('scan').disabled = view.status !== 'running';
    $('autostart').checked = view.autostart;
  }

  function showTab(name) {
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === name);
    });
    for (const tab of TABS) $(`tab-${tab}`).hidden = name !== tab;
    library?.setVisible(name === 'library');
    // Lines that came in while the log was hidden couldn't scroll it.
    if (name === 'status') $('log').scrollTop = $('log').scrollHeight;
  }

  function appendLog(lines) {
    const log = $('log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.append(lines.join('\n') + '\n');
    log.normalize();
    // Keep the DOM small: only the last lines.
    const all = log.textContent.split('\n');
    if (all.length > MAX_LOG_LINES) log.textContent = all.slice(-MAX_LOG_LINES).join('\n');
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  /** Shows a short confirmation on a button, then its label again. */
  function flash(button, key) {
    button.textContent = text(key);
    setTimeout(() => (button.textContent = text(button.dataset.i18n)), 1500);
  }

  async function start() {
    const init = await api.init();
    strings = init.strings;

    document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = text(el.dataset.i18n)));
    render(init.view);
    appendLog(init.logs);
    showTab('status');

    const settings = setUpSettings(api, text);
    await settings.load();
    const matchDialog = setUpMatchDialog(api, text);
    library = setUpLibrary(api, text, { getView: () => view, openSettings: () => showTab('settings'), matchDialog });
    importer = setUpImport(api, text, { getView: () => view, showTab, matchDialog });
    document.querySelectorAll('.tab-button').forEach((button) => {
      button.addEventListener('click', () => showTab(button.dataset.tab));
    });
    $('go-to-settings').addEventListener('click', () => showTab('settings'));
    $('log').scrollTop = $('log').scrollHeight;

    api.onView(render);
    api.onLog(appendLog);

    $('copy').addEventListener('click', async () => {
      await api.copyAddress();
      flash($('copy'), 'window.copied');
    });
    $('scan').addEventListener('click', async () => {
      if (await api.scan()) flash($('scan'), 'window.scanStarted');
    });
    $('restart').addEventListener('click', () => api.restart());
    $('open-data-dir').addEventListener('click', () => api.openDataDir());
    $('open-log-file').addEventListener('click', () => api.openLogFile());
    $('autostart').addEventListener('change', (event) => api.setAutostart(event.target.checked));
  }

  start();
})();
