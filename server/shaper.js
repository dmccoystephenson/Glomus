// The shaper: a Pi agent that turns a player's whim into a skein, working on a copy of the world.
// It can look closely, read other skeins, preview a plan by simulating it, and finally commit it.
// The model only proposes; the game validates every plan (checkPlan) before anything runs.
import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import * as WF from "../game/world.js";
import { CAPS, admissions, checkClaims, requestNeeds, routeOutcome } from "./claims.js";

export const MAX_TOOL_CALLS = 8;
export const PREVIEW_SECONDS = 20;
const TIME_LIMIT_MS = 240_000;

export const LANGUAGE = `You shape Glomus, a living landscape seen from above. The player points at a spot and tells you a
whim; you make it real by committing a plan. You work with tools on a copy of the world:

  look(area)           heights, water and ground in an area; small areas include a tile-by-tile height grid
  read_skein(id)       the full plan of an existing skein
  try_plan(plan)       check a plan and simulate it for ${PREVIEW_SECONDS} seconds on a copy; reports what changed
  commit(plan)         apply the plan to the real world. This ends your turn.
  propose(plan, unsupported)   offer the closest thing you can make when part of the whim can't be done: a
                       full plan (with its threads and edits), plus a short list of what's missing, a few words
                       each. The player sees both and approves it or not. This ends your turn.
  decline(say)         when nothing reasonable fits: tell the player why, briefly. This ends your turn.

Work like this: look where you need detail, try_plan, fix what the preview shows is wrong, then commit.
You have at most ${MAX_TOOL_CALLS} tool calls, so don't over-explore. Finish with commit when the whole whim is done
as asked, propose when part of it can't be (with the closest thing you can make), or decline when nothing
reasonable fits. If you can name an alternative, propose it rather than describing it in a decline. unsupported
names only abilities Glomus lacks ("double-click", "days"), never what your plan does. If the
player only asked a question, just answer in one or two sentences.

WHAT GLOMUS CAN'T DO (use propose or decline; never pretend):
  - player input beyond tools: a click on the map picks the spot, or uses the tool the player picked from their
    palette (see TOOLS), and a drag uses a drag tool. There are no double-clicks, right-clicks, keys, holding the
    mouse, hovering or scroll wheels to bind anything to.
  - real time: there are no days or hours, only game seconds and minutes. For "2 days", propose a span of
    seconds or minutes and propose it with unsupported ["days"].
  - sounds, camera, zoom or 3D views, anything outside the map. Animals exist (see ANIMALS) but can't yet fly,
    swim, breed, form herds or packs, hunt each other, talk, or follow the player.
The game reads the player's request: if it asks for one of these, your plan is shown to the player as a proposal
for them to approve, whichever tool you call. So say plainly what you made instead and how it differs.

A PLAN is a JSON object:
{"name": "short title", "say": "one or two sentences to the player about what you made",
 "materials": [...], "edits": [...], "threads": [...], "powers": [...], "switch_off": [skein ids]}
Leave out any list you don't need.

AREA, where something happens:
  "spot"                                the player's selected spot ("here")
  "everywhere"                          the whole map
  {"circle": [x, y, radius]}
  {"rect": [x, y, width, height]}
  {"path": [[x, y], [x, y], ...], "width": 2}   follows its points in order: streams, channels, walls, roads
x runs 0-95 from west to east; y runs 0-63 from north to south.

EDITS happen once, at commit. Each edit is {"area": AREA, ...} with one or more of:
  "lower": metres      dig (a channel 1.5-3 m deep carries a stream)
  "raise": metres      build up (hills, walls, dams, islands)
  "level": metres      flatten to this height
  "material": "name"   paint the ground
  "water": metres      pour water in

THREADS keep running, every moment, on every tile of their area, until switched off:
  {"name": "...", "area": AREA, "when": [CONDITIONS], "do": [ACTIONS]}
A tile acts only when all its conditions hold; an empty "when" always holds.
CONDITIONS:
  {"material": ["stone", "sand"]}            the tile is one of these
  {"water": [">", 0.2]}  {"height": ["<", 6]}   compare with > < >= <=
  {"near": "water", "count": [">=", 2]}       how many of the 8 neighbours are wet (or are a given material)
  {"chance": 0.1}                             chance per second; it thins out every action, including per-second
                                              amounts, so use it for growth and painting, not for water
  {"cycle": 30, "from": 0, "to": 10}          true from second 0 to 10 of every 30-second cycle: timers, gates, pulses
  {"raining": true}
  {"within": 60}                              only during the first 60 seconds after you commit: "for a minute"
  {"after": 120}                              only from 120 seconds after you commit: "after a while"
  {"not": CONDITION}
The world has no days; if the player names a long time, pick a span in seconds that suits the game (a few
minutes at most), propose it with unsupported ["days"], and tell them what you chose.
ACTIONS, amounts are per second on EACH tile where the thread acts (so a big area multiplies them; the
built-in spring adds 2 per second on about 9 tiles):
  {"add_water": 1}   {"drain_water": 1}   {"raise": 0.2}   {"lower": 0.2}
  {"push_water": "east", "amount": 2}         move water to the neighbour north/south/east/west/downhill/uphill: pumps, currents
  {"set_material": "name"}
  {"spread": "name", "chance": 0.2, "onto": ["soil"]}   paint a random neighbour: growth, creep, infection

MATERIALS: soil, sand, stone, meadow and snow are built in; water is not a material. Invent new ones like
{"name": "glowmoss", "color": "#7fffb0", "erodes": 0.2}; erodes (0-1) is how fast running water wears it
away. Listing an existing material again changes its color or erodes.
SWITCH_OFF lists skein ids to turn off, for when the player wants something stopped.

TOOLS ("powers"): when the player wants to do something themselves, wherever they choose ("a tool that raises a
hill where I click", "when I click, water floods in"), give them a tool. It appears in their palette with its
icon; they pick it and click the map. Nothing happens until they use it.
  {"name": "Sink", "icon": "🕳️", "brush": {"circle": 4}, "edits": [...], "threads": [...]}
  - brush {"circle": r} (r 1-12): each use acts on a circle of radius r around the click (the player can resize it).
  - brush {"stroke": w} (w 1-8): a drag tool; each use acts along the path the player drags, w tiles wide
    ("a tool that digs a channel where I drag", walls, paint brushes).
  - edits and threads have NO area: they act where the player clicks. Edits happen once per use; threads keep
    acting there, each use separately, with within/after counted from that use ("for 10 s after each click").
  - a height limit holds rather than ends: {"height": [">", 6]} on a lowering thread keeps the ground at or below
    6 m, and lowers it again if it rises. To sink until water arrives, sense it: lower while {"water": ["<", 0.2]}
    and {"height": [">", 1]}, so each tile stops once it's wet (and a pit with no water near stays dry at 1 m).
  - spreading from a use can reach beyond the circle; that use's later threads follow it (fire burns out where
    it spread).
  - icon: one emoji. At most 3 tools per plan. A tool and its effect can be the whole plan.
  - keep a use small: a brush of radius 2-5, and per-second amounts like add_water 0.2-0.6 (a radius-4 brush is
    about 50 tiles, so 0.5 a second is 25 m³ a second). A tool makes its own effect: {"raining": true} would
    make a rain-cloud tool wait for the weather's rain instead of raining.
  - to change a tool the player already has ("make my rain stronger"), make a new tool with
    "replaces": "<its id or name>" (ids are in the skein list). It takes the old one's place in the palette; the
    old tool's earlier uses keep going.
You can't use tools yourself: if the player asks you to use one, make the change directly or tell them how.

ANIMALS live on their own (the world report's Animals lines say where each is and how thirsty and hungry it is).
You can't move or command them: they drink, eat, flee and die by themselves. You help or harm them only through
the land. An animal sees 12 tiles; it drinks from a tile next to water, walks only where water is no deeper than it
wades and steps are no taller than it climbs, eats the materials it eats (eating meadow leaves soil) and flees
ground it avoids. So to help a thirsty animal, put water it can reach within 12 tiles of it, without flooding the
tile it stands on.
  New species: {"species": [{"name": "lizard", "look": {"color": "#e8803a", "pattern": "ring"}, "eats": ["sand"],
    "avoids": ["meadow"], "wades": 0.1, "climbs": 2, "speed": 1.5, "thirst": 180, "hunger": 300}]}
    pattern: dot, ring, stripe, diamond or cross. eats and avoids: material names. wades 0-2 m, climbs 0.5-5 m,
    speed 0.2-3 tiles a second, thirst and hunger: seconds it lasts without water or food (30-1200). At most 2 per plan.
  Release animals: {"release": [{"species": "lizard", "area": "spot", "count": 2, "names": ["Ember"]}]}, at most 6.
    Release them where they can live: on ground they can stand on, near the water and food they need.
To turn an existing skein into a tool, read_skein it and put its threads in a tool.

How the world works: water flows downhill, pools in low ground and leaves over the south edge. Fast water
erodes soft ground and drops silt where it slows. It rains now and then. Nature (skein 1) is itself
written as threads, so you can switch it off or work alongside it.

Guidance:
- Do what the player asked, faithfully, and make it visible and alive. A whim doesn't need to be useful.
- Water only runs downhill by itself. To bring water somewhere, dig a channel that slopes down from the water
  to the target, or pump it with push_water. A stream, fountain or waterfall needs a source: unless its
  channel starts in existing water, add a thread at its start that adds water.
- Shapes are edits; behaviour is threads. Keep amounts modest: a source of 1-3 per second on a few tiles
  (a circle of radius 1-2) makes a stream.
- Trust the preview: if it says your water went nowhere or a thread never acted, fix the plan before committing.
- Leave other skeins alone: only use switch_off when the player asks for something to stop.
- Keep the world's variety: an edit that paints the whole map replaces every meadow, stone and sand tile.
  Prefer threads that act on the ground that is already there.
- In "say", describe only what your plan actually does. The game checks your say against the plan and refuses
  the commit if they disagree: a height the ground ends at ("sinks to 6 m") needs a lowering thread with
  {"height": [">", 6]} or a level edit; "for 30 seconds" or "stops after 30 seconds" needs {"within": 30} on
  that thread; "after 10 seconds" (a later start) needs {"after": 10}; "every 30 seconds" needs a cycle; "stops",
  "ends" or "burns out" needs within or a height limit; "regrows" or "later" needs after or cycle.
  The player also sees a description generated from your plan next to your say, so a mismatch shows.`;

const AreaParam = Type.Any({ description: 'An AREA: "spot", "everywhere", {"circle":[x,y,r]}, {"rect":[x,y,w,h]} or {"path":[[x,y],...],"width":2}' });
const PlanParam = Type.Object({
  name: Type.Optional(Type.String()),
  say: Type.Optional(Type.String()),
  materials: Type.Optional(Type.Array(Type.Any())),
  edits: Type.Optional(Type.Array(Type.Any())),
  threads: Type.Optional(Type.Array(Type.Any())),
  switch_off: Type.Optional(Type.Array(Type.Any())),
  powers: Type.Optional(Type.Array(Type.Any())),
  species: Type.Optional(Type.Array(Type.Any())),
  release: Type.Optional(Type.Array(Type.Any())),
});
const UnsupportedParam = Type.Array(Type.String(), { description: 'What part of the whim can\'t be done, a few words each, e.g. ["double-click", "days"]. At most 3.' });

/**
 * Some models' chat templates show earlier tool calls with nested arguments as Python-style text, e.g.
 * "{'circle': [39, 3, 10]}", and the model then copies that form. Read such a string back as the object or
 * list it spells; anything else is left exactly as it was.
 */
export function unstring(value) {
  if (typeof value === "string") {
    const s = value.trim();
    if (!/^[[{][\s\S]*[\]}]$/.test(s)) return value;
    for (const form of [s, s.replace(/'/g, '"').replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null")]) {
      try { return unstring(JSON.parse(form)); } catch { /* Try the next form. */ }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(unstring);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unstring(v)]));
  return value;
}

export function localModel(config) {
  return {
    id: config.alias, name: config.alias, api: "openai-completions", provider: "local",
    baseUrl: config.baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow || 32768, maxTokens: config.maxTokens || 3000,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false,
      supportsStrictMode: false, maxTokensField: "max_tokens" },
  };
}

const text = (t, details = {}) => ({ content: [{ type: "text", text: t }], details });
const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toString();

/** Parse an area exactly as plans do (via checkPlan), so look() accepts the same forms. */
function cellsOf(world, area, spot) {
  const { clean, problems } = WF.checkPlan(world, { edits: [{ area, water: 0.0001 }] }, spot);
  if (!clean || !clean.edits.length) throw new Error("Couldn't read that area: " + problems.join("; "));
  return { area: clean.edits[0].area, cells: WF.areaShape(clean.edits[0].area).cells };
}

/** Area statistics, plus a tile grid for small areas so the model can plan paths. */
export function lookAt(world, area, spot) {
  const { area: a, cells } = cellsOf(world, area, spot);
  if (!cells.length) throw new Error("That area has no tiles on the map.");
  let hmin = 99, hmax = 0, hsum = 0, wsum = 0, wet = 0, xs = [], ys = [];
  const counts = new Map();
  for (const i of cells) {
    const x = i % WF.W, y = Math.floor(i / WF.W);
    xs.push(x); ys.push(y);
    hmin = Math.min(hmin, world.height[i]); hmax = Math.max(hmax, world.height[i]); hsum += world.height[i];
    wsum += world.water[i]; if (world.water[i] > WF.WET) wet++;
    const m = world.materials[world.mat[i]].name; counts.set(m, (counts.get(m) || 0) + 1);
  }
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const lines = [
    `${WF.describeArea(a)}: ${cells.length} tiles spanning x ${x0}-${x1}, y ${y0}-${y1}.`,
    `Ground height ${fmt(hmin)}-${fmt(hmax)} m, average ${fmt(hsum / cells.length)}. Water ${fmt(wsum)} m³ in total, ${wet} wet tiles.`,
    "Ground: " + [...counts].sort((p, q) => q[1] - p[1]).map(([n, c]) => `${n} ${c}`).join(", ") + ".",
  ];
  if (x1 - x0 < 24 && y1 - y0 < 24) {
    lines.push("Height grid in whole metres (~ marks water deeper than 0.05 m):");
    lines.push("      " + Array.from({ length: x1 - x0 + 1 }, (_, k) => String(x0 + k).padStart(4)).join(""));
    for (let y = y0; y <= y1; y++) {
      let row = `y ${String(y).padStart(2)} `;
      for (let x = x0; x <= x1; x++) {
        const i = y * WF.W + x;
        row += (String(Math.round(world.height[i])) + (world.water[i] > WF.WET ? "~" : "")).padStart(4);
      }
      lines.push(row);
    }
  } else {
    lines.push("(Look at a smaller area, under 24 tiles across, for a tile-by-tile grid.)");
  }
  return lines.join("\n");
}

/** Where the preview uses a tool: a circle at useAt, or for a drag tool a short stroke through it. */
function trialUse(p, useAt) {
  if (!p.brush.stroke) return { where: { x: useAt[0], y: useAt[1] }, area: { circle: [useAt[0], useAt[1], p.brush.circle] } };
  const path = [[Math.max(0, useAt[0] - 4), useAt[1]], [Math.min(WF.W - 1, useAt[0] + 4), useAt[1]]];
  return { where: { path }, area: { path, width: p.brush.stroke } };
}

function planAreas(clean, useAt) {
  return clean.edits.map((e) => e.area).concat(clean.threads.map((t) => t.area))
    .concat((clean.powers || []).map((p) => trialUse(p, useAt).area));
}

function footStat(w, area) {
  const { cells } = WF.areaShape(area);
  let h = 0, wet = 0, water = 0;
  for (const i of cells) { h += w.height[i]; water += w.water[i]; if (w.water[i] > WF.WET) wet++; }
  return { h: h / Math.max(1, cells.length), wet, water, tiles: cells.length };
}

/**
 * Simulate the plan on a copy and compare with the same copy left alone. Each tool in the plan is used once at
 * useAt (default: the spot, or the map centre), so the model can see what a use does there.
 */
export function preview(world, clean, spot, seconds = PREVIEW_SECONDS, useAt = null) {
  const without = WF.load(WF.save(world)), withPlan = WF.load(WF.save(world));
  const baseCounts = new Map(withPlan.materials.map((m, k) => [k, 0]));
  for (let i = 0; i < WF.N; i++) baseCounts.set(withPlan.mat[i], (baseCounts.get(withPlan.mat[i]) || 0) + 1);
  const skein = WF.acceptPlan(withPlan, clean, { spot });
  const at = useAt || (spot ? [spot.x, spot.y] : [Math.floor(WF.W / 2), Math.floor(WF.H / 2)]);
  const uses = skein ? skein.powers.map((p) => {
    const trial = trialUse(p, at), before = footStat(withPlan, trial.area);
    return { p, trial, before, r: WF.usePower(withPlan, p.id, trial.where) };
  }) : [];
  const fires = clean.threads.map(() => ({ total: 0, ticks: 0 }));
  for (let t = 0; t < seconds * WF.TPS; t++) {
    WF.step(without); WF.step(withPlan);
    if (skein) WF.threadActivity(withPlan, skein).forEach((f, k) => { fires[k].total += f; if (f > 0) fires[k].ticks++; });
  }
  const cells = new Set();
  for (const a of planAreas(clean, at)) for (const i of WF.areaShape(a).cells) cells.add(i);
  const stat = (w) => {
    let water = 0, wet = 0, h = 0;
    for (const i of cells) { water += w.water[i]; if (w.water[i] > WF.WET) wet++; h += w.height[i]; }
    let mapWet = 0; const counts = new Map();
    for (let i = 0; i < WF.N; i++) { if (w.water[i] > WF.WET) mapWet++; counts.set(w.mat[i], (counts.get(w.mat[i]) || 0) + 1); }
    return { water, wet, h: cells.size ? h / cells.size : 0, mapWet, counts };
  };
  const a = stat(without), b = stat(withPlan);
  const lines = [`Simulated ${seconds} s with the plan, compared with the same ${seconds} s without it.`];
  if (cells.size) {
    lines.push(`In the plan's areas (${cells.size} tiles): water ${fmt(a.water)} → ${fmt(b.water)} m³, wet tiles ${a.wet} → ${b.wet}, average ground ${fmt(a.h)} → ${fmt(b.h)} m.`);
  }
  lines.push(`Whole map: wet tiles ${a.mapWet} → ${b.mapWet}.`);
  const changes = [];
  withPlan.materials.forEach((m, k) => {
    const before = a.counts.get(k) || 0, after = b.counts.get(k) || 0;
    if (Math.abs(after - before) >= 3) changes.push(`${m.name} ${before} → ${after} tiles`);
  });
  if (changes.length) lines.push("Ground: " + changes.join(", ") + ".");
  clean.threads.forEach((t, k) => {
    const f = fires[k], ticks = seconds * WF.TPS;
    lines.push(f.ticks === 0
      ? `Thread "${t.name}" never acted: its conditions never held on any tile.`
      : `Thread "${t.name}": its conditions held on ${fmt(f.total / Math.max(1, f.ticks), 0)} tiles at a time, during ${Math.round((100 * f.ticks) / ticks)}% of the time (actions with their own chance change fewer tiles than that).`);
  });
  const states = WF.useStates(withPlan);
  for (const { p, trial, before, r } of uses) {
    if (!r.ok) { lines.push(`Tool "${p.name}" couldn't be used at (${at[0]},${at[1]}): ${r.message}`); continue; }
    const after = footStat(withPlan, trial.area), st = states.get(r.use.id);
    lines.push(`Used tool "${p.name}" once ${p.brush.stroke ? `as a drag from (${trial.area.path[0]}) to (${trial.area.path[1]}), width ${p.brush.stroke}` : `at (${at[0]},${at[1]}), radius ${p.brush.circle}`}: ` +
      (p.edits.length ? `its edits changed ${r.changed} tiles; ` : "") +
      `over ${seconds} s the ground there went ${fmt(before.h)} → ${fmt(after.h)} m on average, wet tiles ${before.wet} → ${after.wet} of ${after.tiles}, ` +
      `water ${fmt(before.water)} → ${fmt(after.water)} m³. Now: ${st ? st.text : "done"}. That is one use at one place; elsewhere it may differ` +
      (p.threads.length && !p.threads.some((t) => t.when.some((c) => "within" in c)) ? "; each use keeps acting until undone or switched off." : "."));
  }
  if (uses.length && !useAt && !spot) lines.push("No spot is selected, so tools were tried at the map centre; pass use_at: [x, y] to try one elsewhere.");
  for (const r of (skein && skein.release) || []) {
    if (r.released < r.count) lines.push(`Only ${r.released} of the ${r.count} ${r.species} released found ground they can stand on in that area (they can't stand on what they avoid, or in water deeper than they wade). Pick an area that suits them.`);
  }
  // Each animal, with the plan and without it: how its needs and its doing changed.
  for (const c of withPlan.creatures || []) {
    const o = (without.creatures || []).find((k) => k.id === c.id);
    const pct = (v) => Math.round(v * 100) + "%";
    const now = c.dead ? `died of ${c.diedOf}` : `thirst ${pct(c.thirst)}, hunger ${pct(c.hunger)}, ${c.state}`;
    const then = !o ? "not there" : o.dead ? `died of ${o.diedOf}` : `thirst ${pct(o.thirst)}, hunger ${pct(o.hunger)}, ${o.state}`;
    lines.push(`Animal ${c.name} (${c.species}) after ${seconds} s: ${now}. Without the plan: ${then}.`);
  }
  const timed = (c) => "within" in c || "after" in c || (c.not && timed(c.not));
  if (clean.threads.length && !clean.threads.some((t) => t.when.some(timed))) {
    lines.push("None of these threads ever stops on its own: they run until the player switches them off. If the whim has an end, add a within condition.");
  }
  for (const id of clean.switch_off) {
    const s = world.skeins.find((k) => k.id === id);
    lines.push(`This plan switches off skein ${id} (${s ? s.name : "?"}). Only do that if the player asked for it to stop.`);
  }
  return { text: lines.join("\n"), stats: { area: { tiles: cells.size, waterWithout: a.water, waterWith: b.water }, mapWet: [a.mapWet, b.mapWet], fires } };
}

function checked(world, plan, spot) {
  const result = WF.checkPlan(world, plan, spot);
  const head = result.problems.length ? "Problems:\n- " + result.problems.join("\n- ") : "The plan checks out.";
  return { ...result, head };
}

/**
 * Run the shaper on a whim. world is a world object (a private copy is used), spot may be null. apiKey, if the
 * model server needs one, is sent only as its Authorization header.
 * onEvent receives {kind, ...} progress events. Returns {outcome, committed, plan, unsupported, explain, say, events, messages, seconds, toolCalls}.
 */
export async function shapeWhim({ world, spot, whim, model, apiKey = "", onEvent = () => {}, signal }) {
  const copy = WF.load(WF.save(world));
  const events = [];
  const emit = (e) => { const ev = { at: Date.now(), ...e }; events.push(ev); onEvent(ev); };
  let pushedBackDecline = false, pushedBackPropose = false, finished = null, toolCalls = 0, confirmedOff = "", lastTried = null, lastCall = "", repeats = 0;

  // commit and propose share every check. The outcome is decided by routeOutcome from the player's request,
  // the plan and the model's message, so a substitute is never committed as if it were the real thing.
  const finishTool = (name, label, description) => ({
    name, label, description,
    parameters: name === "propose" ? Type.Object({ plan: PlanParam, unsupported: UnsupportedParam }) : Type.Object({ plan: PlanParam }),
    execute: async (_id, raw) => {
      const p = unstring(raw);
      // Models sometimes drop name/say/unsupported between preview and commit; carry them over from the last preview.
      const plan = { ...p.plan, unsupported: p.unsupported || (p.plan && p.plan.unsupported) };
      if (lastTried && !plan.say) plan.say = lastTried.say;
      if (lastTried && !plan.name) plan.name = lastTried.name;
      if (lastTried && !plan.unsupported && lastTried.unsupported) plan.unsupported = lastTried.unsupported;
      // A finish call with only name/say/unsupported means "that plan": reuse the last tried plan's contents.
      const PARTS = ["materials", "edits", "threads", "switch_off"];
      const empty = (v) => !v || (Array.isArray(v) && !v.length);
      if (lastTried && PARTS.every((k) => empty(plan[k]))) for (const k of PARTS) if (!empty(lastTried.plan[k])) plan[k] = lastTried.plan[k];
      const c = checked(copy, plan, spot);
      const Nothing = name === "commit" ? "Nothing was committed" : "Nothing was proposed";
      if (!c.usable) {
        throw new Error(PARTS.every((k) => empty(plan[k]))
          ? `${Nothing}: the plan has no materials, edits or threads. Put in the plan itself the edits and threads the player would get (try_plan first if you like).`
          : c.head + `\n${Nothing}: none of the plan's parts could be used.`);
      }
      // say is optional: the player always sees "What it does", generated from the plan. When it's there, it's checked.
      // The "can't do" list is shown too: its entries name missing abilities on purpose, but other claims in them
      // (durations, heights) are checked like say.
      const claims = checkClaims(c.clean.say, c.clean, CAPS, { proposing: name === "propose" })
        .concat(checkClaims((plan.unsupported || []).map(String).join(". "), c.clean, CAPS, { namesMissing: true }));
      if (claims.length) throw new Error(`${Nothing}: your say doesn't match the plan.\n- ` + claims.join("\n- "));
      const route = routeOutcome({ whim, tool: name, unsupported: plan.unsupported, say: c.clean.say, caps: CAPS });
      if (route.outcome === "proposed" && !route.unsupported.length) {
        throw new Error("Nothing was proposed: list in unsupported what part of the whim can't be done, or commit if the whole whim is done.");
      }
      // A proposal is for abilities Glomus lacks. When neither the request nor the message names one, the "can't do"
      // list is usually a description of the plan; ask once for a commit instead.
      if (route.outcome === "proposed" && !pushedBackPropose && !requestNeeds(whim, CAPS).length && !admissions(c.clean.say).length) {
        pushedBackPropose = true;
        throw new Error(`Not proposed yet: nothing in the whim asks for something Glomus can't do, and unsupported (${route.unsupported.map((u) => JSON.stringify(u)).join(", ")}) should only name missing abilities like "double-click" or "days", never what you made. If the whole whim is done, call commit with this plan. If something really is missing, call propose again.`);
      }
      const offKey = c.clean.switch_off.slice().sort().join(",");
      if (route.outcome === "committed" && offKey && offKey !== confirmedOff) {
        confirmedOff = offKey;
        const names = c.clean.switch_off.map((id) => `${id} (${(copy.skeins.find((k) => k.id === id) || {}).name || "?"})`).join(", ");
        throw new Error(`Nothing was committed yet: this plan switches off skein ${names}. Did the player ask for that to stop? If so, commit the same plan again. If not, remove switch_off and commit.`);
      }
      finished = { outcome: route.outcome, clean: c.clean, problems: c.problems, say: c.clean.say, unsupported: route.unsupported };
      emit({ kind: route.outcome, name: c.clean.name, problems: c.problems.length, unsupported: route.unsupported });
      const tail = route.outcome === "committed" ? "Committed."
        : `Recorded as a proposal for the player to approve (${route.reasons.join("; ") || "you proposed it"}). Can't do: ${route.unsupported.join("; ")}.`;
      return { ...text(c.head + "\n" + tail), terminate: true };
    },
  });
  const started = Date.now();

  const tools = [
    {
      name: "look", label: "Look", description: "Heights, water and ground in an area. Areas under 24 tiles across include a tile-by-tile height grid.",
      parameters: Type.Object({ area: AreaParam }),
      execute: async (_id, p) => text(lookAt(copy, unstring(p.area), spot)),
    },
    {
      name: "read_skein", label: "Read skein", description: "The full plan (materials, edits, threads) of an existing skein, by id.",
      parameters: Type.Object({ id: Type.Number() }),
      execute: async (_id, p) => {
        const s = copy.skeins.find((k) => k.id === Math.round(p.id));
        if (!s) throw new Error(`No skein ${p.id}. Skeins: ${copy.skeins.map((k) => k.id).join(", ")}.`);
        return text(JSON.stringify({ id: s.id, name: s.name, on: s.on, materials: s.materials, edits: s.edits, threads: s.threads }));
      },
    },
    {
      name: "try_plan", label: "Try plan", description: `Check a plan and simulate it for ${PREVIEW_SECONDS} seconds on a copy of the world. Nothing real changes.`,
      parameters: Type.Object({ plan: PlanParam, use_at: Type.Optional(Type.Array(Type.Number(), { description: "Where to use the plan's tools once in the preview, [x, y]. Default: the spot." })) }),
      execute: async (_id, raw) => {
        const p = unstring(raw);
        const c = checked(copy, p.plan, spot);
        if (!c.usable) throw new Error(c.head + "\nNothing in the plan could be used.");
        lastTried = { name: c.clean.name, say: c.clean.say, unsupported: p.plan.unsupported, plan: p.plan };
        const useAt = Array.isArray(p.use_at) && p.use_at.length >= 2 && p.use_at.every(Number.isFinite) ? p.use_at.slice(0, 2).map(Math.round) : null;
        const pv = preview(copy, c.clean, spot, PREVIEW_SECONDS, useAt);
        emit({ kind: "tried", name: c.clean.name, summary: pv.text.split("\n").slice(1, 3).join(" "), problems: c.problems.length });
        const claims = c.clean.say ? checkClaims(c.clean.say, c.clean, CAPS) : [];
        const notes = [
          "What the player will read about this plan (generated from it):\n- " + WF.explainPlan(c.clean, copy).join("\n- "),
          claims.length ? "Your say claims things the plan doesn't do; committing it like this will be refused:\n- " + claims.join("\n- ") : "",
        ].filter(Boolean).join("\n");
        return text(c.head + "\n" + pv.text + "\n" + notes, { problems: c.problems, stats: pv.stats });
      },
    },
    finishTool("commit", "Commit", "Apply the plan to the real world. This ends your turn."),
    finishTool("propose", "Propose", "Offer a full plan (threads and edits included) as the closest thing to the whim, and list in unsupported, a few words each, what can't be done. The player approves it or not. This ends your turn."),
    {
      name: "decline", label: "Decline", description: "Nothing reasonable fits the whim: tell the player why, in one or two sentences. This ends your turn.",
      parameters: Type.Object({ say: Type.String() }),
      execute: async (_id, p) => {
        const say = String(p.say || "").trim().slice(0, 400);
        if (!say) throw new Error("Say why, in one or two sentences.");
        // A decline that describes something buildable makes the player ask again; propose it instead (asked once).
        if (!pushedBackDecline && /\b(?:closest|instead|I can (?:make|give|do|build)|what I can do|could (?:make|give|build)|stand-in)\b/i.test(say)) {
          pushedBackDecline = true;
          throw new Error("Not declined yet: you described something you could make. Build it and call propose with it and unsupported, so the player can apply it with one click. If you really can't make it, call decline again.");
        }
        finished = { outcome: "declined", clean: null, problems: [], say, unsupported: [] };
        emit({ kind: "declined", say });
        return { ...text("Declined."), terminate: true };
      },
    },
  ];

  const agent = new Agent({
    initialState: { systemPrompt: LANGUAGE, model, tools },
    getApiKey: async () => apiKey || "local",
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      toolCalls++;
      // Stop a model that is stuck: the same call three times in a row, or far past the budget.
      const key = toolCall.name + JSON.stringify(toolCall.arguments);
      repeats = key === lastCall ? repeats + 1 : 0;
      lastCall = key;
      if (repeats >= 2 || toolCalls > MAX_TOOL_CALLS + 4) {
        emit({ kind: "error", message: repeats >= 2 ? "The model repeated the same failing call; stopping." : "The model used far more than its tool budget; stopping." });
        setTimeout(() => agent.abort(), 0);
        return { block: true, reason: "Stopped." };
      }
      if (toolCalls > MAX_TOOL_CALLS && !["commit", "propose", "decline"].includes(toolCall.name)) {
        return { block: true, reason: `You have used all ${MAX_TOOL_CALLS} tool calls. Commit or propose your best plan now, or decline.` };
      }
      return undefined;
    },
  });
  agent.subscribe((e) => {
    if (e.type === "tool_execution_start") {
      const a = e.args || {};
      const label = e.toolName === "look" ? `looked at ${describeLoose(unstring(a.area))}` : e.toolName === "read_skein" ? `read skein ${a.id}`
        : e.toolName === "try_plan" ? `tried "${(a.plan && a.plan.name) || "a plan"}"` : e.toolName === "commit" ? `committing "${(a.plan && a.plan.name) || "the plan"}"`
        : e.toolName === "propose" ? `proposing "${(a.plan && a.plan.name) || "a plan"}"` : e.toolName === "decline" ? "declining" : e.toolName;
      emit({ kind: "tool", tool: e.toolName, label });
    }
    if (e.type === "tool_execution_end" && e.isError) {
      const msg = (e.result && e.result.content && e.result.content[0] && e.result.content[0].text) || "error";
      emit({ kind: "tool_error", tool: e.toolName, message: msg.slice(0, 300) });
    }
    if (e.type === "message_end" && e.message.role === "assistant") {
      const said = (e.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ").trim();
      if (said) emit({ kind: "said", text: said.slice(0, 500) });
    }
  });
  const timer = setTimeout(() => agent.abort(), TIME_LIMIT_MS);
  const onAbort = () => agent.abort();
  if (signal) signal.addEventListener("abort", onAbort);
  emit({ kind: "start", whim });
  try {
    await agent.prompt("World report:\n" + WF.describe(copy, spot) + "\n\nThe player's whim: " + whim);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  const lastText = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
  const reply = lastText ? (lastText.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ").trim() : "";
  // A server's error text could quote the key back (in errorMessage and in the transcript); scrub it here.
  const scrub = (v) => (apiKey && v != null ? JSON.parse(JSON.stringify(v).split(apiKey).join("[key]")) : v);
  const error = scrub(agent.state.errorMessage || null);
  if (error) emit({ kind: "error", message: String(error).slice(0, 300) });
  const outcome = finished ? finished.outcome : reply && !error ? "answered" : "failed";
  const plan = finished ? finished.clean : null;
  return {
    outcome, committed: outcome === "committed", plan, problems: finished ? finished.problems : [],
    unsupported: finished ? finished.unsupported : [], explain: plan ? WF.explainPlan(plan, copy) : [],
    say: finished ? finished.say || reply : reply, error, events, messages: scrub(agent.state.messages),
    seconds: (Date.now() - started) / 1000, toolCalls,
  };
}

function describeLoose(area) {
  if (area === "spot" || area === "here") return "the spot";
  if (area === "everywhere") return "the whole map";
  try { return WF.describeArea(area); } catch { return "an area"; }
}
