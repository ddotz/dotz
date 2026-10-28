// Boot runs after every module file (files join in name order): go() on the first frame already reaches the chat list
// (31-conversations.js) and the notices (30-notices.js), whose top-level state must exist by then.
/* ---------- boot ---------- */
(async () => {
  // The owner's custom layer (web/custom.js) comes in after the page has loaded and never holds it: a <script> tag for it kept the document
  // loading while the gateway did not answer, and the load event (the service worker's registration waits on it) never came. It catches up on the open view.
  const custom = () => document.body.append(Object.assign(document.createElement("script"), { src: "/custom.js" }));
  if (document.readyState === "complete") custom(); else addEventListener("load", custom, { once: true });
  const h = parseHash();
  go(h.view || "home", h.t);
  // The first paint needs the history and the plan, not the state: ask for all of them at once instead of state first (the state
  // is the biggest answer and nothing the conversation draws waits for it; a lane that is gone is switched away from inside refreshState).
  const state = refreshState();
  loadTarget(target); loadTodo(target); prjLoad().then(() => renderBars(), () => {});
  await state;
  if (pushOpenTs) { const at = pushOpenTs; pushOpenTs = ""; pushOpen(location.hash, at); }   // the app was started by a tap on a push
  loadModels(true);
  loadProviderData().then(() => { if (current === "home") renderHome(); }, () => {});
  loadSubs(); loadQueue(); loadContext(true).then(renderCtxRing);
  let opened = false, es;
  // The stream is a function so a page that comes back from the back/forward cache (the browser closes the stream when it freezes the page) can open a new one.
  const openStream = () => {
  if (es) es.close();
  es = new EventSource("/api/events");
  // The browser resends the last frame id on reconnect and the gateway replays only what was missed. "reset" comes on
  // the first connect and when the gap cannot be replayed (gateway restarted, or too long away): only then refetch.
  es.onopen = () => setConn(true);
  es.addEventListener("reset", () => {
    if (opened) { refreshState(); for (const k of Object.keys(TS)) TS[k].hLoaded = TS[k].aLoaded = false; renderAll(); loadTarget(target); loadSubs(); loadQueue(); laneTailsStale(); convLoad(); kkResync(); }
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
    else if (e.kind === "peer_notice" || e.kind === "peer_counts" || e.kind === "peer_notice_done") prLive(e);
    else if (e.kind === "read") convOnRead(e);
    else if (e.kind === "comment" || e.kind === "comment_send" || e.kind === "comment_draft" || e.kind === "comment_sources") cmLive(e);
    else if (e.kind === "kakao" || e.kind === "kakao_send" || e.kind === "kakao_draft" || e.kind === "kakao_rooms" || e.kind === "kakao_read" || e.kind === "kakao_unreplied") kkLive(e);
    else if (e.kind === "mail_unreplied") { convLoad(); loadIntegrations(); }
    else if (e.kind === "runtime_check") { if (rtLive) rtLive(); }
    else if (e.kind === "update_available") { if (!e.ts || Date.now() - Date.parse(e.ts) < 60_000) toast(e.text, false, { label: "보기", onclick: updOpen }, 10000); loadUpdate(); }
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
  };
  openStream();
  // Leaving for the other computer (33-peers.js) and coming back with the back button restores this page frozen from the bfcache: its stream is
  // dead and nothing booted again. pagehide closes the stream on purpose; pageshow(persisted) opens a new one (its first frame is a "reset", which refetches everything).
  addEventListener("pagehide", () => { if (es) es.close(); });
  addEventListener("pageshow", ev => { if (ev.persisted) { homeTop(); openStream(); resync(); prLoad(); loadStrip(); loadUpdate(); } });
  // A hidden page (a background tab, a phone in a pocket) skips the state and model polls; wake() catches up on return. Each /api/models
  // poll could start a model-list process on the gateway, so a forgotten tab cost the computer one every minute for nothing.
  const missed = { state: false, models: false };
  const unlessHidden = (key, fn) => () => { if (document.hidden) missed[key] = true; else fn(); };
  setInterval(unlessHidden("state", refreshState), 15000);
  // The 새 버전 badge comes from /api/update: read it on open and again every few minutes.
  loadUpdate(); setInterval(loadUpdate, 5 * 60000);
  // The plan normally refetches when a todo tool call ends; this is the fallback while the open target works.
  setInterval(() => { if (current === "chat" && !document.hidden && isWorking(target)) loadTodo(target); }, 20000);
  $("#ustrip").onclick = () => go("usage");
  loadStrip(); setInterval(loadStrip, 60000);
  // The stream stalls while the phone sleeps (a push can land before the message does): coming back after a few seconds away, refetch.
  let hiddenAt = 0;
  const wake = () => {
    const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0; if (es.readyState === 2) openStream();
    if (away > 5000) resync(); else if (missed.state) refreshState();
    if (missed.models) loadModels(true);
    missed.state = missed.models = false;
  };
  document.addEventListener("visibilitychange", () => { markSeen(); attnChanged(); loadStrip(); if (document.hidden) hiddenAt = Date.now(); else wake(); });
  addEventListener("focus", wake);
  setInterval(unlessHidden("models", () => loadModels(true)), 60000);
})();
