// The browser build's DOM shell (src/ui.js + index.html + styles.css) as
// starhermit:ui, built every frame over the house: the play HUD (the top bar
// with the story's name and objective, the moves / clock / score chips and
// the Text, Hint, Undo, View and Pause buttons; the Discovery cards + Story
// so far rail and the Selection rail with its context actions, the lesson box
// and Save scene ✦; the piece tray; the key hint line), the toasts, the
// captions line, the text mirror (the house as text, playable), named
// targets over every slot and piece (the canvas picking's DOM equivalent:
// screen readers and play scripts find them), the countdown, the pause card
// and the confirm dialog, and the screens (title, mode setup, results,
// journey map, scrapbook, how to play, settings). The old media queries are
// layouts picked by the window's logical size: wide (≥ 1024 px: rails flank
// the house), compact (rails become drawers behind Goals / Actions toggles),
// portrait phones (≤ 700 px: the top bar wraps, icon-only buttons) and short
// landscape (≤ 500 px tall). Left-handed controls mirror the layout, as the
// old dir="rtl" did.
import { frame, openMenu } from "starhermit:engine";
import { bindings, pointer as inputPointer, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { createImageBitmap, type ImageBitmap } from "starhermit:canvas";
import { C, Loc, R, type Scene } from "./game.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { PIECE_ICONS } from "./pieces.ts";
import * as render from "./render.ts";
import { token } from "./style.ts";
import {
  app, cameraReset, canAct, clockText, closeDialog, confirmRestart, confirmWipe, contextAction, copyInvite, deleteScene, finish, finishNote,
  fresh, goto, hasSnapshot, hint, later, leaveToTitle, movesText, nextJourneyIndex, objectiveText, openFromPause, quickPlay,
  refreshSetupView, replayTutorials, restartSession, resultsNext, resumeGame, resumeSnapshot, selectionInfo, setSetup, signIn, sound,
  startFromSetup, startSession, syncLabel, tapPiece, tapSlot, toggleDrawer, toggleMirror, togglePause, trayDragJustEnded, trayDragStart,
  undo,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; land: boolean; portrait: boolean; narrow: boolean; lefty: boolean; sa: { left: number; top: number; right: number; bottom: number } }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const s = f.safeArea;
  const sa = { left: s.left / sc, top: s.top / sc, right: s.right / sc, bottom: s.bottom / sc };
  const lw = Math.max(1, f.width / sc), lh = Math.max(1, f.height / sc);
  const land = lw > lh && lh <= 500;
  const portrait = lw <= 700 && lh >= lw;
  return { lw, lh, sc, wide: lw >= 1024 && !land, land, portrait, narrow: portrait || land, lefty: platform.options.lefty, sa };
}
const lastSize = new Map<string, ui.Rect>();
const sizeOf = (k: string): ui.Rect | undefined => lastSize.get(k);
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean;
  content?: () => void; width?: number; height?: number; quiet?: boolean;
}
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn-menu";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (b.width != null && buttonWidth(b.text, style) > b.width) {
    const ink = style === "btn-primary" || style === "btn-big";
    const inner = b.width - 34;
    opts.content = () => { ui.style(ink ? "wrap-ink" : "wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.style(style === "btn-primary" || style === "btn-big" ? "btn-label-ink" : "btn-label").label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) {
    later(() => { if (!b.quiet) sound("click"); b.act(); });
  }
}
/** Buttons at their own widths in rows that wrap at `width` (flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 8, justify: "start" | "center" | "end" = "start"): ui.Rect {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn-menu"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  return ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button({ ...b, width: bw(b) });
    }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
/** A box over a logical rectangle drawn by a placed role-none widget. */
function paint(id: string, x: number, y: number, w: number, h: number, cls: string): void {
  if (w <= 0 || h <= 0) return;
  ui.place(id, { anchor: "top-start", x, y }, () => { ui.style(cls).widget("", { role: "none", size: { width: w, height: h } }); });
}
/** A wrapping check box row (built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    const res = ui.id(id).widget(label, {
      role: "checkbox", checked: on, size: { width: 36, height: 36 },
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("brand") : token("paper-3"));
        draw.strokeRoundRect(bx, by, box, box, 4, token("line"), 2);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: token("brand-ink"), align: "center", weight: "bold" });
      },
    });
    para(label, w - 48, "text", `${id}-label`);
    if (res.activated && fresh()) later(() => { sound("toggle"); set(!on); });
  }, { width: w, align: "center", spacing: 10 });
}
/** A label and a select on one row (or stacked when narrow). */
function selectRow(id: string, label: string, index: number, options: string[], w: number, set: (i: number) => void): void {
  const selW = Math.min(260, Math.max(140, w * 0.55));
  const stacked = textWidth(label, "text") + selW + 16 > w;
  const body = (): void => {
    para(label, stacked ? w : w - selW - 12, "text", `${id}-label`);
    if (!stacked) ui.spacer();
    const pick = ui.id(id).select(label, index, options, { width: stacked ? w : selW } as ui.WidgetOptions);
    if (pick !== index && fresh()) later(() => set(pick));
  };
  if (stacked) ui.column(`${id}-row`, body, { width: w, spacing: 4 });
  else ui.row(`${id}-row`, body, { width: w, align: "center", spacing: 8 });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (!render.isActive()) paint("page", 0, 0, L.lw, L.lh, "page");
  const hud = !!app.session && !app.screen && app.phase !== "title" && app.phase !== "mode-select";
  if (hud) {
    hudTargets(L);
    playHud(L);
  }
  if (app.screen) screenPanel(L);
  if (app.countdown && !app.screen) countdown(L);
  if (app.pauseOpen && !app.screen) pauseCard(L);
  if (app.dialog) dialogCard(L);
  toasts(L, hud);
  captions(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ the play HUD
const TOP_M = 8;
function playHud(L: Layout): void {
  const top = topBar(L);
  const trayH = tray(L);
  const railTop = top + 8;
  const railBottom = L.lh - L.sa.bottom - trayH - 16;
  if (L.wide) {
    const rw = Math.max(240, Math.min(300, L.lw * 0.2));
    const leftX = L.sa.left + 10, rightX = L.lw - L.sa.right - 10 - rw;
    railBox("rail-left", L.lefty ? rightX : leftX, railTop, rw, railBottom - railTop, (iw) => goalsRail(iw, L));
    railBox("rail-right", L.lefty ? leftX : rightX, railTop, rw, railBottom - railTop, (iw) => actionsRail(iw));
  } else {
    const toggleY = L.land ? railTop : Math.max(railTop, L.lh * 0.42);
    const dw = Math.min(320, L.lw * 0.86);
    const leftSide = (which: "left" | "right"): boolean => (which === "left") !== L.lefty;
    for (const which of ["left", "right"] as const) {
      const open = app.drawer === which;
      const label = which === "left" ? T("Goals") : T("Actions");
      const bw = buttonWidth(label, "btn-drawer");
      const x = leftSide(which) ? L.sa.left + 8 : L.lw - L.sa.right - 8 - (open ? dw : bw);
      if (open) {
        const y = toggleY + 52;
        const maxH = Math.max(120, Math.min(L.land ? railBottom - y : L.lh * 0.48, railBottom - y));
        railBox(`rail-${which}`, x, y, dw, maxH, (iw) => (which === "left" ? goalsRail(iw, L) : actionsRail(iw)));
      }
      const tx = leftSide(which) ? L.sa.left + 8 : L.lw - L.sa.right - 8 - bw;
      ui.place(`drawer-${which}-toggle`, { anchor: "top-start", x: tx, y: toggleY }, () => {
        button({ id: `drawer-${which}`, text: label, style: "btn-drawer", selected: open, act: () => toggleDrawer(which), quiet: true });
      });
    }
  }
  if (app.mirror) mirror(L, trayH);
  if (L.wide && !app.mirror) keyHints(L, trayH);
}
/** The top bar (#hud-top); returns its bottom edge. */
function topBar(L: Layout): number {
  const s = app.session!;
  const x = L.sa.left + 10, y = L.sa.top + TOP_M, w = L.lw - L.sa.left - L.sa.right - 20;
  const iw = w - 24 - 2;
  const ck = clockText();
  const score = R.scoreState(s.state);
  const chips: { id: string; text: string; warn?: boolean }[] = [
    { id: "hud-moves", text: movesText() }, { id: "hud-clock", text: ck.text, warn: ck.warn }, { id: "hud-score", text: `★ ${score.total}` },
  ];
  const chipW = (t: string): number => textWidth(t, "chip-text") + 26;
  const icons = L.narrow;
  const paused = app.phase === "paused";
  const btn = (id: string, glyph: string, label: string, act: () => void, extra: Partial<Btn> = {}): Btn => ({
    id, text: icons ? glyph : `${glyph} ${label}`, name: label, style: "btn-chip", act, ...extra,
    content: () => { ui.style("btn-label").label(icons ? glyph : `${glyph} ${label}`); },
  });
  const btns: Btn[] = [
    btn("btn-mirror", "☰", T("Text"), toggleMirror, { selected: app.mirror }),
    btn("btn-hint", "💡", T("Hint"), hint, { disabled: app.phase !== "active" }),
    btn("btn-undo", "↩", T("Undo"), undo, { disabled: !(s.canUndo() && canAct()) }),
    btn("btn-camera", "⌖", T("View"), cameraReset),
    btn("btn-pause", paused ? "▶" : "⏸", paused ? T("Resume") : T("Pause"), () => togglePause("button")),
  ];
  if (L.lefty) btns.reverse();
  const bw = (b: Btn): number => buttonWidth(b.text, "btn-chip") + 4;
  const chipsW = chips.reduce((a, c) => a + chipW(c.text) + 8, 0);
  const btnsW = btns.reduce((a, b) => a + bw(b) + 6, 0);
  const oneRow = iw - chipsW - btnsW - 24 >= 160;
  const headW = oneRow ? iw - chipsW - btnsW - 24 : iw;
  const chipsRow = (): void => {
    ui.row("hud-status", () => {
      for (const c of chips) ui.row(c.id, () => ui.style(c.warn ? "chip-warn-text" : "chip-text").id(`${c.id}-v`).label(c.text), { style: c.warn ? "chip-warn" : "chip", align: "center" });
    }, { spacing: 8, align: "center" });
  };
  const btnRow = (): void => {
    ui.row("hud-top-buttons", () => { for (const b of btns) button({ ...b, width: bw(b) }); }, { spacing: 6, align: "center" });
  };
  const heading = (): void => {
    ui.column("hud-heading", () => {
      para(Loc.contentLabel(s.content), headW, "stage-title", "hud-stage-title");
      para(objectiveText(), headW, "objective", "hud-objective-text");
    }, { spacing: 0, width: headW });
  };
  ui.place("hud-top", { anchor: "top-start", x, y }, () => {
    const r = ui.column("hud-top-box", () => {
      if (oneRow) {
        ui.row("hud-top-row", () => {
          if (L.lefty) { btnRow(); chipsRow(); heading(); } else { heading(); chipsRow(); btnRow(); }
        }, { spacing: 12, align: "center", width: iw });
      } else {
        heading();
        const fitsBoth = chipsW + btnsW + 12 <= iw;
        if (fitsBoth) ui.row("hud-top-row2", () => { chipsRow(); ui.spacer(); btnRow(); }, { spacing: 12, align: "center", width: iw });
        else { chipsRow(); btnRow(); }
      }
    }, { style: "topbar", width: w, spacing: 6 });
    lastSize.set("hud-top", r);
  });
  const h = (sizeOf("hud-top")?.height ?? 56 * L.sc) / L.sc;
  return y + h;
}
/** A rail panel; its content scrolls when taller than the room it has. */
function railBox(id: string, x: number, y: number, w: number, maxH: number, build: (inner: number) => void): void {
  ui.place(id, { anchor: "top-start", x, y }, () => {
    const prev = sizeOf(`${id}-in`);
    const padX = 14, padY = 10;
    const contentH = prev ? prev.height / ui.preferences().scale : 0;
    const scroll = contentH > maxH - 2 * padY - 2;
    ui.column(id, () => {
      const iw = w - 2 * padX - 2 - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(`${id}-in`, ui.column(`${id}-in`, () => build(iw), { spacing: 6, width: iw })); };
      if (scroll) ui.scrollArea(`${id}-scroll`, { width: w - padX - 2, height: maxH - 2 * padY - 2 }, body);
      else body();
    }, { style: "rail", width: w, spacing: 0, padding: { top: padY, bottom: padY, start: padX, end: padX } });
  });
}
/** #rail-left: discovery cards and the story so far. */
function goalsRail(w: number, L: Layout): void {
  const st = app.session!.state;
  para(T("Discovery cards"), w, "h3", "goals-h");
  ui.column("card-list", () => {
    if (!st.cardDefs.length) para(T("No discovery cards here — play freely."), w, "card-text", "cards-none");
    st.cardDefs.forEach((c, i) => {
      const done = st.cards[c.id] === 1;
      const inner = w - 22;
      ui.row(`card-${i}`, () => {
        ui.style(done ? "card-mark-done" : "card-mark").label(done ? "✓" : "◆");
        ui.column(`card-${i}-body`, () => {
          const pts = `+${c.points}`;
          const tw = inner - 22 - textWidth(pts, "card-pts") - 8;
          ui.row(`card-${i}-top`, () => {
            para(Loc.cardTitle(c), tw, "card-title", `card-${i}-title`);
            ui.spacer();
            ui.style("card-pts").label(pts);
          }, { width: inner - 22, align: "start" });
          para(Loc.cardText(c), inner - 22, "card-text", `card-${i}-text`);
        }, { spacing: 0, width: inner - 22 });
      }, { style: done ? "card-done" : "card-item", width: w, spacing: 8, align: "start" });
    });
  }, { spacing: 6, width: w });
  if (L.land) return; // the beat log hides on short landscape (old .beat-log display:none)
  para(T("Story so far"), w, "h3", "beats-h");
  const beats = st.beats.slice(-12).reverse();
  ui.column("beat-log", () => {
    beats.forEach((b, i) => {
      const who = `${Loc.itemName(b.a)} + ${Loc.itemName(b.b)}`;
      const room = Loc.roomName(R.roomById(st, b.room)) || b.room;
      let text = `${beats.length - i}. ${Loc.beatLabel(b.t)} — ${T("{who} in the {room}", { who, room })}`;
      if (b.sig === 1) text += ` ✦ ${T("signature")}`;
      if (b.hab === 1) text += ` ⌂ ${T("at home")}`;
      para(text, w, b.sig === 1 ? "beat-sig" : b.hab === 1 ? "beat-hab" : "beat", `beat-${i}`);
    });
  }, { spacing: 2, width: w });
}
/** #rail-right: the selection, its context actions, the lesson box, Save scene ✦. */
function actionsRail(w: number): void {
  const info = selectionInfo();
  para(T("Selection"), w, "h3", "selection-heading");
  para(info.desc, w, "sel-desc", "selection-desc");
  if (info.actions.length) {
    ui.column("context-actions", () => {
      info.actions.forEach((a, i) => button({ id: `ctx-${i}`, text: a.label, style: "btn-small", width: w, act: () => contextAction(a) }));
    }, { spacing: 6, width: w });
  }
  const l = app.lesson;
  if (l) {
    ui.column("lesson-box", () => {
      const iw = w - 26;
      para(T(l.def.title), iw, "lesson-h", "lesson-title");
      para(l.stepIndex < l.def.steps.length ? T(l.def.steps[l.stepIndex]!.text) : T("Lesson complete — saving…"), iw, "text", "lesson-step-text");
      para(T("Step {n} of {total}", { n: Math.min(l.stepIndex + 1, l.def.steps.length), total: l.def.steps.length }), iw, "small", "lesson-progress");
    }, { style: "lesson", width: w, spacing: 4 });
  }
  button({ id: "btn-finish", text: T("Save scene ✦"), style: "btn-primary", act: finish, disabled: !canAct() });
  para(finishNote(), w, "fine", "finish-note");
}
/** #tray: the pieces waiting on the tray; returns the tray's height. */
function tray(L: Layout): number {
  const st = app.session!.state;
  const items = L.lefty ? st.tray.slice().reverse() : st.tray;
  const maxW = L.lw - L.sa.left - L.sa.right - 40;
  const gap = L.narrow ? 6 : 8;
  const itemW = (k: string): number => Math.max(52, textWidth(Loc.itemName(k), "tray-name") + 20);
  const rows: string[][] = [[]];
  let used = 0;
  for (const k of items) {
    const w = itemW(k);
    if (rows[rows.length - 1]!.length && used + gap + w > maxW) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(k);
  }
  const prev = sizeOf("tray");
  const h = prev ? prev.height / L.sc : 66;
  const w = prev ? prev.width / L.sc : 200;
  ui.place("tray", { anchor: "top-start", x: (L.lw - w) / 2, y: L.lh - L.sa.bottom - 8 - h }, () => {
    const r = ui.column("tray-box", () => {
      if (!items.length) { para(T("Tray is empty — everything is in the house."), maxW, "fine", "tray-empty"); return; }
      rows.forEach((row, ri) => ui.row(`tray-r${ri}`, () => {
        for (const k of row) trayItem(k, itemW(k), L);
      }, { spacing: gap, align: "center", justify: "center" }));
    }, { style: rows.length > 1 ? "tray-tall" : "tray", spacing: gap, align: "center" });
    lastSize.set("tray", r);
  });
  return h + 8;
}
function trayItem(key: string, w: number, L: Layout): void {
  const name = Loc.itemName(key);
  const st = app.session!.state;
  const on = app.selection === key;
  const res = ui.id(`tray-${key}`).widget(name, {
    role: "toggle", checked: on, style: on ? ["btn-tray", "btn-tray-on"] : "btn-tray", size: { width: w, height: 52 },
    description: Loc.itemKind(st.items[key]?.kind ?? "prop"),
    draw: (r, s) => {
      const k = s.scale;
      draw.text(PIECE_ICONS[key] || "◼", r.x + r.width / 2, r.y + 4 * k, { size: 21 * k, align: "center", color: token("ink") });
      draw.text(name, r.x + r.width / 2, r.y + 31 * k, { size: 12.5 * k, align: "center", color: token("ink") });
      if (on) draw.strokeRoundRect(r.x + 1 * k, r.y + 1 * k, r.width - 2 * k, r.height - 2 * k, 12, token("brand"), 2 * k);
    },
  });
  if (res.pressed && res.hovered) {
    const p = pointerNow();
    if (p && !app.drag) trayDragStart(key, p.x, p.y);
  }
  void L;
  if (res.activated && fresh() && frame().frame - trayDragJustEnded > 1) later(() => tapPiece(key));
}
function pointerNow(): { x: number; y: number } | null { return inputPointer(); }
/** The canvas key hint line (wide layouts). */
const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc", "Numpad Enter": "Num Enter" };
export function keysFor(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join("/") || "—";
}
function keyHints(L: Layout, trayH: number): void {
  const text = T("Arrows move the cursor · {confirm} select/place · {cancel} cancel · {hint} hint · {undo} undo · {camera} camera", {
    confirm: keysFor("confirm"), cancel: keysFor("cancel"), hint: keysFor("hint"), undo: keysFor("undo"), camera: keysFor("camera"),
  });
  const w = Math.min(560, L.lw * 0.34);
  ui.place("canvas-keys", { anchor: "top-start", x: L.lw - L.sa.right - 16 - w, y: L.lh - L.sa.bottom - trayH - 40 }, () => {
    ui.column("canvas-keys-col", () => para(text, w, "fine", "canvas-keys-text"), { width: w, align: "end" });
  });
}
/** #a11y-mirror: the house as text, every slot and tray piece a button. */
function mirror(L: Layout, trayH: number): void {
  const st = app.session!.state;
  const w = Math.min(340, L.lw * 0.92);
  const bottom = L.portrait ? trayH + 16 : 8;
  const maxH = L.portrait ? Math.max(160, L.lh * 0.58 - 60 - trayH) : L.lh * 0.46;
  const prev = sizeOf("mirror-in");
  const contentH = prev ? prev.height / L.sc : maxH;
  const h = Math.min(maxH, contentH + 22);
  const x = L.lefty ? L.sa.left + 8 : L.lw - L.sa.right - 8 - w;
  ui.place("a11y-mirror", { anchor: "top-start", x, y: L.lh - L.sa.bottom - bottom - h }, () => {
    ui.column("mirror-box", () => {
      const iw = w - 28 - 14;
      ui.scrollArea("mirror-scroll", { width: w - 16, height: h - 22 }, () => {
        lastSize.set("mirror-in", ui.column("mirror-in", () => {
          para(T("The house, as text"), iw, "h3", "mirror-h");
          for (const room of st.rooms) {
            para(`${Loc.roomName(room)} (${Loc.roomTypeName(room.type)})`, iw, "h3", `mirror-${room.id}`);
            room.slots.forEach((itemKey, i) => {
              const name = itemKey ? Loc.itemName(itemKey) : T("empty spot");
              const text = app.selection && !itemKey ? T("Place {name} here (spot {n})", { name: Loc.itemName(app.selection), n: i + 1 })
                : T("{name} — spot {n}", { name, n: i + 1 });
              button({ id: `mirror-${room.id}-${i}`, text, style: "btn-mirror", width: iw, selected: !!itemKey && itemKey === app.selection,
                act: () => { if (itemKey) tapPiece(itemKey); else tapSlot({ room: room.id, slot: i }); } });
            });
          }
          para(T("Tray"), iw, "h3", "mirror-tray-h");
          for (const key of st.tray) {
            button({ id: `mirror-tray-${key}`, text: T("Select {name}", { name: Loc.itemName(key) }), style: "btn-mirror", width: iw,
              selected: key === app.selection, act: () => tapPiece(key) });
          }
        }, { spacing: 4, width: iw }));
      });
    }, { style: "mirror", width: w, height: h, padding: { top: 10, bottom: 10, start: 14, end: 4 } });
  });
}
/** Named targets over every slot and piece (and the selection's state). */
function hudTargets(L: Layout): void {
  if (app.pauseOpen || app.dialog || app.countdown || app.phase !== "active") return;
  const st = app.session!.state;
  const f = frame();
  const onScreen = (r: render.Rect | null): r is render.Rect => !!r && r.width > 0 && r.x + r.width > 0 && r.y + r.height > 0 && r.x < f.width && r.y < f.height;
  for (const room of st.rooms) {
    room.slots.forEach((item, i) => {
      if (item) {
        const r = render.pieceRect(item);
        if (onScreen(r)) ui.target(T("{name} in the {room}, spot {n}", { name: Loc.itemName(item), room: Loc.roomName(room), n: i + 1 }) + (app.selection === item ? T(", selected") : ""), r, { role: "button" });
      } else {
        const r = render.slotRect(room.id, i);
        if (onScreen(r)) ui.target(T("{room}, empty spot {n}", { room: Loc.roomName(room), n: i + 1 }), r, { role: "button" });
      }
    });
  }
  void L;
}

// ------------------------------------------------------------------ toasts, captions, countdown
function toasts(L: Layout, hud: boolean): void {
  if (!app.toasts.length) return;
  const w = Math.min(L.lw * 0.9, 520);
  const trayH = hud ? (sizeOf("tray")?.height ?? 60 * L.sc) / L.sc + 8 : 0;
  const y = Math.max(86, trayH + 22) + L.sa.bottom;
  ui.place("toast-region", { anchor: "bottom", y }, () => {
    ui.column("toast-col", () => {
      app.toasts.forEach((t, i) => ui.column(`toast-${i}`, () => para(t.text, w - 38, "toast-text", `toast-${i}-text`),
        { style: t.kind === "bad" ? "toast-bad" : t.kind === "good" ? "toast-good" : "toast", align: "center" }));
    }, { spacing: 6, align: "center" });
  });
}
function captions(L: Layout): void {
  if (!app.caption) return;
  const w = Math.min(L.lw * 0.6, 420);
  ui.place("captions", { anchor: "bottom-start", x: 8 + L.sa.left, y: 8 + L.sa.bottom }, () => {
    ui.column("captions-box", () => para(app.caption!.text, w, "caption-text", "captions-text"), { style: "captions" });
  });
}
function countdown(L: Layout): void {
  const size = Math.max(48, Math.min(112, L.lw * 0.14));
  ui.place("overlay-countdown", { anchor: "center" }, () => {
    ui.style("countdown", { text: { size } }).id("countdown-text").label(app.countdown!);
  });
}

// ------------------------------------------------------------------ the pause card and the dialog
function card(label: string, L: Layout, build: (w: number) => void, onClose: () => void): void {
  const w = Math.min(430, L.lw - 32);
  const pad = L.land ? 16 : 24;
  const open = ui.dialog(label, "", true, () => {
    ui.column(`${label}-card`, () => build(w - 2 * pad - 2), { style: "overlay-card", width: w, spacing: 10, padding: L.land ? { top: 12, bottom: 12, start: pad, end: pad } : { top: 22, bottom: 22, start: pad, end: pad } });
  });
  if (!open && fresh()) later(onClose);
}
function pauseCard(L: Layout): void {
  card(T("Paused"), L, (w) => {
    para(T("Paused"), w, "h1", "pause-heading");
    button({ id: "btn-resume", text: T("Resume"), style: "btn-big", width: w, act: () => resumeGame("button") });
    button({ id: "btn-pause-settings", text: T("Settings"), width: w, act: () => openFromPause("settings") });
    button({ id: "btn-pause-help", text: T("How to play"), width: w, act: () => openFromPause("help") });
    button({ id: "btn-pause-restart", text: T("Restart story"), width: w, act: confirmRestart });
    button({ id: "btn-pause-leave", text: T("Save & leave"), style: "btn-text", act: leaveToTitle });
  }, () => resumeGame("esc key"));
}
function dialogCard(L: Layout): void {
  const d = app.dialog!;
  card(T(d.title), L, (w) => {
    para(T(d.title), w, "h1", "dialog-heading");
    para(T(d.text), w, "text", "dialog-text");
    flow("dialog-buttons", d.buttons.map((b, i) => ({
      id: `dialog-${i}`, text: T(b.label), style: b.primary ? "btn-primary" : b.danger ? "btn-danger" : "btn-menu", quiet: true,
      act: () => { sound(b.primary || b.danger ? "confirm" : "back"); closeDialog(); b.action?.(); },
    })), w, 10);
  }, () => { sound("close"); closeDialog(); });
}

// ------------------------------------------------------------------ the screens
function screenPanel(L: Layout): void {
  const s = app.screen!;
  ui.place(`screen-${s}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.column(`screen-${s}-bg`, () => {
      const cw = Math.min(680, L.lw - L.sa.left - L.sa.right - 40);
      const viewH = L.lh;
      const prev = sizeOf(`screen-${s}-in`);
      const contentH = prev ? prev.height / L.sc : viewH;
      const padTop = 24 + L.sa.top;
      const centred = s === "title" && L.lh > 1000 && contentH + 48 < viewH;
      const opening = frame().frame - app.openedFrame <= 6;
      ui.scrollArea(`screen-${s}-scroll`, { width: L.lw, height: viewH }, () => {
        ui.column(`screen-${s}-wrap`, () => {
          if (centred) ui.spacer();
          lastSize.set(`screen-${s}-in`, ui.column(`screen-${s}-in`, () => buildScreen(s, cw, L), { spacing: 12, width: cw }));
          if (centred) ui.spacer();
        }, { width: L.lw, align: "center", height: centred ? viewH : undefined, padding: { top: centred ? 0 : padTop, bottom: 24 + L.sa.bottom, start: 0, end: 0 } });
      }, opening && !app.focusNext ? { scrollTo: { top: 0 } } : undefined);
    }, { style: "screen", width: L.lw, height: L.lh, spacing: 0 });
  });
}
function buildScreen(s: NonNullable<typeof app.screen>, w: number, L: Layout): void {
  switch (s) {
    case "title": titleScreen(w, L); break;
    case "setup": setupScreen(w, L); break;
    case "results": resultsScreen(w); break;
    case "journey": journeyScreen(w); break;
    case "scrapbook": scrapbookScreen(w); break;
    case "help": helpScreen(w); break;
    case "settings": settingsScreen(w); break;
  }
}
function back(id = "btn-back"): void { button({ id, text: T("Back"), style: "btn-text", act: () => goto("title"), quiet: true }); }

function titleScreen(w: number, L: Layout): void {
  const p = platform.progress();
  const size = Math.max(41.6, Math.min(70.4, L.lw * 0.08));
  ui.column("title-block", () => {
    ui.style("title-h", { text: { size } }).id("title-heading").label("Storyhouse");
    para(T("A little house full of almost-stories. Place the pieces, make the moments, keep the scenes."), w, "tagline", "tagline");
  }, { width: w, align: "center", spacing: 4, padding: { top: Math.min(40, L.lh * 0.04), bottom: 0, start: 0, end: 0 } });
  ui.row("play-row", () => button({ id: "btn-play", text: T("Play"), style: "btn-big", act: quickPlay }), { width: w, justify: "center" });
  const done = Object.keys(p.journey).length;
  const dailyDone = p.lastDaily?.date === platform.utcToday();
  const modes: [string, string, string][] = [
    ["daily", T("Daily Story"), dailyDone ? T("Done today — see the board") : T("One shared house, today only")],
    ["journey", T("Journey"), T("{done} of {total} stages", { done, total: C.journeyLength() })],
    ["learn", T("Learn"), T("Six little lessons")],
    ["practice", T("Practice"), T("Your house, your pace")],
    ["challenge", T("Challenge"), T("Limits and clocks")],
    ["score", T("Score Chase"), T("Seeded and ranked")],
  ];
  const gap = 8;
  let cols = Math.max(1, Math.min(4, Math.floor((w + gap) / (150 + gap))));
  if (L.portrait) cols = Math.min(cols, 2);
  if (L.lw <= 400) cols = 1;
  const cwid = (w - (cols - 1) * gap) / cols;
  ui.column("title-grid", () => {
    for (let r = 0; r * cols < modes.length; r++) {
      ui.row(`title-grid-r${r}`, () => {
        for (const [id, name, sub] of modes.slice(r * cols, (r + 1) * cols)) {
          const iw = cwid - 34;
          button({
            id: `mode-${id}`, text: name, name, width: cwid, act: () => goto(id),
            content: () => ui.column(`mode-${id}-face`, () => { para(name, iw, "menu-name"); para(sub, iw, "menu-sub"); }, { spacing: 2, width: iw }),
          });
        }
      }, { spacing: gap });
    }
  }, { spacing: gap, width: w });
  const foot: Btn[] = [
    { id: "btn-scrapbook", text: T("Scrapbook"), style: "btn-text", act: () => goto("scrapbook"), quiet: true },
    { id: "btn-help", text: T("How to play"), style: "btn-text", act: () => goto("help"), quiet: true },
    { id: "btn-settings", text: T("Settings"), style: "btn-text", act: () => goto("settings"), quiet: true },
  ];
  if (!platform.signedIn()) foot.push({ id: "btn-signin", text: S("signIn"), style: "btn-text", act: signIn });
  else if (platform.inviteLink()) foot.push({ id: "btn-invite", text: S("invite"), style: "btn-text", act: copyInvite });
  flow("title-footer", foot, w, 6, "center");
  const name = platform.signedIn() ? platform.displayName() || T("Player") : T("Local Guest");
  const sync = syncLabel();
  ui.row("profile-row", () => para(T("Playing as {name}", { name }) + (sync ? ` · ${sync}` : ""), w, "small", "profile-badge"), { width: w, justify: "center" });
  if (hasSnapshot()) ui.row("resume-line", () => button({ id: "btn-resume-session", text: T("Continue your paused story →"), style: "btn-text", act: resumeSnapshot }), { width: w, justify: "center" });
}

const fieldText = new Map<string, string>();
function setupScreen(w: number, L: Layout): void {
  const v = app.setupView, s = app.setup;
  if (!v || !s) return;
  para(T(v.mode), w, "h1", "setup-heading");
  ui.column("setup-facts", () => {
    v.facts.forEach(([k, val], i) => {
      const value = val();
      const kw = textWidth(T(k), "fact-k");
      ui.row(`fact-${i}`, () => {
        para(T(k), Math.min(kw, w * 0.5), "fact-k", `fact-${i}-k`);
        ui.spacer();
        para(value, w - Math.min(kw, w * 0.5) - 12, "fact-v", `fact-${i}-v`);
      }, { style: "fact", width: w, align: "start", spacing: 12 });
    });
  }, { spacing: 0, width: w });
  para(v.ranked ? `◆ ${T("Ranked")} — ${T(v.rankedNote)}` : `○ ${T("Casual")} — ${T(v.rankedNote)}`, w, v.ranked ? "ranked" : "casual", "setup-badge");
  for (const f of v.fields) {
    if (f === "lesson") {
      const p = platform.progress();
      const idx = Math.max(0, C.LESSONS.findIndex((l) => l.id === s.lessonId));
      selectRow("set-lesson", T("Lesson"), idx, C.LESSONS.map((l) => T(l.title) + (p.lessons[l.id] ? " ✓" : "")), w, (i) => setSetup({ lessonId: C.LESSONS[i]!.id }));
    } else if (f === "difficulty") {
      const keys = Object.keys(C.PRACTICE_DIFFICULTIES);
      selectRow("set-difficulty", T("Difficulty"), Math.max(0, keys.indexOf(s.difficulty ?? "cozy")), keys.map((k) => T(C.PRACTICE_DIFFICULTIES[k]!.label)), w, (i) => setSetup({ difficulty: keys[i]! }));
    } else if (f === "theme") {
      selectRow("set-theme", T("Theme"), Math.max(0, C.THEME_ORDER.indexOf(s.theme ?? "meadow")), C.THEME_ORDER.map((t) => Loc.themeLabel(t)), w, (i) => setSetup({ theme: C.THEME_ORDER[i]! }));
    } else if (f === "challenge") {
      selectRow("set-challenge", T("Challenge"), Math.max(0, C.CHALLENGES.findIndex((c) => c.id === s.challengeId)), C.CHALLENGES.map((c) => T(c.label)), w, (i) => setSetup({ challengeId: C.CHALLENGES[i]!.id }));
    } else if (f === "practiceSeed" || f === "scoreSeed") {
      const label = f === "practiceSeed" ? T("Seed (inspectable)") : T("Seed (share it, race it)");
      const id = `set-seed-${s.mode}`;
      const fw = Math.min(200, w * 0.45);
      const stacked = textWidth(label, "text") + fw + 16 > w;
      const body = (): void => {
        para(label, stacked ? w : w - fw - 12, "text", `${id}-label`);
        if (!stacked) ui.spacer();
        const cur = fieldText.get(id) ?? s.seed ?? "";
        const next = ui.style("field").textField(id, cur, { maxChars: 9, width: stacked ? w : fw, placeholder: T("Seed") });
        const digits = next.replace(/\D/g, "");
        if (digits !== cur) {
          fieldText.set(id, digits);
          if (app.setup) app.setup.seed = digits || "1";
        } else fieldText.set(id, cur);
      };
      if (stacked) ui.column(`${id}-row`, body, { width: w, spacing: 4 });
      else ui.row(`${id}-row`, body, { width: w, align: "center", spacing: 8 });
    }
  }
  flow("setup-buttons", [
    { id: "btn-setup-start", text: T(v.startLabel), style: "btn-big", act: () => { fieldText.clear(); startFromSetup(); } },
    { id: "btn-setup-back", text: T("Back"), style: "btn-text", act: () => { fieldText.clear(); goto("title"); }, quiet: true },
  ], w, 10);
  void L; void refreshSetupView;
}

function resultsScreen(w: number): void {
  const r = app.results;
  if (!r) return;
  para(T(r.headline), w, "h1", "results-heading");
  ui.row("results-stars", () => {
    for (let i = 0; i < 3; i++) ui.style(i < r.stars ? "star-on" : "star-off").label("★");
  }, { width: w, justify: "center", spacing: 6 });
  ui.target(T("{n} of 3 stars", { n: r.stars }), { x: 0, y: 0, width: 1, height: 1 }, { role: "label" });
  ui.column("results-table", () => {
    r.rows.forEach(([k, val], i) => ui.row(`score-${i}`, () => {
      ui.style("fact-k").label(T(k));
      ui.spacer();
      ui.style("fact-v").id(`score-${i}-v`).label(val());
    }, { style: "score-row", width: w, align: "center" }));
    ui.row("score-total", () => {
      ui.style("total-k").label(T("Total"));
      ui.spacer();
      ui.style("total-v").id("score-total-v").label(String(r.total));
    }, { style: "score-total", width: w, align: "center" });
  }, { spacing: 0, width: w });
  if (r.cards.length) {
    const chips = r.cards.map((c) => (c.done ? "✓ " : "◇ ") + c.title());
    const rows: string[][] = [[]];
    let used = 0;
    chips.forEach((t) => {
      const cw = textWidth(t, "mini-text") + 24;
      if (rows[rows.length - 1]!.length && used + 6 + cw > w) { rows.push([]); used = 0; }
      used += (rows[rows.length - 1]!.length ? 6 : 0) + cw;
      rows[rows.length - 1]!.push(t);
    });
    let n = 0;
    ui.column("results-cards", () => rows.forEach((row, ri) => ui.row(`rc-${ri}`, () => {
      for (const t of row) { const done = r.cards[n++]!.done; ui.row(`rc-${n}`, () => para(t, w - 24, "mini-text"), { style: done ? "mini-done" : "mini-card" }); }
    }, { spacing: 6 })), { spacing: 6, width: w });
  }
  r.achievements.forEach((a, i) => para("🏅 " + T("Achievement unlocked: {name} — {desc}", { name: T(a.name), desc: T(a.desc) }), w, "ach-pop", `results-ach-${i}`));
  const cmp = r.compare();
  if (cmp) para(cmp, w, "small", "results-compare");
  flow("results-buttons", [
    { id: "btn-results-next", text: T(r.nextLabel), style: "btn-primary", act: resultsNext },
    { id: "btn-results-replay", text: T("Replay"), style: "btn-small", act: restartSession },
    { id: "btn-results-home", text: T("Home"), style: "btn-text", act: () => goto("title"), quiet: true },
  ], w, 10);
}

function journeyScreen(w: number): void {
  const p = platform.progress();
  para(T("Journey"), w, "h1", "journey-heading");
  const gap = 6;
  const cols = Math.max(1, Math.floor((w + gap) / (64 + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  const current = nextJourneyIndex();
  C.CHAPTERS_PUB.forEach((ch, ci) => {
    para(`${ci + 1}. ${T(ch.title)}`, w, "h2", `chapter-${ci}`);
    const stages = ch.names.map((label, si) => {
      const index = ci * 9 + si;
      const id = C.journeyStage(index).contentId;
      const rec = p.journey[id];
      const locked = index > 0 && !p.journey[C.journeyStage(index - 1).contentId];
      return { index, label, mastery: si === 8, stars: rec?.stars || 0, locked };
    });
    ui.column(`chapter-${ci}-grid`, () => {
      for (let r = 0; r * cols < stages.length; r++) {
        ui.row(`chapter-${ci}-r${r}`, () => {
          for (const st of stages.slice(r * cols, (r + 1) * cols)) {
            const name = T("Stage {n}: {name}", { n: st.index + 1, name: T(st.label) }) + (st.stars ? T(", {n} stars", { n: st.stars }) : "") + (st.locked ? T(", locked") : "");
            const starText = st.stars > 0 ? "★".repeat(st.stars) : (st.mastery ? "M" : "·");
            button({
              id: `stage-${st.index + 1}`, text: String(st.index + 1), name, width: cw, height: cw, disabled: st.locked,
              style: st.index === current ? "btn-stage-cur" : st.mastery ? "btn-stage-m" : "btn-stage",
              act: () => startSession({ mode: "journey", index: st.index }),
              content: () => ui.column(`stage-${st.index + 1}-face`, () => {
                ui.style("stage-num").label(String(st.index + 1));
                ui.style("stage-stars").label(starText);
              }, { spacing: 2, align: "center", width: cw - 12 }),
            });
          }
        }, { spacing: gap });
      }
    }, { spacing: gap, width: w });
  });
  back();
}

// Thumbnails: the scenes' PNG data URLs decoded once (ImageBitmaps drawn into their boxes).
const thumbs = new Map<string, ImageBitmap | null>();
function thumbFor(s: Scene): ImageBitmap | null {
  if (!s.thumbnail) return null;
  if (!thumbs.has(s.id)) {
    thumbs.set(s.id, null);
    try {
      const b64 = s.thumbnail.slice(s.thumbnail.indexOf(",") + 1);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      void createImageBitmap(bytes).then((bmp) => { thumbs.set(s.id, bmp); }, () => undefined);
    } catch { /* keep none */ }
  }
  return thumbs.get(s.id) ?? null;
}
function scrapbookScreen(w: number): void {
  const p = platform.progress();
  para(T("Scrapbook"), w, "h1", "scrapbook-heading");
  para(T("Your saved scenes live here — persistent, replayable, yours."), w, "fine", "scrapbook-note");
  const scenes = platform.scenes();
  if (!scenes.length) para(T("No saved scenes yet — your finished stories will appear here."), w, "fine", "scenes-none");
  ui.column("scene-list", () => {
    scenes.forEach((s, i) => {
      const delW = buttonWidth(T("Delete"), "btn-text") + 4;
      const mid = w - 24 - 84 - delW - 24 - 2;
      ui.row(`scene-${i}`, () => {
        const bmp = thumbFor(s);
        ui.style("thumb").widget("", {
          role: "none", size: { width: 84, height: 56 },
          draw: bmp ? (r) => { draw.image(bmp, r.x, r.y, r.width, r.height); } : undefined,
        });
        ui.column(`scene-${i}-mid`, () => {
          para(Loc.contentLabel({ label: s.label, contentId: s.contentId }), mid, "ach-name", `scene-${i}-title`);
          para(T("{date} · {n} moments · {done}/{total} cards · score {score}", { date: s.date, n: s.beats.length, done: s.cardsDone, total: s.cardsTotal, score: s.score }), mid, "small", `scene-${i}-meta`);
          para(s.beats.length ? s.beats.map((b) => T(b)).join(", ") : T("quiet house"), mid, "small", `scene-${i}-beats`);
        }, { spacing: 2, width: mid });
        button({ id: `scene-${i}-delete`, text: T("Delete"), name: T("Delete") + " — " + Loc.contentLabel({ label: s.label, contentId: s.contentId }), style: "btn-text", act: () => deleteScene(s.id), quiet: true });
      }, { style: "scene-card", width: w, spacing: 12, align: "center" });
    });
  }, { spacing: 8, width: w });
  para(T("Mastery track"), w, "h2", "mastery-heading");
  const mastery: [string, string][] = [
    [N("Beat kinds discovered"), `${p.beatsSeen.length} / ${Object.keys(R.BEATS).length}`],
    [N("Discovery cards collected"), `${p.cardsCollected.length}`],
    [N("Journey stages completed"), `${Object.keys(p.journey).length} / ${C.journeyLength()}`],
    [N("Journey stars"), `${Object.values(p.journey).reduce((s, j) => s + (j.stars || 0), 0)} / ${C.journeyLength() * 3}`],
    [N("Days played"), `${p.daysPlayed.length}`],
    [N("Scenes saved"), `${p.scenesCount}`],
  ];
  ui.column("mastery-track", () => mastery.forEach(([k, v], i) => ui.row(`mastery-${i}`, () => {
    para(T(k), w - 90, "text", `mastery-${i}-k`);
    ui.spacer();
    ui.style("fact-v").label(v);
  }, { style: "fact", width: w, align: "center" })), { spacing: 0, width: w });
  para(T("Achievements"), w, "h2", "achievements-heading");
  ui.column("achievement-list", () => {
    C.ACHIEVEMENTS.forEach((a, i) => {
      const at = p.achievements[a.id];
      ui.column(`ach-${i}`, () => {
        para((at ? "🏅 " : "🔒 ") + T(a.name), w - 26, "ach-name", `ach-${i}-name`);
        para(T(a.desc) + (at ? " — " + T("unlocked {date}", { date: new Date(at).toLocaleDateString() }) : ""), w - 26, "small", `ach-${i}-desc`);
      }, { style: at ? "ach" : "ach-locked", width: w, spacing: 2 });
    });
  }, { spacing: 6, width: w });
  back();
}

function helpScreen(w: number): void {
  para(T("How to play"), w, "h1", "help-heading");
  const sample = C.practiceContent("cozy", 1, "meadow");
  const st = R.createGame(sample);
  const place = R.listLegalActions(st).find((a) => a.type === "place");
  const key = (a: string): string => keysFor(a).split("/")[0] ?? "—";
  const cards: [string, string, string | null][] = [
    [N("Make a home"), T("Place characters and props from the tray into glowing spots. Every piece on the floor is part of the story."),
      place ? T("place the {item} in the {room}", { item: Loc.itemName(place.item!), room: Loc.roomName(st.rooms.find((r) => r.id === place.room) ?? null) }) : null],
    [N("Make a moment"), T("A character and a prop in the same room can interact — that records a story moment. Two characters can share a heart to heart. Props alone cannot interact."), T("put Pip and the Old Clock in one room, then interact")],
    [N("Signatures & habitats"), T("Each character has a favorite thing (a golden ✦ signature moment). Moments in their natural room earn a habitat bonus."), T("Mabel with the Potted Fern, or tea in the Kitchen")],
    [N("Discovery cards"), T("Optional goals on the left rail. Complete them for points and to grow your collection — or ignore them and play freely."), T("check the Goals drawer any time")],
    [N("Save the scene"), T("Finished stories are scored by moments, discoveries, room coverage, and variety — the breakdown is always shown. Scenes persist in your Scrapbook."), T("the “Save scene ✦” button ends a story")],
    [N("Every action, acknowledged"), T("Confirm with {confirm}, cancel with {cancel}, undo with {undo}, hint with {hint}, camera reset with {camera}. Hints only suggest moves that are legal right now.",
      { confirm: key("confirm"), cancel: key("cancel"), undo: key("undo"), hint: key("hint"), camera: key("camera") }), null],
  ];
  ui.column("help-cards", () => {
    cards.forEach(([title, text, ex], i) => ui.column(`rule-${i}`, () => {
      para(T(title), w - 30, "h3", `rule-${i}-h`);
      para(text, w - 30, "text", `rule-${i}-p`);
      if (ex) para(T("Try: {example}", { example: ex }), w - 30, "fine", `rule-${i}-ex`);
    }, { style: "rule-card", width: w, spacing: 4 }));
  }, { spacing: 10, width: w });
  para(T("Controls"), w, "h2", "controls-heading");
  const rows: [string, string[]][] = [
    [T("Confirm / place"), [keysFor("confirm")]], [T("Cancel"), [keysFor("cancel")]], [T("Pause"), [keysFor("pause")]],
    [T("Undo"), [keysFor("undo")]], [T("Hint"), [keysFor("hint")]], [T("Camera reset"), [keysFor("camera")]], [T("Mute"), [keysFor("mute")]],
    [T("Move cursor"), [T("Arrow keys"), T("stick / dpad")]], [T("Cycle rooms"), [T("gamepad shoulder buttons")]],
    [T("Drag empty space to look around; pinch or wheel to zoom"), []],
  ];
  ui.column("help-bindings", () => rows.forEach(([label, keys], i) => ui.row(`binding-${i}`, () => {
    const kw = keys.reduce((a, k) => a + textWidth(k, "kbd-text") + 24, 0);
    para(label, Math.max(80, w - kw - 12), "text", `binding-${i}-a`);
    ui.spacer();
    for (const k of keys) ui.row(`binding-${i}-${k}`, () => ui.style("kbd-text").label(k), { style: "kbd" });
  }, { style: "binding-row", width: w, align: "center", spacing: 6 })), { spacing: 0, width: w });
  back();
}

function settingsScreen(w: number): void {
  const o = platform.options;
  para(T("Settings"), w, "h1", "settings-heading");
  const section = (id: string, title: string, build: (iw: number) => void): void => {
    ui.column(id, () => { para(title, w - 34, "legend", `${id}-h`); build(w - 34); }, { style: "fieldset", width: w, spacing: 8 });
  };
  section("set-audio", T("Audio"), (iw) => {
    para(T("Volumes, graphics quality, frame rate, language, larger text, high contrast, reduced motion and key bindings are in the StarHermit Options."), iw, "small", "options-note");
    flow("set-runtime", [
      { id: "btn-options", text: T("Open Options"), style: "btn-small", act: () => openMenu() },
      { id: "btn-rebind", text: T("Controls — keyboard & gamepad"), style: "btn-small", act: () => requestRebind() },
    ], iw, 8);
    toggleRow("set-mute", T("Mute all"), o.mute, iw, (v) => platform.setOption("mute", v));
    toggleRow("set-captions", T("Captions for meaningful audio"), o.captions, iw, (v) => platform.setOption("captions", v));
  });
  section("set-a11y", T("Accessibility"), (iw) => {
    const pals: platform.Palette[] = ["default", "protan", "deutan", "tritan"];
    selectRow("set-palette", T("Color palette"), Math.max(0, pals.indexOf(o.palette)), [T("Default"), T("Protanopia-safe"), T("Deuteranopia-safe"), T("Tritanopia-safe")], iw,
      (i) => { sound("toggle"); platform.setOption("palette", pals[i]!); });
    toggleRow("set-lefty", T("Left-handed controls"), o.lefty, iw, (v) => platform.setOption("lefty", v));
    const modes: platform.DragMode[] = ["both", "tap", "drag"];
    selectRow("set-drag-mode", T("Placement style"), Math.max(0, modes.indexOf(o.dragMode)), [T("Tap or drag"), T("Tap to select, tap to place"), T("Drag to place")], iw,
      (i) => { sound("toggle"); platform.setOption("dragMode", modes[i]!); });
    toggleRow("set-timing-assist", T("Timing assistance (scores become casual)"), o.timingAssist, iw, (v) => platform.setOption("timingAssist", v));
    toggleRow("set-haptics-off", T("Haptics off"), o.hapticsOff, iw, (v) => platform.setOption("hapticsOff", v));
    button({ id: "btn-replay-tutorials", text: T("Replay tutorials"), style: "btn-small", act: replayTutorials });
  });
  section("set-data", T("Data & privacy"), (iw) => {
    toggleRow("set-telemetry", T("Share anonymous usage funnel (start, tutorial steps, round end, errors)"), o.telemetry, iw, (v) => platform.setOption("telemetry", v));
    button({ id: "btn-wipe", text: T("Erase local progress"), style: "btn-danger", act: confirmWipe });
  });
  back();
}
