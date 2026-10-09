# Apex GP — Multiplayer Readiness (verified)

Date: 2026-10-09. All findings below were read from the
actual code (`index.html`, ~50k lines, Three.js 0.180.0
via CDN importmap). Nothing here changes the game.

## 1. Entry point & dependencies

- Single-file game: `index.html` (`<script type="module">`,
  `import * as THREE from "three"`). No build step, no
  npm dependencies client-side.
- Main loop: `animate()` (~line 44391):
  `requestAnimationFrame` → `clock.getDelta()` (clamped
  by `MAX_FRAME_DT`) → `updateReplay(dt)` (owns the frame
  when active) → live sim: `updateTyreSystem`,
  `updatePitSystem`, `updatePhysics` (Player 1),
  `updateAI` (field), `updatePlayerAICollisions`,
  `updateAICollisions`, `applyTrackElevation`, lap/HUD.
- Pause (`SESSION.paused/confirming`) and replay skip the
  sim block entirely — a netcode hook must live inside
  the live-sim branch, never outside it.

## 2. Cars & control (verified shapes)

- Player 1: `player` (THREE.Group) + `physics{}`
  (`speed` signed m/s, `steering`, `gear`, `ers` 0–100,
  `drs`, `maxSpeed 96`, `reverseSpeed 18`,
  `acceleration 18`, `braking 39`). Driven by
  `updatePhysics(dt)` from the global `keys{}` map
  (event.code keyed; WASD/Space/E/C).
- Field: `aiCars`, `AI_COUNT=8`. Each car:
  `{mesh, driverName, aiIndex, index, lane, speed,
  targetSpeed, lap, finished, pitState, inPit, pitExit,
  tyres{compound,wear}, drs, ers, ...}`. Driven by
  `updateAI(dt)` per-car loop (brain → servo → pursuit
  steering → shared movement/lap/pit/tyre/finish).
- Proven human-slot pattern: offline split-screen flags
  `aiCars[7].isHuman2` (`P2_SLOT_INDEX=7`,
  `ensurePlayer2()`), and the AI loop skips
  brain/servo/pursuit/recovery for that slot while shared
  movement, laps, pits, tyres, collisions and finish
  keep running. **Online play must reuse this exact
  pattern** (`isHumanNet` per remote/local human slot):
  zero AI writes to human slots, shared systems untouched.

## 3. Systems online play must not break

- Laps/finish: per-car `lap`, `finished`, `finishTime`;
  split-screen completion waits for both humans
  (`SPLITSCREEN.p1Finished`). An 8-human race needs the
  same "wait for all humans" rule generalized.
- Pits: `updateAIPitState` machine + `playerPit` for P1;
  box assignment is per-`aiIndex` (`pitBoxes.find`).
  Remote humans need their own boxes; 8 humans + boxes
  must be checked against `pitBoxes.length`.
- Collisions: `updatePlayerAICollisions` (P1 vs field)
  and pairwise `updateAICollisions` (all `aiCars`).
  Remote cars must be included as colliders, never
  teleported by reconciliation (see §5).
- Restart: `restartRace()` → `resetAICars()` funnel;
  `ensurePlayer2()` re-asserts after it. Net slots need
  the same re-assert hook.
- Replay/macros assume one local simulation; replay
  must stay local-only (as split-screen already does).
- HUD/cameras are per-local-player (`camera2`, `p2hud`
  pattern to extend, not replace).

## 4. Chosen architecture: Node.js + `ws`, no framework

- Server: plain Node.js + `ws` package only.
  - vs Colyseus: Colyseus adds rooms/state-sync, but
    also a client SDK, schema lock-in and a build step
    the project deliberately avoids. Our state is tiny
    (8 cars × pose @20 Hz + lobby events); hand-rolled
    rooms (~150 lines) are fully understandable and
    debuggable. Revisit only if server-side physics
    becomes necessary.
  - Authoritative model for milestone 1–2: **clients
    simulate locally, server relays + validates**
    (sequence numbers, rate limits, range checks).
    Full server-authoritative physics is out of scope;
    anti-cheat = plausibility validation.
- Transports: WebSocket (ws/wss). 20 Hz pose relay,
  event-driven lobby messages. No WebRTC for milestone 1
  (NAT traversal cost outweighs benefit at 8 players).

## 5. Planned integration points (NOT implemented yet)

1. `NetClient` module (`client/multiplayer.js`, done,
   standalone): connect/create/join/leave/20 Hz
   `sendPos`/lobby callbacks. No game globals.
2. Slot mapping: remote human `i` → `aiCars[slot]`
   with `isHumanNet=true`, `driverName`, color/livery;
   local player stays `player`. Unused slots keep AI
   (existing behavior — AI fills the grid by default).
3. Send path (inside live-sim branch, after
   `updatePhysics`): `sendPos(player.position,
   rotation.y, physics.speed, lap)`.
4. Receive path: write remote pose into a
   render-smoothing buffer on that slot's mesh
   (lateral/vertical smoothing only — never snap
   position, never write `speed`, never touch AI
   fields). Remote laps/finish arrive as events.
5. Collisions already include `aiCars` meshes, so
   remote cars collide with zero physics changes.
6. Countdown/restart/disconnect: host (room creator)
   owns start; `restartRace()` + net re-assert;
   disconnect → slot converts to AI (`isHumanNet=false`,
   brain resumes — same trick as `releasePlayer2`).
7. Risks: clock divergence (200–500 ms acceptable for
   pose relay and countdown display; finish times use the
   server clock), box count ≥ humans, cheat tolerance
   (server validates lap events; physics still
   client-simulated — see milestone 3 limits).

## 6. Prototype status (Phase 2 milestone 1)

Separate `server/` + `client/` prototype, zero changes
to `index.html`. Test poses only. See `server/README.md`.

## 7. Milestone 2 status: real cars in the live sim

Implemented, minimal and isolated:

- `client/netgame.js` (new, classic script, no imports):
  NET overlay UI (server/name/code/create/join/leave,
  lobby, status, log), `NetClient` wiring, deterministic
  peer→slot mapping (`assignNetSlots`, unit-tested),
  20 Hz send via `tick()`, leave/restart cleanup.
- `index.html` additions only (no refactors):
  `<script src>` for `multiplayer.js` + `netgame.js`
  (guarded no-ops when absent), `NETPLAY` state,
  `isHumanNet` slot flag, `ensureNetSlot` (lowest free
  AI slot, never P2's, never double-booked),
  `releaseNetSlot`/`releaseAllNetSlots` (AI resumes in
  place), `updateNetCar` (exp smoothing + 60 m snap,
  servo parked as no-op), `window.ApexNet` bridge,
  `manual = p2human || nethuman` across all 6 existing
  AI-decision guards, brain/pit-start guards, movement
  + tyre-wear skip for net slots (index/collisions/
  minimap keep working), send hook after
  `updatePhysics`, restart re-snap hook, menu-leave
  hook, split-slot conflict release, green minimap dot.
- Server untouched (pose relay already suffices).
- Verified: `node --check` all files, full `jsc`
  module parse, `npm test` (proto + netplay logic).
- Deliberately NOT done: shared laps/results,
  countdown sync, host track enforcement (manual step:
  host picks track, guests match it), anti-cheat,
  reconnection tokens, internet deploy.
- Browser-verified (2026-10-09, local): two game tabs,
  host created room from the in-game NET panel, guest
  joined by code, host claimed slot 0 (`NET · Driver`),
  guest drove and host rendered the remote real car at
  the guest's smoothed position (`netHas:true`), guest
  close restored AI on slot 0 in place (Verstappen
  driving, no teleport/dupe), no console errors from
  net code. Quick-race flow (tyre confirm) unchanged.

## 8. Milestone 3 status: shared race state + results

Implemented, still modular and narrow:

- Server owns `lobby → countdown → racing → finished`
  (+ host `cancel` back to lobby), room config
  (track allowlist jeddah/spa, laps 1–10, default 5),
  ready flags, stable ids/slots, host migration on
  disconnect, per-player accepted laps + finish order.
- Lap events validated: racing-state only, exact +1
  increment (duplicates/skips rejected), ≤ target laps,
  ≥15 s plausibility floor (env-overridable for tests).
  Finish times use the server clock, never client claims.
- Disconnects never freeze: mid-race departures resolve
  as DNF at results; empty rooms are deleted.
- Clients: ready/config/start/cancel buttons (host-only
  where required), synchronized countdown overlay with
  automatic `beginNetRace` on every client (guests never
  touch in-game START), track-match warning, standings
  panel (✓ server-confirmed humans, ∼ local AI
  estimates), lap/finish/results applied to remote
  slots display-only (local finish machine untouched).
- Deliberately NOT done: authoritative physics or
  collisions (clients simulate; server validates
  events), anti-cheat beyond plausibility, reconnect
  tokens (rejoin = new id), internet deploy.
  Provisional-vs-confirmed is explicit in the UI.
- Hardening audit (2026-10-09): lap floor is now
  per-track physics (Jeddah 50 s / Spa 55 s — 80% of
  impossible flat-out pace; env-overridable for tests),
  finished rooms refuse joins (`race-over`), no-op
  ready/config no longer rebroadcast, standings render
  from last server snapshot (event handlers can't
  overwrite confirmed rows with the local fallback),
  mid-race leavers vanish from results rather than
  freezing them (dnf covers present-but-unresolved).
- Automation limits: hidden headless tabs get no rAF,
  so only the focused tab simulates — a full 2-player
  driven race cannot complete under automation. The
  live lap→finish→results path was verified via the
  real client send path; the crossing hook itself
  (6 lines) is code-reviewed + syntax-checked only.
