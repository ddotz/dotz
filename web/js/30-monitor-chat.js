// 모니터링 항목의 대화 (owner 2026-11-06): what a monitor's row opens, the left list beside it and the strip over its conversation. Runs only from paints and clicks.
// A monitor opens like a chat (owner 2026-11-06): the list of monitors on the left, its conversation on the right. An app's own watch never gets here: monItems
// folds it into the app (monOwner). A schedule has no conversation (hub isSettingsTarget): its reports open in the same place. So does a peer's watch named like one of this computer's has no conversation here (34-peer-monitoring.js keeps the name local).
const monChatOf = it => {
  const a = it && it.mon ? monSettingsApp(it) : "", t = a.startsWith("w:") ? asConv(a) : "";
  return t && it.pc && (PQ.of.get(t) || {}).key !== it.key ? "" : t;
};
const monRowGo = it => { const c = monChatOf(it); return c ? `c:${c}` : it.key; };
// The monitor whose conversation is open now.
const monChatIt = (items = monItems()) => { if (!monCtx || !isSettingsT(target)) return null; const it = items.find(i => i.key === MON.sel); return it && monChatOf(it) === target ? it : null; };
// The left column beside a monitor: the rows of monitors under their own group names, without the feed, the apps and 앱 관리.
function monListRows(items, sel) {
  const rows = monRows(items, sel);
  if (!sel || !sel.mon || MON.list) return rows;
  const out = [];
  let head = null;
  for (const r of rows) {
    if (r.header) { head = r; continue; }
    if (!(items.find(i => i.key === r.k) || {}).mon) continue;
    if (head) { out.push(head); head = null; }
    out.push(r);
  }
  return out;
}
// Over a monitor's conversation: how far its wait has come, a down banner, 지금 확인 and the way to its reports (소식, with the unread count).
function monChatTopNodes(it) {
  const banner = monBannerOf(it), log = el("button", { class: "btn tonal sm mon-continue", type: "button", "data-k": "mon-log", title: TX("mon.chat.log_title"), text: it.unread ? TX("mon.chat.log_n", { n: it.unread }) : TX("mon.sec.news"), onclick: () => go("monitoring", it.key) });
  return [monProgNode(it.mon, { compact: true, tag: !banner }), banner, el("div", { class: "mon-actions" }, it.mon.watch && !banner ? monRunBtn(it.mon) : null, log)];
}
// The wait bar keeps moving over a monitor's conversation too.
const monTicks = () => current === "monitoring" || (current === "chat" && !!monCtx);
