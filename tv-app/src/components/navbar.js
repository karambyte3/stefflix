// Top navigation tabs shared by the home and category screens.
import * as focus from '../focus.js';
import * as router from '../router.js';
import { t } from '../i18n/bg.js';

const TABS = [
  { id: 'home', label: t.navHome },
  { id: 'movies', label: t.navMovies },
  { id: 'series', label: t.navSeries },
  { id: 'videos', label: t.navVideos },
  { id: 'settings', label: t.navSettings },
];

export function navbarHtml(active) {
  return `
    <nav class="navbar" data-focus-group="nav">
      <img class="navbar-logo" src="logo.png" alt="${t.appName}" />
      ${TABS.map(
        (tab) => `
        <button class="nav-tab${tab.id === active ? ' is-active' : ''}" data-focusable
          data-focus-id="nav-${tab.id}" data-nav="${tab.id}">${tab.label}</button>`
      ).join('')}
    </nav>`;
}

function go(target, active) {
  if (target === active) return;
  if (target === 'settings') router.navigate('settings');
  else if (target === 'home') router.backTo('home');
  // Category screens replace each other, so Back from any of them returns home.
  else if (active === 'home') router.navigate('browse', { kind: target });
  else router.replace('browse', { kind: target });
}

/** Wires the tabs inside `root`. Moving up into the navbar lands on the active tab. */
export function bindNavbar(root, active) {
  root.querySelector('.navbar').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-nav]');
    if (tab) go(tab.getAttribute('data-nav'), active);
  });
  focus.rememberInGroup('nav', 'nav-' + active);
}
