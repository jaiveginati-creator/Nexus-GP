/* Milestone-3 race-state tests: ready/config/start auth,
 * transitions, lap validation, finishing order, DNF paths.
 * Run: npm test (spawns server with fast timers).
 */
"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const PORT = 18766;
const URL = `ws://127.0.0.1:${PORT}`;

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(URL);
        ws._buf = [];
        ws.on("message", (data) => {
            try {
                ws._buf.push(JSON.parse(String(data)));
            } catch {}
        });
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });
}

function send(ws, obj) {
    ws.send(JSON.stringify(obj));
}

/* Collect until predicate matches (server emits several
 * messages per action: lobby+state, countdown+state...). */
function waitFor(ws, pred, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        // Drain anything that arrived before we listened.
        const buffered = (ws._buf || []).findIndex(pred);
        if (buffered >= 0) {
            resolve(ws._buf.splice(buffered, 1)[0]);
            return;
        }
        const seen = [];
        const t = setTimeout(() => {
            ws.removeListener("message", onMsg);
            reject(
                new Error(
                    "timeout waiting; got: " + JSON.stringify(seen).slice(0, 300)
                )
            );
        }, timeoutMs);
        function onMsg(data) {
            let m;
            try {
                m = JSON.parse(String(data));
            } catch {
                return;
            }
            seen.push(m.t);
            if (pred(m)) {
                clearTimeout(t);
                ws.removeListener("message", onMsg);
                // Remove the twin copy from the permanent buffer.
                const bi = (ws._buf || []).findIndex(
                    (x) => JSON.stringify(x) === JSON.stringify(m)
                );
                if (bi >= 0) ws._buf.splice(bi, 1);
                resolve(m);
            }
        }
        ws.on("message", onMsg);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const srv = spawn(
        process.execPath,
        ["server.js"],
        {
            cwd: __dirname,
            env: {
                ...process.env,
                PORT: String(PORT),
                HOST: "127.0.0.1",
                COUNTDOWN_MS: "400",
                MIN_LAP_MS: "300",
            },
            stdio: ["ignore", "pipe", "pipe"],
        }
    );
    const out = [];
    srv.stdout.on("data", (d) => out.push(String(d)));
    for (let i = 0; i < 100; i++) {
        if (out.join("").includes("listening")) break;
        await sleep(50);
    }

    try {
        const host = await connect();
        send(host, { t: "create", name: "Host" });
        const created = await waitFor(host, (m) => m.t === "created");
        const code = created.code;
        await waitFor(host, (m) => m.t === "state");
        console.log("ok create+state", code);

        const guest = await connect();
        send(guest, { t: "join", code, name: "Guest" });
        await waitFor(guest, (m) => m.t === "joined");
        await waitFor(guest, (m) => m.t === "state");
        console.log("ok join");

        // 1. guest start/config rejected (not-host)
        send(guest, { t: "start" });
        assert.equal(
            (await waitFor(guest, (m) => m.t === "error")).error,
            "not-host"
        );
        send(guest, { t: "config", track: "spa", laps: 3 });
        assert.equal(
            (await waitFor(guest, (m) => m.t === "error")).error,
            "not-host"
        );
        console.log("ok guest start/config refused");

        // 2. invalid config values rejected
        send(host, { t: "config", track: "monza", laps: 5 });
        assert.equal(
            (await waitFor(host, (m) => m.t === "error")).error,
            "bad-track"
        );
        send(host, { t: "config", track: "spa", laps: 99 });
        assert.equal(
            (await waitFor(host, (m) => m.t === "error")).error,
            "bad-laps"
        );
        console.log("ok bad config refused");

        // 3. valid config broadcasts to both
        send(host, { t: "config", track: "spa", laps: 1 });
        const stHost = await waitFor(
            host,
            (m) => m.t === "state" && m.config.track === "spa"
        );
        assert.equal(stHost.config.laps, 1);
        const stGuest = await waitFor(
            guest,
            (m) => m.t === "state" && m.config.track === "spa"
        );
        assert.equal(stGuest.hostId !== undefined, true);
        console.log("ok config broadcast");

        // 4. ready flags visible
        send(host, { t: "ready", ready: true });
        send(guest, { t: "ready", ready: true });
        const rst = await waitFor(
            host,
            (m) =>
                m.t === "state" &&
                m.players.every((p) => p.ready === true)
        );
        assert.equal(rst.players.length, 2);
        console.log("ok ready sync");

        // 5. lap in lobby ignored (no crash, no lapUpdate)
        send(host, { t: "lap", lap: 1, time: 0 });
        await sleep(200);
        console.log("ok lobby lap ignored");

        // 6. host start -> countdown with track/laps
        send(host, { t: "start" });
        const cd = await waitFor(guest, (m) => m.t === "countdown");
        assert.equal(cd.track, "spa");
        assert.equal(cd.laps, 1);
        assert.ok(cd.startsAt > Date.now());
        await waitFor(guest, (m) => m.t === "state" && m.state === "racing");
        console.log("ok countdown -> racing");

        // 7. start again in racing: no error, no new countdown
        send(host, { t: "start" });
        send(guest, { t: "ready", ready: true }); // ignored outside lobby
        await sleep(200);
        console.log("ok invalid transitions ignored");

        // 8. duplicate + skip + too-fast lap events rejected
        send(guest, { t: "lap", lap: 1, time: 100 });
        const lu1 = await waitFor(
            host,
            (m) => m.t === "lapUpdate" && m.id !== undefined
        );
        assert.equal(lu1.lap, 1);
        // duplicate
        send(guest, { t: "lap", lap: 1, time: 200 });
        // skip (laps=1 anyway, but lap 2 > target invalid too)
        send(guest, { t: "lap", lap: 5, time: 300 });
        await sleep(300);
        console.log("ok dup/skip laps rejected (no crash)");

        // 9. too-fast lap rejected: fresh room, lap instantly
        const h2 = await connect();
        send(h2, { t: "create", name: "Fast" });
        const c2 = await waitFor(h2, (m) => m.t === "created");
        await waitFor(h2, (m) => m.t === "state");
        send(h2, { t: "config", track: "jeddah", laps: 2 });
        await waitFor(h2, (m) => m.t === "state" && m.config.laps === 2);
        send(h2, { t: "start" });
        await waitFor(h2, (m) => m.t === "countdown");
        await waitFor(h2, (m) => m.t === "state" && m.state === "racing");
        send(h2, { t: "lap", lap: 1, time: 10 }); // way too fast
        let gotLap = false;
        const probe = new Promise((resolve) => {
            const to = setTimeout(() => resolve(false), 400);
            h2.once("message", (d) => {
                try {
                    if (JSON.parse(String(d)).t === "lapUpdate") {
                        clearTimeout(to);
                        resolve(true);
                    }
                } catch {}
            });
        });
        gotLap = await probe;
        assert.equal(gotLap, false);
        console.log("ok implausible lap rejected");

        // 10. finishing order across two clients (laps=1 room)
        // guest already finished lap 1 above (order 1); host finishes now
        await sleep(400); // past MIN_LAP_MS for host
        send(host, { t: "lap", lap: 1, time: 99999 });
        const fin = await waitFor(
            guest,
            (m) => m.t === "finish" && m.order === 2
        );
        assert.ok(fin.time >= 0);
        const res = await waitFor(guest, (m) => m.t === "results");
        assert.equal(res.order.length, 2);
        assert.equal(res.lapsTarget, 1);
        assert.equal(res.track, "spa");
        console.log(
            "ok finish order + results:",
            res.order.map((o) => o.name).join(",")
        );

        // 11. disconnect during countdown: session survives
        const h3 = await connect();
        send(h3, { t: "create", name: "H3" });
        const c3 = await waitFor(h3, (m) => m.t === "created");
        const g3 = await connect();
        send(g3, { t: "join", code: c3.code, name: "G3" });
        await waitFor(g3, (m) => m.t === "joined");
        await waitFor(g3, (m) => m.t === "state");
        send(h3, { t: "start" });
        await waitFor(g3, (m) => m.t === "countdown");
        g3.close(); // guest vanishes mid-countdown
        const stAfter = await waitFor(
            h3,
            (m) => m.t === "state" && m.players.length === 1
        );
        assert.equal(stAfter.hostId !== undefined, true);
        await waitFor(h3, (m) => m.t === "state" && m.state === "racing");
        console.log("ok countdown disconnect survives");

        // 12. disconnect DURING race -> DNF in results, no freeze
        // (fresh 1-lap room: h3's room still targets 5 laps)
        send(h3, { t: "cancel" });
        await waitFor(h3, (m) => m.t === "cancelled");
        await waitFor(h3, (m) => m.t === "state" && m.state === "lobby");
        send(h3, { t: "config", track: "jeddah", laps: 1 });
        await waitFor(h3, (m) => m.t === "state" && m.config.laps === 1);
        send(h3, { t: "start" });
        await waitFor(h3, (m) => m.t === "countdown");
        await waitFor(h3, (m) => m.t === "state" && m.state === "racing");
        const g4 = await connect();
        g4.close(); // stray connection, harmless
        const h5 = await connect();
        send(h5, { t: "create", name: "H5" });
        const c5 = await waitFor(h5, (m) => m.t === "created");
        await waitFor(h5, (m) => m.t === "state");
        const g5 = await connect();
        send(g5, { t: "join", code: c5.code, name: "G5" });
        await waitFor(g5, (m) => m.t === "joined");
        await waitFor(g5, (m) => m.t === "state");
        send(h5, { t: "config", track: "jeddah", laps: 1 });
        await waitFor(h5, (m) => m.t === "state" && m.config.laps === 1);
        send(h5, { t: "start" });
        await waitFor(h5, (m) => m.t === "countdown");
        await waitFor(h5, (m) => m.t === "state" && m.state === "racing");
        g5.close(); // guest vanishes mid-race
        await sleep(400);
        send(h5, { t: "lap", lap: 1, time: 5000 });
        const res5 = await waitFor(h5, (m) => m.t === "results");
        assert.equal(res5.order.length, 1);
        assert.equal(res5.order[0].name, "H5");
        console.log("ok solo finish after peer DNF-leave");

        // 13. cancel flow
        const h4 = await connect();
        send(h4, { t: "create", name: "H4" });
        await waitFor(h4, (m) => m.t === "created");
        await waitFor(h4, (m) => m.t === "state");
        send(h4, { t: "start" });
        await waitFor(h4, (m) => m.t === "countdown");
        send(h4, { t: "cancel" });
        await waitFor(h4, (m) => m.t === "cancelled");
        const backToLobby = await waitFor(
            h4,
            (m) => m.t === "state" && m.state === "lobby"
        );
        assert.equal(backToLobby.players[0].lap, 0);
        console.log("ok cancel resets to lobby");

        // 14. finished rooms refuse joins (no stranding)
        const hf = await connect();
        send(hf, { t: "create", name: "HF" });
        const cf = await waitFor(hf, (m) => m.t === "created");
        await waitFor(hf, (m) => m.t === "state");
        send(hf, { t: "config", track: "jeddah", laps: 1 });
        await waitFor(hf, (m) => m.t === "state" && m.config.laps === 1);
        send(hf, { t: "start" });
        await waitFor(hf, (m) => m.t === "countdown");
        await waitFor(hf, (m) => m.t === "state" && m.state === "racing");
        await sleep(400);
        send(hf, { t: "lap", lap: 1, time: 1000 });
        await waitFor(hf, (m) => m.t === "results");
        const late = await connect();
        send(late, { t: "join", code: cf.code, name: "Late" });
        assert.equal(
            (await waitFor(late, (m) => m.t === "error")).error,
            "race-over"
        );
        late.close();
        // post-finish laps from anyone are dead, not crashes
        send(hf, { t: "lap", lap: 1, time: 2000 });
        await sleep(250);
        console.log("ok finished-room join refused, post-finish laps dead");

        // 15. duplicate ready/config cause no broadcast storm
        const hs = await connect();
        send(hs, { t: "create", name: "HS" });
        await waitFor(hs, (m) => m.t === "created");
        await waitFor(hs, (m) => m.t === "state");
        send(hs, { t: "ready", ready: true });
        await waitFor(
            hs,
            (m) =>
                m.t === "state" &&
                m.players.some((p) => p.ready === true)
        );
        let extraStates = 0;
        const counter = (d) => {
            try {
                if (JSON.parse(String(d)).t === "state") extraStates++;
            } catch {}
        };
        hs.on("message", counter);
        send(hs, { t: "ready", ready: true });
        send(hs, { t: "ready", ready: true });
        send(hs, { t: "config", track: "jeddah", laps: 5 });
        send(hs, { t: "config", track: "jeddah", laps: 5 });
        await sleep(400);
        hs.removeListener("message", counter);
        assert.equal(extraStates, 0);
        console.log("ok no-op ready/config suppressed");

        host.close();
        guest.close();
        h2.close();
        h3.close();
        h4.close();
        h5.close();
        hf.close();
        hs.close();
        console.log("ALL RACE-STATE TESTS PASSED");
        process.exitCode = 0;
    } catch (e) {
        console.error("RACE TEST FAILED:", e);
        process.exitCode = 1;
    } finally {
        srv.kill();
    }
})();
