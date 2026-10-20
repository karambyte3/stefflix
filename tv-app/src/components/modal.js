// A modal layer (dialog, selection menu) on top of the current screen.
// While one is open it receives all keys (see main.js) and focus is trapped inside it.
import * as focus from '../focus.js';

let openModal = null; // { el, onClose, onKey }

export function isOpen() {
  return !!openModal;
}

/**
 * Shows `el` as a modal. `onClose(result)` is called once when it closes,
 * with the value passed to close() - or undefined when closed with Back.
 * `onKey(action)` (optional) sees keys first, e.g. color buttons; return true if handled.
 */
export function open(el, onClose, onKey) {
  if (openModal) close();
  document.getElementById('app').appendChild(el);
  openModal = { el, onClose, onKey };
  focus.pushScope(el, 'modal');
}

export function close(result) {
  if (!openModal) return;
  const modal = openModal;
  openModal = null;
  modal.el.parentNode.removeChild(modal.el);
  focus.popScope();
  modal.onClose(result);
}

export function onKey(action) {
  if (openModal.onKey && openModal.onKey(action)) return true;
  if (action === 'back') {
    close();
    return true;
  }
  return false;
}
