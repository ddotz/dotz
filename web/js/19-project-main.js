/* ---------- 프로젝트 main: header, 목표와 진행, 루틴과 모니터링, 세션, 최근 결과 ---------- */
// PM.D = the detail; PM.open counts fields being edited (a refresh never repaints under them); PM.draft keeps the milestone input.
let PM = { key: "", D: null, fail: false, open: 0, flight: null, draft: "" };
function pmOpen(key) {
  if (PM.key !== key) PM = { key, D: null, fail: false, open: 0, flight: null, draft: "" };
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
  try { await fn(); } catch (e) { note.className = "note err"; note.textContent = `저장하지 못했어요 · ${e.message}`; return false; }
  await pmReload();
  return true;
}
function pmProject() {
  const found = ((PRJ && PRJ.projects) || []).find(x => x.key === PM.key || x.recordKey === PM.key);
  if (found) return found;
  const D = PM.D;
  return D ? { key: PM.key, name: (D.record && D.record.title) || PM.key, lanes: D.lanes || [], record: D.record } : null;
}
function pmSessionRows(p, D) {
  const dl = (D && D.lanes) || [], all = (S && S.lanes) || [], names = new Set([...dl.map(l => l.name), ...(p.lanes || []).map(l => l.name)]);
  const chat = prjChat(p);
  if (chat) for (const l of all) if (laneHome(l) === chat) names.add(l.name);
  // A project with its own chat lists the sessions assigned to it; a live session of the same folder started from chat belongs to no project.
  return [...names].filter(n => { const s = all.find(l => l.name === n); return !(chat && s && laneAlive(s) && !laneHome(s)); }).map(n => {
    const s = all.find(l => l.name === n), d = dl.find(l => l.name === n) || (p.lanes || []).find(l => l.name === n) || {};
    return { project: s && laneHome(s) ? laneProject(s) : prjTitle(p), at: Date.parse(d.finishedAt || d.lastReportAt || d.startedAt || (s && s.startedAt) || "") || 0, name: n, title: (s && s.title) || d.title || n, live: s ? laneAlive(s) : !!d.live, status: s ? s.status : d.status, waiting: s ? !!s.pendingAsk : !!d.waiting, line: friendlyLine(d.line || d.lastText || "").slice(0, 140) };
  }).sort((a, b) => (b.live - a.live) || (b.waiting - a.waiting) || a.title.localeCompare(b.title));
}
function pmPaint() {
  if (current !== "project" || PM.open > 0) return;
  const root = $("#v-project"), D = PM.D, p = pmProject();
  if (!p) { delete root.dataset.sig; clear(root).append(emptyNode(PM.fail || PRJ_FAIL ? "프로젝트를 불러오지 못했어요" : "불러오는 중…")); return; }
  if (p.builtin) { cmPaint(root, p, D); return; }
  const q = { ...p, record: (D && D.record) || p.record }, rows = pmSessionRows(p, D);
  const live = rows.filter(r => r.live), past = rows.filter(r => !r.live), work = (D && D.work) || [];
  const sig = JSON.stringify([q, D, rows, botName]);
  if (root.dataset.sig === sig) return;
  root.dataset.sig = sig;
  // The page header carries the (editable) name; the app bar says where you are, so the name is not shown twice.
  $("#title").textContent = "프로젝트";
  const old = $(".pmv-add input", root), focused = old && document.activeElement === old;
  if (old) PM.draft = old.value;
  const sec = (order, label, node) => el("section", { class: "pmv-sec", style: `order:${order}` }, el("div", { class: "sec", text: label }), node);
  clear(root).append(pmHead(q),
    el("div", { class: "pmv-cols" },
      el("div", { class: "pmv-col" }, sec(1, "목표와 진행", pmGoal(q, rows)), sec(2, "진행 중", pmDoing(live, work.filter(w => w.status === "running"))), sec(3, "최근 세션", pmRecent(past, work.filter(w => w.status !== "running")))),
      el("div", { class: "pmv-col" }, sec(4, "최근 결과", pmResults(D)), sec(5, "루틴과 모니터링", pmRoutines(D)))));
  const add = $(".pmv-add input", root);
  if (add && PM.draft) { add.value = PM.draft; add.dispatchEvent(new Event("input")); if (focused) add.focus(); }
}

// A value that edits in place: tap -> field with 저장/취소; save() writes it, then the page shows the re-fetched value.
function pmEditable({ value, placeholder = "비어 있어요", label, multiline, required, cls = "", save }) {
  const wrap = el("div", { class: "pmv-ed" });
  const show = () => clear(wrap).append(el("button", { type: "button", class: `pmv-edit ${cls}${value ? "" : " empty"}`, title: "눌러서 고쳐요", "aria-label": `${label} 고치기`, onclick: edit, text: value || placeholder }));
  const edit = () => {
    PM.open++;
    const f = multiline ? el("textarea", { class: "fi pmv-ta", rows: 3, "aria-label": label }) : input({ "aria-label": label });
    f.value = value || "";
    const err = el("div", { class: "note err" });
    const close = () => { PM.open = Math.max(0, PM.open - 1); show(); };
    const ok = el("button", { class: "btn", type: "button", text: "저장" });
    const commit = async () => {
      const v = f.value.trim();
      if (v === (value || "")) return close();
      if (required && !v) { err.textContent = "비워 둘 수 없어요"; return; }
      ok.disabled = true; err.textContent = "";
      try { await save(v); } catch (e) { err.textContent = `저장하지 못했어요 · ${e.message}`; ok.disabled = false; return; }
      await pmReload();
    };
    ok.onclick = commit;
    f.addEventListener("keydown", ev => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Escape") { ev.stopPropagation(); close(); }
      else if (ev.key === "Enter" && (!multiline || ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commit(); }
    });
    clear(wrap).append(el("div", { class: "pmv-form" }, f, err, el("div", { class: "pmv-acts" }, el("button", { class: "btn text", type: "button", text: "취소", onclick: close }), ok)));
    f.focus();
  };
  show();
  return wrap;
}

function pmHead(q) {
  const chat = prjChat(q), can = !!chat && validTarget(chat);
  return el("div", { class: "pmv-head" },
    el("div", { class: "pmv-hmain" },
      pmEditable({ value: prjTitle(q), label: "프로젝트 이름", required: true, cls: "pmv-title", save: v => pmWrite({ title: v }) }),
      pmEditable({ value: prjPurpose(q), label: "프로젝트 설명", placeholder: "무엇을 하는 프로젝트인지 적어 주세요", multiline: true, cls: "pmv-purpose", save: v => pmWrite({ purpose: v }) })),
    // No work channel, nothing to chat with: the button is left out instead of showing a dead one.
    chat ? el("div", { class: "pmv-hact" }, el("div", { class: "pmv-hrow" },
      can ? el("button", { class: "btn", type: "button", title: "이 프로젝트 전용 채팅을 열어요", onclick: () => openTarget(chat, lastChatView()), text: "프로젝트 채팅" }) : null,
      pmMenuButton(q))) : null);
}
// The project a chat target (ch:<id>) belongs to, from the list the 프로젝트 tab shows (null until it has loaded or once it is gone).
const pmOfTarget = t => ((PRJ && PRJ.projects) || []).find(x => !x.builtin && prjChat(x) === t) || null;

// 프로젝트 삭제 (hub/projectdelete.ts): the ⋯ menu opens a sheet that lists what goes; 삭제 sends DELETE /api/projects/<ch:id>,
// or POST /api/peer/act {action:"project"} for a project of another computer (q.pc = {name, url}).
// The ⋯ menu (수정 / 삭제) is shared: the project page and a project's chat header (31-conversations.js) both build it here. `q` is a project or a
// function that returns it; 수정 opens that project's page in the 프로젝트 tab (on the page itself it starts editing the name).
function pmMenuButton(q, cls = "pmv-more") {
  const b = el("button", { class: `ib ${cls}`, type: "button", "aria-label": "프로젝트 메뉴", title: "프로젝트 메뉴", "aria-haspopup": "listbox", "aria-expanded": "false" }, icon("more"));
  b.addEventListener("click", () => {
    const p = typeof q === "function" ? q() : q;
    if (!p) return toast("이 프로젝트를 찾을 수 없어요");
    showMenu(b, [{ value: "edit", label: "프로젝트 수정" }, { value: "delete", label: "프로젝트 삭제" }], { onPick: v => {
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
  `#${p.name} 채널을 Discord에서 지워요`,
  p.monitors.length ? `모니터링 ${p.monitors.length}개는 따로 남겨요: ${p.monitors.join(", ")}` : "",
  p.logins.length ? `로그인 유지 ${p.logins.length}개도 남겨요: ${p.logins.map(l => l.name).join(", ")}` : "",
  p.standing ? `자동 처리 설정을 지워요: ${p.standing}` : "",
  `알림 ${p.notices}개를 치워요`,
  `대화 ${p.messages}개는 보관 파일로 남겨요`].filter(Boolean);
async function pmDeleteAsk(q) {
  const fromChat = current === "chat";   // deleted from a project's chat header: land on the main chat, not the 프로젝트 list
  let p;
  try { p = await pmDeleteCall(q, "delete-plan"); } catch (e) { return toast(e.message || "지울 내용을 읽지 못했어요", true); }
  const st = { drop: false, busy: false }, err = el("div", { class: "note err" });
  const h = fsOpen({ labelledby: "pmd-t" });
  const cb = el("input", { type: "checkbox", "data-k": "drop-archive", onchange: () => { st.drop = cb.checked; } });
  const go1 = el("button", { class: "btn danger fill", type: "button", "data-k": "delete", disabled: p.running.length > 0, onclick: async () => {
    if (st.busy) return;
    st.busy = true; go1.disabled = true; err.textContent = "";
    try {
      const r = await pmDeleteCall(q, "delete", { archive: !st.drop });
      h.close(false);
      toast(r.discord && !r.discord.ok ? `프로젝트는 지웠지만 Discord 채널은 남아 있어요 · ${r.discord.error}` : `${r.name} 프로젝트를 지웠어요`, !!(r.discord && !r.discord.ok));
      PM = { key: "", D: null, fail: false, open: 0, flight: null, draft: "" };
      if (fromChat) pickTarget(MAIN); else go("projects");
      prjLoad();
    } catch (e) { err.textContent = e.message || "지우지 못했어요"; st.busy = false; go1.disabled = false; }
  } }, "삭제");
  clear(h.box).append(
    fsHead([el("h2", { class: "fs-t", id: "pmd-t", text: `${p.name} 프로젝트를 삭제할까요?` })], { close: () => h.close() }),
    el("div", { class: "fs-body pmd" },
      p.running.length ? el("div", { class: "note err", text: `실행 중인 세션이 있어서 지울 수 없어요: ${p.running.join(", ")}` }) : null,
      el("ul", { class: "as-rml" }, ...pmDeleteLines(p).map(t => el("li", { text: t }))),
      el("label", { class: "as-del" }, cb, el("span", { text: "보관 파일도 같이 지우기. 체크하지 않으면 남겨요" })),
      el("div", { class: "as-h", text: `보관 파일: ${p.archive}` }),
      err),
    el("div", { class: "fs-ft row" }, el("button", { class: "btn text", type: "button", onclick: () => h.close() }, "취소"), go1));
}

// At a glance, in plain words (owner 2026-10-21: the old '열린 할 일' list of internal open tasks was not readable): what runs
// now, what waits on the owner, and the next milestone. No ids, paths or English status words.
const pmNow = rows => rows.filter(r => r.live && r.status === "working"), pmWait = rows => rows.filter(r => r.waiting);
function pmGlance(ms, rows) {
    const now = pmNow(rows), wait = pmWait(rows), next = ms.find(m => !m.done);
  const line = (label, text, tone) => el("div", { class: "pmv-gl" }, el("span", { class: `dot ${tone}` }), el("span", { class: "pmv-gl-k", text: label }), el("span", { class: "pmv-gl-v", text }));
  return el("div", { class: "pmv-glance" },
    line("지금 하는 일", now.length ? now.map(r => r.title).join(", ") : "실행 중인 세션이 없어요", now.length ? "pri" : ""),
    line("기다리는 것", wait.length ? `${wait.map(r => r.title).join(", ")} · 답이 필요해요` : "없어요", wait.length ? "att" : ""),
    line("다음에 할 일", next ? next.text : ms.length ? "목표를 모두 끝냈어요" : "아직 정한 단계가 없어요", ""));
}
function pmGoal(q, sessions = []) {
  const ms = prjMiles(q), done = ms.filter(m => m.done).length, rec = q.record || {}, pct = ms.length ? Math.round(done / ms.length * 100) : 0;
  const note = el("div", { class: "note" });
  const put = milestones => pmDo(note, () => pmWrite({ milestones }));
  const once = (btn, p) => { btn.disabled = true; p.then(ok => { if (!ok) btn.disabled = false; }); };
  const rows = ms.map((m, i) => {
    const ck = el("button", { class: "pmv-ck", type: "button", role: "checkbox", "aria-checked": String(!!m.done), "aria-label": `${m.text} 완료 표시`, onclick: () => once(ck, put(ms.map((x, j) => j === i ? { ...x, done: !x.done } : x))) }, icon("check"));
    const del = el("button", { class: "ib", type: "button", "aria-label": `${m.text} 삭제`, title: "삭제", onclick: () => once(del, put(ms.filter((_, j) => j !== i))) }, icon("trash"));
    return el("div", { class: `pmv-ms${m.done ? " done" : ""}` }, ck,
      el("div", { class: "pmv-mtx" }, pmEditable({ value: m.text, label: "마일스톤", required: true, save: v => pmWrite({ milestones: ms.map((x, j) => j === i ? { ...x, text: v } : x) }) })), del);
  });
  const addBtn = el("button", { class: "btn tonal", type: "button", disabled: true, text: "추가" });
  const addIn = input({ placeholder: "마일스톤 추가", "aria-label": "마일스톤 추가", maxlength: "200", oninput: ev => { PM.draft = ev.target.value; addBtn.disabled = !ev.target.value.trim(); } });
  const doAdd = async () => {
    const t = addIn.value.trim(), keep = PM.draft;
    if (!t) return;
    addBtn.disabled = true; PM.draft = "";
    if (!await put([...ms, { text: t, done: false }])) { PM.draft = keep; addBtn.disabled = false; }
  };
  addBtn.onclick = doAdd;
  addIn.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); doAdd(); } });
  // Nothing yet (no goal, milestones or sessions): one empty line instead of three empty status rows.
  const bare = !rec.goal && !ms.length && !pmNow(sessions).length && !pmWait(sessions).length;
  return el("div", { class: "card pmv-goal" },
    bare ? null : pmGlance(ms, sessions),
    pmEditable({ value: rec.goal || "", label: "목표", placeholder: bare ? "아직 목표가 없어요 · 눌러서 적어 주세요" : "목표를 적어 주세요", multiline: true, save: v => pmWrite({ goal: v }) }),
    ms.length ? el("div", { class: "pmv-prog" }, el("span", { class: "pmv-big", text: `${done}/${ms.length}` }), el("div", { class: "bar", role: "progressbar", "aria-label": "마일스톤 진행", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${pct}%` }))) : null,
    ms.length ? el("div", { class: "pmv-mlist" }, ...rows) : null,
    el("div", { class: "pmv-add" }, addIn, addBtn), note);
}

const PM_KIND = { monitor: "모니터링", routine: "루틴", schedule: "예약" };
const pmEvery = n => !(n > 0) ? "" : n % 60 === 0 ? `매 ${n / 60}시간` : `매 ${n}분`;
// Health dot: ok after a clean run, warn after a failed one, err after three in a row; a paused item has none.
function pmHealth(x) {
  if (x.paused) return ["", ""];
  const n = x.fails || 0;
  if (x.lastOk === false) return n >= 3 ? ["err", `계속 실패 ${n}번`] : ["warn", "마지막 실행 실패"];
  if (n > 0) return ["warn", `실패 ${n}번`];
  return [x.lastRun ? "ok" : "", ""];
}
function pmRoutines(D) {
  if (!D) return emptyNode(PM.fail ? "불러오지 못했어요" : "불러오는 중…");
  const L = D.linked || {};
  const items = [...(D.monitors || L.watches || []).map(x => ({ ...x, kind: "monitor" })), ...(D.routines || L.routines || []).map(x => ({ ...x, kind: "routine" })), ...(D.schedules || L.schedules || []).map(x => ({ ...x, kind: "schedule" }))];
  return items.length ? el("div", { class: "list" }, ...items.map(pmRoutine)) : emptyNode("아직 루틴이나 모니터링이 없어요");
}
function pmRoutine(x) {
  const mins = x.every_minutes ?? (x.schedule && x.schedule.every_minutes) ?? 0;
  const once = !mins && (x.at || (x.schedule && x.schedule.at));
  const next = x.nextAt || (x.kind === "schedule" ? x.at : "") || (x.schedule && x.schedule.at) || "";
  const [tone, why] = pmHealth(x);
  const url = x.kind === "monitor" ? `/api/watches/${enc(x.id)}` : x.kind === "schedule" ? `/api/schedules/${enc(x.id)}` : "";
  // A schedule's text starts with its internal target (ch:<id>, lane:<name>) for the orchestrator; the owner reads the words.
  const name = x.name || String(x.text || "").replace(/^\s*(?:(?:ch|lane|th):\S+\s*)+/, "") || x.id;
  const note = el("div", { class: "note" }), box = el("div", { class: "pmv-rt" });
  const meta = [PM_KIND[x.kind], mins ? pmEvery(mins) : once ? "한 번" : "", x.script ? String(x.script).split("/").pop() : "", x.lastRun ? `마지막 ${kstStamp(x.lastRun)}` : x.kind === "monitor" ? "아직 안 돌았어요" : "", !x.paused && next ? `다음 ${kstStamp(next)}` : ""].filter(Boolean);
  const patch = body => pmDo(note, () => api(url, "PATCH", body));
  const view = () => {
    PM.open = Math.max(0, PM.open - (box.dataset.editing ? 1 : 0)); delete box.dataset.editing;
    const acts = el("div", { class: "pmv-rt-acts" });
    if (url) {
      const pause = el("button", { class: "btn tonal", type: "button", text: x.paused ? "다시 시작" : "일시정지", onclick: () => { pause.disabled = true; patch({ paused: !x.paused }).then(ok => { if (!ok) pause.disabled = false; }); } });
      acts.append(mins || (x.kind === "monitor" && x.on === "match") ? el("button", { class: "btn text", type: "button", text: "수정", onclick: form }) : "",
        x.script ? el("button", { class: "btn text", type: "button", text: "스크립트", onclick: scriptEdit }) : "", pause);
    } else if (x.kind === "routine") {
      const run = el("button", { class: "btn tonal", type: "button", text: "지금 실행", onclick: () => { run.disabled = true; pmDo(note, () => api("/api/custom/routine", "POST", { id: x.id })).then(() => { run.disabled = false; }); } });
      acts.append(run);
    }
    clear(box).append(
      el("div", { class: "pmv-rt-top" }, el("span", { class: `dot ${tone}`, role: "img", "aria-label": why || (tone === "ok" ? "정상" : "상태 없음"), title: why || (tone === "ok" ? "정상" : "") }),
        el("span", { class: "pmv-rt-name", text: name }),
        // How it runs (owner 2026-10-21: recurring work runs as scripts first): a monitor is a script the gateway runs with no
        // tokens, a routine or schedule wakes the model.
        el("span", { class: "tag", title: x.kind === "monitor" ? "게이트웨이가 직접 실행 · 토큰 없음" : "실행할 때마다 모델을 호출해요", text: x.kind === "monitor" ? "스크립트" : "모델" }),
        x.paused ? el("span", { class: "tag", text: "일시 정지" }) : null, why && tone ? el("span", { class: `tag ${tone}`, text: why }) : null),
      el("div", { class: "pmv-rt-meta" }, ...meta.map(t => el("span", { text: t }))),
      ...(x.pattern ? [el("div", { class: "pmv-rt-meta" }, el("span", { text: `패턴 · ${x.pattern}` }))] : []), acts, note);
  };
  // A script monitor's file (GET/PUT /api/watches/<id>/script): read, edit and save it in place; the next run uses it.
  const scriptEdit = async () => {
    PM.open++; box.dataset.editing = "1";
    const ta = el("textarea", { class: "fi pmv-ta pmv-code", rows: 12, spellcheck: "false", "aria-label": `${name} 스크립트` });
    const err = el("div", { class: "note err" }), ok = el("button", { class: "btn", type: "button", text: "저장", disabled: true });
    clear(box).append(el("div", { class: "pmv-rt-top" }, el("span", { class: "pmv-rt-name", text: name })), el("div", { class: "pmv-rt-meta" }, el("span", { text: x.script })), ta, err,
      el("div", { class: "pmv-acts" }, el("button", { class: "btn text", type: "button", text: "취소", onclick: view }), ok));
    try { ta.value = (await api(`/api/watches/${enc(x.id)}/script`)).text; ok.disabled = false; ta.focus(); }
    catch (e) { err.textContent = `스크립트를 읽지 못했어요 · ${e.message}`; }
    ok.onclick = async () => {
      ok.disabled = true; err.textContent = "";
      try { await api(`/api/watches/${enc(x.id)}/script`, "PUT", { text: ta.value }); } catch (e) { err.textContent = `저장하지 못했어요 · ${e.message}`; ok.disabled = false; return; }
      await pmReload();
    };
  };
  const form = () => {
    PM.open++; box.dataset.editing = "1";
    const iv = mins ? input({ type: "number", min: "1", step: "1", inputmode: "numeric", value: String(mins), "aria-label": "간격(분)" }) : null;
    const pt = x.kind === "monitor" && x.on === "match" ? input({ value: x.pattern || "", placeholder: "패턴", "aria-label": "패턴" }) : null;
    const err = el("div", { class: "note err" }), ok = el("button", { class: "btn", type: "button", text: "저장" });
    ok.onclick = async () => {
      const body = {};
      if (iv) { const n = Number(iv.value); if (!Number.isInteger(n) || n < 1) { err.textContent = "간격은 1분 이상의 정수로 적어 주세요"; return; } if (n !== mins) body.every_minutes = n; }
      if (pt && pt.value.trim() !== (x.pattern || "")) body.pattern = pt.value.trim();
      if (!Object.keys(body).length) return view();
      ok.disabled = true; err.textContent = "";
      try { await api(url, "PATCH", body); } catch (e) { err.textContent = `저장하지 못했어요 · ${e.message}`; ok.disabled = false; return; }
      await pmReload();
    };
    const field = (label, node, unit) => [el("span", { class: "sup", text: label }), el("span", { class: "pmv-fld" }, node, unit ? el("span", { class: "sup", text: unit }) : null)];
    clear(box).append(el("div", { class: "pmv-rt-top" }, el("span", { class: "pmv-rt-name", text: name })),
      el("div", { class: "pmv-rt-form" }, ...(iv ? field("간격", iv, "분마다") : []), ...(pt ? field("패턴", pt) : [])),
      err, el("div", { class: "pmv-acts" }, el("button", { class: "btn text", type: "button", text: "취소", onclick: view }), ok));
    (iv || pt).focus();
  };
  view();
  return box;
}

// The same session row as home (sessionRow, 18-lanes.js).
const pmSessionRow = r => sessionRow({ name: r.name, title: r.title, status: r.status, live: r.live, pendingAsk: r.waiting }, { project: r.project, line: r.line });
// A background job of the main assistant that belongs to the project (asked in its chat, or briefed for its folder): tap lands on the asking message.
const pmWorkRow = w => {
  const run = w.status === "running";
  return el("button", { class: "li tap", type: "button", onclick: () => workGo(w) },
    el("span", { class: `dot ${run ? "pri" : w.status === "done" ? "ok" : "err"}` }),
    el("span", { class: "tx" }, el("div", { class: "hd", text: w.description }), el("div", { class: "sup", text: run ? `작업 중 · ${workElapsed(w)}` : `${w.status === "done" ? "끝남" : "실패"} · ${workAgo(w)}` })),
    icon("chev", "lead"));
};
// 진행 중: sessions that are alive and background jobs that are running. 최근 세션: the ended ones, newest first.
function pmDoing(live, running) {
  if (!live.length && !running.length) return emptyNode("진행 중인 작업이 없어요");
  return el("div", { class: "list srows" }, ...live.map(pmSessionRow), ...running.map(pmWorkRow));
}
function pmRecent(past, done) {
  const items = [...past.map(r => ({ at: r.at, node: pmSessionRow(r) })), ...done.map(w => ({ at: w.ended_at || w.started_at, node: pmWorkRow(w) }))].sort((a, b) => b.at - a.at).slice(0, 10);
  return items.length ? el("div", { class: "list" }, ...items.map(x => x.node)) : emptyNode("아직 끝난 세션이 없어요");
}

const PM_RES = { report: "보고", verify: "확인", commit: "커밋" };
const pmDay = at => { const d = kstDay(at), n = Date.now(); return d === kstDay(n) ? "오늘" : d === kstDay(n - 864e5) ? "어제" : d; };
function pmResults(D) {
  if (!D || !D.results) return emptyNode(PM.fail ? "불러오지 못했어요" : "불러오는 중…");
  if (!D.results.length) return emptyNode("아직 결과가 없어요");
  const groups = [], titleOf = n => (((S && S.lanes) || []).find(l => l.name === n) || {}).title || n;
  for (const r of D.results) {
    const day = pmDay(r.at);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, rows: [] });
    groups[groups.length - 1].rows.push(r);
  }
  return el("div", {}, ...groups.flatMap(g => [el("div", { class: "pmv-day", text: g.day }), el("div", { class: "list" }, ...g.rows.map(r => {
    const tap = r.kind === "report" && r.lane;
    const tag = r.kind === "report" ? (r.tone === "fail" ? ["err", "안 됨"] : r.verified ? ["ok", "확인됨"] : ["", "보고만 함"]) : r.kind === "verify" ? (r.ok ? ["ok", "통과"] : ["err", "안 됨"]) : null;
    return el(tap ? "button" : "div", { class: `li${tap ? " tap" : ""}`, type: tap ? "button" : null, onclick: tap ? () => openTarget(`lane:${r.lane}`, lastChatView()) : null },
      el("span", { class: "tx" }, el("div", { class: "hd pmv-clamp", text: r.title || PM_RES[r.kind] || "결과" }),
        el("div", { class: "sup", text: [PM_RES[r.kind] || r.kind, r.kind === "commit" ? r.hash : "", r.lane ? titleOf(r.lane) : "", kstHM(r.at)].filter(Boolean).join(" · ") })),
      tag ? el("span", { class: `tag ${tag[0]}`, text: tag[1] }) : null);
  }))]));
}
// The built-in 커스텀 project (hub/custom.ts builtinDetail): what the owner has customized, each item with a plain line and a
// way to ask for a change. Asking opens the main chat with a draft tagged [프로젝트 커스텀 ...]; the orchestrator keeps those
// personal (MODE.md, Customization). No edit-in-place, no project chat: there is no channel behind it.
const CM_TAG = "[프로젝트 커스텀 · 개인 설정]";
function cmAsk(text) {
  openTarget(MAIN, lastChatView());
  ta.value = text; autosize(); saveDraft(); updateHints(); ta.focus();
}
// A row's text: the title, the plain line when there is one, and (rules) the full text behind a tap on the row.
function cmText(i) {
  const tx = el("span", { class: "tx" }, el("div", { class: "hd pmv-clamp", text: i.title }), i.line ? el("div", { class: "sup", text: i.line }) : null);
  if (!i.full) return tx;
  const full = el("div", { class: "sup", text: i.full, hidden: true });
  tx.append(full);
  tx.title = i.full; tx.style.cursor = "pointer";
  tx.setAttribute("role", "button"); tx.tabIndex = 0;
  const flip = () => { full.hidden = !full.hidden; tx.setAttribute("aria-expanded", String(!full.hidden)); };
  tx.addEventListener("click", flip);
  tx.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
  tx.setAttribute("aria-expanded", "false");
  return tx;
}
function cmPaint(root, p, D) {
  const sig = JSON.stringify([p, D]);
  if (root.dataset.sig === sig) return;
  root.dataset.sig = sig;
  $("#title").textContent = "프로젝트";
  const ask = (label, text) => el("button", { class: "btn tonal", type: "button", "aria-label": `${label} 수정`, onclick: () => cmAsk(text), text: "수정" });
  const group = g => el("section", { class: "pmv-sec" },
    el("div", { class: "pv-sh" }, el("div", { class: "sec", text: g.label }), el("button", { class: "btn text", type: "button", onclick: () => cmAsk(`${CM_TAG} ${g.label}: `), text: "추가" })),
    g.items.length ? el("div", { class: "list" }, ...g.items.map(i => el("div", { class: "li" },
      cmText(i),
      i.bad ? el("span", { class: "tag warn", text: "확인 필요" }) : null,
      ask(g.label, `${CM_TAG} ${g.label} "${i.title}": `))),
      g.more ? el("div", { class: "sup", style: "padding:10px 16px", text: `그 밖에 ${g.more}개가 더 있어요` }) : null) : emptyNode(g.empty));
  clear(root).append(
    el("div", { class: "pmv-head" }, el("div", { class: "pmv-hmain" }, el("div", { class: "pmv-title", text: p.name }), el("div", { class: "pmv-purpose", text: p.note || "" }))),
    D && D.groups ? el("div", { class: "pmv-cols" }, el("div", { class: "pmv-col" }, ...D.groups.slice(0, 3).map(group)), el("div", { class: "pmv-col" }, ...D.groups.slice(3).map(group))) : emptyNode(PM.fail ? "불러오지 못했어요" : "불러오는 중…"));
}

setInterval(() => {
  if (document.hidden) return;
  if (current === "projects") prjLoad();
  else if (current === "project" && !PM.open) { pmLoad(); prjLoad(); }
}, 20000);

/* ---------- context ---------- */
let C = null, ctxTimer;
const ctxTokens = name => ((C && C.processes) || []).find(p => p.name === name)?.tokens ?? 0;
const ctxTone = pct => pct == null ? "" : pct >= 80 ? "err" : pct >= 60 ? "warn" : "";
function compactState(c) {
  if (!c || !c.state) return null;
  const t = c.at ? kstTime(c.at) : "";
  if (c.state === "queued") return { tone: "warn", text: "압축 대기" };
  if (c.state === "compacting") return { tone: "pri", text: `압축 중 · ${t}` };
  if (c.state === "done") return { tone: "ok", text: `압축 완료 ${t}${c.tokensBefore ? ` · ${num(c.tokensBefore)} 토큰 전` : ""}` };
  return { tone: "err", text: `압축 실패 ${t}${c.error ? ` · ${c.error}` : ""}` };
}
function ctxBar(p) {
  const pct = p.percent;
  return el("div", {},
    el("div", { class: `bar ${ctxTone(pct)}`, role: "progressbar", "aria-label": `${p.name} 컨텍스트`, "aria-valuenow": Math.round(pct || 0), "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${Math.min(100, pct || 0).toFixed(1)}%` })),
    el("div", { class: "kv", style: "margin-top:4px" }, el("span", { class: "v", text: p.window ? `${num(p.tokens)} / ${num(p.window)} 토큰` : `${num(p.tokens)} 토큰` }), el("span", { class: "v", text: pct != null ? `${pct}%` : "–" })));
}
async function loadContext(quiet) {
  clearTimeout(ctxTimer);
  try { C = await api("/api/context"); }
  catch (e) { if (!quiet && current === "context") clear($("#context")).append(emptyNode("컨텍스트를 불러오지 못했어요")); return; }
  if (current === "context") { renderContext(); ctxTimer = setTimeout(() => loadContext(true), 4000); }
  if (current === "home") renderHome();
}
// "<model>:<thinking>" selector -> readable "model · thinking".
function selLabel(sel) {
  const i = sel.lastIndexOf(":"), level = sel.slice(i + 1);
  return i > 0 && ((M && M.thinking_levels) || []).includes(level) ? `${modelName(sel.slice(0, i))} · ${level}` : modelName(sel);
}
function renderContext() {
  const box = $("#context");
  if (!C) { clear(box).append(emptyNode("불러오는 중…")); return; }
  const list = el("div", { class: "col" });
  // Exited lanes leave this list at once, like the lanes board; the orchestrator always stays.
  for (const p of C.processes.filter(x => x.kind !== "lane" || laneAlive(x))) {
    const cs = compactState(p.compaction);
    const inFlight = p.compaction && (p.compaction.state === "queued" || p.compaction.state === "compacting");
    const btn = el("button", { class: "btn tonal", type: "button", disabled: !p.running || inFlight, onclick: ev => busy(ev.currentTarget, async () => {
      const r = await api("/api/compact", "POST", { target: p.name });
      toast(r.state === "queued" ? `${p.name}: 작업 중이라 끝나면 압축해요` : `${p.name}: 압축을 시작했어요`);
      loadContext(true);
    }) }, "압축");
    // A waiting session whose process is off (it starts again on its next message) keeps 대기 like every other screen, and says why it has no numbers.
    const off = !p.running && p.status === "idle";
    list.append(el("div", { class: "card" },
      el("div", { class: "heads" }, el("span", { class: `dot ${statusTone(p.status)}` }), el("span", { class: "t", text: p.kind === "lane" ? p.name : botName }), el("span", { class: "sp" }), el("span", { class: `tag ${statusTone(p.status)}`, text: statusKo(p.status) })),
      p.model ? el("div", { class: "sup sub", text: selLabel(p.model) }) : null,
      p.running ? el("div", { class: "mt8" }, ctxBar(p)) : el("div", { class: "sup mt8", text: off ? "꺼져 있어요. 다음 메시지가 오면 다시 시작해요" : "실행 중이 아니에요" }),
      el("div", { class: "row mt12", style: "justify-content:space-between" }, cs ? el("span", { class: `tag ${cs.tone}`, text: cs.text }) : el("span"), btn)));
  }
  clear(box).append(list);
}
