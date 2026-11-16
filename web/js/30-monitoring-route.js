/* ---------- monitoring: how the screen is left ---------- */
// 모니터링's 뒤로 closes what is open on the screen before it leaves it, in this order: the app settings pane (32-app-settings.js),
// the reply sheet in its pane (30-replies.js), an open KakaoTalk room (30-kakao.js), an open comment or DM thread
// (30-monitoring-comments.js), then a mailbox settings page (30-mailboxes-set.js). Each closer checks it is on 모니터링 itself.
function monBack() { return asBack() || rqBack() || kkBack() || cmBack() || mxsBack(); }
screenHooks("monitoring", { back: monBack });
