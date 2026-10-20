// The "Намери в TMDB" dialog, shared by the "Библиотека" tab (fixes a match on the server)
// and the "Добави" tab (picks the match of a file before it's imported).
// eslint-disable-next-line no-unused-vars
function setUpMatchDialog(api, text) {
  const $ = (id) => document.getElementById(id);
  const format = (key, values) => text(key).replace(/\{(\w+)\}/g, (m, name) => (name in values ? values[name] : m));

  let current = null; // { item, onChoose }

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  }

  const withYear = (title, year) => (year ? `${title} (${year})` : title);

  function setMessage(message, kind = '') {
    $('match-message').textContent = message;
    $('match-message').dataset.kind = kind;
  }

  /**
   * item: { kind: 'movie' | 'series', title, originalTitle, year, tmdbId }
   * onChoose(result): resolves to null when done (the dialog closes) or an error text.
   */
  function open(item, onChoose) {
    current = { item, onChoose };
    $('match-for').textContent = format('match.forItem', { title: withYear(item.title, item.year) });
    $('match-query').value = item.originalTitle || item.title || '';
    $('match-query').placeholder = text('match.query');
    $('match-year').value = item.year || '';
    $('match-year').placeholder = text('match.year');
    $('match-results').replaceChildren();
    setMessage('');
    $('match-dialog').hidden = false;
    $('match-query').select();
    search();
  }

  function close() {
    $('match-dialog').hidden = true;
    current = null;
  }

  async function search() {
    const query = $('match-query').value.trim();
    if (!query || !current) return;
    const opened = current;
    setMessage(text('match.searching'));
    const params = new URLSearchParams({ kind: opened.item.kind, query, year: $('match-year').value });
    const res = await api.request('GET', `/api/admin/tmdb/search?${params}`);
    if (current !== opened) return; // closed or reopened meanwhile
    if (!res.ok) {
      setMessage(format('match.failed', { error: (res.body && res.body.error) || res.status }), 'error');
      return;
    }
    setMessage(res.body.length ? '' : text('match.noResults'));
    $('match-results').replaceChildren(...res.body.map(resultRow));
  }

  function resultRow(result) {
    const row = el('li', 'item');
    if (result.poster) {
      const img = el('img', 'thumb');
      img.alt = '';
      img.src = result.poster;
      row.append(img);
    } else {
      row.append(el('span', 'thumb empty'));
    }
    const info = el('div', 'item-info');
    info.append(el('div', 'item-title', withYear(result.title, result.year)));
    if (result.originalTitle && result.originalTitle !== result.title) info.append(el('div', 'item-sub', result.originalTitle));
    if (result.overview) info.append(el('div', 'item-overview', result.overview));
    row.append(info);

    if (current && current.item.tmdbId === result.tmdbId) {
      row.append(el('span', 'current-match', text('match.current')));
    } else {
      const choose = el('button', 'primary', text('match.choose'));
      choose.type = 'button';
      choose.addEventListener('click', () => chooseResult(result));
      row.append(choose);
    }
    return row;
  }

  async function chooseResult(result) {
    const opened = current;
    setMessage(text('match.saving'));
    $('match-results').querySelectorAll('button').forEach((b) => (b.disabled = true));
    const error = await opened.onChoose(result);
    if (current !== opened) return;
    if (error) {
      setMessage(format('match.failed', { error }), 'error');
      $('match-results').querySelectorAll('button').forEach((b) => (b.disabled = false));
      return;
    }
    close();
  }

  $('match-form').addEventListener('submit', (event) => {
    event.preventDefault();
    search();
  });
  $('match-close').addEventListener('click', close);
  $('match-dialog').addEventListener('click', (event) => {
    if (event.target === $('match-dialog')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('match-dialog').hidden) close();
  });

  return { open };
}
