import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, choosePreset, describe, CATEGORIES, PRESETS } from '../src/gfx.js';
import { migrateSettings } from '../src/persist.js';
import { GFX_STRINGS, gfxLocale } from '../src/gfx-i18n.js';

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(detectPreset('Google SwiftShader'), 'low');
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 640'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('touch/mobile devices cap Auto at balanced', () => {
  assert.equal(detectPreset('Apple M1', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
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
