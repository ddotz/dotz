// Boot runs after every module file (files join in name order): go() on the first frame already reaches the chat list
// (31-conversations.js) and the bell (30-notices.js), whose top-level state must exist by then.
/* ---------- boot ---------- */
(async () => {
  const h = parseHash();
  go(h.view || "home", h.t);
  await refreshState();
  loadTarget(target); loadTodo(target); prjLoad().then(() => renderBars(), () => {});
  loadModels(true);
  loadProviderData().then(() => { if (current === "home") renderHome(); }, () => {});
  loadSubs(); loadQueue(); loadContext(true).then(renderCtxRing);
  let opened = false;
  const es = new EventSource("/api/events");
  // The browser resends the last frame id on reconnect and the gateway replays only what was missed. "reset" comes on
  // the first connect and when the gap cannot be replayed (gateway restarted, or too long away): only then refetch.
  es.onopen = () => setConn(true);
  es.addEventListener("reset", () => {
    if (opened) { refreshState(); for (const k of Object.keys(TS)) TS[k].hLoaded = TS[k].aLoaded = false; renderAll(); loadTarget(target); loadSubs(); loadQueue(); laneTailsStale(); convLoad(); }
    opened = true;
  });
  es.onerror = () => setConn(false);
  es.onmessage = m => {
    let e;
    try { e = JSON.parse(m.data); } catch { return; }
    if (e.kind === "activity") { onActivity(e); laneActivity(e); }
    else if (e.kind === "subagents") setSubs(e.source, e.items);
    else if (e.kind === "queue") { QUEUE = e.items || []; renderQueue(); }
    else if (e.kind === "notice" || e.kind === "notice_read" || e.kind === "notice_dismiss") noticeLive(e);
    else if (e.kind === "read") convOnRead(e);
    else if (e.kind === "runtime_check") { if (rtLive) rtLive(); }
    else if (e.kind === "update_available") { if (!e.ts || Date.now() - Date.parse(e.ts) < 60_000) toast(e.text, false, { label: "보기", onclick: () => go("settings") }, 10000); if (current === "settings") loadUpdate(); }
    // 구성 (lanes node, 프로젝트) is drawn from /api/harness, not the state: reload it too when a lane starts or ends.
    else if (e.kind === "lanes") { if (e.was_live && !e.live) refreshState(); else scheduleState(); if (e.was_live !== e.live && current === "harness") loadHarness(true); }
    else {
      ingestMsg(e); scheduleState();
      // Live notices only (not the replay after a reconnect): alert / worklog posts, the gateway's own notes (sent to the web
      // when Discord is off) and lane reports float in the corner.
      const fresh = !e.ts || Date.now() - Date.parse(e.ts) < 60_000;
      const notice = e.kind === "out" && (e.target === "alert" || e.target === "worklog" || (e.target === "web" && e.source === "gateway"));
      if (fresh && (notice || e.kind === "lane_report")) notify(e);
    }
  };
  setInterval(refreshState, 15000);
  // The plan normally refetches when a todo tool call ends; this is the fallback while the open target works.
  setInterval(() => { if (current === "chat" && !document.hidden && isWorking(target)) loadTodo(target); }, 20000);
  $("#ustrip").onclick = () => go("usage");
  loadStrip(); setInterval(loadStrip, 60000);
  document.addEventListener("visibilitychange", () => { markSeen(); attnChanged(); loadStrip(); });
  setInterval(() => loadModels(true), 60000);
})();
