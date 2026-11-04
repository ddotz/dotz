/* ---------- the conversation as last drawn, kept on this device ---------- */
// A cold start paints the conversation it opens from here (index.html reads the record into window.__snap before this script is parsed) and the network
// refreshes it behind (loadTarget quiet). sw.js puts the newest messages in as a push arrives, so a tap finds the very message. One record per conversation, in
// this origin's IndexedDB, the same words the page already holds; a device that lost its access drops it (01-forbidden-pair.js, 25-settings-devices.js).
// Local command rows, mail and another computer's conversations stay out of it.
// 홈 has one record too (key ~home): the state and what waits on the owner, so a computer switch lands on a drawn 홈 even while that gateway is slow to answer
// (measured 2026-11-05: the shell is on screen in 70 ms, the first state took 340-1690 ms from a Mac mini short of memory). The real answers replace it.
const SNAP_MSGS = 60, SNAP_ACTS = 120, SNAP_KEEP = 8, SNAP_MRU = "dotz-snap-mru", SNAP_WAIT_MS = 150;
const snapDb = () => new Promise((res, rej) => {
  const q = indexedDB.open("dotz-snap", 1);
  q.onupgradeneeded = () => q.result.createObjectStore("conv");
  q.onsuccess = () => res(q.result);
  q.onerror = () => rej(q.error);
});
const snapDone = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
let snapTimer = 0, snapGone = false;
const snapOk = t => !snapGone && !isMailT(t) && !pqPc(t);
function snapSoon(t) { clearTimeout(snapTimer); snapTimer = setTimeout(() => snapSave(t), 1500); }
async function snapSave(t) {
  const s = ts(t);
  if (!snapOk(t) || !s.hLoaded || !s.msgs.length) return;
  try {
    const db = await snapDb();
    const mru = [t, ...JSON.parse(localStorage.getItem(SNAP_MRU) || "[]").filter(k => k !== t)];
    localStorage.setItem(SNAP_MRU, JSON.stringify(mru.slice(0, SNAP_KEEP)));
    const os = db.transaction("conv", "readwrite").objectStore("conv"), gap = [...s.gaps].sort().at(-1) || "";   // only the newest stretch: a record has no gaps
    os.put({ v: 1, t, at: Date.now(), msgs: s.msgs.filter(e => e.source !== "local" && e.ts > gap).slice(-SNAP_MSGS), acts: s.acts.slice(-SNAP_ACTS), hmore: s.hmore || !!gap || s.msgs.length > SNAP_MSGS, amore: s.amore || s.acts.length > SNAP_ACTS, ahist: s.ahist, todo: TD.by[t], read: READ[t] || "" }, t);
    for (const k of await snapDone(os.getAllKeys())) if (k !== SNAP_HOME && !mru.slice(0, SNAP_KEEP).includes(k)) os.delete(k);
    db.close();
  } catch (e) { console.warn("snapshot", e); }
}
const snapForget = () => { snapGone = true; clearTimeout(snapTimer); try { indexedDB.deleteDatabase("dotz-snap"); localStorage.removeItem(SNAP_MRU); } catch {} };
// The record joins the store as a first answer would, unless the real one got here first. True when the conversation was drawn from it.
async function snapSeed(t) {
  const rec = await Promise.race([window.__snap, new Promise(r => setTimeout(r, SNAP_WAIT_MS))]);
  const s = ts(t);
  if (!rec || rec.v !== 1 || rec.t !== t || t !== target || s.hLoaded || !rec.msgs.length) return false;
  const seed = s.seed = { msgs: new Set(), acts: new Set() };
  for (const e of rec.msgs) { const k = msgKey(e); if (!s.mk.has(k)) { s.mk.add(k); s.msgs.push(e); seed.msgs.add(k); } }
  for (const a of rec.acts) { const k = actKey(a); if (!s.ak.has(k)) { s.ak.add(k); s.acts.push(a); seed.acts.add(k); } }
  s.msgs.sort(byTs); s.acts.sort(byTs);
  if (isFixedT(t)) dedupKeyed(s);
  s.hmore = rec.hmore; s.amore = rec.amore; s.ahist = rec.ahist;
  if (TD.by[t] === undefined && rec.todo) TD.by[t] = rec.todo;
  if (READ[t] === undefined && rec.read) READ[t] = rec.read;
  CV.seeded = true;
  renderAll();
  return true;
}
// The first real answer settles what the record said: a stored row it does not hold goes (removed since, or older than a gap the paging could never fill).
// True when one went, so a quiet refresh redraws.
function snapSettle(s, kind, real) {
  const seed = s.seed && s.seed[kind];
  if (!seed) return false;
  const [keyOf, keys] = kind === "msgs" ? [msgKey, s.mk] : [actKey, s.ak], keep = new Set(real.map(keyOf)), had = s[kind].length;
  s[kind] = s[kind].filter(e => { const k = keyOf(e), out = seed.has(k) && !keep.has(k); if (out) keys.delete(k); return !out; });
  s.seed[kind] = null;
  return s[kind].length !== had;
}
const SNAP_HOME = "~home", SNAP_HOME_EVERY_MS = 30_000, SNAP_HOME_WAIT_MS = 40, SNAP_HOME_MAX_MS = 7 * 24 * 3600_000;
let snapHomeAt = 0;
// Only real answers are kept: the state of this gateway (never its pending logins) and the notices 홈 shows as 답변 필요.
async function snapHomeSave() {
  if (snapGone || !S || S.seeded || !NT.loaded) return;
  snapHomeAt = Date.now();
  try {
    const db = await snapDb();
    db.transaction("conv", "readwrite").objectStore("conv").put({ v: 1, at: snapHomeAt, state: { ...S, auth: [] }, notices: NT.items.filter(ntNeeds).slice(0, 40), unread: NT.unread }, SNAP_HOME);
    db.close();
  } catch (e) { console.warn("snapshot", e); }
}
const snapHomeSoon = () => { if (Date.now() - snapHomeAt >= SNAP_HOME_EVERY_MS) snapHomeSave(); };
// Before the first draw: S and the notices as last seen here. Nothing but the first real answers replaces them; the connection line and the build check wait for those.
async function snapHomeSeed() {
  const rec = await Promise.race([window.__snapHome, new Promise(r => setTimeout(r, SNAP_HOME_WAIT_MS))]);
  if (!rec || rec.v !== 1 || S || Date.now() - rec.at > SNAP_HOME_MAX_MS) return;
  S = { ...rec.state, seeded: true };
  if (!NT.loaded) { NT.items = rec.notices; NT.unread = rec.unread; }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { snapSave(target); snapHomeSave(); } });
