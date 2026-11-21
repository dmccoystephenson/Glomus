// The 3D view in a real browser: it draws, taps pick a spot, a click tool and a drag tool work in it, hover
// reads out the tile, rain falls, and it works at phone width with touch. No model is needed: the tools come
// from a hand-written plan, as the page's "Write a plan by hand" box takes them.
//
//   node game/tools/view3d_test.js [--shots DIR]
//
// Needs Playwright with Chromium: the playwright-core devDependency with its browser installed
// (npx playwright-core install chromium-headless-shell), or any Playwright package on NODE_PATH. WebGL runs on
// SwiftShader, so frames are slow (about one a second); the test waits for frames, not speed.
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const SHOTS = args.includes("--shots") ? path.resolve(args[args.indexOf("--shots") + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

function playwright() {
  for (const name of ["playwright", "playwright-core"]) {
    try { return require(name); } catch { /* try the next */ }
  }
  throw new Error("Playwright isn't installed: npm install, then npx playwright-core install chromium-headless-shell");
}
const freePort = (port) => new Promise((resolve) => {
  const s = net.createServer().once("error", () => resolve(freePort(port + 1)))
    .listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(port)));
});

const TOOLS = { name: "Test tools", powers: [
  { name: "Hill", brush: { circle: 3 }, edits: [{ raise: 2 }] },
  { name: "Ditch", brush: { stroke: 2 }, edits: [{ lower: 1 }] },
] };

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message.split("\n").join("\n     ")); process.exitCode = 1; }
}

// ---------- the server, on a port of its own ----------
const port = await freePort(Number(process.env.GLOMUS_TEST_PORT) || 8850);
const server = spawn(process.execPath, ["server/server.js", "--port", String(port), "--no-browser"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
const base = await new Promise((resolve, reject) => {
  let out = "";
  const timer = setTimeout(() => reject(new Error("the server didn't start: " + out)), 20000);
  server.stdout.on("data", (d) => { out += d; const m = /Glomus at (\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
  server.stderr.on("data", (d) => { out += d; });
  server.once("exit", (code) => reject(new Error(`the server stopped (${code}): ${out}`)));
});

const { chromium } = playwright();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

// ---------- helpers that run in the page ----------
const errors = [];
async function openPage(contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${contextOptions.label}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${contextOptions.label} console: ${m.text()}`); });
  await page.goto(base + "?seed=5");
  await page.evaluate((plan) => {
    document.getElementById("planText").value = JSON.stringify(plan);
    document.getElementById("applyPlan").click();
  }, TOOLS);
  return { context, page };
}
const frames = (page) => page.evaluate(() => { const v = window.__glomus3d(); return v ? v.kit.stats().frames : 0; });
async function waitFrames(page, more = 2) {
  const start = await frames(page);
  await page.waitForFunction((n) => { const v = window.__glomus3d(); return v && v.kit.stats().frames >= n; }, start + more, { timeout: 60000, polling: 100 });
}
async function open3d(page) {
  await page.click("#view3d");
  await page.waitForFunction(() => window.__glomus3d && window.__glomus3d(), null, { timeout: 120000 });
  await waitFrames(page, 2);
}
/** Where tile (x, y) is on screen, in viewport pixels. */
const tileXY = (page, x, y) => page.evaluate(([x, y]) => {
  const v = window.__glomus3d(), sc = v.scene, p = v.kit.project(sc.ox + x, sc.heights[y * sc.W + x], sc.oz + y);
  const r = document.getElementById("map3d").getBoundingClientRect();
  return p && { x: r.left + p.x, y: r.top + p.y };
}, [x, y]);
const usesOf = (page, name) => page.evaluate((name) => {
  for (const s of window.__glomusWorld().skeins) for (const p of s.powers || []) if (p.name === name) return p.uses.map((u) => ({ at: u.at, path: u.path || null }));
  return null;
}, name);
const yaw = (page) => page.evaluate(() => window.__strataKit.cam.yaw);
const camDist = (page) => page.evaluate(() => window.__strataKit.cam.dist);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };
const pick = (page, tool) => page.evaluate((tool) => {
  const b = [...document.querySelectorAll("#yourTools .tool")].find((el) => el.textContent.includes(tool));
  b.click();
}, tool);

try {
  // ---------- desktop ----------
  const { context, page } = await openPage({ label: "desktop", viewport: { width: 1280, height: 800 } });

  await test("the 3D view opens and draws frames, with the land, water and animals", async () => {
    await open3d(page);
    const s = await page.evaluate(() => window.__glomus3d().kit.stats());
    assert.ok(s.frames >= 2, "frames: " + s.frames);
    assert.ok(s.terrain > 0, "no terrain");
    assert.strictEqual(await page.isHidden("#map"), true, "the flat map should be hidden");
  });

  await test("the ground is drawn four times finer than the tiles, and each animal has a body", async () => {
    const s = await page.evaluate(() => ({ ...window.__glomus3d().kit.stats(), ...window.__glomus3d().lookStats, alive: window.__glomusWorld().creatures.filter((c) => !c.dead).length }));
    const fine = 381 * 253, half = 191 * 127;
    assert.ok(s.terrain === fine || (s.quality === 0 && s.terrain === half), "terrain samples: " + s.terrain);
    assert.strictEqual(s.bodies, s.alive, "a body per living animal");
    assert.ok(s.alive === 0 || (s.meshes >= 1 + s.alive && s.bodyVertices > 300 * s.alive), JSON.stringify(s));
  });

  await test("day and night follow the world's clock, and the daylight button pins the sun", async () => {
    // Moving the clock would also move the weather's next change: keep the weather as it was.
    const saved = await page.evaluate(() => { const w = window.__glomusWorld(); return { tick: w.tick, weather: { ...w.weather } }; });
    const at = (tick) => page.evaluate(([tick, weather]) => { const w = window.__glomusWorld(); w.tick = tick; w.weather = { ...weather, until: tick + 600 }; return true; }, [tick, saved.weather]);
    const sky = () => page.evaluate(() => window.__glomus3d().sky);
    await page.evaluate(() => window.__glomus3d().setDaylight("clock"));
    await at(0); await waitFrames(page, 1);
    const day = await sky();
    await at(Math.round(0.75 * 3600)); await waitFrames(page, 1);
    const night = await sky();
    assert.ok(day.toSun[1] > 0 && night.toSun[1] < 0 && night.night > 0.9, JSON.stringify([day.toSun, night.toSun]));
    const pts = await page.evaluate(() => window.__glomus3d().lookStats.points);
    assert.ok(pts > 100, "stars and small lights at night: " + pts);
    await page.evaluate(() => document.querySelector(".g3-daylight").click());   // frames are slow here: no waiting for it to hold still
    await waitFrames(page, 1);
    assert.strictEqual(await page.evaluate(() => window.__glomus3d().daylight), "day");
    assert.ok((await sky()).toSun[1] > 0.4, "pinned daylight");
    assert.match(await page.textContent(".g3-daylight"), /Always day/);
    await page.evaluate(() => document.querySelector(".g3-daylight").click());   // frames are slow here: no waiting for it to hold still
    assert.strictEqual(await page.evaluate(() => window.__glomus3d().daylight), "clock");
    await page.evaluate(() => window.__glomus3d().setDaylight("day"));
    await page.evaluate((saved) => { const w = window.__glomusWorld(); w.tick = saved.tick; w.weather = saved.weather; }, saved);
  });

  await test("a tap on the land picks the spot", async () => {
    const p = await tileXY(page, 48, 32);
    await page.mouse.click(p.x, p.y);
    const info = await page.textContent("#spotInfo");
    const m = /Spot: \((\d+), (\d+)\)/.exec(info);
    assert.ok(m, info);
    assert.ok(Math.abs(m[1] - 48) <= 2 && Math.abs(m[2] - 32) <= 2, info);
  });

  await test("hovering reads out the tile, and with a tool picked shows its brush ring", async () => {
    await pick(page, "Hill");
    const p = await tileXY(page, 40, 30);
    await page.mouse.move(p.x, p.y);
    await page.mouse.move(p.x + 2, p.y + 1);
    const text = await page.textContent("#hover");
    assert.match(text, /Hill \(radius 3\).*ground .* m · water/, text);
    await waitFrames(page, 1);
    const st = await page.evaluate(() => window.__glomus3d().overlayStats);
    assert.ok(st.lines > 20, "brush ring lines: " + st.lines);
  });

  await test("a click tool used in 3D changes the land where it was tapped, with a note", async () => {
    const p = await tileXY(page, 30, 20);
    await page.mouse.click(p.x, p.y);
    const uses = await usesOf(page, "Hill");
    assert.strictEqual(uses.length, 1, JSON.stringify(uses));
    assert.ok(Math.abs(uses[0].at[0] - 30) <= 2 && Math.abs(uses[0].at[1] - 20) <= 2, JSON.stringify(uses[0]));
    assert.match(await page.textContent("#hover"), /Hill: \d+ tiles changed/);
    // The note lives 5 s; on slow software rendering a frame can take most of that, so poll frame by frame.
    let st = null;
    for (let k = 0; k < 8 && !(st && st.labels >= 1); k++) {
      await waitFrames(page, 1);
      st = await page.evaluate(() => window.__glomus3d().overlayStats);
    }
    const why = await page.evaluate(() => ({ hover: document.getElementById("hover").textContent, kitRunning: window.__glomus3d().kit.running,
      frames: window.__glomus3d().kit.stats ? window.__glomus3d().kit.stats().frames : null, now: performance.now() }));
    assert.ok(st.labels >= 1, "the use's note should show as a label: " + JSON.stringify({ st, why }));
    await shot(page, "desktop-click-tool.png");
  });

  await test("a drag tool's drag in 3D draws a stroke and uses it along the path, without turning the view", async () => {
    await pick(page, "Ditch");
    assert.match(await page.textContent("#hover"), /Alt-drag/);
    const y0 = await yaw(page), a = await tileXY(page, 20, 40), b = await tileXY(page, 50, 44);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(a.x + ((b.x - a.x) * k) / 10, a.y + ((b.y - a.y) * k) / 10);
    const mid = await page.evaluate(() => window.__glomus3d().stroking);
    assert.ok(mid && mid.length >= 3, "the stroke while dragging: " + JSON.stringify(mid));
    await waitFrames(page, 1);
    await shot(page, "desktop-drag-stroke.png");
    await page.mouse.up();
    const uses = await usesOf(page, "Ditch");
    assert.strictEqual(uses.length, 1, JSON.stringify(uses));
    assert.ok(uses[0].path.length >= 3, "path: " + JSON.stringify(uses[0].path));
    assert.ok(Math.abs(uses[0].path[0][0] - 20) <= 2 && Math.abs(uses[0].path.at(-1)[0] - 50) <= 3, JSON.stringify(uses[0].path));
    assert.strictEqual(await yaw(page), y0, "the drag turned the view");
  });

  await test("with a drag tool, Alt-drag still turns the view and uses nothing", async () => {
    const y0 = await yaw(page), p = await tileXY(page, 48, 32);
    await page.keyboard.down("Alt");
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    for (let k = 1; k <= 5; k++) await page.mouse.move(p.x + k * 20, p.y);
    await page.mouse.up(); await page.keyboard.up("Alt");
    assert.notStrictEqual(await yaw(page), y0, "Alt-drag didn't turn the view");
    assert.strictEqual((await usesOf(page, "Ditch")).length, 1);
  });

  await test("rain falls in 3D, and dead animals are marked", async () => {
    const before = await page.evaluate(() => window.__glomus3d().overlayStats.lines);
    await page.evaluate(() => { const w = window.__glomusWorld(); w.weather.raining = true; w.weather.until = w.tick + 9999; });
    await waitFrames(page, 2);
    const raining = await page.evaluate(() => window.__glomus3d().overlayStats.lines);
    assert.ok(raining >= before + 150, `lines ${before} -> ${raining}`);
    const dead = await page.evaluate(async () => {
      const { overlayLines } = await import("./view3d.js"), WF = await import("./world.js");
      const w = WF.makeWorld(5), c = (w.creatures || [])[0];
      if (!c) return null;
      w.weather.raining = false;
      const alive = overlayLines(WF, w).length; c.dead = true;
      return { alive, dead: overlayLines(WF, w).length };
    });
    if (dead) assert.ok(dead.dead > dead.alive, JSON.stringify(dead));
    await shot(page, "desktop-rain.png");
  });

  await test("back to the map and to 3D again", async () => {
    await page.click("#view3d");
    assert.strictEqual(await page.isVisible("#map"), true);
    const box = await page.locator("#map").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    assert.match(await page.textContent("#hover"), /ground .* m · water/, "the flat map's hover readout");
    await page.click("#view3d");
    await waitFrames(page, 1);
    assert.strictEqual(await page.isVisible("#map3d"), true);
  });
  await test("walking: a visitor on the land, behind it or through its eyes, using the spot where it stands", async () => {
    await page.click("#walk");
    await page.waitForFunction(() => window.__glomusWalker().on);
    const a = await page.evaluate(() => window.__glomusWalker().pos);
    await page.keyboard.down("KeyW"); await page.waitForTimeout(2500); await page.keyboard.up("KeyW");
    const b = await page.evaluate(() => window.__glomusWalker().pos);
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) > 2, `walked ${JSON.stringify([a, b])}`);
    assert.match(await page.textContent("#hover"), /🚶 \(\d+, \d+\) · ground/);
    assert.strictEqual(await page.evaluate(() => window.__glomus3d().kit.cam.dist), 7, "the camera is just behind");
    await page.keyboard.press("KeyC");
    assert.strictEqual(await page.evaluate(() => window.__glomusWalker().first), true);
    await page.keyboard.press("Escape");   // back to Spot, so R puts the spot
    await page.keyboard.press("KeyR");
    const t = await page.evaluate(() => window.__glomusWalker().tile);
    assert.match(await page.textContent("#spotInfo"), new RegExp(`\\(${t.x}, ${t.y}\\)`));
    await page.keyboard.press("KeyC");
    await waitFrames(page, 1);
    await shot(page, "desktop-walk.png");
    await page.click("#walk");
    assert.strictEqual(await page.evaluate(() => window.__glomusWalker().on), false);
    assert.ok(await page.evaluate(() => window.__glomus3d().kit.cam.dist) > 20, "stopping gives the overview back");
  });
  await context.close();

  // ---------- a phone ----------
  const phone = await openPage({ label: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pg = phone.page, cdp = await phone.context.newCDPSession(pg);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

  await test("phone: the 3D view fits 390 px and the toggle is reachable", async () => {
    await open3d(pg);
    const box = await pg.locator("#map3d").boundingBox(), sw = await pg.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(box.width > 300 && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
    assert.ok(sw <= 390, "the page scrolls sideways: " + sw);
    assert.ok(await pg.isVisible("#view3d"));
  });

  await test("phone: a tap picks the spot", async () => {
    const p = await tileXY(pg, 48, 32);
    await pg.touchscreen.tap(p.x, p.y);
    assert.match(await pg.textContent("#spotInfo"), /Spot: \(\d+, \d+\)/);
  });

  await test("phone: one finger turns the view, two fingers pinch to zoom", async () => {
    const y0 = await yaw(pg), p = await tileXY(pg, 48, 32);
    await touch("touchStart", [[p.x, p.y]]);
    for (let k = 1; k <= 5; k++) await touch("touchMove", [[p.x + k * 15, p.y]]);
    await touch("touchEnd", []);
    assert.notStrictEqual(await yaw(pg), y0, "one finger didn't turn the view");
    const d0 = await camDist(pg);
    await touch("touchStart", [[p.x - 20, p.y], [p.x + 20, p.y]]);
    for (let k = 1; k <= 5; k++) await touch("touchMove", [[p.x - 20 - k * 10, p.y], [p.x + 20 + k * 10, p.y]]);
    await touch("touchEnd", []);
    assert.ok(await camDist(pg) < d0, "pinching out didn't zoom in");
  });

  await test("phone: with a drag tool one finger draws the stroke, and two fingers still zoom without using it", async () => {
    await pick(pg, "Ditch");
    await pg.evaluate(() => Object.assign(window.__strataKit.cam, { yaw: Math.PI / 2, pitch: 0.75, dist: 95, tx: 0, ty: 6, tz: 0 }));
    await waitFrames(pg, 1);
    const y0 = await yaw(pg), a = await tileXY(pg, 30, 30), b = await tileXY(pg, 60, 34);
    await touch("touchStart", [[a.x, a.y]]);
    for (let k = 1; k <= 8; k++) await touch("touchMove", [[a.x + ((b.x - a.x) * k) / 8, a.y + ((b.y - a.y) * k) / 8]]);
    await touch("touchEnd", []);
    const uses = await usesOf(pg, "Ditch");
    assert.strictEqual(uses.length, 1, JSON.stringify(uses));
    assert.ok(uses[0].path.length >= 3, JSON.stringify(uses[0].path));
    assert.strictEqual(await yaw(pg), y0, "the stroke turned the view");
    const d0 = await camDist(pg), p = await tileXY(pg, 48, 32);
    await touch("touchStart", [[p.x - 20, p.y]]);
    await touch("touchStart", [[p.x - 20, p.y], [p.x + 20, p.y]]);
    for (let k = 1; k <= 5; k++) await touch("touchMove", [[p.x - 20 + k * 3, p.y], [p.x + 20 - k * 3, p.y]]);
    await touch("touchEnd", []);
    assert.ok(await camDist(pg) > d0, "pinching in didn't zoom out");
    assert.strictEqual((await usesOf(pg, "Ditch")).length, 1, "the two-finger gesture used the tool");
    await waitFrames(pg, 1);
    await shot(pg, "phone-3d.png");
  });
  await test("phone: walking shows a stick, and the stick walks the visitor", async () => {
    await pg.click("#walk");
    await pg.waitForFunction(() => window.__glomusWalker().on);
    const pad = await pg.locator(".g3-walkpad").boundingBox();
    assert.ok(pad && pad.width > 80, "the stick is shown");
    const a = await pg.evaluate(() => window.__glomusWalker().pos), cx = pad.x + pad.width / 2, cy = pad.y + pad.height / 2;
    await touch("touchStart", [[cx, cy]]); await touch("touchMove", [[cx, cy - 40]]);
    await pg.waitForTimeout(2000);
    await touch("touchEnd", []);
    const b = await pg.evaluate(() => window.__glomusWalker().pos);
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) > 1, `walked ${JSON.stringify([a, b])}`);
    await shot(pg, "phone-walk.png");
    await pg.click("#walk");
  });
  await phone.context.close();

  await test("no page errors", async () => { assert.deepStrictEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
console.log(`\n${passed} passed, ${process.exitCode ? "some failing" : "0 failing"}`);
