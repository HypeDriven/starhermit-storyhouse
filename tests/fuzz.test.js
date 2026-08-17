// fuzz.test.js — malformed commands and generated content: no hangs, no NaN,
// no impossible mandatory states, no unbounded loops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/rules.js';
import { RngStream } from '../src/rng.js';
import { practiceContent, scoreChaseContent, dailyContent, validateContent, journeyStage } from '../src/content.js';

const MALFORMED = [
  null, undefined, 42, 'place', [], {}, { type: null }, { type: 7 },
  { type: 'place' }, { type: 'place', item: null, room: null, slot: null },
  { type: 'place', item: 'pip', room: 'kitchen', slot: -1 },
  { type: 'place', item: 'pip', room: 'kitchen', slot: 1e9 },
  { type: 'place', item: 'pip', room: 'kitchen', slot: NaN },
  { type: 'place', item: 'pip'.repeat(5000), room: 'kitchen', slot: 0 },
  { type: 'move', item: {}, room: ['x'], slot: '0' },
  { type: 'remove' }, { type: 'interact' },
  { type: 'interact', a: 'pip', b: 'pip', room: 'kitchen' },
  { type: 'interact', a: 'pip', b: 'otto', room: null },
  { type: 'finish', elapsedMs: -5 }, { type: 'finish', elapsedMs: 'fast' },
  { type: 'timeout', elapsedMs: Infinity },
  { type: 'place', item: '__proto__', room: 'constructor', slot: 0 },
];

test('malformed commands never throw, never hang, only count as invalid', () => {
  const content = practiceContent('cozy', 5, 'meadow');
  const st = R.createGame(content);
  const hashBefore = R.hashState(st);
  const t0 = Date.now();
  for (const cmd of MALFORMED) {
    const r = R.applyCommand(st, cmd);
    assert.ok(r.events.some(e => e.type === 'invalid'), JSON.stringify(cmd));
  }
  assert.ok(Date.now() - t0 < 1000, 'fuzz loop too slow');
  assert.equal(st.stats.invalid, MALFORMED.length);
  assert.equal(st.tick, 0);
  // State unchanged apart from the invalid counter.
  const st2 = R.createGame(content);
  st2.stats.invalid = MALFORMED.length;
  assert.equal(R.hashState(st), R.hashState(st2));
});

test('random command soup keeps the engine consistent', () => {
  const rng = new RngStream(1234);
  const content = practiceContent('standard', 5, 'meadow');
  const st = R.createGame(content);
  const types = ['place', 'move', 'remove', 'interact', 'finish', 'timeout', 'bogus'];
  const items = [...content.tray, 'ghost', null, 7];
  const rooms = [...content.layout.rooms.map(r => r.id), 'nowhere', null];
  let guard = 500;
  while (st.status === 'active' && guard-- > 0) {
    const cmd = {
      type: types[rng.int(0, types.length - 1)],
      item: items[rng.int(0, items.length - 1)],
      room: rooms[rng.int(0, rooms.length - 1)],
      slot: rng.int(-2, 8),
      a: items[rng.int(0, items.length - 1)],
      b: items[rng.int(0, items.length - 1)],
      elapsedMs: rng.int(-100, 100000),
    };
    R.applyCommand(st, cmd);
    // Invariants after every single command.
    assert.ok(Number.isInteger(st.tick) && st.tick >= 0);
    assert.ok(Number.isInteger(st.stats.moves) && st.stats.moves >= 0);
    const s = R.scoreState(st);
    assert.ok(Number.isFinite(s.total) && !Number.isNaN(s.total));
    // Every placed item exists; no item is in two places.
    const seen = new Set();
    for (const room of st.rooms) for (const slot of room.slots) {
      if (slot === null) continue;
      assert.ok(st.items[slot], 'unknown item placed: ' + slot);
      assert.ok(!seen.has(slot), 'item duplicated: ' + slot);
      seen.add(slot);
    }
    for (const key of st.tray) assert.ok(!seen.has(key), 'item both placed and on tray: ' + key);
    assert.equal(seen.size + st.tray.length, Object.keys(st.items).length);
  }
  assert.ok(guard > -500);
});

test('generated content validates across wide seed sweeps', () => {
  for (let seed = 1; seed <= 60; seed++) {
    for (const diff of ['cozy', 'standard', 'tricky']) {
      const problems = validateContent(practiceContent(diff, seed, 'meadow'));
      assert.deepEqual(problems, [], `practice ${diff} seed ${seed}: ${problems.join('; ')}`);
    }
    const sc = scoreChaseContent(seed);
    assert.deepEqual(validateContent(sc), [], `score seed ${seed}`);
  }
  // A year of dailies, sampled weekly.
  for (let d = 1; d <= 365; d += 7) {
    const date = new Date(Date.UTC(2026, 0, d)).toISOString().slice(0, 10);
    const problems = validateContent(dailyContent(date));
    assert.deepEqual(problems, [], `daily ${date}: ${problems.join('; ')}`);
  }
  // Every journey stage.
  for (let i = 0; i < 45; i++) {
    assert.deepEqual(validateContent(journeyStage(i)), [], `journey ${i}`);
  }
});

test('validators catch defective content', () => {
  const good = practiceContent('cozy', 9, 'meadow');
  const noChar = JSON.parse(JSON.stringify(good));
  noChar.tray = noChar.tray.filter(k => noChar.items[k].kind !== 'character');
  assert.ok(validateContent(noChar).some(p => p.includes('no characters')));
  const badCard = JSON.parse(JSON.stringify(good));
  badCard.cards[0].when = { kind: 'beat', beat: 'no-such-beat' };
  assert.ok(validateContent(badCard).some(p => p.includes('unknown beat')));
  const badPar = JSON.parse(JSON.stringify(good));
  badPar.par = [10, 20, 999999];
  assert.ok(validateContent(badPar).some(p => p.includes('max score')));
  const badLimit = JSON.parse(JSON.stringify(good));
  badLimit.moveLimit = 1;
  assert.ok(validateContent(badLimit).length > 0, 'impossible move limit must be flagged');
});
