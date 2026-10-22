/* ---------- 모니터링: a tab built like 채팅 - a list of what is watched, and a conversation per item ---------- */
// The list is the chat list's panel and row (31-conversations.js convRow); an item opens as a conversation: its notices and results as messages,
// an open decision answered in place with the same choice rows a chat message has (10-decision-card.js answerInline). Items: 알림, every
// integration enabled on this install (30-integrations.js: 메일, 카카오톡 ...) and every dotz_watch monitor or schedule.
// Data: GET /api/monitors (hub/monitors.ts) -> {items: [{name, kind, channel?, last_run?, last_result?, next_run?, every?}]}, the notices (30-notices.js NT)
// and the integrations. It repaints when a notice arrives and once a minute while it is open.
const NM = { items: [], loaded: false, failed: false };
const NT_RESULT = { ok: ["정상", "done"], changed: ["바뀜", "ask"], fail: ["실패", "fail"] };
const MON_KIND = { watch: "모니터링", schedule: "예약" };
// sel: the open item's key ("notice", "i:<integration>", "m:<monitor name>"); list: a phone shows the list instead of the conversation.
const MON = { sel: "", list: true, shown: "", sig: "", side: "", seenT: 0 };
const monConv = () => current === "monitoring" && narrowChat() && !MON.list;
const monHash = () => (!MON.list && MON.sel ? `monitoring/${enc(MON.sel)}` : "monitoring");
// go("monitoring", key) opens that item; without one a phone shows the list and a wide screen keeps the open item.
function monRoute(tgt) {
  if (tgt && tgt !== "list") { MON.sel = tgt; MON.list = false; }
  else MON.list = narrowChat();
}

async function loadMonitors() {
  try {
    const r = await api("/api/monitors");
    NM.items = Array.isArray(r.items) ? r.items : [];
    NM.loaded = true; NM.failed = false;
  } catch { NM.failed = !NM.loaded; }
  monSchedule();
  homeSoon();
}
// Failed ones first, then the soonest next run.
const ntMons = () => NM.items.slice().sort((a, b) => (b.last_result === "fail") - (a.last_result === "fail") || (Date.parse(a.next_run) || Infinity) - (Date.parse(b.next_run) || Infinity));
const monTime = t => kstDay(t) === kstDay(Date.now()) ? kstHM(t) : `${dayLabel(t)} ${kstHM(t)}`;
const ntMonRun = m => m.last_run ? `마지막 ${monTime(m.last_run)}` : "아직 실행 전이에요";
const ntMonNext = m => m.next_run ? `다음 ${monTime(m.next_run)}` : "";

const monQuiet = n => /^게이트웨이(?: 재시작했어요|를 다시 시작했어요)/.test(String(n.text || ""));
const monNewest = list => list.slice().sort((a, b) => ntAt(b) - ntAt(a))[0] || null;
const monNoticeAt = n => new Date(ntAt(n)).toISOString();
const monLine = n => convPreview(n.text) || ntPlain(n.title);
const monIcon = ic => el("span", { class: "cv-av nt", "aria-hidden": "true" }, icon(ic));
const monUnread = list => list.reduce((c, n) => c + (n.read ? 0 : 1), 0);

// What is watched, in list order: 알림, then the integrations, then the monitors. Each item carries what its row and its conversation show.
function monItems() {
  intgWatch();
  const owned = new Set(INTG.items.flatMap(i => (i.notices || []).map(String)));
  const alerts = NT.items.filter(n => ntTabOf(n) === "alert" && !owned.has(String(n.id)) && !monQuiet(n));
  const last = monNewest(alerts);
  const items = [{ key: "notice", group: "", name: "알림", ic: "bell", notices: alerts, mails: [], unread: monUnread(alerts), hint: last ? monLine(last) : "새 알림이 없어요", at: last ? monNoticeAt(last) : "" }];
  for (const it of INTG.items) {
    const notices = (it.notices || []).map(ntById).filter(Boolean), mails = [...CONV.keys()].filter(t => (it.conv || []).some(p => t.startsWith(p)));
    const cands = [...notices.map(n => ({ at: monNoticeAt(n), text: monLine(n) })), ...mails.filter(t => CONV.get(t)).map(t => ({ at: CONV.get(t).ts, text: (MAILS.get(t) || {}).subject || CONV.get(t).text }))].sort((a, b) => b.at.localeCompare(a.at));
    items.push({ key: `i:${it.key}`, group: "서비스", name: it.label, ic: it.icon, notices, mails, unread: it.unread | 0, hint: cands[0] ? cands[0].text : `${it.label} 소식이 아직 없어요`, at: cands[0] ? cands[0].at : "" });
  }
  for (const m of ntMons()) {
    const notices = NT.items.filter(n => n.kind === "watch" && n.title === m.name), last = monNewest(notices), res = m.last_result ? NT_RESULT[m.last_result] : null;
    items.push({ key: `m:${m.name}`, group: "모니터링", name: ntPlain(m.name) || MON_KIND[m.kind] || "모니터링", ic: "activity", notices, mails: [], mon: m, unread: monUnread(notices),
      hint: last ? monLine(last) : [ntMonRun(m), res && res[0]].filter(Boolean).join(" · "), at: m.last_run || (last ? monNoticeAt(last) : ""),
      badge: m.last_result === "fail" ? ["실패", "err"] : m.kind === "schedule" ? [MON_KIND.schedule, ""] : null });
  }
  return items;
}
// The open item: the one picked, else on a wide screen the first (a phone shows its list until one is picked).
const monSel = items => items.find(i => i.key === MON.sel) || (narrowChat() ? null : items[0] || null);
const monName = () => { const it = monItems().find(i => i.key === MON.sel); return it ? it.name : titles.monitoring; };
function monState(it) {
  if (it.mon) { const res = it.mon.last_result ? NT_RESULT[it.mon.last_result] : null; return [res && res[0], ntMonRun(it.mon), ntMonNext(it.mon)].filter(Boolean).join(" · "); }
  if (it.key === "notice") return it.unread ? `안 읽은 알림 ${it.unread}개` : "알림";
  return it.unread ? `안 읽음 ${it.unread}개` : "연결돼 있어요";
}

/* ---- the list ---- */
function monRows(items, sel) {
  const rows = [];
  let group = null;
  for (const it of items) {
    if (it.group && it.group !== group) rows.push({ header: it.group });
    group = it.group;
    rows.push({ k: it.key, name: it.name, av: monIcon(it.ic), hint: it.hint, when: it.at ? monTime(it.at) : "", unread: it.unread, badge: it.badge || null, sel: !!sel && it.key === sel.key && !MON.list, open: () => go("monitoring", it.key) });
  }
  if (!NM.loaded) rows.push({ header: NM.failed ? "모니터링을 불러오지 못했어요" : "모니터링 불러오는 중…" });
  return rows;
}

/* ---- the conversation ---- */
const MON_TONE = { fail: ["실패", "err"], warn: ["주의", "warn"], ask: ["답변 필요", "warn"], ok: ["정상", "ok"] };
const monWhen = n => ntTime(n.updated || n.ts);
const monTag = tone => { const t = MON_TONE[tone]; return t ? el("span", { class: `tag ${t[1]}`, text: t[0] }) : null; };
// A decision: the question and the same choice rows a chat message has; an open one is answered here, an answered one shows what was chosen.
function monDecisionNode(n) {
  const d = n.decision, open = d.state === "open", said = d.state === "answered" ? String(d.answer || "") : "";
  const fl = fileLines(n.text);
  const rows = ntOptsOrdered(d.options).map(o => el("button", { class: `dcm-row${o.rec ? " rec" : ""}${said.startsWith(`${o.n})`) ? " on" : ""}`, type: "button", disabled: !open || dcSending.has(n.id), "data-n": o.n,
    onclick: () => (d.draft || o.action === "form" ? noticeSheetOpen(n.id) : answerInline(n, o)) },
    el("span", { class: "dc-key", text: String(o.n) }),
    el("span", { class: "dc-tx" }, el("span", { class: "dc-lb" }, o.label, o.rec ? el("span", { class: "dc-tag", text: "추천" }) : null), o.desc ? el("span", { class: "dc-ds", text: o.desc }) : null)));
  const end = open ? null : el("div", { class: "mt", text: d.state === "ignored" ? "무시했어요" : d.resolved ? "답 없이 끝났어요" : `답했어요${said ? ` · ${ntPlain(said)}` : ""}` });
  return el("div", { class: "bm alert", "data-nid": n.id }, el("div", { class: "mt" }, el("span", { class: "mn", text: ntPlain(n.title) || "답변이 필요해요" }), ` · ${monWhen(n)}`, open ? " " : null, open ? monTag("ask") : null),
    mdNode(fl.text), filesNode(fl.files), el("div", { class: "dcm fx mon-dc" }, ...rows), end);
}
// Any other notice is drawn like a message of the 알림 conversation (11-todo-strip.js msgNode), with its own title in place of the speaker.
function monNoticeNode(n) {
  if (ntIsDec(n)) return monDecisionNode(n);
  const node = msgNode({ kind: "out", target: "alert", ts: n.updated || n.ts, text: String(n.text || "") });
  if (!node) return null;
  node.dataset.nid = n.id;
  const head = node.querySelector(".mt"), name = head && head.querySelector(".mn");
  if (name) name.textContent = ntPlain(n.title) || "알림";
  if (head) { const tag = monTag(n.tone); if (tag) head.append(" ", tag); }
  if (ntNeeds(n)) node.append(el("div", { class: "btns cc-act" }, el("button", { class: "btn tonal", type: "button", onclick: () => noticeOpen(n), text: "답하러 가기" })));
  return node;
}
// A mail or chat of an integration is its own conversation in 채팅: here one line of it and the way in.
function monConvNode(t, label) {
  const m = MAILS.get(t), last = CONV.get(t), n = ts(t).unread;
  const body = m ? [el("div", { class: "ml-from", text: mailSender(m.from) }), el("div", { class: "ml-subj", text: m.subject })] : [el("div", { text: last ? last.text : "" })];
  return el("div", { class: "bm alert" }, el("div", { class: "mt" }, el("span", { class: "mn", text: label }), last ? ` · ${monTime(last.ts)}` : null, n ? " " : null, n ? el("span", { class: "tag warn", text: `안 읽음 ${n}` }) : null),
    ...body, el("div", { class: "btns cc-act" }, el("button", { class: "btn tonal", type: "button", onclick: () => go("chat", t), text: "대화 열기" })));
}
// A monitor's state first (same card a command answer uses), then its results oldest to newest.
function monStatusNode(m) {
  const res = m.last_result ? NT_RESULT[m.last_result] : null, tone = { fail: "err", changed: "warn", ok: "ok" }[m.last_result] || "";
  const card = cardNode({ title: ntPlain(m.name) || MON_KIND[m.kind] || "모니터링", tone, facts: [
    { label: "상태", value: res ? res[0] : "아직 실행 전" }, { label: "마지막 실행", value: m.last_run ? monTime(m.last_run) : "–" },
    ...(m.next_run ? [{ label: "다음 실행", value: monTime(m.next_run) }] : []), ...(m.every ? [{ label: "주기", value: m.every }] : [])] });
  if (m.channel && isProjT(m.channel)) card.append(el("div", { class: "btns cc-act" }, el("button", { class: "btn tonal", type: "button", onclick: () => { if (S && !projTargets().includes(m.channel)) toast("이 프로젝트를 찾을 수 없어요"); else openTarget(m.channel, "chat"); }, text: "프로젝트 대화 열기" })));
  return el("div", { class: "bm" }, el("div", { class: "mt" }, el("span", { class: "mn", text: MON_KIND[m.kind] || "모니터링" })), card);
}
function monTimeline(it) {
  const msgs = [...it.notices.map(n => ({ at: ntAt(n), node: () => monNoticeNode(n) })), ...it.mails.map(t => ({ at: Date.parse((CONV.get(t) || {}).ts) || 0, node: () => monConvNode(t, it.name) }))].sort((a, b) => a.at - b.at);
  const nodes = [...(it.mon ? [monStatusNode(it.mon)] : []), ...msgs.map(x => x.node())].filter(Boolean);
  return nodes.length ? nodes : [el("div", { class: "empty", text: !NT.loaded && !NM.loaded ? "불러오는 중…" : "아직 소식이 없어요" })];
}
const monHead = it => [monIcon(it.ic), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: it.name }), el("span", { class: "cv-p", text: monState(it) }))];

// The owner is looking at an open item: its notices that need no answer count as read after a moment (answers keep theirs unread, like everywhere).
function monSeen() {
  clearTimeout(MON.seenT);
  MON.seenT = setTimeout(() => {
    if (current !== "monitoring" || MON.list && narrowChat() || document.visibilityState !== "visible") return;
    const it = monSel(monItems());
    const fresh = it ? it.notices.filter(n => n.id && !n.read && !ntNeeds(n) && ntById(n.id)) : [];
    if (!fresh.length) return;
    for (const n of fresh) n.read = true;
    NT.unread = Math.max(0, NT.unread - fresh.length);
    ntPaint(); homeSoon();
    ntMarkRead({ ids: fresh.map(n => n.id) });
  }, 700);
}

let monRaf = 0;
const monSchedule = () => { if (!monRaf) monRaf = requestAnimationFrame(renderMonitoring); };
function renderMonitoring() {
  monRaf = 0;
  if (current !== "monitoring") return;
  const items = monItems(), sel = monSel(items), side = $("#mon-side"), box = $("#mon-timeline"), tl = $("#mon-tl");
  const rows = monRows(items, sel), sideSig = JSON.stringify([rows.map(r => [r.k, r.name, r.hint, r.when, r.unread, r.badge, r.header, r.sel])]);
  if (sideSig !== MON.side) {
    MON.side = sideSig;
    const top = side.scrollTop;
    clear(side).append(...rows.map(convRow));
    side.scrollTop = top;
  }
  if (!sel) { MON.sig = ""; MON.shown = ""; convTitle(); return; }
  const sig = JSON.stringify([sel.key, sel.name, monState(sel), sel.notices.map(n => [n.id, n.updated, n.read, n.text, n.decision, n.tone]), sel.mails.map(t => [t, (CONV.get(t) || {}).ts, ts(t).unread]), sel.mon, NM.loaded, NT.loaded]);
  if (sig !== MON.sig) {
    MON.sig = sig;
    const again = MON.shown === sel.key, keep = box.scrollTop, stick = !again || box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    MON.shown = sel.key;
    clear($("#mon-head")).append(...monHead(sel));
    clear(tl).append(...monTimeline(sel));
    box.scrollTop = stick ? box.scrollHeight : keep;
    edgeFade(box);
  }
  convTitle();
  monSeen();
}
$("#mon-timeline").addEventListener("scroll", () => edgeFade($("#mon-timeline")), { passive: true });
setInterval(() => { if (current === "monitoring" && !document.hidden) loadMonitors(); }, 60_000);
loadMonitors();
