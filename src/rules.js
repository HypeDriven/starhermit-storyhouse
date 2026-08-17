// rules.js — Storyhouse rules engine.
// Pure, deterministic, DOM-free, Node-free. Every state transition goes through
// validateCommand/applyCommand; tutorials and hints call the same legal-action
// API as play. State is JSON-serializable and hashable for replays.

import { RngStream, hashValue } from './rng.js';

export const RULESET_VERSION = 1;
export const STATE_VERSION = 2;

// ---------------------------------------------------------------------------
// Beat registry — the interactions that turn placements into story moments.
// A beat needs exactly one character and one prop, or two characters.
// ---------------------------------------------------------------------------
export const BEATS = {
  'story-time':    { prop: 'book',      points: 10, habitat: 'library', habitatBonus: 6, label: 'Story time' },
  'tea-break':     { prop: 'teapot',    points: 10, habitat: 'kitchen', habitatBonus: 6, label: 'Tea break' },
  'melody':        { prop: 'piano',     points: 10, habitat: 'parlor',  habitatBonus: 6, label: 'Melody' },
  'green-thumb':   { prop: 'fern',      points: 10, habitat: 'garden',  habitatBonus: 6, label: 'Green thumb' },
  'catnap':        { prop: 'bed',       points: 10, habitat: 'bedroom', habitatBonus: 6, label: 'Catnap' },
  'stargazing':    { prop: 'telescope', points: 10, habitat: 'attic',   habitatBonus: 6, label: 'Stargazing' },
  'bright-idea':   { prop: 'lamp',      points: 10, habitat: null,      habitatBonus: 0, label: 'Bright idea' },
  'snack':         { prop: 'basket',    points: 10, habitat: 'kitchen', habitatBonus: 6, label: 'Snack' },
  'time-check':    { prop: 'clock',     points: 10, habitat: null,      habitatBonus: 0, label: 'Time check' },
  'playtime':      { prop: 'yarn',      points: 10, habitat: null,      habitatBonus: 0, label: 'Playtime' },
  'heart-to-heart':{ charPair: true,    points: 12, habitat: 'parlor',  habitatBonus: 4, label: 'Heart to heart' },
};
// Signature props: a character's personal favorite — worth a bonus.
export const SIGNATURES = { pip: 'clock', mabel: 'fern', otto: 'basket', luna: 'telescope', biscuit: 'yarn' };
export const SIGNATURE_BONUS = 6;

export const COVERAGE_PER_ROOM = 5;
export const VARIETY_PER_TYPE = 8;
export const TIME_BONUS_PER_SEC = 2;

const VALID_CMDS = new Set(['place', 'move', 'remove', 'interact', 'finish', 'timeout']);

// ---------------------------------------------------------------------------
// Game creation
// ---------------------------------------------------------------------------
/**
 * @param content versioned content descriptor:
 *  { contentId, seed, layout:{id, rooms:[{id,type,name,gx,gy,slots}]},
 *    items:{key:{kind:'character'|'prop',name,tags:[]}}, tray:[keys],
 *    cards:[{id,title,text,points,when}], moveLimit, timeLimitMs, timeBonus,
 *    parTimeMs, par:[s1,s2,s3], allowUndo, ranked }
 */
export function createGame(content) {
  const rooms = content.layout.rooms.map(r => ({
    id: r.id, type: r.type, name: r.name, gx: r.gx, gy: r.gy,
    slots: new Array(r.slots).fill(null),
  }));
  const cards = {};
  for (const c of content.cards) cards[c.id] = 0;
  const state = {
    v: STATE_VERSION,
    ruleset: RULESET_VERSION,
    contentId: content.contentId,
    seed: content.seed >>> 0,
    tick: 0,
    status: 'active',            // 'active' | 'terminal'
    terminalReason: null,        // 'scene-saved' | 'move-limit' | 'time-up'
    rooms,
    tray: content.tray.slice(),
    items: JSON.parse(JSON.stringify(content.items)),
    beats: [],                   // {t, room, a, b, pts, sig, hab, flavor}
    cardDefs: content.cards.map(c => ({ ...c, when: { ...c.when } })),
    cards,
    stats: { moves: 0, invalid: 0, interactions: 0 },
    moveLimit: content.moveLimit ?? null,
    timeLimitMs: content.timeLimitMs ?? null,
    timeBonus: !!content.timeBonus,
    parTimeMs: content.parTimeMs ?? null,
    par: (content.par || [0, 0, 0]).slice(),
    allowUndo: content.allowUndo !== false,
    ranked: !!content.ranked,
    elapsedMs: 0,
    rng: (content.seed ^ 0x9e3779b9) >>> 0, // rules stream state
  };
  return state;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export function roomById(state, roomId) {
  return state.rooms.find(r => r.id === roomId) || null;
}
export function itemRoom(state, itemKey) {
  for (const r of state.rooms) {
    if (r.slots.includes(itemKey)) return r;
  }
  return null;
}
export function itemSlot(state, itemKey) {
  for (const r of state.rooms) {
    const i = r.slots.indexOf(itemKey);
    if (i >= 0) return { room: r, slot: i };
  }
  return null;
}
export function isCharacter(state, key) { return state.items[key]?.kind === 'character'; }
export function isProp(state, key) { return state.items[key]?.kind === 'prop'; }
export function occupiedRooms(state) {
  return state.rooms.filter(r => r.slots.some(s => s !== null));
}
export function itemsInRoom(state, roomId) {
  const r = roomById(state, roomId);
  return r ? r.slots.filter(s => s !== null) : [];
}

/** Which beat (if any) a pair of items would produce. Order-independent. */
export function beatForPair(state, aKey, bKey) {
  const a = state.items[aKey], b = state.items[bKey];
  if (!a || !b) return null;
  if (a.kind === 'character' && b.kind === 'character') return { type: 'heart-to-heart', def: BEATS['heart-to-heart'], char: null, prop: null };
  const char = a.kind === 'character' ? aKey : (b.kind === 'character' ? bKey : null);
  const prop = a.kind === 'prop' ? aKey : (b.kind === 'prop' ? bKey : null);
  if (!char || !prop) return null; // prop+prop
  for (const [type, def] of Object.entries(BEATS)) {
    if (def.prop === prop) return { type, def, char, prop };
  }
  return null;
}

export function beatKey(type, roomId, a, b) {
  return type + '@' + roomId + ':' + [a, b].sort().join('+');
}
export function hasBeat(state, type, roomId, a, b) {
  const key = beatKey(type, roomId, a, b);
  return state.beats.some(be => beatKey(be.t, be.room, be.a, be.b) === key);
}

/** Score a prospective/recorded beat in a room. */
export function beatScore(state, type, roomId, char, prop) {
  const def = BEATS[type];
  const room = roomById(state, roomId);
  let pts = def.points;
  const sig = !!(prop && char && SIGNATURES[char] === prop);
  if (sig) pts += SIGNATURE_BONUS;
  const hab = !!(def.habitat && room && room.type === def.habitat);
  if (hab) pts += def.habitatBonus;
  return { pts, sig, hab };
}

// ---------------------------------------------------------------------------
// Legal actions — one list used by play, hints, tutorials and keyboard nav.
// ---------------------------------------------------------------------------
export function listLegalActions(state) {
  if (state.status !== 'active') return [];
  const out = [];
  const freeSlots = [];
  for (const r of state.rooms) {
    for (let i = 0; i < r.slots.length; i++) {
      if (r.slots[i] === null) freeSlots.push({ room: r.id, slot: i });
    }
  }
  const movesLeft = state.moveLimit === null ? Infinity : state.moveLimit - state.stats.moves;
  if (movesLeft > 0) {
    for (const item of state.tray) {
      for (const fs of freeSlots) out.push({ type: 'place', item, room: fs.room, slot: fs.slot });
    }
    for (const r of state.rooms) {
      for (let i = 0; i < r.slots.length; i++) {
        const item = r.slots[i];
        if (item === null) continue;
        for (const fs of freeSlots) out.push({ type: 'move', item, room: fs.room, slot: fs.slot });
        out.push({ type: 'remove', item });
      }
      // interactions: every unordered pair in this room with an untold beat
      const here = r.slots.filter(s => s !== null);
      for (let i = 0; i < here.length; i++) {
        for (let j = i + 1; j < here.length; j++) {
          const beat = beatForPair(state, here[i], here[j]);
          if (!beat) continue;
          if (hasBeat(state, beat.type, r.id, here[i], here[j])) continue;
          out.push({ type: 'interact', room: r.id, a: here[i], b: here[j] });
        }
      }
    }
  }
  out.push({ type: 'finish' });
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const REASONS = {
  'game-over': 'This story is already saved.',
  'unknown-action': 'That action is not part of the rules.',
  'bad-payload': 'That action is missing information.',
  'room-missing': 'There is no such room.',
  'slot-missing': 'There is no spot there.',
  'slot-occupied': 'That spot is already taken.',
  'item-not-in-tray': 'That piece is not on the tray.',
  'item-not-placed': 'That piece is not in the house.',
  'same-slot': 'It is already there.',
  'need-two-items': 'Pick two pieces to interact.',
  'different-rooms': 'They need to be in the same room.',
  'props-need-character': 'Props need a character to bring them to life.',
  'beat-already-told': 'That moment already happened in this room.',
  'move-limit-reached': 'No moves left — the story must end here.',
  'no-time-limit': 'This story has no clock.',
  'time-not-up': 'The clock has not run out yet.',
};
export function reasonText(code) { return REASONS[code] || 'That action is not allowed.'; }

function fail(reason) { return { ok: false, reason }; }

export function validateCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object' || !VALID_CMDS.has(cmd.type)) return fail('unknown-action');
  if (state.status !== 'active') return fail('game-over');

  if (cmd.type === 'finish' || cmd.type === 'timeout') {
    if (cmd.elapsedMs !== undefined &&
        (!Number.isFinite(cmd.elapsedMs) || cmd.elapsedMs < 0)) return fail('bad-payload');
    if (cmd.type === 'finish') return { ok: true };
    if (state.timeLimitMs === null) return fail('no-time-limit');
    if (((cmd.elapsedMs ?? 0) | 0) < state.timeLimitMs) return fail('time-not-up');
    return { ok: true };
  }

  if (state.moveLimit !== null && state.stats.moves >= state.moveLimit) return fail('move-limit-reached');

  if (cmd.type === 'place') {
    const room = roomById(state, cmd.room);
    if (!room) return fail('room-missing');
    if (!(cmd.slot >= 0 && cmd.slot < room.slots.length)) return fail('slot-missing');
    if (!state.tray.includes(cmd.item)) return fail('item-not-in-tray');
    if (room.slots[cmd.slot] !== null) return fail('slot-occupied');
    return { ok: true };
  }
  if (cmd.type === 'move') {
    const room = roomById(state, cmd.room);
    if (!room) return fail('room-missing');
    if (!(cmd.slot >= 0 && cmd.slot < room.slots.length)) return fail('slot-missing');
    const cur = itemSlot(state, cmd.item);
    if (!cur) return fail('item-not-placed');
    if (cur.room.id === cmd.room && cur.slot === cmd.slot) return fail('same-slot');
    if (room.slots[cmd.slot] !== null) return fail('slot-occupied');
    return { ok: true };
  }
  if (cmd.type === 'remove') {
    if (!itemSlot(state, cmd.item)) return fail('item-not-placed');
    return { ok: true };
  }
  if (cmd.type === 'interact') {
    if (!cmd.a || !cmd.b || cmd.a === cmd.b) return fail('need-two-items');
    const room = roomById(state, cmd.room);
    if (!room) return fail('room-missing');
    const la = itemRoom(state, cmd.a), lb = itemRoom(state, cmd.b);
    if (!la || !lb) return fail('item-not-placed');
    if (la.id !== room.id || lb.id !== room.id) return fail('different-rooms');
    const beat = beatForPair(state, cmd.a, cmd.b);
    if (!beat) return fail('props-need-character');
    if (hasBeat(state, beat.type, room.id, cmd.a, cmd.b)) return fail('beat-already-told');
    return { ok: true };
  }
  return fail('unknown-action');
}

// ---------------------------------------------------------------------------
// Application — mutates state in place; session layer clones for snapshots.
// Returns events for render/audio/UI feedback.
// ---------------------------------------------------------------------------
export function applyCommand(state, cmd) {
  const v = validateCommand(state, cmd);
  if (!v.ok) {
    state.stats.invalid += 1;
    return { events: [{ type: 'invalid', reason: v.reason, command: cmd?.type ?? null }] };
  }
  const events = [];
  const rulesRng = new RngStream(state.rng);

  switch (cmd.type) {
    case 'place': {
      const room = roomById(state, cmd.room);
      room.slots[cmd.slot] = cmd.item;
      state.tray.splice(state.tray.indexOf(cmd.item), 1);
      state.stats.moves += 1;
      events.push({ type: 'placed', item: cmd.item, room: cmd.room, slot: cmd.slot });
      break;
    }
    case 'move': {
      const cur = itemSlot(state, cmd.item);
      cur.room.slots[cur.slot] = null;
      roomById(state, cmd.room).slots[cmd.slot] = cmd.item;
      state.stats.moves += 1;
      events.push({ type: 'moved', item: cmd.item, from: { room: cur.room.id, slot: cur.slot }, room: cmd.room, slot: cmd.slot });
      break;
    }
    case 'remove': {
      const cur = itemSlot(state, cmd.item);
      cur.room.slots[cur.slot] = null;
      state.tray.push(cmd.item);
      state.stats.moves += 1;
      events.push({ type: 'removed', item: cmd.item, room: cur.room.id, slot: cur.slot });
      break;
    }
    case 'interact': {
      const beat = beatForPair(state, cmd.a, cmd.b);
      const sc = beatScore(state, beat.type, cmd.room, beat.char, beat.prop);
      const rec = {
        t: beat.type, room: cmd.room, a: cmd.a, b: cmd.b,
        pts: sc.pts, sig: sc.sig ? 1 : 0, hab: sc.hab ? 1 : 0,
        flavor: rulesRng.int(0, 3), // deterministic cosmetic variant, replayed
      };
      state.beats.push(rec);
      state.stats.moves += 1;
      state.stats.interactions += 1;
      events.push({ type: 'beat', beat: rec, label: BEATS[beat.type].label });
      break;
    }
    case 'finish': {
      state.elapsedMs = Math.max(0, cmd.elapsedMs | 0);
      endGame(state, 'scene-saved', events);
      break;
    }
    case 'timeout': {
      state.elapsedMs = Math.max(0, cmd.elapsedMs | 0);
      endGame(state, 'time-up', events);
      break;
    }
  }
  state.rng = rulesRng.state;
  state.tick += 1;

  if (state.status === 'active') {
    evaluateCards(state, events);
    if (state.moveLimit !== null && state.stats.moves >= state.moveLimit) {
      endGame(state, 'move-limit', events);
    }
  }
  return { events };
}

function endGame(state, reason, events) {
  state.status = 'terminal';
  state.terminalReason = reason;
  evaluateCards(state, events);
  events.push({ type: 'gameover', reason, score: scoreState(state) });
}

// ---------------------------------------------------------------------------
// Discovery cards
// ---------------------------------------------------------------------------
function cardMet(state, when) {
  switch (when.kind) {
    case 'beat':
      return state.beats.some(b =>
        b.t === when.beat &&
        (!when.roomType || roomById(state, b.room)?.type === when.roomType) &&
        (!when.character || b.a === when.character || b.b === when.character) &&
        (!when.signature || b.sig === 1));
    case 'placement': {
      const loc = itemSlot(state, when.item);
      if (!loc) return false;
      if (when.roomId) return loc.room.id === when.roomId;
      if (when.roomType) return loc.room.type === when.roomType;
      return true;
    }
    case 'together': {
      const ra = itemRoom(state, when.a), rb = itemRoom(state, when.b);
      return !!ra && !!rb && ra.id === rb.id;
    }
    case 'coverage': return occupiedRooms(state).length >= when.count;
    case 'variety': return new Set(state.beats.map(b => b.t)).size >= when.count;
    case 'placed': return state.rooms.reduce((n, r) => n + r.slots.filter(s => s !== null).length, 0) >= when.count;
    case 'beats': return state.beats.length >= when.count;
    default: return false;
  }
}

export function evaluateCards(state, events = null) {
  const newly = [];
  for (const def of state.cardDefs) {
    if (state.cards[def.id] === 0 && cardMet(state, def.when)) {
      state.cards[def.id] = 1;
      newly.push(def);
      if (events) events.push({ type: 'card', card: def });
    }
  }
  return newly;
}

// ---------------------------------------------------------------------------
// Scoring — component breakdown, never one unexplained total.
// ---------------------------------------------------------------------------
export function scoreState(state) {
  const moments = state.beats.reduce((s, b) => s + b.pts, 0);
  const cardsDone = state.cardDefs.filter(c => state.cards[c.id] === 1);
  const discoveries = cardsDone.reduce((s, c) => s + c.points, 0);
  const coverage = occupiedRooms(state).length * COVERAGE_PER_ROOM;
  const variety = new Set(state.beats.map(b => b.t)).size * VARIETY_PER_TYPE;
  let timeBonus = 0;
  if (state.timeBonus && state.parTimeMs !== null && state.elapsedMs > 0) {
    timeBonus = Math.max(0, Math.ceil((state.parTimeMs - state.elapsedMs) / 1000)) * TIME_BONUS_PER_SEC;
  }
  const total = moments + discoveries + coverage + variety + timeBonus;
  let stars = 0;
  for (const threshold of state.par) if (total >= threshold && threshold > 0) stars += 1;
  return {
    moments, discoveries, coverage, variety, timeBonus, total, stars,
    cardsDone: cardsDone.length, cardsTotal: state.cardDefs.length,
    beats: state.beats.length, moves: state.stats.moves,
    invalid: state.stats.invalid, elapsedMs: state.elapsedMs,
  };
}

/** Theoretical max score — used by offline validators to prove reachable pars. */
export function maxScore(content) {
  const chars = Object.keys(content.items).filter(k => content.items[k].kind === 'character');
  const props = Object.keys(content.items).filter(k => content.items[k].kind === 'prop');
  let moments = 0, types = new Set();
  for (const room of content.layout.rooms) {
    for (const c of chars) {
      for (const p of props) {
        const def = Object.values(BEATS).find(d => d.prop === p);
        if (!def) continue;
        moments += def.points + (SIGNATURES[c] === p ? SIGNATURE_BONUS : 0) +
          (def.habitat === room.type ? def.habitatBonus : 0);
        types.add(Object.keys(BEATS).find(k => BEATS[k] === def));
      }
    }
    for (let i = 0; i < chars.length; i++) {
      for (let j = i + 1; j < chars.length; j++) {
        const def = BEATS['heart-to-heart'];
        moments += def.points + (def.habitat === room.type ? def.habitatBonus : 0);
        types.add('heart-to-heart');
      }
    }
  }
  const totalSlots = content.layout.rooms.reduce((s, r) => s + r.slots, 0);
  const coverage = Math.min(content.layout.rooms.length, Math.min(totalSlots, content.tray.length) > 0 ? content.layout.rooms.length : 0) * COVERAGE_PER_ROOM;
  const discoveries = content.cards.reduce((s, c) => s + c.points, 0);
  const variety = types.size * VARIETY_PER_TYPE;
  const timeBonus = content.timeBonus && content.parTimeMs ? Math.ceil(content.parTimeMs / 1000) * TIME_BONUS_PER_SEC : 0;
  return moments + discoveries + coverage + variety + timeBonus;
}

// ---------------------------------------------------------------------------
// Hints — derived from the same legal-action list the player uses.
// ---------------------------------------------------------------------------
export function suggestAction(state) {
  const legal = listLegalActions(state);
  const has = (pred) => legal.find(pred) || null;

  // 1. Something that completes a pending card.
  for (const def of state.cardDefs) {
    if (state.cards[def.id] === 1) continue;
    const w = def.when;
    if (w.kind === 'beat') {
      const act = has(a => {
        if (a.type !== 'interact') return false;
        const beat = beatForPair(state, a.a, a.b);
        return beat?.type === w.beat &&
          (!w.roomType || roomById(state, a.room)?.type === w.roomType) &&
          (!w.character || a.a === w.character || a.b === w.character);
      });
      if (act) return { ...act, why: `Works toward “${def.title}”.` };
      // Try to set the beat up: place the prop's character partner in a matching room.
      const beatDef = BEATS[w.beat];
      if (beatDef?.prop && state.tray.length) {
        const wantChar = w.character && state.tray.includes(w.character) ? w.character
          : state.tray.find(k => isCharacter(state, k));
        const room = state.rooms.find(r => (!w.roomType || r.type === w.roomType) && r.slots.includes(null));
        if (wantChar && room) {
          const slot = room.slots.indexOf(null);
          return { type: 'place', item: wantChar, room: room.id, slot, why: `Set up “${def.title}”.` };
        }
      }
    }
    if (w.kind === 'placement') {
      const act = has(a => (a.type === 'place' || a.type === 'move') && a.item === w.item &&
        (!w.roomType || roomById(state, a.room)?.type === w.roomType) &&
        (!w.roomId || a.room === w.roomId));
      if (act) return { ...act, why: `Works toward “${def.title}”.` };
    }
    if (w.kind === 'together') {
      const ra = itemRoom(state, w.a), rb = itemRoom(state, w.b);
      const anchor = ra || rb;
      if (anchor) {
        const other = ra ? w.b : w.a;
        const act = has(a => (a.type === 'place' || a.type === 'move') && a.item === other && a.room === anchor.id);
        if (act) return { ...act, why: `Works toward “${def.title}”.` };
      }
    }
    if (w.kind === 'coverage') {
      const empty = state.rooms.find(r => r.slots.every(s => s === null));
      if (empty) {
        const act = has(a => (a.type === 'place' || a.type === 'move') && a.room === empty.id);
        if (act) return { ...act, why: `Works toward “${def.title}”.` };
      }
    }
    if (w.kind === 'variety' || w.kind === 'beats') {
      const act = has(a => a.type === 'interact');
      if (act) return { ...act, why: `Works toward “${def.title}”.` };
    }
    if (w.kind === 'placed') {
      const act = has(a => a.type === 'place');
      if (act) return { ...act, why: `Works toward “${def.title}”.` };
    }
  }
  // 2. Any fresh interaction.
  const inter = has(a => a.type === 'interact');
  if (inter) return { ...inter, why: 'A new story moment.' };
  // 3. Place anything.
  const place = has(a => a.type === 'place');
  if (place) return { ...place, why: 'Bring a piece into the house.' };
  // 4. Wrap up.
  return { type: 'finish', why: 'Save the scene and see your story.' };
}

// ---------------------------------------------------------------------------
// Result comparison — ties: cards, fewer invalid, lower time, session id.
// ---------------------------------------------------------------------------
export function compareResults(a, b) {
  // a/b: {cardsDone, invalid, elapsedMs, sessionId, total}
  if (b.total !== a.total) return b.total - a.total;
  if (b.cardsDone !== a.cardsDone) return b.cardsDone - a.cardsDone;
  if (a.invalid !== b.invalid) return a.invalid - b.invalid;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

// ---------------------------------------------------------------------------
// Serialization & migration
// ---------------------------------------------------------------------------
export function serializeState(state) {
  return JSON.stringify(state);
}
export function deserializeState(json) {
  return migrateState(typeof json === 'string' ? JSON.parse(json) : json);
}
export function migrateState(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('bad state document');
  if (doc.v === STATE_VERSION) return doc;
  if (doc.v === 1) {
    // v1 stored rooms as an object map and had no elapsedMs/par fields.
    const rooms = Object.values(doc.rooms).map(r => ({ ...r }));
    return {
      ...doc, v: STATE_VERSION, rooms,
      elapsedMs: doc.elapsedMs ?? 0,
      par: doc.par ?? [0, 0, 0],
      timeBonus: doc.timeBonus ?? false,
      parTimeMs: doc.parTimeMs ?? null,
      ranked: doc.ranked ?? false,
    };
  }
  throw new Error('unsupported state version: ' + doc.v);
}
export function hashState(state) {
  return hashValue(state);
}
