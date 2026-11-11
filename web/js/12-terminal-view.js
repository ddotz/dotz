/* ---------- terminal view (터미널): the same data as a session transcript ---------- */
let LG = { cur: null, steps: null, calls: new Map(), workers: [] }, termEmpty = null;
function resetTerm() { clear(term); LG = { cur: null, steps: null, calls: new Map(), workers: [] }; termEmpty = null; }
function toggleOpen(n) {
  if (getSelection().toString()) return;
  n.classList.toggle("open");
  n.setAttribute("aria-expanded", n.classList.contains("open") ? "true" : "false");
}
function clickable(n) {
  n.tabIndex = 0; n.setAttribute("role", "button"); n.setAttribute("aria-expanded", "false");
  n.onclick = ev => { if (!ev.target.closest(".lr-o")) toggleOpen(n); };
  n.onkeydown = ev => { if ((ev.key === "Enter" || ev.key === " ") && ev.target === n) { ev.preventDefault(); toggleOpen(n); } };
  return n;
}
const capName = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "tool";
// Tool name -> the kind word used in summaries ("12초 작업 · 명령 3 · 읽기 2") and row labels.
const KINDS = [[/^(bash|eval|shell|exec|run|python|js)/i, TX("chat.kind.command")], [/^(read|view|cat|ls|open)/i, TX("chat.kind.read")], [/^(edit|write|multiedit|patch|apply|notebook)/i, TX("chat.kind.edit")], [/^(grep|glob|find|search|ast|lsp|symbols)/i, TX("chat.kind.search")], [/^(task|agent|spawn|subagent)/i, TX("common.subagent")], [/^(web|fetch|browser|http)/i, TX("chat.kind.web")], [/^(todo|memory|goal)/i, TX("chat.kind.notes")]];
const kindOf = tool => (KINDS.find(([r]) => r.test(String(tool || ""))) || [0, TX("chat.kind.tool")])[1];
// Status lines from the runtime, said in Korean.
function statusKoLine(text) {
  const t = oneLine(text), m = t.match(/^(\S+) (?:resumed its session|started a new session) \(([^)]+)\)/);
  if (m) return TX(/resumed/.test(t) ? "chat.status.resumed" : "chat.status.started", { name: m[1] === "orchestrator" ? botName : m[1], model: modelChipText(m[2]) });
  if (/^compacting context/.test(t)) return TX("chat.status.compacting");
  if (/^context compacted/.test(t)) return TX("chat.status.compacted");
  if (/^retrying/.test(t)) { const at = (t.match(/attempt (\d+\/?\d*)/) || [])[1]; return at ? TX("chat.status.retrying_n", { attempt: at }) : TX("chat.status.retrying"); };
  if (/^model fallback: /.test(t)) return TX("chat.status.fallback", { model: t.replace(/^model fallback: /, "").replace(/\s*\(.*$/, "") });
  return t;
}
function logGroup(a, title) {
  const dot = el("span", { class: "dot" }), meta = el("span", { class: "lg-m" }), body = el("div", { class: "lg-b" });
  const node = el("section", { class: "lg" }, el("header", { class: "lg-h" }, dot, el("span", { class: "lg-t", text: title || TX("chat.log.work") }), meta), body);
  const g = { node, body, t0: Date.parse(a.ts) || 0, t1: Date.parse(a.ts) || 0, errs: 0, ended: false, used: false };
  g.paint = () => {
    const live = !g.ended && LG.cur === g && isWorking(target);
    meta.textContent = [kstHM(a.ts), g.t1 - g.t0 >= 1000 ? fmtDur(g.t1 - g.t0) : ""].filter(Boolean).join(" · ");
    dot.className = `dot ${live ? "pri" : g.errs ? "err" : g.used ? "ok" : ""}`;
  };
  term.append(node); LG.cur = g; LG.steps = null; g.paint();
  return g;
}
function logSteps(g, a) {
  const sum = el("span", { class: "ls-s" }), rows = el("div", { class: "ls-r" });
  const node = el("details", { class: "ls" }, el("summary", {}, sum), rows);
  const st = { node, rows, n: new Map(), errs: 0, t0: Date.parse(a.ts) || 0, t1: Date.parse(a.ts) || 0 };
  st.paint = () => {
    const parts = [st.t1 - st.t0 >= 1000 ? TX("chat.log.work_for", { dur: fmtDur(st.t1 - st.t0) }) : TX("chat.log.work")];
    for (const [k, v] of st.n) parts.push(`${k} ${v}`);
    if (st.errs) parts.push(TX("chat.log.errors", { n: st.errs }));
    sum.textContent = parts.join(" · ");
  };
  g.body.append(node); LG.steps = st;
  return st;
}
function logRow(a, kind, label) {
  const dot = el("span", { class: "dot pri" }), dur = el("span", { class: "lr-d" }), out = el("div", { class: "lr-o" });
  const node = clickable(el("div", { class: "lr", title: kstTime(a.ts) }, el("div", { class: "lr-h" }, el("span", { class: "lr-k", text: kind }), el("span", { class: "lr-l", text: label }), dur, dot), out));
  if (a.args) out.append(el("pre", { text: a.args }));
  return { node, dot, dur, out, t: Date.parse(a.ts) || 0 };
}
function fillLogRow(rec, a) {
  const t = Date.parse(a.ts) || 0, text = String(a.text ?? "").replace(/\s+$/, "");
  rec.dot.className = `dot ${a.is_error ? "err" : "ok"}`;
  if (t - rec.t >= 1000) rec.dur.textContent = fmtDur(t - rec.t);
  rec.out.append(el("pre", { class: a.is_error ? "err" : "", text: text || TX("chat.log.no_output") }));
}
// One activity item into the log: owner messages and turn starts open a turn card, turn ends close it; tool calls and
// thinking fold into the turn's summary row; answers and errors stay visible in the card.
// A prompt the session received ("> [dotz inbox] web from local …" from the saved transcript): who sent it and its text.
// The gateway's own wording around a message (instructions to the model, channel lists, language reminders, the
// recall block after a compaction) is for the model, not the owner: the log shows a short label and the message itself.
const GW_LEADS = [
  [/^(작업 중에 새 메시지가 도착했어요|A new message arrived while you are working)/, TX("chat.gw.work_msg")],
  [/^(작업 중에 레인 보고가 도착했어요|A lane report arrived while you are working)/, TX("chat.gw.work_lane")],
  [/^(게이트웨이가 다시 시작돼서 이 요청에|The gateway restarted before you answered)/, TX("chat.gw.restart")],
  [/^(오너가 기다리는 중이에요|The owner has waited)/, TX("chat.gw.waiting")],
  [/^(사용량 한도가 풀렸어요|The rate limit has passed)/, TX("chat.gw.limit_over")],
  [/^(모델 제공자 문제|The provider problem)/, TX("chat.gw.provider_ok")],
  [/^(모델 제공자에 일시적인 오류|The provider had a temporary error)/, TX("chat.gw.provider_retry")],
  [/^(당신은 게이트웨이가 헤드리스로|You are \S+, the dotz orchestrator)/, TX("chat.gw.reread")],
  [/^(이 설치의 첫 시작|First start of this install)/, TX("chat.gw.first")],
];
// (no closing parenthesis needed: the saved prompt is cut at 2000 characters, often inside these lines)
const GW_NOISE = /^\s*\((작업 채널 목록|직전에 오너에게|오너에게는 .*로 답하세요|work channels|reply to the owner in|your last message to the owner)/i;
function inboxTitle(head) {
  let m;
  if ((m = head.match(/^(?:레인 (\S+)의 보고|lane report from (\S+))/))) return TX("chat.inbox.lane_from", { name: m[1] || m[2] }).replace(/:$/, "");
  if (/^(레인 보고 \d+건|\d+ lane reports|lane report \()/.test(head)) return TX("chat.inbox.lane");
  if ((m = head.match(/^watch (\S+)/))) return TX("chat.inbox.watch", { name: m[1] });
  if (/새 메일|new mail/.test(head)) return TX("chat.inbox.mail");
  if (/^(예약 항목|scheduled)/.test(head)) return TX("chat.inbox.schedule");
  return "";
}
function promptOf(text) {
  let s = String(text).replace(/^>\s*/, "");
  if (/^\[keepalive\]/i.test(s)) return { title: TX("chat.prompt.keepalive"), body: "", dim: true };
  if (/^\[dotz reflect\]/i.test(s)) return { title: TX("chat.prompt.reflect"), body: "", dim: true };
  if (/^\[handover\]/i.test(s)) return { title: TX("chat.prompt.handover"), body: "", dim: true };
  // the recall block a compaction appends and the memory nudge before it are never the message
  s = s.replace(/\n*(이어가기 전에, 지금까지의 대화에서|Before continuing, save any durable)[\s\S]*$/, "").replace(/\n*\[dotz\] [^\n]*(계약을 다시 읽어요|re-read)[\s\S]*$/i, "");
  let label = "";
  const g = s.match(/^\[dotz gateway\]\s*/i);
  if (g) {
    const after = s.slice(g[0].length), lead = GW_LEADS.find(([re]) => re.test(after));
    // the recall prompt quotes "[dotz inbox]" inside its contract text; only a line that starts with it is the message
    const inbox = after.search(/(^|\n)\[dotz inbox\]/);
    label = lead ? lead[1] : firstLine(after).replace(/^(.{0,60}?[.。])\s.*$/, "$1");
    s = inbox >= 0 && !(lead && lead[1] === TX("chat.gw.reread")) ? after.slice(inbox).trim() : "";
  }
  // attachments: their file names, not the local paths, and never as the title
  const files = [];
  const lines = s.split("\n").filter(l => {
    const a = l.match(/^\[attachment\]\s*(?:(?:이미지|파일)\d+:\s*)?(.+?)\s+\([\w.+-]+\/[\w.+-]+\)/);
    if (a) { files.push(a[1]); return false; }
    return !GW_NOISE.test(l) && !/^\[지금 도는 것\]|^\[now running\]/i.test(l);
  });
  const at = lines.findIndex(l => /^\[dotz inbox\]/i.test(l));
  let head = "", msg = lines;
  if (at >= 0) { head = lines[at].replace(/^\[dotz inbox\]\s*/i, ""); msg = lines.slice(at + 1); }
  const kind = head ? inboxTitle(head) : "";
  // "web from X" / "chat from X": the owner's own words follow on the next lines (or after the header on the same line)
  if (head && !kind) { const rest = head.replace(/^[\w#:-]+ from \S+\s*/, ""); if (rest) msg = [rest, ...msg]; }
  const body = msg.join("\n").trim();
  const first = firstLine(body), title = [label, kind, first && !kind ? first : ""].filter(Boolean).join(" · ") || first || TX("chat.prompt.message");
  const rest = [kind ? body : body.split("\n").slice(1).join("\n").trim(), files.length ? TX("chat.prompt.attached", { files: files.join(", ") }) : ""].filter(Boolean).join("\n");
  return { title, body: rest, dim: !body && !!label };
}
function termNode(a) {
  const t = Date.parse(a.ts) || 0;
  if (a.type === "owner") { logGroup(a, firstLine(a.text ?? "")); return null; }
  if (a.type === "status" && /^>\s/.test(a.text ?? "")) {
    const p = promptOf(a.text), g = logGroup(a, p.title);
    if (p.dim) g.node.classList.add("dim");
    if (p.body) g.body.append(el("div", { class: "lg-q", text: p.body }));
    return null;
  }
  if (a.type === "turn_start") { if (!LG.cur || LG.cur.used || LG.cur.ended) logGroup(a, ""); return null; }
  if (a.type === "status" && (!LG.cur || LG.cur.ended)) return el("div", { class: "lg-note", text: `${statusKoLine(a.text ?? "")} · ${kstHM(a.ts)}` });
  if (a.type === "turn_end") { if (LG.cur) { LG.cur.ended = true; if (t > LG.cur.t1) LG.cur.t1 = t; LG.cur.paint(); } LG.steps = null; return null; }
  const g = LG.cur && !LG.cur.ended ? LG.cur : logGroup(a, "");
  g.used = true; if (t > g.t1) g.t1 = t;
  switch (a.type) {
    case "tool_call": if (kindOf(a.tool) === TX("common.subagent")) {
      // a worker run is its own row in the turn (not folded), with the subagents it started nested under it
      LG.steps = null;
      const rec = logRow(a, TX("common.subagent"), toolLabel(a) || capName(a.tool));
      rec.node.classList.add("lw"); rec.subs = el("div", { class: "lw-s" }); rec.node.append(rec.subs);
      LG.workers.push(rec);
      if (a.call_id) LG.calls.set(a.call_id, { rec, st: { errs: 0, t1: 0, paint() {} } });
      g.body.append(rec.node);
      break;
    }
    // falls through
    case "thinking": {
      const st = LG.steps || logSteps(g, a), kind = a.type === "thinking" ? TX("chat.kind.thinking") : kindOf(a.tool);
      if (t > st.t1) st.t1 = t;
      st.n.set(kind, (st.n.get(kind) || 0) + 1);
      const rec = logRow(a, kind, a.type === "thinking" ? thinkLine(a.text, 120) : toolLabel(a) || capName(a.tool));
      if (a.type === "thinking") { rec.dot.className = "dot"; rec.out.append(mdNode(a.text)); }
      else if (a.call_id) LG.calls.set(a.call_id, { rec, st });
      st.rows.append(rec.node); st.paint();
      break;
    }
    case "tool_result": {
      const hit = a.call_id && LG.calls.get(a.call_id);
      if (hit) { hit.rec.tEnd = t; fillLogRow(hit.rec, a); if (t > hit.st.t1) hit.st.t1 = t; if (a.is_error) { hit.st.errs++; g.errs++; } hit.st.paint(); }
      else { const st = LG.steps || logSteps(g, a), rec = logRow(a, kindOf(a.tool), capName(a.tool || "result")); fillLogRow(rec, a); st.rows.append(rec.node); if (a.is_error) { st.errs++; g.errs++; } st.paint(); }
      break;
    }
    case "text": LG.steps = null; g.body.append(el("div", { class: "lg-x" }, ...mdFiles(a.text))); break;
    case "error": {
      LG.steps = null; g.errs++;
      const raw = String(a.text ?? ""), line = humanAlert(raw);
      g.body.append(el("div", { class: "lg-e" }, line, line.trim() === raw.trim() ? null : el("details", {}, el("summary", { text: TX("chat.log.details") }), el("pre", { text: raw }))));
      break;
    }
    case "cmdout": LG.steps = null; g.body.append(el("div", { class: "lg-x" }, el("div", { class: "md" }, el("pre", { text: String(a.text ?? "") })))); break;
    case "status": g.body.append(el("div", { class: "lg-n", text: `${statusKoLine(a.text ?? "")} · ${kstHM(a.ts)}` })); break;
    default: if (a.text) g.body.append(el("div", { class: "lg-n", text: oneLine(a.text) }));
  }
  g.paint();
  return null;
}
// Subagents have no link to the call that started them: each goes under the worker row whose run window holds its start.
function paintWorkers() {
  if (!LG.workers.length) return;
  const src = subsSourceOf(target), subs = SUBS[src] || [];
  for (const w of LG.workers) {
    const end = w.tEnd || Infinity;
    const mine = subs.filter(x => x.started_at >= w.t - 2000 && x.started_at <= end + 1000);
    clear(w.subs).append(...mine.map(x => el("div", { class: "lw-r", role: "button", tabindex: "0", title: TX("chat.log.open_sub"), onclick: ev => { ev.stopPropagation(); openSub(src, x.id, ev.currentTarget); } },
      el("span", { class: `dot ${subTone(x.status)}` }), el("span", { class: "lw-n", text: x.description || x.agent || x.id }), el("span", { class: "lw-st", text: subKo[x.status] || x.status }))));
  }
}
function termPush(a, bulk) {
  if (termEmpty) { termEmpty.remove(); termEmpty = null; }
  const n = termNode(a);
  if (n) term.append(n);
  while (term.children.length > ts(target).cap) term.firstChild.remove();
  if (!bulk) scrollTerm();
}
