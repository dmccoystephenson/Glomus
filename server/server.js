// Serve Glomus locally. Whims run through the shaper (a Pi agent on the local model).
//
//   node server/server.js [--port 8840] [--no-browser]
//
// Only this machine can reach it: requests must name 127.0.0.1 or localhost as the host, and /api requests
// must carry the token the page was served with. Every whim is saved as a replayable case in
// workspace/whims/ (the world it started from, the transcript, every tool call and the result).
import crypto from "node:crypto";
import { exec } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as WF from "../game/world.js";
import * as Model from "./model.js";
import { shapeWhim, localModel } from "./shaper.js";
import { createStore, MAX_SLOT_BYTES, SlotError } from "./worlds.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// GLOMUS_WORKSPACE moves the token, whims and world slots elsewhere (tests use a temporary folder).
const WORKSPACE = process.env.GLOMUS_WORKSPACE ? path.resolve(process.env.GLOMUS_WORKSPACE) : path.join(ROOT, "workspace");
const FILES = { "/": "index.html", "/index.html": "index.html", "/world.js": "world.js",
  // The 3D view (game/view3d.js and the Strata engine built into game/3d/).
  "/3d": "3d.html", "/3d.html": "3d.html", "/view3d.js": "view3d.js", "/walk3d.js": "walk3d.js",
  "/3d/glomus3d.js": "3d/glomus3d.js", "/3d/glomus3d.wasm": "3d/glomus3d.wasm",
  "/3d/strata-kit.js": "3d/strata-kit.js", "/3d/strata-loader.js": "3d/strata-loader.js",
  "/slots.js": "slots.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };
const IDLE_EXIT_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
const port0 = Number(args[args.indexOf("--port") + 1]) || 8840;
const config = Model.loadConfig(ROOT);
const model = localModel(config);
// The page's access token lives in the workspace, so restarting the server doesn't lock out open pages.
const token = (() => {
  const file = path.join(WORKSPACE, "token.txt");
  try { const t = fs.readFileSync(file, "utf8").trim(); if (/^[\w-]{24,}$/.test(t)) return t; } catch { /* First run. */ }
  const t = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(file, t);
  return t;
})();
const slots = createStore(path.join(WORKSPACE, "worlds"), { WF });
const jobs = new Map();
let active = null, lastSeen = Date.now();

function send(res, status, body, type = "application/json") {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "Content-Type": type, "Content-Length": raw.length, "Cache-Control": "no-store" });
  res.end(raw);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function saveCase(job, input, result) {
  const dir = path.join(WORKSPACE, "whims");
  fs.mkdirSync(dir, { recursive: true });
  const name = new Date(job.started).toISOString().replace(/[:.]/g, "-") + "-" + job.id + ".json";
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ id: job.id, whim: input.whim, spot: input.spot, model: config.alias,
    world: input.world, result: { ...result, messages: undefined }, messages: result.messages }, null, 1));
  fs.appendFileSync(path.join(WORKSPACE, "whims.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: job.id, whim: input.whim,
    outcome: result.outcome, committed: result.committed, toolCalls: result.toolCalls, seconds: result.seconds, error: result.error, file: name }) + "\n");
}

async function startWhim(input) {
  const world = WF.load(input.world);
  const job = { id: crypto.randomBytes(4).toString("hex"), status: "working", started: Date.now(), events: [], result: null };
  jobs.set(job.id, job); active = job;
  (async () => {
    try {
      const result = await shapeWhim({ world, spot: input.spot, whim: input.whim, model, apiKey: config.apiKey, onEvent: (e) => job.events.push(e) });
      job.result = { outcome: result.outcome, committed: result.committed, plan: result.plan, problems: result.problems,
        unsupported: result.unsupported, explain: result.explain, say: result.say,
        error: result.error, seconds: result.seconds, toolCalls: result.toolCalls };
      job.status = "done";
      saveCase(job, input, result);
    } catch (error) {
      job.status = "failed"; job.result = { error: String(error.message || error).slice(0, 300) };
    } finally {
      active = null;
      for (const [id, j] of jobs) if (Date.now() - j.started > 30 * 60 * 1000) jobs.delete(id);
    }
  })();
  return job;
}

// World slots (server/worlds.js). Behind the same Host and token checks as every /api route.
//   GET  /api/worlds          every slot: {name, rev, savedAt, savedBy, tick}
//   GET  /api/worlds/<name>   one slot, with its world
//   POST /api/worlds/<name>   {world, by, base}: base is the rev being replaced, or null for a new slot (409 if stale)
async function worldRoute(req, res, url) {
  let name = null;
  if (url.pathname !== "/api/worlds") { try { name = decodeURIComponent(url.pathname.slice("/api/worlds/".length)); } catch { name = ""; } }
  try {
    if (req.method === "GET" && name === null) return send(res, 200, { ok: true, slots: slots.list() });
    if (req.method === "GET") return send(res, 200, { ok: true, ...slots.read(name) });
    if (req.method === "POST" && name !== null) {
      slots.checkName(name);
      if (Number(req.headers["content-length"]) > MAX_SLOT_BYTES) return send(res, 413, { ok: false, error: "too_large", message: "That world is too large to keep in a slot." });
      let body;
      try { body = await readBody(req, MAX_SLOT_BYTES); }
      catch (e) { return send(res, e.message === "too large" ? 413 : 400, { ok: false, error: e.message === "too large" ? "too_large" : "bad_request" }); }
      return send(res, 200, { ok: true, ...slots.write(name, { world: body.world, by: body.by, base: body.base ?? null }) });
    }
    return send(res, 404, { ok: false, error: "not_found" });
  } catch (e) {
    if (e instanceof SlotError) return send(res, e.status, { ok: false, error: e.error, message: e.message, ...e.extra });
    return send(res, 500, { ok: false, error: "failed", message: "The slot couldn't be read or written." });
  }
}

function handler(port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (req, res) => {
    lastSeen = Date.now();
    if (!hosts.has(req.headers.host)) return send(res, 403, { ok: false, error: "host" });
    const url = new URL(req.url, "http://local");
    if (url.pathname.startsWith("/api/")) {
      const given = String(req.headers["x-glomus-token"] || "");
      if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return send(res, 403, { ok: false, error: "token" });
      if (req.method === "GET" && url.pathname === "/api/status") return send(res, 200, { ...(await Model.status(config)), working: !!active });
      if (req.method === "POST" && url.pathname === "/api/whim") {
        if (active) return send(res, 200, { ok: false, error: "busy", message: "The model is still working on the last whim." });
        let body;
        try { body = await readBody(req); } catch { return send(res, 400, { ok: false, error: "bad_request" }); }
        const whim = String(body.whim || "").trim().slice(0, 600);
        if (!whim) return send(res, 200, { ok: false, error: "bad_request", message: "Write a whim first." });
        const st = await Model.status(config);
        if (!st.ready) return send(res, 200, { ok: false, error: "provider", message: st.reason });
        let spot = null;
        if (body.spot && [body.spot.x, body.spot.y, body.spot.r].every(Number.isFinite)) spot = { x: Math.round(body.spot.x), y: Math.round(body.spot.y), r: Math.max(1, Math.round(body.spot.r)) };
        try { WF.load(body.world); } catch { return send(res, 200, { ok: false, error: "bad_request", message: "The world couldn't be read." }); }
        const job = await startWhim({ whim, spot, world: body.world });
        return send(res, 200, { ok: true, id: job.id });
      }
      if (url.pathname === "/api/worlds" || url.pathname.startsWith("/api/worlds/")) return worldRoute(req, res, url);
      const m = url.pathname.match(/^\/api\/whim\/([0-9a-f]{8})$/);
      if (req.method === "GET" && m) {
        const job = jobs.get(m[1]);
        return job ? send(res, 200, { ok: true, id: job.id, status: job.status, events: job.events, result: job.result })
          : send(res, 404, { ok: false, error: "not_found" });
      }
      return send(res, 404, { ok: false, error: "not_found" });
    }
    if (url.pathname === "/version") return send(res, 200, { name: "glomus" });
    const file = FILES[url.pathname];
    if (!file || req.method !== "GET") return send(res, 404, { ok: false, error: "not_found" });
    let raw = fs.readFileSync(path.join(ROOT, "game", file));
    if (file === "index.html") raw = Buffer.from(raw.toString("utf8").replace("<title>", `<meta name="glomus-local" content="${token}">\n<title>`));
    return send(res, 200, raw, TYPES[path.extname(file)]);
  };
}

function listen(port, tries = 8) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler(port));
    server.once("error", (e) => (tries > 1 && e.code === "EADDRINUSE" ? resolve(listen(port + 1, tries - 1)) : reject(e)));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve({ server, port }));
  });
}

const { server, port } = await listen(port0);
await Model.ensureStarted(config, WORKSPACE);
const url = `http://127.0.0.1:${port}/`;
console.log(`Glomus at ${url} (Ctrl+C to stop)`);
if (!args.includes("--no-browser")) exec(process.platform === "win32" ? `start "" "${url}"` : `xdg-open ${url}`);
const shutdown = () => { Model.stop(); server.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => { if (!active && Date.now() - lastSeen > IDLE_EXIT_MS) { console.log("No page open for 10 minutes; stopping."); shutdown(); } }, 30_000).unref();
