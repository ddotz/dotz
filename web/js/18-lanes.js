/* ---------- lanes: multi-pane board ---------- */
const laneDraft = {};
let laneSig = "";
const LANE_TAIL = 300;          // activity rows read per card (this turn's time and commands)
const LP = {};                  // lane name -> persistent pane (DOM, scroll and tail state survive re-renders)
let laneBoard = null;
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
// This turn's start and command count, read from the card's activity feed (the status line's "3분 · 명령 12").
function laneStat(p, a) {
  if (a.type === "turn_start") { p.t0 = Date.parse(a.ts) || 0; p.cmds = 0; }
  else if (a.type === "turn_end") p.t0 = 0;
  else if (a.type === "tool_call" && kindOf(a.tool) === "명령") p.cmds++;
}
function laneStatusLine(p, l) {
  const parts = [statusKo(l.status)];
  if (l.status === "working" || l.status === "starting") {
    if (p.t0) parts.push(fmtDur(Date.now() - p.t0));
    if (p.cmds) parts.push(`명령 ${p.cmds}`);
  } else { const r = laneReport(p.name); if (r) parts.push(`마지막 보고 ${kstHM(r.ts)}`); }
  return parts.join(" · ");
}
const openLaneChat = name => { setTarget(`lane:${name}`); go("chat"); };
function laneRepPaint(p) {
  const r = laneReport(p.name), sig = r ? `${r.ts}|${String(r.text ?? "").length}` : "";
  if (p.repSig === sig) return;
  if (!r && !p.loaded) return;
  p.repSig = sig; clear(p.rep);
  if (!r) { p.rep.append(el("div", { class: "lnone", text: "아직 보고가 없어요" })); return; }
  const { tone, text } = parseTone(noHandoff(String(r.text ?? ""))), lt = tone ? LANE_TONE[tone] : null;
  const long = text.length > 120 || text.split("\n").length > 4;
  p.rep.append(el("div", { class: "mt" }, kstHM(r.ts), lt ? el("span", { class: `tag ${lt[0]}`, text: lt[1] }) : null),
    mdNode(text, `md lclamp${long ? " long" : ""}`), long ? el("button", { class: "btn text lmore", type: "button", onclick: ev => { ev.stopPropagation(); openLaneChat(p.name); } }, "더 보기") : null);
}
function laneRefresh(p) { laneRepPaint(p); if (p.lane) p.stat.textContent = laneStatusLine(p, p.lane); }
function laneIngest(p, a) {
  const k = laneKey(a);
  if (p.seen.has(k)) return;
  p.seen.add(k); laneStat(p, a); laneRefresh(p);
}
async function laneLoad(p) {
  p.loading = true; p.queue = [];
  const t = `lane:${p.name}`;
  let r, h;
  try { [r, h] = await Promise.all([api(`/api/activity?source=${enc(t)}&limit=${LANE_TAIL}`), api(`/api/history?target=${enc(t)}&limit=60`).catch(() => null)]); }
  catch { p.loading = false; p.failedAt = Date.now(); return; }
  if (h) { const st = ts(t); for (const e of h.events || []) { const k = msgKey(e); if (!st.mk.has(k)) { st.mk.add(k); st.msgs.push(e); } } st.msgs.sort(byTs); }
  p.seen = new Set(); p.t0 = 0; p.cmds = 0;
  for (const a of r.items || []) { p.seen.add(laneKey(a)); laneStat(p, a); }
  for (const a of p.queue) laneIngest(p, a);
  p.queue = []; p.loading = false; p.loaded = true;
  laneRefresh(p);
}
// SSE "activity": keep every loaded pane live, even while another view is open.
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

function laneSend(p, l) {
  const text = p.input.value.trim();
  const alive = laneAlive(l);
  if (!text && alive) return Promise.resolve();
  return busy(p.send, async () => {
    if (alive) await api("/api/message", "POST", { text, lane: p.name });
    else await api(`/api/lanes/${enc(p.name)}/resume`, "POST", text ? { text } : {});
    p.input.value = ""; laneDraft[p.name] = "";
    toast(alive ? "전달했어요" : "재개했어요");
    refreshState();
  });
}
function laneActions(p, l) {
  const alive = laneAlive(l);
  const act = (label, kind, fn) => el("button", { class: `btn ${kind}`, type: "button", onclick: ev => busy(ev.currentTarget, async () => { await fn(); refreshState(); }) }, label);
  const post = (path, body) => api(`/api/lanes/${enc(p.name)}/${path}`, "POST", body ?? {});
  if (!alive) return [act("재개", "tonal", async () => { const t = p.input.value.trim(); await post("resume", t ? { text: t } : {}); p.input.value = ""; laneDraft[p.name] = ""; toast("재개했어요"); })];
  return [
    el("button", { class: "btn text", type: "button", onclick: () => p.input.focus() }, "메시지"),
    act("중단", "text", async () => { await post("abort"); toast("작업을 중단했어요"); }),
    act("재시작", "text", async () => { if (!await ask(`${p.name} 재시작`, "이 세션을 다시 시작할까요?", "재시작", true)) return; await post("restart"); toast("재시작했어요"); }),
    // Same look as its siblings; the confirm dialog carries the danger styling.
    act("종료", "text", async () => { if (!await ask(`${p.name} 종료`, "이 세션을 종료할까요?", "종료", true)) return; await api(`/api/lanes/${enc(p.name)}`, "DELETE"); toast("종료했어요"); }),
  ];
}
function lanePane(name) {
  const p = { name, seen: new Set(), queue: [], t0: 0, cmds: 0, repSig: null, loaded: false, loading: false, failedAt: 0, alive: null };
  p.dot = el("span", { class: "dot" });
  p.nameBtn = el("button", { class: "lname", type: "button", title: "대화 열기", onclick: () => openTarget(`lane:${name}`, lastChatView()) });
  p.tag = el("span", { class: "tag" });
  p.att = el("span", { class: "tag warn", text: "확인 필요", hidden: true });
  p.claim = el("span", { class: "tag", hidden: true });
  p.ask = el("span", { class: "tag warn", text: "질문 대기", hidden: true });
  p.subs = el("button", { class: "tag pri", type: "button", hidden: true, title: "서브에이전트 보기", onclick: ev => { ev.stopPropagation(); openSubs([`lane:${name}`]); } });
  p.model = el("div", { class: "lmodel" });
  p.proj = el("div", { class: "lproj", hidden: true });
  p.acts = el("div", { class: "lacts" });
  p.rep = el("div", { class: "lrep", tabindex: "0", role: "region", "aria-label": `${name} 마지막 보고`, onclick: () => { if (!String(getSelection() || "")) openLaneChat(name); } });
  p.stat = el("div", { class: "lstat" });
  p.input = input({ type: "text", enterkeyhint: "send", value: laneDraft[name] || "", oninput: ev => { laneDraft[name] = ev.target.value; }, onkeydown: ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); p.send.click(); } } });
  p.send = el("button", { class: "ib pri", type: "button" }, icon("send"));
  const head = el("div", { class: "lhead" }, el("div", { class: "ltop" }, p.dot, p.nameBtn, p.att, p.tag, p.claim, p.ask, p.subs), p.proj, p.model, p.acts);
  p.node = el("section", { class: "lpane", "aria-label": name, "data-t": `lane:${name}` }, head,
    p.rep, p.stat,
    el("div", { class: "lcomp" }, p.input, p.send));
  return p;
}
function laneUpdate(p, l, m) {
  const alive = laneAlive(l), tone = statusTone(l.status);
  p.lane = l;
  p.send.onclick = () => laneSend(p, l);
  const k = attnKind(`lane:${l.name}`);
  p.dot.className = `dot ${k ? "att" : tone}`;
  p.att.hidden = !k;
  p.nameBtn.textContent = l.title || l.name;
  p.nameBtn.title = l.title ? `${l.name} · 대화 열기` : "대화 열기";
  const proj = laneProject(l);
  p.proj.hidden = !proj; p.proj.textContent = proj ? `프로젝트 · ${proj}` : "";
  p.tag.className = `tag ${tone}`; p.tag.textContent = statusKo(l.status);
  // "reported" is the lane's own done claim; "verified" only after the orchestrator checked it (dotz_lane verify).
  const claim = l.claim && l.claim.state;
  p.claim.hidden = !claim; p.claim.className = `tag ${claim === "verified" ? "ok" : "pri"}`; p.claim.textContent = claim === "verified" ? "확인됨" : "보고됨"; p.claim.title = claim === "verified" ? `오케스트레이터가 확인했어요${l.claim.evidence ? `: ${l.claim.evidence}` : ""}` : "세션이 완료라고 보고했어요 (아직 확인 전)";
  // A lane's [ask] report waits for the owner's answer until the owner (or the orchestrator) writes to the lane.
  const pa = l.pendingAsk;
  p.ask.hidden = !pa; p.ask.title = pa ? `답을 기다리는 질문 (${kstStamp(pa.at)}): ${String(pa.text).slice(0, 500)}` : "";
  const allSubs = SUBS[`lane:${l.name}`] || [], runSubs = runningSubs(`lane:${l.name}`).length;
  p.subs.hidden = !allSubs.length; p.subs.className = `tag${runSubs ? " pri" : ""}`;
  p.subs.textContent = `서브에이전트 ${allSubs.length - runSubs}/${allSubs.length}`; p.subs.title = `서브에이전트 끝난 수 / 전체 · ${runSubs}개 진행 중`;
  const model = (m && m.model) || l.model;
  p.model.textContent = model ? `${modelName(model)}${m && m.thinking ? ` · ${m.thinking}` : ""}` : "";
  p.model.hidden = !model;
  if (p.alive !== alive) {
    p.alive = alive;
    const ph = alive ? "메시지" : "재개 메시지";
    p.input.placeholder = ph; p.input.setAttribute("aria-label", ph);
    p.send.setAttribute("aria-label", alive ? "전송" : "재개");
    p.node.classList.toggle("off", !alive);
  }
  p.node.classList.toggle("att", !!k || l.status === "rate-limited");
  clear(p.acts).append(...laneActions(p, l));
  laneRefresh(p);
}
function laneBoardInit() {
  const grid = el("div", {});
  laneBoard = { grid, none: emptyNode("작동 중인 세션 없음") };
  laneBoard.node = el("div", { class: "lboard" }, laneBoard.none, grid);
  $("#lanes").append(laneBoard.node);
  // The tail of a pane follows the card height; a resize or move only re-sticks the tails.
  laneBoard.board = makeBoard(grid, "lanes");
}
// Running lanes only: an exited lane leaves the board at once (its history and resume stay reachable from ⌘K).
function renderLanes() {
  if (!S) return;
  if (!laneBoard) laneBoardInit();
  const lanes = S.lanes.filter(laneAlive);
  const modelOf = n => (M && M.lanes || []).find(l => l.name === n);
  const sig = JSON.stringify([lanes.map(l => [l.name, l.title, l.home, l.status, l.model, (SUBS[`lane:${l.name}`] || []).map(s => s.status).join(), attnKind(`lane:${l.name}`), l.claim && l.claim.state, l.pendingAsk && l.pendingAsk.at]), prjRev, M && M.lanes, M && M.available && M.available.length]);
  if (sig === laneSig) return renderEndedLanes();
  laneSig = sig;
  const B = laneBoard;
  for (const n of Object.keys(LP)) if (!lanes.some(l => l.name === n)) { LP[n].node.remove(); delete LP[n]; delete laneDraft[n]; }
  for (const l of lanes) laneUpdate(LP[l.name] || (LP[l.name] = lanePane(l.name)), l, modelOf(l.name));
  const ordered = lanes;
  B.none.hidden = ordered.length > 0;
  B.grid.hidden = !ordered.length;
  B.board.bar.hidden = !ordered.length;
  B.board.set(ordered.map(l => ({ id: `lane:${l.name}`, node: LP[l.name].node, head: ".lhead", def: { w: 4, h: 9 }, min: { w: 3, h: 6 }, max: { w: 12, h: 24 } })));
  for (const l of ordered) {
    const p = LP[l.name];
    if (!p.loaded && !p.loading && Date.now() - p.failedAt > 15000) laneLoad(p);
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
// The project a session belongs to, by name: its home channel (ch:<id>), else the folder project that lists it.
function laneProject(l) {
  const list = (PRJ && PRJ.projects) || [];
  const p = (l.home && list.find(x => x.key === l.home || (x.channel && `ch:${x.channel.id}` === l.home))) || list.find(x => (x.lanes || []).some(z => z.name === l.name));
  if (p) return prjTitle(p);
  const work = (S && S.channels && S.channels.work) || {};
  return l.home && l.home.startsWith("ch:") ? work[l.home.slice(3)] || "" : "";
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
  const [tone, word] = prjStatus(p), ms = prjMiles(p), done = ms.filter(m => m.done).length, ls = p.lanes || [], mon = prjMonitors(p);
  const pct = ms.length ? Math.round(done / ms.length * 100) : 0;
  const meta = [ls.length ? `세션 ${ls.filter(l => l.live).length}/${ls.length}` : "세션 없음", mon != null ? `모니터 ${mon}` : ""].filter(Boolean);
  return el("button", { class: "card tap prj-card", type: "button", onclick: () => go("project", p.key) },
    el("div", { class: "prj-top" }, el("span", { class: `dot ${tone}` }), el("span", { class: "prj-title", text: prjTitle(p) }),
      word ? el("span", { class: `tag ${tone === "att" ? "warn" : tone}`, text: word }) : null, icon("chev", "chev")),
    prjPurpose(p) ? el("div", { class: "prj-note", text: prjPurpose(p) }) : null,
    ms.length ? el("div", { class: "prj-prog" }, el("div", { class: "bar", role: "progressbar", "aria-label": "목표 진행", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${pct}%` })), el("span", { class: "sup", text: `${done}/${ms.length}` })) : null,
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
