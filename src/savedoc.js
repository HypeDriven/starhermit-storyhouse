// savedoc.js — the engine client's save document, pure (shared with node
// tests): { v: 2, progress, scenes } as the browser build kept it in its
// cloud slot, read from any document the game ever saved, merged across
// devices without dropping either side, and the game's options read from the
// browser build's settings KV.
import { verifyProgress, migrateProgress, sealProgress, defaultProgress, mergeProgress, mergeScenes } from './persist.js';

export const SCENE_CAP = 30;

/** A scene, keeping its picture only when it is a small PNG data URL (what the old and new builds make). */
export function cleanScene(s) {
  if (!s || typeof s !== 'object') return s;
  const t = s.thumbnail;
  if (t == null || (typeof t === 'string' && t.startsWith('data:image/png;base64,') && t.length < 400000)) return s;
  const { thumbnail, ...rest } = s;
  return rest;
}

/** Any saved document ({v:2, progress, scenes}, or a bare v1 progress doc) → a clean document, or null. */
export function readDoc(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let progress = null, scenes = [];
  if (raw.v === 2) {
    progress = verifyProgress(raw.progress) ? raw.progress : (raw.progress ? migrateProgress(raw.progress) : null);
    scenes = Array.isArray(raw.scenes) ? raw.scenes.filter((s) => s && typeof s === 'object' && s.id).map(cleanScene) : [];
  } else if (verifyProgress(raw)) progress = raw;
  else return null;
  return { v: 2, progress: progress ?? sealProgress(defaultProgress()), scenes: mergeScenes(scenes, [], SCENE_CAP) };
}

/** Two documents merged (neither side's progress or scenes dropped). */
export function mergeDocs(a, b) {
  return {
    v: 2,
    progress: sealProgress(mergeProgress(a?.progress ?? null, b?.progress ?? null)),
    scenes: mergeScenes(a?.scenes ?? [], b?.scenes ?? [], SCENE_CAP),
  };
}

/** Canonical JSON (key order does not matter). */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

// ---- the game's options
export const DEFAULT_OPTIONS = {
  captions: false, palette: 'default', lefty: false, dragMode: 'both', timingAssist: false, hapticsOff: false, mute: false, telemetry: false,
};
const PALETTES = ['default', 'protan', 'deutan', 'tritan'];
const DRAG_MODES = ['both', 'tap', 'drag'];
/** A stored value for an option, or undefined when it is not one. */
export function pickOption(key, v) {
  if (key === 'palette') return PALETTES.includes(v) ? v : undefined;
  if (key === 'dragMode') return DRAG_MODES.includes(v) ? v : undefined;
  if (!(key in DEFAULT_OPTIONS)) return undefined;
  return typeof v === 'boolean' ? v : undefined;
}
/** The browser build's settings KV keys (platform.js PREF_KEYS). */
export const LEGACY_KEYS = ['music', 'effects', 'ambience', 'voice', 'mute', 'captions', 'gfx', 'reducedMotion', 'highContrast', 'largeText',
  'palette', 'lefty', 'dragMode', 'timingAssist', 'hapticsOff', 'tutorialsDone', 'gamepad'];
/** The old KV's values this game keeps as options. */
export function legacyOptions(kv) {
  const out = {};
  for (const k of Object.keys(DEFAULT_OPTIONS)) {
    if (!(k in kv)) continue;
    const v = pickOption(k, kv[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
