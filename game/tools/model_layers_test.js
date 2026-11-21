// The model server's layers (server/model-server): dependencies point inward, and each port and adapter file
// holds one class. Reads the source; nothing runs. Run: node game/tools/model_layers_test.js
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "server", "model-server");
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}

/** Source with comments and string contents blanked, so words inside them don't count. Import paths are kept. */
function code(file) {
  return fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
/** What a file imports or re-exports from, resolved to a path inside the package when it's relative. */
function imports(file) {
  const specs = [...code(file).matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm)]
    .map((m) => m[1] || m[2] || m[3]);
  return specs.map((s) => (s.startsWith(".") ? path.relative(PKG, path.resolve(path.dirname(file), s)).split(path.sep).join("/") : s));
}
const inPkg = (...p) => path.join(PKG, ...p);
const filesIn = (dir) => fs.readdirSync(inPkg(dir)).filter((f) => f.endsWith(".js")).map((f) => inPkg(dir, f));
const INNER = [inPkg("model.js"), inPkg("core.js"), ...filesIn("ports")];
const isOuter = (target) => target === "service.js" || target.startsWith("adapters/") || target === "index.js";

test("model, core and ports never import adapters, the service or the package entry", () => {
  const bad = INNER.flatMap((f) => imports(f).filter(isOuter).map((t) => `${path.relative(PKG, f)} imports ${t}`));
  assert.deepStrictEqual(bad, []);
});
test("model, core and ports do no I/O: they import nothing from Node or from packages", () => {
  const bad = INNER.flatMap((f) => imports(f).filter((t) => !t.endsWith(".js") || t.startsWith("node:") || !fs.existsSync(inPkg(t))).map((t) => `${path.relative(PKG, f)} imports ${t}`));
  assert.deepStrictEqual(bad, []);
});
test("ports import nothing at all; core imports only model", () => {
  for (const f of filesIn("ports")) assert.deepStrictEqual(imports(f), [], path.relative(PKG, f));
  assert.ok(imports(inPkg("core.js")).every((t) => t === "model.js"));
});
test("adapters never import the service or the package entry", () => {
  const bad = filesIn("adapters").flatMap((f) => imports(f).filter((t) => t === "service.js" || t === "index.js").map((t) => `${path.relative(PKG, f)} imports ${t}`));
  assert.deepStrictEqual(bad, []);
});
test("each port file and each adapter file (other than the registry) declares exactly one class", () => {
  const files = [...filesIn("ports"), ...filesIn("adapters").filter((f) => path.basename(f) !== "index.js")];
  assert.ok(files.length >= 8, `found ${files.length} files`);
  const bad = files.map((f) => [path.relative(PKG, f), (code(f).match(/^(?:export\s+)?class\s+\w+/gm) || []).length]).filter(([, n]) => n !== 1);
  assert.deepStrictEqual(bad, []);
});
test("each adapter extends the port it implements", () => {
  for (const f of filesIn("adapters").filter((g) => path.basename(g) !== "index.js")) {
    const m = code(f).match(/^export\s+class\s+\w+\s+extends\s+(\w+)/m);
    assert.ok(m, `${path.relative(PKG, f)} declares no class that extends a port`);
    assert.ok(imports(f).some((t) => t.startsWith("ports/")), `${path.relative(PKG, f)} imports no port`);
  }
});
test("nothing outside the package still imports the old server/model.js", () => {
  const root = path.resolve(PKG, "..", "..");
  const bad = [];
  for (const dir of ["server", "tools", path.join("game", "tools")]) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith(".js"))) {
      if (/["'](?:\.\.?\/)+(?:server\/)?model\.js["']/.test(fs.readFileSync(path.join(root, dir, f), "utf8"))) bad.push(path.join(dir, f));
    }
  }
  assert.deepStrictEqual(bad, []);
});

console.log(`\n${passed} passed`);
