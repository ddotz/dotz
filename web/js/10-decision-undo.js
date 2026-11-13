// The cancel window of an approved send (hub/approval-send.ts, web.send_undo_sec): the card stays with the seconds left and one 보내기 취소 in the place of the
// choices until the gateway sends; the countdown is text, changed in place once a second.
const dcLeft = dc => Math.max(0, Math.ceil((((DC.undo[dc.key] || {}).end || 0) - Date.now()) / 1000));
const dcUndoText = dc => TX("decision.undo.left", { n: dcLeft(dc) });
let dcUndoT = 0;
function dcUndoStart(dc, held) {
  DC.undo[dc.key] = { ref: dc.draft.ref, end: Date.now() + (held.left ?? 10000) };
  dcUndoTick();
  return "undo";
}
function dcUndoTick() {
  clearTimeout(dcUndoT); dcUndoT = 0;
  for (const [key, u] of Object.entries(DC.undo)) if (Date.now() >= u.end) dcUndoEnd(key, "sent");
  for (const n of document.querySelectorAll(".dc-st[data-undo]")) { const key = n.dataset.undo; if (DC.undo[key]) n.textContent = dcUndoText({ key }); }
  if (Object.keys(DC.undo).length) dcUndoT = setTimeout(dcUndoTick, 250);
}
function dcUndoEnd(key, st) {
  delete DC.undo[key];
  if (st) DC.st[key] = st; else { delete DC.st[key]; delete DC.picks[key]; }
  paintDecision(); if (DK.node) dkPaint();
}
async function dcUndoPost(ref) {
  try { await api("/api/approvals/undo", "POST", { ref }); await loadNotices(); return true; } catch (e) { toast(e.message, true); return false; }
}
const dcUndo = async key => { const u = DC.undo[key]; if (u && await dcUndoPost(u.ref)) dcUndoEnd(key, ""); };
// The gateway's frame for a held send: it went out (or started), or it was taken back and the card waits for approval again (the notice reopens).
function dcUndoLive(e) {
  if (e.state !== "undo") for (const [key, u] of Object.entries(DC.undo)) if (u.ref === e.ref) dcUndoEnd(key, e.state === "back" ? "" : "sent");
}
const dcUndoBtn = (dc, cls) => el("button", { class: cls, type: "button", onclick: () => dcUndo(dc.key) }, TX("decision.undo.cancel"));
// A send that was taken back (cancelled, or the gateway restarted in its window) tells the owner once, on the card that waits again.
const dcBackNote = dc => {
  const r = dc.draft && dc.draft.ref, n = r && NT.items.find(x => ntOpenDec(x) && x.decision.draft && x.decision.draft.ref === r);
  return n && n.decision.send && n.decision.send.state === "back" ? n.decision.send.text || "" : "";
};
const dcStNode = (dc, st) => { const bk = st ? "" : dcBackNote(dc); return st || bk ? el("div", { class: "dc-st", role: "status", ...(st === "undo" ? { "data-undo": dc.key } : {}), text: st ? dcStText(dc, st) : bk }) : null; };
// 되돌리기 of a draft answered 보내지 않기 (dcAnswerToast): the notice opens again.
async function dcReopen(nd) {
  try {
    if (nd.pc) await pqNotice(nd, "notice", { op: "reopen", id: String(nd.id) });
    else { const r = await api("/api/notices/reopen", "POST", { ids: [String(nd.id)] }); ntApply(null, r.unread); await loadNotices(); }
    toast(TX("decision.toast.restored"));
  } catch (e) { toast(e.message, true); }
}
