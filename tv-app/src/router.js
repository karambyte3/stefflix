// Minimal stack router. A screen factory receives params and returns:
//   { mount(rootEl), unmount?(), onKey?(action, event) -> true if handled }
//
// The params object of a stack entry is kept while the entry is on the stack, so a
// screen can store its state there (filters, cached data) and find it again when the
// user comes back to it.
import * as focus from './focus.js';

const factories = {};
const stack = []; // [{ name, params }]
let container = null;
let active = null; // { entry, instance, root }

export function initRouter(el) {
  container = el;
}

export function register(name, factory) {
  factories[name] = factory;
}

function screenKey(entry) {
  const p = entry.params;
  return [entry.name, p.kind, p.id].filter((part) => part !== undefined && part !== null).join(':');
}

function show(entry) {
  if (active && active.instance.unmount) active.instance.unmount();
  container.innerHTML = '';

  const factory = factories[entry.name];
  if (!factory) throw new Error(`Unknown screen: ${entry.name}`);

  const root = document.createElement('div');
  root.className = 'screen screen-' + entry.name;
  container.appendChild(root);

  const instance = factory(entry.params);
  active = { entry, instance, root };

  focus.setScope(root, screenKey(entry));
  instance.mount(root);
  focus.focusInitial();
}

/** Opens a screen on top of the current one. It starts fresh (no remembered focus). */
export function navigate(name, params) {
  const entry = { name, params: params || {} };
  focus.forget(screenKey(entry));
  stack.push(entry);
  show(entry);
}

/** Swaps the current screen for another one (Back skips it). */
export function replace(name, params) {
  stack.pop();
  navigate(name, params);
}

/** Goes to the previous screen. Returns false when already on the first screen. */
export function back() {
  if (stack.length <= 1) return false;
  stack.pop();
  show(stack[stack.length - 1]);
  return true;
}

/** Goes back to the nearest screen with this name, or replaces the whole stack with it. */
export function backTo(name) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].name === name) {
      stack.length = i + 1;
      show(stack[i]);
      return;
    }
  }
  stack.length = 0;
  navigate(name);
}

export function currentName() {
  return active ? active.entry.name : null;
}

export function currentScreen() {
  return active ? active.instance : null;
}
