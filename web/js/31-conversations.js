/* ---------- 채팅: the chat list (KakaoTalk-style) and the read position (Discord-style) ---------- */
// Data: GET /api/conversations (hub/conversations.ts) gives every conversation's newest real message, the owner's read position
// and the unread count; POST /api/read moves the position forward and every device hears {kind:"read"} on the event stream.
// ts(t).unread (the counter the switcher and the nav already use) is that server count, kept current by convNote.
// CONV: target -> { ts, text, from } | null, READ: target -> ISO read position | null (state is declared in 09-needs-you.js).
const CONV_KINDS = new Set(["message", "lane_message", "out", "lane_report", "result", "mail", "schedule", "watch"]);

// A message the conversation shows (same rule as hub/conversations.ts isRealMessage), and one that can be unread: not the owner's own, no restart note.
// A post edited in place (update_key) is a message only in 알림 / 작업 기록; elsewhere it is a progress note.
const convKeyedOk = e => e.update_key !== "progress" && isFixedT(eventTarget(e) || "");
const convReal = e => CONV_KINDS.has(e.kind) && !(e.kind === "out" && e.update_key && !convKeyedOk(e));
// A gateway system line (`system`, 11-todo-strip.js sysLine) is a status, never unread (hub/conversations.ts countIncoming).
const convIncoming = e => convReal(e) && !OWNER.has(e.kind) && !cleanRestart(e) && !e.system;

// Same rule as hub/conversations.ts previewOf: first meaningful line, plain text, 120 chars.
function convPreview(raw) {
  const text = noticeKo(parseTone(previewSrc(raw)).text, NK);
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const plain = line.replace(/^\s*-#\s+/, "").replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_~`]+/g, "").replace(/\s+/g, " ").trim();
    if (plain) return plain.length > 120 ? `${plain.slice(0, 119)}…` : plain;
  }
  return "";
}
function convLastOf(e) {
  if (!convReal(e) || typeof e.ts !== "string") return null;
  const title = e.card && typeof e.card.title === "string" ? e.card.title : "";
  const text = convPreview(e.text) || convPreview(title) || (Array.isArray(e.files) && e.files.length ? "파일" : "");
  if (!text) return null;
  const from = e.kind === "message" || e.kind === "lane_message" ? "owner" : e.kind === "lane_report" || (typeof e.source === "string" && e.source.startsWith("lane:")) ? "session" : "bot";
  return { ts: e.ts, text, from };
}

// An ended session never counts unread (server rule: hub/conversations.ts unreadOf); a lane the state does not list yet is live.
const convEnded = t => { const l = isLaneT(t) && ((S && S.lanes) || []).find(x => `lane:${x.name}` === t); return !!l && !laneAlive(l); };
// A live message (called by ingestMsg once per new event): moves the row's preview and, unless the owner is looking at that
// conversation's bottom right now, adds to its unread count (server rule: hub/conversations.ts).
function convNote(e, t, was) {
  if (isMailT(t) && e.kind === "mail" && !MAILS.has(t)) MAILS.set(t, { subject: e.subject || "", from: e.from || "", source: e.source || "", at: e.ts, summary: e.summary || "", preview: e.preview || "", attachments: e.attachments || [], html: !!e.html });
  const last = convLastOf(e);
  if (!last) return;
  const prev = CONV.get(t);
  if (!prev || prev.ts <= last.ts) CONV.set(t, last);
  // `was`: the older version of an edited post, still unread = this one is the same unread message (counted once, like the hub does)
  const again = !!was && !(READ[t] && READ[t] >= was.ts);
  if (convIncoming(e) && !again && !convEnded(t) && !(READ[t] && READ[t] >= e.ts) && !(CV.key === t && chatStick && document.visibilityState === "visible")) { ts(t).unread++; renderBars(); }
  convSchedule();
}
// A mail the hub listed before and no longer does was deleted (on another device, or by the mailbox's own sync): it leaves this page too, and a view
// of it goes back to the list instead of answering "이 메일을 찾지 못했어요" on the next tap. A mail that only arrived live, or another computer's, is not touched.
let convHadMail = new Set();
function convDropGone(items) {
  const now = new Set(items.filter(it => it.mail).map(it => it.target)), gone = [...convHadMail].filter(t => !now.has(t) && !PQ.of.has(t));
  convHadMail = now;
  if (!gone.length) return;
  for (const t of gone) { MAILS.delete(t); CONV.delete(t); MBOX.sel.delete(t); ts(t).unread = 0; }
  if (current === "chat" && gone.includes(target)) go("monitoring", MON.sel || "i:mail");
  mbRefresh();
}
async function convLoad() {
  clearTimeout(convRetry);
  try {
    const r = await api("/api/conversations");
    for (const it of r.items || []) {
      const t = it.target, prev = CONV.get(t);
      if (it.mail) MAILS.set(t, it.mail);
      if (it.last && (!prev || prev.ts <= it.last.ts)) CONV.set(t, it.last);
      else if (!CONV.has(t)) CONV.set(t, null);
      let unread = it.unread | 0;
      const local = READ[t], last = CONV.get(t);
      // Our own read post may be ahead of what the server has answered with.
      if (local && (!it.read || local > it.read)) { if (last && last.ts <= local) unread = 0; }
      else READ[t] = it.read || null;
      ts(t).unread = unread;
    }
    convDropGone(r.items || []);
    CV.loaded = true; CV.failed = false;
    renderBars();
    if (convCapture() || (CV.key && !CV.placed)) renderAll();   // the first paint of an opening waits for this (chatReady)
    convMaybeRead();
  } catch {
    convRetry = setTimeout(convLoad, 5000);
    CV.failed = true;
    if (CV.key && !CV.placed) renderAll();
  }
  convSchedule();
}
// Another device (or this one) moved a read position.
function convOnRead(e) {
  const t = e.target, at = e.ts;
  if (typeof t !== "string" || typeof at !== "string" || (READ[t] && READ[t] >= at)) return;
  READ[t] = at;
  const last = CONV.get(t);
  if (last && last.ts <= at) { ts(t).unread = 0; renderBars(); }
  else { clearTimeout(convReadT); convReadT = setTimeout(convLoad, 300); }
}

/* ---- read position of the open conversation ---- */
// Which conversation is on screen right now, and what was already read when it was opened: the "새 메시지" divider goes before the
// first unread message of that moment and stays until the owner leaves. A mail without a divider opens at its top, not at the bottom. Opening again after reading shows no divider.
function convSync() {
  const key = current === "chat" && !convListing() ? target : "";
  if (key === CV.key) return false;
  chatUnpin(); clearTimeout(CV.gateT);
  Object.assign(CV, { key, div: "", divNode: null, jump: "", seeded: false, captured: false, failed: false, placed: false, full: false, snap: null, openAt: performance.now() });
  convCapture();
  return !!key;   // the caller draws the conversation: the divider is in it from the first paint
}
function convCapture() {
  if (!CV.key || CV.captured || !CV.loaded) return false;
  CV.captured = true;
  const at = READ[CV.key];
  if (!at || !(ts(CV.key).unread > 0)) return false;   // never opened before: nothing to compare with
  CV.div = at;
  if (CV.seeded) CV.placed = false;
  return true;
}
const convDivider = () => el("div", { class: "cv-new", role: "separator", "aria-label": "여기부터 읽지 않은 메시지" }, el("span", { text: "여기까지 읽음" }));
/* ---- where the timeline sits while an opening settles ---- */
// The first paint of an opening needs three answers: the history, the read position (/api/conversations, which decides the divider)
// and the todo plan (its strip pushes the timeline down). Until then "불러오는 중…" stays, so nothing is drawn at the wrong place
// first. A slow answer cannot hold it forever: the plan gives up after 0.7 s, the read position after 3 s (no divider then).
function chatReady() {
  if (!CV.key || CV.jump || CV.seeded) return true;   // a jump lands on its message and a stored copy (13-snapshot.js) shows at once: the plan's strip re-places them (chatPlace), a divider re-opens it (convCapture)
  const age = performance.now() - CV.openAt, convOk = CV.loaded || CV.failed || age > 3000, todoOk = TD.by[target] !== undefined || age > 700;
  if (convOk && todoOk) return true;
  clearTimeout(CV.gateT);
  CV.gateT = setTimeout(() => { if (CV.key && !CV.placed) renderAll(); }, Math.max(30, (todoOk ? 3000 : 700) - age));
  return false;
}
// After the timeline is drawn (renderAll0): the first drawing of an opening anchors the view to the divider (or the bottom when nothing is
// unread) in the same task, before any paint; later drawings keep the owner's place.
function chatOpen() {
  const snap = CV.snap; CV.snap = null;
  CV.full = true;
  if (!CV.key) { scrollChat(true); return; }
  if (!CV.placed) {
    CV.placed = true;
    if (CV.jump) {   // a jump target wins over the divider (ntJump)
      const m = ntFind(CV.jump);
      if (m) { chatJump(m); if (m.dataset.ts === CV.jump) ntFlash(m); return; }
      chatUnpin(); scrollChat(true); return;
    }
    // reloaded onto a new shell (23-installable-app-web.js): the place the owner was at, unless they were at the bottom
    const r = SHELL_RESTORE;
    if (r && r.key === CV.key && !r.stick && r.anchor) { SHELL_RESTORE = null; CV.pinTs = r.anchor.ts; CV.pinOff = r.anchor.off; chatPin("at"); return; }
    chatPin(CV.divNode ? "div" : isMailT(CV.key) ? "top" : "bottom");   // a mail reads top-down: the first unread, else the start of the mail
    return;
  }
  if (CV.pin) chatPlace();
  else if (snap && !snap.stick) { timeline.scrollTop = snap.top; chatStick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40; $("#chat-jump").hidden = chatStick; }
  else scrollChat(true);
}
// A jump target (notice, toast, push, 답변 필요, ?m=) sits with its top just under the app bar, wherever the divider is, and stays there while
// images and code blocks settle (the pin re-places it before paint) until the owner touches the timeline.
function chatJump(node) {
  const a = timeline.getBoundingClientRect(), bar = $("#appbar").getBoundingClientRect();
  CV.pinTs = node.dataset.ts; CV.pinOff = Math.max(0, bar.bottom - a.top) + 20;
  chatPin("at");
}
function chatPin(kind) { CV.pin = kind; chatPlace(); }
function chatUnpin() { CV.pin = ""; }
// Put the view where the pin says. Runs right after the draw and again whenever the timeline or its content changes size (images,
// code blocks, the todo strip, the composer growing) - a ResizeObserver runs after layout and before paint, so no shift is ever shown.
function chatPlace() {
  if (!CV.pin || !timeline.clientHeight) return;   // the view is hidden: the observer places it once it shows
  let want = timeline.scrollHeight;
  if (CV.pin === "top") want = 0;
  else if (CV.pin === "div") {
    if (!CV.divNode || !CV.divNode.isConnected) return;
    want = timeline.scrollTop + CV.divNode.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 12;
  } else if (CV.pin === "at") {   // a message found again by its ts (the timeline is redrawn, so no node is held), at its old distance from the top
    const n = [...tl.querySelectorAll("[data-ts]")].find(m => m.dataset.ts === CV.pinTs);
    if (n) want = timeline.scrollTop + n.getBoundingClientRect().top - timeline.getBoundingClientRect().top - CV.pinOff;   // gone from the history: the bottom
  }
  if (Math.abs(timeline.scrollTop - want) > 1) timeline.scrollTop = want;
  chatStick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
  $("#chat-jump").hidden = chatStick;
  convMaybeRead();   // what this placement put on screen is read now
}
new ResizeObserver(chatPlace).observe(timeline);
// The timeline's own box changes when the composer grows a line, the todo strip or the keyboard resizes the page. A view that sat at the
// bottom stays there (one write, before paint); any other view keeps its scrollTop, so what the owner reads never moves while typing.
let followH = 0;
new ResizeObserver(() => {
  const h = timeline.clientHeight, grew = followH && h !== followH;
  followH = h;
  if (grew && !CV.pin && chatStick && timeline.scrollHeight - timeline.scrollTop - h > 1) timeline.scrollTop = timeline.scrollHeight;
}).observe(timeline);
new ResizeObserver(chatPlace).observe(tl);
// The owner takes over by touching the timeline: the anchor lets go, the normal stick-to-bottom rules apply from there.
for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) timeline.addEventListener(ev, chatUnpin, { passive: true });

// The open conversation counts as read (page visible): a chat up to the last message whose bottom edge is on screen (owner 2026-10-31: "들어가서
// 해당 메시지 하단까지 내 화면에 보이면 숫자 사라지게"), a mail as soon as it is on screen. It runs whenever what is on screen can change - the opening's
// placement, a scroll, the timeline or its content changing size (a new message, an image or card loading, a resize), the page showing again -
// so no scroll is ever needed, and nothing waits for the view to hold still. A mail opens at its top and reads top-down (chatOpen), so waiting
// for the bottom left a long mail unread however it was read (owner 2026-10-27); its unread is dotz's own read position (hub/reads.ts), never
// the real mailbox's flag, so a newer message of that mail still makes it unread again.
function convMaybeRead() {
  const t = CV.key;
  if (!t || t !== target || !CV.placed || document.visibilityState !== "visible") return;
  const mail = isMailT(t);
  if (!mail && !CV.captured) return;
  const s = ts(t), last = s.hLoaded && s.msgs.findLast(convReal);
  if (!last) return;
  if (READ[t] && READ[t] >= last.ts) { if (s.unread) { s.unread = 0; renderBars(); if (mail) mailReadPainted(); } return; }
  const at = mail ? last.ts : convSeenTs(last.ts);
  if (!at || (READ[t] && READ[t] >= at)) return;
  READ[t] = at;
  s.unread = at >= last.ts ? 0 : Math.min(s.unread, s.msgs.filter(e => e.ts > at && convIncoming(e)).length);   // the hub recounts it on the next load
  convPend.set(t, at);
  if (!convPendT) convPendT = setTimeout(convFlush, 150);
  renderBars();
  if (mail) mailReadPainted();
}
// A mail read on the page moves its row, the app's badge and the 안 읽음 filter now; once the hub holds the position its app counts raise
// (needs.unread, GET /api/integrations), and a peer's mail has its snapshot read again (34-peer-monitoring.js).
function mailReadPainted() { const m = MAILS.get(CV.key); if (m && m.read === false) m.read = true; MON.sig = ""; monSchedule(); }
function mailReadSynced(t) { if (typeof pqPc === "function" && pqPc(t)) pqSoon(); else loadIntegrations(); }
function convFlush() {
  convPendT = 0;
  for (const [t, at] of convPend) api("/api/read", "POST", { target: t, ts: at }).then(() => { if (isMailT(t)) mailReadSynced(t); }, () => { if (READ[t] === at) READ[t] = null; convLoad(); });
  convPend.clear();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { convMaybeRead(); convLoad(); } });
// The newest drawn message whose bottom edge is inside the timeline's visible box (never past `newest`), "" when none is. Walks from the end, so
// it measures only the few messages at the bottom of the view.
function convSeenTs(newest) {
  if (!timeline.clientHeight) return "";
  const bottom = timeline.getBoundingClientRect().bottom + 1, nodes = tl.querySelectorAll("[data-ts]");
  for (let i = nodes.length - 1; i >= 0; i--) {
    const r = nodes[i].getBoundingClientRect();
    if (r.height && r.bottom <= bottom) return nodes[i].dataset.ts > newest ? newest : nodes[i].dataset.ts;
  }
  return "";
}
// A layout change can bring a message's bottom on screen without a scroll (content settling after the pin let go, the window growing): one
// check per frame, after layout.
function convReadSoon() { if (!convReadF) convReadF = requestAnimationFrame(() => { convReadF = 0; convMaybeRead(); }); }
const convReadRO = new ResizeObserver(convReadSoon);
convReadRO.observe(timeline); convReadRO.observe(tl);

// Which conversation this page shows ("" = hidden or not a chat), so the hub keeps that conversation's answers out of the notices (POST /api/viewing).
// Sent when it changes and every 20 s while it stays (the hub counts a report older than 60 s as gone).
const VIEW = { id: Math.random().toString(36).slice(2) + Date.now().toString(36), sent: "", at: 0 };
function viewReport(unload) {
  const conv = !unload && document.visibilityState === "visible" && current === "chat" ? target : "";
  if (conv === VIEW.sent && (!conv || Date.now() - VIEW.at < 20000)) return;
  VIEW.sent = conv; VIEW.at = Date.now();
  if (unload) fetch("/api/viewing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: VIEW.id, conv }), keepalive: true }).catch(() => {});
  else api("/api/viewing", "POST", { id: VIEW.id, conv }).catch(() => { VIEW.sent = "?"; });
}
document.addEventListener("visibilitychange", () => viewReport());
addEventListener("pagehide", () => viewReport(true));
setInterval(viewReport, 2000);

/* ---- the list ---- */
// The main assistant and the two feeds first, then the running sessions under 진행 중 (one with a question waiting first), the projects by their
// newest message (silent ones after, in project order). A session that ended stays in the list only while it is open; the ended ones fold into
// one group after that, and the mails and rooms that wait on the owner close the list. 모니터링 has its own tab (30-monitoring.js) and uses this same row.
function convRows() {
  const at = t => (CONV.get(t) || {}).ts || "";
  const projects = projTargets().map((t, i) => ({ t, i })).sort((a, b) => at(b.t).localeCompare(at(a.t)) || a.i - b.i).map(x => x.t);
  const mk = t => { const last = CONV.get(t) || null; return { t, last, name: targetName(t), hint: last ? convPreview(last.text) : "", unread: ts(t).unread, need: convNeeds(t) }; };
  const all = (S && S.lanes) || [];
  const rank = l => (l.pendingAsk ? 0 : l.status === "working" || l.status === "starting" ? 1 : 2);
  const running = all.filter(laneAlive).sort((a, b) => rank(a) - rank(b) || at(`lane:${b.name}`).localeCompare(at(`lane:${a.name}`)));
  const sess = l => { const t = `lane:${l.name}`; const m = mk(t); return { ...m, badge: sessionStatus(l), hint: convPreview(l.lastText) || m.hint }; };
  const v = CVF.view, keep = r => v === "need" ? r.need : v === "session" ? isLaneT(r.t) : v === "alert" ? isFixedT(r.t) : true;
  // The filter pills, then a card per group (a group with nothing under the filter has no header), and last the 메일 · 카카오톡 card of what waits there.
  const projs = projects.map(mk).filter(keep), page = v === "all" ? projs.filter((r, i) => i < CVF.more || r.t === target) : projs;
  const out = [{ bar: true }, ...[MAIN, "alert", "worklog"].map(mk).filter(keep)], lanes = running.map(sess).filter(keep);
  if (lanes.length) out.push({ header: "진행 중", sec: true }, ...lanes);
  if (page.length) out.push({ header: "프로젝트", sec: true }, ...page);
  if (projs.length > page.length) out.push({ more: projs.length - page.length });
  const open = all.find(l => !laneAlive(l) && `lane:${l.name}` === target);
  if (open && (v === "all" || v === "session")) out.push(sess(open));
  const ended = v === "all" || v === "session" ? endedLanes() : [];
  if (ended.length) out.push({ ended: true, key: `${ended.map(l => { const m = endedMark(l); return `${l.name}:${m.unread}:${m.need ? 1 : 0}`; }).join("|")}|${endedOpen}` });
  const waits = v === "all" || v === "need" ? convWaiting() : [];
  if (out.length === 1 && !waits.length) out.push({ empty: CVF_EMPTY[v] });
  if (waits.length) out.push({ header: "메일 · 카카오톡", sec: true }, ...waits);
  out.push({ read: true });
  return out;
}
const CVF_EMPTY = { need: "답을 기다리는 대화가 없어요", session: "진행 중인 세션이 없어요", alert: "알림이 없어요" };
// The 메일 · 카카오톡 card: this computer's mails with a draft or a reply owed and the watched rooms that owe one, newest first; a tap opens them in 모니터링.
function convWaiting() {
  const letter = name => el("span", { class: "cv-av", "aria-hidden": "true", text: [...String(name || "?").trim()][0] || "?" });
  const mails = [...MAILS].filter(([t, m]) => !PQ.of.has(t) && m.dir !== "out" && !m.archived && (m.reply === "draft" || m.unreplied)).map(([t, m]) => {
    const who = mailSender(m.from), owed = !!m.unreplied;
    return { at: Date.parse(m.at) || 0, k: `w:${t}`, name: m.subject || "(제목 없음)", hint: m.reply === "draft" ? `${who} · 답장 초안이 기다려요` : who, last: { ts: m.at }, bold: mailUnread(t, m), need: true, sel: current === "chat" && target === t, av: letter(who), chips: owed ? [["미답장", "unreplied"]] : undefined, open: () => go("monitoring", `c:${t}`) };
  });
  const rooms = KK.rooms.filter(r => r.watched && r.unreplied).map(r => ({ at: r.lastAt || 0, k: `w:kk:${r.chatId}`, name: r.name, hint: kkSubLine(r), last: r.lastAt ? { ts: new Date(r.lastAt).toISOString() } : null, bold: r.unread > 0, need: true, av: letter(r.name), chips: [["미답장", "unreplied"]], open: () => { go("monitoring", "i:kakao"); kkOpen(r.chatId); } }));
  return [...mails, ...rooms].sort((a, b) => b.at - a.at).slice(0, 5);
}
// Rows in their cards: the bar and a section label stand on the page, every run of rows between them is one card.
function convCards(rows) {
  const nodes = [];
  let box = null;
  for (const r of rows) {
    if (r.read) { const b = convReadBtn(); if (b) nodes.push(b); continue; }
    if (r.bar || r.header) { nodes.push(r.bar ? convBar() : el("div", { class: "cv-sec", role: "presentation", text: r.header })); box = null; continue; }
    if (!box) nodes.push(box = el("div", { class: "cv-card" }));
    box.append(convRow(r));
  }
  return nodes;
}
const FIXED_DESC = { alert: "경고와 결정 요청", worklog: "야간 정리와 세션 진행 기록" };

/* ---- a long list: views, a page of projects, 읽음 처리 ---- */
// view: 전체 / 답할 것 / 세션 / 알림; more: projects drawn in 전체 (CVF_PAGE more per 더 보기).
const CVF_PAGE = 40;
const CVF = { view: "all", more: CVF_PAGE };
// A conversation waits on the owner: an open decision asked there, a loose [ask] notice of it, or a session's question (same rules as 30-notices.js ntNeeds).
// the same rule as the home 답변 필요 list: a gateway question it handles itself (nyHandled) is news there, not a need here
const convNeeds = t => ntHasDecision(t) || NT.items.some(n => ntNeeds(n) && !nyHandled(n) && (n.src || n.open) === t) || !!(isLaneT(t) && targetInfo(t).ask);
const convListed = () => [MAIN, "alert", "worklog", ...((S && S.lanes) || []).filter(laneAlive).map(l => `lane:${l.name}`), ...projTargets()];
function convBar() {
  const list = convListed(), need = list.filter(convNeeds).length + (KK.rooms.filter(r => r.watched && r.unreplied).length) + [...MAILS].filter(([t, m]) => !PQ.of.has(t) && m.dir !== "out" && !m.archived && (m.reply === "draft" || m.unreplied)).length;
  const views = [["all", "전체", 0], ["need", "답할 것", need], ["session", "세션", 0], ["alert", "알림", 0]];
  return el("div", { class: "cv-bar" },
    el("div", { class: "cv-tabs", role: "tablist", "aria-label": "대화 보기" }, ...views.map(([k, label, n]) =>
      el("button", { class: `cchip mr-f${CVF.view === k ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(CVF.view === k), "data-view": k, onclick: () => { CVF.view = k; CVF.more = CVF_PAGE; convSig = ""; convSchedule(); convSide.scrollTop = 0; } }, label, cntSpan(`cv-filter:${k}`, "mr-fn", n)))),
  );
}
// 읽음 처리, under the list: it takes only what needs no answer, so a conversation waiting on the owner keeps its unread.
function convReadBtn() {
  const fyi = convListed().filter(t => ts(t).unread > 0 && !convNeeds(t) && CONV.get(t));
  return fyi.length ? el("div", { class: "cv-foot" }, el("button", { class: "btn text cv-read", type: "button", "data-k": "read", title: "답이 필요한 대화는 그대로 둬요", onclick: ev => convReadAll(ev.currentTarget, fyi), text: `${fyi.length}개 읽음 처리` })) : null;
}
// The listed conversations are read up to their newest message here at once and on the hub (POST /api/read, one per conversation); a failure
// re-reads the counts from the hub and says why (busy toasts it).
const convReadAll = (btn, list) => busy(btn, async () => {
  const was = list.map(t => [t, READ[t], ts(t).unread]);
  for (const t of list) { READ[t] = CONV.get(t).ts; ts(t).unread = 0; }
  renderBars(); convSig = ""; convSchedule();
  const res = await Promise.allSettled(list.map(t => api("/api/read", "POST", { target: t, ts: READ[t] })));
  const bad = res.filter(r => r.status === "rejected");
  if (bad.length) {
    for (const [t, r, u] of was) if (res[list.indexOf(t)].status === "rejected") { READ[t] = r; ts(t).unread = u; }
    renderBars(); convSig = ""; convSchedule(); convLoad();
    throw new Error(`${bad.length}개를 읽음으로 표시하지 못했어요: ${bad[0].reason.message}`);
  }
  toast(`대화 ${list.length}개를 읽음으로 표시했어요`);
});
// Every row has an icon, never a letter (so any name reads the same): the app's own mark for the main assistant, a bell / list for the fixed
// feeds, the folder the 프로젝트 tab uses for a project, the session icon for a session.
function convAvatar(t) {
  if (isFixedT(t)) return el("span", { class: "cv-av nt", "aria-hidden": "true" }, icon(t === "alert" ? "bell" : "list"));
  return el("span", { class: "cv-av", "aria-hidden": "true" }, t === MAIN ? el("span", { class: "logo" }) : icon(isLaneT(t) ? "lanes" : isProjT(t) ? "projects" : "chat"));
}
// The one list row of 채팅, 프로젝트 and 모니터링. A chat target (r.t) opens its conversation; r.open / r.sel / r.av let another list say what a tap opens,
// which row is open and which icon it wears. A row is { header } for a group label, { ended } for the folded ended sessions, or
// { name, badge: [word, tone], unread }, with an optional one-line preview (hint) under the name. A row never shows a time: the name and the content tell what it is.
function convRow(r) {
  if (r.header) return el("div", { class: "cv-gh", role: "presentation", text: r.header });
  if (r.bar) return convBar();
  if (r.empty) return el("div", { class: "cv-empty", text: r.empty });
  if (r.more) return el("div", { class: "cv-more" }, el("button", { class: "btn text", type: "button", "data-k": "more", onclick: () => { CVF.more += CVF_PAGE; convSig = ""; convSchedule(); }, text: `프로젝트 ${r.more}개 더 보기` }));
  if (r.ended) return endedGroup() || "";
  const sel = r.sel !== undefined ? r.sel : r.t === target && current === "chat";
  // 채팅 목록은 시제품의 채팅 행 (proto .li): 아이콘, 제목·미리보기, 오른쪽에 시각과 대기 표시. 모니터링 목록은 시각 없이 그대로예요.
  const when = !monCtx && r.last && r.last.ts ? prjAgo(Date.parse(r.last.ts)) : "";
  return el("button", { class: `cv-row${r.sub ? " sub" : ""}${r.hint ? " pv" : ""}${r.unread || r.bold ? " unread" : ""}${sel ? " on" : ""}${r.last || r.hint ? "" : " none"}`, type: "button", "data-t": r.t || null, "data-k": r.k || null, "aria-current": sel ? "true" : null, onclick: r.open || (() => go("chat", r.t)) },
    r.av || convAvatar(r.t),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", title: r.name, text: r.name }), r.hint ? el("span", { class: "cv-p", text: r.hint }) : null),
    el("span", { class: "cv-m" }, when ? el("span", { class: "cv-t", text: when }) : null, el("span", { class: "cv-m2" }, r.need && !r.chips && !r.k ? el("span", { class: "dot warn", role: "img", "aria-label": "답변 필요" }) : null, ...(r.chips || []).map(c => el("span", { class: `tag ${c[1]}`, text: c[0] })), r.badge ? el("span", { class: `tag ${r.badge[1]}`, text: r.badge[0] }) : null, cntSpan(`cv-row:${r.t || r.k || r.name}`, "nb", r.unread, { "aria-label": `읽지 않은 메시지 ${r.unread}개` }), r.unreplied ? el("span", { class: "nb unreplied", "aria-label": `미답장 ${r.unreplied}개`, text: `미답장 ${r.unreplied > 99 ? "99+" : r.unreplied}` }) : null)));
}
const convSide = el("aside", { id: "chat-convo", class: "cv-side", "aria-label": "채팅 목록" });
// Wide screens: the name and state of the open conversation above its timeline (phones put the name in the app bar).
const convHead = el("div", { id: "cv-head", class: "cv-head" });
$("#v-chat").prepend(convSide, convHead);

function convPaintHead() {
  asSync();
  if (isProjT(target) && !PRJ && !PRJ_FAIL) prjLoad().then(convSchedule);
  const i = targetInfo(target), state = isFixedT(target) ? FIXED_DESC[target] : isMailT(target) ? mailSender((MAILS.get(target) || {}).from) || "메일" : isSettingsT(target) ? "말로 설정을 바꾸고 적용을 눌러요" : i.alive ? statusKo(i.status) : "종료됨", k = monCtx && !isSettingsT(target) ? monItemOf(target) : "", app = k ? monSettingsApp(monItems().find(x => x.key === k)) : "", alertN = target === "alert" ? cvAlertN() : 0, sig = `${target}|${targetName(target)}|${state}|${alertN}|${monCtx ? pqSelf() : ""}|${!!pjMenuOn()}|${app}|${!!AS.by[app]}|${monCtx ? MON.sel : ""}`;
  if (sig === convHeadSig) return;
  convHeadSig = sig;
  // A conversation opened from a 모니터링 list (a mail of the 메일 list): ← goes back to that list inside the page, like the app bar's back on a phone.
  const up = monCtx && MON.sel && !isSettingsT(target) ? el("button", { class: "ib cv-up", type: "button", "aria-label": "목록으로", title: "목록으로", "data-k": "cv-up", onclick: () => go("monitoring", MON.sel) }, icon("back")) : null;
  // 시제품의 대화 머리 (proto .cv-hd): 제목 16/22 600 한 줄, 그 아래 상태 한 줄, 오른쪽에 그 대화의 동작.
  const acts = [isLaneT(target) ? cvMenuBtn() : null, pjMenuOn() ? pmMenuButton(() => pmOfTarget(target), "cvmenu") : null, isSettingsT(target) ? asMoreBtn(settingsApp(target)) : null, target === "alert" ? el("button", { class: "btn text sm cv-readall", type: "button", "data-k": "read-all", disabled: !alertN, title: "답이 필요한 알림은 그대로 둬요", onclick: ev => ntAlertReadAll(ev.currentTarget), text: "모두 읽음" }) : null, ...asEntry(app)].filter(Boolean);
  // 모니터링에서 연 대화(메일·설정)는 그 목록의 머리 그대로 아바타와 이름·상태 줄을 둬요.
  if (monCtx) clear(convHead).append(...[up, convAvatar(target), el("span", { class: "cv-b" }, el("span", { class: "cv-n" }, targetName(target), pqLabel({ pc: pqPc(target) })), el("span", { class: "cv-p", text: state })), ...acts].filter(Boolean));
  else clear(convHead).append(...[up,
    el("span", { class: "cv-hd-b" }, el("span", { class: "cv-hd-t", title: targetName(target) }, targetName(target)), el("span", { class: "cv-hd-s", text: state })),
    acts.length ? el("span", { class: "cv-hd-a" }, ...acts) : null].filter(Boolean));
}
// A project's conversation gets the project page's ⋯ menu (수정 / 삭제, built by pmMenuButton in 19-project-main.js) once the project is known.
const pjMenuOn = () => isProjT(target) && !!pmOfTarget(target);
// A session's actions (stop, restart, model) are the home card's ⋯ menu (08-home.js homeMenu), here in the conversation's header: in the head on wide screens, in the app bar on a phone.
const cvMenuBtn = () => el("button", { class: "ib cvmenu", type: "button", "aria-label": "세션 메뉴", title: "세션 메뉴", "aria-haspopup": "listbox", "aria-expanded": "false", onclick: ev => homeMenu(ev.currentTarget, target, true) }, icon("more"));
const cvAppMenu = cvMenuBtn();
cvAppMenu.id = "cvmenu"; cvAppMenu.hidden = true;
$("#vtog").before(cvAppMenu);
const pjAppMenu = pmMenuButton(() => pmOfTarget(target), "cvmenu");
pjAppMenu.id = "pjmenu"; pjAppMenu.hidden = true;
cvAppMenu.before(pjAppMenu);
// 모두 읽음 of the 알림 conversation (30-notices.js ntAlertReadAll): in its head on wide screens, in the app bar on a phone.
const cvAlertN = () => ts("alert").unread + ntAlertUnread().length;
const cvReadAllBar = el("button", { class: "btn text sm cv-readall", id: "cvreadall", type: "button", hidden: true, "data-k": "read-all", title: "답이 필요한 알림은 그대로 둬요", onclick: ev => ntAlertReadAll(ev.currentTarget), text: "모두 읽음" });
pjAppMenu.before(cvReadAllBar);
/* ---- the tabs of the 알림 conversation (owner 2026-11-01; classes: hub/notice-class.ts, n.cls) ---- */
// 전체 is the timeline as it was; the other tabs list that class of NT.items instead. A "log" notice is in no tab and in no count.
const BELL = { tab: "all", sig: "", lsig: "" }, BELL_SEEN = new Set();
const BELL_TABS = [["all", "전체"], ["ask", "답변 필요"], ["result", "결과"], ["news", "새 소식"], ["alert", "경고"]];
const bellUnread = tab => NT.items.reduce((c, n) => c + (!n.read && n.cls !== "log" && (tab === "all" || n.cls === tab) ? 1 : 0), 0);
function bellTab(tab) { BELL.tab = tab; bellPaint(); }
// 새 소식 by app (the app's own name, else the monitor, else the title); the groups follow their newest item.
function bellGroups(list) {
  const by = new Map();
  for (const n of list) { const k = ntPlain(n.app || n.watch || ""); by.set(k, [...(by.get(k) || []), n]); }   // no app or monitor: one headerless group, never one per row title
  return [...by];
}
function bellRows(tab) {
  const list = NT.items.filter(n => n.id && n.cls === tab).sort((a, b) => (tab === "ask" ? Number(ntNeeds(b)) - Number(ntNeeds(a)) : 0) || ntAt(b) - ntAt(a)).slice(0, 100);
  const row = n => ntHomeRow(n, ntNeeds(n) ? undefined : "");
  if (!list.length) return [el("div", { class: "bell-none", text: "아직 없어요" })];
  // The prototype's notices screen (30-notices.js ntHomeRow): one meta line, a card of rows (새 소식: a label and a card per app), one quiet note.
  const card = items => el("div", { class: "bell-card" }, el("div", { class: "hn" }, ...items.map(row)));
  const meta = el("div", { class: "bell-meta" }, "안 읽은 알림 ", el("b", { text: String(bellUnread(tab)) }), "개"), note = el("div", { class: "bell-note", text: "모두 읽음은 답이 필요한 알림을 그대로 둬요." });
  if (tab !== "news") return [meta, card(list), note];
  // A header that only repeats the title of its single row says nothing: it is not drawn.
  const echo = (name, items) => items.length === 1 && [ntPlain(items[0].title), hcLine(items[0])].includes(name);
  return [meta, ...bellGroups(list).flatMap(([name, items]) => [name && !echo(name, items) ? el("div", { class: "bell-gh", role: "presentation", text: name }) : null, card(items)].filter(Boolean)), note];
}
function bellPaint() {
  const on = current === "chat" && target === "alert" && !monCtx, box = $("#bell-tabs"), list = $("#bell-list"), tab = BELL.tab, listed = on && tab !== "all";
  box.hidden = !on; list.hidden = !listed;
  $("#v-chat").classList.toggle("bell-on", listed);
  $("#v-chat").classList.toggle("bell-view", on);   // every filter keeps one frame (09-notices.css): the same filter row, the same start of content
  if (!on) return;
  const counts = BELL_TABS.map(([k]) => NT.loaded ? bellUnread(k) : 0), sig = JSON.stringify([tab, counts]);
  if (sig !== BELL.sig) {
    BELL.sig = sig;
    clear(box).append(...BELL_TABS.map(([k, label], i) => el("button", { class: `chip${k === tab ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(k === tab), "data-k": k, onclick: () => bellTab(k) },
      el("span", { class: "tx", text: label }), cntSpan(`bell:${k}`, `nb${k === "ask" ? " warn" : k === "alert" ? " err" : ""}`, counts[i], { "aria-label": `안 읽은 알림 ${counts[i]}개` }))));
  }
  if (!listed) { BELL.lsig = ""; BELL_SEEN.clear(); BELL_SEEN.seeded = false; return; }
  const lsig = JSON.stringify([tab, NT.items.filter(n => n.cls === tab).map(n => [n.id, n.read, n.ignored, n.updated || n.ts])]);
  if (lsig === BELL.lsig) return;
  BELL.lsig = lsig;
  const top = list.scrollTop;
  clear(list).append(...bellRows(tab));
  list.scrollTop = top;
  // a notification that arrives while a tab is open slides in at the top of it; opening a tab or drawing it again moves nothing
  if (BELL_SEEN.scope !== tab) { BELL_SEEN.clear(); BELL_SEEN.seeded = false; BELL_SEEN.scope = tab; }
  const rows = [...list.querySelectorAll(".hr[data-nid]")], fresh = rows.length ? freshKeys(BELL_SEEN, rows.map(r => r.dataset.nid)) : new Set();
  for (const r of rows) if (fresh.has(r.dataset.nid)) motionIn(r, "top");
}
function convPaint() {
  convRaf = 0;
  if (current !== "chat") return;
  convTitle();
  mailSentPaint();
  mbReplyPaint();
  const items = monCtx ? monItems() : null, rows = items ? monRows(items, items.find(i => i.key === MON.sel) || null) : convRows(), sig = JSON.stringify([rows.map(r => [r.t, r.k, r.key, r.name, r.last, r.unread, r.badge, r.header, r.hint, r.sel, r.need, r.more, r.empty]), target, current, !!monCtx, rows.some(r => r.bar) ? [CVF.view, convListed().map(t => [ts(t).unread > 0, convNeeds(t)])] : 0]);
  if (!monCtx && !KK.loaded && !KK.asked && typeof INTG !== "undefined" && INTG.items.some(i => i.key === "kakao")) { KK.asked = true; kkLoadRooms(); }
  if (sig !== convSig) {
    convSig = sig;
    convSide.setAttribute("aria-label", monCtx ? "모니터링 목록" : "채팅 목록");
    const top = convSide.scrollTop;
    // A conversation opened from 모니터링 keeps 모니터링's own panel (sections, cards, bars: 30-monitoring.js), never the chat list's rows.
    clear(convSide).append(...(monCtx ? monSideNodes(rows) : convCards(rows)));
    if (monCtx) monDecorateRows(convSide, items);
    convSide.scrollTop = top;
  }
  convSide.classList.toggle("mon-side", !!monCtx);
  $("#v-chat").classList.toggle("mon-ctx", !!monCtx);
  bellPaint();
  convPaintHead();
}
function convSchedule() { if (!convRaf) convRaf = requestAnimationFrame(convPaint); }

/* ---- app bar ---- */
// Phone, inside a conversation: back arrow to the list and the conversation's name as the title.
function convOnPhone() { return current === "chat" && narrowChat() && !chatList; }
function convTitle() {
  if (current === "chat") $("#title").textContent = convOnPhone() ? targetName(target) : monCtx ? titles.monitoring : titles.chat;
  else if (current === "monitoring") $("#title").textContent = monConv() && narrowChat() ? monName() : titles.monitoring;
  const tag = (current === "chat" && monCtx && convOnPhone()) || (monConv() && narrowChat()) ? pqLabel(monItems().find(i => i.key === MON.sel)) : null;
  if (tag) $("#title").append(tag);
  cvAppMenu.hidden = !(convOnPhone() && isLaneT(target));
  pjAppMenu.hidden = !(convOnPhone() && pjMenuOn());
  cvReadAllBar.hidden = !(convOnPhone() && target === "alert");
  if (!cvReadAllBar.hidden) cvReadAllBar.disabled = !cvAlertN();
  if (asBar) asBarSync(narrowChat() ? monDetailApp() : "");
  if (asMoreBar) asMoreSync(convOnPhone() && isSettingsT(target) ? settingsApp(target) : narrowChat() ? monDetailApp() : "");
}
function convChrome() {
  const conv = convOnPhone() || (monConv() && narrowChat()), back = !!backTarget() || conv, bar = $("#appbar"), up = !narrowChat() && (monConv() || (!!monCtx && current === "chat"));
  $("#back").hidden = !back;
  // Inside an app on a wide screen the bar's back button reads ‹ 모니터링 in the title's place; the app's own name stands in its head.
  $("#back").classList.toggle("mon-up", up);
  $("#back").setAttribute("aria-label", up ? "모니터링 목록으로" : "뒤로");
  bar.classList.toggle("back", back);
  bar.classList.toggle("cvconv", conv);
  $("#v-chat").classList.toggle("cv-listing", convListing());
  const listing = current === "monitoring" && MON.list, was = $("#v-monitoring").classList.contains("cv-listing");
  $("#v-monitoring").classList.toggle("cv-listing", listing);
  if (listing && !was) $("#mon-side").scrollTop = MON.top | 0;
  if (current === "monitoring") monSchedule();
  if (convListing()) $("#vtog").hidden = true;
  convTitle();
  convSig = ""; convHeadSig = "";
  convSchedule();
}
matchMedia("(max-width: 1099px)").addEventListener("change", () => {
  if (current === "projects" || current === "project") go(current, current === "project" ? ppCur : undefined);
  convChrome();
  if (convSync()) renderAll();
  document.querySelectorAll(".thead").forEach(b => { b.dataset.sig = ""; });
  renderBars();
});
convLoad();

/* ---- shell: the notice bell and the sidebar's computer row (22-shell.css) ---- */
// The bell opens the 알림 conversation; its count comes from paintBell (09-needs-you.js), fed by every notice change.
$("#bell").prepend(icon("bell"));
$("#bell").title = `알림 (${isMac ? "⌘/" : "Ctrl+/"})`;
$("#bell").onclick = () => openTarget("alert", lastChatView());
