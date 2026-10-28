// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.md) per logical event, with the door creak
// layered ahead of entering a room; the synthesized cues it played where no
// clip exists (the keyboard cursor tick, the characters' voice mumbles, the
// golden signature chime and the homely shimmer on a story beat); the
// generative theme music (a slow pad chord every four beats, a seeded
// melody walk on the even beats) with its adaptive layers (the odd-beat
// melody notes and the sparkle stem rise with the discovery cards done); and
// the quiet ambience bed per theme (birds, hearth, waves, crickets, wind:
// filtered noise with a slow sweep and its sparse chirps or crackles).
//
// A live synthesis graph on the web makes clip loads fail (port lessons), so
// everything synthesized is rendered once into clips (sine tables, a slice a
// frame) and played as clips: the music as a 16-beat loop per theme in three
// stems started together, whose layer gains follow the progress; the
// ambience as a 10-second loop (whole sweep cycles, a crossfaded seam). The
// runtime has three buses: music and the ambience play on music (the
// ambience at the old ambience-to-music volume ratio), effects and the voice
// mumbles on effects (the voice at the old voice-to-effects ratio); the
// runtime's Options own the volumes and the mute; the game's M key mutes the
// game's sounds as the old Mute did. Captions for meaningful audio go to
// main.ts (its captions line). Clips load once the mixer runs (natively at
// once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { Rngs, type Theme } from "./game.ts";

/** audio.js SAMPLE_FILES. */
const SAMPLE_FILES: Record<string, string> = {
  click: "ui-click", hover: "ui-hover", confirm: "ui-confirm", back: "ui-back",
  invalid: "ui-error", card: "ui-success", open: "ui-modal-open", toggle: "ui-toggle",
  pickup: "item-pickup", place: "item-place", remove: "item-pickup",
  interact: "interact-play", finish: "scene-save", tab: "ui-tab-switch",
  scroll: "ui-scroll-tick", slider: "ui-slider-drag", close: "ui-panel-close",
  toast: "ui-toast", pause: "ui-pause", resume: "ui-resume",
  countdown: "ui-countdown-tick", "settings-saved": "ui-settings-saved",
  "room-enter": "room-enter", drag: "item-drag", "story-complete": "story-complete",
  tutorial: "tutorial-step", undo: "undo-action", hint: "hint-reveal",
  go: "challenge-start", "timer-warn": "timer-warning", timeout: "challenge-fail",
  "collection-complete": "collection-complete", star: "star-earn",
  record: "new-record", streak: "streak-keep", tally: "results-tally",
};
const SAMPLE_LAYERS: Record<string, string[]> = { "room-enter": ["door-creak"] };
/** audio.js SAMPLE_CAPTIONS (English keys, translated by main.ts). */
const SAMPLE_CAPTIONS: Record<string, string> = {
  invalid: "low knock — that move is not allowed",
  timeout: "a descending phrase — time is up",
  finish: "a warm music-box phrase — the scene is saved",
};
const AMBIENCE_GAIN = Math.pow(0.55, 2) / Math.pow(0.7, 2);
const VOICE_GAIN = Math.pow(0.65, 2) / Math.pow(0.8, 2);

let captionHook: (key: string) => void = () => undefined;
export function onCaption(fn: (key: string) => void): void { captionHook = fn; }
let muted = false;
let suspended = false;
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

// --- the clock for cues played later in a phrase (the engine's play has no delay) --------------------
let now = 0;
const later: { at: number; fn: () => void }[] = [];
function at(delay: number, fn: () => void): void { if (delay <= 0) fn(); else later.push({ at: now + delay, fn }); }

function playNamed(file: string, gain = 1): boolean {
  const clip = clips.get(file);
  if (!clip) return false;
  try { playClip(clip, { bus: "effects", gain }); return true; } catch { clips.delete(file); if (!queue.includes(file)) queue.push(file); return false; }
}
/** The sample(s) for a logical event; false when none are ready. */
function playSample(name: string, delay = 0): boolean {
  const files = [SAMPLE_FILES[name], ...(SAMPLE_LAYERS[name] ?? [])].filter((f): f is string => !!f);
  let ok = false;
  files.forEach((f, i) => { if (clips.has(f)) { ok = true; at(delay + i * 0.12, () => { playNamed(f); }); } });
  return ok;
}
const silent = (): boolean => muted || suspended;

/** UI + rules event sounds (audio.js sfx). */
export function sfx(name: string, delay = 0): void {
  if (silent()) return;
  if (playSample(name, delay)) { if (SAMPLE_CAPTIONS[name]) captionHook(SAMPLE_CAPTIONS[name]!); return; }
  if (name === "cursor") at(delay, () => playSynth("cursor", 1));
}
/** A story beat: the interaction clip, the signature chime, the homely shimmer (audio.js beatSfx). */
export function beatSfx(sig: boolean, hab: boolean): void {
  if (silent()) return;
  playSample("interact");
  if (sig) { at(0.15, () => playSynth("sig", 1)); captionHook("a golden signature chime"); }
  if (hab) at(0.1, () => playSynth("hab", 1));
}
export function cardSfx(): void {
  if (silent()) return;
  playSample("card");
  captionHook("a discovery card completes");
}
/** Character voice mumbles on the voice bus (audio.js voiceBlip), two or three syllables. */
export function voiceBlip(character: string, r: { next(): number } | null = null): void {
  if (silent()) return;
  const syll = 2 + (((r ? r.next() : Math.random()) * 2) | 0);
  playSynth(`voice-${character}-${syll}`, VOICE_GAIN);
}

// --- synthesis into clips -----------------------------------------------------------------------
const RATE = 22050;
const TABLE = 4096;
const SINE = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SINE[i] = Math.sin((i / TABLE) * Math.PI * 2);
type Wave = "sine" | "triangle";
interface Note {
  t0: number; freq: number; wave: Wave; peak: number;
  /** "exp": linear attack a, exponential decay to 0.0004 over d (audio.js _env); "pad": linear 0 → peak at a, → 0 at d. */
  env: "exp" | "pad"; a: number; d: number; slide?: number; noise?: { kind: "highpass"; f0: number };
}
/** Renders notes into a buffer of `len` samples, wrapping past the end (seamless loops); resumable by note. */
class Job {
  buf: Float32Array;
  private i = 0;
  private noiseState = 0x1234567;
  done = false;
  constructor(readonly notes: Note[], len: number, readonly wrap: boolean) { this.buf = new Float32Array(len); }
  /** Renders up to `budget` samples' worth of notes; true when finished. */
  step(budget: number): boolean {
    let spent = 0;
    while (this.i < this.notes.length && spent < budget) spent += this.render(this.notes[this.i++]!);
    this.done = this.i >= this.notes.length;
    return this.done;
  }
  private render(n: Note): number {
    const len = this.buf.length;
    const s0 = Math.round(n.t0 * RATE);
    const total = Math.round((n.env === "exp" ? n.a + n.d : n.d) * RATE);
    let phase = 0;
    const k = Math.log(0.0004 / n.peak);
    let hp = 0, prev = 0;
    for (let j = 0; j < total; j++) {
      const t = j / RATE;
      let g: number;
      if (n.env === "pad") g = t < n.a ? (n.peak * t) / n.a : n.peak * Math.max(0, 1 - (t - n.a) / (n.d - n.a));
      else g = t < n.a ? (n.peak * t) / n.a : n.peak * Math.exp((k * (t - n.a)) / n.d);
      let v: number;
      if (n.noise) {
        this.noiseState = (this.noiseState * 1664525 + 1013904223) >>> 0;
        const x = this.noiseState / 2147483648 - 1;
        const rc = 1 / (2 * Math.PI * n.noise.f0), dt = 1 / RATE, al = rc / (rc + dt);
        hp = al * (hp + x - prev);
        prev = x;
        v = hp;
      } else {
        const f = n.slide ? n.freq * Math.pow((Math.max(30, n.freq + n.slide)) / n.freq, Math.min(1, t / (n.a + n.d))) : n.freq;
        phase += f / RATE;
        phase -= Math.floor(phase);
        if (n.wave === "sine") v = SINE[(phase * TABLE) | 0]!;
        else v = 4 * Math.abs(phase - 0.5) - 1;
      }
      let idx = s0 + j;
      if (idx >= len) { if (!this.wrap) break; idx %= len; }
      this.buf[idx] = this.buf[idx]! + v * g;
    }
    return total;
  }
}
const jobs: { name: string; job: Job; then: (clip: AudioClip) => void }[] = [];
const synth = new Map<string, AudioClip>();
function want(name: string, notes: Note[], seconds: number, wrap: boolean, then: (clip: AudioClip) => void = (c) => { synth.set(name, c); }): void {
  if (jobs.some((j) => j.name === name)) return;
  jobs.push({ name, job: new Job(notes, Math.ceil(seconds * RATE), wrap), then });
}
function playSynth(name: string, gain: number): void {
  const clip = synth.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: "effects", gain }); } catch { synth.delete(name); }
}
const blip = (t0: number, freq: number, o: { wave?: Wave; a?: number; d?: number; peak?: number; slide?: number }): Note =>
  ({ t0, freq, wave: o.wave ?? "sine", env: "exp", a: o.a ?? 0.004, d: o.d ?? 0.18, peak: o.peak ?? 0.5, slide: o.slide });
function wantCues(): void {
  want("cursor", [blip(0, 980, { d: 0.04, peak: 0.12 })], 0.1, false);
  want("sig", [1046, 1318, 1568].map((f, i) => blip(i * 0.07, f, { d: 0.5, peak: 0.2 })), 0.8, false);
  want("hab", [{ t0: 0, freq: 0, wave: "sine", env: "exp", a: 0.003, d: 0.3, peak: 0.08, noise: { kind: "highpass", f0: 2400 } }], 0.4, false);
  const pitch: Record<string, number> = { pip: 520, mabel: 380, otto: 240, luna: 440, biscuit: 620 };
  for (const [ch, p] of Object.entries(pitch)) {
    for (const syll of [2, 3]) {
      const notes: Note[] = [];
      for (let i = 0; i < syll; i++) {
        const f = p * (1 + (i % 2) * 0.12);
        notes.push(blip(i * 0.1, f, { wave: "triangle", d: 0.09, peak: 0.2, slide: i % 2 ? -40 : 50 }));
        notes.push(blip(i * 0.1, f * 2.4, { d: 0.07, peak: 0.08 }));
      }
      want(`voice-${ch}-${syll}`, notes, 0.1 * syll + 0.2, false);
    }
  }
}

// --- the theme music (audio.js startMusic / _scheduleBeat), rendered as a loop -----------------------
const LOOP_BEATS = 16;
interface MusicSet { theme: string; base?: AudioClip; busy?: AudioClip; sparkle?: AudioClip; voices: Sound[] }
let music: MusicSet | null = null;
let musicTheme: Theme | null = null;
let intensity = 0;
let musicWanted = false;
function musicNotes(th: Theme): { base: Note[]; busy: Note[]; sparkle: Note[]; seconds: number } {
  const m = th.music;
  const beatLen = 60 / m.bpm;
  const scale = m.scale;
  const deg = (i: number): number => m.root * Math.pow(2, scale[i % scale.length]! / 12) * (i >= scale.length ? 2 : 1);
  const rng = new Rngs.RngStream(Rngs.deriveSeed("music", th.id));
  const base: Note[] = [], busy: Note[] = [], sparkle: Note[] = [];
  let mel = 2;
  for (let beat = 0; beat < LOOP_BEATS; beat++) {
    const t0 = beat * beatLen;
    if (beat % 4 === 0) {
      for (const i of [0, 2, 4]) {
        const d = (i + ((beat / 4) % 2 ? 1 : 0)) % scale.length;
        base.push({ t0, freq: deg(d) / 2, wave: "sine", env: "pad", a: beatLen * 1.5, d: beatLen * 4.2, peak: 0.06 });
        base.push({ t0, freq: (deg(d) / 2) * 1.003, wave: "triangle", env: "pad", a: beatLen * 1.5, d: beatLen * 4.2, peak: 0.06 });
      }
    }
    // the melody walk: every even beat, odd beats as the progress rises (the busy stem)
    const even = beat % 2 === 0;
    const extra = rng.next() < 0.7;
    if (even || extra) {
      mel = Math.max(0, Math.min(scale.length + 3, mel + (rng.next() < 0.5 ? -1 : 1) * (rng.next() < 0.3 ? 2 : 1)));
      const note: Note = { t0, freq: deg(mel) * (m.bright > 0.9 ? 2 : 1), wave: "sine", env: "exp", a: 0.01, d: beatLen * 1.8, peak: 0.11 };
      (even ? base : busy).push(note);
    }
    if (beat % 8 === 6) sparkle.push({ t0, freq: deg(Math.floor(rng.next() * scale.length)) * 4, wave: "sine", env: "exp", a: 0.005, d: beatLen * 2.5, peak: 0.05 });
  }
  return { base, busy, sparkle, seconds: LOOP_BEATS * beatLen };
}
/** The music for a theme (audio.js setTheme + startMusic). */
export function setTheme(th: Theme): void {
  musicTheme = th;
  musicWanted = true;
  if (music && music.theme === th.id) return;
  stopMusic();
}
function stopMusic(): void {
  if (!music) return;
  for (const v of music.voices) { try { v.stop(); } catch { /* gone */ } }
  for (const c of [music.base, music.busy, music.sparkle]) { try { c?.dispose(); } catch { /* gone */ } }
  music = null;
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i]!.name.startsWith("music-")) jobs.splice(i, 1);
}
/** Adaptive music follows progress (0 … 1). */
export function setMusicIntensity(x: number): void {
  intensity = Math.max(0, Math.min(1, x));
  if (music?.voices.length === 3) {
    try { music.voices[1]!.fade(silent() ? 0 : intensity, 0.8); music.voices[2]!.fade(silent() ? 0 : (intensity > 0.4 ? intensity : 0), 0.8); } catch { /* gone */ }
  }
}

// --- the ambience bed (audio.js startAmbience), rendered as a 10 s loop ------------------------------
const AMB_SECONDS = 10, FADE = 0.25;
let ambience: { kind: string; clip?: AudioClip; voice?: Sound } | null = null;
let ambJob: { kind: string; buf: Float32Array; i: number; st: number[]; rng: number } | null = null;
const AMB: Record<string, { type: "lowpass" | "highpass" | "bandpass"; f0: number; gain: number; lfoF: number; lfoD: number }> = {
  birds: { type: "lowpass", f0: 500, gain: 0.05, lfoF: 0.1, lfoD: 60 },
  hearth: { type: "lowpass", f0: 320, gain: 0.09, lfoF: 0.5, lfoD: 40 },
  waves: { type: "lowpass", f0: 420, gain: 0.08, lfoF: 0.08, lfoD: 220 },
  crickets: { type: "highpass", f0: 3800, gain: 0.012, lfoF: 11, lfoD: 800 },
  wind: { type: "bandpass", f0: 600, gain: 0.06, lfoF: 0.07, lfoD: 300 },
};
function stepAmbience(budget: number): boolean {
  const j = ambJob!;
  const cfg = AMB[j.kind] ?? AMB.birds!;
  const n = j.buf.length;
  const lfoF = Math.max(1, Math.round(cfg.lfoF * AMB_SECONDS)) / AMB_SECONDS;
  const end = Math.min(n, j.i + budget);
  let [x1, x2, y1, y2] = j.st as [number, number, number, number];
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  for (; j.i < end; j.i++) {
    if ((j.i & 63) === 0) {
      const f = Math.max(40, cfg.f0 + Math.sin(2 * Math.PI * lfoF * (j.i / RATE)) * cfg.lfoD);
      const w = (2 * Math.PI * Math.min(f, RATE * 0.45)) / RATE, cs = Math.cos(w), al = Math.sin(w) / (2 * 0.6);
      const a0 = 1 + al;
      if (cfg.type === "lowpass") { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
      else if (cfg.type === "highpass") { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
      else { b0 = al; b1 = 0; b2 = -al; }
      b0 /= a0; b1 /= a0; b2 /= a0; a1 = (-2 * cs) / a0; a2 = (1 - al) / a0;
    }
    j.rng = (j.rng * 1664525 + 1013904223) >>> 0;
    const x = j.rng / 2147483648 - 1;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    j.buf[j.i] = y * cfg.gain;
  }
  j.st = [x1, x2, y1, y2];
  return j.i >= n;
}
/** The ambience's sparse events (birds' chirps, the hearth's crackles, crickets) baked into the loop. */
function ambienceEvents(kind: string): Note[] {
  const out: Note[] = [];
  let s = 0x2468ace;
  const r = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let t = 0.7; t < AMB_SECONDS - 0.5; t += 1.4) {
    const p = r();
    if (kind === "birds" && p < 0.5) {
      const f0 = 2200 + r() * 1400;
      out.push(blip(t, f0, { d: 0.09, peak: 0.05, slide: 500 }), blip(t + 0.12, f0 * 1.2, { d: 0.07, peak: 0.04, slide: -300 }));
    } else if (kind === "hearth" && p < 0.7) {
      out.push({ t0: t, freq: 0, wave: "sine", env: "exp", a: 0.003, d: 0.03, peak: 0.05, noise: { kind: "highpass", f0: 900 + r() * 1200 } });
    } else if (kind === "crickets" && p < 0.4) out.push(blip(t, 4200, { d: 0.05, peak: 0.02 }));
  }
  return out;
}
function startAmbienceFor(kind: string): void {
  if (ambience?.kind === kind) return;
  if (ambience) { try { ambience.voice?.stop(); ambience.clip?.dispose(); } catch { /* gone */ } }
  ambience = { kind };
  ambJob = { kind, buf: new Float32Array(Math.ceil((AMB_SECONDS + FADE) * RATE)), i: 0, st: [0, 0, 0, 0], rng: 0x9e3779b9 };
}

/** A hidden window silences the game (audio.js suspend); a pause keeps the music, as before. */
export function setSuspended(on: boolean): void { if (on !== suspended) { suspended = on; applyGains(); } }
/** The game's M key (audio.js setMuted). */
export function setMuted(on: boolean): void { if (on !== muted) { muted = on; applyGains(); } }
function applyGains(): void {
  const off = silent();
  try {
    if (music?.voices.length === 3) {
      music.voices[0]!.fade(off ? 0 : 1, 0.2);
      music.voices[1]!.fade(off ? 0 : intensity, 0.2);
      music.voices[2]!.fade(off ? 0 : (intensity > 0.4 ? intensity : 0), 0.2);
    }
    ambience?.voice?.fade(off ? 0 : AMBIENCE_GAIN, 0.2);
  } catch { /* gone */ }
}

let cuesWanted = false;
/** Each frame: due cues, the clips once the mixer runs (one at a time), then a slice of synthesis. */
export function update(dt: number): void {
  now += dt;
  for (let i = later.length - 1; i >= 0; i--) {
    if (later[i]!.at <= now) { const f = later[i]!.fn; later.splice(i, 1); if (!silent()) f(); }
  }
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const f of [...Object.values(SAMPLE_FILES), ...Object.values(SAMPLE_LAYERS).flat()]) if (!queue.includes(f) && !clips.has(f)) queue.push(f);
  }
  if (!cuesWanted) { cuesWanted = true; wantCues(); }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
    return;
  }
  // the theme's music
  if (musicWanted && musicTheme && !music) {
    const th = musicTheme;
    const set: MusicSet = { theme: th.id, voices: [] };
    music = set;
    const notes = musicNotes(th);
    want("music-base", notes.base, notes.seconds, true, (c) => { set.base = c; });
    want("music-busy", notes.busy, notes.seconds, true, (c) => { set.busy = c; });
    want("music-sparkle", notes.sparkle, notes.seconds, true, (c) => { set.sparkle = c; });
  }
  if (music && music.base && music.busy && music.sparkle && !music.voices.length) {
    try {
      const off = silent();
      music.voices = [
        playClip(music.base, { bus: "music", loop: true, gain: off ? 0 : 1 }),
        playClip(music.busy, { bus: "music", loop: true, gain: off ? 0 : intensity }),
        playClip(music.sparkle, { bus: "music", loop: true, gain: off ? 0 : (intensity > 0.4 ? intensity : 0) }),
      ];
    } catch (e) { console.warn(`music: ${String(e)}`); music.voices = []; }
  }
  // the ambience
  if (musicTheme) startAmbienceFor(musicTheme.ambience);
  let budget = 24000;
  if (ambJob && ambience && !ambience.clip) {
    if (stepAmbience(budget)) {
      const j = ambJob;
      const ev = new Job(ambienceEvents(j.kind), j.buf.length, true);
      ev.step(1e9);
      const n = Math.round(AMB_SECONDS * RATE), f = Math.round(FADE * RATE);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = j.buf[i]! + ev.buf[i]!;
      for (let i = 0; i < f; i++) { const k = i / f; out[i] = out[i]! * k + (j.buf[n + i]! + ev.buf[n + i]!) * (1 - k); }
      try {
        ambience.clip = createClip([out], RATE);
        ambience.voice = playClip(ambience.clip, { bus: "music", loop: true, gain: silent() ? 0 : AMBIENCE_GAIN });
      } catch (e) { console.warn(`ambience: ${String(e)}`); }
      ambJob = null;
    }
    return;
  }
  while (jobs.length && budget > 0) {
    const j = jobs[0]!;
    const before = budget;
    if (j.job.step(budget)) {
      jobs.shift();
      try { j.then(createClip([j.job.buf], RATE)); } catch (e) { console.warn(`audio ${j.name}: ${String(e)}`); }
    }
    budget -= Math.max(1, before === budget ? before : 8000);
    break;
  }
}
