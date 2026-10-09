/* Apex GP multiplayer server (Phase 2 milestones 1–3).
 *
 * Lobby + pose relay + server-coordinated race state.
 * Clients still simulate their own physics; the server
 * owns rooms, race state, lap validation and results.
 * It never trusts client-declared winners or positions.
 *
 * Env: PORT, HOST, ALLOWED_ORIGINS (see below).
 */

"use strict";

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_HUMANS = 8;
const MAX_MSG_BYTES = 4096;
const POS_MIN_INTERVAL_MS = 30; // ~33 Hz cap per client
const HEARTBEAT_MS = 30000;
const CODE_LEN = 5;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_RE = /^[A-Z0-9]{4,6}$/;
const MAX_NAME_LEN = 24;

/* race config + validation bounds */
const TRACK_ALLOW = ["jeddah", "spa"];
const DEFAULT_LAPS = 5;
const MIN_LAPS = 1;
const MAX_LAPS = 10;
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS || 5000);
/* Plausibility floor per track: 80% of the outright
 * impossible flat-out-top-speed pace (Spa 7.004 km at
 * 96 m/s needs 73 s; Jeddah ~6.2 km needs 65 s). Only
 * gross fabrication or spam trips this — slow laps,
 * crashes and standing starts are always slower.
 * MIN_LAP_MS env overrides for tests. */
const TRACK_MIN_LAP_MS = { jeddah: 50000, spa: 55000 };
const MIN_LAP_OVERRIDE = process.env.MIN_LAP_MS
    ? Number(process.env.MIN_LAP_MS)
    : null;
function minLapFor(track) {
    if (MIN_LAP_OVERRIDE != null && Number.isFinite(MIN_LAP_OVERRIDE)) {
        return MIN_LAP_OVERRIDE;
    }
    return TRACK_MIN_LAP_MS[track] || 15000;
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function isNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}

function clampNumber(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function makeCode() {
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

/* rooms: code -> {
 *   players: Map(playerId -> player),
 *   createdAt, state, config{track,laps}, hostId,
 *   startsAt, finishOrder:[ids], countdownTimer }
 * player: {ws,name,lastPosAt,ready,connected,lap,
 *   finished,finishTime,lastLapAt,dnf}
 * states: lobby | countdown | racing | finished | cancelled */
const rooms = new Map();

function newPlayer(ws, name) {
    return {
        ws,
        name,
        lastPosAt: 0,
        ready: false,
        connected: true,
        lap: 0,
        finished: false,
        finishTime: null,
        lastLapAt: null,
        dnf: false,
    };
}

function resetRaceFields(room) {
    if (room.countdownTimer) {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
    }
    room.startsAt = null;
    room.finishOrder = [];
    for (const p of room.players.values()) {
        p.ready = false;
        p.lap = 0;
        p.finished = false;
        p.finishTime = null;
        p.lastLapAt = null;
        p.dnf = false;
    }
}

function roomStateMsg(room) {
    const players = [];
    for (const [id, p] of room.players) {
        players.push({
            id,
            name: p.name,
            connected: p.ws.readyState === 1 && p.connected,
            ready: p.ready,
            lap: p.lap,
            finished: p.finished,
            finishTime: p.finishTime,
            dnf: p.dnf,
        });
    }
    return {
        t: "state",
        state: room.state,
        config: { track: room.config.track, laps: room.config.laps },
        hostId: room.hostId,
        startsAt: room.startsAt,
        players,
        finishOrder: room.finishOrder.slice(),
    };
}

function sendState(room) {
    broadcast(room, roomStateMsg(room));
}

function lobbyList(room) {
    const out = [];
    for (const [id, p] of room.players) {
        out.push({ id, name: p.name, connected: p.ws.readyState === 1 });
    }
    return out;
}

function broadcast(room, msg, exceptId) {
    const text = JSON.stringify(msg);
    for (const [id, p] of room.players) {
        if (id === exceptId) continue;
        if (p.ws.readyState === 1) p.ws.send(text);
    }
}

function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function removePlayer(room, code, playerId, reason) {
    if (!room.players.has(playerId)) return;
    const wasHost = room.hostId === playerId;
    room.players.delete(playerId);
    broadcast(room, { t: "left", id: playerId, reason: reason || "left" });
    // Host migrates so the session stays manageable.
    if (wasHost) {
        const next = firstConnected(room);
        room.hostId = next ? next[0] : null;
    }
    if (room.players.size === 0) {
        if (room.countdownTimer) clearTimeout(room.countdownTimer);
        rooms.delete(code);
        return;
    }
    // A mid-race departure is a DNF, never a freeze.
    // Everyone gets a fresh state so standings/HUD
    // never go stale waiting for the next lap.
    if (room.state === "racing" || room.state === "countdown") {
        broadcast(room, roomStateMsg(room));
        maybeFinishRace(room);
    } else {
        broadcast(room, { t: "lobby", players: lobbyList(room) });
        broadcast(room, roomStateMsg(room));
    }
}

function firstConnected(room) {
    for (const [id, p] of room.players) {
        if (p.ws.readyState === 1) return [id, p];
    }
    return null;
}

/* Finish when every human is resolved (finished or gone).
 * Never waits on a disconnected socket. */
function maybeFinishRace(room) {
    if (room.state !== "racing" && room.state !== "countdown") return;
    for (const p of room.players.values()) {
        if (!p.finished && p.ws.readyState === 1) return;
    }
    for (const p of room.players.values()) {
        if (!p.finished) p.dnf = true;
    }
    room.state = "finished";
    broadcast(room, resultsMsg(room));
    broadcast(room, roomStateMsg(room));
}

function resultsMsg(room) {
    const order = room.finishOrder.map((id) => {
        const p = room.players.get(id);
        return {
            id,
            name: p ? p.name : "?",
            finishTime: p ? p.finishTime : null,
        };
    });
    const laps = {};
    const dnf = [];
    for (const [id, p] of room.players) {
        laps[id] = p.lap;
        if (p.dnf || (!p.finished && p.ws.readyState !== 1)) dnf.push(id);
    }
    return {
        t: "results",
        track: room.config.track,
        lapsTarget: room.config.laps,
        order,
        laps,
        dnf,
    };
}

function checkOrigin(req) {
    if (allowedOrigins.length === 0) return true;
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client
    return allowedOrigins.includes(origin);
}

const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
        return;
    }
    res.writeHead(404);
    res.end("apex-gp-mp");
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

wss.on("connection", (ws, req) => {
    if (!checkOrigin(req)) {
        ws.close(4403, "origin not allowed");
        return;
    }

    let code = null;
    let playerId = null;
    let playerName = "Driver";
    let lastPosAt = 0;

    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(String(raw));
        } catch {
            return; // malformed: ignore, never crash
        }
        if (!msg || typeof msg.t !== "string") return;

        if (msg.t === "create") {
            if (code) return; // already in a room
            const name =
                typeof msg.name === "string"
                    ? msg.name.slice(0, MAX_NAME_LEN) || "Driver"
                    : "Driver";
            let c = makeCode();
            for (let i = 0; i < 20 && rooms.has(c); i++) c = makeCode();
            if (rooms.has(c)) {
                send(ws, { t: "error", error: "busy" });
                return;
            }
            playerId = crypto.randomUUID();
            playerName = name;
            const room = {
                players: new Map(),
                createdAt: Date.now(),
                state: "lobby",
                config: { track: "jeddah", laps: DEFAULT_LAPS },
                hostId: playerId,
                startsAt: null,
                finishOrder: [],
                countdownTimer: null,
            };
            room.players.set(playerId, newPlayer(ws, name));
            rooms.set(c, room);
            code = c;
            send(ws, {
                t: "created",
                code,
                id: playerId,
                players: lobbyList(room),
            });
            send(ws, roomStateMsg(room));
            return;
        }

        if (msg.t === "join") {
            if (code) return;
            const c =
                typeof msg.code === "string"
                    ? msg.code.toUpperCase().trim()
                    : "";
            if (!CODE_RE.test(c)) {
                send(ws, { t: "error", error: "bad-code" });
                return;
            }
            const room = rooms.get(c);
            if (!room) {
                send(ws, { t: "error", error: "no-room" });
                return;
            }
            // A finished room is history: rejoining it would
            // strand the newcomer with no race to run.
            if (room.state === "finished") {
                send(ws, { t: "error", error: "race-over" });
                return;
            }
            if (room.players.size >= MAX_HUMANS) {
                send(ws, { t: "error", error: "room-full" });
                return;
            }
            const name =
                typeof msg.name === "string"
                    ? msg.name.slice(0, MAX_NAME_LEN) || "Driver"
                    : "Driver";
            playerId = crypto.randomUUID();
            playerName = name;
            room.players.set(playerId, newPlayer(ws, name));
            code = c;
            send(ws, {
                t: "joined",
                code,
                id: playerId,
                players: lobbyList(room),
            });
            send(ws, roomStateMsg(room));
            broadcast(room, { t: "lobby", players: lobbyList(room) }, playerId);
            // Late joiners (including mid-race) refresh
            // everyone's standings immediately.
            broadcast(room, roomStateMsg(room), playerId);
            return;
        }

        // Everything below requires room membership.
        if (!code || !playerId) return;
        const room = rooms.get(code);
        if (!room || !room.players.has(playerId)) return;

        if (msg.t === "pos") {
            const now = Date.now();
            if (now - lastPosAt < POS_MIN_INTERVAL_MS) return; // rate cap
            lastPosAt = now;
            if (
                !isNumber(msg.x) ||
                !isNumber(msg.z) ||
                !isNumber(msg.yaw) ||
                !isNumber(msg.speed)
            ) {
                return;
            }
            // World-scale plausibility clamp (Apex tracks fit in ±4 km).
            const x = clampNumber(msg.x, -4000, 4000);
            const z = clampNumber(msg.z, -4000, 4000);
            const yaw = clampNumber(msg.yaw, -Math.PI * 4, Math.PI * 4);
            const speed = clampNumber(msg.speed, -30, 120);
            broadcast(
                room,
                { t: "peer", id: playerId, x, z, yaw, speed },
                playerId
            );
            return;
        }

        if (msg.t === "leave") {
            removePlayer(room, code, playerId, "left");
            code = null;
            playerId = null;
            send(ws, { t: "left", id: null, reason: "left" });
            return;
        }

        const me = room.players.get(playerId);
        const isHost = room.hostId === playerId;

        if (msg.t === "ready") {
            if (room.state !== "lobby") return;
            const want = msg.ready === true;
            if (me.ready === want) return; // no-op: no storm
            me.ready = want;
            sendState(room);
            return;
        }

        if (msg.t === "config") {
            if (!isHost || room.state !== "lobby") {
                if (!isHost) send(ws, { t: "error", error: "not-host" });
                return;
            }
            const track =
                typeof msg.track === "string"
                    ? msg.track.toLowerCase()
                    : "";
            const laps = Math.floor(Number(msg.laps));
            if (!TRACK_ALLOW.includes(track)) {
                send(ws, { t: "error", error: "bad-track" });
                return;
            }
            if (!Number.isFinite(laps) || laps < MIN_LAPS || laps > MAX_LAPS) {
                send(ws, { t: "error", error: "bad-laps" });
                return;
            }
            if (
                room.config.track === track &&
                room.config.laps === laps
            ) {
                return; // no-op: no storm
            }
            room.config.track = track;
            room.config.laps = laps;
            sendState(room);
            return;
        }

        if (msg.t === "start") {
            if (!isHost || room.state !== "lobby") {
                if (!isHost) send(ws, { t: "error", error: "not-host" });
                return;
            }
            resetRaceFields(room);
            room.state = "countdown";
            room.startsAt = Date.now() + COUNTDOWN_MS;
            broadcast(room, {
                t: "countdown",
                startsAt: room.startsAt,
                track: room.config.track,
                laps: room.config.laps,
            });
            sendState(room);
            room.countdownTimer = setTimeout(() => {
                room.countdownTimer = null;
                if (room.state !== "countdown") return;
                room.state = "racing";
                for (const p of room.players.values()) {
                    p.lastLapAt = room.startsAt;
                }
                sendState(room);
            }, COUNTDOWN_MS + 250);
            return;
        }

        if (msg.t === "cancel") {
            if (!isHost) {
                send(ws, { t: "error", error: "not-host" });
                return;
            }
            if (room.state === "lobby") return;
            resetRaceFields(room);
            room.state = "lobby";
            broadcast(room, { t: "cancelled" });
            sendState(room);
            return;
        }

        if (msg.t === "lap") {
            if (room.state !== "racing") return;
            const lap = Math.floor(Number(msg.lap));
            if (!Number.isFinite(lap)) return;
            // Exact increment only: duplicates and skips rejected.
            if (lap !== me.lap + 1) return;
            if (lap < 1 || lap > room.config.laps) return;
            const now = Date.now();
            const since =
                me.lastLapAt != null ? now - me.lastLapAt : now - room.startsAt;
            // Implausible teleports rejected, never trusted.
            // Floor is per-track physics (see TRACK_MIN_LAP_MS).
            if (since < minLapFor(room.config.track)) return;
            me.lap = lap;
            me.lastLapAt = now;
            broadcast(room, { t: "lapUpdate", id: playerId, lap });
            if (lap >= room.config.laps && !me.finished) {
                me.finished = true;
                me.finishTime = now - room.startsAt;
                room.finishOrder.push(playerId);
                broadcast(room, {
                    t: "finish",
                    id: playerId,
                    order: room.finishOrder.length,
                    time: me.finishTime,
                });
                maybeFinishRace(room);
            } else {
                sendState(room);
            }
            return;
        }
    });

    ws.on("close", () => {
        if (code && playerId) {
            const room = rooms.get(code);
            if (room) removePlayer(room, code, playerId, "disconnect");
        }
    });

    ws.on("error", () => {});
});

const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.__alive === false) {
            ws.terminate();
            return;
        }
        ws.__alive = false;
        ws.ping();
    });
}, HEARTBEAT_MS);

wss.on("connection", (ws) => {
    ws.__alive = true;
    ws.on("pong", () => {
        ws.__alive = true;
    });
});

server.listen(PORT, HOST, () => {
    console.log(`apex-gp-mp listening on ${HOST}:${PORT}`);
    if (allowedOrigins.length === 0) {
        console.log(
            "WARNING: ALLOWED_ORIGINS empty — accepting all origins (dev mode)."
        );
    }
});

process.on("SIGINT", () => {
    clearInterval(heartbeat);
    server.close(() => process.exit(0));
});
