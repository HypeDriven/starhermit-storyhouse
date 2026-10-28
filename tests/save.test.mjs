// The engine client's save document (src/savedoc.js): the browser build's
// cloud slot ({v:2, progress, scenes}, or a bare v1 progress doc) read as a
// foreign save, two devices' saves merged without losing either side, scene
// pictures kept when they are small PNG data URLs, and the old settings KV's
// game options carried over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readDoc, mergeDocs, canonical, cleanScene, legacyOptions, pickOption, LEGACY_KEYS, DEFAULT_OPTIONS } from '../src/savedoc.js';
import { defaultProgress, sealProgress, verifyProgress } from '../src/persist.js';

const prog = (patch) => sealProgress({ ...defaultProgress(), ...patch });
const scene = (id, savedAt, extra = {}) => ({ id, contentId: 'journey-1', label: 'Moving In', savedAt, score: 10, stars: 1, beats: [], cardsDone: 0, cardsTotal: 2, seed: 1, ...extra });

test('the browser build\'s cloud document reads as a save, bare progress too', () => {
  const p = prog({ journey: { 'journey-1': { stars: 2, score: 40 } }, scenesCount: 1 });
  const d = readDoc({ v: 2, progress: p, scenes: [scene('a', 5)] });
  assert.equal(d.progress.journey['journey-1'].stars, 2);
  assert.equal(d.scenes.length, 1);
  assert.ok(verifyProgress(d.progress));
  const bare = readDoc(p);
  assert.equal(bare.scenes.length, 0);
  assert.equal(bare.progress.scenesCount, 1);
  assert.equal(readDoc({ hello: 1 }), null);
  assert.equal(readDoc(null), null);
  // a tampered progress doc is repaired (migrated), not trusted
  const t = readDoc({ v: 2, progress: { ...p, checksum: 'x' }, scenes: [] });
  assert.ok(verifyProgress(t.progress));
});

test('two devices merge: best stars and scores, unions, earliest achievements, scenes by id newest first', () => {
  const a = { v: 2, progress: prog({ journey: { 'journey-1': { stars: 1, score: 50 } }, beatsSeen: ['melody'], achievements: { 'first-scene': 200 }, scenesCount: 3 }), scenes: [scene('a', 10), scene('b', 30)] };
  const b = { v: 2, progress: prog({ journey: { 'journey-1': { stars: 3, score: 20 }, 'journey-2': { stars: 1, score: 5 } }, beatsSeen: ['snack'], achievements: { 'first-scene': 100 }, scenesCount: 2 }), scenes: [scene('b', 30), scene('c', 20)] };
  const m = mergeDocs(a, b);
  assert.deepEqual(m.progress.journey['journey-1'], { stars: 3, score: 50 });
  assert.ok(m.progress.journey['journey-2']);
  assert.deepEqual([...m.progress.beatsSeen].sort(), ['melody', 'snack']);
  assert.equal(m.progress.achievements['first-scene'], 100);
  assert.equal(m.progress.scenesCount, 3);
  assert.deepEqual(m.scenes.map((s) => s.id), ['b', 'c', 'a']);
  assert.ok(verifyProgress(m.progress));
  assert.equal(canonical(mergeDocs(m, m)), canonical(m)); // merging again changes nothing
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), canonical({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

test('scrapbooks cap at 30 scenes and keep only small PNG pictures', () => {
  const many = Array.from({ length: 40 }, (_, i) => scene(`s${i}`, i));
  assert.equal(mergeDocs({ v: 2, progress: prog({}), scenes: many }, null).scenes.length, 30);
  assert.ok(cleanScene(scene('p', 1, { thumbnail: 'data:image/png;base64,AAAA' })).thumbnail);
  assert.equal(cleanScene(scene('p', 1, { thumbnail: 'data:image/jpeg;base64,AAAA' })).thumbnail, undefined);
  assert.equal(cleanScene(scene('p', 1, { thumbnail: 'data:image/png;base64,' + 'A'.repeat(500000) })).thumbnail, undefined);
});

test('the old settings KV: the game options carry over, the rest is the runtime\'s', () => {
  const kv = { music: 40, captions: true, palette: 'deutan', lefty: true, dragMode: 'tap', gfx: { preset: 'high' }, hapticsOff: 'yes', mute: false };
  assert.deepEqual(legacyOptions(kv), { captions: true, palette: 'deutan', lefty: true, dragMode: 'tap', mute: false });
  assert.equal(pickOption('palette', 'neon'), undefined);
  assert.equal(pickOption('music', 3), undefined);
  for (const k of Object.keys(DEFAULT_OPTIONS)) if (k !== 'telemetry') assert.ok(LEGACY_KEYS.includes(k), k);
});
