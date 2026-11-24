// The status line of an answered decision card (보내는 중 / 고치는 중 / 보냈어요). A draft's undo window lives in the queue card (10-reply-actions.js rqSendNode).
const dcStNode = (dc, st) => (st ? el("div", { class: "dc-st", role: "status", text: dcStText(dc, st) }) : null);
// 되돌리기 of a draft answered 보내지 않기 (dcAnswerToast): the notice opens again.
async function dcReopen(nd) {
  try {
    if (nd.pc) await pqNotice(nd, "notice", { op: "reopen", id: String(nd.id) });
    else { const r = await api("/api/notices/reopen", "POST", { ids: [String(nd.id)] }); ntApply(null, r.unread); await loadNotices(); }
    toast(TX("decision.toast.restored"));
  } catch (e) { toast(e.message, true); }
}
const NT_HOLD = new Map(), NT_HOLD_GRACE_MS = 15000, NT_HOLD_TOLD = new Set();
function ntHoldView(n) {
  const d = n && ntIsDec(n) ? n.decision : null, h = d && d.hold, id = d ? String(n.id) : "";
  if (!d) return n;
  if (h && h.state === "failed" && d.state === "open") { NT_HOLD.delete(id); dcHoldFailed(n, h); return n; }
  if (!h || h.state !== "held" || (d.state !== "open" && !h.shown)) { NT_HOLD.delete(id); if (h && d.state !== "open") delete d.hold; return n; }
  if (!h.shown) ntHoldStart(n, h);
  n.decision = { ...d, state: "answered", answer: h.label, hold: { ...h, shown: true } };
  return n;
}
function ntHoldStart(n, held) {
  const id = String(n.id), was = NT_HOLD.get(id);
  if (was && was.at === held.until) return;
  NT_HOLD.set(id, { at: held.until });
  setTimeout(() => { const h = NT_HOLD.get(id); if (h && h.at === held.until) loadNotices(); }, held.left + NT_HOLD_GRACE_MS + 1);
}
function dcHoldFailed(n, h) {
  const told = `${n.id}|${h.until}`;
  if (NT_HOLD_TOLD.has(told)) return;
  NT_HOLD_TOLD.add(told);
  const opt = h.n === undefined ? null : (n.decision.options || []).find(o => o.n === h.n) || null;
  dcForget(n.decision.to);
  if (h.note) ntGiveBack(n, h);
  if (!dcGoneFail(n, { data: { code: h.code } }, opt, h.note) || !(NS.node && String(NS.id) === String(n.id))) toast(TX("decision.hold_failed", { title: ntShort(ntPlain(n.title), 24), error: h.error }), true);
  setTimeout(() => { ntSheetPaint(); paintDecision(); });
}
function dcHeldToast(n, held, sheet) {
  if (!held || held.state !== "held") return;
  const said = TX("decision.held", { title: ntShort(ntPlain(n.title), 24), label: ntShort(String(held.label).replace(/^\d+\)\s*/, ""), 24) });
  toast(said, false, { label: TX("common.undo"), onclick: () => dcUnhold(n, sheet) }, held.left);
}
async function dcUnhold(n, sheet) {
  const id = String(n.id);
  try {
    const r = await api(`/api/notices/${enc(id)}/unhold`, "POST", {});
    NT_HOLD.delete(id);
    dcForget(n.decision.to);
    ntApply(r.item, r.unread);
    if (r.back) ntGiveBack(ntById(id) || n, r.back);
    paintDecision();
    if (sheet && NS.node) ntSheetGo(id);
    else if (sheet) await noticeSheetOpen(id);
  } catch (e) { toast(e.message, true); }
}
