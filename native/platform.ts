// The game's data and the StarHermit platform, on the runtime's modules (what
// src/platform.js did over the JS SDK and localStorage):
// - the save (starhermit:storage `saves`, schema 1: on the device and in the
//   player's cloud slot) is the document the browser build kept in its cloud
//   slot: { v: 2, progress, scenes } — the checksummed progress
//   (src/persist.js) and the scrapbook of saved scenes. Two devices' saves
//   merge on a conflict (mergeProgress / mergeScenes, as the browser build did
//   on its saveconflict); the slot the browser build wrote through the JS SDK
//   (game:<slug>) shows as foreign: it is merged in and replaced once. Scene
//   thumbnails stay 168×112 PNG data URLs (the old ones show as they were);
// - the paused story "Continue" resumes, the casual local leaderboard and the
//   consent-gated usage counts stay in the device's key/value storage, as
//   localStorage kept them before (only on this device);
// - the game's own options (captions, colour palette, left-handed layout,
//   placement style, timing assistance, haptics, game-sound mute, usage
//   counts) are engine `settings` (synced with the account); the browser
//   build's values in the account's settings KV are adopted (unless set here
//   since), then all its KV keys are removed (volumes, graphics, reduced
//   motion, contrast, larger text, language and the key bindings are the
//   runtime's Options now);
// - the player, the invite link, the platform's clock for the Daily, posting a
//   ranked story's total through score-script.js (a practice session whose
//   socket carries { type: 'result', scores }, as the JS SDK's submitScores
//   did) and the rank on the high-score board.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { Persist, type Progress, type Scene } from "./game.ts";

// --- the save ---------------------------------------------------------------------------------
export interface SaveDoc { v: 2; progress: Progress; scenes: Scene[] }
const SCENE_CAP = 30;
let progressDoc: Progress = Persist.sealProgress(Persist.defaultProgress());
let sceneList: Scene[] = [];
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** A stored scene with a picture only when it is a small PNG data URL (what render.js and render.ts make). */
function cleanScene(s: Scene): Scene {
  if (!s || typeof s !== "object") return s;
  const t = s.thumbnail;
  if (t == null || (typeof t === "string" && t.startsWith("data:image/png;base64,") && t.length < 400_000)) return s;
  const { thumbnail: _t, ...rest } = s;
  void _t;
  return rest as Scene;
}
/** Any document the game ever saved ({v:2, progress, scenes}, or a bare v1 progress doc) → a clean SaveDoc, or null. */
export function readDoc(raw: unknown): SaveDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as { v?: number; progress?: unknown; scenes?: unknown };
  let progress: Progress | null = null, scenes: Scene[] = [];
  if (d.v === 2) {
    progress = Persist.verifyProgress(d.progress) ? d.progress as Progress : (d.progress ? Persist.migrateProgress(d.progress) : null);
    scenes = Array.isArray(d.scenes) ? (d.scenes as Scene[]).filter((s) => s && typeof s === "object" && s.id).map(cleanScene) : [];
  } else if (Persist.verifyProgress(raw)) progress = raw as Progress;
  else return null;
  return { v: 2, progress: progress ?? Persist.sealProgress(Persist.defaultProgress()), scenes: Persist.mergeScenes(scenes, [], SCENE_CAP) };
}
/** Two documents merged (neither side's progress or scenes dropped). */
export function mergeDocs(a: SaveDoc | null, b: SaveDoc | null): SaveDoc {
  return {
    v: 2,
    progress: Persist.sealProgress(Persist.mergeProgress(a?.progress ?? null, b?.progress ?? null)),
    scenes: Persist.mergeScenes(a?.scenes ?? [], b?.scenes ?? [], SCENE_CAP),
  };
}
/** A document's content as canonical JSON (key order and timestamps of the save do not matter). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
const current = (): SaveDoc => ({ v: 2, progress: progressDoc, scenes: sceneList });
function write(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(current() as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
function adopt(other: SaveDoc | null): boolean {
  if (!other) return false;
  const next = mergeDocs(other, current());
  if (canonical(next) === canonical(current())) return false;
  progressDoc = next.progress;
  sceneList = next.scenes;
  write();
  return true;
}
saves.onConflict((mine, remote) => ({ merged: mergeDocs(readDoc(remote.data), readDoc(mine?.data ?? null)) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(readDoc(cur.data))) merged();
  }
});
/** The browser build's cloud slot: merged with this device's save, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  let doc: SaveDoc | null = null;
  try { doc = old.text != null ? readDoc(JSON.parse(old.text)) : null; } catch { doc = null; }
  let grew = false;
  if (doc) {
    const next = mergeDocs(doc, current());
    grew = canonical(next) !== canonical(current());
    progressDoc = next.progress;
    sceneList = next.scenes;
  }
  write({ replaceForeign: true });
  if (grew) merged();
}

/** The live progress (change it, then saveProgress()). */
export function progress(): Progress { return progressDoc; }
/** Seals and saves the progress (the device at once, the account debounced by the runtime). */
export function saveProgress(p: Progress): Progress {
  progressDoc = Persist.sealProgress(p);
  write();
  return progressDoc;
}
export function scenes(): Scene[] { return sceneList; }
/** platform.js saveScene: newest first, at most 30. */
export function saveScene(scene: Scene): void {
  sceneList = [cleanScene(scene), ...sceneList.filter((s) => s.id !== scene.id)].slice(0, SCENE_CAP);
  write();
}
export function deleteScene(id: string): void {
  sceneList = sceneList.filter((s) => s.id !== id);
  write();
}
/** Settings › Erase local progress: progress and scenes reset (here and, signed in, in the cloud), the device's keys removed. */
export function eraseAll(): void {
  progressDoc = Persist.sealProgress(Persist.defaultProgress());
  sceneList = [];
  write();
  for (const k of [SNAPSHOT, BOARDS, TELEMETRY]) deviceKV.removeItem(k);
}

/** The sync line: "local" for a guest, else connecting / saving / synced / error (platform.js syncLabel). */
export function syncState(): "local" | "connecting" | "saving" | "synced" | "error" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading") return "connecting";
  if (st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the device's key/value storage ------------------------------------------------------------
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const deviceKV: KV = {
  getItem: (k) => { try { return storage.getText(k); } catch { return null; } },
  setItem: (k, v) => { try { storage.set(k, String(v)); } catch (e) { console.warn(`storage: ${String(e)}`); } },
  removeItem: (k) => { try { storage.remove(k); } catch { /* gone */ } },
};
const SNAPSHOT = "storyhouse.snapshot.v1", BOARDS = "storyhouse.boards.v1", TELEMETRY = "storyhouse.telemetry.v1";
export function saveSnapshot(json: string): void { deviceKV.setItem(SNAPSHOT, json); }
export function loadSnapshot(): string | null { return deviceKV.getItem(SNAPSHOT); }
export function clearSnapshot(): void { deviceKV.removeItem(SNAPSHOT); }

export interface BoardEntry {
  playerId: string; name: string; sessionId: string; mode: string; contentId: string; total: number; cardsDone: number;
  invalid: number; elapsedMs: number; stars: number; ts: number; casual: true;
}
function loadBoards(): BoardEntry[] {
  try { const b = JSON.parse(deviceKV.getItem(BOARDS) || "[]") as unknown; return Array.isArray(b) ? b as BoardEntry[] : []; } catch { return []; }
}
/** platform.js submitScore: a ranked story kept on this device's casual board (500 at most). */
export function submitLocal(entry: BoardEntry): void {
  const boards = loadBoards();
  boards.push(entry);
  while (boards.length > 500) boards.shift();
  deviceKV.setItem(BOARDS, JSON.stringify(boards));
}
/** platform.js leaderboard (local): today's Daily or the content's entries, best first (compareResults). */
export function localBoard(daily: boolean, contentId: string, compare: (a: unknown, b: unknown) => number): BoardEntry[] {
  const entries = loadBoards().filter((e) => e.contentId === contentId);
  void daily;
  return entries.sort(compare).slice(0, 100);
}
/** platform.js telemetry: anonymous aggregate funnel counts, consent-gated, kept on this device only. */
export function telemetry(event: string): void {
  if (!options.telemetry || !["start", "tutorial-step", "round-end", "retry", "settings-change", "error"].includes(event)) return;
  try {
    const agg = JSON.parse(deviceKV.getItem(TELEMETRY) || "{}") as Record<string, number>;
    agg[event] = (agg[event] || 0) + 1;
    deviceKV.setItem(TELEMETRY, JSON.stringify(agg));
  } catch { /* skip */ }
}

// --- the game's options -----------------------------------------------------------------------
export type Palette = "default" | "protan" | "deutan" | "tritan";
export type DragMode = "both" | "tap" | "drag";
export interface Options {
  captions: boolean; palette: Palette; lefty: boolean; dragMode: DragMode; timingAssist: boolean;
  hapticsOff: boolean; mute: boolean; telemetry: boolean;
}
export const DEFAULT_OPTIONS: Options = {
  captions: false, palette: "default", lefty: false, dragMode: "both", timingAssist: false, hapticsOff: false, mute: false, telemetry: false,
};
const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS) as (keyof Options)[];
const PALETTES: Palette[] = ["default", "protan", "deutan", "tritan"];
const DRAG_MODES: DragMode[] = ["both", "tap", "drag"];
/** A stored value for an option, or undefined when it is not one. */
export function pickOption(key: keyof Options, v: unknown): Options[keyof Options] | undefined {
  if (key === "palette") return PALETTES.includes(v as Palette) ? v as Palette : undefined;
  if (key === "dragMode") return DRAG_MODES.includes(v as DragMode) ? v as DragMode : undefined;
  return typeof v === "boolean" ? v : undefined;
}
export const options: Options = { ...DEFAULT_OPTIONS };
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function readOption(key: keyof Options): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = pickOption(key, v);
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends keyof Options>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
  telemetry("settings-change");
}
/** The browser build's settings KV keys (platform.js PREF_KEYS). */
export const LEGACY_KEYS = ["music", "effects", "ambience", "voice", "mute", "captions", "gfx", "reducedMotion", "highContrast", "largeText",
  "palette", "lefty", "dragMode", "timingAssist", "hapticsOff", "tutorialsDone", "gamepad"];
/** The old KV's values this game keeps as options. */
export function legacyOptions(kv: Record<string, unknown>): Partial<Options> {
  const out: Partial<Options> = {};
  for (const k of OPTION_KEYS) {
    if (!(k in kv)) continue;
    const v = pickOption(k, kv[k]);
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const kv: Record<string, unknown> = {};
  for (const key of keys) kv[key] = store.legacy(key);
  for (const [k, v] of Object.entries(legacyOptions(kv))) {
    try {
      if (store.get(k) !== undefined) continue;
      store.set(k, v as JsonValue);
      (options as unknown as Record<string, unknown>)[k] = v;
    } catch { /* keep the device's */ }
  }
  for (const key of keys) if (LEGACY_KEYS.includes(key) || key.startsWith("ui.")) store.removeLegacy(key);
  optionsChanged();
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const doc = readDoc(cur?.data ?? null);
  if (doc) { progressDoc = doc.progress; sceneList = doc.scenes; }
  for (const k of OPTION_KEYS) readOption(k);
  store.onChange((key) => {
    if (!(OPTION_KEYS as string[]).includes(key)) return;
    readOption(key as keyof Options);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().then(() => undefined, () => undefined);
}

// --- the player and the clock -----------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });

/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's UTC day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
export function utcToday(): string { return new Date(nowMs()).toISOString().slice(0, 10); }
export function msToNextDaily(): number {
  const n = new Date(nowMs());
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime();
}

// --- the high-score board ---------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a ranked story's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
