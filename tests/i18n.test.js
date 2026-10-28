// Storyhouse — localization coverage for the engine client: every English key
// native/*.ts, the rules and the content show to players exists in all nine
// locales (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR inherit),
// placeholders survive translation, no table row is unused, and the locale
// follows the runtime's language tag with the regional fallbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { usedKeys } from './i18n-keys.js';

const { TABLES, LOCALES, T, currentLang, setLang, pickLocale } = await import('../src/i18n.js');
const { shText } = await import('../src/sh-i18n.js');
const PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
const has = (l, k) => { for (let x = l; x; x = PARENT[x]) if (TABLES[x] && Object.hasOwn(TABLES[x], k)) return TABLES[x][k]; return undefined; };
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every used key is translated in all nine locales with its placeholders', async () => {
  const keys = await usedKeys();
  assert.ok(keys.size > 300, `found ${keys.size} keys`);
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
  assert.deepEqual(Object.keys(TABLES['en-US']).filter((k) => !keys.has(k)), []);
  for (const [l, t] of Object.entries(TABLES)) if (PARENT[l]) assert.deepEqual(Object.keys(t).filter((k) => !keys.has(k)), [], l);
});

test('the language follows the runtime tag with the regional fallbacks, and T fills placeholders', () => {
  assert.equal(currentLang(), 'en-US');
  assert.equal(T('Moves {n}', { n: 12 }), 'Moves 12');
  assert.equal(T('No such key'), 'No such key');
  assert.equal(pickLocale('de'), 'de-DE');
  assert.equal(pickLocale('en-AU'), 'en-GB');
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('ja-JP'), 'en-US');
  for (const l of LOCALES) assert.equal(pickLocale(l), l);
  let seen = null;
  setLang('de-DE');
  assert.equal(T('Open Options'), 'Optionen öffnen');
  assert.equal(shText('signIn'), 'Mit StarHermit anmelden');
  setLang('en-GB');
  assert.equal(T('Color palette'), 'Colour palette');
  setLang('fr-CA');
  assert.equal(T('Open Options'), 'Ouvrir les options'); // inherited from fr-FR
  setLang('it-IT');
  assert.equal(T('Tray: {name}', { name: 'Pip' }), 'Vassoio: Pip');
  void seen;
  setLang('en-US');
  assert.equal(shText('signIn'), 'Sign in with StarHermit');
});
