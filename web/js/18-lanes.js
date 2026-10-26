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

/* ---------- 프로젝트 level 1: a compact list (name, one status line, milestone progress, last activity), filtered and paged ----------
   Rows sort by what needs the owner, then what runs, then the most recent. A row opens the project's overview (level 2); the overview's
   sections open one drill-in page each (level 3). The built-in 커스텀 project is a settings page, so it sits at the end, outside the filters. */
const PJ_PAGE = 12, PJ_VIEWS = [["all", "전체"], ["run", "진행 중"], ["need", "확인 필요"], ["done", "끝남"]];
const PJ = { view: "all", q: "", more: PJ_PAGE };
// What the owner should do with a project now: a waiting session first, then work running, then a finished goal, then a resting one.
function prjState(p) {
  const ls = p.lanes || [], ms = prjMiles(p), allDone = ms.length > 0 && ms.every(m => m.done);
  if (prjPaused(p)) return { k: "paused", tone: "", word: "일시 정지" };
  const ask = ls.find(l => l.waiting);
  if (ask) return { k: "need", tone: "att", word: "답을 기다려요", lane: ask };
  const work = ls.find(l => l.live && (l.status === "working" || l.status === "starting"));
  if (work) return { k: "run", tone: "pri", word: "작업 중", lane: work };
  if (allDone) return { k: "done", tone: "ok", word: "끝남" };
  if (ls.some(l => l.live)) return { k: "run", tone: "", word: "세션 열림" };
  return { k: "idle", tone: "", word: ls.length ? "쉬는 중" : "아직 세션이 없어요" };
}
// The newest thing that happened in the project: a session's report or start, or the record's last save.
function prjLastAt(p) {
  const at = x => Date.parse(x || "") || 0;
  return Math.max(0, ...(p.lanes || []).map(l => at(l.lastReportAt) || at(l.startedAt)), at(p.record && p.record.updated));
}
// A short, calm time: 방금 · 12분 전 · 3시간 전 · 어제 · 4일 전 · 9/30.
function prjAgo(at) {
  if (!at) return "기록 없음";
  const m = Math.max(0, Math.floor((Date.now() - at) / 60000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  return d === 1 ? "어제" : d < 7 ? `${d}일 전` : kstDay(at);
}
const prjRank = s => (s.k === "need" ? 0 : s.k === "run" ? 1 : 2);
// The projects as data rows, in reading order: need -> running -> recent.
function projRows(list) {
  return list.filter(p => !p.builtin).map(p => ({ p, st: prjState(p) }))
    .sort((a, b) => prjRank(a.st) - prjRank(b.st) || prjLastAt(b.p) - prjLastAt(a.p) || String(prjTitle(a.p)).localeCompare(String(prjTitle(b.p)), "ko", { numeric: true }));
}
function pjChipCounts(rows) {
  return { all: rows.length, need: rows.filter(r => r.st.k === "need").length, run: rows.filter(r => r.st.k === "run").length, done: rows.filter(r => r.st.k === "done").length };
}
function pjFiltered() {
  const q = PJ.q.trim().toLowerCase(), rows = projRows((PRJ && PRJ.projects) || []);
  return rows.filter(r => (PJ.view === "all" || r.st.k === PJ.view) && (!q || `${prjTitle(r.p)} ${prjPurpose(r.p)}`.toLowerCase().includes(q)));
}
// One row: name + last activity, the one status line, the milestone bar. A waiting row leads with the question's session.
function prjRow(r) {
  const { p, st } = r, ms = prjMiles(p), done = ms.filter(m => m.done).length, pct = ms.length ? Math.round(done / ms.length * 100) : 0;
  const chat = prjChat(p), unread = chat ? ts(chat).unread : 0, at = prjLastAt(p), sel = current === "project" && ppCur === p.key;
  const line = st.lane ? `${st.word} · ${st.lane.title || st.lane.name}` : st.k === "done" ? `끝남 · 목표를 모두 마쳤어요` : st.word;
  return el("button", { class: `pl-row${sel ? " on" : ""}`, type: "button", "data-key": p.key, "aria-label": `${prjTitle(p)} · ${line} · 열기`, onclick: () => go("project", p.key) },
    el("span", { class: "pl-b" },
      el("span", { class: "pl-1" }, el("span", { class: "pl-n", text: prjTitle(p) }), unread ? el("span", { class: "pl-nb", "aria-label": `읽지 않은 메시지 ${unread}개`, text: unread > 99 ? "99+" : String(unread) }) : null, el("span", { class: "pl-at", text: prjAgo(at) })),
      el("span", { class: "pl-s" }, el("span", { class: `dot ${st.tone}` }), el("span", { class: "pl-sw", text: line })),
      ms.length ? el("span", { class: "pl-p" }, el("span", { class: `pl-bar${done === ms.length ? " done" : ""}`, role: "progressbar", "aria-label": `마일스톤 진행 ${done}/${ms.length}`, "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${pct}%` })), el("span", { class: "pl-pn", text: `${done}/${ms.length}` })) : null));
}
function pjSearch() {
  return el("label", { class: "pl-search" }, icon("search"),
    el("input", { id: "pl-q", type: "search", placeholder: "프로젝트 검색", "aria-label": "프로젝트 검색", autocomplete: "off", value: PJ.q, oninput: ev => { PJ.q = ev.target.value; pjPaintRows(); } }));
}
function pjChips(counts) {
  return el("div", { class: "pl-chips", role: "tablist", "aria-label": "프로젝트 보기" }, ...PJ_VIEWS.map(([k, label]) =>
    el("button", { class: `cchip mr-f${PJ.view === k ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(PJ.view === k), "data-view": k, onclick: () => { PJ.view = k; PJ.more = PJ_PAGE; pjPaintChips(); pjPaintRows(); } },
      label, counts[k] ? el("span", { class: "mr-fn", text: String(counts[k]) }) : el("span", { class: "mr-fn", hidden: true }))));
}
function pjShell() {
  return el("div", { class: "pl", id: "pl-shell" }, el("div", { class: "pl-top" }, pjSearch(), el("div", { id: "pl-chips" })), el("div", { class: "pl-list", id: "pl-list" }));
}
function pjPaintChips() {
  const box = $("#pl-chips");
  if (!box) return;
  const counts = pjChipCounts(projRows((PRJ && PRJ.projects) || [])), had = $(".mr-f", box);
  if (!had) { clear(box).append(pjChips(counts)); return; }
  // The chips stay put (a refresh never steals focus); only their state and counts follow the data.
  for (const b of box.querySelectorAll(".mr-f")) {
    const k = b.dataset.view, n = $(".mr-fn", b), c = counts[k] || 0;
    b.classList.toggle("on", PJ.view === k); b.setAttribute("aria-selected", String(PJ.view === k));
    n.textContent = c ? String(c) : ""; n.hidden = !c;
  }
}
function pjPaintRows() {
  const box = $("#pl-list");
  if (!box) return;
  const rows = pjFiltered(), page = rows.slice(0, PJ.more), rest = rows.length - page.length;
  const builtin = ((PRJ && PRJ.projects) || []).find(p => p.builtin), searching = !!PJ.q.trim();
  const showBuiltin = !!builtin && PJ.view === "all" && (!searching || "커스텀".includes(PJ.q.trim().toLowerCase()));
  const sig = JSON.stringify([rows.map(r => [r.p.key, r.st.k, r.st.word, r.st.lane && r.st.lane.name, prjLastAt(r.p), prjMiles(r.p).map(m => m.done), prjChat(r.p) ? ts(prjChat(r.p)).unread : 0]), PJ.more, PJ.view, PJ.q, current === "project" ? ppCur : "", showBuiltin]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const nodes = page.map(prjRow);
  if (rest > 0) nodes.push(el("div", { class: "cv-more" }, el("button", { class: "btn text", type: "button", "data-k": "more", onclick: () => { PJ.more += PJ_PAGE; pjPaintRows(); }, text: `프로젝트 ${rest}개 더 보기` })));
  if (!rows.length) nodes.push(el("div", { class: "cv-empty", text: searching ? "찾는 프로젝트가 없어요" : PJ.view === "need" ? "확인할 프로젝트가 없어요" : PJ.view === "run" ? "지금 진행 중인 프로젝트가 없어요" : PJ.view === "done" ? "끝낸 프로젝트가 없어요" : "아직 프로젝트가 없어요" }));
  // The built-in 커스텀 page is the owner's settings list: always reachable, never part of the filters.
  if (showBuiltin) {
    nodes.push(el("div", { class: "pl-gh", role: "presentation", text: "내 설정" }));
    nodes.push(el("button", { class: `pl-row sub${current === "project" && ppCur === builtin.key ? " on" : ""}`, type: "button", "data-key": builtin.key, onclick: () => go("project", builtin.key) },
      el("span", { class: "pl-b" }, el("span", { class: "pl-1" }, el("span", { class: "pl-n", text: builtin.name })), el("span", { class: "pl-s" }, el("span", { class: "pl-sw", text: "내가 바꾼 것을 봐요" })))));
  }
  clear(box).append(...nodes);
}
function renderProjects() {
  const box = $("#v-projects");
  if (!PRJ) { delete box.dataset.sig; clear(box).append(emptyNode(PRJ_FAIL ? "프로젝트를 불러오지 못했어요" : "불러오는 중…")); return; }
  const list = PRJ.projects || [];
  if (!list.length) { delete box.dataset.sig; clear(box).append(emptyNode("아직 프로젝트가 없어요. 채팅에서 오래 걸리는 작업을 맡기면 여기에 생겨요")); return; }
  // The shell (search box, chip and list slots) is built once: rebuilding it on a data refresh would drop the search box's focus and caret.
  // The chips and rows below follow the data on their own.
  if (!box.querySelector("#pl-shell")) clear(box).append(pjShell());
  pjPaintChips();
  pjPaintRows();
}
