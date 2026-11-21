// Tool arguments as some models send them (server/shaper.js unstring), with no model involved.
// Run: node game/tools/shaper_args_test.js
import assert from "node:assert";
import * as WF from "../world.js";
import { unstring, lookAt } from "../../server/shaper.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}

test("an area written as Python-style text is read as the area it spells (seen from Qwen3-Coder via llama.cpp)", () => {
  assert.deepStrictEqual(unstring("{'circle': [39, 3, 10]}"), { circle: [39, 3, 10] });
  assert.deepStrictEqual(unstring(' {"rect": [35, 0, 10, 10]} '), { rect: [35, 0, 10, 10] });
  assert.deepStrictEqual(unstring({ plan: { threads: "[{'name': 'Rain', 'on': True, 'x': None}]" } }), { plan: { threads: [{ name: "Rain", on: true, x: null }] } });
});
test("look accepts the text form, so the model sees the area instead of an error", () => {
  const world = WF.makeWorld(7, 0);
  assert.match(lookAt(world, unstring("{'circle': [39, 3, 10]}"), null), /^circle at \(39,3\) r 10/);
});
test("anything else is left exactly as it was", () => {
  for (const v of ["spot", "everywhere", "{not an area", "The rocks {glow}", "{'say': \"it's\"", 3, null, ["spot"]]) assert.deepStrictEqual(unstring(v), v);
});

console.log(`\n${passed} passed`);
