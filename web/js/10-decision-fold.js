const dcFolded = t => DC.fold[t] !== false;
function dcFoldSum(dc) {
  const opts = dc.blocks[0] ? dc.blocks[0].options.length : 0;
  return `· ${dc.blocks.length > 1 ? TX("decision.fold_many", { n: dc.blocks.length }) : opts ? TX("decision.fold_pick", { n: opts }) : TX("decision.waiting_tag")}`;
}
const ASK = { later: "", busy: "" };
const askFixed = n => !!n && ntIsDec(n) && n.decision.state === "open" && !n.pc && !n.decision.draft && !/^(?:auth|schedule):/.test(n.decision.to);
const askNoticeOf = dc => { const n = dc.blocks.length === 1 ? (dc.each ? dc.blocks[0].nd : dcNoticeAt(dc.at)) : null; return askFixed(n) ? n : null; };
function askLeft(n) {
  const ms = Date.parse(n.decision.expires_at) - Date.now();
  if (!(ms > 0) || !askFixed(n)) return "";
  return ms >= 3600000 ? TX("decision.ask.left_h", { n: Math.ceil(ms / 3600000) }) : TX("decision.ask.left_m", { n: Math.ceil(ms / 60000) });
}
const askLines = n => [n.decision.more_at ? TX("decision.ask.more_at", { t: kstHM(n.decision.more_at) }) : "", ntLater(n) ? TX("decision.ask.later_at", { t: kstHM(n.decision.later_until) }) : ""].filter(Boolean);
const askRepaint = () => { ntSheetPaint(); paintDecision(); };
async function askSend(n, tail, body) {
  if (ASK.busy) return;
  ASK.busy = String(n.id); ASK.later = ""; askRepaint();
  try {
    const r = await api(`/api/notices/${enc(n.id)}/${tail}`, "POST", body);
    ntApply(r.item, r.unread);
    const at = tail === "later" && r.item && r.item.decision ? r.item.decision.later_until : "";
    if (at) toast(TX("decision.ask.later_at", { t: kstHM(at) }));
  } catch (e) { toast(e instanceof TypeError ? TX("decision.err.offline_act") : e.message, true); }
  ASK.busy = "";
  askRepaint();
}
function askBtns(n, k) {
  const id = String(n.id), off = !!ASK.busy || (k === "ds" && NS.busy);
  const b = (key, text, fn) => el("button", { type: "button", class: k === "ds" ? "ds-direct" : "btn text sm", "data-k": key, disabled: off, onclick: fn, text });
  const pick = how => () => askSend(n, "later", { for: how });
  if (ASK.later === id) return el("div", { class: `${k}-fixed`, role: "group" }, b("later-hour", TX("decision.ask.hour"), pick("hour")), b("later-morning", TX("decision.ask.morning"), pick("morning")), b("later-back", TX("decision.back"), () => { ASK.later = ""; askRepaint(); }));
  return el("div", { class: `${k}-fixed`, role: "group" }, b("direct", TX("decision.ask.other"), () => ntDirect(n)), b("more", TX("decision.ask.more"), () => askSend(n, "more", {})), b("later", TX("decision.ask.later"), () => { ASK.later = id; askRepaint(); }));
}
function askCardNode(dc) {
  const n = askNoticeOf(dc);
  if (!n) return null;
  return el("div", { class: "dc-ask" }, ...[...askLines(n), askLeft(n)].filter(Boolean).map(t => el("div", { class: "dc-ask-st", role: "status", text: t })), askBtns(n, "dc"));
}
function askSig(dc) {
  const n = askNoticeOf(dc), d = n && n.decision;
  return n ? [ASK.later === String(n.id), ASK.busy === String(n.id), d.more_at || "", d.later_until || "", askLeft(n)] : 0;
}
function askClosed(d) {
  if (d.closed_how === "words") return { lb: TX("decision.closed.words"), ra: `"${d.words || ""}"` };
  if (d.closed_how === "expired") return { lb: TX("decision.closed.expired"), ra: "", again: true };
  return d.closed_how === "gone" ? { lb: TX("decision.closed.gone"), ra: "" } : null;
}
const askClosedLine = d => { const c = askClosed(d); return c ? [c.lb, c.ra].filter(Boolean).join(" · ") : ""; };
function askNotes() {
  const note = new Map();
  for (const n of NT.items) if (n.decision && n.decision.state === "open" && n.decision.judging) note.set(n.decision.judging.at, TX("decision.judging", { title: ntShort(ntPlain(n.title)) }));
  for (const n of NT.items) if (n.decision && n.decision.kept_open) note.set(n.decision.kept_open.at, TX("decision.kept_open"));
  for (const m of tl.querySelectorAll(".um[data-ts]")) {
    const text = note.get(m.dataset.ts) || "", old = m.querySelector(":scope > .ask-note");
    if (!text) { if (old) old.remove(); } else if (!old) m.append(el("div", { class: "ask-note", role: "status", text })); else if (old.textContent !== text) old.textContent = text;
  }
  dcQuestionLines();
}
function dqState(n) {
  const d = n.decision;
  if (ntOpenDec(n)) return TX("common.needs_reply");
  if (ntLater(n)) return TX("decision.ask.later_at", { t: kstHM(d.later_until) });
  if (d.state === "ignored") return TX("misc.nsc.d_ignored");
  if (d.expired) return TX("misc.nsc.d_expired");
  if (d.resolved) return askClosedLine(d) || TX("misc.nsc.d_closed");
  const said = ntPlain(d.answer || "").replace(/^\d+\)\s*/, "");
  return [d.hold && d.hold.state === "held" ? TX("decision.hold_lb") : TX("misc.nsc.d_answered"), said].filter(Boolean).join(" · ");
}
function dqRow(n) {
  const open = ntOpenDec(n);
  return el("button", { class: `dc-row dq${open ? " dq-open" : ""}`, type: "button", "data-nid": n.id, onclick: () => noticeSheetOpen(String(n.id)) },
    el("span", { class: "dc-tx" }, el("span", { class: "dc-lb", text: ntPlain(n.title) }), el("span", { class: "dc-ds" }, open ? el("span", { class: "tag warn", text: dqState(n) }) : dqState(n))));
}
const DQ_SIG = new WeakMap();
function dqPara(p, n) {
  const open = ntOpenDec(n), sig = JSON.stringify([n.id, n.decision.state, n.decision.answer || "", open, dqState(n)]);
  if (DQ_SIG.get(p) === sig) return;
  DQ_SIG.set(p, sig);
  p.dataset.nid = String(n.id);
  p.classList.add("dq-p");
  p.classList.toggle("dq-open", open);
  p.setAttribute("role", "button");
  p.tabIndex = 0;
  p.onclick = () => noticeSheetOpen(String(n.id));
  p.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); noticeSheetOpen(String(n.id)); } };
  const st = p.querySelector(":scope > .dq-st") || p.appendChild(el("span", { class: "dq-st" }));
  st.replaceChildren(open ? el("span", { class: "tag warn", text: dqState(n) }) : dqState(n));
}
function dcQuestionLines() {
  const on = current === "chat" && isFixedT(target);
  for (const m of tl.querySelectorAll(".bm[data-dat]")) {
    const first = on ? NT.items.find(x => ntIsDec(x) && !x.pc && x.decision.to === target && x.decision.reply_to === m.dataset.dat) : null, sibs = first ? ntSibs(first) : [], had = m.querySelector(":scope > .dq-list");
    const paras = new Map([...m.querySelectorAll("[data-q]")].map(p => [Number(p.dataset.q), p])), lone = [];
    for (const n of sibs) {
      const p = Number.isInteger(n.decision.place) ? paras.get(n.decision.place) : null;
      if (p) dqPara(p, n); else lone.push(n);
    }
    if (!lone.length) { if (had) had.remove(); continue; }
    const sig = JSON.stringify(lone.map(n => [n.id, n.title, n.decision.state, n.decision.answer || "", ntOpenDec(n)]));
    if (had && had.dataset.sig === sig) continue;
    const box = had || m.appendChild(el("div", { class: "dq-list", role: "group", "aria-label": TX("decision.q_lines") }));
    box.dataset.sig = sig;
    box.replaceChildren(...lone.map(dqRow));
  }
}
