// World slots: named worlds kept on disk by the local server, so a world can be carried between this page and
// another program on this computer that holds the access token. A slot holds one world in world.js's own save
// format (version 1), plus who last wrote it and when.
//
//   workspace/worlds/<name>.json           {format, v, name, rev, savedAt, savedBy, tick, world}
//   workspace/worlds/previous/<name>.json  the world a write replaced, one deep, so a replace is never a loss
//
// A write that would replace a slot must name the revision it replaces (`base`), so two writers can't overwrite
// each other by accident: a stale or missing `base` is a conflict, answered with what's there now.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FORMAT = "glomus-world-slot";
export const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const REV = /^[0-9a-f]{12}$/;
export const MAX_SLOT_BYTES = 1_000_000;   // a saved world is about 140 KB
export const MAX_SLOTS = 64;
export const MAX_BY = 40;

/** A writer's label, cut to one short printable line. */
export function cleanBy(by) {
  const text = String(by ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_BY);
  return text || "unknown";
}

class SlotError extends Error {
  constructor(status, error, message, extra = {}) { super(message); Object.assign(this, { status, error, extra }); }
}
export { SlotError };

/** A slot store in `dir`. `WF` is world.js; `now` gives the time (tests pass their own). */
export function createStore(dir, { WF, now = () => new Date() } = {}) {
  const file = (name) => path.join(dir, name + ".json");
  const previous = (name) => path.join(dir, "previous", name + ".json");

  function checkName(name) {
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new SlotError(400, "bad_name", "A slot name is 1 to 40 lowercase letters, digits, - or _, starting with a letter or digit.");
    }
    return name;
  }

  function readFile(name) {
    let raw;
    try { raw = fs.readFileSync(file(name)); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    if (raw.length > MAX_SLOT_BYTES + 4096) throw new SlotError(500, "damaged", "That slot is too large to read.");
    let slot;
    try { slot = JSON.parse(raw.toString("utf8")); } catch { throw new SlotError(500, "damaged", "That slot's file is damaged."); }
    if (!slot || slot.format !== FORMAT || slot.v !== 1 || slot.name !== name || !REV.test(String(slot.rev))) {
      throw new SlotError(500, "damaged", "That slot's file is damaged.");
    }
    return slot;
  }

  const meta = (slot) => ({ name: slot.name, rev: slot.rev, savedAt: slot.savedAt, savedBy: cleanBy(slot.savedBy), tick: Number(slot.tick) || 0 });

  function names() {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
    return entries.filter((f) => f.endsWith(".json") && NAME.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort();
  }

  /** Every readable slot's name, revision, writer, time and world clock. A damaged file is left out, never removed. */
  function list() {
    const out = [];
    for (const name of names()) {
      try { const slot = readFile(name); if (slot) out.push(meta(slot)); } catch { /* damaged: skip it */ }
    }
    return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  }

  function read(name) {
    const slot = readFile(checkName(name));
    if (!slot) throw new SlotError(404, "not_found", "There's no slot by that name.");
    return { ...meta(slot), world: slot.world };
  }

  /** Writes `world` (a world.js save) to the slot. `base` is the revision being replaced (null for a new slot). */
  function write(name, { world, by, base = null } = {}) {
    checkName(name);
    let clean;
    try { clean = WF.save(WF.load(world)); } catch { throw new SlotError(400, "bad_world", "That isn't a world this version can read."); }
    const current = readFile(name);
    if (current ? base !== current.rev : base !== null && base !== undefined) {
      throw new SlotError(409, "conflict", current ? "The slot changed since you last opened or saved it." : "That slot no longer exists.",
        { current: current ? meta(current) : null });
    }
    if (!current && names().length >= MAX_SLOTS) throw new SlotError(507, "full", `There are already ${MAX_SLOTS} slots.`);
    const slot = { format: FORMAT, v: 1, name, rev: crypto.randomBytes(6).toString("hex"), savedAt: now().toISOString(),
      savedBy: cleanBy(by), tick: Number(clean.tick) || 0, world: clean };
    const raw = Buffer.from(JSON.stringify(slot));
    if (raw.length > MAX_SLOT_BYTES) throw new SlotError(413, "too_large", "That world is too large to keep in a slot.");
    fs.mkdirSync(path.join(dir, "previous"), { recursive: true, mode: 0o700 });
    if (current) fs.copyFileSync(file(name), previous(name));
    const tmp = file(name) + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, raw, { mode: 0o600 });
    fs.renameSync(tmp, file(name));
    return meta(slot);
  }

  return { list, read, write, checkName };
}
