/* ---------- decisions and notices: the data behind 홈's 답변 필요 / 알림 / 작업내역 cards and the decision sheet ---------- */
// Data: GET /api/notices, POST /api/notices/read, POST /api/notices/:id/answer; live frames {kind:"notice"} / {kind:"notice_read"} from the event stream
// (routed here by 99-boot.js, never into the chat timeline or the corner toasts). There is no notice list screen: 알림 and 작업내역 are their own
// conversations (chat list), 모니터링 is its own screen (30-monitoring.js); what waits on the owner shows on 홈 and in the decision sheet below.
const ntTabOf = n => n.kind === "worklog" ? "worklog" : n.kind === "watch" ? "watch" : "alert";
const NT = { items: [], unread: 0, loaded: false, failed: false };
// The 홈 알림 card lists alerts only: a reply in a conversation or a session's report (kind message / result) is not a notice there; it is
// unread in its own conversation, which the 채팅 tab and the session list lead to (owner 2026-10-23).
const ntHomeAlert = n => ntTabOf(n) === "alert" && n.kind !== "message" && n.kind !== "result";
const ntUnreadIn = tab => NT.items.reduce((c, n) => c + (!n.read && (tab === "all" || ntTabOf(n) === tab) ? 1 : 0), 0);

const ntAt = n => Date.parse(n.updated || n.ts) || 0;
const ntTime = t => kstDay(t) === kstDay(Date.now()) ? kstHM(t) : `${dayLabel(t)} ${kstHM(t)}`;
const ntWhen = n => ntTime(n.updated || n.ts);
// Row text is plain: markdown marks (links, headings, bullets, emphasis, code) are dropped.
const ntPlain = s => stripMarkers(s)
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
  if (current === "monitoring") monSchedule();
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
  chatUnpin();
  CV.jump = at;   // set after ntGo (a new opening resets it): the opening's first draw lands on this message, not on the "새 메시지" divider (chatOpen)
  try {
    if (!(ts(t).hLoaded && ts(t).aLoaded)) await loadTarget(t);
    await ensureMsg(t, at);   // a stale stream may not have the message yet: fetch it before jumping
    await ntReach(t, at);
    for (let i = 0; i < 300 && seq === ntJumpSeq && !CV.placed; i++) await ntRaf();   // the opening's first draw waits for the read position (chatReady)
    if (seq !== ntJumpSeq || target !== t || current !== "chat") return;
    const m = ntFind(at);
    if (m) { chatJump(m); ntFlash(m); }
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
//   monitor  a 모니터링 notice (a watch or schedule report)              -> 모니터링, at its monitor or 감시 소식
//   message  anything else (plain message, result)                         -> the conversation, on that message
function noticeKindAction(n, mons = NM.items) {
  if (ntIsDec(n) || ntLinkedDec(n)) return "sheet";
  if (n.tone === "ask") return "ask";
  if (n.kind === "alert" && n.tone === "fail") return "detail";
  if (n.kind === "result" || String(n.src || n.open || "").startsWith("lane:")) return "session";
  if (String(n.src || n.open || "").startsWith("settings:")) return "app";   // a monitor's or app's settings conversation: it lives in 모니터링, not in 채팅
  if ((n.src || n.open) === "settings") return "settings";   // an account / update alert: 설정
  if (n.kind === "worklog") return "worklog";
  if (n.kind === "watch") return "monitor";
  return "message";
}
async function noticeOpen(n) {
  if (!n) return;
  const a = noticeKindAction(n);
  if (a === "detail" || a === "session" || a === "monitor" || a === "settings" || a === "app") ntRead(n);   // no chat view follows these, so nothing else would mark them seen
  switch (a) {
    case "sheet": return noticeSheetOpen((ntLinkedDec(n) || n).id);
    case "ask": if (await ntAskSheet(n)) return; return ntJump(n);   // answered or gone: the conversation
    case "detail": return ntDetailOpen(n);
    case "session": return ntSession(n);
    case "monitor": return monOpen(n);
    case "app": return ntApp(n);
    case "settings": return void go("settings");
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
const monOpen = n => go("monitoring", monKeyOf(n));
// A settings conversation: opened inside 모니터링 (go's "c:" form); a target the page cannot open lands on 홈.
function ntApp(n) {
  const t = n.src || n.open;
  go(...(validTarget(t) ? ["monitoring", `c:${t}`] : ["home"]));
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
const DK = { h: null, node: null, box: null, dc: null, seq: 0, timer: 0, nid: "", ign: "" };   // ign: the notice its x (무시) ignores
function dkClose(restore = true) {
  ++DK.seq; clearTimeout(DK.timer); DK.timer = 0;
  if (DK.h) DK.h.close(restore);
}
function dkPaint() {
  if (!DK.node) return;
  let dc = DK.dc;
  if (DK.nid) {   // a draft sheet follows its own notice
    const n = ntById(DK.nid), rv = n ? ntRevising(n) : null;
    if (rv) {   // 고치기 was answered: the sheet keeps the old draft with 고치는 중… until the new one lands, then shows that one
      const nx = ntSuccessor(n);
      if (nx && ntOpenDec(nx)) { ntDraftSheet(nx); return; }
      if (nx) { dkClose(false); return; }
      if (!DC.picks[dc.key]) { DC.picks[dc.key] = [rv]; DC.st[dc.key] = "sent"; delete DC.edit[dc.key]; }
    } else if (!n || !ntOpenDec(n)) { const answered = !!n && ntIsDec(n) && !ntIgnoredDec(n); dkClose(false); if (answered) toast("답을 보냈어요"); return; }
  } else {
    dc = decisionOf(DK.dc.t);
    if (!dc || dc.sig !== DK.dc.sig) { dkClose(false); return; }   // answered, here or elsewhere
    DK.dc = { ...dc, close: dkClose, ignore: DK.dc.ignore };
  }
  const picks = DC.picks[dc.key] || [], step = DC.step[dc.key] ?? Math.max(0, dc.blocks.findIndex((_, i) => !picks[i]));
  const sig = dcSig(dc, picks, step);
  if (DK.box.dataset.sig !== sig) { DK.box.dataset.key = dc.key; renderDecision(DK.box, DK.dc, picks, step); DK.box.dataset.sig = sig; }
  if (DC.st[dc.key] === "sent" && !DK.timer && !(dc.draft && dcStText(dc, "sent") === "고치는 중…")) DK.timer = setTimeout(() => { dkClose(false); toast("답을 보냈어요"); }, 900);
}
function dkOpen(dc, draft, nid, ign) {
  dkClose(false);
  DK.nid = nid || "";
  const waits = !!ign && !!ign.id && ntNeeds(ign);
  DK.ign = waits ? String(ign.id) : "";
  DK.dc = { ...dc, close: dkClose, draft: draft || null, ignore: waits ? () => ntIgnore(ign) : null };
  const h = fsOpen({ label: draft ? "보낼 내용 확인" : "결정이 필요해요", cls: draft ? "tall" : "", onClose: () => { if (DK.h === h) { DK.h = DK.node = DK.box = DK.dc = null; DK.nid = DK.ign = ""; } } });
  DK.h = h; DK.node = h.node; DK.box = h.box;
  dkPaint();   // the card itself holds the focus, not a row: a focus ring on the first option would read as a pick
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
// A draft whose 고치기 was answered: its 고치기 option, until the new draft of the same conversation arrives (the successor).
const ntRevising = n => {
  if (!ntIsDec(n) || !n.decision.draft || n.decision.state !== "answered") return null;
  const m = /^\s*(\d+)\)/.exec(String(n.decision.answer || "")), o = m && n.decision.options.find(x => x.n === Number(m[1]));
  return o && o.label === DRAFT_EDIT ? o : null;
};
const ntSuccessor = n => NT.items.find(x => x.id !== n.id && ntIsDec(x) && x.decision.draft && x.decision.to === n.decision.to && String(x.ts) > String(n.ts)) || null;
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
// Loose [ask] notices: waiting on the owner, but not carrying (or linked to) an open decision, so ntDecisions() never lists them.
const ntLooseAsks = () => NT.items.filter(n => ntNeeds(n) && !ntOpenDec(n) && !ntLinkedDec(n)).sort((a, b) => ntAt(b) - ntAt(a));
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
  const title = n.decision ? ntPlain(n.title) : hcLine(n), src = n.src || n.open;   // a loose [ask] notice has no decision: its conversation names where it waits
  return el("div", { class: "hr hrx" },
    el("button", { class: "hrx-m", type: "button", onclick: () => noticeOpen(n), "aria-label": `${title} · 답변 필요` },
      el("span", { class: "dot att" }),
      el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: title })), el("span", { class: "ha", text: n.decision ? ntDecWhere(n.decision) : ntLaneNote(n) || (src ? targetName(src) : "알림") })),
      el("span", { class: "hs warn", text: "답변 필요" })),
    ntIgnoreBtn(n));
}

// Send approvals (draft decisions) of one monitoring app instance are one row: "메일 답장 확인 3건". A tap unfolds the items, each one a normal row that opens its sheet.
// The count is of items, never of groups (the badges count NT.unread / `waiting`, untouched). A lone approval stays a plain row. The noun matches hub/notices.ts confirmNoun.
const NT_OPEN = new Set();
const ntGroupNoun = key => (key.split("-")[0] === "mail" || key.split("-")[0] === "kakao" ? "답장 확인" : "댓글 답글");
function ntGroupKey(n) {
  if (!ntOpenDec(n) || !n.decision.draft) return "";
  const it = ((typeof INTG === "object" && INTG.items) || []).find(i => (i.notices || []).includes(n.id));
  return it ? it.key : "";
}
function ntGroupRow(key, list) {
  const it = INTG.items.find(i => i.key === key), open = NT_OPEN.has(key), label = `${it.label} ${ntGroupNoun(key)} ${list.length}건`;
  const who = list.slice(0, 2).map(n => n.decision.draft.to).filter(Boolean).join(", ");
  const head = el("button", { class: "hrx-m ntg-h", type: "button", "aria-expanded": String(open), "aria-label": label, onclick: () => { if (open) NT_OPEN.delete(key); else NT_OPEN.add(key); homeSoon(); } },
    el("span", { class: "dot att" }),
    el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: label })), el("span", { class: "ha", text: who ? `${who}${list.length > 2 ? " 외" : ""}` : "하나씩 확인해 주세요" })),
    el("span", { class: "hs warn", text: open ? "접기" : "펼치기" }));
  return el("div", { class: `ntg${open ? " open" : ""}`, "data-group": key }, el("div", { class: "hr hrx" }, head), open ? el("div", { class: "ntg-l" }, ...list.map(ntHomeRow)) : null);
}
function ntHomeRows(list) {
  const by = new Map();
  for (const n of list) { const k = ntGroupKey(n); if (k) by.set(k, [...(by.get(k) || []), n]); }
  const seen = new Set(), rows = [];
  for (const n of list) {
    const k = ntGroupKey(n), g = k && by.get(k);
    if (!g || g.length < 2) rows.push(ntHomeRow(n));
    else if (!seen.has(k)) { seen.add(k); rows.push(ntGroupRow(k, g)); }
  }
  return rows;
}

/* ---- detail sheet ---- */
const NS = { id: "", det: null, h: null, node: null, busy: false, edit: null };   // edit: { id, opt, text, fresh } while the owner writes the detail an option asks for   // det: a notice shown read-only (a failure alert), not looked up by id
function ntSheetClose(restore = true) { if (NS.h) NS.h.close(restore); }
// "직접 답하기": to the asking message in its chat (a login request: its own form).
function ntDirect(n) {
  ntSheetClose(false);
  if (n.decision.to.startsWith("auth:")) { AUTH_HID.clear(); paintAuth(); const f = document.querySelector(".au input"); if (f) { f.scrollIntoView({ block: "center" }); f.focus(); } else toast("입력 창이 이미 닫혔어요"); return; }
  ntJump(n);
}
// Same rule as the hub (hub/notices.ts answerDecision): an option that needs detail is answered only with the owner's text.
const ntNeedsNote = (n, o) => !o.say && !o.action && (n.decision.draft ? o.label === DRAFT_EDIT : detailOf(o));
async function ntAnswer(n, opt, note) {
  if (opt.action === "form") { ntDirect(n); return; }
  if (!note && ntNeedsNote(n, opt)) { NS.edit = { id: String(n.id), opt, text: "", fresh: true }; ntSheetPaint(); return; }
  NS.busy = true; ntSheetPaint();
  try { await ntPost(n, opt.n, note); NS.edit = null; }
  catch (err) { toast(err.message, true); }
  NS.busy = false; ntSheetPaint();
}
function ntEditNode(n, ed) {
  const ta = el("textarea", { class: "dc-note", rows: "3", maxlength: "500", placeholder: "이유나 내용을 적어 주세요", "aria-label": "자세한 내용", disabled: NS.busy, oninput: () => { ed.text = ta.value; go.disabled = !ta.value.trim(); } });
  ta.value = ed.text;
  const go = el("button", { class: "dc-go", type: "button", "data-k": "send", disabled: NS.busy || !ta.value.trim(), onclick: () => { const note = ta.value.trim(); if (note) ntAnswer(n, ed.opt, note); } }, "내용 보내기");
  const back = el("button", { class: "dc-back", type: "button", "data-k": "back", disabled: NS.busy, onclick: () => { NS.edit = null; ntSheetPaint(); } }, "돌아가기");
  return el("div", { class: "dc-edit" }, el("div", { class: "dc-ctx" }, el("span", { class: "dc-key", text: String(ed.opt.n) }), el("span", { class: "dc-lb", text: ed.opt.label })), ta, el("div", { class: "dc-eb" }, back, go));
}
// A notice sheet's body: the text without its `[file]` lines, then those files as the same image / file chips a chat message shows (15-attachments.js).
function ntBody(n, text) {
  const fl = fileLines(text == null ? n.text : text);
  return [mdNode(ntCode(fl.text), "md ds-md"), filesNode(fl.files)];
}
// Ids, hashes and paths in the body read as `code` (they wrap anywhere); text already in backticks stays as it is.
function ntCode(text) {
  return String(text).split(/(`[^`]*`)/).map((s, i) => i % 2 ? s : s.replace(/(?<![\w:/.@(-])[\w.-]+\/[\w./-]*\w|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, m => `\`${m}\``)).join("");
}
// The first sentence of a line, 60 characters at most (cut at a word boundary with "…"), without its closing period (hub/notice-title.ts).
function ntShort(line, max = 60) {
  const one = String(line).replace(/\s+/g, " ").trim();
  const base = (/^.*?[.!?。？！](?=\s|$)/.exec(one) || [one])[0].replace(/[.。]+$/, "");
  if (base.length <= max) return base;
  const cut = base.slice(0, max), sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
// A notice sheet's title is one short line and its body the rest. A title that is not the text's own first sentence (a question, a block title)
// keeps the whole text as the body; a first sentence that had to be cut stays in the body in full.
function ntParts(n) {
  const text = stripMarkers(n.text).replace(/^\s*\[[^\]\n]{1,10}\][ \t]*/, "").trim(), title0 = ntPlain(n.title);
  const first = (text.split("\n").find(l => l.trim()) || "").trim();
  const m = /^.*?[.!?。？！](?=\s|$)/.exec(first), sent = m ? m[0] : first;
  const head = ntShort(sent.replace(/[*_`#>]/g, "")), a = head.replace(/…$/, ""), b = title0.replace(/…$/, "");
  if (!title0 || !a || !(a.startsWith(b) || b.startsWith(a))) return { title: ntShort(title0), rest: text };
  return { title: head, rest: head.endsWith("…") ? text : text.replace(sent, "").trim() };
}
// A failure alert: its whole text in the same sheet over the current screen, with the way into the conversation.
function ntDetailOpen(n) {
  ntSheetClose(false);
  ntSheetShow(String(n.id || ""), n);
}
function ntDetailPaint(n) {
  clear(NS.h.box).append(
    fsHead([el("span", { class: "fs-ey warn", text: "문제가 생겼어요" })], { close: () => ntSheetClose() }),
    el("div", { class: "fs-body" },
      el("h2", { class: "ds-t", id: "ds-t", text: ntPlain(n.title) || "알림" }),
      el("div", { class: "ds-m", text: ntWhen(n) }),
      ...ntBody(n)),
    el("div", { class: "fs-ft" },
      el("button", { type: "button", class: "ds-direct", "data-k": "go", onclick: () => { ntSheetClose(false); ntJump(n); }, text: "대화에서 보기" }),
      el("button", { type: "button", class: "ds-opt rec c", "data-k": "close", onclick: () => ntSheetClose(), text: "닫기" })));
}
function ntSheetPaint() {
  if (!NS.node) return;
  if (NS.det) { ntDetailPaint(NS.det); return; }
  const n = ntById(NS.id);
  if (!n || !ntIsDec(n)) { ntSheetClose(false); return; }
  const d = n.decision, open = d.state === "open", ignd = d.state === "ignored", parts = ntParts(n), keep = NS.node.contains(document.activeElement) ? document.activeElement.dataset.k : "";
  const kids = [
    fsHead([el("span", { class: `fs-ey ${open ? "warn" : ignd ? "ign" : "done"}`, text: `${ntDecWhere(d)} · ${open ? "답변 필요" : ignd ? "무시함" : d.resolved ? "해결됨" : "답변함"}` })],
      { ignore: open ? () => ntIgnore(n) : null, ignoreOff: NS.busy, close: () => ntSheetClose() }),
    el("div", { class: "fs-body" },
      el("h2", { class: "ds-t", id: "ds-t", text: parts.title || "답변이 필요해요" }),
      el("div", { class: "ds-m", text: ntWhen(n) }),
      ...ntBody(n, parts.rest))];
  const foot = el("div", { class: "fs-ft" }), ed = open && NS.edit && NS.edit.id === String(n.id) ? NS.edit : null;
  // Every notice event repaints the open sheet; one that changes nothing it shows leaves it alone, so the reason field being typed in is not
  // replaced (a new field takes the focus and a phone closes and reopens its keyboard).
  const sig = JSON.stringify([n.title, n.text, d, ntWhen(n), NS.busy, ed ? ed.opt.n : 0]);
  if (NS.h.box.dataset.sig === sig) return;
  NS.h.box.dataset.sig = sig;
  const hadNote = !!NS.node.querySelector(".dc-note:focus");
  if (ed) foot.append(ntEditNode(n, ed));
  else if (open) {
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
  const box = NS.h.box, top = $(".fs-body", box) ? $(".fs-body", box).scrollTop : 0;
  clear(box).append(...kids);
  $(".fs-body", box).scrollTop = top;
  const again = keep ? box.querySelector(`[data-k="${keep}"]`) : null;
  if (again) again.focus({ preventScroll: true });
  const ta = ed ? box.querySelector(".dc-note") : null;
  if (ta && (ed.fresh || hadNote)) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); ed.fresh = false; }
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
  NS.id = id; NS.det = det; NS.busy = false;
  const h = fsOpen({ labelledby: "ds-t", onClose: () => { if (NS.h === h) { NS.h = NS.node = null; NS.id = ""; NS.det = null; NS.edit = null; } } });
  NS.h = h; NS.node = h.node;
  ntSheetPaint();
  const first = NS.edit ? null : NS.node.querySelector(".ds-opt, .ds-direct");
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
