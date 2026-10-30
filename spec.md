# Storyhouse — running specification

Storyhouse is a single-player storytelling sandbox: the player arranges characters and props across
the rooms of a cutaway dollhouse, sets off story moments between them, completes optional discovery
cards and saves each finished scene to a scrapbook. It is a StarHermit engine **script game**
(TypeScript on the host API, `engine.version=1.29.0`, `engine.minor=31`), played natively by the
StarHermit client and in browsers by the engine's web runtime from the same package.

## Rules (src/rules.js, unchanged)

- A layout (Cottage, Manor, Loft, Townhouse) has rooms of six types (Kitchen, Library, Garden Room,
  Parlor, Bedroom, Attic), each with 3–4 spots. The tray holds the story's pieces: five characters
  (Pip, Mabel, Otto, Luna, Biscuit) and ten props.
- Commands: **place** a tray piece on a free spot, **move** a placed piece to another free spot,
  **remove** it back to the tray, **interact** two pieces in one room (a character and a prop, or two
  characters — a heart to heart), **finish** (save the scene). Rejected commands count as invalid
  actions. Move limits end the story at the limit; time limits end it when the clock runs out.
- A fresh interaction records a story beat (10–12 points, +6 for a character's signature prop, a
  habitat bonus in the prop's home room). Discovery cards are optional goals (placements, beats in a
  room type, signatures, two pieces together, room coverage, variety, beat counts).
- Score = moments + discoveries + room coverage (5 a room) + variety (8 a beat kind) + time bonus;
  three par thresholds give 0–3 stars. Results always show the breakdown.
- Hints come from the same legal-action list as play. Undo is allowed where the content allows it.

## Modes and content (src/content.js, unchanged)

- **Play** (title): the next unfinished Journey stage at once.
- **Journey**: 45 stages in five chapters of nine (each chapter ends in a mastery stage); a stage
  unlocks when the one before it is done.
- **Learn**: six lessons, each step performed by the player (the lesson box tracks the step).
- **Daily Story**: one seeded house per UTC day (the platform's clock when it answered, else the
  device's), ranked.
- **Practice**: Cozy / Standard / Tricky, a theme and an inspectable seed; undo, unranked.
- **Challenge**: six authored challenges (move limits, a 150 s clock with a speed bonus, restricted
  undo), ranked.
- **Score Chase**: a seeded Manor (share the seed), ranked.

## Screens

Title (Play, the six modes, Scrapbook, How to play, Settings, Sign in / Invite a friend, the profile
and sync line, "Continue your paused story →"), mode setup (facts, ranked / casual badge, lesson /
difficulty / theme / challenge selects, seed field, Start), the play HUD, pause (Resume, Settings,
How to play, Restart story, Save & leave), confirm dialogs (restart, empty story, erase), results
(headline, stars, score table, cards, achievements, leaderboard line, Next / Replay / Home), Journey
map, Scrapbook (saved scenes with their 168×112 pictures, mastery track, achievements, delete), How
to play (rule cards with live examples and the current bindings) and Settings. Every screen draws
over the dimmed 3D house (or the plain page on the Low tier, which shows no title backdrop).

### Play HUD and layouts (native/screens.ts)

- Top bar: the story's name and objective; Moves, clock (red under 15 s left) and score chips; Text
  (the text mirror), Hint, Undo, View (camera reset) and Pause / Resume.
- Discovery cards + Story so far rail; Selection rail (what is selected, its moments and "Return to
  the tray", the lesson box, **Save scene ✦** and the open-cards note); the piece tray along the
  bottom; the key hint line (wide layouts); toasts above the tray; the captions line bottom-left.
- Layouts by logical window size: **wide** (≥ 1024 px) rails flank the house; **compact** the rails
  are drawers behind Goals / Actions toggles; **portrait phones** (≤ 700 px) the top bar wraps and
  its buttons show icons only; **short landscape** (≤ 500 px tall) drawers open below the top bar and
  the story log is hidden. Left-handed controls mirror the layout (rails, toggles, tray, top bar).
- Named targets over every spot ("Kitchen, empty spot 1") and piece ("Biscuit in the Kitchen,
  spot 1") give screen readers and play scripts the house; the **text mirror** lists every spot and
  tray piece as a button, fully playable.

## Controls

| Action | Keys (default) | Gamepad |
| --- | --- | --- |
| Confirm / place (cursor) | Enter, Space, Numpad Enter | South |
| Cancel selection / pause | Escape | East |
| Pause | P | Start |
| Undo / Hint | U / H | Left shoulder / North |
| Camera reset | C | Right stick press |
| Mute game sounds | M | — |
| Interact with the selected piece | I | West |
| Cursor | Arrow keys | D-pad, left stick |
| Previous / next room | [ / ] | Left / right trigger |

The right stick looks around. Players rebind everything in the runtime's Options (controls).
Pointer and touch: tap a tray piece or a placed piece to pick it up (glowing rings mark legal spots),
tap a spot to place or move it; tap a second piece in the same room for a moment; drag a piece from
the tray or the house onto a spot (ghost preview, red ring on an invalid spot); drag empty space to
look around (yaw ±0.6 rad, pitch 0.5–1.15 rad), pinch or the wheel to zoom. Placement style (tap /
drag / both) is a setting. A press that lands on a widget never also reaches the house.

## Settings

The runtime's Options own volumes and mute, graphics quality and frame rate, language, larger text,
high contrast, reduced motion and key / pad bindings (Settings links to them). The game's own,
synced with the account (engine `settings`): Mute all (the game's sounds), captions for meaningful
audio, colour palette (default, protanopia-, deuteranopia-, tritanopia-safe: the good / bad / card
colours), left-handed controls, placement style, timing assistance (ranked scores become casual),
haptics off, anonymous usage counts (kept on this device), Replay tutorials, Erase local progress.

## Graphics (native/render.ts, house.ts, pieces.ts, vfx.ts, camera.ts, quality.ts)

The browser build's three.js r160 scene on `starhermit:scene`: theme sky and fog, hemisphere / key /
fill lights at the page's intensities with its fitted shadow box (normalBias 0.025, radius 3; the
ground takes shadows), the procedural house (merged vertex-coloured rooms, per-room dressing, the
floorboard / wallpaper / grain / pane-glow surface detail as a WGSL surface hook), the procedural
pieces (Lambert / Standard / clear-coated Physical by tier), RoomEnvironment(renderer) reflections on
the pieces at their old intensities, the selection (lift, outline hull, pulsing ring, legal rings),
ghost and invalid rings, cursor diamond, sparks, impact rings and dust motes, spring-animated pieces,
the authored spring camera and the title backdrop (still on Balanced, swaying on High / Ultra).
Per tier (gfx.js presets): Low — no shadows, no post, plain detail, MSAA; Balanced — 1024 shadows,
bloom (the r160 page's 0.5 strength, bloom.model "r160"), display-space grade + vignette, FXAA; High — 2048, GTAO, SMAA; Ultra — 4096, high GTAO,
MSAA, ×1.5 curve segments. Spark and mote counts scale with the level within the tier.

## Sound (native/audio.ts)

The authored one-shots (`sfx/*.opus`) per event; the cursor tick, voice mumbles, signature chime
and homely shimmer synthesized once into clips; each theme's music as a 16-beat loop in three stems
(base, the progress-driven busy melody and sparkle layers) on the music bus; each theme's ambience
(birds, hearth, waves, crickets, wind) as a 10 s loop on the music bus. Captions name the meaningful
sounds when enabled.

## Saves and platform (native/platform.ts, src/savedoc.js)

- The engine save (device + cloud slot) is `{ v: 2, progress, scenes }`: the checksummed progress
  (journey stars and scores, lessons, collected cards, beats seen, achievements, days played, the
  last Daily, best scores, scene count) and up to 30 scrapbook scenes (each with its replay envelope
  and a PNG picture captured from the frame). Conflicts merge (best of both, unions, earliest
  unlocks, scenes by id). The browser build's cloud slot (game:storyhouse) is read once as a foreign
  save, merged and replaced; its settings-KV options are adopted and the KV keys removed.
- The paused story ("Continue"), the casual local board and the usage counts are device storage.
- Signed in, a ranked story's total is posted through `score-script.js` (range-checked, the
  high-score board) and the rank is shown; signed out, it goes to the casual local board.
  Achievements are part of the save. There is no multiplayer.

## Localization

All strings in en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT (src/strings.js,
src/strings-content.js, src/sh-i18n.js), following the runtime's interface language live.

## Checks

`npm test`: the rules, content, fuzz, golden, replay and persist tests, the i18n coverage and save
document tests, then `tests/native.mjs` (web index up to date, tsc, `starhermit check` without
warnings, and render-check play scripts from `tools/gen-plays.mjs`: Journey 1-5 by mouse, Learn 1-5
by finger on a DPR-3 phone, Journey 1-2 by keyboard on a short landscape, two challenges, the
menus, today's Daily). `npm run test:browser` plays the packaged loader in GPU Chrome at desktop,
phone and landscape. `npm run package` rewrites the loader and the web index after every change.

## Known limitations

- Text-style buttons are not underlined (the engine UI has no text decoration).
- The old four volume sliders map onto the runtime's buses; per-effect graphics overrides are gone.
- Music loops are seeded per theme, not per story seed.
- Guests' old browser localStorage progress cannot migrate; cloud saves do.
- Pre-existing rules behaviour is kept as before (see knownissues.md: the client asserts elapsed
  time on finish; the dev server's replay validator is not used by the platform score script).
