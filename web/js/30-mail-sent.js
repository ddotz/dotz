/* ---------- a mail's handled reply drafts, folded inside its own conversation (owner 2026-10-27) ---------- */
// "보내고 나면 해당 메일 안으로 이동시켜서 접어놔": once a reply draft is no longer in the owner's hands (sent, expired, ignored) its card leaves the
// mail list of 모니터링 in every filter (30-monitoring.js monChronoNodes) and lives here, under the mail it answers, as one collapsed line
// ("보낸 답장 · 오후 3:53 · 받는이 …"). A tap unfolds the draft as it went out (recipient, subject, body, 첨부) with 지우기, which hides the card on
// the computer that holds it (POST /api/notices/<id>/dismiss, a peer's through /api/peer/act "notice" dismiss). Nothing is ever sent by it.
// A draft answered 보내지 않기, or one a newer draft of the same mail replaced, is gone everywhere (mailDraftGone) and never shows here.
// A peer's mail reads its drafts from that computer's snapshot (PQ.list), so both views are the same; only the machine chip in the head differs.
const MS = { open: new Set(), gone: new Set() };
const msKey = n => `${n.pc ? n.pc.url : ""}|${n.id}`;
const MS_LABEL = { send: TX("mail.sent.send"), expired: TX("mail.sent.expired"), ignored: TX("mail.sent.ignored"), edit: TX("mail.sent.edit") };
function mailDraftsOf(t) {
  const pc = pqPc(t), mine = n => !n.dismissed && !!(n.decision && n.decision.draft) && n.decision.to === t;
  if (!pc) return NT.items.filter(mine);
  const p = PQ.list.find(x => x && x.url === pc.url);
  return ((p && p.items && p.items.notices) || []).filter(mine).map(n => ({ ...n, pc }));
}
// The drafts of a mail the owner is done with, oldest first: every sent one, and the newest of the rest when it is not waiting or dropped.
function mailSentList(t) {
  const all = mailDraftsOf(t), newest = mailDraftLive(all);
  return all.filter(n => {
    if (mailDraftHeld(n) || MS.gone.has(msKey(n))) return false;
    const st = drState(n.decision);
    return st === "send" || (st !== "drop" && newest.get(mailDraftKey(n)) === n);
  }).sort((a, b) => ntAt(a) - ntAt(b));
}
// quiet: one of 모두 지우기's items (mailSentClear says the outcome once). Resolves whether it was removed.
async function mailSentRemove(n, btn, quiet = false) {
  const k = msKey(n), id = String(n.id);
  if (btn) btn.disabled = true;
  const card = tl.querySelector(`.ms-card[data-nid="${CSS.escape(id)}"]`);
  let out = null;
  // The draft folds away once the hub said yes, then the folded list redraws without it.
  const leave = () => { MS.gone.add(k); out = card ? motionGone(card) : null; };
  try {
    if (n.pc) {
      await pqNotice(n, "notice", { op: "dismiss", id });
      leave();
      const raw = pqNoticeOf(n);
      if (raw) raw.dismissed = true;
    } else {
      const r = await api(`/api/notices/${enc(id)}/dismiss`, "POST", {});
      if (!r || !r.ok) throw new Error(TX("mail.sent.remove_failed"));
      leave();
      NT.items = NT.items.filter(x => String(x.id) !== id);
      if (typeof r.unread === "number") NT.unread = r.unread;
      ntPaint();
    }
    if (out) out.then(mailSentPaint); else mailSentPaint();
    if (!quiet) toast(TX("mail.sent.removed"));
    return true;
  } catch (e) { if (btn) btn.disabled = false; mailSentPaint(); if (!quiet) toast(e.message || TX("mail.sent.remove_failed"), true); return false; }
}
// 모두 지우기 at the head of a mail's folded drafts: every one of them is hidden the same way (one dismiss each on the computer that holds it).
async function mailSentClear(list, btn) {
  if (btn) btn.disabled = true;
  const ok = await Promise.all(list.map(n => mailSentRemove(n, null, true)));
  const bad = ok.filter(x => !x).length;
  toast(bad ? TX("mail.sent.clear_failed", { total: list.length, n: bad }) : TX("mail.sent.cleared", { n: list.length }), !!bad);
  if (btn && btn.isConnected) btn.disabled = false;
}
function mailSentNode(n) {
  const d = n.decision, dr = d.draft, k = msKey(n), open = MS.open.has(k), st = drState(d);
  const toggle = () => { if (open) MS.open.delete(k); else MS.open.add(k); mailSentPaint(); };
  const line = el("button", { class: "ms-line", type: "button", "aria-expanded": String(open), "data-nid": n.id, onclick: toggle },
    icon(st === "send" ? "send" : "mail"), el("span", { class: "ms-k", text: `${MS_LABEL[st] || TX("mail.sent.handled")} · ${ntTime(d.answered_at || n.updated || n.ts)}` }),
    el("span", { class: "ms-m", text: `${dr.toLabel || TX("decision.to")} ${dr.to || "-"}` }), icon("drop", "ms-ch"));
  const body = open ? el("div", { class: "ms-body" }, draftCardNode(n, { bare: true }),
    el("div", { class: "ms-ft" }, el("button", { class: "btn text sm ms-rm", type: "button", "aria-label": TX("mail.sent.remove_this"), onclick: ev => mailSentRemove(n, ev.currentTarget) }, icon("trash"), el("span", { text: TX("mail.remove") })))) : null;
  return el("div", { class: `ms-card${open ? " open" : ""}`, "data-nid": n.id }, line, body);
}
// Drawn after the chat's own paint (renderAll) and on every notice or snapshot change (convPaint): the slot sits right under the mail's card.
function mailSentPaint() {
  if (typeof tl === "undefined" || !tl) return;
  const t = target, list = current === "chat" && isMailT(t) ? mailSentList(t) : [];
  const sig = JSON.stringify([t, list.map(n => [msKey(n), n.updated, n.decision.state, n.decision.answer, MS.open.has(msKey(n))]), mailLinesOpen(t)]);
  let slot = tl.querySelector(":scope > .ms-slot");
  if (slot && slot.dataset.sig === sig) return;
  if (!list.length) { if (slot) slot.remove(); return; }
  if (!slot) {
    slot = el("div", { class: "ms-slot", role: "group", "aria-label": TX("mail.sent.group") });
    let card = tl.querySelector(".mhd-wrap");
    while (card && card.parentElement !== tl) card = card.parentElement;
    if (card) card.after(slot); else tl.append(slot);
  }
  slot.dataset.sig = sig;
  const head = list.length > 1 ? el("div", { class: "ms-hd" }, el("span", { class: "ms-n", text: TX("mail.sent.count", { n: list.length }) }),
    el("button", { class: "btn text sm ms-clear", type: "button", "data-k": "ms-clear", onclick: ev => mailSentClear(list, ev.currentTarget) }, icon("trash"), el("span", { text: TX("mail.sent.clear") }))) : null;
  clear(slot).append(...(head ? [head] : []), ...list.map(mailSentNode));
}
