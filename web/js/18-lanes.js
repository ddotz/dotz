/* ---------- 세션: a session's last report and chat link, and the 프로젝트 list below (the 세션 tab is gone: running sessions are rows of 채팅 and a card on 홈) ---------- */
const LP = {};                  // lane name -> { acts: oldest-first {ts, text} lines in Korean, rev, loaded, loading, failedAt }
const LANE_TAIL = 40;           // activity rows read per session
const LANE_ACTS = 12;           // lines kept per session
const laneKey = a => `${a.ts}|${a.type}|${a.call_id ?? ""}|${(a.text ?? "").length}|${(a.text ?? "").slice(0, 40)}`;
function laneToolLabel(a) {
  const pre = `${a.tool}: `;
  const fromText = a.tool && typeof a.text === "string" && a.text.startsWith(pre) ? a.text.slice(pre.length) : "";
  const s = a.intent || fromText;
  if (s) return oneLine(s);
  try {
    const o = JSON.parse(a.args);
    if (o && typeof o === "object") for (const k of ["i", "intent", "command", "cmd", "path", "pattern", "query", "url"]) if (typeof o[k] === "string" && o[k]) return oneLine(o[k]);
  } catch { /* args may be cut off */ }
  return "";
}
// A session's last report or answer (not a progress note), from the conversation events this page has seen.
const isLaneReport = e => e.kind === "lane_report" || (e.kind === "out" && !e.update_key && typeof e.source === "string" && e.source.startsWith("lane:"));
const laneReport = name => ts(`lane:${name}`).msgs.findLast(isLaneReport) || null;
const openLaneChat = name => { setTarget(`lane:${name}`); go("chat"); };
// The main assistant's background work (S.work): running first, then what ended in the last hour.
// Tap: the conversation that asked for the work (its waiting message, flashed). Message unknown or not drawn: the work's own detail, never another message.
async function workGo(w) {
  const t = w.target && validTarget(w.target) ? w.target : MAIN;
  // Work for a monitor's / app's settings chat or a project is that conversation's: with the message unknown the row still opens it, never the worker sheet.
  const fallback = () => t === MAIN ? openSub("orchestrator", w.id, null, w.description) : ntGo(t);
  if (!w.reply_to) return fallback();
  if (!(ts(t).hLoaded && ts(t).aLoaded)) await loadTarget(t).catch(() => {});
  const asked = ts(t).msgs.find(e => e.mid === w.reply_to);
  if (!asked) return fallback();
  ntJump({ src: t, at: asked.ts });
}
// One short Korean sentence out of a free-form message: code, links, hashes and markup dropped; English-only lines are not shown.
function plainKo(text) {
  const s = String(text ?? "").replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\b[0-9a-f]{7,40}\b/gi, " ").replace(/[*_#>\[\]|]/g, " ");
  const line = s.split("\n").map(oneLine).find(x => /[가-힣]/.test(x));
  if (!line) return "";
  const cut = line.match(/^.*?(?:[요다죠음함]\.|[.!?])(?=\s|$)/);
  const t = (cut ? cut[0] : line).replace(/[.!]$/, "");
  return t.length > 50 ? `${t.slice(0, 48)}…` : t;
}
const LANE_TOOL_KO = { 명령: "명령을 실행했어요", 수정: "파일을 고쳤어요", 읽기: "파일을 읽어봤어요", 검색: "코드를 찾아봤어요" };
function laneActKo(a) {
  switch (a.type) {
    case "tool_call": return LANE_TOOL_KO[kindOf(a.tool)] || "";
    case "text": return plainKo(parseTone(String(a.text ?? "")).text);
    case "status": return plainKo(statusLineKo(a.text));
    case "error": return "오류가 있었어요";
    case "turn_end": return "이번 작업을 마쳤어요";
    default: return "";
  }
}
// The newest 3 lines of a session, newest first: its reports and its own activity, same line collapsed to "… (3번)".
function laneRecent(name) {
  const p = LP[name], rows = p ? p.acts.slice() : [];
  for (const e of ts(`lane:${name}`).msgs.filter(isLaneReport).slice(-3)) {
    const { text } = parseTone(noHandoff(String(e.text ?? "")));
    rows.push({ ts: Date.parse(e.ts) || 0, text: `보고 · ${plainKo(text) || "내용을 남겼어요"}`, report: true });
  }
  rows.sort((x, y) => y.ts - x.ts);
  const said = new Set(rows.filter(r => r.report).map(r => r.text.slice(5)));
  const out = [];
  for (const r of rows) {
    if (!r.report && said.has(r.text)) continue;
    const last = out[out.length - 1];
    if (last && last.text === r.text) { last.n++; continue; }
    if (out.length < 3) out.push({ ...r, n: 1 });
  }
  return out.map(r => ({ ts: r.ts, text: r.n > 1 ? `${r.text} (${r.n}번)` : r.text, report: r.report }));
}
function laneRefresh(p) { p.rev++; }
function laneIngest(p, a) {
  const k = laneKey(a);
  if (p.seen.has(k)) return;
  p.seen.add(k);
  if (p.seen.size > 200) p.seen = new Set([...p.seen].slice(-100));
  const text = laneActKo(a);
  if (text) { p.acts.push({ ts: Date.parse(a.ts) || Date.now(), text }); if (p.acts.length > LANE_ACTS) p.acts.shift(); }
  laneRefresh(p);
}
async function laneLoad(p) {
  p.loading = true; p.queue = [];
  const t = `lane:${p.name}`;
  let r, h;
  try { [r, h] = await Promise.all([api(`/api/activity?source=${enc(t)}&limit=${LANE_TAIL}`), api(`/api/history?target=${enc(t)}&limit=30`).catch(() => null)]); }
  catch { p.loading = false; p.failedAt = Date.now(); return; }
  if (h) { const st = ts(t); for (const e of h.events || []) { const k = msgKey(e); if (!st.mk.has(k)) { st.mk.add(k); st.msgs.push(e); } } st.msgs.sort(byTs); }
  p.seen = new Set(); p.acts = [];
  for (const a of r.items || []) laneIngest(p, a);
  for (const a of p.queue) laneIngest(p, a);
  p.queue = []; p.loading = false; p.loaded = true;
  laneRefresh(p);
}
// SSE "activity": keep every loaded session live, even while another view is open.
function laneActivity(a) {
  const name = typeof a.source === "string" && a.source.startsWith("lane:") ? a.source.slice(5) : null;
  if (name) { const s = actLine(a); if (s && LAST[name] !== s) { LAST[name] = s; homeSoon(); } }
  const p = name && LP[name];
  if (!p) return;
  if (p.loading) p.queue.push(a);
  else if (p.loaded) laneIngest(p, a);
}
function laneTailsStale() {
  for (const p of Object.values(LP)) p.loaded = false;
}
/* ---------- 프로젝트 (docs/layers.md §5): the list (GET /api/custom) and the main view (GET /api/custom/project?key=) ---------- */
let PRJ = null, PRJ_FAIL = false, prjFlight = null, prjRev = 0;
const prjTitle = p => (p.record && p.record.title) || p.title || p.name;
const prjPurpose = p => (p.record && p.record.purpose) || p.purpose || p.note || "";
const prjMiles = p => { const m = (p.record && p.record.milestones) || p.milestones; return Array.isArray(m) ? m : []; };
const prjMonitors = p => Array.isArray(p.monitors) ? p.monitors.length : typeof p.monitors === "number" ? p.monitors : null;
const prjChat = p => p.key.startsWith("ch:") ? p.key : p.channel ? `ch:${p.channel.id}` : "";
const prjPaused = p => !!(p.paused || (p.record && p.record.paused));
function prjLoad() {
  if (prjFlight) return prjFlight;
  prjFlight = api("/api/custom").then(d => { PRJ = d; PRJ_FAIL = false; }, () => { if (!PRJ) PRJ_FAIL = true; }).then(() => {
    prjFlight = null; prjRev++;
    if (current === "project") { if (ppWide()) renderProjects(); pmPaint(); }
    else if (current === "projects") renderProjects();
  });
  return prjFlight;
}
// The work channel a session was started in (ch:<id>): the hub's lane list carries it as `home` (hub/laneviews.ts withHomes); the gateway's channel map is the fallback.
const laneHome = l => l.home || (S && S.channels && S.channels.homes && S.channels.homes[l.name] ? `ch:${S.channels.homes[l.name]}` : "");
// The project a session belongs to, by name: its home channel only (docs/layers.md §1). A session started from chat has none (""), even when its folder matches a project.
function laneProject(l) {
  const home = laneHome(l);
  if (!home) return "";
  const p = ((PRJ && PRJ.projects) || []).find(x => x.key === home || x.recordKey === home || (x.channel && `ch:${x.channel.id}` === home));
  if (p) return prjTitle(p);
  const work = (S && S.channels && S.channels.work) || {};
  return l.project || work[home.slice(3)] || "";
}
// The one session row (home, project screen): title, parent project, status word; one tap opens the session's chat.
function sessionStatus(l) {
  if (!laneAlive(l)) return ["끝남", ""];
  if (l.status === "working" || l.status === "starting") return ["작업 중", "pri"];
  return ["기다림", l.pendingAsk ? "warn" : ""];
}
// o.project: the project name when the caller knows it better than the lane's own home; o.line: a short activity line after it;
// o.word / o.tone: a status the caller knows better ("답변 필요").
function sessionRow(l, o = {}) {
  const proj = o.project !== undefined ? o.project : laneProject(l), [word, tone] = o.word ? [o.word, o.tone || ""] : sessionStatus(l), name = l.title || l.name, t = `lane:${l.name}`;
  const subs = SUBS[t] || [], done = subs.filter(s => s.status !== "running").length;
  return el("button", { class: "hr srow", type: "button", "data-t": t, onclick: () => openTarget(t, lastChatView()), "aria-label": `${name} · ${proj ? `프로젝트 ${proj}` : "프로젝트 없음"} · ${word} · 대화 열기` },
    el("span", { class: `dot ${tone === "warn" ? "att" : statusTone(l.status)}` }),
    el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: name })),
      el("span", { class: "ha" }, el("span", { class: `sproj${proj ? "" : " none"}`, text: proj || "프로젝트 없음" }), o.line ? el("span", { class: "sline", text: o.line }) : null)),
    subs.length ? el("span", { class: "hp", title: "서브에이전트 끝난 수 / 전체", text: `서브에이전트 ${done}/${subs.length}` }) : null,
    el("span", { class: `hs ${tone}`, text: word }));
}

// Status dot and word of a project: waiting on the owner > working > a live session or channel > nothing running.
function prjStatus(p) {
  const ls = p.lanes || [];
  if (prjPaused(p)) return ["", "일시 정지"];
  if (ls.some(l => l.waiting)) return ["att", "질문 대기"];
  if (ls.some(l => l.live && l.status === "working")) return ["pri", "작업 중"];
  return [ls.some(l => l.live) || p.channel ? "ok" : "", ""];
}
// 프로젝트: the projects as chat-list rows (커스텀 first); the open one is marked, and from 1100px its page sits beside the list.
function projRows(list) {
  const row = p => {
    const [tone, word] = p.builtin ? ["", "고정"] : prjStatus(p), chat = prjChat(p);
    return { name: prjTitle(p), av: el("span", { class: "cv-av", "aria-hidden": "true" }, icon("projects")), badge: word ? [word, tone === "att" ? "warn" : tone] : null, unread: chat ? ts(chat).unread : 0, open: () => go("project", p.key), sel: current === "project" && ppCur === p.key };
  };
  const rest = list.filter(p => !p.builtin);
  return [...list.filter(p => p.builtin).map(row), ...(rest.length ? [{ header: "프로젝트" }, ...rest.map(row)] : [])];
}
function renderProjects() {
  const box = $("#v-projects");
  if (!PRJ) { delete box.dataset.sig; clear(box).append(emptyNode(PRJ_FAIL ? "프로젝트를 불러오지 못했어요" : "불러오는 중…")); return; }
  const list = PRJ.projects || [];
  if (!list.length) { delete box.dataset.sig; clear(box).append(emptyNode("아직 프로젝트가 없어요. 채팅에서 오래 걸리는 작업을 맡기면 여기에 생겨요")); return; }
  const sig = JSON.stringify([list, ppCur, current === "project", list.map(p => { const c = prjChat(p); return c ? ts(c).unread : 0; })]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  clear(box).append(el("div", { class: "cv-list" }, ...projRows(list).map(convRow)));
}
