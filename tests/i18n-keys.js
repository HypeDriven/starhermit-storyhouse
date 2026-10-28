// Storyhouse — collects the English i18n keys the engine client, the rules and
// the content show to players: T("…") / N("…") in native/*.ts (and both
// strings of a T(c ? "…" : "…")), captionHook("…") and SAMPLE_CAPTIONS in
// native/audio.ts, src/loc.js's T('…'), the rules' invalid-move reasons and
// hint reasons, and the content's names, labels, lessons, challenges and
// achievements.
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
export const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const unq = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"');
const LIT = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;

export function codeKeys() {
  const keys = new Set();
  const add = (re, src) => { for (const m of src.matchAll(re)) for (const g of m.slice(1)) if (g !== undefined) keys.add(unq(g)); };
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    const src = read(`native/${f}`);
    add(new RegExp(String.raw`\b(?:T|N|t|captionHook)\(\s*(?:${LIT})`, 'g'), src);
    add(new RegExp(String.raw`\bT\((?:[^()'"?;]|'[^'\n]*'|"[^"\n]*"|\([^()]*\))*\?\s*(?:${LIT})\s*:\s*(?:${LIT})`, 'g'), src);
  }
  const audio = read('native/audio.ts');
  const caps = audio.match(/const SAMPLE_CAPTIONS[^=]*= \{([\s\S]*?)\};/);
  for (const m of caps[1].matchAll(new RegExp(':\\s*(?:' + LIT + ')', 'g'))) keys.add(unq(m[1] ?? m[2]));
  add(new RegExp(String.raw`\bT\(\s*(?:${LIT})`, 'g'), read('src/loc.js'));
  const rules = read('src/rules.js');
  const reasons = rules.match(/const REASONS = \{([\s\S]*?)\};/);
  for (const m of reasons[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(unq(m[1]));
  keys.add('That action is not allowed.');
  keys.add('Go'); // the countdown's last beat (main.ts seq)
  for (const m of rules.matchAll(/why: '([^']+)'/g)) keys.add(m[1]);
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

export async function contentKeys() {
  const C = await import('../src/content.js');
  const R = await import('../src/rules.js');
  const keys = new Set();
  Object.values(C.ALL_ITEMS).forEach((i) => keys.add(i.name));
  Object.values(C.ROOM_TYPES).forEach((r) => keys.add(r.name));
  Object.values(C.LAYOUTS).forEach((l) => { keys.add(l.label); l.rooms.forEach((r) => keys.add(r.name)); });
  Object.values(C.THEMES).forEach((t) => keys.add(t.label));
  Object.values(R.BEATS).forEach((b) => keys.add(b.label));
  C.CHAPTERS_PUB.forEach((ch) => { keys.add(ch.title); ch.names.forEach((n) => keys.add(n)); });
  Object.values(C.PRACTICE_DIFFICULTIES).forEach((d) => keys.add(d.label));
  keys.add('A tighter house with a move limit.'); keys.add('An open house with no limits.');
  keys.add('One shared house for everyone, today only.'); keys.add('One house, one seed, everyone ranked on the same terms.');
  for (const c of C.CHALLENGES) { keys.add(c.label); keys.add(c.blurb); c.cards.forEach((k) => keys.add(k.text)); }
  for (const l of C.LESSONS) { keys.add(l.title); keys.add(l.intro); l.steps.forEach((s) => keys.add(s.text)); l.cards.forEach((k) => keys.add(k.text)); }
  C.ACHIEVEMENTS.forEach((a) => { keys.add(a.name); keys.add(a.desc); });
  return keys;
}

export async function usedKeys() {
  const names = new Set(['Pip', 'Mabel', 'Otto', 'Luna', 'Biscuit', 'Storyhouse']);
  return new Set([...codeKeys(), ...(await contentKeys())].filter((k) => !names.has(k) && /[A-Za-z]/.test(k)));
}
