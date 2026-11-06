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
// Everything synthesized is rendered once into clips (OfflineAudioContext) and
// played as clips: the music as a 16-beat loop per theme in three stems started
// together, whose layer gains follow the progress; the ambience as a 10-second
// loop (whole sweep cycles over a 10 s noise loop: periodic, no seam). The
// runtime has three buses: music and the ambience play on music (the ambience
// at the old ambience-to-music volume ratio), effects and the voice mumbles on
// effects (the voice at the old voice-to-effects ratio); the runtime's Options
// own the volumes and the mute; the game's M key is the engine's game mute.
// Captions for meaningful audio go to main.ts (its captions line). Clips load
// and renders start at once; the beds start once the mixer runs (in a browser,
// after the first press).
import { nextFrame } from "starhermit:engine";
import { OfflineAudioContext, context, createClip, isMuted, loadClip, play as playClip, setMuted as muteGame, type AudioClip, type Sound } from "starhermit:audio";
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
let suspended = false;
const clips = new Map<string, AudioClip>();
/** Loads every clip and renders the cues at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const f of new Set([...Object.values(SAMPLE_FILES), ...Object.values(SAMPLE_LAYERS).flat()])) {
    loadClip(`sfx/${f}.opus`).then((c) => { clips.set(f, c); }, (e: unknown) => console.warn(`sfx ${f}: ${e instanceof Error ? e.message : String(e)}`));
  }
  void renderCues();
}

// --- the clock for cues played later in a phrase (the engine's play has no delay) --------------------
let now = 0;
const later: { at: number; fn: () => void }[] = [];
function at(delay: number, fn: () => void): void { if (delay <= 0) fn(); else later.push({ at: now + delay, fn }); }

function playNamed(file: string, gain = 1): boolean {
  const clip = clips.get(file);
  if (!clip) return false;
  try { playClip(clip, { bus: "effects", gain }); return true; } catch { return false; /* the mixer is full this frame */ }
}
/** The sample(s) for a logical event; false when none are ready. */
function playSample(name: string, delay = 0): boolean {
  const files = [SAMPLE_FILES[name], ...(SAMPLE_LAYERS[name] ?? [])].filter((f): f is string => !!f);
  let ok = false;
  files.forEach((f, i) => { if (clips.has(f)) { ok = true; at(delay + i * 0.12, () => { playNamed(f); }); } });
  return ok;
}
const silent = (): boolean => isMuted() || suspended;

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
type Wave = "sine" | "triangle";
interface Note {
  t0: number; freq: number; wave: Wave; peak: number;
  /** "exp": linear attack a, exponential decay to 0.0004 over d (audio.js _env); "pad": linear 0 → peak at a, → 0 at d. */
  env: "exp" | "pad"; a: number; d: number; slide?: number; noise?: { kind: "highpass"; f0: number };
}
const NOISE_TRIM = 0.77; // a biquad high-pass passes more than audio.js's one-pole: back to the old rms
const noteEnd = (n: Note): number => n.t0 + (n.env === "exp" ? n.a + n.d : n.d);
function schedule(off: OfflineAudioContext, n: Note, seed: number): void {
  const end = noteEnd(n);
  const g = off.createGain();
  g.gain.setValueAtTime(0, n.t0);
  g.gain.linearRampToValueAtTime(n.peak * (n.noise ? NOISE_TRIM : 1), n.t0 + n.a);
  if (n.env === "exp") g.gain.exponentialRampToValueAtTime(0.0004, end); else g.gain.linearRampToValueAtTime(0, end);
  g.connect(off.destination);
  if (n.noise) {
    const src = off.createNoise({ color: "white", seed, seconds: 1 });
    const hp = off.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = n.noise.f0; hp.Q.value = -3;
    src.connect(hp).connect(g);
    src.start(n.t0); src.stop(end);
    return;
  }
  const osc = off.createOscillator(); osc.type = n.wave; osc.frequency.setValueAtTime(n.freq, n.t0);
  if (n.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, n.freq + n.slide), end);
  osc.connect(g);
  osc.start(n.t0); osc.stop(end);
}
/** A finished context still counts against the engine's 16 until the collector finds it (there is no close): past that, wait for it. */
async function offlineContext(length: number): Promise<OfflineAudioContext> {
  for (;;) {
    try { return new OfflineAudioContext(1, length, RATE); } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      await new Promise<void>((resolve) => { nextFrame(() => resolve()); });
    }
  }
}
/** Renders notes into a buffer `seconds` long (in contexts of NOTES_A_CONTEXT, one at a time: the node limit); `wrap` folds what passes the end back to the start (seamless loops). */
const NOTES_A_CONTEXT = 24;
async function renderNotes(notes: Note[], seconds: number, wrap: boolean): Promise<Float32Array> {
  const len = Math.ceil(seconds * RATE);
  const out = new Float32Array(len);
  for (let i = 0; i < notes.length; i += NOTES_A_CONTEXT) {
    const part = notes.slice(i, i + NOTES_A_CONTEXT);
    const tail = wrap ? Math.max(0, ...part.map(noteEnd)) - seconds : 0;
    const off = await offlineContext(len + Math.max(0, Math.ceil(tail * RATE)));
    part.forEach((n, k) => schedule(off, n, i + k + 1));
    const r = (await off.startRendering()).getChannelData(0);
    for (let k = 0; k < r.length; k++) { const at = k < len ? k : k % len; out[at] = out[at]! + r[k]!; }
  }
  return out;
}
const synth = new Map<string, AudioClip>();
function playSynth(name: string, gain: number): void {
  const clip = synth.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: "effects", gain }); } catch { /* the mixer is full this frame */ }
}
const blip = (t0: number, freq: number, o: { wave?: Wave; a?: number; d?: number; peak?: number; slide?: number }): Note =>
  ({ t0, freq, wave: o.wave ?? "sine", env: "exp", a: o.a ?? 0.004, d: o.d ?? 0.18, peak: o.peak ?? 0.5, slide: o.slide });
/** Every cue laid end to end in one render, then cut into clips: contexts are scarce (see offlineContext). */
async function renderCues(): Promise<void> {
  const parts: { name: string; at: number; seconds: number }[] = [];
  const all: Note[] = [];
  let end = 0;
  const want = (name: string, notes: Note[], seconds: number): void => {
    parts.push({ name, at: end, seconds });
    for (const n of notes) all.push({ ...n, t0: n.t0 + end });
    end += seconds;
  };
  want("cursor", [blip(0, 980, { d: 0.04, peak: 0.12 })], 0.1);
  want("sig", [1046, 1318, 1568].map((f, i) => blip(i * 0.07, f, { d: 0.5, peak: 0.2 })), 0.8);
  want("hab", [{ t0: 0, freq: 0, wave: "sine", env: "exp", a: 0.003, d: 0.3, peak: 0.08, noise: { kind: "highpass", f0: 2400 } }], 0.4);
  const pitch: Record<string, number> = { pip: 520, mabel: 380, otto: 240, luna: 440, biscuit: 620 };
  for (const [ch, p] of Object.entries(pitch)) {
    for (const syll of [2, 3]) {
      const notes: Note[] = [];
      for (let i = 0; i < syll; i++) {
        const f = p * (1 + (i % 2) * 0.12);
        notes.push(blip(i * 0.1, f, { wave: "triangle", d: 0.09, peak: 0.2, slide: i % 2 ? -40 : 50 }));
        notes.push(blip(i * 0.1, f * 2.4, { d: 0.07, peak: 0.08 }));
      }
      want(`voice-${ch}-${syll}`, notes, 0.1 * syll + 0.2);
    }
  }
  try {
    const buf = await renderNotes(all, end, false);
    for (const p of parts) {
      const from = Math.round(p.at * RATE);
      synth.set(p.name, createClip([buf.slice(from, from + Math.ceil(p.seconds * RATE))], RATE));
    }
  } catch (e) { console.warn(`audio cues: ${String(e)}`); }
}

// --- the theme music (audio.js startMusic / _scheduleBeat), rendered as a loop -----------------------
const LOOP_BEATS = 16;
const PAD_PEAK = 0.068; // audio.js 0.06, +1.1 dB: keeps the stem's old rms within 1 dB (the sine and detuned triangle beat from another phase)
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
        base.push({ t0, freq: deg(d) / 2, wave: "sine", env: "pad", a: beatLen * 1.5, d: beatLen * 4.2, peak: PAD_PEAK });
        base.push({ t0, freq: (deg(d) / 2) * 1.003, wave: "triangle", env: "pad", a: beatLen * 1.5, d: beatLen * 4.2, peak: PAD_PEAK });
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
/** Renders a theme's three stems; dropped if the theme changed meanwhile. */
function renderMusic(th: Theme): void {
  const set: MusicSet = { theme: th.id, voices: [] };
  music = set;
  const notes = musicNotes(th);
  void (async () => {
    const stem = async (list: Note[]): Promise<AudioClip> => createClip([await renderNotes(list, notes.seconds, true)], RATE);
    const base = await stem(notes.base), busy = await stem(notes.busy), sparkle = await stem(notes.sparkle);
    if (music !== set) { base.dispose(); busy.dispose(); sparkle.dispose(); return; }
    Object.assign(set, { base, busy, sparkle });
  })().catch((e: unknown) => console.warn(`music: ${String(e)}`));
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
}
/** Adaptive music follows progress (0 … 1). */
export function setMusicIntensity(x: number): void {
  intensity = Math.max(0, Math.min(1, x));
  if (music?.voices.length === 3) {
    try { music.voices[1]!.fade(suspended ? 0 : intensity, 0.8); music.voices[2]!.fade(suspended ? 0 : (intensity > 0.4 ? intensity : 0), 0.8); } catch { /* gone */ }
  }
}

// --- the ambience bed (audio.js startAmbience), rendered as a 10 s loop ------------------------------
const AMB_SECONDS = 10;
let ambience: { kind: string; clip?: AudioClip; voice?: Sound } | null = null;
const AMB: Record<string, { type: "lowpass" | "highpass" | "bandpass"; f0: number; gain: number; lfoF: number; lfoD: number }> = {
  birds: { type: "lowpass", f0: 500, gain: 0.05, lfoF: 0.1, lfoD: 60 },
  hearth: { type: "lowpass", f0: 320, gain: 0.09, lfoF: 0.5, lfoD: 40 },
  waves: { type: "lowpass", f0: 420, gain: 0.08, lfoF: 0.08, lfoD: 220 },
  crickets: { type: "highpass", f0: 3800, gain: 0.012, lfoF: 11, lfoD: 800 },
  wind: { type: "bandpass", f0: 600, gain: 0.06, lfoF: 0.07, lfoD: 300 },
};
/** White noise through the swept filter (whole LFO cycles in the 10 s noise loop, so periodic once the filter settled). */
async function renderAmbienceBed(kind: string): Promise<Float32Array> {
  const cfg = AMB[kind] ?? AMB.birds!;
  const n = AMB_SECONDS * RATE, settle = Math.round(0.25 * RATE);
  const off = await offlineContext(settle + n);
  const noise = off.createNoise({ color: "white", seed: 0x9e3779b9, seconds: AMB_SECONDS });
  const filter = off.createBiquadFilter(); filter.type = cfg.type; filter.frequency.value = cfg.f0;
  filter.Q.value = cfg.type === "bandpass" ? 0.6 : 20 * Math.log10(0.6); // the old RBJ Q 0.6 (lowpass and highpass Q are in dB here)
  const lfo = off.createOscillator(); lfo.frequency.value = Math.max(1, Math.round(cfg.lfoF * AMB_SECONDS)) / AMB_SECONDS;
  const depth = off.createGain(); depth.gain.value = cfg.lfoD;
  lfo.connect(depth).connect(filter.frequency); lfo.start();
  const g = off.createGain(); g.gain.value = cfg.gain;
  noise.connect(filter).connect(g).connect(off.destination); noise.start();
  return (await off.startRendering()).getChannelData(0).slice(settle);
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
  const amb: { kind: string; clip?: AudioClip; voice?: Sound } = { kind };
  ambience = amb;
  void (async () => {
    const bed = await renderAmbienceBed(kind);
    const ev = await renderNotes(ambienceEvents(kind), AMB_SECONDS, true);
    for (let i = 0; i < bed.length; i++) bed[i] = bed[i]! + ev[i]!;
    const clip = createClip([bed], RATE);
    if (ambience === amb) amb.clip = clip; else clip.dispose();
  })().catch((e: unknown) => console.warn(`ambience: ${String(e)}`));
}

/** A hidden window silences the game (audio.js suspend); a pause keeps the music, as before. */
export function setSuspended(on: boolean): void { if (on !== suspended) { suspended = on; applyGains(); } }
/** The game's M key: the engine's game mute (the option itself is saved by platform.ts). */
export function setMuted(on: boolean): void { muteGame(on); }
function applyGains(): void {
  const off = suspended;
  try {
    if (music?.voices.length === 3) {
      music.voices[0]!.fade(off ? 0 : 1, 0.2);
      music.voices[1]!.fade(off ? 0 : intensity, 0.2);
      music.voices[2]!.fade(off ? 0 : (intensity > 0.4 ? intensity : 0), 0.2);
    }
    ambience?.voice?.fade(off ? 0 : AMBIENCE_GAIN, 0.2);
  } catch { /* gone */ }
}

/** Each frame: due cues, the theme's renders, and the beds once the mixer runs. */
export function update(dt: number): void {
  now += dt;
  for (let i = later.length - 1; i >= 0; i--) {
    if (later[i]!.at <= now) { const f = later[i]!.fn; later.splice(i, 1); if (!silent()) f(); }
  }
  if (musicWanted && musicTheme && !music) renderMusic(musicTheme);
  if (musicTheme) startAmbienceFor(musicTheme.ambience);
  if (context.state !== "running") return;
  if (music && music.base && music.busy && music.sparkle && !music.voices.length) {
    try {
      const off = suspended;
      music.voices = [
        playClip(music.base, { bus: "music", loop: true, gain: off ? 0 : 1 }),
        playClip(music.busy, { bus: "music", loop: true, gain: off ? 0 : intensity }),
        playClip(music.sparkle, { bus: "music", loop: true, gain: off ? 0 : (intensity > 0.4 ? intensity : 0) }),
      ];
    } catch (e) { console.warn(`music: ${String(e)}`); music.voices = []; }
  }
  if (ambience?.clip && !ambience.voice) {
    try { ambience.voice = playClip(ambience.clip, { bus: "music", loop: true, gain: suspended ? 0 : AMBIENCE_GAIN }); } catch (e) { console.warn(`ambience: ${String(e)}`); }
  }
}
