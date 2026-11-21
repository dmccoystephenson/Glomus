// What status() says about the model server, for every answer a server can give, with no model involved: a
// small HTTP server on 127.0.0.1 plays the model server. Run: node game/tools/model_status_test.js
import assert from "node:assert";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as Model from "../../server/model-server/index.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A stand-in model server: routes maps a path to [status, body]; a missing path answers 404. */
function fakeServer(routes) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ path: req.url, auth: req.headers.authorization || null });
      const [code, body] = routes[req.url] || [404, { error: "not found" }];
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, root: `http://127.0.0.1:${server.address().port}` }));
  });
}
/** A port with nothing on it. */
async function deadRoot() {
  const { server, root } = await fakeServer({});
  await new Promise((r) => server.close(r));
  return root;
}
const config = (root, extra = {}) => {
  const c = { baseUrl: root + "/v1", alias: "glomus-local", ...extra };
  Object.defineProperty(c, "apiKey", { value: extra.key || "", enumerable: false });
  delete c.key;
  return c;
};
const MODELS = { "/v1/models": [200, { data: [{ id: "glomus-local" }] }] };

async function withServer(routes, extra, fn) {
  const s = await fakeServer(routes);
  try { await fn(await Model.status(config(s.root, extra)), s); } finally { await new Promise((r) => s.server.close(r)); }
}

test("ready when the alias is served and nothing is paused or busy", () => withServer({ ...MODELS, "/health": [200, { status: "ok" }], "/slots": [200, [{ is_processing: false }]] }, {},
  (st) => assert.deepStrictEqual(st, { ready: true, model: "glomus-local" })));
test("no /health and no /slots (not llama.cpp) still counts as ready", () => withServer(MODELS, {},
  (st) => assert.deepStrictEqual(st, { ready: true, model: "glomus-local" })));
test("slots that aren't a list, or a /health that isn't JSON, are ignored", () => withServer({ ...MODELS, "/health": [200, "not json"], "/slots": [200, { is_processing: true }] }, {},
  (st) => assert.deepStrictEqual(st, { ready: true, model: "glomus-local" })));
test("a server running another model says so", () => withServer({ "/v1/models": [200, { data: [{ id: "other" }] }] }, {},
  (st, s) => assert.deepStrictEqual(st, { ready: false, reason: `The model server on ${s.root} is running, but not as "glomus-local".` })));
test("a model list with no data counts as not serving the alias", () => withServer({ "/v1/models": [200, {}] }, {},
  (st, s) => assert.deepStrictEqual(st, { ready: false, reason: `The model server on ${s.root} is running, but not as "glomus-local".` })));
test("a paused server is busy", () => withServer({ ...MODELS, "/health": [200, { paused: true }], "/slots": [200, [{ is_processing: true }]] }, {},
  (st) => assert.deepStrictEqual(st, { ready: false, busy: true, reason: "The model server is paused for now; try again later." })));
test("a slot that is processing makes the model busy", () => withServer({ ...MODELS, "/slots": [200, [{ is_processing: false }, { is_processing: true }]] }, {},
  (st) => assert.deepStrictEqual(st, { ready: false, busy: true, reason: "The local model is busy." })));
for (const code of [401, 403]) {
  test(`${code} means the key was refused`, () => withServer({ "/v1/models": [code, { error: "no" }] }, { key: "k" },
    (st, s) => assert.deepStrictEqual(st, { ready: false, reason: `The model server on ${s.root} refused the API key.` })));
}
test("503 means busy or paused", () => withServer({ "/v1/models": [503, { error: "loading" }] }, {},
  (st, s) => assert.deepStrictEqual(st, { ready: false, busy: true, reason: `The model server on ${s.root} is busy or paused; try again later.` })));
test("any other failure from /models, or a list that isn't JSON, means no model there", async () => {
  await withServer({ "/v1/models": [500, {}] }, {}, (st, s) => assert.deepStrictEqual(st, { ready: false, reason: `No local model at ${s.root}.` }));
  await withServer({ "/v1/models": [200, "<html>"] }, {}, (st, s) => assert.deepStrictEqual(st, { ready: false, reason: `No local model at ${s.root}.` }));
  await withServer({ "/v1/models": [200, "null"] }, {}, (st, s) => assert.deepStrictEqual(st, { ready: false, reason: `No local model at ${s.root}.` }));
});
test("the key goes only to /models, as a Bearer header; /health and /slots get none", () => withServer({ ...MODELS, "/health": [200, {}], "/slots": [200, []] }, { key: "sekrit" },
  (_st, s) => assert.deepStrictEqual(s.seen, [{ path: "/v1/models", auth: "Bearer sekrit" }, { path: "/health", auth: null }, { path: "/slots", auth: null }])));
test("with a trailing slash after /v1, the root drops it but the list is asked for at /v1//models, as written", async () => {
  const s = await fakeServer({ "/v1//models": [200, { data: [] }] });
  try {
    const st = await Model.status({ ...config(s.root), baseUrl: s.root + "/v1/" });
    assert.strictEqual(st.reason, `The model server on ${s.root} is running, but not as "glomus-local".`);
  } finally { await new Promise((r) => s.server.close(r)); }
});
test("nothing listening means no local model", async () => {
  const root = await deadRoot();
  assert.deepStrictEqual(await Model.status(config(root)), { ready: false, reason: `No local model at ${root}.` });
});
test("ensureStarted leaves a server that already answers /health alone, and does nothing with no launch section", async () => {
  await withServer({ "/health": [200, {}] }, {}, async (_st, s) => {
    await Model.ensureStarted({ ...config(s.root), launch: { executable: "/nowhere/llama-server", model: "/nowhere/m.gguf" } }, os.tmpdir());
  });
  await Model.ensureStarted(config(await deadRoot()), os.tmpdir());
  const root = await deadRoot();
  assert.deepStrictEqual(await Model.status(config(root)), { ready: false, reason: `No local model at ${root}.` });
});
// Last: the module keeps what it tried to start.
test("a launch whose files are missing says which one", async () => {
  const root = await deadRoot();
  const missing = path.join(os.tmpdir(), "glomus-no-such-llama-server");
  await Model.ensureStarted({ ...config(root), launch: { executable: missing, model: missing + ".gguf" } }, os.tmpdir());
  assert.deepStrictEqual(await Model.status(config(root)), { ready: false, reason: `Couldn't start the local model: ${missing} is missing.` });
  Model.stop();
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}
console.log(`\n${passed} passed`);
