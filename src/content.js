// content.js — versioned content: cast, props, rooms, layouts, themes,
// discovery cards, learn lessons, journey/daily/practice/challenge/score
// generators, and offline validators. Pure and DOM-free; shared by client
// and the authoritative server.

import { RngStream, deriveSeed } from './rng.js';
import { BEATS, SIGNATURES, createGame, applyCommand, scoreState, maxScore, roomById, itemSlot, listLegalActions, evaluateCards } from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Cast and props (the item registry)
// ---------------------------------------------------------------------------
export const CAST = {
  pip:     { kind: 'character', name: 'Pip',     blurb: 'a clockwork tinker', tags: ['curious', 'handy'] },
  mabel:   { kind: 'character', name: 'Mabel',   blurb: 'a patient gardener', tags: ['calm', 'green'] },
  otto:    { kind: 'character', name: 'Otto',    blurb: 'a warm-hearted cook', tags: ['warm', 'hearty'] },
  luna:    { kind: 'character', name: 'Luna',    blurb: 'a quiet stargazer',   tags: ['dreamy', 'night'] },
  biscuit: { kind: 'character', name: 'Biscuit', blurb: 'the house cat',      tags: ['pet', 'sleepy'] },
};
export const PROPS = {
  book:      { kind: 'prop', name: 'Storybook',    tags: ['paper'] },
  teapot:    { kind: 'prop', name: 'Teapot',       tags: ['hot'] },
  piano:     { kind: 'prop', name: 'Piano',        tags: ['music'] },
  fern:      { kind: 'prop', name: 'Potted Fern',  tags: ['plant'] },
  bed:       { kind: 'prop', name: 'Daybed',       tags: ['soft'] },
  telescope: { kind: 'prop', name: 'Telescope',    tags: ['night'] },
  lamp:      { kind: 'prop', name: 'Reading Lamp', tags: ['light'] },
  basket:    { kind: 'prop', name: 'Bread Basket', tags: ['food'] },
  clock:     { kind: 'prop', name: 'Old Clock',    tags: ['time'] },
  yarn:      { kind: 'prop', name: 'Ball of Yarn', tags: ['play'] },
};
export const ALL_ITEMS = { ...CAST, ...PROPS };
const CHAR_KEYS = Object.keys(CAST);
const PROP_KEYS = Object.keys(PROPS);
const PROP_TO_BEAT = {};
for (const [t, d] of Object.entries(BEATS)) if (d.prop) PROP_TO_BEAT[d.prop] = t;

export const ROOM_TYPES = {
  kitchen:  { name: 'Kitchen',     icon: 'kettle' },
  library:  { name: 'Library',     icon: 'shelf' },
  garden:   { name: 'Garden Room', icon: 'leaf' },
  parlor:   { name: 'Parlor',      icon: 'chair' },
  bedroom:  { name: 'Bedroom',     icon: 'bed' },
  attic:    { name: 'Attic',       icon: 'roof' },
};

// ---------------------------------------------------------------------------
// Layouts — cutaway dollhouse floor plans (grid coords; gy=0 ground floor)
// ---------------------------------------------------------------------------
export const LAYOUTS = {
  cottage: {
    id: 'cottage', label: 'Cottage',
    rooms: [
      { id: 'kitchen', type: 'kitchen', name: 'Kitchen',     gx: 0, gy: 0, slots: 3 },
      { id: 'library', type: 'library', name: 'Library',     gx: 1, gy: 0, slots: 3 },
      { id: 'bedroom', type: 'bedroom', name: 'Bedroom',     gx: 0, gy: 1, slots: 3 },
      { id: 'garden',  type: 'garden',  name: 'Garden Room', gx: 1, gy: 1, slots: 3 },
    ],
  },
  manor: {
    id: 'manor', label: 'Manor',
    rooms: [
      { id: 'kitchen', type: 'kitchen', name: 'Kitchen',     gx: 0, gy: 0, slots: 4 },
      { id: 'parlor',  type: 'parlor',  name: 'Parlor',      gx: 1, gy: 0, slots: 4 },
      { id: 'library', type: 'library', name: 'Library',     gx: 2, gy: 0, slots: 3 },
      { id: 'bedroom', type: 'bedroom', name: 'Bedroom',     gx: 0, gy: 1, slots: 3 },
      { id: 'garden',  type: 'garden',  name: 'Garden Room', gx: 1, gy: 1, slots: 4 },
      { id: 'attic',   type: 'attic',   name: 'Attic',       gx: 2, gy: 1, slots: 3 },
    ],
  },
  loft: {
    id: 'loft', label: 'Loft',
    rooms: [
      { id: 'parlor',  type: 'parlor',  name: 'Parlor',  gx: 0, gy: 0, slots: 4 },
      { id: 'bedroom', type: 'bedroom', name: 'Bedroom', gx: 0, gy: 1, slots: 3 },
      { id: 'attic',   type: 'attic',   name: 'Attic',   gx: 0, gy: 2, slots: 3 },
    ],
  },
  townhouse: {
    id: 'townhouse', label: 'Townhouse',
    rooms: [
      { id: 'parlor',  type: 'parlor',  name: 'Parlor',      gx: 0, gy: 0, slots: 4 },
      { id: 'kitchen', type: 'kitchen', name: 'Kitchen',     gx: 1, gy: 0, slots: 4 },
      { id: 'garden',  type: 'garden',  name: 'Garden Room', gx: 2, gy: 0, slots: 3 },
      { id: 'library', type: 'library', name: 'Library',     gx: 0, gy: 1, slots: 3 },
      { id: 'bedroom', type: 'bedroom', name: 'Bedroom',     gx: 1, gy: 1, slots: 3 },
      { id: 'attic',   type: 'attic',   name: 'Attic',       gx: 2, gy: 1, slots: 3 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Themes — five visual/auditory identities
// ---------------------------------------------------------------------------
export const THEMES = {
  meadow: {
    id: 'meadow', label: 'Meadow',
    sky: 0xbfe3d0, fog: 0xcfeadb, hemiSky: 0xeaf7ee, hemiGround: 0x8a9b7a,
    key: 0xfff2d8, keyIntensity: 2.6, exposure: 1.0,
    wall: 0xf3e9c8, wallSide: 0xe7dab4, floor: 0xb08a5e, trim: 0x8a6a44,
    accent: 0x7fb069, ground: 0x9cbf88, roof: 0xc96f4a,
    music: { root: 261.63, scale: [0, 2, 4, 7, 9], bpm: 84, bright: 1.0 },
    ambience: 'birds',
  },
  rosewood: {
    id: 'rosewood', label: 'Rosewood',
    sky: 0xe8c4b8, fog: 0xe6cabc, hemiSky: 0xf6e2d4, hemiGround: 0x7a5a4a,
    key: 0xffd9b0, keyIntensity: 2.4, exposure: 1.0,
    wall: 0xd9a08c, wallSide: 0xc68f7c, floor: 0x7a4a38, trim: 0x5a352a,
    accent: 0xc9563c, ground: 0xa8765e, roof: 0x6e3b2e,
    music: { root: 220.0, scale: [0, 2, 4, 7, 9], bpm: 76, bright: 0.8 },
    ambience: 'hearth',
  },
  seaglass: {
    id: 'seaglass', label: 'Seaglass',
    sky: 0xbcdfe4, fog: 0xc8e4e6, hemiSky: 0xe2f2f2, hemiGround: 0x5e7a7c,
    key: 0xf0f6e8, keyIntensity: 2.4, exposure: 1.0,
    wall: 0xd3e6e0, wallSide: 0xc0d6d0, floor: 0x8a7a5e, trim: 0x4e6a6a,
    accent: 0x3f9a9a, ground: 0x8fb8ac, roof: 0x4e7a8a,
    music: { root: 293.66, scale: [0, 3, 5, 7, 10], bpm: 72, bright: 0.9 },
    ambience: 'waves',
  },
  nightfall: {
    id: 'nightfall', label: 'Nightfall',
    sky: 0x232a52, fog: 0x2a3258, hemiSky: 0x6a7ab8, hemiGround: 0x322c4e,
    key: 0xaabaff, keyIntensity: 2.1, exposure: 1.15,
    wall: 0x5e5688, wallSide: 0x4e4670, floor: 0x6a5442, trim: 0x38304e,
    accent: 0xe8b84a, ground: 0x363e5c, roof: 0x322a52,
    music: { root: 196.0, scale: [0, 3, 5, 7, 10], bpm: 66, bright: 0.6 },
    ambience: 'crickets',
  },
  porcelain: {
    id: 'porcelain', label: 'Porcelain',
    sky: 0xe8ecf2, fog: 0xeef1f6, hemiSky: 0xffffff, hemiGround: 0x9aa4b8,
    key: 0xfff6e8, keyIntensity: 2.5, exposure: 1.0,
    wall: 0xf4f2ee, wallSide: 0xe4e0d8, floor: 0x9a8a72, trim: 0x4a5a7a,
    accent: 0x3a5a9a, ground: 0xb8c0cc, roof: 0x3a4a6a,
    music: { root: 329.63, scale: [0, 2, 4, 7, 9], bpm: 80, bright: 1.1 },
    ambience: 'wind',
  },
};
export const THEME_ORDER = ['meadow', 'rosewood', 'seaglass', 'nightfall', 'porcelain'];

// ---------------------------------------------------------------------------
// Discovery card templates → concrete card defs
// ---------------------------------------------------------------------------
function itemName(key) { return ALL_ITEMS[key]?.name ?? key; }
function roomTypeName(t) { return ROOM_TYPES[t]?.name ?? t; }

const CARD_TEMPLATES = {
  habitatBeat(rng, ctx) {
    const cands = PROP_KEYS.filter(p => ctx.tray.includes(p) && BEATS[PROP_TO_BEAT[p]].habitat && ctx.roomTypes.includes(BEATS[PROP_TO_BEAT[p]].habitat));
    if (!cands.length) return null;
    const prop = rng.pick(cands);
    const beat = PROP_TO_BEAT[prop];
    const rt = BEATS[beat].habitat;
    return {
      title: `${BEATS[beat].label} in the ${roomTypeName(rt)}`,
      text: `Let someone enjoy the ${itemName(prop)} where it belongs: the ${roomTypeName(rt)}.`,
      points: 20, when: { kind: 'beat', beat, roomType: rt },
    };
  },
  signature(rng, ctx) {
    const cands = ctx.chars.filter(c => ctx.tray.includes(SIGNATURES[c]));
    if (!cands.length) return null;
    const c = rng.pick(cands);
    return {
      title: `${itemName(c)}'s favorite`,
      text: `${itemName(c)} has a special bond with the ${itemName(SIGNATURES[c])}. Bring them together.`,
      points: 24, when: { kind: 'beat', beat: PROP_TO_BEAT[SIGNATURES[c]], character: c, signature: true },
    };
  },
  placement(rng, ctx) {
    const cands = ctx.tray.filter(k => CAST[k]);
    if (!cands.length) return null;
    const c = rng.pick(cands);
    const rt = rng.pick(ctx.roomTypes);
    return {
      title: `${itemName(c)} settles in`,
      text: `Give ${itemName(c)} a spot in the ${roomTypeName(rt)}.`,
      points: 14, when: { kind: 'placement', item: c, roomType: rt },
    };
  },
  together(rng, ctx) {
    if (ctx.chars.length < 2) return null;
    const [a, b] = rng.shuffle(ctx.chars).slice(0, 2);
    return {
      title: 'Good company',
      text: `${itemName(a)} and ${itemName(b)} should share a room.`,
      points: 14, when: { kind: 'together', a, b },
    };
  },
  coverage(rng, ctx) {
    const count = Math.min(ctx.roomTypes.length, Math.max(2, Math.min(ctx.tray.length, rng.int(3, ctx.roomTypes.length))));
    return {
      title: 'All over the house',
      text: `Have pieces in at least ${count} different rooms.`,
      points: 16, when: { kind: 'coverage', count },
    };
  },
  variety(rng, ctx) {
    const count = Math.min(ctx.maxTypes, rng.int(2, Math.max(2, Math.min(4, ctx.maxTypes))));
    if (count < 2) return null;
    return {
      title: 'A varied day',
      text: `Create ${count} different kinds of story moment.`,
      points: 18, when: { kind: 'variety', count },
    };
  },
  beats(rng, ctx) {
    const count = rng.int(2, 4);
    return {
      title: 'Moments worth keeping',
      text: `Record at least ${count} story moments.`,
      points: 16, when: { kind: 'beats', count },
    };
  },
};

function buildCtx(content) {
  const chars = content.tray.filter(k => CAST[k]);
  const props = content.tray.filter(k => PROPS[k]);
  const types = new Set(props.map(p => PROP_TO_BEAT[p]));
  if (chars.length >= 2) types.add('heart-to-heart');
  return {
    tray: content.tray, chars, props,
    roomTypes: content.layout.rooms.map(r => r.type),
    maxTypes: types.size,
  };
}

function makeCards(rng, content, kinds, prefix) {
  const ctx = buildCtx(content);
  const cards = [];
  const seen = new Set();
  let guard = 40;
  const pool = rng.shuffle(kinds);
  while (cards.length < kinds.length && guard-- > 0) {
    const kind = pool[cards.length % pool.length] ?? kinds[cards.length % kinds.length];
    const tmpl = CARD_TEMPLATES[kind];
    if (!tmpl) break;
    const card = tmpl(rng, ctx);
    if (!card) { pool.splice(pool.indexOf(kind), 1); if (!pool.length) break; continue; }
    const sig = JSON.stringify(card.when);
    if (seen.has(sig)) { pool.push(pool.shift()); continue; }
    seen.add(sig);
    cards.push({ id: `${prefix}-c${cards.length + 1}`, ...card });
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Minimal planner — proves every card is achievable within the move limit.
// Uses the real engine, so validated content is validated against the rules.
// ---------------------------------------------------------------------------
export function planContent(content) {
  const state = createGame(content);
  const commands = [];
  const doCmd = (cmd) => {
    const v = applyCommand(state, cmd);
    if (v.events.some(e => e.type === 'invalid')) throw new Error('plan step rejected: ' + JSON.stringify(cmd));
    commands.push(cmd);
  };
  const placeOrMoveInto = (item, roomId) => {
    const room = roomById(state, roomId);
    const loc = itemSlot(state, item);
    if (loc && loc.room.id === roomId) return; // already home
    const free = room.slots.indexOf(null);
    if (free < 0) throw new Error('no free slot in ' + roomId);
    if (loc) doCmd({ type: 'move', item, room: roomId, slot: free });
    else doCmd({ type: 'place', item, room: roomId, slot: free });
  };
  const roomFree = (room) => room.slots.filter(s => s === null).length;
  // Guarantee a room (optionally of a type) has at least `need` free slots,
  // evicting occupants elsewhere or back to the tray when necessary.
  const ensureRoom = (roomType, need) => {
    const cands = state.rooms.filter(r => !roomType || r.type === roomType);
    let room = cands.find(r => roomFree(r) >= need);
    if (room) return room;
    room = cands.slice().sort((a, b) => roomFree(b) - roomFree(a))[0];
    if (!room) throw new Error('no room of type ' + roomType);
    let guard = 20;
    while (roomFree(room) < need && guard-- > 0) {
      const occupant = room.slots.find(s => s !== null);
      const dest = state.rooms.find(r => r.id !== room.id && r.slots.includes(null));
      if (dest) doCmd({ type: 'move', item: occupant, room: dest.id, slot: dest.slots.indexOf(null) });
      else doCmd({ type: 'remove', item: occupant });
    }
    if (roomFree(room) < need) throw new Error('cannot free room of type ' + roomType);
    return room;
  };
  // Find items + a room whose interaction produces an untold beat.
  const findFreshInteraction = (preferNewType) => {
    const told = new Set(state.beats.map(b => b.t + '@' + b.room + ':' + [b.a, b.b].sort().join('+')));
    const usedTypes = new Set(state.beats.map(b => b.t));
    const chars = content.tray.filter(k => CAST[k]);
    const props = content.tray.filter(k => PROPS[k]);
    const combos = [];
    for (const c of chars) for (const p of props) combos.push({ a: c, b: p, type: PROP_TO_BEAT[p] });
    for (let i = 0; i < chars.length; i++) for (let j = i + 1; j < chars.length; j++) {
      combos.push({ a: chars[i], b: chars[j], type: 'heart-to-heart' });
    }
    if (preferNewType) {
      combos.sort((x, y) => (usedTypes.has(x.type) ? 1 : 0) - (usedTypes.has(y.type) ? 1 : 0));
    }
    for (const combo of combos) {
      for (const room of state.rooms) {
        if (told.has(combo.type + '@' + room.id + ':' + [combo.a, combo.b].sort().join('+'))) continue;
        const inRoom = [combo.a, combo.b].filter(k => itemSlot(state, k)?.room.id === room.id).length;
        if (roomFree(room) + inRoom >= 2) return { ...combo, room };
      }
    }
    return null;
  };
  const doInteraction = (fresh) => {
    placeOrMoveInto(fresh.a, fresh.room.id);
    placeOrMoveInto(fresh.b, fresh.room.id);
    doCmd({ type: 'interact', room: fresh.room.id, a: fresh.a, b: fresh.b });
  };
  const satisfyBeat = (w) => {
    const def = BEATS[w.beat];
    let a, b;
    if (def.charPair) {
      const cs = content.tray.filter(k => CAST[k]).slice(0, 2);
      [a, b] = [cs[0], cs[1]];
    } else {
      b = def.prop;
      a = (w.character && content.tray.includes(w.character)) ? w.character
        : content.tray.find(k => CAST[k]);
    }
    if (!a || !b) throw new Error('beat card lacks items');
    const room = ensureRoom(w.roomType || null, 2);
    placeOrMoveInto(a, room.id);
    placeOrMoveInto(b, room.id);
    doCmd({ type: 'interact', room: room.id, a, b });
  };
  for (const card of content.cards) {
    const w = card.when;
    // Skip if already satisfied incidentally by earlier plan steps.
    const probe = JSON.parse(JSON.stringify(state));
    probe.cards = { [card.id]: 0 };
    probe.cardDefs = [card];
    evaluateCards(probe);
    if (probe.cards[card.id] === 1) continue;
    switch (w.kind) {
      case 'beat': satisfyBeat(w); break;
      case 'placement': {
        const room = state.rooms.find(r => (!w.roomType || r.type === w.roomType) && r.slots.includes(null));
        if (!room) throw new Error('no room for placement');
        placeOrMoveInto(w.item, room.id);
        break;
      }
      case 'together': {
        const room = ensureRoom(null, 2);
        placeOrMoveInto(w.a, room.id);
        placeOrMoveInto(w.b, room.id);
        break;
      }
      case 'coverage': {
        let guard = 20;
        while (state.rooms.filter(r => r.slots.some(s => s !== null)).length < w.count && guard-- > 0) {
          const empty = state.rooms.find(r => r.slots.every(s => s === null));
          if (!empty) break;
          const fromTray = state.tray[0];
          if (fromTray) { placeOrMoveInto(fromTray, empty.id); continue; }
          const donor = state.rooms.find(r => r.slots.filter(s => s !== null).length > 1);
          if (!donor) throw new Error('nothing to spread for coverage');
          placeOrMoveInto(donor.slots.find(s => s !== null), empty.id);
        }
        break;
      }
      case 'variety': {
        let guard = 40;
        while (new Set(state.beats.map(b => b.t)).size < w.count && guard-- > 0) {
          const fresh = findFreshInteraction(true);
          if (!fresh) break;
          doInteraction(fresh);
        }
        break;
      }
      case 'beats': {
        let guard = 60;
        while (state.beats.length < w.count && guard-- > 0) {
          const fresh = findFreshInteraction(false);
          if (!fresh) break;
          doInteraction(fresh);
        }
        break;
      }
      case 'placed': {
        let guard = 20;
        const placedCount = () => state.rooms.reduce((n, r) => n + r.slots.filter(s => s !== null).length, 0);
        while (placedCount() < w.count && guard-- > 0) {
          if (!state.tray.length) break;
          const room = state.rooms.find(r => r.slots.includes(null));
          if (!room) throw new Error('no free slot');
          placeOrMoveInto(state.tray[0], room.id);
        }
        break;
      }
    }
  }
  return { commands, state, score: scoreState(state) };
}

// ---------------------------------------------------------------------------
// Content assembly helpers
// ---------------------------------------------------------------------------
function resolveItems(tray) {
  const items = {};
  for (const key of tray) items[key] = { kind: ALL_ITEMS[key].kind, name: ALL_ITEMS[key].name, tags: ALL_ITEMS[key].tags.slice() };
  return items;
}

function finalizeContent(raw, opts = {}) {
  const content = {
    contentId: raw.contentId,
    seed: raw.seed >>> 0,
    layout: raw.layout,
    items: resolveItems(raw.tray),
    tray: raw.tray.slice(),
    cards: raw.cards,
    moveLimit: raw.moveLimit ?? null,
    timeLimitMs: raw.timeLimitMs ?? null,
    timeBonus: raw.timeBonus ?? false,
    parTimeMs: raw.parTimeMs ?? null,
    par: raw.par ?? null,
    allowUndo: raw.allowUndo !== false,
    ranked: !!raw.ranked,
    theme: raw.theme || 'meadow',
    mode: raw.mode || 'practice',
    label: raw.label || '',
    blurb: raw.blurb || '',
    mastery: !!raw.mastery,
  };
  const max = maxScore(content);
  if (!content.par) {
    if (content.moveLimit !== null) {
      const plan = planContent(content);
      const base = plan.score.total;
      content.par = [0.55, 0.75, 0.9].map(f => Math.round((base * f) / 5) * 5);
      if (opts.slackMoves) content.moveLimit = plan.commands.length + opts.slackMoves;
    } else {
      content.par = [0.2, 0.35, 0.5].map(f => Math.round((max * f) / 5) * 5);
    }
  }
  return content;
}

// ---------------------------------------------------------------------------
// Journey — 45 authored-progression stages in five themed chapters
// ---------------------------------------------------------------------------
const CHAPTERS = [
  { theme: 'meadow',    layout: 'cottage',   title: 'Morning Light',
    names: ['Moving In', 'First Cuppa', 'Quiet Corner', 'Tidy Up', 'Green Fingers', "Two's Company", 'Around the House', 'Little Rituals', 'Mastery: Cottage Gala'] },
  { theme: 'rosewood',  layout: 'manor',     title: 'Rosewood Hours',
    names: ['Grand Rooms', 'Right Place', 'Hearth Habits', 'The Long Shelf', 'Afternoon Calls', 'Proper Tea', 'Room to Bloom', 'Full House', 'Mastery: Rosewood Review'] },
  { theme: 'seaglass',  layout: 'townhouse', title: 'Seaglass Drift',
    names: ['Salt Air', 'High Rooms', 'Old Favorites', 'Tide Patterns', 'Driftwood Duet', 'Narrow Stairs', 'Bright Work', 'Glass Menagerie', 'Mastery: Seaglass Salon'] },
  { theme: 'nightfall', layout: 'townhouse', title: 'Nightfall Attic',
    names: ['Lights Down', 'Star Charts', 'Quiet Steps', 'Midnight Snack', 'The Small Hours', 'Lamp Lore', 'Whispered Stories', 'Night Watch', 'Mastery: Nightfall Nocturne'] },
  { theme: 'porcelain', layout: 'manor',     title: 'Porcelain Gala',
    names: ['White Gloves', 'Seating Plan', 'The Set Pieces', 'Polished Routine', 'Signature Service', 'Full Dance Card', 'The Grand Tour', 'Encore', 'Mastery: Porcelain Gala'] },
];
const CHAPTER_CARD_KINDS = [
  ['habitatBeat', 'placement', 'together'],
  ['habitatBeat', 'placement', 'together', 'coverage'],
  ['habitatBeat', 'signature', 'coverage', 'variety'],
  ['habitatBeat', 'signature', 'variety', 'beats'],
  ['signature', 'coverage', 'variety', 'beats'],
];

export const CHAPTERS_PUB = CHAPTERS;

export function journeyStage(index) {
  if (index < 0 || index >= 45) return null;
  const chapter = Math.floor(index / 9);
  const step = index % 9;
  const ch = CHAPTERS[chapter];
  const mastery = step === 8;
  const rng = new RngStream(deriveSeed('journey', CONTENT_VERSION, index));

  // Tray grows with progression: characters then props.
  const charCount = Math.min(2 + Math.floor((index + 2) / 8), 5);
  const propCount = Math.min(2 + Math.floor((index + 4) / 6), mastery ? 8 : 6);
  const chars = rng.shuffle(CHAR_KEYS).slice(0, charCount);
  // Guarantee each chapter's early stages include the pieces their cards need.
  const props = rng.shuffle(PROP_KEYS).slice(0, propCount);
  const tray = rng.shuffle([...chars, ...props]);

  const layout = LAYOUTS[ch.layout];
  const cardKinds = CHAPTER_CARD_KINDS[chapter];
  const cardCount = Math.min(2 + Math.floor(step / 3), 4);
  const picked = [];
  for (let i = 0; i < cardCount; i++) picked.push(cardKinds[(step + i) % cardKinds.length]);

  // Nightfall onward: some stages carry a move limit.
  const limited = chapter >= 3 && (step === 2 || step === 4 || step === 6);

  const partial = {
    contentId: `journey-${String(index + 1).padStart(2, '0')}`,
    seed: rng.int(1, 0x7fffffff),
    layout, tray, theme: ch.theme, mode: 'journey',
    label: ch.names[step], mastery,
    blurb: `${ch.title} — stage ${step + 1} of 9`,
    ranked: false, allowUndo: true,
    moveLimit: null,
  };
  partial.cards = makeCards(rng, partial, picked, partial.contentId);
  const content = finalizeContent(partial, { slackMoves: limited ? 3 : 0 });
  if (limited) {
    const plan = planContent(content);
    content.moveLimit = plan.commands.length + 3;
    const base = plan.score.total;
    content.par = [0.55, 0.75, 0.9].map(f => Math.round((base * f) / 5) * 5);
  }
  return content;
}

export function journeyLength() { return 45; }

// ---------------------------------------------------------------------------
// Daily — one shared seed & ruleset per UTC day
// ---------------------------------------------------------------------------
export function dailyContent(utcDate) { // 'YYYY-MM-DD'
  const rng = new RngStream(deriveSeed('daily', CONTENT_VERSION, utcDate));
  const layoutIds = Object.keys(LAYOUTS);
  const layout = LAYOUTS[layoutIds[deriveSeed('daily-layout', utcDate) % layoutIds.length]];
  const charCount = rng.int(2, 4);
  const propCount = rng.int(3, 5);
  const tray = rng.shuffle([
    ...rng.shuffle(CHAR_KEYS).slice(0, charCount),
    ...rng.shuffle(PROP_KEYS).slice(0, propCount),
  ]);
  const theme = THEME_ORDER[deriveSeed('daily-theme', utcDate) % THEME_ORDER.length];
  const partial = {
    contentId: `daily-${utcDate}`,
    seed: rng.int(1, 0x7fffffff),
    layout, tray, theme, mode: 'daily',
    label: `Daily Story — ${utcDate}`,
    blurb: 'One shared house for everyone, today only.',
    ranked: true, allowUndo: false,
  };
  partial.cards = makeCards(rng, partial, ['habitatBeat', 'signature', 'coverage'], partial.contentId);
  return finalizeContent(partial);
}

// ---------------------------------------------------------------------------
// Practice — selectable difficulty, undo, unranked
// ---------------------------------------------------------------------------
export const PRACTICE_DIFFICULTIES = {
  cozy:     { label: 'Cozy',     layout: 'cottage',   chars: 2, props: 2, cards: ['habitatBeat', 'placement'], limited: false },
  standard: { label: 'Standard', layout: 'manor',     chars: 3, props: 3, cards: ['habitatBeat', 'together', 'coverage'], limited: false },
  tricky:   { label: 'Tricky',   layout: 'townhouse', chars: 4, props: 4, cards: ['signature', 'habitatBeat', 'variety', 'beats'], limited: true },
};
export function practiceContent(difficulty, seed, themeId = 'meadow') {
  const d = PRACTICE_DIFFICULTIES[difficulty] || PRACTICE_DIFFICULTIES.cozy;
  const rng = new RngStream(deriveSeed('practice', CONTENT_VERSION, difficulty, seed));
  const tray = rng.shuffle([
    ...rng.shuffle(CHAR_KEYS).slice(0, d.chars),
    ...rng.shuffle(PROP_KEYS).slice(0, d.props),
  ]);
  const partial = {
    contentId: `practice-${difficulty}-${seed}`,
    seed: rng.int(1, 0x7fffffff),
    layout: LAYOUTS[d.layout], tray, theme: themeId, mode: 'practice',
    label: `Practice — ${d.label}`,
    blurb: d.limited ? 'A tighter house with a move limit.' : 'An open house with no limits.',
    ranked: false, allowUndo: true,
  };
  partial.cards = makeCards(rng, partial, d.cards, partial.contentId);
  const content = finalizeContent(partial, { slackMoves: d.limited ? 3 : 0 });
  if (d.limited) {
    const plan = planContent(content);
    content.moveLimit = plan.commands.length + 3;
    content.par = [0.55, 0.75, 0.9].map(f => Math.round((plan.score.total * f) / 5) * 5);
  }
  return content;
}

// ---------------------------------------------------------------------------
// Challenge — constrained, authored
// ---------------------------------------------------------------------------
export const CHALLENGES = [
  {
    id: 'speed-tea', label: 'Tea for Two, Quickly', theme: 'rosewood', layout: 'cottage',
    tray: ['otto', 'mabel', 'teapot', 'basket', 'book'],
    timeLimitMs: 150000, timeBonus: true, parTimeMs: 150000, allowUndo: false, ranked: true,
    blurb: 'Two and a half minutes on the clock. Speed adds to your score.',
    cards: [
      { id: 'speed-tea-c1', title: 'Tea break in the Kitchen', text: 'A proper tea break where the kettle lives.', points: 20, when: { kind: 'beat', beat: 'tea-break', roomType: 'kitchen' } },
      { id: 'speed-tea-c2', title: "Otto's favorite", text: 'Otto and the Bread Basket, together at last.', points: 24, when: { kind: 'beat', beat: 'snack', character: 'otto', signature: true } },
      { id: 'speed-tea-c3', title: 'All over the house', text: 'Pieces in at least 3 rooms.', points: 16, when: { kind: 'coverage', count: 3 } },
    ],
  },
  {
    id: 'move-diet', label: 'Ten Moves, No More', theme: 'porcelain', layout: 'manor',
    tray: ['pip', 'luna', 'book', 'clock', 'lamp', 'telescope'],
    limitedPlan: true, allowUndo: false, ranked: true,
    blurb: 'Every move counts. Plan the whole story before you touch a piece.',
    cards: [
      { id: 'move-diet-c1', title: "Pip's favorite", text: 'Pip and the Old Clock share a moment.', points: 24, when: { kind: 'beat', beat: 'time-check', character: 'pip', signature: true } },
      { id: 'move-diet-c2', title: 'Story time in the Library', text: 'Read where the shelves are.', points: 20, when: { kind: 'beat', beat: 'story-time', roomType: 'library' } },
      { id: 'move-diet-c3', title: 'A varied day', text: 'Create 3 different kinds of story moment.', points: 18, when: { kind: 'variety', count: 3 } },
    ],
  },
  {
    id: 'two-hander', label: 'Just the Two of Us', theme: 'seaglass', layout: 'loft',
    tray: ['luna', 'biscuit', 'telescope', 'yarn', 'bed'],
    allowUndo: true, ranked: true,
    blurb: 'A tall narrow house, two old friends, and their favorite things.',
    cards: [
      { id: 'two-hander-c1', title: "Luna's favorite", text: 'Luna and the Telescope.', points: 24, when: { kind: 'beat', beat: 'stargazing', character: 'luna', signature: true } },
      { id: 'two-hander-c2', title: "Biscuit's favorite", text: 'Biscuit and the Ball of Yarn.', points: 24, when: { kind: 'beat', beat: 'playtime', character: 'biscuit', signature: true } },
      { id: 'two-hander-c3', title: 'Good company', text: 'Luna and Biscuit share a room.', points: 14, when: { kind: 'together', a: 'luna', b: 'biscuit' } },
    ],
  },
  {
    id: 'house-call', label: 'The Grand House Call', theme: 'meadow', layout: 'townhouse',
    tray: ['mabel', 'otto', 'fern', 'basket', 'piano', 'book'],
    allowUndo: true, ranked: true,
    blurb: 'Visit every room before the visit is over.',
    cards: [
      { id: 'house-call-c1', title: 'All over the house', text: 'Pieces in at least 5 rooms.', points: 16, when: { kind: 'coverage', count: 5 } },
      { id: 'house-call-c2', title: "Mabel's favorite", text: 'Mabel and the Potted Fern.', points: 24, when: { kind: 'beat', beat: 'green-thumb', character: 'mabel', signature: true } },
      { id: 'house-call-c3', title: 'Moments worth keeping', text: 'Record at least 4 story moments.', points: 16, when: { kind: 'beats', count: 4 } },
    ],
  },
  {
    id: 'signature-hunt', label: 'Signature Evening', theme: 'nightfall', layout: 'manor',
    tray: ['pip', 'mabel', 'otto', 'luna', 'biscuit', 'clock', 'fern', 'basket', 'telescope', 'yarn'],
    allowUndo: false, ranked: true,
    blurb: 'Five friends, five favorites. Match them all.',
    cards: [
      { id: 'signature-hunt-c1', title: "Pip's favorite", text: 'Pip and the Old Clock.', points: 24, when: { kind: 'beat', beat: 'time-check', character: 'pip', signature: true } },
      { id: 'signature-hunt-c2', title: "Luna's favorite", text: 'Luna and the Telescope.', points: 24, when: { kind: 'beat', beat: 'stargazing', character: 'luna', signature: true } },
      { id: 'signature-hunt-c3', title: "Biscuit's favorite", text: 'Biscuit and the Ball of Yarn.', points: 24, when: { kind: 'beat', beat: 'playtime', character: 'biscuit', signature: true } },
      { id: 'signature-hunt-c4', title: 'A varied day', text: 'Create 4 different kinds of story moment.', points: 18, when: { kind: 'variety', count: 4 } },
    ],
  },
  {
    id: 'grand-gala', label: 'The Grand Gala', theme: 'porcelain', layout: 'manor',
    tray: ['pip', 'mabel', 'otto', 'luna', 'biscuit', 'teapot', 'piano', 'book', 'lamp', 'basket'],
    limitedPlan: true, mastery: true, allowUndo: false, ranked: true,
    blurb: 'Everyone is invited. The house must shine in a handful of moves.',
    cards: [
      { id: 'grand-gala-c1', title: 'All over the house', text: 'Pieces in at least 6 rooms.', points: 16, when: { kind: 'coverage', count: 6 } },
      { id: 'grand-gala-c2', title: 'A varied day', text: 'Create 5 different kinds of story moment.', points: 18, when: { kind: 'variety', count: 5 } },
      { id: 'grand-gala-c3', title: 'Moments worth keeping', text: 'Record at least 8 story moments.', points: 16, when: { kind: 'beats', count: 8 } },
      { id: 'grand-gala-c4', title: 'Melody in the Parlor', text: 'Music where the guests gather.', points: 20, when: { kind: 'beat', beat: 'melody', roomType: 'parlor' } },
    ],
  },
];

export function challengeContent(id) {
  const c = CHALLENGES.find(x => x.id === id);
  if (!c) return null;
  const seed = deriveSeed('challenge', CONTENT_VERSION, id);
  const partial = {
    contentId: `challenge-${id}`,
    seed,
    layout: LAYOUTS[c.layout], tray: c.tray.slice(), theme: c.theme, mode: 'challenge',
    label: c.label, blurb: c.blurb, ranked: c.ranked, allowUndo: c.allowUndo,
    timeLimitMs: c.timeLimitMs ?? null, timeBonus: c.timeBonus ?? false, parTimeMs: c.parTimeMs ?? null,
    mastery: !!c.mastery,
  };
  partial.cards = c.cards.map(card => ({ ...card, when: { ...card.when } }));
  const content = finalizeContent(partial, { slackMoves: 0 });
  if (c.limitedPlan) {
    const plan = planContent(content);
    content.moveLimit = plan.commands.length + (id === 'grand-gala' ? 6 : 2);
    content.par = [0.55, 0.75, 0.9].map(f => Math.round((plan.score.total * f) / 5) * 5);
  } else if (c.timeBonus) {
    content.par = [60, 110, 160]; // includes time bonus headroom
  }
  return content;
}

// ---------------------------------------------------------------------------
// Score chase — seeded, ranked, replay-validated
// ---------------------------------------------------------------------------
export function scoreChaseContent(seed) {
  const rng = new RngStream(deriveSeed('score', CONTENT_VERSION, seed));
  const tray = rng.shuffle([
    ...rng.shuffle(CHAR_KEYS).slice(0, 3),
    ...rng.shuffle(PROP_KEYS).slice(0, 4),
  ]);
  const theme = THEME_ORDER[rng.int(0, THEME_ORDER.length - 1)];
  const partial = {
    contentId: `score-${seed}`,
    seed: rng.int(1, 0x7fffffff),
    layout: LAYOUTS.manor, tray, theme, mode: 'score',
    label: `Score Chase #${seed}`,
    blurb: 'One house, one seed, everyone ranked on the same terms.',
    ranked: true, allowUndo: false,
  };
  partial.cards = makeCards(rng, partial, ['habitatBeat', 'signature', 'coverage', 'variety'], partial.contentId);
  return finalizeContent(partial);
}

// ---------------------------------------------------------------------------
// Learn — interactive lessons; each step requires the player to act.
// ---------------------------------------------------------------------------
export const LESSONS = [
  {
    id: 'learn-1', title: 'Moving In', theme: 'meadow', layout: 'cottage',
    tray: ['pip', 'teapot'],
    cards: [],
    intro: 'Welcome to your storyhouse. Let us give Pip a spot in the Kitchen.',
    steps: [
      { text: 'Select Pip on the tray, then choose a glowing spot in the Kitchen.', require: { type: 'place', item: 'pip', roomType: 'kitchen' } },
      { text: 'Well placed! Now save the scene to finish your first story.', require: { type: 'finish' } },
    ],
  },
  {
    id: 'learn-2', title: 'A Proper Cup', theme: 'meadow', layout: 'cottage',
    tray: ['otto', 'teapot'],
    cards: [
      { id: 'learn-2-c1', title: 'Tea break in the Kitchen', text: 'Tea tastes best in the Kitchen.', points: 20, when: { kind: 'beat', beat: 'tea-break', roomType: 'kitchen' } },
    ],
    intro: 'Pieces come alive together. Let us make a story moment.',
    steps: [
      { text: 'Place Otto in the Kitchen.', require: { type: 'place', item: 'otto', roomType: 'kitchen' } },
      { text: 'Place the Teapot in the Kitchen too.', require: { type: 'place', item: 'teapot', roomType: 'kitchen' } },
      { text: 'Now make a moment: choose Interact with Otto and the Teapot selected.', require: { type: 'interact' } },
      { text: 'A tea break! Save the scene to keep it.', require: { type: 'finish' } },
    ],
  },
  {
    id: 'learn-3', title: 'Moving Day', theme: 'rosewood', layout: 'cottage',
    tray: ['mabel', 'fern', 'book'],
    cards: [],
    intro: 'Stories change. Pieces can move rooms or return to the tray.',
    steps: [
      { text: 'Place Mabel anywhere in the house.', require: { type: 'place', item: 'mabel' } },
      { text: 'Now move Mabel to a different room — drag her, or select her and pick a new spot.', require: { type: 'move', item: 'mabel' } },
      { text: 'Place the Potted Fern, then send it back to the tray with Remove.', require: { type: 'remove', item: 'fern' } },
      { text: 'Save the scene whenever you are ready.', require: { type: 'finish' } },
    ],
  },
  {
    id: 'learn-4', title: 'Good Company', theme: 'seaglass', layout: 'cottage',
    tray: ['luna', 'biscuit', 'yarn'],
    cards: [
      { id: 'learn-4-c1', title: 'Good company', text: 'Luna and Biscuit share a room.', points: 14, when: { kind: 'together', a: 'luna', b: 'biscuit' } },
    ],
    intro: 'Two characters in a room can share a heart to heart.',
    steps: [
      { text: 'Place Luna and Biscuit in the same room.', require: { type: 'custom', check: 'together:luna:biscuit' } },
      { text: 'Make a heart to heart between them.', require: { type: 'interact' } },
      { text: 'Save the scene to finish the lesson.', require: { type: 'finish' } },
    ],
  },
  {
    id: 'learn-5', title: 'Favorites', theme: 'nightfall', layout: 'cottage',
    tray: ['pip', 'clock', 'lamp'],
    cards: [
      { id: 'learn-5-c1', title: "Pip's favorite", text: 'Pip and the Old Clock.', points: 24, when: { kind: 'beat', beat: 'time-check', character: 'pip', signature: true } },
    ],
    intro: 'Every character has a favorite thing. Signature moments shine brighter.',
    steps: [
      { text: 'Place Pip and the Old Clock in one room, then make their moment.', require: { type: 'interact' } },
      { text: 'That golden glow means a signature moment. Save the scene.', require: { type: 'finish' } },
    ],
  },
  {
    id: 'learn-6', title: 'The Whole House', theme: 'porcelain', layout: 'manor',
    tray: ['pip', 'mabel', 'otto', 'teapot', 'book', 'fern'],
    cards: [
      { id: 'learn-6-c1', title: 'All over the house', text: 'Pieces in at least 3 rooms.', points: 16, when: { kind: 'coverage', count: 3 } },
      { id: 'learn-6-c2', title: 'A varied day', text: 'Create 2 different kinds of story moment.', points: 18, when: { kind: 'variety', count: 2 } },
    ],
    intro: 'Discovery cards are optional goals. The Hint button always suggests a legal next step.',
    steps: [
      { text: 'Use Hint if you like, and complete both discovery cards.', require: { type: 'custom', check: 'cards-done' } },
      { text: 'Lovely. Save the scene — you are ready for the Journey.', require: { type: 'finish' } },
    ],
  },
];

export function lessonContent(id) {
  const l = LESSONS.find(x => x.id === id);
  if (!l) return null;
  const partial = {
    contentId: id,
    seed: deriveSeed('lesson', CONTENT_VERSION, id),
    layout: LAYOUTS[l.layout], tray: l.tray.slice(), theme: l.theme, mode: 'learn',
    label: l.title, blurb: l.intro, ranked: false, allowUndo: true,
  };
  partial.cards = l.cards.map(c => ({ ...c, when: { ...c.when } }));
  return finalizeContent(partial);
}

// ---------------------------------------------------------------------------
// Achievements — small static set, stable lowercase keys, idempotent unlocks
// ---------------------------------------------------------------------------
export const ACHIEVEMENTS = [
  { id: 'first-scene',     name: 'First Story',          desc: 'Save your very first scene.' },
  { id: 'mechanic-master', name: 'Every Kind of Moment', desc: 'Trigger all eleven kinds of story beat.' },
  { id: 'streak-3',        name: 'Three Evenings',       desc: 'Play Storyhouse on three different days.' },
  { id: 'mastery-crown',   name: 'Mastery Crown',        desc: 'Earn three stars on any Mastery stage.' },
  { id: 'curator',         name: 'Curator',              desc: 'Collect 25 discovery cards across your saved scenes.' },
];

// ---------------------------------------------------------------------------
// Offline validators — prove legality, reachable goals, bounded duration,
// and absence of soft locks. Run in tests and by the server on submission.
// ---------------------------------------------------------------------------
export function validateContent(content) {
  const problems = [];
  const err = (m) => problems.push(m);
  if (!content.contentId) err('missing contentId');
  if (!Number.isInteger(content.seed)) err('seed must be an integer');
  const roomIds = new Set();
  let totalSlots = 0;
  for (const r of content.layout.rooms) {
    if (roomIds.has(r.id)) err(`duplicate room id ${r.id}`);
    roomIds.add(r.id);
    if (!ROOM_TYPES[r.type]) err(`unknown room type ${r.type}`);
    if (!(r.slots >= 2)) err(`room ${r.id} has too few slots`);
    totalSlots += r.slots;
  }
  const roomTypes = content.layout.rooms.map(r => r.type);
  for (const key of content.tray) {
    if (!content.items[key]) err(`tray item ${key} missing from items`);
  }
  const chars = content.tray.filter(k => content.items[k]?.kind === 'character');
  if (!chars.length) err('no characters in tray');
  if (content.tray.length > totalSlots) err('tray cannot fit in the house');

  const cardIds = new Set();
  for (const card of content.cards) {
    if (cardIds.has(card.id)) err(`duplicate card id ${card.id}`);
    cardIds.add(card.id);
    if (!(card.points > 0)) err(`card ${card.id} has no points`);
    const w = card.when;
    switch (w.kind) {
      case 'beat': {
        const def = BEATS[w.beat];
        if (!def) { err(`card ${card.id}: unknown beat ${w.beat}`); break; }
        if (def.prop && !content.tray.includes(def.prop)) err(`card ${card.id}: prop ${def.prop} not in tray`);
        if (w.character && !content.tray.includes(w.character)) err(`card ${card.id}: character ${w.character} not in tray`);
        if (w.roomType && !roomTypes.includes(w.roomType)) err(`card ${card.id}: no ${w.roomType} room`);
        if (def.charPair && chars.length < 2) err(`card ${card.id}: needs two characters`);
        break;
      }
      case 'placement':
        if (!content.tray.includes(w.item)) err(`card ${card.id}: item ${w.item} not in tray`);
        if (w.roomType && !roomTypes.includes(w.roomType)) err(`card ${card.id}: no ${w.roomType} room`);
        break;
      case 'together':
        if (!content.tray.includes(w.a) || !content.tray.includes(w.b)) err(`card ${card.id}: items not in tray`);
        break;
      case 'coverage':
        if (w.count > content.layout.rooms.length) err(`card ${card.id}: coverage ${w.count} > rooms`);
        if (w.count > content.tray.length) err(`card ${card.id}: coverage ${w.count} > tray`);
        break;
      case 'variety': {
        const props = content.tray.filter(k => content.items[k]?.kind === 'prop');
        const types = new Set(props.map(p => PROP_TO_BEAT[p]).filter(Boolean));
        if (chars.length >= 2) types.add('heart-to-heart');
        if (w.count > types.size) err(`card ${card.id}: variety ${w.count} > achievable ${types.size}`);
        break;
      }
      case 'placed':
        if (w.count > Math.min(totalSlots, content.tray.length)) err(`card ${card.id}: placed ${w.count} unreachable`);
        break;
      case 'beats': {
        const props = content.tray.filter(k => content.items[k]?.kind === 'prop');
        const maxBeats = content.layout.rooms.length *
          (chars.length * props.length + (chars.length * (chars.length - 1)) / 2);
        if (w.count > maxBeats) err(`card ${card.id}: beats ${w.count} unreachable`);
        break;
      }
      default: err(`card ${card.id}: unknown when kind ${w.kind}`);
    }
  }

  // Reachability: the planner must complete every card within the move limit.
  try {
    const plan = planContent(content);
    if (content.moveLimit !== null && plan.commands.length > content.moveLimit) {
      err(`plan needs ${plan.commands.length} moves but limit is ${content.moveLimit}`);
    }
    const pending = content.cards.filter(c => plan.state.cards[c.id] !== 1);
    if (pending.length) err(`planner left cards undone: ${pending.map(c => c.id).join(', ')}`);
  } catch (e) {
    err('planner failed: ' + e.message);
  }

  // Bounded duration and reachable pars.
  const max = maxScore(content);
  if (!Number.isFinite(max)) err('unbounded score');
  if (!Array.isArray(content.par) || content.par.length !== 3) err('par must have 3 thresholds');
  else {
    if (!(content.par[0] <= content.par[1] && content.par[1] <= content.par[2])) err('par not increasing');
    if (content.par[2] > max) err(`par3 ${content.par[2]} > max score ${max}`);
  }
  return problems;
}
