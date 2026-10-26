/* ---------- paused bot: the composer's small status line ---------- */
// The bot that answers this conversation is paused (status "rate-limited"; pauseKind "owner" = the provider wants a login or payment): one line above the
// composer says so, with the computer's name. A conversation of another computer reads that computer's status from the monitoring snapshot (hub/peer-monitor.ts).
function paintPause() {
  const box = $("#pausenote");
  if (!box) return;
  let o = null, name = "";
  if (!isLaneT(target)) {
    const pc = pqPc(target), v = pc && PQ.list.find(x => x.url === pc.url);
    if (pc) { o = v && v.items && v.items.orchestrator; name = pc.name; }
    else { o = S && S.orchestrator; name = pqSelf(); }
  }
  const paused = !!o && o.status === "rate-limited";
  box.hidden = !paused;
  if (!paused) { box.dataset.sig = ""; return; }
  const sig = `${name}|${o.pauseKind}|${!!pqPc(target)}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  // 지금 다시 시도: this computer's bot only (a peer's is resumed on that computer); the pause ends and the held messages go in now.
  clear(box).append(el("span", { text: `${name ? `${name} ` : ""}봇이 멈춰 있어요: ${o.pauseKind === "owner" ? "로그인 필요" : "사용량 한도"}` }),
    pqPc(target) ? null : el("button", { class: "btn text pn-go", type: "button", onclick: ev => orchResume(ev.currentTarget) }, "지금 다시 시도"));
}
// 재개 (POST /api/orchestrator/resume, hub/orchestrator.ts resumeNow): the same for the paused line and the stopped banner.
const orchResume = btn => busy(btn, async () => {
  await api("/api/orchestrator/resume", "POST", {});
  toast("다시 시도해요. 멈춘 동안 온 메시지도 이어서 처리해요");
  refreshState();
});

/* ---------- orchestrator error banner ---------- */
// The automatic retries gave up (hub/orch-error.ts): one banner above every view (chat and home) with the plain reason, since when,
// and the same restart as `/restart orchestrator`. It clears when the next state shows the error gone.
function paintOrchError() {
  const e = S && S.orchestrator && S.orchestrator.error, box = $("#oerr");
  box.hidden = !e;
  if (!e) return;
  $("#oerr-tx").innerHTML = `<b>오케스트레이터가 멈췄어요</b> · ${e.text} · ${kstHM(e.since)}부터`;
  box.title = e.raw || "";
  $("#oerr-btn").onclick = ev => orchResume(ev.currentTarget);
}
