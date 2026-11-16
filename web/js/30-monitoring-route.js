/* ---------- monitoring: how the screen is left ---------- */
// 모니터링's 뒤로 closes what is open on the screen before it leaves it, in this order: the app settings pane (32-app-settings.js),
// the reply sheet in its pane (30-replies.js), an open KakaoTalk room (30-kakao.js), an open comment or DM thread
// (30-monitoring-comments.js), then a mailbox settings page (30-mailboxes-set.js). Each closer checks it is on 모니터링 itself.
function monBack() { return asBack() || rqBack() || kkBack() || cmBack() || mxsBack(); }
// 모니터링 opening, or a conversation opening inside it (13-data.js chatEnter): the list is drawn and its reads refreshed when stale.
// A conversation reads the app list kept fresh already; the read it sends asks again, so it asks only before the first one.
function monEnter() { renderMonitoring(); if (!monitorsFresh()) loadMonitors(); if (!noticesFresh()) loadNotices(); if (current === "monitoring" || !INTG.loaded) loadIntegrations(); }
// The routes behind 모니터링 (32-history-nav.js routeChain): an open item sits on the list, a mailbox settings screen on its box (30-mailboxes-set.js mxChain).
function monChain(hash) { return !MON.list ? ["home", "monitoring", ...mxChain(hash)] : ["home", hash]; }
screenHooks("monitoring", { back: monBack, enter: monEnter, chain: monChain });
// Every file outside 모니터링 that changes what the screen shows asks for its redraw here: the next paint is not skipped as unchanged.
function monDirty() { MON.sig = ""; monSchedule(); }
