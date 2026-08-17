// drag.test.js — regression tests for pointer drags. The DOM tray overlaps the
// 3D tray pieces on screen, so canvas pointer events never see tray-piece
// presses; drags must start from the tray buttons and drive the same
// onDragStart/onDragHover/onDragEnd intents as canvas drags.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stubs — Input touches document/canvas/tray only through these.
// Each harness builds a fresh set so listeners never accumulate across tests.
const trayItem = {
  dataset: { key: 'pip' },
  closest(sel) { return sel === '.tray-item' ? this : null; },
};

const { Input } = await import('../src/ui-input.js');

const STATE = {
  tray: ['pip', 'book'],
  rooms: [
    { id: 'kitchen', slots: ['otto', null, null] },
    { id: 'library', slots: [null, null, null] },
  ],
};

function harness(pickHit, dragMode = 'both') {
  const trayHandlers = {}, canvasHandlers = {}, docHandlers = {};
  const tray = {
    addEventListener(type, fn) { (trayHandlers[type] ??= []).push(fn); },
    setPointerCapture() {},
  };
  const canvas = {
    addEventListener(type, fn) { (canvasHandlers[type] ??= []).push(fn); },
    setPointerCapture() {},
  };
  globalThis.document = {
    addEventListener(type, fn) { (docHandlers[type] ??= []).push(fn); },
    getElementById(id) { return id === 'tray' ? tray : null; },
    activeElement: null,
  };
  const calls = [];
  const h = {
    onDragStart: (key) => calls.push(['start', key]),
    onDragHover: (key, slot) => calls.push(['hover', key, slot]),
    onDragEnd: (key, slot) => calls.push(['end', key, slot]),
  };
  const stage = { pick: () => pickHit, setCursor() {}, orbit() {}, house: null, trayAnchors: [] };
  const input = new Input(canvas, stage, h);
  input.enabled = true;
  input.setContext({ state: STATE, selection: null, bindings: {}, gamepadMap: {}, dragMode });
  const fire = (table, type, e) => (table[type] || []).forEach(fn => fn(e));
  const ev = (x, y, buttons = 1, target = trayItem) => ({ pointerId: 1, clientX: x, clientY: y, buttons, target });
  return {
    input, calls,
    trayDown: (x, y) => fire(trayHandlers, 'pointerdown', ev(x, y)),
    trayMove: (x, y, buttons = 1) => fire(docHandlers, 'pointermove', ev(x, y, buttons)),
    trayUp: (x, y) => fire(docHandlers, 'pointerup', ev(x, y, 0)),
    trayCancel: (x, y) => fire(docHandlers, 'pointercancel', ev(x, y, 0)),
    trayClick: () => {
      const e = { stopped: false, stopImmediatePropagation() { e.stopped = true; }, preventDefault() {} };
      fire(trayHandlers, 'click', e);
      return e;
    },
    canvasFire: (type, x, y, buttons = 1) => fire(canvasHandlers, type, { pointerId: 2, clientX: x, clientY: y, buttons, target: canvas }),
  };
}

test('tray drag: press, move past threshold, release over a slot places there', (t) => {
  const { input, calls, trayDown, trayMove, trayUp } = harness({ kind: 'slot', room: 'library', slot: 1 });
  t.after(() => clearInterval(input._padTimer));
  trayDown(100, 100);
  trayMove(120, 120); // crosses DRAG_MIN_DIST (14px)
  trayMove(300, 200);
  trayUp(300, 200);
  assert.deepEqual(calls[0], ['start', 'pip']);
  assert.deepEqual(calls[calls.length - 1], ['end', 'pip', { room: 'library', slot: 1 }]);
  assert.ok(calls.some(c => c[0] === 'hover'));
});

test('tray tap: press and release without moving starts no drag (click selects)', (t) => {
  const { input, calls, trayDown, trayMove, trayUp } = harness({ kind: 'slot', room: 'library', slot: 1 });
  t.after(() => clearInterval(input._padTimer));
  trayDown(100, 100);
  trayMove(104, 103); // below threshold
  trayUp(104, 103);
  assert.deepEqual(calls, []);
});

test('tray drag: dropping on empty background cancels with null slot', (t) => {
  const { input, calls, trayDown, trayMove, trayUp } = harness(null);
  t.after(() => clearInterval(input._padTimer));
  trayDown(100, 100);
  trayMove(300, 200);
  trayUp(300, 200);
  assert.deepEqual(calls[calls.length - 1], ['end', 'pip', null]);
});

test('tray drag: dropping on a placed piece resolves to its slot for the engine to judge', (t) => {
  const { input, calls, trayDown, trayMove, trayUp } = harness({ kind: 'piece', key: 'otto' });
  t.after(() => clearInterval(input._padTimer));
  trayDown(100, 100);
  trayMove(300, 200);
  trayUp(300, 200);
  assert.deepEqual(calls[calls.length - 1], ['end', 'pip', { room: 'kitchen', slot: 0 }]);
});

test('tray drag: pointercancel mid-drag cancels safely', (t) => {
  const { input, calls, trayDown, trayMove, trayCancel } = harness({ kind: 'slot', room: 'library', slot: 1 });
  t.after(() => clearInterval(input._padTimer));
  trayDown(100, 100);
  trayMove(300, 200);
  trayCancel(300, 200);
  assert.deepEqual(calls[calls.length - 1], ['end', 'pip', null]);
});

test('tray drag: a move with no buttons pressed ends the drag (missed pointerup)', (t) => {
  const { input, calls, trayDown, trayMove } = harness({ kind: 'slot', room: 'library', slot: 1 });
  t.after(() => clearInterval(input._padTimer));
  trayDown(100, 100);
  trayMove(200, 160);
  trayMove(260, 190, 0); // button gone without an up — cancel, don't stick
  assert.deepEqual(calls[calls.length - 1], ['end', 'pip', null]);
});

test('tray drag: finished drag suppresses the button click; taps do not', (t) => {
  const { input, trayDown, trayMove, trayUp, trayClick } = harness({ kind: 'slot', room: 'library', slot: 1 });
  t.after(() => clearInterval(input._padTimer));
  trayDown(100, 100); trayMove(300, 200); trayUp(300, 200);
  assert.equal(trayClick().stopped, true); // post-drag click swallowed
  trayDown(100, 100); trayUp(100, 100); // tap
  assert.equal(trayClick().stopped, false); // tap click passes through
});

test('tray drag: ignored in tap-only placement mode', (t) => {
  const { input, calls, trayDown, trayMove, trayUp } = harness({ kind: 'slot', room: 'library', slot: 1 }, 'tap');
  t.after(() => clearInterval(input._padTimer));
  trayDown(100, 100);
  trayMove(300, 200);
  trayUp(300, 200);
  assert.deepEqual(calls, []);
});

test('canvas drag still works: piece picked on canvas drags to a slot', (t) => {
  const { input, calls, canvasFire } = harness(null);
  t.after(() => clearInterval(input._padTimer));
  // First pointerdown picks the placed piece 'otto', then drag it.
  input.stage.pick = (x) => (x === 50 ? { kind: 'piece', key: 'otto' } : { kind: 'slot', room: 'library', slot: 2 });
  canvasFire('pointerdown', 50, 50);
  canvasFire('pointermove', 90, 90);
  canvasFire('pointermove', 400, 300);
  canvasFire('pointerup', 400, 300, 0);
  assert.deepEqual(calls[0], ['start', 'otto']);
  assert.deepEqual(calls[calls.length - 1], ['end', 'otto', { room: 'library', slot: 2 }]);
});
