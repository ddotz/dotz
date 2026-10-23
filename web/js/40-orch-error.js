/* ---------- orchestrator error banner ---------- */
// The automatic retries gave up (hub/orch-error.ts): one banner above every view (chat and home) with the plain reason, since when,
// and the same restart as `/restart orchestrator`. It clears when the next state shows the error gone.
function paintOrchError() {
  const e = S && S.orchestrator && S.orchestrator.error, box = $("#oerr");
  box.hidden = !e;
  if (!e) return;
  $("#oerr-tx").innerHTML = `<b>오케스트레이터가 멈췄어요</b> · ${e.text} · ${kstHM(e.since)}부터`;
  box.title = e.raw || "";
  $("#oerr-btn").onclick = ev => busy(ev.currentTarget, async () => {
    await api("/api/orchestrator/restart", "POST", {});
    toast("다시 시작을 요청했어요. 답하지 못한 요청도 이어서 처리해요");
    refreshState();
  });
}
