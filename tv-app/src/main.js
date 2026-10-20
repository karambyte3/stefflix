import './styles/base.css';
import './styles/components.css';
import './styles/home.css';
import './styles/browse.css';
import './styles/details.css';
import './styles/player.css';
import * as focus from './focus.js';
import * as router from './router.js';
import * as dialog from './components/dialog.js';
import * as modal from './components/modal.js';
import { actionForEvent, isTextInput } from './keys.js';
import { getServerUrl } from './config.js';
import { t } from './i18n/bg.js';
import { browseScreen } from './screens/browse.js';
import { detailsScreen } from './screens/details.js';
import { homeScreen } from './screens/home.js';
import { settingsScreen } from './screens/settings.js';
import { playerScreen } from './screens/player.js';

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

// The UI is laid out for 1920x1080. On the TV this is 1:1; in a desktop
// browser the whole stage is scaled down to fit the window.
function fitStage() {
  const app = document.getElementById('app');
  const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
  const offsetX = (window.innerWidth - STAGE_WIDTH * scale) / 2;
  const offsetY = (window.innerHeight - STAGE_HEIGHT * scale) / 2;
  app.style.transform = scale === 1 ? '' : `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}

function exitApp() {
  // With "disableBackHistoryAPI": true, window.close() closes the app on webOS.
  window.close();
}

function confirmExit() {
  dialog.confirm(t.exitTitle).then((yes) => {
    if (yes) exitApp();
  });
}

function onKeyDown(event) {
  const action = actionForEvent(event);
  if (!action) return;
  event.preventDefault();

  // Leaving a text field that is being edited.
  const active = document.activeElement;
  if (isTextInput(active)) {
    active.blur();
    if (action === 'enter' || action === 'back') return;
  }

  const layer = modal.isOpen() ? modal : router.currentScreen();
  if (layer && layer.onKey && layer.onKey(action, event)) return;

  switch (action) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      focus.move(action);
      break;
    case 'enter':
      focus.activate();
      break;
    case 'back':
      if (!router.back()) confirmExit();
      break;
    default:
      break;
  }
}

function start() {
  fitStage();
  window.addEventListener('resize', fitStage);

  router.initRouter(document.getElementById('screens'));
  router.register('home', homeScreen);
  router.register('browse', browseScreen);
  router.register('details', detailsScreen);
  router.register('settings', settingsScreen);
  router.register('player', playerScreen);

  focus.initPointerSupport();
  document.addEventListener('keydown', onKeyDown);

  if (getServerUrl()) router.navigate('home');
  else router.navigate('settings', { firstRun: true });
}

start();
