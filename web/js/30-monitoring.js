/* ---------- 모니터링: a tab built like 채팅 - a list of what is watched, and a conversation per item ---------- */
// The list is the chat list's panel and row (31-conversations.js convRow); an item opens as a conversation: its notices and results as messages,
// an open decision answered in place with the same choice rows a chat message has (10-decision-card.js answerInline). Items: 알림, every
// integration enabled on this install (30-integrations.js: 메일, 카카오톡 ...) and every dotz_watch monitor or schedule.
// Only what a watch, a schedule or an integration produced is shown here (monMine). The 알림 channel's posts and the decisions asked there
// stay in 채팅's 알림 conversation and never show here; watch reports are not in that conversation (hub/events.ts eventTarget).
// Data: GET /api/monitors (hub/monitors.ts) -> {items: [{name, watch?, kind, channel?, last_run?, last_result?, next_run?, every?}]}, the notices (30-notices.js NT)
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

// A monitor's readable title: its label, else the [a-z0-9-] name in words ("node-security-updates" -> "node security updates"); the raw name
// is only the small text in the header. A watch's notices carry the label (hub notice) or the raw name (a gateway "[name] ..." post).
const monWords = s => /^[A-Za-z0-9][\w.-]*$/.test(s) && /[-_]/.test(s) ? s.replace(/[-_]+/g, " ") : s;
const monRaw = m => String(m.watch || m.name || "");
const monTitle = m => monWords(ntPlain(m.name)) || MON_KIND[m.kind] || "모니터링";
const monNames = m => [...new Set([monTitle(m), String(m.name || ""), monRaw(m), monWords(monRaw(m))].filter(Boolean))];
const monHas = (m, n) => n.kind === "watch" && monNames(m).includes(String(n.title || ""));
// 모니터링's own notices: a watch's or a schedule's report (kind "watch"), or a notice living in an integration's own conversation (a mail).
const monMine = (n, it) => n.kind === "watch" || (!!it && (it.conv || []).some(p => String(n.src || n.open || "").startsWith(p)));
// Where a notice tap lands in 모니터링 (30-notices.js monOpen): its monitor, else 감시 소식.
function monKeyOf(n) { const m = NM.items.find(x => monHas(x, n)); return m ? `m:${m.name}` : "notice"; }
// The words of a report without the monitor's name in front ("node security updates: 결과가 바뀌었어요" -> "결과가 바뀌었어요").
function monStrip(s, names) {
  for (const x of names) if (s.startsWith(x)) { const r = s.slice(x.length).replace(/^\s*[:：]\s*/, ""); if (r !== s.slice(x.length)) return r; }
  return s;
}
const MON_RUN = { ok: "마지막 확인 결과 정상이에요", changed: "마지막 확인에서 바뀐 점이 있어요", fail: "마지막 확인이 실패했어요" };
const monRunLine = m => !m.last_run ? "아직 확인 전이에요" : m.kind === "schedule" ? "예약한 일을 실행했어요" : MON_RUN[m.last_result] || "확인했어요";
const monNewest = list => list.slice().sort((a, b) => ntAt(b) - ntAt(a))[0] || null;
const monNoticeAt = n => new Date(ntAt(n)).toISOString();
const monLine = n => convPreview(n.text) || ntPlain(n.title);
const monIcon = ic => el("span", { class: "cv-av nt", "aria-hidden": "true" }, icon(ic));
const monUnread = list => list.reduce((c, n) => c + (n.read ? 0 : 1), 0);

// What is watched, in list order: 감시 소식 (reports no row below owns), then the integrations, then the monitors. Each item carries what
// its row and its conversation show.
const MON_FEED = "감시 소식";
function monItems() {
  intgWatch();
  const mons = ntMons(), shown = new Set(), items = [];
  for (const it of INTG.items) {
    const notices = (it.notices || []).map(ntById).filter(n => n && monMine(n, it)), mails = [...CONV.keys()].filter(t => (it.conv || []).some(p => t.startsWith(p)));
    for (const n of notices) shown.add(n.id);
    const cands = [...notices.map(n => ({ at: monNoticeAt(n), text: monLine(n) })), ...mails.filter(t => CONV.get(t)).map(t => ({ at: CONV.get(t).ts, text: (MAILS.get(t) || {}).subject || CONV.get(t).text }))].sort((a, b) => b.at.localeCompare(a.at));
    items.push({ key: `i:${it.key}`, group: "서비스", name: it.label, ic: it.icon, notices, mails, unread: monUnread(notices) + mails.reduce((c, t) => c + (ts(t).unread | 0), 0), hint: cands[0] ? cands[0].text : `${it.label} 소식이 아직 없어요`, at: cands[0] ? cands[0].at : "" });
  }
  for (const m of mons) {
    const notices = NT.items.filter(n => monHas(m, n)), last = monNewest(notices), names = monNames(m);
    for (const n of notices) shown.add(n.id);
    // The row says the newest result in words: the newest report, unless a later run said nothing (an "ok" run posts no report).
    const fresh = last && (!m.last_run || ntAt(last) >= Date.parse(m.last_run) - 60_000);
    items.push({ key: `m:${m.name}`, group: "모니터링", name: monTitle(m), raw: monRaw(m), ic: "activity", notices, mails: [], mon: m, unread: monUnread(notices),
      hint: fresh ? monStrip(monLine(last), names) : monRunLine(m), at: m.last_run || (last ? monNoticeAt(last) : ""),
      badge: m.last_result === "fail" ? ["실패", "err"] : m.kind === "schedule" ? [MON_KIND.schedule, ""] : null });
  }
  const feed = NT.items.filter(n => n.kind === "watch" && !shown.has(n.id)), last = monNewest(feed);
  items.unshift({ key: "notice", group: "", name: MON_FEED, ic: "list", notices: feed, mails: [], unread: monUnread(feed), hint: last ? monLine(last) : "새 감시 소식이 없어요", at: last ? monNoticeAt(last) : "" });
  return items;
}
// The open item: the one picked, else on a wide screen the first (a phone shows its list until one is picked).
const monSel = items => items.find(i => i.key === MON.sel) || (narrowChat() ? null : items[0] || null);
const monName = () => { const it = monItems().find(i => i.key === MON.sel); return it ? it.name : titles.monitoring; };
function monState(it) {
  if (it.mon) { const res = it.mon.last_result ? NT_RESULT[it.mon.last_result] : null; return [res && res[0], ntMonRun(it.mon), ntMonNext(it.mon)].filter(Boolean).join(" · "); }
  if (it.key === "notice") return it.unread ? `안 읽은 소식 ${it.unread}개` : "감시와 예약 결과";
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
const MON_TONE = { fail: ["실패", "err"], warn: ["주의", "warn"], ask: ["답변 필요", "warn"], ok: ["정상", "ok"], changed: ["바뀜", "warn"] };
const monWhen = n => ntTime(n.updated || n.ts);
const monTag = tone => { const t = MON_TONE[tone]; return t ? el("span", { class: `tag ${t[1]}`, text: t[0] }) : null; };
// A decision: the question and the same choice rows a chat message has; an open one is answered here, an answered one shows what was chosen.
function monDecisionNode(n) {
  const d = n.decision, open = d.state === "open", said = d.state === "answered" ? String(d.answer || "") : "";
  // The buttons show the options: the body keeps the lead text and the 결정: line, not the option lines (10-decision-card.js stripChoices).
  const fl = fileLines(d.options.length ? stripChoices(n.text) : n.text);
  const rows = ntOptsOrdered(d.options).map(o => el("button", { class: `dcm-row${o.rec ? " rec" : ""}${said.startsWith(`${o.n})`) ? " on" : ""}`, type: "button", disabled: !open || dcSending.has(n.id), "data-n": o.n,
    onclick: () => (d.draft || o.action === "form" ? noticeSheetOpen(n.id) : answerInline(n, o)) },
    el("span", { class: "dc-key", text: String(o.n) }),
    el("span", { class: "dc-tx" }, el("span", { class: "dc-lb" }, o.label, o.rec ? el("span", { class: "dc-tag", text: "추천" }) : null), o.desc ? el("span", { class: "dc-ds", text: o.desc }) : null)));
  const end = open ? null : el("div", { class: "mt", text: d.state === "ignored" ? "무시했어요" : d.resolved ? "답 없이 끝났어요" : `답했어요${said ? ` · ${ntPlain(said)}` : ""}` });
  return el("div", { class: "bm alert", "data-nid": n.id }, el("div", { class: "mt" }, el("span", { class: "mn", text: ntPlain(n.title) || "답변이 필요해요" }), ` · ${monWhen(n)}`, open ? " " : null, open ? monTag("ask") : null),
    mdNode(fl.text), filesNode(fl.files), el("div", { class: "dcm fx mon-dc" }, ...rows), end);
}
// Any other notice is drawn like a message of the 알림 conversation (11-todo-strip.js msgNode), with its own title in place of the speaker.
// A monitor's own report drops the monitor's name in front of its first line (the card already says whose it is).
function monCard(name, at, text, tone) {
  const node = msgNode({ kind: "out", target: "alert", ts: at, text });
  if (!node) return null;
  const head = node.querySelector(".mt"), mn = head && head.querySelector(".mn");
  if (mn) mn.textContent = name;
  if (head) { const tag = monTag(tone); if (tag) head.append(" ", tag); }
  return node;
}
function monNoticeNode(n, names = []) {
  if (ntIsDec(n)) return monDecisionNode(n);
  const node = monCard(ntPlain(names[0] || n.title) || "알림", n.updated || n.ts, monStrip(String(n.text || ""), names), n.tone);
  if (!node) return null;
  node.dataset.nid = n.id;
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
// A monitor's latest run, as the newest message of its conversation: the result in words, when it checks next, and its project chat.
function monRunNode(it) {
  const m = it.mon;
  if (!m.last_run) return null;
  const next = [m.next_run ? `다음 확인 ${monTime(m.next_run)}` : "", m.every || ""].filter(Boolean).join(" · ");
  const node = monCard(it.name, m.last_run, [`${monRunLine(m)}.`, next].filter(Boolean).join(" "), m.kind === "watch" ? m.last_result : "");
  if (node && m.channel && isProjT(m.channel)) node.append(el("div", { class: "btns cc-act" }, el("button", { class: "btn tonal", type: "button", onclick: () => { if (S && !projTargets().includes(m.channel)) toast("이 프로젝트를 찾을 수 없어요"); else openTarget(m.channel, "chat"); }, text: "프로젝트 대화 열기" })));
  return node;
}
// Every item reads the same way: its reports and mails oldest to newest, a monitor's latest run last.
function monTimeline(it) {
  const names = it.mon ? monNames(it.mon) : [];
  const msgs = [...it.notices.map(n => ({ at: ntAt(n), node: () => monNoticeNode(n, names) })), ...it.mails.map(t => ({ at: Date.parse((CONV.get(t) || {}).ts) || 0, node: () => monConvNode(t, it.name) })),
    ...(it.mon ? [{ at: Date.parse(it.mon.last_run) || 0, node: () => monRunNode(it) }] : [])].sort((a, b) => a.at - b.at);
  const nodes = msgs.map(x => x.node()).filter(Boolean);
  if (nodes.length) return nodes;
  const next = it.mon && it.mon.next_run ? ` · 다음 확인 ${monTime(it.mon.next_run)}` : "";
  return [el("div", { class: "empty", text: !NT.loaded && !NM.loaded ? "불러오는 중…" : it.mon ? `${monRunLine(it.mon)}${next}` : "아직 소식이 없어요" })];
}
const monHead = it => [monIcon(it.ic), el("span", { class: "cv-b" }, el("span", { class: "cv-n" }, it.name, it.raw && it.raw !== it.name ? el("span", { class: "cv-id", text: it.raw }) : null), el("span", { class: "cv-p", text: monState(it) }))];

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
