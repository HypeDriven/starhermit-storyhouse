// persist.test.js — settings/progress document migrations and checksums.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings, migrateSettings, defaultProgress, migrateProgress,
  sealProgress, verifyProgress, checksumDoc,
} from '../src/persist.js';

test('settings: defaults are complete and valid', () => {
  const s = defaultSettings();
  assert.equal(s.v, 1);
  assert.ok(s.bindings.confirm.includes('Enter'));
  assert.ok(Number.isInteger(s.gamepad.confirm));
});

test('settings: partial old documents gain missing keys', () => {
  const s = migrateSettings({ v: 1, music: 20, bindings: { hint: ['x'] } });
  assert.equal(s.music, 20);
  assert.deepEqual(s.bindings.hint, ['x']);
  assert.deepEqual(s.bindings.undo, ['u']); // filled from defaults
  assert.equal(s.effects, 80);
  assert.equal(migrateSettings(null).v, 1);
});

test('progress: seal + verify round-trip', () => {
  const p = sealProgress({ ...defaultProgress(), scenesCount: 4 });
  assert.ok(verifyProgress(p));
  p.scenesCount = 5; // tamper
  assert.equal(verifyProgress(p), false);
});

test('progress: v0 documents migrate and reseal', () => {
  const v0 = {
    // pre-release shape: no lessons/beatsSeen/scenesCount, no checksum
    v: 0,
    journey: { 'journey-01': { stars: 2, score: 90 } },
    cardsCollected: ['journey-01/c1'],
    achievements: { 'first-scene': 1700000000000 },
    daysPlayed: ['2026-08-01'],
    lastDaily: null,
    bestScores: {},
  };
  const p = migrateProgress(v0);
  assert.equal(p.v, 1);
  assert.equal(p.journey['journey-01'].stars, 2);
  assert.deepEqual(p.lessons, {});
  assert.deepEqual(p.beatsSeen, []);
  assert.equal(p.scenesCount, 0);
  assert.ok(verifyProgress(p), 'migrated doc is checksummed');
});

test('progress: corrupted collections are repaired', () => {
  const p = migrateProgress({ v: 1, journey: 'junk', daysPlayed: 42, checksum: 'bad' });
  assert.deepEqual(p.journey, {});
  assert.deepEqual(p.daysPlayed, []);
  assert.ok(verifyProgress(p));
});

test('checksum ignores only the checksum field itself', () => {
  const a = defaultProgress();
  const b = { ...a, checksum: 'anything' };
  assert.equal(checksumDoc(a), checksumDoc(b));
});
