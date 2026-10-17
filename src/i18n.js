// i18n.js — Storyhouse localization.
//
// Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
// English source strings are the keys; strings.js holds the tables (en-GB,
// es-ES and fr-CA list only their differences from en-US, es-419 and fr-FR).
// The locale comes from the game's Language setting through sh-language.js
// (explicit choice → StarHermit account preferredLanguage → navigator.languages
// → en-US); ?lang= forces one for the page load (QA links) and hides the
// selector.
//
// Static markup in index.html is translated in place: every text node and
// aria-label/title/placeholder/alt under <body> whose English text is a key.
// Subtrees marked data-i18n-skip and <kbd> keys are left alone. Code that
// writes text uses T() and re-renders on onLanguage() / the `story-language`
// event.
import { ROWS, OVERRIDES } from './strings.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const COLUMNS = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];
const PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
const ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];

export const TABLES = { 'en-US': {} };
for (const row of ROWS) {
  TABLES['en-US'][row[0]] = row[0];
  COLUMNS.forEach((l, i) => { (TABLES[l] || (TABLES[l] = {}))[row[0]] = row[i + 1]; });
}
for (const [l, table] of Object.entries(OVERRIDES)) TABLES[l] = { ...table };

let lang = 'en-US';
const listeners = new Set();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function lookup(key) {
  for (let l = lang; l; l = PARENT[l]) {
    const t = TABLES[l];
    if (t && own(t, key)) return t[key];
  }
  return key;
}

/** Translate an English source string; {name} placeholders are filled from vars. */
export function T(key, vars) {
  let s = lookup(String(key));
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (own(vars, k) ? String(vars[k]) : m));
  return s;
}
/** True when the English text is a known key (authored content vs generated text). */
export function hasKey(key) { return own(TABLES['en-US'], String(key)); }
export function currentLang() { return lang; }
/** Call fn(locale) after every language change; returns an unsubscribe function. */
export function onLanguage(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ---- static markup -------------------------------------------------------
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
let texts = [], attrs = [], scanned = false;
function skipped(el) {
  for (let n = el; n && n !== document.body; n = n.parentNode) {
    if (n.nodeType === 1 && (n.hasAttribute('data-i18n-skip') || ['KBD', 'SCRIPT', 'STYLE', 'NOSCRIPT'].includes(n.tagName))) return true;
  }
  return false;
}
function scan() {
  if (scanned || typeof document === 'undefined' || !document.body) return;
  scanned = true;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const key = norm(node.nodeValue);
    if (!/[A-Za-z]/.test(key) || skipped(node.parentNode) || !hasKey(key)) continue;
    const m = /^(\s*)[\s\S]*?(\s*)$/.exec(node.nodeValue);
    texts.push({ node, key, pre: m[1], post: m[2], last: node.nodeValue });
  }
  for (const el of document.body.querySelectorAll('[' + ATTRS.join('],[') + ']')) {
    if (skipped(el)) continue;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && /[A-Za-z]/.test(v) && hasKey(norm(v))) attrs.push({ el, attr: a, key: norm(v), last: v });
    }
  }
}
/** Re-apply the current language to the static markup (skips text the game has since replaced). */
export function applyStatic() {
  scan();
  for (const t of texts) {
    if (!t.node.parentNode || t.node.nodeValue !== t.last) continue;
    t.last = t.node.nodeValue = t.pre + T(t.key) + t.post;
  }
  for (const a of attrs) {
    if (a.el.getAttribute(a.attr) !== a.last) continue;
    a.last = T(a.key);
    a.el.setAttribute(a.attr, a.last);
  }
}

function setLocale(next) {
  const changed = next !== lang;
  lang = LOCALES.includes(next) ? next : 'en-US';
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  if (document.body) applyStatic();
  if (!changed) return;
  for (const fn of [...listeners]) { try { fn(lang); } catch (e) { console.error(e); } }
  if (typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('story-language', { detail: { lang } }));
}

const SL = typeof window !== 'undefined' ? window.StarHermitLanguage : null;
let forced = null;
try { forced = new URLSearchParams(window.location.search).get('lang'); } catch { /* no window / opaque origin */ }
const forcedLocale = forced && SL ? SL.match(forced, LOCALES) : null;

/** The sh-language.js instance (also window.GameLanguage); null outside the browser. */
export const language = SL ? SL.create({
  game: 'storyhouse', supported: LOCALES, panel: !forcedLocale,
  apply: (locale) => setLocale(forcedLocale || locale),
}) : null;
if (!language) setLocale('en-US');
if (typeof document !== 'undefined' && !document.body) document.addEventListener('DOMContentLoaded', applyStatic);
else if (typeof document !== 'undefined') applyStatic();
