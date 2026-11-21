// The 3D view: the same world, drawn with Strata (https://github.com/Preponderous-Software/strata, MIT).
//
// This file turns a Glomus world into plain arrays and hands them to the engine in 3d/glomus3d.wasm, built
// from view3d/glomus3d.cpp with Strata's web kit. It reads the world and never changes it: a tap, a hover or
// a stroke only reports which tiles were under the pointer, and the page decides what that means.
//
//   const view = await open3d({
//     canvas, WF, world: () => world, spot: () => spot,
//     overlay: (now) => ({ outlines: [...], labels: [...] }),   // what the page draws over the land this frame
//     onTap(x, y) {}, onHover(hit) {},                         // hit: {x, y} or null
//     strokeWidth: () => null,   // a number while a drag tool is picked: one-pointer drags then draw a stroke
//     onStrokeMove(points) {}, onStroke(points) {},            // points: [[x, y], ...] in tiles
//   });
//   view.pause(); view.resume(); view.refresh();   // refresh: upload the world now, not at the next interval
//
// An outline is {area, color: "#rrggbb", alpha, px, dash: [on, off] in metres, offset, top}, where area is an
// area as world.js writes them: "everywhere", {circle: [x, y, r]}, {rect: [x, y, w, h]} or {path, width}.
// A label is {x, y, text, color, alpha}: HTML over the canvas at a tile.
//
// One tile is one metre, as world.js's heights are; the map's centre is the origin.

const BASE = new URL("./3d/", import.meta.url);
const REFRESH_MS = 250;
const LINE = 13;   // floats per wide line segment: x0 y0 z0 x1 y1 z1 r g b a px metres flags
const ON_TOP = 1, ROUND = 2;

function script(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`couldn't load ${src}`));
    document.head.append(s);
  });
}

// Glomus's colours are sRGB hex; Strata lights in linear RGB.
const linear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export function hexLinear(hex) {
  const n = parseInt(String(hex || "#ff00ff").slice(1), 16);
  return [linear((n >> 16) & 255), linear((n >> 8) & 255), linear(n & 255)];
}

/** The surface under a point in tile units, water included. */
function surfaceOf(WF, world) {
  const { W, H } = WF, h = world.height, w = world.water;
  return (tx, ty) => {
    const x = Math.max(0, Math.min(W - 1, Math.round(tx))), y = Math.max(0, Math.min(H - 1, Math.round(ty))), i = y * W + x;
    return h[i] + (w[i] > 0.02 ? w[i] : 0);
  };
}

/** Everything the engine draws from the world itself, as arrays: the ground, the water and the animals. */
export function sceneOf(WF, world) {
  const { W, H } = WF, N = W * H, h = world.height, w = world.water, m = world.mat, f = world.flux || new Float32Array(N);
  const ox = -(W - 1) / 2, oz = -(H - 1) / 2;
  const mats = world.materials.map((mm) => hexLinear(mm.color));
  const heights = new Float32Array(N), colors = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    heights[i] = h[i];
    const c = mats[m[i]] || [1, 0, 1], damp = w[i] > 0.02 ? 0.72 : 1;   // wet ground reads darker
    colors[i * 3] = c[0] * damp; colors[i * 3 + 1] = c[1] * damp; colors[i * 3 + 2] = c[2] * damp;
  }
  // Water: one vertex per tile, so the surface is continuous. A dry vertex is tucked under the ground,
  // so the water's edge meets the bank instead of stepping. Only quads with some water are kept.
  const wet = (i) => w[i] > 0.02;
  const pos = new Float32Array(N * 3), wcol = new Float32Array(N * 3), idx = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, d = w[i], fast = Math.min(1, f[i] * 5);
    pos[i * 3] = ox + x; pos[i * 3 + 1] = wet(i) ? h[i] + d + 0.03 : h[i] - 0.15; pos[i * 3 + 2] = oz + y;
    const deep = Math.min(1, d / 1.5);
    wcol[i * 3] = 0.03 + 0.10 * fast; wcol[i * 3 + 1] = 0.12 + 0.18 * fast - 0.05 * deep; wcol[i * 3 + 2] = 0.35 + 0.15 * fast - 0.12 * deep;
  }
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const a = y * W + x, b = a + 1, c = a + W, d = c + 1;
    if (!(wet(a) || wet(b) || wet(c) || wet(d))) continue;
    idx.push(a, c, b, b, c, d);
  }
  const ground = surfaceOf(WF, world), marks = [];
  for (const c of world.creatures || []) {
    if (c.dead) continue;
    const sp = WF.speciesOf ? WF.speciesOf(world, c.species) : null, col = hexLinear(sp && sp.look ? sp.look.color : "#e8d08a");
    const tx = c.x - 0.5, ty = c.y - 0.5;
    marks.push(ox + tx, ground(tx, ty), oz + ty, 0.6, ...col);
  }
  return { W, H, ox, oz, heights, colors, water: { pos, col: wcol, idx: Uint32Array.from(idx) }, marks: Float32Array.from(marks) };
}

/** An area as polylines in tile units (tile centres at whole numbers), each densified so it can lie on the land. */
export function areaLines(area, W, H) {
  const out = [];
  const box = (x0, y0, x1, y1) => out.push({ pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });
  if (area === "everywhere") box(-0.3, -0.3, W - 0.7, H - 0.7);
  else if (area && area.circle) {
    const [x, y, r] = area.circle, R = r + 0.5, n = Math.max(24, Math.round(R * 8)), pts = [];
    for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI * 2; pts.push([x + Math.cos(a) * R, y + Math.sin(a) * R]); }
    out.push({ pts });
  } else if (area && area.rect) {
    const [x, y, w, h] = area.rect;
    box(x - 0.5, y - 0.5, x + w - 0.5, y + h - 0.5);
  } else if (area && area.path && area.path.length) {
    const pts = area.path.map(([x, y]) => [x, y]);
    if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]);   // a tap with a drag tool: a dot
    out.push({ pts, band: area.width || 1 });
  }
  for (const line of out) {   // at most half a tile between points
    const dense = [line.pts[0]];
    for (let k = 1; k < line.pts.length; k++) {
      const [ax, ay] = line.pts[k - 1], [bx, by] = line.pts[k], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5));
      for (let j = 1; j <= n; j++) dense.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]);
    }
    line.pts = dense;
  }
  return out;
}

/** This frame's lines: outlines from the page, the rain, and the marks animals carry (patterns, the dead). */
export function overlayLines(WF, world, outlines = [], t = 0) {
  const { W, H } = WF, ox = -(W - 1) / 2, oz = -(H - 1) / 2, ground = surfaceOf(WF, world), out = [];
  const seg = (ax, ay, az, bx, by, bz, col, a, px, metres = 0, flags = ROUND) => out.push(ax, ay, az, bx, by, bz, col[0], col[1], col[2], a, px, metres, flags);
  for (const o of outlines) {
    const col = hexLinear(o.color || "#ffffff"), a = o.alpha ?? 1, px = o.px ?? 2, lift = o.lift ?? 0.25;
    const flags = ROUND | (o.top ? ON_TOP : 0), dash = o.dash, period = dash ? dash[0] + dash[1] : 0;
    for (const line of areaLines(o.area, W, H)) {
      const p = line.pts, band = line.band ? line.band : 0;
      let s = o.offset || 0;
      for (let k = 1; k < p.length; k++) {
        const [ax, ay] = p[k - 1], [bx, by] = p[k], len = Math.hypot(bx - ax, by - ay), mid = s + len / 2;
        s += len;
        if (period && ((mid % period) + period) % period >= dash[0]) continue;
        seg(ox + ax, ground(ax, ay) + lift, oz + ay, ox + bx, ground(bx, by) + lift, oz + by, col, band ? a * 0.35 : a, px, band, flags);
      }
    }
  }
  if (world.weather && world.weather.raining) {
    // Streaks falling through a box over the land, each in its own column, which moves every fall.
    const rain = hexLinear("#bed7f0");
    for (let k = 0; k < 160; k++) {
      const cycle = t * 1.1 + ((k * 0.618) % 1), n = Math.floor(cycle), f = cycle - n;
      const hash = (v) => (((Math.sin(v * 12.9898 + n * 78.233) * 43758.5453) % 1) + 1) % 1;
      const tx = hash(k + 1) * (W - 1), ty = hash(k + 101) * (H - 1), top = ground(tx, ty) + 22;
      const y = top - f * 22, x = ox + tx - f * 2, z = oz + ty;
      seg(x, y, z, x - 0.25, y - 1.4, z, rain, 0.35, 1, 0, 0);
    }
  }
  const dark = [0.003, 0.005, 0.006];
  for (const c of world.creatures || []) {
    const tx = c.x - 0.5, ty = c.y - 0.5, x = ox + tx, z = oz + ty, g = ground(tx, ty);
    if (c.dead) {   // where it died: a faded ×, as on the map
      const red = hexLinear("#e8806a"), r = 0.7, y = g + 0.15;
      seg(x - r, y, z - r, x + r, y, z + r, red, 0.6, 3);
      seg(x + r, y, z - r, x - r, y, z + r, red, 0.6, 3);
      continue;
    }
    const sp = WF.speciesOf ? WF.speciesOf(world, c.species) : null, look = (sp && sp.look) || {}, col = hexLinear(look.color || "#e8d08a");
    const cy = g + 0.6;
    const loop = (r, y, colr, a, px, tilt = 0) => {
      for (let k = 0; k < 16; k++) {
        const a0 = (k / 16) * Math.PI * 2, a1 = ((k + 1) / 16) * Math.PI * 2;
        seg(x + Math.cos(a0) * r, y + Math.sin(a0) * r * tilt, z + Math.sin(a0) * r, x + Math.cos(a1) * r, y + Math.sin(a1) * r * tilt, z + Math.sin(a1) * r, colr, a, px, 0, 0);
      }
    };
    if (look.pattern === "ring") loop(0.95, cy, col, 1, 3);
    else if (look.pattern === "stripe") loop(0.63, cy, dark, 0.85, 3, 0.6);
    else if (look.pattern === "cross") { seg(x - 1, cy, z, x + 1, cy, z, col, 1, 4); seg(x, cy, z - 1, x, cy, z + 1, col, 1, 4); }
    else if (look.pattern === "diamond") {
      const r = 0.95, y = g + 0.1;
      seg(x, y, z - r, x + r, y, z, col, 1, 3); seg(x + r, y, z, x, y, z + r, col, 1, 3);
      seg(x, y, z + r, x - r, y, z, col, 1, 3); seg(x - r, y, z, x, y, z - r, col, 1, 3);
    }
  }
  return Float32Array.from(out);
}

/** Nearest tile to a point in CSS pixels, by projecting tile centres; null off the map. */
export function tileAtPixel(kit, scene, px, py, radius) {
  const m = kit.viewProj(), cw = kit.canvas ? kit.canvas.clientWidth : 0, ch = kit.canvas ? kit.canvas.clientHeight : 0;
  let best = null, bestD = radius * radius;
  for (let y = 0; y < scene.H; y++) for (let x = 0; x < scene.W; x++) {
    const X = scene.ox + x, Y = scene.heights[y * scene.W + x], Z = scene.oz + y;
    const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
    if (w <= 0.01) continue;
    const sx = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * cw;
    const sy = (1 - ((m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5 + 0.5)) * ch;
    const d = (sx - px) ** 2 + (sy - py) ** 2;
    if (d < bestD) { bestD = d; best = { x, y, w }; }
  }
  return best;
}

/** Loads the engine into `canvas` and keeps it drawing the world. Rejects if WebGL 2 or the engine fails. */
export async function open3d({ canvas, mount, WF, world, spot = () => null, rings = () => [], overlay = () => ({}),
  onTap = () => {}, onHover = () => {}, strokeWidth = () => null, onStrokeMove = () => {}, onStroke = () => {},
  // An avatar (walk3d.js) or anything else that moves every frame: called before each frame with the kit and the
  // frame's seconds; its spheres (7 floats each, as sceneOf's marks) and wide lines (LINE floats each) are drawn
  // with the world's. onKey sees the canvas's keys first; returning true keeps them from the kit's camera.
  beforeFrame = null, extraMarks = null, extraLines = null, onKey = null }) {
  await script(new URL("strata-loader.js", BASE).href);
  await script(new URL("strata-kit.js", BASE).href);
  const module = await window.StrataLoader.load({
    script: new URL("glomus3d.js", BASE).href, factory: "createGlomus3d", wasm: new URL("glomus3d.wasm", BASE).href,
    title: "Glomus in 3D", mount: mount || canvas.parentElement, contain: true,
  });
  const M = module, bufs = new Map();
  const buf = (name, bytes) => {   // one malloc'd buffer per array, grown when needed
    let b = bufs.get(name);
    if (!b || b.bytes < bytes) { if (b) M._free(b.ptr); b = { ptr: M._malloc(Math.max(16, bytes)), bytes: Math.max(16, bytes) }; bufs.set(name, b); }
    return b.ptr;
  };
  const putF = (name, arr) => { const p = buf(name, arr.length * 4); M.HEAPF32.set(arr, p >> 2); return p; };
  const putU = (name, arr) => { const p = buf(name, arr.length * 4); M.HEAP32.set(new Int32Array(arr.buffer, arr.byteOffset, arr.length), p >> 2); return p; };

  // Labels: HTML over the canvas, placed at their tiles every frame.
  const host = canvas.parentElement;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const layer = document.createElement("div");
  layer.className = "g3-labels";
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;overflow:visible;z-index:2";
  host.appendChild(layer);
  const pool = [];
  function placeLabels(labels) {
    const sc = scene, ground = surfaceOf(WF, world());
    for (let k = 0; k < Math.max(labels.length, pool.length); k++) {
      let el = pool[k];
      const lb = labels[k];
      if (!lb) { if (el) el.style.display = "none"; continue; }
      if (!el) {
        el = document.createElement("div");
        el.style.cssText = "position:absolute;white-space:nowrap;font:bold 12px system-ui,sans-serif;padding:1px 5px;border-radius:4px;" +
          "background:rgba(13,20,24,.75);transform:translate(-50%,-100%)";
        layer.appendChild(el); pool.push(el);
      }
      const q = sc ? kit.project(sc.ox + lb.x, ground(lb.x, lb.y) + 1.2, sc.oz + lb.y) : null;
      if (!q || q.x < 0 || q.y < 0 || q.x > canvas.clientWidth || q.y > canvas.clientHeight + 20) { el.style.display = "none"; continue; }
      el.style.display = "";
      if (el.textContent !== lb.text) el.textContent = lb.text;
      el.style.color = lb.color || "#e4e7eb";
      el.style.opacity = String(lb.alpha ?? 1);
      el.style.left = canvas.offsetLeft + q.x + "px";
      el.style.top = canvas.offsetTop + q.y + "px";
    }
  }

  let scene = null, lastTick = -1, lastAt = 0, stats = { lines: 0, labels: 0 }, labels = [];
  function upload(force) {
    const wd = world(), now = performance.now();
    if (!force && scene && (wd.tick === lastTick || now - lastAt < REFRESH_MS)) return;
    lastTick = wd.tick; lastAt = now;
    scene = sceneOf(WF, wd);
    M._g3_set_ground(putF("h", scene.heights), putF("c", scene.colors), scene.W, scene.H, 1.0, scene.ox, scene.oz);
    const wt = scene.water;
    M._g3_set_water(putF("wp", wt.pos), putF("wc", wt.col), wt.pos.length / 3, putU("wi", wt.idx), wt.idx.length, 0.72);
    if (!extraMarks) M._g3_set_marks(putF("m", scene.marks), scene.marks.length / 7);
  }
  function drawMarks() {   // the world's animals plus anything moving every frame
    const more = extraMarks();
    if (!more || !more.length) { M._g3_set_marks(putF("m", scene.marks), scene.marks.length / 7); return; }
    const all = new Float32Array(scene.marks.length + more.length);
    all.set(scene.marks); all.set(more, scene.marks.length);
    M._g3_set_marks(putF("m", all), all.length / 7);
  }
  function drawOverlay(now) {
    const o = overlay(now) || {}, sp = spot();
    const outlines = [...(sp ? [{ area: { circle: [sp.x, sp.y, sp.r] }, color: "#ffffff", alpha: 0.95, px: 2.5 }] : []),
      ...rings().map((r) => ({ area: { circle: [r.x, r.y, r.r] }, color: r.color || "#ffffff", alpha: r.alpha ?? 0.95 })),
      ...(o.outlines || [])];
    let lines = overlayLines(WF, world(), outlines, now / 1000);
    const more = extraLines ? extraLines(now) : null;
    if (more && more.length) { const all = new Float32Array(lines.length + more.length); all.set(lines); all.set(more, lines.length); lines = all; }
    M._g3_set_wide_lines(putF("wl", lines), lines.length / LINE);
    labels = o.labels || [];
    stats = { lines: lines.length / LINE, labels: labels.length };
  }

  // Strokes: while the page has a drag tool picked, one pointer (a left drag, a pen or one finger) draws over
  // the land instead of turning the view. These listeners are added before the kit's, so they see the
  // pointer first and keep it. Alt-, middle- or right-drag and shift-drag still go to the kit; a second
  // finger hands both fingers back to it (pinch and pan) and drops the stroke.
  let stroke = null, forwarding = false;
  const tileOf = (e) => (scene ? kit.pickAt(e.clientX, e.clientY, 40) : null);
  canvas.addEventListener("pointerdown", (e) => {
    if (forwarding || strokeWidth() == null) return;
    if (stroke) {
      if (e.pointerId === stroke.id) return;
      const s = stroke; stroke = null; onStrokeMove(null);
      forwarding = true;
      try {
        canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: s.id, pointerType: s.type, isPrimary: true, button: 0, buttons: 1, clientX: s.x, clientY: s.y, bubbles: true }));
      } finally { forwarding = false; }
      return;   // this second pointer goes on to the kit: two pointers, a pinch
    }
    if (e.pointerType === "mouse" && (e.button !== 0 || e.shiftKey || e.altKey)) return;
    const hit = tileOf(e);
    if (!hit) return;   // off the land: the kit turns the view
    e.stopImmediatePropagation(); e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    stroke = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, points: [[hit.x, hit.y]] };
    onStrokeMove(stroke.points, hit);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!stroke || e.pointerId !== stroke.id) return;
    e.stopImmediatePropagation();
    stroke.x = e.clientX; stroke.y = e.clientY;
    const hit = tileOf(e), pts = stroke.points, last = pts[pts.length - 1];
    if (hit && Math.hypot(hit.x - last[0], hit.y - last[1]) >= 1) pts.push([hit.x, hit.y]);
    onStrokeMove(pts, hit);
  });
  const endStroke = (e) => {
    if (!stroke || e.pointerId !== stroke.id) return;
    e.stopImmediatePropagation();
    const s = stroke; stroke = null;
    if (e.type === "pointerup") onStroke(s.points); else onStrokeMove(null);
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  const kit = window.StrataKit.create({
    module, canvas,
    camera: { yaw: Math.PI / 2, pitch: 0.75, dist: 95, tx: 0, ty: 6, tz: 0 },
    limits: { minDist: 12, maxDist: 220 },
    idleOrbit: false,
    frame(t, now, dt) { upload(false); if (beforeFrame) beforeFrame(kit, dt, now); if (extraMarks) drawMarks(); drawOverlay(now); },
    onKey: onKey || undefined,
    after() { placeLabels(labels); },   // after the frame, so they use its camera
    onRestore() { upload(true); },
    pick(x, y, radius) { return scene ? tileAtPixel(kit, scene, x, y, Math.max(radius, 24)) : null; },
    idOf: (hit) => `${hit.x},${hit.y}`,
    onTap(hit) { if (hit) onTap(hit.x, hit.y); },
    onHover(hit) { onHover(hit ? { x: hit.x, y: hit.y } : null); },
    onSlow: () => window.StrataLoader.slow(),
    onFatal: (code, message) => window.StrataLoader.fallback(code, message),
  });
  kit.canvas = canvas;
  upload(true);
  drawOverlay(performance.now());
  kit.start();
  window.StrataLoader.done();
  return {
    kit,
    refresh: () => upload(true),
    pause() { kit.running = false; layer.style.display = "none"; stroke = null; },
    resume() { layer.style.display = ""; upload(true); kit.start(); },
    get scene() { return scene; },
    get stroking() { return stroke ? stroke.points.slice() : null; },
    get overlayStats() { return stats; },
  };
}
