// loc.js — player-facing names for content.js / rules.js data. The content
// modules stay English (they feed hashes, replays and the server); these
// helpers translate at display time, rebuilding generated card and stage
// text from their structured fields so every language reads naturally.
import { T, hasKey } from './i18n.js';
import { ALL_ITEMS, ROOM_TYPES, LAYOUTS, THEMES, CHAPTERS_PUB, PRACTICE_DIFFICULTIES } from './content.js';
import { BEATS, SIGNATURES } from './rules.js';

const NAMES = new Set(['Pip', 'Mabel', 'Otto', 'Luna', 'Biscuit']); // character names stay as they are

/** An item (character or prop) by key or by its English name. */
export function itemName(keyOrName) {
  const name = ALL_ITEMS[keyOrName]?.name ?? keyOrName;
  return NAMES.has(name) ? name : T(name);
}
export function itemKind(kind) { return kind === 'character' ? T('character') : T('prop'); }
export function roomTypeName(type) { return T(ROOM_TYPES[type]?.name ?? type); }
/** A room in a game state (its English name comes from the layout). */
export function roomName(room) { return room ? T(room.name) : ''; }
export function beatLabel(type) { return T(BEATS[type]?.label ?? type); }
export function layoutLabel(layout) { return T(layout?.label ?? (LAYOUTS[layout]?.label) ?? ''); }
export function themeLabel(id) { return T(THEMES[id]?.label ?? id); }

/** Discovery card title, built from its condition. */
export function cardTitle(c) {
  const w = c.when || {};
  if (w.kind === 'beat' && w.signature && w.character) return T('{name}\'s favorite', { name: itemName(w.character) });
  if (w.kind === 'beat' && w.roomType) return T('{beat} in the {room}', { beat: beatLabel(w.beat), room: roomTypeName(w.roomType) });
  if (w.kind === 'placement') return T('{name} settles in', { name: itemName(w.item) });
  if (w.kind === 'together') return T('Good company');
  if (w.kind === 'coverage') return T('All over the house');
  if (w.kind === 'variety') return T('A varied day');
  if (w.kind === 'beats') return T('Moments worth keeping');
  return T(c.title);
}
/** Discovery card text: authored text when it has a translation, else rebuilt from its condition. */
export function cardText(c) {
  if (hasKey(c.text)) return T(c.text);
  const w = c.when || {};
  if (w.kind === 'beat' && w.signature && w.character) {
    return T('{name} has a special bond with the {item}. Bring them together.', { name: itemName(w.character), item: itemName(SIGNATURES[w.character]) });
  }
  if (w.kind === 'beat' && w.roomType) {
    return T('Let someone enjoy the {item} where it belongs: the {room}.', { item: itemName(BEATS[w.beat]?.prop), room: roomTypeName(w.roomType) });
  }
  if (w.kind === 'placement') return T('Give {name} a spot in the {room}.', { name: itemName(w.item), room: roomTypeName(w.roomType) });
  if (w.kind === 'together') return T('{a} and {b} should share a room.', { a: itemName(w.a), b: itemName(w.b) });
  if (w.kind === 'coverage') return T('Have pieces in at least {n} different rooms.', { n: w.count });
  if (w.kind === 'variety') return T('Create {n} different kinds of story moment.', { n: w.count });
  if (w.kind === 'beats') return T('Record at least {n} story moments.', { n: w.count });
  return c.text;
}

/** Story label (journey stage, daily, practice, challenge, lesson, score chase). */
export function contentLabel(content) {
  const label = String(content?.label || '');
  let m;
  if ((m = /^Daily Story — (.+)$/.exec(label))) return T('Daily Story — {date}', { date: m[1] });
  if ((m = /^Practice — (.+)$/.exec(label))) {
    const d = Object.values(PRACTICE_DIFFICULTIES).find((x) => x.label === m[1]);
    return T('Practice — {difficulty}', { difficulty: d ? T(d.label) : m[1] });
  }
  if ((m = /^Score Chase #(.+)$/.exec(label))) return T('Score Chase #{seed}', { seed: m[1] });
  return label ? T(label) : (content?.contentId || '');
}
export function contentBlurb(content) {
  const blurb = String(content?.blurb || '');
  const m = /^(.+) — stage (\d+) of 9$/.exec(blurb);
  if (m) return T('{chapter} — stage {n} of 9', { chapter: T(m[1]), n: m[2] });
  return blurb ? T(blurb) : '';
}
export function chapterTitle(i) { return T(CHAPTERS_PUB[i]?.title ?? ''); }
