// Walking the 3D view: a visitor's body on the land, seen from behind (third person) or through its eyes
// (first person). The visitor is not part of the simulation: world.js never hears of it, animals don't react,
// and it changes nothing by walking. It only reads the ground (heights and water) to stand on it, and tells the
// page which tile it stands on, so a tool or the spot can be put where it is.
//
//   const walker = createWalker({ WF, world: () => world, onStatus(text) {}, onUseHere(x, y) {} });
//   open3d({ ..., beforeFrame: walker.frame, extraMarks: walker.marks, extraLines: walker.lines, onKey: walker.canvasKey });
//   walker.start(kit, x, y); walker.stop(); walker.toggleView();
//
// Keys while walking: W/S or ↑/↓ forward and back, A/D sideways, Q/E or ←/→ turn, Shift to hurry, C to switch
// the view, R to put the spot or use the picked tool right here. Dragging still turns the view; the wheel zooms
// the third-person camera. On a touch screen the page shows a stick and buttons (see stickPad below).

const WALK = 3.2, HURRY = 6.5, WADE = 1.3;   // metres a second: walking, hurrying, wading
const DEEP = 1.1;      // water deeper than this (m) is too deep for a visitor
const STEP = 0.9;      // the most the ground may rise over 0.5 m of walking (a cliff stops you)
const EYE = 1.6, TURN = 1.9;   // eye height (m); radians a second for Q/E and ←/→
const LINE = 13, ROUND = 2;

/** The surface under a point in tile units, bilinear between tile samples; ground and water separately. */
export function groundAt(WF, world, tx, ty) {
  const { W, H } = WF, h = world.height, w = world.water;
  const x = Math.max(0, Math.min(W - 1.001, tx)), y = Math.max(0, Math.min(H - 1.001, ty));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * W + x0;
  const mix = (a) => (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + W] * (1 - fx) + a[i + W + 1] * fx) * fy;
  const ground = mix(h), water = Math.max(0, mix(w));
  return { ground, water: water > 0.02 ? water : 0 };
}

/** Where a step from (tx, ty) by (dx, dy) tiles ends, and why it stopped if it did. Pure, for tests. */
export function stepFrom(WF, world, tx, ty, dx, dy) {
  const { W, H } = WF;
  const nx = Math.max(0, Math.min(W - 1, tx + dx)), ny = Math.max(0, Math.min(H - 1, ty + dy));
  const here = groundAt(WF, world, tx, ty), there = groundAt(WF, world, nx, ny), run = Math.hypot(nx - tx, ny - ty);
  if (run < 1e-6) return { x: tx, y: ty, stopped: dx || dy ? "edge" : null };
  if (there.water > DEEP) return { x: tx, y: ty, stopped: "deep" };
  if ((there.ground - here.ground) / run > STEP / 0.5) return { x: tx, y: ty, stopped: "cliff" };
  return { x: nx, y: ny, stopped: nx !== tx + dx || ny !== ty + dy ? "edge" : null };
}

export function createWalker({ WF, world, onStatus = () => {}, onUseHere = () => {} }) {
  const { W, H } = WF, ox = -(W - 1) / 2, oz = -(H - 1) / 2;
  const keys = new Set();
  const stick = { x: 0, y: 0 };   // the touch stick: x right, y forward, each -1..1
  let kit = null, on = false, first = false, saved = null;
  let pos = { x: W / 2, y: H / 2 }, heading = 0, stride = 0, said = "", stoppedFor = 0;

  const typing = (t) => !!(t && t.closest && t.closest("textarea, input, select"));
  function keyDown(e) {
    if (!on || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.code;
    if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"].includes(k)) {
      keys.add(k); e.preventDefault();
    } else if (k === "KeyC" && !e.repeat) { toggleView(); e.preventDefault(); }
    else if (k === "KeyR" && !e.repeat) { useHere(); e.preventDefault(); }
  }
  function keyUp(e) { keys.delete(e.code); }
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("blur", () => keys.clear());

  const tile = () => ({ x: Math.max(0, Math.min(W - 1, Math.round(pos.x))), y: Math.max(0, Math.min(H - 1, Math.round(pos.y))) });
  function useHere() { if (on) { const t = tile(); onUseHere(t.x, t.y); } }

  function start(k, x, y) {
    kit = k;
    if (!on) saved = { cam: { ...kit.cam }, limits: { ...kit.limits } };
    on = true;
    if (Number.isFinite(x) && Number.isFinite(y)) pos = { x, y };
    // Walk off a spot that's under water: look for the nearest dry ground.
    if (groundAt(WF, world(), pos.x, pos.y).water > DEEP) {
      let best = null;
      for (let y2 = 0; y2 < H; y2++) for (let x2 = 0; x2 < W; x2++) {
        if (world().water[y2 * W + x2] > 0.3) continue;
        const d = (x2 - pos.x) ** 2 + (y2 - pos.y) ** 2;
        if (!best || d < best.d) best = { x: x2, y: y2, d };
      }
      if (best) pos = { x: best.x, y: best.y };
    }
    heading = kit.cam.yaw;
    applyView();
    say("");
  }
  function stop() {
    if (!on) return;
    on = false; keys.clear(); stick.x = stick.y = 0;
    if (kit && saved) { Object.assign(kit.cam, saved.cam); Object.assign(kit.limits, saved.limits); }
    say("");
  }
  function applyView() {
    if (!kit) return;
    if (first) Object.assign(kit.limits, { minDist: 0.25, maxDist: 0.25, minPitch: -1.3, maxPitch: 1.3 }), Object.assign(kit.cam, { dist: 0.25, pitch: 0.15 });
    else Object.assign(kit.limits, { minDist: 2.5, maxDist: 30, minPitch: -0.2, maxPitch: 1.4 }), Object.assign(kit.cam, { dist: 7, pitch: 0.35 });
  }
  function toggleView() { if (!on) return; first = !first; applyView(); }
  function say(text) { if (text !== said) { said = text; onStatus(text); } }

  /** Each frame: move by the keys and the stick, keep to the ground, and put the camera on the visitor. */
  function frame(k, dt, now) {
    if (!on) return;
    kit = k;
    const cam = kit.cam;
    let turn = 0, fwd = stick.y, side = stick.x;
    if (keys.has("KeyQ") || keys.has("ArrowLeft")) turn -= 1;
    if (keys.has("KeyE") || keys.has("ArrowRight")) turn += 1;
    if (keys.has("KeyW") || keys.has("ArrowUp")) fwd += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) fwd -= 1;
    if (keys.has("KeyD")) side += 1;
    if (keys.has("KeyA")) side -= 1;
    if (turn) { cam.yaw += turn * TURN * dt; kit.touch && kit.touch(); }
    // The camera looks along -(cos yaw, sin yaw) on the ground, so that is "forward".
    const fx = -Math.cos(cam.yaw), fz = -Math.sin(cam.yaw), rx = -fz, rz = fx;
    let mx = fx * fwd + rx * side, mz = fz * fwd + rz * side;
    const len = Math.hypot(mx, mz);
    const wd = world(), here = groundAt(WF, wd, pos.x, pos.y);
    if (len > 0.01) {
      mx /= Math.max(1, len); mz /= Math.max(1, len);
      const hurry = keys.has("ShiftLeft") || keys.has("ShiftRight") || Math.hypot(stick.x, stick.y) > 0.95;
      const speed = here.water > 0.25 ? WADE : hurry ? HURRY : WALK;
      const step = stepFrom(WF, wd, pos.x, pos.y, mx * speed * dt, mz * speed * dt);
      if (step.stopped === "deep" || step.stopped === "cliff") {
        // Slide along whatever stopped you, one axis at a time, before giving up.
        const sx = stepFrom(WF, wd, pos.x, pos.y, mx * speed * dt, 0), sz = stepFrom(WF, wd, pos.x, pos.y, 0, mz * speed * dt);
        const moved = [sx, sz].find((s) => !s.stopped || s.stopped === "edge");
        if (moved) pos = { x: moved.x, y: moved.y }; else stoppedFor = now;
        if (!moved) say(step.stopped === "deep" ? "Too deep to wade." : "Too steep to climb.");
      } else { pos = { x: step.x, y: step.y }; }
      heading = Math.atan2(mz, mx);
      stride += speed * dt * 2.2;
    } else stride *= 0.85;
    if (now - stoppedFor > 1500) {
      const t = tile(), g = groundAt(WF, wd, pos.x, pos.y);
      say(`🚶 (${t.x}, ${t.y}) · ground ${g.ground.toFixed(1)} m${g.water ? ` · wading ${g.water.toFixed(2)} m` : ""} · ${wd.materials[wd.mat[t.y * W + t.x]].name}`);
    }
    const g = groundAt(WF, wd, pos.x, pos.y), feet = g.ground + Math.max(0, g.water - 0.5);
    const wx = ox + pos.x, wz = oz + pos.y;
    if (first) {
      // Eye at head height; the kit's eye is target + dist * (its direction), so put the target just in front.
      const cp = Math.cos(cam.pitch), d = cam.dist;
      cam.tx = wx - d * cp * Math.cos(cam.yaw); cam.ty = feet + EYE - d * Math.sin(cam.pitch); cam.tz = wz - d * cp * Math.sin(cam.yaw);
    } else {
      cam.tx = wx; cam.ty = feet + 1.3; cam.tz = wz;
    }
  }

  /** The body: spheres for the trunk and head (lit, with the world's), seen only from behind. */
  function marks() {
    if (!on || first) return null;
    const g = groundAt(WF, world(), pos.x, pos.y), y = g.ground + Math.max(0, g.water - 0.5), x = ox + pos.x, z = oz + pos.y;
    const coat = [0.55, 0.08, 0.05], skin = [0.75, 0.5, 0.33];
    // marks stand on y: (x, y, z, radius, r, g, b)
    return new Float32Array([x, y + 0.75, z, 0.27, ...coat, x, y + 1.05, z, 0.24, ...coat, x, y + 1.42, z, 0.15, ...skin]);
  }
  /** Legs and arms as wide lines that swing as it walks, and a small mark on the ground ahead. */
  function lines() {
    if (!on || first) return null;
    const g = groundAt(WF, world(), pos.x, pos.y), y = g.ground + Math.max(0, g.water - 0.5), x = ox + pos.x, z = oz + pos.y;
    const fx = Math.cos(heading), fz = Math.sin(heading), sx = -fz, sz = fx, swing = Math.sin(stride) * 0.32;
    const out = [], leg = [0.06, 0.05, 0.05], arm = [0.5, 0.07, 0.05];
    const seg = (a, b, col, metres) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], col[0], col[1], col[2], 1, 1, metres, ROUND);
    for (const side of [-1, 1]) {
      const hip = [x + sx * 0.11 * side, y + 0.75, z + sz * 0.11 * side];
      const foot = [hip[0] + fx * swing * side, y + 0.04, hip[2] + fz * swing * side];
      seg(hip, foot, leg, 0.13);
      const shoulder = [x + sx * 0.3 * side, y + 1.2, z + sz * 0.3 * side];
      const hand = [shoulder[0] - fx * swing * side * 0.8, y + 0.78, shoulder[2] - fz * swing * side * 0.8];
      seg(shoulder, hand, arm, 0.1);
    }
    const ahead = [x + fx * 0.55, y + 1.42, z + fz * 0.55];   // where it's facing: a short nose of a hood
    seg([x + fx * 0.12, y + 1.45, z + fz * 0.12], ahead, [0.4, 0.06, 0.04], 0.07);
    return new Float32Array(out);
  }

  /** The canvas's own keys: while walking, the arrows walk instead of turning the kit's camera. */
  function canvasKey(e) { return on && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "+", "=", "-", "_"].includes(e.key); }

  /** A touch stick and two buttons over the 3D view, shown only while walking on a touch screen. */
  function stickPad(host) {
    const pad = document.createElement("div");
    pad.className = "g3-walkpad";
    pad.style.cssText = "position:absolute;left:12px;bottom:12px;width:112px;height:112px;border-radius:50%;background:rgba(13,20,24,.45);" +
      "border:1px solid rgba(255,255,255,.25);touch-action:none;z-index:3;display:none";
    const knob = document.createElement("div");
    knob.style.cssText = "position:absolute;left:36px;top:36px;width:40px;height:40px;border-radius:50%;background:rgba(228,231,235,.75);pointer-events:none";
    pad.appendChild(knob);
    const buttons = document.createElement("div");
    buttons.style.cssText = "position:absolute;right:12px;bottom:12px;display:none;gap:8px;z-index:3";
    const mk = (text, title, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.title = title; b.onclick = fn; buttons.appendChild(b); return b; };
    mk("Use here", "Put the spot, or use the picked tool, where you stand (R)", useHere);
    mk("View", "Switch between behind and through the eyes (C)", toggleView);
    let id = null;
    const move = (e) => {
      const r = pad.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / (r.width / 2), dy = (e.clientY - cy) / (r.height / 2);
      const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
      stick.x = dx; stick.y = -dy;
      knob.style.left = 36 + dx * 36 + "px"; knob.style.top = 36 + dy * 36 + "px";
    };
    const end = () => { id = null; stick.x = stick.y = 0; knob.style.left = "36px"; knob.style.top = "36px"; };
    pad.addEventListener("pointerdown", (e) => { id = e.pointerId; pad.setPointerCapture(e.pointerId); move(e); e.preventDefault(); });
    pad.addEventListener("pointermove", (e) => { if (e.pointerId === id) move(e); });
    pad.addEventListener("pointerup", end); pad.addEventListener("pointercancel", end);
    host.appendChild(pad); host.appendChild(buttons);
    return { show(v) { pad.style.display = v ? "" : "none"; buttons.style.display = v ? "flex" : "none"; if (!v) end(); } };
  }

  return {
    start, stop, toggleView, useHere, frame, marks, lines, canvasKey, stickPad,
    get on() { return on; }, get first() { return first; }, get pos() { return { ...pos }; }, get tile() { return tile(); },
    stick,
  };
}
