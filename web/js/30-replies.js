/* ---------- 모니터링 > 답장 대기: every reply that waits for the owner, of every app and every computer, as one list ---------- */
// The prototype's #queue (site/prototype/s-queue.js) on the app's own notice-row classes: tabs 전체 · 답 필요 · 실패 · 보낸 것 with counts, a sticky head with
// 빠른 처리, and sections 실패 / 답 필요 / 보낸 것. Every row is an item of the one reply queue (10-reply-actions.js: GET /api/reply/queue, this computer's
// and the others' snapshots): a waiting or failed item is its card (rqItemCard) right in the list, acted on with raAct (another computer's through its own
// queue); a sent one (today) is a row that opens the same card in ONE sheet. The stop reason of a failed row is the send's own reason, never invented.
// rqWaiting() (답 필요 + 실패) is the ONE number: #nav-mon, the tab counts, the list row and 홈 read it.
// Reached from 홈 답장 대기, the app rows' 답장 대기 button, the chat's 답장 초안 line and the list row itself; the row shows only while something waits (or it is open).
const RQ = { loaded: false, app: "", tab: "all", cur: "", sheet: null, shSig: "", rows: null, top: null, mark: "", err: "", t: 0, lim: {}, reset: false };
const RQ_KEY = "replies";

async function rqLoad() {
  await raLoad();
  RQ.err = RA.err ? appFail(RA.err, TX("triage.rq.load_fail")) : "";
  RQ.loaded = true;
  monSchedule(); homeSoon(); rqSheetPaint(); paintDecision();
}
const rqSoon = () => { clearTimeout(RQ.t); RQ.t = setTimeout(rqLoad, 400); };

const rqPcKey = pc => (pc ? pc.url : "");
const rqFilterKey = (pc, inst) => `${rqPcKey(pc)}|${inst}`;

/* ---- the rows ---- */
const RQ_SENT = { owner: TX("triage.sent.owner"), rule: TX("triage.sent.rule"), retry: TX("triage.sent.retry") };   // the prototype's words by `how`
const RQ_TONE = { ask: "warn", fail: "err", sent: "ok" };
// Every row of the screen, from the one queue of every computer: failed / unsure first, then what waits (newest first), then what went out today.
function rqRows() {
  const byAt = (a, b) => (b.at || 0) - (a.at || 0), all = raItems(), today = new Date().setHours(0, 0, 0, 0);
  const items = all.filter(i => i.draft.state === "pending" || (i.send && i.send.state !== "sent"));
  const sent = all.filter(i => i.send && i.send.state === "sent" && (i.send.at || 0) >= today).map(i => ({ ...rqItemRow(i), state: "sent", at: i.send.at, why: RQ_SENT[i.send.how] || "" }));
  return [...items.map(rqItemRow).sort((a, b) => (a.state === b.state ? byAt(a, b) : a.state === "fail" ? -1 : 1)), ...sent.sort(byAt)];
}
// One queue item as a row of the screen: failed and unsure are 실패, the rest waits.
function rqItemRow(i) {
  const bad = i.send && (i.send.state === "failed" || i.send.state === "unsure");
  return { key: `i:${rqPcKey(i.pc)}|${i.ref}`, state: bad ? "fail" : "ask", who: (i.original && i.original.who) || i.draft.to || "", what: i.draft.text, inst: i.app, app: i.label, pc: i.pc || null, at: i.at, why: bad && i.send.reason ? i.send.reason.text : "", it: i };
}
// The one number: what waits on the owner (답 필요 + 실패 as the screen shows them), of every computer.
const rqWaiting = () => rqRows().filter(r => r.state !== "sent").length;
const rqAskCount = () => rqRows().filter(r => r.state === "ask").length;

// The 모니터링 list row (monItems, 30-monitoring.js): under 감시 소식, only while something waits or the queue is open.
function rqMonItem(home) {   // home: the wide home shows the queue also while nothing waits
  const rows = rqRows().filter(r => r.state !== "sent"), n = rows.length;
  if (!n && MON.sel !== RQ_KEY && !home) return null;
  // the line under the name is the home row's (08-home.js homeRepliesRow): the count per source, the total at the row's right
  const by = new Map(), at = Math.max(0, ...rows.map(r => r.at || 0));
  for (const r of rows) { const k = r.app || TX("home.replies.other"); by.set(k, (by.get(k) || 0) + 1); }
  return { key: RQ_KEY, group: "", name: TX("triage.rq.name"), ic: "send", notices: [], mails: [], unread: n, rq: true,
    hint: n ? countsLine(by) : TX("triage.empty.all"), at: at ? new Date(at).toISOString() : "" };
}
// Opens the queue, filtered to one app of one computer when given (an app's own 답장 대기 button).
function rqOpen(inst, pc) { RQ.app = inst ? rqFilterKey(pc || null, inst) : ""; MON.sig = ""; go("monitoring", RQ_KEY); }

/* ---- the screen ---- */
const RQ_TABS = [["all", TX("mon.filter.all")], ["ask", TX("mon.filter.need")], ["fail", TX("mon.tag.fail")], ["sent", TX("triage.tab.sent")]];
const RQ_SECS = [["fail", TX("mon.tag.fail")], ["ask", TX("mon.filter.need")], ["sent", TX("triage.tab.sent")]];
const RQ_EMPTY = { all: TX("triage.empty.all"), ask: TX("triage.empty.ask"), fail: TX("triage.empty.fail"), sent: TX("triage.empty.sent") };
const RQ_UI = {};
// The sticky head (tabs, meta row with 빠른 처리, the app chips) and the list box are built once and repainted in place, so scroll, focus and the counts' roll survive.
function rqUi() {
  if (RQ_UI.hd) return RQ_UI;
  const tabs = el("div", { class: "nsc-f rq-tabs", role: "tablist", "aria-label": TX("triage.rq.state_aria") }, ...RQ_TABS.map(([k, l]) =>
    el("button", { class: "nsc-fb", type: "button", role: "tab", "data-f": k, onclick: () => rqTab(k) }, l, el("span", { class: `n${k === "fail" ? " err" : ""}`, "data-n": k }))));
  const mt = el("span", { class: "meta" }), fast = el("button", { class: "btn tonal sm rq-fast", type: "button", "data-k": "triage", onclick: () => tqOpen() }, icon("spark"), el("span", { text: TX("triage.fast") }));
  const meta = el("div", { class: "nsc-m rq-qm" }, mt, el("span", { class: "sp" }), fast), chips = el("div", { class: "rq-chips" });
  return Object.assign(RQ_UI, { hd: el("div", { class: "rq-hd2" }, tabs, meta, chips), tabs, mt, fast, meta, chips, ls: el("div", { class: "rq-ls" }), seq: 0 });
}
function rqTab(k) {
  if (RQ.tab === k) return;
  RQ.tab = k; RQ.now = true; RQ.reset = true; RQ.lim = {};
  motionSwap(rqUi().ls, () => { MON.sig = ""; renderMonitoring(); });
  const box = $("#mon-timeline"); if (box) box.scrollTop = 0;
}
// The app filter with each app's count in its menu items: shown while two or more apps wait and the waiting count reaches the triage minimum, or while one app is picked (an app row's 답장 대기 button).
// The state tabs are the one segment of this screen; the app is the 앱 select at the right end of their row (a short row under them on a phone).
function rqFilterBar(rows) {
  const by = new Map();
  for (const r of rows) { if (r.state === "sent") continue; const k = rqFilterKey(r.pc, r.inst), cur = by.get(k); by.set(k, { n: (cur ? cur.n : 0) + 1, text: `${r.app || rqAppName(r.inst) || TX("home.replies.other")}${r.pc ? ` · ${r.pc.name}` : ""}` }); }
  if (RQ.app && !by.has(RQ.app)) RQ.app = "";
  const total = [...by.values()].reduce((c, v) => c + v.n, 0);
  if (!(RQ.app || (by.size >= 2 && total >= RA.min))) return null;
  return selectButton({ label: TX("home.ny.app"), frame: t => TX("triage.rq.app_frame", { t }), value: RQ.app, text: k => (k ? by.get(k).text : TX("mon.filter.all")),
    items: [{ value: "", label: TX("triage.rq.all_n", { n: total }) }, ...[...by].map(([k, v]) => ({ value: k, label: `${v.text} · ${v.n}` }))],
    onPick: k => { RQ.app = k; RQ.lim = {}; MON.sig = ""; monSchedule(); } });
}
// 방금 / N분 전 within the hour, as the prototype's rows, then the plain time.
const rqWhen = at => { const m = at ? Math.floor((Date.now() - at) / 60_000) : -1; return !at ? "" : m < 1 ? TX("home.ago.now") : m < 60 ? TX("home.ago.m", { n: m }) : rcWhen(new Date(at).toISOString()); };
// One row, the notice row's own classes: the state dot, who and the time, then "앱 · 무엇" with the tag (the stop reason, or how a sent one went).
function rqRowNode(r) {
  const at = rqWhen(r.at), head = r.who || r.what || r.app, sub = [r.app, r.who ? r.what : ""].filter(Boolean).join(" · ");
  const open = RQ.mark === r.key;   // the row whose card stands (or stood) in the right column: marked the way 채팅 marks its open row
  return el("div", { class: `li nsc-r rq-r ${r.state}${open ? " on" : ""}`, "data-qr": r.key },
    el("span", { class: "lead" }, el("span", { class: `dot ${RQ_TONE[r.state]}` })),
    el("button", { class: "tx nsc-tx", type: "button", "aria-current": open ? "true" : null, onclick: () => rqSheetOpen(rqRows().find(x => x.key === r.key) || r) },
      el("span", { class: "ln" }, el("span", { class: "hd", text: head }), at ? el("span", { class: "t", text: at }) : null),
      sub || r.why ? el("span", { class: "ln" }, sub ? el("span", { class: "nsc-s", text: sub }) : null, r.why ? el("span", { class: `tag${r.state === "fail" ? " err" : ""}`, text: r.why }) : null) : null));
}
// A row as a keyed descriptor: rqSync keeps its node while the signature (everything the row shows) is the same.
const rqRowDesc = r => ({ key: `r:${r.key}`, sig: JSON.stringify([r.state, r.who, r.what, r.app, r.why, rqWhen(r.at), RQ.mark === r.key]), make: () => rqRowNode(r) });
// Replies the owner approved that are in their undo window, queued or on their way, of this computer and the others.
const rqSending = () => raCounts().sending;
function rqPaintHead(rows) {
  const u = rqUi(), n = { ask: 0, fail: 0, sent: 0 };
  for (const r of rows) n[r.state]++;
  for (const b of u.tabs.children) {
    const k = b.dataset.f, on = RQ.tab === k;
    b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on));
    rollCount(b.querySelector(".n"), k === "all" || !n[k] ? "" : String(n[k]));
  }
  // the count is said once, on the filter chips; the line under them keeps only what the chips do not say
  const fast = (RQ.tab === "all" || RQ.tab === "ask") && n.ask >= RA.min;
  const sending = rqSending(), text = [RQ.tab === "sent" && n.sent ? TX("triage.rq.sent_today", { n: n.sent }) : "", sending ? TX("triage.rq.sending_n", { n: sending }) : ""].filter(Boolean).join(" · ");
  u.mt.textContent = text; u.fast.hidden = !fast; u.meta.hidden = !text && !fast;
}
const RQ_PAGE = 200;   // rows drawn per section; 더 보기 adds a page (the failed section always draws all)
// Keyed update of one box: a child stays when its key and signature are the same, the rest is removed, replaced or inserted in order.
function rqSync(box, descs) {
  const have = new Map([...box.children].map(n => [n.dataset.rk, n]));
  listPlace(box, descs.map(d => {
    let n = have.get(d.key);
    if (!n || n._sig !== d.sig) { n = d.make(); n._sig = d.sig; n.dataset.rk = d.key; }
    return n;
  }));
}
// Puts `nodes` in `box` in that order: a child no longer wanted is removed, one already in place stays, the rest is inserted.
function listPlace(box, nodes) {
  const want = new Set(nodes);
  for (const n of [...box.children]) if (!want.has(n)) n.remove();
  let at = box.firstChild;
  for (const n of nodes) { if (n === at) at = at.nextSibling; else box.insertBefore(n, at); }
}
// The first row of `root` (matching `sel`) in view and its offset from the top of the scroll box, `key` being the dataset name that identifies a row;
// rowHold puts it back after the rows above it changed.
function rowAnchor(root, sel, key, box = $("#mon-timeline")) {
  if (!box || box.scrollTop <= 0 || !root.isConnected) return null;
  const top = box.getBoundingClientRect().top, n = [...root.querySelectorAll(sel)].find(e => e.getBoundingClientRect().bottom > top);
  return n ? { box, root, sel, key, id: n.dataset[key], off: n.getBoundingClientRect().top - top } : null;
}
function rowHold(a) {
  const n = a && [...a.root.querySelectorAll(a.sel)].find(e => e.dataset[a.key] === a.id);
  if (n) a.box.scrollTop += n.getBoundingClientRect().top - a.box.getBoundingClientRect().top - a.off;
}
const rqAnchor = () => rowAnchor(rqUi().ls, ".rq-r", "rk");
// What the list holds: the section heads and one box of rows per section (their own descriptors under `rows`).
function rqDescs(shown) {
  if (!shown.length && RQ.err && !(RQ.rows || []).length) return [{ key: "empty", sig: RQ.err, make: () => el("div", { class: "rq-empty", role: "status" }, el("div", { text: RQ.err }), appRetry(() => rqLoad())) }];   // the load failed: a sentence and 다시 시도
  if (!shown.length) { const text = RQ.loaded || NT.loaded ? RQ_EMPTY[RQ.tab] : TX("common.loading"); return [{ key: "empty", sig: text, make: () => el("div", { class: "rq-empty", role: "status", text }) }]; }
  const out = [];
  for (const [s, label] of RQ_SECS) {
    const part = shown.filter(r => r.state === s);
    if (!part.length) continue;
    if (RQ.tab === "all") out.push({ key: `sec:${s}`, sig: label, make: () => el("div", { class: "sec", text: label }) });
    const lim = s === "fail" ? part.length : RQ.lim[s] || RQ_PAGE, rows = part.slice(0, lim).map(r => (s === "sent" ? rqRowDesc(r) : rqCardDesc(r, shown)));
    if (part.length > lim) rows.push({ key: `more:${s}`, sig: String(part.length - lim), make: () => moreRow(TX("mon.more_n", { n: part.length - lim }), () => { RQ.lim[s] = lim + RQ_PAGE; MON.sig = ""; monSchedule(); }) });
    out.push({ key: `list:${s}`, sig: "", make: () => el("div", { class: "list rq-list" }), rows });
  }
  return out;
}
// A queue item as its card (rqItemCard): only the first waiting card's 보내기 is filled; it is drawn again when its item changes.
function rqCardDesc(r, shown) {
  const lead = r.state === "ask" && shown.find(x => x.state === "ask") === r;
  RA.items.has(r.it.ref) || r.it.pc ? null : RA.items.set(r.it.ref, r.it);
  return { key: `r:${r.key}`, sig: JSON.stringify([r.it, lead, RA.busy.get(r.it.ref) || "", RA.fail.get(r.it.ref) || ""]), make: () => el("div", { class: "rq-c", "data-qr": r.key }, rqItemCard(r.it, { lead })) };
}
function rqPaintList(rows) {
  const u = rqUi(), shown = RQ.tab === "all" ? rows : rows.filter(r => r.state === RQ.tab), reset = RQ.reset;
  RQ.reset = false;
  const apply = () => {
    const at = document.activeElement, f = at && u.ls.contains(at) ? at.closest(".rq-r") : null, fk = f ? f.dataset.rk : "", anchor = rqAnchor();
    if (reset) clear(u.ls);
    const top = rqDescs(shown);
    rqSync(u.ls, top);
    for (const d of top) if (d.rows) rqSync([...u.ls.children].find(n => n.dataset.rk === d.key), d.rows);
    u.ls.dataset.on = "1";
    if (fk) { const n = [...u.ls.querySelectorAll(".rq-r")].find(e => e.dataset.rk === fk), b = n && n.querySelector(".tx"); if (b && document.activeElement !== b) b.focus({ preventScroll: true }); }
    rowHold(anchor);
  };
  // Rows that left (answered, sent again, dropped: the hub already said yes) fold away first and the rows below glide up; a tab change redraws at once.
  const keys = new Set(shown.map(r => r.key)), gone = RQ.now || !u.ls.dataset.on ? [] : [...u.ls.querySelectorAll("[data-qr]")].filter(n => !keys.has(n.dataset.qr));
  RQ.now = false;
  const seq = ++u.seq;
  if (gone.length) Promise.all(gone.map(n => motionGone(n))).then(() => { if (u.seq === seq) apply(); });
  else apply();
}
function rqPaint(rows) {
  const u = rqUi(), bar = rqFilterBar(rows), mine = RQ.app ? rows.filter(r => rqFilterKey(r.pc, r.inst) === RQ.app) : rows;
  clear(u.chips).append(...(bar ? [bar] : []));
  rqPaintHead(mine); rqPaintList(mine);
  rqSheetPaint();
}
// The nodes of the screen: the sticky head, then the list.
// 답장 대기 in the right column of 모니터링: the rows of the queue, or the open row's card (wide), redrawn only when an item or the screen's own state changes.
function rqScreen(qSel, box, tl) {
  const sig = rqSig();
  if (sig !== MON.sig || MON.shown !== qSel.key) {
    const pane = !!(RQ.sheet && RQ.sheet.pane), back = RQ.top != null && !pane, keep = pane ? 0 : back ? RQ.top : MON.shown === qSel.key ? box.scrollTop : 0, anchor = keep > 0 && !back && !pane ? rqAnchor() : null;   // the first row in view stays where it was
    if (!pane) RQ.top = null;
    MON.sig = sig; MON.shown = qSel.key;
    clear($("#mon-head")).append(...monHead(qSel));
    if (!(pane && tl.firstElementChild === RQ.sheet.box)) clear(tl).append(...(pane ? [RQ.sheet.box] : rqNodes()));   // an open pane already stands there: drawn again it would lose the focus
    box.scrollTop = keep;
    rowHold(anchor);
    edgeFade(box);
    rqSheetPaint();
  }
  convTitle();
}
function rqNodes() { rqPaint(RQ.rows || rqRows()); return [rqUi().hd, rqUi().ls]; }

/* ---- the sheet: ONE sheet for every row, holding the reply card (10-reply-card.js) with the why line on top ---- */
// A wide window opens the card in the right column in place of the queue (no modal); a phone keeps the sheet. Back (the card's x, the app bar) returns to the queue with the row marked.
function rqPaneOpen() {
  RQ.top = $("#mon-timeline").scrollTop;
  const h = { pane: true, box: el("div", { class: "rq-sheet rq-pane" }), close: () => { if (RQ.sheet === h) { RQ.sheet = null; RQ.cur = ""; MON.sig = ""; monSchedule(); } } };
  RQ.sheet = h; MON.sig = ""; monSchedule();
}
const rqBack = () => !!(current === "monitoring" && RQ.sheet && RQ.sheet.pane && (RQ.sheet.close(), true));
function rqSheetOpen(r) {
  if (RQ.sheet) RQ.sheet.close(false);
  RQ.cur = r.key; RQ.shSig = "";
  if (current === "monitoring" && !narrowChat()) { RQ.mark = r.key; rqPaneOpen(); rqSheetPaint(r); return; }
  RQ.mark = "";
  const h = fsOpen({ label: TX("decision.check_reply"), cls: "mid rq-sheet", onClose: () => { if (RQ.sheet === h) { RQ.sheet = null; RQ.cur = ""; } } });
  RQ.sheet = h;
  rqSheetPaint(r);
}
function rqSheetPaint(found) {
  const h = RQ.sheet;
  if (!h || h.tr) return;   // 빠른 처리 (30-triage.js) draws its own pane
  const key = found ? found.key : RQ.cur, r = rqRows().find(x => x.key === key);
  if (!r) { h.close(false); return; }   // its item left: answered, sent, dropped
  const sig = JSON.stringify([r.key, r.state, r.why]);
  if (sig === RQ.shSig) return;
  RQ.shSig = sig;
  const body = el("div", { class: "rq-sb" }, r.why && r.state !== "sent" ? el("div", { class: "note rq-why", role: "note", text: r.why }) : null, rqItemCard(r.it, { lead: true })), old = h.box.querySelector(".rq-sb");
  if (!h.box.querySelector(".fs-hd")) h.box.append(fsHead([el("div", { class: "fs-t", text: TX("decision.check_reply") })], { close: () => h.close() }));
  if (old) { const top = old.scrollTop; old.replaceWith(body); body.scrollTop = top; } else h.box.append(body);   // a redraw keeps the place in a long draft
}
// What the screen shows; it is redrawn only when this changes.
function rqSig() {
  const rows = (RQ.rows = rqRows());
  return JSON.stringify([RQ.app, RQ.tab, RQ.lim, RQ.err, RQ.mark, !!(RQ.sheet && RQ.sheet.pane), rqSending(), RA.min, RQ.loaded, rows.map(r => [r.key, r.state, r.at, r.who, r.what, r.app, r.why])]);
}
rqLoad();
// A press on a waiting draft's button: the card is drawn again at once with the buttons off in place (the pressed one says what is going on), and again
// if the request failed, now with the reason above the buttons (10-decision-card.js answerInline keeps it in rqFail). A second press is ignored there.
const monDraftPaint = n => { const c = [...document.querySelectorAll(".rq[data-nid]")].find(x => x.dataset.nid === String(n.id)); if (c) c.replaceWith(draftCardNode(n)); };
async function monDraftRun(n, opt) {
  const p = answerInline(n, opt);
  if (dcSending.has(n.id)) monDraftPaint(n);
  if ((await p) === false) monDraftPaint(n);
}
