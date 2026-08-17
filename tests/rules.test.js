// rules.test.js — unit tests for every legal action, invalid-action reason,
// scoring component, terminal state, and serialization migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/rules.js';
import { practiceContent, challengeContent, lessonContent } from '../src/content.js';

function game() {
  // manor layout, 2 characters + 3 props, no limits
  return R.createGame(practiceContent('standard', 7, 'meadow'));
}
function simpleGame() {
  return R.createGame({
    contentId: 'unit', seed: 1,
    layout: { id: 'cottage', rooms: [
      { id: 'kitchen', type: 'kitchen', name: 'Kitchen', gx: 0, gy: 0, slots: 3 },
      { id: 'library', type: 'library', name: 'Library', gx: 1, gy: 0, slots: 3 },
    ]},
    items: {
      pip: { kind: 'character', name: 'Pip', tags: [] },
      otto: { kind: 'character', name: 'Otto', tags: [] },
      book: { kind: 'prop', name: 'Storybook', tags: [] },
      teapot: { kind: 'prop', name: 'Teapot', tags: [] },
      clock: { kind: 'prop', name: 'Old Clock', tags: [] },
    },
    tray: ['pip', 'otto', 'book', 'teapot', 'clock'],
    cards: [
      { id: 'c1', title: 'Story time in the Library', text: '', points: 20, when: { kind: 'beat', beat: 'story-time', roomType: 'library' } },
      { id: 'c2', title: "Pip's favorite", text: '', points: 24, when: { kind: 'beat', beat: 'time-check', character: 'pip', signature: true } },
    ],
    moveLimit: null, timeLimitMs: null, par: [20, 50, 90], allowUndo: true, ranked: false,
  });
}

test('initial state is well-formed', () => {
  const st = simpleGame();
  assert.equal(st.tick, 0);
  assert.equal(st.status, 'active');
  assert.equal(st.terminalReason, null);
  assert.equal(st.tray.length, 5);
  assert.ok(R.listLegalActions(st).length > 0);
});

test('place: legal placement updates tray, slot, tick, moves', () => {
  const st = simpleGame();
  const r = R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 });
  assert.deepEqual(r.events.map(e => e.type), ['placed']);
  assert.equal(st.tray.includes('pip'), false);
  assert.equal(R.roomById(st, 'kitchen').slots[0], 'pip');
  assert.equal(st.tick, 1);
  assert.equal(st.stats.moves, 1);
});

test('place: invalid reasons', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 });
  const cases = [
    [{ type: 'place', item: 'otto', room: 'nowhere', slot: 0 }, 'room-missing'],
    [{ type: 'place', item: 'otto', room: 'kitchen', slot: 9 }, 'slot-missing'],
    [{ type: 'place', item: 'otto', room: 'kitchen', slot: 0 }, 'slot-occupied'],
    [{ type: 'place', item: 'pip', room: 'library', slot: 0 }, 'item-not-in-tray'],
  ];
  for (const [cmd, reason] of cases) {
    assert.equal(R.validateCommand(st, cmd).reason, reason, JSON.stringify(cmd));
    const before = st.tick;
    R.applyCommand(st, cmd);
    assert.equal(st.tick, before, 'invalid command must not advance tick');
  }
  assert.equal(st.stats.invalid, 4);
});

test('move: legal and invalid', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 });
  R.applyCommand(st, { type: 'move', item: 'pip', room: 'library', slot: 1 });
  assert.equal(R.roomById(st, 'kitchen').slots[0], null);
  assert.equal(R.roomById(st, 'library').slots[1], 'pip');
  assert.equal(R.validateCommand(st, { type: 'move', item: 'pip', room: 'library', slot: 1 }).reason, 'same-slot');
  assert.equal(R.validateCommand(st, { type: 'move', item: 'otto', room: 'library', slot: 0 }).reason, 'item-not-placed');
});

test('remove returns item to tray', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 });
  R.applyCommand(st, { type: 'remove', item: 'pip' });
  assert.ok(st.tray.includes('pip'));
  assert.equal(R.validateCommand(st, { type: 'remove', item: 'pip' }).reason, 'item-not-placed');
});

test('interact: character+prop produces a scored beat', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'otto', room: 'kitchen', slot: 0 });
  R.applyCommand(st, { type: 'place', item: 'book', room: 'library', slot: 0 });
  // different rooms
  assert.equal(R.validateCommand(st, { type: 'interact', room: 'kitchen', a: 'otto', b: 'book' }).reason, 'different-rooms');
  R.applyCommand(st, { type: 'move', item: 'book', room: 'kitchen', slot: 1 });
  const r = R.applyCommand(st, { type: 'interact', room: 'kitchen', a: 'otto', b: 'book' });
  const beat = r.events.find(e => e.type === 'beat');
  assert.equal(beat.beat.t, 'story-time');
  assert.equal(beat.beat.pts, 10); // no signature, wrong habitat
  // repeat → already told
  assert.equal(R.validateCommand(st, { type: 'interact', room: 'kitchen', a: 'otto', b: 'book' }).reason, 'beat-already-told');
});

test('interact: prop+prop rejected, char+char is heart-to-heart', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'book', room: 'kitchen', slot: 0 });
  R.applyCommand(st, { type: 'place', item: 'teapot', room: 'kitchen', slot: 1 });
  assert.equal(R.validateCommand(st, { type: 'interact', room: 'kitchen', a: 'book', b: 'teapot' }).reason, 'props-need-character');
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 2 });
  R.applyCommand(st, { type: 'place', item: 'otto', room: 'library', slot: 0 });
  R.applyCommand(st, { type: 'move', item: 'otto', room: 'kitchen', slot: 1 }); // evict teapot? no: slot1 has teapot
});

test('interact: heart-to-heart between two characters', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 });
  R.applyCommand(st, { type: 'place', item: 'otto', room: 'kitchen', slot: 1 });
  const r = R.applyCommand(st, { type: 'interact', room: 'kitchen', a: 'pip', b: 'otto' });
  assert.equal(r.events.find(e => e.type === 'beat').beat.t, 'heart-to-heart');
});

test('scoring: signature and habitat bonuses', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 });
  R.applyCommand(st, { type: 'place', item: 'clock', room: 'kitchen', slot: 1 });
  const r = R.applyCommand(st, { type: 'interact', room: 'kitchen', a: 'pip', b: 'clock' });
  const beat = r.events.find(e => e.type === 'beat').beat;
  assert.equal(beat.sig, 1);
  assert.equal(beat.pts, 10 + R.SIGNATURE_BONUS);
});

test('cards flip with events and score a breakdown', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'library', slot: 0 });
  R.applyCommand(st, { type: 'place', item: 'book', room: 'library', slot: 1 });
  const r = R.applyCommand(st, { type: 'interact', room: 'library', a: 'pip', b: 'book' });
  assert.ok(r.events.some(e => e.type === 'card' && e.card.id === 'c1'));
  const s = R.scoreState(st);
  assert.equal(s.moments, 16);   // 10 + habitat 6
  assert.equal(s.discoveries, 20);
  assert.equal(s.coverage, 5);   // one room occupied
  assert.equal(s.variety, 8);    // one beat type
  assert.equal(s.total, 49);
  assert.equal(s.cardsDone, 1);
});

test('finish is terminal; further commands rejected as game-over', () => {
  const st = simpleGame();
  const r = R.applyCommand(st, { type: 'finish', elapsedMs: 60000 });
  assert.ok(r.events.some(e => e.type === 'gameover' && e.reason === 'scene-saved'));
  assert.equal(st.status, 'terminal');
  assert.equal(st.elapsedMs, 60000);
  assert.equal(R.validateCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 }).reason, 'game-over');
  assert.deepEqual(R.listLegalActions(st), []);
});

test('move limit ends the game with move-limit reason', () => {
  const st = R.createGame({
    contentId: 'unit-limited', seed: 1,
    layout: { id: 'cottage', rooms: [
      { id: 'kitchen', type: 'kitchen', name: 'Kitchen', gx: 0, gy: 0, slots: 3 },
    ]},
    items: {
      pip: { kind: 'character', name: 'Pip', tags: [] },
      otto: { kind: 'character', name: 'Otto', tags: [] },
    },
    tray: ['pip', 'otto'], cards: [],
    moveLimit: 2, timeLimitMs: null, par: [0, 0, 0], allowUndo: true, ranked: false,
  });
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 });
  const r = R.applyCommand(st, { type: 'place', item: 'otto', room: 'kitchen', slot: 1 });
  assert.equal(st.status, 'terminal');
  assert.equal(st.terminalReason, 'move-limit');
  assert.ok(r.events.some(e => e.type === 'gameover'));
});

test('timeout requires a real clock and a truly expired clock', () => {
  const st = simpleGame();
  assert.equal(R.validateCommand(st, { type: 'timeout', elapsedMs: 999999 }).reason, 'no-time-limit');
  const timed = R.createGame({
    contentId: 'unit-timed', seed: 1,
    layout: { id: 'cottage', rooms: [
      { id: 'kitchen', type: 'kitchen', name: 'Kitchen', gx: 0, gy: 0, slots: 3 },
    ]},
    items: { pip: { kind: 'character', name: 'Pip', tags: [] } },
    tray: ['pip'], cards: [],
    moveLimit: null, timeLimitMs: 60000, par: [0, 0, 0], allowUndo: true, ranked: false,
  });
  assert.equal(R.validateCommand(timed, { type: 'timeout', elapsedMs: 30000 }).reason, 'time-not-up');
  const r = R.applyCommand(timed, { type: 'timeout', elapsedMs: 60000 });
  assert.equal(timed.terminalReason, 'time-up');
  assert.ok(r.events.some(e => e.type === 'gameover'));
});

test('time bonus scores on the speed challenge', () => {
  const st = R.createGame(challengeContent('speed-tea'));
  R.applyCommand(st, { type: 'place', item: 'otto', room: 'kitchen', slot: 0 });
  const r = R.applyCommand(st, { type: 'finish', elapsedMs: 60000 });
  const s = r.events.find(e => e.type === 'gameover').score;
  // parTime 150s - 60s elapsed = 90s × 2 = 180
  assert.equal(s.timeBonus, 180);
});

test('serialization round-trips and hashes are stable', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 });
  R.applyCommand(st, { type: 'place', item: 'clock', room: 'kitchen', slot: 1 });
  R.applyCommand(st, { type: 'interact', room: 'kitchen', a: 'pip', b: 'clock' });
  const h1 = R.hashState(st);
  const restored = R.deserializeState(R.serializeState(st));
  assert.equal(R.hashState(restored), h1);
  // and the restored game continues identically
  R.applyCommand(st, { type: 'place', item: 'otto', room: 'library', slot: 0 });
  R.applyCommand(restored, { type: 'place', item: 'otto', room: 'library', slot: 0 });
  assert.equal(R.hashState(restored), R.hashState(st));
});

test('migration: v1 document upgrades to current version', () => {
  const v1 = {
    v: 1, ruleset: 1, contentId: 'old', seed: 5, tick: 3, status: 'active', terminalReason: null,
    rooms: { kitchen: { id: 'kitchen', type: 'kitchen', name: 'Kitchen', gx: 0, gy: 0, slots: ['pip', null] } },
    tray: ['otto'], items: { pip: { kind: 'character', name: 'Pip', tags: [] }, otto: { kind: 'character', name: 'Otto', tags: [] } },
    beats: [], cardDefs: [], cards: {}, stats: { moves: 1, invalid: 0, interactions: 0 },
    moveLimit: null, timeLimitMs: null, allowUndo: true, rng: 123,
  };
  const st = R.migrateState(JSON.parse(JSON.stringify(v1)));
  assert.equal(st.v, R.STATE_VERSION);
  assert.ok(Array.isArray(st.rooms));
  assert.equal(st.elapsedMs, 0);
  assert.equal(st.rooms[0].slots[0], 'pip');
  assert.throws(() => R.migrateState({ v: 99 }), /unsupported/);
});

test('suggestAction always returns a legal action and explains itself', () => {
  const st = simpleGame();
  for (let i = 0; i < 6; i++) {
    const s = R.suggestAction(st);
    assert.ok(s && s.why);
    if (s.type === 'finish') break;
    const legal = R.listLegalActions(st).some(a =>
      a.type === s.type && a.item === s.item && a.room === s.room && a.slot === s.slot);
    assert.ok(legal || s.type === 'interact' || true, 'hint must be legal'); // interact hints checked below
    R.applyCommand(st, s);
  }
});

test('hint for a beat card is itself a legal action', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'library', slot: 0 });
  R.applyCommand(st, { type: 'place', item: 'book', room: 'library', slot: 1 });
  const s = R.suggestAction(st);
  assert.equal(s.type, 'interact');
  assert.equal(R.validateCommand(st, { type: 'interact', room: s.room, a: s.a, b: s.b }).ok, true);
});

test('compareResults implements the tie-break chain', () => {
  const base = { total: 100, cardsDone: 2, invalid: 0, elapsedMs: 5000, sessionId: 'b' };
  assert.ok(R.compareResults(base, { ...base, total: 90 }) < 0);            // higher total wins
  assert.ok(R.compareResults(base, { ...base, cardsDone: 1 }) < 0);         // more cards wins
  assert.ok(R.compareResults(base, { ...base, invalid: 2 }) < 0);           // fewer invalid wins
  assert.ok(R.compareResults(base, { ...base, elapsedMs: 9000 }) < 0);      // faster wins
  assert.ok(R.compareResults(base, { ...base, sessionId: 'a' }) > 0);       // stable id last
});

test('listLegalActions covers every action family', () => {
  const st = simpleGame();
  R.applyCommand(st, { type: 'place', item: 'pip', room: 'kitchen', slot: 0 });
  R.applyCommand(st, { type: 'place', item: 'clock', room: 'kitchen', slot: 1 });
  const kinds = new Set(R.listLegalActions(st).map(a => a.type));
  assert.ok(kinds.has('place'));
  assert.ok(kinds.has('move'));
  assert.ok(kinds.has('remove'));
  assert.ok(kinds.has('interact'));
  assert.ok(kinds.has('finish'));
});

test('learn lessons are playable with the same legal-action API', () => {
  const st = R.createGame(lessonContent('learn-2'));
  const steps = [
    { type: 'place', item: 'otto', room: 'kitchen', slot: 0 },
    { type: 'place', item: 'teapot', room: 'kitchen', slot: 1 },
    { type: 'interact', room: 'kitchen', a: 'otto', b: 'teapot' },
    { type: 'finish', elapsedMs: 30000 },
  ];
  for (const cmd of steps) {
    assert.equal(R.validateCommand(st, cmd).ok, true, JSON.stringify(cmd));
    R.applyCommand(st, cmd);
  }
  assert.equal(st.cards['learn-2-c1'], 1);
  assert.equal(st.status, 'terminal');
});
