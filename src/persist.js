// persist.js — DOM-free persistence helpers: settings defaults, versioned
// checksummed progress documents with migrations, and replay envelopes.
// Shared by the browser platform layer and by Node tests.
import { hashValue } from './rng.js';
import { hashState } from './rules.js';
import { defaultGfx, PRESETS } from './gfx.js';

export const SETTINGS_VERSION = 1;
export const PROGRESS_VERSION = 1;
export const REPLAY_SCHEMA = 1;

export function defaultSettings() {
  return {
    v: SETTINGS_VERSION,
    music: 70, effects: 80, ambience: 55, voice: 65,
    mute: false, captions: false,
    // Graphics quality model (see gfx.js): preset + per-category overrides.
    gfx: defaultGfx(),
    reducedMotion: false, highContrast: false, largeText: false,
    palette: 'default', lefty: false, dragMode: 'both',
    timingAssist: false, hapticsOff: false,
    telemetry: false,
    tutorialsDone: {},
    // Desktop action bindings as KeyboardEvent.code values (mirrors the
    // control.* lines in starhermit.txt); players may override. Touch stays
    // responsive UI.
    bindings: defaultBindings(),
    gamepad: {
      confirm: 0, cancel: 1, interact: 2, hint: 3,
      undo: 4, pause: 9, cycleRoomL: 6, cycleRoomR: 7,
    },
  };
}

export function defaultBindings() {
  return {
    confirm: ['Enter', 'Space'],
    cancel: ['Escape'],
    pause: ['KeyP'],
    undo: ['KeyU'],
    hint: ['KeyH'],
    camera: ['KeyC'],
    mute: ['KeyM'],
    left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
  };
}

/** Older builds stored KeyboardEvent.key values ('u', ' '); map to codes. */
export function keyToCode(k) {
  k = String(k);
  if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  if (k === ' ') return 'Space';
  return k;
}
function migrateBindings(b) {
  const out = defaultBindings();
  for (const [action, keys] of Object.entries(b || {})) {
    if (!Array.isArray(keys) || !keys.length) continue;
    out[action] = [...new Set(keys.map(keyToCode))];
  }
  // Escape is the cancel action (which also pauses); one action per code.
  if (out.pause.includes('Escape') && out.cancel.includes('Escape')) {
    out.pause = out.pause.filter(c => c !== 'Escape');
    if (!out.pause.length) out.pause = ['KeyP'];
  }
  return out;
}

/** Short on-screen label for a KeyboardEvent.code. */
export function codeLabel(code) {
  const c = String(code);
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  return { Escape: 'Esc', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[c] || c;
}

export function migrateSettings(doc) {
  if (!doc || typeof doc !== 'object') return defaultSettings();
  const def = defaultSettings();
  if (doc.v === SETTINGS_VERSION) {
    // Tolerate missing keys from older/partial writes.
    return {
      ...def, ...doc,
      bindings: migrateBindings(doc.bindings),
      gamepad: { ...def.gamepad, ...(doc.gamepad || {}) },
      tutorialsDone: { ...(doc.tutorialsDone || {}) },
      gfx: migrateGfx(doc),
    };
  }
  return { ...def, ...doc, v: SETTINGS_VERSION, bindings: migrateBindings(doc.bindings), gfx: migrateGfx(doc) };
}

// Older builds stored a single `quality` tier (auto/high/medium/low).
const LEGACY_QUALITY = { high: 'high', medium: 'balanced', low: 'low' };
function migrateGfx(doc) {
  const gfx = { ...defaultGfx(), ...(doc.gfx && typeof doc.gfx === 'object' ? doc.gfx : {}) };
  if (!doc.gfx && LEGACY_QUALITY[doc.quality]) gfx.preset = LEGACY_QUALITY[doc.quality];
  if (gfx.preset !== 'auto' && !PRESETS.includes(gfx.preset)) gfx.preset = 'auto';
  return gfx;
}

export function defaultProgress() {
  return {
    v: PROGRESS_VERSION,
    journey: {},            // contentId -> {stars, score}
    lessons: {},            // lessonId -> true
    cardsCollected: [],     // "contentId/cardId" — the discovery collection
    beatsSeen: [],          // beat types ever triggered (mastery)
    achievements: {},       // id -> timestamp (idempotent unlocks)
    daysPlayed: [],         // UTC dates for the streak achievement
    lastDaily: null,        // {date, total}
    bestScores: {},         // contentId -> total
    scenesCount: 0,
    checksum: '',
  };
}

export function checksumDoc(doc) {
  const { checksum, ...rest } = doc;
  return hashValue(rest);
}
export function sealProgress(doc) {
  return { ...doc, checksum: checksumDoc(doc) };
}
export function verifyProgress(doc) {
  return doc && typeof doc === 'object' && doc.checksum === checksumDoc(doc);
}

export function migrateProgress(raw) {
  if (!raw || typeof raw !== 'object') return defaultProgress();
  const def = defaultProgress();
  // v0 (pre-release) lacked lessons/beatsSeen/scenesCount.
  const merged = { ...def, ...raw, v: PROGRESS_VERSION };
  for (const k of ['journey', 'lessons', 'achievements', 'bestScores']) {
    if (!merged[k] || typeof merged[k] !== 'object') merged[k] = {};
  }
  for (const k of ['cardsCollected', 'beatsSeen', 'daysPlayed']) {
    if (!Array.isArray(merged[k])) merged[k] = [];
  }
  return sealProgress(merged);
}

// ---------------------------------------------------------------------------
// Replay envelope — everything needed to reproduce and audit a session.
// Spec §5: schema/build/content versions, seed, initial hash, timestamp
// offset, ordered commands (accepted AND rejected — rejections mutate
// stats.invalid), periodic state hashes, and the hashed terminal result.
// ---------------------------------------------------------------------------
export function makeReplayEnvelope({ build, contentVersion, ruleset, content, sessionId, commands, hashes, initialState, state, score, timestampOffset = 0 }) {
  return {
    schema: REPLAY_SCHEMA,
    build, contentVersion, ruleset,
    contentId: content.contentId,
    seed: content.seed,
    mode: content.mode,
    sessionId,
    initialHash: initialState ? hashState(initialState) : null,
    timestampOffset,
    commands,
    hashes,            // periodic state hashes
    result: {
      reason: state.terminalReason,
      hash: hashState(state),
      score,
    },
  };
}
