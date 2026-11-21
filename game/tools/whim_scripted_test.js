// Whims end to end with no model: scripted replies (tool calls) drive the shaper's Pi agent through the plan
// checks and the honesty layer (server/claims.js) to an outcome. Run: node game/tools/whim_scripted_test.js
import assert from "node:assert";
import * as WF from "../world.js";
import { shapeWhim } from "../../server/shaper.js";
import { localModel } from "../../server/model-server/index.js";
import { FakeClock, ScriptedReplies } from "./model_fakes.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SPOT = { x: 40, y: 40, r: 4 };
const MODEL = localModel({ alias: "scripted", baseUrl: "http://127.0.0.1:9/v1" });
const POND = { name: "A pond", say: "Fills the spot with water.", edits: [{ area: "spot", water: 0.5 }] };
const call = (name, args) => [{ name, arguments: args }];
const toolErrors = (r) => r.events.filter((e) => e.kind === "tool_error").map((e) => e.message);

async function whim(text, steps, { clock = new FakeClock(1000), world = WF.makeWorld(7, 0) } = {}) {
  const replies = new ScriptedReplies(steps);
  const result = await shapeWhim({ world, spot: SPOT, whim: text, model: MODEL, replies, clock });
  return { ...result, replies };
}

test("a plan tried and then committed is committed, with the checked plan and its explanation", async () => {
  const world = WF.makeWorld(7, 0);
  const before = JSON.stringify(WF.save(world));
  const r = await whim("make a pond here", [call("try_plan", { plan: POND }), call("commit", { plan: POND })], { world });
  assert.strictEqual(r.outcome, "committed");
  assert.strictEqual(r.committed, true);
  assert.strictEqual(r.plan.name, "A pond");
  assert.strictEqual(r.say, "Fills the spot with water.");
  assert.ok(r.explain.length > 0);
  assert.deepStrictEqual(r.events.map((e) => e.kind), ["start", "tool", "tried", "tool", "committed"]);
  assert.strictEqual(r.toolCalls, 2);
  assert.strictEqual(r.error, null);
  assert.ok(JSON.stringify(WF.save(world)) === before, "the shaper works on a copy");
  // The model was asked twice; the second request carried the preview's result.
  assert.strictEqual(r.replies.contexts.length, 2);
  assert.ok(r.replies.contexts[1].messages.some((m) => m.role === "toolResult" && m.toolName === "try_plan"));
});

test("the clock times the whim: events and seconds come from it", async () => {
  const r = await whim("make a pond here", [call("commit", { plan: POND })], { clock: new FakeClock(5000) });
  assert.ok(r.events.every((e) => e.at === 5000));
  assert.strictEqual(r.seconds, 0);
  assert.strictEqual(r.waitSeconds, 0);
});

test("a whim that asks for something Glomus lacks is proposed, with what can't be done", async () => {
  const r = await whim("make it rain here for three days", [call("propose", { plan: POND, unsupported: ["days"] })]);
  assert.strictEqual(r.outcome, "proposed");
  assert.strictEqual(r.committed, false);
  assert.deepStrictEqual(r.unsupported, ["days"]);
  assert.deepStrictEqual(toolErrors(r), []);
});

test("a proposal for a whim that needs nothing missing is pushed back once, then the commit goes through", async () => {
  const r = await whim("make a pond here", [call("propose", { plan: POND, unsupported: ["a deeper pond"] }), call("commit", { plan: POND })]);
  assert.strictEqual(r.outcome, "committed");
  assert.strictEqual(toolErrors(r).length, 1);
  assert.match(toolErrors(r)[0], /^Not proposed yet: nothing in the whim asks for something Glomus can't do/);
});

test("a say that claims more than the plan does is refused by the honesty checks, and nothing is committed", async () => {
  const boast = { ...POND, say: "Raises the ground by 5 and fills it with water for 30 seconds." };
  const r = await whim("make a pond here", [call("commit", { plan: boast }), "I give up."]);
  assert.strictEqual(r.outcome, "answered");
  assert.strictEqual(r.committed, false);
  assert.strictEqual(r.plan, null);
  assert.match(toolErrors(r)[0], /^Nothing was committed: your say doesn't match the plan\./);
});

test("a decline that describes something buildable is pushed back once; a plain one stands", async () => {
  const r = await whim("make a pond here", [call("decline", { say: "I can't, but I could make a puddle instead." }), call("decline", { say: "Not possible." })]);
  assert.strictEqual(r.outcome, "declined");
  assert.strictEqual(r.say, "Not possible.");
  assert.match(toolErrors(r)[0], /^Not declined yet/);
});

test("a reply with only text ends the whim as answered", async () => {
  const r = await whim("make a pond here", ["I'm not sure what you mean."]);
  assert.strictEqual(r.outcome, "answered");
  assert.strictEqual(r.say, "I'm not sure what you mean.");
});

test("a reply dropped on the way is asked for again after the clock's pause, then the whim goes on", async () => {
  const clock = new FakeClock(0);
  let done = false;
  const pending = whim("make a pond here", [{ error: "fetch failed" }, call("commit", { plan: POND })], { clock }).finally(() => { done = true; });
  for (let i = 0; i < 50 && !done; i++) { await new Promise((r) => setTimeout(r, 5)); await clock.advance(1000); }
  const r = await pending;
  assert.strictEqual(r.outcome, "committed");
  assert.deepStrictEqual(r.events.filter((e) => e.kind === "retry").map((e) => e.message), ["fetch failed"]);
  assert.ok(clock.now() >= 3000, "the first retry waits 3 s of clock time");
});

test("the same failing call three times in a row stops the whim", async () => {
  const boast = { ...POND, say: "Raises the ground by 5 and fills it with water for 30 seconds." };
  const r = await whim("make a pond here", [call("commit", { plan: boast }), call("commit", { plan: boast }), call("commit", { plan: boast })]);
  assert.strictEqual(r.outcome, "failed");
  assert.ok(r.events.some((e) => e.kind === "error" && /repeated the same failing call/.test(e.message)));
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}
console.log(`\n${passed} passed`);
