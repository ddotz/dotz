/* ---------- 모니터링: a tab built like 채팅 - a list of what is watched, and a conversation per item ---------- */
// The list is the chat list's panel and row (31-conversations.js convRow); an item opens as a conversation: its notices and results as messages,
// an open decision answered in place with the same choice rows a chat message has (10-decision-card.js answerInline). Items: 알림, every
// integration enabled on this install (30-integrations.js: 메일, 카카오톡 ...) and every dotz_watch monitor or schedule.
// Only what a watch, a schedule or an integration produced is shown here (monMine). The 알림 channel's posts and the decisions asked there
// stay in 채팅's 알림 conversation and never show here; watch reports are not in that conversation (hub/events.ts eventTarget).
// Data: GET /api/monitors (hub/monitors.ts) -> {items: [{name, watch?, kind, channel?, last_run?, last_result?, next_run?, every?, connection?, since?, conn_reason?, paused?, last_summary?}]}, the notices (30-notices.js NT)
// and the integrations. It repaints when a notice arrives and once a minute while it is open.
const NM = { items: [], loaded: false, failed: false };
const NT_RESULT = { ok: ["정상", "done"], changed: ["바뀜", "ask"], fail: ["실패", "fail"] };
const MON_KIND = { watch: "모니터링", schedule: "예약" };
// The list's groups after 감시 소식: app-type integrations (hub/integrations.ts kind "app"), then the plain monitors.
const MON_GROUP = { app: "앱", plain: "일반 모니터링" };
// sel: the open item's key ("notice", "i:<integration>", "m:<monitor name>"); list: a phone shows the list instead of the conversation.
// filter: 전체 / 답 필요 / 실패 of the open item; open: the rows unfolded ("g:<source>", "n:<notice id>"); more: pages shown per list; grew: older reports were just added above.
const MON = { sel: "", list: true, shown: "", sig: "", side: "", seenT: 0, mailFilter: "all", filter: "all", open: new Set(), more: new Map(), grew: false, running: new Set(), autoArmed: false, olderBusy: false };
const monConv = () => current === "monitoring" && narrowChat() && !MON.list;
const monHash = () => (!MON.list && MON.sel ? `monitoring/${enc(MON.sel)}` : "monitoring");
// A mail is a conversation of 모니터링 (go() in 05-command-palette.js draws it with the chat view while the tab stays 모니터링); monItemOf: the list item it sits under.
const monOwned = t => isMailT(String(t || "")) || isSettingsT(String(t || ""));
const monItemOf = t => {
  if (!monOwned(t)) return "";
  if (isSettingsT(t)) {
    if (PQ.of.has(t)) return PQ.of.get(t).key;   // a peer monitor's conversation sits under its row
    const a = settingsApp(t), m = a.startsWith("w:") ? NM.items.find(x => x.watch === a.slice(2)) : null;
    return m ? `m:${m.name}` : `i:${a}`;
  }
  if (PQ.of.has(t)) return PQ.of.get(t).key;   // a peer's mail sits under that computer's item
  const it = INTG.items.find(x => intgHas(x, t));
  return `i:${it ? it.key : "mail"}`;
};
// go("monitoring", key) opens that item; without one a phone shows the list and a wide screen keeps the open item.
function monRoute(tgt) {
  pqOpen();
  if (tgt && tgt !== "list") {
    if (tgt !== MON.sel) { MON.filter = "all"; MON.open.clear(); MON.more.clear(); }   // another item: its list starts whole and folded
    MON.autoArmed = false; MON.olderBusy = false;
    MON.sel = tgt; MON.list = false;
  } else MON.list = narrowChat();
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

/* ---- a monitor's own timeline: how far the wait between two runs has come ---- */
// '방금 전' / '3분 전' / '2시간 전' and '곧' / '12분 후'. The bar's two ends are the last run and the next one; the fill is the share of that
// wait already gone. One ticker (monTickStart at the bottom) moves every bar of the page, so a row never owns a timer of its own.
const monRel = (ms, past) => {
  const a = Math.max(0, ms), min = Math.floor(a / 60000);
  if (min < 1) return past ? "방금 전" : "곧";
  const t = min < 60 ? `${min}분` : min < 1440 ? `${Math.floor(min / 60)}시간` : `${Math.floor(min / 1440)}일`;
  return past ? `${t} 전` : `${t} 후`;
};
const MON_PTAG = { ok: ["정상", "ok"], changed: ["바뀜", "warn"], fail: ["실패", "err"], disconnected: ["연결 끊김", "err"], need: ["확인 필요", "warn"], off: ["꺼짐", ""], late: ["늦어짐", "warn"], run: ["확인 중", "warn"] };
const monConnLine = m => ["연결 끊김", m.since ? `${monTime(m.since)}부터` : "", m.conn_reason === "login" ? "다시 로그인 필요" : m.conn_reason ? "확인이 계속 실패해요" : ""].filter(Boolean).join(" · ");
// The list row's status line has room for the start of the outage only; the banner and the overview add why.
const monConnShort = m => ["연결 끊김", m.since ? `${kstHM(m.since).replace(/^오[전후]\s*/, "")}부터` : ""].filter(Boolean).join(" · ");
// Empty for a paused or disconnected monitor: its one tag (꺼짐 / 연결 끊김) and, when down, the banner's single line already say it.
const monProgLine = (from, to, now, m, short) => {
  if (m && (m.paused || m.connection === "disconnected")) return "";
  if (m && m.watch && MON.running.has(m.watch)) return short ? "확인 중" : "지금 확인하고 있어요";
  if (short) return [from > 0 ? monRel(now - from, true) : "실행 전", to > 0 ? now >= to ? "늦어짐" : monRel(to - now, false) : "예정 없음"].join(" · ");
  return [from > 0 ? `지난 실행 ${monRel(now - from, true)}` : "아직 실행 전", to > 0 ? now >= to ? "다음 확인이 늦어졌어요" : `다음 ${monRel(to - now, false)}` : "예정 없음"].join(" · ");
};
// kind drives the fill: "" (accent, moving), warn (overdue, full), err (disconnected), off (paused, grey), run (indeterminate shimmer).
function monProgState(m, now) {
  if (m.watch && MON.running.has(m.watch)) return { kind: "run", pct: 0, tag: "run" };
  if (m.paused) return { kind: "off", pct: 100, tag: "off" };
  if (m.connection === "disconnected") return { kind: "err", pct: 100, tag: "disconnected" };
  const from = Date.parse(m.last_run), to = Date.parse(m.next_run);
  if (!(to > 0)) return { kind: "none", pct: 0, tag: m.last_result === "fail" ? "fail" : m.last_run ? "" : "need" };
  if (now >= to) return { kind: "warn", pct: 100, tag: m.last_result === "fail" ? "fail" : "late" };
  const pct = from > 0 ? Math.max(0, Math.min(100, ((now - from) / (to - from)) * 100)) : 0;
  return { kind: "", pct, tag: m.last_result === "changed" ? "changed" : m.last_result === "fail" ? "fail" : from > 0 ? "ok" : "need" };
}
const monPTagOf = k => MON_PTAG[k] || ["", ""];
// One progress block: a thin bar with its result tag on the same line and the two times in words under it. The bar carries data-from/data-to
// so the ticker can move it, and the tag is re-read on the way past next_run (늦어짐) without a repaint.
function monProgNode(m, opts = {}) {
  const now = Date.now(), st = monProgState(m, now), from = Date.parse(m.last_run), to = Date.parse(m.next_run), live = st.kind === "" || st.kind === "warn", line = monProgLine(from, to, now, m, opts.short);
  const [text, tone] = monPTagOf(st.tag);
  const width = st.kind === "run" ? 35 : st.pct;
  const bar = el("span", { class: `mon-prog${st.kind ? ` ${st.kind}` : ""}`, role: "progressbar", "aria-label": `${monTitle(m)} 진행`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(st.pct)), "aria-valuetext": line }, el("i", { style: `width:${width}%` }));
  if (live && from > 0 && to > 0) { bar.dataset.from = String(from); bar.dataset.to = String(to); bar.dataset.short = opts.short ? "1" : ""; }
  const tag = text && opts.tag !== false ? el("span", { class: `mon-ptag${tone ? ` ${tone}` : ""}`, "data-fixed": st.tag === "fail" || st.tag === "disconnected" || st.tag === "off" || st.tag === "run" ? "1" : null, text }) : null;
  const tx = line ? el("span", { class: "mon-prog-tx", text: line }) : null;
  return el("div", { class: `mon-prog-wrap${opts.compact ? " compact" : ""}` }, el("div", { class: "mon-prog-top" }, bar, tag), tx);
}

// A monitor's readable title: its label, else the [a-z0-9-] name in words ("node-security-updates" -> "node security updates"); the raw name
// is only the small text in the header. A watch's notices carry the label (hub notice) or the raw name (a gateway "[name] ..." post).
const monWords = s => /^[A-Za-z0-9][\w.-]*$/.test(s) && /[-_]/.test(s) ? s.replace(/[-_]+/g, " ") : s;
const monRaw = m => String(m.watch || m.name || "");
const monTitle = m => monWords(ntPlain(m.name)) || MON_KIND[m.kind] || "모니터링";
const monNames = m => [...new Set([monTitle(m), String(m.name || ""), monRaw(m), monWords(monRaw(m))].filter(Boolean))];
const monHas = (m, n) => n.kind === "watch" && monNames(m).includes(String(n.title || ""));
// 모니터링's own notices: a watch's or a schedule's report (kind "watch"), or a notice living in an integration's own conversation (a mail).
const monMine = (n, it) => n.kind === "watch" || (!!it && intgHas(it, n.src || n.open || ""));
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

// What is watched, in list order: 감시 소식 (reports no row below owns), then the 앱 group (the integrations), then the 일반 모니터링 group (the monitors). Each item carries what
// its row and its conversation show.
const MON_FEED = "감시 소식";
// An app's row says what waits on the owner, never the latest item's title. `needs` = {drafts, unread, sentToday} from GET /api/integrations (hub/integrations.ts):
// at most two parts, the most important first; the badge is the count that waits on him (drafts first, else unread).
function monNeedLine(n) {
  const parts = [];
  if (n.drafts) parts.push(`답장 확인 ${n.drafts}건`);
  if (n.unread) parts.push(`안 읽음 ${n.unread}`);
  if (n.sentToday) parts.push(`오늘 자동 답장 ${n.sentToday}건 보냄`);
  return parts.slice(0, 2).join(" · ") || "확인할 것 없어요";
}
// A watch an app owns (it.watches / it.watchesNot of GET /api/integrations, hub/integrations.ts) belongs to that app: no row of its own in 일반 모니터링,
// its status is in the app's panel and a failing one marks the app's row.
const monNamed = (list, w) => (list || []).some(x => x.endsWith("-") ? w.startsWith(x) : w === x);
// `own` = the watch names the hub resolved for the app (names, instance filters and the site a login keeper keeps, hub/app-features.ts); the name rules answer for an older hub.
const monOwner = (apps, m) => m.kind === "watch" && m.watch ? apps.find(a => Array.isArray(a.own) ? a.own.includes(m.watch) : monNamed(a.watches, m.watch) && !monNamed(a.watchesNot, m.watch)) : undefined;
const monOwnedBy = (apps, mons) => { const by = new Map(); for (const m of mons) { const o = monOwner(apps, m); if (o) by.set(o.key, [...(by.get(o.key) || []), m]); } return by; };
const monFail = owned => owned.some(m => m.last_result === "fail") ? ["실패", "err"] : null;
function monItems() {
  intgWatch();
  const mons = ntMons(), shown = new Set(), items = [], owned = monOwnedBy(INTG.items, mons);
  for (const it of INTG.items) {
    const notices = (it.notices || []).map(ntById).filter(n => n && monMine(n, it)), mails = [...CONV.keys()].filter(t => !PQ.of.has(t) && intgHas(it, t));
    for (const n of notices) shown.add(n.id);
    const cands = [...notices.map(n => ({ at: monNoticeAt(n), text: monLine(n) })), ...mails.filter(t => CONV.get(t)).map(t => ({ at: CONV.get(t).ts, text: (MAILS.get(t) || {}).subject || CONV.get(t).text }))].sort((a, b) => b.at.localeCompare(a.at));
    const needs = it.needs || { drafts: 0, unread: monUnread(notices) + mails.reduce((c, t) => c + (ts(t).unread | 0), 0), sentToday: 0 }, conn = it.state === "disconnected", own = owned.get(it.key) || [], bad = own.some(m => m.last_result === "fail");
    items.push({ key: `i:${it.key}`, group: MON_GROUP[it.kind || "app"] || MON_GROUP.app, name: it.label, ic: it.icon, notices, mails, app: true, conn, unread: needs.drafts || needs.unread, unreplied: needs.unreplied | 0, hint: conn && it.hint ? it.hint : bad ? "확인이 실패했어요" : monNeedLine(needs), at: cands[0] ? cands[0].at : "", owned: own, msig: conn ? "conn" : bad ? "fail" : "",
      badge: conn ? ["연결 끊김", "err"] : monFail(owned.get(it.key) || []) });
  }
  const ownedNames = new Set([...owned.values()].flat());
  for (const m of mons) {
    const notices = NT.items.filter(n => monHas(m, n)), last = monNewest(notices), names = monNames(m);
    for (const n of notices) shown.add(n.id);
    if (ownedNames.has(m)) continue;
    // The row says the newest result in words: the newest report, unless a later run said nothing (an "ok" run posts no report).
    const fresh = last && (!m.last_run || ntAt(last) >= Date.parse(m.last_run) - 60_000);
    const need = notices.filter(monNeed).length, conn = m.connection === "disconnected", running = !!m.watch && MON.running.has(m.watch);
    items.push({ key: `m:${m.name}`, group: MON_GROUP.plain, name: monTitle(m), raw: monRaw(m), ic: "activity", notices, mails: [], mon: m, unread: monUnread(notices), need, chips: monNeedChips(need),
      hint: conn ? monConnShort(m) : running ? "지금 확인하고 있어요" : fresh ? monStrip(monLine(last), names) : monRunLine(m), at: m.last_run || (last ? monNoticeAt(last) : ""),
      msig: [m.last_run, m.next_run, m.last_result, m.paused, m.connection, running].join("|"),
      badge: conn ? ["연결 끊김", "err"] : m.paused ? ["꺼짐", ""] : (Date.parse(m.next_run) || Infinity) < Date.now() ? ["늦어짐", "warn"] : m.last_result === "fail" ? ["실패", "err"] : m.last_result === "changed" ? ["바뀜", "warn"] : m.last_run ? ["정상", "ok"] : ["확인 필요", "warn"] });
  }
  // A report the hub marked as an app's (n.app, hub/notices.ts) is never here, even before the app list below has loaded.
  const feed = NT.items.filter(n => n.kind === "watch" && !n.app && !shown.has(n.id)), last = monNewest(feed), need = feed.filter(monNeed).length;
  // The feed's row: what waits on the owner as its chip (counted apart from the plain reports, like an app row), the newest line under the name.
  items.unshift({ key: "notice", group: "", name: MON_FEED, ic: "list", notices: feed, mails: [], unread: monUnread(feed), need, chips: monNeedChips(need), hint: last ? monLine(last) : "새 감시 소식이 없어요", at: last ? monNoticeAt(last) : "" });
  return pqMerge(items);
}
// 답 필요: waits on the owner and is answered from here (an open decision, an [ask] report), never read by looking; 실패: a report that could not check.
const monNeed = n => ntNeeds(n) && !n.pc;
const monFailed = n => n.tone === "fail";
const monNeedChips = need => (need ? [[`답 필요 ${need}`, "warn"]] : undefined);
// The open item: the one picked, else on a wide screen the first (a phone shows its list until one is picked).
const monSel = items => items.find(i => i.key === MON.sel) || (narrowChat() ? null : items[0] || null);
const monName = () => { const it = monItems().find(i => i.key === MON.sel); return kkItem(it) && KK.open && KK.room ? KK.room.name : it ? it.name : titles.monitoring; };
function monState(it) {
  if (it.off) return "연결 안 됨";
  // The progress block under the name already carries the two runs in words, so the state line says only where it stands.
  if (it.mon) { if (it.mon.connection === "disconnected") return ""; if (it.mon.paused) return "꺼짐"; const res = it.mon.last_result ? NT_RESULT[it.mon.last_result] : null; return res ? res[0] : "확인 전"; }
  if (it.key === "notice") return [it.need ? `답 필요 ${it.need}건` : "", it.unread ? `안 읽음 ${it.unread}개` : ""].filter(Boolean).join(" · ") || "감시와 예약 결과";
  return it.app ? it.hint : it.unread ? `안 읽음 ${it.unread}개` : "연결돼 있어요";
}

/* ---- the list ---- */
function monRows(items, sel) {
  const rows = [];
  let group = null, added = false;
  // 앱 추가 is the last row of the 앱 group, right under the apps; with no app yet it is the group's only row.
  const addRow = () => { added = true; rows.push({ k: "add-app", name: "앱 관리", av: monIcon("add"), hint: asAddHint(), sel: false, open: () => asAddSheet() }); };
  for (const it of items) {
    if (group === MON_GROUP.app && it.group !== group && !added) addRow();
    if (it.group === MON_GROUP.plain && !added) { rows.push({ header: MON_GROUP.app }); addRow(); }
    if (it.group && it.group !== group) rows.push({ header: it.group });
    group = it.group;
    rows.push({ k: it.key, name: it.name, av: monIcon(it.ic), hint: it.hint, unread: it.unread, unreplied: it.unreplied | 0, badge: it.badge || null, chips: it.chips, sel: !!sel && it.key === sel.key && !MON.list, open: () => go("monitoring", it.key) });
  }
  if (!added) { if (group !== MON_GROUP.app) rows.push({ header: MON_GROUP.app }); addRow(); }
  if (!NM.loaded) rows.push({ header: NM.failed ? "모니터링을 불러오지 못했어요" : "모니터링 불러오는 중…" });
  return rows;
}

/* ---- the conversation ---- */
const MON_TONE = { fail: ["실패", "err"], warn: ["주의", "warn"], ask: ["답변 필요", "warn"], ok: ["정상", "ok"], changed: ["바뀜", "warn"] };
const monWhen = n => ntTime(n.updated || n.ts);
const monTag = tone => { const t = MON_TONE[tone]; return t ? el("span", { class: `tag ${t[1]}`, text: t[0] }) : null; };
// A send approval (hub/draft-approval.ts): drawn as the mail it would send - the one question, the mail being answered when known, the recipient chip,
// the subject in bold, the body in paragraphs - with its state as a badge with the time. 보내기 sends, 고치기 asks "어떻게 고칠까요?" (the bot rewrites it),
// 보내지 않기 is the quiet way out. The whole answer path is the notice's (answerInline / ntPost), so the chat card and this one stay in step.
const DR = { edit: new Set(), manual: new Set(), note: {} };
const DR_STATE = { open: ["승인 대기", "warn"], send: ["보냄", "ok"], edit: ["고침", "pri"], revising: ["고치는 중…", "pri"], drop: ["보내지 않음", ""], expired: ["만료", ""], ignored: ["무시함", ""] };
function drState(d) {
  if (d.state === "open" || d.state === "ignored") return d.state;
  if (d.draft && ntRevising({ kind: "decision", decision: d })) return "revising";   // 고치기 answered, the new draft has not landed
  const m = /^\s*(\d+)\)/.exec(String(d.answer || "")), o = m && d.options.find(x => x.n === Number(m[1]));
  return d.resolved || !o ? "expired" : { 보내기: "send", 고치기: "edit", "보내지 않기": "drop" }[o.label] || "expired";
}
const drParas = body => String(body ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().split(/\n\n/);
function drOriginal(t) {
  const m = MAILS.get(t);
  if (!m) return null;
  const brief = mailBrief(m, t);
  return el("div", { class: "dr-orig" }, el("div", { class: "dr-ok", text: "답장할 메일" }), el("div", { class: "dr-os" }, el("b", { text: mailSender(m.from) }), m.subject ? ` · ${m.subject}` : ""), brief ? el("div", { class: "dr-ob", text: brief }) : null);
}
function draftCardNode(n) {
  const d = n.decision, dr = d.draft, st = drState(d), open = st === "open", [stText, stTone] = DR_STATE[st], busy = dcSending.has(n.id);
  const opt = k => d.options.find(o => o.label === k) || null, oSend = opt("보내기"), oEdit = opt("고치기"), oDrop = opt("보내지 않기");
  const redraw = () => { const nn = draftCardNode(n); card.replaceWith(nn); };
  const when = ntTime(d.answered_at || n.updated || n.ts), mail = d.to.startsWith("mail:");
  const q = ntPlain(n.title).replace(/\s*\([^()]*\)\s*$/, "");
  const editing = open && DR.edit.has(n.id), man = editing && DR.manual.has(n.id);
  let go2 = null;
  const ta = editing ? el("textarea", { class: man ? "dr-edit" : "dr-edit ask", rows: man ? "8" : "2", maxlength: man ? "6000" : "500", placeholder: man ? "" : DRAFT_HINT, "aria-label": man ? "직접 수정" : "고칠 내용", disabled: busy, oninput: () => { DR.note[n.id] = ta.value; if (go2) go2.disabled = !ta.value.trim(); } }) : null;
  if (ta) ta.value = DR.note[n.id] ?? (man ? drParas(dr.body).join("\n\n") : "");
  const leave = () => { DR.edit.delete(n.id); DR.manual.delete(n.id); delete DR.note[n.id]; };
  const mailBox = el("div", { class: "dr-mail" },
    el("div", { class: "dr-to" }, el("span", { class: "dr-k", text: dr.toLabel || "받는이" }), el("span", { class: "dr-chip", text: dr.to || "-" })),
    dr.subject ? el("div", { class: "dr-sub", text: dr.subject }) : null,
    draftOriginNode(dr),
    man ? ta : el("div", { class: "dr-body" }, ...drParas(dr.body).map(t => el("p", { text: t }))),
    draftFilesNode(dr, { t: d.to, edit: open }), draftMailNode(dr.mail));
  if (editing && !man) mailBox.append(el("div", { class: "dr-q2", text: "어떻게 고칠까요?" }), ta);
  const kids = [
    el("div", { class: "rc-hd" }, el("span", { class: "dr-ic" }, icon(mail ? "mail" : "send")), el("span", { class: "rc-src", text: mail ? "메일" : (targetName(d.to) || "초안") }), el("span", { class: `tag dr-st${stTone ? ` ${stTone}` : ""}`, "data-state": st, text: `${stText} · ${when}` })),
    q ? el("div", { class: "rc-title dr-q", text: q }) : null, mail ? drOriginal(d.to) : null, mailBox];
  if (editing) {
    go2 = el("button", { class: "btn", type: "button", disabled: busy || !ta.value.trim(), text: man ? "이 내용으로 고치기" : "고쳐 달라고 하기", onclick: async () => {
      const text = ta.value.trim();
      if (!text || !oEdit) return;
      dcSending.add(n.id); syncInlineChoices(); redraw();
      try { await ntPost(n, oEdit.n, man ? MANUAL_LEAD + text : text); leave(); } catch (e) { toast(e.message, true); }
      dcSending.delete(n.id); syncInlineChoices();
    } });
    kids.push(el("div", { class: "dr-act dr-row" }, go2, el("button", { class: "btn text", type: "button", disabled: busy, text: "취소", onclick: () => { leave(); redraw(); } }),
      man ? null : el("button", { class: "btn text dr-manual", type: "button", disabled: busy, onclick: () => { DR.manual.add(n.id); delete DR.note[n.id]; redraw(); } }, icon("pencil"), el("span", { text: "직접 수정" }))));
  } else if (open) {
    const go = o => () => { if (!o || busy) return; if (o === oSend && (dr.warning || (dr.attachments || []).length)) drfSure(dr, d.to).then(ok => ok && answerInline(n, o)); else answerInline(n, o); };
    kids.push(el("div", { class: "dr-act dr-row" },
      el("button", { class: "btn dr-send", type: "button", disabled: busy || !oSend, text: "보내기", onclick: go(oSend) }),
      el("button", { class: "btn tonal", type: "button", disabled: busy || !oEdit, text: "고치기", onclick: () => { DR.edit.add(n.id); redraw(); } }),
      el("button", { class: "btn text dr-drop", type: "button", disabled: busy || !oDrop, text: "보내지 않기", onclick: go(oDrop) })));
  }
  const card = el("div", { class: `bm alert rc dr ${st}`, "data-nid": n.id }, ...kids.filter(Boolean));
  return card;
}
// A decision: the question and the same choice rows a chat message has; an open one is answered here, an answered one shows what was chosen.
function monDecisionNode(n) {
  const d = n.decision, open = d.state === "open", said = d.state === "answered" ? String(d.answer || "") : "";
  if (d.draft) return ntRevising(n) && ntSuccessor(n) ? null : draftCardNode(n);   // the rewritten draft replaces the one that was sent back
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
// Any other notice is a result card (11-resultcard.js): the monitor's name, the time, the result in words, the original folded.
// A monitor's own report drops the monitor's name in front of its first line (the card already says whose it is).
const monCard = (name, at, text, tone, title) => resultCard({ src: name, at, text, title, tag: monTag(tone) });
function monNoticeNode(n, names = []) {
// A report that points at an app item (n.item, hub/watchitem.ts) shows the item as the app draws it, the check's own output folded under it. This is the one
// place that resolves the reference: a mail this page holds, else the card the hub kept with the report; an item that is not found here (another gateway's)
// shows the subject and sender the check printed, and a report with nothing to show is a plain report.
function monItemNode(n) {
  const it = n.item, t = it && it.app === "mail" && it.key ? `mail:${it.key}` : "", c = it && it.card;
  if (t && !MAILS.has(t) && c && c.source) MAILS.set(t, c);
  const node = t && MAILS.has(t) ? monConvNode(t, "메일") : c && (c.subject || c.from) ? resultCard({ src: mailSender(c.from), at: n.updated || n.ts, title: c.subject }) : null;
  const raw = node ? rcSplit(n.text).raw : "";
  if (raw) { const d = rcRawFold(raw); d.addEventListener("click", e => e.stopPropagation()); node.append(d); }
  return node;
}
  if (ntIsDec(n) && !n.pc) return monDecisionNode(n);   // a peer's question is answered on that computer: here it is a plain report
  const node = monCard(ntPlain(names[0] || n.title) || "알림", n.updated || n.ts, monStrip(String(n.text || ""), [...names, ntPlain(n.title)]), n.tone);
  const card = n.item ? monItemNode(n) : null;
  if (card) { card.dataset.nid = n.id; return card; }
  if (!node) return null;
  node.dataset.nid = n.id;
  if (ntNeeds(n) && !n.pc) node.append(el("div", { class: "btns cc-act" }, el("button", { class: "btn tonal", type: "button", onclick: () => noticeOpen(n), text: "답하러 가기" })));
  return node;
}
// A mail's short text for its row: the poster's summary, else the first lines of its body (hub/mail.ts keeps both), else the same taken from
// the conversation's first message the web already holds (a plugin that posts only sender and subject: the 요약 section the lane wrote, else
// the original's first lines; hub/mail.ts mailBriefOf does the same for the list), else nothing.
// It never repeats the sender or the subject: with nothing to summarize the row shows no third line.
const mailSkip = m => new Set([rcPlain(m.subject), rcPlain(`${m.from} · ${m.subject}`), rcPlain(m.from), rcPlain(mailSender(m.from))].filter(Boolean));
const mailLines = (s, skip) => String(s ?? "").split("\n").map(l => rcPlain(l).replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(l => l && !rcLabel(l) && !skip.has(l));
function mailFromMsg(text, skip) {
  const sp = rcSplit(text), sec = rcSections(sp.text).find(s => s.h === "요약"), own = sec ? mailLines(sec.body, skip).slice(0, 3) : [];
  return own.length ? own : mailLines(sp.raw, skip).slice(0, 3);
}
const mailBrief = (m, t) => {
  const skip = mailSkip(m), own = mailLines(m.summary || m.preview, skip);
  if (own.length || !t) return own.join(" ");
  for (const e of ts(t).msgs) {
    if (!convIncoming(e)) continue;
    const lines = mailFromMsg(e.text, skip);
    if (lines.length) return lines.join(" ");
  }
  return "";
};
const mailSize = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : b >= 1024 ? `${Math.round(b / 1024)}KB` : b > 0 ? `${b}B` : "";
// The authenticated hub route of one attached file (hub/mail.ts mailFileRoute); dl=1 answers with Content-Disposition: attachment.
const mailFileUrl = (key, i, dl) => pqLink(`/api/mail/${enc(key)}/files/${i}${dl ? "?dl=1" : ""}`);
// The attachments of a mail in its original view: one row per file (name, size); the row itself is the download link, so it also saves
// in an installed app / on a phone, where a new tab would not.
function mailFilesNode(key, files) {
  return el("div", { class: "mr-files" }, el("div", { class: "mr-fh", text: `첨부파일 ${files.length}개` }), ...files.map((f, i) =>
    el("a", { class: "mr-file", href: mailFileUrl(key, i, true), download: f.name, title: `${f.name} 내려받기`, "aria-label": `${f.name} 내려받기${f.size ? ` (${mailSize(f.size)})` : ""}` },
      icon("file"), el("span", { class: "mr-fname", text: f.name }), f.size ? el("span", { class: "mr-fsize", text: mailSize(f.size) }) : null, icon("download"))));
}
// The reply state of a mail's row. `m.suggest` is written by the reply-draft lane (hub/mail.ts setMailSuggest; stays absent while the install's
// reply-draft option is off or nothing was offered): { kind: "reply-draft", label, ref, state? }, `ref` = the draft id and `state` =
// "draft" (default: a draft waits for approval) | "sent" (the reply went out by itself) | "waiting" (a reply is expected, no draft yet).
// Without suggest nothing is drawn.
const MAIL_REPLY = { draft: ["답장 초안 있음", "pri"], sent: ["자동 답장 보냄", "ok"], waiting: ["답장 대기", ""] };
const mailReplyChip = sg => {
  if (!sg || typeof sg !== "object" || (sg.kind && sg.kind !== "reply-draft")) return null;
  const [text, tone] = MAIL_REPLY[sg.state || "draft"] || [];
  return text ? el("span", { class: `tag mr-reply${tone ? ` ${tone}` : ""}`, "data-slot": "suggest", text }) : null;
};
// The state label of a mail row (hub/mail-state.ts mailLabel): outgoing = 내가 보냄; incoming = its reply state (m.reply: needs | draft | replied | skipped | fyi),
// else 읽음 / 새 메일. Reading never changes the reply state; the unread count stays beside it as its own tag.
const MAIL_STATE = { needs: ["답장 필요", "warn"], draft: ["초안 있음", "pri"], replied: ["답장함", "ok"], skipped: ["답장 안 함", ""], fyi: ["참고만", ""] };
const mailStateOf = (m, unread) => m.dir === "out" ? ["내가 보냄", ""] : MAIL_STATE[m.reply] || (unread ? ["새 메일", "warn"] : ["읽음", ""]);
// The filter of the mail list: 전체 / 답장 필요 / 답장함 / 보낸 메일.
const MAIL_FILTERS = [["all", "전체", () => true], ["owed", "답장 필요", m => m.dir !== "out" && (m.reply === "needs" || m.reply === "draft")], ["replied", "답장함", m => m.dir !== "out" && m.reply === "replied"], ["sent", "보낸 메일", m => m.dir === "out"]];
const mailFilterOf = () => MAIL_FILTERS.find(f => f[0] === MON.mailFilter) || MAIL_FILTERS[0];
function mailFilterBar(mails) {
  const cur = mailFilterOf()[0];
  return el("div", { class: "mr-filter", role: "tablist", "aria-label": "메일 보기" }, ...MAIL_FILTERS.map(([k, label, ok]) => {
    const n = k === "all" ? 0 : mails.filter(t => MAILS.has(t) && ok(MAILS.get(t))).length;
    return el("button", { class: `cchip mr-f${k === cur ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(k === cur), "data-filter": k, onclick: () => { MON.mailFilter = k; MON.sig = ""; monSchedule(); } }, label, n ? el("span", { class: "mr-fn", text: String(n) }) : null);
  }));
}
// A mail or chat of an integration is its own conversation in 채팅. A mail is a compact result-card row: sender and time on one line (with
// a paperclip and the file count when it has files), the subject, a summary of up to 3 lines and, at the bottom, the reply state. The
// whole card is the way in: it opens the mail's conversation, where the original and its files are (11-todo-strip.js "mail").
function monConvNode(t, label) {
  const m = MAILS.get(t), last = CONV.get(t), n = ts(t).unread, open = () => go("monitoring", `c:${t}`);
  const owed = !!(m && m.unreplied), [stateText, stateTone] = m ? mailStateOf(m, n) : ["", ""];
  // A mail's tags: the unread count only beside a reply state (alone, "새 메일" says it); the state label is the orange 미답장 pill while a reply is owed.
  const tag = m ? (n && m.dir !== "out" && m.reply ? el("span", { class: "tag warn", text: `안 읽음 ${n}` }) : null) : n ? el("span", { class: "tag warn", text: `안 읽음 ${n}` }) : ntHasDecision(t) ? el("span", { class: "tag warn", text: "답변 필요" }) : null;
  const stateTag = m ? (owed ? unrepPill(stateText) : el("span", { class: `tag mr-state${stateTone ? ` ${stateTone}` : ""}`, "data-state": stateText, text: stateText })) : null;
  const files = m ? m.attachments || [] : [], brief = m ? mailBrief(m, t) : "", when = rcWhen(last ? last.ts : m && m.at), chip = m && (m.dir === "out" || !m.reply || (m.suggest && m.suggest.state === "sent")) ? mailReplyChip(m.suggest) : null;
  const title = m ? m.subject || "(제목 없음)" : rcPlain(String(last ? last.text : "").split("\n").find(l => l.trim() && !/^\s*>/.test(l)) || "") || label;
  const clip = files.length ? el("span", { class: "mr-clip", title: `첨부파일 ${files.length}개`, "aria-label": `첨부파일 ${files.length}개` }, icon("clip"), String(files.length)) : null;
  return el("div", { class: "bm alert rc mr", role: "button", tabindex: "0", "aria-label": `${title} ${m ? "원문 열기" : "대화 열기"}`, onclick: open,
    onkeydown: e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } } },
    el("div", { class: "rc-hd" }, el("span", { class: "rc-src", text: m ? m.dir === "out" ? `나 → ${mailSender(m.to) || "받는 사람"}` : mailSender(m.from) || label : label }), stateTag, tag, clip, when ? el("span", { class: "rc-time", text: when }) : null),
    el("div", { class: "rc-title", text: title }),
    brief ? el("div", { class: "mr-sum", text: brief }) : null,
    chip || owed ? el("div", { class: "mr-slot" }, chip, owed ? unrepNo(`/api/mail/${t.slice(5)}/no-reply`, () => { m.unreplied = false; m.reply = "skipped"; monSchedule(); if (pqPc(t)) pqSoon(); }) : null, owed ? mailFyiButton(t, m) : null) : null);
}
// 참고만: this mail needs no reply (POST /api/mail/<key>/fyi); the label changes at once, the lists re-read.
const mailFyiButton = (t, m) => el("button", { class: "cchip unrep-no mr-fyi", type: "button", text: "참고만", onclick: ev => { ev.stopPropagation(); busy(ev.currentTarget, async () => { await api(`/api/mail/${t.slice(5)}/fyi`, "POST", {}); toast("참고만으로 표시했어요"); m.unreplied = false; m.reply = "fyi"; monSchedule(); if (pqPc(t)) pqSoon(); loadIntegrations(); }); } });   // busy: a second tap while it posts does nothing
// A monitor's latest run, as the newest message of its conversation: the result in words, when it checks next, and its project chat.
function monRunNode(it) {
  const m = it.mon;
  if (!m.last_run) return null;
  const next = [m.next_run ? `다음 확인 ${monTime(m.next_run)}` : "", m.every || ""].filter(Boolean).join(" · ");
  // The status header: fails in a row, the last good run and the last output in words (hub/monitors.ts watchFacts), then when it runs next.
  const facts = [m.fails ? `연속 실패 ${m.fails}번` : "", m.last_ok ? `마지막 정상 ${monTime(m.last_ok)}` : "", m.last_output ? `마지막 결과: ${m.last_output}` : ""].filter(Boolean);
  const node = monCard(it.name, m.last_run, [...facts, next].filter(Boolean).join("\n\n"), m.kind === "watch" ? m.last_result : "", monRunLine(m));
  const chips = m.kind === "watch" && m.watch ? asChipTexts(m) : [];
  if (node && chips.length) node.append(el("div", { class: "btns cc-act mon-chips" }, ...chips.map(t => el("button", { class: "as-tpl", type: "button", "data-chip": t, onclick: () => asAsk(`w:${m.watch}`, t) }, t))));
  return node;
}
// Runs the monitor once now, on the computer that owns it (a peer's through /api/peer/act). The route answers after the check with the new
// row, so the bar's right edge moves at once; a peer has no row to read here, so its list is re-read through pqSoon.
const monRunNow = (btn, m) => busy(btn, async () => {
  if (!m || !m.watch) return;
  MON.running.add(m.watch); MON.sig = ""; MON.side = ""; monSchedule();
  const was = btn && btn.textContent;
  if (btn) btn.textContent = "확인하는 중…";
  try {
    const r = await api(`/api/watches/${enc(m.watch)}/run`, "POST", {});
    if (r && r.item && r.item.watch) {
      const i = NM.items.findIndex(x => x.watch === r.item.watch);
      if (i >= 0) NM.items[i] = r.item; else NM.items.push(r.item);
    }
    await loadMonitors();
    if (m.pc) pqSoon();
    toast(r && r.item && r.item.connection === "disconnected" ? "확인했지만 아직 연결이 끊겨 있어요" : "확인했어요");
  } finally {
    MON.running.delete(m.watch); MON.sig = ""; MON.side = ""; monSchedule();
    if (btn) btn.textContent = was;
  }
});
// 지금 다시 확인 on a disconnected app: every watch the app owns runs on this computer, then the app and the list are read again.
const monRecheckApp = (btn, it, names) => busy(btn, async () => {
  for (const n of names) MON.running.add(n);
  MON.sig = ""; MON.side = ""; monSchedule();
  try { await Promise.all(names.map(n => api(`/api/watches/${enc(n)}/run`, "POST", {}))); }
  finally { for (const n of names) MON.running.delete(n); }
  await Promise.all([loadMonitors(), it.pc ? pqLoad() : loadIntegrations()]);
  MON.sig = ""; MON.side = ""; monSchedule();
  toast("지금 다시 확인했어요");
});
// An item reads like a chat: its reports and mails oldest to newest, a monitor's latest run last. The 감시 소식 feed is a list, not a chat: newest on top.
const monFeed = it => it.key === "notice";

/* ---- a lot piled up: what waits first, one row per source, filters, 읽음 처리, pages ---- */
const MON_FILTERS = [["all", "전체", () => true], ["need", "답 필요", monNeed], ["fail", "실패", monFailed]];
const monFilterOf = () => MON_FILTERS.find(f => f[0] === MON.filter) || MON_FILTERS[0];
const MON_PAGE = 30;       // rows per page (더 보기 / 이전 소식 보기 bring the next)
const MON_FOLD_MIN = 3;    // a run of this many same results in a row folds into its last one
// A row's summary: the report's first two lines (the monitor's name and the original dropped), 140 characters at most.
function monSummary(n, names) {
  const body = String(n.text || "").split(/\n(?:```원문|원문[ \t]*\n)/)[0];
  const lines = monStrip(body, [...names, ntPlain(n.title)]).split("\n").map(l => ntPlain(l)).filter(Boolean);
  const s = lines.slice(0, 2).join(" · ");
  return (s.length > 140 ? `${s.slice(0, 139)}…` : s) || ntPlain(n.title) || "알림";
}
const monFoldKey = (n, names) => `${n.tone}|${monSummary(n, names)}`;
// One source of the feed: the watch's name on one computer (a peer's report of the same name is its own row).
const monSrcKey = n => `${n.pc ? n.pc.name : ""}|${ntPlain(n.title)}`;
function monToggle(key) { if (MON.open.has(key)) MON.open.delete(key); else MON.open.add(key); MON.sig = ""; monSchedule(); }
const monMoreBtn = (key, left, text) => el("button", { class: "btn text mon-more", type: "button", "data-more": key, onclick: () => { MON.more.set(key, (MON.more.get(key) || MON_PAGE) + MON_PAGE); MON.grew = key !== "feed" && !key.startsWith("g:"); MON.sig = ""; monSchedule(); }, text: text || `${left}개 더 보기` });
// The top of an older page watches for the owner reaching it (monObserveOlder at the bottom): the reports above load themselves, and the button stays
// for a keyboard or a browser without the observer.
const monOlderSentinel = (key, left) => el("div", { class: "mon-sentinel", "data-older": key, "data-left": String(left), "aria-hidden": "true" });
const monKey = (ev, fn) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); fn(); } };
// The bar above a long list: the three views with their counts, and 읽음 처리 for the plain reports in the view (what waits on the owner stays unread).
// It is drawn once the item holds more than a handful of reports, or any that waits or failed unread; a mail list has its own bar instead.
const monBarWanted = it => !it.pc && !it.mails.some(t => MAILS.has(t)) && (it.notices.length > 6 || it.notices.some(n => monNeed(n) || (monFailed(n) && !n.read)));
function monBar(it) {
  const cur = monFilterOf(), fyi = it.notices.filter(n => cur[2](n) && !n.read && !monNeed(n) && n.id);
  return el("div", { class: "mr-filter mon-bar" },
    el("div", { class: "mon-tabs", role: "tablist", "aria-label": "소식 보기" }, ...MON_FILTERS.map(([k, label, ok]) => {
      const n = k === "all" ? it.notices.length : it.notices.filter(ok).length;
      return el("button", { class: `cchip mr-f${k === cur[0] ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(k === cur[0]), "data-filter": k, onclick: () => { MON.filter = k; MON.more.clear(); MON.sig = ""; monSchedule(); } }, label, n ? el("span", { class: "mr-fn", text: String(n) }) : null);
    })),
    el("button", { class: "btn text mon-read", type: "button", "data-k": "read", disabled: !fyi.length, title: "답이 필요한 것은 그대로 둬요", onclick: ev => monReadAll(ev.currentTarget, fyi), text: fyi.length ? `${fyi.length}개 읽음 처리` : "읽음 처리" }));
}
// 읽음 처리: the listed plain reports are read here at once and on the hub; a failure puts them back and says why (busy toasts it).
const monReadAll = (btn, list) => busy(btn, async () => {
  const ids = list.map(n => String(n.id));
  for (const n of list) n.read = true;
  NT.unread = Math.max(0, NT.unread - ids.length); ntPaint(); homeSoon();
  let r;
  try { r = await api("/api/notices/read", "POST", { ids }); }
  catch (err) { for (const n of list) n.read = false; NT.unread += ids.length; ntPaint(); homeSoon(); loadNotices(); throw err; }
  if (r && typeof r.unread === "number") NT.unread = r.unread;
  ntPaint();
  toast(`${ids.length}개를 읽음으로 표시했어요`);
});
// One report as a row: source, state, time and a two-line summary; a tap unfolds the whole card in place (sections, the original, 답하러 가기).
// A report that waits on the owner carries 답하러 가기 on the row itself. A decision is always the whole card: it is answered in place.
function monRowNode(n, names) {
  if ((ntIsDec(n) && !n.pc) || n.item) return monNoticeNode(n, names);   // a report about an app item shows the item (a mail row) as the app draws it
  const key = `n:${n.id}`, src = ntPlain(names[0] || n.title) || "알림";
  if (MON.open.has(key)) {
    const full = monNoticeNode(n, names);
    if (!full) return null;
    full.classList.add("fr-open");
    full.append(el("div", { class: "btns cc-act" }, el("button", { class: "btn text", type: "button", "aria-label": `${src} 소식 접기`, onclick: () => monToggle(key), text: "접기" })));
    return full;
  }
  const need = monNeed(n);
  return el("div", { class: `bm alert rc fr${n.read ? "" : " un"}`, "data-nid": n.id, role: "button", tabindex: "0", "aria-expanded": "false", "aria-label": `${src} 소식 펼치기`, onclick: () => monToggle(key), onkeydown: ev => monKey(ev, () => monToggle(key)) },
    el("div", { class: "rc-hd" }, el("span", { class: "rc-src", text: src }), n.pc ? el("span", { class: "tag", text: n.pc.name }) : null, need ? monTag("ask") : monTag(n.tone), el("span", { class: "rc-time", text: monWhen(n) })),
    el("div", { class: "fr-sum", text: monSummary(n, names) }),
    need ? el("div", { class: "btns cc-act" }, el("button", { class: "btn tonal", type: "button", onclick: ev => { ev.stopPropagation(); noticeOpen(n); }, text: "답하러 가기" })) : null);
}
// One source folded into one row: its newest line, how many reports and how many unread; a tap lists them, newest first, a page at a time.
// Folded, the row stands for its newest report (seeing it reads that one); the rest are read as they come into view or by 읽음 처리.
function monGroupNode(g, names) {
  if (g.length === 1) return [monRowNode(g[0], names)];
  const n0 = g[0], need = monNeed(n0), key = `g:${need ? `need|${monSummary(n0, names)}|` : ""}${monSrcKey(n0)}`, open = MON.open.has(key), unread = g.filter(n => !n.read).length, src = ntPlain(names[0] || n0.title) || "알림";
  const head = el("div", { class: `bm alert rc fr grp${unread ? " un" : ""}${open ? " open" : ""}`, "data-nid": open ? null : n0.id, "data-group": key, role: "button", tabindex: "0", "aria-expanded": String(open), "aria-label": `${src} 소식 ${g.length}건 ${open ? "접기" : "펼치기"}`, onclick: () => monToggle(key), onkeydown: ev => monKey(ev, () => monToggle(key)) },
    el("div", { class: "rc-hd" }, el("span", { class: "rc-src", text: src }), n0.pc ? el("span", { class: "tag", text: n0.pc.name }) : null, need ? monTag("ask") : monTag(n0.tone), el("span", { class: "tag fr-n", text: need ? `같은 질문 ${g.length}번` : `${g.length}건` }), unread ? el("span", { class: "nb", "aria-label": `안 읽음 ${unread}개`, text: unread > 99 ? "99+" : String(unread) }) : null, el("span", { class: "rc-time", text: monWhen(n0) }), el("span", { class: "fr-chev", "aria-hidden": "true" }, icon("drop"))),
    open ? null : el("div", { class: "fr-sum", text: monSummary(n0, names) }),
    // the same question asked again: answered once from its newest one, the earlier ones listed when unfolded
    need && !open ? el("div", { class: "btns cc-act" }, el("button", { class: "btn tonal", type: "button", onclick: ev => { ev.stopPropagation(); noticeOpen(n0); }, text: "답하러 가기" })) : null);
  if (!open) return [head];
  const page = MON.more.get(key) || MON_PAGE;
  return [head, el("div", { class: "fr-list" }, ...g.slice(0, page).map(n => monRowNode(n, names)).filter(Boolean), g.length > page ? monMoreBtn(key, g.length - page) : null)];
}
// 감시 소식, newest first: what waits on the owner (each its own row), then the sources with an unread failure, then the rest, one row per source.
function monFeedNodes(it, names) {
  const ok = monFilterOf()[2], list = it.notices.filter(ok).sort((a, b) => ntAt(b) - ntAt(a));
  const asked = new Map(), by = new Map();
  for (const n of list) if (monNeed(n)) { const k = `${monSrcKey(n)}|${monSummary(n, names)}`; asked.set(k, [...(asked.get(k) || []), n]); }
  for (const n of list) if (!monNeed(n)) { const k = n.item ? `item|${n.id}` : monSrcKey(n); by.set(k, [...(by.get(k) || []), n]); }
  const groups = [...by.values()], bad = groups.filter(g => g.some(n => monFailed(n) && !n.read));
  const secs = [["답 필요", [...asked.values()]], ["실패", bad], ["소식", groups.filter(g => !bad.includes(g))]].filter(s => s[1].length);
  const page = MON.more.get("feed") || MON_PAGE, out = [];
  let shown = 0, left = 0;
  for (const [label, gs] of secs) {
    if (shown >= page) { left += gs.length; continue; }
    if (secs.length > 1) out.push(el("div", { class: "mon-sh", role: "heading", "aria-level": "3", text: label }));
    let day = "";
    for (const g of gs) {
      if (shown >= page) { left++; continue; }
      shown++;
      // the plain sources under a day line (오늘 / 10월 25일 (토)), by their newest report; what waits stays one block on top
      const d = label === "답 필요" ? "" : dayLabel(ntAt(g[0]));
      if (d && d !== day) { day = d; out.push(el("div", { class: "mon-day", text: d })); }
      out.push(...monGroupNode(g, names));
    }
  }
  if (left) out.push(monMoreBtn("feed", left));
  return out.filter(Boolean);
}
// A monitor or an app, oldest to newest: the newest MON_PAGE reports (이전 소식 보기 brings the older ones above), a run of the same result folded into its
// last report, the mails, and the monitor's latest run last.
function monChronoNodes(it, names) {
  const ok = monFilterOf()[2], withMails = it.mails.some(t => MAILS.has(t)), mf = withMails ? mailFilterOf() : null;
  const runs = [];
  for (const n of it.notices.filter(ok).sort((a, b) => ntAt(a) - ntAt(b))) {
    const last = runs[runs.length - 1], k = monNeed(n) || ntIsDec(n) ? "" : monFoldKey(n, names);
    if (k && last && last.k === k) { last.all.push(n); last.n = n; } else runs.push({ k, n, all: [n] });
  }
  const page = MON.more.get(it.key) || MON_PAGE, cut = Math.max(0, runs.length - page);
  const rep = r => {
    if (r.all.length < MON_FOLD_MIN) return r.all.map(n => ({ at: ntAt(n), node: () => monNoticeNode(n, names) }));
    return [{ at: ntAt(r.n), node: () => { const x = monNoticeNode(r.n, names); if (!x) return null; x.dataset.nids = r.all.map(n => n.id).join(","); x.querySelector(".rc-hd").after(el("div", { class: "mon-rep", text: `같은 결과 ${r.all.length}번 · 처음 ${monWhen(r.all[0])}` })); return x; } }];
  };
  const msgs = [...runs.slice(cut).flatMap(rep), ...(mf ? it.mails.filter(t => !MAILS.has(t) || mf[2](MAILS.get(t))) : it.mails).map(t => ({ at: Date.parse((CONV.get(t) || {}).ts) || Date.parse((MAILS.get(t) || {}).at) || 0, node: () => monConvNode(t, it.name) })),
    ...(it.mon ? [{ at: Date.parse(it.mon.last_run) || 0, node: () => monRunNode(it) }] : [])].sort((a, b) => a.at - b.at);
  const nodes = msgs.map(x => x.node()).filter(Boolean);
  if (cut) nodes.unshift(monOlderSentinel(it.key, cut), monMoreBtn(it.key, cut, `이전 소식 ${cut}개 보기`));
  if (withMails) return [mailFilterBar(it.mails), ...(nodes.length ? nodes : [el("div", { class: "empty", text: "이 보기에 해당하는 메일이 없어요" })])];
  return nodes;
}
// A short feed (a handful of reports) reads best as the whole cards, newest first, with the machine of a peer's report; past MON_COMPACT
// reports it becomes the sections and folded rows of monFeedNodes.
const MON_COMPACT = 6;
const monFeedCards = (it, names) => it.notices.filter(monFilterOf()[2]).sort((a, b) => ntAt(b) - ntAt(a)).map(n => {
  const x = monNoticeNode(n, names), src = x && n.pc && x.querySelector(".rc-src");
  if (src) src.after(el("span", { class: "tag", text: n.pc.name }));
  return x;
}).filter(Boolean);
// A phone has no room for the wide head, so the same progress, connection banner and 지금 확인 open the conversation instead.
function monTopNodes(it) {
  if (!narrowChat()) return [];
  const out = [], banner = monBannerOf(it);
  if (it.mon) out.push(monProgNode(it.mon, { tag: !banner }));
  if (banner) out.push(banner);
  if (it.mon && it.mon.watch && !banner) out.push(el("div", { class: "mon-actions" }, monRunBtn(it.mon)));
  return out;
}
// 감시 소식 opens with every plain monitor at a glance: how far its wait has come, how it last ended, and the last line it said. Down and failed
// rows come first, so what needs the owner is at the top; a tap opens that monitor.
function monOverview(it) {
  if (it.key !== "notice") return null;
  const mons = ntMons(), ownedNames = new Set([...monOwnedBy(INTG.items, mons).values()].flat());
  const now = Date.now(), list = mons.filter(m => !ownedNames.has(m));
  const rank = m => m.connection === "disconnected" ? 0 : m.last_result === "fail" ? 1 : m.paused ? 4 : (Date.parse(m.next_run) || Infinity) < now ? 2 : m.last_result ? 3 : 2;
  const sorted = list.slice().sort((a, b) => rank(a) - rank(b) || (Date.parse(a.next_run) || Infinity) - (Date.parse(b.next_run) || Infinity));
  return el("div", { class: "mon-ov" }, el("div", { class: "mon-ov-h", text: "모니터링 상태" }),
    ...(sorted.length ? sorted.map(m => el("button", { class: "mon-ov-row", type: "button", "data-ov": `m:${m.name}`, onclick: () => go("monitoring", `m:${m.name}`) },
      el("span", { class: "mon-ov-n", text: monTitle(m) }), monProgNode(m, { compact: true }), el("span", { class: "mon-ov-s", text: m.connection === "disconnected" ? monConnLine(m) : m.last_summary || monRunLine(m) }))) : [el("div", { class: "mon-ov-empty", text: "아직 일반 모니터링이 없어요" })]));
}
function monTimeline(it) {
  if (it.off) return [el("div", { class: "empty", text: "연결 안 됨" })];
  const names = it.mon ? monNames(it.mon) : [];
  const bar = monBarWanted(it) ? [monBar(it)] : [], nodes = !monFeed(it) ? monChronoNodes(it, names) : it.notices.length > MON_COMPACT ? monFeedNodes(it, names) : monFeedCards(it, names);
  const ov = monOverview(it), head = [...monTopNodes(it), ...bar, ...(ov ? [ov, el("div", { class: "mon-sh", text: "최근 감시 소식" })] : [])];
  if (nodes.length) return [...head, ...nodes];
  if (head.length) return [...head, el("div", { class: "empty", text: "이 보기에 해당하는 소식이 없어요" })];
  const next = it.mon && it.mon.next_run ? ` · 다음 확인 ${monTime(it.mon.next_run)}` : "";
  return [el("div", { class: "empty", text: !NT.loaded && !NM.loaded ? "불러오는 중…" : it.mon ? `${monRunLine(it.mon)}${next}` : "아직 소식이 없어요" })];
}
// The settings conversation an item has: a local app's, a watch's (local or a peer's, forwarded by pqAct); none for a peer's app, a schedule or an unreachable computer.
// The title of a settings conversation: the monitor's or the app's own name (a peer's monitor too), not "설정".
function monSettingsName(t) {
  const a = settingsApp(t);
  if (!a.startsWith("w:")) { const pe = PQ.of.get(t), it = pe && pe.app ? { label: pe.label } : INTG.items.find(x => x.key === a); return it ? it.label : "설정"; }
  const pe = PQ.of.get(t), m = pe ? pe.mon : NM.items.find(x => x.watch === a.slice(2));
  return m ? monTitle(m) : "설정";
}
// The status block of a settings panel: the monitor itself, or each watch the app owns. Same facts as the status card of the monitor's detail (monRunNode).
const monStatMons = app => (app.startsWith("w:") ? [asMon(app)] : (monItems().find(i => i.app && monSettingsApp(i) === app) || {}).owned || []).filter(Boolean);
function monStatNode(m) {
  const res = m.last_result ? NT_RESULT[m.last_result] : null;
  const facts = [m.fails ? `연속 실패 ${m.fails}번` : "", m.last_ok ? `마지막 정상 ${monTime(m.last_ok)}` : "", m.last_output ? `마지막 결과: ${m.last_output}` : ""].filter(Boolean);
  return el("div", { class: "as-row as-stat", "data-watch": m.watch || m.name },
    el("span", { class: "as-b" }, el("span", { class: "as-n", text: monTitle(m) }), el("span", { class: "as-h", text: [res && res[0], ntMonRun(m), ntMonNext(m)].filter(Boolean).join(" · ") }), ...facts.map(t => el("span", { class: "as-h", text: t }))),
    m.last_result === "fail" ? el("span", { class: "tag err", text: "실패" }) : null);
}
// A peer's app is `<its key>~<computer hash>`: the same key may exist on this computer too (34-peer-monitoring.js pqApp).
const monSettingsApp = it => !it || it.off ? "" : it.app && !it.pc ? it.key.slice(2) : it.app && it.pc ? pqApp(it.inst, it.pc) : it.mon && it.mon.kind === "watch" && it.mon.watch ? `w:${it.mon.watch}` : "";
// A connection that is down says so at the top of the conversation, whether or not an alert went out, with the way to check again.
function monBannerNode(text, btn) {
  const t = String(text || "").trim(), head = t.startsWith("연결 끊김") ? "연결 끊김" : "연결이 끊겼어요";
  return el("div", { class: "mon-banner", role: "alert" }, icon("refresh"), el("span", { class: "mon-banner-tx" }, el("b", { text: head }), t.startsWith("연결 끊김") && t.length > head.length ? t.slice(head.length) : t && !t.startsWith("연결 끊김") ? ` · ${t}` : ""), btn);
}
const monRunBtn = (m, text) => el("button", { class: "as-tpl mon-run", type: "button", "data-run": m.watch, text: text || "지금 확인", onclick: ev => monRunNow(ev.currentTarget, m) });
// One re-check control per conversation: a down or failing monitor, and a down app, get the banner and its button; a healthy one gets 지금 확인
// in the head (a phone at the top of the timeline). The latest-run card never repeats it.
function monBannerOf(it) {
  if (it.mon && (it.mon.connection === "disconnected" || it.mon.last_result === "fail")) return monBannerNode(it.mon.connection === "disconnected" ? monConnLine(it.mon) : "마지막 확인이 실패했어요", it.mon.watch ? el("button", { class: "as-tpl mon-recheck", type: "button", "data-recheck": it.mon.watch, text: "지금 다시 확인", onclick: ev => monRunNow(ev.currentTarget, it.mon) }) : null);
  if (!it.conn) return null;
  const names = (it.owned || []).map(m => m.watch).filter(Boolean);
  return monBannerNode(it.hint || "연결이 끊겼어요", names.length ? el("button", { class: "as-tpl mon-recheck", type: "button", "data-recheck": it.key, text: "지금 다시 확인", onclick: ev => monRecheckApp(ev.currentTarget, it, names) }) : null);
}
// The title bar of an open item; the kakao pane puts the gear in its room head once a room is open.
// A monitor adds its own progress block and 지금 확인 under the name, so the conversation always says how far the wait has come.
const monHead = it => {
  const banner = monBannerOf(it), st = monState(it);
  const row = [monIcon(it.ic), el("span", { class: "cv-b" }, el("span", { class: "cv-n" }, it.name, pqLabel(it)), st ? el("span", { class: "cv-p", text: st }) : null), it.mon && it.mon.watch && !banner ? monRunBtn(it.mon) : null, it.unreplied ? unrepPill(`미답장 ${it.unreplied}`) : null, ...(kkItem(it) && KK.open ? [] : asEntry(monSettingsApp(it)))].filter(Boolean);
  const extra = [];
  if (it.mon) extra.push(monProgNode(it.mon, { compact: true, tag: !banner }));
  if (banner) extra.push(banner);
  return extra.length ? [el("div", { class: "mon-hdwrap" }, el("div", { class: "mon-hdrow" }, ...row), ...extra)] : row;
};
// The settings app of the detail open now (an item, or a conversation sitting under one), for the phone's app bar.
function monDetailApp() {
  if (current === "monitoring") return monConv() ? monSettingsApp(monSel(monItems())) : "";
  if (!(current === "chat" && monCtx && convOnPhone()) || isSettingsT(target)) return "";
  const k = monItemOf(target);
  return k ? monSettingsApp(monItems().find(i => i.key === k)) : "";
}

// The owner is looking at an open item: the plain reports on screen (a row, a card, a folded run) count as read after a moment; one folded away or
// below the fold is read when it comes into view, or by 읽음 처리. What waits on the owner keeps its unread (ntNeeds), like everywhere.
function monSeen() {
  clearTimeout(MON.seenT);
  MON.seenT = setTimeout(() => {
    if (current !== "monitoring" || MON.list && narrowChat() || document.visibilityState !== "visible") return;
    const it = monSel(monItems()), box = $("#mon-timeline");
    if (!it || it.pc || !box.clientHeight) return;
    const a = box.getBoundingClientRect(), seen = new Set();
    for (const m of box.querySelectorAll("[data-nid], [data-nids]")) {
      const r = m.getBoundingClientRect();
      if (r.bottom > a.top && r.top < a.bottom) for (const id of String(m.dataset.nids || m.dataset.nid || "").split(",")) if (id) seen.add(id);
    }
    const fresh = it.notices.filter(n => n.id && !n.read && !ntNeeds(n) && seen.has(String(n.id)) && ntById(n.id));
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
  if (current !== "monitoring") { if (monCtx && current === "chat") convSchedule(); return; }
  const items = monItems(), sel = monSel(items), side = $("#mon-side"), box = $("#mon-timeline"), tl = $("#mon-tl");
  const rows = monRows(items, sel), sideSig = JSON.stringify([rows.map(r => [r.k, r.name, r.hint, r.unread, r.unreplied, r.badge, r.header, r.sel, r.chips, r.msig])]);
  if (sideSig !== MON.side) {
    MON.side = sideSig;
    const top = side.scrollTop;
    clear(side).append(...rows.map(convRow));
    monDecorateRows(side, items);
    side.scrollTop = top;
  }
  monTickStart();
  const kakao = kkItem(sel);
  const cm = !kakao && sel ? cmAppOf(sel.key) : "";
  kkMode(kakao, kakao && !(narrowChat() && MON.list), kakao ? sel.pc : null);
  cmMode(cm, !!cm && !(narrowChat() && MON.list));
  if (!sel) { MON.sig = ""; MON.shown = ""; convTitle(); return; }
  if (kakao || cm) {   // 30-kakao.js / 30-monitoring-comments.js draw this item's pane (rooms and chat); only the head is the usual one
    const head = JSON.stringify([sel.name, monState(sel), sel.unreplied | 0, !!AS.by[monSettingsApp(sel)], !!KK.open]);
    if (head !== MON.kkHead) { MON.kkHead = head; clear($("#mon-head")).append(...monHead(sel)); }
    MON.sig = ""; MON.shown = sel.key;
    convTitle();
    return;
  }
  MON.kkHead = "";
  const sig = JSON.stringify([sel.key, sel.name, monState(sel), sel.unreplied | 0, sel.conn | 0, sel.mon && !!sel.mon.watch && MON.running.has(sel.mon.watch), sel.notices.map(n => [n.id, n.updated, n.read, n.text, n.decision, n.tone, n.item, n.item && n.item.key ? MAILS.get(`mail:${n.item.key}`) : null]), sel.mails.map(t => [t, (CONV.get(t) || {}).ts, ts(t).unread, MAILS.get(t), MAILS.has(t) ? mailBrief(MAILS.get(t), t) : ""]), sel.mon, NM.loaded, NT.loaded, MON.mailFilter || "all", pqSig(sel)]);
  if (sig !== MON.sig) {
    MON.sig = sig;
    const again = MON.shown === sel.key, keep = box.scrollTop, was = box.scrollHeight, stick = !again || box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    MON.shown = sel.key;
    clear($("#mon-head")).append(...monHead(sel));
    clear(tl).append(...monTimeline(sel));
    // Older reports added above (이전 소식 보기) keep what was on screen where it is.
    if (MON.grew) { MON.grew = false; box.scrollTop = keep + (box.scrollHeight - was); }
    else box.scrollTop = monFeed(sel) ? (again ? keep : 0) : stick ? box.scrollHeight : keep;
    edgeFade(box);
  }
  MON.olderBusy = false;
  monObserveOlder();
  convTitle();
  monSeen();
}
// A monitor row in the list carries the same bar under its status line; the row itself is the shared convRow, so the block is appended here.
function monDecorateRows(side, items) {
  for (const row of side.querySelectorAll(".cv-row[data-k]")) {
    const it = items.find(i => i.key === row.dataset.k);
    const b = it && it.mon && row.querySelector(".cv-b");
    if (!b) continue;
    const old = b.querySelector(".mon-prog-wrap");
    if (old) old.remove();
    b.append(monProgNode(it.mon, { compact: true, tag: false, short: true }));
  }
}
function monTick() {
  const now = Date.now();
  for (const bar of document.querySelectorAll(".mon-prog[data-from]")) {
    const from = Number(bar.dataset.from), to = Number(bar.dataset.to), fill = bar.firstElementChild;
    if (!(to > 0) || !fill) continue;
    const late = now >= to, pct = late ? 100 : Math.max(0, Math.min(100, ((now - from) / (to - from)) * 100));
    fill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(pct)));
    bar.setAttribute("aria-valuetext", monProgLine(from, to, now));
    bar.classList.toggle("warn", late);
    const wrap = bar.parentElement && bar.parentElement.parentElement;
    if (!wrap) continue;
    const tx = wrap.querySelector(".mon-prog-tx");
    if (tx) tx.textContent = monProgLine(from, to, now, null, bar.dataset.short === "1");
    const tag = wrap.querySelector(".mon-ptag");
    if (tag && !tag.dataset.fixed) {
      const [text, tone] = monPTagOf(late ? "late" : "ok");
      if (tag.textContent !== text) tag.textContent = text;
      tag.className = `mon-ptag${tone ? ` ${tone}` : ""}`;
    }
  }
}
let monTickRaf = 0;
function monTickLoop() { monTickRaf = 0; if (document.hidden || current !== "monitoring") return; monTick(); monTickRaf = requestAnimationFrame(monTickLoop); }
function monTickStart() { if (!monTickRaf && current === "monitoring" && !document.hidden) monTickRaf = requestAnimationFrame(monTickLoop); }
document.addEventListener("visibilitychange", () => { if (document.hidden) { if (monTickRaf) cancelAnimationFrame(monTickRaf); monTickRaf = 0; } else monTickStart(); });
let monOlderObs = null;
// The owner reached the top of an older page: the previous reports load themselves, one page per paint, and the anchored scroll keeps the reader
// where they were (the same keep + growth rule the button uses).
function monOlderLoad(sentinel) {
  if (!MON.autoArmed || MON.olderBusy) return;
  const key = sentinel && sentinel.dataset ? sentinel.dataset.older : "", left = Number(sentinel && sentinel.dataset ? sentinel.dataset.left : 0);
  if (!key || !(left > 0)) return;
  MON.olderBusy = true;
  MON.more.set(key, (MON.more.get(key) || MON_PAGE) + MON_PAGE);
  MON.grew = true;
  MON.sig = "";
  monSchedule();
}
function monObserveOlder() {
  const box = $("#mon-timeline");
  if (!box) return;
  if (!monOlderObs && typeof IntersectionObserver === "function") monOlderObs = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) monOlderLoad(e.target); }, { root: box, rootMargin: "48px 0px 0px 0px" });
  if (!monOlderObs) return;
  monOlderObs.disconnect();
  for (const s of box.querySelectorAll(".mon-sentinel[data-older]")) monOlderObs.observe(s);
}
$("#mon-timeline").addEventListener("scroll", () => {
  const box = $("#mon-timeline");
  MON.autoArmed = true;
  edgeFade(box);
  monSeen();
  if (box.scrollTop <= 0) monOlderLoad(box.querySelector(".mon-sentinel[data-older]"));
}, { passive: true });
setInterval(() => { if ((current === "monitoring" || monCtx) && !document.hidden) loadMonitors(); }, 60_000);
loadMonitors();
