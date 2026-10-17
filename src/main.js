// main.js — composition root. Owns the game-state machine
//   boot → title → profile-ready → mode-select → preparing → countdown
//        → active ↔ paused → resolving → results → progression
// Every transition has one owner and an explicit reason. Rules state changes
// only through GameSession commands; the renderer consumes snapshots+events.
import { Stage } from './render.js';
import { UI } from './ui.js';
import { Input } from './ui-input.js';
import { AudioEngine } from './audio.js';
import { Platform, BUILD } from './platform.js?v=production-qa-1';
import { GameSession } from './session.js';
import { defaultSettings, defaultBindings, codeLabel } from './persist.js';
import { shText } from './sh-i18n.js';
import { GraphicsPanel } from './gfx-panel.js';
import * as R from './rules.js';
import * as C from './content.js';
import { RngStream, deriveSeed } from './rng.js';
import { T, onLanguage, currentLang } from './i18n.js';
import { itemName, roomName, roomTypeName, beatLabel, layoutLabel, themeLabel, cardTitle, cardText, contentLabel, contentBlurb } from './loc.js';

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
  setGraphics() {} graphicsInfo() { return null; } setBackdrop() {} setReducedMotion() {}
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
    this.platform.onSyncChange = () => this._refreshTitle();
    this.platform.onAuthChange = (a) => {
      if (!a.signedIn) this.ui.toast(shText('signedOut'));
      this._refreshTitle();
    };

    // Renderer (or text-mode fallback).
    if (Stage.webglAvailable()) {
      this.stage = new Stage(document.getElementById('gl'), {
        onGraphicsInfo: () => this.gfxPanel?.sync(),
        onContextLost: () => this.ui.toast(T('Graphics context lost — rebuilding…'), 'bad'),
        onContextRestored: () => this.ui.toast(T('Graphics restored.')),
      });
      if (!this.stage.init()) this.stage = null;
    }
    if (!this.stage) {
      this.stage = new NullStage();
      this.ui.showCompat();
    }

    this.input = new Input(document.getElementById('gl'), this.stage, this._inputHandlers());
    this.gfxPanel = new GraphicsPanel(document.getElementById('gfx-panel'), {
      get: () => this.settings.gfx,
      set: (gfx) => this._applySettings({ gfx }),
      info: (words) => this.stage.graphicsInfo(words),
      lang: () => currentLang(),
    });
    this._applySettings();
    this._bindGlobalKeys();
    this._bindLifecycle();
    this._refreshTitle();
    // Language change (Settings → Language): redraw everything built in code in place.
    onLanguage(() => this.relocalize());
    // Another device saved first: the platform merged its cloud doc into ours.
    this.platform.onConflictMerged = () => { this.progress = this.platform.loadProgress(); this._refreshTitle(); };
    this._transition('title', 'boot complete');

    // Identity in the background: title → profile-ready, then merge the
    // cloud save with this device's (localStorage stays the offline cache),
    // the platform-stored preferences and the player's control bindings.
    this.platform.ensureProfile().then(async () => {
      const [prefs, bindings] = await Promise.all([
        this.platform.loadPlatformSettings(this.settings),
        this.platform.loadBindings(defaultBindings()),
      ]);
      if (prefs && Object.keys(prefs).length) this._applySettings(prefs);
      if (bindings) this._applySettings({ bindings: { ...this.settings.bindings, ...bindings } });
      const remote = await this.platform.loadCloudSave();
      if (remote && this.platform.adoptRemoteProgress(remote)) {
        this.progress = this.platform.loadProgress();
        this.ui.toast(T('Cloud save restored to this device.'));
      }
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
    if (to === 'title' || to === 'profile-ready') { this.ui.showScreen('title'); this._syncBackdrop(); }
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
      sync: this.platform.hosted ? this.platform.syncLabel() : null,
      hasSnapshot: !!this.platform.loadSnapshot(),
      canSignIn: this.platform.canSignIn(),
      canInvite: !!this.platform.inviteLink(),
    });
  }

  // ------------------------------------------------------------ settings
  _applySettings(patch = {}) {
    Object.assign(this.settings, patch);
    this.ui.applySettingsClasses(this.settings);
    this._applyAudioSettings();
    this.ui.setCaptions(this.settings.captions);
    this.platform.setTelemetryConsent(this.settings.telemetry);
    this.stage.setReducedMotion(this.settings.reducedMotion);
    this.ui.setKeyHints(this.settings.bindings);
    // Graphics apply live, but only when they changed (recompiles materials).
    const gfxKey = JSON.stringify(this.settings.gfx || {});
    if (gfxKey !== this._gfxKey) {
      this._gfxKey = gfxKey;
      this.stage.setGraphics(this.settings.gfx);
      this._syncBackdrop();
    }
    this.platform.saveSettings(this.settings);
  }

  /** Title backdrop: a furnished demo house behind the menus when no story is open. */
  _syncBackdrop() {
    if (this.session || !this.stage?.q) return;
    const mode = this.stage.q.backdrop;
    if (mode === 'off' || document.hidden) {
      this.stage.setBackdrop(null);
      this.stage.setRunning(false);
      document.body.classList.remove('has-backdrop');
      document.body.classList.add('no-scene');
      return;
    }
    if (!this.stage.backdrop) {
      const content = C.practiceContent('standard', 3, 'meadow');
      const state = R.createGame(content);
      const tray = state.tray.slice();
      for (const room of state.rooms) {
        for (let k = 0; k < Math.min(2, room.slots.length) && tray.length; k++) room.slots[k] = tray.shift();
      }
      state.tray = tray;
      this.stage.startSession({ content, theme: C.THEMES[content.theme] || C.THEMES.meadow, state });
    }
    this.stage.setBackdrop(mode);
    this.stage.setRunning(true);
    document.body.classList.add('has-backdrop');
    document.body.classList.remove('no-scene');
  }
  _applyAudioSettings() {
    for (const bus of ['music', 'effects', 'ambience', 'voice']) this.audio.setVolume(bus, this.settings[bus]);
    this.audio.setMuted(this.settings.mute);
  }

  _bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const is = (a) => (this.settings.bindings[a] || []).includes(e.code);
      if (is('cancel')) {
        if (this.state === 'active') this.pauseGame('esc key');
        else if (this.state === 'paused') this.resumeGame('esc key');
      } else if (is('pause') && (this.state === 'active' || this.state === 'paused')) {
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
        this._syncBackdrop();
        if (this.session && this.state === 'paused') {
          this.stage.setRunning(true);
          if (this._awayAt && !this._awayToastShown) {
            const mins = Math.round((Date.now() - this._awayAt) / 60000);
            this.ui.toast(mins >= 1 ? T('Welcome back — paused while you were away for about {n} min. Nothing moved without you.', { n: mins }) : T('Welcome back — paused while you were away. Nothing moved without you.'));
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
      onOpenSettings: () => { this._fromPause = this.state === 'paused'; this.ui.showPause(false); this.openSettings(); },
      onOpenHelp: () => { this._fromPause = this.state === 'paused'; this.ui.showPause(false); this.openHelp(); },
      onRestart: () => this.confirmRestart(),
      onLeave: () => this.leaveToTitle(),
      onHint: () => this.hint(),
      onCameraReset: () => this.stage?.resetCamera(),
      onUndo: () => this.undo(),
      onFinish: () => this.finish(),
      onSetupStart: () => this.startFromSetup(),
      onResultsNext: () => this.resultsNext(),
      onResultsReplay: () => this.restartSession('replay button'),
      onTraySelect: (key) => this.tapPiece(key),
      onContextAction: (a) => this.contextAction(a),
      onDeleteScene: (id) => { this.platform.deleteScene(id); this.openScrapbook(); },
      onResetBindings: () => { const d = defaultSettings(); this.settings.bindings = d.bindings; this.settings.gamepad = d.gamepad; this.platform.resetBindings(); this._applySettings(); this.openSettings(); },
      onSignIn: () => this.platform.signIn(),
      onInvite: () => this.copyInvite(),
      onReplayTutorials: () => { this.progress.lessons = {}; this.platform.saveProgress(this.progress); this.goto('learn'); },
      onWipe: () => this.confirmWipe(),
      onTextMode: () => { this._textModeOn = true; this.ui.setMirrorVisible(true); this.ui.toast(T('Text mode: the whole house is playable from the panel and tray.')); },
      onToggleMirror: () => { this._textModeOn = !this._textModeOn; this.ui.setMirrorVisible(this._textModeOn); },
      onSound: (name) => this.audio.sfx(name),
    };
  }

  goto(where) {
    this.audio.sfx(where === 'title' ? 'back' : 'open');
    if (where === 'title') {
      // Settings/help opened from the pause overlay return to the paused game.
      // Opening them moved the machine to 'mode-select', so the paused phase is
      // restored here — otherwise Resume would find no paused game to resume.
      if (this._fromPause && this.session?.state.status === 'active') {
        this._fromPause = false;
        this.ui.showScreen(null);
        this._transition('paused', 'closed a menu opened from pause');
        this.ui.showPause(true);
        return;
      }
      this._fromPause = false;
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
    // Field labels and option texts keep their English key (data-key) so a
    // language change can relabel them without rebuilding the fields.
    const mk = (label, input) => {
      const l = document.createElement('label');
      l.style.display = 'flex'; l.style.justifyContent = 'space-between'; l.style.alignItems = 'center'; l.style.gap = '10px';
      const s = document.createElement('span'); s.dataset.key = label; s.textContent = T(label);
      l.append(s, input);
      return l;
    };
    const select = (opts, val) => {
      const s = document.createElement('select');
      for (const [v, t, suffix = ''] of opts) {
        const o = document.createElement('option'); o.value = v; o.dataset.key = t; o.dataset.suffix = suffix; o.textContent = T(t) + suffix;
        s.appendChild(o);
      }
      s.value = val;
      return s;
    };
    // Each setup view is kept as a thunk: a language change re-runs it with the same choices.
    const show = (view) => {
      this._setupView = () => this.ui.setupScreen(view());
      this._setupFields = fields;
      this._setupView();
    };

    if (mode === 'daily') {
      const content = C.dailyContent(today);
      this.setup = { mode, date: today };
      const done = this.progress.lastDaily?.date === today;
      const leftMs = this.platform.msToNextDaily();
      const leftH = Math.floor(leftMs / 3600000), leftM = Math.ceil((leftMs % 3600000) / 60000);
      show(() => ({
        mode: 'Daily Story',
        facts: [['Date (UTC)', today], ['House', layoutLabel(content.layout)], ['Pieces', content.tray.length],
          ['Discovery cards', content.cards.length], ['Seed', String(content.seed)],
          ['Expected time', T('3–6 minutes')], ['Players', T('1 — scores compared asynchronously')],
          ['Next daily in', T('{h}h {m}m (server-synced)', { h: leftH, m: leftM })],
          done ? ['Today', T('Completed — replay to improve')] : ['Today', T('Not yet played')]],
        ranked: true, rankedNote: 'one shared seed and ruleset for everyone today',
        startLabel: done ? 'Replay today' : 'Start today’s story',
      }));
    } else if (mode === 'learn') {
      const nextLesson = C.LESSONS.find(l => !this.progress.lessons[l.id]) || C.LESSONS[0];
      const sel = select(C.LESSONS.map(l => [l.id, l.title, this.progress.lessons[l.id] ? ' ✓' : '']), nextLesson.id);
      sel.addEventListener('change', () => { this.setup.lessonId = sel.value; this.audio.sfx('tab'); });
      fields.appendChild(mk('Lesson', sel));
      this.setup = { mode, lessonId: nextLesson.id };
      show(() => ({
        mode: 'Learn',
        facts: [['Lessons', T('{n} interactive', { n: C.LESSONS.length })], ['This lesson', T(nextLesson.title)],
          ['Rules', T('One new idea at a time — you perform each action')], ['Expected time', T('1–3 minutes')]],
        ranked: false, rankedNote: 'lessons are never ranked',
        startLabel: 'Start lesson', fields,
      }));
    } else if (mode === 'practice') {
      const diff = select(Object.entries(C.PRACTICE_DIFFICULTIES).map(([k, v]) => [k, v.label]), 'cozy');
      const theme = select(C.THEME_ORDER.map(t => [t, C.THEMES[t].label]), this._theme.id);
      const seedInput = document.createElement('input');
      seedInput.type = 'text'; seedInput.inputMode = 'numeric';
      seedInput.value = String(Math.floor(Math.random() * 899999) + 100000);
      seedInput.setAttribute('aria-label', T('Seed'));
      diff.addEventListener('change', () => { this.setup.difficulty = diff.value; this.audio.sfx('tab'); this._updateSetupFacts(); });
      theme.addEventListener('change', () => { this.setup.theme = theme.value; this.audio.sfx('tab'); });
      seedInput.addEventListener('change', () => { this.setup.seed = seedInput.value.replace(/\D/g, '') || '1'; });
      fields.append(mk('Difficulty', diff), mk('Theme', theme), mk('Seed (inspectable)', seedInput));
      this.setup = { mode, difficulty: 'cozy', theme: this._theme.id, seed: seedInput.value };
      show(() => ({
        mode: 'Practice',
        facts: this._practiceFacts(this.setup.difficulty),
        ranked: false, rankedNote: 'undo enabled, no effect on ratings',
        startLabel: 'Start practicing', fields,
      }));
      this._setupFactsFor = (d) => this._practiceFacts(d);
    } else if (mode === 'challenge') {
      const sel = select(C.CHALLENGES.map(c => [c.id, c.label]), C.CHALLENGES[0].id);
      const update = () => {
        this.setup.challengeId = sel.value;
        const c = C.challengeContent(sel.value);
        show(() => ({
          mode: 'Challenge',
          facts: [['Challenge', T(c.label)], ['House', layoutLabel(c.layout)], ['Pieces', c.tray.length],
            ['Discovery cards', c.cards.length],
            ...(c.moveLimit ? [['Move limit', c.moveLimit]] : []),
            ...(c.timeLimitMs ? [['Time limit', T('{n}s · speed scores bonus', { n: c.timeLimitMs / 1000 })]] : []),
            ['Undo', c.allowUndo ? T('Allowed') : T('Off')], ['Expected time', T('3–8 minutes')]],
          ranked: c.ranked, rankedNote: c.ranked ? 'validated replay on the leaderboard' : 'unranked',
          startLabel: 'Take the challenge', fields,
        }));
      };
      sel.addEventListener('change', () => { this.audio.sfx('tab'); update(); });
      this.setup = { mode, challengeId: sel.value };
      fields.appendChild(mk('Challenge', sel));
      update();
    } else if (mode === 'score') {
      const seedInput = document.createElement('input');
      seedInput.type = 'text'; seedInput.inputMode = 'numeric';
      seedInput.value = String(Math.floor(Math.random() * 89999) + 10000);
      seedInput.setAttribute('aria-label', T('Seed'));
      seedInput.addEventListener('change', () => { this.setup.seed = seedInput.value.replace(/\D/g, '') || '1'; });
      fields.appendChild(mk('Seed (share it, race it)', seedInput));
      this.setup = { mode, seed: seedInput.value };
      show(() => ({
        mode: 'Score Chase',
        facts: [['House', T('Manor')], ['Pieces', T('7, seeded')], ['Discovery cards', T('4, seeded')],
          ['Expected time', T('4–8 minutes')], ['Validation', T('server replays your input log')]],
        ranked: true, rankedNote: 'global and friends boards on this seed',
        startLabel: 'Chase the score', fields,
      }));
    }
  }
  _practiceFacts(d) {
    const dd = C.PRACTICE_DIFFICULTIES[d];
    return [['Difficulty', T(dd.label)], ['House', layoutLabel(C.LAYOUTS[dd.layout])], ['Pieces', dd.chars + dd.props],
      ['Discovery cards', dd.cards.length], ['Move limit', dd.limited ? T('Yes — tight') : T('None')],
      ['Undo', T('Allowed')], ['Expected time', T('2–7 minutes')]];
  }
  _updateSetupFacts() {
    if (this.mode === 'practice' && this.setup && this._setupView) this._setupView();
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
    this._journeyArgs = chapters;
    this.ui.journeyMap(chapters, this.progress, (index) => {
      this.mode = 'journey';
      this._startSession({ mode: 'journey', index });
    });
    this.ui.showScreen('journey');
  }

  openScrapbook() {
    this._transition('mode-select', 'scrapbook');
    this._renderScrapbook();
    this.ui.showScreen('scrapbook');
  }
  _renderScrapbook() {
    const scenes = this.platform.loadScenes().map((s) => ({ ...s, label: contentLabel({ label: s.label, contentId: s.contentId }) }));
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
  }

  openHelp() {
    this._transition('mode-select', 'help');
    this._renderHelp();
    this.ui.showScreen('help');
  }
  _renderHelp() {
    const sample = C.practiceContent('cozy', 1, 'meadow');
    const st = R.createGame(sample);
    const legal = R.listLegalActions(st);
    const place = legal.find(a => a.type === 'place');
    const b = this.settings.bindings;
    const key = (a) => codeLabel((b[a] || ['?'])[0]);
    this.ui.help({
      ruleCards: [
        { title: 'Make a home', text: 'Place characters and props from the tray into glowing spots. Every piece on the floor is part of the story.', example: place ? () => T('place the {item} in the {room}', { item: itemName(place.item), room: roomName(st.rooms.find(r => r.id === place.room)) }) : null },
        { title: 'Make a moment', text: 'A character and a prop in the same room can interact — that records a story moment. Two characters can share a heart to heart. Props alone cannot interact.', example: 'put Pip and the Old Clock in one room, then interact' },
        { title: 'Signatures & habitats', text: 'Each character has a favorite thing (a golden ✦ signature moment). Moments in their natural room earn a habitat bonus.', example: 'Mabel with the Potted Fern, or tea in the Kitchen' },
        { title: 'Discovery cards', text: 'Optional goals on the left rail. Complete them for points and to grow your collection — or ignore them and play freely.', example: 'check the Goals drawer any time' },
        { title: 'Save the scene', text: 'Finished stories are scored by moments, discoveries, room coverage, and variety — the breakdown is always shown. Scenes persist in your Scrapbook.', example: 'the “Save scene ✦” button ends a story' },
        { title: 'Every action, acknowledged', text: () => T('Confirm with {confirm}, cancel with {cancel}, undo with {undo}, hint with {hint}, camera reset with {camera}. Hints only suggest moves that are legal right now.', { confirm: key('confirm'), cancel: key('cancel'), undo: key('undo'), hint: key('hint'), camera: key('camera') }) },
      ],
      bindings: [
        ...Object.entries(b).filter(([a]) => !['left', 'right', 'up', 'down'].includes(a))
          .map(([a, keys]) => [{
            confirm: 'Confirm / place', cancel: 'Cancel', pause: 'Pause', undo: 'Undo',
            hint: 'Hint', camera: 'Camera reset', mute: 'Mute',
          }[a] || a, keys.map(codeLabel)]),
        ['Move cursor', ['Arrow keys', 'stick / dpad']],
        ['Cycle rooms', ['gamepad shoulder buttons']],
      ],
    });
  }

  openSettings() {
    this._transition('mode-select', 'settings');
    this.ui.bindSettings(this.settings, (patch) => this._applySettings(patch));
    this.gfxPanel?.sync();
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
            // One action per key: steal the code from any other action.
            const changed = { [action]: keys };
            for (const [other, codes] of Object.entries(this.settings.bindings)) {
              if (other !== action && codes.some(c => keys.includes(c))) {
                changed[other] = codes.filter(c => !keys.includes(c));
              }
            }
            Object.assign(this.settings.bindings, changed);
            for (const [a, codes] of Object.entries(changed)) this.platform.saveBinding(a, codes);
            this._applySettings();
            if (Object.keys(changed).length > 1) this.openSettings();
          }
          done(this.settings.bindings[action]);
        });
      }
    });
    this.ui.showScreen('settings');
  }

  async copyInvite() {
    const url = this.platform.inviteLink();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.ui.toast(shText('copied'), 'good');
    } catch {
      this.ui.toast(shText('copyFail', { url }));
    }
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

  /** Inverse of _contentFor: the setup that regenerates this exact content. */
  _setupForContent(content) {
    const mode = content.mode;
    const id = content.contentId || '';
    if (mode === 'journey') return { mode, index: Math.max(0, Number(id.replace(/^journey-/, '')) - 1) };
    if (mode === 'daily') return { mode, date: id.replace(/^daily-/, '') };
    if (mode === 'learn') return { mode, lessonId: id };
    if (mode === 'challenge') return { mode, challengeId: id.replace(/^challenge-/, '') };
    if (mode === 'score') return { mode, seed: id.replace(/^score-/, '') };
    if (mode === 'practice') {
      const m = /^practice-([^-]+)-(.+)$/.exec(id);
      return { mode, difficulty: m?.[1] || 'cozy', seed: m?.[2] || '1', theme: content.theme };
    }
    return { mode };
  }

  startFromSetup() {
    this._startSession(this.setup);
  }

  _startSession(setup, restored = null) {
    const content = restored ? restored.content : this._contentFor(setup.mode, setup);
    if (!content) { this.ui.toast(T('That content is unavailable.'), 'bad'); return; }
    this.mode = setup.mode;
    this.setup = { mode: setup.mode, ...setup };
    clearTimeout(this._cdTimer); // a restart mid-countdown must not run two chains
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
    this._clockWarned = false;
    if (setup.mode === 'learn') {
      const def = C.LESSONS.find(l => l.id === (setup.lessonId || content.contentId));
      if (def) this.lesson = { def, stepIndex: 0 };
    }

    this.stage.startSession({ content, theme: this._theme, state: this.session.state });
    document.body.classList.remove('has-backdrop', 'no-scene');
    this.ui.showScreen(null);
    this.ui.setHudVisible(true);
    this.ui.setPaused(false);
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
    this.ui.live(`${contentLabel(content)}. ${this._objectiveText()}`);
    const step = () => {
      if (!this.session) return;
      if (i < seq.length) {
        this.ui.countdown(T(seq[i]));
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
    this.ui.toast(T('Fresh start — same house, same seed.'));
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
    if (!restored) { this.ui.toast(T('That saved story could not be read.'), 'bad'); return; }
    this.mode = restored.content.mode;
    // Rebuild the setup from the restored content, so Restart and Next can
    // regenerate the same stage instead of asking for an undefined one.
    this.setup = this._setupForContent(restored.content);
    this._startSession(this.setup, restored);
    const ago = Math.round((Date.now() - (restored._savedAt || Date.now())) / 60000);
    this.ui.toast(ago >= 1 ? T('Welcome back — restored your paused story from about {n} min ago.', { n: ago }) : T('Welcome back — restored your paused story.'));
  }

  pauseGame(reason, { silent = false } = {}) {
    if (this.state !== 'active') return;
    this.session.pauseClock();
    this._transition('paused', reason);
    this.input.enabled = false;
    this.ui.setPaused(true);
    if (!silent) { this.ui.showPause(true); this.audio.sfx('pause'); }
    this._saveSnapshot();
  }
  resumeGame(reason) {
    if (this.state !== 'paused') return;
    this.ui.showPause(false);
    this.ui.setPaused(false);
    this.audio.sfx('resume');
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
      onRoomCycle: () => this.audio.sfx('room-enter'),
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
    else this.ui.toast(T('Pick a piece from the tray first — then choose a spot.'));
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
    const now = performance.now();
    if (now - (this._dragSnd || 0) > 180) { this._dragSnd = now; this.audio.sfx('drag'); }
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
      this.ui.toast(T('No fresh moment available with this piece here.'));
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
        this.ui.live(T('{beat} — a new story moment.', { beat: beatLabel(e.beat.t) }));
        this._resolving = true;
        this.input.locked = true;
        setTimeout(() => { this._resolving = false; this.input.locked = false; }, 260);
      }
      else if (e.type === 'card') {
        this.audio.cardSfx();
        this.ui.toast('◆ ' + T('Discovery complete: {card} (+{n})', { card: cardTitle(e.card), n: e.card.points }), 'good');
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
          this.ui.toast(T('Lesson complete: {name} ✓', { name: T(this.lesson.def.title) }), 'good');
        } else {
          this.audio.sfx('tutorial');
          this.ui.live(T('Lesson step {n}: {text}', { n: this.lesson.stepIndex + 1, text: T(this.lesson.def.steps[this.lesson.stepIndex].text) }));
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
    const why = this._hintWhy(s.why);
    if (s.type === 'place' || s.type === 'move') {
      const room = R.roomById(this.session.state, s.room);
      text = why + ' ' + T(s.type === 'place' ? 'Try placing {item} in the {room}.' : 'Try moving {item} to the {room}.', { item: itemName(s.item), room: roomName(room) });
      this.setSelection(s.item);
      this.stage.focusRoom(s.room);
    } else if (s.type === 'interact') {
      text = why + ' ' + T('Try {a} with {b} in the {room}.', { a: itemName(s.a), b: itemName(s.b), room: roomName(R.roomById(this.session.state, s.room)) });
      this.setSelection(s.a);
      this.stage.focusRoom(s.room);
    } else {
      text = why + ' ' + T('Press “Save scene ✦” when you are ready.');
    }
    this.ui.toast(text, 'good');
    this.ui.live(text);
  }

  /** rules.suggestAction's English reason, localized (card titles rebuilt from the card). */
  _hintWhy(why) {
    const m = /^(Works toward|Set up) “(.+)”\.$/.exec(why || '');
    if (m) {
      const def = this.session.state.cardDefs.find((c) => c.title === m[2]);
      const card = def ? cardTitle(def) : T(m[2]);
      return m[1] === 'Set up' ? T('Set up “{card}”.', { card }) : T('Works toward “{card}”.', { card });
    }
    return T(why || '');
  }

  undo() {
    if (!this._canAct()) return;
    const prev = this.session.undo();
    if (!prev) { this.ui.toast(T('Nothing to undo.')); return; }
    this.audio.sfx('undo');
    this.selection = null;
    this.stage.setSelection(null, []);
    this.stage.settleAll(this.session.state);
    this.ui.toast(T('Undone.'));
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
      st.tray.map(key => ({ key, name: itemName(key), kind: st.items[key].kind })),
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
    if (this.lesson) return T(this.lesson.def.intro);
    const total = st.cardDefs.length;
    const done = st.cardDefs.filter(c => st.cards[c.id] === 1).length;
    if (st.moveLimit !== null) return T('Move limit: {limit}. Cards {done}/{total}. End by saving the scene — it ends itself at the limit.', { limit: st.moveLimit, done, total });
    if (st.timeLimitMs !== null) return T('Beat the clock ({n}s). Cards {done}/{total}. Speed adds bonus.', { n: st.timeLimitMs / 1000, done, total });
    return total ? T('Discovery cards {done}/{total} — or play freely, then save the scene.', { done, total }) : T('Play freely, then save the scene.');
  }

  _updateHud() {
    if (!this.session) return;
    const st = this.session.state;
    const score = R.scoreState(st);
    const movesText = st.moveLimit !== null ? T('Moves {n}/{limit}', { n: st.stats.moves, limit: st.moveLimit }) : T('Moves {n}', { n: st.stats.moves });
    let clockText = '', clockWarn = false;
    if (st.timeLimitMs !== null) {
      const left = Math.max(0, st.timeLimitMs - this.session.elapsedMs());
      clockText = `⏱ ${Math.ceil(left / 1000)}s`;
      clockWarn = left < 15000;
      if (clockWarn && !this._clockWarned) { this._clockWarned = true; this.audio.sfx('timer-warn'); }
    } else {
      clockText = `⏱ ${Math.floor(this.session.elapsedMs() / 1000)}s`;
    }

    // Context actions for the current selection.
    let selectionDesc = T('Nothing selected. Tap a piece to pick it up.');
    const ctx = [];
    if (this.selection) {
      const placed = R.itemSlot(st, this.selection);
      const name = itemName(this.selection);
      selectionDesc = placed
        ? T('{name} — in the {room}. Tap a glowing spot to move, or:', { name, room: roomName(placed.room) })
        : T('{name} — on the tray. Tap a glowing spot to place.', { name });
      if (placed) {
        const others = R.itemsInRoom(st, placed.room.id).filter(k => k !== this.selection);
        for (const other of others) {
          const beat = R.beatForPair(st, this.selection, other);
          if (beat && !R.hasBeat(st, beat.type, placed.room.id, this.selection, other)) {
            ctx.push({ kind: 'interact', room: placed.room.id, a: this.selection, b: other, label: `✦ ${beatLabel(beat.type)}: ${name} + ${itemName(other)}` });
          }
        }
        ctx.push({ kind: 'remove', item: this.selection, label: '↩ ' + T('Return {name} to the tray', { name }) });
      }
    }

    const lessonView = this.lesson ? {
      title: T(this.lesson.def.title),
      stepText: this.lesson.stepIndex < this.lesson.def.steps.length
        ? T(this.lesson.def.steps[this.lesson.stepIndex].text)
        : T('Lesson complete — saving…'),
      progress: T('Step {n} of {total}', { n: Math.min(this.lesson.stepIndex + 1, this.lesson.def.steps.length), total: this.lesson.def.steps.length }),
    } : null;

    const pending = st.cardDefs.filter(c => st.cards[c.id] === 0).length;
    this.ui.updateHud({
      stageTitle: contentLabel(this.session.content),
      objective: this._objectiveText(),
      movesText, clockText, clockWarn,
      scoreText: `★ ${score.total}`,
      canUndo: this.session.canUndo(),
      canHint: this.state === 'active',
      finishNote: pending ? T(pending > 1 ? '{n} cards still open' : '{n} card still open', { n: pending }) : (st.cardDefs.length ? T('All cards complete ✓') : ''),
      cards: st.cardDefs.map(c => ({ ...c, title: cardTitle(c), text: cardText(c), done: st.cards[c.id] === 1 })),
      beats: st.beats.map(b => ({
        label: beatLabel(b.t), sig: b.sig === 1, hab: b.hab === 1,
        who: `${itemName(b.a)} + ${itemName(b.b)}`,
        room: roomName(R.roomById(st, b.room)) || b.room,
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
    const firstPlayToday = !p.daysPlayed.includes(today);
    const prevBest = p.bestScores[st.contentId] || 0;
    if (firstPlayToday) p.daysPlayed.push(today);
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
      compareText = this.platform.hosted ? () => shText('lbPosting') : () => T('Submitting to the leaderboard…');
      const submission = {
        mode: this.mode, contentId: st.contentId, seed: st.seed,
        ruleset: R.RULESET_VERSION, contentVersion: C.CONTENT_VERSION,
        sessionId: this.session.sessionId,
        // Full ordered log: rejected commands are not inert (they increment
        // stats.invalid) and undo entries drive the server's snapshot stack,
        // so filtering here would guarantee a hash-mismatch on replay.
        commands: this.session.commands.map(c => c.cmd),
        clientHash: R.hashState(st),
        assists: { undo: false, timingAssist: false },
        settings: { difficulty: this.mode === 'practice' ? this.setup?.difficulty : undefined },
        score: { total: score.total, components: { moments: score.moments, discoveries: score.discoveries, coverage: score.coverage, variety: score.variety, timeBonus: score.timeBonus }, cardsDone: score.cardsDone, invalid: score.invalid, elapsedMs: score.elapsedMs, stars: score.stars },
      };
      const session = this.session;
      if (this.platform.hosted) {
        this.platform.postScore(score.total).then((r) => {
          const el = document.getElementById('results-compare');
          if (!el || this.session !== session) return;
          const line = () => (!r.posted ? shText('lbNotPosted') : r.rank ? shText('lbRank', { rank: r.rank }) : shText('lbPosted'));
          if (this.ui._results) this.ui._results.compareText = line;
          el.textContent = line();
        });
      }
      this.platform.submitScore(submission).then(async (r) => {
        const el = document.getElementById('results-compare');
        if (!el || this.platform.hosted) return; // hosted: the line shows the platform rank
        const board = await this.platform.leaderboard(this.mode === 'daily' ? 'daily' : 'global', { contentId: st.contentId });
        const rank = board.entries.findIndex(e => e.sessionId === r.entry.sessionId) + 1;
        const line = () => (rank > 0
          ? T('Placed #{rank} of {n} on the local board (casual — offline).', { rank, n: board.entries.length })
          : T('Score saved to the local board (casual — offline).'));
        if (this.ui._results) this.ui._results.compareText = line;
        el.textContent = line();
      });
    } else if (this.settings.timingAssist && this.session.content.ranked) {
      compareText = () => T('Timing assistance is on — this score is casual and was not submitted.');
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
        ['Story moments', () => T('{n} ({beats} beats)', { n: score.moments, beats: score.beats })],
        ['Discoveries', () => T('{n} ({done}/{total} cards)', { n: score.discoveries, done: score.cardsDone, total: score.cardsTotal })],
        ['Room coverage', score.coverage],
        ['Variety', score.variety],
        ...(score.timeBonus ? [['Time bonus', score.timeBonus]] : []),
        ['Moves used', score.moves],
        ['Elapsed', `${Math.floor(score.elapsedMs / 1000)}s`],
        ['Invalid actions', score.invalid],
      ],
      cards: st.cardDefs.map(c => ({ title: () => cardTitle(c), done: st.cards[c.id] === 1 })),
      achievements: newly,
      compareText,
      nextLabel: this._nextLabel(),
      summary: () => T('{n} moments, {done} of {total} cards.', { n: score.beats, done: score.cardsDone, total: score.cardsTotal }),
    });
    this.audio.sfx('finish');
    // Results reveal: tally, then one chime per star, then the flourishes.
    let at = 700;
    setTimeout(() => this.audio.sfx('tally'), at); at += 500;
    for (let i = 0; i < score.stars; i++) setTimeout(() => this.audio.sfx('star'), at + i * 420);
    at += score.stars * 420 + (score.stars ? 300 : 0);
    newly.forEach((a, i) => setTimeout(() => this.audio.cardSfx(), at + i * 500));
    at += newly.length * 500;
    const allCards = score.cardsTotal > 0 && score.cardsDone === score.cardsTotal;
    if (allCards) setTimeout(() => this.audio.sfx(this.mode === 'journey' ? 'collection-complete' : 'story-complete'), at);
    else if (prevBest > 0 && score.total > prevBest) setTimeout(() => this.audio.sfx('record'), at);
    if (firstPlayToday && p.daysPlayed.length >= 2) setTimeout(() => this.audio.sfx('streak'), at + 200);
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

  /**
   * Language change: static markup is re-applied by i18n.js; redraw everything
   * built in code from current state — no restart, no new deal, no save.
   */
  relocalize() {
    this.ui.labelAccount();
    this.ui.setKeyHints(this.settings.bindings);
    this._refreshTitle();
    this.gfxPanel?.setLang?.();
    this.ui.setPaused(!!this.ui._paused);
    this.ui.relabelDialog();
    const screen = this.ui.screen();
    if (screen === 'setup' && this._setupView) {
      for (const el of this._setupFields?.querySelectorAll('[data-key]') || []) el.textContent = T(el.dataset.key) + (el.dataset.suffix || '');
      this._setupView();
    }
    if (screen === 'journey' && this._journeyArgs) this.ui.journeyMap(this._journeyArgs, this.progress, (index) => { this.mode = 'journey'; this._startSession({ mode: 'journey', index }); });
    if (screen === 'scrapbook') this._renderScrapbook();
    if (screen === 'help') this._renderHelp();
    if (screen === 'settings' && this.ui._bindingsArgs) this.ui.bindingsEditor(...this.ui._bindingsArgs);
    if (screen === 'results' && this.ui._results) this.ui.results(this.ui._results, true);
    if (this.session) this._syncAll();
  }

  _saveSettingsQuiet() {
    try { localStorage.setItem('storyhouse.settings.v1', JSON.stringify(this.settings)); } catch {}
  }
}

// ---------------------------------------------------------------------------
const app = new App();
app.boot();
window.storyhouse = app; // inspectable for support/debugging
