// platform.js — StarHermit launch-token adapter: identity, cloud saves, time
// sync, persistence, telemetry consent. Hosted mode activates only when a
// launch token was read; every hosted call is same-origin with Bearer auth
// and degrades quietly offline. The game's own dev server (npm start) keeps
// its optional richer contract behind the no-token path. Tokens live in
// memory only — never in local storage.
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
const REFRESH_MS = 45 * 60 * 1000;   // re-mint the 60-min launch token early
const REFRESH_RETRY_MS = 60 * 1000;
const CLOUD_DEBOUNCE_MS = 2000;

export class Platform {
  constructor() {
    this.hosted = false;        // true iff a launch token was read
    this.ownServer = false;     // the game's own dev server answered /config
    this.profile = null;
    this._token = null;         // memory only
    this._timeOffset = 0;       // server - local, ms
    this.launch = null;         // {token, sub, scope} decoded from the token
    this.syncState = 'offline'; // offline | saving | synced | error
    this._cloudTimer = 0;
    this._cloudDoc = null;
    this._refreshTimer = 0;
    this._nameCache = new Map();
    this._telemetryConsent = false;
  }

  async init() {
    const launch = readLaunchToken();
    if (launch) {
      this.hosted = true;
      this.launch = launch;
      this._token = launch.token;
      this._bindCloudFlush();
      this._scheduleRefresh();
      return this;
    }
    // No token: local dev may still run the game's own optional server.
    try {
      const r = await fetchWithTimeout('/api/v1/config', {}, 1800);
      if (r.ok) {
        this.ownServer = true;
        this.config = await r.json();
      }
    } catch { this.ownServer = false; }
    await this.syncTime();
    return this;
  }

  // ------------------------------------------------------------- time sync
  async syncTime() {
    if (!this.ownServer) { this._timeOffset = 0; return; }
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
    if (this.hosted && this.launch.sub) {
      const name = await this._fetchNickname(this.launch.sub);
      this.profile = { id: this.launch.sub, name, avatar: null, guest: false, local: false };
      return this.profile;
    }
    if (this.ownServer) {
      const p = await this._api('/api/v1/profile');
      if (p?.profile) { this.profile = p.profile; return this.profile; }
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
  // Display NICKNAME from the profile endpoint; never the username, never
  // /api/v1/me (403 for launch tokens).
  async _fetchNickname(userId) {
    if (this._nameCache.has(userId)) return this._nameCache.get(userId);
    let name = null;
    try {
      const r = await fetchWithTimeout(`/api/v1/users/${encodeURIComponent(userId)}/profile`, {
        headers: { Authorization: `Bearer ${this._token}` },
      }, 5000);
      if (r.ok) {
        const j = await r.json().catch(() => null);
        name = j?.nickname || null;
      }
    } catch {}
    if (!name) name = 'Player ' + String(userId).slice(0, 8);
    this._nameCache.set(userId, name);
    return name;
  }

  // ------------------------------------------------------- token lifecycle
  // Scoped launch tokens may re-mint: POST with the current token, swap the
  // new one in, keep the 45-min cadence; retry failures after ~60 s.
  _scheduleRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this._refreshToken(), REFRESH_MS);
  }
  async _refreshToken() {
    if (!this.hosted || !this._token || !this.launch.scope) return;
    try {
      const r = await fetchWithTimeout(`/api/v1/games/${encodeURIComponent(this.launch.scope)}/launch-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this._token}` },
      }, 8000);
      if (r.ok) {
        const j = await r.json().catch(() => null);
        const t = j?.token || j?.launchToken || null;
        if (t) { this._token = t; this.launch.token = t; }
        this._scheduleRefresh();
        return;
      }
    } catch {}
    this._refreshTimer = setTimeout(() => this._refreshToken(), REFRESH_RETRY_MS);
  }

  // ------------------------------------------------------------ API helper
  async _api(path, opts = {}) {
    if (!this.hosted && !this.ownServer) return null;
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
  // One platform slot: GET/PUT /api/v1/me/cloud-saves/{slug}, zip+base64.
  // localStorage stays the offline cache; the cloud is a mirror of it.
  syncLabel() {
    return { saving: 'saving…', synced: 'cloud synced', offline: 'offline', error: 'sync error' }[this.syncState] || '';
  }
  _setSyncState(s) {
    if (this.syncState === s) return;
    this.syncState = s;
    this.onSyncChange?.();
  }
  _bindCloudFlush() {
    const flush = () => { clearTimeout(this._cloudTimer); this._flushCloudSave(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
  _queueCloudSave(doc) {
    if (this.ownServer && !this.hosted && this._token) this._devServerSave(doc);
    if (!this.hosted || !this._token || !this.launch.scope) return;
    this._cloudDoc = doc;
    this._setSyncState('saving');
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => this._flushCloudSave(), CLOUD_DEBOUNCE_MS);
  }
  // Dev-server mirror of the local cache (its own optional contract).
  async _devServerSave(doc) {
    const remote = await this._api('/api/v1/save');
    await this._api('/api/v1/save', {
      method: 'PUT',
      body: JSON.stringify({ doc, baseVersion: remote?.doc?.v ?? 0 }),
    });
  }
  async _flushCloudSave() {
    const doc = this._cloudDoc;
    if (!doc) return;
    this._cloudDoc = null;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(doc));
      const r = await fetchWithTimeout(`/api/v1/me/cloud-saves/${encodeURIComponent(this.launch.scope)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${this._token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataBase64: bytesToBase64(zipStore('save.json', bytes)) }),
      }, 8000);
      this._setSyncState(r.ok ? 'synced' : 'error');
    } catch { this._setSyncState('offline'); }
  }
  async loadCloudSave() {
    if (!this.hosted || !this._token || !this.launch.scope) return null;
    try {
      const r = await fetchWithTimeout(`/api/v1/me/cloud-saves/${encodeURIComponent(this.launch.scope)}`, {
        headers: { Authorization: `Bearer ${this._token}` },
      }, 8000);
      if (r.status === 404 || !r.ok) return null;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
      return verifyProgress(doc) ? doc : null;
    } catch { return null; }
  }
  // Remote wins when both exist; localStorage remains the offline cache.
  adoptRemoteProgress(remoteDoc) {
    if (!verifyProgress(remoteDoc)) return false;
    let local = null;
    try { local = JSON.parse(localStorage.getItem(LS.progress) || 'null'); } catch {}
    if (local && JSON.stringify(local) === JSON.stringify(remoteDoc)) return false;
    try { localStorage.setItem(LS.progress, JSON.stringify(remoteDoc)); } catch {}
    return true;
  }

  // --------------------------------------------------------------- scores
  // Platform leaderboards are script-owned: the client can never submit.
  // Ranked scores stay as local personal bests (cloud-saved with progress);
  // hosted boards below are read-only.
  async submitScore(submission) {
    if (this.ownServer && !this.hosted && this._token) {
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
    if (this.hosted && this._token) {
      const remote = await this._hostedBoard(board, { friends });
      if (remote) return remote;
    } else if (this.ownServer) {
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
  // Read-only: game info → leaderboardId → entries, nicknames resolved via
  // the profile helper. Daily/weekly variants have no platform filter, so
  // only global/friends boards read remotely.
  async _hostedBoard(board, { friends }) {
    if (!this.launch.scope || (board !== 'global' && board !== 'friends')) return null;
    try {
      const g = await this._api(`/api/v1/games/${encodeURIComponent(this.launch.scope)}`);
      const lbId = g?.leaderboardId ?? g?.game?.leaderboardId ?? null;
      if (!lbId) return null;
      const q = new URLSearchParams({ page: '1', pageSize: '100' });
      if (board === 'friends' || friends.length) q.set('friendsOnly', 'true');
      const r = await this._api(`/api/v1/leaderboards/${encodeURIComponent(lbId)}/entries?${q}`);
      if (!r?.entries) return null;
      const entries = [];
      for (const e of r.entries.slice(0, 50)) {
        const uid = e.userId ?? e.playerId ?? e.user?.id ?? null;
        entries.push({
          playerId: uid, name: uid ? await this._fetchNickname(uid) : 'Player',
          sessionId: e.sessionId ?? null, total: e.score ?? e.total ?? 0,
          stars: e.stars ?? 0, ts: e.ts ?? e.createdAt ?? 0, source: 'server',
        });
      }
      return { entries, source: 'server' };
    } catch { return null; }
  }

  // ---------------------------------------------------------- achievements
  // Local only (part of the cloud-saved progress doc): a pure browser game
  // has no server-authoritative unlock path reachable by launch tokens.
  async unlockAchievement(id, progress) {
    progress.achievements[id] = progress.achievements[id] || Date.now();
    if (this.ownServer && !this.hosted && this._token) {
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

// ---------------------------------------------------------------------------
// Launch token: fragment #game_token=<jwt> (optional &session_id=<guid>),
// read once and stripped from the URL. Query param / injected global are
// local-dev fallbacks only. JWT payload (base64url, no verify): sub = user
// id, game_scope = slug — the slug is never hard-coded.
function readLaunchToken() {
  let tok = null;
  try {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    if (raw.includes('game_token=')) {
      const hp = new URLSearchParams(raw);
      tok = hp.get('game_token');
      hp.delete('game_token');
      hp.delete('session_id');
      const rest = hp.toString();
      history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
    }
  } catch {}
  if (!tok) {
    const q = new URLSearchParams(location.search);
    tok = q.get('launch') || q.get('token') || null;
  }
  if (!tok && typeof window !== 'undefined') tok = window.STARHERMIT_LAUNCH || null;
  if (!tok) return null;
  const payload = decodeTokenPayload(tok);
  if (!payload || (!payload.sub && !payload.scope)) return null;
  return { token: tok, sub: payload.sub, scope: payload.scope };
}

function decodeTokenPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { sub: payload.sub || null, scope: payload.game_scope || payload.scope || payload.game || null };
  } catch { return null; }
}

function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export { BUILD };
