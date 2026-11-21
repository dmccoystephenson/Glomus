// The model server's ports (server/model-server/ports): each production adapter and its test fake pass the same
// contract, and the service's policy is checked on fakes. No model involved: a small HTTP server on 127.0.0.1
// plays the model server where a real adapter needs one. Run: node game/tools/model_ports_test.js
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createModelServer, localModel } from "../../server/model-server/index.js";
import { LlamaServerLauncher, OpenAiCompatEndpoint, PiReplyStream, SystemClock } from "../../server/model-server/adapters/index.js";
import { retryingStream } from "../../server/shaper.js";
import { FakeClock, FakeEndpoint, FakeLauncher, ScriptedReplies } from "./model_fakes.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, root: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}
const json = (routes) => (req, res) => {
  const [code, body] = routes[req.url] || [404, {}];
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const configFor = (root, key = "") => {
  const c = { baseUrl: root + "/v1", alias: "glomus-local" };
  Object.defineProperty(c, "apiKey", { value: key, enumerable: false });
  return c;
};
const isAnswer = (a) => a && (a.ok === true ? "value" in a : a.ok === false && ["refused", "busy", "absent"].includes(a.failure));

// ---------- Clock ----------
const clocks = [
  ["SystemClock", () => new SystemClock(), (_c, ms) => tick(ms + 15)],
  ["FakeClock", () => new FakeClock(100), (c, ms) => c.advance(ms)],
];
for (const [name, make, wait] of clocks) {
  test(`${name}: now() is a number that never goes back`, async () => {
    const c = make();
    const a = c.now();
    await wait(c, 5);
    assert.strictEqual(typeof a, "number");
    assert.ok(c.now() >= a);
  });
  test(`${name}: after() calls back once, later, unless cancelled`, async () => {
    const c = make();
    const fired = [];
    c.after(10, () => fired.push("a"));
    const cancelled = c.after(10, () => fired.push("b"));
    cancelled.cancel();
    assert.deepStrictEqual(fired, [], "never synchronously");
    await wait(c, 10);
    assert.deepStrictEqual(fired, ["a"]);
    cancelled.cancel();
    await wait(c, 10);
    assert.deepStrictEqual(fired, ["a"]);
  });
}

// ---------- ModelEndpoint ----------
// Each scenario: what the model server does, and the Answers expected from models(), health(), slots().
const SCENARIOS = [
  ["serving", { "/v1/models": [200, { data: [{ id: "glomus-local" }] }], "/health": [200, { paused: true }], "/slots": [200, [{ is_processing: true }]] },
    { models: { ok: true, value: { data: [{ id: "glomus-local" }] } }, health: { ok: true, value: { paused: true } }, slots: { ok: true, value: [{ is_processing: true }] } }],
  ["refusing the key", { "/v1/models": [401, {}], "/health": [403, {}], "/slots": [401, {}] },
    { models: { ok: false, failure: "refused" }, health: { ok: false, failure: "refused" }, slots: { ok: false, failure: "refused" } }],
  ["busy", { "/v1/models": [503, {}], "/health": [503, {}], "/slots": [503, {}] },
    { models: { ok: false, failure: "busy" }, health: { ok: false, failure: "busy" }, slots: { ok: false, failure: "busy" } }],
  ["broken", { "/v1/models": [500, {}], "/health": [200, "not json"] },
    { models: { ok: false, failure: "absent" }, health: { ok: false, failure: "absent" }, slots: { ok: false, failure: "absent" } }],
];
const endpoints = [
  ["OpenAiCompatEndpoint", async (routes) => { const s = await serve(json(routes)); return { endpoint: new OpenAiCompatEndpoint(), config: configFor(s.root), close: s.close }; }],
  ["FakeEndpoint", async (_routes, expected) => ({ endpoint: new FakeEndpoint(expected), config: configFor("http://127.0.0.1:9"), close: async () => {} })],
];
for (const [name, make] of endpoints) {
  for (const [what, routes, expected] of SCENARIOS) {
    test(`${name}: a server ${what} gives Answers, never a rejection`, async () => {
      const { endpoint, config, close } = await make(routes, expected);
      try {
        const got = { models: await endpoint.models(config), health: await endpoint.health(config, { timeoutMs: 1500 }), slots: await endpoint.slots(config) };
        for (const a of Object.values(got)) assert.ok(isAnswer(a), JSON.stringify(a));
        assert.deepStrictEqual(got, expected);
      } finally { await close(); }
    });
  }
}
test("OpenAiCompatEndpoint: nothing listening is absent; the key goes only to /models", async () => {
  const s = await serve(json({}));
  await s.close();
  const e = new OpenAiCompatEndpoint();
  for (const a of [await e.models(configFor(s.root)), await e.health(configFor(s.root)), await e.slots(configFor(s.root))]) assert.deepStrictEqual(a, { ok: false, failure: "absent" });
  const seen = [];
  const t = await serve((req, res) => { seen.push([req.url, req.headers.authorization || null]); json({})(req, res); });
  try {
    const c = configFor(t.root, "k1");
    await e.models(c); await e.health(c); await e.slots(c);
    assert.deepStrictEqual(seen, [["/v1/models", "Bearer k1"], ["/health", null], ["/slots", null]]);
  } finally { await t.close(); }
});

// ---------- ModelLauncher ----------
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "glomus-launch-"));
const launchers = [["LlamaServerLauncher", () => new LlamaServerLauncher()], ["FakeLauncher", () => new FakeLauncher()]];
for (const [name, make] of launchers) {
  test(`${name}: nothing started at first, and stop() then does nothing`, () => {
    const l = make();
    assert.deepStrictEqual(l.state(), { running: false, started: false, log: null, problem: null });
    l.stop();
    assert.deepStrictEqual(l.state(), { running: false, started: false, log: null, problem: null });
  });
}
test("LlamaServerLauncher: missing files are a problem, not an exception, and nothing starts", () => {
  const l = new LlamaServerLauncher();
  const missing = path.join(os.tmpdir(), "glomus-no-such-server");
  l.start({ launch: { executable: missing, model: missing }, alias: "a", root: "http://127.0.0.1:8080", workspace: tmp() });
  assert.deepStrictEqual(l.state(), { running: false, started: false, log: null, problem: missing + " is missing." });
});
test("LlamaServerLauncher: a server that exits while starting is started but not running, with its log", async () => {
  // Node itself stands in for llama-server: it refuses the --model flag and exits at once.
  const workspace = tmp();
  const l = new LlamaServerLauncher();
  l.start({ launch: { executable: process.execPath, model: process.execPath }, alias: "a", root: "http://127.0.0.1:8080", workspace });
  assert.strictEqual(l.state().started, true);
  assert.strictEqual(l.state().log, path.join(workspace, "llama-server.log"));
  await new Promise((r) => l.process.once("exit", r));
  assert.deepStrictEqual(l.state(), { running: false, started: true, log: path.join(workspace, "llama-server.log"), problem: null });
  assert.match(fs.readFileSync(l.state().log, "utf8"), /--model/);
  l.stop();
});

// ---------- ReplyStream ----------
/** A stand-in OpenAI-compatible server whose every chat completion is one tool call, streamed. */
function chatServer(toolName, args) {
  return serve((req, res) => {
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end(); }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "glomus-local", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    });
  });
}
const CONTEXT = { systemPrompt: "Shape the world.", messages: [{ role: "user", content: "a pond", timestamp: 0 }], tools: [] };
async function finalOf(stream) {
  for await (const ev of stream) if (ev.type === "done" || ev.type === "error") return ev;
  return null;
}
const replyStreams = [
  ["PiReplyStream", async () => { const s = await chatServer("commit", { plan: { name: "A pond" } }); return { replies: new PiReplyStream(), model: localModel({ alias: "glomus-local", baseUrl: s.root + "/v1" }), close: s.close }; }],
  ["ScriptedReplies", async () => ({ replies: new ScriptedReplies([[{ name: "commit", arguments: { plan: { name: "A pond" } } }]]), model: localModel({ alias: "glomus-local", baseUrl: "http://127.0.0.1:9/v1" }), close: async () => {} })],
];
for (const [name, make] of replyStreams) {
  test(`${name}: a reply with a tool call ends in one done event carrying the call`, async () => {
    const { replies, model, close } = await make();
    try {
      const ev = await finalOf(await replies.stream(model, CONTEXT, { apiKey: "local" }));
      assert.strictEqual(ev.type, "done");
      assert.strictEqual(ev.message.stopReason, "toolUse");
      const calls = ev.message.content.filter((c) => c.type === "toolCall");
      assert.deepStrictEqual(calls.map((c) => [c.name, c.arguments]), [["commit", { plan: { name: "A pond" } }]]);
    } finally { await close(); }
  });
}
test("PiReplyStream: a server that isn't there gives an error event, not an exception", async () => {
  const s = await serve(json({}));
  await s.close();
  const ev = await finalOf(await new PiReplyStream().stream(localModel({ alias: "a", baseUrl: s.root + "/v1" }), CONTEXT, { apiKey: "local", maxRetries: 0 }));
  assert.strictEqual(ev.type, "error");
  assert.strictEqual(ev.error.stopReason, "error");
});

// ---------- the service on fakes ----------
const READY_MODELS = { ok: true, value: { data: [{ id: "glomus-local" }] } };
const statusWith = (endpoint, launcher = new FakeLauncher()) => createModelServer({ endpoint, launcher }).status(configFor("http://h:1"));
test("status asks /models, then /health, then /slots, and is ready when none objects", async () => {
  const endpoint = new FakeEndpoint({ models: READY_MODELS });
  assert.deepStrictEqual(await statusWith(endpoint), { ready: true, model: "glomus-local" });
  assert.deepStrictEqual(endpoint.calls.map((c) => c[0]), ["models", "health", "slots"]);
});
test("when /models can't be had, the launcher's state says why, in order: starting, stopped, problem", async () => {
  const absent = new FakeEndpoint();
  assert.strictEqual((await statusWith(absent, new FakeLauncher({ running: true, started: true, problem: "x" }))).reason, "The local model is starting up (usually under a minute).");
  assert.strictEqual((await statusWith(absent, new FakeLauncher({ started: true, log: "/w/llama-server.log", problem: "x" }))).reason, "The local model server stopped while starting; see /w/llama-server.log");
  assert.strictEqual((await statusWith(absent, new FakeLauncher({ problem: "spawn EACCES" }))).reason, "Couldn't start the local model: spawn EACCES");
  assert.strictEqual((await statusWith(absent)).reason, "No local model at http://h:1.");
  // A refused key or a busy server is said first, whatever the launcher is doing.
  assert.strictEqual((await statusWith(new FakeEndpoint({ models: { ok: false, failure: "refused" } }), new FakeLauncher({ running: true }))).reason, "The model server on http://h:1 refused the API key.");
  assert.deepStrictEqual(await statusWith(new FakeEndpoint({ models: { ok: false, failure: "busy" } }), new FakeLauncher({ running: true })),
    { ready: false, busy: true, reason: "The model server on http://h:1 is busy or paused; try again later." });
});
test("a model list that can't be read counts as no answer; slots that can't be read count as free", async () => {
  assert.strictEqual((await statusWith(new FakeEndpoint({ models: { ok: true, value: null } }))).reason, "No local model at http://h:1.");
  assert.strictEqual((await statusWith(new FakeEndpoint({ models: { ok: true, value: { data: [null] } } }))).reason, "No local model at http://h:1.");
  assert.strictEqual((await statusWith(new FakeEndpoint({ models: READY_MODELS, slots: { ok: true, value: [null] } }))).ready, true);
});
test("ensureStarted starts nothing when /health answers or there's no launch section, and otherwise asks the launcher", async () => {
  const launch = { executable: "llama-server", model: "m.gguf" };
  const config = { ...configFor("http://127.0.0.1:8090"), launch };
  let launcher = new FakeLauncher();
  let endpoint = new FakeEndpoint({ health: { ok: true, value: {} } });
  await createModelServer({ endpoint, launcher }).ensureStarted(config, "/w");
  assert.deepStrictEqual(launcher.starts, []);
  assert.deepStrictEqual(endpoint.calls, [["health", { timeoutMs: 1500 }]]);
  launcher = new FakeLauncher();
  await createModelServer({ endpoint: new FakeEndpoint(), launcher }).ensureStarted(configFor("http://127.0.0.1:8090"), "/w");
  assert.deepStrictEqual(launcher.starts, []);
  const server = createModelServer({ endpoint: new FakeEndpoint(), launcher });
  await server.ensureStarted(config, "/w");
  assert.deepStrictEqual(launcher.starts, [{ launch, alias: "glomus-local", root: "http://127.0.0.1:8090", workspace: "/w" }]);
  server.stop();
  assert.strictEqual(launcher.stops, 1);
});
test("adapters can be picked by registry name; an unknown name is a mistake", () => {
  const s = createModelServer({ endpoint: "openai-compat", clock: "system" });
  assert.ok(s.clock instanceof SystemClock);
  assert.ok(s.replies instanceof PiReplyStream);
  assert.throws(() => createModelServer({ endpoint: "nope" }), /No adapter named "nope"/);
});

// ---------- retryingStream on a FakeClock ----------
test("a reply with no first token is cut when the clock passes firstTokenMs, then asked for again", async () => {
  const clock = new FakeClock(0);
  let calls = 0;
  const replies = new ScriptedReplies([[{ name: "look", arguments: { area: "spot" } }]]);
  const model = localModel({ alias: "a", baseUrl: "http://127.0.0.1:9/v1" });
  const inner = (m, c, o) => {
    calls++;
    if (calls === 1) {   // Never answers until aborted.
      const s = new ScriptedReplies([]).stream(m, c, { signal: { aborted: true } });
      return new Promise((resolve) => o.signal.addEventListener("abort", () => resolve(s)));
    }
    return replies.stream(m, c, o);
  };
  const retried = [];
  const out = retryingStream(inner, { firstTokenMs: 1000, waitMs: 500, clock, onRetry: (why) => retried.push(why) })(model, CONTEXT, {});
  await tick(5);
  await clock.advance(999);
  assert.strictEqual(calls, 1);
  await clock.advance(1);     // The stall timer fires...
  await tick(5);
  await clock.advance(500);   // ...and the pause before asking again passes.
  const ev = await finalOf(out);
  assert.strictEqual(ev.type, "done");
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(retried, ["timed out: no reply from the model server for 1 s"]);
  assert.strictEqual(clock.pending, 0, "no timer left behind");
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}
console.log(`\n${passed} passed`);
