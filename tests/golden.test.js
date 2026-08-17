// golden.test.js — representative easy/medium/hard/interrupted/terminal
// sessions pinned to exact hashes and score breakdowns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/rules.js';
import { journeyStage, practiceContent, challengeContent, dailyContent, planContent } from '../src/content.js';

function run(content, cmds, interruptAt) {
  let st = R.createGame(content);
  const apply = (cmd) => R.applyCommand(st, cmd);
  if (interruptAt === undefined) {
    cmds.forEach(apply);
  } else {
    cmds.slice(0, interruptAt).forEach(apply);
    st = R.deserializeState(R.serializeState(st)); // quit + resume
    cmds.slice(interruptAt).forEach(apply);
  }
  return { hash: R.hashState(st), score: R.scoreState(st), reason: st.terminalReason, tick: st.tick };
}

test('golden: easy journey session', () => {
  const r = run(journeyStage(0), [
    { type: 'place', item: 'biscuit', room: 'kitchen', slot: 0 },
    { type: 'place', item: 'otto', room: 'library', slot: 0 },
    { type: 'place', item: 'book', room: 'library', slot: 1 },
    { type: 'interact', room: 'library', a: 'otto', b: 'book' },
    { type: 'place', item: 'telescope', room: 'garden', slot: 0 },
    { type: 'finish', elapsedMs: 95000 },
  ]);
  assert.equal(r.hash, '2182fa43');
  assert.equal(r.reason, 'scene-saved');
  assert.deepEqual(r.score, {
    moments: 16, discoveries: 34, coverage: 15, variety: 8, timeBonus: 0,
    total: 73, stars: 1, cardsDone: 2, cardsTotal: 2,
    beats: 1, moves: 5, invalid: 0, elapsedMs: 95000,
  });
});

test('golden: medium practice session', () => {
  const r = run(practiceContent('standard', 42, 'rosewood'), [
    { type: 'place', item: 'luna', room: 'parlor', slot: 0 },
    { type: 'place', item: 'piano', room: 'parlor', slot: 1 },
    { type: 'interact', room: 'parlor', a: 'luna', b: 'piano' },
    { type: 'place', item: 'biscuit', room: 'parlor', slot: 2 },
    { type: 'place', item: 'lamp', room: 'bedroom', slot: 0 },
    { type: 'place', item: 'telescope', room: 'attic', slot: 0 },
    { type: 'interact', room: 'parlor', a: 'luna', b: 'biscuit' },
    { type: 'finish', elapsedMs: 200000 },
  ]);
  assert.equal(r.hash, 'b6350ee1');
  assert.equal(r.score.total, 113);
  assert.equal(r.score.cardsDone, 3);
});

test('golden: hard challenge (grand gala) via planner solution', () => {
  const content = challengeContent('grand-gala');
  const plan = planContent(content);
  const r = run(content, [...plan.commands, { type: 'finish', elapsedMs: 240000 }]);
  assert.equal(r.hash, '56fde5a5');
  assert.equal(r.score.stars, 3);
  assert.equal(r.score.cardsDone, 4);
  assert.equal(r.score.total, 237);
});

test('golden: interrupted daily resumes to the continuous hash', () => {
  const content = dailyContent('2026-08-17');
  const plan = planContent(content);
  const cmds = [...plan.commands, { type: 'finish', elapsedMs: 180000 }];
  const continuous = run(content, cmds);
  const resumed = run(content, cmds, 3);
  assert.equal(continuous.hash, 'c5483758');
  assert.equal(resumed.hash, continuous.hash);
  assert.equal(resumed.score.total, 123);
});

test('golden: move-limit terminal session', () => {
  const content = challengeContent('move-diet');
  const plan = planContent(content);
  const r = run(content, [
    ...plan.commands,
    { type: 'move', item: 'book', room: 'parlor', slot: 0 },
    { type: 'move', item: 'book', room: 'bedroom', slot: 0 },
  ]);
  assert.equal(r.hash, '3f33b5a8');
  assert.equal(r.reason, 'move-limit');
  assert.equal(r.score.moves, 11);
  assert.equal(r.tick, 11);
});
