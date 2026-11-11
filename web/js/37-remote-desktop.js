/* ---------- 화면 공유: this computer's screen in a browser tab (hub/remote-desktop.ts; features/remote-desktop/DESIGN.md) ---------- */
// (owner 2026-11-04) "크롬으로 되네. 크롬이 설치되어있으면 크롬에서 띄우는걸로 구현하자"
// Keyboard lock (Cmd+W/T/Tab reach the screen) works only in a top-level tab of real Chrome, so the page asks the gateway it is on
// (POST /api/desk/open): that gateway tells this page to open /desk/ here, or has the viewer's own gateway open Chrome. Everything on this
// page hangs on S.desk, which /api/state carries only when the feature is available: no S.desk, no entry, no row, no pill, no space.
// Names start with dsk (the dk prefix is taken by the draft sheet, 30-notices.js).
const DSK = { st: null, asked: false, pending: false, busy: false, painted: false, pill: null };

// Real desktop Chrome only. Brave, Edge, Opera and Aside report just "Chromium" (plus a grease entry), so the brand is the test;
// navigator.keyboard exists in every Chromium and says nothing about the browser.
function deskIsChrome() {
  const u = navigator.userAgentData;
  return !!u && !u.mobile && Array.isArray(u.brands) && u.brands.some(b => b && b.brand === "Google Chrome");
}
function deskIsPhone() {
  const u = navigator.userAgentData;
  if (u && typeof u.mobile === "boolean" && u.mobile) return true;
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// The click that starts it. Real Chrome: wait for the answer, then open (Chrome keeps the click's permission for seconds). Any other
// browser: a blank tab is opened inside the click, because it will not allow a window.open after an await, and it is pointed at /desk/
// once the gateway says so, or closed when the answer is blocked or the viewer's own Chrome opened it.
// `p`: another computer of the computer list. Its gateway is asked through this one, because the page never calls another computer, and
// the answer's `go` is that computer's one-time ticket, which opens the screen straight away (a bare link from elsewhere cannot start
// capture and lands on its one-tap page). No `p`: this computer, and when it is off the same tap switches it on.
async function openScreen(p) {
  if (DSK.busy) return;
  DSK.busy = true;
  const chrome = deskIsChrome(), phone = deskIsPhone(), peer = p && !p.self ? p : null;
  const path = peer ? `${peer.url}/desk/` : "/desk/", turnOn = !peer && !!S && !!S.desk && !S.desk.on;
  let tab = null;
  if (!chrome) { tab = window.open("", "_blank"); if (tab) tab.opener = null; }
  try {
    const r = (await api("/api/desk/open", "POST", { chrome, phone, ...(peer ? { peer: peer.url } : {}), ...(turnOn ? { on: true } : {}) })) || {};
    if (turnOn && r.action !== "blocked") dskLoad();
    if (r.action === "here") {
      const href = r.go ? `${path}?go=${enc(r.go)}` : path;
      const win = tab || window.open(href, "_blank");
      if (tab) tab.location.href = href;
      if (!win) { toast(TX("misc.dsk.blocked"), true); return; }
      if (r.note) toast(r.note);
    } else {
      if (tab) tab.close();
      if (r.action === "opened") toast(TX("misc.dsk.opened_in", { name: r.name || TX("misc.dsk.that_pc") }));
      // an off computer can only be switched on over there: the one step, with the way to it
      else toast(r.reason || TX("misc.dsk.cant_now"), true, peer && typeof r.to === "string" ? { label: TX("misc.dsk.open_peer", { name: peer.name }), onclick: () => prGo(`${peer.url}/?did=${enc(DEVICE_ID)}${r.to}`) } : undefined, peer ? 10000 : undefined);
    }
  } catch (e) {
    if (tab) tab.close();
    toast(e.message || TX("misc.dsk.open_failed"), true);
  } finally { DSK.busy = false; }
}

// One button on one computer of the list (33-peers.js): another computer that answers, or this one when it has the feature. A computer
// reached only through JANDI, or only by a public address, has no gateway of ours to show a screen from, and an offline one has nothing to open: no button, no space.
function dskRowBtn(p) {
  if (selfDown || p.via || p.public || (p.self ? !(S && S.desk) : !p.online)) return null;
  const off = p.self && !S.desk.on;
  return el("button", { type: "button", class: "btn tonal inrow pr-desk", text: off ? TX("misc.dsk.on_view") : TX("misc.dsk.view"), "aria-label": TX(off ? "misc.dsk.aria_on_view" : "misc.dsk.aria_view", { name: p.name }), onclick: () => { prClose(false); openScreen(p); } });
}

/* ---------- state ---------- */
const dskViewers = () => (S && S.desk && Array.isArray(S.desk.viewers) ? S.desk.viewers : []);
const dskWho = v => (v && (v.device || v.who)) || TX("misc.dsk.device");
const dskPillText = vs => (vs.length === 1 ? TX("misc.dsk.viewing_from", { who: dskWho(vs[0]) }) : TX("misc.dsk.viewing_n", { n: vs.length }));
// An answer of GET/PUT /api/desk/... is the new status; S.desk follows it at once instead of waiting for the next state refresh.
function dskTake(st) {
  DSK.st = st;
  if (S && S.desk) S.desk = { ...S.desk, on: st.on, running: st.running, viewers: Array.isArray(st.viewers) ? st.viewers : [] };
  dskPaint();
  if (inSettings()) renderSettings();
}
async function dskLoad() {
  DSK.asked = true;
  try { dskTake(await api("/api/desk/status")); } catch { /* the row for the public address just stays out */ }
}
async function dskSet(patch, said) {
  if (DSK.pending) return;
  DSK.pending = true;
  try { dskTake(await api("/api/desk/settings", "PUT", patch)); toast(said); }
  catch (e) { toast(e.message, true); }
  finally { DSK.pending = false; }
}

/* ---------- app-bar pill: who is watching ---------- */
// Blue (--accent) is running; the pill is there while S.desk.viewers is non-empty and gone otherwise. It is painted from the state refresh
// (17-state-refresh.js), which already runs on events: no timer of its own. A tap opens 설정, where sharing is switched off.
function dskPillNode() {
  if (!DSK.pill) {
    DSK.pill = el("button", { type: "button", class: "tag pri dsk-pill", id: "dsk-pill", hidden: true, onclick: () => go("settings") });
    const bar = $("#ustrip");
    if (bar) bar.before(DSK.pill);
  }
  return DSK.pill;
}
function dskPaint() {
  const p = dskPillNode(), vs = dskViewers(), fresh = DSK.painted;
  DSK.painted = true;
  if (vs.length) {
    const text = dskPillText(vs);
    p.setAttribute("aria-label", TX("misc.dsk.pill_aria", { text }));
    if (p.hidden) { p.textContent = text; p.hidden = false; if (fresh) motionIn(p, "fade"); }
    else if (p.textContent !== text) motionSwap(p, () => { p.textContent = text; });
  } else if (!p.hidden) {
    if (fresh) motionOut(p).then(() => { if (!dskViewers().length) p.hidden = true; });
    else p.hidden = true;
  }
}

/* ---------- settings: beside 이 컴퓨터 이름 ---------- */
const dskSwitch = (on, label, onclick) => el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(!!on), "aria-label": label, onclick });
const dskRow = (key, hd, sup, end) => el("div", { class: "li", "data-dsk": key }, el("span", { class: "tx" }, el("div", { class: "hd", text: hd }), sup ? el("div", { class: "sup", text: sup }) : null), end ? liEnd(end) : null);
// The rows of the 화면 공유 section, or nothing when this computer has no S.desk. The public address needs the cloudflare web access mode
// (WA, 25-settings-web-access.js) and the saved value, which only GET /api/desk/status carries.
function dskSettings() {
  const d = S && S.desk;
  if (!d) return [];
  const cf = !!(WA.data && WA.data.mode === "cloudflare");
  if (cf && !DSK.asked) dskLoad();
  const opens = dskRow("open", TX("misc.dsk.this_screen"), d.on ? TX("misc.dsk.on_note") : TX("misc.dsk.off_note"), el("button", { type: "button", class: "btn inrow", text: d.on ? TX("misc.dsk.view") : TX("misc.dsk.on_view"), onclick: () => openScreen() }));
  const rows = [opens, dskRow("on", TX("misc.dsk.share"), TX("misc.dsk.share_note"), dskSwitch(d.on, TX("misc.dsk.share"), () => dskSet({ on: !d.on }, d.on ? TX("misc.dsk.share_off") : TX("misc.dsk.share_on"))))];
  if (cf && DSK.st) rows.push(dskRow("allow_public", TX("misc.dsk.public"), TX("misc.dsk.public_note"), dskSwitch(DSK.st.allow_public, TX("misc.dsk.public"), () => dskSet({ allow_public: !DSK.st.allow_public }, DSK.st.allow_public ? TX("misc.dsk.public_off") : TX("misc.dsk.public_on")))));
  return [stSec(TX("misc.dsk.share")), stList(...rows)];
}

dskPillNode();
