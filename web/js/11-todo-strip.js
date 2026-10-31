/* ---------- todo strip: the target's plan (GET /api/todo), one line above the timeline ---------- */
const TD = { by: {}, open: {}, timer: 0, calls: new Set() };
async function loadTodo(t = target) {
  if (isFixedT(t) || isMailT(t)) { TD.by[t] = []; if (t === target) { paintTodo(); if (CV.key && !CV.placed) renderAll(); } return; }   // no plan in 알림 / 작업 기록
  let r;
  try { r = await api(`/api/todo?target=${enc(t)}`); } catch { TD.by[t] = TD.by[t] || []; r = null; }
  if (r) TD.by[t] = Array.isArray(r.phases) ? r.phases : [];
  if (t === target) { paintTodo(); paintRunState(); if (CV.key && !CV.placed) renderAll(); }   // the first paint of an opening waits for the plan (chatReady)
}
const todoState = x => x.status === "in_progress" ? "act" : x.status === "completed" ? "done" : x.status === "abandoned" ? "drop" : "pend";
function paintTodo() {
  const box = $("#todo");
  if (!box) return;
  const phases = TD.by[target] || [], all = phases.flatMap(p => p.tasks || []);
  if (!all.length || all.every(x => todoState(x) === "done" || todoState(x) === "drop")) { box.hidden = true; delete box.dataset.sig; clear(box); return; }
  const open = !!TD.open[target], sig = JSON.stringify([phases, open]);
  box.hidden = false;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const live = all.filter(x => todoState(x) !== "drop"), done = live.filter(x => todoState(x) === "done").length;
  const cur = all.find(x => todoState(x) === "act") || all.find(x => todoState(x) === "pend"), g = x => el("span", { class: `td-g tg-${todoState(x)}`, "aria-hidden": "true" });
  const bar = el("button", { class: "td-bar", type: "button", "aria-expanded": String(open), onclick: () => { TD.open[target] = !open; paintTodo(); } },
    g(cur), el("span", { class: "td-cur", text: cur.content }), el("span", { class: "td-n", text: `${done}/${live.length}` }), icon("drop", "td-ch"));
  const kids = [bar];
  if (open) kids.push(el("div", { class: "td-list" }, ...phases.flatMap(p => [
    p.name ? el("div", { class: "td-ph", text: p.name }) : null,
    ...(p.tasks || []).map(x => el("div", { class: `td-r tr-${todoState(x)}` }, g(x), el("span", { class: "td-tx", text: x.content })))])));
  const keep = $(".td-list", box), top = keep ? keep.scrollTop : 0;
  clear(box).append(...kids);
  const nl = $(".td-list", box); if (nl) nl.scrollTop = top;
}
// A todo tool call finishing means the plan changed: refetch (debounced) when it belongs to the open target.
function todoActivity(a) {
  const isTodo = /(^|__)todo/i.test(String(a.tool || ""));
  if (a.type === "tool_call" && isTodo && a.call_id) { TD.calls.add(a.call_id); return; }
  if (a.type !== "tool_result" || !(isTodo || (a.call_id && TD.calls.delete(a.call_id)))) return;
  const own = targetOfSource(a.source);
  if (own === target || (own === MAIN && isProjT(target))) { clearTimeout(TD.timer); TD.timer = setTimeout(() => loadTodo(target), 250); }
}
// The top of the timeline is the older-messages loader: it sits above the messages (the observer in 09-needs-you.js loads when it comes
// into view) and holds the button for a click. Kept across redraws, never counted as a message or trimmed with the oldest ones.
const TL_TOP_NODE = $("#tl-top"), TL_MORE_BTN = TL_TOP_NODE && $("#tl-more", TL_TOP_NODE);
function paintOlderTop() {
  if (!TL_TOP_NODE) return;
  const more = !!(ts(target).hmore && ts(target).hLoaded);
  TL_TOP_NODE.hidden = !more;
  TL_MORE_BTN.hidden = !more;
}
if (TL_MORE_BTN) TL_MORE_BTN.onclick = () => loadOlderMsgs();
function resetChat() { clear(tl); if (TL_TOP_NODE) tl.append(TL_TOP_NODE); CV.divNode = null; CS = { day: "", group: null, empty: null, prog: new Map(), who: "", whoT: 0 }; paintOlderTop(); }
function dayDiv(t) { const d = kstDay(t); if (d && d !== CS.day) { CS.day = d; CS.who = ""; tl.append(el("div", { class: "a-div", text: dayLabel(t) })); } }
// Who said a message, for the meta line: shown once per run of messages from the same speaker (a gap over 10 minutes starts a new run).
function speakerOf(e) {
  if (e.kind === "message" || e.kind === "lane_message" || e.kind === "_cmd") return `owner|${e.kind === "_cmd" ? "cmd" : e.source ?? ""}`;
  if (e.kind === "lane_report") return `lane|${e.lane ?? ""}`;
  if (e.kind === "out" && (e.target === "alert" || e.target === "worklog")) return e.target;
  if (e.kind === "out") return "bot";
  return "";
}
const SYS_LABEL = { schedule: "예약", watch: "모니터링", mail: "메일" };
// Gateway restart notices: a clean one (nothing was cut off) leaves the chat and only counts toward the top banner.
const isRestart = e => e.kind === "out" && e.source === "gateway" && /^게이트웨이(?: 재시작했어요|를 다시 시작했어요)/.test(String(e.text ?? ""));
const cleanRestart = e => isRestart(e) && /끊긴 작업은 없어요/.test(String(e.text ?? ""));
const BAN_KEY = "dotz-restart-seen";
function paintRestartBanner() {
  const today = kstDay(Date.now()), list = ts(MAIN).msgs.filter(e => isRestart(e) && kstDay(e.ts) === today);
  const b = $("#gban"), last = list.length ? list[list.length - 1].ts : "";
  // Closing it silences today's count; it comes back today only when a later restart cut work off.
  const cut = list.filter(e => !cleanRestart(e)).length;
  const seen = lsJson(BAN_KEY, null);
  b.hidden = !last || (!!seen && seen.day === today && cut <= (seen.cut || 0));
  if (b.hidden) return;
  $("#gban-dot").className = `dot ${cut ? "warn" : ""}`;
  $("#gban-tx").innerHTML = `오늘 재시작 <b>${list.length}회</b> · 끊긴 작업 <b>${cut}</b>`;
  b.title = `오늘 게이트웨이 재시작 ${list.length}회, 끊긴 작업 ${cut}, 마지막 ${kstHM(last)}`;
  $("#gban-x").onclick = () => { try { localStorage.setItem(BAN_KEY, JSON.stringify({ day: today, cut })); } catch {} b.hidden = true; };
}
// Alerts: one plain Korean line; the raw text (provider error strings, report lines) folds under 자세히.
function humanAlert(text) {
  const m = text.match(/^(.+?): 모델 제공자 오류\(([\s\S]*)\)가 (\d+)번 재시도해도 계속돼서 멈췄(?:습니다|어요)/);
  if (m) {
    const c = m[2];
    const why = /timed out|timeout/i.test(c) ? "모델 응답이 너무 오래 없어서" : /ENOTFOUND|reach|network|ECONN|fetch failed/i.test(c) ? "모델 서버에 연결되지 않아서" : /rate|limit|429/i.test(c) ? "사용 한도에 걸려서" : /overload|529|50\d/i.test(c) ? "모델 서버가 바빠서" : "모델 오류가 계속돼서";
    const last = m[1].charCodeAt(m[1].length - 1) - 0xac00, josa = last >= 0 && last < 11172 && last % 28 ? "이" : "가";
    return `${m[1]}${josa} ${why} ${m[3]}번 다시 해 보다가 멈췄어요. 다음 메시지부터 다시 해요.`;
  }
  return text.split("\n")[0].replace(/\s*\([^()]*[A-Za-z]{4,}[^()]*\)/g, "").trim() || text;
}
// A reply that just arrived types itself out (the harness sends only finished messages, no token deltas): its text
// nodes fill in order at a pace that ends within ~1.2 s. History, re-renders and reduced motion show it at once.
const STREAMED = new Set(), STREAMING = new Map();   // STREAMING: text root -> its [text node, full text] pairs while it types out
// A message's height with its text fully in, measured in one synchronous step (no paint between): scrollChat judges "taller than the view"
// by it. While the text is still typing out the message is held at that height (min-height, released when typed) so the room to scroll is there.
function fullHeight(node) {
  const blank = [];
  for (const [root, nodes] of STREAMING) if (node.contains(root)) for (const [n, t] of nodes) { blank.push([n, n.data]); n.data = t; }
  const h = node.offsetHeight;
  for (const [n, d] of blank) n.data = d;
  if (blank.length) node.style.minHeight = `${h}px`;
  return h;
}
function streamIn(root, key, ts) {
  if (STREAMED.has(key) || Date.now() - Date.parse(ts) > 15000 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  STREAMED.add(key);
  const nodes = [], walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { nodes.push([n, n.data]); n.data = ""; }
  STREAMING.set(root, nodes);
  const total = nodes.reduce((s, [, t]) => s + t.length, 0), t0 = performance.now(), dur = Math.min(1200, 250 + total * 6);
  const step = now => {
    let left = Math.ceil(total * Math.min(1, (now - t0) / dur));
    for (const [n, t] of nodes) { const k = Math.min(t.length, left); if (n.data.length !== k) n.data = t.slice(0, k); left -= k; }
    if (now - t0 < dur) requestAnimationFrame(step); else { STREAMING.delete(root); const bm = root.closest(".bm"); if (bm) bm.style.minHeight = ""; }
  };
  requestAnimationFrame(step);
}
// Delivery state of an owner message (hub/events.ts emitDelivery), shown in its meta line: received (steered into the running step /
// received by an idle session / waited in the queue / resumed a stopped session / held on a limit), answered, or not delivered.
const DELIV = { nodes: new Map(), state: new Map() };
const DELIV_RANK = { steered: 1, received: 1, queued: 1, held: 1, resumed: 1, answered: 2, failed: 2 };
const DELIV_LABEL = { steered: "받음 · 지금 작업에 전달", received: "받음 · 바로 전달", queued: "받음 · 기다렸다 전달", held: "받음 · 한도가 풀리면 전달", resumed: "다시 시작해서 전달", answered: "답함" };
const delivLabel = d => d.state === "failed" ? `전달하지 못했어요${d.text ? ` · ${d.text}` : ""}` : DELIV_LABEL[d.state] || "";
function paintDelivery(mid) {
  const n = DELIV.nodes.get(mid), d = DELIV.state.get(mid);
  if (!n || !d) return;
  n.mt.textContent = [n.base, delivLabel(d)].filter(Boolean).join(" · ");
  n.mt.classList.add("dv"); n.mt.classList.toggle("dv-fail", d.state === "failed");
}
function applyDelivery(e) {
  const old = DELIV.state.get(e.ref);
  if (old && DELIV_RANK[old.state] > DELIV_RANK[e.state]) return;
  DELIV.state.set(e.ref, e);
  if (DELIV.state.size > 600) DELIV.state.delete(DELIV.state.keys().next().value);
  paintDelivery(e.ref);
}
// A command answer: title with a tone dot, label/value rows, a note, and buttons that send a command like the composer does.
function cardNode(c) {
  const dot = el("span", { class: `dot${c.tone ? ` ${c.tone === "busy" ? "pri" : c.tone}` : ""}` });
  const rows = (c.facts || []).flatMap(f => [el("dt", { text: f.label }), el("dd", { text: f.value })]);
  const acts = (c.actions || []).map(a => {
    const b = el("button", { class: "btn tonal", type: "button", title: a.send, text: a.label });
    b.onclick = () => sendCommand(a.send);
    return b;
  });
  return el("div", { class: "ccard" }, el("div", { class: "cc-hd" }, dot, el("span", { text: c.title })),
    rows.length ? el("dl", { class: "cc-facts" }, ...rows) : null, c.note ? el("div", { class: "cc-note", text: c.note }) : null,
    acts.length ? el("div", { class: "btns cc-act" }, ...acts) : null);
}
function msgNode(e) {
  const text = String(e.text ?? ""), hm = kstHM(e.ts);
  // Nothing to read: an outbox record with no text and no card is not a bubble (a deferral note must never look like an empty one).
  if (!text.trim() && !e.card && !(Array.isArray(e.files) && e.files.length) && e.kind !== "result" && e.kind !== "lane_start") return null;
  switch (e.kind) {
    case "message": case "lane_message": case "_cmd": {
      const via = e.kind === "_cmd" ? "명령" : e.source === "discord" ? "Discord" : e.source === "terminal" ? "터미널" : "";
      const ub = el("div", { class: "ub", text }), long = text.length > 420 || text.split("\n").length > 6;
      if (long) ub.classList.add("clamp");
      const more = long ? el("button", { class: "ubm", type: "button", onclick: () => { const c = ub.classList.toggle("clamp"); more.textContent = c ? "더 보기" : "접기"; } }, "더 보기") : null;
      const base = [hm, via].filter(Boolean).join(" · "), mt = el("div", { class: "mt", text: base }), mid = e.mid || e.message_id || "";
      if (mid) { DELIV.nodes.set(mid, { mt, base }); if (DELIV.nodes.size > 600) DELIV.nodes.delete(DELIV.nodes.keys().next().value); paintDelivery(mid); }
      // The owner's files are uploads of the computer that holds the conversation: a peer's open there (15-attachments.js fileUrl).
      const pc = Array.isArray(e.files) && e.files.length ? pqPc(eventTarget(e) || "") : null;
      return el("div", { class: "um" }, filesNode(pc ? e.files.map(f => ({ ...f, pc })) : e.files), rpQuote(e), text ? ub : null, more, mt);
    }
    case "_cmdout": return el("div", { class: `cmdbox${e.is_error ? " err" : ""}` }, e.card ? cardNode(e.card) : el("pre", { text }), el("div", { class: "mt", text: hm }));
    case "notice": case "notice_read": return null;
    case "result": {
      const go = el("button", { class: "btn tonal", type: "button", text: "세션 열기" });
      go.onclick = () => pickTarget(e.open || "main");
      // the preview is plain text: drop the markdown bold and code marks
      const lines = text.replace(/\*\*|`/g, "").split("\n").filter(Boolean).slice(0, 3).join("\n");
      return el("div", { class: "bm res" }, el("div", { class: "mt", text: ["세션 결과", hm].filter(Boolean).join(" · ") }),
        el("div", { class: "ccard" }, el("div", { class: "cc-hd" }, el("span", { class: "dot ok" }), el("span", { text: `${e.title || "세션"} 끝났어요` }), e.verified ? el("span", { class: "tag ok", text: "확인됨" }) : null),
          lines ? el("div", { class: "cc-note", text: lines }) : null, el("div", { class: "btns cc-act" }, go)));
    }
    case "lane_start": return el("div", { class: "a-div", text: `세션 시작 · ${hm}` });
    case "mail": {
      // A mail conversation's first message (hub/mail.ts postMail): sender, subject, then the summary and the body (원문).
      if (e.subject) {
        const key = e.mail || (isMailT(e.conv || "") ? mailOf(e.conv) : ""), html = !!(e.html || (MAILS.get(`mail:${key}`) || {}).html);
        const card = resultCard({ src: mailSender(e.from) || SYS_LABEL.mail, at: e.ts, title: e.subject, text: text.split("\n").slice(1).join("\n").trim(), rawOpen: !!key, rawNode: key ? raw => mailBodyNode(key, html, raw) : undefined });
        // 보낸 사람 / 받는 사람 / 참조 and the same-sender thread (30-mail-thread.js) sit under the summary, above the original
        if (card && key) { const meta = mailMetaNode(`mail:${key}`, e), fold = card.querySelector(".rc-raw"); if (fold) card.insertBefore(meta, fold); else card.append(meta); if (MT_READY) mailThreadSync(); }
        // 초안 작성 under the summary of an incoming mail, the same button as on its row (30-monitoring.js mailDraftButton): no tap on the ⋯ first.
        // A wide screen hides it (16-result-card.css): the conversation head there has its own 초안 작성 (31-conversations.js cv-draft).
        if (card && key && ((MAILS.get(`mail:${key}`) || {}).dir || e.dir) !== "out") { const meta = card.querySelector(".mhd-wrap"); card.insertBefore(el("div", { class: "mr-slot mr-conv-act" }, mailDraftButton(`mail:${key}`)), meta || card.querySelector(".rc-raw")); }
        const files = card && key && Array.isArray(e.attachments) ? mailFilesNode(key, e.attachments) : null;
        if (files) card.append(files);
        // the same ⋯ as the mail's row in the list, at the top right (30-monitoring.js mailMenuBtn)
        if (card && key) { const hd = card.querySelector(".rc-hd"); if (hd) hd.append(mailMenuBtn(`mail:${key}`)); }
        return card;
      }
      const f = k => (text.match(new RegExp(`^${k}: ?(.*)$`, "m")) || [])[1] || "";
      const subj = f("subject"), acct = (text.match(/^new mail \(([^)]*)\)/m) || [])[1] || "";
      const snip = (text.match(/^snippet: ?([\s\S]*)$/m) || [])[1] || "";
      const from = f("from").replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "") || f("from");
      if (subj) return resultCard({ src: from || acct || SYS_LABEL.mail, at: e.ts, title: subj, text: snip.trim() });
    }
    // falls through: a mail without a subject line shows as plain text
    case "schedule": case "watch": {
      // the gateway's own wake (hub/main.ts wakeOnce: update carry-over, text overrides) is an instruction to the assistant: no card
      if (e.kind === "schedule" && e.source === "gateway") return null;
      // Same card as any other assistant message: who, when, then the plain line; the raw output folds under 원문.
      const body = e.kind === "watch" ? watchLine(e.label || e.watch, e.reason, text, { prev: e.prev }) : scheduleLine(text);
      return resultCard({ src: e.kind === "watch" ? humanLabel(e.label || e.watch) : SYS_LABEL[e.kind], at: e.ts, text: e.kind === "watch" ? body : body.replace(/^[^\n]*\n?/, ""), title: e.kind === "watch" ? undefined : body.split("\n")[0] });
    }
    default: {
      const fromLane = typeof e.source === "string" && e.source.startsWith("lane:");
      // A session's report or answer is a full message; only the gateway's progress line (update_key) stays one compact note.
      const laneMsg = e.kind === "lane_report" || (e.kind === "out" && fromLane);
      const isNote = e.kind === "out" && !!e.update_key && (fromLane || (typeof e.target === "string" && e.target.startsWith("lane:")));
      const { tone, text: parsed } = e.kind === "out" || e.kind === "lane_report" ? parseTone(noHandoff(text), true) : { tone: "", text };
      // The orchestrator keeps its leading status emoji; a session's tone is a short word in the meta line instead.
      const body = (tone && !laneMsg ? `${TONE_EMOJI[tone]} ` : "") + parsed;
      if (isNote) {
        const n = el("div", { class: "pn", tabindex: "0", role: "button" }, el("span", { class: "mt", text: hm }), el("span", { class: "pt", text: body.replace(/^진행 중:\s*/, "") }));
        n.onclick = () => { if (!getSelection().toString()) n.classList.toggle("open"); };
        return n;
      }
      const name = e.kind === "lane_report" ? String(e.lane ?? "") : fromLane ? targetName(e.source) : e.target === "alert" ? "알림" : e.target === "worklog" ? "작업내역" : isRestart(e) ? "게이트웨이" : botName;
      if (e.kind === "out" && e.card && Array.isArray(e.card.facts)) return el("div", { class: "bm" }, el("div", { class: "mt" }, name ? el("span", { class: "mn", text: name }) : null, hm ? `${name ? " · " : ""}${hm}` : null), rpQuote(e), cardNode(e.card));
      const card = e.kind === "lane_report" && !isLaneT(target) ? " rep" : e.target === "alert" ? " alert" : "";
      const lt = laneMsg && tone ? LANE_TONE[tone] : null;
      const head = el("div", { class: "mt" }, name ? el("span", { class: "mn", text: name }) : null, hm ? `${name ? " · " : ""}${hm}` : null, lt ? el("span", { class: `tag ${lt[0]}`, text: lt[1] }) : null);
      const pc0 = e.kind === "out" || e.kind === "lane_report" ? parseChoices(parsed) : null, pc = pc0 && choiceAsks(e, tone, pc0) ? pc0 : null;
      // A plain alert is one human line with the raw text folded; an alert that asks (a choice block) shows whole, with its buttons.
      if (e.target === "alert" && !(pc && pc.blocks.length)) {
        if (/```원문\n/.test(body)) return el("div", { class: `bm${card}` }, head, mdNode(body));
        const line = humanAlert(body);
        return el("div", { class: `bm${card}` }, head, mdNode(line), line.trim() === body.trim() ? null : el("details", { class: "more" }, el("summary", { text: "자세히" }), el("pre", { text: body })));
      }
      // A result file of another computer's conversation lives on that computer: its chips and paths open through the peer proxy.
      const fl = fileLines(body), host = pqPc(eventTarget(e) || ""), md = mdNode(pc && pc.blocks.length ? stripChoices(fl.text) : fl.text), files = pathFiles(md, host);
      if (e.kind === "out" && !isRestart(e)) streamIn(md, `${e.ts}|${text.length}`, e.ts);
      return el("div", { class: `bm${card}` }, head, rpQuote(e), md, filesNode(host ? fl.files.map(f => ({ ...f, pc: host })) : fl.files), files, pc && pc.blocks.length ? choicesNode(hashOf(parsed.trim()), pc, e.ts) : null);
    }
  }
}
const WORK = new Set(["tool_call", "tool_result", "thinking", "text", "error"]);
function newGroup(a) {
  const wsum = el("span", { class: "wsum" }), body = el("div", { class: "wbody" });
  const node = el("details", { class: "work" }, el("summary", {}, el("span", { class: "wdot" }), wsum), body);
  const g = { node, body, ctx: { calls: new Map() }, kinds: new Map(), tools: 0, think: 0, errs: 0, t0: Date.parse(a.ts), t1: Date.parse(a.ts), live: false };
  g.update = () => {
    const parts = [g.t1 - g.t0 >= 1000 ? `${fmtDur(g.t1 - g.t0)} 작업` : g.tools ? "작업" : g.think ? "생각" : "작업"];
    if (g.live) { const d = Math.max(g.t1, Date.now()) - g.t0; parts[0] = `작업 중${d >= 1000 ? ` ${fmtDur(d)}` : ""}`; }
    for (const [k, v] of g.kinds) parts.push(`${k} ${v}`);
    if (g.errs) parts.push(`오류 ${g.errs}`);
    wsum.textContent = parts.join(" · ");
    node.classList.toggle("bad", g.errs > 0);
  };
  g.add = a => {
    const n = actNode(a, g.ctx);
    if (n) g.body.append(n);
    if (a.type === "tool_call") { g.tools++; const k = kindOf(a.tool); g.kinds.set(k, (g.kinds.get(k) || 0) + 1); }
    else if (a.type === "thinking") g.think++;
    if (a.type === "error" || (a.type === "tool_result" && a.is_error)) g.errs++;
    const t = Date.parse(a.ts);
    if (t > g.t1) g.t1 = t;
    g.update();
  };
  return g;
}
function dropProgress(key) { const p = CS.prog.get(key); if (p) { p.node.remove(); CS.prog.delete(key); } }
// entry: {m: conversation event} or {a: activity item}. Work between messages folds into one collapsed group.
function chatPush(en, bulk) {
  let fresh = null;   // an incoming message node: a tall one is scrolled to by its top (scrollChat)
  if (en.m && en.m.kind === "delivery") { applyDelivery(en.m); return; }
  if (CS.empty) { CS.empty.remove(); CS.empty = null; }
  if (en.m) {
    if (cleanRestart(en.m)) return;
    dayDiv(en.m.ts);
    if (CS.group) { CS.group.live = false; CS.group.node.classList.remove("live"); CS.group.update(); }
    CS.group = null;
    const e = en.m;
    if (isSettingsT(target) && eventTarget(e) === target) { if (e.kind === "message") TURN.set(target, Date.parse(e.ts) || Date.now()); else if (e.kind === "out" && !e.update_key) TURN.delete(target); }
    const pkey = e.kind === "out" && e.update_key ? `${e.target ?? ""}|${e.update_key}` : "";
    const et = eventTarget(e) || "", laneT = isLaneT(et) ? et : "";
    // One progress note per target+key (newest text at the newest position; a session keeps only its newest note);
    // the answer to that target (or its lane report) drops them.
    if (pkey) { dropProgress(pkey); if (laneT) for (const [k, v] of CS.prog) if (v.target === laneT) dropProgress(k); }
    else if (!isFixedT(target) && (e.kind === "lane_report" || e.kind === "out")) {
      const t = e.kind === "lane_report" || laneT ? et : String(e.target ?? "");
      for (const [k, v] of CS.prog) if (v.target === t) dropProgress(k);
    }
    const n = msgNode(e);
    if (n) {
      n.dataset.ts = e.ts;   // the notice jump finds its source message by this (30-notices.js ntFind)
      rpMark(n, e);
      if (CV.div && !CV.divNode && convIncoming(e) && e.ts > CV.div) { CV.divNode = tl.appendChild(convDivider()); CS.who = ""; }
      const who = n.matches(".um, .bm") ? speakerOf(e) : "", t = Date.parse(e.ts) || 0;
      if (who && who === CS.who && t - CS.whoT < 600000) n.classList.add("cont");
      CS.who = who; CS.whoT = t;
      if (convIncoming(e)) fresh = n;
      tl.append(n); if (pkey) CS.prog.set(pkey, { node: n, target: laneT || String(e.target ?? "") });
    }
  } else {
    if (!WORK.has(en.a.type) || isMailT(target) || (isSettingsT(target) && !(TURN.get(target) <= (Date.parse(en.a.ts) || 0)))) return;
    if (!CS.group) { dayDiv(en.a.ts); CS.group = newGroup(en.a); tl.append(CS.group.node); }
    CS.group.add(en.a);
  }
  const fixed = TL_TOP_NODE && TL_TOP_NODE.parentNode === tl ? 1 : 0;
  while (tl.children.length > ts(target).cap + fixed) (fixed ? tl.children[1] : tl.firstElementChild)?.remove();
  markLive();
  if (!bulk) scrollChat(false, fresh);
}
function markLive() {
  const g = CS.group;
  if (!g) return;
  const live = isWorking(target) && tl.lastElementChild === g.node;
  if (g.live !== live) { g.live = live; g.node.classList.toggle("live", live); g.update(); }
}
