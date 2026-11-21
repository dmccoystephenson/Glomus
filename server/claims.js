// Honesty checks for whims. Two questions, answered without trusting the model's prose:
//
//   requestNeeds(whim)      What does the player's request ask for that Glomus doesn't have? (double-click, keys,
//                           days, creatures…). Read from the player's words, so a model that quietly substitutes
//                           something else can't skip the approval step.
//   checkClaims(say, plan)  Does the model's message claim something the plan doesn't do? Typed claims (target
//                           height, change, rate, duration, delay, recurrence, ending, future event, input) are
//                           matched to the threads and edits doing the action the clause talks about.
//   routeOutcome(...)       committed, proposed or declined, from the request, the plan and the tool the model used.
//
// Prose these rules don't recognize is simply not checked: the page's "What it does" (explainPlan, built from the
// plan) is the authoritative description, not the model's say.

// What the game can do with player input. Slice 2 turns on click tools; slice 3 drag tools.
export const CAPS = { clickTools: true, dragTools: true };

const norm = (s) => String(s || "").replace(/[’‘]/g, "'").replace(/[“”]/g, '"');

/** Sentences, then clauses. A denial ("can't…") only exempts its own clause. */
export function clauses(text) {
  return norm(text).split(/(?<=[.!?:])\s+|;|\s+[—–]\s+|\s+-\s+|\s+but\s+|,\s*(?:and|so|while|whereas)\s+|\s+while\s+|\s+whereas\s+/i)
    .map((c) => c.trim()).filter(Boolean);
}

const DENY = /\b(can't|cannot|can not|couldn't|isn't (?:possible|supported|something)|aren't (?:possible|supported)|not possible|no way to|doesn't (?:support|have|let)|don't (?:have|support)|unable|unsupported|instead of|not able|there's no|there is no|has no|have no)\b/i;
export const denies = (clause) => DENY.test(norm(clause));

// ---------- the request ----------
const NEEDS = [
  { what: "double-click", re: /\bdouble[- ]?(?:click|tap)/i },
  { what: "right-click", re: /\bright[- ]?click/i },
  { what: "middle-click", re: /\bmiddle[- ]?click/i },
  { what: "a key binding", re: /\b(?:key ?board|hot ?keys?|shortcut|space ?bar|shift[- ]click|ctrl[- ]click|alt[- ]click)\b|\b(?:[a-z0-9]|shift|ctrl|control|alt|space|enter|return|escape|esc|tab|f\d{1,2})\s+(?:key|button)\b|\bkeys?\b|\bpress(?:es|ing)?\s+(?:the\s+)?["']?[a-z0-9]["']?(?![\w])/i },
  { what: "holding the mouse button", re: /\b(?:click|press)[- ]and[- ]hold\b|\bhold(?:ing)?\s+(?:down\s+)?(?:the\s+)?(?:mouse|button|click)\b|\blong[- ]press/i },
  { what: "the scroll wheel", re: /\bscroll(?:ing)?\b|\bmouse ?wheel\b/i },
  { what: "following the mouse pointer", re: /\bhover(?:ing)?\b|\bmouse ?over\b|\b(?:under|follows?|following|beneath)\s+(?:my|the)\s+(?:mouse|cursor|pointer)\b|\bwhere(?:ver)?\s+(?:my|the)\s+(?:mouse|cursor|pointer)\b/i },
  { what: "clicking on the map", re: /\b(?:click|clicks|clicking|clicked|tap|taps|tapping)\b/i, unless: "clickTools" },
  { what: "dragging on the map", re: /\b(?:drag|drags|dragging|dragged|swipe)\b/i, unless: "dragTools" },
  { what: "days and hours (the world only has game seconds and minutes)", re: /\b(?:\d+|a|an|one|two|three|few|several|many)?\s*(?:days?|hours?|weeks?|months?|years?)\b|\bovernight\b|\btomorrow\b|\breal[- ]time\b/i },
  { what: "sounds", re: /\b(?:sounds?|music|noise|audio)\b/i },
  // Animals are supported (species and releases); these parts of animal life aren't yet.
  { what: "herds and packs", re: /\b(?:herds?|packs?|flocks?|swarms?|colon(?:y|ies)|troops?)\b/i },
  { what: "breeding", re: /\b(?:breed|breeds|breeding|babies|offspring|young ones|reproduc\w*|mates?|mating|multiply)\b/i },
  { what: "flying", re: /\b(?:fly|flies|flying|flew|soar\w*|wings?|birds?)\b/i },
  { what: "swimming", re: /\b(?:swim\w*|underwater|fish)\b/i },
  { what: "talking or tricks", re: /\b(?:talk\w*|speak\w*|tricks?|sing\w*)\b/i },
  { what: "one animal hunting another", re: /\b(?:hunt\w*|prey|predators?|chase\w*)\b/i },
  { what: "people", re: /\b(?:people|villagers?|humans?|persons?)\b/i },
  { what: "camera, zoom or 3D views", re: /\b(?:camera|zoom|3d|three[- ]dimensional|rotate the (?:map|view)|side view)\b/i },
];
const WHIM_NEGATION = /\b(?:without|don't|do not|no need|not using|instead of)\b/i;

/** What the player's own words ask for that the game can't do. [{what, phrase}] */
export function requestNeeds(whim, caps = CAPS) {
  const found = [];
  for (const c of clauses(whim)) {
    if (WHIM_NEGATION.test(c)) continue;
    for (const n of NEEDS) {
      if (n.unless && caps[n.unless]) continue;
      const m = c.match(n.re);
      if (m && !found.some((f) => f.what === n.what)) found.push({ what: n.what, phrase: m[0].trim() });
    }
  }
  // "Double-click" also contains "click": report it once, as the more specific need.
  if (found.some((f) => f.what === "double-click")) return found.filter((f) => f.what !== "clicking on the map");
  return found;
}

// ---------- the message ----------
// Which actions a clause is talking about, by its verbs.
const EFFECTS = [
  { keys: ["add_water", "water"], re: /\b(?:rain|rains|raining|pour|pours|pouring|flood|floods|flooding|spring|fountain|gush|gushes|spray|drizzle|adds? water|fills? (?:it |up )?with water|wets?)\b/i },
  { keys: ["lower", "level"], re: /\b(?:sink|sinks|sinking|dig|digs|digging|dug|lower|lowers|lowering|carve|carves|carving|sag|sags|subside|subsides|drop|drops)\b/i },
  { keys: ["raise", "level"], re: /\b(?:raise|raises|raising|build|builds|rise|rises|rising|grow a hill|heap|pile|lift|lifts|push(?:es)? up)\b/i },
  { keys: ["set_material", "spread", "material"], re: /\b(?:burn|burns|burning|fire|fires|flames?|blaze|spread|spreads|spreading|creep|creeps|grow|grows|growing|paint|paints|turns? (?:in)?to|becomes?|covers? (?:it )?(?:in|with)|moss|meadow)\b/i },
  { keys: ["drain_water"], re: /\b(?:dry|dries|drying|drain|drains|draining|soak(?:s)? up|evaporate|evaporates)\b/i },
  { keys: ["push_water"], re: /\b(?:push|pushes|pump|pumps|pumping|current|currents|blow|blows)\b/i },
];
// "Fades back", "turns back" and "returns" name a later change, not an end: they're future events.
const BACK = /\b(?:fades?|fading|turns?|turning|goes?|going|changes?|changing|reverts?|reverting|returns?|returning|grows?|growing|comes?|coming|cools?|cooling)\s+back\b|\breverts?\b/i;
const ENDING = /\b(?:stops?|stopping|stopped|ends?|ending|burns? (?:itself )?out|dies? (?:down|out|away)|fades?(?! back)|fading(?! back)|runs? out|wears? off|goes? out|switch(?:es)? (?:itself )?off|finish(?:es)?|is over)\b/i;
const FUTURE = /\b(?:regrows?|regrowing|recovers?|after a while|later on|in a while|return(?:s)? later)\b/i;
const INPUT_CLICK = /\b(?:click|clicks|clicking|tap|taps|tapping)\b(?!\s+["']?apply)/i;
const INPUT_DRAG = /\b(?:drag|drags|dragging|swipe)\b/i;
const INPUT_BAD = /\bdouble[- ]?(?:click|tap)|\bright[- ]?click|\bkey ?board\b|\b(?:[a-z0-9]|shift|ctrl|space|enter)\s+key\b|\bpress(?:es|ing)?\s+(?:the\s+)?["']?[a-z0-9]["']?(?![\w])|\bhover|\bscroll|\bmouse ?wheel/i;
const WEATHER_QUALIFIED = /\b(?:when|while|whenever|during|if|once|only)\b[^.]{0,30}\b(?:rain|rains|raining|rainy|storm|storms|dry|weather)\b/i;
// Nothing in a plan moves with the player: areas are fixed when the whim lands.
const FOLLOWS = /\b(?:follows?|following|moves? with|tracks?|wherever)\b[^.]{0,40}\b(?:you|your|selection|selected|spot you pick|mouse|cursor|pointer)\b/i;
const LONG_TIME = /\b(?:\d+|a|an|one|two|three|few|several)\s+(?:days?|hours?|weeks?|months?|years?)\b|\bovernight\b/i;

const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, "half a": 0.5, "a half": 0.5 };
const near = (v, target, rel, abs) => Math.abs(v - target) <= Math.max(abs, Math.abs(target) * rel);

/** Every action, condition and edit the plan has, with what each thread does. */
function effectsOf(plan) {
  // A tool's edits and threads count like the plan's own: "each click sinks the ground to 6 m" is about them.
  const allThreads = (plan.threads || []).concat(...(plan.powers || []).map((p) => p.threads || []));
  const allEdits = (plan.edits || []).concat(...(plan.powers || []).map((p) => p.edits || []));
  const threads = allThreads.map((t) => ({ t, keys: new Set(t.do.flatMap((a) => Object.keys(a))) }));
  const edits = allEdits.map((e) => ({ e, keys: new Set(Object.keys(e).filter((k) => k !== "area").map((k) => (k === "water" ? "water" : k))) }));
  return { threads, edits };
}

function matchEffects(clause, fx) {
  const keys = new Set();
  for (const e of EFFECTS) if (e.re.test(clause)) for (const k of e.keys) keys.add(k);
  if (!keys.size) return { threads: fx.threads, edits: fx.edits, keys: null };
  return {
    threads: fx.threads.filter((x) => [...x.keys].some((k) => keys.has(k))),
    edits: fx.edits.filter((x) => [...x.keys].some((k) => keys.has(k))),
    keys,
  };
}

const cond = (t, k) => t.when.find((c) => k in c);
const heightBound = (t, dir) => t.when.find((c) => c.height && (dir === "down" ? c.height[0].includes(">") : c.height[0].includes("<")));

/** Seconds named in a clause: [{n, kind: "duration"|"delay"|"recurrence"|null, text}] */
function timesIn(clause, ending) {
  const out = [];
  const re = /(\d+(?:\.\d+)?|half a|a half|an?|one|two|three|four|five|ten)[\s-]*(seconds?|secs?|s|minutes?|mins?)\b/gi;
  let m;
  while ((m = re.exec(clause))) {
    const raw = m[1].toLowerCase(), n0 = WORD_NUM[raw] ?? Number(raw);
    if (!Number.isFinite(n0)) continue;
    const n = /^m/i.test(m[2]) ? n0 * 60 : n0;
    const before = clause.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = clause.slice(m.index + m[0].length, m.index + m[0].length + 12).toLowerCase();
    let kind = null;
    if (/\bevery\s*(?:other\s*)?$/.test(before) || /^\s*(?:cycles?|intervals?|pulses?|periods?)\b/.test(after)) kind = "recurrence";
    // "stops after 30 seconds" names an ending: the effect lasts 30 s. Only a start is a delay.
    else if (ending && /\b(?:after|in|within|once)\s*(?:about|around|roughly)?\s*$/.test(before)) kind = "duration";
    else if (/\b(?:for|lasts?|lasting|runs? for|burns? for|rages? for)\s*(?:about|around|roughly|another|the next|just)?\s*$/.test(before) || /^\s*long\b/.test(after) || /\d-(?:second|minute)/.test(m[0])) kind = "duration";
    else if (/\b(?:after|in|starting in|starts in|wait)\s*(?:about|around|roughly)?\s*$/.test(before) || /^\s*later\b/.test(after)) kind = "delay";
    out.push({ n, kind, text: m[0] });
  }
  return out;
}

/** Metres named in a clause: [{n, kind: "target"|"delta"|"rate"|"water"|null, text}] */
function metresIn(clause) {
  const out = [];
  const re = /(\d+(?:\.\d+)?|half a|a half)\s*(?:m|metres?|meters?)(?![a-z²³])/gi;
  let m;
  while ((m = re.exec(clause))) {
    const raw = m[1].toLowerCase(), n = WORD_NUM[raw] ?? Number(raw);
    if (!Number.isFinite(n)) continue;
    const before = clause.slice(Math.max(0, m.index - 28), m.index).toLowerCase();
    const after = clause.slice(m.index + m[0].length, m.index + m[0].length + 16).toLowerCase();
    let kind = null;
    if (/^\s*(?:\/\s*s\b|per sec|a sec|each sec|every sec)/.test(after)) kind = "rate";
    else if (/^\s*(?:of\s+)?water\b/.test(after) || /^\s*deep of water/.test(after)) kind = "water";
    else if (/\b(?:to|until|till|at|reach(?:es)?|reaching|down to|up to|holds?(?: it)? at|stops? at|level of|height of)\s*(?:about|around|roughly|~|approximately|just under|just over)?\s*$/.test(before)) kind = "target";
    else if (/^\s*(?:deep|high|tall|higher|lower|down|up|deeper|taller)\b/.test(after) || /\b(?:by|raises?(?: it| the ground)?|lowers?(?: it| the ground)?|digs?(?: it)?|sinks?(?: it)?)\s*(?:about|around|roughly)?\s*$/.test(before)) kind = "delta";
    out.push({ n, kind, text: m[0] });
  }
  return out;
}

/**
 * Claims in the model's message that the plan doesn't back up. Returns problems, each naming the clause, the claim
 * and what to change. Clauses that deny an ability are skipped; prose with no recognized claim isn't checked.
 */
export function checkClaims(say, plan, caps = CAPS, { namesMissing = false, proposing = false } = {}) {
  const problems = [];
  const fx = effectsOf(plan || {});
  const powers = (plan && plan.powers) || [];
  const lingering = fx.threads.length > 0;
  for (const clause of clauses(say)) {
    if (denies(clause)) continue;
    const quote = `"${clause.length > 90 ? clause.slice(0, 87) + "…" : clause}"`;
    const fail = (claim, need) => problems.push(`${quote} claims ${claim}, but ${need}. Change the plan so it does this, or change what you tell the player.`);
    const scope = matchEffects(clause, fx);
    const what = scope.keys ? "the threads doing that" : "the plan's threads";

    // Inputs the game doesn't have, said as if they work. A "can't do" entry (namesMissing) names them on purpose.
    const missingHint = proposing ? "Glomus has no such input. Leave it out of say (it's already in unsupported) and describe what the plan does" : "Glomus has no such input. Use propose and list it in unsupported";
    const bad = !namesMissing && clause.match(INPUT_BAD);
    if (bad) fail(`"${bad[0]}" works`, missingHint);
    else if (!namesMissing) {
      if (INPUT_CLICK.test(clause) && !(caps.clickTools && powers.length)) fail("the player can click to trigger it", caps.clickTools ? "the plan has no tool" : "clicking only picks spots in Glomus. Use propose and list it in unsupported");
      if (INPUT_DRAG.test(clause) && !(caps.dragTools && powers.some((p) => p.brush && p.brush.stroke))) fail("the player can drag to use it", "the plan has no drag tool");
    }
    // A thread that waits for the weather doesn't do what a clause says it does unconditionally: "click and it rains
    // there" with {"raining": true} only rains while it's already raining.
    // A tool's or species' name isn't a claim ("a new Rain cloud replaces yours"), and a weather qualifier anywhere in
    // the message counts ("It only acts when the weather is raining: your Rain cloud adds water…").
    const named = (powers.map((p) => p.name).concat(((plan && plan.species) || []).map((sp) => sp.name)))
      .reduce((t, n) => t.split(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig")).join(" "), clause);
    const weatherScope = matchEffects(named, fx);
    if (!namesMissing && weatherScope.keys && !WEATHER_QUALIFIED.test(norm(say))) {
      const weather = weatherScope.threads.find((x) => x.t.when.some((c) => "raining" in c || (c.not && "raining" in c.not)));
      if (weather) {
        const wet = weather.t.when.some((c) => c.raining === true || (c.not && c.not.raining === false));
        // Models tend to reword the message instead of fixing the plan, so hand them the corrected list to copy.
        const fixed = weather.t.when.filter((c) => !("raining" in c) && !(c.not && "raining" in c.not));
        fail(`"${weather.t.name}" acts whenever this happens`, `that thread has the condition {"raining": ${wet}}, so it only acts ${wet ? "while the weather is raining" : "while the weather is dry"}. ` +
          `Rewording won't fix this: change the plan, giving thread "${weather.t.name}" "when": ${JSON.stringify(fixed)}. Or keep the condition and say it only happens ${wet ? "when it rains" : "in dry weather"}`);
      }
    }
    const follows = !namesMissing && clause.match(FOLLOWS);
    if (follows) fail(`it moves with the player ("${follows[0]}")`, "every area in a plan is fixed where it lands; nothing follows the spot or the mouse");
    const long = !namesMissing && clause.match(LONG_TIME);
    if (long) fail(`a span of "${long[0]}"`, "the world has no days or hours. Say the span in seconds or minutes that the plan uses, and use propose with \"days\" in unsupported");

    const back = BACK.test(clause);
    const ending = !back && ENDING.test(clause);
    const times = timesIn(clause, ending);
    // "for 10 seconds every 30 seconds" is one claim: a 10-second window of a 30-second cycle, not a 10-second life.
    // So is "a 10-second burst each cycle" when the plan's cycle is the one the thread has.
    const every = times.filter((tm) => tm.kind === "recurrence").map((tm) => tm.n);
    const eachCycle = /\b(?:each|every|per|a)\s+cycle\b/i.test(clause);
    const window = (x, n) => { const c = cond(x.t, "cycle"); return !!c && (eachCycle || every.some((m) => near(c.cycle, m, 0.15, 2))) && near((c.to ?? c.cycle) - (c.from ?? 0), n, 0.15, 2); };
    // Name the thread that breaks a claim and the condition list that would back it, so one call can fix it.
    const fixWhen = (x, add) => `give thread "${x.t.name}" "when": ${JSON.stringify(x.t.when.filter((c) => !Object.keys(add).some((k) => k in c)).concat([add]))}`;
    for (const tm of times) {
      if (tm.kind === "duration") {
        if (!scope.threads.length) fail(`something lasts ${tm.text}`, "nothing in the plan keeps acting, so nothing has a duration");
        else {
          const off = scope.threads.find((x) => !((cond(x.t, "within") && near(cond(x.t, "within").within, tm.n, 0.15, 2)) || window(x, tm.n)));
          if (off) {
            const add = every.length || eachCycle ? { cycle: every[0] || (cond(off.t, "cycle") || {}).cycle || 30, from: 0, to: tm.n } : { within: tm.n };
            fail(`it lasts ${tm.text}`, `thread "${off.t.name}" doesn't stop after ${tm.text}${every.length || eachCycle ? " of each cycle" : ""}. Either ${fixWhen(off, add)}, or remove that thread, or say what it does instead`);
          }
        }
      } else if (tm.kind === "delay") {
        if (!scope.threads.some((x) => cond(x.t, "after") && near(cond(x.t, "after").after, tm.n, 0.15, 2))) fail(`it starts after ${tm.text}`, `none of ${what} has {"after": ${tm.n}}`);
      } else if (tm.kind === "recurrence") {
        // A thread that ends (within) before its second cycle never repeats.
        const repeats = (x) => cond(x.t, "cycle") && near(cond(x.t, "cycle").cycle, tm.n, 0.15, 2) && !(cond(x.t, "within") && cond(x.t, "within").within <= cond(x.t, "cycle").cycle);
        if (!scope.threads.some(repeats)) fail(`it repeats every ${tm.text}`, scope.threads.some((x) => cond(x.t, "cycle") && cond(x.t, "within"))
          ? `the threads with {"cycle": ${tm.n}} also have a within that ends them before the cycle comes round again; drop the within`
          : `none of ${what} has {"cycle": ${tm.n}}`);
      }
    }
    for (const mt of metresIn(clause)) {
      const lowering = scope.threads.filter((x) => x.keys.has("lower")), raising = scope.threads.filter((x) => x.keys.has("raise"));
      if (mt.kind === "target") {
        const byThread = lowering.some((x) => { const h = heightBound(x.t, "down"); return h && near(h.height[1], mt.n, 0, 0.5); })
          || raising.some((x) => { const h = heightBound(x.t, "up"); return h && near(h.height[1], mt.n, 0, 0.5); });
        const byEdit = fx.edits.some((x) => x.e.level !== undefined && near(x.e.level, mt.n, 0, 0.5));
        if (!byThread && !byEdit) fail(`the ground ends up at ${mt.text}`, `no lowering thread has {"height": [">", ${mt.n}]} (or raising thread {"height": ["<", ${mt.n}]}), and no edit levels to ${mt.n}`);
      } else if (mt.kind === "delta") {
        if (!scope.edits.concat(fx.edits).some((x) => ["lower", "raise"].some((k) => x.e[k] !== undefined && near(x.e[k], mt.n, 0.2, 0.25)))) fail(`a change of ${mt.text}`, `no edit raises or lowers by ${mt.n}`);
      } else if (mt.kind === "rate") {
        if (!scope.threads.some((x) => x.t.do.some((a) => Object.values(a).some((v) => typeof v === "number" && near(v, mt.n, 0.2, 0.02))))) fail(`a rate of ${mt.text} per second`, `no thread acts at ${mt.n} per second`);
      } else if (mt.kind === "water") {
        if (!fx.edits.some((x) => x.e.water !== undefined && near(x.e.water, mt.n, 0.2, 0.1))) fail(`${mt.text} of water`, `no edit pours ${mt.n} m of water`);
      }
    }
    if (ending && lingering) {
      const ends = (x) => cond(x.t, "within") || (x.keys.has("lower") && heightBound(x.t, "down")) || (x.keys.has("raise") && heightBound(x.t, "up"));
      const open = scope.threads.filter((x) => !ends(x));
      if (open.length) fail("it stops or ends", `"${open[0].t.name}" never stops: give it {"within": seconds}${open[0].keys.has("lower") || open[0].keys.has("raise") ? " or a height limit" : ""}`);
    }
    const fut = clause.match(FUTURE) || clause.match(BACK);
    if (fut) {
      if (!scope.threads.some((x) => cond(x.t, "after") || cond(x.t, "cycle"))) fail(`something happens later ("${fut[0]}")`, `none of ${what} has an {"after": seconds} or cycle condition, so nothing in the plan happens later`);
    }
  }
  return problems;
}

/** Clauses where the message admits it couldn't do part of the whim. */
// An admission that the game lacks something has the game or the model as its subject ("I can't bind keys",
// "Glomus has no double-click", "there's no way to…"). "The lizard can't climb" describes an animal, and "2 m instead
// of 1 m" is a comparison: neither should turn a commit into a proposal.
const ADMIT = new RegExp([
  String.raw`\b(?:I|I'm|we|Glomus|the game|the world|this world)\b[^.;]{0,40}\b(?:can't|cannot|can not|couldn't|isn't able|am not able|unable|don't have|doesn't have|has no|have no|doesn't support|don't support|can only)\b`,
  String.raw`\bthere(?:'s| is| are)\s+no\b(?:\s+\w+){0,3}\s+(?:in Glomus|in the game|here)\b`,
  String.raw`\b(?:no way to|isn't possible|not possible|aren't possible|isn't supported|not supported|unsupported)\b`,
].join("|"), "i");
export const admits = (clause) => ADMIT.test(norm(clause));

export function admissions(say) {
  return clauses(say).filter(admits);
}

/**
 * Decide the outcome. tool is "commit", "propose" or "decline". A commit becomes a proposal when the request asks for
 * something the game doesn't have, when the model lists anything as unsupported, or when its message admits a gap:
 * the player sees and approves every substitute before it applies.
 */
export function routeOutcome({ whim, tool, unsupported = [], say = "", caps = CAPS }) {
  if (tool === "decline") return { outcome: "declined", unsupported: [] };
  const needs = requestNeeds(whim, caps);
  const listed = (unsupported || []).map((u) => String(u).trim().slice(0, 140)).filter(Boolean).slice(0, 4);
  const admitted = admissions(say);
  const merged = [...listed];
  for (const n of needs) {
    const word = n.what.replace(/^(?:a|the)\s+/, "").split(/[\s(]/)[0].toLowerCase();
    if (!merged.some((u) => u.toLowerCase().includes(word))) merged.push(n.what);
  }
  if (!merged.length && admitted.length) merged.push(admitted[0].replace(/[.!]$/, ""));
  const reasons = [];
  if (needs.length) reasons.push("the whim asks for " + needs.map((n) => `${n.what} ("${n.phrase}")`).join(", "));
  if (listed.length) reasons.push("you listed unsupported parts");
  if (admitted.length) reasons.push("your message says part of it can't be done");
  if (tool === "propose" || reasons.length) return { outcome: "proposed", unsupported: merged, reasons };
  return { outcome: "committed", unsupported: [], reasons };
}
