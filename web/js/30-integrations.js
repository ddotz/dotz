/* ---------- 모니터링 sources: one per integration that contacts the owner first (메일, 카카오톡, 인스타그램, 유튜브 ...) ---------- */
// Data: GET /api/integrations (hub/integrations.ts) -> {items: [{key, label, icon, iconPath?, conv, unread, notices}]}: only the integrations enabled on
// this install, with the ids of their notices and the unread count. The registry lives in the hub; the 모니터링 tab (30-monitoring.js) lists
// whatever it returns beside the dotz_watch monitors and 알림.
const INTG = { items: [], available: [], sig: "", timer: 0 };
// An app switched off on this install keeps its mails here (data is kept): a peer's copy of the same mail must still show (34-peer-monitoring.js pqMail).
// An instance owns a conversation under its `conv` prefixes, minus the prefixes its siblings claim (`convNot`, hub/integrations.ts appEntries).
const intgHas = (it, t) => (it.conv || []).some(p => String(t).startsWith(p)) && !(it.convNot || []).some(p => String(t).startsWith(p));
const intgHidden = t => INTG.available.some(a => a.off && intgHas(a, t));

// 미답장 (hub/unreplied.ts): the orange pill, and the small 답장 안 함 action that clears it (reading never does). `after` repaints the caller.
const unrepPill = (text = "미답장") => el("span", { class: "tag unreplied", text });
// The pill and the button leave at the tap (owner 2026-10-26: it did not go away at once); a failed request puts them back.
const unrepNo = (path, after) => el("button", { class: "cchip unrep-no", type: "button", text: "답장 안 함", onclick: ev => {
  ev.stopPropagation();
  const btn = ev.currentTarget, box = btn.parentElement, pill = box && box.querySelector(".tag.unreplied");
  const hidden = [btn, pill].filter(Boolean);
  hidden.forEach(n => { n.hidden = true; });
  api(path, "POST", {}).then(() => { toast("답장 안 함으로 표시했어요"); if (after) after(); loadIntegrations(); },
    e => { hidden.forEach(n => { n.hidden = false; }); toast(e.message, true); });
} });

async function loadIntegrations() {
  try {
    const r = await api("/api/integrations");
    INTG.items = Array.isArray(r.items) ? r.items : [];
    INTG.available = Array.isArray(r.available) ? r.available : [];
    for (const it of INTG.available) if (it.iconPath && !ICONS[it.icon]) ICONS[it.icon] = it.iconPath;
    for (const it of INTG.items) if (it.iconPath && !ICONS[it.icon]) ICONS[it.icon] = it.iconPath;
  } catch { return; }
  monSchedule();
  homeSoon();
}
// Refetch when the notices or a conversation's unread count changed (cheap signature, checked on every list build).
function intgWatch() {
  const sig = `${NT.items.length}:${NT.unread}:${[...CONV.keys()].map(t => ts(t).unread).join(",")}:${[...MAILS.values()].filter(m => m && m.unreplied).length}`;
  if (sig === INTG.sig) return;
  INTG.sig = sig;
  clearTimeout(INTG.timer);
  INTG.timer = setTimeout(loadIntegrations, 300);
}
loadIntegrations();
