// World slots (server/worlds.js and its routes in server/server.js), with no browser and no model.
// Run: node game/tools/slots_test.js
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as WF from "../world.js";
import { createStore, cleanBy, MAX_SLOTS, MAX_SLOT_BYTES } from "../../server/worlds.js";
import { slotName, ago } from "../slots.js";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + (e.stack || e.message)); process.exitCode = 1; }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "glomus-slots-"));
const world = WF.save(WF.makeWorld(11, 0));
const code = (fn) => { try { fn(); } catch (e) { return e.error; } return "no error"; };

await test("a slot keeps a world, who wrote it and when, and reads back the same world", () => {
  const dir = tmp(), store = createStore(dir, { WF, now: () => new Date("2026-01-02T03:04:05Z") });
  const meta = store.write("valley", { world, by: "the page" });
  assert.match(meta.rev, /^[0-9a-f]{12}$/);
  assert.deepStrictEqual({ ...meta, rev: 0 }, { name: "valley", rev: 0, savedAt: "2026-01-02T03:04:05.000Z", savedBy: "the page", tick: 0 });
  const back = store.read("valley");
  assert.deepStrictEqual(back.world, world);
  assert.deepStrictEqual(store.list().map((s) => s.name), ["valley"]);
  assert.strictEqual(fs.statSync(path.join(dir, "valley.json")).mode & 0o777, 0o600);
});

await test("names are checked: no paths, dots, capitals, spaces or empty names", () => {
  const store = createStore(tmp(), { WF });
  for (const bad of ["", "../x", "a/b", "a.b", "Valley", "a b", "-x", "x".repeat(41), "x\u0000", null, 7]) {
    assert.strictEqual(code(() => store.write(bad, { world })), "bad_name", JSON.stringify(bad));
    assert.strictEqual(code(() => store.read(bad)), "bad_name", JSON.stringify(bad));
  }
  assert.strictEqual(code(() => store.write("x".repeat(40), { world })), "no error");
});

await test("only a world this version can load is kept, and it's kept as world.js saves it", () => {
  const store = createStore(tmp(), { WF });
  for (const bad of [null, {}, { version: 2 }, { ...world, height: "AAAA" }, "text"]) assert.strictEqual(code(() => store.write("a", { world: bad })), "bad_world");
  store.write("a", { world: { ...world, extra: "<b>dropped</b>" } });
  assert.strictEqual(store.read("a").world.extra, undefined);
});

await test("replacing a slot needs the revision it replaces, and keeps what it replaced", () => {
  const dir = tmp(), store = createStore(dir, { WF });
  const first = store.write("a", { world, by: "one" });
  const conflict = (() => { try { store.write("a", { world, by: "two" }); } catch (e) { return e; } })();
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.extra.current.rev, first.rev);
  assert.strictEqual(code(() => store.write("a", { world, by: "two", base: "000000000000" })), "conflict", "a stale base");
  assert.strictEqual(code(() => store.write("b", { world, base: first.rev })), "conflict", "a base for a slot that doesn't exist");
  const moved = WF.makeWorld(11, 0); WF.step(moved);
  const second = store.write("a", { world: WF.save(moved), by: "two", base: first.rev });
  assert.notStrictEqual(second.rev, first.rev);
  assert.strictEqual(store.read("a").savedBy, "two");
  const kept = JSON.parse(fs.readFileSync(path.join(dir, "previous", "a.json"), "utf8"));
  assert.strictEqual(kept.rev, first.rev, "the replaced world is kept");
});

await test("slots are capped in number and size, and labels are cut to one short line", () => {
  const dir = tmp(), store = createStore(dir, { WF });
  for (let i = 0; i < MAX_SLOTS; i++) fs.writeFileSync(path.join(dir, `s${i}.json`), "{}");
  assert.strictEqual(code(() => store.write("one-more", { world })), "full");
  const big = createStore(tmp(), { WF });
  const huge = { ...world, skeins: [{ id: 1, name: "x".repeat(MAX_SLOT_BYTES), kind: "nature", on: true, threads: [] }] };
  assert.strictEqual(code(() => big.write("big", { world: huge })), "too_large");
  assert.strictEqual(cleanBy("a\nb\u001b[2J" + "c".repeat(80)).length, 40);
  assert.strictEqual(cleanBy(""), "unknown");
});

await test("a damaged slot file is left out of the list and never removed", () => {
  const dir = tmp(), store = createStore(dir, { WF });
  store.write("good", { world });
  fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
  fs.writeFileSync(path.join(dir, "Not-A-Name.json"), "{}");
  assert.deepStrictEqual(store.list().map((s) => s.name), ["good"]);
  assert.strictEqual(code(() => store.read("bad")), "damaged");
  assert.ok(fs.existsSync(path.join(dir, "bad.json")));
});

await test("the page turns typed text into a slot name and says how long ago", () => {
  assert.strictEqual(slotName("  My Valley! "), "my-valley");
  assert.strictEqual(slotName("../../etc"), "etc");
  assert.strictEqual(slotName("!!!"), "");
  assert.strictEqual(ago("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:05:00Z")), "5 min ago");
  assert.strictEqual(ago("nonsense"), "at an unknown time");
});

// ---------- the routes, on a real server in a temporary workspace ----------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspace = tmp();
const port0 = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [path.join(ROOT, "server/server.js"), "--port", String(port0), "--no-browser"], {
  env: { ...process.env, GLOMUS_WORKSPACE: workspace, GLOMUS_MODEL_URL: "http://127.0.0.1:9/v1" }, stdio: ["ignore", "pipe", "pipe"] });
const port = await new Promise((resolve, reject) => {
  let out = "";
  child.stdout.on("data", (d) => { out += d; const m = out.match(/127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); });
  child.on("exit", (c) => reject(new Error("server exited " + c + ": " + out)));
  setTimeout(() => reject(new Error("server didn't start: " + out)), 15000);
});
const token = fs.readFileSync(path.join(workspace, "token.txt"), "utf8").trim();

function request(method, p, { body, host = `127.0.0.1:${port}`, tok = token } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const headers = { Host: host, "Content-Type": "application/json" };
    if (tok !== null) headers["X-Glomus-Token"] = tok;
    if (raw) headers["Content-Length"] = raw.length;
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = ""; res.on("data", (d) => { data += d; });
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

try {
  await test("every slot route refuses a missing or wrong token and a foreign Host", async () => {
    for (const [method, p, body] of [["GET", "/api/worlds"], ["GET", "/api/worlds/a"], ["POST", "/api/worlds/a", { world }]]) {
      assert.strictEqual((await request(method, p, { body, tok: null })).status, 403, `${method} ${p}: no token`);
      assert.strictEqual((await request(method, p, { body, tok: "x".repeat(token.length) })).status, 403, `${method} ${p}: wrong token`);
      assert.strictEqual((await request(method, p, { body, host: "evil.example" })).status, 403, `${method} ${p}: Host`);
      assert.strictEqual((await request(method, p, { body, host: `evil.example:${port}` })).status, 403, `${method} ${p}: rebound Host`);
    }
    assert.ok(!fs.existsSync(path.join(workspace, "worlds", "a.json")), "nothing was written");
  });

  await test("save, list, open and a guarded replace through the routes", async () => {
    const saved = await request("POST", "/api/worlds/valley", { body: { world, by: "a test" } });
    assert.strictEqual(saved.status, 200); assert.ok(saved.json.ok);
    const listed = await request("GET", "/api/worlds");
    assert.deepStrictEqual(listed.json.slots.map((s) => [s.name, s.savedBy]), [["valley", "a test"]]);
    const read = await request("GET", "/api/worlds/valley");
    assert.deepStrictEqual(read.json.world, world);
    const clash = await request("POST", "/api/worlds/valley", { body: { world, by: "another" } });
    assert.strictEqual(clash.status, 409); assert.strictEqual(clash.json.current.rev, saved.json.rev);
    const ok = await request("POST", "/api/worlds/valley", { body: { world, by: "another", base: saved.json.rev } });
    assert.strictEqual(ok.status, 200);
  });

  await test("bad names, bad worlds, bad JSON and oversized bodies are refused", async () => {
    assert.strictEqual((await request("GET", "/api/worlds/..%2F..%2Ftoken")).status, 400);
    assert.strictEqual((await request("GET", "/api/worlds/%E0%A4%A")).status, 400);
    assert.strictEqual((await request("GET", "/api/worlds/missing")).status, 404);
    assert.strictEqual((await request("POST", "/api/worlds/x", { body: { world: { version: 1 } } })).status, 400);
    assert.strictEqual((await request("POST", "/api/worlds/x", { body: "{nope" })).status, 400);
    assert.strictEqual((await request("POST", "/api/worlds/x", { body: { world, pad: "x".repeat(MAX_SLOT_BYTES) } })).status, 413);
    assert.strictEqual((await request("DELETE", "/api/worlds/valley")).status, 404, "no deletes");
    assert.ok(!fs.existsSync(path.join(workspace, "worlds", "x.json")));
  });
} finally {
  child.kill("SIGTERM");
}
console.log(`${passed} passed`);
