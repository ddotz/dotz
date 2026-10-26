/* ---------- run state: one line above the composer saying what this conversation's agent is doing ---------- */
// /api/state `runs` (hub/runstate.ts, derived from real hub state) carries {kind, reason, since, detail, todos} for the main
// conversation and every lane. The line always says one of 작업 중 / 답을 기다려요 / 쉬는 중 / 한도에 걸렸어요 / 오류로 멈췄어요 /
// 멈춤 / 끝났어요. An idle conversation with plan tasks left names the reason and offers 계속하기: the owner's complaint was
// "todo는 남아있는데 아무것도 안하고 있을때 왜 안하는지 모르는 경우가 많음", so "쉬는 중" alone is never the answer.
const RUN_LABEL = { working: "작업 중", waiting: "답을 기다려요", idle: "쉬는 중", limited: "한도에 걸렸어요", error: "오류로 멈췄어요", stopped: "멈춤", done: "끝났어요" };
const RUN_DOT = { working: "pri", waiting: "warn", idle: "", limited: "warn", error: "err", stopped: "", done: "ok" };
const RUN_MEMO = { sig: "" };
const runStateOf = () => {
  if (isFixedT(target) || isMailT(target) || isSettingsT(target)) return null;
  const runs = (S && S.runs) || {};
  return (isLaneT(target) ? runs[target] : runs.main) || null;
};
// The gateway's clock, not this device's, so the elapsed time ticks every second between state refreshes (workNow, 06-subagents.js).
const runClock = () => (typeof workNow === "function" ? workNow() : Date.now());
function runSince(iso) {
  const d = runClock() - (Date.parse(iso) || 0);
  return !(d >= 0) ? "" : d < 60000 ? "방금" : d < 3600000 ? `${Math.floor(d / 60000)}분` : `${Math.floor(d / 3600000)}시간 ${Math.floor((d % 3600000) / 60000)}분`;
}
function runText(r) {
  const label = RUN_LABEL[r.kind] || "알 수 없음", left = r.todos ? `할 일 ${r.todos}개 남음` : "";
  switch (r.kind) {
    case "working": return [label, r.detail, r.since ? runSince(r.since) : ""].filter(Boolean).join(" · ");
    case "waiting": {
      const what = r.reason === "later" ? "백그라운드 작업의 답을 기다리는 중" : r.detail;
      return [label, what, r.reason === "work" && r.since ? runSince(r.since) : "", left].filter(Boolean).join(" · ");
    }
    case "idle": {
      const why = r.reason === "unfinished" ? "이번 턴이 끝났는데 할 일이 남아 있어요" : r.reason === "unknown" ? "이유를 알 수 없어요" : "";
      return [label, left, why].filter(Boolean).join(" · ");
    }
    case "limited": return [label, r.detail ? `${kstTime(r.detail)}까지` : "잠시 쉬어요"].join(" · ");
    case "error": return [label, r.detail].filter(Boolean).join(" · ");
    case "stopped": return [label, r.reason === "owner" ? "직접 멈췄어요" : "", left].filter(Boolean).join(" · ");
    case "done": return [label, r.since ? kstHM(r.since) : ""].filter(Boolean).join(" · ");
    default: return label;
  }
}
// The one thing the owner can do about that state, when there is one.
function runAction(r) {
  if (r.kind === "waiting" && r.reason === "ask") return { label: "질문으로 가기", run: () => runAskGo() };
  if (r.kind === "idle") return { label: "계속하기", run: () => runContinue() };
  if (r.kind === "limited" || r.kind === "error") return { label: r.kind === "limited" ? "지금 다시 시도" : "다시 시도", run: ev => orchResume(ev.currentTarget) };
  if (r.kind === "stopped") return { label: "다시 시작", run: ev => runRestart(ev.currentTarget) };
  return null;
}
function paintRunState() {
  const box = $("#runstate");
  if (!box) return;
  const r = runStateOf();
  box.hidden = !r;
  $("#composer").classList.toggle("rs-on", !!r);
  if (!r) { RUN_MEMO.sig = ""; return; }
  const sig = JSON.stringify([target, r]), act = runAction(r);
  if (RUN_MEMO.sig !== sig) {
    RUN_MEMO.sig = sig;
    $("#runstate-dot").className = `dot ${RUN_DOT[r.kind] || ""}`.trim();
    box.classList.toggle("warn", r.kind === "waiting" || r.kind === "limited");
    box.classList.toggle("err", r.kind === "error");
    const b = $("#runstate-act");
    b.hidden = !act;
    b.dataset.kind = r.kind;
    if (act) { b.textContent = act.label; b.onclick = act.run; }
  }
  $("#runstate-tx").textContent = runText(r);
}
setInterval(() => { if (!document.hidden) paintRunState(); }, 1000);

// 질문으로 가기: the open question for this conversation, at the decision sheet (or its message).
async function runAskGo() {
  if (!NT.loaded) await loadNotices();
  const d = ntDecisions().find(n => {
    const to = n.decision && n.decision.to;
    return to === target || (target === MAIN && (to === "main" || String(to).startsWith("auth:")));
  });
  if (d) return noticeOpenId(d.id);
  toast("질문을 찾지 못했어요. 알림에서 확인해 주세요");
}
// 계속하기: one short message that starts the next turn where the last one stopped.
function runContinue() {
  if (ta.value.trim()) { toast("쓰던 메시지가 있어요. 먼저 보내 주세요"); ta.focus(); return; }
  ta.value = "계속해 주세요";
  autosize();
  sendChat();
}
// 다시 시작 (a stopped session): the gateway's restart, the same as the stopped banner (08-home.js).
const runRestart = btn => busy(btn, async () => {
  await api("/api/orchestrator/restart", "POST", {});
  toast("다시 시작할게요");
  scheduleState();
});
