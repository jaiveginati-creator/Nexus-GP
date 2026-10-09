/* Automated milestone-1 test: spins server.js, drives it
 * with raw WebSocket clients. Run: npm test
 * (needs devDependency install first: npm install).
 */
"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const PORT = 18765;
const URL = `ws://127.0.0.1:${PORT}`;

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(URL);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });
}

function nextMsg(ws, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            ws.removeListener("message", onMsg);
            reject(new Error("timeout waiting for message"));
        }, timeoutMs);
        function onMsg(data) {
            clearTimeout(t);
            resolve(JSON.parse(String(data)));
        }
        ws.once("message", onMsg);
    });
}

function send(ws, obj) {
    ws.send(JSON.stringify(obj));
}

(async () => {
    const srv = spawn(
        process.execPath,
        ["server.js"],
        {
            cwd: __dirname,
            env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
            stdio: ["ignore", "pipe", "pipe"],
        }
    );
    const out = [];
    srv.stdout.on("data", (d) => out.push(String(d)));
    // Wait for listen line.
    for (let i = 0; i < 100; i++) {
        if (out.join("").includes("listening")) break;
        await new Promise((r) => setTimeout(r, 50));
    }

    try {
        // 1. create -> code + id + self in lobby
        const a = await connect();
        send(a, { t: "create", name: "Host" });
        const created = await nextMsg(a);
        assert.equal(created.t, "created");
        assert.match(created.code, /^[A-Z0-9]{5}$/);
        assert.ok(created.id);
        assert.equal(created.players.length, 1);
        const code = created.code;
        console.log("ok create", code);

        // 2. join -> both see lobby of 2
        const b = await connect();
        send(b, { t: "join", code, name: "Guest" });
        const joined = await nextMsg(b);
        assert.equal(joined.t, "joined");
        const lobbyOnA = await nextMsg(a);
        assert.equal(lobbyOnA.t, "lobby");
        assert.equal(lobbyOnA.players.length, 2);
        console.log("ok join + lobby sync");

        // 3. bad code / unknown room rejected
        const c = await connect();
        send(c, { t: "join", code: "!!", name: "X" });
        assert.equal((await nextMsg(c)).error, "bad-code");
        send(c, { t: "join", code: "ZZZZZ", name: "X" });
        assert.equal((await nextMsg(c)).error, "no-room");
        c.close();
        console.log("ok bad-code / no-room");

        // 4. pos relay a->b (and not echoed to a)
        send(a, { t: "pos", x: 10, z: 20, yaw: 1.5, speed: 40 });
        const peer = await nextMsg(b);
        assert.equal(peer.t, "peer");
        assert.equal(peer.x, 10);
        assert.equal(peer.z, 20);
        console.log("ok pos relay");

        // 5. malformed + out-of-range tolerated, server alive
        b.send("not json{{{");
        send(b, { t: "pos", x: 1e12, z: "NaN", yaw: 0, speed: 0 });
        send(b, { t: "bogus" });
        await new Promise((r) => setTimeout(r, 60)); // server rate cap
        send(a, { t: "pos", x: 11, z: 21, yaw: 1.6, speed: 41 });
        const peer2 = await nextMsg(b);
        assert.equal(peer2.x, 11);
        console.log("ok malformed tolerated");

        // 6. fill to 8, 9th rejected
        const extras = [];
        for (let i = 0; i < 6; i++) {
            const w = await connect();
            send(w, { t: "join", code, name: "P" + i });
            const m = await nextMsg(w);
            assert.equal(m.t, "joined");
            extras.push(w);
            await nextMsg(a); // lobby broadcast drain
        }
        const full = await connect();
        send(full, { t: "join", code, name: "TooMany" });
        assert.equal((await nextMsg(full)).error, "room-full");
        full.close();
        console.log("ok 8-player cap");

        // 7. leave notifies + frees slot
        extras[0].close(); // abrupt disconnect
        const leftMsg = await nextMsg(a);
        assert.equal(leftMsg.t, "left");
        const rejoin = await connect();
        send(rejoin, { t: "join", code, name: "Back" });
        assert.equal((await nextMsg(rejoin)).t, "joined");
        console.log("ok disconnect + slot freed");

        a.close();
        b.close();
        extras.slice(1).forEach((w) => w.close());
        rejoin.close();
        console.log("ALL PROTO TESTS PASSED");
        process.exitCode = 0;
    } catch (e) {
        console.error("PROTO TEST FAILED:", e);
        process.exitCode = 1;
    } finally {
        srv.kill();
    }
})();
