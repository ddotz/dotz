/* ---------- monitoring: how the screen is left ---------- */
// 모니터링's 뒤로 closes what is open on the screen before it leaves it, in this order: the app settings pane (32-app-settings.js),
// the reply sheet in its pane (30-replies.js), an open KakaoTalk room (30-kakao.js), an open comment or DM thread
// (30-monitoring-comments.js), then a mailbox settings page (30-mailboxes-set.js). Each closer checks it is on 모니터링 itself.
function monBack() { return asBack() || rqBack() || kkBack() || cmBack() || mxsBack(); }
// 모니터링 opening, or a conversation opening inside it (13-data.js chatEnter): the list is drawn and its reads refreshed when stale.
// A conversation reads the app list kept fresh already; the read it sends asks again, so it asks only before the first one.
function monEnter() { renderMonitoring(); if (!monitorsFresh()) loadMonitors(); if (!noticesFresh()) loadNotices(); if (current === "monitoring" || !INTG.loaded) loadIntegrations(); }
// The routes behind 모니터링 (32-history-nav.js routeChain): an open item sits on the list, a mailbox settings screen on its box (30-mailboxes-set.js mxChain).
function monChain(hash) { return !MON.list ? ["home", "monitoring", ...mxChain(hash)] : ["home", hash]; }
screenHooks("monitoring", { back: monBack, enter: monEnter, chain: monChain });

/* ---------- monitoring: the address ---------- */
// A route: { list, sel, mx?, c? }. list: the list is on screen; sel: the open item's key; mx: what a mail item's address names, its account, box and
// screen ({ scr } alone when it names none: the item opens as it was); c: the conversation a `c:<target>` address opens inside 모니터링 (go() in 05-command-palette.js).
// The address: `monitoring`, `monitoring/<item>`, and after a mail item `/<account>/<box>` and `/set` or `/new` (30-mailboxes-set.js); the box is encoded twice
// so a name with a slash stays one part.
const MON_MAIL = /^(i:[^/]+)(?:\/([^/]*)\/([^/]*)(?:\/([^/]*))?)?$/;
// Reads an address target and changes nothing. Any mail instance opens the one mail item (30-mailboxes.js mxKeyOf); an instance that is not that item's key
// opens it on its own account.
function monParse(tgt) {
  const t = tgt || "", m = MON_MAIL.exec(t);
  if (!m) return !t || t === "list" ? { list: true, sel: "" } : t.startsWith("c:") ? { list: false, sel: t, c: t.slice(2) } : { list: false, sel: t };
  const sel = mxKeyOf(m[1].slice(2)), scr = m[4] === "set" || m[4] === "new" ? m[4] : "";
  return { list: false, sel, mx: m[2] !== undefined ? { acct: mxDec(m[2]), box: mxDec(m[3]), scr } : sel !== m[1] ? { acct: m[1].slice(2), box: "all", scr } : { scr } };
}
// Opens what a route says; MX's part goes through its own setter (30-mailboxes.js mxRouteSet).
function monApply(r) {
  MON.miss = false;
  if (r.mx) mxRouteSet(r.mx);
  if (r.list) { MON.list = true; return; }
  if (r.sel !== MON.sel) { MON.filter = "all"; MON.open.clear(); MON.more.clear(); }   // another item: its list starts whole and folded
  MON.autoArmed = false; MON.olderBusy = false;
  MON.sel = r.sel; MON.list = false;
}
function monHashOf(r) {
  if (r.list || !r.sel) return "monitoring";
  const x = r.mx;
  return `monitoring/${enc(r.sel)}${x && (x.acct !== "all" || x.box !== "all" || x.scr) ? `/${enc(x.acct)}/${enc(enc(x.box))}${x.scr ? `/${x.scr}` : ""}` : ""}`;
}
// go("monitoring", key) opens that item; without one the list shows.
function monRoute(tgt) { pqOpen(); monApply(monParse(tgt)); }
const monHash = () => monHashOf({ list: MON.list, sel: MON.sel, mx: MON.sel === MX.key ? MX : null });

/* ---------- monitoring: what other files change on the screen ---------- */
// Every file outside 모니터링 that changes what the screen shows asks for its redraw here: the next paint is not skipped as unchanged.
function monDirty() { MON.sig = ""; monSchedule(); }
// The same for a caller that draws or schedules the paint itself; side: the list beside the item is drawn again too.
function monSigReset(side) { MON.sig = ""; if (side) MON.side = ""; }
// Drawn now, not on the next frame: a sheet that takes the focus (30-triage.js), a tab whose rows swap in a motion (30-replies.js).
function monRenderNow() { MON.sig = ""; renderMonitoring(); }
// 답장 대기 draws its own screen (30-replies.js rqScreen) and records what it drew, so the next paint is skipped while nothing changed.
function monDrawn(sig, key) { MON.sig = sig; MON.shown = key; }
// A box picked beside an open mail (30-mailboxes.js mxBox): its list is drawn again from the top.
function monFromTop() { MON.sig = ""; MON.tlTop = 0; }
// A conversation opened inside 모니터링 (go() in 05-command-palette.js) sits on its item, which is open behind it.
function monConvIn(t) { const k = monItemOf(t); if (k) MON.sel = k; MON.list = false; }
// The open item follows its conversation (31-conversations.js) or a schedule renamed in its pane (32-app-settings.js asPaneFollow).
function monSelSet(k) { MON.sel = k; }
// The mail list's landing and its filters (30-monitoring-mail.js mailLand, mailFilterBar).
function monMailLand(key) { MON.land = key; }
function monMailFilter(k) { MON.mailFilter = k; }
function monMailIn(k) { MON.mailIn = k; }
// A jump to a notice (30-notices.js monOpen): the notice it is reaching (fresh: the item's list whole and drawn again), then the row it lit for ms.
function monWant(id, fresh) { MON.want = id; if (fresh) { MON.filter = "all"; MON.sig = ""; } }
function monLit(id, ms) { MON.hl = id; MON.hlUntil = Date.now() + ms; }
