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
//
// How things look (the hour's light, the ground up close, the water, the animals' bodies, glints and stars)
// is the second half of this file ("how it looks"); the first moves it into the engine and keeps it current. The sun follows the world's own
// clock (DAY_SECONDS); a button over the view pins daylight for anyone who'd rather see clearly.


const BASE = new URL("./3d/", import.meta.url);
const REFRESH_MS = 250;   // the water, the glow and the wet tiles
const GROUND_MS = 1500;   // the ground, when it has only drifted (erosion, damp); a real change goes up at once
const DAYLIGHT_KEY = "glomus.3d.daylight";
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


/** The surface under a point in tile units, water included. */
function surfaceOf(WF, world) {
  const { W, H } = WF, h = world.height, w = world.water;
  return (tx, ty) => {
    const x = Math.max(0, Math.min(W - 1, Math.round(tx))), y = Math.max(0, Math.min(H - 1, Math.round(ty))), i = y * W + x;
    return h[i] + (w[i] > 0.02 ? w[i] : 0);
  };
}

/** The fine ground's height at a point in tile units, bilinear between its samples. */
export function fineAt(ground, tx, ty) {
  const S = ground.S, gx = Math.max(0, Math.min(ground.nx - 1.001, tx * S)), gy = Math.max(0, Math.min(ground.nz - 1.001, ty * S));
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, i = y0 * ground.nx + x0, h = ground.heights;
  return (h[i] * (1 - fx) + h[i + 1] * fx) * (1 - fy) + (h[i + ground.nx] * (1 - fx) + h[i + ground.nx + 1] * fx) * fy;
}

/** The wet tiles, with the way their water runs (towards the lowest neighbouring surface) and how fast. */
function wetTiles(WF, world) {
  const { W, H } = WF, h = world.height, w = world.water, f = world.flux || new Float32Array(W * H), out = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (w[i] <= 0.05) continue;
    const head = h[i] + w[i];
    let dx = 0, dy = 0, best = 0;
    for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ax, ny = y + ay;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const drop = head - (h[ny * W + nx] + w[ny * W + nx]);
      if (drop > best) { best = drop; dx = ax; dy = ay; }
    }
    out.push({ x, y, top: head + 0.03, flux: f[i], dx, dy });
  }
  return out;
}

/** Everything the engine draws from the world itself, as arrays: the ground S times finer than the tiles, the
 * water, and the wet tiles (for glints and foam). `heights` stay one per tile, for picking. */
export function sceneOf(WF, world, { S = 4, wet = 0 } = {}) {
  const { W, H } = WF, N = W * H, ox = -(W - 1) / 2, oz = -(H - 1) / 2;
  const heights = Float32Array.from(world.height.subarray ? world.height.subarray(0, N) : world.height);
  const ground = groundOf(WF, world, S, { wet });
  return { W, H, ox, oz, heights, ground, water: waterOf(WF, world, ground, Math.min(2, S)), wet: wetTiles(WF, world), marks: new Float32Array(0) };
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

/** This frame's lines: outlines from the page, the rain, and the marks animals carry (patterns, the dead).
 * `light` (0..1) dims the rain with the hour; `patterns` false leaves the animals' rings off (up close their
 * bodies show their patterns). */
export function overlayLines(WF, world, outlines = [], t = 0, { light = 1, patterns = true } = {}) {
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
    const rain = hexLinear("#bed7f0").map((v) => v * (0.35 + 0.65 * light));
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
    if (!patterns) continue;
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

  // The scene: heights per tile (picking, labels), the fine ground, the water and the wet tiles.
  let scene = null, lastTick = -1, lastAt = 0, stats = { lines: 0, labels: 0 }, labels = [];
  let groundAt = 0, groundH = null, groundM = null, groundS = 0, glow = { lights: [], spots: [] }, glowKey = "";
  const look = { groundUploads: 0, groundMs: 0, groundSamples: 0, waterVertices: 0, bodyVertices: 0, bodies: 0, points: 0, lights: 0 };
  const fineness = () => (kit && kit.quality === 0 ? 2 : 4);   // the lowest tier draws the ground half as fine
  /** Whether the land changed enough since the ground went up to show it now: a tool, a whim, an animal grazing. */
  function groundChanged(wd) {
    if (!groundH) return 2;
    let drift = false;
    for (let i = 0; i < groundH.length; i++) {
      const d = Math.abs(wd.height[i] - groundH[i]);
      if (d > 0.05 || wd.mat[i] !== groundM[i]) return 2;
      if (d > 0.002) drift = true;
    }
    return drift ? 1 : 0;
  }
  function uploadGround(wd, now) {
    const t0 = performance.now(), S = fineness();
    const ground = groundOf(WF, wd, S, { wet: weather.wet });
    M._g3_set_ground(putF("h", ground.heights), putF("c", ground.colors), ground.nx, ground.nz, ground.cell, scene.ox, scene.oz);
    scene.ground = ground; groundAt = now; groundS = S; weather.wetAtUpload = weather.wet;
    groundH = Float32Array.from(wd.height); groundM = Uint8Array.from(wd.mat);
    look.groundUploads++; look.groundMs = performance.now() - t0; look.groundSamples = ground.nx * ground.nz;
  }
  function upload(force) {
    const wd = world(), now = performance.now();
    if (!force && scene && (wd.tick === lastTick || now - lastAt < REFRESH_MS)) return;
    lastTick = wd.tick; lastAt = now;
    const { W, H } = WF;
    if (!scene) scene = { W, H, ox: -(W - 1) / 2, oz: -(H - 1) / 2, marks: new Float32Array(0) };
    scene.heights = Float32Array.from(wd.height);
    const change = groundChanged(wd);
    if (force || !scene.ground || change === 2 || groundS !== fineness() || (now - groundAt > GROUND_MS && (change || weather.wetMoved(now)))) uploadGround(wd, now);
    const wt = waterOf(WF, wd, scene.ground, Math.min(2, scene.ground.S));
    scene.water = wt; scene.wet = wetTiles(WF, wd);
    M._g3_set_water(putF("wp", wt.pos), putF("wc", wt.col), wt.pos.length / 3, putU("wi", wt.idx), wt.idx.length, 0.8);
    look.waterVertices = wt.pos.length / 3;
    const key = wd.materials.map((m) => m.name).join("|");
    if (force || change === 2 || key !== glowKey) { glowKey = key; glow = glowsOf(WF, wd); }
    if (!extraMarks) M._g3_set_marks(putF("m", scene.marks), scene.marks.length / 7);
  }

  // The hour's light, from the world's clock unless daylight is pinned; rain eases in and out, and the land
  // stays wet for a while after it.
  let pinned = false;
  try { pinned = localStorage.getItem(DAYLIGHT_KEY) === "day"; } catch (e) { /* no storage: follow the clock */ }
  const weather = { rain: 0, wet: 0, wetAtUpload: 0, wetMoved() { return Math.abs(this.wet - this.wetAtUpload) > 0.08 && ((this.wetAtUpload = this.wet), true); } };
  let sky = skyAt(0, { TPS: WF.TPS || 10, pinned });
  function updateSky(dt) {
    const wd = world(), raining = !!(wd.weather && wd.weather.raining), k = Math.min(1, dt);
    weather.rain += ((raining ? 1 : 0) - weather.rain) * Math.min(1, k / 3);
    weather.wet = Math.max(0, Math.min(1, weather.wet + (raining ? k / 20 : -k / 90)));
    sky = skyAt(wd.tick, { TPS: WF.TPS || 10, pinned, rain: weather.rain });
    M._g3_set_sky(putF("sky", skyFloats(sky)));
    const lights = glow.lights.map((l) => { const c = l.slice(); c[7] *= 0.25 + 0.75 * sky.night; return c; }).flat();
    M._g3_set_lights(putF("gl", Float32Array.from(lights)), lights.length / 9);
    look.lights = lights.length / 9;
  }
  function drawPoints(t) {
    const g = scene.ground, wd = world();
    const pts = pointsOf(WF, wd, sky, t, { wet: scene.wet, spots: glow.spots, budget: kit.quality === 0 ? 0.5 : 1, ground: (x, y) => fineAt(g, x, y) });
    M._g3_set_points(putF("pt", pts), pts.length / 10);
    look.points = pts.length / 10;
  }

  // The animals: one body mesh each (bodyMesh), eased towards where the world has them so they walk
  // smoothly between its ticks, facing where they go, bobbing as they step, nose down while they eat or drink.
  const herd = new Map(), freeSlots = [];
  let nextSlot = 0;
  function bodyFor(c, sp) {
    const lk = (sp && sp.look) || {}, mossy = c.name === "Mossback";
    const key = `${lk.color}|${lk.pattern}|${mossy}`;
    let a = herd.get(c.id);
    if (a && a.key === key) return a;
    const slot = a ? a.slot : freeSlots.length ? freeSlots.pop() : nextSlot++;
    const mesh = bodyMesh(lk, { mossy });
    M._g3_set_body(slot, putF("bp", mesh.pos), putF("bc", mesh.col), mesh.pos.length / 3, putU("bi", mesh.idx), mesh.idx.length);
    const tx = c.x - 0.5, ty = c.y - 0.5;
    a = Object.assign(a || { x: tx, y: ty, heading: hashHeading(c.id), stride: 0, pitch: 0 }, { slot, key, verts: mesh.pos.length / 3, coat: hexLinear(lk.color || "#e8d08a") });
    herd.set(c.id, a);
    return a;
  }
  const hashHeading = (id) => ((String(id).split("").reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7) >>> 0) % 628) / 100;
  let herdLines = new Float32Array(0);
  function moveHerd(dt, t) {
    const wd = world(), g = scene.ground, seen = new Set(), poses = [], legs = [];
    const scale = Math.max(1, Math.min(2.2, kit.cam.dist / 40));   // a touch bigger from far off, so they read
    const legCol = (a) => a.coat.map((v) => v * 0.45 * sky.light);
    for (const c of wd.creatures || []) {
      if (c.dead) continue;
      const sp = WF.speciesOf ? WF.speciesOf(wd, c.species) : null, a = bodyFor(c, sp);
      seen.add(c.id);
      const tx = c.x - 0.5, ty = c.y - 0.5, ease = 1 - Math.exp(-dt * 6);
      let dx = tx - a.x, dy = ty - a.y;
      if (Math.hypot(dx, dy) > 4) { a.x = tx; a.y = ty; dx = dy = 0; }   // a jump (a new world, a release): no sliding
      const mx = dx * ease, my = dy * ease, moved = Math.hypot(mx, my);
      a.x += mx; a.y += my;
      if (moved > 0.0015) {
        const want = Math.atan2(my, mx);
        let turn = want - a.heading;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        a.heading += turn * Math.min(1, dt * 7);
        a.stride += moved * 9;
      }
      const grazing = c.state === "eating" || c.state === "drinking";
      a.pitch += ((grazing ? 0.38 + 0.08 * Math.sin(t * 2.6 + a.slot) : 0) - a.pitch) * Math.min(1, dt * 4);
      const gy = fineAt(g, a.x, a.y), bob = moved > 0.0015 ? Math.abs(Math.sin(a.stride)) * 0.05 : 0;
      const X = scene.ox + a.x, Z = scene.oz + a.y, Y = gy + bob * scale;
      poses.push(a.slot, ...poseMatrix(X, Y, Z, a.heading, a.pitch, scale));
      // Legs: four lines from the trunk to the ground, swinging in pairs as it walks.
      const hx = Math.cos(a.heading), hz = Math.sin(a.heading), swing = moved > 0.0015 ? Math.sin(a.stride) * 0.16 : 0, col = legCol(a);
      for (const [fx, sz, ph] of [[0.28, 1, 1], [0.28, -1, -1], [-0.3, 1, -1], [-0.3, -1, 1]]) {
        const lx = fx * scale, lz = 0.17 * sz * scale, top = Y + (LEG + 0.12) * scale;
        const hipX = X + hx * lx - hz * lz, hipZ = Z + hz * lx + hx * lz, s = swing * ph * scale;
        const footX = hipX + hx * s, footZ = hipZ + hz * s, foot = fineAt(g, a.x + (footX - X), a.y + (footZ - Z)) + 0.03;
        legs.push(hipX, top, hipZ, footX, foot, footZ, col[0], col[1], col[2], 1, 1.5, 0.1 * scale, ROUND);
      }
    }
    for (const [id, a] of herd) if (!seen.has(id)) { M._g3_set_body(a.slot, 0, 0, 0, 0, 0); freeSlots.push(a.slot); herd.delete(id); }
    if (poses.length) M._g3_pose_bodies(putF("pose", Float32Array.from(poses)), poses.length / 17);
    herdLines = Float32Array.from(legs);
    look.bodies = herd.size; look.bodyVertices = [...herd.values()].reduce((n, a) => n + a.verts, 0);
  }

  function drawMarks() {   // anything moving every frame that draws itself as spheres (the walker)
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
    let lines = overlayLines(WF, world(), outlines, now / 1000, { light: sky.light, patterns: kit.cam.dist > 30 });
    const parts = [lines, herdLines, extraLines ? extraLines(now) : null].filter((p) => p && p.length);
    if (parts.length === 1) lines = parts[0];
    else if (parts.length > 1) {
      const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) { all.set(p, at); at += p.length; }
      lines = all;
    }
    M._g3_set_wide_lines(putF("wl", lines), lines.length / LINE);
    labels = o.labels || [];
    stats = { lines: lines.length / LINE, labels: labels.length };
  }

  // A button over the view: follow the world's clock (day and night), or keep it day.
  const sunButton = document.createElement("button");
  sunButton.type = "button"; sunButton.className = "g3-daylight";
  sunButton.style.cssText = "position:absolute;right:8px;top:8px;z-index:3;font:12px system-ui,sans-serif;padding:3px 9px;border-radius:6px;" +
    "border:1px solid rgba(255,255,255,.25);background:rgba(13,20,24,.7);color:#e4e7eb;cursor:pointer";
  const showSun = () => {
    sunButton.textContent = pinned ? "☀ Always day" : sky.night > 0.5 ? "🌙 Day & night" : "🌗 Day & night";
    sunButton.title = pinned ? "Daylight is pinned. Click to let the sun follow the world's clock (a day lasts six minutes)."
      : "The sun follows the world's clock: a day lasts six minutes. Click to keep it day.";
    sunButton.setAttribute("aria-pressed", String(pinned));
  };
  function setDaylight(mode) {
    pinned = mode === "day";
    try { localStorage.setItem(DAYLIGHT_KEY, pinned ? "day" : "clock"); } catch (e) { /* not kept */ }
    showSun();
  }
  sunButton.onclick = () => setDaylight(pinned ? "clock" : "day");
  host.appendChild(sunButton);
  showSun();

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
    frame(t, now, dt) {
      upload(false); updateSky(dt); moveHerd(dt, t);
      if (beforeFrame) beforeFrame(kit, dt, now);
      if (extraMarks) drawMarks();
      drawPoints(t); drawOverlay(now);
      if (sunButton.textContent[0] !== (pinned ? "☀" : sky.night > 0.5 ? "🌙" : "🌗")) showSun();
    },
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
  updateSky(0); moveHerd(0, 0); drawPoints(0);
  drawOverlay(performance.now());
  kit.start();
  window.StrataLoader.done();
  return {
    kit,
    refresh: () => upload(true),
    pause() { kit.running = false; layer.style.display = "none"; sunButton.style.display = "none"; stroke = null; },
    resume() { layer.style.display = ""; sunButton.style.display = ""; upload(true); kit.start(); },
    /** "day" keeps the afternoon sun; "clock" lets it follow the world's clock. */
    setDaylight, get daylight() { return pinned ? "day" : "clock"; },
    get sky() { return sky; },
    get lookStats() { return { ...look }; },
    get scene() { return scene; },
    get stroking() { return stroke ? stroke.points.slice() : null; },
    get overlayStats() { return stats; },
  };
}

// ================================================================ how it looks
//
// The light of the hour, the ground up close, the water, the animals' bodies, and the small lights (glints,
// foam, fireflies, stars, glowing ground). Pure functions of the world and the time, with no DOM and no
// engine, so they run under node (game/tools/look3d_test.js). Everything is deterministic: the same world at
// the same tick looks the same, so a still is reproducible.

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// Glomus's colours are sRGB hex; Strata lights in linear RGB.
const linear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export function hexLinear(hex) {
  const n = parseInt(String(hex || "#ff00ff").slice(1), 16);
  return [linear((n >> 16) & 255), linear((n >> 8) & 255), linear(n & 255)];
}

/** A hash of two integers and a seed, 0..1. */
export function hash(ix, iy, seed = 0) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Smooth value noise, 0..1. */
export function noise(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// ---------------------------------------------------------------- the light of the hour

/** Seconds of the world's own clock in one day and night. Six minutes: a sunset now and then, not a strobe. */
export const DAY_SECONDS = 360;
const DAYLIGHT = 0.64;   // of each day, the part with the sun up
const DAWN = 0.1;        // where in the day a new world starts: mid-morning
const PINNED = 0.62;     // "always day": a clear mid-afternoon sun

/** Where in its day the world is, 0..1: 0 sunrise, DAYLIGHT/2 noon, DAYLIGHT sunset, then night. */
export function dayPhase(tick, TPS = 10) {
  return (((tick / TPS) / DAY_SECONDS + DAWN) % 1 + 1) % 1;
}

/**
 * The light at a tick: the direction to the sun, the key light (sun by day, the engine's moon by night) and the
 * ambient, as g3_set_sky takes them, plus `night` (0..1) and `light` (about how lit the land looks, 0..1,
 * for things drawn unlit such as the rain and the animals' legs). `rain` is 0..1, how hard it rains;
 * `pinned` keeps the afternoon sun whatever the clock says.
 */
export function skyAt(tick, { TPS = 10, pinned = false, rain = 0 } = {}) {
  const p = pinned ? DAYLIGHT * PINNED : dayPhase(tick, TPS);
  // The sun crosses the sky by day, and the other half of the circle, faster, by night.
  const a = p < DAYLIGHT ? Math.PI * (p / DAYLIGHT) : Math.PI * (1 + (p - DAYLIGHT) / (1 - DAYLIGHT));
  const tilt = 0.62;   // its path leans south (+Z), as seen from a northern land: noon stands about 54 degrees
  let x = Math.cos(a), y = Math.sin(a) * Math.cos(tilt), z = Math.sin(a) * Math.sin(tilt) + 0.12;
  const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
  const day = smooth(-0.12, 0.18, y), night = 1 - day, low = 1 - smooth(0.02, 0.4, y);   // low: dawn and dusk
  const r = clamp(rain, 0, 1);
  // Key light: warm and low at the ends of the day, white at noon; the moon is a cool, dim one.
  const sunTint = [mix(1, 1.0, low), mix(0.97, 0.66, low), mix(0.92, 0.42, low)];
  const moonTint = [0.62, 0.74, 1.0];
  const tint = [0, 1, 2].map((k) => mix(moonTint[k], sunTint[k], day));
  const intensity = (day > 0.5 ? mix(0.55, 1.05, smooth(0, 0.3, y)) : mix(1.8, 0.55, day)) * (1 - 0.6 * r);
  // Ambient: grey under rain, blue at night, a touch of gold at dusk; a little lift so night is never black.
  const amb = [mix(0.8, mix(1, 1.08, low), day), mix(0.88, mix(1, 0.95, low), day), mix(1.15, mix(1, 0.86, low), day)]
    .map((v) => v * (1 - 0.25 * r) + 0.2 * r * 0.8);
  const lift = [0.04 * night + 0.02 * r, 0.05 * night + 0.022 * r, 0.09 * night + 0.026 * r];
  const light = clamp((0.28 + 0.72 * day) * (1 - 0.35 * r), 0, 1);
  return { toSun: [x, y, z], intensity, tint, ambient: amb, lift, night, day, light, phase: p, dusk: low * day };
}
/** skyAt as the 13 floats g3_set_sky takes. */
export function skyFloats(s) {
  return Float32Array.from([...s.toSun, s.intensity, ...s.tint, ...s.ambient, ...s.lift]);
}

// ---------------------------------------------------------------- the ground, up close

// How a material's surface varies up close, by its name: grass-like, rock-like, sand, snow or plain ground.
function surfaceKind(name) {
  const n = String(name || "");
  if (/meadow|grass|moss|lawn|fern|clover|turf|leaf|leaves|bush|shrub|forest|reed/.test(n)) return "grass";
  if (/stone|rock|granite|basalt|cliff|slate|marble|gravel|obsidian|crystal|ore|iron/.test(n)) return "rock";
  if (/sand|dune|beach|salt/.test(n)) return "sand";
  if (/snow|ice|frost/.test(n)) return "snow";
  return "ground";
}
const RELIEF = { grass: 0.05, rock: 0.13, sand: 0.035, snow: 0.03, ground: 0.045 };   // metres of bumps
/** Whether a material glows, by its name: "glowing moss", "lava", "ember field" and the like. */
export function glows(name) {
  return /glow|lumin|phosph|ember|lava|magma|fire|flame|burn|radian|lantern|shin(e|ing)|spark|bright|beacon|fluores|aurora/.test(String(name || ""));
}

// One axis of a monotone cubic: through the samples, with no bump past either neighbour (no overshoot at a
// cliff's foot, so the water and the walker stay where the tile heights say).
function cubic1(p0, p1, p2, p3, t) {
  const m1 = (p2 - p0) / 2, m2 = (p3 - p1) / 2, t2 = t * t, t3 = t2 * t;
  const v = (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
  return p1 < p2 ? clamp(v, p1, p2) : clamp(v, p2, p1);
}

// The ground's noise for one seed and fineness: where each sample looks its material up (a ragged border),
// two octaves of grain, a speckle, sand ripples, and a shade per tile. Kept, since it never changes.
const grains = new Map();
function grain(W, H, S, seed) {
  const key = `${W}x${H}/${S}/${seed}`;
  if (grains.has(key)) return grains.get(key);
  const nx = (W - 1) * S + 1, nz = (H - 1) * S + 1, n = nx * nz;
  const g = { seed, wx: new Float32Array(n), wy: new Float32Array(n), n1: new Float32Array(n), n2: new Float32Array(n), sp: new Float32Array(n),
    rip: new Float32Array(n), shade: new Float32Array(W * H) };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, tx = i / S, ty = j / S;
    g.wx[k] = clamp(tx + (noise(tx * 0.9, ty * 0.9, seed) - 0.5) * 0.8, 0, W - 1.0001);
    g.wy[k] = clamp(ty + (noise(tx * 0.9 + 31.7, ty * 0.9, seed) - 0.5) * 0.8, 0, H - 1.0001);
    g.n1[k] = noise(tx * 1.7, ty * 1.7, seed + 11); g.n2[k] = noise(tx * 5.3, ty * 5.3, seed + 13); g.sp[k] = hash(i, j, seed + 17);
    g.rip[k] = Math.sin((tx + ty * 0.35) * 5.5 + g.n1[k] * 4);
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.shade[y * W + x] = 0.93 + 0.14 * hash(x, y, seed + 5);
  if (grains.size > 3) grains.clear();
  grains.set(key, g);
  return g;
}

/**
 * The ground as a terrain tile S times finer than the tiles: (W-1)*S+1 by (H-1)*S+1 samples, heights smoothed
 * between tile centres with fine bumps by material, and colours that blend across material borders along
 * a ragged edge, with grain, clumps and ripples by material, darker in hollows and where wet.
 * `wet` (0..1) is how soaked the land is from rain lately.
 */
export function groundOf(WF, world, S = 4, { wet = 0 } = {}) {
  const { W, H } = WF, h = world.height, w = world.water, m = world.mat, mats = world.materials;
  const nx = (W - 1) * S + 1, nz = (H - 1) * S + 1, n = nx * nz;
  const heights = new Float32Array(n), colors = new Float32Array(n * 3);
  const kinds = mats.map((mm) => surfaceKind(mm.name)), base = mats.map((mm) => hexLinear(mm.color));
  const hAt = (x, y) => h[clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)];
  // Hollows: how far each tile sits below its neighbours' mean (a cheap ambient occlusion).
  const hollow = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const avg = (hAt(x - 1, y) + hAt(x + 1, y) + hAt(x, y - 1) + hAt(x, y + 1)) / 4;
    hollow[y * W + x] = clamp(avg - h[y * W + x], -1, 2);
  }
  // Heights: rows first, then columns (the cubic is separable).
  const rows = new Float32Array(H * nx);
  for (let y = 0; y < H; y++) for (let i = 0; i < nx; i++) {
    const x = Math.floor(i / S), t = (i % S) / S;
    rows[y * nx + i] = t === 0 ? h[y * W + x] : cubic1(hAt(x - 1, y), hAt(x, y), hAt(x + 1, y), hAt(x + 2, y), t);
  }
  const rowAt = (y, i) => rows[clamp(y, 0, H - 1) * nx + i];
  for (let j = 0; j < nz; j++) {
    const y = Math.floor(j / S), t = (j % S) / S;
    for (let i = 0; i < nx; i++) {
      heights[j * nx + i] = t === 0 ? rowAt(y, i) : cubic1(rowAt(y - 1, i), rowAt(y, i), rowAt(y + 1, i), rowAt(y + 2, i), t);
    }
  }
  // Colours and fine relief, sample by sample. The noise depends only on the seed and fineness: made once.
  const nz_ = grain(W, H, S, (world.seed | 0) ^ 0x2c1b), seed = nz_.seed;
  const tileCol = new Float32Array(W * H * 3), tileKind = new Array(W * H), tileRelief = new Float32Array(W * H), tileGlow = new Uint8Array(W * H);
  const glowing = mats.map((mm) => glows(mm.name));
  for (let ti = 0; ti < W * H; ti++) {
    const mi = m[ti], c = base[mi] || [1, 0, 1], kd = kinds[mi] || "ground";
    // Each tile a shade of its own, and darker where it's wet.
    const shade = nz_.shade[ti], damp = w[ti] > 0.02 ? 0.68 : 1;
    tileCol[ti * 3] = c[0] * shade * damp; tileCol[ti * 3 + 1] = c[1] * shade * damp; tileCol[ti * 3 + 2] = c[2] * shade * damp;
    tileKind[ti] = kd; tileRelief[ti] = RELIEF[kd]; tileGlow[ti] = glowing[mi] ? 1 : 0;
  }
  const soakAll = 1 - 0.22 * clamp(wet, 0, 1);
  for (let k = 0; k < n; k++) {
    // A ragged border: the materials are looked up a little way off, by noise.
    const wx = nz_.wx[k], wy = nz_.wy[k], x0 = Math.floor(wx), y0 = Math.floor(wy);
    // Bilinear weights, sharpened so a tile is its own colour in its middle and blends only near its edges.
    const fx = smooth(0.18, 0.82, wx - x0), fy = smooth(0.18, 0.82, wy - y0);
    let r = 0, g = 0, b = 0, relief = 0, ao = 0, glowLift = 0, bestW = -1, kind = "ground";
    for (let q = 0; q < 4; q++) {
      const wt = ((q & 1) ? fx : 1 - fx) * ((q >> 1) ? fy : 1 - fy);
      if (wt <= 0) continue;
      const ti = (y0 + (q >> 1)) * W + x0 + (q & 1);
      r += tileCol[ti * 3] * wt; g += tileCol[ti * 3 + 1] * wt; b += tileCol[ti * 3 + 2] * wt;
      relief += tileRelief[ti] * wt; ao += hollow[ti] * wt; glowLift += tileGlow[ti] * wt;
      if (wt > bestW) { bestW = wt; kind = tileKind[ti]; }
    }
    // Grain and pattern by the main material here.
    const n1 = nz_.n1[k], n2 = nz_.n2[k], sp = nz_.sp[k];
    let v = 1, gShift = 0, bump = (n1 - 0.5) * 0.7 + (n2 - 0.5) * 0.3;
    if (kind === "grass") { v = 0.78 + 0.32 * n1 + 0.12 * (sp - 0.5); gShift = (n2 - 0.5) * 0.18; }
    else if (kind === "rock") { v = 0.8 + 0.22 * n2 + 0.22 * (sp - 0.5); bump = (n2 - 0.5) * 0.8 + (sp - 0.5) * 0.4; }
    else if (kind === "sand") { const rip = nz_.rip[k]; v = 0.94 + 0.05 * rip + 0.05 * (sp - 0.5); bump = rip * 0.5; }
    else if (kind === "snow") { v = 0.95 + 0.05 * n1; b *= 1.03 + 0.04 * (1 - n1); }
    else { v = 0.86 + 0.2 * n1 + 0.12 * (sp - 0.5); }
    const occl = clamp(1 - 0.09 * ao, 0.72, 1.06), f = v * occl * (kind === "snow" ? 1 : soakAll);
    let cr = r * f * (1 - gShift * 0.5), cg = g * f * (1 + gShift), cb = b * f;
    if (glowLift > 0) {   // glowing ground stays bright: a little more than its colour, never dark grain
      cr = mix(cr, Math.min(1, cr * 1.35 + 0.05), glowLift); cg = mix(cg, Math.min(1, cg * 1.35 + 0.05), glowLift); cb = mix(cb, Math.min(1, cb * 1.35 + 0.05), glowLift);
    }
    colors[k * 3] = cr; colors[k * 3 + 1] = cg; colors[k * 3 + 2] = cb;
    heights[k] += bump * relief;
  }
  return { nx, nz, cell: 1 / S, S, heights, colors };
}

// ---------------------------------------------------------------- water

/**
 * The water as a mesh SW times finer than the tiles, over a ground from groundOf (its heights, every S/SW-th
 * sample): depth-tinted (teal in the shallows, deep blue in pools), lighter where it flows and foaming where
 * it's fast, more see-through in the shallows. A dry vertex is tucked under the bank so the edge meets it.
 * Colours are RGBA. Only quads with some water are kept.
 */
export function waterOf(WF, world, ground, SW = 2) {
  const { W, H } = WF, h = world.height, w = world.water, f = world.flux || new Float32Array(W * H);
  const ox = -(W - 1) / 2, oz = -(H - 1) / 2, step = Math.max(1, Math.round(ground.S / SW));
  const nx = (W - 1) * SW + 1, nz = (H - 1) * SW + 1, n = nx * nz;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), wetV = new Uint8Array(n);
  const deep = [0.008, 0.035, 0.09], shallow = [0.04, 0.2, 0.22], flow = [0.12, 0.32, 0.42], foam = [0.75, 0.82, 0.86];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const tx = i / SW, ty = j / SW, x0 = Math.min(W - 2, Math.floor(tx)), y0 = Math.min(H - 2, Math.floor(ty));
    const fx = tx - x0, fy = ty - y0, a = y0 * W + x0;
    const ws = [a, a + 1, a + W, a + W + 1], wt = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    let head = 0, hw = 0, d = 0, fl = 0, wetness = 0;
    for (let q = 0; q < 4; q++) {
      const t = ws[q], on = w[t] > 0.02;
      d += w[t] * wt[q]; fl += f[t] * wt[q];
      if (on && wt[q] > 0) { head += (h[t] + w[t]) * wt[q]; hw += wt[q]; wetness += wt[q]; }
    }
    const k = j * nx + i, g = ground.heights[(j * step) * ground.nx + i * step];
    const wet = wetness > 0.3;
    wetV[k] = wet ? 1 : 0;
    pos[k * 3] = ox + tx; pos[k * 3 + 2] = oz + ty;
    pos[k * 3 + 1] = wet ? Math.max(g + 0.03, head / hw + 0.03) : g - 0.15;
    const dd = clamp(d / 1.8, 0, 1), fast = clamp(fl * 5, 0, 1), froth = smooth(0.35, 0.9, fast);
    for (let c = 0; c < 3; c++) {
      let v = mix(shallow[c], deep[c], dd);
      v = mix(v, flow[c], fast * 0.55);
      v = mix(v, foam[c], froth * 0.6);
      col[k * 4 + c] = v;
    }
    col[k * 4 + 3] = clamp(0.5 + 0.45 * dd + 0.3 * froth, 0, 1);
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    if (!(wetV[a] || wetV[b] || wetV[c] || wetV[d])) continue;
    idx.push(a, c, b, b, c, d);
  }
  // Keep only the vertices the wet quads use, so a dry map uploads next to nothing.
  const remap = new Int32Array(n).fill(-1), P = [], C = [];
  for (let k = 0; k < idx.length; k++) {
    const v = idx[k];
    if (remap[v] < 0) { remap[v] = P.length / 3; P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); C.push(col[v * 4], col[v * 4 + 1], col[v * 4 + 2], col[v * 4 + 3]); }
    idx[k] = remap[v];
  }
  return { pos: Float32Array.from(P), col: Float32Array.from(C), idx: Uint32Array.from(idx) };
}

// ---------------------------------------------------------------- animals

// Adds an ellipsoid (rx along X, ry up, rz across) at c to a mesh being built.
function ellipsoid(out, cx, cy, cz, rx, ry, rz, color, seg = 10, rings = 7, shade = null) {
  const first = out.pos.length / 3;
  for (let r = 0; r <= rings; r++) {
    const v = (r / rings) * Math.PI, sv = Math.sin(v), cv = Math.cos(v);
    for (let s = 0; s <= seg; s++) {
      const u = (s / seg) * TAU, x = Math.cos(u) * sv, z = Math.sin(u) * sv, y = cv;
      out.pos.push(cx + x * rx, cy + y * ry, cz + z * rz);
      const c = shade ? shade(x, y, z, color) : color;
      out.col.push(c[0], c[1], c[2]);
    }
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
    const a = first + r * (seg + 1) + s, b = a + 1, c = a + seg + 1, d = c + 1;
    out.idx.push(a, b, c, b, d, c);   // counter-clockwise seen from outside
  }
}

/**
 * An animal's body (without legs, which view3d.js draws as lines so they can swing): an ellipsoid trunk with
 * a lighter belly, a head with a muzzle, ears, eyes and a tail, in its species' colour, facing +X, standing
 * with its belly `LEG` metres up. The pattern shows on the body (stripes, a dark ring, a pale cross); the
 * first grazer, Mossback, wears a mossy back so it's known on sight.
 */
export const LEG = 0.34;
export function bodyMesh(look = {}, { mossy = false } = {}) {
  const out = { pos: [], col: [], idx: [] }, coat = hexLinear(look.color || "#e8d08a");
  const belly = coat.map((v) => Math.min(1, v * 1.25 + 0.04)), dark = coat.map((v) => v * 0.28), muzzle = coat.map((v) => v * 0.55 + 0.02);
  const pat = look.pattern || "dot";
  const by = LEG + 0.24;   // the trunk's centre
  ellipsoid(out, 0, by, 0, 0.5, 0.26, 0.27, coat, 12, 8, (x, y, z, c) => {
    if (y < -0.45) return belly;
    if (pat === "stripe" && Math.abs(((x + 1) * 3.5) % 1 - 0.5) < 0.17) return dark;
    if (pat === "ring" && Math.abs(x) < 0.16) return dark;
    if (pat === "cross" && y > 0.55 && (Math.abs(x) < 0.12 || Math.abs(z) < 0.18)) return belly;
    if (pat === "diamond" && y > 0.4 && Math.abs(x) + Math.abs(z) < 0.45) return dark;
    return c;
  });
  ellipsoid(out, 0.5, by + 0.17, 0, 0.19, 0.17, 0.16, coat, 10, 6);           // head
  ellipsoid(out, 0.66, by + 0.11, 0, 0.11, 0.08, 0.1, muzzle, 8, 5);         // muzzle
  ellipsoid(out, 0.75, by + 0.13, 0, 0.025, 0.025, 0.035, dark, 5, 3);       // nose
  for (const s of [-1, 1]) {
    ellipsoid(out, 0.42, by + 0.35, 0.1 * s, 0.05, 0.1, 0.04, coat, 6, 4);   // ears
    ellipsoid(out, 0.61, by + 0.23, 0.1 * s, 0.03, 0.03, 0.03, [0.01, 0.01, 0.012], 5, 3);   // eyes
  }
  ellipsoid(out, -0.52, by + 0.1, 0, 0.13, 0.06, 0.06, coat.map((v) => v * 0.85), 6, 4);   // tail
  if (mossy) {   // tufts of moss along the back
    const moss = hexLinear("#5f8f3a"), moss2 = hexLinear("#7fae4c");
    for (let k = 0; k < 7; k++) {
      const x = -0.32 + k * 0.105, z = (hash(k, 3, 7) - 0.5) * 0.12, r = 0.07 + 0.03 * hash(k, 5, 7);
      ellipsoid(out, x, by + 0.23 + 0.02 * Math.cos(x * 3), z, r * 1.3, r * 0.75, r, k & 1 ? moss : moss2, 6, 4);
    }
  }
  return { pos: Float32Array.from(out.pos), col: Float32Array.from(out.col), idx: Uint32Array.from(out.idx) };
}

/** A column-major model matrix: turn to face (hx, hz) on the ground, tilt the nose down by `pitch`, stand at (x, y, z), scaled. */
export function poseMatrix(x, y, z, heading, pitch = 0, scale = 1) {
  const hx = Math.cos(heading), hz = Math.sin(heading), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // Columns: where local X (forward, tipped down by pitch), Y (up, tipped forward) and Z (across) go.
  return [hx * cp * scale, -sp * scale, hz * cp * scale, 0,
    hx * sp * scale, cp * scale, hz * sp * scale, 0,
    -hz * scale, 0, hx * scale, 0,
    x, y, z, 1];
}

// ---------------------------------------------------------------- small lights

/**
 * Glowing ground as point lights: tiles of a glowing material gathered into 8 x 8 tile cells, one light over
 * each cell's glowing tiles, brighter for bigger patches (view3d.js brightens them at night); the biggest come first. Also where
 * motes rise from them (`spots`, a few tiles of each patch). Lights are (x, y, z, range, r, g, b, intensity, priority).
 */
export function glowsOf(WF, world) {
  const { W, H } = WF, mats = world.materials, ox = -(W - 1) / 2, oz = -(H - 1) / 2;
  const lit = mats.map((m) => glows(m.name));
  if (!lit.some(Boolean)) return { lights: [], spots: [] };
  const cells = new Map(), spots = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, mi = world.mat[i];
    if (!lit[mi] || world.water[i] > 0.3) continue;
    const key = (y >> 3) * 64 + (x >> 3);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { n: 0, x: 0, y: 0, h: 0, col: hexLinear(mats[mi].color) }));
    c.n++; c.x += x; c.y += y; c.h = Math.max(c.h, world.height[i]);
    if (hash(x, y, 91) < 0.25) spots.push([x, y, mi]);
  }
  const lights = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 16).map((c) => {
    const mx = c.x / c.n, my = c.y / c.n, peak = Math.max(...c.col), col = c.col.map((v) => Math.min(1, v / Math.max(peak, 1e-3)));
    return [ox + mx, c.h + 1.6, oz + my, 5 + Math.sqrt(c.n) * 1.6, ...col, 0.3 + Math.min(0.9, c.n / 40), Math.min(99, c.n)];
  });
  return { lights, spots: spots.slice(0, 80) };
}

/**
 * This frame's points (10 floats each, as g3_set_points takes): sun glints on still water, foam drifting on
 * fast water, fireflies over the meadows at night, motes over glowing ground, and stars. `wet` is the scene's
 * list of wet tiles with their flow (view3d.js builds it with the water), `t` seconds, `budget` 0..1 thins them.
 */
const SOFT = 1;
export function pointsOf(WF, world, sky, t, { wet = [], spots = [], budget = 1, ground = null } = {}) {
  const { W, H } = WF, ox = -(W - 1) / 2, oz = -(H - 1) / 2, out = [];
  const gAt = ground || ((x, y) => world.height[clamp(Math.round(y), 0, H - 1) * W + clamp(Math.round(x), 0, W - 1)]);
  const put = (x, y, z, px, m, r, g, b, a, flags = SOFT) => { if (a > 0.01) out.push(x, y, z, px, m, r, g, b, Math.min(1, a), flags); };
  const raining = world.weather && world.weather.raining;
  // Glints: a sparkle now and then on still or slow water, while the sun is up.
  if (sky.day > 0.05 && !raining) {
    const n = Math.min(wet.length, Math.round(90 * budget));
    for (let k = 0; k < n; k++) {
      const s = wet[Math.floor(hash(k, 1, 33) * wet.length)];
      if (s.flux > 0.12) continue;
      const ph = hash(k, 2, 33), cyc = t * (0.5 + ph) + ph * 10, f = cyc - Math.floor(cyc), seed = Math.floor(cyc);
      const jx = (hash(k, seed, 35) - 0.5) * 0.9, jy = (hash(k, seed, 36) - 0.5) * 0.9;
      const a = Math.sin(f * Math.PI) ** 6 * sky.day * (0.6 + 0.4 * sky.dusk);
      put(ox + s.x + jx, s.top + 0.05, oz + s.y + jy, 3, 0.12, 1, mix(0.95, 0.75, sky.dusk), mix(0.85, 0.5, sky.dusk), a);
    }
  }
  // Foam: flecks carried along fast water, each fading in and out over its run.
  let foam = 0;
  for (const s of wet) {
    if (s.flux < 0.1 || foam > 160 * budget) continue;
    const many = s.flux > 0.25 ? 2 : 1;
    for (let q = 0; q < many; q++) {
      const ph = hash(s.x * 3 + q, s.y, 41), run = (t * (0.6 + s.flux * 3) + ph) % 1, a = Math.sin(run * Math.PI);
      const px = s.x + s.dx * (run - 0.5) + (hash(s.x, s.y + q, 43) - 0.5) * 0.6, py = s.y + s.dy * (run - 0.5) + (hash(s.x + q, s.y, 44) - 0.5) * 0.6;
      const l = sky.light;
      put(ox + px, s.top + 0.06, oz + py, 2, 0.16, 0.85 * l + 0.05, 0.9 * l + 0.05, 0.92 * l + 0.06, 0.75 * a);
      foam++;
    }
  }
  // Fireflies: at night, drifting low over the grass near the middle of the map.
  if (sky.night > 0.3 && !raining) {
    const n = Math.round(36 * budget), meadow = world.materials.findIndex((m) => /meadow|grass|moss/.test(m.name));
    for (let k = 0; k < n; k++) {
      const hx = hash(k, 7, 51) * (W - 1), hy = hash(k, 8, 51) * (H - 1);
      const i = clamp(Math.round(hy), 0, H - 1) * W + clamp(Math.round(hx), 0, W - 1);
      if (meadow >= 0 && world.mat[i] !== meadow) continue;
      if (world.water[i] > 0.05) continue;
      const x = hx + Math.sin(t * 0.37 + k) * 1.2, y = hy + Math.cos(t * 0.29 + k * 1.7) * 1.2;
      const blink = Math.max(0, Math.sin(t * (1.3 + hash(k, 9, 51)) + k * 2.1)) ** 3;
      put(ox + x, gAt(x, y) + 0.6 + 0.4 * Math.sin(t * 0.8 + k), oz + y, 4, 0.12, 0.75, 1, 0.35, blink * smooth(0.3, 0.8, sky.night));
    }
  }
  // Motes rising from glowing ground, more by night.
  for (let k = 0; k < spots.length && k < 80 * budget; k++) {
    const [x, y, mi] = spots[k], c = hexLinear(world.materials[mi] ? world.materials[mi].color : "#ffffff");
    const peak = Math.max(...c, 1e-3), rise = (t * 0.25 + hash(x, y, 61)) % 1;
    put(ox + x + Math.sin(t + k) * 0.25, gAt(x, y) + 0.2 + rise * 2.2, oz + y + Math.cos(t * 0.7 + k) * 0.25, 3, 0.22,
      c[0] / peak, c[1] / peak, c[2] / peak, Math.sin(rise * Math.PI) * (0.35 + 0.65 * sky.night));
  }
  // Stars on a dome far above, as the light goes.
  const stars = sky.night * (raining ? 0.15 : 1);
  if (stars > 0.02) {
    for (let k = 0; k < Math.round(220 * budget); k++) {
      const u = hash(k, 1, 71) * TAU, v = Math.acos(1 - hash(k, 2, 71) * 0.92), R = 420;
      const tw = 0.7 + 0.3 * Math.sin(t * (1 + hash(k, 3, 71) * 2) + k), big = hash(k, 4, 71);
      put(Math.cos(u) * Math.sin(v) * R, Math.cos(v) * R * 0.8 + 20, Math.sin(u) * Math.sin(v) * R,
        big > 0.93 ? 3.4 : 2.2, 0, 0.9, 0.93, 1, stars * tw * (0.45 + 0.55 * big), SOFT);
    }
  }
  return Float32Array.from(out);
}
