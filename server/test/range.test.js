import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../src/utils/range.js';

const SIZE = 1000;

test('no header -> full body', () => {
  assert.deepEqual(parseRange(undefined, SIZE), { type: 'none' });
  assert.deepEqual(parseRange('', SIZE), { type: 'none' });
});

test('open-ended range', () => {
  assert.deepEqual(parseRange('bytes=0-', SIZE), { type: 'range', start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=500-', SIZE), { type: 'range', start: 500, end: 999 });
});

test('closed range', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { type: 'range', start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-10', SIZE), { type: 'range', start: 10, end: 10 });
});

test('end past the file is clamped', () => {
  assert.deepEqual(parseRange('bytes=900-5000', SIZE), { type: 'range', start: 900, end: 999 });
});

test('suffix range', () => {
  assert.deepEqual(parseRange('bytes=-100', SIZE), { type: 'range', start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { type: 'range', start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=-0', SIZE), { type: 'unsatisfiable' });
});

test('start past the end -> 416', () => {
  assert.deepEqual(parseRange('bytes=1000-', SIZE), { type: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=2000-3000', SIZE), { type: 'unsatisfiable' });
});

test('malformed headers are ignored', () => {
  assert.deepEqual(parseRange('bytes=500-100', SIZE), { type: 'none' });
  assert.deepEqual(parseRange('items=0-10', SIZE), { type: 'none' });
  assert.deepEqual(parseRange('bytes=abc', SIZE), { type: 'none' });
  assert.deepEqual(parseRange('bytes=-', SIZE), { type: 'none' });
});

test('multi-range uses the first range', () => {
  assert.deepEqual(parseRange('bytes=0-9, 20-29', SIZE), { type: 'range', start: 0, end: 9 });
});

test('empty file', () => {
  assert.deepEqual(parseRange('bytes=0-', 0), { type: 'unsatisfiable' });
});
