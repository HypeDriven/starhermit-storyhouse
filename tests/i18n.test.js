// Storyhouse — localization coverage: every English key the code and the
// content data show to players exists in all nine locales (en-GB → en-US,
// es-ES → es-419, fr-CA → fr-FR inherit), placeholders survive translation,
// and the locale follows sh-language.js and switches live.
import test from 'node:test';
import assert from 'node:assert/strict';

import { read, usedKeys } from './i18n-keys.js';

const { TABLES, LOCALES, T, currentLang } = await import('../src/i18n.js');
const PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
const has = (l, k) => { for (let x = l; x; x = PARENT[x]) if (TABLES[x] && Object.hasOwn(TABLES[x], k)) return TABLES[x][k]; return undefined; };
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every used key is translated in all nine locales with its placeholders', async () => {
  const keys = await usedKeys();
  assert.ok(keys.size > 150, `found ${keys.size} keys`);
  const missing = [];
  for (const k of keys) {
    for (const l of LOCALES) {
      const v = has(l, k);
      if (typeof v !== 'string' || !v) missing.push(`${l}: ${k}`);
      else if (holes(v) !== holes(k)) missing.push(`${l}: placeholders differ in "${k}" → "${v}"`);
    }
  }
  assert.deepEqual(missing, []);
});

test('tables carry no unused rows (catches typos in keys)', async () => {
  const keys = await usedKeys();
  const unused = Object.keys(TABLES['en-US']).filter((k) => !keys.has(k));
  assert.deepEqual(unused, []);
});

test('T fills placeholders and falls back to English outside the browser', () => {
  assert.equal(currentLang(), 'en-US');
  assert.equal(T('Moves {n}', { n: 12 }), 'Moves 12');
  assert.equal(T('No such key'), 'No such key');
});

test('index.html loads sh-language.js before the game module', () => {
  const html = read('index.html');
  const lang = html.indexOf('src="sh-language.js"');
  assert.ok(lang > 0 && lang < html.indexOf('src="./src/main.js'));
});

test('the locale follows sh-language.js (device → choice) and switches live', async () => {
  const store = new Map();
  const win = { navigator: { languages: ['de-AT', 'en'] }, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) } };
  const mod = { exports: {} };
  new Function('module', 'window', read('sh-language.js'))(mod, win);
  const doc = { documentElement: {}, events: [], addEventListener() {}, dispatchEvent(e) { this.events.push(e.detail.lang); } };
  globalThis.window = { StarHermitLanguage: mod.exports, location: { search: '' } };
  globalThis.document = doc;
  try {
    const I = await import('../src/i18n.js?live');
    const seen = [];
    I.onLanguage((l) => seen.push(l));
    assert.equal(I.currentLang(), 'de-DE');
    assert.equal(doc.documentElement.lang, 'de-DE');
    assert.equal(I.T('Journey'), 'Reise');
    I.language.setChoice('fr-CA');
    assert.equal(I.currentLang(), 'fr-CA');
    assert.deepEqual(seen, ['fr-CA']);
    assert.deepEqual(doc.events, ['de-DE', 'fr-CA']);
    assert.equal(I.T('Score'), 'Pointage', 'fr-CA override');
    assert.equal(I.T('Journey'), 'Parcours', 'fr-CA inherits fr-FR');
    assert.equal(store.get('storyhouse.language.guest'), 'fr-CA');
    I.language.setChoice('auto');
    assert.equal(I.currentLang(), 'de-DE');
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});
