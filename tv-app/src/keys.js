// Maps keyboard / remote key events to app actions.
//
// LG remote key codes: https://webostv.developer.lge.com/develop/guides/magic-remote
// In a desktop browser: arrows, Enter, Backspace/Escape = Back, Space = play/pause,
// keys 1-4 = Red/Green/Yellow/Blue.

const KEY_ACTIONS = {
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',
  13: 'enter',

  461: 'back', // webOS Back
  8: 'back', // Backspace (desktop)
  27: 'back', // Escape (desktop)

  415: 'play',
  19: 'pause',
  413: 'stop',
  417: 'ff',
  412: 'rw',
  179: 'playpause', // MediaPlayPause on desktop keyboards
  32: 'playpause', // Space (desktop)

  403: 'red',
  404: 'green',
  405: 'yellow',
  406: 'blue',
  49: 'red', // "1"
  50: 'green', // "2"
  51: 'yellow', // "3"
  52: 'blue', // "4"
};

export function isTextInput(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

/**
 * Returns the action for a keydown event, or null if the key isn't ours.
 * While a text field is being edited, typing keys are left to the field.
 */
export function actionForEvent(event) {
  const action = KEY_ACTIONS[event.keyCode] || null;
  if (!action) return null;

  if (isTextInput(document.activeElement)) {
    const code = event.keyCode;
    // Let the field handle typing, deleting and moving the caret.
    if (code === 8 || code === 32 || (code >= 48 && code <= 57) || code === 37 || code === 39) {
      return null;
    }
  }

  return action;
}
