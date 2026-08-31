// audio.js — WebAudio buses (music / effects / ambience / voice), sampled
// one-shots from sfx/ (see sfx/manifest.md) with synthesized fallbacks tied to
// logical events, generative theme music with adaptive stems, quiet ambience
// beds, and text captions for meaningful audio.

// Logical event -> sfx/ sample (manifest names, without extension).
const SAMPLE_FILES = {
  click: 'ui-click', hover: 'ui-hover', confirm: 'ui-confirm', back: 'ui-back',
  invalid: 'ui-error', card: 'ui-success', open: 'ui-modal-open', toggle: 'ui-toggle',
  pickup: 'item-pickup', place: 'item-place', remove: 'item-pickup',
  interact: 'interact-play', finish: 'scene-save', tab: 'ui-tab-switch',
  scroll: 'ui-scroll-tick', slider: 'ui-slider-drag', close: 'ui-panel-close',
  toast: 'ui-toast', pause: 'ui-pause', resume: 'ui-resume',
  countdown: 'ui-countdown-tick', 'settings-saved': 'ui-settings-saved',
  'room-enter': 'room-enter', drag: 'item-drag', 'story-complete': 'story-complete',
  tutorial: 'tutorial-step', undo: 'undo-action', hint: 'hint-reveal',
  go: 'challenge-start', 'timer-warn': 'timer-warning', timeout: 'challenge-fail',
  'collection-complete': 'collection-complete', star: 'star-earn',
  record: 'new-record', streak: 'streak-keep', tally: 'results-tally',
};
// Extra samples layered just ahead of an event's primary sample.
const SAMPLE_LAYERS = { 'room-enter': ['door-creak'] };
// Captions for meaningful sampled events (kept in sync with the synth cues).
const SAMPLE_CAPTIONS = {
  invalid: 'low knock — that move is not allowed',
  timeout: 'a descending phrase — time is up',
  finish: 'a warm music-box phrase — the scene is saved',
};

export class AudioEngine {
  constructor(hooks = {}) {
    this.hooks = hooks;                 // { onCaption(text) }
    this.ctx = null;
    this.buses = {};
    this.volumes = { music: 70, effects: 80, ambience: 55, voice: 65 };
    this.muted = false;
    this.theme = null;
    this._musicTimer = 0;
    this._musicNext = 0;
    this._musicBeat = 0;
    this._musicIntensity = 0;
    this._musicRng = null;
    this._ambTimer = 0;
    this._ambNodes = [];
    this._noiseBuf = null;
  }

  /** Must be called from a user gesture at least once. */
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.connect(this.ctx.destination);
    this.master = master;
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
      const g = this.ctx.createGain();
      g.connect(master);
      this.buses[bus] = g;
      g.gain.value = this._gain(this.volumes[bus]);
    }
    this._applyMute();
    // Shared noise buffer.
    const len = this.ctx.sampleRate * 2;
    this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._samples = new Map();    // file -> AudioBuffer, or null after a failed load
    this._sampleLoads = new Map(); // file -> in-flight fetch/decode promise
    return true;
  }

  // ---------------------------------------------------------------- samples
  // Lazy fetch+decode+cache of the sfx/ one-shots on first use (only after the
  // user-gesture unlock in ensure()). While a sample is loading — or if it
  // failed — the synthesized fallback for that event stays in place.
  _sampleBuffer(file) {
    if (!this.ctx) return null;
    if (this._samples.has(file)) return this._samples.get(file);
    if (!this._sampleLoads.has(file)) {
      this._sampleLoads.set(file, (async () => {
        try {
          const res = await fetch(`sfx/${file}.opus`);
          if (!res.ok) throw new Error(`sfx ${res.status}`);
          this._samples.set(file, await this.ctx.decodeAudioData(await res.arrayBuffer()));
        } catch {
          this._samples.set(file, null); // missing/undecodable — synth fallback covers it
        } finally {
          this._sampleLoads.delete(file);
        }
      })());
    }
    return undefined; // still loading
  }

  /** Play the manifest sample(s) for a logical event. Returns false if none are ready. */
  _playSample(name, at = 0) {
    if (!this.ctx || this.muted) return false;
    const files = [SAMPLE_FILES[name], ...(SAMPLE_LAYERS[name] ?? [])].filter(Boolean);
    let played = false;
    files.forEach((file, i) => {
      const buf = this._sampleBuffer(file);
      if (!buf) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.buses.effects);
      src.start(this.ctx.currentTime + at + i * 0.12);
      played = true;
    });
    return played;
  }

  _gain(v) { return Math.pow(Math.max(0, Math.min(100, v)) / 100, 2); }
  setVolume(bus, v) {
    this.volumes[bus] = v;
    if (this.buses[bus]) this.buses[bus].gain.setTargetAtTime(this._gain(v), this.ctx.currentTime, 0.05);
  }
  setMuted(m) { this.muted = m; this._applyMute(); }
  _applyMute() {
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.03);
  }
  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }
  caption(text) { this.hooks.onCaption?.(text); }

  // ------------------------------------------------------------------ synth
  _osc(type, freq, t0) {
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    return o;
  }
  _env(t0, a, d, peak = 1, sustain = 0) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0004, sustain), t0 + a + d);
    return g;
  }
  _play(bus, node, t0, dur) {
    node.connect(this.buses[bus]);
    node.start?.(t0);
    node.stop?.(t0 + dur + 0.1);
  }
  _blip(bus, freq, { type = 'sine', a = 0.004, d = 0.18, peak = 0.5, at = 0, slide = 0 } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + at;
    const o = this._osc(type, freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + a + d);
    const g = this._env(t0, a, d, peak);
    o.connect(g); this._play(bus, g, t0, a + d);
  }
  _noise(bus, { f0 = 800, q = 1, a = 0.003, d = 0.12, peak = 0.4, at = 0, type = 'bandpass' } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = f0; f.Q.value = q;
    const g = this._env(t0, a, d, peak);
    src.connect(f); f.connect(g); this._play(bus, g, t0, a + d);
    src.start(t0); src.stop(t0 + a + d + 0.1);
  }

  // ------------------------------------------------------------------- SFX
  /** UI + rules event sounds. rng (optional) seeds pitch variants for replays. */
  sfx(name, rng = null) {
    if (!this.ctx || this.muted) return;
    if (this._playSample(name)) {
      if (SAMPLE_CAPTIONS[name]) this.caption(SAMPLE_CAPTIONS[name]);
      return;
    }
    const v = rng ? 0.94 + rng.next() * 0.12 : 1;
    switch (name) {
      case 'click':   this._blip('effects', 660 * v, { type: 'triangle', d: 0.07, peak: 0.25 }); break;
      case 'open':    this._blip('effects', 520 * v, { type: 'triangle', d: 0.1, peak: 0.22 }); this._blip('effects', 780 * v, { type: 'triangle', d: 0.12, peak: 0.18, at: 0.05 }); break;
      case 'close':   this._blip('effects', 700 * v, { type: 'triangle', d: 0.08, peak: 0.2 }); this._blip('effects', 470 * v, { type: 'triangle', d: 0.12, peak: 0.18, at: 0.05 }); break;
      case 'pickup':  this._blip('effects', 440 * v, { type: 'sine', d: 0.1, peak: 0.3, slide: 220 }); break;
      case 'place':   this._noise('effects', { f0: 300, d: 0.1, peak: 0.5 }); this._blip('effects', 180 * v, { type: 'sine', d: 0.14, peak: 0.5, slide: -60 }); break;
      case 'remove':  this._blip('effects', 330 * v, { type: 'sine', d: 0.12, peak: 0.3, slide: -120 }); break;
      case 'invalid': this._blip('effects', 140, { type: 'square', d: 0.16, peak: 0.16 }); this._blip('effects', 110, { type: 'square', d: 0.2, peak: 0.14, at: 0.07 }); this.caption('low buzz — that move is not allowed'); break;
      case 'undo':    this._blip('effects', 500 * v, { type: 'sine', d: 0.1, peak: 0.25, slide: -200 }); break;
      case 'hint':    this._blip('effects', 880 * v, { type: 'sine', d: 0.25, peak: 0.22 }); this._blip('effects', 1320 * v, { type: 'sine', d: 0.3, peak: 0.15, at: 0.08 }); break;
      case 'cursor':  this._blip('effects', 980 * v, { type: 'sine', d: 0.04, peak: 0.12 }); break;
      case 'countdown': this._blip('effects', 587, { type: 'triangle', d: 0.15, peak: 0.3 }); break;
      case 'go':      this._blip('effects', 880, { type: 'triangle', d: 0.3, peak: 0.35 }); this._blip('effects', 1174, { type: 'triangle', d: 0.4, peak: 0.25, at: 0.06 }); break;
      case 'timeout': this._blip('effects', 392, { type: 'triangle', d: 0.4, peak: 0.3 }); this._blip('effects', 311, { type: 'triangle', d: 0.6, peak: 0.3, at: 0.25 }); this.caption('the clock chimes — time is up'); break;
      case 'finish': {
        const notes = [523, 659, 784, 1046];
        notes.forEach((f, i) => this._blip('effects', f, { type: 'triangle', d: 0.5, peak: 0.3, at: i * 0.11 }));
        this.caption('a bright cadence — the scene is saved');
        break;
      }
    }
  }

  /** Beat sounds: one transient color per interaction kind. */
  beatSfx(beatType, sig, hab, rng = null) {
    if (!this.ctx || this.muted) return;
    const v = rng ? 0.95 + rng.next() * 0.1 : 1;
    const base = {
      'story-time': [523, 659], 'tea-break': [659, 784], 'melody': [392, 523, 659],
      'green-thumb': [587, 698], 'catnap': [440, 349], 'stargazing': [784, 988],
      'bright-idea': [880, 1108], 'snack': [523, 494], 'time-check': [659, 587],
      'playtime': [698, 880], 'heart-to-heart': [523, 622, 784],
    }[beatType] || [523, 659];
    if (!this._playSample('interact')) {
      base.forEach((f, i) => this._blip('effects', f * v, { type: 'sine', d: 0.35, peak: 0.28, at: i * 0.09 }));
    }
    if (sig) [1046, 1318, 1568].forEach((f, i) => this._blip('effects', f, { type: 'sine', d: 0.5, peak: 0.2, at: 0.15 + i * 0.07 }));
    if (hab) this._noise('effects', { f0: 2400, d: 0.3, peak: 0.08, at: 0.1, type: 'highpass' });
    const labels = { sig: 'a golden signature chime', hab: 'a warm homely shimmer' };
    if (sig) this.caption(labels.sig);
  }

  cardSfx() {
    if (!this.ctx || this.muted) return;
    if (this._playSample('card')) { this.caption('a discovery card completes'); return; }
    [784, 988, 1175, 1568].forEach((f, i) => this._blip('effects', f, { type: 'triangle', d: 0.4, peak: 0.22, at: i * 0.08 }));
    this.caption('a discovery card completes');
  }

  /** Character voice blips — tiny formant mumbles on the voice bus. */
  voiceBlip(characterKey, rng = null) {
    if (!this.ctx || this.muted) return;
    const pitch = { pip: 520, mabel: 380, otto: 240, luna: 440, biscuit: 620 }[characterKey] ?? 400;
    const v = rng ? 0.94 + rng.next() * 0.12 : 1;
    const syll = 2 + ((rng ? rng.next() * 2 : Math.random() * 2) | 0);
    for (let i = 0; i < syll; i++) {
      const f = pitch * v * (1 + (i % 2) * 0.12);
      this._blip('voice', f, { type: 'triangle', d: 0.09, peak: 0.2, at: i * 0.1, slide: i % 2 ? -40 : 50 });
      this._blip('voice', f * 2.4, { type: 'sine', d: 0.07, peak: 0.08, at: i * 0.1 });
    }
  }

  // ------------------------------------------------------------------ music
  setTheme(theme) {
    this.theme = theme;
    this._musicRng = null; // reseed on next start
  }

  startMusic(seedStream) {
    if (!this.ctx || this._musicTimer) return;
    const m = this.theme?.music ?? { root: 261.63, scale: [0, 2, 4, 7, 9], bpm: 78, bright: 1 };
    this._musicRng = seedStream ?? this._musicRng;
    this._musicBeat = 0;
    this._musicNext = this.ctx.currentTime + 0.1;
    const beatLen = 60 / m.bpm;
    this._musicTimer = setInterval(() => {
      if (!this.ctx || this.muted) return;
      while (this._musicNext < this.ctx.currentTime + 0.35) {
        this._scheduleBeat(this._musicNext, this._musicBeat, beatLen, m);
        this._musicNext += beatLen;
        this._musicBeat++;
      }
    }, 90);
  }
  stopMusic() { clearInterval(this._musicTimer); this._musicTimer = 0; }
  setMusicIntensity(x) { this._musicIntensity = Math.max(0, Math.min(1, x)); }

  _scheduleBeat(t0, beat, beatLen, m) {
    const rng = this._musicRng;
    const scale = m.scale;
    const deg = (i) => m.root * Math.pow(2, scale[i % scale.length] / 12) * (i >= scale.length ? 2 : 1);
    // Pad: a slow chord every 4 beats.
    if (beat % 4 === 0) {
      const chordDeg = [0, 2, 4].map(i => (i + ((beat / 4) % 2 ? 1 : 0)) % scale.length);
      for (const d of chordDeg) {
        const o = this._osc('sine', deg(d) / 2, t0);
        const o2 = this._osc('triangle', deg(d) / 2 * 1.003, t0);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.06, t0 + beatLen * 1.5);
        g.gain.linearRampToValueAtTime(0, t0 + beatLen * 4.2);
        o.connect(g); o2.connect(g);
        this._play('music', g, t0, beatLen * 4.4);
        o.start(t0); o.stop(t0 + beatLen * 4.4); o2.start(t0); o2.stop(t0 + beatLen * 4.4);
      }
    }
    // Melody: gentle seeded random walk, denser as intensity rises.
    if (rng && (beat % 2 === 0 || rng.next() < this._musicIntensity * 0.7)) {
      this._melDeg = Math.max(0, Math.min(scale.length + 3, (this._melDeg ?? 2) + (rng.next() < 0.5 ? -1 : 1) * (rng.next() < 0.3 ? 2 : 1)));
      const f = deg(this._melDeg) * (m.bright > 0.9 ? 2 : 1);
      const o = this._osc('sine', f, t0);
      const g = this._env(t0, 0.01, beatLen * 1.8, 0.11);
      o.connect(g); this._play('music', g, t0, beatLen * 2);
      o.start(t0); o.stop(t0 + beatLen * 2.1);
    }
    // Sparkle stem: appears only with progress (adaptive layer).
    if (this._musicIntensity > 0.4 && beat % 8 === 6 && rng) {
      const f = deg(rng.int ? rng.int(0, scale.length - 1) : 0) * 4;
      const o = this._osc('sine', f, t0);
      const g = this._env(t0, 0.005, beatLen * 2.5, 0.05 * this._musicIntensity);
      o.connect(g); this._play('music', g, t0, beatLen * 2.5);
      o.start(t0); o.stop(t0 + beatLen * 2.6);
    }
  }

  // --------------------------------------------------------------- ambience
  startAmbience() {
    if (!this.ctx || this._ambTimer) return;
    const kind = this.theme?.ambience ?? 'wind';
    // Base bed: soft filtered noise shaped per kind.
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const lfoG = this.ctx.createGain();
    const cfg = {
      birds:    { type: 'lowpass', f0: 500, gain: 0.05, lfoF: 0.1, lfoD: 60 },
      hearth:   { type: 'lowpass', f0: 320, gain: 0.09, lfoF: 0.5, lfoD: 40 },
      waves:    { type: 'lowpass', f0: 420, gain: 0.08, lfoF: 0.08, lfoD: 220 },
      crickets: { type: 'highpass', f0: 3800, gain: 0.012, lfoF: 11, lfoD: 800 },
      wind:     { type: 'bandpass', f0: 600, gain: 0.06, lfoF: 0.07, lfoD: 300 },
    }[kind] ?? { type: 'lowpass', f0: 500, gain: 0.05, lfoF: 0.1, lfoD: 60 };
    f.type = cfg.type; f.frequency.value = cfg.f0; f.Q.value = 0.6;
    g.gain.value = cfg.gain;
    lfo.frequency.value = cfg.lfoF; lfoG.gain.value = cfg.lfoD;
    lfo.connect(lfoG); lfoG.connect(f.frequency);
    src.connect(f); f.connect(g); g.connect(this.buses.ambience);
    src.start(); lfo.start();
    this._ambNodes = [src, lfo, g];
    // Sparse events (bird chirps / crackles) on a seeded timer.
    this._ambTimer = setInterval(() => {
      if (this.muted || !this.ctx) return;
      const r = Math.random();
      if (kind === 'birds' && r < 0.5) {
        const f0 = 2200 + Math.random() * 1400;
        this._blip('ambience', f0, { type: 'sine', d: 0.09, peak: 0.05, slide: 500 });
        this._blip('ambience', f0 * 1.2, { type: 'sine', d: 0.07, peak: 0.04, at: 0.12, slide: -300 });
      } else if (kind === 'hearth' && r < 0.7) {
        this._noise('ambience', { f0: 900 + Math.random() * 1200, d: 0.03, peak: 0.05, q: 4 });
      } else if (kind === 'crickets' && r < 0.4) {
        this._blip('ambience', 4200, { type: 'sine', d: 0.05, peak: 0.02 });
      }
    }, 1400);
  }
  stopAmbience() {
    clearInterval(this._ambTimer); this._ambTimer = 0;
    for (const n of this._ambNodes) { try { n.stop?.(); n.disconnect?.(); } catch {} }
    this._ambNodes = [];
  }
}
