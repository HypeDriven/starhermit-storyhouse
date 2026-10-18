import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectPreset, resolve, presetTier, choosePreset, describe, CATEGORIES, PRESETS,
  detectLevel, presetForLevel, budgetFor, particleCap, LEVELS, BUDGETS, PARTICLE_MAX, MOTE_MAX,
} from '../src/gfx.js';
import { migrateSettings } from '../src/persist.js';
import { GFX_STRINGS, gfxLocale } from '../src/gfx-i18n.js';
// src/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../src/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M2', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'seg', 'particles', 'motes', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
    if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('balanced', 9).motes > budgetFor('balanced', 4).motes, 'counts scale up within the preset');
  assert.ok(budgetFor('ultra', 20).particles <= PARTICLE_MAX && budgetFor('ultra', 20).motes <= MOTE_MAX);
  assert.equal(particleCap(resolve({ preset: 'high' }, 'low', 10)), BUDGETS.high.particles);
  assert.equal(particleCap(resolve({ preset: 'low' }, 'low', 0)), BUDGETS.low.particles / 4, 'Low: Particles low = ¼');
  assert.equal(resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
});

test('resolve: auto follows detection, presets fill every category', () => {
  const r = resolve({}, 'low');
  assert.equal(r.preset, 'low');
  assert.equal(r.auto, true);
  for (const cat of Object.keys(CATEGORIES)) assert.equal(r[cat], presetTier('low', cat));
  assert.equal(r.post, false, 'Low renders without a post chain');
  assert.equal(r.adaptive, true);
  assert.equal(r.showFps, false);
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.post, true);
});

test('resolve: overrides win, invalid overrides fall back to the preset', () => {
  const r = resolve({ preset: 'high', bloom: 'off', shadows: 'nonsense' }, 'low');
  assert.equal(r.bloom, 'off');
  assert.equal(r.shadows, presetTier('high', 'shadows'));
});

test('resolve: render scale is clamped to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'high', render_scale: 1.5 }).scale, 1.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
});

test('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
  const s = choosePreset({ preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'low');
  assert.equal(s.preset, 'low');
  for (const cat of Object.keys(CATEGORIES)) assert.equal(s[cat], undefined);
  assert.equal(s.render_scale, 1.5);
  assert.equal(s.adaptive, false);
  assert.equal(s.show_fps, true);
  assert.equal(choosePreset({}, 'auto').preset, 'auto');
});

test('describe summarises cost and pixels', () => {
  const d = describe(resolve({ preset: 'high' }), [1280, 800]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows/);
});

test('legacy quality setting migrates to a gfx preset', () => {
  assert.equal(migrateSettings({ v: 1, quality: 'medium' }).gfx.preset, 'balanced');
  assert.equal(migrateSettings({ v: 1, quality: 'auto' }).gfx.preset, 'auto');
  assert.equal(migrateSettings({ v: 1, gfx: { preset: 'ultra', bloom: 'off' } }).gfx.bloom, 'off');
  assert.equal(migrateSettings(null).gfx.preset, 'auto');
});

test('graphics strings exist for every locale and category', () => {
  for (const tag of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    const t = GFX_STRINGS[tag];
    assert.ok(t, tag);
    for (const p of PRESETS) assert.ok(t.presets[p], `${tag} preset ${p}`);
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      assert.ok(t.cats[cat], `${tag} category ${cat}`);
      for (const tier of tiers) assert.ok(t.tiers[tier], `${tag} tier ${tier}`);
    }
    for (const k of ['quality', 'auto', 'renderScale', 'fromPreset', 'adaptive', 'showFps', 'postFailed']) assert.ok(t[k], `${tag} ${k}`);
  }
  assert.equal(gfxLocale('es-MX'), 'es-419');
  assert.equal(gfxLocale('es-ES'), 'es-ES');
  assert.equal(gfxLocale('fr-CA'), 'fr-CA');
  assert.equal(gfxLocale('en-GB'), 'en-GB');
  assert.equal(gfxLocale('ja-JP'), 'en-US');
});
