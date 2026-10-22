/* ---------- decisions and notices: the data behind 홈's 답변 필요 / 알림 / 작업내역 cards and the decision sheet ---------- */
// Data: GET /api/notices, POST /api/notices/read, POST /api/notices/:id/answer; live frames {kind:"notice"} / {kind:"notice_read"} from the event stream
// (routed here by 99-boot.js, never into the chat timeline or the corner toasts). There is no notice list screen: 알림 and 작업내역 are their own
// conversations (chat list), 모니터링 is its own screen (30-monitoring.js); what waits on the owner shows on 홈 and in the decision sheet below.
const ntTabOf = n => n.kind === "worklog" ? "worklog" : n.kind === "watch" ? "watch" : "alert";
const NT = { items: [], unread: 0, loaded: false, failed: false };
const ntUnreadIn = tab => NT.items.reduce((c, n) => c + (!n.read && (tab === "all" || ntTabOf(n) === tab) ? 1 : 0), 0);

const ntAt = n => Date.parse(n.updated || n.ts) || 0;
const ntTime = t => kstDay(t) === kstDay(Date.now()) ? kstHM(t) : `${dayLabel(t)} ${kstHM(t)}`;
const ntWhen = n => ntTime(n.updated || n.ts);
// Row text is plain: markdown marks (links, headings, bullets, emphasis, code) are dropped.
const ntPlain = s => String(s ?? "")
  .replace(/^[ \t]*\[file\][ \t].*$/gm, "")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
  .replace(/\*+|~~|`+/g, "")
  .replace(/(^|\s)_+([^_\s][^_]*)_+(?=\s|$)/g, "$1$2")
  .replace(/\s+/g, " ").trim();

// Phone: the count is part of the chat tab badge.
function ntPaint() {
  convSchedule();
  paintAttn();
}

async function loadNotices() {
  try {
    const r = await api("/api/notices?limit=100");
    NT.items = Array.isArray(r.items) ? r.items : [];
    NT.unread = r.unread | 0; NT.loaded = true; NT.failed = false;
  } catch { NT.failed = !NT.loaded; }
  ntPaint();
  homeSoon();
  syncInlineChoices();
  ntSeenSoon();
}

// /api/state carries notices_unread: a count that disagrees with ours means a frame was missed, so refetch.
function ntSync(s) {
  if (!s || typeof s.notices_unread !== "number" || s.notices_unread === NT.unread) return;
  NT.unread = s.notices_unread; ntPaint(); loadNotices();
}

function noticeLive(e) {
  if (e.kind === "notice" && e.item && e.item.id != null) {
    const i = NT.items.findIndex(x => x.id === e.item.id);
    if (e.item.dismissed) { if (i >= 0) NT.items.splice(i, 1); }
    else if (i < 0) NT.items.push(e.item); else NT.items[i] = e.item;
    if (i < 0 && ntOpenDec(e.item) && NT.loaded) toast("답변이 필요해요", false, { label: "열기", onclick: () => noticeOpenId(e.item.id) }, 8000);
    if (e.item.kind === "watch") loadMonitors();
  } else if (e.kind === "notice_dismiss") {
    NT.items = NT.items.filter(x => x.id !== e.id);
  } else if (e.kind === "notice_read") {
    const ids = new Set(e.ids || []);
    for (const n of NT.items) if (ids.has(n.id)) n.read = true;   // the hub names the ids it read (never "all"): what waits on the owner stays unread
  }
  if (typeof e.unread === "number") NT.unread = e.unread;
  ntPaint();
  ntSheetPaint();
  homeSoon();
  syncInlineChoices();
  ntSeenSoon();
}

async function ntMarkRead(body) {
  try {
    const r = await api("/api/notices/read", "POST", body);
    if (r && typeof r.unread === "number") { NT.unread = r.unread; ntPaint(); }
  } catch (err) { toast(err.message, true); loadNotices(); }
}

/* ---- tap: go to the source message ---- */
// The conversation holding the notice's message (n.src; older items fall back to n.open) is opened on its chat view, older history
// is fetched until the message's time is covered, the message is scrolled to the top of the timeline and flashed. A message the chat does not
// show lands on the nearest one in time. Alert and worklog posts are messages of the 알림 / 작업 기록 conversations. Nothing here ever reports an error.
const ntRaf = () => new Promise(r => requestAnimationFrame(() => r()));
const ntWait = ms => new Promise(r => setTimeout(r, ms));
function ntGo(t) {
  if (t === "settings") { go("settings"); return ""; }   // the 새 버전 notice: 설정 → 업데이트
  if (isLaneT(t) && S && !S.lanes.some(l => `lane:${l.name}` === t)) t = MAIN;   // the session is gone: its result card is in the main chat
  if (t !== MAIN && isProjT(t) && S && !projTargets().includes(t)) { toast("이 프로젝트를 찾을 수 없어요"); go("projects"); return ""; }
  if (!validTarget(t)) { go("home"); return ""; }
  go("chat", t);
  return t;
}
// The rendered message of an event ts (data-ts is set in chatPush): the exact one, else the nearest in time.
function ntFind(at) {
  const want = Date.parse(at);
  let best = null, gap = Infinity;
  for (const m of tl.querySelectorAll("[data-ts]")) {
    if (m.dataset.ts === at) return m;
    const d = Math.abs(Date.parse(m.dataset.ts) - want);
    if (d < gap) { gap = d; best = m; }
  }
  return best;
}
// Older messages, 300 at a time (up to four rounds), until the loaded history reaches back to `at`.
async function ntReach(t, at) {
  const s = ts(t);
  for (let i = 0; i < 4 && s.msgs.length && s.msgs[0].ts > at; i++) {
    let r;
    try { r = await api(`/api/history?target=${enc(t)}&limit=300&before=${enc(s.msgs[0].ts)}`); } catch { return; }
    const add = (r.events || []).filter(e => !s.mk.has(msgKey(e)));
    if (!add.length) return;
    for (const e of add) { s.mk.add(msgKey(e)); s.msgs.push(e); }
    s.msgs.sort(byTs); s.cap += add.length;
    if (isFixedT(t)) dedupKeyed(s);
    if (t === target) renderAll(true);
  }
}
// Top of the message to the top of the visible timeline, just under the app bar (a message taller than the view is aligned the same way).
function ntAlignTop(node) {
  chatUnpin();
  const a = timeline.getBoundingClientRect(), b = node.getBoundingClientRect(), bar = $("#appbar").getBoundingClientRect();
  const inset = Math.max(0, bar.bottom - a.top) + 20;
  const top = Math.max(0, timeline.scrollTop + b.top - a.top - inset);
  timeline.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
// A notice whose source message is on screen in the open chat counts as seen: read here and on the hub (so the other devices agree).
// What waits on the owner (ntNeeds) stays until it is answered or ignored.
let ntSeenT = 0;
function ntSeenSoon() { clearTimeout(ntSeenT); ntSeenT = setTimeout(ntSeen, 500); }
function ntSeen() {
  if (current !== "chat" || document.visibilityState !== "visible" || !NT.loaded || !timeline.clientHeight) return;
  const pending = NT.items.filter(n => !n.read && !ntNeeds(n) && (n.src || n.open) === target && n.at);
  if (!pending.length) return;
  const a = timeline.getBoundingClientRect(), shown = new Set();
  for (const m of tl.querySelectorAll("[data-ts]")) {
    const r = m.getBoundingClientRect();
    if (r.bottom > a.top && r.top < a.bottom) shown.add(m.dataset.ts);
  }
  const hit = pending.filter(n => shown.has(n.at));
  if (!hit.length) return;
  for (const n of hit) n.read = true;
  NT.unread = Math.max(0, NT.unread - hit.length); ntPaint();
  ntMarkRead({ ids: hit.map(n => n.id) });
}
timeline.addEventListener("scroll", ntSeenSoon, { passive: true });
document.addEventListener("visibilitychange", ntSeenSoon);
// The element that carries the highlight: the card or bubble inside the message when there is one (so the glow follows its own rounded shape),
// else the message itself, drawn as a bar + tint ("nt-bar"). ~2s soft fade (a brief still tint under reduced motion: 09-notices.css).
function ntHlHost(node) {
  const card = node.matches(".um") ? node.querySelector(":scope > .ub") : node.matches(".bm") ? node.querySelector(":scope > .ccard") : node.matches(".cmdbox") ? node.querySelector(":scope > .ccard") : node.matches(".sn, .pn, .ccard") ? node : null;
  if (!card && node.matches(".bm.rep, .bm.alert")) return { host: node, bar: false };   // these carry their own rounded card background
  return { host: card || node, bar: !card };
}
function ntFlash(node) {
  const { host, bar } = ntHlHost(node);
  for (const x of tl.querySelectorAll(".nt-hl")) x.classList.remove("nt-hl", "nt-bar");
  void host.offsetWidth;
  host.classList.add("nt-hl");
  host.classList.toggle("nt-bar", bar);
  clearTimeout(host._hl);
  host._hl = setTimeout(() => host.classList.remove("nt-hl", "nt-bar"), 2300);
}
let ntJumpSeq = 0;
async function ntJump(n) {
  const seq = ++ntJumpSeq, at = n.at || n.updated || n.ts, t = ntGo(n.src || n.open || "main");
  if (!t) return;
  CV.landed = true;   // no jump to the "새 메시지" divider: this opening lands on the message
  chatUnpin();
  try {
    if (!(ts(t).hLoaded && ts(t).aLoaded)) await loadTarget(t);
    await ensureMsg(t, at);   // a stale stream may not have the message yet: fetch it before jumping
    await ntReach(t, at);
    await ntRaf(); await ntRaf();   // after the renders' own scroll-to-bottom
    if (seq !== ntJumpSeq || target !== t || current !== "chat") return;
    const m = ntFind(at);
    if (m) { ntAlignTop(m); ntFlash(m); }
  } catch {}
}

// A tapped push: open its conversation and land on the message it is about (loaded first when the stream missed it).
function pushOpen(hash, at) {
  const p = parseHash(hash), t = p.t || MAIN;
  if (at && p.view === "chat") noticeOpen(ntMsgFor(t, at) || { kind: "message", tone: "", src: t, open: t, at });
  else go(p.view, p.t);
}

/* ---- one handler for every notice entry point ---- */
// The corner toast, a tapped push, a row of 답변 필요, a row of the 홈 notice cards and a message tapped in the 알림 / 작업내역 conversations all end in
// noticeOpen: the item opens by the kind of thing it links to, never by where it was tapped.
//   sheet    a decision notice (hub/notices.ts kind "decision")           -> the bottom decision sheet over the current screen
//   ask      an [ask] message whose question still waits                    -> the same sheet (else the conversation at that message)
//   detail   a failure alert                                                -> a detail sheet over the current screen
//   session  a session's report                                             -> that session's view
//   worklog  a 작업내역 post                                                 -> 작업내역, on that item
//   monitor  a 모니터링 notice whose monitor still exists                   -> 모니터링, at that monitor
//   message  anything else (plain message, result)                         -> the conversation, on that message
function noticeKindAction(n, mons = NM.items) {
  if (ntIsDec(n) || ntLinkedDec(n)) return "sheet";
  if (n.tone === "ask") return "ask";
  if (n.kind === "alert" && n.tone === "fail") return "detail";
  if (n.kind === "result" || String(n.src || n.open || "").startsWith("lane:")) return "session";
  if (n.kind === "worklog") return "worklog";
  if (n.kind === "watch" && mons.some(m => m.name === n.title)) return "monitor";
  return "message";
}
async function noticeOpen(n) {
  if (!n) return;
  const a = noticeKindAction(n);
  if (a === "detail" || a === "session" || a === "monitor") ntRead(n);   // no chat view follows these, so nothing else would mark them seen
  switch (a) {
    case "sheet": return noticeSheetOpen((ntLinkedDec(n) || n).id);
    case "ask": if (await ntAskSheet(n)) return; return ntJump(n);   // answered or gone: the conversation
    case "detail": return ntDetailOpen(n);
    case "session": return ntSession(n);
    case "monitor": return monOpen(n.title);
    default: return ntJump(n);
  }
}
async function noticeOpenId(id) {
  let n = ntById(id);
  if (!n) { await loadNotices(); n = ntById(id); }
  if (!n) { toast("이 알림은 이미 처리됐어요"); return; }
  return noticeOpen(n);
}
function ntRead(n) {
  if (!n.id || n.read || ntNeeds(n) || !ntById(n.id)) return;
  n.read = true; NT.unread = Math.max(0, NT.unread - 1); ntPaint(); homeSoon();
  ntMarkRead({ ids: [n.id] });
}
// The stored notice of a message (its decision first), by conversation and event time; a 작업내역 line of a session is stored under the session, so time alone is the fallback.
const ntMsgFor = (src, at) => NT.items.find(x => ntIsDec(x) && x.decision.to === src && x.decision.reply_to === at)
  || NT.items.find(x => (x.src || x.open) === src && x.at === at) || NT.items.find(x => x.at === at) || null;
// A conversation event (toast, a message of the 알림 / 작업내역 conversations) as a notice: the stored one, else one drawn from the event itself.
function ntOfEvent(e) {
  const own = e.kind === "out" && (e.target === "alert" || e.target === "worklog") ? e.target : "";
  const lane = e.kind === "lane_report" ? String(e.lane || "") : "";
  const src = e.ask && e.target ? e.target : own || (lane ? `lane:${lane}` : e.open || MAIN);
  const real = ntMsgFor(src, e.ts);
  if (real) return real;
  const p = parseTone(noHandoff(String(e.text || "")));
  return { id: "", kind: own === "alert" ? "alert" : own === "worklog" ? "worklog" : lane ? "result" : "message", tone: e.ask ? "ask" : own || lane ? p.tone : "",
    title: e.title || (own === "alert" ? "알림" : own === "worklog" ? "작업 기록" : lane ? `세션 ${lane}` : botName), text: p.text, src, open: src, at: e.ts, ts: e.ts };
}
function ntSession(n) {
  const t = n.src || n.open;
  if (isLaneT(t) && S && S.lanes.some(l => `lane:${l.name}` === t)) openTarget(t, lastChatView());
  else ntJump(n);   // the session is gone: its result card in the main chat
}
async function monOpen(name) {
  go("monitoring");
  await ntRaf(); await ntRaf();
  const row = [...document.querySelectorAll("#v-monitoring [data-mon-name]")].find(r => r.dataset.monName === name);
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  row.classList.remove("nt-hl"); void row.offsetWidth;
  row.classList.add("nt-hl");
  setTimeout(() => row.classList.remove("nt-hl"), 2300);
}
// A message tapped in the 알림 / 작업내역 conversations opens like its notice does (capture phase: the choice rows inside it do not answer in place there).
timeline.addEventListener("click", ev => {
  if (current !== "chat" || !isFixedT(target) || !(ev.target instanceof Element)) return;
  const m = ev.target.closest(".bm[data-ts]");
  if (!m || !tl.contains(m) || ev.target.closest("a, summary, details[open] pre, input, textarea, button:not(.dcm-row)") || getSelection().toString()) return;
  const e = ts(target).msgs.find(x => x.ts === m.dataset.ts);
  if (!e) return;
  ev.stopPropagation(); ev.preventDefault();
  noticeOpen(ntOfEvent(e));
}, true);

/* ---- decision sheet: the docked decision card (10-decision-card.js) over the current screen ---- */
// Same card and same answer path as the one above the composer, for the conversation the notice came from; no navigation, no scroll.
const DK = { node: null, box: null, ov: null, dc: null, seq: 0, opener: null, timer: 0, nid: "", ign: "" };   // ign: the notice its x (무시) ignores
function dkClose(restore = true) {
  ++DK.seq; clearTimeout(DK.timer); DK.timer = 0;
  if (!DK.node) return;
  DK.node.remove(); DK.node = DK.box = DK.dc = null; DK.nid = DK.ign = "";
  ovDone(DK.ov); DK.ov = null;
  document.removeEventListener("keydown", dkKey, true);
  if (restore && DK.opener && DK.opener.isConnected) DK.opener.focus({ preventScroll: true });
  DK.opener = null;
}
function dkKey(ev) { if (ev.key === "Escape" && DK.node) { ev.preventDefault(); ev.stopPropagation(); dkClose(); } }
function dkPaint() {
  if (!DK.node) return;
  let dc = DK.dc;
  if (DK.nid) {   // a draft sheet follows its own notice
    const n = ntById(DK.nid);
    if (!n || !ntOpenDec(n)) { const answered = !!n && ntIsDec(n) && !ntIgnoredDec(n); dkClose(false); if (answered) toast("답을 보냈어요"); return; }
  } else {
    dc = decisionOf(DK.dc.t);
    if (!dc || dc.sig !== DK.dc.sig) { dkClose(false); return; }   // answered, here or elsewhere
    DK.dc = { ...dc, close: dkClose, ignore: DK.dc.ignore };
  }
  const picks = DC.picks[dc.key] || [], step = DC.step[dc.key] ?? Math.max(0, dc.blocks.findIndex((_, i) => !picks[i]));
  DK.box.dataset.key = dc.key;
  renderDecision(DK.box, DK.dc, picks, step);
  if (DC.st[dc.key] === "sent" && !DK.timer) DK.timer = setTimeout(() => { dkClose(false); toast("답을 보냈어요"); }, 900);
}
function dkOpen(dc, draft, nid, ign) {
  dkClose(false);
  DK.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  DK.nid = nid || "";
  const waits = !!ign && !!ign.id && ntNeeds(ign);
  DK.ign = waits ? String(ign.id) : "";
  DK.dc = { ...dc, close: dkClose, draft: draft || null, ignore: waits ? () => ntIgnore(ign) : null };
  DK.box = el("section", { class: "dcard dk-card", role: "dialog", "aria-label": "결정이 필요해요", tabindex: "-1" });
  DK.node = el("div", { class: "dk-bd", onpointerdown: ev => { if (ev.target === DK.node) dkClose(); } }, DK.box);
  document.body.append(DK.node);
  DK.ov = ovOpen(() => dkClose(false));
  document.addEventListener("keydown", dkKey, true);
  dkPaint();
  DK.box.focus({ preventScroll: true });   // not a row: a focus ring on the first option would read as a pick
}
// Opens the sheet for an [ask] notice whose question still waits in its conversation; false when it does not (answered, gone): the caller jumps.
async function ntAskSheet(n) {
  const t = n.src || n.open || "main", at = n.at || n.updated || n.ts, seq = ++DK.seq;
  if (!validTarget(t)) return false;
  try {
    if (!(ts(t).hLoaded && ts(t).aLoaded)) await loadTarget(t);
    await ensureMsg(t, at);
  } catch { return false; }
  if (seq !== DK.seq) return true;   // another tap or a close came meanwhile
  const dc = decisionOf(t);
  if (!dc || !dc.blocks.length || (n.at && dc.at && dc.at !== n.at)) return false;
  dkOpen(dc, null, "", n);
  return true;
}
// A draft waiting for send approval (hub/draft-approval.ts): the same sheet, built from the notice itself, with the draft above the three choices.
function ntDraftSheet(n) {
  const d = n.decision;
  dkOpen({ key: `dk:${n.id}`, t: d.to, sig: `dk:${n.id}`, at: d.reply_to || n.at || "", question: "", blocks: [{ title: n.title, options: d.options }] }, d.draft, String(n.id), n);
}
// An entry that comes from a session names its parent project and status, in the words of sessionRow.
function ntLaneNote(n) {
  const name = typeof n.key === "string" && n.key.startsWith("lane:") ? n.key.slice(5) : "", l = name && S && S.lanes.find(x => x.name === name);
  return l ? `${laneProject(l) || "프로젝트 없음"} · ${sessionStatus(l)[0]}` : "";
}

/* ---------- decisions: a question that waits on the owner ---------- */
// Hub: kind "decision" notices (hub/notices.ts) carry decision = { options, to, reply_to, group, state, answer }. An open one stays unread and
// shown on 홈 and cannot be dismissed; tapping it opens a sheet with the whole text and one button per option. A
// button posts /api/notices/:id/answer: the hub sends the answer to the chat, session or login request the question came from.
const ntIsDec = n => n.kind === "decision" && !!n.decision;
const ntOpenDec = n => ntIsDec(n) && n.decision.state === "open";
// Waits on the owner's action: an open decision or an [ask] item (the alert / message twin of one), unread and not ignored. Same rule as
// hub/notices.ts needsAnswer, which keeps these unread however they are viewed: only an answer, a resolving signal or the x (무시) clears them.
const ntNeeds = n => !n.read && !n.ignored && !n.dismissed && (ntOpenDec(n) || n.tone === "ask");
const ntIgnoredDec = n => ntIsDec(n) && n.decision.state === "ignored";
// The open decision a notice carries or links to: itself, or the one asked in the same conversation at the same time (the [ask] alert twin the hub
// stores beside it), or the newest one of the conversation for that conversation's latest-message item (key msg:<conversation>).
const ntLinkedDec = n => {
  if (ntOpenDec(n)) return n;
  const t = n.src || n.open;
  return NT.items.find(d => ntOpenDec(d) && d.decision.to === t && n.at && d.decision.reply_to === n.at)
    || (n.kind === "message" && n.key === `msg:${t}` ? ntDecisions().find(d => d.decision.to === t) : null) || null;
};
const ntById = id => NT.items.find(x => String(x.id) === String(id));
const ntDecisions = () => NT.items.filter(ntOpenDec).sort((a, b) => ntAt(b) - ntAt(a));
const ntHasDecision = t => NT.items.some(n => ntOpenDec(n) && n.decision.to === t);
const ntDecWhere = d => d.to.startsWith("auth:") ? "로그인 요청" : targetName(d.to);
const ntOptsOrdered = opts => [...opts].sort((a, b) => Number(b.rec) - Number(a.rec) || a.n - b.n);
function ntApply(item, unread) {
  if (item) { const i = NT.items.findIndex(x => x.id === item.id); if (i >= 0) NT.items[i] = item; else NT.items.push(item); }
  if (typeof unread === "number") NT.unread = unread;
  ntPaint();
  ntSheetPaint();
  dkPaint();
  homeSoon();
  syncInlineChoices();
}
// Throws with the hub's reason when the answer could not be delivered.
async function ntPost(n, num, note) {
  const r = await api(`/api/notices/${enc(n.id)}/answer`, "POST", { n: num, ...(note ? { note } : {}) });
  ntApply(r.item, r.unread);
}
// The open decision that is this chat card's question (a card with one block), so the card and the notice answer through the same path.
function ntFor(t, at, opt) {
  return NT.items.find(n => ntOpenDec(n) && n.decision.to === t && n.decision.group === 1 && n.decision.reply_to === at && n.decision.options.some(o => o.n === opt.n && o.label === opt.label)) || null;
}

// The x (무시) on a question that waits: off the badge and 답변 필요, kept in the history as 무시함, nothing is sent to the bot. The toast undoes it.
async function ntIgnore(n) {
  if (!n || !n.id || !ntNeeds(n)) return;
  const id = String(n.id);
  try {
    const r = await api(`/api/notices/${enc(id)}/ignore`, "POST", {});
    ntApply(r.item, r.unread);
    if (r.ids && r.ids.length > 1) loadNotices();   // its alert / message twins changed too; their live frames follow, the refetch makes sure
  } catch (err) { toast(err.message, true); return; }
  if (NS.node && NS.id === id) ntSheetClose(false);
  if (DK.node && DK.ign === id) dkClose(false);
  toast("무시했어요", false, { label: "되돌리기", onclick: () => ntUnignore(id) }, 6000);
}
async function ntUnignore(id) {
  try {
    const r = await api(`/api/notices/${enc(id)}/unignore`, "POST", {});
    ntApply(r.item, r.unread);
    if (r.ids && r.ids.length > 1) loadNotices();
    toast("다시 답변 필요로 돌렸어요");
  } catch (err) { toast(err.message, true); }
}
// The 44px x of a row. It stops the click and key events so the row behind it does not open.
function ntIgnoreBtn(n) {
  return el("button", { type: "button", class: "ib nt-x", title: "무시", "aria-label": `${ntPlain(n.title) || "알림"} 무시`,
    onclick: ev => { ev.stopPropagation(); ntIgnore(n); }, onkeydown: ev => ev.stopPropagation() }, icon("close"));
}

// One row of the home card 답변 필요 (same markup as 08-home.js homeNowRow): tap = the detail sheet, x = ignore.
function ntHomeRow(n) {
  return el("div", { class: "hr hrx" },
    el("button", { class: "hrx-m", type: "button", onclick: () => noticeOpen(n), "aria-label": `${ntPlain(n.title)} · 답변 필요` },
      el("span", { class: "dot att" }),
      el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: ntPlain(n.title) })), el("span", { class: "ha", text: ntDecWhere(n.decision) })),
      el("span", { class: "hs warn", text: "답변 필요" })),
    ntIgnoreBtn(n));
}

/* ---- detail sheet ---- */
const NS = { id: "", det: null, node: null, ov: null, busy: false, opener: null };   // det: a notice shown read-only (a failure alert), not looked up by id
function ntSheetClose(restore = true) {
  if (!NS.node) return;
  NS.node.remove(); NS.node = null; NS.id = ""; NS.det = null;
  ovDone(NS.ov); NS.ov = null;
  document.removeEventListener("keydown", ntSheetKey, true);
  if (restore && NS.opener && NS.opener.isConnected) NS.opener.focus({ preventScroll: true });
  NS.opener = null;
}
function ntSheetKey(ev) {
  if (!NS.node) return;
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); ntSheetClose(); return; }
  if (ev.key !== "Tab") return;
  const f = [...NS.node.querySelectorAll("button:not([disabled])")];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], at = document.activeElement;
  if (!NS.node.contains(at)) { ev.preventDefault(); first.focus(); }
  else if (ev.shiftKey && at === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
}
// "직접 답하기": to the asking message in its chat (a login request: its own form).
function ntDirect(n) {
  ntSheetClose(false);
  if (n.decision.to.startsWith("auth:")) { const f = document.querySelector("#authbox input"); if (f) { f.scrollIntoView({ block: "center" }); f.focus(); } else toast("입력 창이 이미 닫혔어요"); return; }
  ntJump(n);
}
async function ntAnswer(n, opt) {
  if (opt.action === "form") { ntDirect(n); return; }
  NS.busy = true; ntSheetPaint();
  try { await ntPost(n, opt.n); }
  catch (err) { toast(err.message, true); }
  NS.busy = false; ntSheetPaint();
}
// A failure alert: its whole text in the same sheet over the current screen, with the way into the conversation.
function ntDetailOpen(n) {
  ntSheetClose(false);
  ntSheetShow(String(n.id || ""), n);
}
function ntDetailPaint(n) {
  const x = el("button", { type: "button", class: "ib", "aria-label": "닫기", onclick: () => ntSheetClose() });
  x.append(icon("close"));
  clear($(".ds-sheet", NS.node)).append(
    el("div", { class: "ds-hd" }, el("span", { class: "ds-ey", text: "문제가 생겼어요" }), x),
    el("div", { class: "ds-body" },
      el("h2", { class: "ds-t", id: "ds-t", text: ntPlain(n.title) || "알림" }),
      el("div", { class: "ds-m", text: ntWhen(n) }),
      mdNode(fileLines(n.text).text, "md ds-md")),
    el("div", { class: "ds-foot" },
      el("button", { type: "button", class: "ds-direct", "data-k": "go", onclick: () => { ntSheetClose(false); ntJump(n); }, text: "대화에서 보기" }),
      el("button", { type: "button", class: "ds-opt rec c", "data-k": "close", onclick: () => ntSheetClose(), text: "닫기" })));
}
function ntSheetPaint() {
  if (!NS.node) return;
  if (NS.det) { ntDetailPaint(NS.det); return; }
  const n = ntById(NS.id);
  if (!n || !ntIsDec(n)) { ntSheetClose(false); return; }
  const d = n.decision, open = d.state === "open", ignd = d.state === "ignored", keep = NS.node.contains(document.activeElement) ? document.activeElement.dataset.k : "";
  const x = el("button", { type: "button", class: "ib", "aria-label": "닫기", onclick: () => ntSheetClose() });
  x.append(icon("close"));
  const kids = [
    el("div", { class: "ds-hd" }, el("span", { class: `ds-ey${open ? "" : ignd ? " ign" : " done"}`, text: open ? "답변이 필요해요" : ignd ? "무시했어요" : d.resolved ? "해결됐어요" : "답변했어요" }),
      open ? el("button", { type: "button", class: "ds-ign", "data-k": "ignore", disabled: NS.busy, onclick: () => ntIgnore(n) }, icon("close"), el("span", { text: "무시" })) : null, x),
    el("div", { class: "ds-body" },
      el("h2", { class: "ds-t", id: "ds-t", text: ntPlain(n.title) || "답변이 필요해요" }),
      el("div", { class: "ds-m", text: `${ntDecWhere(d)} · ${ntWhen(n)}` }),
      mdNode(fileLines(n.text).text, "md ds-md"))];
  const foot = el("div", { class: "ds-foot" });
  if (open) {
    for (const o of ntOptsOrdered(d.options)) foot.append(el("button", { type: "button", class: `ds-opt${o.rec ? " rec" : ""}`, "data-k": `o${o.n}`, disabled: NS.busy, onclick: () => ntAnswer(n, o) },
      el("span", { class: "ds-lb" }, o.label, o.rec ? el("span", { class: "ds-tag", text: "추천" }) : null),
      o.desc ? el("span", { class: "ds-ds", text: o.desc }) : null));
    foot.append(el("button", { type: "button", class: "ds-direct", "data-k": "direct", disabled: NS.busy, onclick: () => ntDirect(n), text: d.to.startsWith("auth:") ? "입력 창으로 가기" : "직접 답하기" }));
    if (NS.busy) foot.append(el("div", { class: "ds-st", role: "status", text: "보내는 중…" }));
  } else if (ignd) {
    foot.append(el("div", { class: "ds-res", role: "status" }, el("span", { class: "ds-rl ign", text: "무시했어요" }), el("span", { class: "ds-ra", text: "답하지 않고 넘겼어요" })));
    foot.append(el("button", { type: "button", class: "ds-direct", "data-k": "undo", onclick: () => ntUnignore(n.id), text: "되돌리기" }));
    if (!d.to.startsWith("auth:")) foot.append(el("button", { type: "button", class: "ds-direct", "data-k": "go", onclick: () => { ntSheetClose(false); ntJump(n); }, text: "대화에서 보기" }));
    foot.append(el("button", { type: "button", class: "ds-opt rec c", "data-k": "close", onclick: () => ntSheetClose(), text: "닫기" }));
  } else {
    foot.append(el("div", { class: "ds-res", role: "status" }, el("span", { class: "ds-rl", text: d.resolved ? "답 없이 끝났어요" : "이렇게 답했어요" }), el("span", { class: "ds-ra", text: d.resolved ? "일이 끝나서 닫혔어요" : ntPlain(d.answer || "") || "답했어요" })));
    if (!d.to.startsWith("auth:")) foot.append(el("button", { type: "button", class: "ds-direct", "data-k": "go", onclick: () => { ntSheetClose(false); ntJump(n); }, text: "대화에서 보기" }));
    foot.append(el("button", { type: "button", class: "ds-opt rec c", "data-k": "close", onclick: () => ntSheetClose(), text: "닫기" }));
  }
  kids.push(foot);
  const sheet = $(".ds-sheet", NS.node), top = $(".ds-body", sheet) ? $(".ds-body", sheet).scrollTop : 0;
  clear(sheet).append(...kids);
  $(".ds-body", sheet).scrollTop = top;
  const again = keep ? sheet.querySelector(`[data-k="${keep}"]`) : null;
  if (again) again.focus({ preventScroll: true });
}
async function noticeSheetOpen(id) {
  let n = ntById(id);
  if (!n) { await loadNotices(); n = ntById(id); }
  if (!n || !ntIsDec(n)) { toast("이 알림은 이미 처리됐어요"); return; }
  if (NS.node && NS.id === String(n.id)) return;
  ntSheetClose(false);
  if (n.decision.draft && n.decision.state === "open") { ntDraftSheet(n); return; }
  ntSheetShow(String(n.id), null);
}
function ntSheetShow(id, det) {
  NS.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  NS.id = id; NS.det = det; NS.busy = false;
  NS.node = el("div", { class: "ds-bd", onpointerdown: ev => { if (ev.target === NS.node) ntSheetClose(); } }, el("div", { class: "ds-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "ds-t" }));
  document.body.append(NS.node);
  NS.ov = ovOpen(() => ntSheetClose(false));
  document.addEventListener("keydown", ntSheetKey, true);
  ntSheetPaint();
  const first = NS.node.querySelector(".ds-opt, .ds-direct");
  if (first) first.focus({ preventScroll: true });
}

// A tapped notification (or an option button on it) asks an open window to show the decision; a cold start carries it as ?n=<id>.
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", ev => { const d = ev.data || {}; if (d.notice) noticeOpenId(d.notice); });
{
  const want = PUSH_FOLLOW ? "" : new URLSearchParams(location.search).get("n") || "";   // a relayed notice's ?n names an item on the other computer (prFollow)
  if (want) {
    const u = new URL(location.href);
    u.searchParams.delete("n");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    setTimeout(() => noticeOpenId(want), 500);
  }
}

ntPaint();
loadNotices();
