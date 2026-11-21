// Fixtures for the honesty checks (server/claims.js), with no model involved. Run: node game/tools/claims_test.js
import assert from "node:assert";
import * as WF from "../world.js";
import { checkClaims, requestNeeds, routeOutcome } from "../../server/claims.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}
const world = WF.makeWorld(7, 0);
const clean = (plan) => WF.checkPlan(world, plan, { x: 35, y: 36, r: 4 }).clean;
const spot = "spot";
const rain = (when) => ({ name: "Rain", area: spot, when, do: [{ add_water: 0.4 }] });
const sink = (when) => ({ name: "Sink", area: spot, when, do: [{ lower: 0.25 }] });
const passes = (say, plan) => { const p = checkClaims(say, clean(plan)); assert.deepStrictEqual(p, [], "expected no problems, got:\n     " + p.join("\n     ")); };
const fails = (say, plan, re) => {
  const p = checkClaims(say, clean(plan));
  assert.ok(p.length, `expected a problem for ${JSON.stringify(say)}`);
  if (re) assert.ok(p.some((x) => re.test(x)), "problems were:\n     " + p.join("\n     "));
};

const DOUBLE = "Make it so when I left double-click, water replaces the land, by lowering the land or whatever mechanism for that area that works";

// ---------- R1: routing from the request ----------
test("Jon's double-click whim is proposed even with a clean plan, a clicking-only say and nothing listed", () => {
  const r = routeOutcome({ whim: DOUBLE, tool: "commit", unsupported: [], say: "The ground here sinks to 6 m and the lake floods in." });
  assert.strictEqual(r.outcome, "proposed");
  assert.ok(r.unsupported.some((u) => /double-click/.test(u)), r.unsupported.join(", "));
});
test("a request with nothing unsupported can be committed directly", () => {
  const r = routeOutcome({ whim: "Raise a little island in the middle of this lake", tool: "commit", say: "An island rises here." });
  assert.strictEqual(r.outcome, "committed");
});
test("click tools are only routed to a proposal while the game has none", () => {
  const whim = "Give me a tool that raises a hill where I click";
  assert.strictEqual(routeOutcome({ whim, tool: "commit", caps: { clickTools: false } }).outcome, "proposed");
  assert.strictEqual(routeOutcome({ whim, tool: "commit", caps: { clickTools: true } }).outcome, "committed");
  assert.strictEqual(routeOutcome({ whim: DOUBLE, tool: "commit", caps: { clickTools: true } }).outcome, "proposed", "double-click stays unsupported with click tools");
});
test("key bindings, hover, days, sounds and creatures are detected in the request", () => {
  const needs = (w) => requestNeeds(w).map((n) => n.what);
  assert.ok(needs("When I press the R key, make it rain on the spot under my mouse").includes("a key binding"));
  assert.ok(needs("When I press the R key, make it rain on the spot under my mouse").includes("following the mouse pointer"));
  assert.ok(needs("press R to make it rain").includes("a key binding"));
  assert.ok(needs("Fire everywhere randomly for 2 days")[0].startsWith("days"));
  assert.ok(needs("play a thunder sound when it rains").includes("sounds"));
  assert.ok(needs("a herd of deer that wanders the meadows").includes("herds and packs"), "herds wait for step 3");
  assert.deepStrictEqual(needs("Carve a stream from here down into the nearest lake"), []);
  assert.deepStrictEqual(needs("A floodgate here that releases a burst of water for 10 seconds every 30 seconds"), []);
  assert.deepStrictEqual(needs("Let glowing moss creep along the river banks"), []);
});
test("a negated mention in the request is not a need", () => {
  assert.deepStrictEqual(requestNeeds("make the lake bigger without me having to double-click anything"), []);
});
test("a commit whose say admits a gap is a proposal; there is no remove-the-sentence escape", () => {
  const r = routeOutcome({ whim: "make the hills breathe", tool: "commit", say: "I can't make hills breathe, so they pulse with water instead." });
  assert.strictEqual(r.outcome, "proposed");
  assert.ok(r.unsupported.length);
});
test("a commit listing unsupported parts is a proposal; decline is declined", () => {
  assert.strictEqual(routeOutcome({ whim: "x", tool: "commit", unsupported: ["the R key"] }).outcome, "proposed");
  assert.strictEqual(routeOutcome({ whim: "x", tool: "decline" }).outcome, "declined");
});

// ---------- R2: typed claims matched to the effect ----------
test("'sinks to 6 m' needs a height bound, not lower: 6 (a rate)", () => {
  fails("The ground slowly sinks to about 6 m.", { threads: [{ ...sink([]), do: [{ lower: 6 }] }] }, /ends up at 6 m/);
  passes("The ground slowly sinks to about 6 m.", { threads: [sink([{ height: [">", 6] }])] });
  passes("The ground is flattened to 6 m.", { edits: [{ area: spot, level: 6 }] });
});
test("Jon's original plan and message fail: no trigger, no stop", () => {
  const p = checkClaims("When you left double-click here, the ground slowly sinks to about 6 m — below the lake's surface — and the water rushes in to cover it.",
    clean({ threads: [{ name: "Sink the clicked ground", area: { circle: [35, 36, 4] }, when: [], do: [{ lower: 0.25 }] }] }));
  assert.ok(p.some((x) => /double-click/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /6 m/.test(x)), p.join("\n"));
});
test("'rains for 30 seconds' needs within 30, not after 30 (a delay)", () => {
  fails("It rains here for 30 seconds.", { threads: [rain([{ after: 30 }])] }, /lasts 30 seconds/);
  passes("It rains here for 30 seconds.", { threads: [rain([{ within: 30 }])] });
});
test("'the rain stops' fails when only an unrelated thread is limited", () => {
  fails("The rain stops on its own.", { threads: [rain([]), sink([{ height: [">", 6] }])] }, /"Rain" never stops/);
  passes("The rain stops on its own.", { threads: [rain([{ within: 20 }]), sink([{ height: [">", 6] }])] });
});
test("an admission exempts only its own clause", () => {
  fails("I can't bind keys, but the rain stops after 30 seconds.", { threads: [rain([])] });
  fails("I can't bind keys, but the rain stops after 30 seconds.", { threads: [rain([{ after: 30 }])] });
  passes("I can't bind keys, but the rain stops after 30 seconds.", { threads: [rain([{ within: 30 }])] });
});
test("'stops after 30 seconds' is an ending (within), 'starts after 10 seconds' is a delay (after)", () => {
  passes("The rain stops after 30 seconds.", { threads: [rain([{ within: 30 }])] });
  fails("The rain starts after 10 seconds.", { threads: [rain([{ within: 10 }])] }, /starts after/);
  passes("The rain starts after 10 seconds.", { threads: [rain([{ after: 10 }])] });
  passes("After a minute, the rain stops.", { threads: [rain([{ within: 60 }])] });
});
test("a cycle's window backs \"for N seconds\" said with the cycle; the thread that breaks a claim is named with a fix", () => {
  const gate = { name: "Floodgate release", area: spot, when: [{ cycle: 30, from: 0, to: 10 }], do: [{ add_water: 2 }] };
  passes("It runs in 30-second cycles, releasing water for 10 seconds each cycle.", { threads: [gate] });
  passes("A 10-second burst of water each cycle, every 30 seconds.", { threads: [gate] });
  fails("It runs in 30-second cycles.", { threads: [rain([])] }, /every 30-second|"cycle": 30/);
  // A second water thread that never pauses makes "for 10 seconds every 30 seconds" untrue (seen from a model).
  const always = { name: "Water reservoir", area: spot, when: [{ material: ["soil"] }], do: [{ add_water: 1 }] };
  fails("A floodgate that releases water for 10 seconds every 30 seconds.", { threads: [always, gate] }, /thread "Water reservoir" doesn't stop .* "when": \[\{"material":\["soil"\]\},\{"cycle":30,"from":0,"to":10\}\]/);
  fails("A rain cloud rains for 10 seconds.", { threads: [rain([])] }, /thread "Rain" doesn't stop after 10 seconds\. Either give thread "Rain" "when": \[\{"within":10\}\]/);
});
test("durations, recurrences and deltas are checked; minutes convert", () => {
  passes("A burst of water for 10 seconds every 30 seconds.", { threads: [rain([{ cycle: 30, from: 0, to: 10 }])] });
  // A within as long as the burst ends the thread for good: it would never repeat.
  fails("A burst of water for 10 seconds every 30 seconds.", { threads: [rain([{ cycle: 30, from: 0, to: 10 }, { within: 10 }])] }, /never|before the cycle comes round/);
  fails("A burst of water for 20 seconds every 30 seconds.", { threads: [rain([{ cycle: 30, from: 0, to: 10 }])] }, /"to":20/);
  fails("A burst of water for 10 seconds.", { threads: [rain([{ cycle: 30, from: 0, to: 10 }])] }, /within/);
  passes("A burst of water every 30 seconds for the next minute.", { threads: [rain([{ cycle: 30, from: 0, to: 10 }, { within: 60 }])] });
  fails("A burst of water every 30 seconds.", { threads: [rain([])] }, /every 30 seconds/);
  passes("A wildfire sweeps these hills for one minute, then burns out.", {
    materials: [{ name: "fire", color: "#ff5522" }],
    threads: [{ name: "Fire", area: spot, when: [{ within: 60 }], do: [{ spread: "fire", chance: 0.2 }] }] });
  fails("A wildfire sweeps these hills for one minute, then burns out.", {
    materials: [{ name: "fire", color: "#ff5522" }],
    threads: [{ name: "Fire", area: spot, when: [{ within: 120 }], do: [{ spread: "fire", chance: 0.2 }] }] });
  passes("I dug a channel 2 m deep.", { edits: [{ area: spot, lower: 2 }] });
  fails("I dug a channel 2 m deep.", { edits: [{ area: spot, lower: 0.5 }] }, /change of 2 m/);
  passes("The ground sinks 0.25 m per second.", { threads: [sink([])] });
});
test("input, long time units and future events in affirmative clauses fail", () => {
  fails("Double-click anywhere to sink the ground.", { threads: [sink([])] }, /double-click/i);
  fails("Press R and it rains.", { threads: [rain([])] }, /Press R/i);
  fails("Click anywhere to make it rain.", { threads: [rain([])] }, /click/);
  fails("Fire burns everywhere for 2 days.", { threads: [rain([{ within: 120 }])] }, /days/);
  fails("Nature will regrow it afterwards.", { threads: [rain([{ within: 60 }])] }, /later/);
  passes("The world has no days, so it burns for 2 minutes instead.", { materials: [{ name: "fire", color: "#ff5522" }], threads: [{ name: "Fire", area: spot, when: [{ within: 120 }], do: [{ spread: "fire" }] }] });
});
test("prose without recognized claims passes, so it isn't 'verified' — only unchecked", () => {
  passes("The stones bead with water and it trickles off downhill.", { threads: [rain([{ water: ["<", 0.3] }])] });
  passes("An island rises here in the lake.", { edits: [{ area: spot, raise: 4 }] });
});

test("'lasts N' is a duration, and dashes split clauses", () => {
  fails("Glomus has no days — the fire lasts 2 minutes of game time.", { threads: [rain([])] }, /lasts 2 minutes/);
  passes("Glomus has no days — the rain lasts 2 minutes of game time.", { threads: [rain([{ within: 120 }])] });
});

test("'fades back after 4 minutes' is a later event (after), not an ending (within)", () => {
  const plan = (fadeWhen) => ({ materials: [{ name: "gold", color: "#ffcf40" }], threads: [
    { name: "turn gold", area: spot, when: [{ material: ["meadow"] }, { within: 240 }], do: [{ set_material: "gold" }] },
    { name: "fade back", area: spot, when: [{ material: ["gold"] }, ...fadeWhen], do: [{ set_material: "meadow" }] }] });
  fails("The meadows glow gold, then fade back to green after 4 minutes.", plan([{ within: 240 }]), /after 4 minutes/);
  passes("The meadows glow gold, then fade back to green after 4 minutes.", plan([{ after: 240 }]));
});

test("a can't-do entry may name the missing input or time unit, but its other claims are checked", () => {
  assert.deepStrictEqual(checkClaims("double-click. days", clean({ threads: [rain([])] }), undefined, { namesMissing: true }), []);
  const p = checkClaims("days: the fire lasts 2 minutes of game time", clean({ materials: [{ name: "fire", color: "#ff5522" }],
    threads: [{ name: "Fire", area: spot, when: [], do: [{ spread: "fire" }] }] }), undefined, { namesMissing: true });
  assert.ok(p.some((x) => /lasts 2 minutes/.test(x)), p.join("; "));
});

test("claiming an effect follows the player's selection or mouse fails: plan areas are fixed", () => {
  fails("Extra rain pours onto those tiles, so the rain follows wherever your selection is.", { threads: [rain([{ raining: true }])] }, /fixed/);
  passes("Extra rain pours onto the spot you picked whenever it rains.", { threads: [rain([{ raining: true }])] });
});

test("a claim that it rains on a click fails when the rain only falls in rainy weather", () => {
  const tool = (when) => ({ powers: [{ name: "Rain Cloud", brush: 4, threads: [{ name: "rain shower", when, do: [{ add_water: 0.5 }] }] }] });
  const say = "Pick the Rain Cloud tool, click the map, and it rains there for 10 seconds.";
  fails(say, tool([{ raining: true }, { within: 10 }]), /only acts while the weather is raining/);
  passes(say, tool([{ within: 10 }]));
  passes("Click the map and, whenever it rains, the rain there pours twice as hard for 10 seconds.", tool([{ raining: true }, { within: 10 }]));
  passes("Nature melts snow into water while it's dry.", { threads: [{ name: "melt", area: spot, when: [{ raining: false }], do: [{ add_water: 0.01 }] }] });
});

// ---------- explainPlan: authoritative, built from the plan ----------
test("explainPlan says when a thread never stops, and how a height limit holds", () => {
  const lines = WF.explainPlan(clean({ threads: [sink([]), sink([{ height: [">", 6] }]), rain([{ within: 30 }])] }), world);
  assert.match(lines[0], /Never stops on its own/);
  assert.match(lines[1], /Stops lowering at 6 m, and lowers again if the ground rises/);
  assert.match(lines[2], /Stops for good 30 s after it lands/);
});

console.log(`\n${passed} passed`);
