// platform.js — token-aware REST adapter, time sync, persistence, telemetry
// consent, presence. Works hosted (same-origin /api) or fully local/offline;
// account state survives either way. Tokens live in memory only — never in
// local storage.
import { defaultSettings, migrateSettings, defaultProgress, migrateProgress, sealProgress, verifyProgress } from './persist.js';

const LS = {
  settings: 'storyhouse.settings.v1',
  progress: 'storyhouse.progress.v1',
  boards: 'storyhouse.boards.v1',
  snapshot: 'storyhouse.snapshot.v1',
  scenes: 'storyhouse.scenes.v1',
  telemetry: 'storyhouse.telemetry.v1',
};
const BUILD = '1.0.0';

export class Platform {
  constructor() {
    this.hosted = false;
    this.profile = null;
    this._token = null;         // memory only
    this._timeOffset = 0;       // server - local, ms
    this.launch = null;         // {token, scope} from the host shell
    this._presenceTimer = 0;
    this._telemetryQueue = [];
  }

  async init() {
    // UUID production subdomains serve a static build; their shared platform
    // API is not this game's optional server contract.
    if (/^[0-9a-f-]{36}\.starhermit\.com$/i.test(location.hostname)) {
      this.hosted = false;
      this._timeOffset = 0;
      return this;
    }
    // Launch token: query param or host-injected global. Scope is read from
    // the token payload when decodable; the slug is never hard-coded.
    const q = new URLSearchParams(location.search);
    const tok = q.get('launch') || (typeof window !== 'undefined' && window.STARHERMIT_LAUNCH) || null;
    if (tok) this.launch = { token: tok, scope: decodeTokenScope(tok) };

    // Hosted probe with a tight budget — the game must boot fast offline.
    try {
      const r = await fetchWithTimeout('/api/v1/config', {}, 1800);
      if (r.ok) {
        const cfg = await r.json();
        this.hosted = true;
        this.config = cfg;
      }
    } catch { this.hosted = false; }
    await this.syncTime();
    return this;
  }

  // ------------------------------------------------------------- time sync
  async syncTime() {
    if (!this.hosted) { this._timeOffset = 0; return; }
    try {
      const t0 = Date.now();
      const r = await fetchWithTimeout('/api/v1/time', {}, 1500);
      const t1 = Date.now();
      if (r.ok) {
        const j = await r.json();
        this._timeOffset = j.epochMs - Math.round((t0 + t1) / 2); // round-trip adjusted
      }
    } catch { this._timeOffset = 0; }
  }
  now() { return new Date(Date.now() + this._timeOffset); }
  utcToday() { return this.now().toISOString().slice(0, 10); }
  msToNextDaily() {
    const n = this.now();
    const next = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1);
    return next - n.getTime();
  }

  // -------------------------------------------------------------- identity
  async ensureProfile() {
    if (this.profile) return this.profile;
    if (this.launch?.token) {
      this._token = this.launch.token;
      const p = await this._api('/api/v1/profile');
      if (p?.profile) { this.profile = p.profile; return this.profile; }
      // Expired/rotated launch token: ask the host shell to refresh.
      const refreshed = await this._requestTokenRefresh();
      if (refreshed) {
        this._token = refreshed;
        const p2 = await this._api('/api/v1/profile');
        if (p2?.profile) { this.profile = p2.profile; return this.profile; }
      }
    }
    if (this.hosted) {
      const g = await this._api('/api/v1/guest', { method: 'POST' });
      if (g?.token) {
        this._token = g.token;
        this.profile = g.profile;
        return this.profile;
      }
    }
    // Fully local guest — progress stays on this device.
    this.profile = { id: 'local-guest', name: 'Local Guest', avatar: null, guest: true, local: true };
    return this.profile;
  }
  _requestTokenRefresh() {
    return new Promise((resolve) => {
      if (!window.parent || window.parent === window) return resolve(null);
      const onMsg = (e) => {
        if (e.data?.type === 'starhermit:token') {
          window.removeEventListener('message', onMsg);
          resolve(e.data.token || null);
        }
      };
      window.addEventListener('message', onMsg);
      window.parent.postMessage({ type: 'starhermit:token-refresh' }, '*');
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, 1500);
    });
  }

  // ------------------------------------------------------------ API helper
  async _api(path, opts = {}) {
    if (!this.hosted) return null;
    try {
      const headers = { ...(opts.headers || {}) };
      if (this._token) headers.Authorization = `Bearer ${this._token}`;
      if (opts.body) headers['Content-Type'] = 'application/json';
      const r = await fetchWithTimeout(path, { ...opts, headers }, 5000);
      if (r.status === 429) return { error: 'rate-limited', retryAfter: r.headers.get('Retry-After') };
      const j = await r.json().catch(() => null);
      if (!r.ok) return { error: j?.error || `http-${r.status}` };
      return j;
    } catch { return null; }
  }

  // ------------------------------------------------------------- settings
  loadSettings() {
    try { return migrateSettings(JSON.parse(localStorage.getItem(LS.settings) || 'null')); }
    catch { return defaultSettings(); }
  }
  saveSettings(s) {
    try { localStorage.setItem(LS.settings, JSON.stringify(s)); } catch {}
    this.telemetry('settings-change', {});
  }

  // ------------------------------------------------------------- progress
  loadProgress() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS.progress) || 'null');
      if (raw && !verifyProgress(raw)) return migrateProgress(raw); // repair via migration
      return raw ? raw : defaultProgress();
    } catch { return defaultProgress(); }
  }
  saveProgress(p) {
    const sealed = sealProgress(p);
    try { localStorage.setItem(LS.progress, JSON.stringify(sealed)); } catch {}
    this._cloudSave(sealed); // fire-and-forget
    return sealed;
  }
  async _cloudSave(doc) {
    if (!this.hosted || !this._token) return;
    const remote = await this._api('/api/v1/save');
    const remoteDoc = remote?.doc;
    const r = await this._api('/api/v1/save', {
      method: 'PUT',
      body: JSON.stringify({ doc, baseVersion: remoteDoc?.v ?? 0 }),
    });
    if (r?.error === 'save-conflict') {
      // Preserve both; the shell asks the player which to keep.
      this.onSaveConflict?.({ local: doc, remote: r.remote });
    }
  }
  async loadCloudSave() {
    const r = await this.hosted && this._token ? await this._api('/api/v1/save') : null;
    return r?.doc || null;
  }

  // --------------------------------------------------------------- scores
  async submitScore(submission) {
    if (this.hosted && this._token) {
      const r = await this._api('/api/v1/scores', { method: 'POST', body: JSON.stringify(submission) });
      if (r?.entry) return { entry: r.entry, deduped: !!r.deduped, source: 'server' };
      if (r?.error) return { error: r.error };
      return { error: 'offline' };
    }
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
      const q = new URLSearchParams({ board });
      if (contentId) q.set('contentId', contentId);
      if (friends.length) q.set('friends', friends.join(','));
      const r = await this._api(`/api/v1/leaderboard?${q}`);
      if (r?.entries) return { entries: r.entries, source: 'server' };
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

  // ---------------------------------------------------------- achievements
  async unlockAchievement(id, progress) {
    progress.achievements[id] = progress.achievements[id] || Date.now();
    if (this.hosted && this._token) {
      await this._api('/api/v1/achievements', { method: 'POST', body: JSON.stringify({ achievementId: id }) });
    }
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
    return scenes;
  }
  deleteScene(id) {
    const scenes = this.loadScenes().filter(s => s.id !== id);
    try { localStorage.setItem(LS.scenes, JSON.stringify(scenes)); } catch {}
    return scenes;
  }

  // ------------------------------------------------------------- telemetry
  /** Anonymous funnel events, aggregate only, consent-gated. */
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
  /** Activity start/end pairing + throttled heartbeats while playing. */
  activityStart() {
    this._activity('start');
    clearInterval(this._presenceTimer);
    this._presenceTimer = setInterval(() => this._activity('heartbeat'), 30000);
  }
  activityEnd() {
    clearInterval(this._presenceTimer);
    this._presenceTimer = 0;
    this._activity('end');
  }
  _activity(phase) {
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: 'starhermit:activity', phase, game: 'storyhouse', t: Date.now() }, '*'); } catch {}
    }
  }
}

function decodeTokenScope(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.scope || payload.game || null;
  } catch { return null; }
}

function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

export { BUILD };
