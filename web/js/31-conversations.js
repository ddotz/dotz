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
const convIncoming = e => convReal(e) && !OWNER.has(e.kind) && !cleanRestart(e);

// Same rule as hub/conversations.ts previewOf: first meaningful line, plain text, 120 chars.
function convPreview(raw) {
  const text = parseTone(noHandoff(String(raw ?? ""))).text;
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

// A live message (called by ingestMsg once per new event): moves the row's preview and, unless the owner is looking at that
// conversation's bottom right now, adds to its unread count (server rule: hub/conversations.ts).
function convNote(e, t, was) {
  const last = convLastOf(e);
  if (!last) return;
  const prev = CONV.get(t);
  if (!prev || prev.ts <= last.ts) CONV.set(t, last);
  // `was`: the older version of an edited post, still unread = this one is the same unread message (counted once, like the hub does)
  const again = !!was && !(READ[t] && READ[t] >= was.ts);
  if (convIncoming(e) && !again && !(READ[t] && READ[t] >= e.ts) && !(CV.key === t && chatStick && document.visibilityState === "visible")) { ts(t).unread++; renderBars(); }
  convSchedule();
}
async function convLoad() {
  clearTimeout(convRetry);
  try {
    const r = await api("/api/conversations");
    for (const it of r.items || []) {
      const t = it.target, prev = CONV.get(t);
      if (it.last && (!prev || prev.ts <= it.last.ts)) CONV.set(t, it.last);
      else if (!CONV.has(t)) CONV.set(t, null);
      let unread = it.unread | 0;
      const local = READ[t], last = CONV.get(t);
      // Our own read post may be ahead of what the server has answered with.
      if (local && (!it.read || local > it.read)) { if (last && last.ts <= local) unread = 0; }
      else READ[t] = it.read || null;
      ts(t).unread = unread;
    }
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
// first unread message of that moment and stays until the owner leaves. Opening again after reading shows no divider.
function convSync() {
  const key = current === "chat" && !convListing() ? target : "";
  if (key === CV.key) return false;
  chatUnpin(); clearTimeout(CV.gateT);
  Object.assign(CV, { key, div: "", divNode: null, landed: false, captured: false, failed: false, placed: false, full: false, snap: null, openAt: performance.now() });
  convCapture();
  return !!key;   // the caller draws the conversation: the divider is in it from the first paint
}
function convCapture() {
  if (!CV.key || CV.captured || !CV.loaded) return false;
  CV.captured = true;
  const at = READ[CV.key];
  if (!at || !(ts(CV.key).unread > 0)) return false;   // never opened before: nothing to compare with
  CV.div = at;
  return true;
}
const convDivider = () => el("div", { class: "cv-new", role: "separator", "aria-label": "여기부터 읽지 않은 메시지" }, el("span", { text: "여기까지 읽음" }));
/* ---- where the timeline sits while an opening settles ---- */
// The first paint of an opening needs three answers: the history, the read position (/api/conversations, which decides the divider)
// and the todo plan (its strip pushes the timeline down). Until then "불러오는 중…" stays, so nothing is drawn at the wrong place
// first. A slow answer cannot hold it forever: the plan gives up after 0.7 s, the read position after 3 s (no divider then).
function chatReady() {
  if (!CV.key) return true;
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
    if (CV.landed) { chatUnpin(); scrollChat(true); return; }   // the notice jump lands on its own message
    CV.landed = true;
    // reloaded onto a new shell (23-installable-app-web.js): the place the owner was at, unless they were at the bottom
    const r = SHELL_RESTORE;
    if (r && r.key === CV.key && !r.stick && r.anchor) { SHELL_RESTORE = null; CV.pinTs = r.anchor.ts; CV.pinOff = r.anchor.off; chatPin("at"); return; }
    chatPin(CV.divNode ? "div" : "bottom");
    return;
  }
  if (CV.pin) chatPlace();
  else if (snap && !snap.stick) { timeline.scrollTop = snap.top; chatStick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40; $("#chat-jump").hidden = chatStick; }
  else scrollChat(true);
}
function chatPin(kind) { CV.pin = kind; chatPlace(); }
function chatUnpin() { CV.pin = ""; clearTimeout(CV.dwellT); }
// Put the view where the pin says. Runs right after the draw and again whenever the timeline or its content changes size (images,
// code blocks, the todo strip, the composer growing) - a ResizeObserver runs after layout and before paint, so no shift is ever shown.
function chatPlace() {
  if (!CV.pin || !timeline.clientHeight) return;   // the view is hidden: the observer places it once it shows
  let want = timeline.scrollHeight;
  if (CV.pin === "div") {
    if (!CV.divNode || !CV.divNode.isConnected) return;
    want = timeline.scrollTop + CV.divNode.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 12;
  } else if (CV.pin === "at") {   // a message found again by its ts (the timeline is redrawn, so no node is held), at its old distance from the top
    const n = [...tl.querySelectorAll("[data-ts]")].find(m => m.dataset.ts === CV.pinTs);
    if (n) want = timeline.scrollTop + n.getBoundingClientRect().top - timeline.getBoundingClientRect().top - CV.pinOff;   // gone from the history: the bottom
  }
  if (Math.abs(timeline.scrollTop - want) > 1) timeline.scrollTop = want;
  chatStick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
  $("#chat-jump").hidden = chatStick;
  convDwell();
}
// Anchored views count as read only after they held still for a moment (the owner can see them), never on the draw itself.
function convDwell() {
  clearTimeout(CV.dwellT);
  CV.seen = false;
  CV.dwellT = setTimeout(() => { CV.seen = true; convMaybeRead(); }, 700);
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

// The owner is at the bottom of the open conversation (page visible): everything in it counts as read.
function convMaybeRead() {
  const t = CV.key;
  if (!t || t !== target || !CV.captured || !CV.placed || !chatStick || (CV.pin && !CV.seen) || document.visibilityState !== "visible") return;
  const s = ts(t), last = s.hLoaded && s.msgs.findLast(convReal);
  if (!last) return;
  if (READ[t] && READ[t] >= last.ts) { if (s.unread) { s.unread = 0; renderBars(); } return; }
  READ[t] = last.ts; s.unread = 0;
  convPend.set(t, last.ts);
  if (!convPendT) convPendT = setTimeout(convFlush, 150);
  renderBars();
}
function convFlush() {
  convPendT = 0;
  for (const [t, at] of convPend) api("/api/read", "POST", { target: t, ts: at }).catch(() => { if (READ[t] === at) READ[t] = null; convLoad(); });
  convPend.clear();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { if (CV.pin) convDwell(); convMaybeRead(); convLoad(); } });

// Which conversation this page shows ("" = hidden or not a chat), so the hub keeps that conversation's answers out of the bell (POST /api/viewing).
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
// KST HH:MM for today, M/D for earlier days.
function convTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  if (kstDay(d) === kstDay(Date.now())) return d.toLocaleTimeString("en-GB", { ...KST, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { ...KST, month: "numeric", day: "numeric" }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.month}/${p.day}`;
}
// The main assistant first, then the projects by their newest message (silent ones after, in project order). Sessions stay under 세션.
function convRows() {
  const at = t => (CONV.get(t) || {}).ts || "";
  const projects = projTargets().map((t, i) => ({ t, i })).sort((a, b) => at(b.t).localeCompare(at(a.t)) || a.i - b.i).map(x => x.t);
  return [MAIN, "alert", "worklog", ...projects].map(t => ({ t, last: CONV.get(t) || null, name: targetName(t), unread: ts(t).unread }));
}
const FIXED_DESC = { alert: "경고와 감시 소식, 결정 요청", worklog: "야간 정리와 세션 진행 기록" };
function convAvatar(t) {
  const name = targetName(t);
  if (isFixedT(t)) return el("span", { class: "cv-av nt", "aria-hidden": "true" }, icon(t === "alert" ? "bell" : "list"));
  return el("span", { class: `cv-av${t === MAIN ? " bot" : ""}`, "aria-hidden": "true" }, isLaneT(t) ? icon("lanes") : Array.from(name || "d")[0].toUpperCase());
}
function convRow(r) {
  const sel = r.t === target && current === "chat";
  const text = r.last ? `${r.last.from === "owner" ? "나: " : ""}${r.last.text}` : "아직 대화가 없어요";
  return el("button", { class: `cv-row${r.unread ? " unread" : ""}${sel ? " on" : ""}${r.last ? "" : " none"}`, type: "button", "data-t": r.t, "aria-current": sel ? "true" : null, onclick: () => go("chat", r.t) },
    convAvatar(r.t),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: r.name }), el("span", { class: "cv-p", text })),
    el("span", { class: "cv-m" }, el("span", { class: "cv-t", text: r.last ? convTime(r.last.ts) : "" }), r.unread ? el("span", { class: "nb", "aria-label": `읽지 않은 메시지 ${r.unread}개`, text: r.unread > 99 ? "99+" : String(r.unread) }) : null));
}
// Phone only (no header bell there): the first row of the list opens the notice hub, with the unread count as its badge.
const convPhone = matchMedia("(max-width: 639px)");
function convNoticeInfo() {
  if (!convPhone.matches) return null;
  const un = NT.items.filter(n => !n.read).sort((a, b) => ntAt(b) - ntAt(a))[0];
  const text = !NT.loaded ? "" : un ? [ntPlain(un.title) || "알림", ntPlain(un.text)].filter(Boolean).join(": ") : "새 알림이 없어요";
  return { unread: NT.unread, text, at: un ? un.updated || un.ts : "" };
}
function convNoticeRow(r) {
  return el("button", { class: `cv-row cv-nt${r.unread ? " unread" : ""}`, type: "button", "data-nt": "1", onclick: () => openNotices("all") },
    el("span", { class: "cv-av nt", "aria-hidden": "true" }, icon("bell")),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: "알림 모아보기" }), el("span", { class: "cv-p", text: r.text })),
    el("span", { class: "cv-m" }, el("span", { class: "cv-t", text: r.at ? convTime(r.at) : "" }), r.unread ? el("span", { class: "nb", "aria-label": `안 읽은 알림 ${r.unread}개`, text: r.unread > 99 ? "99+" : String(r.unread) }) : null));
}
convPhone.addEventListener("change", () => { convSig = ""; convSchedule(); });
const convSide = el("aside", { id: "chat-convo", class: "cv-side", "aria-label": "채팅 목록" });
// Wide screens: the name and state of the open conversation above its timeline (phones put the name in the app bar).
const convHead = el("div", { id: "cv-head", class: "cv-head" });
$("#v-chat").prepend(convSide, convHead);

function convPaintHead() {
  const i = targetInfo(target), state = isFixedT(target) ? FIXED_DESC[target] : i.alive ? statusKo(i.status) : "종료됨", sig = `${target}|${targetName(target)}|${state}`;
  if (sig === convHeadSig) return;
  convHeadSig = sig;
  clear(convHead).append(convAvatar(target), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: targetName(target) }), el("span", { class: "cv-p", text: state })));
}
function convPaint() {
  convRaf = 0;
  if (current !== "chat") return;
  convTitle();
  const rows = convRows(), note = convNoticeInfo(), sig = JSON.stringify([rows.map(r => [r.t, r.name, r.last, r.unread]), target, note]);
  if (sig !== convSig) {
    convSig = sig;
    const top = convSide.scrollTop;
    clear(convSide).append(...(note ? [convNoticeRow(note)] : []), ...rows.map(convRow));
    convSide.scrollTop = top;
  }
  convPaintHead();
}
function convSchedule() { if (!convRaf) convRaf = requestAnimationFrame(convPaint); }

/* ---- app bar ---- */
// Phone, inside a conversation: back arrow to the list and the conversation's name as the title.
function convOnPhone() { return current === "chat" && narrowChat() && !chatList; }
function convTitle() { if (current === "chat") $("#title").textContent = convOnPhone() ? targetName(target) : titles.chat; }
function convChrome() {
  const conv = convOnPhone(), back = !!backTarget() || conv, bar = $("#appbar");
  $("#back").hidden = !back;
  bar.classList.toggle("back", back);
  bar.classList.toggle("cvconv", conv);
  $("#v-chat").classList.toggle("cv-listing", convListing());
  if (convListing()) $("#vtog").hidden = true;
  convTitle();
  convSig = ""; convHeadSig = "";
  convSchedule();
}
matchMedia("(max-width: 1099px)").addEventListener("change", () => {
  convChrome();
  if (convSync()) renderAll();
  document.querySelectorAll(".thead").forEach(b => { b.dataset.sig = ""; });
  renderBars();
});
convLoad();
