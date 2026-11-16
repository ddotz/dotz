/* ---------- 답장 하나의 흐름: the one client of GET /api/reply/queue and POST /api/reply/act (hub/reply-actions.ts) ---------- */
// Every surface that shows a reply draws it with rqItemCard(item, opts) from the server's ReplyItem and acts on it with raAct: the card has no
// per-channel code, and the server says which buttons a failed or unsure send gets. The `reply` event updates one item and swaps a replaced
// card in place (99-boot.js). opts: { bare (no head or original), lead (this card's 보내기 is the filled one), after (called once a send or a drop went through),
// parts (a mail draft's own parts from its notice, 10-reply-card.js rqMailParts, in place of the item's), cls, attrs, tail (nodes at the head's end), sure (asked before 보내기) }.
// The card's buttons are 보내기 · 고치기 · 보내지 않기. 고치기 (`fix` here) opens one panel that posts the server's two changing actions (hub/reply-actions.ts ActInput): `edit`
// saves the owner's own text as written, `revise` has the model rewrite from an instruction. A changing action never sends: only `send`, `retry` and `resolve` do, and each
// of those carries the hash of the version its card showed. RA.fix holds what is being changed in an open panel (raFixOpen); `edit` carries the hash the panel opened on.
// RA.asked: the line to the AI of a revise the panel posted, kept until the revise ends: its `next` forgets it, its `why` opens the panel again with it.
// RA.nodes: every card of a ref on screen, a set of registrations per ref (raReg).
// loaded: the first read came back; min: how many waiting items make the 답장 대기 head offer 빠른 처리 and the app filter (the queue's triageMin);
// err: the last failed read, kept for 답장 대기's 다시 시도.
const RA = { items: new Map(), loaded: false, min: 1, err: null, busy: new Map(), fail: new Map(), fix: new Map(), asked: new Map(), nodes: new Map(), t: 0, ticking: false };
// An open panel outlives a reload of the tab (01-core.js kept): its texts, subjects, line to the AI, part and the hash it opened on. The rows it marked (files picked) do not.
for (const [ref, s] of kept("ra-fix", () => [...RA.fix].map(([r, f]) => [r, { part: f.part, text: f.text, subject: f.subject, note: f.note, hash: f.hash }])) || []) RA.fix.set(ref, { ...s, rows: {} });

async function raLoad() {
  try {
    const r = await api("/api/reply/queue");
    RA.items = new Map((r.items || []).map(i => [i.ref, i]));
    if (Number(r.triageMin) > 0) RA.min = Number(r.triageMin);
    if (!RA.loaded) for (const ref of RA.fix.keys()) if (!RA.items.has(ref)) RA.fix.delete(ref);   // a panel kept over a reload whose draft no longer waits
    RA.err = null;
    RA.loaded = true;
  } catch (e) { RA.err = e; }   // the next event or open reads it again; what was shown stays
  for (const ref of [...RA.nodes.keys()]) raPaint(ref, undefined, true);
}
const raSoon = () => { clearTimeout(RA.t); RA.t = setTimeout(raLoad, 300); };

const raFixNew = () => ({ part: "reply", text: {}, subject: {}, note: "", rows: {} });
// A revise made elsewhere replaced the draft a panel is open on: what the owner typed goes on to the new draft (the parts he changed, his line to the AI) with a line
// saying so, on the new draft's hash; the parts he left alone open on the new text. Nothing typed: the panel closes with the draft it was open on.
function raFixMove(ref, next) {
  const st = RA.fix.get(ref), old = RA.items.get(ref);
  RA.fix.delete(ref);
  if (!st || !old) return;
  const d = old.draft, was = { text: { reply: d.text, mail: d.mail ? d.mail.text : "" }, subject: { reply: d.subject || "", mail: d.mail ? d.mail.subject || "" : "" } };
  const typed = k => Object.fromEntries(Object.entries(st[k]).filter(([p, v]) => v != null && v.trim() !== String(was[k][p] ?? "").trim()));
  const text = typed("text"), subject = typed("subject");
  if (!Object.keys(text).length && !Object.keys(subject).length && !st.note.trim()) return;
  RA.fix.set(next, { ...raFixNew(), part: st.part, text, subject, note: st.note });
  RA.fail.set(next, { text: TX("reply.fix.moved") });
}

// The reply event: one item changed (its draft, its send) or was replaced by a revise (`next`); a card shown anywhere follows at once.
function raLive(e) {
  if (!e || !e.ref) return;
  if (e.item) RA.items.set(e.item.ref, e.item);
  const it = RA.items.get(e.ref);
  if (e.send && it) it.send = e.send;
  if (e.why) RA.fail.set(e.ref, { text: e.why });
  if (e.why && RA.asked.has(e.ref)) { RA.fix.set(e.ref, { ...(RA.fix.get(e.ref) || raFixNew()), ...RA.asked.get(e.ref) }); RA.asked.delete(e.ref); }   // the revise failed: its line is back in the panel
  if (e.next) { RA.asked.delete(e.ref); raFixMove(e.ref, e.next); }
  if (e.next && RA.nodes.has(e.ref)) {
    const regs = RA.nodes.get(e.ref);
    RA.nodes.delete(e.ref);
    RA.nodes.set(e.next, new Set([...(RA.nodes.get(e.next) || []), ...regs]));
    if (RA.items.has(e.next)) raPaint(e.next, e.ref); else raSoon();
    return;
  }
  if (!it && !e.item) raSoon();
  raPaint(e.ref, undefined, true);
  tqLive();
}

// One action on one item, posted once: a second press while it waits does nothing. A refusal stays on the card (422 keeps the typed text).
// An act that sends carries the hash of the version its card showed (item.draft.hash, the hub's approvalHash): the hub sends that version only. When the draft moved on
// meanwhile it answers 409 `changed` with the item as it is now: nothing went out, and the card is drawn again from that item with a line saying so.
async function raAct(item, action, args = {}) {
  const ref = item.ref, sends = action === "send" || action === "retry" || (action === "resolve" && args.as === "retry");
  if (RA.busy.has(ref)) return false;
  RA.busy.set(ref, action);
  RA.fail.delete(ref);
  raPaint(ref);
  try {
    // Another computer's item runs there, through its own queue (hub/peer-monitor.ts "reply").
    const body = { ref, action, ...args, ...(sends && item.draft.hash ? { hash: item.draft.hash } : {}) };
    const r = item.pc ? await api(pqProxy(item.pc, "/api/peer/act"), "POST", { action: "reply", args: body }) : await api("/api/reply/act", "POST", body);
    if (r && r.item) RA.items.set(ref, { ...RA.items.get(ref), ...r.item });
    return true;
  } catch (e) {
    const d = (e && e.data) || {};
    if (d.code === "changed") {
      if (d.item && !item.pc) RA.items.set(ref, { ...RA.items.get(ref), ...d.item });
      RA.fail.set(ref, { text: TX(action === "edit" ? "reply.fix.changed" : "reply.changed"), code: "changed" });
      return false;
    }
    // No status: the answer never came back (Safari "Load failed", a phone switching networks), yet the hub may have taken the action.
    // The queue read again says which: an item that left the waiting state was handled, so the card follows it and is not a failure. 되돌리기 is the exception: it went
    // through only when the send is gone (none, or failed); a window that closed meanwhile means the mail went, and that is said, never taken for success.
    if (e && !e.status && !item.pc) {
      await raLoad();
      const now = RA.items.get(ref), st = i => (i.send ? i.send.state : "");
      if (action === "undo" ? !!now && (!now.send || now.send.state === "failed") : !now || now.draft.state !== item.draft.state || st(now) !== st(item) || now.draft.text !== item.draft.text) return true;
      RA.fail.set(ref, { text: TX(action === "undo" ? "reply.undo_net" : sends ? "reply.act_net" : "reply.act_net_change") });
      return false;
    }
    RA.fail.set(ref, { text: d.error || TX("reply.act_fail"), why: Array.isArray(d.lint) ? d.lint.join(" · ") : "" });
    return false;
  } finally {
    RA.busy.delete(ref);
    raPaint(ref);
  }
}

/** The items a surface lists: "waiting" (a pending draft with no send), "attention" (a failed or unsure send), or every one. */
const raItems = filter => [...RA.items.values(), ...raPeerItems()].filter(i => (filter === "waiting" ? i.draft.state === "pending" && !i.send : filter === "attention" ? i.send && (i.send.state === "failed" || i.send.state === "unsure") : true));
// The other computers' queues (their snapshot's `reply` part), each item carrying its computer.
const raPeerItems = () => PQ.list.filter(p => p && p.items && p.items.reply).flatMap(p => (p.items.reply.items || []).map(i => ({ ...i, pc: pqPcOf(p) })));
const raCounts = () => {
  const all = [...RA.items.values(), ...raPeerItems()], st = s => all.filter(i => i.send && i.send.state === s).length;
  return { waiting: raItems("waiting").length, failed: st("failed"), unsure: st("unsure"), sending: st("undo") + st("queued") + st("sending") };
};

// Every card of a ref drawn again in its own place; the field that had the focus keeps it, caret included. A card that left the page is forgotten, the others all follow
// (the node drawn in a card's place registered itself). live: the repaint comes from an event or a reload, not from the owner's own press: a card he is typing in then
// waits until he leaves the field, so the field under his keyboard is never replaced (01-core.js paintKeep says why).
function raPaint(ref, was, live) {
  const regs = RA.nodes.get(ref), it = RA.items.get(ref) || raPeerItems().find(i => i.ref === ref);   // another computer's card is drawn from its own snapshot
  if (was) RA.nodes.delete(was);
  if (!regs || !it) return;
  for (const reg of [...regs]) {
    if (!reg.node.isConnected) { regs.delete(reg); continue; }
    if ([...regs].some(r => r.node !== reg.node && r.node.contains(reg.node))) continue;   // a card inside another registration (a 30-triage.js row) is drawn with it
    const at = document.activeElement, mine = reg.node.contains(at);
    if (live && mine && at === typingIn()) { if (!reg.held) { reg.held = true; at.addEventListener("focusout", () => afterTap(() => raPaint(ref)), { once: true }); } continue; }
    const k = mine ? at.getAttribute("data-k") : null, caret = k && at.selectionStart != null ? [at.selectionStart, at.selectionEnd] : null;
    const next = reg.make ? reg.make(it) : rqItemCard(it, reg.opts);
    reg.node.replaceWith(next);
    regs.delete(reg);
    const f = k ? next.querySelector(`[data-k="${k}"]`) : null;
    if (f) { f.focus(); if (caret && f.setSelectionRange) f.setSelectionRange(...caret); }
  }
  if (!regs.size && RA.nodes.get(ref) === regs) RA.nodes.delete(ref);
}

// One node has one registration, the last one made for it: rqItemCard registers its card with its opts, and a surface that draws the card through its own maker
// (30-monitoring.js, 30-triage.js) or a block waiting for the queue to know its ref (raInline) registers the same node again with `make`.
function raReg(ref, reg) {
  const s = RA.nodes.get(ref) || new Set();
  for (const r of s) if (r.node === reg.node) s.delete(r);
  RA.nodes.set(ref, s.add(reg));
}

// The undo window counts down in place: one timer for every card that shows one, stopped when none does.
function raTick() {
  const left = [...document.querySelectorAll(".rq-send.undo [data-until]")];
  if (!left.length) { RA.ticking = false; return; }
  RA.ticking = true;
  for (const n of left) n.textContent = TX("reply.undo_in", { n: Math.max(0, Math.ceil((Number(n.dataset.until) - Date.now()) / 1000)) });
  setTimeout(raTick, 1000);
}

/** The foot of a card whose send the queue holds: the countdown with 되돌리기, sending, sent, or the cause with the server's buttons. A failed send offers 다시 보내기
 *  (그래도 보내기 where the server lists `send_as_is`, the attachment check having refused it: that one sends it as it is, despite the finding) · 고치기 · 보내지 않기. */
function rqSendNode(item) {
  const s = item.send, busy = RA.busy.has(item.ref), btn = (k, text, fn, cls = "btn text sm") => el("button", { class: cls, type: "button", "data-k": k, disabled: busy, text, onclick: fn });
  if (s.state === "undo") {
    const left = el("span", { "data-until": String(s.until), text: TX("reply.undo_in", { n: Math.max(0, Math.ceil((s.until - Date.now()) / 1000)) }) });
    if (!RA.ticking) setTimeout(raTick, 1000);
    return el("div", { class: "rq-send undo", role: "status" }, left, btn("undo", TX("common.undo"), () => raAct(item, "undo")));
  }
  if (s.state === "queued" || s.state === "sending") return el("div", { class: "rq-send sending", role: "status", text: TX("reply.sending") });
  if (s.state === "sent") return rqSentNode();
  const why = s.reason ? s.reason.text : "";
  if (s.state === "failed" && s.auto && s.safeToAuto) return el("div", { class: "rq-send failed auto", role: "status", text: `${why} · ${TX("reply.auto_retry", { n: s.auto.attempt, max: s.auto.max })}` });
  if (s.state === "failed") {
    const has = k => (s.actions || []).includes(k), acts = has("retry") ? [btn("retry", TX("reply.retry"), () => raAct(item, "retry"), "btn tonal sm")] : [];
    if (has("send_as_is")) acts.push(btn("send-as-is", TX("decision.send_anyway"), () => raAct(item, "send", { asIs: true })));
    if (raCanFix(item)) acts.push(btn("fix", TX("decision.fix"), () => raFixOpen(item)));
    if (item.can.drop) acts.push(btn("drop", TX("decision.drop"), () => raAct(item, "drop")));
    return el("div", { class: "rq-send failed" }, el("div", { class: "rq-why", role: "alert", text: TX("reply.failed", { why }) }), el("div", { class: "dr-act dr-row rq-acts" }, ...acts));
  }
  return el("div", { class: "rq-send unsure" },
    el("div", { class: "rq-why warn", role: "alert", text: TX("reply.unsure") }), el("div", { class: "rq-sub2", text: `${why} · ${TX("reply.no_auto")}` }),
    el("div", { class: "dr-act dr-row rq-acts" }, btn("resolve-sent", TX("reply.went_out"), () => raAct(item, "resolve", { as: "sent" }), "btn tonal sm"),
      btn("open", TX("reply.check"), () => go("monitoring", `c:${item.conv}`)), btn("resolve-retry", TX("reply.retry"), () => raAct(item, "resolve", { as: "retry" }))));
}

// 고치기 opens the card's panel (once: a second call keeps what is being changed). What he changes is kept until 반영 or 닫기: the text and the subject per part (a comment
// reply that carries a mail has two), the line to the AI, and what he marks on the 받는이 and 첨부 rows of a mail draft (rows[its draft ref] = { recv, files }, the `stage`
// of 10-decision-card.js draftToNode and draftFilesNode).
const raCanFix = item => item.can.edit || item.can.revise;
function raFixOpen(item) {
  if (!RA.fix.has(item.ref)) RA.fix.set(item.ref, raFixNew());
  raPaint(item.ref);
}
// 반영 writes what the panel marked on a mail draft's rows, through the draft's own routes: the 받는이 lists in one request, the files taken off (from the last, so the
// earlier places stand), then the ones picked. What went leaves the marks, so 반영 after a failure goes on from there.
async function raRowsApply(ref, rows) {
  const f = rows.files;
  if (Object.keys(rows.recv).length) { await drrWrite(ref, { ...rows.recv }); for (const k of Object.keys(rows.recv)) delete rows.recv[k]; }
  for (f.remove.sort((a, b) => a - b); f.remove.length; f.remove.pop()) await drfWrite(ref, { remove: f.remove[f.remove.length - 1] });
  for (; f.add.length; f.add.shift()) await (f.add[0].file ? drfUpload(ref, f.add[0].file) : drfWrite(ref, { library: f.add[0].library }));
}
/** 고치기 (the panel): the draft's text as a field in the body's own place (답글 / 메일 choosing which part it shows), a mail's 제목 as a field and its 받는이 and 첨부 rows
 *  open in their own places, then one optional line to the AI, and 반영 · 닫기. 반영 writes the marked rows first, then posts `edit` for each part whose text or subject
 *  changed, then `revise` when the line is filled, so the AI works from the saved text; with nothing changed it is off. Nothing here can send, and 닫기 forgets every
 *  change, the rows' too. Cmd/Ctrl+Enter (Enter in the AI line) is 반영, Esc is 닫기; a refusal keeps what was typed, with its cause above the buttons.
 *  lead: 반영 is the filled control (this card's 보내기 is away while the panel is open); elsewhere another card holds it, so 반영 is tonal.
 *  Returns { body, foot, card (the card's own parts as fields and open rows), mail (draftMailNode's `fix`) }. */
function rqFixNodes(item, lead) {
  const ref = item.ref, d = item.draft, st = RA.fix.get(ref), f = RA.fail.get(ref), off = () => RA.busy.has(ref) || !!st.busy;
  st.hash ??= d.hash;   // the version the panel opened on: an `edit` over a draft that moved meanwhile is refused (409 changed)
  const parts = d.mail ? ["reply", "mail"] : ["reply"], mailKind = item.kind === "mail" || item.kind === "webmail", hand = item.can.edit;
  // The rows open only on a draft of this computer, and never while the queue holds a send of it (the server refuses a change then).
  const rowRef = !item.pc && hand && (!item.send || item.send.state === "failed") ? (mailKind ? ref : item.kind === "comment" && d.mail ? d.mail.ref : "") : "";
  const rows = rowRef ? (st.rows[rowRef] ||= { recv: {}, files: { remove: [], add: [] } }) : null;
  const was = { text: { reply: d.text, mail: d.mail ? d.mail.text : "" }, subject: { reply: mailKind ? d.subject || "" : null, mail: d.mail ? d.mail.subject || "" : null } };
  for (const p of parts) { st.text[p] ??= was.text[p]; st.subject[p] ??= was.subject[p]; }   // also a mail that came to ride along while the panel was open
  const moved = (k, p) => was[k][p] !== null && st[k][p].trim() !== was[k][p].trim();
  const edits = () => (hand ? parts.filter(p => moved("text", p) || moved("subject", p)) : []);
  const marked = () => !!rows && Object.keys(rows.recv).length + rows.files.remove.length + rows.files.add.length > 0;
  const ready = () => !off() && parts.every(p => st.text[p].trim() && (!was.subject[p] || st.subject[p].trim())) && (edits().length > 0 || !!st.note.trim() || marked());
  const close = () => { RA.fix.delete(ref); RA.fail.delete(ref); if (rowRef) { DRR.add[rowRef] = ""; DRR.edit[rowRef] = ""; DRF.menu[rowRef] = ""; } raPaint(ref); };
  const save = async () => {
    if (!ready()) return;
    const todo = edits(), change = st.note.trim();
    if (marked()) {
      st.busy = true; RA.fail.delete(ref); raPaint(ref);
      // The queue is read again before anything else: the item must carry the hash of the rows as they are now, or the next 보내기 would be refused as changed.
      try { await raRowsApply(rowRef, rows); await raLoad(); st.hash = (RA.items.get(ref) || item).draft.hash; }
      catch (e) { RA.fail.set(ref, { text: e instanceof TypeError ? TX("decision.err.offline_change") : e.message }); return; }
      finally { st.busy = false; raPaint(ref); }
    }
    for (const p of todo) {
      const ok = await raAct(item, "edit", { text: st.text[p].trim(), ...(moved("subject", p) ? { subject: st.subject[p].trim() } : {}), ...(d.mail ? { part: p } : {}), ...(st.hash ? { hash: st.hash } : {}) });
      // Saved, or refused as changed: the panel now stands on the version the hub has, so a second 반영 after the refusal saves over it knowingly. The typed text stays.
      st.hash = (RA.items.get(ref) || item).draft.hash;
      if (!ok) return;
    }
    if (change) {
      RA.asked.set(ref, { note: change, part: st.part });
      if (!(await raAct(item, "revise", { change, ...(d.mail ? { part: st.part } : {}) }))) { RA.asked.delete(ref); return; }
    }
    close();
  };
  const go = el("button", { class: `btn${lead ? "" : " tonal"} sm`, type: "button", "data-k": "fix-apply", disabled: !ready(), text: TX("reply.fix.apply"), onclick: save });
  const sync = () => { go.disabled = !ready(); };
  // One field of the panel: `box[key]` is what it shows and writes.
  const field = (tag, k, box, key, attrs) => {
    const n = el(tag, { ...attrs, "data-k": k, "data-esc": "field", disabled: off(), oninput: () => { box[key] = n.value; sync(); }, onkeydown: ev => {
      if (ev.isComposing) return;
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey || k === "fix-note")) { ev.preventDefault(); save(); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); }   // the sheet or pane around the card stays open
    } });
    n.value = box[key];
    return n;
  };
  const subject = p => (hand && was.subject[p] !== null ? field("input", "fix-subject", st.subject, p, { class: "ra-sub", type: "text", maxlength: "300", autocomplete: "off", placeholder: TX("decision.subject"), "aria-label": TX("decision.subject") }) : null);
  const note = item.can.revise ? field("input", "fix-note", st, "note", { class: "kk-rv", type: "text", maxlength: "500", autocomplete: "off", placeholder: TX("reply.fix.note_ph"), "aria-label": TX("reply.fix.note") }) : null;
  const seg = d.mail ? el("div", { class: "seg dr-seg", role: "group", "aria-label": TX("mon.cm.part") }, ...[["reply", TX("mon.cm.reply")], ["mail", TX("common.mail")]].map(([k, text]) =>
    el("button", { class: st.part === k ? "on" : "", type: "button", "data-k": `part-${k}`, "aria-pressed": String(st.part === k), disabled: off(), text, onclick: () => { st.part = k; raPaint(ref); } }))) : null;
  return { body: hand ? el("div", { class: "ra-editbox" }, seg, field("textarea", "fix-text", st.text, st.part, { class: "ra-edit", rows: "6", "aria-label": TX("reply.edit_label") })) : null,
    // The AI changes one part: with a mail riding along, the line names the part the switch shows.
    foot: el("div", { class: "rq-edit" }, hand ? null : seg,
      note ? el("div", { class: "kk-rq", text: d.mail ? TX("reply.fix.note_part", { part: st.part === "mail" ? TX("common.mail") : TX("mon.cm.reply") }) : TX("reply.fix.note") }) : null, note,
      f ? el("div", { class: "ra-lint err", role: "alert", text: f.why || f.text }) : null,
      el("div", { class: "btns" }, go, el("button", { class: "btn text sm", type: "button", "data-k": "fix-close", disabled: off(), text: TX("common.close"), onclick: close }))),
    card: { ...(mailKind && hand ? { subject: subject("reply") } : {}),
      ...(rows && mailKind ? { to: null, recv: draftToNode({ ref, toLabel: d.toLabel, to: d.to, cc: d.cc }, { t: item.conv, edit: true, always: true, stage: rows.recv, onstage: sync }),
        attach: draftFilesNode({ ref, toLabel: d.toLabel, attachments: d.attachments }, { t: item.conv, stage: rows.files, onstage: sync }) } : {}) },
    mail: d.mail && hand ? { subject: subject("mail"), ...(rows && !mailKind ? { recv: rows.recv, files: rows.files, onstage: sync } : {}) } : null };
}

/** The one card of a reply, on every surface. */
function rqItemCard(item, opts = {}) {
  const ref = item.ref, d = item.draft, busy = RA.busy.has(ref), fail = RA.fail.get(ref), fx = RA.fix.has(ref) ? rqFixNodes(item, !!opts.lead) : null, p = opts.parts;
  const foot = fx ? fx.foot : d.revising ? el("div", { class: "kk-st", role: "status", text: TX("reply.revising") }) : item.send ? rqSendNode(item) : null;
  // A draft of this hub that the server can open (a mail, a comment): 원문 보기 loads the whole original (10-draft-original.js), also when the item came with no quote,
  // and a mail's 첨부 줄 reads the files staged on it (10-decision-card.js draftFilesNode); the queue item carries neither. Another computer's item keeps the quote it came with.
  const local = !item.pc && (item.kind === "mail" || item.kind === "webmail" || item.kind === "comment"), mail = local && item.kind !== "comment", src = local ? { ref, t: item.conv } : {};
  if (mail && !DRF.st[ref]) { DRF.pc[ref] = null; drfLoad(ref).then(() => raPaint(ref)); }
  const node = rqCard({
    key: `ra:${item.item}`, bare: !!opts.bare,
    // The head names the person: a mail sender's address ("이름 <a@b>") stays in the quoted original only.
    head: { app: item.app, label: item.label, who: item.original && (String(item.original.who).replace(/\s*<[^<>]*>\s*$/, "") || item.original.who), at: item.at, tail: opts.tail },
    original: item.original ? { who: item.original.who, text: item.original.text, ...src } : local ? { who: "", text: "", ...src } : null,
    subject: d.subject,
    // Outside the 고치기 panel every row is only read: a mail's files as the hub holds them, any other draft's as the item lists them. The panel's own fields and open rows
    // (fx.card) then stand in the same places.
    attach: mail ? draftFilesNode({ ref, toLabel: d.toLabel, attachments: d.attachments }, { t: item.conv, edit: false }) : d.attachments,
    ...(p || { to: [d.toLabel, d.to] }), ...(fx ? fx.card : {}),
    cls: `ra-card${opts.lead ? " lead" : ""}${opts.cls ? ` ${opts.cls}` : ""}${p && p.cls ? ` ${p.cls}` : ""}`, attrs: { "data-ref": ref, "data-item": item.item, ...opts.attrs },
    // Which version this is, said above the body: the owner's own text, or the model's rewrite with what it changed marked against the draft it replaced (rqDiffBody).
    label: d.edited ? TX("reply.edited") : d.replaces ? TX("reply.revised") : "",
    body: fx && fx.body ? { node: fx.body, full: true } : (d.replaces && !d.edited && rqDiffBody(d)) || { text: d.text, parts: d.parts, sentParts: d.sentParts },
    extra: [...(d.notes || []).map(n => el("div", { class: "dr-wn", text: n })),
      // The mail a comment reply carries goes out with it, so it stands in the card: who gets it, its subject, its text and its files.
      d.mail ? draftMailNode({ ...(local ? { ref: d.mail.ref } : {}), to: d.mail.to, subject: d.mail.subject, body: d.mail.text, attachments: d.mail.attachments }, { t: item.conv, fix: fx && fx.mail }) : null, ...((p && p.extra) || [])],
    fail: fail && !fx ? fail : null,
    foot,
    // A draft that no longer waits (dropped, sent, replaced) offers nothing to press.
    acts: d.state !== "pending" ? null : { quiet: !opts.lead, busy, press: RA.busy.get(ref),
      send: item.can.send ? () => (opts.sure ? opts.sure().then(ok => ok && raAct(item, "send")) : raAct(item, "send")).then(ok => ok && opts.after && opts.after("send")) : null,
      fix: raCanFix(item) ? () => raFixOpen(item) : null,
      drop: item.can.drop ? () => raAct(item, "drop").then(ok => ok && opts.after && opts.after("drop")) : null },
  });
  raReg(ref, { node, opts });
  return node;
}

// The send approvals of a message are their drafts' cards in the message (10-decision-card.js dcInline), one per block, never a docked question. A block whose ref the
// queue does not know yet (the message came before the queue read it) stands as `draw([block])` draws it, registered under its ref: raLoad or the reply event then draws
// the card in its place. Returns [block, node] for every send block that names a ref.
function raInline(blocks, draw) {
  return blocks.flatMap(b => {
    const m = SEND_LABELS.test(b.options.map(o => o.label).join("|")) && /\(([A-Za-z0-9]{2,16})\)\s*$/.exec(b.title);
    if (!m) return [];
    const make = it => el("div", { class: "ra-inl" }, rqItemCard(it));
    if (RA.items.has(m[1])) return [[b, make(RA.items.get(m[1]))]];
    const node = draw([b]);
    raReg(m[1], { node, make });
    return [[b, node]];
  });
}
// A draft notice's row answered in place (10-decision-card.js answerInline): through the queue when it holds the draft, by what the option's label asks of it
// (30-monitoring.js DRAFT_ACTS: 이대로 보내기 is `send` with asIs, never a plain send; the numbers move with the card). 고치기 opens its card with the panel open, and an
// option that is the bot's to read (직접 입력) stays with the notice.
function raAnswer(nd, opt) {
  const it = nd.decision.draft && !nd.pc ? RA.items.get(nd.decision.draft.ref) : null, a = it && DRAFT_ACTS[opt.label];
  if (!a) return null;
  if (a[0] === "revise") { raFixOpen(it); ntDraftSheet(nd); return Promise.resolve(true); }
  return raAct(it, a[0], a[1]);
}

raLoad();
