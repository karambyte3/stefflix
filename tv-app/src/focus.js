// Spatial navigation / focus manager.
//
// Focusable elements are marked with [data-focusable] and ideally a stable
// [data-focus-id], so focus can be restored after a screen is re-rendered.
// Focus is "virtual" (an .is-focused class), so the browser never scrolls or
// opens the on-screen keyboard on its own. Text inputs get real DOM focus only
// when activated with Enter.
//
// Scopes: each screen sets the scope root; modals push a scope on top of it.
// Groups: elements inside a [data-focus-group] (e.g. a row of posters) remember
// their last focused item, so entering the row again lands on that item.
//
// Scrolling (transform-based, no native scroll):
// - [data-scroll-row]: a horizontal track inside an overflow:hidden viewport.
//   The focused card is kept at the left edge.
// - [data-scroll-page="top"|"visible"]: a vertical page inside an overflow:hidden
//   viewport. The focused element's [data-scroll-anchor] (or the element itself)
//   is aligned to the top ("top") or just kept on screen ("visible").
//   [data-scroll-margin] is the gap kept above/below; an anchor with
//   [data-scroll-to="0"] scrolls the page to that exact position instead.
// Every focus change dispatches a bubbling "tvfocus" event, for components
// (like the virtual grid) that scroll themselves.

import { isTextInput } from './keys.js';

const FOCUSED_CLASS = 'is-focused';

const scopes = []; // [{ root, key }]
const lastFocusByScope = {}; // scope key -> focus id
const lastFocusByGroup = {}; // scope key + '|' + group name -> focus id

let current = null;

function activeScope() {
  return scopes[scopes.length - 1] || null;
}

function isVisible(el) {
  return el.getClientRects().length > 0 && !el.disabled;
}

function focusables() {
  const scope = activeScope();
  if (!scope) return [];
  return Array.prototype.filter.call(scope.root.querySelectorAll('[data-focusable]'), isVisible);
}

function groupOf(el) {
  return el.closest('[data-focus-group]');
}

function groupKey(scope, groupName) {
  return scope.key + '|' + groupName;
}

function findById(id) {
  if (!id) return null;
  const list = focusables();
  for (let i = 0; i < list.length; i++) {
    if (list[i].getAttribute('data-focus-id') === id) return list[i];
  }
  return null;
}

// --- scrolling -----------------------------------------------------------------

/** Offset of `el` inside `ancestor` (which must be positioned), ignoring transforms. */
function offsetWithin(el, ancestor) {
  let top = 0;
  let left = 0;
  let node = el;
  while (node && node !== ancestor) {
    top += node.offsetTop;
    left += node.offsetLeft;
    node = node.offsetParent;
  }
  return { top, left };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Moves a scroll container with a CSS transform; `instant` skips the transition. */
export function setScroll(el, x, y, instant) {
  el.setAttribute('data-scroll-x', x);
  el.setAttribute('data-scroll-y', y);
  if (instant) el.classList.add('no-transition');
  el.style.transform = `translate3d(${-x}px, ${-y}px, 0)`;
  if (instant) {
    el.offsetWidth; // flush styles so the transition stays off for this change
    el.classList.remove('no-transition');
  }
}

function scrollRowTo(el, instant) {
  const track = el.closest('[data-scroll-row]');
  if (!track) return;
  const viewportWidth = track.parentNode.clientWidth;
  const last = track.lastElementChild;
  const padding = parseInt(window.getComputedStyle(track).paddingLeft, 10) || 0;
  const contentWidth = last ? last.offsetLeft + last.offsetWidth + padding : 0;
  const x = clamp(offsetWithin(el, track).left - padding, 0, Math.max(0, contentWidth - viewportWidth));
  setScroll(track, x, 0, instant);
}

/** Scrolls the horizontal row containing `el` (without focusing it), e.g. to show the "up next" episode. */
export function revealInRow(el) {
  if (el) scrollRowTo(el, true);
}

function scrollPageTo(el, instant) {
  const page = el.closest('[data-scroll-page]');
  if (!page) return;
  const mode = page.getAttribute('data-scroll-page');
  const margin = Number(page.getAttribute('data-scroll-margin')) || 0;
  const viewportHeight = page.parentNode.clientHeight;
  const anchor = el.closest('[data-scroll-anchor]') || el;
  const top = offsetWithin(anchor, page).top;
  const currentY = Number(page.getAttribute('data-scroll-y')) || 0;

  let y;
  const fixed = anchor.getAttribute('data-scroll-to');
  if (fixed !== null) {
    y = Number(fixed);
  } else if (mode === 'top') {
    y = top - margin;
  } else {
    y = currentY;
    if (top - margin < y) y = top - margin;
    else if (top + anchor.offsetHeight + margin > y + viewportHeight) y = top + anchor.offsetHeight + margin - viewportHeight;
  }
  y = clamp(y, 0, Math.max(0, page.offsetHeight - viewportHeight));
  if (y !== currentY) setScroll(page, 0, y, instant);
}

// --- focus -----------------------------------------------------------------------

export function getCurrent() {
  return current && document.body.contains(current) ? current : null;
}

/**
 * Focuses an element.
 * options.instant: scroll without animation (used when restoring focus).
 * options.remember === false: don't remember it as the screen's last focus (a temporary fallback).
 */
export function focus(el, options) {
  if (!el) return;
  const instant = !!(options && options.instant);
  const scope = activeScope();

  if (current && current !== el) {
    current.classList.remove(FOCUSED_CLASS);
    if (isTextInput(current) && document.activeElement === current) current.blur();
  }

  current = el;
  el.classList.add(FOCUSED_CLASS);

  const id = el.getAttribute('data-focus-id');
  if (scope && id && !(options && options.remember === false)) {
    lastFocusByScope[scope.key] = id;
    const group = groupOf(el);
    if (group) lastFocusByGroup[groupKey(scope, group.getAttribute('data-focus-group'))] = id;
  }

  scrollRowTo(el, instant);
  scrollPageTo(el, instant);
  el.dispatchEvent(new CustomEvent('tvfocus', { bubbles: true, detail: { instant } }));
}

/** Focuses the remembered element of the active scope, or [data-autofocus], or the first focusable. */
export function focusInitial() {
  const scope = activeScope();
  if (!scope) return;
  const list = focusables();
  if (!list.length) return;

  const remembered = findById(lastFocusByScope[scope.key]);
  const auto = scope.root.querySelector('[data-autofocus]');
  const preferred = remembered || (auto && isVisible(auto) ? auto : null);
  // The first-element fallback isn't remembered: a screen that is still loading its
  // content must still get its [data-autofocus] element once that content arrives.
  focus(preferred || list[0], { instant: true, remember: !!preferred });
}

/** Re-focuses something sensible if the focused element disappeared (e.g. after a re-render). */
export function ensureFocus() {
  const scope = activeScope();
  if (!scope) return;
  const el = getCurrent();
  if (!el || !isVisible(el) || !scope.root.contains(el)) focusInitial();
}

/** The focus id remembered for the active scope (e.g. to scroll a virtual grid to it before rendering). */
export function rememberedId() {
  const scope = activeScope();
  return scope ? lastFocusByScope[scope.key] || null : null;
}

/** Pre-sets what a group should focus when it's entered (e.g. the active tab of the navbar). */
export function rememberInGroup(groupName, focusId) {
  const scope = activeScope();
  if (scope) lastFocusByGroup[groupKey(scope, groupName)] = focusId;
}

/** Drops the remembered focus of a screen, so a fresh visit starts at its default element. */
export function forget(scopeKey) {
  delete lastFocusByScope[scopeKey];
  const prefix = scopeKey + '|';
  for (const key in lastFocusByGroup) {
    if (key.indexOf(prefix) === 0) delete lastFocusByGroup[key];
  }
}

/** Current translation of an element from its computed transform (mid-transition value). */
function currentTranslate(el) {
  const transform = window.getComputedStyle(el).transform;
  if (!transform || transform === 'none') return { x: 0, y: 0 };
  const values = transform.slice(transform.indexOf('(') + 1, -1).split(',').map(Number);
  // matrix(a, b, c, d, tx, ty) or matrix3d(... tx, ty, tz, 1)
  return values.length === 16 ? { x: values[12], y: values[13] } : { x: values[4], y: values[5] };
}

/**
 * Where an element will be once all scroll animations have finished.
 * Without this, pressing keys quickly (or holding one) would measure rows
 * mid-animation and jump to the wrong card.
 */
function settledRect(el, cache, stageScale) {
  const rect = el.getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  for (let node = el.parentNode; node && node.getAttribute; node = node.parentNode) {
    if (!node.hasAttribute('data-scroll-x')) continue;
    let pending = cache.get(node);
    if (!pending) {
      const now = currentTranslate(node);
      pending = {
        x: -Number(node.getAttribute('data-scroll-x')) - now.x,
        y: -Number(node.getAttribute('data-scroll-y')) - now.y,
      };
      cache.set(node, pending);
    }
    dx += pending.x;
    dy += pending.y;
  }
  dx *= stageScale;
  dy *= stageScale;
  return { left: rect.left + dx, right: rect.right + dx, top: rect.top + dy, bottom: rect.bottom + dy, width: rect.width, height: rect.height };
}

// Distance between two 1-D ranges, 0 if they overlap.
function rangeGap(aStart, aEnd, bStart, bEnd) {
  if (bEnd < aStart) return aStart - bEnd;
  if (bStart > aEnd) return bStart - aEnd;
  return 0;
}

// Elements whose distance differs by less than this (stage px) count as the same line.
const ROW_BAND = 24;

/** Moves focus in a direction: 'up' | 'down' | 'left' | 'right'. Returns true if focus moved. */
export function move(direction) {
  const from = getCurrent();
  if (!from) {
    focusInitial();
    return !!getCurrent();
  }

  // Rects are in screen pixels, transforms in stage pixels (the stage is scaled in a desktop browser).
  const stageScale = document.getElementById('app').getBoundingClientRect().width / 1920;
  const cache = new Map();
  const a = settledRect(from, cache, stageScale);
  const aCx = a.left + a.width / 2;
  const aCy = a.top + a.height / 2;

  const horizontal = direction === 'left' || direction === 'right';
  const candidates = [];

  const list = focusables();
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (el === from) continue;
    const b = settledRect(el, cache, stageScale);

    // A candidate must start beyond the centre of the current element in that direction.
    // Using the centre (not the edge) keeps this working while the focused element is
    // scaled up by CSS and slightly overlaps its neighbours.
    let distance;
    if (direction === 'right') {
      if (b.left < aCx) continue;
      distance = b.left - a.right;
    } else if (direction === 'left') {
      if (b.right > aCx) continue;
      distance = a.left - b.right;
    } else if (direction === 'down') {
      if (b.top < aCy) continue;
      distance = b.top - a.bottom;
    } else {
      if (b.bottom > aCy) continue;
      distance = a.top - b.bottom;
    }

    // How far off the current element's "beam" the candidate is (0 = overlapping).
    const offAxis = horizontal ? rangeGap(a.top, a.bottom, b.top, b.bottom) : rangeGap(a.left, a.right, b.left, b.right);
    // Left/Right only moves within the same row; there's nothing "to the right" of the end of a row.
    if (horizontal && offAxis > 0) continue;

    const centreDistance = horizontal ? Math.abs(b.top + b.height / 2 - aCy) : Math.abs(b.left + b.width / 2 - aCx);
    candidates.push({ el, distance: Math.max(0, distance), offAxis, centreDistance });
  }

  if (!candidates.length) return false;

  // Take the nearest line of elements in that direction (the next row, the next button),
  // then the element in it that is best aligned with the current one. This way Up from a
  // grid goes to the filter bar above it even if its buttons are off to the side.
  const nearest = Math.min.apply(null, candidates.map((c) => c.distance));
  const band = nearest + ROW_BAND * stageScale;
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.distance > band) continue;
    const score = c.offAxis * 1000 + c.centreDistance + c.distance;
    if (score < bestScore) {
      bestScore = score;
      best = c.el;
    }
  }

  // Entering a different group: go to the item that was focused there last time.
  const scope = activeScope();
  const targetGroup = groupOf(best);
  if (targetGroup && targetGroup !== groupOf(from)) {
    const remembered = findById(lastFocusByGroup[groupKey(scope, targetGroup.getAttribute('data-focus-group'))]);
    if (remembered && targetGroup.contains(remembered)) best = remembered;
  }

  focus(best);
  return true;
}

/** Enter on the focused element: text inputs get real focus (opens the TV keyboard), everything else is clicked. */
export function activate() {
  const el = getCurrent();
  if (!el) return false;
  if (isTextInput(el)) {
    el.focus();
  } else {
    el.click();
  }
  return true;
}

/** Called by the router when a screen is shown. Replaces all scopes. */
export function setScope(root, key) {
  if (current) current.classList.remove(FOCUSED_CLASS);
  current = null;
  scopes.length = 0;
  scopes.push({ root, key });
}

/** For overlays like dialogs: focus is trapped inside `root` until popScope(). */
export function pushScope(root, key) {
  if (current) current.classList.remove(FOCUSED_CLASS);
  current = null;
  scopes.push({ root, key });
}

export function popScope() {
  scopes.pop();
  current = null;
  focusInitial();
}

/** Magic Remote pointer / desktop mouse: hovering focuses, clicking works natively. */
export function initPointerSupport() {
  document.addEventListener('mouseover', (event) => {
    const scope = activeScope();
    const target = event.target.closest && event.target.closest('[data-focusable]');
    if (target && scope && scope.root.contains(target) && target !== current) focus(target);
  });
}
