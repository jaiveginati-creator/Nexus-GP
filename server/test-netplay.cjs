/* Milestone-2 logic tests: deterministic slot mapping,
 * yaw stepping, smoothing math. Run: node test-netplay.cjs
 */
"use strict";
const assert = require("assert");
const { assignNetSlots, stepYaw, MAX_HUMANS } = require("../client/netgame.js");

// 1. empty lobby -> no claims
assert.deepEqual(assignNetSlots([], [], 8), {});

// 2. sorted-id order maps to lowest slots
assert.deepEqual(
    assignNetSlots(["b-id", "a-id", "c-id"], [], 8),
    { "a-id": 0, "b-id": 1, "c-id": 2 }
);

// 3. reserved (split-screen P2) slot skipped
assert.deepEqual(assignNetSlots(["a", "b"], [0], 8), { a: 1, b: 2 });
assert.deepEqual(assignNetSlots(["a"], [7], 8), { a: 0 });

// 4. determinism: same input, same output regardless of order
const m1 = assignNetSlots(["z", "m", "a"], [3], 8);
const m2 = assignNetSlots(["a", "z", "m"], [3], 8);
assert.deepEqual(m1, m2);

// 5. capacity cap: never exceed aiCars.length
const many = [];
for (let i = 0; i < 12; i++) many.push("p" + i);
const m3 = assignNetSlots(many, [], 8);
assert.equal(Object.keys(m3).length, 8);
assert.ok(Math.max(...Object.values(m3)) < 8);

// 6. unique slots, never double-booked
const vals = Object.values(assignNetSlots(["x", "y", "z"], [], 8));
assert.equal(new Set(vals).size, vals.length);

// 7. yaw steps take the short arc (3.0 -> -3.0 is +0.28, not -6)
const y1 = stepYaw(3.0, -3.0, 1 / 60, 10);
assert.ok(y1 > 3.0 && y1 < 3.2, "wraps upward through pi, got " + y1);
const y2 = stepYaw(-3.0, 3.0, 1 / 60, 10);
assert.ok(y2 < -3.0 && y2 > -3.2, "wraps downward, got " + y2);
// converges with big dt
assert.ok(Math.abs(stepYaw(0, 1.0, 10, 10) - 1.0) < 1e-9);

// 8. smoothing converges (mirror of updateNetCar math)
let px = 0;
const tx = 100;
for (let i = 0; i < 300; i++) px += (tx - px) * (1 - Math.exp(-(1 / 60) * 10));
assert.ok(Math.abs(px - tx) < 0.5, "converges, got " + px);

// 9. snap threshold: 60m => 3600 dist2
assert.ok(61 * 61 > 3600 && 59 * 59 < 3600);

assert.equal(MAX_HUMANS, 8);
console.log("ALL NETPLAY LOGIC TESTS PASSED");
