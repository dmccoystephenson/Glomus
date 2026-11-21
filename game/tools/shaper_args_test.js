// Tool arguments as some models send them (server/shaper.js unstring), with no model involved.
// Run: node game/tools/shaper_args_test.js
import assert from "node:assert";
import * as WF from "../world.js";
import { unstring, lookAt, pythonToJson, retryingStream, droppedReply, workClock, sameNameTools, selfStopping } from "../../server/shaper.js";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log("ok   " + name); }
    catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
  })());
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

test("Python-style text with apostrophes, escapes and trailing commas still reads as the object", () => {
  assert.deepStrictEqual(unstring(`{'say': "The stones sweat; it's wet", 'edits': [],}`), { say: "The stones sweat; it's wet", edits: [] });
  assert.deepStrictEqual(unstring(`{'say': 'a \\'quoted\\' "word"'}`), { say: `a 'quoted' "word"` });
  assert.deepStrictEqual(unstring(`[{'when': [{'not': {'raining': True}}], 'do': []}]`), [{ when: [{ not: { raining: true } }], do: [] }]);
  assert.strictEqual(pythonToJson(`{'say': "never closes}`), null);
  assert.strictEqual(unstring(`{'say': "never closes}`), `{'say': "never closes}`);
});

// A fake model stream: each attempt either finishes or fails the way a dropped connection does.
const reply = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 });
const failure = (errorMessage) => ({ role: "assistant", content: [], stopReason: "error", errorMessage, timestamp: 0 });
function fakeModel(attempts) {
  let n = 0;
  const fn = () => {
    const s = createAssistantMessageEventStream(), m = attempts[Math.min(n++, attempts.length - 1)];
    setTimeout(() => {
      s.push({ type: "start", partial: { ...m, content: [] } });
      s.push(m.stopReason === "error" ? { type: "error", reason: "error", error: m } : { type: "done", reason: "stop", message: m });
    }, 1);
    return s;
  };
  return Object.assign(fn, { calls: () => n });
}
const finalOf = async (stream) => { const evs = []; for await (const e of stream) evs.push(e); return { evs, msg: await stream.result() }; };

test("a dropped reply (\"terminated\") is asked for once more, and only the finished reply reaches the agent", async () => {
  const model = fakeModel([failure("terminated"), reply("hello")]), retried = [];
  const { evs, msg } = await finalOf(retryingStream(model, { waitMs: 1, onRetry: (why) => retried.push(why) })({}, {}, {}));
  assert.strictEqual(model.calls(), 2);
  assert.deepStrictEqual(retried, ["terminated"]);
  assert.deepStrictEqual(evs.map((e) => e.type), ["done"]);
  assert.strictEqual(msg.content[0].text, "hello");
});
test("it gives up after its retries, and never retries errors the server meant (a bad request) or an abort", async () => {
  let model = fakeModel([failure("Request timed out."), failure("Request timed out."), reply("late")]);
  let r = await finalOf(retryingStream(model, { retries: 1, waitMs: 1 })({}, {}, {}));
  assert.strictEqual(model.calls(), 2); assert.strictEqual(r.msg.errorMessage, "Request timed out.");
  model = fakeModel([failure("terminated"), failure("Request timed out."), reply("third time")]);
  r = await finalOf(retryingStream(model, { waitMs: [1, 1] })({}, {}, {}));
  assert.strictEqual(model.calls(), 3); assert.strictEqual(r.msg.content[0].text, "third time");
  model = fakeModel([failure("400 tool schema invalid"), reply("x")]);
  r = await finalOf(retryingStream(model, { waitMs: 1 })({}, {}, {}));
  assert.strictEqual(model.calls(), 1); assert.strictEqual(r.evs[0].type, "error");
  const ac = new AbortController(); ac.abort();
  model = fakeModel([failure("terminated"), reply("x")]);
  r = await finalOf(retryingStream(model, { waitMs: 1 })({}, {}, { signal: ac.signal }));
  assert.strictEqual(model.calls(), 1);
});
test("a reply that never starts is cut after firstTokenMs and asked for again; waiting time is reported", async () => {
  let n = 0;
  const hanging = (_m, _c, opts) => {
    const s = createAssistantMessageEventStream(), k = n++;
    if (k === 0) opts.signal.addEventListener("abort", () => s.push({ type: "error", reason: "aborted", error: { ...failure("Request was aborted."), stopReason: "aborted" } }));
    else setTimeout(() => { s.push({ type: "text_start", partial: {} }); s.push({ type: "done", reason: "stop", message: reply("ok") }); }, 1);
    return s;
  };
  const waits = [], retried = [];
  const r = await finalOf(retryingStream(hanging, { firstTokenMs: 20, waitMs: 1, onWait: (w) => waits.push(w), onRetry: (why) => retried.push(why) })({}, {}, {}));
  assert.strictEqual(n, 2); assert.strictEqual(r.msg.content[0].text, "ok");
  assert.match(retried[0], /no reply from the model server/);
  assert.deepStrictEqual(waits, [true, false, true, false]);
});
test("droppedReply knows connection failures from other errors", () => {
  for (const m of ["terminated", "Request timed out.", "fetch failed", "read ECONNRESET", "Connection error.", "502 Bad Gateway"]) assert.ok(droppedReply(failure(m)), m);
  for (const m of ["400 bad request", "Request was aborted.", "context length exceeded"]) assert.ok(!droppedReply(failure(m)), m);
  assert.ok(!droppedReply(reply("fine")));
});

test("the work clock doesn't count time spent waiting for the server, but caps the whole whim", () => {
  let t = 0; const now = () => t;
  const c = workClock(0, { work: 100, total: 300, now });
  c.wait(true); t = 150; assert.strictEqual(c.over(), "");            // 150 waiting, 0 working
  c.wait(false); t = 240; assert.strictEqual(c.over(), "");           // 90 working
  t = 260; assert.match(c.over(), /ran out of time \(0 s of work\)|ran out of time/);
  const d = workClock(0, { work: 100, total: 300, now: () => t });
  t = 0; d.wait(true); t = 310; assert.match(d.over(), /too busy/);
  assert.strictEqual(Math.round(d.waited()), 310);
});
test("a new tool named like one the player has is pointed out, unless it says what it replaces", () => {
  const world = WF.makeWorld(7, 0);
  const tool = { name: "Rain cloud", icon: "🌧️", brush: { circle: 3 }, threads: [{ name: "Rain", when: [], do: [{ add_water: 0.3 }] }] };
  WF.acceptPlan(world, WF.checkPlan(world, { name: "Rain cloud", powers: [tool] }, null).clean, {});
  const again = WF.checkPlan(world, { powers: [{ ...tool, name: "rain cloud " }] }, null).clean;
  assert.match(sameNameTools(world, again)[0], /already has a tool "Rain cloud" \(id \d+\.0\)/);
  const id = world.skeins.at(-1).powers[0].id;
  assert.deepStrictEqual(sameNameTools(world, WF.checkPlan(world, { powers: [{ ...tool, replaces: id }] }, null).clean), []);
  assert.deepStrictEqual(sameNameTools(world, WF.checkPlan(world, { powers: [{ ...tool, name: "Storm" }] }, null).clean), []);
});

test("a thread that paints its tiles out of its own material condition is pointed out (seen from a model)", () => {
  const t = { name: "Stone Springs", when: [{ material: ["stone"] }], do: [{ set_material: "wet_stone" }, { add_water: 0.5 }] };
  assert.match(selfStopping(t), /acts once and then stops \(its add_water stops too\)\. To keep it going, add "wet_stone"/);
  assert.strictEqual(selfStopping({ ...t, when: [{ material: ["stone", "wet_stone"] }] }), "");
  assert.strictEqual(selfStopping({ name: "Spread", when: [{ material: ["soil"] }], do: [{ spread: "moss", chance: 0.2 }] }), "");
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
