/* ---------- 프로젝트: level 2 overview (header, 확인 필요, four summary rows) and level 3 drill-in pages ---------- */
// PM.D = the detail; PM.open counts fields being edited (a refresh never repaints under them);
// PM.sheets = the open drill-in pages, repainted from the re-fetched detail after every write.
const pmReset = () => ({ key: "", D: null, fail: false, open: 0, flight: null, sheets: new Set() });
let PM = pmReset();
function pmOpen(key) {
  if (PM.key !== key) { for (const s of PM.sheets) s.h.close(false); PM = { ...pmReset(), key }; }
  pmPaint(); prjLoad(); pmLoad();
}
function pmLoad() {
  const st = PM;
  if (!st.key) return Promise.resolve(false);
  if (st.flight) return st.flight;
  st.flight = api(`/api/custom/project?key=${enc(st.key)}`).then(d => { st.D = d; st.fail = false; return true; }, () => { if (!st.D) st.fail = true; return false; })
    .then(ok => { st.flight = null; if (PM === st) pmPaint(); return ok; });
  return st.flight;
}
// A project turn changed this project's info (hub/outbound.ts noteProjectInfo): a fetch already out may predate it, so one follows it.
function pmLive(e) {
  if (current !== "project" || (e.key !== PM.key && e.key !== (pmProject() || {}).recordKey)) return;
  (PM.flight || Promise.resolve()).then(pmLoad);
}
// After a write: fetch again and repaint from what the gateway kept (the page never shows the typed value as saved).
async function pmReload() {
  const st = PM;
  if (st.flight) await st.flight;
  const root = $("#v-project");
  if (root) delete root.dataset.sig;
  st.open = 0;
  await Promise.all([pmLoad(), prjLoad()]);
}
// The record lives under the project's channel when it has one (hub/custom.ts recordKey).
const pmWrite = body => api("/api/projects", "PUT", { key: (pmProject() || {}).recordKey || PM.key, ...body });
// Runs a write; a failure stays as a calm note under the control, a success re-fetches.
async function pmDo(note, fn) {
  note.className = "note"; note.textContent = "";
  try { await fn(); } catch (e) { note.className = "note err"; note.textContent = TX("project.save_failed", { error: e.message }); return false; }
  await pmReload();
  return true;
}
const pmNames = {};   // project key -> the name last shown for it
function pmProject() {
  const found = ((PRJ && PRJ.projects) || []).find(x => x.key === PM.key || x.recordKey === PM.key);
  if (found) return found;
  const D = PM.D;
  return D ? { key: PM.key, name: (D.record && D.record.title) || (PM.key === "builtin:custom" ? TX("project.custom") : PM.key), lanes: D.lanes || [], record: D.record } : null;
}
function pmSessionRows(p, D) {
  const dl = (D && D.lanes) || [], all = (S && S.lanes) || [], names = new Set([...dl.map(l => l.name), ...(p.lanes || []).map(l => l.name)]);
  const chat = prjChat(p);
  if (chat) for (const l of all) if (laneChat(l) === chat) names.add(l.name);
  return [...names].map(n => {
    const s = all.find(l => l.name === n), d = dl.find(l => l.name === n) || (p.lanes || []).find(l => l.name === n) || {};
    return { project: (s && laneProject(s)) || prjTitle(p), at: Date.parse(d.finishedAt || d.lastReportAt || d.startedAt || (s && s.startedAt) || "") || 0, name: n, title: (s && s.title) || d.title || n, live: s ? laneAlive(s) : !!d.live, status: s ? s.status : d.status, waiting: s ? !!s.pendingAsk : !!d.waiting, ask: s && s.pendingAsk && s.pendingAsk.text ? oneLine(s.pendingAsk.text) : "", line: friendlyLine(d.line || d.lastText || "").slice(0, 140) };
  }).map(r => ({ r, rank: pmSessionRank(r) })).sort((a, b) => a.rank - b.rank || (a.rank === PM_DONE ? b.r.at - a.r.at : a.r.title.localeCompare(b.r.title))).map(x => x.r);
}
// The word of a project's session row, the same as its 진행 중 row (sessionState). Waiting on the owner, then running, then what stopped short; finished sink, newest first.
const pmLaneState = r => sessionState({ name: r.name, status: r.status, live: r.live, pendingAsk: r.waiting });
const PM_DONE = 3;
function pmSessionRank(r) {
  const s = pmLaneState(r);
  return s === SESSION_WORD.wait ? 0 : s === SESSION_WORD.run ? 1 : s === SESSION_WORD.done ? PM_DONE : 2;
}
// Level 2: the essentials only. Each section is one tappable summary row that opens its own page (level 3, pmSheet).
function pmPaint() {
  if (current !== "project" || PM.open > 0) return;
  const root = $("#v-project"), D = PM.D, p = pmProject();
  // The name stays in the app bar when the project cannot be read now: the last one seen, or the chat channel's own name.
  if (!p) { if (!ppWide()) $("#title").textContent = pmNames[PM.key] || (isProjT(PM.key) ? targetName(PM.key) : TX("common.projects")); delete root.dataset.sig; clear(root).append(emptyNode(PM.fail || PRJ_FAIL ? TX("project.one.load_failed") : TX("common.loading"), PM.fail || PRJ_FAIL ? () => Promise.all([pmLoad(), prjLoad()]) : null)); return; }
  if (p.builtin) { cmPaint(root, p, D); return; }
  const q = { ...p, record: (D && D.record) || p.record }, rows = pmSessionRows(p, D);
  pmNames[PM.key] = prjTitle(q);
  // A phone shows one screen at a time, so its app bar carries the project's name (the prototype's detail); wide keeps the list beside it under "프로젝트".
  $("#title").textContent = ppWide() ? TX("common.projects") : prjTitle(q);
  const sig = JSON.stringify([q, D, rows, botName, PM.fail]);
  if (root.dataset.sig === sig) return;
  root.dataset.sig = sig;
  // Not read yet is not empty: what is already known (확인 필요, the sessions) shows, and under it a pending load says so, a failed one offers 다시 시도.
  const o = pmOverview(q, D, rows);
  if (!D) o.append(emptyNode(PM.fail ? TX("project.rest_failed") : TX("common.loading"), PM.fail ? () => { PM.fail = false; pmPaint(); pmLoad(); } : null));
  clear(root).append(pmHead(q), o);
  pmSheetsPaint();
}
// An open drill-in page follows the detail: a save or a 20 s refresh repaints it from the re-fetched data, never under a field being typed in.
// A row of one of these pages opens a conversation: the page must not stay over it.
const pmSheetsClose = () => { for (const s of [...PM.sheets]) s.h.close(); };
function pmSheetsPaint() {
  for (const s of PM.sheets) if (!(s.h.box.contains(document.activeElement) && document.activeElement.matches("input, textarea"))) s.paint();
}
// What needs the owner now: the prototype's 확인 필요 card (s-work.js project ask): the question, then one filled action. Nothing else needs a card of its own:
// a running session or job is already a row of the lists below.
function pmPrimary(rows) {
  const wait = rows.filter(r => r.waiting), ask = wait[0];
  if (!ask) return null;
  return el("div", { class: "card pm-need" },
    el("div", { class: "ch" }, el("h3", { text: TX("home.attn.check") }), el("span", { class: "tag warn", text: TX("decision.waiting_tag") })),
    el("div", { class: "pm-need-t", text: ask.ask || ask.title }),
    wait.length > 1 ? el("div", { class: "pm-need-s", text: TX("project.need.more", { n: wait.length - 1 }) }) : null,
    el("div", { class: "cf" }, el("button", { class: "btn pm-need-a", type: "button", "data-k": "answer", onclick: () => openTarget(`lane:${ask.name}`, lastChatView()) }, TX("project.need.answer"))));
}
// A monitor, routine or schedule of the project as a prototype 감시 row: health dot, name, one quiet line, and what kind it is.
function pmWatchRow(x) {
  const mins = x.every_minutes ?? (x.schedule && x.schedule.every_minutes) ?? 0, [tone, why] = pmHealth(x);
  const sub = [mins ? pmEvery(mins) : "", x.paused ? TX("project.paused") : why || (x.lastRun ? TX("project.rt.last", { at: kstStamp(x.lastRun) }) : "")].filter(Boolean).join(" · ");
  // A monitor opens beside the other monitors, as in 모니터링; an app's own watch has no row there and stays in the sheet.
  const open = () => { const it = x.kind === "monitor" ? monItems().find(i => i.mon && i.mon.watch === x.id) : null; if (it) go("monitoring", monRowGo(it)); else pmSheet("routines"); };
  return el("button", { class: "li tap", type: "button", onclick: open },
    el("span", { class: "lead" }, el("span", { class: `dot ${tone}` })),
    el("span", { class: "tx" }, el("div", { class: "hd", text: pmRoutineName(x) }), sub ? el("div", { class: "sup", text: sub }) : null),
    el("span", { class: "li-end" }, el("span", { class: "tag", text: PM_KIND[x.kind] })));
}
function pmOverview(q, D, rows) {
  const work = (D && D.work) || [], results = (D && D.results) || [], items = pmRoutineItems(D);
  const works = [...work.filter(w => w.status === "running"), ...work.filter(w => w.status !== "running")];
  const info = (D && D.info) || {}, files = info.files || [];
  // A section with nothing in it is left out, title and all.
  const parts = [
    pmPrimary(rows),
    pmSection({ kind: "info", label: TX("project.sec.info"), count: "", action: D && D.info ? TX("project.sec.all") : "", head: info.summary ? el("div", { class: "pm-goal sup", text: info.summary }) : null,
      nodes: pmInfoRows(info) }),
    pmSection({ kind: "sessions", label: TX("project.sec.sessions"), count: rows.length, action: rows.length ? TX("project.sec.all") : "", nodes: rows.slice(0, 5).map(pmLaneRow) }),
    pmSection({ kind: "sessions", label: TX("home.work.work"), count: work.length, nodes: works.slice(0, 4).map(pmWorkRow) }),
    pmSection({ kind: "results", label: TX("project.sec.results"), count: results.length, action: results.length ? TX("project.sec.all") : "", nodes: results.slice(0, 4).map(pmResultRow) }),
    files.length ? pmSection({ kind: "info", label: TX("project.sec.files"), count: files.length, action: files.length > 3 ? TX("project.sec.all") : "", nodes: files.slice(-3).toReversed().map(pmFileRow) }) : null,
    pmSection({ kind: "routines", label: TX("project.sec.watch"), count: items.length, action: items.length ? TX("project.sec.all") : "", nodes: items.slice(0, 4).map(pmWatchRow) })].filter(Boolean);
  // Nothing to draw once the detail is read: one line says what will appear and how to start (before it is read, the load line speaks).
  if (D && !parts.length) parts.push(emptyNode(TX("project.empty.overview")));
  return el("div", { class: "pm-o" }, ...parts);
}
// A line of what the project's turns kept (hub/projectinfo.ts), with what kind of line it is.
const pmInfoRow = (text, tag, tone = "") => el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "hd pmv-clamp pmv-wrap", text })), tag ? el("span", { class: "li-end" }, el("span", { class: `tag ${tone}`, text: tag })) : null);
const pmInfoRows = i => [...(i.blocked || []).map(t => pmInfoRow(t, TX("project.info.blocked_tag"), "warn")), ...(i.next || []).slice(0, 3).map(t => pmInfoRow(t, TX("project.info.next"))), ...(i.decided || []).slice(-3).toReversed().map(d => pmInfoRow(d.text, TX("project.info.decided_tag")))];
const pmFileRow = f => el("button", { class: "li tap", type: "button", onclick: () => openPath(f.path) }, el("span", { class: "tx" }, el("div", { class: "hd", text: f.label })));
function pmInfoBody(D) {
  const i = (D && D.info) || {}, part = (title, rows) => rows.length ? [el("div", { class: "pmv-day", text: title }), el("div", { class: "list" }, ...rows)] : [];
  const nodes = [
    ...(i.summary ? [el("div", { class: "pm-goal sup", text: i.summary })] : []),
    ...part(TX("project.info.blocked"), (i.blocked || []).map(t => pmInfoRow(t))),
    ...part(TX("project.info.next"), (i.next || []).map(t => pmInfoRow(t))),
    ...part(TX("project.info.decided"), (i.decided || []).toReversed().map(d => pmInfoRow(d.text))),
    ...part(TX("project.info.prefs"), (i.prefs || []).toReversed().map(p => pmInfoRow(p.text))),
    ...part(TX("project.sec.files"), (i.files || []).toReversed().map(pmFileRow)),
  ];
  return nodes.length ? el("div", {}, ...nodes) : emptyNode(TX("project.info.empty"));
}
// The prototype's section header + list (s-work.js project detail: 지금 상황 · 세션 · 작업 · 결과 · 감시); the header button opens the section's full page.
function pmSection({ kind, label, count, action, head, nodes }) {
  if (!nodes.length && !head) return null;
  return el("div", { class: "pm-block" },
    el("div", { class: "sec sec-act pm-sec" }, el("span", { text: `${label}${count !== "" ? ` ${count}` : ""}` }),
      action ? el("button", { class: "btn text sm", type: "button", "data-k": kind, onclick: () => pmSheet(kind), text: action }) : null),
    head,
    nodes.length ? el("div", { class: "list pm-sec-list" }, ...nodes) : null);
}
// Level 3: one section page over the overview. It is an overlay, so 32-history-nav gives it its own history entry: the back arrow
// (or the browser's back) returns to the overview. Every function of the old one-page layout lives here, unchanged.
const PM_PAGE = { info: [TX("project.sec.info"), TX("project.page.info_sub")], rules: [TX("project.page.rules"), TX("project.page.rules_sub")], sessions: [TX("project.page.sessions"), TX("project.page.sessions_sub")], results: [TX("project.page.results"), TX("project.page.results_sub")], routines: [TX("project.page.routines"), TX("project.page.routines_sub")] };
function pmSheet(kind) {
  const [title, ey] = PM_PAGE[kind] || [TX("common.projects"), ""];
  let entry;
  const h = fsOpen({ cls: "pdv", labelledby: "pdv-t", onClose: () => PM.sheets.delete(entry) });
  entry = { h, paint: () => {
    const p = pmProject();
    if (!p) { clear(h.box).append(el("div", { class: "fs-body pdv-body" }, emptyNode(TX("common.loading")))); return; }
    const rows = pmSessionRows(p, PM.D);
    const body = kind === "info" ? pmInfoBody(PM.D) : kind === "rules" ? cmRulesBody() : kind === "sessions" ? pmSessions(PM.D, rows) : kind === "results" ? pmResults(PM.D) : pmRoutines(PM.D);
    clear(h.box).append(
      el("div", { class: "pdv-hd" },
        el("button", { class: "ib pdv-back", type: "button", "data-k": "back", "aria-label": TX("common.back"), title: TX("project.back_to"), onclick: () => h.close() }, icon("back")),
        el("div", { class: "pdv-tt" }, el("h2", { class: "pdv-t", id: "pdv-t", text: title }), el("div", { class: "pdv-ey", text: ey }))),
      el("div", { class: "fs-body pdv-body" }, ...(Array.isArray(body) ? body : [body])));
  } };
  PM.sheets.add(entry);
  entry.paint();
}

// A value that edits in place: tap -> field with 저장/취소; save() writes it, then the page shows the re-fetched value.
function pmEditable({ value, shown = value, placeholder = TX("project.edit.empty"), label, multiline, required, cls = "", save }) {
  const wrap = el("div", { class: "pmv-ed" });
  const show = () => clear(wrap).append(el("button", { type: "button", class: `pmv-edit ${cls}${shown ? "" : " empty"}`, title: TX("project.edit.hint"), "aria-label": TX("project.edit.aria", { label }), onclick: edit, text: shown || placeholder }));
  const edit = () => {
    PM.open++;
    const f = multiline ? el("textarea", { class: "fi pmv-ta", rows: 3, "aria-label": label }) : input({ "aria-label": label });
    f.value = value || "";
    const err = el("div", { class: "note err" });
    const close = () => { PM.open = Math.max(0, PM.open - 1); show(); };
    const ok = el("button", { class: "btn sm", type: "button", text: TX("common.save") });
    const commit = async () => {
      const v = f.value.trim();
      if (v === (value || "")) return close();
      if (required && !v) { err.textContent = TX("project.edit.required"); return; }
      ok.disabled = true; err.textContent = "";
      try { await save(v); } catch (e) { err.textContent = TX("project.save_failed", { error: e.message }); ok.disabled = false; return; }
      await pmReload();
    };
    ok.onclick = commit;
    f.addEventListener("keydown", ev => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Escape") { ev.stopPropagation(); close(); }
      else if (ev.key === "Enter" && (!multiline || ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commit(); }
    });
    clear(wrap).append(el("div", { class: "pmv-form" }, f, err, el("div", { class: "pmv-acts" }, el("button", { class: "btn text sm", type: "button", text: TX("common.cancel"), onclick: close }), ok)));
    f.focus();
  };
  show();
  return wrap;
}

// The prototype's project header card: name + state tag + last activity, the purpose under it.
function pmHead(q) {
  const chat = prjChat(q), can = !!chat && validTarget(chat), st = prjState(q), tone = st.tone === "att" ? "warn" : st.tone, at = prjLastAt(q);
  return el("div", { class: "pmv-head" },
    el("div", { class: "pmv-hmain" },
      el("div", { class: "pmv-htop" },
        pmEditable({ value: prjTitle(q), label: TX("project.name"), required: true, cls: "pmv-title", save: v => pmWrite({ title: v }) }),
        st.k === "idle" && at ? null : el("span", { class: `tag ${tone}`, text: st.word }),
        at ? el("span", { class: "pmv-upd", text: TX("project.last_chat", { ago: prjAgo(at) }) }) : null),
      pmEditable({ value: prjPurpose(q), shown: prjBlurb(prjPurpose(q)), label: TX("project.desc"), placeholder: TX("project.desc_ph"), multiline: true, cls: "pmv-purpose", save: v => pmWrite({ purpose: v }) })),
    // No work channel, nothing to chat with: the button is left out instead of showing a dead one.
    chat ? el("div", { class: "pmv-hact" }, el("div", { class: "pmv-hrow" },
      can ? el("button", { class: "btn tonal", type: "button", title: TX("project.chat_title"), onclick: () => openTarget(chat, lastChatView()), text: TX("project.chat") }) : null,
      pmMenuButton(q))) : null);
}
// The project a chat target (ch:<id>) belongs to, from the list the 프로젝트 tab shows (null until it has loaded or once it is gone).
const pmOfTarget = t => ((PRJ && PRJ.projects) || []).find(x => !x.builtin && prjChat(x) === t) || null;

// 프로젝트 삭제 (hub/projectdelete.ts): the ⋯ menu opens a sheet that lists what goes; 삭제 sends DELETE /api/projects/<ch:id>,
// or POST /api/peer/act {action:"project"} for a project of another computer (q.pc = {name, url}).
// The ⋯ menu (수정 / 삭제) is shared: the project page and a project's chat header (31-conversations.js) both build it here. `q` is a project or a
// function that returns it; 수정 opens that project's page in the 프로젝트 tab (on the page itself it starts editing the name).
function pmMenuButton(q, cls = "pmv-more") {
  const b = el("button", { class: `ib ${cls}`, type: "button", "aria-label": TX("project.menu"), title: TX("project.menu"), "aria-haspopup": "listbox", "aria-expanded": "false" }, icon("more"));
  b.addEventListener("click", () => {
    const p = typeof q === "function" ? q() : q;
    if (!p) return toast(TX("project.not_found"));
    showMenu(b, [{ value: "edit", label: TX("project.edit.title") }, { value: "delete", label: TX("project.del.title"), danger: true }], { onPick: v => {
      if (v === "delete") return pmDeleteAsk(p);
      if (current === "project" && PM.key === p.key) { const t = $("#v-project .pmv-title"); if (t) t.click(); } else go("project", p.key);
    } });
  });
  return b;
}
function pmDeleteCall(q, op, args = {}) {
  const key = prjChat(q);
  if (q.pc) return api(pqProxy(q.pc, "/api/peer/act"), "POST", { action: "project", args: { op, key, ...args } });
  return op === "delete-plan" ? api(`/api/projects/${enc(key)}/delete-plan`) : api(`/api/projects/${enc(key)}`, "DELETE", args);
}
const pmDeleteLines = p => [
  TX("project.del.channel", { name: p.name }),
  p.monitors.length ? TX("project.del.monitors", { n: p.monitors.length, list: p.monitors.join(", ") }) : "",
  p.logins.length ? TX("project.del.logins", { n: p.logins.length, list: p.logins.map(l => l.name).join(", ") }) : "",
  p.standing ? TX("project.del.standing", { what: p.standing }) : "",
  TX("project.del.notices", { n: p.notices }),
  TX("project.del.messages", { n: p.messages })].filter(Boolean);
async function pmDeleteAsk(q) {
  const fromChat = current === "chat";   // deleted from a project's chat header: land on the main chat, not the 프로젝트 list
  let p;
  try { p = await pmDeleteCall(q, "delete-plan"); } catch (e) { return toast(e.message || TX("project.del.plan_failed"), true); }
  const st = { drop: false, busy: false }, err = el("div", { class: "note err" });
  const h = fsOpen({ labelledby: "pmd-t" });
  // The app's own switch row (as 설정), not a browser checkbox: the whole row is the tap target.
  const sw = el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": "false", "aria-label": TX("project.del.drop_aria"), "data-k": "drop-archive" });
  const drop = el("div", { class: "li tap", onclick: () => { st.drop = !st.drop; sw.setAttribute("aria-checked", String(st.drop)); } }, el("span", { class: "tx" }, el("div", { class: "hd", text: TX("project.del.drop") })), liEnd(sw));
  const go1 = el("button", { class: "btn danger fill", type: "button", "data-k": "delete", disabled: p.running.length > 0, onclick: async () => {
    if (st.busy) return;
    st.busy = true; go1.disabled = true; err.textContent = "";
    try {
      const r = await pmDeleteCall(q, "delete", { archive: !st.drop });
      h.close(false);
      toast(r && r.discord && !r.discord.ok ? TX("project.del.partial", { error: r.discord.error }) : TX("project.del.done", { name: (r && r.name) || p.name }), !!(r && r.discord && !r.discord.ok));
      PM = pmReset();
      if (fromChat) pickTarget(MAIN); else go("projects");
      prjLoad();
    } catch (e) { err.textContent = e.message || TX("project.del.failed"); st.busy = false; go1.disabled = false; }
  } }, TX("common.delete"));
  clear(h.box).append(
    fsHead([el("h2", { class: "fs-t", id: "pmd-t", text: TX("project.del.ask", { name: p.name }) })], { close: () => h.close() }),
    el("div", { class: "fs-body pmd" },
      p.running.length ? el("div", { class: "note err", text: TX("project.del.running", { list: p.running.join(", ") }) }) : null,
      el("ul", { class: "as-rml" }, ...pmDeleteLines(p).map(t => el("li", { text: t }))),
      el("div", { class: "list" }, drop)),
    el("div", { class: "fs-ft row pmd-ft" }, err, el("button", { class: "btn text", type: "button", onclick: () => h.close() }, TX("common.cancel")), go1));
}

// 세션 기록 page: what runs now, then the ended sessions and finished background work, newest first.
function pmSessions(D, rows) {
  const live = rows.filter(r => r.live), past = rows.filter(r => !r.live), work = (D && D.work) || [];
  return el("div", { class: "pdv-stack" },
    el("div", { class: "sec", text: TX("home.sys.running") }), pmDoing(live, work.filter(w => w.status === "running")),
    el("div", { class: "sec", text: TX("project.recent") }), pmRecent(past, work.filter(w => w.status !== "running")));
}

const PM_KIND = { monitor: TX("common.monitoring"), routine: TX("common.routine"), schedule: TX("common.schedule") };
const pmEvery = n => !(n > 0) ? "" : n % 60 === 0 ? TX("project.rt.every_h", { n: n / 60 }) : TX("project.rt.every_m", { n });
// Health dot: ok after a clean run, err after a failed one (failure is red, owner 2026-10-28); a paused item has none.
function pmHealth(x) {
  if (x.paused) return ["", ""];
  const n = x.fails || 0;
  if (x.lastOk === false) return n >= 3 ? ["err", TX("project.rt.failing", { n })] : ["err", TX("project.rt.last_failed")];
  if (n > 0) return ["err", TX("project.rt.failed_n", { n })];
  return [x.lastRun ? "ok" : "", ""];
}
// The recurring work of a project, monitors first: scripts the gateway runs, then routines and one-off schedules that wake the model.
function pmRoutineItems(D) {
  if (!D) return [];
  const L = D.linked || {};
  return [...(D.monitors || L.watches || []).map(x => ({ ...x, kind: "monitor" })), ...(D.routines || L.routines || []).map(x => ({ ...x, kind: "routine" })), ...(D.schedules || L.schedules || []).map(x => ({ ...x, kind: "schedule" }))];
}
function pmRoutines(D) {
  if (!D) return emptyNode(PM.fail ? TX("common.load_failed") : TX("common.loading"));
  const items = pmRoutineItems(D);
  return items.length ? el("div", { class: "list" }, ...items.map(pmRoutine)) : emptyNode(TX("project.rt.empty"));
}
// A schedule's text starts with its internal target (ch:<id>, lane:<name>) for the orchestrator; the owner reads the words.
const pmRoutineName = x => x.name || String(x.text || "").replace(/^\s*(?:(?:ch|lane|th):\S+\s*)+/, "") || x.id;
function pmRoutine(x) {
  const mins = x.every_minutes ?? (x.schedule && x.schedule.every_minutes) ?? 0;
  const once = !mins && (x.at || (x.schedule && x.schedule.at));
  const next = x.nextAt || (x.kind === "schedule" ? x.at : "") || (x.schedule && x.schedule.at) || "";
  const [tone, why] = pmHealth(x);
  const url = x.kind === "monitor" ? `/api/watches/${enc(x.id)}` : x.kind === "schedule" ? `/api/schedules/${enc(x.id)}` : "";
  const name = pmRoutineName(x);
  const note = el("div", { class: "note" }), box = el("div", { class: "pmv-rt" });
  const meta = [PM_KIND[x.kind], mins ? pmEvery(mins) : once ? TX("project.rt.once") : "", x.kind === "monitor" ? (x.on === "match" ? TX("project.rt.on_match") : TX("project.rt.on_check")) : "", x.lastRun ? TX("project.rt.last", { at: kstStamp(x.lastRun) }) : x.kind === "monitor" ? TX("project.rt.never") : "", !x.paused && next ? TX("project.rt.next", { at: kstStamp(next) }) : ""].filter(Boolean);
  const patch = body => pmDo(note, () => api(url, "PATCH", body));
  const view = () => {
    PM.open = Math.max(0, PM.open - (box.dataset.editing ? 1 : 0)); delete box.dataset.editing;
    const acts = el("div", { class: "pmv-rt-acts" });
    if (url) {
      const pause = el("button", { class: "btn tonal inrow", type: "button", text: x.paused ? TX("project.rt.resume") : TX("project.rt.pause"), onclick: () => { pause.disabled = true; patch({ paused: !x.paused }).then(ok => { if (!ok) pause.disabled = false; }); } });
      acts.append(mins || (x.kind === "monitor" && x.on === "match") ? el("button", { class: "btn text inrow", type: "button", text: TX("project.edit.go"), onclick: form }) : "",
        x.script ? el("button", { class: "btn text inrow", type: "button", text: TX("project.rt.script"), onclick: scriptEdit }) : "", pause);
    } else if (x.kind === "routine") {
      const run = el("button", { class: "btn tonal inrow", type: "button", text: TX("project.rt.run_now"), onclick: () => { run.disabled = true; pmDo(note, () => api("/api/custom/routine", "POST", { id: x.id })).then(() => { run.disabled = false; }); } });
      acts.append(run);
    }
    clear(box).append(
      el("div", { class: "pmv-rt-top" }, el("span", { class: `dot ${tone}`, role: "img", "aria-label": why || (tone === "ok" ? TX("project.rt.ok") : TX("project.rt.no_state")), title: why || (tone === "ok" ? TX("project.rt.ok") : "") }),
        el("span", { class: "pmv-rt-name", text: name }),
        // How it runs (owner 2026-10-21: recurring work runs as scripts first): a monitor is a script the gateway runs with no
        // tokens, a routine or schedule wakes the model.
        el("span", { class: "tag", title: x.kind === "monitor" ? TX("project.rt.script_title") : TX("project.rt.model_title"), text: x.kind === "monitor" ? TX("project.rt.script") : TX("common.model") }),
        x.paused ? el("span", { class: "tag", text: TX("project.paused") }) : null, why && tone ? el("span", { class: `tag ${tone}`, text: why }) : null),
      el("div", { class: "pmv-rt-meta" }, ...meta.map(t => el("span", { text: t }))),
      ...(x.pattern ? [el("div", { class: "pmv-rt-meta" }, el("span", { text: TX("project.rt.pattern_line", { pattern: x.pattern }) }))] : []), acts, note);
  };
  // A script monitor's file (GET/PUT /api/watches/<id>/script): read, edit and save it in place; the next run uses it.
  const scriptEdit = async () => {
    PM.open++; box.dataset.editing = "1";
    const ta = el("textarea", { class: "fi pmv-ta pmv-code", rows: 12, spellcheck: "false", "aria-label": TX("project.rt.script_named", { name }) });
    const err = el("div", { class: "note err" }), ok = el("button", { class: "btn sm", type: "button", text: TX("common.save"), disabled: true });
    clear(box).append(el("div", { class: "pmv-rt-top" }, el("span", { class: "pmv-rt-name", text: name })), el("div", { class: "pmv-rt-meta" }, el("span", { text: x.script })), ta, err,
      el("div", { class: "pmv-acts" }, el("button", { class: "btn text sm", type: "button", text: TX("common.cancel"), onclick: view }), ok));
    try { ta.value = (await api(`/api/watches/${enc(x.id)}/script`)).text; ok.disabled = false; ta.focus(); }
    catch (e) { err.textContent = TX("project.rt.script_failed", { error: e.message }); }
    ok.onclick = async () => {
      ok.disabled = true; err.textContent = "";
      try { await api(`/api/watches/${enc(x.id)}/script`, "PUT", { text: ta.value }); } catch (e) { err.textContent = TX("project.save_failed", { error: e.message }); ok.disabled = false; return; }
      await pmReload();
    };
  };
  const form = () => {
    PM.open++; box.dataset.editing = "1";
    const hrs = mins > 0 && mins % 60 === 0, mul = hrs ? 60 : 1;   // the form counts in the unit the card says (매 12시간 -> 12 시간마다)
    const iv = mins ? input({ type: "number", min: "1", step: "1", inputmode: "numeric", value: String(mins / mul), "aria-label": hrs ? TX("project.rt.gap_h") : TX("project.rt.gap_m") }) : null;
    const pt = x.kind === "monitor" && x.on === "match" ? input({ value: x.pattern || "", placeholder: TX("project.rt.pattern"), "aria-label": TX("project.rt.pattern") }) : null;
    const err = el("div", { class: "note err" }), ok = el("button", { class: "btn sm", type: "button", text: TX("common.save") });
    ok.onclick = async () => {
      const body = {};
      if (iv) { const r = Number(iv.value), n = r * mul; if (!Number.isInteger(r) || r < 1) { err.textContent = hrs ? TX("project.rt.gap_bad_h") : TX("project.rt.gap_bad_m"); return; } if (n !== mins) body.every_minutes = n; }
      if (pt && pt.value.trim() !== (x.pattern || "")) body.pattern = pt.value.trim();
      if (!Object.keys(body).length) return view();
      ok.disabled = true; err.textContent = "";
      try { await api(url, "PATCH", body); } catch (e) { err.textContent = TX("project.save_failed", { error: e.message }); ok.disabled = false; return; }
      await pmReload();
    };
    const field = (label, node, unit) => [el("span", { class: "sup", text: label }), el("span", { class: "pmv-fld" }, node, unit ? el("span", { class: "sup", text: unit }) : null)];
    clear(box).append(el("div", { class: "pmv-rt-top" }, el("span", { class: "pmv-rt-name", text: name })),
      el("div", { class: "pmv-rt-form" }, ...(iv ? field(TX("project.rt.gap"), iv, hrs ? TX("project.rt.per_h") : TX("project.rt.per_m")) : []), ...(pt ? field(TX("project.rt.pattern"), pt) : [])),
      err, el("div", { class: "pmv-acts" }, el("button", { class: "btn text sm", type: "button", text: TX("common.cancel"), onclick: view }), ok));
    (iv || pt).focus();
  };
  view();
  return box;
}

// The same session row as home (sessionRow, 18-lanes.js).
const pmSessionRow = (r, open) => sessionRow({ name: r.name, title: r.title, status: r.status, live: r.live, pendingAsk: r.waiting }, { project: r.project, line: r.line, ...(typeof open === "function" ? { open } : {}) });
// The prototype's session row (s-work.js project 세션): a state dot, the title, the lane name, and the state tag at the right.
function pmLaneRow(r) {
  const [word, tone] = pmLaneState(r), sub = (r.waiting && r.ask) || r.line;   // what it does now, not its internal name
  return el("button", { class: "li tap", type: "button", onclick: () => openTarget(`lane:${r.name}`, lastChatView()), "aria-label": [r.title, word, TX("project.open_chat")].join(" · ") },
    el("span", { class: "lead" }, el("span", { class: `dot ${tone}` })),
    el("span", { class: "tx" }, el("div", { class: "hd", text: r.title }), sub ? el("div", { class: "sup", text: sub }) : null),
    el("span", { class: "li-end" }, el("span", { class: `tag ${tone}`, text: word })));
}
// A background job of the main assistant that belongs to the project (asked in its chat, or briefed for its folder): tap lands on its result, or on the asking message while it runs.
const pmWorkRow = w => {
  const run = w.status === "running" && !w.queued, stall = w.status === "stalled", rec = workRecovering(w);
  const word = w.queued ? TX("home.todo.queued") : run ? TX("home.sys.running") : stall ? TX("common.status.stopped") : w.status === "done" ? TX("home.sys.done") : w.cancelled ? TX("home.sys.stopped") : rec ? TX("project.work.resuming") : TX("home.sys.failed");
  const tag = workTone(w), ok = run || w.status === "done";
  // Same as home's workRow: the dot says the state, the quiet line what or why, the right end a time; a stopped or failed one keeps its word.
  const sub = w.queued ? TX("project.work.queued_sub") : ok ? w.model || "" : stall ? `${w.reason || TX("home.wk.no_activity")} · ${workAgo(w)}` : `${workFailText(w)} · ${workAgo(w)}`;
  return withResults(el("button", { class: "li tap", type: "button", onclick: () => workGo(w), "aria-label": `${friendlyLine(w.description)} · ${word}` },
    el("span", { class: "lead" }, el("span", { class: `dot ${tag}` })),
    el("span", { class: "tx" }, el("div", { class: "hd", text: friendlyLine(w.description) }), sub ? el("div", { class: "sup", text: sub }) : null),
    el("span", { class: "li-end" }, ok && !w.queued ? el("span", { class: "sup", text: run ? workElapsed(w) : workAgo(w) }) : el("span", { class: `tag ${tag}`, text: word }))), w.status === "done" ? resultChips(w) : null);
};
// 진행 중: sessions that are alive and background jobs that are running. 최근 세션: the ended ones, newest first.
function pmDoing(live, running) {
  if (!live.length && !running.length) return emptyNode(TX("home.card.nothing_running"));
  return el("div", { class: "list srows" }, ...live.map(pmSessionRow), ...running.map(pmWorkRow));
}
function pmRecent(past, done) {
  const items = [...past.map(r => ({ at: r.at, node: withResults(pmSessionRow(r, () => laneResultGo(r.name, r.at ? new Date(r.at).toISOString() : "")), resultChips(laneResult(`lane:${r.name}`))) })), ...done.map(w => ({ at: w.ended_at || w.started_at, node: pmWorkRow(w) }))].sort((a, b) => b.at - a.at).slice(0, 10);
  return items.length ? el("div", { class: "list" }, ...items.map(x => x.node)) : emptyNode(TX("project.recent_empty"));
}

const PM_RES = { report: TX("project.res.report"), verify: TX("project.res.verify"), commit: TX("home.chip.commit"), note: TX("common.conversation") };
const pmDay = at => { const d = kstDay(at), n = Date.now(); return d === kstDay(n) ? TX("home.today") : d === kstDay(n - 864e5) ? TX("project.yesterday") : d; };
const pmLaneTitle = n => (((S && S.lanes) || []).find(l => l.name === n) || {}).title || n;
// The prototype's result row (s-work.js project 결과): the title, the kind · hash · session · time line, and its state tag.
function pmResultRow(r) {
  const tap = r.kind === "report" && r.lane;
  const tag = r.kind === "report" ? (r.tone === "fail" ? ["err", TX("project.res.failed")] : r.verified ? ["ok", TX("home.lane.verified")] : ["", TX("project.res.unverified")]) : r.kind === "verify" ? (r.ok ? ["ok", TX("project.res.passed")] : ["err", TX("project.res.failed")]) : ["", TX("home.chip.commit")];
  return withResults(el(tap ? "button" : "div", { class: `li${tap ? " tap" : ""}`, type: tap ? "button" : null, onclick: tap ? () => laneResultGo(r.lane, r.at) : null },
    el("span", { class: "tx" }, el("div", { class: `hd${r.kind === "note" ? " pmv-clamp pmv-wrap" : ""}`, title: r.title || null, text: r.title || PM_RES[r.kind] || TX("project.result") }),
      el("div", { class: "sup", text: [PM_RES[r.kind] || r.kind, r.kind === "commit" ? r.hash : "", r.lane ? pmLaneTitle(r.lane) : "", kstHM(r.at)].filter(Boolean).join(" · ") })),
    tag ? el("span", { class: `tag ${tag[0]}`, text: tag[1] }) : null), r.kind === "report" && r.tone === "done" ? resultChips(pmOwnResult(r)) : null);
}
// A lane keeps one result notice, its last report's: an older report of the same lane is not given the newer one's chips.
function pmOwnResult(r) {
  const n = laneResult(`lane:${r.lane}`);
  return n && Math.abs(ntAt(n) - Date.parse(r.at)) < 10 * 60e3 ? n : null;
}
function pmResults(D) {
  if (!D || !D.results) return emptyNode(PM.fail ? TX("common.load_failed") : TX("common.loading"));
  if (!D.results.length) return emptyNode(TX("project.res.empty"));
  const groups = [];
  for (const r of D.results) {
    const day = pmDay(r.at);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, rows: [] });
    groups[groups.length - 1].rows.push(r);
  }
  return el("div", {}, ...groups.flatMap(g => [el("div", { class: "pmv-day", text: g.day }), el("div", { class: "list" }, ...g.rows.map(pmResultRow))]));
}
// The built-in 커스텀 project (hub/custom.ts builtinDetail): what the owner has customized, each item with a plain line and a
// way to ask for a change. Asking opens the main chat with a draft tagged [프로젝트 커스텀 ...]; the orchestrator keeps those
// personal (MODE.md, Customization). No edit-in-place, no project chat: there is no channel behind it.
const CM_TAG = "[프로젝트 커스텀 · 개인 설정]";
function cmAsk(text) {
  openTarget(MAIN, lastChatView());
  ta.value = text; autosize(); saveDraft(); updateHints(); ta.focus();
}
const cmText = i => el("span", { class: "tx" }, el("div", { class: "hd", title: i.title, text: i.title }), i.line ? el("div", { class: "sup", text: i.line }) : null);
// 내 규칙: the newest few here, every rule behind the list's 더 보기 (hub/custom.ts newestRules sets the order). A row is one short title; a tap
// opens the same chat draft as the other groups' 수정, carrying the rule's full text, and hover shows that text too.
const CM_RULES_SHOWN = 5;
let cmRuleQ = "";
const cmRuleRow = i => el("button", { class: "li tap", type: "button", title: i.full, "aria-label": TX("project.edit.named", { name: i.title }),
  onclick: () => { pmSheetsClose(); cmAsk(`${CM_TAG} ${TX("project.page.rules")} "${i.full || i.title}": `); } }, el("span", { class: "tx" }, el("div", { class: "hd", text: i.title })));
const cmRulesCard = g => [el("div", { class: "list" }, ...g.items.slice(0, CM_RULES_SHOWN).map(cmRuleRow),
  g.items.length > CM_RULES_SHOWN ? moreRow(TX("project.rules.more_n", { n: g.items.length - CM_RULES_SHOWN }), () => { cmRuleQ = ""; pmSheet("rules"); }) : null)];
function cmRulesBody() {
  const items = ((PM.D && PM.D.groups) || []).find(g => g.id === "rules")?.items || [], found = el("div");
  const fill = () => {
    const q = cmRuleQ.trim().toLowerCase(), hit = items.filter(i => `${i.title} ${i.full}`.toLowerCase().includes(q));
    clear(found).append(hit.length ? el("div", { class: "list" }, ...hit.map(cmRuleRow)) : emptyNode(TX("project.rules.none")));
  };
  fill();
  return [el("label", { class: "pl-search cm-rule-q" }, icon("search"),
    el("input", { id: "cm-q", type: "search", placeholder: TX("project.rules.search"), "aria-label": TX("project.rules.search"), autocomplete: "off", value: cmRuleQ, oninput: ev => { cmRuleQ = ev.target.value; fill(); } })), found];
}
function cmPaint(root, p, D) {
  const sig = JSON.stringify([p, D]);
  if (root.dataset.sig === sig) return;
  root.dataset.sig = sig;
  $("#title").textContent = TX("common.projects");
  const ask = (label, text) => el("button", { class: "btn tonal inrow", type: "button", "aria-label": TX("project.edit.named", { name: label }), onclick: () => cmAsk(text), text: TX("project.edit.go") });
  const group = g => el("section", { class: "pmv-sec" },
    el("div", { class: "sec sec-act" }, el("span", { text: g.label }), el("button", { class: "btn text sm", type: "button", onclick: () => cmAsk(`${CM_TAG} ${g.label}: `), text: TX("decision.add") })),
    ...(!g.items.length ? [emptyNode(g.empty)] : g.id === "rules" ? cmRulesCard(g)
    : [el("div", { class: "list" }, ...g.items.map(i => el("div", { class: "li" },
      cmText(i),
      i.bad ? el("span", { class: "tag warn", text: TX("home.attn.check") }) : null,
      el("span", { class: "li-end" }, ask(g.label, `${CM_TAG} ${g.label} "${i.title}": `)))))]));
  clear(root).append(
    el("div", { class: "pmv-head" }, el("div", { class: "pmv-hmain" },
      el("div", { class: "pmv-htop" }, el("div", { class: "pmv-title", text: p.name }), el("span", { class: "pmv-upd", text: TX("project.my_settings") })),
      el("div", { class: "pmv-purpose", text: p.note || "" }))),
    D && D.groups ? el("div", { class: "pmv-cols" }, el("div", { class: "pmv-col" }, ...D.groups.slice(0, 3).map(group)), el("div", { class: "pmv-col" }, ...D.groups.slice(3).map(group))) : emptyNode(PM.fail ? TX("common.load_failed") : TX("common.loading")));
}

setInterval(() => {
  if (document.hidden) return;
  if (current === "projects") prjLoad();
  else if (current === "project" && !PM.open) { pmLoad(); prjLoad(); }
}, 20000);

/* ---------- context ---------- */
let C = null, ctxTimer;
const ctxTone = pct => pct != null && pct >= 60 ? "warn" : "";   // context running out needs the owner: orange, never red (owner 2026-10-28)
function compactState(c) {
  if (!c || !c.state) return null;
  const t = c.at ? kstTime(c.at) : "";
  if (c.state === "queued") return { tone: "pri", text: TX("project.ctx.queued") };
  if (c.state === "compacting") return { tone: "pri", text: TX("project.ctx.compacting", { at: t }) };
  if (c.state === "done") return { tone: "ok", text: c.tokensBefore ? TX("project.ctx.done_from", { at: t, tokens: num(c.tokensBefore) }) : TX("project.ctx.done", { at: t }) };
  return { tone: "err", text: c.error ? TX("project.ctx.failed_why", { at: t, error: c.error }) : TX("project.ctx.failed", { at: t }) };
}
function ctxBar(p) {
  const pct = p.percent;
  return el("div", {},
    el("div", { class: `bar ${ctxTone(pct)}`, role: "progressbar", "aria-label": TX("project.ctx.of", { name: p.name }), "aria-valuenow": Math.round(pct || 0), "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${Math.min(100, pct || 0).toFixed(1)}%` })),
    el("div", { class: "kv", style: "margin-top:var(--sp-1)" }, el("span", { class: "v", text: p.window ? TX("project.ctx.tokens_of", { used: num(p.tokens), win: num(p.window) }) : TX("project.ctx.tokens", { tokens: num(p.tokens) }) }), el("span", { class: "v", text: pct != null ? `${pct}%` : "–" })));
}
// A quiet read asked while another is out shares it (the page's first read and refreshState ask at the same time).
let ctxFlight = null;
function loadContext(quiet) {
  if (quiet && ctxFlight) return ctxFlight;
  const p = ctxFlight = ctxFetch(quiet).finally(() => { if (ctxFlight === p) ctxFlight = null; });
  return p;
}
async function ctxFetch(quiet) {
  clearTimeout(ctxTimer);
  try { C = await api("/api/context"); }
  catch (e) { if (!quiet && current === "context") clear($("#context")).append(emptyNode(TX("project.ctx.load_failed"))); return; }
  if (current === "context") { renderContext(); ctxTimer = setTimeout(() => loadContext(true), 4000); }
  if (current === "home") renderHome();
}
// "<model>:<thinking>" selector -> readable "model · thinking".
function selLabel(sel) {
  const i = sel.lastIndexOf(":"), level = sel.slice(i + 1);
  return i > 0 && ((M && M.thinking_levels) || []).includes(level) ? `${modelName(sel.slice(0, i))} · ${thinkKo(level)}` : modelName(sel);
}
function renderContext() {
  const box = $("#context");
  if (!C) { clear(box).append(emptyNode(TX("common.loading"))); return; }
  const list = el("div", { class: "col" }), offList = el("div", { class: "list" });
  // Exited lanes leave this list at once, like the lanes board; the orchestrator always stays.
  // Then each conversation with its own session, by the same row; a parked one shows its last figure.
  const convRows = (C.conversations || []).map(x => ({ ...x, name: targetName(x.key) }));
  for (const p of [...C.processes.filter(x => x.kind !== "lane" || laneAlive(x)), ...convRows]) {
    const cs = compactState(p.compaction);
    const inFlight = p.compaction && (p.compaction.state === "queued" || p.compaction.state === "compacting");
    const btn = el("button", { class: "btn tonal sm", type: "button", disabled: !p.running || inFlight, onclick: ev => busy(ev.currentTarget, async () => {
      const r = await api("/api/compact", "POST", { target: p.key || p.name });
      toast(r.state === "queued" ? TX("project.ctx.later", { name: p.name }) : TX("project.ctx.started", { name: p.name }));
      loadContext(true);
    }) }, TX("common.compact"));
    // A waiting session whose process is off (it starts again on its next message) keeps 대기 like every other screen, and says why it has no numbers.
    const off = !p.running && (p.status === "idle" || !!p.key);
    const t = p.key || (p.kind === "lane" ? `lane:${p.name}` : MAIN), [word, tone] = runStatus(t, off ? "idle" : p.status, targetInfo(t).ask);
    // A session that is not running is one plain list row (its display name, 꺼짐 said once at the right); only a running one keeps a card.
    if (!p.running) {
      offList.append(el("div", { class: "li", "data-cx-off": "1" }, el("span", { class: "tx" }, el("div", { class: "hd", text: p.kind === "orchestrator" ? botName : targetName(t) }), cs ? el("div", { class: "sup", text: cs.text }) : null),
        liEnd(el("span", { class: "cx-state" }, el("span", { class: "dot", "aria-hidden": "true" }), TX("project.ctx.off")))));
      continue;
    }
    list.append(el("div", { class: "card" },
      el("div", { class: "heads" }, el("span", { class: `dot ${tone}` }), el("span", { class: "t", text: p.kind === "orchestrator" ? botName : p.name }), el("span", { class: "sp" }), word === statusKo("") ? null : el("span", { class: `tag ${tone}`, text: word })),   // a state nobody knows is left out, not named 알 수 없음
      p.model ? el("div", { class: "sup sub", text: selLabel(p.model) }) : null,
      p.running || (p.key && p.tokens > 0) ? el("div", { class: "mt8" }, ctxBar(p)) : null,
      p.running ? null : el("div", { class: "sup mt8", text: off ? TX("project.ctx.off_note") : TX("project.ctx.not_running") }),
      el("div", { class: "row mt12", style: "justify-content:space-between" }, cs ? el("span", { class: `tag ${cs.tone}`, text: cs.text }) : el("span"), btn)));
  }
  clear(box).append(list, ...(offList.firstChild ? [offList] : []), ...ctxModels());
}
/* Per-model context window and auto-compaction point (PUT /api/context/model, stored in config context.models). */
const ctxUser = n => n === "orchestrator" ? botName : n === "lanes" ? TX("project.ctx.new_default") : n;
// "300000", "300,000", "300k", "1.5m" -> tokens; "80%" -> that share of `window`. "" -> null (default). NaN when unreadable.
function ctxParse(v, window) {
  const s = String(v || "").replace(/[\s,_]/g, "").toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(%|k|m)?$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  if (m[2] === "%") return window ? Math.round(window * n / 100) : NaN;
  return Math.round(m[2] === "k" ? n * 1e3 : m[2] === "m" ? n * 1e6 : n);
}
function ctxModels() {
  const list = (C && C.models) || [];
  if (!list.length) return [];
  return [el("div", { class: "sec mt12", text: TX("project.ctx.per_model") }), el("div", { class: "col" }, ...list.map(m => {
    const win = m.window || m.window_default, at = m.compact_at || m.compact_at_default;
    const pct = win ? ` (${Math.round(at / win * 100)}%)` : "";
    return el("div", { class: "card ctx-model" },
      el("div", { class: "ch" }, el("h3", { text: modelName(m.model) }), el("button", { class: "btn text inrow", type: "button", onclick: () => ctxDialog(m) }, TX("common.settings"))),
      el("div", { class: "kv" }, el("span", { class: "k", text: TX("project.ctx.size") }), el("span", { class: "v", text: win ? [TX("project.ctx.tokens", { tokens: num(win) }), m.window ? TX("project.ctx.custom") : TX("project.ctx.default")].join(" · ") : TX("project.ctx.unknown") })),
      el("div", { class: "kv" }, el("span", { class: "k", text: TX("project.ctx.auto") }), el("span", { class: "v", text: [`${TX("project.ctx.tokens", { tokens: num(at) })}${pct}`, m.compact_at ? TX("project.ctx.custom") : TX("project.ctx.default")].join(" · ") })),
      el("div", { class: "sup", text: TX("project.ctx.used_by", { list: m.used_by.map(ctxUser).join(", ") }) }));
  }))];
}
function ctxDialog(m) {
  const L = C.limits || {};
  const win = input({ type: "text", inputmode: "numeric", value: m.window ? String(m.window) : "", placeholder: m.window_default ? TX("project.ctx.default_n", { n: num(m.window_default) }) : TX("project.ctx.default_ph") });
  const at = input({ type: "text", inputmode: "numeric", value: m.compact_at ? String(m.compact_at) : "", placeholder: m.compact_at_default ? TX("project.ctx.default_n", { n: num(m.compact_at_default) }) : TX("project.ctx.auto_ph") });
  const err = usErr();
  const save = (c, btn, body, msg) => usRun(btn, err, async () => {
    C = await api("/api/context/model", "PUT", { model: m.model, ...body });
    c(); toast(msg); renderContext();
  });
  const actions = [{ label: TX("common.cancel"), onclick: c => c() }];
  if (m.window || m.compact_at) actions.push({ label: TX("project.ctx.reset"), onclick: (c, btn) => save(c, btn, { window: null, compact_at: null }, TX("project.ctx.reset_done")) });
  actions.push({ label: TX("common.save"), kind: "pri", onclick: (c, btn) => {
    const w = ctxParse(win.value, null);
    const a = ctxParse(at.value, w || m.window_default);
    if (Number.isNaN(w)) { err.textContent = TX("project.ctx.bad_size"); return; }
    if (Number.isNaN(a)) { err.textContent = TX("project.ctx.bad_at"); return; }
    return save(c, btn, { window: w, compact_at: a }, TX("project.ctx.saved"));
  } });
  const d = dialog({
    classic: true,
    title: TX("project.ctx.of", { name: modelName(m.model) }),
    body: el("div", { class: "col" },
      el("p", { class: "sup", text: TX("project.ctx.applies", { list: m.used_by.map(ctxUser).join(", ") }) }),
      textField(TX("project.ctx.size_label"), win),
      el("p", { class: "sup", text: L.window ? TX("project.ctx.range", { min: num(L.window.min), max: num(L.window.max) }) : "" }),
      textField(TX("project.ctx.at_label"), at),
      el("p", { class: "sup", text: L.compact_at ? TX("project.ctx.at_hint_min", { min: num(L.compact_at.min) }) : TX("project.ctx.at_hint") }),
      el("p", { class: "sup", text: L.applies || "" }),
      err),
    actions,
  });
  usDirty(d, [win, at]);
  win.focus();
}
