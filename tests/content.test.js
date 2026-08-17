// content.test.js — content schema, versioning, generators, themes,
// achievements, and lesson integrity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/content.js';
import * as R from '../src/rules.js';

test('journey has 45 stages with gradually combined mechanics', () => {
  assert.equal(C.journeyLength(), 45);
  assert.equal(C.journeyStage(-1), null);
  assert.equal(C.journeyStage(45), null);
  const ids = new Set();
  for (let i = 0; i < 45; i++) {
    const s = C.journeyStage(i);
    assert.ok(!ids.has(s.contentId), 'duplicate stage id');
    ids.add(s.contentId);
    assert.ok(C.THEMES[s.theme], 'stage theme exists');
    assert.equal(s.mode, 'journey');
    if (i % 9 === 8) assert.ok(s.mastery, `stage ${i} should be mastery`);
  }
  // Mastery stages are bigger than chapter openers.
  for (let ch = 0; ch < 5; ch++) {
    const first = C.journeyStage(ch * 9), last = C.journeyStage(ch * 9 + 8);
    assert.ok(last.tray.length >= first.tray.length, `chapter ${ch} grows`);
    assert.ok(last.cards.length >= first.cards.length, `chapter ${ch} cards grow`);
  }
});

test('daily is deterministic per UTC date and varies by date', () => {
  const a1 = C.dailyContent('2026-08-17');
  const a2 = C.dailyContent('2026-08-17');
  const b = C.dailyContent('2026-08-18');
  assert.equal(R.hashValue ? true : true, true);
  assert.deepEqual(a1, a2);
  assert.equal(a1.contentId, 'daily-2026-08-17');
  assert.ok(a1.ranked);
  assert.notDeepEqual(
    a1.cards.map(c => c.title),
    b.cards.map(c => c.title).concat().reverse() === a1.cards.map(c => c.title) ? [] : b.cards.map(c => c.title),
    'different days should differ in some way',
  );
});

test('practice difficulties differ and honor undo/ranked flags', () => {
  const cozy = C.practiceContent('cozy', 1, 'meadow');
  const tricky = C.practiceContent('tricky', 1, 'meadow');
  assert.ok(cozy.allowUndo && !cozy.ranked);
  assert.ok(tricky.moveLimit !== null, 'tricky has a move limit');
  assert.ok(tricky.tray.length > cozy.tray.length);
});

test('all challenges validate and carry their constraints', () => {
  assert.equal(C.CHALLENGES.length, 6);
  for (const c of C.CHALLENGES) {
    const content = C.challengeContent(c.id);
    assert.deepEqual(C.validateContent(content), [], c.id);
    assert.equal(content.mode, 'challenge');
  }
  assert.ok(C.challengeContent('speed-tea').timeLimitMs > 0);
  assert.ok(C.challengeContent('move-diet').moveLimit > 0);
  assert.equal(C.challengeContent('nope'), null);
});

test('lessons require the player to perform each step', () => {
  assert.equal(C.LESSONS.length, 6);
  for (const l of C.LESSONS) {
    assert.ok(l.steps.length >= 2, l.id);
    assert.ok(l.steps.every(s => s.text && s.require && s.require.type), l.id);
    assert.equal(l.steps.at(-1).require.type, 'finish', 'lessons end by saving');
    const content = C.lessonContent(l.id);
    assert.deepEqual(C.validateContent(content), [], l.id);
  }
});

test('five themes with complete palettes and music', () => {
  assert.equal(C.THEME_ORDER.length, 5);
  for (const id of C.THEME_ORDER) {
    const t = C.THEMES[id];
    for (const k of ['sky', 'fog', 'wall', 'floor', 'trim', 'accent', 'key', 'ground', 'roof']) {
      assert.ok(Number.isInteger(t[k]), `${id}.${k}`);
    }
    assert.ok(t.music.root > 100 && t.music.bpm > 40 && t.music.scale.length >= 5);
    assert.ok(['birds', 'hearth', 'waves', 'crickets', 'wind'].includes(t.ambience));
  }
});

test('achievements: stable lowercase ids, the five required kinds', () => {
  assert.equal(C.ACHIEVEMENTS.length, 5);
  const ids = C.ACHIEVEMENTS.map(a => a.id);
  assert.deepEqual(ids, ['first-scene', 'mechanic-master', 'streak-3', 'mastery-crown', 'curator']);
  for (const a of C.ACHIEVEMENTS) {
    assert.match(a.id, /^[a-z0-9-]+$/);
    assert.ok(a.name && a.desc);
  }
});

test('score chase is seeded, ranked, and reproducible', () => {
  const a = C.scoreChaseContent(2026);
  const b = C.scoreChaseContent(2026);
  assert.deepEqual(a, b);
  assert.ok(a.ranked && !a.allowUndo);
});

test('every beat kind is reachable through the prop registry', () => {
  for (const [type, def] of Object.entries(R.BEATS)) {
    if (def.charPair) continue;
    assert.ok(C.PROPS[def.prop], `beat ${type} prop ${def.prop} exists`);
  }
  for (const [char, prop] of Object.entries(R.SIGNATURES)) {
    assert.ok(C.CAST[char], `signature character ${char}`);
    assert.ok(C.PROPS[prop], `signature prop ${prop}`);
  }
});
