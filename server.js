// server.js — Storyhouse authoritative script (StarHermit: server=server.js).
// Dependency-free Node ESM. Serves the static distribution and provides:
//   GET  /api/v1/time          platform time for daily boundaries & countdowns
//   GET  /api/v1/config        content/ruleset versions
//   GET  /api/v1/daily?date=   today's validated daily descriptor
//   POST /api/v1/guest         issue a guest identity token
//   GET  /api/v1/profile       profile for a bearer token
//   POST /api/v1/scores        replay-validated score submission (ranked modes)
//   GET  /api/v1/leaderboard   global / daily / weekly / friends boards
//   GET  /api/v1/achievements  unlocked set for a bearer token
//   POST /api/v1/achievements  idempotent achievement unlock
//   GET  /api/v1/save          cloud-save document (versioned, checksummed)
//   PUT  /api/v1/save          store a cloud-save document (conflict-aware)
//
// Ordinary practice runs locally and offline; this script exists for seeded
// daily sessions, replay validation, and durable achievement delivery.

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGame, applyCommand, validateCommand, scoreState, hashState, compareResults, maxScore, RULESET_VERSION } from './src/rules.js';
import { CONTENT_VERSION, dailyContent, scoreChaseContent, challengeContent, ACHIEVEMENTS, validateContent } from './src/content.js';
import { hashValue } from './src/rng.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.join(__dirname, 'data');
const BUILD_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Tiny JSON-file persistence
// ---------------------------------------------------------------------------
async function loadJson(name, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA_DIR, name), 'utf8')); }
  catch { return structuredClone(fallback); }
}
async function saveJson(name, value) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, name), JSON.stringify(value));
}
const db = {
  guests: await loadJson('guests.json', {}),          // token -> profile
  scores: await loadJson('scores.json', []),          // leaderboard entries
  achievements: await loadJson('achievements.json', {}), // token -> {id: ts}
  saves: await loadJson('saves.json', {}),            // token -> doc
};

// ---------------------------------------------------------------------------
// Rate limiting (token bucket per key)
// ---------------------------------------------------------------------------
const buckets = new Map();
function rateLimit(key, cost, perMinute) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.started > 60000) { b = { started: now, left: perMinute }; buckets.set(key, b); }
  b.left -= cost;
  return b.left >= 0;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2', '.map': 'application/json', '.opus': 'audio/ogg',
};
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null && !(body instanceof Buffer);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
  res.end(payload);
}
const fail = (res, code, error, headers = {}) => send(res, code, { error }, headers);

async function readBody(req, cap = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].slice(0, 128) : null;
}
function profileFor(token) {
  if (!token) return null;
  if (db.guests[token]) return db.guests[token];
  // Host-issued tokens are honored opaquely: identity lives with the host shell.
  if (token.startsWith('sh_') || token.length >= 8) {
    return { id: 'host-' + hashValue(token).slice(0, 8), name: 'Player', avatar: null, guest: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Score validation — replay the input log against regenerated content.
// ---------------------------------------------------------------------------
const RANKED_MODES = new Set(['daily', 'score', 'challenge']);
function contentForSubmission(sub) {
  if (sub.mode === 'daily') {
    const date = String(sub.contentId || '').replace(/^daily-/, '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return dailyContent(date);
  }
  if (sub.mode === 'score') {
    const seed = Number(String(sub.contentId || '').replace(/^score-/, ''));
    if (!Number.isInteger(seed) || seed < 0) return null;
    return scoreChaseContent(seed);
  }
  if (sub.mode === 'challenge') {
    const id = String(sub.contentId || '').replace(/^challenge-/, '');
    return challengeContent(id);
  }
  return null;
}

function validateScoreSubmission(sub) {
  if (!sub || typeof sub !== 'object') return { error: 'bad-payload' };
  if (sub.ruleset !== RULESET_VERSION || sub.contentVersion !== CONTENT_VERSION) return { error: 'stale-version', status: 409 };
  if (!RANKED_MODES.has(sub.mode)) return { error: 'mode-not-ranked', status: 422 };
  if (!Array.isArray(sub.commands) || sub.commands.length > 2000) return { error: 'bad-command-log', status: 422 };
  if (typeof sub.sessionId !== 'string' || sub.sessionId.length < 6 || sub.sessionId.length > 64) return { error: 'bad-session', status: 422 };
  const content = contentForSubmission(sub);
  if (!content) return { error: 'unknown-content', status: 422 };
  if (content.seed !== sub.seed) return { error: 'seed-mismatch', status: 422 };

  // Replay mirrors the client session pipeline exactly: rejected commands are
  // applied too (they increment stats.invalid, which feeds the state hash and
  // the tie-break), and undo entries pop a snapshot stack taken before each
  // accepted mutation — so the full ordered log reproduces the terminal state.
  let state = createGame(content);
  const history = [];
  for (const cmd of sub.commands) {
    if (!cmd || typeof cmd !== 'object') return { error: 'bad-command-log', status: 422 };
    if (cmd.type === 'undo') {
      if (!content.allowUndo || !history.length) return { error: 'bad-command-log', status: 422 };
      state = JSON.parse(history.pop());
      continue;
    }
    const check = validateCommand(state, cmd);
    if (check.ok && content.allowUndo && cmd.type !== 'finish' && cmd.type !== 'timeout') {
      history.push(JSON.stringify(state));
      if (history.length > 120) history.shift();
    }
    applyCommand(state, cmd);
  }
  if (state.status !== 'terminal') return { error: 'session-not-finished', status: 422 };
  const replayHash = hashState(state);
  if (replayHash !== sub.clientHash) return { error: 'hash-mismatch', status: 422 };
  const score = scoreState(state);
  // Plausibility: humans cannot act faster than ~150 ms per accepted command.
  const minMs = state.tick * 150;
  if (state.elapsedMs < minMs) return { error: 'implausibly-fast', status: 422 };
  if (score.total > maxScore(content)) return { error: 'impossible-score', status: 422 };
  return { content, state, score };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const route = url.pathname;
  const ip = req.socket.remoteAddress || 'unknown';
  const token = bearerToken(req);

  if (req.method === 'GET' && route === '/api/v1/time') {
    const now = new Date();
    return send(res, 200, { now: now.toISOString(), epochMs: now.getTime() });
  }
  if (req.method === 'GET' && route === '/api/v1/config') {
    return send(res, 200, { build: BUILD_VERSION, contentVersion: CONTENT_VERSION, ruleset: RULESET_VERSION });
  }
  if (req.method === 'GET' && route === '/api/v1/daily') {
    if (!rateLimit('daily:' + ip, 1, 60)) return fail(res, 429, 'rate-limited', { 'Retry-After': '30' });
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, 'bad-date');
    const content = dailyContent(date);
    const problems = validateContent(content);
    if (problems.length) return fail(res, 500, 'daily-excluded'); // defective days are excluded, never silently replaced
    return send(res, 200, { content });
  }
  if (req.method === 'POST' && route === '/api/v1/guest') {
    if (!rateLimit('guest:' + ip, 1, 10)) return fail(res, 429, 'rate-limited', { 'Retry-After': '30' });
    const tok = 'sh_' + randomBytes(18).toString('hex');
    const num = Object.keys(db.guests).length + 1;
    db.guests[tok] = { id: 'guest-' + hashValue(tok).slice(0, 8), name: `Guest ${num}`, avatar: null, guest: true, created: Date.now() };
    await saveJson('guests.json', db.guests);
    return send(res, 200, { token: tok, profile: db.guests[tok] });
  }
  if (req.method === 'GET' && route === '/api/v1/profile') {
    const p = profileFor(token);
    if (!p) return fail(res, 401, 'unauthorized');
    return send(res, 200, { profile: p });
  }
  if (req.method === 'POST' && route === '/api/v1/scores') {
    const p = profileFor(token);
    if (!p) return fail(res, 401, 'unauthorized');
    if (!rateLimit('scores:' + p.id, 1, 20)) return fail(res, 429, 'rate-limited', { 'Retry-After': '30' });
    let sub;
    try { sub = await readBody(req); } catch (e) { return fail(res, 400, e.message); }
    const v = validateScoreSubmission(sub);
    if (v.error) return fail(res, v.status || 422, v.error);
    // Idempotent: same session + content returns the existing entry.
    const existing = db.scores.find(e => e.sessionId === sub.sessionId && e.contentId === sub.contentId);
    if (existing) return send(res, 200, { entry: existing, deduped: true });
    const entry = {
      playerId: p.id, name: p.name, sessionId: sub.sessionId,
      mode: sub.mode, contentId: sub.contentId, seed: sub.seed,
      ruleset: RULESET_VERSION, contentVersion: CONTENT_VERSION,
      assists: sub.assists || {}, settings: sub.settings || {},
      total: v.score.total, components: {
        moments: v.score.moments, discoveries: v.score.discoveries,
        coverage: v.score.coverage, variety: v.score.variety, timeBonus: v.score.timeBonus,
      },
      cardsDone: v.score.cardsDone, invalid: v.score.invalid,
      elapsedMs: v.state.elapsedMs, durationMs: v.state.elapsedMs,
      stars: v.score.stars, hash: hashState(v.state), ts: Date.now(),
    };
    db.scores.push(entry);
    if (db.scores.length > 5000) db.scores.splice(0, db.scores.length - 5000);
    await saveJson('scores.json', db.scores);
    return send(res, 200, { entry });
  }
  if (req.method === 'GET' && route === '/api/v1/leaderboard') {
    if (!rateLimit('board:' + ip, 1, 60)) return fail(res, 429, 'rate-limited', { 'Retry-After': '30' });
    const board = url.searchParams.get('board') || 'global';
    const contentId = url.searchParams.get('contentId') || null;
    const friends = (url.searchParams.get('friends') || '').split(',').filter(Boolean);
    let entries = db.scores.slice();
    if (board === 'daily') {
      const today = new Date().toISOString().slice(0, 10);
      entries = entries.filter(e => e.contentId === (contentId || `daily-${today}`));
    } else if (board === 'weekly') {
      entries = entries.filter(e => Date.now() - e.ts < 7 * 86400000);
    } else if (board === 'friends') {
      entries = entries.filter(e => friends.includes(e.playerId));
    } else if (board !== 'global') {
      return fail(res, 400, 'unknown-board');
    }
    if (contentId && board !== 'daily') entries = entries.filter(e => e.contentId === contentId);
    entries.sort((a, b) => compareResults(a, b));
    return send(res, 200, { board, entries: entries.slice(0, 100) });
  }
  if (req.method === 'GET' && route === '/api/v1/achievements') {
    const p = profileFor(token);
    if (!p) return fail(res, 401, 'unauthorized');
    return send(res, 200, { achievements: db.achievements[p.id] || {}, catalog: ACHIEVEMENTS });
  }
  if (req.method === 'POST' && route === '/api/v1/achievements') {
    const p = profileFor(token);
    if (!p) return fail(res, 401, 'unauthorized');
    let body;
    try { body = await readBody(req, 4096); } catch (e) { return fail(res, 400, e.message); }
    const id = String(body.achievementId || '');
    if (!ACHIEVEMENTS.some(a => a.id === id)) return fail(res, 422, 'unknown-achievement');
    const mine = db.achievements[p.id] || (db.achievements[p.id] = {});
    const already = !!mine[id];
    if (!already) { mine[id] = Date.now(); await saveJson('achievements.json', db.achievements); }
    return send(res, 200, { id, unlocked: !already, at: mine[id] }); // idempotent
  }
  if (req.method === 'GET' && route === '/api/v1/save') {
    const p = profileFor(token);
    if (!p) return fail(res, 401, 'unauthorized');
    return send(res, 200, { doc: db.saves[p.id] || null });
  }
  if (req.method === 'PUT' && route === '/api/v1/save') {
    const p = profileFor(token);
    if (!p) return fail(res, 401, 'unauthorized');
    let body;
    try { body = await readBody(req, 262144); } catch (e) { return fail(res, 400, e.message); }
    const doc = body.doc;
    if (!doc || !Number.isInteger(doc.v) || typeof doc.checksum !== 'string') return fail(res, 422, 'bad-save-doc');
    const { checksum, ...rest } = doc;
    if (hashValue(rest) !== checksum) return fail(res, 422, 'bad-checksum');
    const existing = db.saves[p.id];
    if (existing && Number.isInteger(body.baseVersion) && existing.v !== body.baseVersion) {
      // Conflict: preserve both and let the player choose.
      return send(res, 409, { error: 'save-conflict', remote: existing, local: doc });
    }
    db.saves[p.id] = doc;
    await saveJson('saves.json', db.saves);
    return send(res, 200, { ok: true, v: doc.v });
  }
  return fail(res, 404, 'not-found');
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const BLOCKED = new Set(['server.js', 'package.json', 'package-lock.json']);
async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const rel = path.normalize(p).replace(/^([/\\])+/, '');
  if (rel.startsWith('..') || rel.includes('/../') || rel.startsWith('data/') || rel.startsWith('.') || rel.split('/').some(s => s.startsWith('.'))) {
    return fail(res, 403, 'forbidden');
  }
  if (BLOCKED.has(rel)) return fail(res, 403, 'forbidden');
  const file = path.join(__dirname, rel);
  if (!file.startsWith(__dirname)) return fail(res, 403, 'forbidden');
  if (!existsSync(file)) return fail(res, 404, 'not-found');
  const ext = path.extname(file).toLowerCase();
  const immutable = rel.startsWith('vendor/');
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    return fail(res, 500, 'read-error');
  }
}

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET') return fail(res, 405, 'method-not-allowed');
    return await serveStatic(req, res, url);
  } catch (e) {
    return fail(res, 500, 'internal-error');
  }
});

server.listen(PORT, () => {
  console.log(`Storyhouse server listening on http://localhost:${PORT}`);
});
