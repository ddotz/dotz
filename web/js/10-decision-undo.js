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
