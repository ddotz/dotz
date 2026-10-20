/* ---------- conversations: messenger-style list of every chat (홈 '대화' section + 채팅 left column) ---------- */
// Data: GET /api/conversations (hub/conversations.ts) once, then each live message moves its row. Unread counts are the
// per-target ones the target switcher already keeps (ts(t).unread).
const CONV = new Map();   // target -> { ts, text, from } | null
const CONV_KINDS = new Set(["message", "lane_message", "out", "lane_report", "result", "mail", "schedule", "watch"]);
const CONV_HOME_TOP = 6;
let convAll = false, convTried = 0, convRaf = 0;
const convSig = { home: "", side: "" };

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
  if (!CONV_KINDS.has(e.kind) || (e.kind === "out" && e.update_key) || typeof e.ts !== "string") return null;
  const title = e.card && typeof e.card.title === "string" ? e.card.title : "";
  const text = convPreview(e.text) || convPreview(title) || (Array.isArray(e.files) && e.files.length ? "파일" : "");
  if (!text) return null;
  const from = e.kind === "message" || e.kind === "lane_message" ? "owner" : e.kind === "lane_report" || (typeof e.source === "string" && e.source.startsWith("lane:")) ? "session" : "bot";
  return { ts: e.ts, text, from };
}
function convNote(e) {
  const t = eventTarget(e), last = t && convLastOf(e);
  if (!last) return;
  const prev = CONV.get(t);
  if (prev && prev.ts > last.ts) return;
  CONV.set(t, last);
  convSchedule();
}
async function convLoad() {
  convTried = Date.now();
  try {
    const r = await api("/api/conversations");
    for (const it of r.items || []) {
      const prev = CONV.get(it.target);
      if (it.last && (!prev || prev.ts <= it.last.ts)) CONV.set(it.target, it.last);
      else if (!CONV.has(it.target)) CONV.set(it.target, null);
    }
    convTried = -1;
  } catch { /* retried with the next state refresh */ }
  convSchedule();
}

// KST HH:MM for today, M/D for earlier days.
function convTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  if (kstDay(d) === kstDay(Date.now())) return d.toLocaleTimeString("en-GB", { ...KST, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { ...KST, month: "numeric", day: "numeric" }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.month}/${p.day}`;
}
// Rows in display order: the targets the switcher offers (plus the open one), newest message first, silent ones after in switcher order.
function convRows() {
  const all = liveTargets();
  if (!all.includes(target)) all.push(target);
  return all.map((t, i) => ({ t, i, last: CONV.get(t) || null, name: targetName(t), unread: ts(t).unread }))
    .sort((a, b) => (a.last && b.last ? (a.last.ts < b.last.ts ? 1 : a.last.ts > b.last.ts ? -1 : 0) : a.last ? -1 : b.last ? 1 : 0) || a.i - b.i);
}
function convAvatar(t) {
  return el("span", { class: `cv-av${t === MAIN ? " bot" : ""}`, "aria-hidden": "true" }, t === MAIN ? Array.from(botName || "d")[0].toUpperCase() : icon(isProjT(t) ? "projects" : "lanes"));
}
function convRow(r) {
  const sel = r.t === target && current === "chat";
  const text = r.last ? `${r.last.from === "owner" ? "나: " : ""}${r.last.text}` : "아직 대화가 없어요";
  return el("button", { class: `cv-row${r.unread ? " unread" : ""}${sel ? " on" : ""}${r.last ? "" : " none"}`, type: "button", "data-t": r.t, "aria-current": sel ? "true" : null, onclick: () => go("chat", r.t) },
    convAvatar(r.t),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: r.name }), el("span", { class: "cv-p", text })),
    el("span", { class: "cv-m" }, el("span", { class: "cv-t", text: r.last ? convTime(r.last.ts) : "" }), r.unread ? el("span", { class: "nb", "aria-label": `읽지 않은 메시지 ${r.unread}개`, text: r.unread > 99 ? "99+" : String(r.unread) }) : null));
}
const convHomeBox = el("div", { id: "home-convo" });
const convSide = el("aside", { id: "chat-convo", class: "cv-side", "aria-label": "대화 목록" });
$("#v-home").prepend(convHomeBox);
$("#v-chat").prepend(convSide);

function convPaintHome(rows) {
  const shown = convAll ? rows : rows.slice(0, CONV_HOME_TOP);
  const sig = JSON.stringify([shown.map(r => [r.t, r.name, r.last, r.unread]), rows.length, convAll]);
  if (sig === convSig.home) return;
  convSig.home = sig;
  clear(convHomeBox).append(el("div", { class: "sec", text: "대화" }), el("div", { class: "list cv-list" }, ...shown.map(convRow)),
    rows.length > CONV_HOME_TOP ? el("button", { class: "btn text cv-more", type: "button", onclick: () => { convAll = !convAll; convSchedule(); } }, convAll ? "접기" : `전체 보기 · ${rows.length}`) : null);
}
function convPaintSide(rows) {
  const sig = JSON.stringify([rows.map(r => [r.t, r.name, r.last, r.unread]), target]);
  if (sig === convSig.side) return;
  convSig.side = sig;
  const top = convSide.scrollTop;
  clear(convSide).append(...rows.map(convRow));
  convSide.scrollTop = top;
}
function convPaint() {
  convRaf = 0;
  const rows = convRows();
  if (current === "home") convPaintHome(rows);
  if (current === "chat") convPaintSide(rows);
}
function convSchedule() { if (!convRaf) convRaf = requestAnimationFrame(convPaint); }

// Hooks into the existing flow (one global scope): live messages, every switcher repaint (unread, selection), view changes,
// and the SSE reset that follows a gap the stream could not replay.
{
  const ingest = ingestMsg, bars = renderBars, nav = go, stale = laneTailsStale;
  ingestMsg = function (e) { const r = ingest.apply(this, arguments); convNote(e); return r; };
  renderBars = function () { const r = bars.apply(this, arguments); if (convTried >= 0 && Date.now() - convTried > 5000) convLoad(); else convSchedule(); return r; };
  go = function () { const r = nav.apply(this, arguments); convSig.home = convSig.side = ""; convSchedule(); return r; };
  laneTailsStale = function () { const r = stale.apply(this, arguments); convLoad(); return r; };
}
convLoad();
