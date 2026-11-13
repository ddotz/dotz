/* ---------- 분할 창 (docs/split-panes.md): the model ----------
   A split exists only on the chat tab, and a pane holds only what a row of the chat list opens (owner 8f7c8c3d): a conversation, or a KakaoTalk room of the
   chat list's 메일 · 카카오톡 card. Panes are leaves {id, kind: "chat"|"app", t, at, stick, dot} (an app pane is that KakaoTalk room in 모니터링's own screen:
   t is "i:kakao#kk:<room>") of a tree: one pane, or two side by side as {dir: "row", a, b, r} (r = a's share, 0.2..0.8;
   at most two, left and right only, owner 950d715f);
   one is active and holds the real section. The screen is 43-panes-view.js, the inactive panes are 43-panes-mirror.js. With one pane (or none) nothing here touches the page. */
const PANE_KEY = "dotz-panes", PANE_MAX = 2;
let PN = { root: null, active: "", seq: 0 };
const paneLeaf = n => !n.dir;
function paneLeaves(n = PN.root) { return !n ? [] : paneLeaf(n) ? [n] : [...paneLeaves(n.a), ...paneLeaves(n.b)]; }
function paneCount() { return paneLeaves().length; }
function paneList() { return paneLeaves().map(p => ({ id: p.id, kind: p.kind, t: p.t, active: p.id === PN.active })); }
const paneFind = id => paneLeaves().find(p => p.id === id) || null;
const paneOpenIn = (kind, t) => paneLeaves().find(p => p.kind === kind && p.t === t) || null;
const paneNew = (kind, t) => ({ id: `p${++PN.seq}`, kind, t, at: null, stick: true, dot: "" });
// The KakaoTalk room of an app pane: t is "i:kakao#kk:<room>". Nothing else of 모니터링 is a pane.
const paneKkT = id => `${KK_KEY}#kk:${enc(id)}`;
const paneKkId = t => (String(t).startsWith(`${KK_KEY}#kk:`) ? decodeURIComponent(String(t).slice(KK_KEY.length + 4)) : "");
// What a pane can hold: a conversation, or a KakaoTalk room.
const paneCanHold = (kind, t) => (kind === "chat" ? validTarget(t) : kind === "app" && !!paneKkId(t));
// The chat tab is lit: the conversation view (not a mail opened from 모니터링), or 모니터링's screen lent to an app pane (PN.app, set by paneGoApp,
// cleared by the next go() that does not come from a pane).
const paneTabOk = () => (current === "chat" && !monCtx) || (current === "monitoring" && !!PN.app && paneCount() > 1 && paneFind(PN.active).kind === "app");
// Opens a KakaoTalk room's app pane: 모니터링 on 카카오톡 with that room, and the tab stays 채팅 (43-panes-view.js paneLit).
function paneGoApp(t) {
  const id = paneKkId(t);
  PN.going = true; PN.app = true;
  try {
    go("monitoring", KK_KEY);
    if (id) kkOpen(id);
  } finally { PN.going = false; }
  const p = paneFind(PN.active);
  if (p && p.kind === "app") { p.t = paneKkT(id); paneHeadSync(); panePersist(); }
}
// What the page shows now, as a pane's content.
const paneHere = () => (current === "monitoring" ? { kind: "app", t: KK.open ? paneKkT(KK.open) : (paneFind(PN.active) || {}).t || "" } : { kind: "chat", t: target });
// A row of the chat list pressed while the panes are shown opens in the active pane (a pane that already shows it only takes the focus), and the tab stays 채팅.
function paneRowOpen(kind, t) {
  if (paneCount() < 2 || !paneTabOk() || !PNV.el || PNV.el.hidden) return false;
  const dup = paneOpenIn(kind, t);
  if (dup) paneFocus(dup.id); else paneReplace(PN.active, t, kind);
  return true;
}
// go() keeps a mail a pane shows in the chat view (the chat tab lit, the chat list), where a mail opened by itself belongs to 모니터링.
const paneKeeps = t => !!PN.going || (paneCount() > 1 && !narrowChat() && !!paneOpenIn("chat", t));
// A conversation is opened by the pane machinery, so go() keeps the chat tab and the chat list even for a mail (05-command-palette.js).
function paneGo(kind, t) {
  if (kind === "app") { paneGoApp(t); return; }
  PN.going = true;
  try { go("chat", t); } finally { PN.going = false; }
}
function paneParent(n, p) {
  if (paneLeaf(n)) return null;
  return n.a === p || n.b === p ? n : paneParent(n.a, p) || paneParent(n.b, p);
}
function paneSwap(old, next) {
  const par = paneParent(PN.root, old);
  if (!par) PN.root = next; else if (par.a === old) par.a = next; else par.b = next;
}
function panePersist() {
  try {
    if (paneCount() < 2) localStorage.removeItem(PANE_KEY);
    else localStorage.setItem(PANE_KEY, JSON.stringify({ root: PN.root, active: PN.active, seq: PN.seq }));
  } catch { /* storage blocked: the layout only lasts until reload */ }
}

// Opens t next to the active pane, or next to pane atId (side: right | left). A target already open in a pane is not opened twice: that pane becomes active.
// The one place that refuses what a pane cannot hold and a split outside the chat tab.
function paneSplit(t, kind, side, atId = "") {
  if (!paneCanHold(kind, t) || !paneTabOk()) return "";
  if (paneCount() < 2) {
    const h = paneHere();
    PN.root = paneNew(h.kind, h.t); PN.active = PN.root.id;
  }
  const dup = paneOpenIn(kind, t);
  if (dup) { paneFocus(dup.id); return dup.id; }
  if (paneCount() >= PANE_MAX) return "";
  const at = paneFind(atId) || paneFind(PN.active), np = paneNew(kind, t), first = side === "left";
  paneSwap(at, { dir: "row", a: first ? np : at, b: first ? at : np, r: 0.5 });
  paneFocus(np.id);
  return np.id;
}
function paneReplace(id, t, kind) {
  const p = paneFind(id);
  if (!p || !paneCanHold(kind, t) || !paneTabOk()) return false;
  const dup = paneOpenIn(kind, t);
  if (dup && dup !== p) { paneFocus(dup.id); return false; }
  if (p.kind === kind && p.t === t) return true;
  Object.assign(p, { kind, t, at: null, stick: true, dot: "" });
  paneForget(p.id);
  if (p.id === PN.active) paneEnter(p); else paneSync();
  panePersist();
  return true;
}
function paneFocus(id) {
  const p = paneFind(id);
  if (!p || p.id === PN.active) return;
  paneLeave(paneFind(PN.active));
  PN.active = p.id; p.dot = "";
  paneEnter(p);
  panePersist();
}
// A pane dragged by its head: onto the middle of another pane the two swap places, onto an edge (side) it moves next to that pane.
function paneMove(id, dst, side) {
  const x = paneFind(id), y = paneFind(dst);
  if (!x || !y || x === y) return false;
  if (side === "center") {
    const px = paneParent(PN.root, x), py = paneParent(PN.root, y);
    if (px === py) [px.a, px.b] = [px.b, px.a];
    else {
      if (px.a === x) px.a = y; else px.b = y;
      if (py.a === y) py.a = x; else py.b = x;
    }
  } else {
    const par = paneParent(PN.root, x), first = side === "left";
    paneSwap(par, par.a === x ? par.b : par.a);
    paneSwap(y, { dir: "row", a: first ? x : y, b: first ? y : x, r: 0.5 });
  }
  paneSync();
  panePersist();
  return true;
}
function paneClose(id) {
  const p = paneFind(id);
  if (!p || paneCount() < 2) return false;
  const par = paneParent(PN.root, p), sib = par.a === p ? par.b : par.a;
  paneSwap(par, sib);
  paneForget(id);
  if (PN.active === id) {
    const next = paneLeaves(sib)[0];
    PN.active = next.id; next.dot = "";
    paneEnter(next);
  } else paneSync();
  panePersist();
  return true;
}

// A saved layout {root, active, seq} as a live tree: panes whose target is gone or already shown are dropped, the first PANE_MAX stay, side by side
// (a layout saved with three or four panes, or one above another, before 950d715f). null when nothing is left.
function panePrune(d) {
  if (!d || !d.root) return null;
  const ok = p => p && typeof p.t === "string" && paneCanHold(p.kind, p.t);   // what the chat list can open; a project or 모니터링 screen of an older layout is dropped
  const seen = new Set();
  let left = PANE_MAX;
  const prune = n => {
    if (!n || typeof n !== "object") return null;
    if (n.dir) {
      const a = prune(n.a), b = prune(n.b);
      return !a ? b : !b ? a : { dir: n.dir === "col" ? "col" : "row", a, b, r: Math.min(0.8, Math.max(0.2, Number(n.r) || 0.5)) };
    }
    const key = `${n.kind}|${n.t}`;
    if (!ok(n) || seen.has(key) || left < 1) return null;
    seen.add(key); left--;
    return { id: String(n.id), kind: n.kind, t: n.t, at: n.at && n.at.ts ? { ts: String(n.at.ts), off: Number(n.at.off) || 0 } : null, stick: n.stick !== false, dot: "" };
  };
  const tree = prune(d.root);
  if (!tree) return null;
  const lv = paneLeaves(tree), root = lv.length < 2 ? lv[0] : { dir: "row", a: lv[0], b: lv[1], r: tree.dir === "row" && tree.a === lv[0] ? tree.r : 0.5 };
  return { root, active: (lv.find(p => p.id === d.active) || lv[0]).id, seq: Math.max(Number(d.seq) || 0, ...lv.map(p => Number(p.id.slice(1)) || 0)) };
}
// The saved layout, after the first go(): the page keeps what it shows (the active pane takes it over, paneSync).
function paneRestore() {
  const d = lsJson(PANE_KEY, null);   // a broken value is no layout
  const r = panePrune(d);
  if (!r) return;
  PN = r;
  paneSync();
  panePersist();
}
// The chat tab pressed again after another tab: the panes come back as they were, the active one's content opened again.
// A relayed computer chosen off the chat (44-relay-views.js relayShow) sits in no pane: the tab opens its chat, not what the active pane held.
function paneReturn() {
  if (paneCount() < 2 || narrowChat() || (isRelayT(target) && !paneOpenIn("chat", target))) return false;
  if (!paneTabOk()) paneEnter(paneFind(PN.active));
  return true;
}
// go() asks before it leaves the chat tab: the reader's place in the active conversation is kept for the way back.
function paneStash() {
  const p = PNV.el && !PNV.el.hidden && current === "chat" && paneFind(PN.active);
  if (p && p.kind === "chat") { p.at = chatAnchor(); p.stick = chatStick; }
}
