// Category screen: a poster grid of movies, series or videos with a filter and a sort menu.
// Filter, sort and loaded data live in the router params, so Back restores the exact view.
import * as api from '../api.js';
import * as focus from '../focus.js';
import { cardHtml } from '../components/card.js';
import { select } from '../components/menu.js';
import { bindNavbar, navbarHtml } from '../components/navbar.js';
import { createVirtualGrid } from '../components/virtualGrid.js';
import { t } from '../i18n/bg.js';
import { openItem } from '../navigation.js';
import { escapeHtml } from '../utils/format.js';

const SORT_LABELS = { title: t.sortTitle, year: t.sortYear, rating: t.sortRating, added: t.sortAdded };

const KINDS = {
  movies: {
    title: t.navMovies,
    empty: t.emptyMovies,
    sorts: ['added', 'title', 'year', 'rating'],
    filterLabel: t.filterGenre,
    landscape: false,
    fetchItems: (p) => api.getMovies({ genre: p.filter, sort: p.sort }),
    fetchFilters: () => api.getGenres('movie').then((genres) => genres.map((g) => ({ value: g, label: g }))),
  },
  series: {
    title: t.navSeries,
    empty: t.emptySeries,
    sorts: ['added', 'title', 'year', 'rating'],
    filterLabel: t.filterGenre,
    landscape: false,
    fetchItems: (p) => api.getSeriesList({ genre: p.filter, sort: p.sort }),
    fetchFilters: () => api.getGenres('series').then((genres) => genres.map((g) => ({ value: g, label: g }))),
  },
  videos: {
    title: t.navVideos,
    empty: t.emptyVideos,
    sorts: ['added', 'title'],
    filterLabel: t.filterCategory,
    landscape: true,
    // An empty string means "videos without a category".
    fetchItems: (p) => api.getVideos({ category: p.filter, sort: p.sort }),
    fetchFilters: () =>
      api.getVideoCategories().then((categories) =>
        categories.map((c) => ({ value: c.category === null ? '' : c.category, label: c.category || t.noCategory }))
      ),
  },
};

// Grid geometry for the 1920px stage (see .grid-* in CSS).
const POSTER_GRID = { columns: 7, rowHeight: 432 };
const LANDSCAPE_GRID = { columns: 4, rowHeight: 356 };

function focusIdOf(item) {
  return `item-${item.type}-${item.id}`;
}

export function browseScreen(params) {
  const kind = KINDS[params.kind];
  if (params.sort === undefined) params.sort = 'added';
  if (params.filter === undefined) params.filter = null; // null = all

  let alive = true;
  let root;

  function filterLabel() {
    if (params.filter === null) return `${kind.filterLabel}: ${t.allGenres}`;
    return `${kind.filterLabel}: ${params.filter === '' ? t.noCategory : params.filter}`;
  }

  function renderGrid(items) {
    const viewport = root.querySelector('.grid-viewport');
    viewport.innerHTML = '';
    root.querySelector('.browse-count').textContent = items.length ? String(items.length) : '';

    if (!items.length) {
      viewport.innerHTML = `<p class="empty-message">${params.filter === null ? kind.empty : t.emptyFiltered}</p>`;
      focus.focus(root.querySelector('[data-action="filter"]'), { instant: true });
      return;
    }

    const geometry = kind.landscape ? LANDSCAPE_GRID : POSTER_GRID;
    const grid = createVirtualGrid(viewport, {
      items,
      columns: geometry.columns,
      rowHeight: geometry.rowHeight,
      renderCard: (item, index) =>
        cardHtml(item, focusIdOf(item), `data-index="${index}"${index === 0 ? ' data-autofocus' : ''}`),
      onSelect: openItem,
      focusIdOf,
    });
    grid.revealFocusId(focus.rememberedId());
    // The remembered card when coming back, otherwise the first card.
    focus.focusInitial();
  }

  function loadItems() {
    const key = `${params.filter}|${params.sort}`;
    if (params.cache && params.cache.key === key) {
      renderGrid(params.cache.items);
      return;
    }
    kind.fetchItems(params).then(
      (items) => {
        if (!alive) return;
        params.cache = { key, items };
        renderGrid(items);
      },
      () => {
        if (!alive) return;
        root.querySelector('.grid-viewport').innerHTML = `<p class="empty-message">${t.serverUnreachable}</p>`;
      }
    );
  }

  // After a filter/sort change the remembered card may not be in the list any more.
  function resetFocusMemory() {
    focus.forget(`browse:${params.kind}`);
    focus.rememberInGroup('nav', 'nav-' + params.kind);
  }

  function chooseFilter() {
    kind.fetchFilters().then(
      (filters) => {
        if (!alive) return;
        const options = [{ value: null, label: t.allGenres }].concat(filters);
        return select(kind.filterLabel, options, params.filter).then((choice) => {
          if (!choice || choice.value === params.filter || !alive) return;
          params.filter = choice.value;
          root.querySelector('[data-action="filter"]').textContent = filterLabel();
          resetFocusMemory(); // the old focused card may not be in the new list
          loadItems();
        });
      },
      () => {}
    );
  }

  function chooseSort() {
    const options = kind.sorts.map((value) => ({ value, label: SORT_LABELS[value] }));
    select(t.sortLabel, options, params.sort).then((choice) => {
      if (!choice || choice.value === params.sort || !alive) return;
      params.sort = choice.value;
      root.querySelector('[data-action="sort"]').textContent = `${t.sortLabel}: ${SORT_LABELS[params.sort]}`;
      resetFocusMemory();
      loadItems();
    });
  }

  return {
    mount(el) {
      root = el;
      root.innerHTML = `
        <div class="browse">
          ${navbarHtml(params.kind)}
          <div class="browse-header">
            <h1 class="browse-title">${kind.title} <span class="browse-count"></span></h1>
            <div class="browse-filters">
              <button class="btn btn-small" data-focusable data-focus-id="filter" data-action="filter">${escapeHtml(filterLabel())}</button>
              <button class="btn btn-small" data-focusable data-focus-id="sort" data-action="sort">${t.sortLabel}: ${SORT_LABELS[params.sort]}</button>
            </div>
          </div>
          <div class="grid-viewport ${kind.landscape ? 'grid-landscape' : 'grid-poster'}"></div>
        </div>`;
      bindNavbar(root, params.kind);
      root.querySelector('[data-action="filter"]').addEventListener('click', chooseFilter);
      root.querySelector('[data-action="sort"]').addEventListener('click', chooseSort);
      loadItems();
    },
    unmount() {
      alive = false;
    },
  };
}
