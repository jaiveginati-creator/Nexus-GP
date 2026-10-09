/* Milestone-3 client tests: NetGame.reportLap guards and
 * NetClient new protocol methods + dispatch. No sockets.
 * Run: node test-netclient.cjs
 */
"use strict";

const assert = require("assert");
const path = require("path");

function loadClientFile(name) {
    return require(path.join(__dirname, "..", "client", name));
}

const { NetClient } = loadClientFile("multiplayer.js");
loadClientFile("netgame.js");
const NetGame = globalThis.NetGame;
assert.ok(NetGame, "NetGame global set");
assert.equal(typeof NetClient, "function");

// 1. reportLap gating: needs connection + racing/countdown,
//    suppresses duplicates.
{
    const sent = [];
    NetGame.connected = true;
    NetGame.client = { sendLap: (l, t) => sent.push([l, t]) };
    NetGame.roomState = "racing";
    NetGame.lastSentLap = 0;
    NetGame.reportLap(1, 61000);
    assert.deepEqual(sent, [[1, 61000]]);
    NetGame.reportLap(1, 62000); // duplicate suppressed
    assert.deepEqual(sent, [[1, 61000]]);
    NetGame.roomState = "lobby";
    NetGame.reportLap(2, 90000); // wrong state
    assert.deepEqual(sent, [[1, 61000]]);
    NetGame.roomState = "racing";
    NetGame.connected = false;
    NetGame.reportLap(2, 90000); // offline
    assert.deepEqual(sent, [[1, 61000]]);
    NetGame.connected = false;
    NetGame.client = null;
    console.log("ok reportLap guards");
}

// 2. new send methods serialize correctly.
{
    const captured = [];
    const c = Object.create(NetClient.prototype);
    c.url = "ws://x";
    c.ws = {
        readyState: 1,
        send: (m) => captured.push(JSON.parse(m)),
    };
    c.sendReady(true);
    c.sendConfig("spa", 3);
    c.sendStart();
    c.sendCancel();
    c.sendLap(2, 45000);
    assert.deepEqual(captured, [
        { t: "ready", ready: true },
        { t: "config", track: "spa", laps: 3 },
        { t: "start" },
        { t: "cancel" },
        { t: "lap", lap: 2, time: 45000 },
    ]);
    console.log("ok send shapes");
}

// 3. dispatch of new server messages reaches callbacks.
{
    const seen = [];
    const c = Object.create(NetClient.prototype);
    c.onLobby = () => {};
    c.onPeer = () => {};
    c.onLeft = () => {};
    c.onError = () => {};
    c.onDisconnect = () => {};
    c.onCreated = () => {};
    c.onJoined = () => {};
    c.onState = (m) => seen.push(["state", m.state]);
    c.onCountdown = (m) => seen.push(["countdown", m.laps]);
    c.onLapUpdate = (m) => seen.push(["lapUpdate", m.lap]);
    c.onFinish = (m) => seen.push(["finish", m.order]);
    c.onResults = (m) => seen.push(["results", m.order.length]);
    c.onCancelled = () => seen.push(["cancelled"]);
    c.ws = { readyState: 1, send: () => {}, close: () => {} };
    c._attach();
    const fire = (obj) => c.ws.onmessage({ data: JSON.stringify(obj) });
    fire({ t: "state", state: "racing" });
    fire({ t: "countdown", laps: 5 });
    fire({ t: "lapUpdate", id: "a", lap: 2 });
    fire({ t: "finish", id: "a", order: 1, time: 100 });
    fire({ t: "results", order: [{}, {}] });
    fire({ t: "cancelled" });
    fire({ t: "something-new", x: 1 }); // forward-compat: ignored
    assert.deepEqual(seen, [
        ["state", "racing"],
        ["countdown", 5],
        ["lapUpdate", 2],
        ["finish", 1],
        ["results", 2],
        ["cancelled"],
    ]);
    console.log("ok dispatch (+unknown ignored)");
}

console.log("ALL NETCLIENT TESTS PASSED");
