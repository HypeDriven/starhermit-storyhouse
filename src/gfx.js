// gfx.js — graphics quality model: presets, per-category overrides, StarHermit
// hardware-level detection, per-preset asset/effect budgets and a cost summary. Pure (no three.js, no DOM) so the settings
// panel, the renderer and Node tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  detail: ['plain', 'detailed'],
  particles: ['low', 'high'],
  backdrop: ['off', 'static', 'animated'],
};

// Each preset is a row of tiers, a device-pixel-ratio cap and a render scale.
const TABLE = {
  low: { cap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low', backdrop: 'off' },
  balanced: { cap: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'high', backdrop: 'static' },
  high: { cap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', backdrop: 'animated' },
  ultra: { cap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', backdrop: 'animated' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; src/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones and tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Rooms, slots, pieces,
 * picking and rules are identical on every preset — only visuals change.
 *   material  house, tray and piece shading: lambert (Low) / standard (Balanced) / physical clear-coated
 *             glazed and lacquered pieces (High, Ultra)
 *   seg       curved-mesh segment multiplier (characters, props, room dressing, ground)
 *   particles spark pool at Particles "high" (low: a quarter), scaled with the level
 *   motes     dust motes drifting through the rooms (Particles high), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', seg: 0.6, particles: 800, motes: 60, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', seg: 0.8, particles: 2000, motes: 100, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', seg: 1, particles: 4000, motes: 140, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', seg: 1.5, particles: 5000, motes: 220, bloomRes: 1, aoRes: 1 },
};
export const PARTICLE_MAX = 7500;
export const MOTE_MAX = 330;
const PARTICLE_SHARE = { low: 0.25, high: 1 };

/** A preset's concrete budget for a hardware level (spark and mote counts scale ≤ 1.5× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(1.5, G.scaleBudget(1, lv, floor)) : 1;
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return b;
}

/** Live spark pool for a resolved setting (Particles tier share of the preset's budget). */
export function particleCap(r) {
  return Math.round(r.budget.particles * (PARTICLE_SHARE[r.particles] ?? 0));
}

/** Saved graphics settings with defaults filled in. */
export function defaultGfx() {
  return { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false };
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, cap: row.cap, renderScale, scale: row.scale * renderScale };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas's own MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every per-category override (scale/adaptive/fps are kept). */
export function choosePreset(saved, preset) {
  const s = { ...defaultGfx(), ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete s[cat];
  s.preset = PRESETS.includes(preset) ? preset : 'auto';
  return s;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

const SUMMARY_WORDS = {
  shadows: '{n}² shadows', noShadows: 'no shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
  bloom: 'bloom', reflections: 'reflections', noAa: 'no anti-aliasing',
};

/**
 * Short cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · 2560×1600 px".
 * `words` lets the settings panel pass localized fragments.
 */
export function describe(r, pixels, words = SUMMARY_WORDS) {
  const w = { ...SUMMARY_WORDS, ...words };
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    r.antialias === 'off' ? w.noAa : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
