/* ---------- slash commands: Discord-style menu above the composer (hub/control.ts COMMANDS) ---------- */
// Each arg: n = placeholder, opts() = [value, label?] choices from live state, opt = may be left out, free = any text.
const SL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const slLanes = () => ((S && S.lanes) || []).filter(laneAlive).map(l => [l.name, `세션 · ${statusKo(l.status)}`]);
const slProcs = () => [["orchestrator", botName], ...slLanes()];
const slModelTargets = () => [["orchestrator", botName], ["lanes", "세션 기본값"], ["workers", "서브에이전트"], ...slLanes()];
// Current models only: no Haiku, no Fable, no dated snapshots; newest versions first.
const slModels = () => ((M && M.available) || []).filter(m => !/haiku|fable/i.test(`${m.selector} ${m.name || ""}`) && !/-\d{8}$/.test(m.selector)).sort((a, b) => b.selector.localeCompare(a.selector, "en", { numeric: true })).map(m => [m.selector, m.name || ""]);
const slProviders = () => ((P && P.providers) || []).map(p => [p.id, p.name || ""]);
const CMDS = [
  { c: "/status", d: "봇·세션·Discord 상태와 컨텍스트" },
  { c: "/context", d: "프로세스별 컨텍스트 사용량과 압축 상태" },
  { c: "/compact", d: "컨텍스트 압축 (작업 중이면 끝난 뒤)", args: [{ n: "대상", opts: slProcs }] },
  { c: "/lanes", d: "세션마다 상태·모델·폴더" },
  { c: "/model", d: "모델 보기, 또는 대상의 모델 바꾸기", args: [{ n: "대상", opts: slModelTargets, opt: true }, { n: "모델", opts: slModels, opt: true }, { n: "강도", opts: () => SL_LEVELS.map(v => [v]), opt: true }] },
  { c: "/effort", d: "추론 강도 바꾸기", args: [{ n: "대상", opts: slModelTargets }, { n: "강도", opts: () => SL_LEVELS.map(v => [v]) }] },
  { c: "/restart", d: "에이전트 재시작 · 게이트웨이는 전체 재시작", args: [{ n: "대상", opts: () => [["orchestrator", botName], ["gateway", "게이트웨이 전체 (한가할 때)"], ...slLanes()] }] },
  { c: "/stop", d: "세션 멈추기 (나중에 다시 시작할 수 있어요)", args: [{ n: "세션", opts: slLanes }] },
  { c: "/resume", d: "멈춘 세션 이어가기, 실행 중이면 메시지 보내기", args: [{ n: "세션", opts: slLanes }, { n: "글", free: true, opt: true }] },
  { c: "/abort", d: "지금 하는 일 취소 (비우면 봇)", args: [{ n: "대상", opts: slProcs, opt: true }] },
  { c: "/providers", d: "로그인·API 키·공급자별 모델" },
  { c: "/login", d: "공급자 로그인 (링크가 열려요)", args: [{ n: "공급자", opts: slProviders, opt: true }] },
  { c: "/logout", d: "공급자 로그아웃", args: [{ n: "공급자", opts: slProviders }] },
  { c: "/quota", d: "공급자·모델별 사용 한도" },
  { c: "/help", d: "명령 전체 설명" },
];
// The command palette lists the same commands.
const hintList = CMDS.map(x => [x.c, x.d]);
let SL = { items: [], idx: -1, hide: "" };
// Where the caret is in "/cmd a b c": which command, which args are done, and the partial token being typed.
function slParse(v) {
  const m = v.match(/^\/(\S*)(\s+([\s\S]*))?$/);
  if (!m) return null;
  if (m[2] === undefined) return { stage: "cmd", q: `/${m[1]}`.toLowerCase() };
  const cmd = CMDS.find(x => x.c === `/${m[1].toLowerCase()}`);
  if (!cmd) return null;
  const rest = m[3], toks = rest.split(/\s+/), done = toks.slice(0, -1).filter(Boolean), q = toks[toks.length - 1] || "";
  return { stage: "arg", cmd, done, q, i: done.length };
}
function updateHints() {
  const box = $("#hints"), v = ta.value, p = slParse(v);
  const off = () => { box.hidden = true; clear(box); SL.items = []; SL.idx = -1; };
  if (!p || v === SL.hide || document.activeElement !== ta) return off();
  SL.hide = "";
  let head, items = [], chips = null, idx = 0;
  if (p.stage === "cmd") {
    const pre = CMDS.filter(x => x.c.startsWith(p.q)), sub = CMDS.filter(x => !x.c.startsWith(p.q) && x.c.includes(p.q.slice(1)));
    items = [...pre, ...sub].map(x => ({ kind: "cmd", x, fill: `${x.c} ` }));
    head = el("div", { class: "sl-hd" }, el("span", { class: "logo" }), el("span", { class: "nm", text: botName }), el("span", { class: "tx", text: "명령" }));
  } else {
    const args = p.cmd.args || [], a = args[p.i];
    if (!a || a.free) return off();
    const q = p.q.toLowerCase(), base = `${p.cmd.c} ${p.done.length ? `${p.done.join(" ")} ` : ""}`;
    items = a.opts().filter(([val, lab]) => !q || val.toLowerCase().includes(q) || (lab || "").toLowerCase().includes(q)).sort((x, y) => (y[0].toLowerCase().startsWith(q) ? 1 : 0) - (x[0].toLowerCase().startsWith(q) ? 1 : 0)).slice(0, 40)
      .map(([val, lab]) => ({ kind: "arg", val, lab, fill: `${base}${val} ` }));
    if (!items.length) return off();
    // An optional arg is not preselected, so Enter still sends the command as typed.
    idx = a.opt && !q ? -1 : 0;
    chips = el("div", { class: "sl-args" }, el("span", { class: "sl-c", text: p.cmd.c }),
      ...args.map((x, i) => el("span", { class: `sl-a${i < p.i ? " done" : i === p.i ? " on" : ""}`, text: i < p.i ? p.done[i] : `${x.n}${x.opt ? "?" : ""}` })));
    head = el("div", { class: "sl-hd" }, el("span", { class: "tx", text: `${a.n}${a.opt ? " · 비워도 돼요" : ""}` }));
  }
  if (!items.length) return off();
  SL.items = items; SL.idx = idx;
  const list = el("div", { class: "sl-list", role: "listbox", id: "sl-list" }, ...items.map((it, i) => {
    const b = el("button", { type: "button", role: "option", class: "sl-i", id: `sl-${i}`, tabindex: "-1" },
      it.kind === "cmd"
        ? [el("span", { class: "c", text: it.x.c }), (it.x.args || []).length ? el("span", { class: "ar", text: it.x.args.map(x => x.opt ? `[${x.n}]` : `<${x.n}>`).join(" ") }) : null, el("span", { class: "d", text: it.x.d })]
        : [el("span", { class: "c", text: it.val }), it.lab ? el("span", { class: "d", text: it.lab }) : null]);
    // Taps and clicks must not take focus from the textarea (the phone keyboard stays up).
    b.addEventListener("pointerdown", ev => ev.preventDefault());
    b.addEventListener("click", () => slPick(i));
    b.addEventListener("mousemove", () => { if (SL.idx !== i) { SL.idx = i; slMark(); } });
    return b;
  }));
  clear(box).append(...[chips, head, list].filter(Boolean));
  box.hidden = false;
  const sr = $("#send");
  box.style.bottom = `${$("#composer").offsetHeight - sr.offsetTop + 8}px`;
  slMark();
}
function slMark() {
  const items = [...$("#hints").querySelectorAll(".sl-i")];
  items.forEach((n, i) => { n.classList.toggle("on", i === SL.idx); n.setAttribute("aria-selected", i === SL.idx ? "true" : "false"); });
  if (items[SL.idx]) items[SL.idx].scrollIntoView({ block: "nearest" });
  ta.setAttribute("aria-activedescendant", SL.idx >= 0 ? `sl-${SL.idx}` : "");
}
function slPick(i) {
  const it = SL.items[i];
  if (!it) return;
  ta.value = it.fill; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  autosize(); saveDraft(); updateHints();
}
const ta = $("#text");
ta.setAttribute("aria-controls", "sl-list");
// The box itself is measured (the same "auto" then scrollHeight as ever, so the default height and the 140px cap are the original ones), but the
// composer row is pinned to its current height for that instant: collapsing it used to shrink the composer, the timeline grew for a moment,
// the browser clamped its scrollTop and the view slid on every keystroke. Pinned, nothing around the box moves and no frame sees the dip.
const sendRow = $("#send");
// The height never goes below one full line of the box's own computed font plus its vertical padding (CSS min-height says the same; this keeps
// a JS-set px height from ever sitting under it, e.g. after the text scale changed). "normal" line-height resolves from the font size.
function taFloor() {
  const cs = getComputedStyle(ta);
  const fs = parseFloat(cs.fontSize) || 16;
  const lh = parseFloat(cs.lineHeight) || fs * 1.5;
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const border = cs.boxSizing === "border-box" ? (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) : 0;
  return Math.ceil(Math.max(lh + pad + border, parseFloat(cs.minHeight) || 0));
}
function autosize() {
  const keep = sendRow.offsetHeight;
  sendRow.style.height = `${keep}px`;
  ta.style.height = "auto";
  ta.style.height = `${Math.max(taFloor(), Math.min(ta.scrollHeight, 140))}px`;
  sendRow.style.height = "";
}
ta.addEventListener("input", () => { autosize(); saveDraft(); updateHints(); });
ta.addEventListener("focus", () => updateHints());
ta.addEventListener("blur", () => { const box = $("#hints"); box.hidden = true; });
// Registered before the send/stop key handler: while the menu is open, arrows move, Tab/Enter pick, Esc closes it.
ta.addEventListener("keydown", ev => {
  if ($("#hints").hidden || !SL.items.length || ev.isComposing || ev.keyCode === 229) return;
  const n = SL.items.length, stop = () => { ev.preventDefault(); ev.stopImmediatePropagation(); };
  if (ev.key === "ArrowDown") { stop(); SL.idx = (SL.idx + 1) % n; slMark(); }
  else if (ev.key === "ArrowUp") { stop(); SL.idx = SL.idx <= 0 ? n - 1 : SL.idx - 1; slMark(); }
  else if (ev.key === "Tab" && !ev.shiftKey) { stop(); slPick(Math.max(0, SL.idx)); }
  else if (ev.key === "Enter" && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey && SL.idx >= 0) { stop(); slPick(SL.idx); }
  else if (ev.key === "Escape") { stop(); SL.hide = ta.value; updateHints(); }
});
// While the target works: Enter steers into the running turn, ⌘/Ctrl+Enter queues it for the next turn, ⌥/Alt+Enter stops it and sends, Esc stops it.
ta.addEventListener("keydown", ev => {
  if (ev.key === "Escape" && isWorking(target) && !document.querySelector("dialog[open]") && !openMenu) { ev.preventDefault(); stopTarget(); return; }
  if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
  if (matchMedia("(pointer: coarse)").matches) return;
  ev.preventDefault();
  sendChat(ev.altKey ? "interrupt" : ev.metaKey || ev.ctrlKey ? "queue" : undefined);
});
// A tap on send must not take focus from the textarea: otherwise the phone keyboard closes on pointerdown, the composer re-lays out
// and the click never lands (owner 2026-10-21: the first tap only hid the keyboard). The click then submits once; sendChat clears the box,
// so a repeat is a no-op, and the box is refocused so the keyboard stays up like a messenger.
$("#send-btn").addEventListener("pointerdown", ev => ev.preventDefault());
$("#send").onsubmit = ev => { ev.preventDefault(); if ($("#send-btn").classList.contains("stop") && !ta.value.trim() && !ATT.length) stopTarget(); else sendChat(); if (!ta.disabled) ta.focus({ preventScroll: true }); };
$("#working-stop").onclick = () => stopTarget();
ta.addEventListener("input", () => { if (!$("#working").hidden) renderWorking(); });
async function stopTarget() {
  try {
    await api(isLaneT(target) ? `/api/lanes/${enc(laneOf(target))}/abort` : "/api/orchestrator/abort", "POST", {});
    toast("작업을 중단했어요");
    scheduleState();
  } catch (e) { toast(e.message, true); }
}
// A slash command (typed, or a card button) goes to the gateway for the current target; its answer joins the chat as a card.
async function sendCommand(text) {
  const t = target, lane = isLaneT(t) ? laneOf(t) : "";
  const mk = (kind, extra) => ({ ts: new Date().toISOString(), kind, source: "local", ...(lane ? { lane } : {}), ...extra });
  chatStick = true; termStick = true;
  ingestMsg(mk("_cmd", { text }));
  try {
    const r = await api("/api/command", "POST", { text });
    ingestMsg(mk("_cmdout", { text: String(r.output ?? "") || "✓", ...(r.card ? { card: r.card } : {}) }));
    if (/^\/(model|effort|compact|restart|resume|stop|abort)\b/i.test(text)) { refreshState(); loadModels(true); loadContext(true); }
  } catch (e) { ingestMsg(mk("_cmdout", { text: e.message, is_error: true, ...(e.data && e.data.card ? { card: e.data.card } : {}) })); }
}
async function sendChat(how) {
  const text = ta.value.trim();
  if (ATT.some(a => !a.file)) { toast("파일을 올리는 중이에요"); return; }
  const files = ATT.map(a => a.file);
  if ((!text && !files.length) || ta.disabled) return;
  if (files.length && text.startsWith("/")) { toast("명령에는 파일을 붙일 수 없어요", true); return; }
  const sentAtt = ATT; ATT = []; renderAtt();
  const t = target, lane = isLaneT(t) ? laneOf(t) : "";
  ta.value = ""; ts(t).draft = ""; try { localStorage.removeItem(DRAFT_KEY(t)); } catch {} autosize(); updateHints(); renderWorking();
  if (typeof asTplEnd === "function") asTplEnd();
  chatStick = true; termStick = true;
  if (text.startsWith("/")) { sendCommand(text); return; }
  const mode = how || (isWorking(t) ? "steer" : undefined), reply = rpTake();
  try {
    const r = await api("/api/message", "POST", { text, ...(reply ? { reply } : {}), ...(lane ? { lane } : {}), ...(isProjT(t) ? { project: projOf(t) } : {}), ...(isMailT(t) ? { mail: mailOf(t) } : {}), ...(isSettingsT(t) ? { settings: settingsApp(t) } : {}), ...(isFixedT(t) ? { conv: t } : {}), ...(mode ? { mode } : {}), ...(files.length ? { files } : {}) });
    scrollChat(true); scrollTerm(true);
    if (r && r.queued) { QUEUE = QUEUE.filter(i => i.id !== r.queued.id).concat(r.queued); renderQueue(); toast("작업이 끝나면 전달할게요"); }
    // Steering is the default for a message sent mid-turn, so it gets no toast (owner 2026-10-20); interrupting still does.
  else if (mode === "interrupt") toast("중단하고 보냈어요");
  }
  catch (e) { toast(e.message, true); ta.value = text; autosize(); ATT = sentAtt.concat(ATT); renderAtt(); rpRestore(reply); }
}
// The composer follows the selected target and the view mode.
function updateComposerMeta() {
  const info = targetInfo(target), isTerm = modeOf() === "term";
  const gone = isLaneT(target) && info.known && !info.alive;
  const off = gone && !info.resumable;
  ta.disabled = off; $("#send-btn").disabled = off;
  ta.placeholder = off ? "종료된 세션이에요" : DC.cur ? "번호를 누르거나 직접 입력해 주세요" : gone ? "재개하면서 보내기" : isWorking(target) ? "작업 중에 끼어들기" : isTerm ? "메시지 또는 /명령" : isProjT(target) ? `${targetName(target)} 프로젝트의 ${botName}에게 메시지 · /명령` : isMailT(target) ? `이 메일 답장·전달은 ${botName}에게 · /명령` : `${targetName(target)}에게 메시지 · /명령`;
  $("#composer").classList.toggle("tmode", isTerm);
  rpPaint();
  if (typeof asTplSync === "function") asTplSync();
}
// The elapsed time ticks every second on its own; events only arrive when a tool runs, so a time drawn only on events
// froze (owner 2026-10-20: stuck at 18s until the answer came).
let workingLabel = "", workingSubs = 0, workingBg = [];
function tickWorking() {
  if ($("#working").hidden) return;
  // The bottom line shows only the state (owner 2026-10-20); elapsed time lives on the work card.
  const g = CS.group;
  $("#working-tx").textContent = $("#runline-tx").textContent = workingBg.length ? workLine(workingBg) : `${workingLabel}${workingSubs ? ` · 서브에이전트 ${workingSubs}` : ""}`;
  if (g && g.live) g.update();
}
setInterval(() => { if (!document.hidden) tickWorking(); }, 1000);
function renderWorking() {
  const info = targetInfo(target), box = $("#working");
  const st = info.alive ? info.status : "";
  const on = st === "working" || st === "starting" || st === "rate-limited";
  // A request answered with [later] has no running turn, but its background work is still going: the line stays with that work.
  const bg = on ? [] : workOfTarget(target), show = on || bg.length > 0;
  workingBg = bg;
  box.hidden = !show;
  // Only while the gateway reports this target running: status line, model-chip spinner, and stop in place of send
  // (with text typed the button sends it into the running turn instead).
  const line = $("#runline"), stopMode = on && st !== "rate-limited" && !ta.value.trim() && !ATT.length;
  line.hidden = !show; line.classList.toggle("warn", st === "rate-limited");
  $("#c-model").classList.toggle("run", on && st !== "rate-limited");
  const sb = $("#send-btn"); sb.classList.toggle("stop", stopMode); sb.setAttribute("aria-label", stopMode ? "중단" : "보내기"); sb.title = stopMode ? "지금 하는 일 중단" : "";
  if (on) {
    const n = runningSubs(sourceOf(target)).length;
    $(".dot", box).className = `dot ${st === "rate-limited" ? "warn" : "pri"}`;
    workingLabel = `${st === "rate-limited" ? "사용량 한도로 대기 중" : "작업 중…"}`; workingSubs = n;
    tickWorking();
    $("#working-stop").hidden = st === "rate-limited";
  } else if (bg.length) {
    $(".dot", box).className = "dot pri";
    $("#working-stop").hidden = true;
    tickWorking();
  }
  renderQueue(); renderCtxRing();
  markLive();
}

/* ---------- queued messages (server queue, sent when the target's turn ends) + context ring ---------- */
let QUEUE = [];
async function loadQueue() {
  try { QUEUE = (await api("/api/queue")).items || []; } catch { return; }
  renderQueue();
}
function renderQueue() {
  const box = $("#queue"), mine = QUEUE.filter(i => i.target === target);
  box.hidden = !mine.length;
  if (!mine.length) { clear(box); return; }
  clear(box).append(...mine.map(i => el("div", { class: "qitem" },
    el("div", { class: "qb" }, el("div", { class: "qt", text: i.text }), el("div", { class: "qm", text: "작업이 끝나면 전달" })),
    el("div", { class: "qa" },
      el("button", { class: "btn tonal", type: "button", onclick: ev => busy(ev.currentTarget, async () => { await api(`/api/queue/${enc(i.id)}/send`, "POST", {}); QUEUE = QUEUE.filter(x => x.id !== i.id); renderQueue(); scheduleState(); }) }, "지금 끼워넣기"),
      el("button", { class: "btn text", type: "button", onclick: ev => busy(ev.currentTarget, () => takeBack(i)) }, "취소")))));
}
// Taking a queued message back puts its text into the box; a box with a draft keeps it and the message stays queued.
async function takeBack(i) {
  if (ta.value.trim()) { toast("입력창을 비운 뒤 취소해 주세요", true); return; }
  const r = await api(`/api/queue/${enc(i.id)}`, "DELETE");
  QUEUE = QUEUE.filter(x => x.id !== i.id); renderQueue();
  ta.value = r.text; autosize(); renderWorking(); ta.focus();
}
const kfmt = n => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
// "anthropic/claude-opus-5-5:medium" -> "Opus 5.5 · medium" (the models list name when it is loaded).
function modelChipText(sel) {
  const [base, level] = String(sel || "").split(":");
  if (!base) return "";
  const a = [...((M && M.pickable) || []), ...((M && M.available) || [])].find(x => x.selector === base || x.selector === sel);
  const nm = a && a.name ? a.name.replace(/^Claude\s+/i, "") : base.split("/").pop().replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1").replace(/^./, c => c.toUpperCase());
  return level ? `${nm} · ${thinkKo(level)}` : nm;
}
function renderCtxRing() {
  const mb = $("#c-model"), lane = isLaneT(target) && S ? S.lanes.find(x => x.name === laneOf(target)) : null;
  const orchT = target === MAIN || isProjT(target);
  const sel = orchT ? S && S.orchestrator && S.orchestrator.activeModel : lane && lane.model;
  // The chips say whose they are: the orchestrator and a lane often run the same model with a similar context, and
  // unlabeled they read as one (owner 2026-10-20: "오케스트레이터와 레인별로 구분 안되는거 같은데").
  const owner = orchT ? botName : lane ? `세션 ${lane.title || lane.name}` : "";
  const ob = $("#c-own"), wb = $("#c-worker"), wsel = lane && lane.worker_model;
  ob.hidden = !(sel && owner); ob.textContent = owner;
  wb.hidden = !wsel;
  if (wsel) { const [wbase, wlevel] = String(wsel).split(":"); wb.textContent = `서브에이전트 ${modelChipText(wbase)}${wlevel ? ` · ${thinkKo(wlevel)}` : ""}`; wb.title = `이 세션의 서브에이전트 모델`; }
  // model and effort are separate chips, each with its own popover
  const [base, level] = String(sel || "").split(":"), eb = $("#c-effort");
  mb.hidden = !sel; eb.hidden = !level;
  if (sel) prefetchTV();
  if (sel) { const t = modelChipText(base); mb.textContent = t; mb.title = `${owner} 모델 · ${t}`; }
  if (level) { eb.textContent = thinkKo(level); eb.title = `${owner} 추론 강도 · ${thinkKo(level)}`; }
  const keyed = !!(orchT ? S && S.orchestrator && S.orchestrator.key_fallback : lane && lane.key_fallback);
  $("#c-api").hidden = !keyed;
  $("#cbar").classList.toggle("api", keyed);
  const b = $("#ctx-ring"), p = ((C && C.processes) || []).find(x => x.name === (orchT ? "orchestrator" : laneOf(target)));
  b.hidden = !(p && p.running && p.tokens != null);
  if (b.hidden) return;
  const pct = p.percent != null ? Math.min(100, Math.max(0, p.percent)) : 0;
  const label = `${owner} 컨텍스트 ${p.percent != null ? `${Math.round(p.percent)}% · ${kfmt(p.tokens)}/${kfmt(p.window)}` : `${kfmt(p.tokens)} 토큰`}`;
  b.title = label; b.setAttribute("aria-label", label);
  b.textContent = p.percent != null ? `컨텍스트 ${Math.round(p.percent)}%` : `컨텍스트 ${kfmt(p.tokens)}`;
  b.classList.toggle("err", pct >= 80);
}
/* ---------- composer chips: model / effort / context of the current target (GET/PUT /api/target) ---------- */
// The chips are quick switches; the last row of each opens the 모델 · 폴백 screen at this target (fallback order lives there).
const MODELS_LINK = { value: "__models", label: "모델 · 폴백 설정", sub: "폴백 순서까지" };
const targetParam = () => isLaneT(target) ? target : "main";
// GET /api/target per target, kept so a chip opens its menu at once; the server builds it from the CLI model list, which is slow while cold.
// The first click used to wait for that response (owner 2026-10-22: first click on the model/effort chip felt slow).
const TV = new Map(), TV_BUSY = new Set();
async function fetchTV(k) { const T = await api(`/api/target?target=${enc(k)}`); TV.set(k, T); return T; }
// Fills the cache at idle once the chips render, so even the first click finds it.
function prefetchTV() {
  const k = targetParam();
  if (TV.has(k) || TV_BUSY.has(k)) return;
  TV_BUSY.add(k);
  (window.requestIdleCallback || (f => setTimeout(f, 300)))(() => fetchTV(k).catch(() => {}).finally(() => TV_BUSY.delete(k)), { timeout: 3000 });
}
// Opens a chip menu from the cached view without waiting, then refetches; the menu is rebuilt only when the fresh view differs.
async function chipMenu(anchor, build) {
  const k = targetParam(), hit = TV.get(k);
  if (!hit) return build(await fetchTV(k));
  build(hit);
  const sig = T => JSON.stringify([T.model, T.thinking, T.models.map(m => m.selector)]);
  fetchTV(k).then(T => { if (openMenu && openMenu.anchor === anchor && targetParam() === k && sig(T) !== sig(hit)) { closeMenu(false); build(T); } }).catch(() => {});
}
async function targetChange(title, change, label) {
  const body = { target: targetParam(), ...change };
  let r;
  try { r = await api("/api/target", "PUT", body); }
  catch (e) {
    if (!(e.data && e.data.requires_force)) throw e;
    if (!await ask(title, `작업 중인 세션이라 컨텍스트 ${num(e.data.context_tokens)} 토큰이 캐시에 다시 쓰여요\n${label}`, "적용")) return;
    r = await api("/api/target", "PUT", { ...body, force: true });
  }
  toast(change.compact ? (r.compaction === "queued" ? "작업이 끝나면 압축해요" : "압축을 시작했어요") : (applyKo[r.applied] || "적용했어요"));
  TV.delete(body.target);
  await Promise.all([loadModels(true), loadContext(true), fetchTV(body.target).catch(() => {})]); refreshState();
}
$("#c-model").onclick = ev => busy(null, () => {
  const anchor = ev.currentTarget;
  return chipMenu(anchor, T => {
    const name = targetName(target), items = [...modelPickItems(T.models, T.model), MODELS_LINK];
    showMenu(anchor, items, { value: T.model, onPick: v => v === MODELS_LINK.value ? openModels(T.key) : busy(null, () => targetChange(name, { model: v }, `${modelName(v)} · ${T.thinking}`)) });
  });
});
// Effort only: low / medium / high (plus the current level when it is another one); the model is never touched.
$("#c-effort").onclick = ev => busy(null, () => {
  const anchor = ev.currentTarget;
  return chipMenu(anchor, T => {
    const name = targetName(target);
    const levels = ["low", "medium", "high"].filter(v => T.thinking_levels.includes(v));
    if (T.thinking && !levels.includes(T.thinking)) levels.push(T.thinking);
    showMenu(anchor, [{ header: "추론 강도" }, ...levels.map(v => ({ value: v, label: v })), MODELS_LINK], { value: T.thinking, onPick: v => v === MODELS_LINK.value ? openModels(T.key) : busy(null, () => targetChange(name, { thinking: v }, `${modelName(T.model)} · ${v}`)) });
  });
});
$("#ctx-ring").setAttribute("aria-haspopup", "listbox");
$("#ctx-ring").onclick = ev => busy(null, async () => {
  const anchor = ev.currentTarget, T = await api(`/api/target?target=${enc(targetParam())}`), c = T.context || {};
  const inFlight = c.compaction && (c.compaction.state === "queued" || c.compaction.state === "compacting");
  const items = [{ header: c.percent != null ? `컨텍스트 ${Math.round(c.percent)}% · ${kfmt(c.tokens)}/${kfmt(c.window)}` : `컨텍스트 ${kfmt(c.tokens || 0)} 토큰` }];
  if (T.running && !inFlight) items.push({ value: "compact", label: "지금 압축", sub: T.busy ? "작업이 끝나면 압축해요" : "캐시가 한 번 다시 쓰여요" });
  else if (inFlight) items.push({ value: "none", label: "압축 진행 중" });
  items.push({ value: "open", label: "컨텍스트 화면 열기" });
  showMenu(anchor, items, { onPick: v => v === "open" ? go("context") : v === "compact" ? busy(null, () => targetChange(targetName(target), { compact: true }, "")) : null });
});
