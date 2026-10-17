// Storyhouse — collects the English i18n keys the markup, code and content show to players.
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
export const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const unq = (s) => s.replace(/\\'/g, "'");
const STR = String.raw`'((?:[^'\\]|\\.)*)'`;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m);
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Static <body> keys, as src/i18n.js collects them (data-i18n-skip subtrees left out). */
export function htmlKeys() {
  let body = read('index.html');
  body = body.slice(body.indexOf('<body'), body.lastIndexOf('</body>'));
  body = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/g, '');
  for (;;) {
    const m = /<(\w+)[^>]*\bdata-i18n-skip\b[^>]*>/.exec(body);
    if (!m) break;
    const re = new RegExp('<(/?)' + m[1] + '\\b[^>]*>', 'gi');
    re.lastIndex = m.index + m[0].length;
    let depth = 1, t;
    while (depth && (t = re.exec(body))) depth += t[1] ? -1 : 1;
    body = body.slice(0, m.index) + body.slice(t ? re.lastIndex : body.length);
  }
  const keys = new Set();
  for (const m of body.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*)"/g)) keys.add(norm(decode(m[2])));
  for (const m of body.matchAll(/>([^<>]+)</g)) keys.add(norm(decode(m[1])));
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

/** Keys passed to T(), English tables kept in code (dialogs, rows, labels, captions). */
export function codeKeys() {
  const keys = new Set();
  const add = (re, src) => { for (const m of src.matchAll(re)) for (const g of m.slice(1)) if (g !== undefined) keys.add(unq(g)); };
  for (const f of ['src/ui.js', 'src/main.js', 'src/loc.js']) {
    const src = read(f);
    add(new RegExp(String.raw`\bT\(` + STR, 'g'), src);
    add(new RegExp(String.raw`\bT\([^;\n]*?\?\s*` + STR + String.raw`\s*:\s*` + STR, 'g'), src);
    add(new RegExp(String.raw`\b(?:title|text|label|example|mode|rankedNote|startLabel|headline|nextLabel): ` + STR, 'g'), src);
    add(new RegExp(String.raw`\b(?:title|text|label|example|mode|rankedNote|startLabel): [^,\n]*?\?\s*` + STR + String.raw`\s*:\s*` + STR, 'g'), src);
    add(new RegExp(String.raw`\[` + STR + String.raw`,\s*(?:T\(|layoutLabel|today|content\.|String\(|c\.|dd\.|score\.|\(\) =>|\`)`, 'g'), src);
    add(new RegExp(String.raw`\[` + STR + String.raw`,\s*\[`, 'g'), src);
    add(new RegExp(String.raw`\['\w+',\s*` + STR + String.raw`\]`, 'g'), src);
    add(new RegExp(String.raw`mk\(` + STR, 'g'), src);
    add(new RegExp(String.raw`\b(?:confirm|cancel|pause|undo|hint|camera|mute): ` + STR, 'g'), src);
    add(new RegExp(String.raw`'(?:scene-saved|move-limit|time-up)': ` + STR, 'g'), src);
    add(new RegExp(String.raw`\]\s*\|\|\s*` + STR, 'g'), src);
    add(new RegExp(String.raw`return ` + STR + String.raw`;`, 'g'), src);
    add(new RegExp(String.raw`\? ` + STR + String.raw` : ` + STR, 'g'), src);
  }
  // countdown word, help binding names, sync labels and invalid-move reasons
  for (const w of ['Go', 'Arrow keys', 'stick / dpad', 'gamepad shoulder buttons']) keys.add(w);
  const plat = read('src/platform.js').match(/syncLabel\(\) \{\s*return (\{[^}]*\})/);
  for (const m of plat[1].matchAll(new RegExp(':\\s*' + STR, 'g'))) keys.add(m[1]);
  keys.add('Local Guest');
  const rules = read('src/rules.js');
  const reasons = rules.match(/const REASONS = \{([\s\S]*?)\};/);
  for (const m of reasons[1].matchAll(new RegExp(':\\s*' + STR, 'g'))) keys.add(unq(m[1]));
  keys.add('That action is not allowed.');
  for (const m of rules.matchAll(/why: '([^']+)'/g)) keys.add(m[1]);
  const audio = read('src/audio.js');
  add(new RegExp(String.raw`caption\(` + STR, 'g'), audio);
  const caps = audio.match(/const SAMPLE_CAPTIONS = \{([\s\S]*?)\};/);
  for (const m of caps[1].matchAll(new RegExp(':\\s*' + STR, 'g'))) keys.add(unq(m[1]));
  for (const m of audio.matchAll(/(?:sig|hab): '([^']+)'/g)) keys.add(m[1]);
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

// The greedy code patterns also catch ids, CSS classes and sound names; those are not text.
const WORDS = new Set(['signature', 'character', 'prop', 'offline', 'unranked']);
const isText = (k) => !/^\s|\s$/.test(k) && k.length > 1 &&
  !(/^[a-z][a-z-]*$/.test(k) && !WORDS.has(k)) && !/^[a-z]+-[a-z-]+( [a-z-]+)?$/.test(k);

export async function usedKeys() {
  const names = new Set(['Pip', 'Mabel', 'Otto', 'Luna', 'Biscuit']);
  return new Set([...htmlKeys(), ...codeKeys(), ...(await contentKeys())].filter((k) => !names.has(k) && isText(k)));
}
