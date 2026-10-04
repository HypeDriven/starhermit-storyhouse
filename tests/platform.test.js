// platform.test.js — the StarHermit adapter over starhermit-sdk.js with a
// stubbed fetch and launch hash: token read, nickname, cloud-save path
// game:<slug> round-trip, settings patch, controls, and no network standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The SDK is a classic browser script; package.json "type": "module" makes
// Node treat .js as ESM, so evaluate it with a CommonJS shim.
const mod = { exports: {} };
new Function('module', 'exports', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(mod, mod.exports);
const SDK = mod.exports;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `x.${b64url({ sub: 'u-12345678', game_scope: 'storyhouse-test', exp: Math.floor(Date.now() / 1000) + 3600 })}.y`;

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i], get length() { return m.size; },
  };
}

function setup(hash, hostname = 'storyhouse-test.starhermit.com') {
  const calls = [];
  const store = new Map();
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body, auth: init.headers?.Authorization });
    const path = url.split('?')[0];
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (path.endsWith('/profile')) return json({ nickname: 'Mabel', username: 'mabel99' });
    if (path.includes('/cloud-saves/')) {
      if (init.method === 'PUT') { store.set(path, JSON.parse(init.body).dataBase64); return new Response(null, { status: 204 }); }
      return store.has(path) ? new Response(Buffer.from(store.get(path), 'base64')) : new Response(null, { status: 404 });
    }
    if (path.endsWith('/settings')) return init.method === 'PATCH' ? new Response(null, { status: 204 }) : json({ settings: { music: 12 } });
    if (path.endsWith('/controls')) return json({ actions: [{ action: 'hint', codes: ['KeyJ'] }] });
    return new Response(null, { status: 404 });
  };
  const location = { hash, search: '', pathname: '/index.html', hostname, href: `https://${hostname}/index.html${hash}` };
  const win = { location, history: { state: null, replaceState: (_s, _t, u) => { location.hash = u.includes('#') ? u.slice(u.indexOf('#')) : ''; } } };
  globalThis.location = location;
  globalThis.localStorage = memStorage();
  return { calls, sdk: SDK.create({ window: win, fetch }), location };
}

const { Platform } = await import('../src/platform.js');
const { defaultBindings } = await import('../src/persist.js');

test('launch token: read from the hash, stripped, nickname resolved', async () => {
  const { sdk, location } = setup('#game_token=' + JWT + '&session_id=abc');
  const p = await new Platform(sdk).init();
  assert.equal(p.hosted, true);
  assert.equal(sdk.slug, 'storyhouse-test');
  assert.equal(sdk.userId, 'u-12345678');
  assert.equal(location.hash, '');
  const prof = await p.ensureProfile();
  assert.equal(prof.name, 'Mabel');
  sdk.signOut();
});

test('cloud save: game:<slug> path round-trips progress and scenes', async () => {
  const { sdk, calls } = setup('#game_token=' + JWT);
  const p = await new Platform(sdk).init();
  p.saveScene({ id: 's1', title: 'Tea time' });
  const sealed = p.saveProgress({ ...p.loadProgress(), scenesCount: 3 });
  await sdk.flushSave();
  const put = calls.find(c => c.method === 'PUT');
  assert.ok(put.url.endsWith('/api/v1/me/cloud-saves/' + encodeURIComponent('game:storyhouse-test')));
  assert.equal(put.auth, 'Bearer ' + JWT);
  const doc = await p.loadCloudSave();
  assert.deepEqual(doc.progress, sealed);
  assert.equal(doc.scenes[0].id, 's1');
  sdk.signOut();
});

test('settings KV: platform values load, changes PATCH; controls override defaults', async () => {
  const { sdk, calls } = setup('#game_token=' + JWT);
  const p = await new Platform(sdk).init();
  const s = p.loadSettings();
  assert.deepEqual(await p.loadPlatformSettings(s), { music: 12 });
  p.pushSettings({ ...s, music: 12, mute: true });
  await new Promise(r => setTimeout(r, 900));
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch.url.endsWith('/api/v1/games/storyhouse-test/settings'));
  assert.deepEqual(JSON.parse(patch.body), { settings: { mute: true } });
  const b = await p.loadBindings(defaultBindings());
  assert.deepEqual(b.hint, ['KeyJ']);
  assert.deepEqual(b.undo, ['KeyU']);
  assert.match(p.inviteLink(), /\/game-invite\/u-12345678\/storyhouse-test$/);
  sdk.signOut();
});

test('standalone: no token means no network and local behaviour', async () => {
  const { sdk, calls } = setup('', 'example.com');
  const p = await new Platform(sdk).init();
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), false);
  assert.equal(p.inviteLink(), null);
  const prof = await p.ensureProfile();
  assert.equal(prof.local, true);
  p.saveProgress(p.loadProgress());
  p.pushSettings(p.loadSettings());
  assert.equal(await p.loadCloudSave(), null);
  assert.equal(await p.loadPlatformSettings({}), null);
  await new Promise(r => setTimeout(r, 900));
  assert.equal(calls.length, 0);
});

test('standalone on localhost: no own-server probes (no /api/v1/config)', async () => {
  const { sdk, calls } = setup('', '127.0.0.1');
  const own = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { own.push(String(u)); throw new Error('offline'); };
  try {
    const p = await new Platform(sdk).init();
    assert.equal(p.hosted, false);
    assert.equal((await p.ensureProfile()).local, true);
    const r = await p.submitScore({ sessionId: 's', mode: 'daily', contentId: 'c', score: { total: 1, components: {}, cardsDone: 1, invalid: 0, elapsedMs: 1, stars: 1 } });
    assert.equal(r.source, 'local');
    assert.equal((await p.leaderboard('global')).source, 'local');
    await p.unlockAchievement('a', { achievements: {} });
    assert.ok(Math.abs(p.now().getTime() - Date.now()) < 1000);
    assert.deepEqual(own, []);
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = prevFetch; }
});

test('sign-in is offered on the platform host without a token', async () => {
  const { sdk, calls } = setup('');
  const p = await new Platform(sdk).init();
  assert.equal(p.canSignIn(), true);
  assert.equal(calls.length, 0);
});
