// Helpers for docs/media/media.json, the darkroom shot list for the README's images. darkroom runs this in
// the page before Glomus's own scripts; the shots call window.__shoot from their "js" steps.
//
// The skeins below are plans in the format the model writes (server/shaper.js), applied the way the page's
// "Write a plan by hand" box applies them, so the images can be made again without a model.
(() => {
  const PLANS = {
    stream: {
      name: "A stream to the pool",
      say: "A channel runs from here down the slope into the pool, fed by a small spring at its head.",
      edits: [{ area: { path: [[78, 18], [74, 24], [70, 29], [66, 34], [61, 40]], width: 2 }, lower: 2 }],
      threads: [{ name: "Spring at the head", area: { circle: [78, 18, 1] }, when: [], do: [{ add_water: 2 }] }],
    },
    glowmoss: {
      name: "Glowing moss",
      say: "Moss that glows creeps over the meadow along the water's edge.",
      materials: [{ name: "glowing moss", color: "#7fffb0", erodes: 0.2 }],
      threads: [{ name: "Moss creeps", area: "everywhere",
        when: [{ material: ["meadow"] }, { near: "water", count: [">=", 2] }, { chance: 0.15 }],
        do: [{ set_material: "glowing moss" }] }],
    },
    floodgate: {
      name: "Floodgate",
      say: "A gate here opens for 10 seconds every 30 seconds and lets a burst of water down the stream.",
      threads: [{ name: "The gate opens", area: { circle: [78, 18, 2] }, when: [{ cycle: 30, from: 0, to: 10 }], do: [{ add_water: 3 }] }],
    },
    lizards: {
      name: "Sand lizards",
      say: "A few little orange lizards that bask on the warm sand by the pool.",
      species: [{ name: "sand lizard", look: { color: "#e8803a", pattern: "ring" }, eats: ["sand"], avoids: ["meadow"],
        wades: 0.1, climbs: 2, speed: 1.2, thirst: 600, hunger: 600 }],
      release: [{ species: "sand lizard", area: { circle: [67, 47, 3] }, count: 4, names: ["Ember", "Flint", "Saffron", "Dune"] }],
    },
    tools: {
      name: "Three tools",
      say: "A rain cloud to drop anywhere, a hill where you click and a channel where you drag.",
      powers: [
        { name: "Rain cloud", icon: "🌧️", brush: { circle: 4 }, threads: [{ name: "Rain", when: [{ within: 10 }], do: [{ add_water: 0.4 }] }] },
        { name: "Hill", icon: "⛰️", brush: { circle: 3 }, edits: [{ raise: 2 }] },
        { name: "Channel", icon: "⛏️", brush: { stroke: 2 }, edits: [{ lower: 1.5 }] },
      ],
    },
  };
  const $ = (id) => document.getElementById(id);
  let WF = null;
  const shoot = {
    PLANS,
    world: () => window.__glomusWorld(),
    async wf() { return WF || (WF = await import(new URL("world.js", location.href).href)); },
    /** Runs the world on by n ticks (10 a second) at once. */
    async advance(n) { const wf = await this.wf(), w = this.world(); for (let i = 0; i < n; i++) wf.step(w); },
    /** Applies a plan from PLANS (or a plan object) with the page's hand-written plan box; whim labels its card. */
    plan(p, whim) {
      $("planText").value = JSON.stringify(typeof p === "string" ? PLANS[p] : p);
      $("applyPlan").click();
      const skeins = this.world().skeins, skein = skeins[skeins.length - 1];
      if (whim) {
        skein.whim = whim;
        for (const el of document.querySelectorAll("#skeins .card .whim")) if (el.textContent.includes("(written by hand)")) el.textContent = "“" + whim + "”";
      }
      $("planNote").textContent = "";
      return skein.id;
    },
    /** The world most shots start from: seed 7 after two minutes, with a stream, glowing moss and lizards. */
    async rich() {
      await this.advance(1200);
      this.plan("stream", "Carve a stream from here into the lake");
      this.plan("glowmoss", "Let glowing moss creep along the banks");
      this.plan("lizards", "A few little orange lizards that bask on the warm sand here");
      await this.advance(500);
    },
    /** Picks a tool in the palette by name ("Spot" for the spot). */
    pick(name) { [...document.querySelectorAll("#palette .tool")].find((b) => b.textContent.includes(name)).click(); },
    /** Sets the spot size with the palette's buttons. */
    size(r) { for (let k = 0; k < 40 && Number($("sizeVal").textContent) !== r; k++) $(Number($("sizeVal").textContent) < r ? "sizeUp" : "sizeDown").click(); },
    /** Points the 3D camera at tile (x, y). */
    cam(o) {
      const c = window.__strataKit.cam, v = o.at ? this.world() : null;
      if (o.at) { c.tx = o.at[0] - 47.5; c.tz = o.at[1] - 31.5; c.ty = v.height[Math.round(o.at[1]) * 96 + Math.round(o.at[0])]; }
      for (const k of ["yaw", "pitch", "dist"]) if (k in o) c[k] = o[k];
    },
    /** The sun: "day" pins an afternoon sun, "clock" follows the world's clock. */
    sun(mode) { try { localStorage.setItem("glomus.3d.daylight", mode); } catch (e) { /* not kept */ } },
  };
  window.__shoot = shoot;
})();
