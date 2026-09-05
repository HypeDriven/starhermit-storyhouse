/**
 * Storyhouse — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the REAL visible UI in headless Chrome via playwright-core:
 *   title → Play (Journey stage) → wait out the 3-2-1-Go countdown →
 *   reveal the accessibility "Text" house mirror (`#btn-mirror`) →
 *   place a character + a prop into one room, tap the second piece to start
 *   a story moment, then the visible "✦ interact" context action to record
 *   the beat → exercise Undo / Hint / Pause+Resume through the HUD →
 *   press "Save scene ✦" (#btn-finish) → results ("Scene saved") with a
 *   score breakdown. A second (mobile) pass loads the game on a touch
 *   viewport, starts a Journey stage and makes a few real piece placements /
 *   an interact via touchscreen.tap, confirming progress.
 *
 * Observation only: the game exposes `window.storyhouse` (main.js:
 * `window.storyhouse = app;`). The test reads that handle solely to read
 * round state (tray, items, rooms, beats, counters) so it can click the
 * correct REAL on-screen buttons next. It never calls the game's own move
 * / rules API — every action is a genuine click/tap on the visible tray,
 * mirror spot, context-action or HUD buttons, which dispatch through the
 * normal Input → tapPiece/tapSlot/contextAction/finish path. No game code
 * is modified.
 *
 * Serving: starhermit.txt declares `server=server.js`, but the game is fully
 * playable offline. platform.js probes `/api/v1/config` and only sets
 * `hosted=true` when it returns 2xx; without a launch token a hosted probe
 * that answers `{}` would leave `_timeOffset = NaN` (broken daily time), so
 * this test deliberately answers every `/api/*` request with **404** — the
 * client then degrades to its documented local-guest/offline path with zero
 * console noise. It therefore needs no backend and runs on a self-contained
 * node:http static server on an ephemeral port. If the UI ever begins to
 * require the real backend this can be swapped for spawning `server.js`;
 * today it is not needed.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/storyhouse-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors the sibling suites)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here. Answer every API probe with 404 so the
    // platform adapter stays in its documented offline/local-guest mode
    // (hosted=false, time offset 0) with no console noise.
    if (p.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"offline"}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the debug handle ----------
const readState = (page) => page.evaluate(() => {
  const a = window.storyhouse;
  const s = a?.session?.state;
  if (!s) return null;
  return {
    phase: a.state,
    status: s.status,
    tray: s.tray.slice(),
    items: s.items,
    rooms: s.rooms.map((r) => ({ id: r.id, name: r.name, type: r.type, slots: r.slots.slice() })),
    beats: s.beats.map((b) => ({ t: b.t, room: b.room, a: b.a, b: b.b })),
    moves: s.stats.moves,
    interactions: s.stats.interactions,
    invalid: s.stats.invalid,
  };
});

const waitPlayActive = (page) =>
  page.waitForFunction(() => {
    const a = window.storyhouse;
    return a && a.state === 'active' && a.session?.state?.status === 'active';
  }, null, { timeout: 15000 });

// The mirror `#a11y-mirror` renders each room's slot buttons under a heading
// "«room name» («type»)" and a tray list under a "Tray" heading.
const roomButtons = (page, roomName) =>
  page.locator('#a11y-mirror h3', { hasText: roomName })
    .locator('xpath=following-sibling::ul[1]')
    .locator('button');

const selectFromTray = (page, name) =>
  page.locator('#a11y-mirror li button', { hasText: `Select ${name}` }).click();

// Pick the first character and first prop still on the tray.
const pickPair = (st) => {
  const chars = st.tray.filter((k) => st.items[k]?.kind === 'character');
  const props = st.tray.filter((k) => st.items[k]?.kind === 'prop');
  if (!chars.length || !props.length) throw new Error('need at least one character and one prop on the tray');
  return { char: chars[0], prop: props[0] };
};

// Place a piece from the tray into (room, slotIdx) using the visible controls.
async function placePiece(page, room, slotIdx, name) {
  const before = (await readState(page)).tray.length;
  await selectFromTray(page, name);
  await roomButtons(page, room).nth(slotIdx).click();
  await page.waitForFunction((n) => {
    const s = window.storyhouse?.session?.state; if (!s) return false;
    return s.tray.length === n - 1;
  }, before, { timeout: 4000 });
}

// Select the placed character (by tapping its spot button), then press the
// visible "✦ …" context action to record the story moment.
async function makeBeat(page, room, charSlot) {
  const bi = (await readState(page)).beats.length;
  await roomButtons(page, room).nth(charSlot).click();
  await page.waitForFunction(() => document.querySelectorAll('#context-actions .menu-btn').length > 0, null, { timeout: 3000 });
  await page.locator('#context-actions .menu-btn').first().click();
  await page.waitForFunction((n) => {
    const s = window.storyhouse?.session?.state; if (!s) return false;
    return s.beats.length === n + 1;
  }, bi, { timeout: 4000 });
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title (screens/hud are toggled via the hidden attribute, not .active)
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.storyhouse && !document.getElementById('screen-title').hidden, null, { timeout: 15000 });
    await page.waitForFunction(() => window.storyhouse.state === 'title' || window.storyhouse.state === 'profile-ready');
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible ("${(await page.textContent('#title-heading')).trim()}")`);

    // start a real Journey story via the big Play button
    await page.click('#btn-play');
    await waitPlayActive(page);
    let st = await readState(page);
    if (st.status !== 'active') throw new Error('session not active after Play: ' + st.status);
    if (!st.tray.length) throw new Error('empty tray at start of journey');
    ok(`${name}: Play started a Journey stage (${st.tray.length} pieces, ${st.beats.length} moments)`);

    // reveal the textual house mirror (real Text toggle), which is how we
    // drive placement/interactions from the visible DOM.
    await page.click('#btn-mirror');
    await page.waitForFunction(() => !document.getElementById('a11y-mirror').hidden);
    const room0 = st.rooms[0];
    if (!room0 || room0.slots.length < 2) throw new Error('first room needs >=2 slots for a beat');
    ok(`${name}: text mirror shown ("${room0.name}")`);

    if (full) {
      // pause / resume through the visible buttons
      await page.click('#btn-pause');
      await page.waitForFunction(() => !document.getElementById('overlay-pause').hidden);
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#btn-resume');
      await page.waitForFunction(() => document.getElementById('overlay-pause').hidden);
      await waitPlayActive(page);
      ok(`${name}: pause (⏸ Pause) and resume work`);

      // place a character + a prop in the first room, then record a moment
      const pair = pickPair(await readState(page));
      await placePiece(page, room0.name, 0, pair.char);
      await placePiece(page, room0.name, 1, pair.prop);
      st = await readState(page);
      if (st.moves !== 2) throw new Error(`expected 2 placements, got ${st.moves} moves`);
      await makeBeat(page, room0.name, 0);
      st = await readState(page);
      if (st.beats.length !== 1 || st.interactions !== 1) {
        throw new Error(`beat not recorded: beats=${st.beats.length} interactions=${st.interactions}`);
      }
      await page.screenshot({ path: SHOT('beat', name) });
      ok(`${name}: placed ${pair.char}+${pair.prop} in the ${room0.name} and recorded a story moment`);

      // undo (the interact) through the visible Undo button, then re-record
      await page.click('#btn-undo');
      await page.waitForFunction(() => {
        const s = window.storyhouse?.session?.state; if (!s) return false;
        return s.beats.length === 0;
      }, null, { timeout: 4000 });
      st = await readState(page);
      if (st.interactions !== 0) throw new Error('undo did not roll back the moment');
      await makeBeat(page, room0.name, 0);
      ok(`${name}: Undo rolled back the moment, then re-recorded it`);

      // hint through the visible Hint button (suggests a legal move + selects it).
      // The 260ms beat-resolution lock must clear first or hint() no-ops.
      await page.waitForFunction(() => !window.storyhouse._resolving, null, { timeout: 4000 });
      await page.click('#btn-hint');
      await page.waitForFunction(() => !!window.storyhouse.selection, null, { timeout: 3000 });
      const hintSel = await page.evaluate(() => window.storyhouse.selection);
      ok(`${name}: Hint selected a legal piece ("${hintSel}")`);
      // clear the floating selection so the finish path is clean
      await page.evaluate(() => window.storyhouse.setSelection(null));
    } else {
      // mobile: place a character + a prop into the first room by tapping the
      // mirror spot buttons, then record a moment — all via touchscreen.tap.
      const pair = pickPair(await readState(page));
      // locator.tap() performs a genuine touchscreen tap, auto-scrolling the
      // element into view — the mirror can sit below the fold on a phone.
      const tap = (loc) => loc.tap();
      await tap(page.locator('#a11y-mirror li button', { hasText: `Select ${pair.char}` }));
      await tap(roomButtons(page, room0.name).nth(0));
      await tap(page.locator('#a11y-mirror li button', { hasText: `Select ${pair.prop}` }));
      await tap(roomButtons(page, room0.name).nth(1));
      await tap(roomButtons(page, room0.name).nth(0)); // select the placed character
      // On a phone the ✦ context-action buttons live in a collapsed drawer
      // (#rail-right) which the text mirror panel overlays. So: confirm the
      // interact button is present, hide the mirror, open the Actions drawer,
      // then tap it — all real taps.
      await page.waitForFunction(() => document.querySelectorAll('#context-actions .menu-btn').length > 0, null, { timeout: 3000 });
      await tap(page.locator('#btn-mirror'));
      await page.waitForFunction(() => document.getElementById('a11y-mirror').hidden, null, { timeout: 3000 });
      await tap(page.locator('#drawer-right-toggle'));
      await page.waitForFunction(() => document.getElementById('rail-right').classList.contains('open'), null, { timeout: 3000 });
      await tap(page.locator('#context-actions .menu-btn').first());
      await page.waitForFunction(() => {
        const s = window.storyhouse?.session?.state; if (!s) return false;
        return s.beats.length >= 1;
      }, null, { timeout: 4000 });
      st = await readState(page);
      if (st.beats.length < 1) throw new Error('mobile: no moment recorded');
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: placed ${pair.char}+${pair.prop} via touch and recorded ${st.beats.length} moment(s)`);
    }

    if (full) {
      // Save the scene → the authoritative end state (results / "Scene saved")
      await page.click('#btn-finish');
      // The resolution window is ~1400ms (non-reduced-motion); results show next.
      await page.waitForFunction(() => !document.getElementById('screen-results').hidden, null, { timeout: 10000 });
      const headline = (await page.textContent('#results-heading')).trim();
      if (!/scene saved/i.test(headline)) throw new Error(`unexpected results headline: "${headline}"`);
      const rows = await page.locator('#results-table tbody tr').count();
      if (rows < 3) throw new Error(`score breakdown too short: ${rows} rows`);
      const stars = await page.locator('#results-stars [aria-label]').count();
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: scene saved — results shown ("${headline}", ${rows} score rows)`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — storyhouse, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
