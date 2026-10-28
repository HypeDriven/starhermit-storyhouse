// Storyhouse on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), content
// (src/content.js), session (src/session.js) and save documents
// (src/persist.js) are the browser build's, unchanged; this module is what
// src/main.js did around them — the state machine (title → mode setup /
// journey / scrapbook / help / settings → countdown → active ⇄ paused →
// resolving → results), starting every mode (Learn, Journey, Daily,
// Practice, Challenge, Score Chase), selecting, placing, moving, returning
// and interacting pieces by pointer, finger, keys and pads (taps, drags from
// the tray or the house, the keyboard / gamepad cursor), undo, hints, the
// lesson steps, the clock and time limits, the results with progression,
// achievements, the scrapbook scene and the score post, "Continue your
// paused story", and the lifecycle (a hidden window pauses and saves, as
// visibilitychange did). Screens are drawn by screens.ts (starhermit:ui),
// the house by render.ts (starhermit:scene), sound by audio.ts.
//
// Time is the runtime's fixed steps: the session clock, the countdown, the
// one-second ticker (time limits, autosave), the beat lock and the toasts run
// on a clock advanced 1/60 s per fixed step, so slow frames never change a
// story and play scripts replay exactly.
import {
  clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate,
} from "starhermit:engine";
import { gamepads, onAction, onPointerButton, onPointerMove, onTouch, onWheel, primaryPointer, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import type { Vector3 } from "starhermit:scene";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { C, Loc, R, Sessions, type Achievement, type Command, type Content, type Event, type Lesson, type Scene, type Session, type Theme } from "./game.ts";
import * as audio from "./audio.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor, type Look } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

const BUILD = "1.0.0";
const VERSIONS = { build: BUILD, contentVersion: C.CONTENT_VERSION, ruleset: R.RULESET_VERSION };

export type Phase = "boot" | "title" | "mode-select" | "preparing" | "countdown" | "active" | "paused" | "resolving" | "results";
export type Screen = "title" | "setup" | "results" | "journey" | "scrapbook" | "help" | "settings" | null;
export interface DialogButton { label: string; primary?: boolean; danger?: boolean; action?: () => void }
export interface Dialog { title: string; text: string; buttons: DialogButton[] }
export interface Toast { text: string; kind: "" | "good" | "bad"; until: number }
export interface SetupView {
  mode: string; facts: [string, () => string][]; ranked: boolean; rankedNote: string; startLabel: string;
  fields: ("lesson" | "difficulty" | "theme" | "practiceSeed" | "challenge" | "scoreSeed")[];
}
export interface Setup { mode: string; index?: number; date?: string; lessonId?: string; difficulty?: string; theme?: string; seed?: string; challengeId?: string }
export interface ResultsView {
  headline: string; stars: number; total: number; rows: [string, () => string][];
  cards: { title: () => string; done: boolean }[]; achievements: Achievement[]; compare: () => string; nextLabel: string;
}
export interface LessonRun { def: Lesson; stepIndex: number }
export interface CtxAction { kind: "interact" | "remove"; room?: string; a?: string; b?: string; item?: string; label: string }

export const app = {
  phase: "boot" as Phase,
  screen: "title" as Screen,
  pauseOpen: false,
  dialog: null as Dialog | null,
  countdown: null as string | null,
  session: null as Session | null,
  selection: null as string | null,
  mode: null as string | null,
  setup: null as Setup | null,
  setupView: null as SetupView | null,
  lesson: null as LessonRun | null,
  results: null as ResultsView | null,
  toasts: [] as Toast[],
  caption: null as { text: string; until: number } | null,
  mirror: false,
  drawer: null as "left" | "right" | null,
  fromPause: false,
  openedFrame: 0,
  focusNext: null as string | null,
  /** The keyboard / gamepad cursor shows only after key or pad input. */
  cursorShown: false,
  drag: null as { key: string; started: boolean; x0: number; y0: number; fromTray: boolean } | null,
  hoverInvalid: null as string | null,
  theme: C.THEMES.meadow! as Theme,
};
export let look: Look = lookFor("balanced", 2);

// ------------------------------------------------------------------ clock and timers
let clockMs = 0;
export const now = (): number => clockMs;
Sessions.setClock(() => clockMs);
const timers: { at: number; fn: () => void; tag: string }[] = [];
function after(ms: number, fn: () => void, tag = ""): void { timers.push({ at: clockMs + ms, fn, tag }); }
function cancel(tag: string): void { for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.tag === tag) timers.splice(i, 1); }
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
let spokenAssertive = false;
/** The live regions (objective, story moments, errors, results): one announcement a frame, joined. */
export function live(text: string, assertive = false): void {
  if (!text) return;
  spoken.push(text);
  spokenAssertive ||= assertive;
}
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).join(" ").slice(0, 500);
  try { ui.announce(text, { politeness: spokenAssertive ? "assertive" : "polite" }); } catch { /* busy */ }
  spokenAssertive = false;
}
export function toast(text: string, kind: Toast["kind"] = ""): void {
  app.toasts.push({ text, kind, until: clockMs + 3400 });
  if (app.toasts.length > 4) app.toasts.shift();
  live(text);
  if (kind !== "bad") audio.sfx("toast");
}
audio.onCaption((key) => {
  if (!platform.options.captions) return;
  app.caption = { text: `♪ ${T(key)}`, until: clockMs + 3200 };
});
const pending: (() => void)[] = [];
let uiPressed = false;
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); uiPressed = true; }
function haptic(ms: number): void {
  if (platform.options.hapticsOff) return;
  try { vibrate(ms); } catch { /* none */ }
}
export function sound(name: string): void { audio.sfx(name); }
const coarse = (): boolean => {
  const f = frame();
  return primaryPointer() === "coarse" || (primaryPointer() === "none" && Math.min(f.width, f.height) / f.scale < 600);
};

function transition(to: Phase, reason: string): void {
  const from = app.phase;
  app.phase = to;
  console.info(`[storyhouse] ${from} → ${to} (${reason})`);
  if (to === "title") showScreen("title");
  if (to === "results") showScreen("results");
}
/** Opens a screen (null: the house), focusing its first control for keyboard players. */
export function showScreen(name: Screen, focus: string | null = null): void {
  if (app.screen === "settings" && name !== "settings") sound("settings-saved");
  app.screen = name;
  if (name) app.drawer = null;
  app.openedFrame = frame().frame;
  app.focusNext = focus ?? (coarse() ? null : firstFocus(name));
  if (!focus) ui.setFocus(null);
  syncBackdrop();
}
function firstFocus(s: Screen): string | null {
  switch (s) {
    case "title": return "btn-play";
    case "setup": return "btn-setup-start";
    case "results": return "btn-results-next";
    case "journey": return `stage-${nextJourneyIndex() + 1}`;
    case "scrapbook": case "help": case "settings": return "btn-back";
    default: return null;
  }
}
export function showDialog(d: Dialog): void {
  app.dialog = d;
  app.openedFrame = frame().frame;
  app.focusNext = coarse() ? null : "dialog-0";
  sound("open");
}
export function closeDialog(): void { app.dialog = null; ui.setFocus(null); }
function showPause(on: boolean): void {
  app.pauseOpen = on;
  if (on) { app.drawer = null; app.openedFrame = frame().frame; app.focusNext = coarse() ? null : "btn-resume"; }
  else ui.setFocus(null);
}

// ------------------------------------------------------------------ the title backdrop (main.js _syncBackdrop)
let backdropBuilt = false;
function syncBackdrop(): void {
  if (app.session) { render.setBackdrop(null); render.setActive(true); return; }
  const mode = look.backdrop;
  if (mode === "off") { render.setActive(false); return; }
  if (!backdropBuilt || !render.hasHouse()) {
    const content = C.practiceContent("standard", 3, "meadow");
    const state = R.createGame(content);
    const tray = state.tray.slice();
    for (const room of state.rooms) {
      for (let k = 0; k < Math.min(2, room.slots.length) && tray.length; k++) room.slots[k] = tray.shift()!;
    }
    state.tray = tray;
    render.startSession(content, C.THEMES[content.theme] || C.THEMES.meadow!, state);
    backdropBuilt = true;
  }
  render.setBackdrop(mode);
  render.setActive(true);
}

// ------------------------------------------------------------------ title info
export function nextJourneyIndex(): number {
  const p = platform.progress();
  for (let i = 0; i < C.journeyLength(); i++) if (!p.journey[C.journeyStage(i).contentId]) return i;
  return C.journeyLength() - 1;
}
export function hasSnapshot(): boolean { return !!platform.loadSnapshot(); }
export function syncLabel(): string | null {
  switch (platform.syncState()) {
    case "synced": return T("cloud synced");
    case "saving": case "connecting": return T("saving…");
    case "error": return T("sync error");
    default: return null;
  }
}

// ------------------------------------------------------------------ navigation (main.js goto)
export function goto(where: string): void {
  sound(where === "title" ? "back" : "open");
  if (where === "title") {
    // Settings / help opened from the pause overlay return to the paused story.
    if (app.fromPause && app.session?.state.status === "active") {
      app.fromPause = false;
      showScreen(null);
      transition("paused", "closed a menu opened from pause");
      showPause(true);
      return;
    }
    app.fromPause = false;
    leaveToTitle();
    return;
  }
  if (where === "settings") { transition("mode-select", "settings"); showScreen("settings"); return; }
  if (where === "help") { transition("mode-select", "help"); showScreen("help"); return; }
  if (where === "journey") { transition("mode-select", "journey map"); showScreen("journey"); return; }
  if (where === "scrapbook") { transition("mode-select", "scrapbook"); showScreen("scrapbook"); return; }
  if (["daily", "learn", "practice", "challenge", "score"].includes(where)) openSetup(where);
}
export function quickPlay(): void { app.mode = "journey"; startSession({ mode: "journey", index: nextJourneyIndex() }); }
export function openFromPause(where: "settings" | "help"): void {
  app.fromPause = app.phase === "paused";
  showPause(false);
  goto(where);
}

// ------------------------------------------------------------------ setup (main.js openSetup)
const randomSeed = (lo: number, span: number): string => String(Math.floor(Math.random() * span) + lo);
export function openSetup(mode: string): void {
  app.mode = mode;
  transition("mode-select", `setup ${mode}`);
  const today = platform.utcToday();
  if (mode === "daily") app.setup = { mode, date: today };
  else if (mode === "learn") {
    const p = platform.progress();
    const next = C.LESSONS.find((l) => !p.lessons[l.id]) || C.LESSONS[0]!;
    app.setup = { mode, lessonId: next.id };
  } else if (mode === "practice") app.setup = { mode, difficulty: "cozy", theme: app.theme.id, seed: randomSeed(100000, 899999) };
  else if (mode === "challenge") app.setup = { mode, challengeId: C.CHALLENGES[0]!.id };
  else if (mode === "score") app.setup = { mode, seed: randomSeed(10000, 89999) };
  refreshSetupView();
  showScreen("setup");
}
/** The setup screen's facts for the current choices (rebuilt when a choice changes). */
export function refreshSetupView(): void {
  const s = app.setup;
  if (!s) return;
  const today = platform.utcToday();
  const v = (x: string | number): (() => string) => () => String(x);
  const t = (k: string, vars?: Record<string, string | number>): (() => string) => () => T(k, vars);
  if (s.mode === "daily") {
    const content = C.dailyContent(today);
    const done = platform.progress().lastDaily?.date === today;
    const leftMs = platform.msToNextDaily();
    const leftH = Math.floor(leftMs / 3600000), leftM = Math.ceil((leftMs % 3600000) / 60000);
    app.setupView = {
      mode: N("Daily Story"), fields: [], ranked: true, rankedNote: N("one shared seed and ruleset for everyone today"),
      startLabel: done ? N("Replay today") : N("Start today’s story"),
      facts: [[N("Date (UTC)"), v(today)], [N("House"), () => Loc.layoutLabel(content.layout)], [N("Pieces"), v(content.tray.length)],
        [N("Discovery cards"), v(content.cards.length)], [N("Seed"), v(content.seed)], [N("Expected time"), t("3–6 minutes")],
        [N("Players"), t("1 — scores compared asynchronously")], [N("Next daily in"), t("{h}h {m}m (server-synced)", { h: leftH, m: leftM })],
        done ? [N("Today"), t("Completed — replay to improve")] : [N("Today"), t("Not yet played")]],
    };
  } else if (s.mode === "learn") {
    const lesson = C.LESSONS.find((l) => l.id === s.lessonId) || C.LESSONS[0]!;
    app.setupView = {
      mode: N("Learn"), fields: ["lesson"], ranked: false, rankedNote: N("lessons are never ranked"), startLabel: N("Start lesson"),
      facts: [[N("Lessons"), t("{n} interactive", { n: C.LESSONS.length })], [N("This lesson"), t(lesson.title)],
        [N("Rules"), t("One new idea at a time — you perform each action")], [N("Expected time"), t("1–3 minutes")]],
    };
  } else if (s.mode === "practice") {
    const dd = C.PRACTICE_DIFFICULTIES[s.difficulty || "cozy"]!;
    app.setupView = {
      mode: N("Practice"), fields: ["difficulty", "theme", "practiceSeed"], ranked: false, rankedNote: N("undo enabled, no effect on ratings"),
      startLabel: N("Start practicing"),
      facts: [[N("Difficulty"), t(dd.label)], [N("House"), () => Loc.layoutLabel(C.LAYOUTS[dd.layout]!)], [N("Pieces"), v(dd.chars + dd.props)],
        [N("Discovery cards"), v(dd.cards.length)], [N("Move limit"), dd.limited ? t("Yes — tight") : t("None")], [N("Undo"), t("Allowed")],
        [N("Expected time"), t("2–7 minutes")]],
    };
  } else if (s.mode === "challenge") {
    const c = C.challengeContent(s.challengeId || C.CHALLENGES[0]!.id);
    app.setupView = {
      mode: N("Challenge"), fields: ["challenge"], ranked: !!c.ranked, rankedNote: c.ranked ? N("validated replay on the leaderboard") : N("unranked"),
      startLabel: N("Take the challenge"),
      facts: [[N("Challenge"), t(c.label)], [N("House"), () => Loc.layoutLabel(c.layout)], [N("Pieces"), v(c.tray.length)],
        [N("Discovery cards"), v(c.cards.length)],
        ...(c.moveLimit ? [[N("Move limit"), v(c.moveLimit)] as [string, () => string]] : []),
        ...(c.timeLimitMs ? [[N("Time limit"), t("{n}s · speed scores bonus", { n: c.timeLimitMs / 1000 })] as [string, () => string]] : []),
        [N("Undo"), c.allowUndo ? t("Allowed") : t("Off")], [N("Expected time"), t("3–8 minutes")]],
    };
  } else if (s.mode === "score") {
    app.setupView = {
      mode: N("Score Chase"), fields: ["scoreSeed"], ranked: true, rankedNote: N("global and friends boards on this seed"),
      startLabel: N("Chase the score"),
      facts: [[N("House"), t("Manor")], [N("Pieces"), t("7, seeded")], [N("Discovery cards"), t("4, seeded")],
        [N("Expected time"), t("4–8 minutes")], [N("Validation"), t("server replays your input log")]],
    };
  }
}
export function setSetup(patch: Partial<Setup>): void {
  if (!app.setup) return;
  Object.assign(app.setup, patch);
  sound("tab");
  refreshSetupView();
}
export function startFromSetup(): void { if (app.setup) startSession(app.setup); }

// ------------------------------------------------------------------ sessions (main.js _startSession)
function contentFor(s: Setup): Content | null {
  switch (s.mode) {
    case "journey": return C.journeyStage(s.index ?? 0);
    case "daily": return C.dailyContent(s.date || platform.utcToday());
    case "learn": return C.lessonContent(s.lessonId || C.LESSONS[0]!.id);
    case "practice": return C.practiceContent(s.difficulty || "cozy", Number(s.seed) || 1, s.theme);
    case "challenge": return C.challengeContent(s.challengeId || C.CHALLENGES[0]!.id);
    case "score": return C.scoreChaseContent(Number(s.seed) || 1);
    default: return null;
  }
}
/** Inverse of contentFor: the setup that regenerates this exact content. */
function setupForContent(c: Content): Setup {
  const mode = c.mode, id = c.contentId || "";
  if (mode === "journey") return { mode, index: Math.max(0, Number(id.replace(/^journey-/, "")) - 1) };
  if (mode === "daily") return { mode, date: id.replace(/^daily-/, "") };
  if (mode === "learn") return { mode, lessonId: id };
  if (mode === "challenge") return { mode, challengeId: id.replace(/^challenge-/, "") };
  if (mode === "score") return { mode, seed: id.replace(/^score-/, "") };
  if (mode === "practice") {
    const m = /^practice-([^-]+)-(.+)$/.exec(id);
    return { mode, difficulty: m?.[1] || "cozy", seed: m?.[2] || "1", theme: c.theme };
  }
  return { mode };
}
export function startSession(setup: Setup, restored: Session | null = null): void {
  const content = restored ? restored.content : contentFor(setup);
  if (!content) { toast(T("That content is unavailable."), "bad"); return; }
  app.mode = setup.mode;
  app.setup = { ...setup };
  cancel("countdown");
  transition("preparing", `start ${setup.mode}`);
  app.theme = C.THEMES[content.theme] || C.THEMES.meadow!;
  audio.setTheme(app.theme);
  audio.setMusicIntensity(0);
  const s = restored || new Sessions.GameSession(content).start(R.createGame(content));
  s.pauseClock(); // the clock starts when the countdown ends, at 'active'
  app.session = s;
  app.selection = null;
  app.lesson = null;
  app.results = null;
  clockWarned = false;
  app.dialog = null;
  if (setup.mode === "learn") {
    const def = C.LESSONS.find((l) => l.id === (setup.lessonId || content.contentId));
    if (def) app.lesson = { def, stepIndex: 0 };
  }
  render.startSession(content, app.theme, s.state);
  backdropBuilt = false;
  render.setBackdrop(null);
  render.setActive(true);
  showScreen(null);
  showPause(false);
  app.drawer = null;
  platform.telemetry("start");
  cursorIndex = -1;
  render.setCursor(null);
  syncAll();
  // Countdown → active.
  transition("countdown", "session prepared");
  const seq = preferences().reducedMotion ? ["Go"] : ["3", "2", "1", "Go"];
  let i = 0;
  live(`${Loc.contentLabel(content)}. ${objectiveText()}`);
  const step = (): void => {
    if (app.session !== s) return;
    if (i < seq.length) {
      app.countdown = T(seq[i]!);
      sound(i === seq.length - 1 ? "go" : "countdown");
      i++;
      after(preferences().reducedMotion ? 500 : 700, step, "countdown");
    } else {
      app.countdown = null;
      s.resumeClock();
      transition("active", "countdown complete");
      tickAcc = 0;
      autosave = 0;
    }
  };
  step();
}
export function restartSession(): void {
  if (!app.session) return;
  platform.telemetry("retry");
  showPause(false);
  startSession({ ...(app.setup ?? { mode: app.mode ?? "journey" }) });
  toast(T("Fresh start — same house, same seed."));
}
export function confirmRestart(): void {
  showDialog({
    title: N("Restart this story?"), text: N("The current arrangement will be lost, but anything already saved stays saved."),
    buttons: [{ label: N("Restart"), danger: true, action: restartSession }, { label: N("Keep playing"), primary: true }],
  });
}
export function confirmWipe(): void {
  showDialog({
    title: N("Erase local progress?"), text: N("Journey stars, scenes, achievements, and settings on this device will be deleted. This cannot be undone."),
    buttons: [
      { label: N("Erase everything"), danger: true, action: () => {
        platform.eraseAll();
        for (const [k, v] of Object.entries(platform.DEFAULT_OPTIONS)) platform.setOption(k as keyof platform.Options, v as never);
        toast(T("Local progress erased."));
        showScreen("title");
      } },
      { label: N("Keep my progress"), primary: true },
    ],
  });
}
function saveSnapshot(): void {
  if (app.session && app.session.state.status === "active") platform.saveSnapshot(app.session.serializeSnapshot());
}
export function resumeSnapshot(): void {
  const json = platform.loadSnapshot();
  if (!json) return;
  const restored = Sessions.GameSession.restoreSnapshot(json);
  if (!restored) { toast(T("That saved story could not be read."), "bad"); return; }
  app.mode = restored.content.mode;
  // Rebuild the setup from the restored content, so Restart and Next regenerate the same stage.
  const setup = setupForContent(restored.content);
  startSession(setup, restored);
  const ago = Math.round((Date.now() - (restored._savedAt || Date.now())) / 60000);
  toast(ago >= 1 ? T("Welcome back — restored your paused story from about {n} min ago.", { n: ago }) : T("Welcome back — restored your paused story."));
}
export function pauseGame(reason: string, silent = false): void {
  if (app.phase !== "active" || !app.session) return;
  app.session.pauseClock();
  transition("paused", reason);
  endDrag(null);
  if (!silent) { showPause(true); sound("pause"); }
  saveSnapshot();
}
export function resumeGame(reason: string): void {
  if (app.phase !== "paused" || !app.session) return;
  showPause(false);
  sound("resume");
  app.session.resumeClock();
  transition("active", reason);
}
export function togglePause(reason: string): void { if (app.phase === "active") pauseGame(reason); else if (app.phase === "paused") resumeGame(reason); }
export function leaveToTitle(): void {
  cancel("countdown");
  if (app.session?.state.status === "active") saveSnapshot();
  else if (app.session?.state.status === "terminal") platform.clearSnapshot();
  app.session = null;
  app.lesson = null;
  app.countdown = null;
  app.selection = null;
  app.dialog = null;
  showPause(false);
  render.setCursor(null);
  transition("title", "leave to title");
}

// ------------------------------------------------------------------ selecting, placing, interacting (main.js)
function legalSlotsFor(itemKey: string): render.SlotRef[] {
  const st = app.session!.state;
  if (st.moveLimit !== null && st.stats.moves >= st.moveLimit) return [];
  const placed = R.itemSlot(st, itemKey);
  const out: render.SlotRef[] = [];
  for (const room of st.rooms) {
    room.slots.forEach((s, i) => {
      if (s === null) {
        if (placed && placed.room.id === room.id && placed.slot === i) return;
        out.push({ room: room.id, slot: i });
      }
    });
  }
  return out;
}
export function setSelection(key: string | null): void {
  app.selection = key;
  render.setSelection(key, key ? legalSlotsFor(key) : []);
  if (!key) render.setHoverTarget(null);
  syncAll();
  if (key) sound("pickup");
}
export function canAct(): boolean { return app.phase === "active" && app.session?.state.status === "active" && !resolving; }
export function tapPiece(key: string): void {
  if (!canAct()) return;
  const st = app.session!.state;
  if (!st.items[key]) return;
  if (app.selection === key) { setSelection(null); return; }
  if (app.selection && app.selection !== key) {
    // Tapping a second piece in the same room = interact.
    const a = R.itemRoom(st, app.selection), b = R.itemRoom(st, key);
    if (a && b && a.id === b.id) {
      const cmd: Command = { type: "interact", room: a.id, a: app.selection, b: key };
      const check = R.validateCommand(st, cmd);
      if (check.ok) { submit(cmd); setSelection(null); return; }
      const slot = R.itemSlot(st, key);
      invalidAt(check.reason ?? "", slot ? { room: slot.room.id, slot: slot.slot } : null);
      audio.voiceBlip(key);
      setSelection(key);
      return;
    }
  }
  setSelection(key);
}
export function tapSlot(slot: render.SlotRef): void {
  if (!canAct()) return;
  if (app.selection) { placeSelected(slot); return; }
  const room = R.roomById(app.session!.state, slot.room);
  const item = room?.slots[slot.slot];
  if (item) tapPiece(item);
  else toast(T("Pick a piece from the tray first — then choose a spot."));
}
function placeSelected(slot: render.SlotRef): void {
  if (!app.selection || !canAct()) return;
  const st = app.session!.state;
  const placed = R.itemSlot(st, app.selection);
  const cmd: Command = placed ? { type: "move", item: app.selection, room: slot.room, slot: slot.slot } : { type: "place", item: app.selection, room: slot.room, slot: slot.slot };
  const check = R.validateCommand(st, cmd);
  if (!check.ok) { invalidAt(check.reason ?? "", slot); return; }
  submit(cmd);
  app.selection = null;
  render.setSelection(null, []);
  syncAll();
}
function dragHover(key: string, slot: render.SlotRef | null): void {
  if (!slot) { render.setHoverTarget(null); return; }
  const st = app.session!.state;
  const placed = R.itemSlot(st, key);
  const cmd: Command = placed ? { type: "move", item: key, room: slot.room, slot: slot.slot } : { type: "place", item: key, room: slot.room, slot: slot.slot };
  const check = R.validateCommand(st, cmd);
  render.setHoverTarget(slot, key, check.ok);
  app.hoverInvalid = check.ok ? null : (check.reason ?? null);
  if (clockMs - dragSnd > 180) { dragSnd = clockMs; sound("drag"); }
}
let dragSnd = 0;
function invalidAt(reason: string, slot: render.SlotRef | null): void {
  const text = T(R.reasonText(reason));
  toast(text, "bad");
  live(text, true);
  sound("invalid");
  if (slot) {
    render.setHoverTarget(slot, null, false);
    after(600, () => render.setHoverTarget(null), "invalid");
  }
}
export function contextAction(a: CtxAction): void {
  if (!canAct()) return;
  if (a.kind === "interact") submit({ type: "interact", room: a.room, a: a.a, b: a.b });
  else submit({ type: "remove", item: a.item });
  setSelection(null);
}
function interactKey(): void {
  if (!app.selection || !canAct()) return;
  const st = app.session!.state;
  const room = R.itemRoom(st, app.selection);
  if (!room) return;
  const sel = app.selection;
  const partner = R.itemsInRoom(st, room.id).find((k) => {
    if (k === sel) return false;
    const b = R.beatForPair(st, sel, k);
    return !!b && !R.hasBeat(st, b.type, room.id, sel, k);
  });
  if (partner) { submit({ type: "interact", room: room.id, a: sel, b: partner }); setSelection(null); }
  else toast(T("No fresh moment available with this piece here."));
}
let resolving = false;
function submit(cmd: Command): void {
  const r = app.session!.submit(cmd);
  handleEvents(r.events, cmd);
}
function handleEvents(events: Event[], cmd: Command | null = null): void {
  if (!events.length || !app.session) return;
  render.playEvents(events, app.session.state);
  for (const e of events) {
    if (e.type === "placed" || e.type === "moved") { sound("place"); haptic(8); }
    else if (e.type === "removed") sound("remove");
    else if (e.type === "beat" && e.beat) {
      audio.beatSfx(e.beat.sig === 1, e.beat.hab === 1);
      audio.voiceBlip(e.beat.a);
      haptic(40);
      live(T("{beat} — a new story moment.", { beat: Loc.beatLabel(e.beat.t) }));
      resolving = true;
      after(260, () => { resolving = false; }, "resolve");
    } else if (e.type === "card" && e.card) {
      audio.cardSfx();
      toast("◆ " + T("Discovery complete: {card} (+{n})", { card: Loc.cardTitle(e.card), n: e.card.points }), "good");
      haptic(60);
    } else if (e.type === "invalid") {
      if (cmd) invalidAt(e.reason ?? "", null);
    } else if (e.type === "gameover") {
      platform.telemetry("round-end");
      const s = app.session;
      after(preferences().reducedMotion ? 300 : 1400, () => { if (app.session === s) showResults(); }, "results");
      transition("resolving", `terminal: ${e.reason ?? ""}`);
      endDrag(null);
    }
  }
  afterCommand(cmd);
  syncAll();
}
function afterCommand(cmd: Command | null): void {
  const s = app.session!;
  const l = app.lesson;
  if (l && cmd) {
    const step = l.def.steps[l.stepIndex];
    if (step && stepSatisfied(step.require, cmd)) {
      l.stepIndex++;
      platform.telemetry("tutorial-step");
      const p = platform.progress();
      if (l.stepIndex >= l.def.steps.length) {
        p.lessons[l.def.id] = true;
        toast(T("Lesson complete: {name} ✓", { name: T(l.def.title) }), "good");
      } else {
        sound("tutorial");
        live(T("Lesson step {n}: {text}", { n: l.stepIndex + 1, text: T(l.def.steps[l.stepIndex]!.text) }));
      }
      platform.saveProgress(p);
    }
  }
  const total = s.state.cardDefs.length;
  if (total) audio.setMusicIntensity(s.state.cardDefs.filter((c) => s.state.cards[c.id] === 1).length / total);
}
function stepSatisfied(req: Lesson["steps"][number]["require"], cmd: Command): boolean {
  const st = app.session!.state;
  if (req.type === "custom") {
    if (req.check === "cards-done") return st.cardDefs.every((c) => st.cards[c.id] === 1);
    if (req.check?.startsWith("together:")) {
      const [, a, b] = req.check.split(":");
      const ra = R.itemRoom(st, a!), rb = R.itemRoom(st, b!);
      return !!ra && !!rb && ra.id === rb.id;
    }
    return false;
  }
  if (cmd.type !== req.type) return false;
  if (req.item && cmd.item !== req.item) return false;
  if (req.roomType) {
    const room = R.roomById(st, cmd.room ?? "");
    if (room?.type !== req.roomType) return false;
  }
  return true;
}
export function hint(): void {
  if (!canAct()) return;
  const st = app.session!.state;
  const s = R.suggestAction(st);
  if (!s) return;
  sound("hint");
  const why = hintWhy(s.why);
  let text: string;
  if (s.type === "place" || s.type === "move") {
    const room = R.roomById(st, s.room!);
    text = why + " " + T(s.type === "place" ? "Try placing {item} in the {room}." : "Try moving {item} to the {room}.", { item: Loc.itemName(s.item!), room: Loc.roomName(room) });
    setSelection(s.item!);
    render.focusRoom(s.room!);
  } else if (s.type === "interact") {
    text = why + " " + T("Try {a} with {b} in the {room}.", { a: Loc.itemName(s.a!), b: Loc.itemName(s.b!), room: Loc.roomName(R.roomById(st, s.room!)) });
    setSelection(s.a!);
    render.focusRoom(s.room!);
  } else text = why + " " + T("Press “Save scene ✦” when you are ready.");
  toast(text, "good");
}
/** rules.suggestAction's English reason, localized (card titles rebuilt from the card). */
function hintWhy(why: string | undefined): string {
  const m = /^(Works toward|Set up) “(.+)”\.$/.exec(why || "");
  if (m) {
    const def = app.session!.state.cardDefs.find((c) => c.title === m[2]);
    const card = def ? Loc.cardTitle(def) : T(m[2]!);
    return m[1] === "Set up" ? T("Set up “{card}”.", { card }) : T("Works toward “{card}”.", { card });
  }
  return T(why || "");
}
export function undo(): void {
  if (!canAct()) return;
  const prev = app.session!.undo();
  if (!prev) { toast(T("Nothing to undo.")); return; }
  sound("undo");
  app.selection = null;
  render.setSelection(null, []);
  render.settleAll(app.session!.state);
  toast(T("Undone."));
  syncAll();
}
export function finish(): void {
  if (!canAct()) return;
  const st = app.session!.state;
  const pendingCards = st.cardDefs.filter((c) => st.cards[c.id] === 0);
  if (pendingCards.length && st.beats.length === 0) {
    showDialog({
      title: N("Save an empty story?"), text: N("No moments have happened yet, and discovery cards are still open. Save anyway?"),
      buttons: [{ label: N("Save scene"), primary: true, action: () => submit({ type: "finish" }) }, { label: N("Keep playing") }],
    });
    return;
  }
  submit({ type: "finish" });
}
export function cameraReset(): void { render.resetCamera(); sound("click"); }
export function toggleMirror(): void {
  app.mirror = !app.mirror;
  if (app.mirror) toast(T("Text mode: the whole house is playable from the panel and tray."));
}
export function toggleDrawer(which: "left" | "right"): void {
  const open = app.drawer !== which;
  app.drawer = open ? which : null;
  sound(open ? "open" : "close");
  ui.setFocus(null);
}

// ------------------------------------------------------------------ HUD texts (main.js _updateHud)
let clockWarned = false;
export function objectiveText(): string {
  const st = app.session!.state;
  if (app.lesson) return T(app.lesson.def.intro);
  const total = st.cardDefs.length;
  const done = st.cardDefs.filter((c) => st.cards[c.id] === 1).length;
  if (st.moveLimit !== null) return T("Move limit: {limit}. Cards {done}/{total}. End by saving the scene — it ends itself at the limit.", { limit: st.moveLimit, done, total });
  if (st.timeLimitMs !== null) return T("Beat the clock ({n}s). Cards {done}/{total}. Speed adds bonus.", { n: st.timeLimitMs / 1000, done, total });
  return total ? T("Discovery cards {done}/{total} — or play freely, then save the scene.", { done, total }) : T("Play freely, then save the scene.");
}
export function clockText(): { text: string; warn: boolean } {
  const s = app.session!, st = s.state;
  if (st.timeLimitMs !== null) {
    const left = Math.max(0, st.timeLimitMs - s.elapsedMs());
    return { text: `⏱ ${Math.ceil(left / 1000)}s`, warn: left < 15000 };
  }
  return { text: `⏱ ${Math.floor(s.elapsedMs() / 1000)}s`, warn: false };
}
export function movesText(): string {
  const st = app.session!.state;
  return st.moveLimit !== null ? T("Moves {n}/{limit}", { n: st.stats.moves, limit: st.moveLimit }) : T("Moves {n}", { n: st.stats.moves });
}
export function selectionInfo(): { desc: string; actions: CtxAction[] } {
  const st = app.session!.state;
  const sel = app.selection;
  if (!sel) return { desc: T("Nothing selected. Tap a piece to pick it up."), actions: [] };
  const placed = R.itemSlot(st, sel);
  const name = Loc.itemName(sel);
  const actions: CtxAction[] = [];
  if (placed) {
    for (const other of R.itemsInRoom(st, placed.room.id).filter((k) => k !== sel)) {
      const beat = R.beatForPair(st, sel, other);
      if (beat && !R.hasBeat(st, beat.type, placed.room.id, sel, other)) {
        actions.push({ kind: "interact", room: placed.room.id, a: sel, b: other, label: `✦ ${Loc.beatLabel(beat.type)}: ${name} + ${Loc.itemName(other)}` });
      }
    }
    actions.push({ kind: "remove", item: sel, label: "↩ " + T("Return {name} to the tray", { name }) });
  }
  return {
    desc: placed ? T("{name} — in the {room}. Tap a glowing spot to move, or:", { name, room: Loc.roomName(placed.room) }) : T("{name} — on the tray. Tap a glowing spot to place.", { name }),
    actions,
  };
}
export function finishNote(): string {
  const st = app.session!.state;
  const n = st.cardDefs.filter((c) => st.cards[c.id] === 0).length;
  return n ? T(n > 1 ? "{n} cards still open" : "{n} card still open", { n }) : (st.cardDefs.length ? T("All cards complete ✓") : "");
}
/** After any change: the cursor targets follow the state. */
function syncAll(): void { rebuildCursorTargets(); }

// ------------------------------------------------------------------ results (main.js _showResults)
function showResults(): void {
  const s = app.session;
  if (!s) return;
  const st = s.state;
  const score = R.scoreState(st);
  platform.clearSnapshot();
  render.settleAll(st);
  const p = platform.progress();
  const today = platform.utcToday();
  const firstPlayToday = !p.daysPlayed.includes(today);
  const prevBest = p.bestScores[st.contentId] || 0;
  if (firstPlayToday) p.daysPlayed.push(today);
  for (const b of st.beats) if (!p.beatsSeen.includes(b.t)) p.beatsSeen.push(b.t);
  for (const c of st.cardDefs) {
    const key = `${st.contentId}/${c.id}`;
    if (st.cards[c.id] === 1 && !p.cardsCollected.includes(key)) p.cardsCollected.push(key);
  }
  if (app.mode === "journey") {
    const rec = p.journey[st.contentId] || { stars: 0, score: 0 };
    rec.stars = Math.max(rec.stars, score.stars);
    rec.score = Math.max(rec.score, score.total);
    p.journey[st.contentId] = rec;
  }
  p.bestScores[st.contentId] = Math.max(p.bestScores[st.contentId] || 0, score.total);
  if (app.mode === "daily") p.lastDaily = { date: today, total: score.total };
  p.scenesCount++;
  const newly: Achievement[] = [];
  const unlock = (id: string, cond: boolean): void => {
    if (cond && !p.achievements[id]) {
      p.achievements[id] = Date.now();
      const a = C.ACHIEVEMENTS.find((x) => x.id === id);
      if (a) newly.push(a);
    }
  };
  unlock("first-scene", true);
  unlock("mechanic-master", p.beatsSeen.length >= Object.keys(R.BEATS).length);
  unlock("streak-3", p.daysPlayed.length >= 3);
  unlock("mastery-crown", !!s.content.mastery && score.stars >= 3);
  unlock("curator", p.cardsCollected.length >= 25);
  platform.saveProgress(p);

  // The scene into the scrapbook (its picture follows once the capture is read).
  const scene: Scene = {
    id: s.sessionId, contentId: st.contentId, label: s.content.label || st.contentId, theme: app.theme.id,
    date: new Date(platform.nowMs()).toLocaleDateString(), savedAt: Date.now(), score: score.total, stars: score.stars,
    beats: st.beats.map((b) => R.BEATS[b.t]!.label), cardsDone: score.cardsDone, cardsTotal: score.cardsTotal,
    thumbnail: null, seed: st.seed, replay: s.replayEnvelope(VERSIONS) as Scene["replay"],
  };
  platform.saveScene(scene);
  void render.captureThumbnail().then((url) => {
    if (!url) return;
    const cur = platform.scenes().find((x) => x.id === scene.id);
    if (cur) platform.saveScene({ ...cur, thumbnail: url });
  });

  // Ranked submission: signed in, the total goes to the high-score board; else the casual local board.
  let compare: () => string = () => "";
  const ranked = !!s.content.ranked && !platform.options.timingAssist;
  const view: ResultsView = {
    headline: ({ "scene-saved": N("Scene saved ✦"), "move-limit": N("Out of moves — scene saved"), "time-up": N("Time! — scene saved") } as Record<string, string>)[st.terminalReason ?? ""] || N("Scene saved"),
    stars: score.stars, total: score.total,
    rows: [
      [N("Story moments"), () => T("{n} ({beats} beats)", { n: score.moments, beats: score.beats })],
      [N("Discoveries"), () => T("{n} ({done}/{total} cards)", { n: score.discoveries, done: score.cardsDone, total: score.cardsTotal })],
      [N("Room coverage"), () => String(score.coverage)],
      [N("Variety"), () => String(score.variety)],
      ...(score.timeBonus ? [[N("Time bonus"), () => String(score.timeBonus)] as [string, () => string]] : []),
      [N("Moves used"), () => String(score.moves)],
      [N("Elapsed"), () => `${Math.floor(score.elapsedMs / 1000)}s`],
      [N("Invalid actions"), () => String(score.invalid)],
    ],
    cards: st.cardDefs.map((c) => ({ title: () => Loc.cardTitle(c), done: st.cards[c.id] === 1 })),
    achievements: newly, compare: () => compare(), nextLabel: nextLabel(),
  };
  if (ranked) {
    if (platform.signedIn()) {
      compare = () => S("lbPosting");
      void platform.postScore(score.total).then((r) => {
        compare = () => (!r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted"));
        if (app.results === view) live(compare());
      });
    } else {
      platform.submitLocal({
        playerId: "local-guest", name: T("Local Guest"), sessionId: s.sessionId, mode: app.mode ?? "", contentId: st.contentId, total: score.total,
        cardsDone: score.cardsDone, invalid: score.invalid, elapsedMs: score.elapsedMs, stars: score.stars, ts: Date.now(), casual: true,
      });
      const board = platform.localBoard(app.mode === "daily", st.contentId, R.compareResults);
      const rank = board.findIndex((e) => e.sessionId === s.sessionId) + 1;
      compare = () => (rank > 0 ? T("Placed #{rank} of {n} on the local board (casual — offline).", { rank, n: board.length }) : T("Score saved to the local board (casual — offline)."));
    }
  } else if (platform.options.timingAssist && s.content.ranked) compare = () => T("Timing assistance is on — this score is casual and was not submitted.");
  app.results = view;
  sound("finish");
  // Results reveal: tally, then one chime per star, then the flourishes.
  let at = 700;
  after(at, () => sound("tally"), "reveal"); at += 500;
  for (let i = 0; i < score.stars; i++) after(at + i * 420, () => sound("star"), "reveal");
  at += score.stars * 420 + (score.stars ? 300 : 0);
  newly.forEach((_, i) => after(at + i * 500, () => audio.cardSfx(), "reveal"));
  at += newly.length * 500;
  const allCards = score.cardsTotal > 0 && score.cardsDone === score.cardsTotal;
  if (allCards) after(at, () => sound(app.mode === "journey" ? "collection-complete" : "story-complete"), "reveal");
  else if (prevBest > 0 && score.total > prevBest) after(at, () => sound("record"), "reveal");
  if (firstPlayToday && p.daysPlayed.length >= 2) after(at + 200, () => sound("streak"), "reveal");
  transition("results", `score ${score.total}`);
  live(T("{headline}. Score {n}, {stars} stars. {summary}", {
    headline: T(view.headline), n: score.total, stars: score.stars,
    summary: T("{n} moments, {done} of {total} cards.", { n: score.beats, done: score.cardsDone, total: score.cardsTotal }),
  }));
}
function nextLabel(): string {
  if (app.mode === "journey") return (app.setup?.index ?? 0) + 1 < C.journeyLength() ? N("Next stage →") : N("Journey map");
  if (app.mode === "learn") {
    const i = C.LESSONS.findIndex((l) => l.id === app.lesson?.def.id);
    return i + 1 < C.LESSONS.length ? N("Next lesson →") : N("Begin the Journey →");
  }
  if (app.mode === "daily") return N("Open scrapbook");
  if (app.mode === "challenge") return N("Next challenge →");
  if (app.mode === "score") return N("New seed →");
  return N("Play again");
}
export function resultsNext(): void {
  if (app.mode === "journey") {
    const next = (app.setup?.index ?? nextJourneyIndex()) + 1;
    if (next < C.journeyLength()) { startSession({ mode: "journey", index: next }); return; }
    leaveToTitle();
    goto("journey");
    return;
  }
  if (app.mode === "learn") {
    const i = C.LESSONS.findIndex((l) => l.id === app.lesson?.def.id);
    if (i + 1 < C.LESSONS.length) { startSession({ mode: "learn", lessonId: C.LESSONS[i + 1]!.id }); return; }
    startSession({ mode: "journey", index: 0 });
    return;
  }
  if (app.mode === "daily") { leaveToTitle(); goto("scrapbook"); return; }
  if (app.mode === "challenge") {
    const i = C.CHALLENGES.findIndex((c) => c.id === app.setup?.challengeId);
    startSession({ mode: "challenge", challengeId: C.CHALLENGES[(i + 1) % C.CHALLENGES.length]!.id });
    return;
  }
  if (app.mode === "score") { startSession({ mode: "score", seed: randomSeed(10000, 89999) }); return; }
  restartSession();
}
export function replayTutorials(): void {
  const p = platform.progress();
  p.lessons = {};
  platform.saveProgress(p);
  goto("learn");
}
export function deleteScene(id: string): void { platform.deleteScene(id); sound("back"); }
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function copyInvite(): void {
  const url = platform.inviteLink();
  if (!url) return;
  try { clipboard.writeText(url); toast(S("copied"), "good"); } catch { toast(S("copyFail", { url })); }
}

// ------------------------------------------------------------------ the keyboard / gamepad cursor (ui-input.js)
interface CursorTarget { type: "slot" | "tray"; room?: string; slot?: number; item: string | null; x: number; y: number; pos: Vector3 }
let cursorTargets: CursorTarget[] = [];
let cursorIndex = -1;
function rebuildCursorTargets(): void {
  const st = app.session?.state;
  const prev = cursorTargets[cursorIndex];
  cursorTargets = [];
  if (!st || !render.hasHouse()) { cursorIndex = -1; render.setCursor(null); return; }
  const rooms = st.rooms.slice().sort((a, b) => b.gy - a.gy || a.gx - b.gx);
  for (const room of rooms) {
    room.slots.forEach((item, slot) => {
      const pos = render.slotAnchor(room.id, slot)!;
      const p = pos.clone();
      p.y += 0.75;
      cursorTargets.push({ type: "slot", room: room.id, slot, item, x: pos.x, y: room.gy, pos: p });
    });
  }
  st.tray.forEach((key, i) => {
    const pos = render.trayAnchors[i];
    if (!pos) return;
    const p = pos.clone();
    p.y += 0.75;
    cursorTargets.push({ type: "tray", item: key, x: pos.x, y: -1, pos: p });
  });
  // keep the cursor where it was (the same slot, else the same row), as the old one restarted
  if (prev && cursorIndex >= 0) {
    const same = cursorTargets.findIndex((t) => t.type === prev.type && (t.type === "tray" ? t.item === prev.item : t.room === prev.room && t.slot === prev.slot));
    cursorIndex = same;
  } else cursorIndex = -1;
  const t = cursorTargets[cursorIndex];
  render.setCursor(t && app.cursorShown ? t.pos : null);
}
function moveCursor(dir: "left" | "right" | "up" | "down"): void {
  const Tg = cursorTargets;
  if (!Tg.length) return;
  app.cursorShown = true;
  if (cursorIndex < 0) {
    const firstTray = Tg.findIndex((t) => t.type === "tray");
    cursorIndex = firstTray >= 0 ? firstTray : 0;
  } else {
    const cur = Tg[cursorIndex]!;
    if (dir === "left" || dir === "right") {
      const d = dir === "left" ? -1 : 1;
      let i = cursorIndex;
      for (let n = 0; n < Tg.length; n++) {
        i = (i + d + Tg.length) % Tg.length;
        if (Tg[i]!.y === cur.y) break;
      }
      cursorIndex = i;
    } else {
      const d = dir === "up" ? 1 : -1;
      const rows = [...new Set(Tg.map((t) => t.y))].sort((a, b) => a - b);
      const nri = rows.indexOf(cur.y) + d;
      if (nri >= 0 && nri < rows.length) {
        let best = -1, bestDx = Infinity;
        Tg.forEach((t, i) => {
          if (t.y !== rows[nri]) return;
          const dx = Math.abs(t.x - cur.x);
          if (dx < bestDx) { bestDx = dx; best = i; }
        });
        if (best >= 0) cursorIndex = best;
      }
    }
  }
  const t = Tg[cursorIndex]!;
  render.setCursor(t.pos);
  sound("cursor");
  live(cursorLabel(t));
}
function cursorLabel(t: CursorTarget): string {
  if (t.type === "tray") return T("Tray: {name}", { name: Loc.itemName(t.item!) });
  const room = R.roomById(app.session!.state, t.room!);
  return T("{room}, spot {n}: {what}", { room: Loc.roomName(room), n: t.slot! + 1, what: t.item ? Loc.itemName(t.item) : T("empty spot") });
}
function confirmCursor(): void {
  if (cursorIndex < 0) { moveCursor("right"); return; }
  const t = cursorTargets[cursorIndex];
  if (!t) return;
  if (t.item) tapPiece(t.item);
  else tapSlot({ room: t.room!, slot: t.slot! });
}
function cycleRoom(dir: number): void {
  const st = app.session?.state;
  if (!st) return;
  const rooms = st.rooms.slice().sort((a, b) => a.gx - b.gx || a.gy - b.gy);
  const cur = cursorTargets[cursorIndex];
  const ids = rooms.map((r) => r.id);
  const i = cur?.room ? ids.indexOf(cur.room) : -1;
  const next = rooms[(i + dir + rooms.length) % rooms.length]!;
  const idx = cursorTargets.findIndex((t) => t.room === next.id);
  if (idx >= 0) {
    app.cursorShown = true;
    cursorIndex = idx;
    render.setCursor(cursorTargets[idx]!.pos);
    render.focusRoom(next.id);
    sound("room-enter");
    live(cursorLabel(cursorTargets[idx]!));
  }
}

// ------------------------------------------------------------------ keys and pads (main.js keydown, ui-input.js)
export const playing = (): boolean => !!app.session && (app.phase === "active") && !app.screen && !app.pauseOpen && !app.dialog;
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (e.source === "keyboard" || e.source === "gamepad") app.cursorShown = true;
  if (app.dialog) return; // the dialog closes on its own Escape
  if (app.screen) {
    if (a === "cancel" && fresh() && app.screen !== "title") {
      if (app.screen === "results") return;
      later(() => goto("title"));
    }
    return;
  }
  if (app.pauseOpen) {
    if ((a === "cancel" || a === "pause") && fresh()) later(() => resumeGame("key"));
    return;
  }
  if (a === "pause" && (app.phase === "active" || app.phase === "paused")) { later(() => togglePause("p key")); return; }
  if (a === "cancel") {
    if (app.phase === "active" && app.selection) { later(() => setSelection(null)); return; }
    if (app.phase === "active") later(() => pauseGame("esc key"));
    return;
  }
  if (a === "mute") { later(() => platform.setOption("mute", !platform.options.mute)); return; }
  if (!playing()) return;
  switch (a) {
    case "undo": later(undo); return;
    case "hint": later(hint); return;
    case "camera": render.resetCamera(); return;
    case "interact": later(interactKey); return;
    case "roomprev": cycleRoom(-1); return;
    case "roomnext": cycleRoom(1); return;
  }
  if (ui.focused() !== null && (a === "confirm" || a === "left" || a === "right" || a === "up" || a === "down")) {
    // Enter / Space / arrows on a focused HUD button are the button's (UI focus navigation)
    if (a === "confirm") return;
    ui.setFocus(null);
  }
  if (a === "left" || a === "right" || a === "up" || a === "down") moveCursor(a);
  else if (a === "confirm") later(confirmCursor);
});

// ------------------------------------------------------------------ pointer and touch on the house (ui-input.js)
const TAP_MAX_DIST = 12, TAP_MAX_MS = 350, DRAG_MIN_DIST = 14;
interface Press { x0: number; y0: number; x: number; y: number; t0: number; hit: render.Hit; orbiting: boolean; consumed: boolean; decided: boolean }
let press: Press | null = null;
let pressPending = false;
let lastTouch = -1e9;
let releaseAt: { x: number; y: number } | null = null;
const fingers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
const dragAllowed = (): boolean => platform.options.dragMode !== "tap";
function slotFromHit(h: render.Hit): render.SlotRef | null {
  if (!h) return null;
  if (h.kind === "slot") return { room: h.room, slot: h.slot };
  const st = app.session?.state;
  if (!st) return null;
  const p = R.itemSlot(st, h.key);
  return p ? { room: p.room.id, slot: p.slot } : null; // occupied → the rules explain
}
function pointerDown(x: number, y: number): void {
  press = { x0: x, y0: y, x, y, t0: clockMs, hit: null, orbiting: false, consumed: false, decided: false };
  pressPending = true;
}
function pointerMove(x: number, y: number): void {
  const p = press;
  if (!p || p.consumed) {
    // a drag from a tray button follows the pointer over the house
    if (app.drag?.fromTray) trayDragMove(x, y);
    return;
  }
  if (!p.decided) { p.x = x; p.y = y; return; }
  const sc = frame().scale;
  const dx = x - p.x0, dy = y - p.y0;
  const dist = Math.hypot(dx, dy) / sc;
  p.x = x; p.y = y;
  if (p.orbiting) {
    if (playing()) render.orbit((-dx / sc) * 0.004, (dy / sc) * 0.003);
    p.x0 = x; p.y0 = y;
    return;
  }
  const d = app.drag;
  if (d && !d.started && dist > DRAG_MIN_DIST && dragAllowed()) {
    d.started = true;
    setSelection(d.key);
  }
  if (d?.started && playing()) dragHover(d.key, slotFromHit(render.pick(x, y)));
}
function pointerUp(x: number, y: number): void {
  if (app.drag?.fromTray) { trayDragEnd(x, y); press = null; return; }
  const p = press;
  press = null;
  if (!p || p.consumed) return;
  if (!p.decided) { releaseAt = { x, y }; press = p; return; } // decided after this frame's UI
  finishPress(p, x, y);
}
function finishPress(p: Press, x: number, y: number): void {
  const dist = Math.hypot(x - p.x0, y - p.y0) / frame().scale;
  const held = clockMs - p.t0;
  const d = app.drag;
  app.drag = null;
  if (!playing()) { if (d?.started) render.setHoverTarget(null); return; }
  const hit = render.pick(x, y);
  ui.setFocus(null);
  app.cursorShown = false;
  render.setCursor(null);
  if (d?.started) {
    const slot = slotFromHit(hit);
    if (slot) placeSelected(slot);
    else render.setHoverTarget(null);
  } else if (d && dist <= TAP_MAX_DIST && held < TAP_MAX_MS * 2) tapPiece(d.key);
  else if (hit?.kind === "slot" && dist <= TAP_MAX_DIST && held <= TAP_MAX_MS) tapSlot({ room: hit.room, slot: hit.slot });
  else if (!hit && !p.orbiting && dist <= TAP_MAX_DIST && held <= TAP_MAX_MS) setSelection(null);
  else if (!hit && dist <= TAP_MAX_DIST && held <= TAP_MAX_MS) setSelection(null);
}
/** A drag that began on a tray button (ui-input.js _onTrayPointerDown): started by screens.ts. */
export function trayDragStart(key: string, x: number, y: number): void {
  if (!canAct() || !dragAllowed() || app.drag) return;
  app.drag = { key, started: false, x0: x, y0: y, fromTray: true };
}
function trayDragMove(x: number, y: number): void {
  const d = app.drag!;
  if (!d.started) {
    if (Math.hypot(x - d.x0, y - d.y0) / frame().scale <= DRAG_MIN_DIST) return;
    d.started = true;
    setSelection(d.key);
  }
  if (playing()) dragHover(d.key, slotFromHit(render.pick(x, y)));
}
function trayDragEnd(x: number, y: number): void {
  const d = app.drag!;
  app.drag = null;
  if (!d.started) return; // a plain tap: the button's activation selects
  trayDragJustEnded = frame().frame;
  const slot = playing() ? slotFromHit(render.pick(x, y)) : null;
  if (slot) placeSelected(slot);
  else render.setHoverTarget(null);
}
/** The frame a tray drag ended (its button must not also activate). */
export let trayDragJustEnded = -1;
function endDrag(_reason: string | null): void {
  if (app.drag?.started) render.setHoverTarget(null);
  app.drag = null;
  press = null;
}
onTouch((e) => {
  lastTouch = clockMs;
  if (e.control) return;
  if (e.phase === "start" || e.phase === "move") fingers.set(e.id, { x: e.x, y: e.y });
  else fingers.delete(e.id);
  if (fingers.size >= 2) {
    // a two-finger pinch zooms the camera (never needed for play)
    const [a, b] = [...fingers.values()];
    const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y) / frame().scale;
    if (pinchDist > 0 && playing()) render.zoom((pinchDist - dist) * 0.004);
    pinchDist = dist;
    if (press) press.consumed = true;
    return;
  }
  pinchDist = 0;
  if (!e.primary) return;
  if (e.phase === "start") pointerDown(e.x, e.y);
  else if (e.phase === "move") pointerMove(e.x, e.y);
  else if (e.phase === "end") pointerUp(e.x, e.y);
  else endDrag("cancel");
});
onPointerButton((e) => {
  if (e.button !== 0 || clockMs - lastTouch < 600) return;
  if (e.pressed) pointerDown(e.x, e.y);
  else pointerUp(e.x, e.y);
});
onPointerMove((x, y) => { if (clockMs - lastTouch >= 600) pointerMove(x, y); });
onWheel((_dx, dy) => { if (playing() && !ui.pointerOver()) render.zoom(Math.sign(dy) * 0.08); });
/** Presses on the house, decided after the frame's UI is built (so ui.pointerOver() is this frame's). */
function pointerInput(wasPlaying: boolean): void {
  if (pressPending && press) {
    pressPending = false;
    const p = press;
    p.decided = true;
    if (uiPressed || ui.pointerOver() || !wasPlaying || app.drag?.fromTray) p.consumed = true;
    else {
      p.hit = render.pick(p.x0, p.y0);
      if (p.hit?.kind === "piece") app.drag = { key: p.hit.key, started: false, x0: p.x0, y0: p.y0, fromTray: false };
      else if (!p.hit) p.orbiting = true;
      if (p.x !== p.x0 || p.y !== p.y0) pointerMove(p.x, p.y);
    }
    if (releaseAt) {
      const r = releaseAt;
      releaseAt = null;
      press = null;
      if (!p.consumed) finishPress(p, r.x, r.y);
    }
  }
  uiPressed = false;
}
/** The right stick orbits the camera (ui-input.js). */
function padOrbit(): void {
  if (!playing()) return;
  for (const pad of gamepads()) {
    const rx = pad.axes[2] ?? 0, ry = pad.axes[3] ?? 0;
    if (Math.abs(rx) > 0.3 || Math.abs(ry) > 0.3) { render.orbit(-rx * 0.03, ry * 0.02); return; }
  }
}

// ------------------------------------------------------------------ the clock
let hidden = false;
let tickAcc = 0;
let autosave = 0;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += 1000 / 60;
  for (let i = 0; i < timers.length; i++) {
    const t = timers[i]!;
    if (t.at <= clockMs) { timers.splice(i--, 1); t.fn(); }
  }
  const s = app.session;
  if (s && app.phase === "active") {
    tickAcc += 1000 / 60;
    if (tickAcc >= 1000) {
      tickAcc -= 1000;
      const r = s.tickClock();
      if (r) { sound("timeout"); handleEvents(r.events); }
      else if (++autosave % 8 === 0) saveSnapshot();
    }
    if (s.state.timeLimitMs !== null && !clockWarned && s.state.timeLimitMs - s.elapsedMs() < 15000) { clockWarned = true; sound("timer-warn"); }
  }
  app.toasts = app.toasts.filter((x) => x.until >= clockMs);
  if (app.caption && app.caption.until < clockMs) app.caption = null;
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  look = lookFor(f.quality, f.levelIndex);
  render.applyLook(look);
  if (!app.session) syncBackdrop();
}
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  audio.setTheme(app.theme);
  audio.setMuted(platform.options.mute);
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  transition("title", "boot complete");
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => audio.setMuted(platform.options.mute));
platform.onProgressMerged(() => toast(T("Cloud save restored to this device.")));
onSessionEnded(() => toast(S("signedOut")));
onSuspend(() => {
  hidden = true;
  if (app.phase === "active") {
    awayAt = Date.now();
    pauseGame("backgrounded", true);
  }
  audio.setSuspended(true);
  platform.flush();
});
let awayAt: number | null = null;
onResume(() => {
  hidden = false;
  audio.setSuspended(false);
  if (app.session && app.phase === "paused" && awayAt !== null) {
    const mins = Math.round((Date.now() - awayAt) / 60000);
    toast(mins >= 1 ? T("Welcome back — paused while you were away for about {n} min. Nothing moved without you.", { n: mins })
      : T("Welcome back — paused while you were away. Nothing moved without you."));
    showPause(true);
  }
  awayAt = null;
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(platform.options.palette, ui.preferences().highContrast);
  audio.update(dt);
  padOrbit();
});
onRender(() => {
  const wasPlaying = playing();
  const f = frame();
  render.update(frameDt, f.width, f.height);
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  flushAnnouncements();
});

export type { Session };
