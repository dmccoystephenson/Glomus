// How the 3D view looks (the second half of game/view3d.js) without a browser: the sun follows the world's clock, the ground is
// finer than the tiles and stays true to them, the water, the animals' bodies, glowing ground and the small
// lights. Run: node game/tools/look3d_test.js
import assert from "node:assert";
import * as WF from "../world.js";
import { skyAt, skyFloats, dayPhase, DAY_SECONDS, groundOf, waterOf, bodyMesh, poseMatrix, glows, glowsOf, pointsOf } from "../view3d.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}
const TPS = WF.TPS || 10, DAY = DAY_SECONDS * TPS;

test("the sun follows the world's clock: up in the morning, down at night, round again next day", () => {
  const morning = skyAt(0), noon = skyAt(DAY * 0.22), night = skyAt(DAY * 0.75), again = skyAt(DAY);
  assert.ok(morning.toSun[1] > 0.1 && morning.night === 0, "a new world starts in daylight: " + morning.toSun);
  assert.ok(noon.toSun[1] > morning.toSun[1], "higher towards noon");
  assert.ok(night.toSun[1] < 0 && night.night > 0.9, "night: " + night.toSun);
  assert.deepStrictEqual(again.toSun, morning.toSun, "a day later it's the same hour");
  assert.ok(morning.toSun[0] > 0 && skyAt(DAY * 0.55).toSun[0] < 0, "rises in the east (+X), sets in the west");
  assert.ok(night.light < noon.light && night.lift[2] > 0, "night is darker but never black");
  assert.strictEqual(skyFloats(noon).length, 13);
  assert.ok(dayPhase(0) >= 0 && dayPhase(DAY * 3.5) < 1);
});

test("pinned daylight keeps the sun up whatever the hour, and rain dims it", () => {
  for (const tick of [0, DAY * 0.3, DAY * 0.75, DAY * 0.9]) {
    const s = skyAt(tick, { pinned: true });
    assert.ok(s.toSun[1] > 0.4 && s.night === 0, `pinned at ${tick}: ${s.toSun}`);
  }
  const dry = skyAt(0, { pinned: true }), wet = skyAt(0, { pinned: true, rain: 1 });
  assert.ok(wet.intensity < dry.intensity * 0.6 && wet.light < dry.light);
});

const world = WF.makeWorld(5);
for (let k = 0; k < 200; k++) WF.step(world);

test("the ground is four times finer than the tiles, and still stands on them", () => {
  const g = groundOf(WF, world, 4);
  assert.strictEqual(g.nx, (WF.W - 1) * 4 + 1);
  assert.strictEqual(g.nz, (WF.H - 1) * 4 + 1);
  assert.strictEqual(g.heights.length, g.nx * g.nz);
  assert.ok(g.nx <= 1025 && g.nz <= 1025, "Strata's terrain limit");
  let worst = 0;
  for (let y = 0; y < WF.H; y++) for (let x = 0; x < WF.W; x++) worst = Math.max(worst, Math.abs(g.heights[(y * 4) * g.nx + x * 4] - world.height[y * WF.W + x]));
  assert.ok(worst < 0.2, "tile centres stay within fine relief of the tile heights: " + worst);
  // Between two tiles the ground never bulges past them (bar the fine relief): no cliff-foot overshoot.
  const y = 30, row = (i) => g.heights[(y * 4) * g.nx + i];
  for (let x = 0; x < WF.W - 1; x++) {
    const a = world.height[y * WF.W + x], b = world.height[y * WF.W + x + 1];
    for (let s = 1; s < 4; s++) assert.ok(row(x * 4 + s) <= Math.max(a, b) + 0.2 && row(x * 4 + s) >= Math.min(a, b) - 0.2, `between ${x} and ${x + 1}`);
  }
  assert.ok(g.colors.every((v) => Number.isFinite(v) && v >= 0), "colours are finite and not negative");
  const half = groundOf(WF, world, 2);
  assert.strictEqual(half.nx * half.nz, 191 * 127, "the lowest tier's ground");
});

test("the same world looks the same twice (deterministic), and rain darkens the land", () => {
  const a = groundOf(WF, world, 4), b = groundOf(WF, world, 4), wet = groundOf(WF, world, 4, { wet: 1 });
  assert.deepStrictEqual(a.colors, b.colors);
  const sum = (c) => c.reduce((s, v) => s + v, 0);
  assert.ok(sum(wet.colors) < sum(a.colors) * 0.9);
});

test("water: only where it's wet, with a colour and alpha per vertex", () => {
  const g = groundOf(WF, world, 4), wt = waterOf(WF, world, g, 2);
  assert.ok(wt.idx.length > 0 && wt.idx.length % 3 === 0);
  assert.ok(wt.idx.every((i) => i < wt.pos.length / 3));
  assert.strictEqual(wt.col.length, (wt.pos.length / 3) * 4, "RGBA per vertex");
  const dry = WF.makeWorld(5); dry.water.fill(0);
  assert.strictEqual(waterOf(WF, dry, groundOf(WF, dry, 4), 2).idx.length, 0, "a dry map has no water mesh");
});

test("an animal's body: a trunk, head, ears, eyes and tail; Mossback wears moss", () => {
  const plain = bodyMesh({ color: "#e8d27a", pattern: "dot" }), moss = bodyMesh({ color: "#e8d27a" }, { mossy: true });
  assert.ok(plain.pos.length / 3 > 300 && plain.idx.length / 3 > 400, "geometry: " + plain.pos.length / 3);
  assert.ok(moss.pos.length > plain.pos.length, "moss tufts add geometry");
  assert.ok(plain.idx.every((i) => i < plain.pos.length / 3));
  let front = -Infinity, back = Infinity;
  for (let k = 0; k < plain.pos.length; k += 3) { front = Math.max(front, plain.pos[k]); back = Math.min(back, plain.pos[k]); }
  assert.ok(front > 0.7 && back < -0.5, "faces +X, its head in front");
  const striped = bodyMesh({ color: "#e8d27a", pattern: "stripe" });
  assert.notDeepStrictEqual(striped.col, plain.col, "the pattern shows on the coat");
});

test("a pose turns the body to face where it walks", () => {
  const m = poseMatrix(1, 2, 3, Math.PI / 2);
  // Local +X (the head) goes to world +Z for a heading of 90 degrees.
  assert.ok(Math.abs(m[0]) < 1e-6 && Math.abs(m[2] - 1) < 1e-6, m.join());
  assert.deepStrictEqual([m[12], m[13], m[14], m[15]], [1, 2, 3, 1]);
  const t = poseMatrix(0, 0, 0, 0, 0.4);
  assert.ok(t[1] < 0, "a grazing pitch tips the nose down");
});

test("glowing ground: found by its material's name, a light over each patch", () => {
  assert.ok(glows("glowing moss") && glows("lava") && !glows("meadow") && !glows("stone"));
  const w = WF.makeWorld(5);
  assert.strictEqual(glowsOf(WF, w).lights.length, 0);
  w.materials.push({ name: "glowing moss", color: "#6dffb0", erodes: 0.2 });
  for (let x = 10; x < 20; x++) { const i = 10 * WF.W + x; w.mat[i] = w.materials.length - 1; w.water[i] = 0; }
  const g = glowsOf(WF, w);
  assert.ok(g.lights.length >= 1 && g.lights[0].length === 9, JSON.stringify(g.lights));
  assert.ok(g.lights[0][5] > g.lights[0][4], "a green patch glows green");
});

test("small lights: stars and fireflies by night only, glints by day", () => {
  const wet = [];
  for (let i = 0; i < 300; i++) wet.push({ x: i % 90, y: (i / 90) | 0, top: 2, flux: 0.01, dx: 1, dy: 0 });
  const day = pointsOf(WF, world, skyAt(0, { pinned: true }), 3, { wet }), night = pointsOf(WF, world, skyAt(DAY * 0.78), 3, { wet });
  assert.strictEqual(day.length % 10, 0);
  const high = (p) => { let n = 0; for (let k = 0; k < p.length; k += 10) if (p[k + 1] > 200) n++; return n; };
  assert.strictEqual(high(day), 0, "no stars by day");
  assert.ok(high(night) > 100, "stars at night: " + high(night));
  for (let k = 0; k < night.length; k += 10) assert.ok(night[k + 8] >= 0 && night[k + 8] <= 1 && (night[k + 9] & ~3) === 0);
});

console.log(`\n${passed} passed, ${process.exitCode ? "some failing" : "0 failing"}`);
