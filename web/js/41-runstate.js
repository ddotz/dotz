/* ---------- run state: one line above the composer saying what this conversation's agent is doing ---------- */
// /api/state `runs` (hub/runstate.ts, derived from real hub state) carries {kind, reason, since, detail, todos} for the main
// conversation and every lane. The line always says one of 작업 중 / 답을 기다려요 / 쉬는 중 / 한도에 걸렸어요 / 오류로 멈췄어요 /
// 멈춤 / 끝났어요. An idle conversation with plan tasks left names the reason (no button): the owner's complaint was
// "todo는 남아있는데 아무것도 안하고 있을때 왜 안하는지 모르는 경우가 많음", so "쉬는 중" alone is never the answer.
const RUN_LABEL = { working: "작업 중", waiting: "답을 기다려요", idle: "쉬는 중", limited: "한도에 걸렸어요", error: "오류로 멈췄어요", stopped: "멈춤", done: "끝났어요" };
const RUN_DOT = { working: "pri", waiting: "warn", idle: "", limited: "warn", error: "err", stopped: "", done: "ok" };
// "답을 기다려요" only when the owner's answer is awaited (a question); work the agent handed off reads as its own progress and is not
// colored as needing him (owner 2026-10-28: "답을 기다려요" read as waiting on him; he picked "맡긴 작업 진행 중").
// recover: a background worker failed and the agent takes it up itself (hub/runstate.ts failedRun) - its progress, not a request to the owner.
const waitLabel = r => r.reason === "ask" ? RUN_LABEL.waiting : r.reason === "capacity" ? "순서를 기다려요" : r.reason === "recover" ? "이어서 처리 중" : "맡긴 작업 진행 중";
const waitsOnOwner = r => r.kind === "waiting" && r.reason === "ask";
// A conversation waiting on work it handed off or on its turn (capacity) is progressing: blue on every row that shows it, like this line.
const runOf = t => (S && S.runs && S.runs[t === MAIN ? "main" : t]) || null;
const runBusy = t => { const r = runOf(t); return !!r && r.kind === "waiting" && !waitsOnOwner(r); };
const RUN_MEMO = { sig: "" };
const runStateOf = () => {
  if (isFixedT(target) || isSettingsT(target)) return null;
  const runs = (S && S.runs) || {};
  // A mail conversation's run state is the background worker its request was deferred to (hub/routes.ts stateRuns): this
  // computer's under /api/state `runs`, the other computer's in its monitoring snapshot (34-peer-monitoring.js pqRuns).
  if (isMailT(target)) return (typeof pqRuns === "function" && pqRuns(target)) || runs[target] || null;
  // A project channel, thread or settings screen with a session of its own (hub/convsessions.ts) has its own line.
  return (isLaneT(target) ? runs[target] : runs[target] || runs.main) || null;
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
    case "waiting": return [waitLabel(r), r.reason === "later" ? "" : r.reason === "recover" && r.detail ? `${r.detail.split(" · ")[0]} 실패` : r.detail, r.reason === "work" && r.since ? runSince(r.since) : "", left].filter(Boolean).join(" · ");
    case "idle": {
      const why = r.reason === "unfinished" ? "이번 턴이 끝났는데 할 일이 남아 있어요" : r.reason === "unknown" ? "이유를 알 수 없어요" : "";
      return [label, left, why].filter(Boolean).join(" · ");
    }
    case "limited": return [label, r.detail ? `${kstTime(r.detail)}까지` : "잠시 쉬어요"].join(" · ");
    case "error": return [r.reason === "work" ? (r.cancelled ? "중단됨" : "실패") : label, r.detail].filter(Boolean).join(" · ");
    case "stopped": return [label, r.reason === "owner" ? "직접 멈췄어요" : "", left].filter(Boolean).join(" · ");
    case "done": return [label, r.detail, r.since ? kstHM(r.since) : ""].filter(Boolean).join(" · ");
    default: return label;
  }
}
// The one thing the owner can do about that state, when there is one, for the conversation it is shown in: a background worker is
// stopped (중단) or handed over again (다시 맡기기) on its own; a session restarts itself, never the assistant; a mail conversation has no
// session to resume or restart; a feed (알림, 작업내역) gets nothing that stops or restarts anything. The other computer's worker is
// that computer's to act on, so its line offers no button here.
function runAction(r, t = target) {
  if (r.kind === "waiting" && r.reason === "ask") return { label: "질문으로 가기", run: () => runAskGo() };
  if (isFixedT(t)) return null;
  const peer = isMailT(t) && typeof pqPc === "function" && !!pqPc(t);
  if (r.work && !peer) {
    // 중단 is the send button itself while work runs (14-slash-commands.js renderWorking: send turns into stop), not a second button here.
    if (r.kind === "working" || (r.kind === "waiting" && (r.reason === "work" || r.reason === "recover"))) return null;
    if (r.kind === "error" && r.reason === "work") return { label: "다시 맡기기", run: ev => workRetry(r.work, ev.currentTarget) };
  }
  if (isMailT(t)) return null;
  // idle with tasks left only says why; no 계속하기 button (owner 2026-10-28: "계속하기 버튼 너무 거슬린다") - a message continues it.
  if (isLaneT(t)) return r.kind === "error" || r.kind === "stopped" ? { label: "다시 시작", run: ev => runLaneRestart(laneOf(t), ev.currentTarget) } : null;
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
    const mine = r.kind === "error" && r.cancelled;   // work the owner stopped himself is neutral, not a failure
    $("#runstate-dot").className = `dot ${r.kind === "waiting" && !waitsOnOwner(r) ? "pri" : mine ? "" : RUN_DOT[r.kind] || ""}`.trim();
    box.classList.toggle("warn", waitsOnOwner(r) || r.kind === "limited");
    box.classList.toggle("err", r.kind === "error" && !mine);
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
// 다시 시작 (a stopped session): the gateway's restart, the same as the stopped banner (08-home.js).
const runRestart = btn => busy(btn, async () => {
  await api("/api/orchestrator/restart", "POST", {});
  toast("다시 시작할게요");
  scheduleState();
});
// 다시 시작 (a session that stopped or failed): that session's own restart, the same as its ⋯ menu on 홈 (08-home.js).
const runLaneRestart = (name, btn) => busy(btn, async () => {
  await api(`/api/lanes/${enc(name)}/restart`, "POST", {});
  toast("다시 시작할게요");
  scheduleState();
});
