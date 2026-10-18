// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics, starts
// a Journey story with the big Play button and keeps building it like a player — the Hint button picks a
// piece, a tap on one of the glowing legal slots in the 3D house places it (located through the stage's own
// camera), the "✦" context action records story moments and "Save scene ✦" finishes; the results screen's
// Next starts the following story. Pieces hop, sparks and rings fire and dust motes drift all the time.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const titleShown = (page) => page.waitForFunction(() => !!window.storyhouse && !document.getElementById('screen-title').hidden, null, { timeout: 30000 });

export async function setPreset(page, preset) {
  await titleShown(page);
  await page.click('#screen-title [data-goto="settings"]');
  await page.waitForFunction(() => !document.getElementById('screen-settings').hidden);
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.locator('#screen-settings [data-goto="title"]').last().click();
  await titleShown(page);
}

// Screen position of a free legal slot for the selected piece (the slot markers the player sees).
const legalSlot = (page) => page.evaluate(() => {
  const st = window.storyhouse.stage, legal = st?._legal || [];
  if (!window.storyhouse.selection || !legal.length) return null;
  const ls = legal[0], p = st._slotPos(ls.room, ls.slot);
  if (!p) return null;
  const v = p.clone().project(st.rig.camera), r = st.canvas.getBoundingClientRect();
  return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
});

async function step(page, press, tapAt) {
  const s = await page.evaluate(() => ({
    results: !document.getElementById('screen-results')?.hidden,
    active: window.storyhouse?.session?.state?.status === 'active' && !window.storyhouse._resolving,
    tray: window.storyhouse?.session?.state?.tray?.length ?? 0,
  }));
  if (s.results) {
    await press('#btn-results-next');
    return;
  }
  if (!s.active) return;
  if (await page.locator('#context-actions .menu-btn').count()) { await press('#context-actions .menu-btn >> nth=0'); return; }
  if (!(await page.locator('#btn-hint:not([disabled])').count())) return;
  await press('#btn-hint');
  await page.waitForTimeout(150);
  if (await page.locator('#context-actions .menu-btn').count()) { await press('#context-actions .menu-btn >> nth=0'); return; }
  const at = await legalSlot(page);
  if (at) await tapAt(at.x, at.y);
  else if (!s.tray && await page.locator('#btn-finish:not([disabled])').count()) await press('#btn-finish');
}

export async function start(page, { mobile } = {}) {
  const press = (sel) => (mobile ? page.tap(sel, { timeout: 3000 }) : page.click(sel, { timeout: 3000 }));
  const tapAt = (x, y) => (mobile ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  await press('#btn-play');
  await page.waitForFunction(() => window.storyhouse?.session?.state?.status === 'active', null, { timeout: 15000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page, press, tapAt); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(500).catch(() => {});
    }
  })();
  await page.waitForTimeout(2000);
}
