// i18n.js — Storyhouse localization.
//
// Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
// English source strings are the keys; strings.js holds the tables (en-GB,
// es-ES and fr-CA list only their differences from en-US, es-419 and fr-FR).
// The engine client sets the locale from the runtime's interface language
// (native/i18n.ts → setLang); node tests get English unless they set one.
// Every string is drawn through T() each frame, so a change shows on the next
// frame without a restart.
import { ROWS, OVERRIDES } from './strings.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const COLUMNS = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];
const PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
const FALLBACK_BY_LANG = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

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
/** Marks an English key that is translated with T() where it is shown. */
export const N = (key) => key;
/** True when the English text is a known key (authored content vs generated text). */
export function hasKey(key) { return own(TABLES['en-US'], String(key)); }
export function currentLang() { return lang; }
/** Call fn(locale) after every language change; returns an unsubscribe function. */
export function onLanguage(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** The closest supported locale for a BCP-47 tag (defaults to en-US). */
export function pickLocale(tag) {
  const t = String(tag || '').replace('_', '-');
  const exact = LOCALES.find((k) => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const base = t.split('-')[0].toLowerCase();
  if (base === 'en' && /-(gb|uk|ie|au|nz|za|in)$/i.test(t)) return 'en-GB';
  if (base === 'es' && /-es$/i.test(t)) return 'es-ES';
  if (base === 'fr' && /-ca$/i.test(t)) return 'fr-CA';
  return FALLBACK_BY_LANG[base] || 'en-US';
}

/** Sets the game language (any tag; the closest supported locale is used). Returns it. */
export function setLang(tag) {
  const next = pickLocale(tag);
  if (next === lang) return lang;
  lang = next;
  for (const fn of [...listeners]) { try { fn(lang); } catch (e) { console.error(String(e)); } }
  return lang;
}
