// The composition root: reads config/model.json, and builds the model server's operations on the production
// adapters unless the caller hands it others (tests hand it fakes).
//
// config/model.json is the shared default. config/model.local.json (not tracked) and the GLOMUS_MODEL_URL,
// GLOMUS_MODEL_ALIAS and GLOMUS_MODEL_KEY environment variables override it, in that order, so a different
// server can be used without editing the tracked file. When either of them points baseUrl somewhere else,
// the launch section is dropped unless model.local.json gives its own.
import fs from "node:fs";
import path from "node:path";
import { CLOCKS, DEFAULTS, ENDPOINTS, LAUNCHERS, REPLY_STREAMS } from "./adapters/index.js";
import { busyStatus, isPaused, notServed, pausedStatus, ready, rootOf, servesAlias, slotsBusy, unreachable } from "./core.js";

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

/** An adapter given as an instance, as a registry name, or left out (the default). */
function pick(registry, given, fallback) {
  if (given && typeof given === "object") return given;
  const make = registry[given || fallback];
  if (!make) throw new Error(`No adapter named "${given}" (known: ${Object.keys(registry).join(", ")}).`);
  return make();
}

/**
 * The model server's operations, on the given adapters (instances or registry names; production ones by
 * default). Each server keeps its own launcher, so what it started is what it stops.
 */
export function createModelServer({ endpoint, launcher, replies, clock } = {}) {
  endpoint = pick(ENDPOINTS, endpoint, DEFAULTS.endpoint);
  launcher = pick(LAUNCHERS, launcher, DEFAULTS.launcher);
  replies = pick(REPLY_STREAMS, replies, DEFAULTS.replies);
  clock = pick(CLOCKS, clock, DEFAULTS.clock);

  /** Find the server and say whether it's ready: {ready: true, model} or {ready: false, busy?, reason}. */
  async function status(config) {
    const root = rootOf(config.baseUrl);
    const list = await endpoint.models(config);
    const served = list.ok ? servesAlias(list.value, config.alias) : null;
    if (served === null) return unreachable(root, list.ok ? "absent" : list.failure, launcher.state());
    if (!served) return notServed(root, config.alias);
    const health = await endpoint.health(config);   // No /health: nothing to learn.
    if (health.ok && isPaused(health.value)) return pausedStatus();
    const slots = await endpoint.slots(config);     // Not llama.cpp, or slots disabled: assume free.
    if (slots.ok && slotsBusy(slots.value)) return busyStatus();
    return ready(config.alias);
  }

  /** Start a local server unless something already answers at baseUrl. Only a server started here is stopped later. */
  async function ensureStarted(config, workspace) {
    const root = rootOf(config.baseUrl);
    if ((await endpoint.health(config, { timeoutMs: 1500 })).ok) return;
    const launch = config.launch;
    if (!launch) return;   // Nothing to start: status() says nothing answers.
    launcher.start({ launch, alias: config.alias, root, workspace });
  }

  const stop = () => launcher.stop();

  return { status, ensureStarted, stop, replies, clock };
}
