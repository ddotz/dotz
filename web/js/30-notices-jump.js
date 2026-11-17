/* ---- tap: go to the source message ---- */
// The conversation holding the notice's message (n.src; older items fall back to n.open) is opened on its chat view, older history
// is fetched until the message's time is covered, the message is scrolled to the top of the timeline and flashed. A message that is not in that
// conversation is asked of the gateway (ntLocate: a row stored with the wrong conversation, a session that has ended); a message the gateway does not hold
// lands on a neighbour only within NT_NEAR_MS, else the conversation stays at its end. Alert and worklog posts are messages of the 알림 / 작업 기록 conversations. Nothing here ever reports an error.
const NT_NEAR_MS = 60_000;   // the median gap between two messages of the main chat is 44 s (alert 3.8 min, worklog 25 min): a neighbour this close is the same exchange
const ntRaf = () => new Promise(r => requestAnimationFrame(() => r()));
function ntGo(t, kept = false) {
  if (t === "settings") { go("settings"); return ""; }   // the 새 버전 notice: 설정 → 업데이트
  if (!kept && isLaneT(t) && S && !S.lanes.some(l => `lane:${l.name}` === t)) t = MAIN;   // `kept`: the gateway holds the message in that session's history   // the session is gone: its result card is in the main chat
  if (t !== MAIN && isProjT(t) && S && !projTargets().includes(t)) { toast(TX("project.not_found")); go("projects"); return ""; }
  if (!validTarget(t)) { toast(TX("conv.nt.no_screen")); go("home"); return ""; }
  if (t === "alert") nscPass(1000);   // the one way into the record conversation: a row's source message (#chat/alert alone is the 알림 screen)
  if (current !== "chat" || target !== t || convListing()) go("chat", t);   // already open (a cold start draws the address first): no second draw
  return t;
}
// The rendered message of an event ts (data-ts is set in chatPush): the exact one, else the nearest in time within NT_NEAR_MS, else none.
function ntFind(at) {
  const want = Date.parse(at);
  let best = null, gap = NT_NEAR_MS + 1;
  for (const m of tl.querySelectorAll("[data-ts]")) {
    if (m.dataset.ts === at) return m;
    const d = Math.abs(Date.parse(m.dataset.ts) - want);
    if (d < gap) { gap = d; best = m; }
  }
  return best;
}
// The other conversation the gateway holds the message of `at` in (/api/history?locate=), "" when it holds it nowhere else. Asked only after the exact message was not found.
async function ntLocate(at, not = "") {
  try { return ((await api(`/api/history?locate=${enc(at)}`)).convs || []).find(c => c !== not && validTarget(c)) || ""; } catch { return ""; }
}
// Older messages, 300 at a time (up to four rounds), until the loaded history reaches back to `at`; a message further back comes in with the page around it
// (GET /api/history?around=, joined by chatMerge as a quote's original is, rpJump). Only a message the gateway no longer holds is left to the caller's toast.
async function ntReach(t, at) {
  const s = ts(t);
  for (let i = 0; i < 4 && s.msgs.length && s.msgs[0].ts > at; i++) {
    let r;
    try { r = await api(`/api/history?target=${enc(t)}&limit=300&before=${enc(s.msgs[0].ts)}`); } catch { return; }
    const add = (r.events || []).filter(e => !s.mk.has(msgKey(e)));
    if (!add.length) return;
    for (const e of add) { s.mk.add(msgKey(e)); s.msgs.push(e); }
    s.msgs.sort(byTs); s.cap += add.length;
    if (isFixedT(t)) dedupKeyed(s);
    if (t === target) renderAll(true);
  }
  if (!s.msgs.length || s.msgs.some(e => e.ts === at)) return;
  try {
    const r = await api(`/api/history?target=${enc(t)}&limit=150&around=${enc(at)}`);
    if (!r.at || t !== target) return;
    chatMerge(s, r);
    renderAll(true);
  } catch (e) { console.warn("history around", e); }
}
// The element that carries the highlight: the card or bubble inside the message when there is one, else the message itself. Anything that paints
// its own fill keeps the glow on its own rounded shape; plain text gets the tint alone ("nt-bar"). ~2s soft fade (a brief still tint under reduced motion: 09-notices.css).
function ntHlHost(node) {
  const card = node.matches(".um") ? node.querySelector(":scope > .ub") : node.matches(".bm, .cmdbox") ? node.querySelector(":scope > .ccard") : null;
  return { host: card || node, bar: !card && /(\d, ){3}0\)$/.test(getComputedStyle(node).backgroundColor) };   // alpha 0: no fill of its own
}
function ntFlash(node) {
  const { host, bar } = ntHlHost(node);
  if (host.classList.contains("nt-hl")) return;   // the first draw lit it and the notice list confirmed it: the glow does not restart
  for (const x of document.querySelectorAll(".nt-hl")) x.classList.remove("nt-hl", "nt-bar");
  void host.offsetWidth;
  host.classList.add("nt-hl");
  host.classList.toggle("nt-bar", bar);
  clearTimeout(host._hl);
  host._hl = setTimeout(() => host.classList.remove("nt-hl", "nt-bar"), 2300);
}
let ntJumpSeq = 0;
let ntKeep = "";   // the session a tapped notice opened: it may end while its report is on screen, and the view then stays (refreshState)
// `quiet`: a sheet is opening over the conversation and says what the notice is about itself, so a message that is gone needs no toast.
// `via`: the conversation the gateway said holds the message (the second try, never a third).
const ntWhere = n => n.msg || n.src || n.open || "main";   // the conversation a notice leads to
async function ntJump(n, quiet = false, via = "") {
  const seq = ++ntJumpSeq, at = n.at || n.updated || n.ts, want = via || ntWhere(n), ended = () => isLaneT(want) && S && !S.lanes.some(l => `lane:${l.name}` === want);
  let open = want, located = !!via;
  // A session this page has not read yet (it began and ended while the page slept) is not gone: ask the gateway before ntGo sends the tap to the main chat.
  if (!via && ended()) { await refreshState(); if (seq !== ntJumpSeq) return; }
  // An ended session keeps its history at the gateway, and its report may have been posted to 작업 기록: open where the message is.
  if (!via && ended()) { const c = await ntLocate(at); if (seq !== ntJumpSeq) return; if (c) { open = c; located = true; } }
  const t = ntGo(open, located);
  if (!t) return "no-conversation";
  if (isLaneT(open) && t === MAIN) { toast(TX("conv.nt.session_gone")); return "session-gone"; }   // the main chat has no message of it: say so instead of landing on the nearest one
  chatUnpin();
  ntKeep = isLaneT(t) ? t : "";
  cvJump(at);   // set after ntGo (a new opening resets it): the opening's first draw lands on this message, not on the "새 메시지" divider (chatOpen)
  try {
    const s = ts(t), stored = s.msgs.some(e => e.ts === at);
    if (!(s.hLoaded && s.aLoaded)) { if (stored) loadTarget(t, true).catch(() => {}); else await loadTarget(t); }   // the message is here: land now, refresh behind it
    await ensureMsg(t, at);   // a stale stream may not have the message yet: fetch it before jumping
    await ntReach(t, at);
    for (let i = 0; i < 300 && seq === ntJumpSeq && !CV.placed; i++) await ntRaf();   // the opening's first draw waits for the read position (chatReady)
    if (seq !== ntJumpSeq || target !== t || current !== "chat") return "moved-on";
    chatShow(at);
    let m = ntFind(at), exact = !!m && m.dataset.ts === at;
    if (!exact && !located) {   // not where the row said: the one place the page asks the gateway, so a tap that finds its message costs nothing extra
      const c = await ntLocate(at, t);
      if (seq !== ntJumpSeq) return "moved-on";
      if (c) return ntJump(n, quiet, c);
    }
    if (m) chatJump(m); else chatPin("bottom");   // no message to show: the conversation stays at its end, whatever pages the search loaded meanwhile
    if (exact) ntFlash(m);
    else {
      const unshown = !m && ts(t).msgs.some(e => e.ts === at && cleanRestart(e));   // stored but never drawn (a restart with nothing cut off): not a missing message
      if (n.at && !quiet) toast(m ? TX("conv.nt.nearby") : unshown ? TX("conv.nt.unshown") : TX("conv.nt.no_msg"));
      return m ? "near-message" : "no-message";   // what a tap on a push reports to the gateway (23-installable-app-web.js pushTapReport)
    }
  } catch {}
}
// The conversation behind a sheet (a decision, an [ask], a failure): the same jump, without one for a question that has no conversation (a login request) or lives on another computer.
const ntUnder = n => { if (!n.pc && !n.decision?.to?.startsWith("auth:") && validTarget(n.src || n.open || "")) ntJump(n, true); };
