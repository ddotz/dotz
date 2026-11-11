/* ---------- back navigation: the browser history is the app's layer stack (Android back gesture, desktop back/forward) ---------- */
// Every history entry the app owns carries {dz:1, c, ov, g?}:
//   c   the routes in the order they were stacked, up to and including the entry's own view; entry i of the stack has c.length === i + 1
//   w   the chain of routes from 홈 down to the entry's own view, e.g. ["home","chat/list","chat/main"]; it equals c until a tab or an item is pressed beside the view the entry sat on
//   ov  how many overlays (sheet, menu, dialog) are open on top of that view; each one is an entry of its own
//   g   the exit guard under 홈 (installed app only): back from 홈 lands on it, shows the toast, and a second back leaves
// go() computes the chain it wants (H.want) and histSync() makes the real stack match: push to go deeper, replace to move sideways
// (tab to tab, item to item) and history.go(-n) to go up. A press beside the current view stacks a new entry on top of it, so back returns to the
// view that was showing (same tab, same item); back ends at 홈 and then leaves.
// An entry's popstate restores its w, not its c.
// The 홈 tab is a tab like the others (H.tab): pressing it stacks 홈 on the view that was showing, where the app bar's back goes up to the entry below.
// A row of the chat or mail list stacks too (setTarget(t, true) leaves the entry to go()); the switcher menu and a pane coming forward replace in place.
const OV = [];   // open overlays, bottom first: {close} (close runs the overlay's own close path, which calls ovDone)
const H = { want: ["home"], hash: "home", hold: 0, moving: 0, tries: 0, timer: 0, guardTimer: 0, fromHist: null, auto: false, tab: false };   // tab: the 홈 tab was pressed (33-peers.js), which is a move beside the view, not a move up
const hstate = (c, ov = 0, w = c) => ({ dz: 1, c, ov, w });
const hurl = c => `#${c[c.length - 1]}`;

// The chain of routes for a view, computed when the app navigates by itself (a back/forward uses the entry's stored chain).
function routeChain(name, hash) {
  if (name === "home") return ["home"];
  if (NSC.ret && name !== "notices") return ["home", "notices", hash];
  const conv = n => narrowChat() ? ["home", "chat/list", `${n}/${target}`] : ["home", `${n}/${target}`];
  // A conversation opened from 모니터링 (a mail of the 메일 list): back returns to that item's list, on a wide screen too (owner 2026-10-27).
  if (monCtx && (name === "chat" || name === "activity")) return MON.sel && !monChatIt() ? ["home", "monitoring", `monitoring/${enc(MON.sel)}`, hash] : ["home", "monitoring", hash];
  if (name === "chat" || name === "activity") return narrowChat() ? (chatList ? ["home", hash] : ["home", "chat/list", hash]) : ["home", hash];
  if (name === "harness") return ["home", "settings", hash];
  if (name === "project") return ppWide() ? ["home", hash] : ["home", "projects", hash];   // wide: the list sits beside the pane, it is not a screen of its own
  if (name === "monitoring") return !MON.list ? ["home", "monitoring", ...mxChain(hash)] : ["home", hash];
  if (SUB.has(name)) {
    const bt = backTarget();
    if (bt === "home") return ["home", hash];
    if (bt === "messengers") return ["home", "settings", bt, hash];
    if (bt === "chat" || bt === "activity") return [...conv(bt), hash];
    return ["home", bt === "project" ? "projects" : bt, hash];
  }
  return ["home", hash];
}
function navSync(name, hash) {
  H.hash = hash;
  H.want = H.fromHist ? [...H.fromHist.slice(0, -1), hash] : routeChain(name, hash);
  H.fromHist = null;
  histSync();
  H.auto = H.tab = false;
}
// A route changed its own hash without changing level (a conversation picked from the switcher, a project map opened).
function routeReplace(hash) {
  const S = history.state;
  if (!S || !S.dz || S.g) { history.replaceState(S, "", `#${hash}`); return; }
  history.replaceState({ ...S, c: [...S.c.slice(0, -1), hash], w: [...(S.w || S.c).slice(0, -1), hash] }, "", `#${hash}`);
  H.hash = hash; H.want = [...H.want.slice(0, -1), hash];
}

// An entry remembers where its screen was scrolled when something is stacked on top of it, and gets it back when the browser's back returns to it.
const scrollKeep = S => history.replaceState({ ...S, sy: { v: $("#views").scrollTop, m: ($("#mon-timeline") || {}).scrollTop | 0 } }, "", hurl(S.c));
function scrollBack(S) { if (!S || !S.sy || (S.w || S.c).length < 2) return;   // 홈 always opens at its top (08-home.js homeTop)
  $("#views").scrollTop = S.sy.v; const m = $("#mon-timeline"); if (m) m.scrollTop = S.sy.m; }
// Stacks W[from..] one entry each on top of the stack C (stacked order c, logical chain w).
// H.auto: the last view was opened by the app (a list's own first pane), not pressed by the user: the entry is marked a.
const pushChain = (W, from, C) => {
  for (let i = from; i < W.length; i++) {
    const s = hstate([...C, ...W.slice(from, i + 1)], 0, W.slice(0, i + 1));
    if (H.auto && i === W.length - 1) s.a = 1;
    history.pushState(s, "", `#${W[i]}`);
  }
};
function histMove(n) {
  if (++H.tries > 6) { H.tries = 0; history.replaceState(hstate(H.want), "", hurl(H.want)); return; }   // never loop: settle on the wanted route
  H.moving = n;
  clearTimeout(H.timer);
  H.timer = setTimeout(() => { if (H.moving) { H.moving = 0; histSync(); } }, 400);   // a go() that found no entry never answers
  history.go(-n);
}
function histSeed() {
  const W = H.want, guard = isStandalone();
  const list = [...(guard ? [{ dz: 1, g: 1, c: ["guard"], ov: 0 }] : []), ...W.map((_, i) => hstate(W.slice(0, i + 1)))];
  const urls = [...(guard ? ["home"] : []), ...W];
  history.replaceState(list[0], "", `#${urls[0]}`);
  for (let i = 1; i < list.length; i++) history.pushState(list[i], "", `#${urls[i]}`);
}
// A wide screen has no back gesture to serve, and a history traversal (history.go) the app starts there is a real browser navigation: the
// address bar blinks and the page looks reloaded (owner 2026-11-04): so on a wide screen overlays take no entry and moving up only replaces
// the current entry; going deeper or sideways (another tab, another item of a list) stacks an entry, and only the browser's own back and
// forward move through them (owner 2026-11-10). A few back presses may land on the same view; the phone keeps the exact layer stack.
const histFlat = () => !narrowChat();
// Makes the history stack match the open overlays (OV) and the wanted chain (H.want).
function histSync() {
  if (H.hold || H.moving) return;   // a traversal is in flight (or overlays are closing): its end calls this again
  const flat = histFlat(), k = flat ? 0 : OV.length, S = history.state;
  if (!S || !S.dz) { histSeed(); return; }
  if (S.g) {   // on the exit guard: a view other than 홈 (or an overlay) needs the 홈 entry above it first
    if (H.want.length > 1 || k) { pushChain(H.want, 0, []); histSync(); }
    return;
  }
  if (S.ov > k) { histMove(S.ov - k); return; }
  if (S.ov < k) { for (let j = S.ov + 1; j <= k; j++) history.pushState(hstate(S.c, j, S.w), "", hurl(S.c)); return; }
  if (k) return;   // an overlay is open: the view follows once it closes
  const C = S.c, w = S.w || C, W = H.want;
  let p = 0;
  while (p < w.length && p < W.length && w[p] === W[p]) p++;
  if (p === w.length && p === W.length) { H.tries = 0; return; }
  if (p === W.length) {   // going up: the wanted view is the entry n below, when the n entries under this one are its own chain
    const n = w.length - W.length;
    if (!H.tab && flat) { history.replaceState(hstate(W), "", hurl(W)); return; }
    if (!H.tab && C.slice(-n - 1).join("\n") === w.slice(-n - 1).join("\n")) { histMove(n); return; }
    H.tries = 0;   // the 홈 tab was pressed, or the parent is not directly below (the view was reached from another tab): stack it on top instead
    scrollKeep(S);
    history.pushState(hstate([...C, W[p - 1]], 0, W), "", hurl(W));
    return;
  }
  H.tries = 0;
  // the pane a list opened by itself was never chosen: pressing another item of that list takes its place, so back from the first item pressed lands before the list
  if (S.a && W[p].startsWith("project/") && p === w.length - 1 && p === W.length - 1) { const s = hstate([...C.slice(0, -1), W[p]], 0, W); if (H.auto) s.a = 1;   // the app itself moved its first pane (the list came late): still not chosen
    history.replaceState(s, "", hurl(W)); return; }
  scrollKeep(S);
  pushChain(W, p, C);   // going deeper, or sideways (another tab, another item): stack on top of the view that was showing
}

function ovOpen(close) { const o = { close }; OV.push(o); histSync(); return o; }
function ovDone(o) { const i = o ? OV.indexOf(o) : -1; if (i < 0) return; OV.splice(i, 1); histSync(); }
const ovCloseAll = () => { for (const o of [...OV].reverse()) o.close(); };
// A modal <dialog> is an overlay for as long as it is open (Esc, ✕ and back all end in its close event).
function dialogHist(d) { const o = ovOpen(() => d.close()); d.addEventListener("close", () => ovDone(o)); }
// On a phone, a screen's inner state that the app bar arrow closes (a KakaoTalk room, a comment post or DM) is one history step, like a sheet: the browser's back
// closes what the arrow closes. bkStep makes the step (S.bk) match the state. It runs wherever the room, post, screen or list changes (kkOpen, kkClose, kkMode,
// cmOpen, cmClose, dmOpen, dmClose, cmTab, cmMode, go); switching rooms keeps the one step, and a wide screen has none.
function bkStep(S, on, close) {
  if (on && !S.bk) S.bk = ovOpen(close);
  else if (!on && S.bk) { const o = S.bk; S.bk = null; ovDone(o); }
}
function bkKkSync() { bkStep(KK, !!(KK.vis && KK.open && narrowChat() && current === "monitoring" && !MON.list), () => kkClose()); }
function bkCmSync() { bkStep(CM, !!(CM.vis && (CM.tab === "dm" ? DM.open : CM.open) && narrowChat() && current === "monitoring" && !MON.list), () => (CM.tab === "dm" ? dmClose() : cmClose())); }

function guardHit() {
  if (H.hash !== "home") { H.fromHist = ["home"]; go("home"); }
  toast("한 번 더 누르면 닫혀요", false, undefined, 2000);
  clearTimeout(H.guardTimer);
  // a second back inside the window finds nothing below and leaves the app; after it, 홈 gets its entry back
  H.guardTimer = setTimeout(() => { const S = history.state; if (S && S.g && !H.moving) history.pushState(hstate(["home"]), "", "#home"); }, 2000);
}

window.addEventListener("popstate", ev => {
  const S = ev.state;
  if (H.moving) { H.moving = 0; clearTimeout(H.timer); histSync(); scrollBack(S); return; }   // our own traversal: the view is already right
  if (!S || !S.dz) return;   // an entry the app did not make: hashchange handles it
  if (S.g) { guardHit(); return; }
  H.hold++;
  try {
    while (OV.length > S.ov) { const n = OV.length; OV[n - 1].close(); if (OV.length === n) OV.pop(); }
  } finally { H.hold--; }
  const W = S.w || S.c, hash = W[W.length - 1];
  H.fromHist = W;
  if (hash !== H.hash) { const p = parseHash(`#${hash}`); go(p.view, p.t); }
  else H.want = W;
  H.fromHist = null;
  histSync();
  scrollBack(S);
});
