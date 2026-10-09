# Apex GP multiplayer server

Lobby + pose relay + server-coordinated race state
(ready/config/countdown/laps/results). Clients still
simulate their own physics; the server validates race
events and owns results. Anti-cheat is plausibility
checks only — no authoritative physics or collisions.

## Install & run (local)

```sh
cd server
npm install
npm start
# or: PORT=8765 HOST=0.0.0.0 node server.js
```

Then open `../client/lobby-test.html` in two browsers
(serve it over HTTP so the page origin is sane):

```sh
cd ../client
python3 -m http.server 8080
# open http://localhost:8080/lobby-test.html twice
```

In page 1: CREATE ROOM → note the 5-letter code. In page
2: enter the code → JOIN. Drive with WASD/arrows; each
browser sees the other's dot. `npm test` runs the same
flow headlessly (create, join, relay, bad codes, 8-cap,
disconnect).

## Protocol (JSON over WebSocket)

- `→ {t:"create", name}` → `← {t:"created", code, id, players}` + `← {t:"state", ...}`
- `→ {t:"join", code, name}` → `← {t:"joined", ...}` or
  `← {t:"error", error}` (`bad-code|no-room|room-full|race-over|busy`;
  `race-over` = room already finished; joins allowed in
  lobby/countdown/racing)
- `→ {t:"pos", x,z,yaw,speed}` (≤ ~33 Hz) →
  others get `← {t:"peer", id,x,z,yaw,speed}`
- `→ {t:"leave"}` / socket close →
  others get `← {t:"left", id, reason}` and
  `← {t:"lobby", players}` (+ `state` outside lobby)
- Race state: `→ {t:"ready", ready}`, `→ {t:"config", track, laps}`
  (host, lobby only), `→ {t:"start"}` (host, lobby only),
  `→ {t:"cancel"}` (host), `→ {t:"lap", lap, time}`
  (racing only, exact increment, per-track plausibility
  floor: 50 s Jeddah / 55 s Spa — 80% of impossible
  flat-out pace, so only fabrication trips it).
- Server emits `← {t:"state", state, config, hostId, startsAt,
  players:[{id,name,connected,ready,lap,finished,finishTime,dnf}],
  finishOrder}`, `← {t:"countdown", startsAt, track, laps}`,
  `← {t:"lapUpdate", id, lap}`, `← {t:"finish", id, order, time}`,
  `← {t:"results", track, lapsTarget, order, laps, dnf}`,
  `← {t:"cancelled"}` and `← {t:"error", error}`
  (`not-host|bad-track|bad-laps` added).
- States: `lobby → countdown → racing → finished`, plus
  `cancelled`/lobby reset by host cancel. Host migrates on
  disconnect; mid-race departures never freeze results.
- `GET /health` → `{"ok":true,"rooms":n}`

## Config

| var | default | meaning |
|---|---|---|
| `PORT` | 8765 | TCP port |
| `HOST` | 0.0.0.0 | bind address (LAN reachable; firewall still applies) |
| `ALLOWED_ORIGINS` | (empty = allow all, dev) | comma-separated origins |

## Deploying for friends (what you need)

1. A host that runs Node 18+: VPS, home server, or a
   container PaaS (Render/Fly.io/Railway all work).
   Deploy the `server/` directory only (`npm install`
   then `npm start` as the start command).
2. If players are on another network, the host needs a
   public address: VPS public IP, or
   Tailscale/ZeroTier if you stay on a private mesh.
   Set `HOST=0.0.0.0` (default) and open `PORT` in the
   host firewall / security group.
3. Browsers require `wss://` when the page is served
   over HTTPS: terminate TLS in front of the server
   (Caddy/Nginx/reverse proxy on the PaaS) and set
   `ALLOWED_ORIGINS=https://your-game-page.example`.
4. In `client/lobby-test.html` (later: the game lobby),
   point the server field at
   `wss://your-server.example:443` (or the PaaS URL).
5. Internet connectivity is **not** claimed until you
   have joined one room from a phone/off-LAN network
   and watched both dots move. LAN testing does not
   prove this.

## Limits of this milestone

- Test dots, not F1 cars. Next step: map peer `id` →
  `aiCars[slot]` with an `isHumanNet` flag (mirrors the
  proven `isHuman2` split-screen pattern), relay real
  poses from the live-sim branch, smooth remote meshes
  without touching their AI fields.
- No reconnection tokens yet: a dropped socket rejoins
  as a new player id (slot converts to AI in between —
  same trick as split-screen `releasePlayer2`).
