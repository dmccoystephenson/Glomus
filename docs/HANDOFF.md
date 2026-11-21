# Glomus handoff

Updated: November 17, 2026. Read this first, then [PLAYTEST_FEEDBACK.md](../PLAYTEST_FEEDBACK.md).

## Session of Nov 18: animals (steps 1–2 of [CREATURES.md](CREATURES.md))

- **Mossback.** Every new world has Mossback, a built-in grazer, in a "Wildlife (built in)" skein (skein 2). Whim
  skeins now start at 3. It's written in the same species format whims use.
- **Behaviour.** Animals drink, eat (meadow becomes soil), flee, search and die on their own. They use their own
  random stream (`crng`), and saves, rewind and erase all carry them.
- **Whims.** They can define `species` and `release` animals. Routing still refuses herds, breeding, flying,
  swimming, hunting and people.
- **Page.** Animals panel with both scores, glyphs on the map, hovering an animal or its row, a legend, and
  "Release another grazer".
- **Tests.** `npm test`: 77, written test-first for animals. New eval cases `thirsty-animal` (calibrated: unhelped,
  it's at 15% and still searching at 30 s) and `invent-species`.
- **Not committed yet.** This and the palette move, README and demo-recorder fixes.

## Session of Nov 17 (evening): tools and honest whims

Built per [POWERS.md](POWERS.md), revised after Codex's review ([POWERS_REVIEW.md](POWERS_REVIEW.md)). Not committed.

- **Priority 1 below is addressed structurally.**
  - A whim ends as commit, propose (Apply / No thanks) or decline. That's decided from the player's request
    (`server/claims.js`), not from the model's prose.
  - The model's message is checked clause by clause against the plan.
  - Every card leads with a "What it does" description generated from the plan (`explainPlan`).
- **Priority 4 is built: tools ("powers").**
  - A palette above the map holds Spot and a shared size control, plus Undo use (Ctrl+Z).
  - Then come the player's tools: click tools and drag tools, on keys 1–9, with Escape back to Spot.
  - Each use has its own clock, rules that follow what it spread, a visible state, and a 24-live-use cap.
  - Tools can replace older ones, and Remove / Put back works from the card.
- **Erase and undo now subtract each skein's recorded height changes** instead of restoring old heights. This fixes
  the erase bugs for ordinary whims too: overlapping raises, and ground lowered by threads.
- **Evals.**
  - Baseline: 9/10 cases, 24/27 checks, 25.8 s per whim.
  - Last run: 14/15 cases, 52/53 checks, 22.8 s per whim.
  - New cases: `double-click-sink`, `key-binding`, `rain-cloud-tool`, `channel-tool`, `replace-tool`.
  - Remaining miss: `wildfire` sometimes has no time limit. Its message admits that, so it's a model choice.
  - `npm test` runs 57 checks (world plus claims fixtures) with no model involved.
- **Known gaps.**
  - Reloading `?seed=` loses tools.
  - Undo doesn't take back water.
  - Claims about existing tools ("twice the previous 3 m") aren't checked.
  - Brush gaps (`fill`, `downhill`, buttons) stay proposals.

## Priority: Jon's playtest feedback

Jon played three whims with Codex observing; the full write-up is [PLAYTEST_FEEDBACK.md](../PLAYTEST_FEEDBACK.md),
and the three saved cases are in `workspace/whims/` (`…dfba7e70.json`, `…407ee5a4.json`, `…d3ae4fe7.json`).
Work on these before anything else, in this order.

### 1. The model claims behavior its plan doesn't have (highest priority)

Jon asked: *"Make it so when I left double-click, water replaces the land, by lowering the land or whatever
mechanism for that area that works."* The model said *"When you left double-click here, the ground slowly
sinks to about 6 m"* and committed one thread: `lower 0.25/s` on a fixed circle, with no conditions. So:

- **No double-click trigger exists.** The thread language has no input events, and the map's pointer handlers
  only select spots. The thread started sinking the ground immediately.
- **No stop at 6 m.** The empty `when` list means it lowers until the terrain floor or until switched off.

This is the same failure as the earlier wildfire ("for 2 days", "Nature will regrow it") and the prompt rule
added for it ("In say, describe only what your plan actually does") did not prevent it. Prompt rules alone are
not enough; the fix needs to be structural. Acceptance criteria from the feedback:

- A request for an unsupported mouse action does not commit a substitute while claiming success.
- Any claimed stopping depth, duration, trigger or future event is represented in the committed plan.
- A supported alternative is described explicitly, including how it differs, before it is applied.
- Add this exact double-click whim as an eval case that checks the plan **and** the explanation; a successful
  commit alone is not a pass.

Directions worth trying (not yet decided):

- **Make "can't do that" a first-class outcome.** Give the shaper an explicit way to decline or to propose an
  alternative (for example a `decline`/`propose` tool, or `commit` taking `{plan, unsupported: [...]}`), and
  have the page show "Here's what I can do instead: … Apply?" rather than committing silently.
- **Generate the factual part of the explanation from the plan, not the model.** `try_plan` already produces a
  plan summary for the model; derive a player-facing "what this does" line from the clean plan (area, rate,
  whether it ever stops, what triggers it) and show it next to the model's `say`, so a mismatch is visible.
- **Check claims against the plan at commit.** A cheap check: if `say` mentions a depth/height, a duration, a
  trigger word (click, press, when I…), or "stops/ends", require a matching condition (`height`, `within`,
  `after`) or reject with a specific message. It's heuristic, so pair it with the eval case.
- An `{"height": [">", 6]}` condition on the sinking thread is exactly what "stop at 6 m" needs; the language
  already supports it. The model just didn't use it.

### 2. Make consequences and scope readable without JSON

Jon opened "Show its plan" to understand a whim. Players should be able to see what a skein does, where, and
whether it's still acting, without reading JSON:

- Highlight a skein's actual areas on the map (hovering a skein card already outlines them; make it
  discoverable and show it right after a whim lands).
- Distinguish one-off edits from ongoing threads in the card ("dug a pond once" vs "keeps lowering 0.25 m/s
  here, forever").
- A "why is this happening here?" inspector: click a tile, list the threads acting on it and which skein they
  belong to.

### 3. Terrain shaping looks mechanical

"Expand the water to the right" produced a 30×12 rectangle leveled to 15.5 m and filled with water: visible, but
geometric. The preview only checks quantities, so it accepted an awkward shape. Ideas: an organic edit
primitive (blob/noise-edged area, or "flood to a level" that fills only connected low ground), and preview
feedback on shape. Evaluate results after water settles, not only at commit.

### 4. Explore: whims that create tools or powers

Within three whims Jon asked for a reusable mouse interaction. One data point, but worth exploring: named
brushes or powers created by whims, with visible activation controls and scope. This needs input-event design
beyond the current thread language (for example a thread condition like `{"clicked": true}` plus a "power"
the player selects and clicks with).

### Also from the feedback

- Responsiveness: 9–18 s per whim in this session.
- Next playtest: unassisted. Watch for later whims that come from consequences of earlier ones, whether the
  player can explain and stop each rule without JSON, and moments where they rephrase a request.
- Add sequence evals: several whims in a row that must stay understandable and interact as intended.

## Where things stand

- **Repo:** `C:\Source\Glomus`, branch `main`, two commits (`317e8ac`, `16cf8ff`). `PLAYTEST_FEEDBACK.md` and
  this handoff are uncommitted. No remote.
- **Lineage:** the predecessor prototype `C:\Source\Orket-Extensions\Whimfield` (Python + Orket, one-shot JSON)
  is frozen at `3c81a50` for reference. Glomus replaced Orket with a Pi agent harness by Jon's decision.
- **Evals (last full run):** 9/10 cases, 26/27 checks, 22 s and 3.1 tool calls per whim. The miss was the
  floodgate's water amount (+0.5 m³ vs a 2 m³ bar), which is borderline and passed on the previous run.
- **Demo package:** `demo/out/Glomus-demo.zip` (not in git): an 88 s narrated demo and a 45 s stop-motion
  tilt-shift timelapse, both voiced by Kokoro's Sky (`af_sky`), plus a poster and the blurb.

## How to run

- `npm start` or **Play Glomus.vbs** serves http://127.0.0.1:8840/ and starts the model if nothing answers on
  port 8080. `?seed=7` gives a fresh, repeatable world in its own save slot.
- Model: `config/model.json` launches llama.cpp b11146 with Qwen3.8-27B Q4_K_L under the alias
  `glomus-qwen3.8-27b`, with `--jinja` (the model's own chat template, needed for tool calls) and
  `--reasoning off`. Paperclips uses the same GGUF with a different template and alias; don't share a server.
- `npm test` (18 world checks), `npm run eval [-- --only id --repeat n]`, `npm run record-demo`,
  `npm run record-timelapse`, `npm run voice-over`.
- **Restart the server after changing `server/*.js` or `game/world.js`;** Node doesn't reload. (This bit us
  mid-playtest: the old harness was still live.) The page token now persists in `workspace/token.txt`, so open
  pages survive restarts.

## How it works

- `game/world.js`: the whole world as an ES module with no DOM. 96×64 tiles of height, water, silt and
  material; water flow, erosion, weather (own random stream), the thread language, `checkPlan` (validate and
  normalize, keep what's usable, list problems), skeins with erase/undo, snapshots, and `describe()` (the
  report the model reads). Nature is skein 1, written in threads.
- `server/shaper.js`: the harness. A Pi agent (`@mariozechner/pi-agent-core` 0.73.1) with four tools: `look`,
  `read_skein`, `try_plan` (check, then simulate 20 s next to an untouched copy and report the differences),
  `commit`. Guards: 8 tool calls (commit exempt, hard stop at 12), a stop when the same call repeats, `name`/`say`
  carried over from the last preview, a second confirming commit before `switch_off`, and preview lines that
  say when no thread ever stops. The `LANGUAGE` prompt is the thread language's reference.
- `server/server.js`: local HTTP server, whim jobs the page polls, and a replayable case per whim in
  `workspace/whims/`. `server/model-server/` finds or launches the model server (ports and adapters; see the README).
- `game/index.html`: map rendering (shallow water faint, flow glints), spot picking, the whim queue with live
  steps, skein cards (switch off, erase, show plan), rewind, rain and speed controls.
- `tools/eval.js` + `evals/cases.json`: whims on seed 7, applied and simulated 30 s next to a copy without the
  plan. Check types: committed, not_committed, says, more/less_water, higher/lower, more_wet_tiles,
  thread_acts, intermittent, new_material_grows, uses, uses_condition, no_switch_off, keeps.

## Known issues and gaps

- The model's `say` can still contradict its plan (priority 1 above).
- Some eval checks are taste calls: `keeps stone ≥ 50%` for "fire everywhere", and the floodgate's 2 m³ bar.
- The `try_plan` preview reports how many tiles a thread's conditions held on, not how many tiles it changed;
  the model has misread this.
- Top-down rendering can't show vertical effects (geysers, falling water); there are no visual effects yet.
- Only water moves. Moving materials (conveyors, avalanches, crawling lava) is the natural next verb for
  "streams and automations".
- Claude-as-judge for evals is planned, not built. Eval runs save every plan and transcript for it.
- Decision (Nov 17): no support for machines without a capable GPU. Daniel's PC (GT 1030) is out of scope;
  don't build CPU-only model paths or remote serving for it.
- The harness's lessons each came from one observed failure. Before adding more prompt rules, prefer structural
  checks plus an eval case, as with priority 1.
