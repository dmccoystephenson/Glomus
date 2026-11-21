// How config/model.json, config/model.local.json and the environment combine (server/model.js), with no model
// involved. Run: node game/tools/model_config_test.js
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../server/model.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}
const BASE = { baseUrl: "http://127.0.0.1:8080/v1", alias: "glomus-local", contextWindow: 32768, launch: { executable: "llama-server", model: "m.gguf" } };
function root(local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glomus-config-"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(path.join(dir, "config", "model.json"), JSON.stringify(BASE));
  if (local !== undefined) fs.writeFileSync(path.join(dir, "config", "model.local.json"), typeof local === "string" ? local : JSON.stringify(local));
  return dir;
}

test("with no local file and no environment, model.json is used as it is, with no key", () => {
  const c = loadConfig(root(), {});
  assert.deepStrictEqual({ ...c }, BASE);
  assert.strictEqual(c.apiKey, "");
});
test("model.local.json moves the server, drops launch and holds the key out of sight", () => {
  const c = loadConfig(root({ baseUrl: "http://gpu-box:8000/v1", alias: "qwen", apiKey: "secret-key-123" }), {});
  assert.strictEqual(c.baseUrl, "http://gpu-box:8000/v1");
  assert.strictEqual(c.alias, "qwen");
  assert.strictEqual(c.launch, undefined);
  assert.strictEqual(c.apiKey, "secret-key-123");
  assert.ok(!JSON.stringify(c).includes("secret-key-123"), "the key must not serialise");
  assert.ok(!Object.keys(c).includes("apiKey"));
});
test("model.local.json can keep a launch section of its own, or change other settings and keep the default one", () => {
  assert.deepStrictEqual(loadConfig(root({ baseUrl: "http://127.0.0.1:9090/v1", launch: { executable: "x", model: "y" } }), {}).launch, { executable: "x", model: "y" });
  assert.deepStrictEqual(loadConfig(root({ maxTokens: 2000 }), {}).launch, BASE.launch);
});
test("the environment beats both files, and GLOMUS_MODEL_URL drops launch", () => {
  const c = loadConfig(root({ alias: "from-file", apiKey: "file-key" }), { GLOMUS_MODEL_URL: "http://other:1/v1", GLOMUS_MODEL_ALIAS: "from-env", GLOMUS_MODEL_KEY: "env-key" });
  assert.strictEqual(c.baseUrl, "http://other:1/v1");
  assert.strictEqual(c.alias, "from-env");
  assert.strictEqual(c.apiKey, "env-key");
  assert.strictEqual(c.launch, undefined);
});
test("a broken model.local.json is an error that names the file, never a silent fallback", () => {
  assert.throws(() => loadConfig(root("{ not json"), {}), /model\.local\.json/);
});

console.log(`\n${passed} passed`);
