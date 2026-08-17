// main.js — composition root. Owns the game-state machine
//   boot → title → profile-ready → mode-select → preparing → countdown
//        → active ↔ paused → resolving → results → progression
// Every transition has one owner and an explicit reason. Rules state changes
// only through GameSession commands; the renderer consumes snapshots+events.
import { Stage } from './render.js';
import { UI } from './ui.js';
import { Input } from './ui-input.js';
import { AudioEngine } from './audio.js';
import { Platform, BUILD } from './platform.js';
import { GameSession } from './session.js';
import { defaultSettings } from './persist.js';
import * as R from './rules.js';
import * as C from './content.js';
import { RngStream, deriveSeed } from './rng.js';

const VERSIONS = { build: BUILD, contentVersion: C.CONTENT_VERSION, ruleset: R.RULESET_VERSION };

// A no-op renderer for text mode (WebGL unavailable): full play through the
// semantic DOM mirror remains possible.
class NullStage {
  constructor() { this.house = null; this.trayAnchors = []; }
  init() { return true; }
  startSession() {} syncState() {} playEvents() {} settleAll() {}
  pick() { return null; } worldOnGround() { return null; }
  setSelection() {} setHoverTarget() {} setCursor() {}
  focusRoom() {} resetCamera() {} orbit() {} zoom() {}
  setQualityTier() {} setAutoQuality() {} setReducedMotion() {}
  setRunning() {} captureThumbnail() { return null; } dispose() {}
  piecePos() { return null; } roomIds() { return []; }
}

class App {
  constructor() {
    this.state = 'boot';
    this.platform = new Platform();
    this.settings = this.platform.loadSettings();
    this.progress = this.platform.loadProgress();
    this.audio = new AudioEngine({ onCaption: (t) => this.ui?.caption(t) });
    this.stage = null;
    this.ui = new UI(this._uiHandlers());
    this.input = null;
    this.session = null;
    this.selection = null;
    this.mode = null;              // 'learn'|'journey'|'daily'|'practice'|'challenge'|'score'
    this.setup = null;             // pending setup options
    this.lesson = null;            // active lesson runtime {def, stepIndex}
    this._awayAt = null;
    this._resolving = false;
    this._theme = C.THEMES.meadow;
    this._tickTimer = 0;
    this._awayToastShown = false;
  }

  // ------------------------------------------------------------ boot
  async boot() {
    this._transition('boot', 'process start');
    await this.platform.init();
    this.platform.setTelemetryConsent(this.settings.telemetry);
    this.platform.onSaveConflict = ({ local, remote }) => this._resolveSaveConflict(local, remote);

    // Renderer (or text-mode fallback).
    if (Stage.webglAvailable()) {
      this.stage = new Stage(document.getElementById('gl'), {
        onTierChange: (tier) => this.ui.toast(`Graphics adjusted to “${tier}” to keep things smooth.`),
        onContextLost: () => this.ui.toast('Graphics context lost — rebuilding…', 'bad'),
        onContextRestored: () => this.ui.toast('Graphics restored.'),
      });
      if (!this.stage.init()) this.stage = null;
    }
    if (!this.stage) {
      this.stage = new NullStage();
      this.ui.showCompat();
    }

    this.input = new Input(document.getElementById('gl'), this.stage, this._inputHandlers());
    this._applySettings();
    this._bindGlobalKeys();
    this._bindLifecycle();
    this._refreshTitle();
    this._transition('title', 'boot complete');

    // Identity in the background: title → profile-ready.
    this.platform.ensureProfile().then((p) => {
      this._refreshTitle();
      this._transition('profile-ready', 'identity resolved');
    });

    // Audio needs a first gesture.
    const unlock = () => {
      if (this.audio.ensure()) {
        this._applyAudioSettings();
        this.audio.setTheme(this._theme);
        this.audio.startMusic(new RngStream(deriveSeed('music', this._theme.id)));
        this.audio.startAmbience();
      }
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }

  _transition(to, reason) {
    const from = this.state;
    this.state = to;
    console.info(`[storyhouse] ${from} → ${to} (${reason})`);
    // Screen routing per state.
    if (to === 'title' || to === 'profile-ready') this.ui.showScreen('title');
    if (to === 'mode-select') this.ui.showScreen('setup');
    if (to === 'results') this.ui.showScreen('results');
  }

  _refreshTitle() {
    const journeyDone = Object.keys(this.progress.journey).length;
    this.ui.setTitleInfo({
      journeyDone,
      journeyTotal: C.journeyLength(),
      dailyDone: this.progress.lastDaily?.date === this.platform.utcToday(),
      profile: this.platform.profile,
      hasSnapshot: !!this.platform.loadSnapshot(),
    });
  }

  // ------------------------------------------------------------ settings
  _applySettings(patch = {}) {
    Object.assign(this.settings, patch);
    this.ui.applySettingsClasses(this.settings);
    this._applyAudioSettings();
    this.ui.setCaptions(this.settings.captions);
    this.platform.setTelemetryConsent(this.settings.telemetry);
    const q = this.settings.quality === 'auto' ? 'high' : this.settings.quality;
    this.stage.setAutoQuality(this.settings.quality === 'auto');
    this.stage.setQualityTier(q);
    this.stage.setReducedMotion(this.settings.reducedMotion);
    this.platform.saveSettings(this.settings);
  }
  _applyAudioSettings() {
    for (const bus of ['music', 'effects', 'ambience', 'voice']) this.audio.setVolume(bus, this.settings[bus]);
    this.audio.setMuted(this.settings.mute);
  }

  _bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        if (this.state === 'active') this.pauseGame('esc key');
        else if (this.state === 'paused') this.resumeGame('esc key');
      } else if ((e.key === 'p' || e.key === 'P') && (this.state === 'active' || this.state === 'paused')) {
        this.state === 'active' ? this.pauseGame('p key') : this.resumeGame('p key');
      }
    });
  }

  _bindLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.state === 'active') {
          this._awayAt = Date.now();
          this.pauseGame('backgrounded', { silent: true });
          this._saveSnapshot();
        }
        this.stage.setRunning(false);
        this.audio.suspend();
      } else {
        this.audio.resume();
        if (this.session && this.state === 'paused') {
          this.stage.setRunning(true);
          if (this._awayAt && !this._awayToastShown) {
            const mins = Math.round((Date.now() - this._awayAt) / 60000);
            this.ui.toast(`Welcome back — paused while you were away${mins >= 1 ? ` for about ${mins} min` : ''}. Nothing moved without you.`);
            this._awayToastShown = true;
          }
          this._awayAt = null;
        }
      }
    });
    window.addEventListener('resize', () => { /* renderer observes its box; HUD is pure CSS */ });
  }

  // ------------------------------------------------------------ navigation
  _uiHandlers() {
    return {
      onGoto: (where) => this.goto(where),
      onPlay: () => this.quickPlay(),
      onResumeSnapshot: () => this.resumeSnapshot(),
      onPauseToggle: () => this.state === 'active' ? this.pauseGame('button') : this.resumeGame('button'),
      onOpenSettings: () => { this.ui.showPause(false); this._fromPause = true; this.openSettings(); },
      onOpenHelp: () => { this.ui.showPause(false); this._fromPause = true; this.openHelp(); },
      onRestart: () => this.confirmRestart(),
      onLeave: () => this.leaveToTitle(),
      onHint: () => this.hint(),
      onUndo: () => this.undo(),
      onFinish: () => this.finish(),
      onSetupStart: () => this.startFromSetup(),
      onResultsNext: () => this.resultsNext(),
      onResultsReplay: () => this.restartSession('replay button'),
      onTraySelect: (key) => this.tapPiece(key),
      onContextAction: (a) => this.contextAction(a),
      onDeleteScene: (id) => { this.platform.deleteScene(id); this.openScrapbook(); },
      onResetBindings: () => { const d = defaultSettings(); this.settings.bindings = d.bindings; this.settings.gamepad = d.gamepad; this._applySettings(); this.openSettings(); },
      onReplayTutorials: () => { this.progress.lessons = {}; this.platform.saveProgress(this.progress); this.goto('learn'); },
      onWipe: () => this.confirmWipe(),
      onTextMode: () => { this._textModeOn = true; this.ui.setMirrorVisible(true); this.ui.toast('Text mode: the whole house is playable from the panel and tray.'); },
      onToggleMirror: () => { this._textModeOn = !this._textModeOn; this.ui.setMirrorVisible(this._textModeOn); },
    };
  }

  goto(where) {
    this.audio.sfx('open');
    if (where === 'title') {
      // Settings/help opened from the pause overlay return to the paused game.
      if (this._fromPause && this.session && this.state === 'paused') {
        this._fromPause = false;
        this.ui.showScreen(null);
        this.ui.showPause(true);
        return;
      }
      this.leaveToTitle();
      return;
    }
    if (where === 'settings') return this.openSettings();
    if (where === 'help') return this.openHelp();
    if (where === 'journey') return this.openJourneyMap();
    if (where === 'scrapbook') return this.openScrapbook();
    if (['daily', 'learn', 'practice', 'challenge', 'score'].includes(where)) return this.openSetup(where);
  }

  quickPlay() {
    // Shortest path: next journey stage (or stage 0) in one action.
    const next = this._nextJourneyIndex();
    this.mode = 'journey';
    this._startSession({ mode: 'journey', index: next });
  }
  _nextJourneyIndex() {
    for (let i = 0; i < C.journeyLength(); i++) {
      const id = C.journeyStage(i).contentId;
      if (!this.progress.journey[id]) return i;
    }
    return C.journeyLength() - 1;
  }

  // ------------------------------------------------------------ setup
  openSetup(mode) {
    this.mode = mode;
    this._transition('mode-select', `setup ${mode}`);
    const fields = document.createElement('div');
    fields.style.display = 'grid';
    fields.style.gap = '8px';
    const today = this.platform.utcToday();
    const mk = (label, input) => {
      const l = document.createElement('label');
      l.style.display = 'flex'; l.style.justifyContent = 'space-between'; l.style.alignItems = 'center'; l.style.gap = '10px';
      const s = document.createElement('span'); s.textContent = label;
      l.append(s, input);
      return l;
    };
    const select = (opts, val) => {
      const s = document.createElement('select');
      for (const [v, t] of opts) {
        const o = document.createElement('option'); o.value = v; o.textContent = t;
        s.appendChild(o);
      }
      s.value = val;
      return s;
    };

    if (mode === 'daily') {
      const content = C.dailyContent(today);
      this.setup = { mode, date: today };
      const done = this.progress.lastDaily?.date === today;
      const leftMs = this.platform.msToNextDaily();
      const leftH = Math.floor(leftMs / 3600000), leftM = Math.ceil((leftMs % 3600000) / 60000);
      this.ui.setupScreen({
        mode: 'Daily Story',
        facts: [['Date (UTC)', today], ['House', content.layout.label], ['Pieces', content.tray.length],
          ['Discovery cards', content.cards.length], ['Seed', String(content.seed)],
          ['Expected time', '3–6 minutes'], ['Players', '1 — scores compared asynchronously'],
          ['Next daily in', `${leftH}h ${leftM}m (server-synced)`],
          done ? ['Today', 'Completed — replay to improve'] : ['Today', 'Not yet played']],
        ranked: true, rankedNote: 'one shared seed and ruleset for everyone today',
        startLabel: done ? 'Replay today' : 'Start today’s story',
      });
    } else if (mode === 'learn') {
      const nextLesson = C.LESSONS.find(l => !this.progress.lessons[l.id]) || C.LESSONS[0];
      const sel = select(C.LESSONS.map(l => [l.id, `${l.title}${this.progress.lessons[l.id] ? ' ✓' : ''}`]), nextLesson.id);
      sel.addEventListener('change', () => { this.setup.lessonId = sel.value; });
      fields.appendChild(mk('Lesson', sel));
      this.setup = { mode, lessonId: nextLesson.id };
      this.ui.setupScreen({
        mode: 'Learn',
        facts: [['Lessons', `${C.LESSONS.length} interactive`], ['This lesson', nextLesson.title],
          ['Rules', 'One new idea at a time — you perform each action'], ['Expected time', '1–3 minutes']],
        ranked: false, rankedNote: 'lessons are never ranked',
        startLabel: 'Start lesson', fields,
      });
    } else if (mode === 'practice') {
      const diff = select(Object.entries(C.PRACTICE_DIFFICULTIES).map(([k, v]) => [k, v.label]), 'cozy');
      const theme = select(C.THEME_ORDER.map(t => [t, C.THEMES[t].label]), this._theme.id);
      const seedInput = document.createElement('input');
      seedInput.type = 'text'; seedInput.inputMode = 'numeric';
      seedInput.value = String(Math.floor(Math.random() * 899999) + 100000);
      seedInput.setAttribute('aria-label', 'Seed');
      diff.addEventListener('change', () => { this.setup.difficulty = diff.value; this._updateSetupFacts(); });
      theme.addEventListener('change', () => { this.setup.theme = theme.value; });
      seedInput.addEventListener('change', () => { this.setup.seed = seedInput.value.replace(/\D/g, '') || '1'; });
      fields.append(mk('Difficulty', diff), mk('Theme', theme), mk('Seed (inspectable)', seedInput));
      this.setup = { mode, difficulty: 'cozy', theme: this._theme.id, seed: seedInput.value };
      this.ui.setupScreen({
        mode: 'Practice',
        facts: this._practiceFacts('cozy'),
        ranked: false, rankedNote: 'undo enabled, no effect on ratings',
        startLabel: 'Start practicing', fields,
      });
      this._setupFactsFor = (d) => this._practiceFacts(d);
    } else if (mode === 'challenge') {
      const sel = select(C.CHALLENGES.map(c => [c.id, c.label]), C.CHALLENGES[0].id);
      const update = () => {
        this.setup.challengeId = sel.value;
        const c = C.challengeContent(sel.value);
        this.ui.setupScreen({
          mode: 'Challenge',
          facts: [['Challenge', c.label], ['House', c.layout.label], ['Pieces', c.tray.length],
            ['Discovery cards', c.cards.length],
            ...(c.moveLimit ? [['Move limit', c.moveLimit]] : []),
            ...(c.timeLimitMs ? [['Time limit', `${c.timeLimitMs / 1000}s · speed scores bonus`]] : []),
            ['Undo', c.allowUndo ? 'Allowed' : 'Off'], ['Expected time', '3–8 minutes']],
          ranked: c.ranked, rankedNote: c.ranked ? 'validated replay on the leaderboard' : 'unranked',
          startLabel: 'Take the challenge', fields,
        });
      };
      sel.addEventListener('change', update);
      this.setup = { mode, challengeId: sel.value };
      fields.appendChild(mk('Challenge', sel));
      update();
    } else if (mode === 'score') {
      const seedInput = document.createElement('input');
      seedInput.type = 'text'; seedInput.inputMode = 'numeric';
      seedInput.value = String(Math.floor(Math.random() * 89999) + 10000);
      seedInput.setAttribute('aria-label', 'Seed');
      seedInput.addEventListener('change', () => { this.setup.seed = seedInput.value.replace(/\D/g, '') || '1'; });
      fields.appendChild(mk('Seed (share it, race it)', seedInput));
      this.setup = { mode, seed: seedInput.value };
      this.ui.setupScreen({
        mode: 'Score Chase',
        facts: [['House', 'Manor'], ['Pieces', '7, seeded'], ['Discovery cards', '4, seeded'],
          ['Expected time', '4–8 minutes'], ['Validation', 'server replays your input log']],
        ranked: true, rankedNote: 'global and friends boards on this seed',
        startLabel: 'Chase the score', fields,
      });
    }
  }
  _practiceFacts(d) {
    const dd = C.PRACTICE_DIFFICULTIES[d];
    return [['Difficulty', dd.label], ['House', dd.layout], ['Pieces', dd.chars + dd.props],
      ['Discovery cards', dd.cards.length], ['Move limit', dd.limited ? 'Yes — tight' : 'None'],
      ['Undo', 'Allowed'], ['Expected time', '2–7 minutes']];
  }
  _updateSetupFacts() {
    if (this.mode === 'practice' && this.setup) {
      this.ui.setupScreen({
        mode: 'Practice',
        facts: this._practiceFacts(this.setup.difficulty),
        ranked: false, rankedNote: 'undo enabled, no effect on ratings',
        startLabel: 'Start practicing',
        fields: document.querySelector('#setup-body > div'),
      });
    }
  }

  openJourneyMap() {
    this._transition('mode-select', 'journey map');
    const chapters = C.CHAPTERS_PUB.map((ch, ci) => ({
      title: ch.title,
      stages: ch.names.map((label, si) => {
        const index = ci * 9 + si;
        const id = C.journeyStage(index).contentId;
        const rec = this.progress.journey[id];
        const locked = index > 0 && !this.progress.journey[C.journeyStage(index - 1).contentId];
        return { index, label, mastery: si === 8, stars: rec?.stars || 0, locked, current: index === this._nextJourneyIndex() };
      }),
    }));
    this.ui.journeyMap(chapters, this.progress, (index) => {
      this.mode = 'journey';
      this._startSession({ mode: 'journey', index });
    });
    this.ui.showScreen('journey');
  }

  openScrapbook() {
    this._transition('mode-select', 'scrapbook');
    const scenes = this.platform.loadScenes();
    const mastery = [
      ['Beat kinds discovered', `${this.progress.beatsSeen.length} / ${Object.keys(R.BEATS).length}`],
      ['Discovery cards collected', `${this.progress.cardsCollected.length}`],
      ['Journey stages completed', `${Object.keys(this.progress.journey).length} / ${C.journeyLength()}`],
      ['Journey stars', `${Object.values(this.progress.journey).reduce((s, j) => s + (j.stars || 0), 0)} / ${C.journeyLength() * 3}`],
      ['Days played', `${this.progress.daysPlayed.length}`],
      ['Scenes saved', `${this.progress.scenesCount}`],
    ];
    const achievements = C.ACHIEVEMENTS.map(a => ({
      ...a, unlocked: !!this.progress.achievements[a.id], at: this.progress.achievements[a.id],
    }));
    this.ui.scrapbook({ scenes, mastery, achievements });
    this.ui.showScreen('scrapbook');
  }

  openHelp() {
    this._transition('mode-select', 'help');
    const sample = C.practiceContent('cozy', 1, 'meadow');
    const st = R.createGame(sample);
    const legal = R.listLegalActions(st);
    const place = legal.find(a => a.type === 'place');
    const b = this.settings.bindings;
    const key = (a) => (b[a] || ['?'])[0];
    this.ui.help({
      ruleCards: [
        { title: 'Make a home', text: 'Place characters and props from the tray into glowing spots. Every piece on the floor is part of the story.', example: place ? `place the ${sample.items[place.item].name} in the ${st.rooms.find(r => r.id === place.room).name}` : null },
        { title: 'Make a moment', text: 'A character and a prop in the same room can interact — that records a story moment. Two characters can share a heart to heart. Props alone cannot interact.', example: 'put Pip and the Old Clock in one room, then interact' },
        { title: 'Signatures & habitats', text: 'Each character has a favorite thing (a golden ✦ signature moment). Moments in their natural room earn a habitat bonus.', example: 'Mabel with the Potted Fern, or tea in the Kitchen' },
        { title: 'Discovery cards', text: 'Optional goals on the left rail. Complete them for points and to grow your collection — or ignore them and play freely.', example: 'check the Goals drawer any time' },
        { title: 'Save the scene', text: 'Finished stories are scored by moments, discoveries, room coverage, and variety — the breakdown is always shown. Scenes persist in your Scrapbook.', example: 'the “Save scene ✦” button ends a story' },
        { title: 'Every action, acknowledged', text: `Confirm with ${key('confirm')}, cancel with ${key('cancel')}, undo with ${key('undo')}, hint with ${key('hint')}, camera reset with ${key('camera')}. Hints only suggest moves that are legal right now.` },
      ],
      bindings: [
        ...Object.entries(b).filter(([a]) => !['left', 'right', 'up', 'down'].includes(a))
          .map(([a, keys]) => [{
            confirm: 'Confirm / place', cancel: 'Cancel', pause: 'Pause', undo: 'Undo',
            hint: 'Hint', camera: 'Camera reset', mute: 'Mute',
          }[a] || a, keys]),
        ['Move cursor', ['Arrow keys', 'stick / dpad']],
        ['Cycle rooms', ['gamepad shoulder buttons']],
      ],
    });
    this.ui.showScreen('help');
  }

  openSettings() {
    this._transition('mode-select', 'settings');
    this.ui.bindSettings(this.settings, (patch) => this._applySettings(patch));
    this.ui.bindingsEditor(this.settings, (action, done) => {
      if (action.startsWith('pad:')) {
        this.input.captureNextPadButton((btn) => {
          if (btn !== null && btn !== undefined) {
            this.settings.gamepad[action.slice(4)] = btn;
            this._applySettings();
          }
          done(this.settings.gamepad[action.slice(4)]);
        });
      } else {
        this.input.captureNextKey((keys) => {
          if (keys) {
            this.settings.bindings[action] = keys;
            this._applySettings();
          }
          done(this.settings.bindings[action]);
        });
      }
    });
    this.ui.showScreen('settings');
  }

  _resolveSaveConflict(localDoc, remoteDoc) {
    // Neither snapshot descends from the other: preserve both, ask the player.
    const localScenes = localDoc.scenesCount ?? 0;
    const remoteScenes = remoteDoc.scenesCount ?? 0;
    this.ui.showDialog({
      title: 'Two save files found',
      text: `This device has ${localScenes} scenes and the cloud has a different save with ${remoteScenes} scenes. Both are safe — which should continue from here?`,
      buttons: [
        { label: `Keep this device (${localScenes} scenes)`, primary: true, action: async () => {
          await this.platform._api('/api/v1/save', { method: 'PUT', body: JSON.stringify({ doc: localDoc, baseVersion: remoteDoc.v }) });
          this.ui.toast('This device’s save now syncs to the cloud.');
        } },
        { label: `Use the cloud save (${remoteScenes} scenes)`, action: () => {
          this.progress = remoteDoc;
          this.platform.saveProgress(remoteDoc);
          this._refreshTitle();
          this.ui.toast('Cloud save restored to this device.');
        } },
      ],
    });
  }

  confirmWipe() {
    this.ui.showDialog({
      title: 'Erase local progress?',
      text: 'Journey stars, scenes, achievements, and settings on this device will be deleted. This cannot be undone.',
      buttons: [
        { label: 'Erase everything', danger: true, action: () => {
          for (const k of Object.keys(localStorage)) if (k.startsWith('storyhouse.')) localStorage.removeItem(k);
          location.reload();
        } },
        { label: 'Keep my progress', primary: true },
      ],
    });
  }

  confirmRestart() {
    this.ui.showDialog({
      title: 'Restart this story?',
      text: 'The current arrangement will be lost, but anything already saved stays saved.',
      buttons: [
        { label: 'Restart', danger: true, action: () => this.restartSession('restart confirmed') },
        { label: 'Keep playing', primary: true },
      ],
    });
  }

  // ------------------------------------------------------------ sessions
  _contentFor(mode, setup) {
    if (mode === 'journey') return C.journeyStage(setup.index);
    if (mode === 'daily') return C.dailyContent(setup.date || this.platform.utcToday());
    if (mode === 'learn') return C.lessonContent(setup.lessonId);
    if (mode === 'practice') return C.practiceContent(setup.difficulty, Number(setup.seed) || 1, setup.theme);
    if (mode === 'challenge') return C.challengeContent(setup.challengeId);
    if (mode === 'score') return C.scoreChaseContent(Number(setup.seed) || 1);
    return null;
  }

  startFromSetup() {
    this._startSession(this.setup);
  }

  _startSession(setup, restored = null) {
    const content = restored ? restored.content : this._contentFor(setup.mode, setup);
    if (!content) { this.ui.toast('That content is unavailable.', 'bad'); return; }
    this.mode = setup.mode;
    this.setup = { mode: setup.mode, ...setup };
    this._transition('preparing', `start ${setup.mode}`);

    this._theme = C.THEMES[content.theme] || C.THEMES.meadow;
    this.audio.setTheme(this._theme);
    if (this.audio.ctx) {
      this.audio.stopMusic();
      this.audio.startMusic(new RngStream(deriveSeed('music', content.seed)));
      this.audio.stopAmbience();
      this.audio.startAmbience();
    }

    this.session = restored || new GameSession(content).start(R.createGame(content));
    this.session.pauseClock(); // the clock starts when the countdown ends, at 'active'
    this.selection = null;
    this.lesson = null;
    if (setup.mode === 'learn') {
      const def = C.LESSONS.find(l => l.id === (setup.lessonId || content.contentId));
      if (def) this.lesson = { def, stepIndex: 0 };
    }

    this.stage.startSession({ content, theme: this._theme, state: this.session.state });
    this.ui.showScreen(null);
    this.ui.setHudVisible(true);
    this.ui.closeDrawers();
    this.ui.setMirrorVisible(!!this._textModeOn);
    this.platform.activityStart();
    this.platform.telemetry('start', { mode: setup.mode });
    this._syncAll();

    // Countdown → active.
    this._transition('countdown', 'session prepared');
    this.input.enabled = false;
    const seq = this.settings.reducedMotion ? ['Go'] : ['3', '2', '1', 'Go'];
    let i = 0;
    this.ui.live(`${content.label}. ${this._objectiveText()}`);
    const step = () => {
      if (!this.session) return;
      if (i < seq.length) {
        this.ui.countdown(seq[i]);
        this.audio.sfx(i === seq.length - 1 ? 'go' : 'countdown');
        i++;
        this._cdTimer = setTimeout(step, this.settings.reducedMotion ? 500 : 700);
      } else {
        this.ui.countdown(null);
        this.session.resumeClock();
        this.input.enabled = true;
        this.stage.setRunning(true);
        this._transition('active', 'countdown complete');
        this._startTicker();
      }
    };
    step();
  }

  _startTicker() {
    clearInterval(this._tickTimer);
    let autosave = 0;
    this._tickTimer = setInterval(() => {
      if (!this.session) return;
      if (this.state === 'active') {
        const r = this.session.tickClock();
        if (r) {
          this.audio.sfx('timeout');
          this._handleEvents(r.events);
          return;
        }
        this._updateHud();
        if (++autosave % 8 === 0) this._saveSnapshot();
      }
    }, 1000);
  }

  restartSession(reason) {
    if (!this.session) return;
    this.platform.telemetry('retry', {});
    this.ui.showPause(false);
    this._startSession({ mode: this.mode, ...this.setup, index: this.setup?.index });
    this.ui.toast('Fresh start — same house, same seed.');
  }

  _saveSnapshot() {
    if (this.session && this.session.state.status === 'active') {
      this.platform.saveSnapshot(this.session.serializeSnapshot());
    }
  }

  resumeSnapshot() {
    const json = this.platform.loadSnapshot();
    if (!json) return;
    const restored = GameSession.restoreSnapshot(json);
    if (!restored) { this.ui.toast('That saved story could not be read.', 'bad'); return; }
    this.mode = restored.content.mode;
    this.setup = { mode: this.mode };
    this._startSession({ mode: this.mode }, restored);
    const ago = Math.round((Date.now() - (restored._savedAt || Date.now())) / 60000);
    this.ui.toast(`Welcome back — restored your paused story${ago >= 1 ? ` from about ${ago} min ago` : ''}.`);
  }

  pauseGame(reason, { silent = false } = {}) {
    if (this.state !== 'active') return;
    this.session.pauseClock();
    this._transition('paused', reason);
    this.input.enabled = false;
    if (!silent) this.ui.showPause(true);
    this._saveSnapshot();
  }
  resumeGame(reason) {
    if (this.state !== 'paused') return;
    this.ui.showPause(false);
    this.session.resumeClock();
    this.input.enabled = true;
    this._awayToastShown = false;
    this._transition('active', reason);
  }

  leaveToTitle() {
    clearTimeout(this._cdTimer);
    clearInterval(this._tickTimer);
    if (this.session?.state.status === 'active') this._saveSnapshot();
    else if (this.session?.state.status === 'terminal') this.platform.clearSnapshot();
    this.session = null;
    this.lesson = null;
    this.platform.activityEnd();
    this.ui.showPause(false);
    this.ui.setHudVisible(false);
    this.ui.countdown(null);
    this.stage.setRunning(false);
    this.input.enabled = false;
    this._refreshTitle();
    this._transition('title', 'leave to title');
  }

  // ------------------------------------------------------------ input
  _inputHandlers() {
    return {
      onTapPiece: (key) => this.tapPiece(key),
      onTapSlot: (slot) => this.tapSlot(slot),
      onTapBackground: () => this.setSelection(null),
      onDragStart: (key) => { this.setSelection(key); this.audio.sfx('pickup'); },
      onDragHover: (key, slot) => this._dragHover(key, slot),
      onDragEnd: (key, slot) => { if (slot) this._placeSelected(slot); else this.stage.setHoverTarget(null); },
      onHover: () => {},
      onCursorMove: () => this.audio.sfx('cursor'),
      onUndo: () => this.undo(),
      onHint: () => this.hint(),
      onCancel: () => this.setSelection(null),
      onPauseKey: () => this.state === 'active' ? this.pauseGame('gamepad') : this.resumeGame('gamepad'),
      onMuteToggle: () => this._applySettings({ mute: !this.settings.mute }),
      onInteractKey: () => this._interactKey(),
      onPieceTouch: () => {},
      onPress: () => this.audio.ensure(),
    };
  }

  _legalSlotsFor(itemKey) {
    const st = this.session.state;
    if (st.moveLimit !== null && st.stats.moves >= st.moveLimit) return [];
    const placed = R.itemSlot(st, itemKey);
    const out = [];
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

  setSelection(key) {
    this.selection = key;
    this.stage.setSelection(key, key ? this._legalSlotsFor(key) : []);
    if (!key) this.stage.setHoverTarget(null);
    this._syncAll();
    if (key) this.audio.sfx('pickup');
  }

  tapPiece(key) {
    if (!this._canAct()) return;
    const st = this.session.state;
    if (!st.items[key]) return;
    if (this.selection === key) { this.setSelection(null); return; }
    if (this.selection && this.selection !== key) {
      // Tapping a second piece in the same room = interact.
      const a = R.itemRoom(st, this.selection);
      const b = R.itemRoom(st, key);
      if (a && b && a.id === b.id) {
        const cmd = { type: 'interact', room: a.id, a: this.selection, b: key };
        const check = R.validateCommand(st, cmd);
        if (check.ok) {
          this._submit(cmd);
          this.setSelection(null);
          return;
        }
        this._invalidAt(check.reason, b.id ? R.itemSlot(st, key) : null);
        this.audio.voiceBlip(key, null);
        this.setSelection(key);
        return;
      }
    }
    this.setSelection(key);
  }

  tapSlot(slot) {
    if (!this._canAct()) return;
    if (this.selection) { this._placeSelected(slot); return; }
    const st = this.session.state;
    const room = R.roomById(st, slot.room);
    const item = room?.slots[slot.slot];
    if (item) this.tapPiece(item);
    else this.ui.toast('Pick a piece from the tray first — then choose a spot.');
  }

  _placeSelected(slot) {
    if (!this.selection || !this._canAct()) return;
    const st = this.session.state;
    const placed = R.itemSlot(st, this.selection);
    const cmd = placed
      ? { type: 'move', item: this.selection, room: slot.room, slot: slot.slot }
      : { type: 'place', item: this.selection, room: slot.room, slot: slot.slot };
    const check = R.validateCommand(st, cmd);
    if (!check.ok) { this._invalidAt(check.reason, slot); return; }
    this._submit(cmd);
    // Keep tray selection flowing: select next tray item for rapid placement.
    this.selection = null;
    this.stage.setSelection(null, []);
    this._syncAll();
  }

  _dragHover(key, slot) {
    if (!slot) { this.stage.setHoverTarget(null); return; }
    const st = this.session.state;
    const placed = R.itemSlot(st, key);
    const cmd = placed
      ? { type: 'move', item: key, room: slot.room, slot: slot.slot }
      : { type: 'place', item: key, room: slot.room, slot: slot.slot };
    const check = R.validateCommand(st, cmd);
    this.stage.setHoverTarget(slot, key, check.ok);
    this._hoverInvalid = check.ok ? null : check.reason;
  }

  _invalidAt(reason, slot) {
    this.ui.announceError(reason);
    this.audio.sfx('invalid');
    if (slot) {
      this.stage.setHoverTarget(slot, null, false);
      setTimeout(() => this.stage.setHoverTarget(null), 600);
    }
  }

  contextAction(a) {
    if (!this._canAct()) return;
    if (a.kind === 'interact') {
      this._submit({ type: 'interact', room: a.room, a: a.a, b: a.b });
      this.setSelection(null);
    } else if (a.kind === 'remove') {
      this._submit({ type: 'remove', item: a.item });
      this.setSelection(null);
    }
  }

  _interactKey() {
    if (!this.selection || !this._canAct()) return;
    const st = this.session.state;
    const room = R.itemRoom(st, this.selection);
    if (!room) return;
    const partner = R.itemsInRoom(st, room.id).find(k => k !== this.selection && R.beatForPair(st, this.selection, k) && !R.hasBeat(st, R.beatForPair(st, this.selection, k).type, room.id, this.selection, k));
    if (partner) {
      this._submit({ type: 'interact', room: room.id, a: this.selection, b: partner });
      this.setSelection(null);
    } else {
      this.ui.toast('No fresh moment available with this piece here.');
    }
  }

  _canAct() {
    return this.state === 'active' && this.session?.state.status === 'active' && !this._resolving;
  }

  _submit(cmd) {
    const r = this.session.submit(cmd);
    this._handleEvents(r.events, cmd);
    return r;
  }

  _handleEvents(events, cmd = null) {
    if (!events.length) return;
    this.stage.playEvents(events, this.session.state);
    for (const e of events) {
      if (e.type === 'placed' || e.type === 'moved') { this.audio.sfx('place'); this._haptic(8); }
      else if (e.type === 'removed') this.audio.sfx('remove');
      else if (e.type === 'beat') {
        this.audio.beatSfx(e.beat.t, e.beat.sig === 1, e.beat.hab === 1, null);
        this.audio.voiceBlip(e.beat.a, null);
        this._haptic([12, 40, 12]);
        this.ui.live(`${e.label} — a new story moment.`);
        this._resolving = true;
        this.input.locked = true;
        setTimeout(() => { this._resolving = false; this.input.locked = false; }, 260);
      }
      else if (e.type === 'card') {
        this.audio.cardSfx();
        this.ui.toast(`◆ Discovery complete: ${e.card.title} (+${e.card.points})`, 'good');
        this._haptic([20, 60, 20]);
      }
      else if (e.type === 'invalid') {
        // Engine-level rejection (should be rare — UI pre-validates).
        if (cmd) this._invalidAt(e.reason, null);
      }
      else if (e.type === 'gameover') {
        this.platform.telemetry('round-end', { mode: this.mode });
        setTimeout(() => this._showResults(e), this.settings.reducedMotion ? 300 : 1400);
        this._transition('resolving', `terminal: ${e.reason}`);
        this.input.enabled = false;
      }
    }
    this._afterCommand(cmd);
    this._syncAll();
  }

  _afterCommand(cmd) {
    // Lesson step tracking.
    if (this.lesson && cmd) {
      const step = this.lesson.def.steps[this.lesson.stepIndex];
      if (step && this._stepSatisfied(step.require, cmd)) {
        this.lesson.stepIndex++;
        this.platform.telemetry('tutorial-step', { lesson: this.lesson.def.id, step: this.lesson.stepIndex });
        if (this.lesson.stepIndex >= this.lesson.def.steps.length) {
          this.progress.lessons[this.lesson.def.id] = true;
          this.settings.tutorialsDone[this.lesson.def.id] = true;
          this._saveSettingsQuiet();
          this.ui.toast(`Lesson complete: ${this.lesson.def.title} ✓`, 'good');
        } else {
          this.audio.sfx('hint');
          this.ui.live(`Lesson step ${this.lesson.stepIndex + 1}: ${this.lesson.def.steps[this.lesson.stepIndex].text}`);
        }
        this.platform.saveProgress(this.progress);
      }
    }
    // Adaptive music follows progress.
    const total = this.session.state.cardDefs.length;
    if (total) this.audio.setMusicIntensity(this.session.state.cardDefs.filter(c => this.session.state.cards[c.id] === 1).length / total);
  }

  _stepSatisfied(req, cmd) {
    const st = this.session.state;
    if (req.type === 'custom') {
      if (req.check === 'cards-done') return st.cardDefs.every(c => st.cards[c.id] === 1);
      if (req.check.startsWith('together:')) {
        const [, a, b] = req.check.split(':');
        const ra = R.itemRoom(st, a), rb = R.itemRoom(st, b);
        return !!ra && !!rb && ra.id === rb.id;
      }
      return false;
    }
    if (cmd.type !== req.type) return false;
    if (req.item && cmd.item !== req.item) return false;
    if (req.roomType) {
      const room = R.roomById(st, cmd.room);
      if (room?.type !== req.roomType) return false;
    }
    return true;
  }

  hint() {
    if (!this._canAct()) return;
    const s = R.suggestAction(this.session.state);
    if (!s) return;
    this.audio.sfx('hint');
    let text;
    if (s.type === 'place' || s.type === 'move') {
      const room = R.roomById(this.session.state, s.room);
      text = `${s.why} Try ${s.type === 'place' ? 'placing' : 'moving'} ${this.session.state.items[s.item].name} to the ${room.name}.`;
      this.setSelection(s.item);
      this.stage.focusRoom(s.room);
    } else if (s.type === 'interact') {
      text = `${s.why} Try ${this.session.state.items[s.a].name} with ${this.session.state.items[s.b].name} in the ${R.roomById(this.session.state, s.room).name}.`;
      this.setSelection(s.a);
      this.stage.focusRoom(s.room);
    } else {
      text = `${s.why} Press “Save scene ✦” when you are ready.`;
    }
    this.ui.toast(text, 'good');
    this.ui.live(text);
  }

  undo() {
    if (!this._canAct()) return;
    const prev = this.session.undo();
    if (!prev) { this.ui.toast('Nothing to undo.'); return; }
    this.audio.sfx('undo');
    this.selection = null;
    this.stage.setSelection(null, []);
    this.stage.settleAll(this.session.state);
    this.ui.toast('Undone.');
    this._syncAll();
  }

  finish() {
    if (!this._canAct()) return;
    const st = this.session.state;
    const pending = st.cardDefs.filter(c => st.cards[c.id] === 0);
    if (pending.length && st.beats.length === 0) {
      this.ui.showDialog({
        title: 'Save an empty story?',
        text: 'No moments have happened yet, and discovery cards are still open. Save anyway?',
        buttons: [
          { label: 'Save scene', primary: true, action: () => this._submit({ type: 'finish' }) },
          { label: 'Keep playing' },
        ],
      });
      return;
    }
    this._submit({ type: 'finish' });
  }

  _haptic(pattern) {
    if (this.settings.hapticsOff) return;
    try { navigator.vibrate?.(pattern); } catch {}
  }

  // ------------------------------------------------------------ HUD sync
  _syncAll() {
    if (!this.session) return;
    const st = this.session.state;
    this.input.setContext({
      state: st,
      selection: this.selection,
      bindings: this.settings.bindings,
      gamepadMap: this.settings.gamepad,
      dragMode: this.settings.dragMode,
    });
    this.ui.setTray(
      st.tray.map(key => ({ key, name: st.items[key].name, kind: st.items[key].kind })),
      this.selection,
    );
    this.ui.mirror(st, this.selection, (a) => {
      if (a.tray) this.tapPiece(a.tray);
      else if (a.item) this.tapPiece(a.item);
      else this.tapSlot({ room: a.room, slot: a.slot });
    });
    this._updateHud();
  }

  _objectiveText() {
    const st = this.session.state;
    if (this.lesson) return this.lesson.def.intro;
    const total = st.cardDefs.length;
    const done = st.cardDefs.filter(c => st.cards[c.id] === 1).length;
    if (st.moveLimit !== null) return `Move limit: ${st.moveLimit}. Cards ${done}/${total}. End by saving the scene — it ends itself at the limit.`;
    if (st.timeLimitMs !== null) return `Beat the clock (${st.timeLimitMs / 1000}s). Cards ${done}/${total}. Speed adds bonus.`;
    return total ? `Discovery cards ${done}/${total} — or play freely, then save the scene.` : 'Play freely, then save the scene.';
  }

  _updateHud() {
    if (!this.session) return;
    const st = this.session.state;
    const score = R.scoreState(st);
    const movesText = st.moveLimit !== null ? `Moves ${st.stats.moves}/${st.moveLimit}` : `Moves ${st.stats.moves}`;
    let clockText = '', clockWarn = false;
    if (st.timeLimitMs !== null) {
      const left = Math.max(0, st.timeLimitMs - this.session.elapsedMs());
      clockText = `⏱ ${Math.ceil(left / 1000)}s`;
      clockWarn = left < 15000;
    } else {
      clockText = `⏱ ${Math.floor(this.session.elapsedMs() / 1000)}s`;
    }

    // Context actions for the current selection.
    let selectionDesc = 'Nothing selected. Tap a piece to pick it up.';
    const ctx = [];
    if (this.selection) {
      const item = st.items[this.selection];
      const placed = R.itemSlot(st, this.selection);
      selectionDesc = placed
        ? `${item.name} — in the ${placed.room.name}. Tap a glowing spot to move, or:`
        : `${item.name} — on the tray. Tap a glowing spot to place.`;
      if (placed) {
        const others = R.itemsInRoom(st, placed.room.id).filter(k => k !== this.selection);
        for (const other of others) {
          const beat = R.beatForPair(st, this.selection, other);
          if (beat && !R.hasBeat(st, beat.type, placed.room.id, this.selection, other)) {
            ctx.push({ kind: 'interact', room: placed.room.id, a: this.selection, b: other, label: `✦ ${R.BEATS[beat.type].label}: ${item.name} + ${st.items[other].name}` });
          }
        }
        ctx.push({ kind: 'remove', item: this.selection, label: `↩ Return ${item.name} to the tray` });
      }
    }

    const lessonView = this.lesson ? {
      title: this.lesson.def.title,
      stepText: this.lesson.stepIndex < this.lesson.def.steps.length
        ? this.lesson.def.steps[this.lesson.stepIndex].text
        : 'Lesson complete — saving…',
      progress: `Step ${Math.min(this.lesson.stepIndex + 1, this.lesson.def.steps.length)} of ${this.lesson.def.steps.length}`,
    } : null;

    const pending = st.cardDefs.filter(c => st.cards[c.id] === 0).length;
    this.ui.updateHud({
      stageTitle: this.session.content.label || this.session.content.contentId,
      objective: this._objectiveText(),
      movesText, clockText, clockWarn,
      scoreText: `★ ${score.total}`,
      canUndo: this.session.canUndo(),
      canHint: this.state === 'active',
      finishNote: pending ? `${pending} card${pending > 1 ? 's' : ''} still open` : (st.cardDefs.length ? 'All cards complete ✓' : ''),
      cards: st.cardDefs.map(c => ({ ...c, done: st.cards[c.id] === 1 })),
      beats: st.beats.map(b => ({
        label: R.BEATS[b.t].label, sig: b.sig === 1, hab: b.hab === 1,
        who: `${st.items[b.a].name} + ${st.items[b.b].name}`,
        room: R.roomById(st, b.room)?.name ?? b.room,
      })),
      selectionDesc,
      contextActions: ctx,
      lesson: lessonView,
    });
  }

  // ------------------------------------------------------------ results
  _showResults(gameoverEvent) {
    if (!this.session) return; // left to title during the resolution window
    const st = this.session.state;
    const score = R.scoreState(st);
    this.platform.clearSnapshot();
    this.stage.settleAll(st); // exact deterministic end state before leaving

    // Progression updates.
    const p = this.progress;
    const today = this.platform.utcToday();
    if (!p.daysPlayed.includes(today)) p.daysPlayed.push(today);
    for (const b of st.beats) if (!p.beatsSeen.includes(b.t)) p.beatsSeen.push(b.t);
    for (const c of st.cardDefs) {
      const key = `${st.contentId}/${c.id}`;
      if (st.cards[c.id] === 1 && !p.cardsCollected.includes(key)) p.cardsCollected.push(key);
    }
    if (this.mode === 'journey') {
      const rec = p.journey[st.contentId] || { stars: 0, score: 0 };
      rec.stars = Math.max(rec.stars, score.stars);
      rec.score = Math.max(rec.score, score.total);
      p.journey[st.contentId] = rec;
    }
    p.bestScores[st.contentId] = Math.max(p.bestScores[st.contentId] || 0, score.total);
    if (this.mode === 'daily') p.lastDaily = { date: today, total: score.total };
    p.scenesCount++;

    // Achievements (idempotent).
    const newly = [];
    const unlock = (id, cond) => {
      if (cond && !p.achievements[id]) {
        this.platform.unlockAchievement(id, p);
        newly.push(C.ACHIEVEMENTS.find(a => a.id === id));
      }
    };
    unlock('first-scene', true);
    unlock('mechanic-master', p.beatsSeen.length >= Object.keys(R.BEATS).length);
    unlock('streak-3', p.daysPlayed.length >= 3);
    unlock('mastery-crown', !!this.session.content.mastery && score.stars >= 3);
    unlock('curator', p.cardsCollected.length >= 25);
    this.progress = this.platform.saveProgress(p);

    // Scene into the scrapbook.
    const scene = {
      id: this.session.sessionId,
      contentId: st.contentId,
      label: this.session.content.label || st.contentId,
      theme: this._theme.id,
      date: new Date().toLocaleDateString(),
      savedAt: Date.now(),
      score: score.total, stars: score.stars,
      beats: st.beats.map(b => R.BEATS[b.t].label),
      cardsDone: score.cardsDone, cardsTotal: score.cardsTotal,
      thumbnail: this.stage.captureThumbnail(),
      seed: st.seed,
      replay: this.session.replayEnvelope(VERSIONS),
    };
    this.platform.saveScene(scene);

    // Ranked submission.
    let compareText = '';
    const ranked = this.session.content.ranked && !this.settings.timingAssist;
    if (ranked) {
      compareText = 'Submitting to the leaderboard…';
      const submission = {
        mode: this.mode, contentId: st.contentId, seed: st.seed,
        ruleset: R.RULESET_VERSION, contentVersion: C.CONTENT_VERSION,
        sessionId: this.session.sessionId,
        commands: this.session.commands.filter(c => c.accepted).map(c => c.cmd),
        clientHash: R.hashState(st),
        assists: { undo: false, timingAssist: false },
        settings: { difficulty: this.mode === 'practice' ? this.setup?.difficulty : undefined },
        score: { total: score.total, components: { moments: score.moments, discoveries: score.discoveries, coverage: score.coverage, variety: score.variety, timeBonus: score.timeBonus }, cardsDone: score.cardsDone, invalid: score.invalid, elapsedMs: score.elapsedMs, stars: score.stars },
      };
      this.platform.submitScore(submission).then(async (r) => {
        const el = document.getElementById('results-compare');
        if (!el) return;
        if (r?.entry) {
          const board = await this.platform.leaderboard(this.mode === 'daily' ? 'daily' : 'global', { contentId: st.contentId });
          const rank = board.entries.findIndex(e => e.sessionId === r.entry.sessionId) + 1;
          const label = r.source === 'server' ? 'leaderboard' : 'local board (casual — offline)';
          el.textContent = rank > 0
            ? `Placed #${rank} of ${board.entries.length} on the ${label}.`
            : `Score saved to the ${label}.`;
        } else {
          el.textContent = `Score not submitted (${r?.error || 'offline'}) — saved locally instead.`;
        }
      });
    } else if (this.settings.timingAssist && this.session.content.ranked) {
      compareText = 'Timing assistance is on — this score is casual and was not submitted.';
    }

    const headline = {
      'scene-saved': 'Scene saved ✦',
      'move-limit': 'Out of moves — scene saved',
      'time-up': 'Time! — scene saved',
    }[st.terminalReason] || 'Scene saved';

    this.ui.results({
      headline,
      stars: score.stars,
      total: score.total,
      rows: [
        ['Story moments', `${score.moments} (${score.beats} beats)`],
        ['Discoveries', `${score.discoveries} (${score.cardsDone}/${score.cardsTotal} cards)`],
        ['Room coverage', score.coverage],
        ['Variety', score.variety],
        ...(score.timeBonus ? [['Time bonus', score.timeBonus]] : []),
        ['Moves used', score.moves],
        ['Elapsed', `${Math.floor(score.elapsedMs / 1000)}s`],
        ['Invalid actions', score.invalid],
      ],
      cards: st.cardDefs.map(c => ({ title: c.title, done: st.cards[c.id] === 1 })),
      achievements: newly,
      compareText,
      nextLabel: this._nextLabel(),
      summary: `${score.beats} moments, ${score.cardsDone} of ${score.cardsTotal} cards.`,
    });
    this.audio.sfx('finish');
    this._transition('results', `score ${score.total}`);
  }

  _nextLabel() {
    if (this.mode === 'journey') return this.setup?.index + 1 < C.journeyLength() ? 'Next stage →' : 'Journey map';
    if (this.mode === 'learn') {
      const i = C.LESSONS.findIndex(l => l.id === this.lesson?.def.id);
      return i + 1 < C.LESSONS.length ? 'Next lesson →' : 'Begin the Journey →';
    }
    if (this.mode === 'daily') return 'Open scrapbook';
    if (this.mode === 'challenge') return 'Next challenge →';
    if (this.mode === 'score') return 'New seed →';
    return 'Play again';
  }

  resultsNext() {
    if (this.mode === 'journey') {
      const next = (this.setup?.index ?? this._nextJourneyIndex()) + 1;
      if (next < C.journeyLength()) {
        this.setup = { mode: 'journey', index: next };
        this._startSession(this.setup);
        return;
      }
      return this.openJourneyMap();
    }
    if (this.mode === 'learn') {
      const i = C.LESSONS.findIndex(l => l.id === this.lesson?.def.id);
      if (i + 1 < C.LESSONS.length) {
        this.setup = { mode: 'learn', lessonId: C.LESSONS[i + 1].id };
        this._startSession(this.setup);
        return;
      }
      this.setup = { mode: 'journey', index: 0 };
      this._startSession(this.setup);
      return;
    }
    if (this.mode === 'daily') return this.openScrapbook();
    if (this.mode === 'challenge') {
      const i = C.CHALLENGES.findIndex(c => c.id === this.setup?.challengeId);
      this.setup = { mode: 'challenge', challengeId: C.CHALLENGES[(i + 1) % C.CHALLENGES.length].id };
      this._startSession(this.setup);
      return;
    }
    if (this.mode === 'score') {
      this.setup = { mode: 'score', seed: String(Math.floor(Math.random() * 89999) + 10000) };
      this._startSession(this.setup);
      return;
    }
    this.restartSession('next');
  }

  _saveSettingsQuiet() {
    try { localStorage.setItem('storyhouse.settings.v1', JSON.stringify(this.settings)); } catch {}
  }
}

// ---------------------------------------------------------------------------
const app = new App();
app.boot();
window.storyhouse = app; // inspectable for support/debugging
