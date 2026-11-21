// Run the eval cases through the real shaper and the local model, headless.
//
//   node tools/eval.js                      every case once
//   node tools/eval.js --only floodgate,island --repeat 3
//
// Each case starts from the same seeded world. If the shaper commits, the plan is applied to one copy and the
// world is simulated for after_seconds next to an untouched copy; the checks compare the two. Results, plans
// and full transcripts go to workspace/evals/run-<time>.json, ready for a reviewer (or Claude) to judge
// whether each result actually matches its whim.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as WF from "../game/world.js";
import * as Model from "../server/model-server/index.js";
import { shapeWhim } from "../server/shaper.js";
import { checkClaims } from "../server/claims.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => { const k = args.indexOf(name); return k >= 0 ? args[k + 1] : null; };
const suite = JSON.parse(fs.readFileSync(path.join(ROOT, "evals", "cases.json"), "utf8"));
const only = opt("--only") ? new Set(opt("--only").split(",")) : null;
const repeat = Math.max(1, Number(opt("--repeat")) || 1);
const config = Model.loadConfig(ROOT);

const st = await Model.status(config);
if (!st.ready) { console.error("Model not ready: " + st.reason); process.exit(2); }

const base = WF.save(WF.makeWorld(suite.seed));
const water = (w, cells) => { let s = 0; for (const i of cells) s += w.water[i]; return s; };
const height = (w, cells) => { let s = 0; for (const i of cells) s += w.height[i]; return cells.length ? s / cells.length : 0; };
const wetTiles = (w) => { let n = 0; for (let i = 0; i < WF.N; i++) if (w.water[i] > WF.WET) n++; return n; };

// ---------- tools: use one at a point and compare with the same world where it wasn't used ----------
const circleStat = (w, x, y, r) => {
  const cells = WF.areaShape({ circle: [x, y, r] }).cells;
  let h = 0, wet = 0, water = 0, min = 99;
  for (const i of cells) { h += w.height[i]; water += w.water[i]; if (w.water[i] > WF.WET) wet++; min = Math.min(min, w.height[i]); }
  return { h: h / cells.length, wet, water, min, tiles: cells.length };
};
let caseBase = base;   // the world a case starts from (its setup applied)
const areaStat = (w, area) => {
  const cells = WF.areaShape(area).cells;
  let h = 0, wet = 0, water = 0, min = 99;
  for (const i of cells) { h += w.height[i]; water += w.water[i]; if (w.water[i] > WF.WET) wet++; min = Math.min(min, w.height[i]); }
  return { h: h / cells.length, wet, water, min, tiles: cells.length };
};
/** Use the plan's first tool once: at a point (a drag tool drags 8 tiles across it) or along a given path. */
function useTool(plan, spot, pt, seconds) {
  const A = WF.load(caseBase), B = WF.load(caseBase);
  const sa = WF.acceptPlan(A, WF.checkPlan(A, plan, spot).clean, { spot }); WF.acceptPlan(B, WF.checkPlan(B, plan, spot).clean, { spot });
  const power = sa.powers[0], at = pt.at || pt.path[0];
  const where = power.brush.stroke ? { path: pt.path || [[at[0] - 4, at[1]], [at[0] + 4, at[1]]] } : { x: at[0], y: at[1] };
  const r = WF.usePower(A, power.id, where);
  for (let t = 0; t < seconds * WF.TPS; t++) { WF.step(A); WF.step(B); }
  return { A, B, power, use: r.use, ok: r.ok, area: r.ok ? WF.useArea(r.use) : null, label: pt.path ? "drag" : `(${at})` };
}
// A height the message says the ground ends at, read with the eval's own pattern (not the claim checker's).
const statedHeight = (say) => { const m = (say || "").match(/\b(?:to|at|until|down to|reaches|about)\s*(?:about\s*|around\s*)?(\d+(?:\.\d+)?)\s*m\b/i); return m ? Number(m[1]) : null; };
const planFloor = (power) => {
  const bounds = power.threads.filter((t) => t.do.some((a) => "lower" in a)).flatMap((t) => t.when.filter((c) => c.height && c.height[0].includes(">")).map((c) => c.height[1]));
  return bounds.length ? Math.min(...bounds) : null;
};

function judge(check, ctx) {
  const { result, without, withPlan, fires, ticks, plan, newMaterials, spot } = ctx;
  const cells = check.area ? WF.areaShape(check.area).cells : null;
  switch (check.type) {
    case "committed": return [result.outcome === "committed", result.outcome === "committed" ? "committed" : result.outcome + (result.error ? ": " + result.error : "")];
    case "not_committed": return [result.outcome !== "committed", result.outcome === "committed" ? "committed a plan" : result.outcome];
    case "outcome_in": return [check.outcomes.includes(result.outcome), result.outcome + (result.error ? ": " + result.error : "")];
    // The missing ability is named to the player: in a proposal's "can't do" list, or in a decline's message.
    case "unsupported_mentions": {
      const re = new RegExp(check.pattern, "i");
      if (result.outcome === "declined" || result.outcome === "answered") return [re.test(result.say || ""), "declined: " + (result.say || "").slice(0, 70)];
      const ok = (result.unsupported || []).some((u) => re.test(u));
      return [ok, "unsupported: " + ((result.unsupported || []).join("; ") || "none")];
    }
    // Regression coverage for the claim checker: not, by itself, evidence that the message is true.
    case "claims_check": {
      if (!plan) return [true, "no plan to check"];
      const p = checkClaims(result.say || "", plan);
      return [!p.length, p.length ? p[0].slice(0, 100) : "no unbacked claims found"];
    }
    case "says": { const ok = new RegExp(check.pattern, "i").test(result.say || ""); return [ok, `said: ${(result.say || "").slice(0, 80)}`]; }
    case "more_water": case "less_water": {
      if (!plan) return [false, "no plan"];
      const d = water(withPlan, cells) - water(without, cells), ok = check.type === "more_water" ? d >= check.min : -d >= check.min;
      return [ok, `water ${d >= 0 ? "+" : ""}${d.toFixed(1)} m³`];
    }
    case "higher": case "lower": {
      if (!plan) return [false, "no plan"];
      const d = height(withPlan, cells) - height(without, cells), ok = check.type === "higher" ? d >= check.min : -d >= check.min;
      return [ok, `ground ${d >= 0 ? "+" : ""}${d.toFixed(2)} m`];
    }
    case "more_wet_tiles": { if (!plan) return [false, "no plan"]; const d = wetTiles(withPlan) - wetTiles(without); return [d >= check.min, `wet tiles ${d >= 0 ? "+" : ""}${d}`]; }
    case "thread_acts": { const any = fires.some((f) => f.ticks > 0); return [any, any ? "a thread acted" : "no thread ever acted"]; }
    case "intermittent": {
      const best = fires.map((f) => f.ticks / ticks).find((r) => r > 0.1 && r < 0.9);
      return [best !== undefined, "active " + fires.map((f) => Math.round((100 * f.ticks) / ticks) + "%").join("/")];
    }
    case "new_material_grows": {
      let n = 0; for (let i = 0; i < WF.N; i++) if (newMaterials.has(withPlan.mat[i])) n++;
      return [n >= check.min, `${n} tiles of new materials`];
    }
    case "no_switch_off": return [!plan || !plan.switch_off.length, plan && plan.switch_off.length ? `switched off ${plan.switch_off.join(", ")}` : "left other skeins alone"];
    case "uses_condition": {
      const has = (c) => check.condition in c || (c.not && has(c.not));
      const used = !!plan && plan.threads.some((t) => t.when.some(has));
      return [used, used ? `uses ${check.condition}` : `no ${check.condition}`];
    }
    case "keeps": {
      const k = withPlan.materials.findIndex((m) => m.name === check.material);
      let a = 0, b = 0; for (let i = 0; i < WF.N; i++) { if (without.mat[i] === k) a++; if (withPlan.mat[i] === k) b++; }
      return [b >= a * check.fraction, `${check.material} ${a} → ${b} tiles`];
    }
    case "has_power": {
      const tools = plan ? (plan.powers || []).filter((p) => !check.brush || check.brush in p.brush) : [];
      return [tools.length > 0, tools.length ? "tools: " + tools.map((p) => `${p.icon || ""}${p.name}${p.brush.stroke ? " (drag)" : ""}`).join(", ") : `no ${check.brush ? check.brush + " " : ""}tool`];
    }
    // A new tool replaces the one the player already has, instead of piling up a second copy.
    case "replaces": {
      const r = plan ? (plan.powers || []).map((p) => p.replaces).filter(Boolean) : [];
      return [r.includes(check.id), r.length ? "replaces " + r.join(", ") : "replaces nothing"];
    }
    // Before anyone uses a tool, nothing changes at these points (Jon's original plan sank its circle at once).
    case "quiet_until_used": {
      if (!plan) return [false, "no plan"];
      const worst = Math.max(...check.at.map(([x, y]) => Math.abs(circleStat(withPlan, x, y, 3).h - circleStat(without, x, y, 3).h)));
      return [worst < 0.05, `ground moved ${worst.toFixed(2)} m before any use`];
    }
    case "power_use": {
      if (!plan || !(plan.powers || []).length) return [false, "no tool"];
      const notes = [], fails = [];
      for (const pt of check.points) {
        const { A, B, power, ok, area, label } = useTool(plan, spot, pt, check.seconds || 60);
        if (!ok) { fails.push(`${label} refused`); continue; }
        const a = areaStat(A, area), b = areaStat(B, area);
        const drop = b.h - a.h, bits = [`${label} drop ${drop.toFixed(2)} m, wet ${b.wet}→${a.wet}/${a.tiles}`];
        if (pt.sinks !== undefined && drop < pt.sinks) fails.push(`${label} didn't sink`);
        if (pt.wet && a.wet < Math.max(b.wet + 1, a.tiles * 0.5)) fails.push(`${label} didn't get wet`);
        if (pt.floor) {
          const floor = statedHeight(result.say) ?? planFloor(power);
          if (floor !== null) { bits.push(`min ${a.min.toFixed(1)} m vs floor ${floor}`); if (a.min < Math.min(floor, b.min) - 0.75) fails.push(`${label} dug below ${floor} m`); }
          else bits.push("no floor stated or planned");
        }
        if (check.control) {
          const ca = circleStat(A, check.control[0], check.control[1], 2), cb = circleStat(B, check.control[0], check.control[1], 2);
          if (Math.abs(ca.h - cb.h) > 0.05) fails.push("the control point changed");
        }
        notes.push(bits.join(", "));
      }
      return [!fails.length, (fails.length ? fails.join("; ") + " — " : "") + notes.join("; ")];
    }
    // The effect really ends: run past its planned (or stated) end and check the use has stopped acting.
    case "effect_ends": {
      if (!plan || !(plan.powers || []).length) return [false, "no tool"];
      const power = plan.powers[0];
      const ends = power.threads.filter((t) => t.do.some((a) => check.action in a)).map((t) => (t.when.find((c) => "within" in c) || {}).within);
      if (!ends.length) return [false, `no thread does ${check.action}`];
      if (ends.some((e) => e === undefined)) return [false, `a ${check.action} thread never ends`];
      const { A, use } = useTool(plan, spot, { at: check.at }, Math.max(...ends) + 5);
      const st = WF.useStates(A).get(use.id);
      return [!["acting", "pending", "waiting"].includes(st.state), `after ${Math.max(...ends) + 5} s: ${st.text}`];
    }
    // An animal after the case's seconds: alive, and at least this watered and fed. Compared with no plan.
    case "animal": {
      const show = (w) => { const a = w.creatures.find((k) => k.name === check.name); return !a ? "gone" : a.dead ? `died of ${a.diedOf}` : `thirst ${Math.round(a.thirst * 100)}%, ${a.state}`; };
      const a = withPlan.creatures.find((k) => k.name === check.name);
      const ok = !!a && !a.dead && a.thirst >= (check.min_thirst ?? 0) && a.hunger >= (check.min_hunger ?? 0);
      return [ok, `${check.name}: ${show(withPlan)}; without the plan: ${show(without)}`];
    }
    case "species_defined": {
      const n = plan ? (plan.species || []).length : 0;
      return [n > 0, n ? "species: " + plan.species.map((sp) => `${sp.name} (eats ${sp.eats.join("/")}, wades ${sp.wades} m)`).join(", ") : "no species"];
    }
    // Animals of the plan's new species are still alive after `seconds` more.
    case "animals_survive": {
      if (!plan || !(plan.species || []).length) return [false, "no species"];
      const names = new Set(plan.species.map((sp) => sp.name)), w = WF.load(WF.save(withPlan));
      const count = () => w.creatures.filter((k) => names.has(k.species) && !k.dead).length, start = count();
      for (let t = 0; t < (check.seconds || 90) * WF.TPS; t++) WF.step(w);
      const dead = w.creatures.filter((k) => names.has(k.species) && k.dead).map((k) => `${k.name}: ${k.diedOf}`);
      return [start > 0 && count() > 0, `${start} released and alive at ${suite.after_seconds || 30} s, ${count()} alive ${check.seconds || 90} s later${dead.length ? " (" + dead.join(", ") + ")" : ""}`];
    }
    case "uses": {
      const used = !!plan && plan.threads.some((t) => t.do.some((a) => check.action in a));
      return [used, used ? `uses ${check.action}` : `no ${check.action}`];
    }
    default: return [false, "unknown check " + check.type];
  }
}

const runs = [];
for (const c of suite.cases) {
  if (only && !only.has(c.id)) continue;
  for (let k = 0; k < repeat; k++) {
    process.stdout.write(`${c.id}${repeat > 1 ? " #" + (k + 1) : ""} … `);
    // A case can start with something already made (a tool in the palette), written as a plan.
    caseBase = base;
    if (c.setup || c.animals) {
      const w = WF.load(base);
      if (c.setup) WF.acceptPlan(w, WF.checkPlan(w, c.setup, c.spot).clean, { spot: c.spot });
      // A case can move an animal or change its needs, e.g. a thirsty Mossback on a dry ridge.
      for (const a of c.animals || []) {
        const cr = w.creatures.find((k) => k.name === a.name);
        if (!cr) continue;
        if (a.x !== undefined) Object.assign(cr, { x: a.x + 0.5, y: a.y + 0.5, goal: null, next: -1 });
        for (const k of ["thirst", "hunger"]) if (a[k] !== undefined) cr[k] = a[k];
      }
      caseBase = WF.save(w);
    }
    const result = await shapeWhim({ world: WF.load(caseBase), spot: c.spot, whim: c.whim, model: Model.localModel(config), apiKey: config.apiKey });
    const without = WF.load(caseBase), withPlan = WF.load(caseBase);
    const knownMaterials = withPlan.materials.length;
    let plan = null, skein = null;
    if ((result.outcome === "committed" || result.outcome === "proposed") && result.plan) {
      const checked = WF.checkPlan(withPlan, result.plan, c.spot);
      plan = checked.clean; skein = WF.acceptPlan(withPlan, plan, { whim: c.whim, spot: c.spot });
    }
    const ticks = (suite.after_seconds || 30) * WF.TPS;
    const fires = plan ? plan.threads.map(() => ({ ticks: 0 })) : [];
    for (let t = 0; t < ticks; t++) {
      WF.step(without); WF.step(withPlan);
      if (skein) WF.threadActivity(withPlan, skein).forEach((f, j) => { if (f > 0) fires[j].ticks++; });
    }
    const newMaterials = new Set(withPlan.materials.map((_, j) => j).filter((j) => j >= knownMaterials));
    const checks = c.checks.map((check) => { const [ok, note] = judge(check, { result, without, withPlan, fires, ticks, plan, newMaterials, spot: c.spot }); return { type: check.type, ok, note }; });
    const passed = checks.every((x) => x.ok);
    const retries = result.events.filter((e) => e.kind === "retry").length;
    console.log(`${passed ? "PASS" : "FAIL"}  ${result.outcome}, ${result.seconds.toFixed(0)}s${result.waitSeconds >= 1 ? ` (${result.waitSeconds.toFixed(0)}s before replies started)` : ""}, ${result.toolCalls} tool calls${retries ? `, ${retries} retried` : ""}  ` + checks.map((x) => `${x.ok ? "✓" : "✗"} ${x.type} (${x.note})`).join("  "));
    runs.push({ id: c.id, whim: c.whim, spot: c.spot, passed, checks, outcome: result.outcome, committed: result.committed, say: result.say, plan: result.plan,
      unsupported: result.unsupported, explain: result.explain,
      error: result.error, seconds: result.seconds, waitSeconds: result.waitSeconds, retries, toolCalls: result.toolCalls, events: result.events, messages: result.messages });
  }
}

const n = runs.length, pass = runs.filter((r) => r.passed).length;
const checksAll = runs.flatMap((r) => r.checks), checksOk = checksAll.filter((x) => x.ok).length;
const avg = (f) => (runs.reduce((s, r) => s + f(r), 0) / Math.max(1, n));
const summary = { model: config.alias, seed: suite.seed, runs: n, passed: pass, checks: `${checksOk}/${checksAll.length}`,
  avgSeconds: +avg((r) => r.seconds).toFixed(1), avgToolCalls: +avg((r) => r.toolCalls).toFixed(1) };
console.log(`\n${pass}/${n} cases passed, ${checksOk}/${checksAll.length} checks, ${summary.avgSeconds}s and ${summary.avgToolCalls} tool calls per whim on average.`);
const dir = path.join(ROOT, "workspace", "evals");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "run-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
fs.writeFileSync(file, JSON.stringify({ summary, runs }, null, 1));
console.log("Saved " + path.relative(ROOT, file));
