/* ---------- back navigation: the browser history is the app's layer stack (Android back gesture, desktop back/forward) ---------- */
// Every history entry the app owns carries {dz:1, c, ov, g?}:
//   c   the chain of routes from 홈 down to the entry's own view, e.g. ["home","chat/list","chat/main"]: back from the last one lands on the one before it
//   ov  how many overlays (sheet, menu, dialog) are open on top of that view; each one is an entry of its own
//   g   the exit guard under 홈 (installed app only): back from 홈 lands on it, shows the toast, and a second back leaves
// go() computes the chain it wants (H.want) and histSync() makes the real stack match: push to go deeper, replace to move sideways
// (tab to tab), history.go(-n) to go up. A tab switch therefore never piles up entries, and back always ends at 홈 and then leaves.
const OV = [];   // open overlays, bottom first: {close} (close runs the overlay's own close path, which calls ovDone)
const H = { want: ["home"], hash: "home", hold: 0, moving: 0, tries: 0, timer: 0, guardTimer: 0, fromHist: null };
const hstate = (c, ov = 0) => ({ dz: 1, c, ov });
const hurl = c => `#${c[c.length - 1]}`;

// The chain of routes for a view, computed when the app navigates by itself (a back/forward uses the entry's stored chain).
function routeChain(name, hash) {
  if (name === "home") return ["home"];
  const conv = n => narrowChat() ? ["home", "chat/list", `${n}/${target}`] : ["home", `${n}/${target}`];
  if (name === "chat" || name === "activity") return narrowChat() ? (chatList ? ["home", hash] : ["home", "chat/list", hash]) : ["home", hash];
  if (name === "harness") return ["home", "settings", hash];
  if (name === "project") return ["home", "projects", hash];
  if (name === "monitoring") return narrowChat() ? ["home", "chat/list", hash] : ["home", hash];
  if (SUB.has(name)) {
    const bt = backTarget();
    if (bt === "home") return ["home", hash];
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
}
// A route changed its own hash without changing level (a conversation picked from the switcher, a project map opened).
function routeReplace(hash) {
  const S = history.state;
  if (!S || !S.dz || S.g) { history.replaceState(S, "", `#${hash}`); return; }
  history.replaceState({ ...S, c: [...S.c.slice(0, -1), hash] }, "", `#${hash}`);
  H.hash = hash; H.want = [...H.want.slice(0, -1), hash];
}

const pushChain = (W, from) => { for (let i = from; i < W.length; i++) history.pushState(hstate(W.slice(0, i + 1)), "", `#${W[i]}`); };
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
// Makes the history stack match the open overlays (OV) and the wanted chain (H.want).
function histSync() {
  if (H.hold || H.moving) return;   // a traversal is in flight (or overlays are closing): its end calls this again
  const k = OV.length, S = history.state;
  if (!S || !S.dz) { histSeed(); return; }
  if (S.g) {   // on the exit guard: a view other than 홈 (or an overlay) needs the 홈 entry above it first
    if (H.want.length > 1 || k) { pushChain(H.want, 0); histSync(); }
    return;
  }
  if (S.ov > k) { histMove(S.ov - k); return; }
  if (S.ov < k) { for (let j = S.ov + 1; j <= k; j++) history.pushState(hstate(S.c, j), "", hurl(S.c)); return; }
  if (k) return;   // an overlay is open: the view follows once it closes
  const C = S.c, W = H.want, m = C.length - 1;
  let p = 0;
  while (p < C.length && p < W.length && C[p] === W[p]) p++;
  if (p === C.length && p === W.length) { H.tries = 0; return; }
  if (p === W.length) { histMove(C.length - W.length); return; }   // going up: the wanted view is an entry below
  H.tries = 0;
  if (p === C.length) { pushChain(W, p); return; }                  // going deeper
  if (m > p) { histMove(m - p); return; }                           // sideways from a deeper level: land on the sibling, then replace it
  history.replaceState(hstate(W.slice(0, p + 1)), "", `#${W[p]}`);  // sideways at the same level
  pushChain(W, p + 1);
}

function ovOpen(close) { const o = { close }; OV.push(o); histSync(); return o; }
function ovDone(o) { const i = o ? OV.indexOf(o) : -1; if (i < 0) return; OV.splice(i, 1); histSync(); }
// A modal <dialog> is an overlay for as long as it is open (Esc, ✕ and back all end in its close event).
function dialogHist(d) { const o = ovOpen(() => d.close()); d.addEventListener("close", () => ovDone(o)); }

function guardHit() {
  if (H.hash !== "home") { H.fromHist = ["home"]; go("home"); }
  toast("한 번 더 누르면 닫혀요", false, undefined, 2000);
  clearTimeout(H.guardTimer);
  // a second back inside the window finds nothing below and leaves the app; after it, 홈 gets its entry back
  H.guardTimer = setTimeout(() => { const S = history.state; if (S && S.g && !H.moving) history.pushState(hstate(["home"]), "", "#home"); }, 2000);
}
// Called once at 홈 with no other entry above it; boot does it by itself in the installed app.
function armExitGuard() {
  const S = history.state;
  if (!S || !S.dz || S.g || S.ov || S.c.length !== 1 || OV.length || H.moving) return false;
  history.replaceState({ dz: 1, g: 1, c: ["guard"], ov: 0 }, "", "#home");
  history.pushState(hstate(["home"]), "", "#home");
  return true;
}

window.addEventListener("popstate", ev => {
  const S = ev.state;
  if (H.moving) { H.moving = 0; clearTimeout(H.timer); histSync(); return; }   // our own traversal: the view is already right
  if (!S || !S.dz) return;   // an entry the app did not make: hashchange handles it
  if (S.g) { guardHit(); return; }
  H.hold++;
  try {
    while (OV.length > S.ov) { const n = OV.length; OV[n - 1].close(); if (OV.length === n) OV.pop(); }
  } finally { H.hold--; }
  const hash = S.c[S.c.length - 1];
  H.fromHist = S.c;
  if (hash !== H.hash) { const p = parseHash(`#${hash}`); go(p.view, p.t); }
  else H.want = S.c;
  H.fromHist = null;
  histSync();
});
