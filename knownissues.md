# Known Issues — Storyhouse

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark185 (OBLITERATED Q8_0, 262k ctx),
alongside the game's own unit tests and a headless-Chrome boot check.

Method note: broad "find the defects in this module" prompts to the review model mostly came back
*NO DEFECTS FOUND*; the findings below were located by reading the source and then **re-executing
the real modules** to reproduce each one. Narrow, single-question prompts to the model were used
afterwards to double-check individual findings, and where that happened it is noted in the
evidence.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 58/58 pass (`node --test tests/*.test.js` — content, drag, fuzz, golden, persist, replay, rules) |
| `node --check` on all modules | clean (11 `src/*.js` + 4 `src/render/*.js` + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | not present — substituted a CDP boot check (see *Not tested*): page loads, title "Storyhouse", canvas present, **no console errors, no page exceptions, no failed requests** |

## Confirmed defects

Each defect below was reproduced end to end against the running server, not merely reported by the
model.

### 1. Any ranked run containing a single invalid action is refused by the leaderboard

**FIXED 2026-08-26.** The client now submits the full ordered command log (accepted, rejected, and
undo entries) instead of filtering to accepted-only (`src/main.js:1118`, same change in
`GameSession.replayEnvelope` at `src/session.js:99`). The server's `validateScoreSubmission`
(`server.js:144-165`) now mirrors the session pipeline: rejected commands are applied too (they
increment `stats.invalid`), and `undo` entries pop a server-side snapshot stack taken before each
accepted mutation — so the replay reproduces the terminal state, hash and invalid count included.
Verified end to end: a daily run with one rejected action now returns 200 with `invalid: 1`
(previously 422 `hash-mismatch`), and a ranked allow-undo challenge containing an undo returns 200.

- **File:** `src/main.js:1118-1119` versus `server.js:145-151` (`validateScoreSubmission`)
- **Trigger:** while **hosted** (a launch token is present, so `platform.submitScore` posts to the
  server rather than the local casual board), play a Daily or any other ranked mode, make one
  rejected action — drag a piece onto an occupied slot, tap two props with no character, retry a
  beat already told — then finish. The results line reads
  "Score not submitted (hash-mismatch) — saved locally instead." (`src/main.js:1135`, fed by
  `src/platform.js:173`).
- **Behaviour:** the client submits only accepted commands:

  ```js
  commands: this.session.commands.filter(c => c.accepted).map(c => c.cmd),
  clientHash: R.hashState(st),
  ```

  but a rejected command is not inert — `applyCommand` increments `state.stats.invalid`
  (`src/rules.js:270`) before returning. `hashState` hashes the whole state
  (`src/rules.js:553-555`), `stats.invalid` included. The server rebuilds the content itself,
  replays the accepted-only log, and compares:
  `if (replayHash !== sub.clientHash) return { error: 'hash-mismatch', status: 422 }`.
  Its replayed state has `invalid: 0`, the client's has `invalid: 1`, so the hashes can never
  agree. `stats.invalid` is also one of the components the spec tie-break needs, and the accepted
  log is structurally unable to carry it.
- **Expected:** spec §5: the replay envelope's "ordered commands" must reproduce the terminal state;
  spec §2 makes "fewer invalid actions" a ranking criterion. A player who mis-drags once must still
  be able to post a score.
- **Evidence:** two otherwise identical daily runs against `PORT=39606 node server.js`:

  ```
  clean run (no invalids)  -> 200 {"entry":{"playerId":"guest-fbd05b92","mode":"daily",
                                            "contentId":"daily-2026-08-20", ...}}
  WITH one invalid action  -> 422 {"error":"hash-mismatch"}
  ```

  and the underlying divergence:

  ```
  client stats: {"moves":2,"invalid":1,"interactions":0}   clientHash 0c3fa9e0
  server replay: {"moves":2,"invalid":0,"interactions":0}  serverHash 2a17b5b1   MATCH: false
  ```

  (For the record: the review model, shown exactly these four excerpts, concluded the two hashes
  *would* match because "the state hash is unaffected by which commands are in the array" — it
  missed the `state.stats.invalid += 1` on the rejection path. The HTTP result above is the
  ground truth.)

  Note this is not a security hole — the server is right to reject a mismatch. The defect is that
  the client's submission is constructed so the mismatch is guaranteed. The same
  `filter(c => c.accepted)` appears in `GameSession.replayEnvelope` (`src/session.js:99`), so the
  envelope saved with every scrapbook scene carries the same divergence.

### 2. `makeReplayEnvelope` produces an envelope with no hashes and is never called

**FIXED 2026-08-26.** `makeReplayEnvelope` (`src/persist.js:98-122`) now takes `initialState` and
fills real `initialHash` and `result.hash` via `hashState`, and `GameSession.replayEnvelope`
(`src/session.js:95-109`) delegates to it — one implementation, satisfying spec §5 (initial hash,
ordered commands, periodic hashes, hashed terminal result). Verified: an envelope containing a
rejected command and an undo replays to the terminal hash, and `initialHash` matches
`hashState(createGame(content))`.

- **File:** `src/persist.js:98-121`
- **Trigger:** n/a — dead code.
- **Behaviour:** the helper hard-codes `initialHash: null` and `result.hash: null` with the comment
  "filled by caller if needed", but no caller exists: `makeReplayEnvelope` appears nowhere else in
  `src/` or `tests/`. The live path uses `GameSession.replayEnvelope` (`src/session.js:94`)
  instead, which is a different shape: it carries periodic `hashes` and a terminal
  `result.hash`, but no `initialHash` field at all — so neither envelope satisfies spec §5's
  "initial hash" requirement.
- **Expected:** spec §5 requires the envelope to carry "schema version, build/content version, seed,
  initial hash, timestamp offset, ordered commands, periodic state hashes, terminal result". An
  exported helper that cannot satisfy that contract is a trap for the next caller.
- **Evidence:** `grep -rn "makeReplayEnvelope" src/ tests/` returns only its own definition.

## Suspected — not confirmed

### 1. Elapsed time is asserted by the client on the `finish` command

- **File:** `src/rules.js:317` (`applyCommand`, `finish`/`timeout` branches) and
  `src/rules.js:396-399` (`scoreState`)
- **Concern:** `state.elapsedMs` is only ever written as `Math.max(0, cmd.elapsedMs | 0)` from the
  command payload, and it drives the `timeBonus` component. A client can claim a near-minimum
  elapsed time to harvest almost the whole bonus.
- **Why unconfirmed:** the server does apply a floor — `minMs = state.tick * 150`, rejecting
  `implausibly-fast` (`server.js:154-155`) — which bounds the exaggeration. Whether the residual
  headroom is materially exploitable depends on par times per content record and was not measured.
  (`| 0` also truncates to int32 above ~24.8 days, which is not reachable.)

### 2. The `global` leaderboard mixes content

- **File:** `server.js:226-244`
- **Concern:** with `board=global` and no `contentId`, entries from daily, score-chase and challenge
  content are ranked against each other by raw total, even though their score ceilings differ
  (`maxScore(content)` is content-specific).
- **Why unconfirmed:** the client always passes a `contentId` when reading the board
  (`src/main.js:1128`), so the mixed view may be intentional and unused.

## Checked, no defects found

- `server.js` `validateScoreSubmission` is the strongest validator of the seven games reviewed in
  this pass: it rebuilds the content **server-side** from `contentId` (`contentForSubmission`),
  refuses a `seed-mismatch`, replays every command through the same engine, requires a terminal
  state, checks the state hash, recomputes the score rather than trusting the claim
  (`entry.total = v.score.total`), rejects `score.total > maxScore(content)`, and applies a
  150 ms-per-command plausibility floor.
- `server.js` leaderboard ordering calls `compareResults` (`src/rules.js:518`), which implements the
  spec chain in full: total, then cards completed, then fewer invalid actions, then lower elapsed
  time, then stable session id.
- `server.js` score submission is idempotent by `(sessionId, contentId)`; achievement unlocks are
  idempotent; ranked routes are token-gated and rate-limited; defective daily content is refused
  with `daily-excluded` rather than silently regenerated (`server.js:180-181`), matching spec §2.
- `src/rules.js` scoring: five integer components summed exactly; stars derived from authored par
  thresholds; `maxScore` exists specifically so validators can prove pars are reachable.
- `src/rules.js` legality: `validateCommand` is the single gate, `listLegalActions` enumerates the
  same set, and `suggestAction` (hints) is built on `listLegalActions` — spec §2's shared
  legal-action API.
- `src/rules.js` move limit: `listLegalActions` gates on `moveLimit - stats.moves > 0` and
  `validateCommand` rejects at `stats.moves >= moveLimit`, and `applyCommand` ends the game on the
  same boundary — no off-by-one between the three.
- `src/rules.js` migrations: `migrateState` upgrades v1 documents (rooms map → array, missing
  `elapsedMs`/`par`/`timeBonus`) and throws on unknown versions.
- `src/persist.js`: progress documents are checksummed with `sealProgress`/`verifyProgress`;
  `migrateProgress` coerces every container back to the right type, so a corrupt or partially
  written document degrades to defaults instead of throwing.
- `src/session.js`: idempotent by command id, undo snapshots taken only before accepted mutations,
  clock accumulated only while active (`pauseClock`/`resumeClock`), integer `elapsedMs`.
- The shipped test suite already covers drag input, fuzzing, golden states, persistence and replay
  determinism — 58/58 passing.

## Not tested

- **`tests/e2e.mjs`**: not shipped. Substituted a CDP boot check against `PORT=39606 node
  server.js`; it verifies a clean boot (title, canvas, all mode cards and overlay buttons present,
  no errors) but does not play a scene to completion in the browser.
- **Rendering**: `src/render.js` and `src/render/{house,pieces,camera,vfx}.js` (~1400 lines) were
  not reviewed beyond confirming a clean WebGL boot.
- **Hosted platform paths**: `src/platform.js` guest-token flow was exercised through the server's
  `/api/v1/guest` route, but the real StarHermit host shell (launch token, cloud save conflict,
  presence) was not available.
- **Defect 1's user-visible symptom in the browser**: confirmed at the module and HTTP level, not by
  driving a mis-drag through the real UI.
- **Broad model review of `src/rules.js` + `src/session.js` + `src/persist.js`**: the module-level
  prompt to spark185 returned *NO DEFECTS FOUND* (an earlier attempt returned nothing at all — the
  model exhausted its completion budget on internal reasoning). The companion prompt covering
  `server.js` + `src/persist.js` also returned *NO DEFECTS FOUND*, and the narrow, single-question
  prompt used for defect 1 answered — but answered **wrongly**, as recorded in that defect's
  evidence. The review of these modules therefore rests on manual reading plus direct
  re-execution.

## QA artifacts left on disk

Reproducing the findings above required running `storyhouse/server.js` locally, which created an
untracked `data/` directory. It holds the evidence entries used here (guest profiles and the two probe scores from the defect-1 test), plus one guest and two probe scores from the 2026-08-26 fix verification. **Delete
`data/` before treating any of it as real data** — this QA pass had no permission to remove it.
