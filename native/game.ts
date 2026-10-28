// The browser build's pure game modules (shared with the node tests and the
// dev server), typed for this client: the rules (src/rules.js: rooms, slots,
// placements, story beats, discovery cards, scoring, hints, hashes), the
// content (src/content.js: cast, props, layouts, themes, the 45 Journey
// stages, the six lessons, the Daily, Practice, the challenges, Score Chase,
// achievements), the session (src/session.js: validated commands, undo, the
// session clock, snapshots, replay envelopes), the save documents
// (src/persist.js: settings defaults and migration, the checksummed progress
// document and its merge, the scrapbook merge), the seeded streams
// (src/rng.js) and the display names (src/loc.js).
import * as rules from "../src/rules.js";
import * as content from "../src/content.js";
import * as sessionMod from "../src/session.js";
import * as persistMod from "../src/persist.js";
import * as rngMod from "../src/rng.js";
import * as locMod from "../src/loc.js";

export type Kind = "character" | "prop";
export interface Item { kind: Kind; name: string; tags?: string[] }
export interface Room { id: string; type: string; name: string; gx: number; gy: number; slots: (string | null)[] }
export interface Beat { t: string; room: string; a: string; b: string; pts: number; sig: number; hab: number }
export interface Card { id: string; title: string; text: string; points: number; when: Record<string, unknown> & { kind?: string } }
export interface State {
  contentId: string; seed: number; tick: number; status: "active" | "terminal"; terminalReason: string | null;
  rooms: Room[]; tray: string[]; items: Record<string, Item>; beats: Beat[]; cardDefs: Card[]; cards: Record<string, number>;
  stats: { moves: number; invalid: number; interactions: number }; moveLimit: number | null; timeLimitMs: number | null;
  timeBonus: boolean; parTimeMs: number | null; par: number[]; allowUndo: boolean; ranked: boolean; elapsedMs: number;
}
export interface LayoutRoom { id: string; type: string; name: string; gx: number; gy: number; slots: number }
export interface Layout { id: string; label: string; rooms: LayoutRoom[] }
export interface Content {
  contentId: string; seed: number; mode: string; label?: string; blurb?: string; theme: string; layout: Layout;
  items: Record<string, Item>; tray: string[]; cards: Card[]; moveLimit?: number | null; timeLimitMs?: number | null;
  allowUndo?: boolean; ranked?: boolean; mastery?: boolean; par?: number[];
}
export interface Theme {
  id: string; label: string; sky: number; fog: number; hemiSky: number; hemiGround: number; key: number; keyIntensity: number;
  exposure: number; wall: number; wallSide: number; floor: number; trim: number; accent: number; ground: number; roof: number;
  music: { root: number; scale: number[]; bpm: number; bright: number }; ambience: string;
}
export interface Command { type: string; item?: string; room?: string; slot?: number; a?: string; b?: string; elapsedMs?: number }
export interface Event {
  type: string; item?: string; room?: string; slot?: number; reason?: string;
  beat?: Beat; card?: Card;
}
export interface Score {
  moments: number; discoveries: number; coverage: number; variety: number; timeBonus: number; total: number; stars: number;
  cardsDone: number; cardsTotal: number; beats: number; moves: number; invalid: number; elapsedMs: number;
}
export interface Suggestion { type: string; item?: string; room?: string; slot?: number; a?: string; b?: string; why?: string }
export interface Lesson { id: string; title: string; intro: string; steps: { text: string; require: { type: string; item?: string; roomType?: string; check?: string } }[] }
export interface Challenge { id: string; label: string }
export interface Achievement { id: string; name: string; desc: string }
export interface Chapter { title: string; names: string[] }

interface RulesApi {
  RULESET_VERSION: number; BEATS: Record<string, { label: string; prop?: string; charPair?: boolean }>; SIGNATURES: Record<string, string>;
  createGame(c: Content): State; roomById(s: State, id: string): Room | null; itemRoom(s: State, key: string): Room | null;
  itemSlot(s: State, key: string): { room: Room; slot: number } | null; itemsInRoom(s: State, roomId: string): string[];
  beatForPair(s: State, a: string, b: string): { type: string } | null; hasBeat(s: State, type: string, room: string, a: string, b: string): boolean;
  validateCommand(s: State, c: Command): { ok: boolean; reason?: string }; applyCommand(s: State, c: Command): { events: Event[] };
  listLegalActions(s: State): Suggestion[]; scoreState(s: State): Score; suggestAction(s: State): Suggestion | null;
  reasonText(code: string): string; hashState(s: State): string; compareResults(a: unknown, b: unknown): number;
}
interface ContentApi {
  CONTENT_VERSION: number; THEMES: Record<string, Theme>; THEME_ORDER: string[]; LAYOUTS: Record<string, Layout>;
  ROOM_TYPES: Record<string, { name: string }>; ALL_ITEMS: Record<string, Item>;
  PRACTICE_DIFFICULTIES: Record<string, { label: string; layout: string; chars: number; props: number; cards: unknown[]; limited?: boolean }>;
  CHALLENGES: Challenge[]; LESSONS: Lesson[]; ACHIEVEMENTS: Achievement[]; CHAPTERS_PUB: Chapter[];
  journeyStage(i: number): Content; journeyLength(): number; dailyContent(date: string): Content;
  practiceContent(difficulty: string, seed: number, theme?: string): Content; challengeContent(id: string): Content & { label: string; moveLimit?: number; timeLimitMs?: number };
  scoreChaseContent(seed: number): Content; lessonContent(id: string): Content;
}
export interface Session {
  content: Content; sessionId: string; state: State; commands: { id: string; cmd: Command; accepted: boolean }[];
  start(s: State): Session; resumeClock(): void; pauseClock(): void; elapsedMs(): number;
  submit(c: Command): { events: Event[]; accepted: boolean; reason: string | null };
  canUndo(): boolean; undo(): State | null; tickClock(): { events: Event[] } | null; score(): Score;
  replayEnvelope(v: { build: string; contentVersion: number; ruleset: number }): unknown; serializeSnapshot(): string;
  _savedAt?: number;
}
interface SessionApi {
  GameSession: { new (c: Content, opts?: { sessionId?: string }): Session; restoreSnapshot(json: string): Session | null };
  setClock(fn: () => number): void;
}
export interface Progress {
  v: number; journey: Record<string, { stars: number; score: number }>; lessons: Record<string, boolean>; cardsCollected: string[];
  beatsSeen: string[]; achievements: Record<string, number>; daysPlayed: string[]; lastDaily: { date: string; total: number } | null;
  bestScores: Record<string, number>; scenesCount: number; checksum: string;
}
export interface Scene {
  id: string; contentId: string; label: string; theme: string; date: string; savedAt: number; score: number; stars: number;
  beats: string[]; cardsDone: number; cardsTotal: number; thumbnail?: string | null; seed: number; replay?: { commands?: Command[] } | null;
}
interface PersistApi {
  defaultSettings(): Record<string, unknown>; migrateSettings(doc: unknown): Record<string, unknown>;
  defaultProgress(): Progress; migrateProgress(raw: unknown): Progress; sealProgress(p: Progress): Progress;
  verifyProgress(p: unknown): boolean; mergeProgress(a: unknown, b: unknown): Progress; mergeScenes(a: unknown, b: unknown, cap?: number): Scene[];
  PROGRESS_VERSION: number;
}
export interface Rng { next(): number; int?(a: number, b: number): number }
interface RngApi { RngStream: new (seed: number) => Rng; deriveSeed(...parts: unknown[]): number }
interface LocApi {
  itemName(k: string): string; itemKind(k: string): string; roomTypeName(t: string): string; roomName(r: Room | null): string;
  beatLabel(t: string): string; layoutLabel(l: Layout | string | null): string; themeLabel(id: string): string;
  cardTitle(c: Card): string; cardText(c: Card): string; contentLabel(c: { label?: string; contentId?: string } | null): string;
  contentBlurb(c: Content | null): string;
}

export const R = rules as unknown as RulesApi;
export const C = content as unknown as ContentApi;
export const Sessions = sessionMod as unknown as SessionApi;
export const Persist = persistMod as unknown as PersistApi;
export const Rngs = rngMod as unknown as RngApi;
export const Loc = locMod as unknown as LocApi;
