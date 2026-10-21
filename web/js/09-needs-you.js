/* ---------- needs-you: a target whose last finished turn this browser has not looked at yet ---------- */
// SEEN: when this browser last had the target open in 채팅 (대화 or 터미널) while the page was visible. DONE: the newest finished turn
// of the target: for a lane its turn_end or working->idle change; for the main chat and a project the orchestrator's answer stored in it (ingestMsg). Both are ISO strings kept in localStorage.
const SEEN_KEY = "dotz-seen", DONE_KEY = "dotz-done";
const readMap = k => { try { const o = JSON.parse(localStorage.getItem(k) || "null"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; } };
const SEEN = readMap(SEEN_KEY), DONE = readMap(DONE_KEY), PREV = {};
const saveMap = (k, m) => { try { localStorage.setItem(k, JSON.stringify(m)); } catch {} };
const msOf = s => Date.parse(s) || 0;
const watching = t => t === target && (current === "chat" || current === "activity") && !convListing() && document.visibilityState === "visible";
// Looking at the open target counts it as seen up to now (or up to its newest finished turn when the clocks differ).
function markSeen() {
  if (!watching(target)) return;
  SEEN[target] = new Date(Math.max(Date.now(), msOf(DONE[target]))).toISOString();
  saveMap(SEEN_KEY, SEEN);
}
function noteDone(t, at, live) {
  const m = msOf(at);
  if (!m || m <= msOf(DONE[t])) return;
  if (SEEN[t] === undefined) SEEN[t] = new Date(live ? m - 1 : Date.now()).toISOString();   // first sight of a target: only turns after this one count
  DONE[t] = new Date(m).toISOString();
  saveMap(SEEN_KEY, SEEN); saveMap(DONE_KEY, DONE);
  markSeen();
  attnChanged();
}
// From /api/state: first sight of a target starts as seen; a working->idle change is a finished turn; gone lanes are forgotten.
function noteStatus() {
  if (!S) return;
  // Only a lane's working->idle is a finished turn: the main chat's and a project's turns count when their answer lands (ingestMsg).
  const now = new Date().toISOString(), all = [[MAIN, (S.orchestrator || {}).status], ...S.lanes.map(l => [`lane:${l.name}`, l.status])], names = new Set([...all.map(x => x[0]), ...projTargets()]);
  let dirty = false;
  for (const t of projTargets()) if (SEEN[t] === undefined) { SEEN[t] = now; dirty = true; }
  for (const k of [...Object.keys(SEEN), ...Object.keys(DONE)]) if (!names.has(k)) { delete SEEN[k]; delete DONE[k]; delete PREV[k]; dirty = true; }
  for (const [t, st] of all) {
    if (SEEN[t] === undefined) { SEEN[t] = now; dirty = true; }
    if (PREV[t] === "working" && st === "idle" && isLaneT(t)) noteDone(t, now, true);
    PREV[t] = st;
  }
  if (dirty) { saveMap(SEEN_KEY, SEEN); saveMap(DONE_KEY, DONE); }
}
// "limit": rate-limited; "done": finished while this browser was not looking; "": nothing. Looking at the target clears both.
// "ask" (checked first): a lane question waiting for the owner's answer (lane.json pendingAsk, cleared when answered).
function attnRaw(t) {
  const i = targetInfo(t);
  if (i.alive && i.ask) return "ask";
  if (i.alive && i.status === "rate-limited" && !isProjT(t)) return "limit";
  return msOf(DONE[t]) > msOf(SEEN[t]) ? "done" : "";
}
const attnKind = t => watching(t) ? "" : attnRaw(t);
const attnLabel = k => ({ ask: "답변 필요", limit: "한도 대기" })[k] || "확인 필요";
const attnCount = () => S ? liveTargets().filter(attnKind).length : 0;
// Targets needing attention, not messages: the 채팅 nav badge and the page title. Unread message counts stay on the chips.
function paintAttn() {
  const n = attnCount(), b = $("#nav-att");
  b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n); b.title = `확인 필요 ${n}개`;
  b.parentElement.setAttribute("aria-label", n ? `채팅, 확인 필요 ${n}개` : "채팅");
  document.title = n ? `(${n}) ${botName}` : botName;
  toastAttn();
}
// A target that starts needing the owner pops one toast (tap = switch to it): a lane question, a rate limit, or the main chat
// finishing unseen (a lane's finished turn already has its report toast). On page load only open questions pop.
const ATTN_LAST = {};
let attnPainted = false;
function toastAttn() {
  if (!S) return;
  for (const t of liveTargets()) {
    const k = attnRaw(t), was = ATTN_LAST[t] || "";
    ATTN_LAST[t] = k;
    if (!k || k === was || watching(t) || (k === "done" && isLaneT(t)) || (!attnPainted && k !== "ask")) continue;
    const ask = targetInfo(t).ask;
    notify({ kind: "needs", target: t, open: t, tone: "warn", title: `${targetName(t)} · ${attnLabel(k)}`,
      ts: k === "ask" ? ask.at : k === "done" ? DONE[t] : new Date().toISOString(),
      text: k === "ask" ? ask.text : k === "limit" ? "한도에 걸려 기다리고 있어요" : "답을 마쳤어요. 확인해 주세요" });
  }
  attnPainted = true;
}
function attnChanged() {
  renderBars();
  if (current === "home") renderHome();
  if (current === "lanes") renderLanes();
}

/* ---------- usage strip in the app header: the tightest Anthropic-like limit ---------- */
let SQ = null, stripAt = 0;
const limitWord = l => {
  const m = `${l.id} ${l.window} ${l.label}`.match(/(\d+)\s*(h|d|w)/i);
  if (!m) return l.label || l.id;
  const n = Number(m[1]), u = m[2].toLowerCase();
  return u === "h" ? `${n}시간` : u === "d" ? `${n}일` : `${n}주`;
};
function tightLimit(q) {
  const provs = (q.providers || []).filter(p => (p.limits || []).length), an = provs.filter(p => /anthropic|claude/i.test(p.provider));
  let best = null;
  for (const p of an.length ? an : provs) for (const l of p.limits) { const f = limitFrac(l); if (f != null && (!best || f < best.f)) best = { l, f }; }
  return best;
}
function paintStrip() {
  const b = $("#ustrip"), t = SQ && tightLimit(SQ);
  b.hidden = !t;
  if (!t) return;
  const pct = Math.round(t.f * 100), word = limitWord(t.l);
  b.className = `ustrip${pct <= 40 ? " warn" : ""}`;
  b.style.setProperty("--p", pct);
  b.title = `사용량 · ${word} ${pct}% 남음`; b.setAttribute("aria-label", b.title);
  clear(b).append(el("span", { class: "ulab", text: `${word} ${pct}% 남음` }), el("span", { class: "ubar" }, el("i", { style: `width:${pct}%` })), el("span", { class: "uring" }), el("span", { class: "upct", text: `${word} ${pct}%` }));
}
function noteQuota(q) { SQ = q; stripAt = Date.now(); paintStrip(); }
// At most one fetch per 3 minutes, and only while the page is visible (the home and usage views feed it through noteQuota too).
async function loadStrip() {
  if (document.visibilityState !== "visible" || Date.now() - stripAt < 180000) return;
  stripAt = Date.now();
  try { noteQuota(await api("/api/quota")); } catch {}
}

// Per-target data, shared by both views: conversation events (msgs) and what the agent did (acts).
const TS = {};
const ts = t => TS[t] || (TS[t] = { msgs: [], mk: new Set(), acts: [], ak: new Set(), hLoaded: false, aLoaded: false, unread: 0, draft: "", loading: null, ahist: false, amore: false, older: false, cap: 600 });
const byTs = (a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
const msgKey = e => `${e.ts}|${e.kind}|${e.lane ?? ""}|${e.ref ?? ""}${e.state ?? ""}|${String(e.text ?? "").slice(0, 60)}`;
const actKey = a => `${a.ts}|${a.type}|${a.call_id ?? ""}|${(a.text ?? "").length}|${(a.text ?? "").slice(0, 40)}`;
const OWNER = new Set(["message", "lane_message", "_cmd"]);
const ownerish = e => OWNER.has(e.kind) || e.kind === "_cmdout";
const ownerAct = e => ({ type: e.kind === "_cmdout" ? "cmdout" : "owner", ts: e.ts, text: e.text, is_error: e.is_error });
// Same rule as the hub's eventTarget (hub/events.ts): which conversation an event belongs to.
function eventTarget(e) {
  if (e.kind === "activity" || e.kind === "subagents" || e.kind === "notice" || e.kind === "notice_read" || e.kind === "read") return null;
  let lane = typeof e.lane === "string" ? e.lane : "";
  if (!lane) for (const v of [e.source, e.target, e.channel]) if (typeof v === "string" && v.startsWith("lane:")) { lane = v.slice(5); break; }
  if (lane) return `lane:${lane}`;
  return [e.channel, e.target].find(v => typeof v === "string" && isProjT(v)) || MAIN;
}

/* ---------- conversation view (대화) ---------- */
const timeline = $("#timeline"), tl = $("#tl"), term = $("#term");
let chatStick = true, termStick = true;
timeline.addEventListener("scroll", () => { chatStick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40; $("#chat-jump").hidden = chatStick; if (chatStick) convMaybeRead(); });
timeline.addEventListener("scroll", () => edgeFade(timeline), { passive: true });
term.addEventListener("scroll", () => edgeFade(term), { passive: true });
term.addEventListener("scroll", () => { termStick = term.scrollTop + term.clientHeight >= term.scrollHeight - 40; $("#act-jump").hidden = termStick; if (term.scrollTop < 80) loadOlder(); });
$("#chat-jump").prepend(icon("down")); $("#act-jump").prepend(icon("down"));
$("#chat-jump").onclick = () => scrollChat(true);
$("#act-jump").onclick = () => scrollTerm(true);
// Messages read top-down: `top` = a message that just arrived while the owner sits at the bottom. When it is taller than the visible area
// its TOP goes to the top of the view (leaving the bottom, so the "new message" jump button shows); a short one keeps sticking to the bottom.
function scrollChat(force, top) {
  if (!force && !chatStick) return;
  if (force) chatUnpin();   // an explicit jump to the bottom ends the opening's anchor (31-conversations.js)
  requestAnimationFrame(() => {
    if (!force && !chatStick) return;   // an earlier message of this frame already put the view at its top
    if (!force && top && top.isConnected && fullHeight(top) > timeline.clientHeight - 24) {
      chatUnpin();
      timeline.scrollTop += top.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 12;
      chatStick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
      $("#chat-jump").hidden = chatStick;
    } else { timeline.scrollTop = timeline.scrollHeight; chatStick = true; $("#chat-jump").hidden = true; }
    convMaybeRead();
  });
}
function scrollTerm(force) {
  if (force || termStick) requestAnimationFrame(() => { term.scrollTop = term.scrollHeight; termStick = true; $("#act-jump").hidden = true; });
}
const kstHM = t => { const d = new Date(t); return isNaN(d) ? "" : d.toLocaleTimeString("ko-KR", { ...KST, hour: "numeric", minute: "2-digit" }); };
const kstDay = t => { const d = new Date(t); return isNaN(d) ? "" : d.toLocaleDateString("ko-KR", { ...KST, year: "numeric", month: "numeric", day: "numeric" }); };
const dayLabel = t => kstDay(t) === kstDay(Date.now()) ? "오늘" : new Date(t).toLocaleDateString("ko-KR", { ...KST, month: "long", day: "numeric", weekday: "short" });
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
  return m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.floor(m / 60)}시간`;
}
let CS = { day: "", group: null, empty: null, prog: new Map(), who: "", whoT: 0 };
// The open conversation's read state (31-conversations.js): key = the target being looked at, div = the read position when it was opened
// (the "새 메시지" divider goes before the first message after it), divNode = that divider in the timeline.
// pin = what the view is anchored to while the opening settles (late images, the todo strip, an SSE frame): "div" (the divider at the top),
// "bottom", or "" once the owner took over; placed = the opening has been positioned; seen = the pin held still long enough to count as read.
const CV = { key: "", div: "", divNode: null, landed: false, loaded: false, captured: false, failed: false, placed: false, full: false, snap: null, pin: "", seen: false, openAt: 0, dwellT: 0, gateT: 0 };
// 31-conversations.js state; declared here because the boot code calls go() before that file has run.
const CONV = new Map(), READ = {}, convPend = new Map();
let convRaf = 0, convSig = "", convHeadSig = "", convRetry = 0, convReadT = 0, convPendT = 0;
