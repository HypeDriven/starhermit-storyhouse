// session.js — local command pipeline: validated commands only, idempotent
// by command id, snapshot history for undo, replay envelope with periodic
// hashes, and an authoritative quantized session clock.
import { createGame, applyCommand, validateCommand, hashState, serializeState, deserializeState, scoreState } from './rules.js';
import { makeReplayEnvelope } from './persist.js';

let SESSION_COUNTER = 0;

export class GameSession {
  constructor(content, opts = {}) {
    this.content = content;
    this.sessionId = opts.sessionId || `s-${Date.now().toString(36)}-${(SESSION_COUNTER++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.state = null; // set by start()
    this.commands = [];       // ordered accepted+rejected command log
    this.hashes = [];         // {n, hash} every 10 accepted commands
    this._seen = new Set();   // command ids (idempotent)
    this._cmdCounter = 0;
    this._history = [];       // snapshot stack for undo {tick, json}
    this._clockAcc = 0;       // ms accumulated while active
    this._clockSince = null;  // resumed timestamp
  }

  start(state) {
    this.state = state;
    this.resumeClock();
    return this;
  }

  // ------------------------------------------------------------ clock
  resumeClock() { if (this._clockSince === null) this._clockSince = performance.now(); }
  pauseClock() {
    if (this._clockSince !== null) {
      this._clockAcc += performance.now() - this._clockSince;
      this._clockSince = null;
    }
  }
  elapsedMs() {
    const running = this._clockSince !== null ? performance.now() - this._clockSince : 0;
    return Math.floor(this._clockAcc + running); // integer simulation units
  }

  // ------------------------------------------------------------ commands
  /** The only way state changes. Returns {events, accepted, reason}. */
  submit(payload, opts = {}) {
    if (this.state.status !== 'active' && payload.type !== 'finish') {
      return { events: [], accepted: false, reason: 'game-over' };
    }
    const id = opts.commandId || `${this.sessionId}:${this._cmdCounter}`;
    if (this._seen.has(id)) {
      return { events: [], accepted: false, reason: 'duplicate', deduped: true };
    }
    // finish/timeout carry the authoritative clock.
    const cmd = { ...payload };
    if (cmd.type === 'finish' || cmd.type === 'timeout') cmd.elapsedMs = this.elapsedMs();

    const check = validateCommand(this.state, cmd);
    // Snapshot before any accepted mutation (undo lives outside rules state).
    if (check.ok && this.content.allowUndo && cmd.type !== 'finish' && cmd.type !== 'timeout') {
      this._history.push({ tick: this.state.tick, json: serializeState(this.state) });
      if (this._history.length > 120) this._history.shift();
    }
    const { events } = applyCommand(this.state, cmd);
    const accepted = check.ok;
    this._seen.add(id);
    this._cmdCounter++;
    this.commands.push({ id, cmd, accepted });
    if (accepted && this.state.tick % 10 === 0) {
      this.hashes.push({ n: this.state.tick, hash: hashState(this.state) });
    }
    return { events, accepted, reason: accepted ? null : events.find(e => e.type === 'invalid')?.reason };
  }

  canUndo() {
    return this.content.allowUndo && this.state.status === 'active' && this._history.length > 0;
  }
  undo() {
    if (!this.canUndo()) return null;
    const snap = this._history.pop();
    this.state = deserializeState(snap.json);
    this.commands.push({ id: `${this.sessionId}:${this._cmdCounter++}`, cmd: { type: 'undo' }, accepted: true });
    return this.state;
  }

  /** Called once per second by the shell while a timed game is active. */
  tickClock() {
    if (this.state.status !== 'active') return null;
    if (this.state.timeLimitMs !== null && this.elapsedMs() >= this.state.timeLimitMs) {
      return this.submit({ type: 'timeout' });
    }
    return null;
  }

  score() { return scoreState(this.state); }

  replayEnvelope({ build, contentVersion, ruleset }) {
    return makeReplayEnvelope({
      build, contentVersion, ruleset,
      content: this.content, sessionId: this.sessionId,
      // Full ordered log — rejected commands mutate stats.invalid and undo
      // entries drive the replayer's snapshot stack, so filtering here would
      // make the envelope unable to reproduce the terminal state.
      commands: this.commands.map(c => c.cmd),
      hashes: this.hashes.slice(),
      initialState: createGame(this.content), // deterministic from the content
      state: this.state, score: this.score(),
    });
  }

  // ------------------------------------------------------------ snapshots
  serializeSnapshot() {
    return JSON.stringify({
      v: 1,
      content: this.content,
      state: this.state,
      commands: this.commands,
      hashes: this.hashes,
      clockAcc: this.elapsedMs(),
      sessionId: this.sessionId,
      savedAt: Date.now(),
    });
  }
  static restoreSnapshot(json) {
    const doc = JSON.parse(json);
    if (!doc || doc.v !== 1) return null;
    const s = new GameSession(doc.content, { sessionId: doc.sessionId });
    s.state = doc.state;
    s.commands = doc.commands || [];
    s.hashes = doc.hashes || [];
    s._cmdCounter = s.commands.length;
    s._seen = new Set(s.commands.map(c => c.id));
    s._clockAcc = doc.clockAcc || 0;
    s._clockSince = null;
    s._savedAt = doc.savedAt || Date.now();
    return s;
  }
}
