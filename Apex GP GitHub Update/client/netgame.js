/* NetGame — online-multiplayer game integration (milestone 2).
 *
 * Standalone classic script (no modules, no imports) so it
 * loads from index.html alongside client/multiplayer.js.
 * It NEVER touches AI, physics or tracks directly: every
 * game mutation goes through the tiny window.ApexNet
 * bridge defined inside index.html. When the bridge is
 * absent (lobby-test.html, unit tests) only the pure
 * helpers and UI-less client logic are usable.
 *
 * Slot rule (must match on every client): remote peers,
 * sorted by player id, map onto the lowest free AI slots
 * in ascending order, skipping slots flagged isHuman2
 * (split-screen P2). The local driver always uses the
 * built-in player car, never a slot.
 */

"use strict";

(function () {
    const G =
        typeof window !== "undefined"
            ? window
            : typeof globalThis !== "undefined"
              ? globalThis
              : {};

    const MAX_HUMANS = 8;

    /* Pure: deterministic peer -> slot mapping.
     * peerIds: remote player ids (self already excluded).
     * taken: array of ai indices reserved (e.g. P2 slot).
     * capacity: number of AI slots (aiCars.length).
     * Returns {peerId: slot}. Extra peers beyond capacity
     * are left unmapped (server already caps at 8). */
    function assignNetSlots(peerIds, taken, capacity) {
        const sorted = peerIds.slice().sort();
        const reserved = {};
        for (let i = 0; i < taken.length; i++) {
            reserved[taken[i]] = true;
        }
        const out = {};
        let slot = 0;
        for (let i = 0; i < sorted.length; i++) {
            while (slot < capacity && reserved[slot]) slot++;
            if (slot >= capacity) break;
            out[sorted[i]] = slot;
            slot++;
        }
        return out;
    }

    /* Pure: shortest-arc yaw step. Returns new yaw. */
    function stepYaw(yaw, target, dt, rate) {
        let d = target - yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        return yaw + d * Math.min(1, dt * rate);
    }

    const NetGame = {
        client: null,
        url: "ws://localhost:8765",
        name: "Driver",
        connected: false,
        peers: {}, // peerId -> {name:true}
        panel: null,
        roomState: "lobby",
        config: { track: "jeddah", laps: 5 },
        isHost: false,
        startsAt: null,
        countdownTimer: null,
        countdownTick: null,
        lastSentLap: 0,
        results: null,
        sharedLaps: {},
        sharedFinish: {},
        readyFlag: false,

        bridge: function () {
            return G.ApexNet || null;
        },

        log: function (m) {
            const el =
                typeof document !== "undefined"
                    ? document.getElementById("netLog")
                    : null;
            if (el) {
                const d = document.createElement("div");
                d.textContent = m;
                el.appendChild(d);
                while (el.children.length > 12) {
                    el.removeChild(el.firstChild);
                }
            }
        },

        status: function (m) {
            if (typeof document !== "undefined") {
                const el = document.getElementById("netStatus");
                if (el) el.textContent = m;
            }
        },

        /* Reconcile lobby list with slot claims. */
        reconcile: function (players, selfId) {
            const B = this.bridge();
            if (!B) return;
            const remote = [];
            const seen = {};
            for (let i = 0; i < players.length; i++) {
                const p = players[i];
                if (p.id === selfId) continue;
                seen[p.id] = true;
                remote.push(p.id);
                this.peers[p.id] = { name: p.name || "Driver" };
            }
            // Release stale mappings first.
            const mapped = B.mappedPeers();
            for (let i = 0; i < mapped.length; i++) {
                if (!seen[mapped[i]]) {
                    B.release(mapped[i]);
                    delete this.peers[mapped[i]];
                    this.log("peer left, slot restored to AI");
                }
            }
            const mapping = assignNetSlots(
                remote,
                B.takenSlots(),
                B.slotCount()
            );
            const ids = Object.keys(mapping);
            for (let i = 0; i < ids.length; i++) {
                B.claim(ids[i], mapping[ids[i]], (this.peers[ids[i]] || {}).name);
            }
            this.renderPeers(players, selfId);
        },

        renderPeers: function (players, selfId) {
            if (typeof document === "undefined") return;
            const el = document.getElementById("netPeers");
            if (!el) return;
            el.textContent = "";
            players.forEach((p) => {
                const d = document.createElement("div");
                d.textContent =
                    (p.id === selfId ? "(you) " : "") +
                    (p.name || "?") +
                    (p.connected === false ? " [away]" : "");
                el.appendChild(d);
            });
        },

        connect: function (create, code) {
            const B = this.bridge();
            if (typeof NetClient === "undefined") {
                this.status("net client missing");
                return;
            }
            if (B && B.splitActive()) {
                this.status("leave split-screen first");
                return;
            }
            const self = this;
            self.disconnect(true);
            self.roomState = "lobby";
            self.results = null;
            self.sharedLaps = {};
            self.sharedFinish = {};
            self.lastSentLap = 0;
            const client = new NetClient({
                url: self.url,
                onLobby: function (players) {
                    self.reconcile(players, client.id);
                },
                onCreated: function (m) {
                    self.connected = true;
                    if (B) B.setActive(true, m.code, m.id);
                    self.setCode(m.code);
                    self.status("hosting " + m.code);
                    self.log("room created: " + m.code);
                    self.refreshRaceUI();
                },
                onJoined: function (m) {
                    self.connected = true;
                    if (B) B.setActive(true, m.code, m.id);
                    self.setCode(m.code);
                    self.status("joined " + m.code);
                    self.log("joined room: " + m.code);
                    self.refreshRaceUI();
                },
                onPeer: function (p) {
                    if (B) B.pose(p.id, p.x, p.z, p.yaw, p.speed);
                },
                onLeft: function () {
                    self.log("peer left");
                },
                onError: function (e) {
                    self.status("error: " + e);
                    self.log("error: " + e);
                },
                onDisconnect: function () {
                    self.connected = false;
                    self.status("disconnected");
                    self.log("disconnected");
                    self.clearCountdown();
                    if (B) B.setActive(false);
                },
                onState: function (m) {
                    self.onRoomState(m, client.id);
                },
                onCountdown: function (m) {
                    self.onCountdownMsg(m);
                },
                onLapUpdate: function (m) {
                    if (B) B.setSlotLap(m.id, m.lap);
                    self.sharedLaps[m.id] = m.lap;
                    self.renderStandings();
                },
                onFinish: function (m) {
                    if (B) B.setSlotFinished(m.id, m.order, m.time);
                    self.sharedFinish[m.id] = {
                        order: m.order,
                        time: m.time,
                    };
                    self.log(
                        "finish P" + m.order + " (" + Math.round(m.time / 1000) + "s)"
                    );
                    self.renderStandings();
                },
                onResults: function (m) {
                    self.results = m;
                    if (B) B.setResults(m);
                    self.roomState = "finished";
                    self.clearCountdown();
                    self.log("results confirmed by server");
                    self.refreshRaceUI();
                    self.renderStandings();
                },
                onCancelled: function () {
                    self.roomState = "lobby";
                    self.results = null;
                    self.clearCountdown();
                    self.log("race cancelled by host");
                    self.refreshRaceUI();
                    self.renderStandings();
                },
            });
            self.client = client;
            if (create) client.create(self.name);
            else client.join(code, self.name);
        },

        setCode: function (c) {
            if (typeof document === "undefined") return;
            const el = document.getElementById("netCode");
            if (el) el.textContent = c || "—";
        },

        /* Per-frame send, called from the game's live sim. */
        tick: function () {
            if (!this.connected || !this.client || !this.client.id) return;
            const B = this.bridge();
            if (!B) return;
            const p = B.local();
            if (!p) return;
            this.client.sendPos(p.x, p.z, p.yaw, p.speed);
        },

        leave: function () {
            if (this.client) {
                try {
                    this.client.leave();
                } catch (e) {}
            }
            this.client = null;
            this.connected = false;
            this.peers = {};
            this.roomState = "lobby";
            this.results = null;
            this.sharedLaps = {};
            this.sharedFinish = {};
            this.lastSentLap = 0;
            this.lastStateMsg = null;
            this.readyFlag = false;
            this.startsAt = null;
            this.clearCountdown();
            const B = this.bridge();
            if (B) {
                B.setActive(false);
                B.releaseAll();
            }
            this.setCode(null);
            this.status("idle");
            this.renderPeers([], null);
            this.refreshRaceUI();
        },

        disconnect: function (silent) {
            if (this.client) {
                try {
                    this.client.leave();
                } catch (e) {}
            }
            this.client = null;
            this.connected = false;
            this.peers = {};
            this.roomState = "lobby";
            this.readyFlag = false;
            this.startsAt = null;
            this.clearCountdown();
            const B = this.bridge();
            if (B) {
                B.setActive(false);
                B.releaseAll();
            }
            if (!silent) this.status("idle");
            this.refreshRaceUI();
        },

        /* Called from restartRace so net slots survive resets. */
        onRestart: function () {
            const B = this.bridge();
            if (!B || !this.connected || !this.client) return;
            B.reclaim();
            this.lastSentLap = 0;
            this.lastStateMsg = null;
        },

        /* ---- shared race state (milestone 3) ---- */

        onRoomState: function (m, selfId) {
            this.roomState = m.state || "lobby";
            this.lastStateMsg = m;
            if (m.config) {
                this.config = {
                    track: m.config.track || "jeddah",
                    laps: m.config.laps || 5,
                };
            }
            this.isHost = !!selfId && m.hostId === selfId;
            if (typeof document !== "undefined") {
                const tr = document.getElementById("netTrack");
                if (tr) tr.value = this.config.track;
                const lp = document.getElementById("netLaps");
                if (lp) lp.value = String(this.config.laps);
            }
            this.refreshRaceUI();
            this.renderStandings(m);
        },

        onCountdownMsg: function (m) {
            const B = this.bridge();
            this.roomState = "countdown";
            this.results = null;
            this.lastSentLap = 0;
            this.lastStateMsg = null;
            this.config = {
                track: m.track || this.config.track,
                laps: m.laps || this.config.laps,
            };
            this.startsAt = m.startsAt;
            this.log(
                "countdown: " +
                    this.config.track +
                    " x" +
                    this.config.laps
            );
            this.refreshRaceUI();
            this.scheduleGo();
        },

        scheduleGo: function () {
            const B = this.bridge();
            this.clearCountdown();
            if (!B || !this.startsAt) return;
            const self = this;
            const delay = Math.max(0, this.startsAt - Date.now());
            this.showCountdownOverlay(delay);
            this.countdownTimer = setTimeout(function () {
                self.countdownTimer = null;
                self.hideCountdownOverlay();
                // Guests never touch the in-game START button:
                // every client begins the configured race here.
                if (B.beginNetRace(self.config.track, self.config.laps)) {
                    self.log("race started (net sync)");
                } else {
                    self.log("could not start net race here");
                    self.status("start failed here — see log");
                }
            }, delay);
        },

        clearCountdown: function () {
            if (this.countdownTimer) {
                clearTimeout(this.countdownTimer);
                this.countdownTimer = null;
            }
            if (this.countdownTick) {
                clearInterval(this.countdownTick);
                this.countdownTick = null;
            }
            this.hideCountdownOverlay();
        },

        showCountdownOverlay: function (delay) {
            if (typeof document === "undefined") return;
            let ov = document.getElementById("netGoOverlay");
            if (!ov) {
                ov = document.createElement("div");
                ov.id = "netGoOverlay";
                ov.style.cssText =
                    "position:fixed;left:0;top:18%;width:100%;z-index:10001;" +
                    "text-align:center;pointer-events:none;" +
                    "font:700 54px monospace;color:#fff;" +
                    "text-shadow:0 2px 12px #000;";
                document.body.appendChild(ov);
            }
            ov.style.display = "block";
            const self = this;
            const paint = function () {
                const left = Math.max(
                    0,
                    Math.ceil((self.startsAt - Date.now()) / 1000)
                );
                ov.textContent =
                    left > 0 ? "NET RACE STARTS IN " + left : "GO!";
            };
            paint();
            this.countdownTick = setInterval(paint, 250);
        },

        hideCountdownOverlay: function () {
            if (typeof document === "undefined") return;
            const ov = document.getElementById("netGoOverlay");
            if (ov) ov.style.display = "none";
        },

        /* Local lap crossing -> server event (server validates). */
        reportLap: function (completedLap, clockMs) {
            if (!this.connected || !this.client) return;
            if (this.roomState !== "racing" && this.roomState !== "countdown")
                return;
            if (completedLap <= this.lastSentLap) return; // no duplicates
            this.lastSentLap = completedLap;
            this.client.sendLap(completedLap, clockMs);
        },

        trackMatches: function () {
            const B = this.bridge();
            if (!B || typeof B.currentTrack !== "function") return true;
            return B.currentTrack() === this.config.track;
        },

        refreshRaceUI: function () {
            if (typeof document === "undefined") return;
            const race = document.getElementById("netRace");
            if (race) {
                race.style.display = this.connected ? "block" : "none";
            }
            const cfg = document.getElementById("netCfgLine");
            if (cfg) {
                cfg.textContent =
                    "TRACK " +
                    this.config.track.toUpperCase() +
                    " · " +
                    this.config.laps +
                    " LAPS · " +
                    this.roomState.toUpperCase() +
                    (this.isHost ? " · HOST" : "");
            }
            const startBtn = document.getElementById("netStart");
            if (startBtn) {
                startBtn.style.display =
                    this.connected && this.isHost && this.roomState === "lobby"
                        ? "inline-block"
                        : "none";
            }
            const cancelBtn = document.getElementById("netCancel");
            if (cancelBtn) {
                cancelBtn.style.display =
                    this.connected &&
                    this.isHost &&
                    (this.roomState === "countdown" ||
                        this.roomState === "racing")
                        ? "inline-block"
                        : "none";
            }
            const match = document.getElementById("netTrackWarn");
            if (match) {
                const ok = this.trackMatches();
                match.style.display =
                    this.connected && !ok ? "block" : "none";
                if (!ok) {
                    match.textContent =
                        "SWITCH YOUR GAME TO " +
                        this.config.track.toUpperCase() +
                        " BEFORE THE START";
                }
            }
            const rc = document.getElementById("netReady");
            if (rc) {
                rc.style.display =
                    this.connected && this.roomState === "lobby"
                        ? "inline-block"
                        : "none";
            }
            const hc = document.getElementById("netHostCfg");
            if (hc) {
                hc.style.display =
                    this.connected && this.isHost && this.roomState === "lobby"
                        ? "block"
                        : "none";
            }
            this.renderStandings();
        },

        /* Provisional table: server-confirmed laps/finish for
           humans (✓), local-sim estimates for AI (∼). */
        renderStandings: function (stateMsg) {
            if (typeof document === "undefined") return;
            const el = document.getElementById("netStandings");
            if (!el) return;
            // Default to the last server snapshot so event
            // handlers never overwrite confirmed rows with
            // the local-sim fallback.
            stateMsg = stateMsg || this.lastStateMsg;
            const B = this.bridge();
            const rows = [];
            const push = function (name, lap, status, confirmed, me) {
                rows.push({ name, lap, status, confirmed, me });
            };
            if (stateMsg && stateMsg.players) {
                const sorted = stateMsg.players.slice().sort(function (a, b) {
                    const fa = a.finished ? 0 : 1;
                    const fb = b.finished ? 0 : 1;
                    if (fa !== fb) return fa - fb;
                    if (a.finished && b.finished)
                        return (a.finishTime || 0) - (b.finishTime || 0);
                    return (b.lap || 0) - (a.lap || 0);
                });
                for (let i = 0; i < sorted.length; i++) {
                    const p = sorted[i];
                    const me =
                        this.client && p.id === this.client.id;
                    let status = "racing";
                    if (p.finished) status = "finished";
                    else if (p.dnf || p.connected === false) status = "DNF";
                    push(p.name || "?", p.lap || 0, status, true, me);
                }
            } else if (B && typeof B.localStandings === "function") {
                const local = B.localStandings();
                for (let i = 0; i < local.length; i++) {
                    push(
                        local[i].name,
                        local[i].lap,
                        local[i].finished ? "finished*" : "racing*",
                        false,
                        !!local[i].me
                    );
                }
            }
            el.textContent = "";
            rows.forEach(function (r, i) {
                const d = document.createElement("div");
                d.textContent =
                    i +
                    1 +
                    ". " +
                    r.name +
                    " L" +
                    r.lap +
                    " " +
                    r.status +
                    (r.confirmed ? " ✓" : " ∼") +
                    (r.me ? " (you)" : "");
                el.appendChild(d);
            });
            if (!rows.length) {
                el.textContent = "no data yet — join a room";
            }
        },

        buildUI: function () {
            if (typeof document === "undefined") return;
            if (document.getElementById("netPanel")) return;
            const panel = document.createElement("div");
            panel.id = "netPanel";
            panel.style.cssText =
                "position:fixed;right:10px;bottom:10px;z-index:9999;" +
                "background:rgba(10,14,20,.92);color:#dfe4ea;" +
                "border:1px solid #333;font:12px monospace;padding:10px;" +
                "width:250px;display:none;";
            panel.innerHTML =
                "<div style='letter-spacing:.1em;margin-bottom:6px'>APEX GP — ONLINE (beta)</div>" +
                "<div style='display:flex;gap:4px;margin-bottom:4px'>" +
                "<input id='netSrv' style='flex:1;min-width:0' value='" +
                this.url +
                "'>" +
                "<input id='netName' style='width:70px' maxlength='24' value='Driver'>" +
                "</div>" +
                "<div style='display:flex;gap:4px;margin-bottom:4px'>" +
                "<button id='netCreate'>CREATE</button>" +
                "<input id='netJoinCode' style='width:60px' maxlength='6' placeholder='CODE'>" +
                "<button id='netJoin'>JOIN</button>" +
                "<button id='netLeave'>LEAVE</button>" +
                "</div>" +
                "<div>ROOM: <span id='netCode'>—</span></div>" +
                "<div id='netStatus'>idle</div>" +
                "<div id='netPeers' style='margin:4px 0'></div>" +
                "<div id='netLog' style='font-size:11px;color:#8a93a3'></div>" +
                "<div id='netRace' style='display:none;margin-top:6px;border-top:1px solid #333;padding-top:6px'>" +
                "<div id='netCfgLine' style='margin-bottom:4px'></div>" +
                "<div id='netTrackWarn' style='display:none;color:#f2d132;margin-bottom:4px'></div>" +
                "<div style='display:flex;gap:4px;margin-bottom:4px;flex-wrap:wrap'>" +
                "<button id='netReady'>READY</button>" +
                "<button id='netStart' style='display:none'>START RACE</button>" +
                "<button id='netCancel' style='display:none'>CANCEL</button>" +
                "</div>" +
                "<div id='netHostCfg' style='margin-bottom:4px'>" +
                "TRACK <select id='netTrack'><option value='jeddah'>JEDDAH</option><option value='spa'>SPA</option></select> " +
                "LAPS <input id='netLaps' style='width:40px' value='5'>" +
                "<button id='netApplyCfg'>SET</button>" +
                "</div>" +
                "<div id='netStandings' style='font-size:11px'></div>" +
                "</div>" +
                "<div style='color:#8a93a3;font-size:11px'>host sets track+laps, presses START RACE. Guests: match the track, wait — the race begins for everyone automatically. ✓ = server-confirmed.</div>";
            document.body.appendChild(panel);
            this.panel = panel;
            const self = this;
            const grab = function () {
                self.url = document.getElementById("netSrv").value.trim();
                self.name =
                    document.getElementById("netName").value.trim() ||
                    "Driver";
            };
            document.getElementById("netCreate").onclick = function () {
                grab();
                self.connect(true);
            };
            document.getElementById("netJoin").onclick = function () {
                grab();
                self.connect(
                    false,
                    document.getElementById("netJoinCode").value.trim()
                );
            };
            document.getElementById("netLeave").onclick = function () {
                self.leave();
            };
            document.getElementById("netReady").onclick = function () {
                if (self.client) {
                    self.readyFlag = !self.readyFlag;
                    self.client.sendReady(self.readyFlag);
                    document.getElementById("netReady").textContent =
                        self.readyFlag ? "UNREADY" : "READY";
                }
            };
            document.getElementById("netApplyCfg").onclick = function () {
                if (!self.client) return;
                const laps = Math.max(
                    1,
                    Math.min(
                        10,
                        parseInt(
                            document.getElementById("netLaps").value,
                            10
                        ) || 5
                    )
                );
                self.client.sendConfig(
                    document.getElementById("netTrack").value,
                    laps
                );
            };
            document.getElementById("netStart").onclick = function () {
                if (self.client) self.client.sendStart();
            };
            document.getElementById("netCancel").onclick = function () {
                if (self.client) self.client.sendCancel();
            };
            const tab = document.createElement("button");
            tab.id = "netTab";
            tab.textContent = "NET";
            tab.style.cssText =
                "position:fixed;right:10px;bottom:10px;z-index:10000;" +
                "background:#e10600;color:#fff;border:0;cursor:pointer;" +
                "font:12px monospace;padding:6px 10px;";
            tab.onclick = function () {
                panel.style.display = "block";
                tab.style.display = "none";
            };
            document.body.appendChild(tab);
            // While the panel is open the tab hides; a small
            // reopen link keeps it reachable without menus.
            const re = document.createElement("button");
            re.textContent = "NET–";
            re.style.cssText =
                "margin-top:6px;background:#2a3240;color:#fff;border:0;" +
                "cursor:pointer;font:11px monospace;padding:2px 8px;";
            re.onclick = function () {
                panel.style.display = "none";
                tab.style.display = "block";
            };
            panel.appendChild(re);
        },

        toggle: function () {
            if (typeof document === "undefined") return;
            this.buildUI();
            const p = document.getElementById("netPanel");
            const t = document.getElementById("netTab");
            const open = p.style.display !== "none";
            p.style.display = open ? "none" : "block";
            if (t) t.style.display = open ? "block" : "none";
        },
    };

    G.NetGame = NetGame;

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { assignNetSlots, stepYaw, MAX_HUMANS };
    }

    if (
        typeof document !== "undefined" &&
        typeof document.addEventListener === "function"
    ) {
        document.addEventListener("DOMContentLoaded", function () {
            try {
                NetGame.buildUI();
            } catch (e) {}
        });
    }
})();
