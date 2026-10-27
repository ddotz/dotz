/* ---------- data: load history, take live events ---------- */
// 알림 / 작업 기록: a post edited in place (update_key, e.g. a lane's worklog line) is one message, its newest version.
const keyedOut = e => e.kind === "out" && !!e.update_key;
function dedupKeyed(s) {
  const last = new Map();
  for (const e of s.msgs) if (keyedOut(e)) last.set(e.update_key, e);
  s.msgs = s.msgs.filter(e => !keyedOut(e) || last.get(e.update_key) === e);
}
// The live version of a keyed post replaces the older one; returns the replaced event (so its unread mark is not counted twice).
function keyedReplace(s, e) {
  if (!keyedOut(e)) return null;
  const i = s.msgs.findIndex(o => o !== e && keyedOut(o) && o.update_key === e.update_key);
  return i < 0 ? null : s.msgs.splice(i, 1)[0];
}
function ingestMsg(e) {
  const t = eventTarget(e);
  if (!t) return;
  const s = ts(t), k = msgKey(e);
  if (s.mk.has(k)) return;
  s.mk.add(k); s.msgs.push(e);
  const was = isFixedT(t) ? keyedReplace(s, e) : null;
  if (s.msgs.length > 400) s.mk.delete(msgKey(s.msgs.shift()));
  if (isRestart(e)) paintRestartBanner();
  convNote(e, t, was);
  if (t === target && s.hLoaded && CV.full) { chatPush({ m: e }); if (ownerish(e)) termPush(ownerAct(e)); }   // CV.full: drawn (until then the draw takes it from msgs)
  if (t === target) paintDecision();
  if (isLaneT(t) && isLaneReport(e) && LP[t.slice(5)]) laneRefresh(LP[t.slice(5)]);
  if (chatAnswer(t, e) && !quietReply(s, e)) noteDone(t, e.ts, true);
}
// The main chat's and a project's finished turn is the orchestrator's answer stored in that chat (not a progress note), never the
// turn's end: a turn can end with nothing sent yet (answer deferred to a background worker, keepalive, a worker's wake-up run;
// owner 2026-10-21: the toast came before any message). A lane's finished turn stays its turn_end (its report has its own toast).
const chatAnswer = (t, e) => !isLaneT(t) && !isFixedT(t) && e.kind === "out" && e.source === "orchestrator" && !e.update_key;
// The orchestrator's first answer after a choice-button answer (an owner message with picks / decision, hub/intake.ts) is a quiet reply: no
// "답을 마쳤어요" toast and no unseen mark (hub/notices.ts answerReply keeps push and the notice list quiet the same way). One that asks or fails still counts.
function quietReply(s, e) {
  const tone = parseTone(String(e.text ?? "")).tone;
  if (tone === "ask" || tone === "fail") return false;
  for (let k = s.msgs.lastIndexOf(e) - 1; k >= 0; k--) {
    const p = s.msgs[k];
    if (OWNER.has(p.kind)) return !!((p.picks && p.picks.length) || p.decision);
    if (p.kind === "out" && !p.update_key && p.source === "orchestrator") return false;
  }
  return false;
}
// The orchestrator's activity is also the log of every loaded project target; a project's 대화 shows only its messages,
// since the same process also works for the main chat and other channels.
function ingestAct(a) {
  if (a.type === "text" && isLaterText(a.text)) return;   // the orchestrator's [later] turn end is no chat line
  const own = targetOfSource(a.source);
  for (const t of own === MAIN ? [MAIN, ...Object.keys(TS).filter(isProjT)] : [own]) {
    const s = ts(t), k = actKey(a);
    if (s.ak.has(k)) continue;
    s.ak.add(k); s.acts.push(a);
    if (s.acts.length > s.cap) s.ak.delete(actKey(s.acts.shift()));
    if (t === target && s.aLoaded && CV.full) { if (!isProjT(t)) chatPush({ a }); termPush(a); }
  }
}
// quiet: a repeated read of a peer's conversation (34-peer-monitoring.js) redraws only when it brought something new.
async function loadTarget(t, quiet) {
  const s = ts(t), before = s.mk.size;
  if (s.loading) return s.loading;
  s.loading = (async () => {
    await Promise.all([
      api(`/api/history?target=${enc(t)}&limit=150`).then(r => { s.hmore = (r.events || []).length >= 150; for (const e of r.events || []) { const k = msgKey(e); if (!s.mk.has(k)) { s.mk.add(k); s.msgs.push(e); } } s.msgs.sort(byTs); if (isFixedT(t)) dedupKeyed(s); s.herr = false; }, () => { s.herr = true; }),
      isFixedT(t) ? null : api(`/api/activity?source=${enc(sourceOf(t))}&limit=300`).then(r => { s.ahist = !!r.history; s.amore = !!r.more; for (const a of r.items || []) { const k = actKey(a); if (!s.ak.has(k) && !(a.type === "text" && isLaterText(a.text))) { s.ak.add(k); s.acts.push(a); } } s.acts.sort(byTs); }, () => {}),
    ]);
    s.hLoaded = s.aLoaded = true;
    if (t === MAIN) paintRestartBanner();
    { const te = isLaneT(t) ? s.acts.findLast(a => a.type === "turn_end") : s.msgs.findLast(e => chatAnswer(t, e) && !quietReply(s, e)); if (te) noteDone(t, te.ts, false); }
  })().finally(() => { s.loading = null; });
  await s.loading;
  if (t === target && (!quiet || s.mk.size !== before)) renderAll();
}
// A tapped push or notice names a message the stream may not have delivered (it stalls while the phone sleeps): fetch the
// history until that message is in. loadTarget joins a fetch already in flight, so the second round covers one that began before the message existed.
async function ensureMsg(t, at) {
  const s = ts(t);
  for (let i = 0; i < 2 && at && !s.msgs.some(e => e.ts >= at); i++) await loadTarget(t);
}
// The page is back after being away: whatever the stream missed is fetched now, before anyone taps a notification for it.
function resync() {
  refreshState();
  for (const k of Object.keys(TS)) if (k !== target) TS[k].hLoaded = TS[k].aLoaded = false;
  loadTarget(target); loadSubs(); loadQueue(); convLoad();
}
// Older activity from the saved session transcript, 300 at a time, prepended while the scroll position stays put.
async function loadOlder() {
  const t = target, s = ts(t);
  if (!s.amore || s.older || !s.aLoaded || !s.acts.length) return;
  s.older = true;
  try {
    const r = await api(`/api/activity?source=${enc(sourceOf(t))}&limit=300&before=${enc(s.acts[0].ts)}`);
    const add = (r.items || []).filter(a => !s.ak.has(actKey(a)));
    for (const a of add) s.ak.add(actKey(a));
    s.acts = [...add, ...s.acts]; s.cap += add.length; s.amore = !!r.more && add.length > 0; s.ahist = true;
    if (t === target) {
      const th = term.scrollHeight - term.scrollTop, ch = timeline.scrollHeight - timeline.scrollTop;
      renderAll(true);
      term.scrollTop = term.scrollHeight - th; timeline.scrollTop = timeline.scrollHeight - ch;
    }
  } catch { toast("이전 기록을 불러오지 못했어요", true); }
  finally { s.older = false; }
}
// Older chat messages, 150 at a time, when the conversation is scrolled to its top (history keeps more than the first read).
async function loadOlderMsgs() {
  const t = target, s = ts(t);
  if (!s.hmore || s.olderMsgs || !s.hLoaded || !s.msgs.length) return;   // one request in flight, and nothing past the beginning
  s.olderMsgs = true;
  try {
    // The message at the top of the view stays where it is while the older ones go in above it (the view is redrawn whole):
    // the opening's pin ("bottom") would push it back down on the redraw, so the owner's place takes over now.
    if (t === target) chatUnpin();
    const at = t === target ? chatAnchor() : null, ch = timeline.scrollHeight - timeline.scrollTop;
    const r = await api(`/api/history?target=${enc(t)}&limit=150&before=${enc(s.msgs[0].ts)}`);
    const add = (r.events || []).filter(e => !s.mk.has(msgKey(e)));
    for (const e of add) s.mk.add(msgKey(e));
    s.msgs = [...add, ...s.msgs]; s.hmore = (r.events || []).length >= 150 && add.length > 0;
    if (t === target && add.length) {
      renderAll(true);
      const now = at && [...tl.querySelectorAll("[data-ts]")].find(m => m.dataset.ts === at.ts);
      if (now) timeline.scrollTop += now.getBoundingClientRect().top - timeline.getBoundingClientRect().top - at.off;
      else timeline.scrollTop = timeline.scrollHeight - ch;
      chatStick = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
      $("#chat-jump").hidden = chatStick;
    }
  } catch { toast("이전 대화를 불러오지 못했어요", true); }
  finally { s.olderMsgs = false; if (t === target) paintOlderTop(); }
}
function renderAll(keepScroll) { renderAll0(keepScroll); mailSentPaint(); paintDecision(); paintTodo(); paintWorkers(); paintRunState(); edgeFade(timeline); edgeFade(term); }
function edgeFade(t) { const b = t.parentElement; b.classList.toggle("fade-t", t.scrollTop > 4); b.classList.toggle("fade-b", t.scrollTop + t.clientHeight < t.scrollHeight - 4); }
function renderAll0(keepScroll) {
  const s = ts(target);
  if (CV.full) { CV.snap = { top: timeline.scrollTop, stick: chatStick }; CV.full = false; }   // a redraw keeps the owner's place (chatOpen)
  resetChat(); resetTerm();
  if (!(s.hLoaded && s.aLoaded) || !chatReady()) {
    CS.empty = tl.appendChild(el("div", { class: "a-div", text: "불러오는 중…" }));
    termEmpty = term.appendChild(el("div", { class: "a-div", text: "불러오는 중…" }));
    return;
  }
  const A = s.acts, M = s.msgs, first = A.length ? A[0].ts : null;
  if (s.amore && A.length) term.append(el("button", { class: "btn text tmore", type: "button", onclick: () => loadOlder() }, "이전 기록 더 보기"));
  if (s.ahist && A.length) { tl.append(el("div", { class: "a-div", text: "지난 기록" })); term.append(el("div", { class: "tdv", text: "지난 기록" })); }
  let i = 0, j = 0;
  while (i < A.length || j < M.length) {
    if (j < M.length && (i >= A.length || M[j].ts <= A[i].ts)) {
      const m = M[j++];
      chatPush({ m }, true);
      if (ownerish(m) && first && m.ts >= first) termPush(ownerAct(m), true);
    } else { const a = A[i++]; if (!isProjT(target) && !isFixedT(target)) chatPush({ a }, true); termPush(a, true); }
  }
  if (tl.children.length <= 1) CS.empty = tl.appendChild(el("div", { class: s.herr ? "a-error" : "empty", text: s.herr ? "대화를 불러오지 못했어요" : "아직 대화가 없어요" }));   // only the top sentinel is there
  if (!term.children.length) termEmpty = term.appendChild(el("div", { class: "a-div", text: "활동이 없어요" }));
  if (!keepScroll) { chatOpen(); scrollTerm(true); } else { CV.snap = null; CV.full = true; }
  markLive();
}
function onActivity(a) {
  if (a.source === "orchestrator" || a.type === "turn_start" || a.type === "turn_end" || a.type === "status") scheduleState();
  ingestAct(a); todoActivity(a);
  if (a.type === "turn_end" && isLaneT(targetOfSource(a.source))) noteDone(targetOfSource(a.source), a.ts, true);
}

/* ---------- switching the target ---------- */
const DRAFT_KEY = t => `dotz-draft:${t}`;
function saveDraft() { ts(target).draft = ta.value; try { if (ta.value) localStorage.setItem(DRAFT_KEY(target), ta.value); else localStorage.removeItem(DRAFT_KEY(target)); } catch {} }
function setTarget(t) {
  if (!validTarget(t) || t === target) return;
  saveDraft();
  closeSheet();
  target = t;
  try { localStorage.setItem(TARGET_KEY, t); } catch {}
  if (current === "chat" || current === "activity") routeReplace(monCtx && current === "chat" ? `monitoring/c:${enc(t)}` : `${current}/${t}`);
  const s = ts(t);
  convSync();
  markSeen();
  if (!s.draft) { try { s.draft = localStorage.getItem(DRAFT_KEY(target)) || ""; } catch {} }
  ta.value = s.draft; autosize(); updateHints();
  updateComposerMeta(); renderBars(); renderSubs(); renderWorking();
  renderAll();
  if (!(s.hLoaded && s.aLoaded)) loadTarget(t);
  loadTodo(t);
}
function enterTarget() {
  $(current === "activity" ? "#v-activity" : "#v-chat").append($("#composer"));
  markSeen();
  updateComposerMeta(); renderBars(); renderSubs(); renderWorking(); paintDecision();
  if (current === "chat") { if (!CV.placed) scrollChat(true); } else scrollTerm(true);
  if (SUBD) renderSubSheet();
  autosize();
  if (!matchMedia("(pointer: coarse)").matches && !document.querySelector("dialog[open]")) ta.focus({ preventScroll: true });
}