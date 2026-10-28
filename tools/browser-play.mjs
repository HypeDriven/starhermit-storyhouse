// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): on the desktop Journey 1 by
// mouse (tray buttons and the named spots and pieces over the house, one
// piece dragged from the tray onto its spot), a pause by Escape, the results
// and the scrapbook with the scene's picture; on the phone Learn 1-2 by
// finger (one piece dragged from the tray, Save scene from the Actions
// drawer); sideways a swipe across the sky to look around and today's Daily
// by finger. Widgets and targets are found through the page's accessibility
// mirror of the engine's UI. Screenshots of each step go to --shots. Fails on
// console errors or warnings, the runtime's error screen, or a view that does
// not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import * as C from '../src/content.js';
import * as R from '../src/rules.js';
import { itemName, roomName } from '../src/loc.js';
import { planFor } from './gen-plays.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const only = process.env.VIEW;
const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];
const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views.filter((x) => !only || x.name === only)) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true }))
    .or(page.getByRole('switch', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const tapAt = async (x, y) => {
    if (cdp) { await touch('touchStart', x, y); await page.waitForTimeout(80); await touch('touchEnd'); }
    else await page.mouse.click(x, y);
    await page.waitForTimeout(300);
  };
  const centre = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 20000 });
    const b = await el.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const press = async (name) => { const p = await centre(name); await tapAt(p.x, p.y); };
  /** A drag from one widget / target to another (the mouse, or a finger). */
  const dragFromTo = async (from, to) => {
    const a = await centre(from), b = await centre(to);
    const steps = 12;
    if (cdp) {
      await touch('touchStart', a.x, a.y);
      for (let i = 1; i <= steps; i++) { await page.waitForTimeout(30); await touch('touchMove', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps); }
      await page.waitForTimeout(80);
      await touch('touchEnd');
    } else {
      await page.mouse.move(a.x, a.y); await page.mouse.down();
      for (let i = 1; i <= steps; i++) { await page.waitForTimeout(30); await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps); }
      await page.waitForTimeout(80); await page.mouse.up();
    }
    await page.waitForTimeout(1800); // a finger tap right after a drag can be missed (spiral-drop lesson)
  };
  const active = async () => { await find('Moves 0').waitFor({ timeout: 60000 }); await page.waitForTimeout(3600); };
  const compact = v.name !== 'desktop';
  const actions = async (fn) => { if (compact) await press('Actions'); await fn(); if (compact) await press('Actions'); };
  /** One story through the UI: tray buttons and the house's named targets; the first placement dragged when asked. */
  const playStory = async (content, dragFirst) => {
    const st = R.createGame(content);
    const piece = (k) => { const p = R.itemSlot(st, k); return `${itemName(k)} in the ${roomName(p.room)}, spot ${p.slot + 1}`; };
    const spot = (room, slot) => `${roomName(R.roomById(st, room))}, empty spot ${slot + 1}`;
    let dragged = !dragFirst;
    for (const cmd of planFor(content)) {
      if (cmd.type === 'place' && !dragged) { await dragFromTo(itemName(cmd.item), spot(cmd.room, cmd.slot)); dragged = true; }
      else if (cmd.type === 'place') { await press(itemName(cmd.item)); await press(spot(cmd.room, cmd.slot)); }
      else if (cmd.type === 'move') { await press(piece(cmd.item)); await press(spot(cmd.room, cmd.slot)); }
      else if (cmd.type === 'interact') { await press(piece(cmd.a)); await press(piece(cmd.b)); }
      else if (cmd.type === 'remove') { await press(piece(cmd.item)); await actions(() => press(`↩ Return ${itemName(cmd.item)} to the tray`)); }
      R.applyCommand(st, cmd);
      await page.waitForTimeout(500);
    }
    const pending = st.cardDefs.some((c) => st.cards[c.id] === 0) && st.beats.length === 0;
    await actions(() => press('Save scene ✦'));
    if (pending) await press('Save scene');
    R.applyCommand(st, { type: 'finish', elapsedMs: 0 });
    const s = R.scoreState(st);
    await page.getByText('Invalid actions', { exact: true }).first().waitFor({ timeout: 30000 });
    await page.getByText(`${s.moments} (${s.beats} beats)`, { exact: true }).first().waitFor({ timeout: 5000 });
    await page.waitForTimeout(1200);
  };
  let reached = false;
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await press('Play');
      await active();
      await shot('journey-1');
      const content = C.journeyStage(0);
      // half way: a pause by Escape
      await playStory(content, true).then(() => undefined);
      await shot('journey-1-results');
      await press('Next stage →');
      await active();
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await shot('pause');
      await press('Save & leave');
      await press('Scrapbook');
      await find('Mastery track').waitFor({ timeout: 15000 });
      await page.waitForTimeout(1500);
      await shot('scrapbook');
    } else if (v.name === 'phone') {
      await press('Learn');
      await press('Start lesson');
      for (let i = 0; i < 2; i++) {
        await active();
        await shot(`lesson-${i + 1}`);
        await playStory(C.lessonContent(C.LESSONS[i].id), i === 1);
        await shot(`lesson-${i + 1}-results`);
        if (i === 0) await press('Next lesson →');
      }
    } else {
      await press('Daily Story');
      await press('Start today’s story');
      await active();
      // a swipe across the sky looks around (orbit), then View resets the camera
      const w = v.viewport.width;
      if (cdp) {
        await touch('touchStart', w * 0.08, 130);
        for (let i = 1; i <= 10; i++) { await page.waitForTimeout(30); await touch('touchMove', w * 0.08 + i * 18, 130 + i * 4); }
        await touch('touchEnd');
      }
      await page.waitForTimeout(800);
      await shot('orbit');
      await press('View');
      await page.waitForTimeout(1500);
      await shot('daily');
      await playStory(C.dailyContent(new Date().toISOString().slice(0, 10)), false);
      await shot('daily-results');
    }
    reached = true;
  } catch (e) {
    problems.push(`play: ${String(e.message || e).split('\n')[0]}`);
    await shot('failed');
    if (process.env.DEBUG) console.log(await page.locator('body').ariaSnapshot().catch(() => ''));
  }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
