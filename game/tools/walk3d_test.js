// Walking the 3D view (game/walk3d.js) without a browser: standing on the ground, what stops a step, and the
// camera that follows. Run: node game/tools/walk3d_test.js
import assert from "node:assert";
import * as WF from "../world.js";
import { groundAt, stepFrom, createWalker } from "../walk3d.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}
// walk3d.js listens for keys on window; under node there is none.
globalThis.window = globalThis.window || { addEventListener() {} };

const flat = (h = 5) => {
  const w = WF.makeWorld(3, 0);
  w.height.fill(h); w.water.fill(0);
  return w;
};

test("the visitor stands on the ground between tile samples, and on the water when it wades", () => {
  const w = flat(2);
  w.height[10 * WF.W + 10] = 4; w.height[10 * WF.W + 11] = 6;
  assert.strictEqual(groundAt(WF, w, 10, 10).ground, 4);
  assert.strictEqual(groundAt(WF, w, 10.5, 10).ground, 5);
  w.water[20 * WF.W + 20] = 0.5; w.water[20 * WF.W + 21] = 0.5; w.water[21 * WF.W + 20] = 0.5; w.water[21 * WF.W + 21] = 0.5;
  assert.strictEqual(groundAt(WF, w, 20.5, 20.5).water, 0.5);
  assert.strictEqual(groundAt(WF, w, 40, 40).water, 0, "a damp film isn't wading");
});

test("deep water and cliffs stop a step; the map's edge holds you in", () => {
  const w = flat(2);
  for (let y = 0; y < WF.H; y++) w.water[y * WF.W + 30] = 2;
  assert.strictEqual(stepFrom(WF, w, 29, 10, 1, 0).stopped, "deep");
  assert.strictEqual(stepFrom(WF, w, 20, 10, 0.3, 0).stopped, null);
  for (let y = 0; y < WF.H; y++) w.height[y * WF.W + 51] = 12;
  assert.strictEqual(stepFrom(WF, w, 50, 10, 1, 0).stopped, "cliff");
  const gentle = flat(2);
  for (let x = 0; x < WF.W; x++) for (let y = 0; y < WF.H; y++) gentle.height[y * WF.W + x] = 2 + x * 0.5;
  assert.strictEqual(stepFrom(WF, gentle, 50, 10, 1, 0).stopped, null, "a walkable slope");
  const edge = stepFrom(WF, w, 0.2, 10, -1, 0);
  assert.strictEqual(edge.x, 0); assert.strictEqual(edge.stopped, "edge");
});

test("walking goes where the camera faces, the camera follows, and stopping gives the old camera back", () => {
  const w = flat(3), kit = { cam: { yaw: Math.PI / 2, pitch: 0.75, dist: 95, tx: 0, ty: 6, tz: 0 }, limits: { minDist: 12, maxDist: 220, minPitch: 0.12, maxPitch: 1.45 } };
  const walker = createWalker({ WF, world: () => w });
  walker.start(kit, 40, 30);
  assert.strictEqual(kit.cam.dist, 7);
  walker.stick.y = 0.5;   // half forward on the stick
  for (let k = 0; k < 10; k++) walker.frame(kit, 0.1, k * 100);
  const p = walker.pos;
  assert.ok(Math.abs(p.x - 40) < 1e-6 && p.y < 30 - 1, `yaw π/2 faces -y on the map: ${JSON.stringify(p)}`);
  assert.ok(Math.abs(kit.cam.tz - (-(WF.H - 1) / 2 + p.y)) < 1e-6, "the camera's target is on the visitor");
  assert.strictEqual(walker.marks().length, 21, "three spheres for the body");
  walker.toggleView();
  assert.strictEqual(walker.marks(), null, "no body seen from inside it");
  walker.stop();
  assert.deepStrictEqual(kit.cam, { yaw: Math.PI / 2, pitch: 0.75, dist: 95, tx: 0, ty: 6, tz: 0 });
  assert.strictEqual(kit.limits.minDist, 12);
});

test("starting in deep water puts the visitor on the nearest dry ground", () => {
  const w = flat(2);
  for (let y = 0; y < WF.H; y++) for (let x = 0; x < 50; x++) w.water[y * WF.W + x] = 2;
  const walker = createWalker({ WF, world: () => w });
  walker.start({ cam: { yaw: 0, pitch: 0.5, dist: 30, tx: 0, ty: 0, tz: 0 }, limits: {} }, 20, 20);
  assert.strictEqual(walker.pos.x, 50);
});

test("use here reports the tile underfoot", () => {
  const w = flat(2), used = [];
  const walker = createWalker({ WF, world: () => w, onUseHere: (x, y) => used.push([x, y]) });
  walker.start({ cam: { yaw: 0, pitch: 0.5, dist: 30, tx: 0, ty: 0, tz: 0 }, limits: {} }, 12.4, 7.6);
  walker.useHere();
  assert.deepStrictEqual(used, [[12, 8]]);
});

console.log(`\n${passed} passed, ${process.exitCode ? "some failing" : "0 failing"}`);
