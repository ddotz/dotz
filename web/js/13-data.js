/* ---------- data: load history, take live events ---------- */
function ingestMsg(e) {
  const t = eventTarget(e);
  if (!t) return;
  const s = ts(t), k = msgKey(e);
  if (s.mk.has(k)) return;
  s.mk.add(k); s.msgs.push(e);
  if (s.msgs.length > 400) s.mk.delete(msgKey(s.msgs.shift()));
  if (isRestart(e)) paintRestartBanner();
  if (!ownerish(e) && e.kind !== "delivery" && !cleanRestart(e) && !(t === target && current === "chat")) { s.unread++; renderBars(); }
  if (t === target && s.hLoaded) { chatPush({ m: e }); if (ownerish(e)) termPush(ownerAct(e)); }
  if (t === target) paintDecision();
  if (isLaneT(t) && isLaneReport(e) && LP[t.slice(5)]) laneRefresh(LP[t.slice(5)]);
  if (projAnswer(t, e)) noteDone(t, e.ts, true);
}
// A project's finished turn is the orchestrator's answer posted to its channel (not a progress note).
const projAnswer = (t, e) => isProjT(t) && e.kind === "out" && e.source === "orchestrator" && !e.update_key;
// The orchestrator's activity is also the log of every loaded project target; a project's 대화 shows only its messages,
// since the same process also works for the main chat and other channels.
function ingestAct(a) {
  const own = targetOfSource(a.source);
  for (const t of own === MAIN ? [MAIN, ...Object.keys(TS).filter(isProjT)] : [own]) {
    const s = ts(t), k = actKey(a);
    if (s.ak.has(k)) continue;
    s.ak.add(k); s.acts.push(a);
    if (s.acts.length > s.cap) s.ak.delete(actKey(s.acts.shift()));
    if (t === target && s.aLoaded) { if (!isProjT(t)) chatPush({ a }); termPush(a); }
  }
}
async function loadTarget(t) {
  const s = ts(t);
  if (s.loading) return s.loading;
  s.loading = (async () => {
    await Promise.all([
      api(`/api/history?target=${enc(t)}&limit=150`).then(r => { for (const e of r.events || []) { const k = msgKey(e); if (!s.mk.has(k)) { s.mk.add(k); s.msgs.push(e); } } s.msgs.sort(byTs); s.herr = false; }, () => { s.herr = true; }),
      api(`/api/activity?source=${enc(sourceOf(t))}&limit=300`).then(r => { s.ahist = !!r.history; s.amore = !!r.more; for (const a of r.items || []) { const k = actKey(a); if (!s.ak.has(k)) { s.ak.add(k); s.acts.push(a); } } s.acts.sort(byTs); }, () => {}),
    ]);
    s.hLoaded = s.aLoaded = true;
    if (t === MAIN) paintRestartBanner();
    { const te = isProjT(t) ? s.msgs.findLast(e => projAnswer(t, e)) : s.acts.findLast(a => a.type === "turn_end"); if (te) noteDone(t, te.ts, false); }
  })().finally(() => { s.loading = null; });
  await s.loading;
  if (t === target) renderAll();
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
function renderAll(keepScroll) { renderAll0(keepScroll); paintDecision(); paintTodo(); paintWorkers(); edgeFade(timeline); edgeFade(term); }
function edgeFade(t) { const b = t.parentElement; b.classList.toggle("fade-t", t.scrollTop > 4); b.classList.toggle("fade-b", t.scrollTop + t.clientHeight < t.scrollHeight - 4); }
function renderAll0(keepScroll) {
  const s = ts(target);
  resetChat(); resetTerm();
  if (!(s.hLoaded && s.aLoaded)) {
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
    } else { const a = A[i++]; if (!isProjT(target)) chatPush({ a }, true); termPush(a, true); }
  }
  if (!tl.children.length) CS.empty = tl.appendChild(el("div", { class: s.herr ? "a-error" : "empty", text: s.herr ? "대화를 불러오지 못했어요" : "아직 대화가 없어요" }));
  if (!term.children.length) termEmpty = term.appendChild(el("div", { class: "a-div", text: "활동 없음" }));
  if (!keepScroll) { scrollChat(true); scrollTerm(true); }
  markLive();
}
function onActivity(a) {
  if (a.source === "orchestrator" || a.type === "turn_start" || a.type === "turn_end" || a.type === "status") scheduleState();
  ingestAct(a); todoActivity(a);
  if (a.type === "turn_end") noteDone(targetOfSource(a.source), a.ts, true);
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
  if (current === "chat" || current === "activity") history.replaceState(null, "", `#${current}/${t}`);
  const s = ts(t);
  if (current === "chat") s.unread = 0;
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
  if (current === "chat") ts(target).unread = 0;
  markSeen();
  updateComposerMeta(); renderBars(); renderSubs(); renderWorking(); paintDecision();
  if (current === "chat") scrollChat(true); else scrollTerm(true);
  if (SUBD) renderSheet();
  autosize();
  if (!matchMedia("(pointer: coarse)").matches && !document.querySelector("dialog[open]")) ta.focus({ preventScroll: true });
}