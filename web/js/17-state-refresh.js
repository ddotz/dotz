/* ---------- state refresh ---------- */
// A short drop (the stream reconnects and replays what it missed) shows nothing; past 2s the header says it is reconnecting.
// A gateway that is off (the computer asleep, the process down) often does not refuse: the request just hangs. So a state that has not come
// within STATE_WAIT_MS counts as a drop too. When that happens before this page ever reached its gateway, the page goes to the other computer
// by itself, with no notice (owner 2026-10-28: "안오면 그냥
// 자동 전환 ... 굳이 알리지 말고"); a page that arrived by such a switch (?auto=1) does not switch again, so two computers that are both off
// do not hand the page back and forth, and its header line stays a button to try the other one. A drop later on (a gateway restart) only shows that line.
const STATE_WAIT_MS = 4000;
let connTimer = 0, selfDown = false, everConnected = false;
function setConn(ok) {
  clearTimeout(connTimer);
  if (ok) { selfDown = false; everConnected = true; $("#conn").hidden = true; return; }
  connTimer = setTimeout(() => { selfDown = true; paintConn(); autoSwitch(); }, 2000);
}
matchMedia("(max-width: 639px)").addEventListener("change", () => { if (!$("#conn").hidden) paintConn(); });
const cameByAuto = new URLSearchParams(location.search).has("auto");
if (cameByAuto) { const u = new URL(location.href); u.searchParams.delete("auto"); history.replaceState(history.state, "", u.pathname + u.search + u.hash); }
// A lane that exits disappears at once: the view falls back to the main assistant (it stays reachable from ⌘K), unless a tapped notice opened that session's report (ntKeep).
// A project's work channel that was deleted falls back the same way. While the owner has text in the composer or the focus there, the move waits (endedHold)
// until the box is blurred and empty; a session that cannot be written to (gone from the list, ended for good, a deleted project) carries the text into main instead.
let endedHold = "";
function endedNow(t) {
  if (isLaneT(t)) return !S.lanes.some(l => `lane:${l.name}` === t) || (t !== ntKeep && targetInfo(t).status === "exited" && (endedHold === t || (!!PREV[t] && PREV[t] !== "exited")));
  return isProjT(t) && !projTargets().includes(t);
}
function endedLeave() {
  const t = target, held = document.activeElement === ta, text = ta.value;
  if (!text.trim() && !held) { endedHold = ""; setTarget(MAIN); return; }
  const i = targetInfo(t);
  if (isLaneT(t) && i.known && (i.alive || i.resumable)) { endedHold = t; return; }   // it can still be written to: stay while there is text or focus
  endedHold = "";
  setTarget(MAIN);
  try { localStorage.removeItem(DRAFT_KEY(t)); } catch (e) { console.warn("draft", e); }
  ts(t).draft = "";
  ta.value = [ta.value, text].filter(x => x.trim()).join("\n");
  saveDraft(); autosize(); updateHints();
  if (held) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
function endedSettle() {
  if (!endedHold) return;
  if (endedHold !== target || !S || !endedNow(target)) { endedHold = ""; return; }
  if (!ta.value.trim() && document.activeElement !== ta) endedLeave();
}
ta.addEventListener("blur", endedSettle);
ta.addEventListener("input", endedSettle);
let autoTried = false;
function autoSwitch() {
  const other = typeof prFailover === "function" ? prFailover() : null;
  if (!other || cameByAuto || autoTried || everConnected) return;
  autoTried = true;
  prPick(other, { quiet: true, auto: true });
}
// A device that cannot reach this computer at all (its network is gone, or it fell off the tailnet: the owner's phone, 2026-11-14) looked like a gateway restart,
// the one word 끊김. The page cannot tell a computer that is down from a device that is off the tailnet, but it can tell "no answer of any kind" from an answer:
// the state request rejects with a TypeError (no status) and the stream's error leaves it CONNECTING (the browser retries on its own; an HTTP error status
// closes it, 99-boot.js). When both hold for UNREACH_MS the line says this device cannot reach the computer and points at its network and Tailscale.
// 30 s: a gateway restart is back well within it (the stream retries every 0.25 s up to 5 s, the gateway's ping comes every 25 s, hub/events.ts).
// The stretch is timed from the stream's first such error; at its end one state request checks again when the last one was answered.
const UNREACH_MS = 30000;
let streamNet = false, stateNet = false, netLong = false, netTimer = 0;
const unreachable = () => netLong && streamNet && stateNet;
function reachNote(kind, net) {
  const was = unreachable();
  if (kind === "stream") streamNet = net; else stateNet = net;
  if (!streamNet) { clearTimeout(netTimer); netTimer = 0; netLong = false; }
  else if (!netTimer && !netLong) netTimer = setTimeout(() => { netTimer = 0; netLong = true; if (stateNet) { if (selfDown) paintConn(); } else refreshState(); }, UNREACH_MS);
  if (was !== unreachable() && selfDown) paintConn();
}
function paintConn() {
  const c = $("#conn"), other = typeof prFailover === "function" ? prFailover() : null, far = unreachable();
  const full = far ? TX("shell.conn.unreachable") : other ? koPick(TX("chat.conn.switching", { name: other.name })) : TX("shell.conn.lost");
  c.hidden = !selfDown;
  // A phone's bar has no room for the sentence: the dot and one short word stay, the sentence is the label.
  c.textContent = matchMedia("(max-width: 639px)").matches ? TX(far ? "shell.conn.unreachable_short" : "chat.conn.short") : full;
  c.title = full; c.setAttribute("aria-label", full);
  c.disabled = !other;
  c.onclick = other ? () => prPick(other) : null;
}
// Only the state request decides the connection: an error while drawing a state that did arrive is a page bug, not a drop. It used to share the catch, so
// a render error on one device showed the lost-connection line on every refresh while the stream and the requests were fine. Such an error goes to the
// console and, once per message, to the gateway's diagnostic file (hub/input-diag.ts, kind "state-err").
const stateErrSent = new Set();
function stateRenderErr(e) {
  console.error("state render", e);
  const msg = String((e && e.message) || e).slice(0, 200);
  if (stateErrSent.has(msg)) return;
  stateErrSent.add(msg);
  const stack = String((e && e.stack) || "").split("\n").slice(0, 8);
  const entry = { at: new Date().toISOString(), kind: "state-err", vis: document.visibilityState, active: msg, field: { tag: "state", sel: current || "" }, stack };
  fetch("/api/input-diag", { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true, body: JSON.stringify({ app: typeof WEB_BUILD === "string" ? WEB_BUILD : "", entries: [entry] }) })
    .catch(err => console.warn("state-err report", err));
}
async function refreshState() {
  try {
    const slow = setTimeout(() => setConn(false), STATE_WAIT_MS - 2000);
    try { S = await api("/api/state?limit=0"); } finally { clearTimeout(slow); }
  } catch (e) { reachNote("state", e instanceof TypeError); setConn(false); return; }
  reachNote("state", false);
  try {
    S.work_skew = (S.work_now || Date.now()) - Date.now();
    setConn(true);
    webBuildCheck(S.web_build);
    ntSync(S);
    if (S.name && S.name !== botName) { botName = S.name; setBrand(); if (current === "home") $("#title").textContent = botName; if (ts(target).hLoaded) renderAll(); }
    if (endedNow(target)) endedLeave();
    noteStatus(); paintAuth(); paintDecision(); paintOrchError(); paintPause(); paintRunState();
    renderBars(); renderWorking(); paintSysLines(); updateComposerMeta(); dskPaint();
    if (current === "project") pmPaint();
    if (current === "home") renderHome();
    if (current === "settings") renderSettings();
    loadContext(true);
    snapHomeSoon();
  } catch (e) { stateRenderErr(e); }
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
function actNode(a, ctx) {
  const time = kstTime(a.ts);
  switch (a.type) {
    case "turn_start": case "turn_end": return null;
    case "status": return el("div", { class: "a-div", text: `${oneLine(a.text ?? "")} · ${time}` });
    case "text": return el("div", { class: "a-text" }, el("span", { class: "a-time", text: time }), ...mdFiles(a.text));
    case "thinking": return el("details", { class: "box think" }, el("summary", {}, el("span", { class: "tname", text: TX("chat.kind.thinking") }), el("span", { class: "tsum", text: `· ${thinkLine(a.text)}` }), el("span", { class: "sp" }), el("span", { class: "ttime", text: time })), mdNode(a.text));
    case "error": { const raw = String(a.text ?? ""), line = humanAlert(raw); return el("div", { class: "lg-e" }, line, line.trim() === raw.trim() ? null : el("details", {}, el("summary", { text: TX("chat.log.details") }), el("pre", { text: raw }))); }
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

