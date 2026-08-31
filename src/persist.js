// persist.js — DOM-free persistence helpers: settings defaults, versioned
// checksummed progress documents with migrations, and replay envelopes.
// Shared by the browser platform layer and by Node tests.
import { hashValue } from './rng.js';
import { hashState } from './rules.js';

export const SETTINGS_VERSION = 1;
export const PROGRESS_VERSION = 1;
export const REPLAY_SCHEMA = 1;

export function defaultSettings() {
  return {
    v: SETTINGS_VERSION,
    music: 70, effects: 80, ambience: 55, voice: 65,
    mute: false, captions: false,
    quality: 'auto',
    reducedMotion: false, highContrast: false, largeText: false,
    palette: 'default', lefty: false, dragMode: 'both',
    timingAssist: false, hapticsOff: false,
    telemetry: false,
    tutorialsDone: {},
    // Desktop action bindings; players may override. Touch stays responsive UI.
    bindings: {
      confirm: ['Enter', ' '],
      cancel: ['Escape'],
      pause: ['p', 'Escape'],
      undo: ['u'],
      hint: ['h'],
      camera: ['c'],
      mute: ['m'],
      left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
    },
    gamepad: {
      confirm: 0, cancel: 1, interact: 2, hint: 3,
      undo: 4, pause: 9, cycleRoomL: 6, cycleRoomR: 7,
    },
  };
}

export function migrateSettings(doc) {
  if (!doc || typeof doc !== 'object') return defaultSettings();
  const def = defaultSettings();
  if (doc.v === SETTINGS_VERSION) {
    // Tolerate missing keys from older/partial writes.
    return {
      ...def, ...doc,
      bindings: { ...def.bindings, ...(doc.bindings || {}) },
      gamepad: { ...def.gamepad, ...(doc.gamepad || {}) },
      tutorialsDone: { ...(doc.tutorialsDone || {}) },
    };
  }
  return { ...def, ...doc, v: SETTINGS_VERSION };
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
