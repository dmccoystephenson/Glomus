// World slots on the page: save this world to a named slot the local server keeps, or open one.
// Another program on this computer that holds the access token can read and write the same slots, so a world can
// be carried there and back. Names and labels come from the server and are set with textContent only.
//
// The page remembers which slot its world came from or went to, and that slot's revision. Saving over a slot that
// someone else wrote since asks you to press again; opening a slot keeps the world it replaces, so it can be put back.

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Turns typed text into a slot name, or "" when nothing usable is left. */
export function slotName(text) {
  const name = String(text || "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/^[-_]+/, "").slice(0, 40);
  return NAME.test(name) ? name : "";
}

/** "3 min ago" and the like, from an ISO time. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "at an unknown time";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(t).toLocaleDateString();
}

/**
 * opts: { token, key, getWorld() -> a world.js save, setWorld(save) -> throws if it can't be loaded,
 *         button, dialog } where key is this page's own save key (the link and the backup live beside it).
 */
export function mountSlots({ token, key, getWorld, setWorld, button, dialog }) {
  const LINK = key + ".slot", BEFORE = key + ".before-open";
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const q = (sel) => dialog.querySelector(sel);
  const nameBox = q("[data-slot-name]"), list = q("[data-slot-list]"), note = q("[data-slot-note]");
  const saveBtn = q("[data-slot-save]"), backBtn = q("[data-slot-back]"), closeBtn = q("[data-slot-close]");
  let slots = [], armed = null;   // armed: {kind: "save"|"open", name, base}

  const say = (text) => { note.textContent = text; };
  const link = () => { try { const l = JSON.parse(localStorage.getItem(LINK) || "null"); return l && NAME.test(l.name) ? l : null; } catch { return null; } };
  const setLink = (name, rev) => { try { localStorage.setItem(LINK, JSON.stringify({ name, rev })); } catch { /* storage blocked: no link */ } };
  const before = () => { try { return localStorage.getItem(BEFORE); } catch { return null; } };

  async function call(path, body) {
    let res;
    try {
      res = await fetch(path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Glomus-Token": token },
        body: body ? JSON.stringify(body) : undefined });
    } catch { return { ok: false, message: "The game server isn't running." }; }
    if (res.status === 403) return { ok: false, message: "The game server no longer recognizes this page. Reload the page to reconnect." };
    try { return await res.json(); } catch { return { ok: false, message: "The server said " + res.status + "." }; }
  }

  function render() {
    const mine = link();
    list.replaceChildren();
    if (!slots.length) list.append(el("li", "empty", "No slots yet. Name one above and save this world to it."));
    for (const s of slots) {
      const li = el("li", mine && mine.name === s.name ? "linked" : "");
      li.append(el("strong", "", s.name), el("span", "meta", ` · ${Math.floor((s.tick || 0) / 10 / 60)} min of world time · saved by ${s.savedBy} ${ago(s.savedAt)}`));
      const open = el("button", "small", armed && armed.kind === "open" && armed.name === s.name ? "Press again: this world is replaced" : "Open");
      open.type = "button";
      open.onclick = () => openSlot(s.name);
      li.append(" ", open);
      list.append(li);
    }
    saveBtn.textContent = armed && armed.kind === "save" ? "Press again to replace it" : "Save to slot";
    backBtn.hidden = !before();
  }

  async function refresh() {
    const r = await call("/api/worlds");
    if (!r.ok) { say(r.message || "The slots couldn't be listed."); slots = []; }
    else slots = (r.slots || []).filter((s) => s && NAME.test(String(s.name)));
    render();
  }

  async function save() {
    const name = slotName(nameBox.value);
    if (!name) { say("Name the slot: lowercase letters, digits, - or _."); nameBox.focus(); return; }
    nameBox.value = name;
    const mine = link();
    let base = mine && mine.name === name ? mine.rev : null;
    if (armed && armed.kind === "save" && armed.name === name) base = armed.base;
    armed = null;
    const r = await call("/api/worlds/" + name, { world: getWorld(), by: "the Glomus page", base });
    if (r.ok) { setLink(name, r.rev); say(`Saved to ${name}.`); await refresh(); return; }
    if (r.error === "conflict" && r.current) {
      armed = { kind: "save", name, base: r.current.rev };
      say(`${name} was saved by ${r.current.savedBy} ${ago(r.current.savedAt)}. Press again to replace it (its last world is kept by the server).`);
    } else say(r.message || "That slot couldn't be saved.");
    render();
  }

  async function openSlot(name) {
    if (!(armed && armed.kind === "open" && armed.name === name)) {
      armed = { kind: "open", name }; say(`Opening ${name} replaces this world. You can put this one back afterwards.`); render(); return;
    }
    armed = null;
    const r = await call("/api/worlds/" + name);
    if (!r.ok) { say(r.message || "That slot couldn't be opened."); render(); return; }
    try { localStorage.setItem(BEFORE, JSON.stringify(getWorld())); }
    catch { say("This browser can't keep a copy of the world you have, so the slot wasn't opened."); render(); return; }
    try { setWorld(r.world); } catch { say(`${name} couldn't be read by this version, so nothing changed.`); render(); return; }
    setLink(name, r.rev);
    say(`Opened ${name}, saved by ${r.savedBy} ${ago(r.savedAt)}.`);
    render();
  }

  function putBack() {
    const raw = before();
    if (!raw) return;
    const now = JSON.stringify(getWorld());
    try { setWorld(JSON.parse(raw)); } catch { say("The kept world couldn't be read."); return; }
    try { localStorage.setItem(BEFORE, now); } catch { /* the swap back is best effort */ }
    say("Put back the world you had. Press again to swap back.");
    render();
  }

  saveBtn.onclick = save;
  backBtn.onclick = putBack;
  closeBtn.onclick = () => dialog.close();
  nameBox.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
  button.onclick = () => {
    if (!token) { alert("World slots need the game server (npm start)."); return; }
    armed = null; say("");
    const mine = link();
    if (mine && !nameBox.value) nameBox.value = mine.name;
    dialog.showModal(); refresh();
  };
  return { refresh };
}
