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
// `p`: another computer of the computer list. Its gateway is asked through this one, because the page never calls another computer; a
// tab pointed at it lands on that computer's one-tap page (a link from elsewhere cannot start capture). No `p`: this computer, and when
// it is off the same tap switches it on.
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
      const win = tab || window.open(path, "_blank");
      if (tab) tab.location.href = path;
      if (!win) { toast("새 탭이 막혔어요. 팝업을 허용해 주세요", true); return; }
      if (r.note) toast(r.note);
    } else {
      if (tab) tab.close();
      if (r.action === "opened") toast(`${r.name || "그 컴퓨터"}의 크롬에서 열었어요`);
      // an off computer can only be switched on over there: the one step, with the way to it
      else toast(r.reason || "지금은 화면을 열 수 없어요", true, peer && typeof r.to === "string" ? { label: `${peer.name} 열기`, onclick: () => prGo(`${peer.url}/?did=${enc(DEVICE_ID)}${r.to}`) } : undefined, peer ? 10000 : undefined);
    }
  } catch (e) {
    if (tab) tab.close();
    toast(e.message || "화면을 열지 못했어요", true);
  } finally { DSK.busy = false; }
}

// One button on one computer of the list (33-peers.js): another computer that answers, or this one when it has the feature. A computer
// reached only through JANDI has no gateway to show a screen from, and an offline one has nothing to open: no button, no space.
function dskRowBtn(p) {
  if (selfDown || p.via || (p.self ? !(S && S.desk) : !p.online)) return null;
  const off = p.self && !S.desk.on;
  return el("button", { type: "button", class: "btn tonal inrow pr-desk", text: off ? "켜고 보기" : "화면 보기", "aria-label": `${p.name} ${off ? "화면 공유 켜고 보기" : "화면 보기"}`, onclick: () => { prClose(false); openScreen(p); } });
}

/* ---------- state ---------- */
const dskViewers = () => (S && S.desk && Array.isArray(S.desk.viewers) ? S.desk.viewers : []);
const dskWho = v => (v && (v.device || v.who)) || "기기";
const dskPillText = vs => (vs.length === 1 ? `${dskWho(vs[0])}에서 보는 중` : `${vs.length}곳에서 보는 중`);
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
    p.setAttribute("aria-label", `${text}. 설정에서 보기`);
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
  const opens = dskRow("open", "이 컴퓨터 화면", d.on ? "다른 기기에서 보고 조작해요" : "꺼져 있어요. 누르면 켜고 열어요", el("button", { type: "button", class: "btn inrow", text: d.on ? "화면 보기" : "켜고 보기", onclick: () => openScreen() }));
  const rows = [opens, dskRow("on", "화면 공유", "이 컴퓨터 화면을 내 다른 기기에서 보고 조작해요", dskSwitch(d.on, "화면 공유", () => dskSet({ on: !d.on }, d.on ? "화면 공유를 껐어요" : "화면 공유를 켰어요")))];
  if (cf && DSK.st) rows.push(dskRow("allow_public", "공개 주소", "Cloudflare 주소로 들어온 기기도 화면을 볼 수 있어요", dskSwitch(DSK.st.allow_public, "공개 주소", () => dskSet({ allow_public: !DSK.st.allow_public }, DSK.st.allow_public ? "공개 주소로는 막았어요" : "공개 주소로도 열었어요"))));
  return [stSec("화면 공유"), stList(...rows)];
}

dskPillNode();
