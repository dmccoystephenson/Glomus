// The model server: find it, or start llama-server from config/model.json, and say whether it's ready.
//
// config/model.json is the shared default. config/model.local.json (not tracked) and the GLOMUS_MODEL_URL,
// GLOMUS_MODEL_ALIAS and GLOMUS_MODEL_KEY environment variables override it, in that order, so a different
// server can be used without editing the tracked file. When either of them points baseUrl somewhere else,
// the launch section is dropped unless model.local.json gives its own.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function loadConfig(root, env = process.env) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config", "model.json"), "utf8"));
  let local = {};
  try { local = JSON.parse(fs.readFileSync(path.join(root, "config", "model.local.json"), "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw new Error("config/model.local.json: " + e.message); }
  const { apiKey: localKey, ...rest } = local;
  if (rest.baseUrl && !("launch" in rest)) delete config.launch;
  Object.assign(config, rest);
  if (env.GLOMUS_MODEL_URL) { config.baseUrl = env.GLOMUS_MODEL_URL; delete config.launch; }
  if (env.GLOMUS_MODEL_ALIAS) config.alias = env.GLOMUS_MODEL_ALIAS;
  if (!config.launch) delete config.launch;
  // The key only ever goes in an Authorization header. It is not enumerable, so it never shows up when the
  // config is logged, saved or sent to the page.
  Object.defineProperty(config, "apiKey", { value: env.GLOMUS_MODEL_KEY || localKey || "", enumerable: false });
  return config;
}

const authHeaders = (config) => (config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {});

const state = { process: null, problem: null, log: null };

async function fetchJson(url, ms = 3000, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw Object.assign(new Error(`${url} answered ${res.status}`), { status: res.status });
  return res.json();
}

export async function status(config) {
  const root = config.baseUrl.replace(/\/v1\/?$/, "");
  try {
    const models = await fetchJson(config.baseUrl + "/models", 3000, authHeaders(config));
    if (!(models.data || []).some((m) => m.id === config.alias)) {
      return { ready: false, reason: `The model server on ${root} is running, but not as "${config.alias}".` };
    }
    try {
      // Some shared servers report a pause (their owner needs the GPU) on /health.
      const health = await fetchJson(root + "/health", 3000);
      if (health && health.paused === true) return { ready: false, busy: true, reason: "The model server is paused for now; try again later." };
    } catch { /* No /health: nothing to learn. */ }
    try {
      const slots = await fetchJson(root + "/slots");
      if (Array.isArray(slots) && slots.some((s) => s.is_processing)) return { ready: false, busy: true, reason: "The local model is busy." };
    } catch { /* Not llama.cpp, or slots disabled: assume free. */ }
    return { ready: true, model: config.alias };
  } catch (error) {
    if (error.status === 401 || error.status === 403) return { ready: false, reason: `The model server on ${root} refused the API key.` };
    if (error.status === 503) return { ready: false, busy: true, reason: `The model server on ${root} is busy or paused; try again later.` };
    if (state.process && state.process.exitCode === null) return { ready: false, reason: "The local model is starting up (usually under a minute)." };
    if (state.process) return { ready: false, reason: "The local model server stopped while starting; see " + state.log };
    if (state.problem) return { ready: false, reason: "Couldn't start the local model: " + state.problem };
    return { ready: false, reason: `No local model at ${root}.` };
  }
}

/** Start llama-server unless something already answers at baseUrl. Only a server started here is stopped later. */
export async function ensureStarted(config, workspace) {
  const root = config.baseUrl.replace(/\/v1\/?$/, "");
  try { await fetchJson(root + "/health", 1500); return; } catch { /* Nothing there yet. */ }
  const launch = config.launch;
  if (!launch) return;   // Nothing to start: status() says nothing answers.
  for (const p of [launch.executable, launch.model]) if (!fs.existsSync(p)) { state.problem = p + " is missing."; return; }
  const url = new URL(root);
  fs.mkdirSync(workspace, { recursive: true });
  state.log = path.join(workspace, "llama-server.log");
  const out = fs.openSync(state.log, "a");
  state.process = spawn(launch.executable, ["--model", launch.model, "--alias", config.alias, "--host", url.hostname,
    "--port", url.port || "8080", ...(launch.args || [])], { stdio: ["ignore", out, out], windowsHide: true });
  state.process.on("error", (e) => { state.problem = e.message; });
}

export function stop() {
  if (state.process && state.process.exitCode === null) state.process.kill();
}
