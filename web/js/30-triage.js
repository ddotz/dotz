/* ---------- 빠른 처리: many waiting send approvals of one app instance, answered fast (hub/approval-wire.ts, docs/layers.md section 5) ---------- */
// The UI adapts to the workload: with `triageMin` (web.triage_min, default 3) or more waiting cards in one group (an app instance: a mail
// category, a comment source), the 답장 대기 screen's head offers 빠른 처리 and opening one of those cards opens it here instead of the one-card sheet.
// One item fills the view (what it answers, the lines above the draft, the draft and its mail, files, rule), the draft text is edited in
// place, and 보내기 / 고치기 / 보내지 않기 answer it and move on at once: the answer goes out in the background (POST /api/approvals) and the
// gateway sends it itself; each card's progress comes back as approval_send events. 목록 shows every card of the group with its whole draft
// and a pick per card; 확인한 것 보내기 answers the picked ones together. Nothing is sent that was not picked one by one.
const TR = { groups: [], min: 3, results: {}, t: 0, h: null, key: "", label: "", items: [], i: 0, list: false, picks: {}, edits: {}, notes: {}, done: {}, org: {}, open: {}, busy: {}, noting: false };
const trK = c => `${c.to}|${c.ref}`;
const trQ = c => draftQ(c.question);

async function trLoad() {
  let r;
  // A failed refresh keeps what was shown (the next notice event tries again); a failed answer is reported where it was made.
  try { r = await api("/api/approvals"); } catch { return; }
  TR.groups = Array.isArray(r.groups) ? r.groups : [];
  TR.min = Number(r.triageMin) > 0 ? Number(r.triageMin) : 3;
  // A send the gateway no longer holds (its frame was lost, or it restarted) does not stay 보내는 중 here.
  for (const x of Object.values(TR.results)) if ((x.state === "queued" || x.state === "sending") && !(r.results || []).some(y => y.ref === x.ref)) delete TR.results[x.ref];
  for (const x of r.results || []) TR.results[x.ref] = x;
  TR.loaded = true;
  if (current === "monitoring" && MON.sel === "replies" && !(TR.h && TR.h.pane)) { MON.sig = ""; monSchedule(); }   // the queue's head offers 빠른 처리 once enough wait (an open pane stands where the queue is drawn: left alone, so a typed note keeps its focus)
  if (TR.h) trMerge();
  paintDecision();   // a conversation with 2 or more waiting cards shows the 답장 초안 line (10-decision-card.js)
  monAttnSoon(); homeSoon();
}
const trSoon = () => { clearTimeout(TR.t); TR.t = setTimeout(trLoad, 300); };
const trBig = () => TR.groups.filter(g => g.count >= TR.min);
// Key "*" = the review queue: every waiting draft of every comment app and mail app in one walk.
const trCards = key => (key === "*" ? TR.groups.flatMap(g => g.cards) : (TR.groups.find(x => x.key === key) || { cards: [] }).cards);
const trKst = at => new Date(at).toLocaleString(TX_LOCALE, { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
/** The group a waiting card is in, when it is one the triage view takes (big enough). */
const trGroupFor = ref => trBig().find(g => g.cards.some(c => c.ref === ref));


// 모니터링 on a wide screen: the screen stands in the right column of the frame, in place of the queue (the reply card's pane, 30-replies.js rqPaneOpen); the list stays at the left.
// It is RQ.sheet, so the queue's own redraw, back and item changes treat it like that card. Back, the browser's back and Esc close it one step.
const trPaneNow = () => current === "monitoring" && !narrowChat() && !!$("#v-monitoring.rq-on");
function trPaneOpen(onClose) {
  if (RQ.sheet) RQ.sheet.close(false);
  RQ.top = $("#mon-timeline").scrollTop;
  let ov = null, closed = false;
  const box = el("div", { class: "rq-pane tr-pane", tabindex: "-1", onkeydown: ev => { if (ev.key === "Escape" && !document.querySelector("dialog[open]:not([data-leaving])")) { ev.preventDefault(); ev.stopPropagation(); h.close(); } } });
  const h = { pane: true, tr: true, box, close() {
    if (closed) return;
    closed = true; ovDone(ov); onClose();
    if (RQ.sheet === h) { RQ.sheet = null; RQ.cur = ""; MON.sig = ""; monSchedule(); }
  } };
  ov = ovOpen(() => h.close());
  RQ.sheet = h; MON.sig = ""; renderMonitoring();   // drawn now, so the box is on the page when it takes the focus
  return h;
}
// The queue row of the card on screen is the marked one (what the reply card does for its row), seen when the pane closes.
const trMarkRow = c => { const r = c && (RQ.rows || rqRows()).find(x => x.x && rqRefOf(x.x) === c.ref); if (r) RQ.mark = r.key; };
// A pane shares the page: its keys answer only while the focus is on it or on nothing, never in a field or control elsewhere.
const trAway = ev => current !== "monitoring" || RQ.sheet !== TR.h || (ev.target instanceof Element && ev.target !== document.body && !TR.h.box.contains(ev.target));
function trOpen(key, ref) {
  const g = TR.groups.find(x => x.key === key), cards = trCards(key);
  if (!cards.length) { toast(TX("triage.none")); return; }
  if (TR.h) TR.h.close(false);
  Object.assign(TR, { key, label: g ? g.label : TX("mon.filter.all"), items: cards.slice(), list: false, picks: {}, edits: {}, notes: {}, done: {}, open: {}, busy: {}, noting: false });
  TR.i = Math.max(0, ref ? TR.items.findIndex(c => c.ref === ref) : 0);
  const onClose = () => { if (TR.h === h) TR.h = null; document.removeEventListener("keydown", trKey); };
  const h = trPaneNow() ? trPaneOpen(onClose) : fsOpen({ label: TX("triage.fs.label", { label: TR.label }), cls: "tall tr", onClose });
  TR.h = h;
  document.addEventListener("keydown", trKey);
  trPaint();
  h.box.focus({ preventScroll: true });
}

// New cards of the group join at the end; a card answered elsewhere (another window, Discord, the bot) leaves the walk (the backend closed it),
// while one answered here stays with its progress chip.
function trMerge() {
  const cards = trCards(TR.key), now = new Set(cards.map(trK));
  let changed = false;
  for (const c of cards) if (!TR.items.some(x => trK(x) === trK(c))) { TR.items.push(c); changed = true; }
  const cur = TR.items[TR.i], kept = TR.items.filter(c => now.has(trK(c)) || TR.done[trK(c)]);
  if (kept.length !== TR.items.length) {
    TR.items = kept; changed = true;
    const j = cur ? kept.indexOf(cur) : -1;
    TR.i = j >= 0 ? j : Math.min(TR.i, kept.length);
    TR.noting = false;
  }
  if (changed) trPaint();
}

// What a card's send is doing now: the local answer first, then the gateway's own progress (approval_send).
function trState(c) {
  const d = TR.done[trK(c)];
  if (!d) return null;
  if (d.state === "send") {
    const r = TR.results[c.ref];
    return r && r.at >= d.at - 5000 ? { state: r.state, text: r.text } : { state: c.sendable ? "queued" : "bot" };
  }
  return d;
}
const TR_ST = { drop: TX("decision.not_sent"), undo: TX("decision.toast.sending_soon"), back: TX("decision.not_sent"), queued: TX("triage.st.queued"), sending: TX("decision.pending.send"), sent: TX("decision.sent"), failed: TX("triage.st.failed"), unsure: TX("triage.st.unsure"), bot: TX("triage.st.bot"), edit: TX("triage.st.edit"), gone: TX("triage.st.gone"), err: TX("triage.st.err") };
const trChip = c => {
  const s = trState(c);
  if (s && s.state === "undo") return el("span", { class: "tr-st undo", "data-trst": trK(c) }, TR_ST.undo, el("button", { class: "btn text sm", type: "button", onclick: () => trUndo(c) }, TX("decision.undo.cancel")));
  return s ? el("span", { class: `tr-st ${s.state}`, "data-trst": trK(c), title: s.text || null, text: TR_ST[s.state] || s.state }) : el("span", { class: "tr-st", "data-trst": trK(c), hidden: true });
};
// The reason behind 확인이 필요해요 / 보내지 못했어요 as visible text under the card's header (the chip's title is not seen on a phone).
const trWhy = c => {
  const s = trState(c), t = s && (s.state === "unsure" || s.state === "failed") ? s.text : "";
  return el("div", { class: "tr-why", "data-trwhy": trK(c), role: "note", text: t || "", hidden: !t });
};
// 보내기 취소 inside the gateway's cancel window: nothing is sent and the card waits again.
async function trUndo(c) {
  if (!(await dcUndoPost(c.ref))) return;
  delete TR.done[trK(c)];
  await trLoad(); trPaint();
}
function trLive(e) {
  if (!e || !e.ref) return;
  TR.results[e.ref] = e;
  if (!TR.h) return;
  for (const c of TR.items) if (c.ref === e.ref) {
    const n = TR.h.box.querySelector(`[data-trst="${CSS.escape(trK(c))}"]`), next = trChip(c);
    if (n) n.replaceWith(next);
    const w = TR.h.box.querySelector(`[data-trwhy="${CSS.escape(trK(c))}"]`);
    if (w) w.replaceWith(trWhy(c));
  }
  if (TR.i >= TR.items.length) trPaint();
}

function trNext() {
  TR.noting = false;
  const j = TR.items.findIndex((c, i) => i > TR.i && !TR.done[trK(c)]);
  TR.i = j < 0 ? TR.items.length : j;
  trPaint();
}

// Each item names the label of its button (1 보내기, 2 고치기, 3 보내지 않기); a hub that refuses a changed card (409) makes the list read again.
const TR_LABEL = { 1: "보내기", 2: "고치기", 3: "보내지 않기", 4: "이대로 보내기" };
async function trPost(items) {
  try {
    const r = await api("/api/approvals", "POST", { items: items.map(i => ({ ...i, label: TR_LABEL[i.n] })) });
    if (r && r.error) throw new Error(r.error);
    return r;
  } catch (e) {
    if (e && e.message === NT_STALE) await trLoad();
    throw e;
  }
}
// The owner's own words replace the draft's text before it is sent (POST /api/drafts/<ref>/body).
async function trSaveEdits(c) {
  const k = trK(c), e = TR.edits[k] || {}, d = c.draft || {};
  if (e.reply != null && e.reply.trim() && e.reply.trim() !== String(d.body || "").trim()) await api(`/api/drafts/${enc(c.ref)}/body`, "POST", { text: e.reply });
  if (d.mail && e.mail != null && e.mail.trim() && e.mail.trim() !== String(d.mail.body || "").trim()) await api(`/api/drafts/${enc(c.ref)}/body`, "POST", { text: e.mail, part: "mail" });
}
// Answers one card and moves on once the gateway took the answer. While it waits, the card's buttons stay in place, disabled, and the pressed one says what is
// happening (the 답장 확인 sheet's way); a second press is ignored. A failure keeps the owner on that card, with the reason where the buttons are and nothing counted.
const TR_BUSY = { 1: TX("decision.pending.send"), 2: TX("decision.pending.edit"), 3: TX("decision.pending.drop") };
// 보내기 goes through the reply card's own refusals: a mail whose files disagree with its words is sent only by 이대로 보내기 (pick 4, after the same
// question), and a draft with files or a warning on an account that cannot send files asks once more (drfSure). Answering no leaves the card as it was.
const TR_SURE = new Set(), TR_SEEN = new Set();
const trIssues = d => [...(d.attachIssues || []), ...((d.mail && d.mail.attachIssues) || [])];
const trNeedsSure = d => trIssues(d).length > 0 || !!d.warning || (d.attachments || []).length > 0;
async function trSure(c) {
  const d = { ...(c.draft || {}), ref: (c.draft && c.draft.ref) || c.ref }, issues = trIssues(d);
  let n = 1;
  if (issues.length) {
    const list = issues.join(". ");
    if (!(await ask(TX("decision.attach.check_title"), d.to ? TX("decision.attach.asis_to", { to: d.to, issues: list }) : TX("decision.attach.asis", { issues: list }), TX("decision.attach.send_asis")))) return 0;
    n = 4;
  }
  return (!d.warning && !(d.attachments || []).length) || (await drfSure(d, c.to)) ? n : 0;
}
async function trAnswer(c, n, note) {
  const k = trK(c), idle = () => !TR.busy[k] && !TR_SURE.has(k) && !(TR.done[k] && TR.done[k].state !== "err");
  if (!idle()) return;
  if (n === 1 && trNeedsSure(c.draft || {})) {
    TR_SURE.add(k);
    try { n = await trSure(c); } finally { TR_SURE.delete(k); }
    if (!n || !idle()) return;
  }
  TR.busy[k] = n === 4 ? 1 : n;
  trPaint();
  let fail = null;
  try {
    if (n === 1 || n === 4) await trSaveEdits(c);
    await trPost([{ ref: c.ref, to: c.to, n, ...(note ? { note } : {}) }]);
  } catch (err) { fail = err; }
  delete TR.busy[k];
  TR.done[k] = fail ? { state: "err", text: fail.message } : { state: n === 1 || n === 4 ? "send" : n === 3 ? "drop" : "edit", at: Date.now() };
  if (fail || !TR.items[TR.i] || trK(TR.items[TR.i]) !== k) trPaint(); else trNext();
}
// ← / →: look at the previous / next card without answering (the last step past the end shows the summary).
const trStep = d => { const j = TR.i + d; if (j < 0 || j > TR.items.length) return; TR.i = j; TR.noting = false; trPaint(); };
const trLocked = c => { const s = TR.done[trK(c)]; return !!TR.busy[trK(c)] || (!!s && s.state !== "err"); };

function trKey(ev) {
  if (!TR.h || (TR.h.pane ? trAway(ev) : FS[FS.length - 1] !== TR.h) || document.querySelector("dialog[open]:not([data-leaving])")) return;
  const typing = ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement;
  const c = TR.items[TR.i];
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
    ev.preventDefault();
    if (TR.list) trSendPicked();
    else if (c && TR.noting) trEditSubmit(c);
    else if (c) trAnswer(c, 1);
    return;
  }
  if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === "l") { ev.preventDefault(); TR.list = !TR.list; trPaint(); }
  else if (TR.list) return;
  else if (k === "arrowright" || k === "j") { ev.preventDefault(); trStep(1); }
  else if (k === "arrowleft" || k === "k") { ev.preventDefault(); trStep(-1); }
  else if (!c || TR.noting || trLocked(c) || (k === "enter" && ev.target instanceof HTMLElement && ev.target.closest("button, a"))) return;
  else if (k === "enter" || k === "1") { ev.preventDefault(); trAnswer(c, 1); }
  else if (k === "2" || k === "e") { ev.preventDefault(); TR.noting = true; trPaint(); }
  else if (k === "3" || k === "x") { ev.preventDefault(); trAnswer(c, 3); }
}

function trEditSubmit(c) {
  const note = (TR.notes[trK(c)] || "").trim();
  if (!note) { toast(TX("triage.note.need"), true); return; }
  trAnswer(c, 2, note);
}

/* ---- drawing ---- */
function trPaint() {
  if (!TR.h) return;
  if (TR.h.pane) trMarkRow(TR.items[TR.i]);
  const box = TR.h.box, n = TR.items.length, handled = TR.items.filter(c => TR.done[trK(c)] && TR.done[trK(c)].state !== "err").length;   // a failed answer is not counted
  const bar = el("div", { class: "tr-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(n), "aria-valuenow": String(handled), "aria-label": TX("triage.bar") }, el("span", { style: `width:${n ? (handled / n) * 100 : 0}%` }));
  const pos = TR.i < n ? `${TR.i + 1}/${n}` : `${n}/${n}`;
  const head = fsHead([el("span", { class: "fs-ey" }, TX("triage.head.ey", { label: TR.label })), el("h2", { class: "fs-t tr-pos" }, TR.list ? TX("triage.head.list", { n }) : pos, el("span", { class: "tr-sum", text: ` · ${TX("triage.head.done", { n: handled })}` })), bar], { close: () => TR.h && TR.h.close() });
  const tog = el("button", { class: "btn text sm tr-tog", type: "button", "aria-pressed": String(TR.list), onclick: () => { TR.list = !TR.list; trPaint(); } }, icon("list"), el("span", { text: TR.list ? TX("triage.tog.one") : TX("triage.tog.list") }));
  $(".fs-hb", head).prepend(tog);
  // a paint that shows other cards (moved on, or the list changed) goes through even while a card's text is being typed in
  if (!paintKeep(box, [head, ...(TR.list ? trListView() : TR.i >= n ? trDoneView() : trOneView(TR.items[TR.i]))], trPaint, TR.list ? TR.items.map(trK).join() : TR.i < n ? trK(TR.items[TR.i]) : "")) return;
  const t = $(".tr-note", box) || null;
  if (t && TR.noting) t.focus({ preventScroll: true });
}

// The four things the owner decides on, in this order on every card whatever its kind: 받는 사람, 원본, 답장, 첨부. The parts are the reply card's own
// (draftToNode, rqOrigNode, draftFilesNode, rqAttachNode); this screen only puts them under four fixed labels.
const trSec = (name, label, ...kids) => el("div", { class: "tr-sec", role: "group", "data-sec": name, "aria-label": label }, el("div", { class: "tr-k", text: label }), ...kids.filter(Boolean));
const trNone = text => el("div", { class: "tr-none", role: "status", text });
const trRow = (label, value) => el("div", { class: "rq-to dr-to" }, el("span", { class: "dr-k", text: label }), el("span", { class: "dr-chip", title: value || "", text: value || "-" }));
// The original a card answers as { who, text }: the comment, the mail the list call carried (c.original), or what the per-card read brought; null when there is none.
function trOrigSrc(c) {
  const x = c.comment, o = c.original, r = TR.org[c.ref];
  if (x) return { who: [x.who, x.at ? trKst(x.at) : ""].filter(Boolean).join(" · "), text: x.text || "" };
  if (o && trCutLoaded(c)) return { who: [mailSender(o.from), o.at ? trKst(o.at) : ""].filter(Boolean).join(" · "), text: mailOwnBody(r.text, r.subject || o.subject) };
  if (o) return { who: [mailSender(o.from), o.at ? trKst(o.at) : ""].filter(Boolean).join(" · "), text: mailOwnBody(o.text, o.subject) };
  if (!r) return null;
  return r.kind === "mail" ? { who: mailSender(r.from), text: mailOwnBody(r.text, r.subject) } : { who: [r.author, r.post && r.post.title].filter(Boolean).join(" · "), text: r.text };
}
// The list carries only the start of a long mail (original.cut): the whole text is read once when the card opens or its row is pressed. A hub that sent no original
// at all gets it read once per card, as before.
const trCutLoaded = c => !!(c.original && c.original.cut && TR.org[c.ref] && TR.org[c.ref].kind === "mail");
function trOrigLoad(c, whole) {
  const k = c.ref;
  if (c.comment || TR.org[k] !== undefined || (c.original && !(whole && c.original.cut))) return;
  TR.org[k] = null;
  api(`/api/drafts/${enc(c.ref)}/original`).then(r => { TR.org[k] = r && !r.error ? r : false; }, () => { TR.org[k] = false; }).then(() => { if (TR.h && (TR.list || (TR.items[TR.i] && TR.items[TR.i].ref === k))) trPaint(); });
}
// 받는 사람: a mail's 받는이 and 참조 rows (read only), its subject, the sending account when the install has more than one; a comment's target and post;
// the recipient of the mail that goes along with a comment reply.
function trToNodes(c) {
  const d = c.draft || {}, x = c.comment, m = d.mail;
  return [
    d.recipientWarning ? el("div", { class: "dr-warn dc-rw", role: "alert" }, el("span", { text: TX("decision.rcpt.check", { warning: d.recipientWarning }) })) : null,
    d.toLabel === "받는이" ? draftToNode({ ...d, ref: d.ref || c.ref }, { t: c.to, edit: false, always: true }) : trRow(d.toLabel || TX("decision.to"), d.to),
    d.toLabel === "받는이" && d.subject ? el("div", { class: "dr-sub rq-sub", text: d.subject }) : null,
    x && x.post ? trRow(TX("triage.post"), x.post) : null,
    c.account && c.account.many ? trRow(TX("triage.account"), c.account.label) : null,
    m ? trRow(TX("decision.mail.along"), [m.to, m.subject].filter(Boolean).join(" · ")) : null];
}
// 원본: the quote of the reply card (open here, in a box that scrolls, so a long mail never pushes the reply off the screen), the post a comment sits on,
// one muted line when the card answers nothing, and what the thread did since the draft was made.
function trOrigNodes(c) {
  trOrigLoad(c, true);
  const key = `tr:${trK(c)}`, src = trOrigSrc(c), x = c.comment, o = c.original, t = c.thread, has = !!src && !!(src.who || src.text.trim());
  if (!TR_SEEN.has(key)) { TR_SEEN.add(key); RQ_OG.add(key); }   // a card starts with its original open; the owner's 원문 접기 stays
  const quote = has ? rqOrigNode(key, src) : null;
  return [
    x ? el("div", { class: "tr-cmt" }, x.post ? el("div", { class: "tr-post", text: x.post }) : null, quote, x.mailMark ? el("span", { class: "tag", "data-mail": x.mailMark.state, text: x.mailMark.label }) : null) : quote,
    has ? null : trNone(TR.org[c.ref] === null ? TX("triage.org_loading") : TX("triage.no_org")),
    o && o.cut && !trCutLoaded(c) ? trNone(TX("triage.org_cut")) : null,
    t && t.newer ? el("div", { class: "dr-warn", role: "status" }, el("span", { text: TX("triage.thread_newer") })) : null,
    t && t.earlier > 0 ? trNone(TX("triage.thread_earlier", { n: t.earlier })) : null];
}
// 첨부: the send sheet's file rows (each opens the staged file) with their warnings, the mail that goes along with a comment reply likewise, or the plain 첨부: 없음.
function trAttNodes(c) {
  const d = c.draft || {}, m = d.mail, mref = m && (m.ref || m.id), n = (d.attachments || []).length + (m ? (m.attachments || []).length : 0);
  return [
    draftFilesNode({ ...d, ref: d.ref || c.ref }, { t: c.to, edit: false }),
    m ? draftFilesNode(mref ? { ...m, ref: mref } : m, { t: c.to, edit: false, live: !!mref }) : null,
    n ? null : rqAttachNode({})];
}
// A row of the list: the file names, or how many when there are many.
function trRowFiles(c) {
  const d = c.draft || {}, fl = [...(d.attachments || []), ...((d.mail && d.mail.attachments) || [])];
  if (!fl.length) return trNone(TX("triage.row.no_files"));
  return el("div", { class: "tr-files", title: fl.map(f => f.name).join(", ") }, ...(fl.length > 3 ? [el("span", { class: "tr-file", text: TX("decision.attach.count", { n: fl.length }) })] : fl.map(f => el("span", { class: "tr-file", text: f.size ? `${f.name} (${f.size})` : f.name }))));
}
// A row of the list: the original as two lines that open fully on a press (the reply card's quote, its 원문 보기 on the quote itself).
function trRowOrig(c, k) {
  trOrigLoad(c);
  const src = trOrigSrc(c);
  if (!src || !(src.who || src.text.trim())) return trNone(TR.org[c.ref] === null ? TX("triage.org_loading") : TX("triage.no_org"));
  const wrap = rqOrigNode(`trl:${k}`, src), btn = $(".rq-og", wrap);
  if (btn) wrap.firstChild.onclick = () => btn.click();
  if (c.original && c.original.cut) wrap.addEventListener("click", () => trOrigLoad(c, true));
  return wrap;
}

function trOneView(c) {
  const k = trK(c), d = c.draft || {}, st = trState(c), gone = dcGone(c.to), busy = TR.busy[k] || 0, locked = gone || !!busy || (!!st && st.state !== "err");
  const e = (TR.edits[k] ||= {});
  // A draft the gateway cannot change in place (a block a session wrote) is read here and goes back to the session with 고치기.
  const area = (part, value) => c.editable === false ? draftBodyNode(value, "dc-dr-b") : el("textarea", { class: "tr-ta", rows: "6", "aria-label": part === "mail" ? TX("decision.mail.along_body") : TX("decision.body_label"), disabled: locked, oninput: ev => { e[part] = ev.target.value; trSendLabel(c); } }, value);
  const body = el("div", { class: "fs-body tr-body", tabindex: "-1" },
    el("div", { class: "tr-q" }, el("span", { text: trQ(c) || TX("triage.q.default") }), trChip(c)),
    trWhy(c),
    decideNode(d),
    trSec("to", TX("triage.sec.to"), ...trToNodes(c)),
    trSec("org", TX("triage.sec.org"), ...trOrigNodes(c)),
    c.info && c.info.length ? el("ul", { class: "tr-info" }, ...c.info.map(l => el("li", { text: l }))) : null,
    trSec("reply", TX("triage.sec.reply"), draftRuleNode(d), area("reply", e.reply ?? d.body ?? ""), !c.sendable ? el("span", { class: "tr-rule", text: TX("triage.bot_sends") }) : null,
      d.mail ? el("div", { class: "tr-mail" }, el("div", { class: "tr-k", text: TX("decision.mail.along") }), area("mail", e.mail ?? d.mail.body ?? "")) : null),
    trSec("att", TX("triage.sec.att"), ...trAttNodes(c)));
  const foot = el("div", { class: "fs-ft tr-ft" });
  // a failed answer: the reason stands where the buttons are (the card stays, its head says which answer failed)
  if (st && st.state === "err") foot.append(el("div", { class: "tr-hint tr-fail", role: "alert", text: st.text ? TX("triage.fail.with", { text: st.text }) : TX("triage.fail.plain") }));
  if (TR.noting && !locked || busy === 2) {
    foot.append(el("textarea", { class: "dc-note tr-note", rows: "3", placeholder: TX("triage.note.ph"), "aria-label": TX("triage.note.aria"), oninput: ev => { TR.notes[k] = ev.target.value; } }, TR.notes[k] || ""),
      el("div", { class: "tr-acts" }, el("button", { class: "btn tr-b tr-go", type: "button", disabled: !!busy, onclick: () => trEditSubmit(c) }, busy ? TR_BUSY[2] : TX("decision.revise.go")), el("button", { class: "btn text tr-b", type: "button", disabled: !!busy, onclick: () => { TR.noting = false; trPaint(); } }, TX("common.cancel"))));
  } else {
    // The reply card's three actions in its order (the prototype's #triage): 보내기, 고치기, then the quiet 보내지 않기.
    foot.append(el("div", { class: "tr-acts" },
      el("button", { class: "btn tr-b tr-go", type: "button", disabled: locked, onclick: () => trAnswer(c, 1) }, busy === 1 ? TR_BUSY[1] : trSendText(c)),
      el("button", { class: "btn tonal tr-b", type: "button", disabled: locked, onclick: () => { TR.noting = true; trPaint(); } }, TX("decision.edit")),
      el("button", { class: "btn text tr-b", type: "button", disabled: locked, onclick: () => trAnswer(c, 3) }, busy === 3 ? TR_BUSY[3] : TX("decision.drop"))),
      ...(gone ? [el("div", { class: "tr-hint", text: DC_GONE })] : []),   // foot.append turns a null into the word "null"
      el("div", { class: "tr-nav" }, el("button", { class: "btn text tr-b", type: "button", "aria-label": TX("triage.nav.prev_aria"), disabled: TR.i === 0, onclick: () => trStep(-1) }, TX("triage.nav.prev")), el("button", { class: "btn text tr-b", type: "button", "aria-label": TX("triage.nav.next_aria"), onclick: () => trStep(1) }, TX("triage.nav.next"))),
      el("div", { class: "tr-keys", text: TX("triage.keys.one") }));
  }
  return [body, foot];
}
const trEdited = c => {
  const e = TR.edits[trK(c)] || {}, d = c.draft || {};
  return (e.reply != null && e.reply.trim() !== String(d.body || "").trim()) || (!!d.mail && e.mail != null && e.mail.trim() !== String(d.mail.body || "").trim());
};
const trSendText = c => (trEdited(c) ? TX("triage.send_edited") : TX("common.send"));
function trSendLabel(c) { const b = TR.h && $(".tr-go", TR.h.box); if (b) b.textContent = trSendText(c); }

function trDoneView() {
  const by = s => TR.items.filter(c => { const x = trState(c); return x && x.state === s; }).length;
  const skipped = TR.items.filter(c => !TR.done[trK(c)]).length;
  const rows = [[TX("decision.sent"), by("sent")], [TX("decision.not_sent"), by("drop")], [TX("mon.cm.st.sending"), by("queued") + by("sending")], [TX("triage.st.failed"), by("failed") + by("err")], [TX("triage.st.unsure"), by("unsure")], [TX("triage.done.bot"), by("edit") + by("bot")], [TX("triage.done.skipped"), skipped]].filter(([, v]) => v);
  const body = el("div", { class: "fs-body tr-body tr-empty" }, el("div", { class: "tr-done-t", text: skipped ? TX("triage.done.seen") : TX("triage.done.all") }), el("ul", { class: "tr-sumlist" }, ...rows.map(([t, v]) => el("li", {}, el("span", { text: t }), el("b", { text: TX("triage.done.n", { n: v }) })))));
  const foot = el("div", { class: "fs-ft tr-ft" }, el("div", { class: "tr-acts" },
    skipped ? el("button", { class: "dc-act alt tr-b", type: "button", onclick: () => { TR.i = TR.items.findIndex(c => !TR.done[trK(c)]); trPaint(); } }, TX("triage.done.back")) : null,
    el("button", { class: "dc-act main tr-b", type: "button", onclick: () => TR.h && TR.h.close() }, TX("common.close"))));
  return [body, foot];
}

// The third choice of the list only leaves the card waiting (trSendPicked posts the first two): it says 건너뛰기, never the 보내지 않기 of the one-card view, which drops the draft.
const TR_PICK = [[1, TX("common.send")], [2, TX("decision.edit")], [3, TX("triage.skip")]];
function trListView() {
  const picked = TR.items.filter(c => !TR.done[trK(c)] && (TR.picks[trK(c)] === 1 || (TR.picks[trK(c)] === 2 && (TR.notes[trK(c)] || "").trim()))).length;
  const body = el("div", { class: "fs-body tr-body tr-list" }, ...TR.items.map((c, i) => {
    const k = trK(c), d = c.draft || {}, st = trState(c), locked = dcGone(c.to) || (!!st && st.state !== "err"), p = TR.picks[k] || 0;   // no choice stands marked before the owner presses one
    return el("div", { class: `tr-row${locked ? " locked" : ""}` },
      el("button", { class: "tr-rh", type: "button", onclick: () => { TR.i = i; TR.list = false; trPaint(); } }, el("span", { class: "tr-n", text: String(i + 1) }), el("span", { class: "tr-rq", text: [d.to, trQ(c)].filter(Boolean).join(" · ") }), trChip(c)),
      trWhy(c),
      trRowOrig(c, k),
      draftBodyNode((TR.edits[k] && TR.edits[k].reply) ?? d.body ?? "", `tr-rb${p === 1 || TR.open[k] ? " open" : ""}`, { title: TX("triage.row.open"), onclick: ev => { TR.open[k] = ev.currentTarget.classList.toggle("open"); } }),
      d.mail ? el("div", { class: `tr-rb mail${p === 1 || TR.open[k] ? " open" : ""}`, onclick: ev => { TR.open[k] = ev.currentTarget.classList.toggle("open"); }, text: `${d.mail.subject ? TX("triage.row.mail_subj", { to: d.mail.to || "", subject: d.mail.subject }) : TX("triage.row.mail", { to: d.mail.to || "" })}\n${(TR.edits[k] && TR.edits[k].mail) ?? d.mail.body ?? ""}` }) : null,
      trRowFiles(c),
      locked ? null : el("div", { class: "tr-seg", role: "radiogroup", "aria-label": TX("triage.row.card", { n: i + 1 }) }, ...TR_PICK.map(([n, t]) => el("button", { class: `tr-sg${p === n ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(p === n), onclick: () => { TR.picks[k] = n; trPaint(); } }, t))),
      !locked && p === 2 ? el("input", { class: "tr-rn", type: "text", placeholder: TX("decision.revise.ask"), value: TR.notes[k] || "", "aria-label": TX("triage.row.note_aria", { n: i + 1 }), oninput: ev => { TR.notes[k] = ev.target.value; trListCount(); } }) : null);
  }));
  const foot = el("div", { class: "fs-ft tr-ft" }, el("div", { class: "tr-acts" }, el("button", { class: "dc-act main tr-b tr-batch", type: "button", disabled: !picked, onclick: trSendPicked }, picked ? TX("triage.batch_n", { n: picked }) : TX("triage.batch"))), el("div", { class: "tr-keys", text: TX("triage.keys.list") }));
  return [body, foot];
}
function trListCount() {
  const b = TR.h && $(".tr-batch", TR.h.box);
  if (!b) return;
  const n = TR.items.filter(c => !TR.done[trK(c)] && (TR.picks[trK(c)] === 1 || (TR.picks[trK(c)] === 2 && (TR.notes[trK(c)] || "").trim()))).length;
  b.disabled = !n;
  b.textContent = n ? TX("triage.batch_n", { n }) : TX("triage.batch");
}

async function trSendPicked() {
  if (TR_SURE.has("*")) return;
  const want = TR.items.filter(c => !TR.done[trK(c)] && (TR.picks[trK(c)] === 1 || (TR.picks[trK(c)] === 2 && (TR.notes[trK(c)] || "").trim()))), go = [], ns = {};
  let kept = 0;
  TR_SURE.add("*");
  try {
    for (const c of want) {
      const k = trK(c);
      if (TR.picks[k] === 1 && trNeedsSure(c.draft || {})) {
        const n = await trSure(c);
        if (!n) { TR.picks[k] = 0; kept++; continue; }
        ns[k] = n;
      }
      if (!TR.done[k]) go.push(c);
    }
  } finally { TR_SURE.delete("*"); }
  if (kept) toast(TX("triage.kept", { n: kept }));
  if (!go.length) { trPaint(); return; }
  const at = Date.now();
  for (const c of go) TR.done[trK(c)] = { state: TR.picks[trK(c)] === 1 ? "send" : "edit", at };
  trPaint();
  try {
    for (const c of go) if (TR.picks[trK(c)] === 1) await trSaveEdits(c);
    const r = await trPost(go.map(c => ({ ref: c.ref, to: c.to, n: ns[trK(c)] ?? TR.picks[trK(c)], ...(TR.picks[trK(c)] === 2 ? { note: TR.notes[trK(c)].trim() } : {}) })));
    toast(r.sending ? TX("triage.answered_sending", { n: go.length, sending: r.sending }) : TX("triage.answered", { n: go.length }));
  } catch (err) {
    for (const c of go) TR.done[trK(c)] = { state: "err", text: err.message };
    trPaint();
    toast(TX("triage.send_fail", { msg: err.message }), true);
  }
}

/* ---- 빠른 처리 over the one reply queue (design 4.4, mockups 7 and 8): every waiting item of every channel and computer, the same card ---- */
// One by one: the head counts the place and the channels, the card is rqItemCard with the filled 보내기, and 진행 lists every item with its live state.
// After 보내기 the view moves on at once; the send waits its undo window in the common queue and its state shows in the rail. 목록: one compact row per item,
// 보내기 | 고치기 | 건너뛰기 picked per row, and 고른 것 처리 posts only the picks. Keys: Enter 보내기, E 직접 수정, X 보내지 않기, → 건너뛰기, ← back, L list.
const TQ = { h: null, items: [], i: 0, list: false, picks: {}, notes: {} };
const tqItem = ref => RA.items.get(ref) || TQ.items.find(i => i.ref === ref);
const TQ_ST = { undo: "reply.q.st.undo", queued: "reply.sending", sending: "reply.sending", sent: "reply.q.st.sent", failed: "reply.q.st.failed", unsure: "reply.q.st.unsure" };
function tqStateOf(ref) {
  const it = tqItem(ref), s = it && it.send;
  if (s) return s.state;
  return it && it.draft.state === "dropped" ? "dropped" : "";
}
function tqOpen(ref) {
  const items = raItems("waiting").sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!items.length) { toast(TX("triage.none")); return; }
  if (TQ.h) TQ.h.close(false);
  Object.assign(TQ, { items, i: Math.max(0, ref ? items.findIndex(i => i.ref === ref) : 0), list: false, picks: {}, notes: {} });
  const onClose = () => { if (TQ.h === h) TQ.h = null; document.removeEventListener("keydown", tqKey); };
  const h = trPaneNow() ? trPaneOpen(onClose) : fsOpen({ label: TX("triage.fast"), cls: "tall tr", onClose });
  TQ.h = h;
  document.addEventListener("keydown", tqKey);
  tqPaint();
  h.box.focus({ preventScroll: true });
}
const tqStep = d => { const j = TQ.i + d; if (j < 0 || j > TQ.items.length) return; TQ.i = j; tqPaint(); };
function tqKey(ev) {
  if (!TQ.h || (TQ.h.pane ? current !== "monitoring" || RQ.sheet !== TQ.h || (ev.target instanceof Element && ev.target !== document.body && !TQ.h.box.contains(ev.target)) : FS[FS.length - 1] !== TQ.h) || document.querySelector("dialog[open]:not([data-leaving])")) return;
  if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement || ev.metaKey || ev.ctrlKey || ev.altKey) return;   // keys do nothing while a field has the focus
  const k = ev.key.toLowerCase(), it = TQ.items[TQ.i] && tqItem(TQ.items[TQ.i].ref);
  if (k === "l") { ev.preventDefault(); TQ.list = !TQ.list; tqPaint(); return; }
  if (TQ.list) return;
  if (k === "arrowright") { ev.preventDefault(); tqStep(1); return; }
  if (k === "arrowleft") { ev.preventDefault(); tqStep(-1); return; }
  if (!it || RA.busy.has(it.ref) || it.send || (k === "enter" && ev.target instanceof HTMLElement && ev.target.closest("button, a"))) return;
  if (k === "enter" && it.can.send) { ev.preventDefault(); raAct(it, "send").then(ok => ok && tqAfter()); }
  else if (k === "e" && it.can.edit) { ev.preventDefault(); RA.edit.set(it.ref, it.draft.text); tqPaint(); const f = TQ.h.box.querySelector(".ra-edit"); if (f) f.focus(); }
  else if (k === "x" && it.can.drop) { ev.preventDefault(); raAct(it, "drop").then(ok => ok && tqAfter()); }
}
const tqAfter = () => { if (TQ.h) tqStep(1); };
function tqLive() { if (TQ.h) tqPaint(); }
function tqPaint() {
  if (!TQ.h) return;
  const n = TQ.items.length, handled = TQ.items.filter(i => tqStateOf(i.ref)).length, by = new Map();
  for (const i of TQ.items) by.set(i.label, (by.get(i.label) || 0) + 1);
  const bar = el("div", { class: "tr-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(n), "aria-valuenow": String(handled), "aria-label": TX("triage.bar") }, el("span", { style: `width:${n ? (handled / n) * 100 : 0}%` }));
  const head = fsHead([el("span", { class: "fs-ey", text: countsLine(by) }), el("h2", { class: "fs-t tr-pos", text: TQ.list ? TX("triage.head.list", { n }) : TX("reply.q.head", { i: Math.min(TQ.i + 1, n), n }) }), bar], { close: () => TQ.h && TQ.h.close() });
  const tog = el("button", { class: "btn text sm tr-tog", type: "button", "aria-pressed": String(TQ.list), onclick: () => { TQ.list = !TQ.list; tqPaint(); } }, icon("list"), el("span", { text: TQ.list ? TX("triage.tog.one") : TX("triage.tog.list") }));
  $(".fs-hb", head).prepend(tog);
  const body = TQ.list ? tqListView() : TQ.i >= n ? tqDoneView() : [rqItemCard(tqItem(TQ.items[TQ.i].ref), { lead: true, after: tqAfter }), tqRail()];
  const keep = TQ.h.box.querySelector("textarea:focus, input:focus");
  if (keep && TQ.h.box.contains(keep) && !TQ.list) return;   // typing in the card's field: the next event repaints
  clear(TQ.h.box).append(head, el("div", { class: "tq-body" }, ...body));
}
// 진행: every item and its live state; the one on screen is marked, a tap opens it.
function tqRail() {
  return el("div", { class: "tq-rail", role: "list", "aria-label": TX("reply.q.rail") }, el("div", { class: "tr-k", text: TX("reply.q.rail") }),
    ...TQ.items.map((i, k) => {
      const st = tqStateOf(i.ref), it = tqItem(i.ref), who = (it.original && String(it.original.who).replace(/\s*<[^<>]*>\s*$/, "")) || it.draft.to || it.label;
      return el("button", { class: `tq-r${k === TQ.i ? " on" : ""}${st === "failed" || st === "unsure" ? " bad" : ""}`, type: "button", role: "listitem", "data-ref": i.ref, onclick: () => { TQ.i = k; TQ.list = false; tqPaint(); } },
        el("span", { class: "tq-who", text: who }), el("span", { class: `tq-st${st === "failed" || st === "unsure" ? " err" : ""}`, text: k === TQ.i && !st ? TX("reply.q.st.now") : st === "dropped" ? TX("decision.not_sent") : TQ_ST[st] ? TX(TQ_ST[st], st === "undo" ? { n: Math.max(0, Math.ceil(((it.send.until || 0) - Date.now()) / 1000)) } : {}) : "" }));
    }));
}
function tqDoneView() {
  const bad = TQ.items.filter(i => ["failed", "unsure"].includes(tqStateOf(i.ref)));
  return [el("div", { class: "tr-none", role: "status", text: TX("reply.q.done", { n: TQ.items.filter(i => tqStateOf(i.ref)).length }) }),
    bad.length ? el("button", { class: "btn tonal sm", type: "button", "data-k": "fails", text: TX("reply.q.fails", { n: bad.length }), onclick: () => { TQ.items = bad; TQ.i = 0; tqPaint(); } }) : null, tqRail()].filter(Boolean);
}
// 목록: a pick per row; a revise opens a one-line field, and the new draft shows in the same row and waits for a new pick. Nothing unpicked is sent.
function tqListView() {
  const picked = Object.values(TQ.picks).filter(v => v === "send" || v === "revise").length;
  const rows = TQ.items.map(i => {
    const it = tqItem(i.ref), pick = TQ.picks[i.ref] || "", st = tqStateOf(i.ref);
    const b = (k, label) => el("button", { class: `btn ${pick === k ? "tonal" : "text"} sm`, type: "button", "aria-pressed": String(pick === k), "data-k": k, disabled: !!st || RA.busy.has(i.ref), text: label, onclick: () => { TQ.picks[i.ref] = pick === k ? "" : k; tqPaint(); } });
    const note = pick === "revise" ? el("input", { class: "kk-rv rq-rv", type: "text", maxlength: "500", placeholder: DRAFT_HINT, "aria-label": TX("decision.revise.what"), value: TQ.notes[i.ref] || "", oninput: ev => (TQ.notes[i.ref] = ev.target.value) }) : null;
    return el("div", { class: "tq-row", role: "group", "data-ref": i.ref },
      el("div", { class: "tq-line" }, el("span", { class: "tq-who", text: (it.original && String(it.original.who).replace(/\s*<[^<>]*>\s*$/, "")) || it.draft.to }), el("span", { class: "tq-app", text: it.label }), st ? el("span", { class: "tq-st", text: TQ_ST[st] ? TX(TQ_ST[st], { n: 0 }) : "" }) : null),
      el("div", { class: "tq-tx", text: it.draft.text }), note,
      el("div", { class: "dr-act dr-row rq-acts" }, b("send", TX("common.send")), b("revise", TX("decision.edit")), b("skip", TX("reply.q.skip"))));
  });
  return [...rows, el("div", { class: "tq-foot" }, el("button", { class: "btn sm", type: "button", "data-k": "go-picked", disabled: !picked, text: TX("reply.q.go", { n: picked }), onclick: tqGoPicked }))];
}
async function tqGoPicked() {
  for (const i of TQ.items) {
    const pick = TQ.picks[i.ref], it = tqItem(i.ref);
    if (pick === "send") await raAct(it, "send");
    else if (pick === "revise" && (TQ.notes[i.ref] || "").trim()) await raAct(it, "revise", { change: TQ.notes[i.ref].trim() });
    if (pick === "send" || pick === "revise") delete TQ.picks[i.ref];
  }
  tqPaint();
}
