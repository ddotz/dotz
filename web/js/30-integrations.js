/* ---------- 모니터링 sub-items: one per integration that contacts the owner first (메일, 카카오톡, 인스타그램, 유튜브 ...) ---------- */
// Data: GET /api/integrations (hub/integrations.ts) -> {items: [{key, label, icon, iconPath?, conv, unread, notices}]}: only the integrations enabled on
// this install, with the ids of their notices and the unread count. The registry lives in the hub; this file draws whatever it lists.
// A sub-item opens the 모니터링 screen filtered to that integration (renderIntegration), the 모니터링 row itself opens it unfiltered.
const INTG = { items: [], view: "", pick: "", sig: "", timer: 0 };

async function loadIntegrations() {
  try {
    const r = await api("/api/integrations");
    INTG.items = Array.isArray(r.items) ? r.items : [];
    for (const it of INTG.items) if (it.iconPath && !ICONS[it.icon]) ICONS[it.icon] = it.iconPath;
  } catch { return; }
  if (INTG.view && !INTG.items.some(i => i.key === INTG.view)) INTG.view = "";
  convSchedule();
  if (current === "monitoring") renderMonitoring();
}
// Refetch when the notices or a conversation's unread count changed (cheap signature, checked on every list build).
function intgWatch() {
  const sig = `${NT.items.length}:${NT.unread}:${[...CONV.keys()].map(t => ts(t).unread).join(",")}`;
  if (sig === INTG.sig) return;
  INTG.sig = sig;
  clearTimeout(INTG.timer);
  INTG.timer = setTimeout(loadIntegrations, 300);
}
const intgRows = () => { intgWatch(); return INTG.items.map(i => ({ intg: true, sub: true, key: i.key, name: i.label, icon: i.icon, unread: i.unread })); };
function intgOpen(key) { INTG.pick = key; go("monitoring"); }
// go("monitoring") from anywhere else (홈 card, palette, address bar) shows the whole screen: only a sub-item click carries a filter.
const goBase = go;
go = (name, tgt) => { if (name === "monitoring") INTG.view = INTG.pick; INTG.pick = ""; return goBase(name, tgt); };

function intgRow(r) {
  const on = current === "monitoring" && INTG.view === r.key;
  return el("button", { class: `cv-row sub${r.unread ? " unread" : ""}${on ? " on" : ""}`, type: "button", "data-intg": r.key, "aria-current": on ? "true" : null, onclick: () => intgOpen(r.key) },
    el("span", { class: "cv-av nt", "aria-hidden": "true" }, icon(r.icon)),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", title: r.name, text: r.name })),
    el("span", { class: "cv-m" }, r.unread ? el("span", { class: "nb", "aria-label": `읽지 않은 항목 ${r.unread}개`, text: r.unread > 99 ? "99+" : String(r.unread) }) : null));
}

function intgConvRow(t) {
  const m = MAILS.get(t), n = ts(t).unread;
  return el("button", { type: "button", class: `nt-row${n ? " un" : ""}`, "data-t": t, onclick: () => go("chat", t) },
    el("span", { class: `nt-dot tone-${n ? "ask" : "none"}`, "aria-hidden": "true" }),
    el("span", { class: "nt-b" }, el("span", { class: "nt-t", text: targetName(t) }), m ? el("span", { class: "nt-x", text: mailSender(m.from) }) : null),
    n ? el("span", { class: "nb", "aria-label": `읽지 않은 메시지 ${n}개`, text: String(n) }) : null);
}
function intgNoticeRow(n) {
  const [first = ""] = ntPlain(n.text).split("\n");
  return el("button", { type: "button", class: `nt-row${n.read ? "" : " un"}`, "data-nid": n.id, onclick: () => noticeOpen(n) },
    el("span", { class: `nt-dot tone-${n.read ? "none" : n.tone || "none"}`, "aria-hidden": "true" }),
    el("span", { class: "nt-b" }, el("span", { class: "nt-t", text: ntPlain(n.title) || "알림" }), el("span", { class: "nt-x", text: first }), el("span", { class: "nt-m", text: ntWhen(n) })));
}
function renderIntegration(box) {
  const it = INTG.items.find(i => i.key === INTG.view);
  const convs = [...CONV.keys()].filter(t => it.conv.some(p => t.startsWith(p)));
  const notices = it.notices.map(ntById).filter(Boolean);
  box.append(el("div", { class: "mon-sum", text: `${it.label}${it.unread ? ` · 안 읽음 ${it.unread}개` : ""}` }));
  if (!convs.length && !notices.length) { box.append(emptyNode(`${it.label} 소식이 아직 없어요`)); return; }
  box.append(el("div", { class: "card mon-list" }, ...convs.map(intgConvRow), ...notices.map(intgNoticeRow)));
}
loadIntegrations();
