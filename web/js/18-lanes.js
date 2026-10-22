/* ---------- 세션 탭: one status briefing card per session; a tap anywhere on it opens that session's chat ---------- */
let laneSig = "";
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
// Tap: the conversation that asked for the work (its waiting message, flashed). Unknown, or gone: the main chat at the time it started.
async function workGo(w) {
  const t = w.target && validTarget(w.target) ? w.target : MAIN;
  if (!(ts(t).hLoaded && ts(t).aLoaded)) await loadTarget(t).catch(() => {});
  const asked = w.reply_to ? ts(t).msgs.find(e => e.mid === w.reply_to) : null;
  ntJump({ src: t, at: asked ? asked.ts : new Date(w.started_at).toISOString() });
}
// A relative time on the KST clock: 방금 / N분 전 / N시간 전 (today) / 어제 오후 3:20 / 10월 20일.
function agoKo(t) {
  if (!(t > 0)) return "";
  const m = Math.floor((Date.now() - t) / 60000), day = x => new Date(x).toLocaleDateString("sv-SE", KST);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (day(t) === day(Date.now())) return `${Math.floor(m / 60)}시간 전`;
  if (day(t) === day(Date.now() - 864e5)) return `어제 ${kstHM(t)}`;
  return new Date(t).toLocaleDateString("ko-KR", { ...KST, month: "long", day: "numeric" });
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
// The one-line state of a live session, in plain Korean, and when it happened.
function laneState(l, recent) {
  const pa = l.pendingAsk, top = recent[0];
  if (pa) return ["질문에 답을 기다리고 있어요", Date.parse(pa.at) || 0];
  if (l.status === "rate-limited") return ["사용 한도에 걸려 잠시 멈췄어요", top ? top.ts : 0];
  if (l.status === "starting") return ["세션을 시작하는 중이에요", top ? top.ts : 0];
  if (l.status === "working") return [top ? top.text : "작업을 하고 있어요", top ? top.ts : 0];
  const rep = recent.find(r => r.report);
  if (rep) return ["작업을 마치고 보고했어요", rep.ts];
  return [top ? top.text : "다음 지시를 기다리고 있어요", top ? top.ts : 0];
}
function laneCard(l) {
  const name = l.title || l.name, proj = laneProject(l), [word, tone] = sessionStatus(l), recent = laneRecent(l.name), [state, at] = laneState(l, recent), when = agoKo(at);
  const k = attnKind(`lane:${l.name}`), card = el("button", { class: `card tap sb-card${k ? " att" : ""}`, type: "button", "data-t": `lane:${l.name}`, onclick: () => openLaneChat(l.name),
    "aria-label": `${name} · ${proj ? `프로젝트 ${proj}` : "프로젝트 없음"} · ${word} · ${state}${when ? ` · ${when}` : ""} · 대화 열기` },
    el("div", { class: "sb-top" }, el("span", { class: `dot ${k ? "att" : tone === "warn" ? "att" : statusTone(l.status)}` }), el("span", { class: "sb-title", text: name }),
      el("span", { class: `tag ${tone}`, text: word }), icon("chev", "chev")),
    el("div", { class: `sb-proj${proj ? "" : " none"}`, text: proj ? `프로젝트 · ${proj}` : "프로젝트 없음" }),
    el("div", { class: "sb-state" }, el("span", { class: "t", text: state }), when ? el("span", { class: "w", text: when }) : null));
  const rest = recent.filter(r => r.text !== state);
  if (rest.length) card.append(el("div", { class: "sb-recent" }, el("div", { class: "sb-h", text: "최근 내역" }),
    ...rest.map(r => el("div", { class: "sb-item" }, el("span", { class: "t", text: r.text }), el("span", { class: "w", text: agoKo(r.ts) })))));
  return card;
}
function laneRefresh(p) { p.rev++; laneSoon(); }
let laneSoonT;
const laneSoon = () => { clearTimeout(laneSoonT); laneSoonT = setTimeout(() => { if (current === "lanes") { laneSig = ""; renderLanes(); } }, 300); };
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
  if (current === "lanes") { laneSig = ""; renderLanes(); }
}
// Running and waiting sessions, a question waiting for the owner first, then the ones at work; the ended ones fold below (renderEndedLanes).
function renderLanes() {
  if (!S) return;
  const lanes = S.lanes.filter(laneAlive);
  for (const n of Object.keys(LP)) if (!lanes.some(l => l.name === n)) delete LP[n];
  for (const l of lanes) if (!LP[l.name]) LP[l.name] = { name: l.name, acts: [], seen: new Set(), queue: [], rev: 0, loaded: false, loading: false, failedAt: 0 };
  const rank = l => (l.pendingAsk ? 0 : l.status === "working" || l.status === "starting" ? 1 : 2);
  const recentTs = l => { const r = laneRecent(l.name)[0]; return r ? r.ts : 0; };
  const sig = JSON.stringify([lanes.map(l => [l.name, l.title, l.home, l.project, l.status, attnKind(`lane:${l.name}`), l.pendingAsk && l.pendingAsk.at, LP[l.name].rev, ts(`lane:${l.name}`).msgs.length]), prjRev, Math.floor(Date.now() / 30000)]);
  if (sig !== laneSig) {
    laneSig = sig;
    const box = $("#lanes");
    clear(box);
    if (!lanes.length) box.append(emptyNode("작동 중인 세션이 없어요"));
    else box.append(el("div", { class: "sb-list" }, ...lanes.map(l => ({ l, r: rank(l), t: recentTs(l) })).sort((x, y) => x.r - y.r || y.t - x.t).map(x => laneCard(x.l))));
    for (const l of lanes) { const p = LP[l.name]; if (!p.loaded && !p.loading && Date.now() - p.failedAt > 15000) laneLoad(p); }
  }
  renderEndedLanes();
}
function renderEndedLanes() {
  const box = $("#lanes-ended"), names = endedLanes().map(l => l.name).join("|");
  if (box.dataset.sig === `${names}|${endedOpen}`) return;
  box.dataset.sig = `${names}|${endedOpen}`;
  clear(box).append(endedGroup() || "");
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
    if (current === "projects") renderProjects();
    else if (current === "project") pmPaint();
    else if (current === "lanes") renderLanes();
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
  if (prjPaused(p)) return ["", "쉬는 중"];
  if (ls.some(l => l.waiting)) return ["att", "질문 대기"];
  if (ls.some(l => l.live && l.status === "working")) return ["pri", "작업 중"];
  return [ls.some(l => l.live) || p.channel ? "ok" : "", ""];
}
function prjCard(p) {
  if (p.builtin) return el("button", { class: "card tap prj-card", type: "button", onclick: () => go("project", p.key) },
    el("div", { class: "prj-top" }, el("span", { class: "dot ok" }), el("span", { class: "prj-title", text: p.name }), el("span", { class: "tag", text: "고정" }), icon("chev", "chev")),
    el("div", { class: "prj-note", text: p.note }), el("div", { class: "prj-meta" }, el("span", { text: "홈 카드 · 루틴 · 규칙 · 말투" })));
  const [tone, word] = prjStatus(p), ms = prjMiles(p), done = ms.filter(m => m.done).length, ls = p.lanes || [], mon = prjMonitors(p);
  const pct = ms.length ? Math.round(done / ms.length * 100) : 0;
  const meta = [ls.length ? `세션 ${ls.filter(l => l.live).length}/${ls.length}` : "세션 없음", mon != null ? `모니터링 ${mon}` : ""].filter(Boolean);
  return el("button", { class: "card tap prj-card", type: "button", onclick: () => go("project", p.key) },
    el("div", { class: "prj-top" }, el("span", { class: `dot ${tone}` }), el("span", { class: "prj-title", text: prjTitle(p) }),
      word ? el("span", { class: `tag ${tone === "att" ? "warn" : tone}`, text: word }) : null, icon("chev", "chev")),
    // A fresh project (no description, no milestones) keeps the same three rows as a filled one, so cards in the grid line up.
    el("div", { class: `prj-note${prjPurpose(p) ? "" : " blank"}`, text: prjPurpose(p) || "아직 설명이 없어요" }),
    el("div", { class: "prj-prog" }, ...(ms.length ? [el("div", { class: "bar", role: "progressbar", "aria-label": "목표 진행", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${pct}%` })), el("span", { class: "sup", text: `${done}/${ms.length}` })] : [el("span", { class: "sup", text: "아직 목표가 없어요" })])),
    el("div", { class: "prj-meta" }, ...meta.map(t => el("span", { text: t }))));
}
function renderProjects() {
  const box = $("#v-projects");
  if (!PRJ) { delete box.dataset.sig; clear(box).append(emptyNode(PRJ_FAIL ? "프로젝트를 불러오지 못했어요" : "불러오는 중…")); return; }
  const list = PRJ.projects || [];
  if (!list.length) { delete box.dataset.sig; clear(box).append(emptyNode("아직 프로젝트가 없어요. 채팅에서 계속 돌아가야 하는 일을 맡기면 여기에 생겨요")); return; }
  const sig = JSON.stringify(list);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  clear(box).append(el("div", { class: "prj-grid" }, ...list.map(prjCard)));
}
