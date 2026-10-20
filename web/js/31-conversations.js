/* ---------- 채팅: the chat list (KakaoTalk-style) and the read position (Discord-style) ---------- */
// Data: GET /api/conversations (hub/conversations.ts) gives every conversation's newest real message, the owner's read position
// and the unread count; POST /api/read moves the position forward and every device hears {kind:"read"} on the event stream.
// ts(t).unread (the counter the switcher and the nav already use) is that server count, kept current by convNote.
// CONV: target -> { ts, text, from } | null, READ: target -> ISO read position | null (state is declared in 09-needs-you.js).
const CONV_KINDS = new Set(["message", "lane_message", "out", "lane_report", "result", "mail", "schedule", "watch"]);

// A message the conversation shows (same rule as hub/conversations.ts isRealMessage), and one that can be unread: not the owner's own, no restart note.
const convReal = e => CONV_KINDS.has(e.kind) && !(e.kind === "out" && (e.update_key || e.target === "worklog"));
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
function convNote(e, t) {
  const last = convLastOf(e);
  if (!last) return;
  const prev = CONV.get(t);
  if (!prev || prev.ts <= last.ts) CONV.set(t, last);
  if (convIncoming(e) && !(READ[t] && READ[t] >= e.ts) && !(CV.key === t && chatStick && document.visibilityState === "visible")) { ts(t).unread++; renderBars(); }
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
    CV.loaded = true;
    renderBars();
    if (convCapture()) renderAll();
    convMaybeRead();
  } catch { convRetry = setTimeout(convLoad, 5000); }
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
  Object.assign(CV, { key, div: "", divNode: null, landed: false, captured: false });
  return convCapture();
}
function convCapture() {
  if (!CV.key || CV.captured || !CV.loaded) return false;
  CV.captured = true;
  const at = READ[CV.key];
  if (!at || !(ts(CV.key).unread > 0)) return false;   // never opened before: nothing to compare with
  CV.div = at;
  return true;
}
const convDivider = () => el("div", { class: "cv-new", role: "separator", "aria-label": "여기부터 읽지 않은 메시지" }, el("span", { text: "새 메시지" }));
// After the timeline is drawn: land on the divider (once per opening). Returns false when there is none, so the caller scrolls to the bottom.
function convLand() {
  if (!CV.div || CV.landed || !CV.divNode || !CV.divNode.isConnected) return false;
  CV.landed = true;
  requestAnimationFrame(() => {
    if (!CV.divNode || !CV.divNode.isConnected) return;
    timeline.scrollTop += CV.divNode.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 12;
    chatStick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
    $("#chat-jump").hidden = chatStick;
    convMaybeRead();
  });
  return true;
}
// The owner is at the bottom of the open conversation (page visible): everything in it counts as read.
function convMaybeRead() {
  const t = CV.key;
  if (!t || t !== target || !chatStick || document.visibilityState !== "visible") return;
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
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { convMaybeRead(); convLoad(); } });

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
  return [MAIN, ...projects].map(t => ({ t, last: CONV.get(t) || null, name: targetName(t), unread: ts(t).unread }));
}
function convAvatar(t) {
  const name = targetName(t);
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
const convSide = el("aside", { id: "chat-convo", class: "cv-side", "aria-label": "채팅 목록" });
// Wide screens: the name and state of the open conversation above its timeline (phones put the name in the app bar).
const convHead = el("div", { id: "cv-head", class: "cv-head" });
$("#v-chat").prepend(convSide, convHead);

function convPaintHead() {
  const i = targetInfo(target), state = i.alive ? statusKo(i.status) : "종료됨", sig = `${target}|${targetName(target)}|${state}`;
  if (sig === convHeadSig) return;
  convHeadSig = sig;
  clear(convHead).append(convAvatar(target), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: targetName(target) }), el("span", { class: "cv-p", text: state })));
}
function convPaint() {
  convRaf = 0;
  if (current !== "chat") return;
  convTitle();
  const rows = convRows(), sig = JSON.stringify([rows.map(r => [r.t, r.name, r.last, r.unread]), target]);
  if (sig !== convSig) {
    convSig = sig;
    const top = convSide.scrollTop;
    clear(convSide).append(...rows.map(convRow));
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
