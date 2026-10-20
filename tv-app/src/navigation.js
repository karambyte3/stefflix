// Shared navigation helpers for screens.
import * as router from './router.js';

/** What happens when a card is selected. */
export function openItem(item) {
  if (item.type === 'movie') {
    router.navigate('details', { kind: 'movie', id: item.id });
  } else if (item.type === 'series') {
    router.navigate('details', { kind: 'series', id: item.id });
  } else if (item.type === 'episode') {
    router.navigate('details', { kind: 'series', id: item.seriesId, season: item.seasonNumber, focusEpisode: item.id });
  } else {
    router.navigate('player', { id: item.id });
  }
}

/**
 * Loads screen data with a per-visit cache kept in the router params:
 * when the user comes back to a screen it renders the cached data at once,
 * then re-renders only if the server returns something different.
 */
export function loadCached(params, fetcher, handlers) {
  if (params.cache) handlers.render(params.cache);
  fetcher().then(
    (data) => {
      if (!handlers.isAlive()) return;
      if (params.cache && JSON.stringify(data) === JSON.stringify(params.cache)) return;
      params.cache = data;
      handlers.render(data);
    },
    (err) => {
      if (handlers.isAlive() && !params.cache) handlers.error(err);
    }
  );
}
