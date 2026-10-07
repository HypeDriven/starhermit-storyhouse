// platform.js — StarHermit adapter over window.StarHermit (starhermit-sdk.js):
// launch token + renewal, sign-in, nickname, cloud save (game:<slug> slot),
// settings KV, controls, invite link and read-only leaderboards. Without a
// token every platform call is a no-op and nothing touches the network (the
// game never calls its own server routes, on any host). Tokens live in memory only — never in local storage.
import { defaultSettings, migrateSettings, defaultProgress, migrateProgress, sealProgress, verifyProgress, PROGRESS_VERSION } from './persist.js';

const LS = {
  settings: 'storyhouse.settings.v1',
  progress: 'storyhouse.progress.v1',
  boards: 'storyhouse.boards.v1',
  snapshot: 'storyhouse.snapshot.v1',
  scenes: 'storyhouse.scenes.v1',
  telemetry: 'storyhouse.telemetry.v1',
};
const BUILD = '1.0.0';
// Player preferences mirrored to the platform settings KV (bindings go
// through the controls API instead; telemetry consent stays per device).
const PREF_KEYS = ['music', 'effects', 'ambience', 'voice', 'mute', 'captions', 'gfx',
  'reducedMotion', 'highContrast', 'largeText', 'palette', 'lefty', 'dragMode',
  'timingAssist', 'hapticsOff', 'tutorialsDone', 'gamepad'];
const SETTINGS_PUSH_MS = 800;

export class Platform {
  constructor(sdk = (typeof globalThis !== 'undefined' ? globalThis.StarHermit : null)) {
    this.sh = sdk || null;      // window.StarHermit (starhermit-sdk.js)
    this.profile = null;
    this.syncState = 'offline'; // offline | saving | synced | error
    this._telemetryConsent = false;
    this._pushedPrefs = {};
    this._prefTimer = 0;
  }

  /** True while a StarHermit launch token is held (signed in). */
  get hosted() { return !!this.sh?.signedIn; }

  async init() {
    if (this.sh) {
      this.sh.init();
      this.sh.on('auth', (a) => {
        if (!a.signedIn) { this.profile = null; this._setSyncState('offline'); }
        this.onAuthChange?.(a);
      });
      this.sh.on('saved', (ok) => this._setSyncState(ok ? 'synced' : 'error'));
    }
    if (this.hosted) this._bindCloudFlush();
    return this;
  }

  // ------------------------------------------------------------- sign-in
  canSignIn() { return !!this.sh?.canSignIn(); }
  signIn() { return !!this.sh?.signIn(); }
  /** Share link (friends the recipient and invites them back), or null. */
  inviteLink() { return this.hosted ? this.sh.inviteLink() : null; }

  // ------------------------------------------------------------- clock
  // Daily boundaries use the local clock.
  now() { return new Date(); }
  utcToday() { return this.now().toISOString().slice(0, 10); }
  msToNextDaily() {
    const n = this.now();
    const next = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1);
    return next - n.getTime();
  }

  // -------------------------------------------------------------- identity
  async ensureProfile() {
    if (this.profile) return this.profile;
    if (this.hosted) {
      const p = await this.sh.profile();
      if (p) {
        // Nickname (fallback "Player <id>") — never the username or /me.
        this.profile = { id: p.userId, name: p.displayName, avatar: null, guest: false, local: false };
        return this.profile;
      }
    }
    // Fully local guest — progress stays on this device.
    this.profile = { id: 'local-guest', name: 'Local Guest', avatar: null, guest: true, local: true };
    return this.profile;
  }

  // ----------------------------------------------- platform settings KV
  /** Platform-stored preferences (signed in), merged over local ones. */
  async loadPlatformSettings(local) {
    if (!this.hosted) return null;
    const remote = await this.sh.getSettings();
    const patch = {};
    for (const k of PREF_KEYS) if (remote && remote[k] !== undefined && remote[k] !== null) patch[k] = remote[k];
    this._pushedPrefs = { ...pickPrefs(local), ...patch };
    return patch;
  }
  /** Mirror changed preferences to the platform (debounced PATCH). */
  pushSettings(s) {
    if (!this.hosted) return;
    clearTimeout(this._prefTimer);
    this._prefTimer = setTimeout(() => {
      const prefs = pickPrefs(s), diff = {};
      for (const k of PREF_KEYS) {
        if (JSON.stringify(prefs[k]) !== JSON.stringify(this._pushedPrefs[k])) diff[k] = prefs[k] ?? null;
      }
      if (!Object.keys(diff).length) return;
      Object.assign(this._pushedPrefs, diff);
      this.sh.patchSettings(diff);
    }, SETTINGS_PUSH_MS);
  }

  // ---------------------------------------------------------- controls
  /** Effective keyboard bindings: platform overrides win when signed in. */
  async loadBindings(defaults) {
    if (!this.hosted) return null;
    return this.sh.loadBindings(defaults);
  }
  saveBinding(action, codes) { if (this.hosted) this.sh.setControl(action, codes).catch(() => {}); }
  resetBindings() { if (this.hosted) this.sh.resetControls(); }

  // ------------------------------------------------------------- settings
  loadSettings() {
    try { return migrateSettings(JSON.parse(localStorage.getItem(LS.settings) || 'null')); }
    catch { return defaultSettings(); }
  }
  saveSettings(s) {
    try { localStorage.setItem(LS.settings, JSON.stringify(s)); } catch {}
    this.pushSettings(s);
    this.telemetry('settings-change', {});
  }

  // ------------------------------------------------------------- progress
  loadProgress() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS.progress) || 'null');
      if (!raw) return defaultProgress();
      // Repair a tampered/partial document, and upgrade an older one — an
      // intact v0 doc still passes its checksum but lacks whole containers.
      if (!verifyProgress(raw) || raw.v !== PROGRESS_VERSION) return migrateProgress(raw);
      return raw;
    } catch { return defaultProgress(); }
  }
  saveProgress(p) {
    const sealed = sealProgress(p);
    try { localStorage.setItem(LS.progress, JSON.stringify(sealed)); } catch {}
    this._queueCloudSave(sealed);
    return sealed;
  }

  // ----------------------------------------------------------- cloud save
  // One platform slot (game:<slug>, via the SDK) holding {v:2, progress,
  // scenes}. localStorage stays the offline cache; remote wins on start.
  syncLabel() {
    return { saving: 'saving…', synced: 'cloud synced', offline: 'offline', error: 'sync error' }[this.syncState] || '';
  }
  _setSyncState(s) {
    if (this.syncState === s) return;
    this.syncState = s;
    this.onSyncChange?.();
  }
  _bindCloudFlush() {
    if (this._flushBound || typeof window === 'undefined') return;
    this._flushBound = true;
    const flush = () => { if (this.hosted) this.sh.flushSave(true); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
  _cloudDoc(progress) {
    return { v: 2, progress, scenes: this.loadScenes() };
  }
  _queueCloudSave(progress) {
    if (!this.hosted) return;
    this._bindCloudFlush();
    this._setSyncState('saving');
    this.sh.saveJSON(this._cloudDoc(progress));
  }
  /** Remote cloud document ({v:2, progress, scenes}; a bare v1 progress doc is accepted). */
  async loadCloudSave() {
    if (!this.hosted) return null;
    const doc = await this.sh.loadJSON();
    this._setSyncState('synced');
    if (!doc) return null;
    if (doc.v === 2 && verifyProgress(doc.progress)) return doc;
    return verifyProgress(doc) ? { v: 2, progress: doc, scenes: null } : null;
  }
  // Remote wins when both exist; localStorage remains the offline cache.
  adoptRemoteProgress(remote) {
    const doc = remote && remote.v === 2 ? remote : { progress: remote, scenes: null };
    if (!verifyProgress(doc.progress)) return false;
    let changed = false;
    if (Array.isArray(doc.scenes) && JSON.stringify(doc.scenes) !== JSON.stringify(this.loadScenes())) {
      try { localStorage.setItem(LS.scenes, JSON.stringify(doc.scenes)); changed = true; } catch {}
    }
    let local = null;
    try { local = JSON.parse(localStorage.getItem(LS.progress) || 'null'); } catch {}
    if (local && JSON.stringify(local) === JSON.stringify(doc.progress)) return changed;
    try { localStorage.setItem(LS.progress, JSON.stringify(doc.progress)); } catch {}
    return true;
  }

  // --------------------------------------------------------------- scores
  // Signed in: a ranked story's total goes to the platform high-score board
  // (score-script.js); resolves { posted, rank } — rank there, or null.
  async postScore(total) {
    if (!this.hosted || typeof this.sh.submitScores !== 'function') return { posted: false, rank: null };
    const keys = await this.sh.submitScores({ 'high-score': total }).catch(() => []);
    if (!keys || !keys.includes('high-score')) return { posted: false, rank: null };
    try {
      const r = await this.sh.leaderboard('high-score', { pageSize: 100 });
      const me = (r?.items || []).find(i => i.userId === this.sh.userId);
      return { posted: true, rank: me ? me.rank : null };
    } catch { return { posted: true, rank: null }; }
  }

  // Ranked scores are also kept as local personal bests (cloud-saved with
  // progress); hosted boards below are read through the SDK.
  async submitScore(submission) {
    // Local board: same ordering, labeled casual (no authoritative validation).
    const entry = {
      playerId: this.profile?.id || 'local', name: this.profile?.name || 'You',
      sessionId: submission.sessionId, mode: submission.mode, contentId: submission.contentId,
      total: submission.score.total, components: submission.score.components,
      cardsDone: submission.score.cardsDone, invalid: submission.score.invalid,
      elapsedMs: submission.score.elapsedMs, stars: submission.score.stars,
      ts: Date.now(), casual: true,
    };
    const boards = this._loadBoards();
    boards.push(entry);
    while (boards.length > 500) boards.shift();
    try { localStorage.setItem(LS.boards, JSON.stringify(boards)); } catch {}
    return { entry, source: 'local' };
  }
  _loadBoards() {
    try { return JSON.parse(localStorage.getItem(LS.boards) || '[]'); } catch { return []; }
  }
  async leaderboard(board, { contentId = null, friends = [] } = {}) {
    if (this.hosted) {
      const remote = await this._hostedBoard(board);
      if (remote) return remote;
    }
    let entries = this._loadBoards();
    if (board === 'daily') entries = entries.filter(e => e.contentId === (contentId || `daily-${this.utcToday()}`));
    else if (board === 'weekly') entries = entries.filter(e => Date.now() - e.ts < 7 * 86400000);
    else if (board === 'friends') entries = entries.filter(e => friends.includes(e.playerId));
    if (contentId && board !== 'daily') entries = entries.filter(e => e.contentId === contentId);
    const { compareResults } = await import('./rules.js');
    entries.sort((a, b) => compareResults(a, b));
    return { entries: entries.slice(0, 100), source: 'local' };
  }
  // Read-only platform board (script-owned): entries with nicknames resolved
  // via the profile helper. Daily/weekly variants have no platform filter, so
  // only global/friends boards read remotely.
  async _hostedBoard(board) {
    if (board !== 'global' && board !== 'friends') return null;
    const r = await this.sh.leaderboard(null, { pageSize: 50, scope: board === 'friends' ? 'friends' : undefined });
    if (!r?.board) return null;
    const entries = [];
    for (const e of r.items || []) {
      const uid = e.userId ?? null;
      const p = uid ? await this.sh.profile(uid) : null;
      entries.push({
        playerId: uid, name: p?.displayName || e.username || 'Player',
        sessionId: e.sessionId ?? null, total: e.score ?? 0,
        stars: e.stars ?? 0, ts: e.ts ?? e.createdAt ?? 0, source: 'server',
      });
    }
    return { entries, source: 'server' };
  }

  // ---------------------------------------------------------- achievements
  // Local only (part of the cloud-saved progress doc): a pure browser game
  // has no server-authoritative unlock path reachable by launch tokens.
  async unlockAchievement(id, progress) {
    progress.achievements[id] = progress.achievements[id] || Date.now();
    return progress.achievements[id];
  }

  // ------------------------------------------------------------- snapshot
  saveSnapshot(json) { try { localStorage.setItem(LS.snapshot, json); } catch {} }
  loadSnapshot() { try { return localStorage.getItem(LS.snapshot); } catch { return null; } }
  clearSnapshot() { try { localStorage.removeItem(LS.snapshot); } catch {} }

  // --------------------------------------------------------------- scenes
  loadScenes() {
    try { return JSON.parse(localStorage.getItem(LS.scenes) || '[]'); } catch { return []; }
  }
  saveScene(scene) {
    const scenes = this.loadScenes();
    scenes.unshift(scene);
    while (scenes.length > 30) scenes.pop();
    try { localStorage.setItem(LS.scenes, JSON.stringify(scenes)); } catch {}
    if (this.hosted) this._queueCloudSave(this.loadProgress());
    return scenes;
  }
  deleteScene(id) {
    const scenes = this.loadScenes().filter(s => s.id !== id);
    try { localStorage.setItem(LS.scenes, JSON.stringify(scenes)); } catch {}
    if (this.hosted) this._queueCloudSave(this.loadProgress());
    return scenes;
  }

  // ------------------------------------------------------------- telemetry
  /** Anonymous funnel events, aggregate only, consent-gated, local only. */
  telemetry(event, data = {}) {
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    if (!this._telemetryConsent) return;
    try {
      const agg = JSON.parse(localStorage.getItem(LS.telemetry) || '{}');
      agg[event] = (agg[event] || 0) + 1;
      localStorage.setItem(LS.telemetry, JSON.stringify(agg));
    } catch {}
  }
  setTelemetryConsent(on) { this._telemetryConsent = !!on; }

  // -------------------------------------------------------------- presence
  // The wiki has no per-game presence/activity endpoints reachable by launch
  // tokens; the old parent-shell postMessage channel was fabricated. Kept as
  // no-ops so the game lifecycle calls stay valid.
  activityStart() {}
  activityEnd() {}
}

function pickPrefs(s) {
  const out = {};
  for (const k of PREF_KEYS) if (s && s[k] !== undefined) out[k] = s[k];
  return out;
}

export { BUILD };
