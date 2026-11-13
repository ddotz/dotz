// Boot runs after every module file (files join in name order): go() on the first frame already reaches the chat list
// (31-conversations.js) and the notices (30-notices.js), whose top-level state must exist by then.
/* ---------- boot ---------- */
(async () => {
  // The owner's custom layer (web/custom.js) comes in after the page has loaded and never holds it: a <script> tag for it kept the document
  // loading while the gateway did not answer, and the load event (the service worker's registration waits on it) never came. It catches up on the open view.
  // #cardform is drawn only by that layer: without it (a failed load, the demo's empty file) the address goes home instead of staying empty.
  const noCustom = () => { if (!window.dotzCustom && current === "cardform") go("home"); };
  const custom = () => document.body.append(Object.assign(document.createElement("script"), { src: "/custom.js", onload: noCustom, onerror: noCustom }));
  if (document.readyState === "complete") custom(); else addEventListener("load", custom, { once: true });
  pushTapCheck();
  await snapHomeSeed();
  let h = parseHash();
  if (pushOpenTs && h.view === "chat" && h.t === "alert") h = { view: "notices", t: "" };   // #chat/alert is the 알림 screen: drawn first, then pushOpen lands on the item
  go(h.view || "home", h.t);
  if (pushOpenTs && h.view === "chat") CV.jump = pushOpenTs;   // the first draw lands on the tapped message (chatOpen); 30-notices.js pushOpen finishes by its kind
  // The first paint needs the history and the plan, not the state: ask for all of them at once instead of state first (the state
  // is the biggest answer and nothing the conversation draws waits for it; a lane that is gone is switched away from inside refreshState).
  const state = refreshState();
  // #notices needs the state and the notices (asked for in index.html), not the main chat: go() loads a conversation when it is first opened.
  // Landing on 홈 (every computer switch from a conversation does) the hidden conversation waits for the state: its activity is the slowest answer on a busy gateway.
  const loadOpen = () => { snapSeed(target).then(seeded => loadTarget(target, seeded)); loadTodo(target); };
  if (h.view === "notices") { /* its list is already on the way */ }
  else if ((!h.view || h.view === "home") && !pushOpenTs) state.then(loadOpen);
  else loadOpen();
  prjLoad().then(() => renderBars(), () => {});
  // 알림 and 작업내역 sit one tap away and their answers are small: read ahead once the page has settled, so their first opening has something to show.
  if (h.view !== "notices") setTimeout(() => { for (const t of ["worklog"]) if (t !== target && !ts(t).hLoaded) loadTarget(t, true).catch(() => {}); }, 1500);
  await state;
  paneRestore();
  if (pushOpenTs) { const at = pushOpenTs; pushOpenTs = ""; pushTapCold(pushOpen(PUSH_HASH, at, pushOpenNid)); }   // the app was started by a tap on a push
  else if (!pushQ.has("n")) pushTapCold();   // a decision (?n=) reports when its sheet is open (30-notices.js)
  introStart();   // the screen tour (42-intro.js) asks the gateway after a pause; nothing here waits for it
  loadModels(true);
  loadProviderData().then(() => { if (current === "home") renderHome(); }, () => {});
  loadSubs(); loadQueue(); loadContext(true).then(renderCtxRing);
  let opened = false, es, lastId = "", fast = true, retryT = 0, tries = 0, parkedAt = 0;
  // The stream is a function so a page that comes back from the back/forward cache (the browser closes the stream when it freezes the page) can open a new one.
  // `live` names the stream to the gateway (it closes a stream nobody vouches for, hub/events.ts); `last` replays what a new stream missed, as the browser does on its own reconnect.
  const openStream = () => {
  if (es) es.close();
  clearTimeout(retryT); retryT = 0;
  es = new EventSource(`/api/events?live=${LIVE_TOK}${lastId ? `&last=${lastId}` : ""}`);
  // The browser resends the last frame id on reconnect and the gateway replays only what was missed. "reset" comes on
  // the first connect and when the gap cannot be replayed (gateway restarted, or too long away): only then refetch.
  es.onopen = () => { fast = true; tries = 0; setConn(true); outboxGo(); };
  es.addEventListener("reset", m => {
    lastId = m.lastEventId;
    trLoad();   // the waiting approvals by app instance: the 빠른 처리 banner (30-triage.js)
    // The drawn conversation stays as it is: loadTarget redraws it only when the read brought something new.
    if (opened) { refreshState(); for (const k of Object.keys(TS)) TS[k].hLoaded = TS[k].aLoaded = false; loadTarget(target, hasCached(ts(target))); loadSubs(); loadQueue(); laneTailsStale(); convLoad(); kkResync(); }
    opened = true;
  });
  // A stream the gateway closed (a cleanup, a slow reader) is attached again at once, not after the browser's wait, so the 2 s of setConn pass unseen. Behind a proxy that
  // answers 502/503 while the gateway is down the browser gives up (CLOSED) and never retries: one timer opens it again, after 0.25 s, 0.5 s, 1 s ... up to 5 s (a hidden page: 15 s).
  es.onerror = () => {
    if (fast) { fast = false; openStream(); }
    else if (es.readyState === 2 && !retryT) retryT = setTimeout(openStream, Math.max(Math.min(250 * 2 ** tries++, 5000), document.hidden ? 15000 : 0));
    setConn(false);
  };
  es.onmessage = m => {
    lastId = m.lastEventId;
    let e;
    try { e = JSON.parse(m.data); } catch { return; }
    if (e.kind === "activity") { onActivity(e); laneActivity(e); }
    else if (e.kind === "subagents") setSubs(e.source, e.items);
    else if (e.kind === "queue") { QUEUE = e.items || []; renderQueue(); }
    else if (e.kind === "waitlist") { if (S) S.waitlist = e.items || []; scheduleState(); }   // 할일 changed (hub/waitlist.ts)
    else if (e.kind === "work") { workRowsLive(e); scheduleState(); }   // a background job changed (hub/workrows.ts): its rows, then the lists
    else if (e.kind === "notice" || e.kind === "notice_read" || e.kind === "notice_dismiss") { noticeLive(e); if (e.kind === "notice") trSoon(); }
    else if (e.kind === "approval_send") { trLive(e); dcUndoLive(e); rqSoon(); }
    else if (e.kind === "reply") raLive(e);   // the one reply flow: a draft or its send changed (10-reply-actions.js)
    else if (e.kind === "approvals") trSoon();
    else if (e.kind === "quota") quotaLive(e.quota);   // the gateway's background usage read changed (09-needs-you.js)
    else if (e.kind === "peer_notice" || e.kind === "peer_counts" || e.kind === "peer_notice_done") prLive(e);
    else if (e.kind === "read") convOnRead(e);
    else if (e.kind === "comment" || e.kind === "comment_send" || e.kind === "comment_draft" || e.kind === "comment_sources") cmLive(e);
    else if (e.kind === "kakao" || e.kind === "kakao_send" || e.kind === "kakao_draft" || e.kind === "kakao_rooms" || e.kind === "kakao_read" || e.kind === "kakao_unreplied") kkLive(e);
    else if (e.kind === "mail_unreplied") mailLive();
    else if (e.kind === "project_info") pmLive(e);
    else if (e.kind === "runtime_check") { if (rtLive) rtLive(); }
    else if (e.kind === "update_available") loadUpdate();   // the top update bar (24-settings-update.js) offers it
    // 구성 (lanes node, 프로젝트) is drawn from /api/harness, not the state: reload it too when a lane starts or ends.
    else if (e.kind === "lanes") { if (e.was_live && !e.live) refreshState(); else scheduleState(); if (e.was_live !== e.live && current === "harness") loadHarness(true); if (e.was_live !== e.live) convLoad(); }   // an ended lane's unread drops to 0, a resumed one recounts
    else {
      ingestMsg(e); scheduleState();
      // Live notices only (not the replay after a reconnect): alert / worklog posts, the gateway's own notes (sent to the web
      // when Discord is off) and lane reports float in the corner.
      const fresh = !e.ts || Date.now() - Date.parse(e.ts) < 60_000 || (parkedAt && Date.parse(e.ts) > parkedAt);   // parkedAt: what came while the page was hidden is new to its owner, also when a frozen page gets it as a replay
      const notice = e.kind === "out" && (e.target === "alert" || e.target === "worklog" || (e.target === "web" && e.source === "gateway"));
      if (fresh && (notice || e.kind === "lane_report")) notify(e);
    }
    paneEvent(e);
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
  loadUpdate(); setInterval(() => { if (!document.hidden) loadUpdate(); }, 5 * 60000);
  // The plan normally refetches when a todo tool call ends; this is the fallback while the open target works.
  setInterval(() => { if (current === "chat" && !document.hidden && isWorking(target)) loadTodo(target); }, 20000);
  $("#ustrip").onclick = () => go("usage");
  loadStrip(); setInterval(loadStrip, 60000);
  // The stream stalls while the phone sleeps (a push can land before the message does): coming back after a few seconds away, refetch.
  let hiddenAt = 0;
  const wake = () => {
    pushTapCheck();
    const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0; if (es.readyState === 2) openStream(); setTimeout(() => { parkedAt = 0; }, 10_000);
    if (away > 5000) resync(); else if (missed.state) refreshState();
    if (missed.models) loadModels(true);
    missed.state = missed.models = false;
  };
  // A hidden page keeps its stream (the tab title count and the unread marks follow it) and vouches for it with the smallest answer the gateway has, once a minute
  // (a visible page vouches with every request). A frozen page cannot: the gateway drops its stream after LIVE_MAX_MS and wake() attaches again with the frames it missed.
  setInterval(() => { if (document.hidden) api("/api/health").catch(() => { /* a down gateway is the stream's retry to handle */ }); }, 60000);
  document.addEventListener("visibilitychange", () => {
    markSeen(); attnChanged(); loadStrip();
    if (document.hidden) { hiddenAt = parkedAt = Date.now(); } else wake();
  });
  addEventListener("focus", wake);
  setInterval(unlessHidden("models", () => loadModels(true)), 60000);
})();
