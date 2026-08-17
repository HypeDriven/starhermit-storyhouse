// replay.test.js — property tests: same version + seed + commands → identical
// state hashes, across generated content, random play, interruption/resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/rules.js';
import { RngStream, deriveSeed } from '../src/rng.js';
import { practiceContent, scoreChaseContent, dailyContent, journeyStage, planContent } from '../src/content.js';

/** Play a random legal game, returning the command log and final hash. */
function randomSession(content, seed, maxCommands = 60) {
  const rng = new RngStream(seed);
  const st = R.createGame(content);
  const commands = [];
  let guard = maxCommands;
  while (st.status === 'active' && guard-- > 0) {
    const legal = R.listLegalActions(st);
    // Bias toward not finishing immediately.
    const pool = legal.filter(a => a.type !== 'finish');
    const pick = (pool.length && rng.next() < 0.92) ? pool[rng.int(0, pool.length - 1)] : legal[rng.int(0, legal.length - 1)];
    const cmd = { ...pick };
    if (cmd.type === 'finish' || cmd.type === 'timeout') cmd.elapsedMs = rng.int(1000, 600000);
    R.applyCommand(st, cmd);
    commands.push(cmd);
  }
  if (st.status === 'active') {
    const fin = { type: 'finish', elapsedMs: rng.int(1000, 600000) };
    R.applyCommand(st, fin);
    commands.push(fin);
  }
  return { commands, hash: R.hashState(st) };
}

function replay(content, commands) {
  const st = R.createGame(content);
  for (const cmd of commands) R.applyCommand(st, JSON.parse(JSON.stringify(cmd)));
  return R.hashState(st);
}

test('deterministic replay across content families and seeds', () => {
  const contents = [
    practiceContent('cozy', 11, 'meadow'),
    practiceContent('standard', 22, 'rosewood'),
    practiceContent('tricky', 33, 'nightfall'),
    scoreChaseContent(99),
    dailyContent('2026-08-17'),
    journeyStage(12),
  ];
  for (const content of contents) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = randomSession(content, deriveSeed(content.contentId, seed));
      const b = replay(content, a.commands);
      const c = randomSession(content, deriveSeed(content.contentId, seed));
      assert.equal(b, a.hash, `replay mismatch ${content.contentId} seed ${seed}`);
      assert.equal(c.hash, a.hash, `same-seed sessions must be identical ${content.contentId} seed ${seed}`);
    }
  }
});

test('interrupted sessions resume to identical hashes', () => {
  const content = scoreChaseContent(4242);
  const full = randomSession(content, 777);
  for (const cut of [0, 1, 3, Math.floor(full.commands.length / 2)]) {
    const st = R.createGame(content);
    for (const cmd of full.commands.slice(0, cut)) R.applyCommand(st, cmd);
    const restored = R.deserializeState(R.serializeState(st));
    for (const cmd of full.commands.slice(cut)) R.applyCommand(restored, cmd);
    assert.equal(R.hashState(restored), full.hash, `resume at ${cut} diverged`);
  }
});

test('planner solutions replay to identical scores', () => {
  for (const i of [0, 9, 21, 34, 44]) {
    const content = journeyStage(i);
    const plan = planContent(content);
    const st = R.createGame(content);
    for (const cmd of plan.commands) R.applyCommand(st, cmd);
    R.applyCommand(st, { type: 'finish', elapsedMs: 120000 });
    const st2 = R.createGame(content);
    for (const cmd of plan.commands) R.applyCommand(st2, cmd);
    R.applyCommand(st2, { type: 'finish', elapsedMs: 120000 });
    assert.equal(R.hashState(st), R.hashState(st2));
    assert.deepEqual(R.scoreState(st), R.scoreState(st2));
  }
});

test('different seeds diverge (sanity that hashing sees real differences)', () => {
  const content = practiceContent('standard', 22, 'rosewood');
  const a = randomSession(content, 1);
  const b = randomSession(content, 2);
  assert.notEqual(a.hash, b.hash);
});
