/* ---------- state refresh ---------- */
// A short drop (the stream reconnects and replays what it missed) shows nothing; past 2s the header says it is reconnecting.
let connTimer = 0;
function setConn(ok) { clearTimeout(connTimer); if (ok) $("#conn").hidden = true; else connTimer = setTimeout(() => { $("#conn").hidden = false; }, 2000); }
async function refreshState() {
  try {
    S = await api("/api/state?limit=0");
    S.work_skew = (S.work_now || Date.now()) - Date.now();
    setConn(true);
    webBuildCheck(S.web_build);
    ntSync(S);
    if (S.name && S.name !== botName) { botName = S.name; setBrand(); if (current === "home") $("#title").textContent = botName; if (ts(target).hLoaded) renderAll(); }
    // A lane that exits disappears at once: the view falls back to the main assistant (it stays reachable from ⌘K).
    if (isLaneT(target) && (!S.lanes.some(l => `lane:${l.name}` === target) || (PREV[target] && PREV[target] !== "exited" && targetInfo(target).status === "exited"))) setTarget(MAIN);
    if (isProjT(target) && !projTargets().includes(target)) setTarget(MAIN);   // its work channel was deleted
    noteStatus(); paintAuth(); paintDecision(); paintOrchError();
    renderBars(); renderWorking(); updateComposerMeta();
    if (current === "project") pmPaint();
    if (current === "home") renderHome();
    if (current === "settings") renderSettings();
    loadContext(true);
  } catch { setConn(false); }
}
let stateTimer;
const scheduleState = () => { clearTimeout(stateTimer); stateTimer = setTimeout(refreshState, 800); };
// Collapsed tool row label: the intent the model gave (`i`), else the first line of the command/path. Code stays in the body.
function toolLabel(a) {
  if (a.intent) return firstLine(a.intent);
  // The server's text is "<tool>: <label>", built from the full (untruncated) args, so it still has the intent when args were cut.
  const pre = `${a.tool}: `;
  if (a.tool && typeof a.text === "string" && a.text.startsWith(pre)) return firstLine(a.text.slice(pre.length));
  const args = a.args;
  if (!args) return "";
  const keys = ["i", "intent", "command", "cmd", "path", "file_path", "pattern", "query", "url"];
  let o;
  try { o = JSON.parse(args); } catch {
    for (const k of keys) {
      const m = String(args).match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
      if (m) return firstLine(m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'));
    }
    return "";
  }
  if (o && typeof o === "object") for (const k of keys) if (typeof o[k] === "string" && o[k]) return firstLine(o[k]);
  return "";
}
const firstLine = s => { const l = String(s).trim().split("\n")[0].trim(); return l.length > 90 ? `${l.slice(0, 89)}…` : l; };
function fillResult(rec, a) {
  rec.state.textContent = a.is_error ? "✗" : "✓";
  rec.state.className = `tstate ${a.is_error ? "bad" : "ok"}`;
  rec.body.append(el("div", { class: `cl${a.is_error ? " err" : ""}`, text: a.is_error ? "결과 (오류)" : "결과" }), el("pre", { class: a.is_error ? "err" : "" }, el("code", { text: String(a.text ?? "") })));
}
function toolBox(a, tool, withState) {
  const state = el("span", { class: "tstate", text: withState ? "…" : "" });
  const body = el("div", { class: "body" });
  const label = toolLabel(a);
  // collapsed row reads "tool · intent"; code and results live only in the expansion
  const node = el("details", { class: "box" },
    el("summary", {}, el("span", { class: "tname", text: capName(tool) }), label ? el("span", { class: "tsum", text: `· ${label}` }) : null, el("span", { class: "sp" }), el("span", { class: "ttime", text: kstTime(a.ts) }), state), body);
  return { node, body, state };
}
function actNode(a, ctx) {
  const time = kstTime(a.ts);
  switch (a.type) {
    case "turn_start": case "turn_end": return null;
    case "status": return el("div", { class: "a-div", text: `${oneLine(a.text ?? "")} · ${time}` });
    case "text": return el("div", { class: "a-text" }, el("span", { class: "a-time", text: time }), ...mdFiles(a.text));
    case "thinking": return el("details", { class: "box think" }, el("summary", {}, el("span", { class: "tname", text: "생각" }), el("span", { class: "tsum", text: `· ${oneLine(a.text ?? "").slice(0, 80)}` }), el("span", { class: "sp" }), el("span", { class: "ttime", text: time })), mdNode(a.text));
    case "error": { const raw = String(a.text ?? ""), line = humanAlert(raw); return el("div", { class: "lg-e" }, line, line.trim() === raw.trim() ? null : el("details", {}, el("summary", { text: "자세히" }), el("pre", { text: raw }))); }
    case "tool_call": {
      const rec = logRow(a, kindOf(a.tool), toolLabel(a) || capName(a.tool));
      if (a.call_id) ctx.calls.set(a.call_id, rec);
      return rec.node;
    }
    case "tool_result": {
      const rec = a.call_id && ctx.calls.get(a.call_id);
      if (rec) { fillLogRow(rec, a); return null; }
      const alone = logRow(a, kindOf(a.tool), capName(a.tool || "result"));
      fillLogRow(alone, a);
      return alone.node;
    }
    default: return a.text ? el("div", { class: "a-div", text: oneLine(a.text) }) : null;
  }
}

