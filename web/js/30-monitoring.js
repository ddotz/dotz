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
const MON_PTAG = { ok: ["정상", "ok"], changed: ["바뀜", "warn"], fail: ["실패", "err"], disconnected: ["연결 끊김", "err"], need: ["확인 필요", "warn"], off: ["꺼짐", ""], late: ["늦어짐", "warn"], run: ["확인 중", "pri"] };
// A monitor's one status, read the same on every screen (the list row's badge, the detail's state line and tag, the home card, the app settings):
// connection > paused > fail > late > changed > ok > not run yet. key is a MON_PTAG key; text and tone are its words and colour.
function monStatus(m, now = Date.now()) {
  const key = m.connection === "disconnected" ? "disconnected" : m.paused ? "off" : m.last_result === "fail" ? "fail" : (Date.parse(m.next_run) || Infinity) <= now ? "late" : m.last_result === "changed" ? "changed" : m.last_run ? "ok" : "need";
  const [text, tone] = MON_PTAG[key];
  return { key, text, tone };
}
// Wording (one pair): a row, a tag or a badge says "연결 끊김"; the banner at the top of the conversation says "연결이 끊겼어요" plus why.
const monConnWhy = m => [m.since ? `${monTime(m.since)}부터` : "", m.conn_reason === "login" ? "다시 로그인 필요" : m.conn_reason ? "확인이 계속 실패해요" : ""].filter(Boolean).join(" · ");
const monConnLine = m => ["연결 끊김", monConnWhy(m)].filter(Boolean).join(" · ");
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
  const tag = monStatus(m, now).key;
  if (tag === "disconnected") return { kind: "err", pct: 100, tag };
  if (tag === "off") return { kind: "off", pct: 100, tag };
  const from = Date.parse(m.last_run), to = Date.parse(m.next_run);
  if (!(to > 0)) return { kind: "none", pct: 0, tag };
  if (now >= to) return { kind: "warn", pct: 100, tag };
  const pct = from > 0 ? Math.max(0, Math.min(100, ((now - from) / (to - from)) * 100)) : 0;
  return { kind: "", pct, tag };
}
const monPTagOf = k => MON_PTAG[k] || ["", ""];
// The bar's colour is the result (owner 2026-10-27): green normal, yellow needs a look (changed, late, not run yet), red error or disconnected.
const MON_BAR_TONE = { ok: "ok", changed: "warn", late: "warn", need: "warn", fail: "err", disconnected: "err" };
// One progress block: a thin bar with its result tag on the same line and the two times in words under it. The bar carries data-from/data-to
// so the ticker can move it, and the tag is re-read on the way past next_run (늦어짐) without a repaint.
function monProgNode(m, opts = {}) {
  const now = Date.now(), st = monProgState(m, now), from = Date.parse(m.last_run), to = Date.parse(m.next_run), live = st.kind === "" || st.kind === "warn", line = monProgLine(from, to, now, m, opts.short);
  const [text, tone] = monPTagOf(st.tag);
  const width = st.kind === "run" ? 35 : st.pct;
  const barTone = st.kind === "" || st.kind === "none" ? MON_BAR_TONE[st.tag] || "" : st.kind === "warn" && st.tag === "fail" ? "err" : "";
  const bar = el("span", { class: `mon-prog${st.kind ? ` ${st.kind}` : ""}${barTone ? ` ${barTone}` : ""}`, "data-tone": barTone || null, role: "progressbar", "aria-label": `${monTitle(m)} 진행`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(st.pct)), "aria-valuetext": line }, el("i", { style: `width:${width}%` }));
  if (live && from > 0 && to > 0) { bar.dataset.from = String(from); bar.dataset.to = String(to); bar.dataset.short = opts.short ? "1" : ""; }
  // data-tag keeps the result the node was built with: the ticker only flips a live tag between it and 늦어짐, never to another result.
  const tag = text && opts.tag !== false ? el("span", { class: `mon-ptag${tone ? ` ${tone}` : ""}`, "data-tag": st.tag, "data-fixed": st.tag === "fail" || st.tag === "disconnected" || st.tag === "off" || st.tag === "run" ? "1" : null, text }) : null;
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
// An app's row says what waits on the owner, never the latest item's title. `needs` = {drafts, unread, sentToday, unreplied} from GET /api/integrations (hub/integrations.ts):
// at most two parts, the most important first (drafts, 미답장, 안 읽음, sent today); the badge is the count that waits on him (drafts first, else unread).
// "확인할 것 없어요" only for a connected app with every count 0; `down` (the app is disconnected) says 연결 끊김 instead.
function monNeedLine(n, down) {
  const parts = [];
  if (n.drafts) parts.push(`답장 확인 ${n.drafts}건`);
  if (n.unreplied) parts.push(`미답장 ${n.unreplied}건`);
  if (n.unread) parts.push(`안 읽음 ${n.unread}`);
  if (n.sentToday) parts.push(`오늘 자동 답장 ${n.sentToday}건 보냄`);
  return parts.slice(0, 2).join(" · ") || (down ? "연결 끊김" : "확인할 것 없어요");
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
    const notices = (it.notices || []).map(ntById).filter(n => n && monMine(n, it)), mails = [...CONV.keys()].filter(t => !PQ.of.has(t) && intgHas(it, t) && (!isMailT(t) || MAILS.has(t)));   // a mail conversation without its mail (deleted) is no mail row
    for (const n of notices) shown.add(n.id);
    const cands = [...notices.map(n => ({ at: monNoticeAt(n), text: monLine(n) })), ...mails.filter(t => CONV.get(t)).map(t => ({ at: CONV.get(t).ts, text: (MAILS.get(t) || {}).subject || CONV.get(t).text }))].sort((a, b) => b.at.localeCompare(a.at));
    const needs = it.needs || { drafts: 0, unread: monUnread(notices.filter(n => !mails.includes(n.open) && !mails.includes(n.src))) + mails.filter(t => (ts(t).unread | 0) > 0).length, sentToday: 0 }, conn = it.state === "disconnected", own = owned.get(it.key) || [], bad = own.some(m => m.last_result === "fail");
    items.push({ key: `i:${it.key}`, group: MON_GROUP[it.kind || "app"] || MON_GROUP.app, name: it.label, ic: it.icon, notices, mails, app: true, conn, inst: it.key, drafts: needs.drafts | 0, unread: needs.drafts || needs.unread, unreplied: needs.unreplied | 0, hint: conn && it.hint ? it.hint : bad ? "확인이 실패했어요" : monNeedLine(needs, conn), at: cands[0] ? cands[0].at : "", owned: own, msig: conn ? "conn" : bad ? "fail" : "",
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
      badge: (st => [st.text, st.tone])(monStatus(m)) });
  }
  // A report the hub marked as an app's (n.app, hub/notices.ts) is never here, even before the app list below has loaded.
  const feed = NT.items.filter(n => n.kind === "watch" && !n.app && !shown.has(n.id)), need = feed.filter(monNeed).length;
  // The feed's row: what waits on the owner as its chip (counted apart from the plain reports, like an app row), the head line under the name (monFeedHead).
  items.unshift({ key: "notice", group: "", name: MON_FEED, ic: "list", notices: feed, mails: [], unread: monUnread(feed), need, chips: monNeedChips(need), ...monFeedHead(feed) });
  // 답장 확인 (30-replies.js): every waiting reply draft of every app and computer, right under 감시 소식.
  const rq = rqMonItem();
  if (rq) items.splice(1, 0, rq);
  return pqMerge(items);
}
// The 감시 소식 row's line never passes an old report off as the current state: the newest UNREAD report (another computer's with its name),
// else only when the last one came ("마지막 소식 10월 26일"). A report of a watch that no longer exists (on the computer that wrote it) is skipped.
const monGone = n => {
  if (!n.watch) return false;
  const mons = n.pc ? ((((PQ.list.find(p => p && p.url === n.pc.url) || {}).items) || {}).monitors || null) : NM.loaded ? NM.items : null;
  return !!mons && !mons.some(m => m.watch === n.watch);
};
const monFeedDay = t => kstDay(t) === kstDay(Date.now()) ? `오늘 ${kstHM(t)}` : new Date(t).toLocaleDateString("ko-KR", { ...KST, month: "long", day: "numeric" });
function monFeedHead(list) {
  const live = list.filter(n => !monGone(n)), fresh = monNewest(live.filter(n => !n.read)), last = monNewest(live);
  if (fresh) return { hint: `${fresh.pc ? `${fresh.pc.name} · ` : ""}${monLine(fresh)}`, at: monNoticeAt(fresh) };
  return last ? { hint: `마지막 소식 ${monFeedDay(ntAt(last))}`, at: monNoticeAt(last) } : { hint: "새 감시 소식이 없어요", at: "" };
}
// 답 필요: waits on the owner and is answered from here (an open decision, an [ask] report), never read by looking; 실패: a report that could not check.
// A peer's open decision is answered here too (ntPost through the peer); a peer's loose [ask] waits in that computer's conversation.
const monNeed = n => ntNeeds(n) && (!n.pc || ntIsDec(n));
const monFailed = n => n.tone === "fail";
const monNeedChips = need => (need ? [[`답 필요 ${need}`, "warn"]] : undefined);
// The open item: the one picked, else on a wide screen the first (a phone shows its list until one is picked).
const monSel = items => items.find(i => i.key === MON.sel) || (narrowChat() ? null : items[0] || null);
const monName = () => { const it = monItems().find(i => i.key === MON.sel); return kkItem(it) && KK.open && KK.room ? KK.room.name : it ? it.name : titles.monitoring; };
function monState(it) {
  if (it.off) return "연결 안 됨";
  // The progress block under the name already carries the two runs in words, so the state line says only where it stands.
  if (it.mon) { const st = monStatus(it.mon); return st.key === "disconnected" ? "" : st.text; }
  if (it.rq) return it.hint;
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
const DR_STATE = { open: ["승인 대기", "warn"], send: ["보냄", "ok"], edit: ["고침", "pri"], revising: ["고치는 중…", "pri"], drop: ["보내지 않음", ""], own: ["보낼 방법 전함", "pri"], expired: ["만료", ""], ignored: ["무시함", ""] };
function drState(d) {
  if (d.state === "open" || d.state === "ignored") return d.state;
  if (d.draft && ntRevising({ kind: "decision", decision: d })) return "revising";   // 고치기 answered, the new draft has not landed
  const m = /^\s*(\d+)\)/.exec(String(d.answer || "")), o = m && d.options.find(x => x.n === Number(m[1]));
  return d.resolved || !o ? "expired" : { 보내기: "send", 고치기: "edit", "보내지 않기": "drop", "답글만 보내기": "send", "메일만 보내기": "send", [DRAFT_OWN]: "own" }[o.label] || "expired";
}
const drParas = body => String(body ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().split(/\n\n/);
function drOriginal(t) {
  const m = MAILS.get(t);
  if (!m) return null;
  const brief = mailBrief(m, t);
  return el("div", { class: "dr-orig" }, el("div", { class: "dr-ok", text: "답장할 메일" }), el("div", { class: "dr-os" }, el("b", { text: mailSender(m.from) }), m.subject ? ` · ${m.subject}` : ""), brief ? el("div", { class: "dr-ob", text: brief }) : null);
}
// The app instance that holds a conversation target, for the card's head (a peer's row first: PQ.of).
const monInstLabel = t => { const pe = PQ.of.get(t); if (pe) return pe.label || ""; const it = INTG.items.find(x => intgHas(x, t)); return it ? it.label : ""; };
// The send approval as the one reply card (web/js/10-reply-card.js): same head (앱 · 계정 · 컴퓨터 · 모델), same 첨부 줄, clamped body, and the same
// three actions as the 답장 확인 queue, the KakaoTalk room and a comment thread. The answer path is the notice's (answerInline / ntPost), so this
// card and the chat card stay in step.
// o.bare: only the mail it sends (a handled draft unfolded inside its mail's conversation, 30-mail-sent.js).
function draftCardNode(n, o = {}) {
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
  // The 받는이·참조 rows of a mail draft are its own (10-decision-card.js draftToNode): 답장 | 전체 답장, the chips, editable while it waits.
  const recv = dr.toLabel === "받는이" || !dr.toLabel ? draftToNode(dr, { t: d.to, edit: open }) : el("div", { class: "dr-to" }, el("span", { class: "dr-k", text: dr.toLabel || "받는이" }), el("span", { class: "dr-chip", text: dr.to || "-" }));
  if (o.bare) return el("div", { class: "dr-mail" }, recv,
    dr.subject ? el("div", { class: "dr-sub", text: dr.subject }) : null,
    draftOriginNode(dr),
    man ? ta : el("div", { class: "dr-body" }, ...drParas(dr.body).map(t => el("p", { text: t }))),
    draftFilesNode(dr, { t: d.to, edit: open }), draftMailNode(dr.mail));
  const head = { app: mail ? "mail" : d.to, label: mail ? monInstLabel(d.to) : pcTargetName(d.to, n.pc), pc: mail && pqPc(d.to) ? pqPc(d.to).name : pqSelf(), model: dr.model || "", at: d.answered_at || n.updated || n.ts,
    tail: [dr.rule ? draftRuleTag(dr.rule, "dr-rule") : null, el("span", { class: `tag dr-st${stTone ? ` ${stTone}` : ""}`, "data-state": st, text: `${stText} · ${when}` }),
      // 지우기 on a waiting draft is 보내지 않기: the same answer path, so the owning computer drops it once and nothing is sent
      open && !editing && oDrop ? el("button", { class: "ib dr-rm", type: "button", title: "지우기 (보내지 않아요)", "aria-label": "초안 지우기", disabled: busy, onclick: () => { if (!busy) answerInline(n, oDrop); } }, icon("close")) : null] };
  if (editing) {
    go2 = el("button", { class: "btn", type: "button", disabled: busy || !ta.value.trim(), text: man ? "이 내용으로 고치기" : "고쳐 달라고 하기", onclick: async () => {
      const text = ta.value.trim();
      if (!text || !oEdit) return;
      dcSending.add(n.id); syncInlineChoices(); redraw();
      try { await ntPost(n, oEdit.n, man ? MANUAL_LEAD + text : text); leave(); } catch (e) { toast(e.message, true); }
      dcSending.delete(n.id); syncInlineChoices();
    } });
  }
  const acts = editing ? null : open ? {
    send: () => { if (!oSend || busy) return; if (dr.warning || (dr.attachments || []).length) drfSure(dr, d.to).then(ok => ok && answerInline(n, oSend)); else answerInline(n, oSend); },
    edit: oEdit ? () => { DR.edit.add(n.id); redraw(); } : null,
    drop: oDrop ? () => { if (!busy) answerInline(n, oDrop); } : null,
    busy,
  } : null;
  // 직접 수정 (man) types the mail itself: the field stands where the body was, with only the two buttons below it.
  const revise = editing ? el("div", { class: "rq-edit" }, man ? null : el("div", { class: "dr-q2", text: "어떻게 고칠까요?" }), man ? null : ta,
    el("div", { class: "dr-act dr-row" }, go2, el("button", { class: "btn text", type: "button", disabled: busy, text: "취소", onclick: () => { leave(); redraw(); } }),
      man ? null : el("button", { class: "btn text dr-manual", type: "button", disabled: busy, onclick: () => { DR.manual.add(n.id); delete DR.note[n.id]; redraw(); } }, icon("pencil"), el("span", { text: "직접 수정" })))) : null;
  const card = rqCard({ key: `dr:${n.id}`, cls: `bm alert rc dr ${st}`, attrs: { "data-nid": n.id }, head,
    label: q || null, labelCls: "rc-title dr-q",
    recv, subject: dr.subject,
    body: { text: dr.body, node: man ? ta : el("div", { class: "dr-body" }, ...drParas(dr.body).map(t => el("p", { text: t }))), cls: "dr-body" },
    // A mail draft always shows its 첨부 줄 (files, or 첨부: 없음) right before 보내기; the files are editable while the draft waits.
    attach: draftFilesNode(dr, { t: d.to, edit: open }),
    extra: [mail ? drOriginal(d.to) : null, draftOriginNode(dr), draftMailNode(dr.mail)],
    ...(revise ? { revise } : acts ? { acts } : {}) });
  return card;
}
// A decision: the question and the same choice rows a chat message has; an open one is answered here, an answered one shows what was chosen.
function monDecisionNode(n) {
  const d = n.decision, open = d.state === "open", said = d.state === "answered" ? String(d.answer || "") : "";
  if (d.draft) return ntRevising(n) && ntSuccessor(n) ? null : draftCardNode(n);   // the rewritten draft replaces the one that was sent back
  // The buttons show the options: the body keeps the lead text and the 결정: line, not the option lines (10-decision-card.js stripChoices).
  const fl = fileLines(d.options.length ? stripChoices(n.text) : n.text);
  const rows = ntOptsOrdered(d.options).map(o => el("button", { class: `dcm-row${o.rec ? " rec" : ""}${said.startsWith(`${o.n})`) ? " on" : ""}`, type: "button", disabled: !open || dcSending.has(n.id), "data-n": o.n,
    onclick: () => (d.draft || o.action === "form" ? noticeSheetOpen(n.pc ? n : n.id) : answerInline(n, o)) },
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
  if (ntIsDec(n)) return monDecisionNode(n);   // a peer's question too: the same card, its answer sent to that computer (ntPost)
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
// The row's summary as parts: up to two points of 요약 when the summary is a bulleted list (else the first lines as one text), and the
// first thing to do from 할 일 unless it says 없음. 첨부 is the paperclip count, never repeated here.
const MAIL_BULLET = /^\s*(?:[-*•·]|\d+[.)])\s+/;
function mailParts(text, skip) {
  const secs = rcSections(String(text ?? "")), sum = secs.find(s => s.h === "요약") || secs.find(s => !s.h), todo = secs.find(s => s.h === "할 일" || s.h === "할일" || s.h === "다음 할 일");
  const bullets = sum ? sum.body.split("\n").filter(l => MAIL_BULLET.test(l)) : [];
  const points = bullets.length ? mailLines(bullets.join("\n"), skip).slice(0, 2) : [];
  const first = todo ? mailLines(todo.body, skip)[0] || "" : "";
  return { points, todo: /^없음/.test(first) ? "" : first, more: todo ? Math.max(0, mailLines(todo.body, skip).length - 1) : 0 };
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
// A mail's files without the pictures its body shows (hub/mail.ts inline: drawn in the original, not files); each keeps its own index.
const mailRealFiles = files => (files || []).map((f, i) => ({ f, i })).filter(x => !x.f.inline);
function mailFilesNode(key, files) {
  const real = mailRealFiles(files);
  if (!real.length) return null;
  return el("div", { class: "mr-files" }, el("div", { class: "mr-fh", text: `첨부파일 ${real.length}개` }), ...real.map(({ f, i }) =>
    el("a", { class: "mr-file", href: mailFileUrl(key, i, true), download: f.name, title: `${f.name} 내려받기`, "aria-label": `${f.name} 내려받기${f.size ? ` (${mailSize(f.size)})` : ""}` },
      icon("file"), el("span", { class: "mr-fname", text: f.name }), f.size ? el("span", { class: "mr-fsize", text: mailSize(f.size) }) : null, icon("download"))));
}
// The reply state of a mail's row. `m.suggest` is written by the reply-draft lane (hub/mail.ts setMailSuggest; stays absent while the install's
// reply-draft option is off or nothing was offered): { kind: "reply-draft", label, ref, state? }, `ref` = the draft id and `state` =
// "draft" (default: a draft waits for approval) | "sent" (the reply went out by itself) | "waiting" (a reply is expected, no draft yet).
// Without suggest nothing is drawn.
const MAIL_REPLY = { draft: ["답장 초안 있음", "warn"], sent: ["자동 답장 보냄", "ok"], waiting: ["답장 대기", ""] };
const mailReplyChip = sg => {
  if (!sg || typeof sg !== "object" || (sg.kind && sg.kind !== "reply-draft")) return null;
  const [text, tone] = MAIL_REPLY[sg.state || "draft"] || [];
  return text ? el("span", { class: `tag mr-reply${tone ? ` ${tone}` : ""}`, "data-slot": "suggest", text }) : null;
};
// The reply-state tag of a mail (hub/mail-state.ts mailLabel): an incoming mail's reply state (m.reply: needs | draft | replied | skipped | fyi),
// else none. Read / unread is never a state (a row has its own 안 읽음 N pill), and skipped / fyi are the same mark to the owner: 답장 안 함.
// An outgoing mail is 내가 보냄 in the thread list of a mail (30-mail-thread.js), where both directions sit together; a list row has no tag for it.
const MAIL_STATE = { needs: ["답장 필요", "warn"], draft: ["초안 있음", "warn"], replied: ["답장함", "ok"], skipped: ["답장 안 함", ""], fyi: ["답장 안 함", ""] };
const mailStateOf = m => m.dir === "out" ? ["내가 보냄", ""] : MAIL_STATE[m.reply] || ["", ""];
// An app whose conversation is a list of mails (메일 and its instances): newest on top, opened at the top.
const monMailList = it => !!(it && it.app && !it.mon && it.mails.some(t => MAILS.has(t)));
// The filter of the mail list: 전체 / 안 읽음 / 답장 필요 / 확인 대기 / 답장함 / 보낸 메일. A filter gets the mail and its conversation target.
// 확인 대기 holds no mail rows: it is the reply drafts waiting on the owner (owner 2026-10-27), and those approval cards show only there.
// 전체 is the received mail; what was sent is only under 보낸 메일 (owner 2026-10-28).
const MAIL_FILTERS = [["all", "전체", m => m.dir !== "out"], ["unread", "안 읽음", (m, t) => m.dir !== "out" && (ts(t).unread | 0) > 0], ["owed", "답장 필요", m => m.dir !== "out" && (m.reply === "needs" || m.reply === "draft")], ["pending", "확인 대기", () => false], ["replied", "답장함", m => m.dir !== "out" && m.reply === "replied"], ["sent", "보낸 메일", m => m.dir === "out"]];
const mailFilterOf = () => MAIL_FILTERS.find(f => f[0] === MON.mailFilter) || MAIL_FILTERS[0];
// A reply draft still in the owner's hands: waiting for 보내기 / 고치기 / 보내지 않기, or being rewritten after 고치기 (a peer's too, as its plain report).
const mailDraftOpen = n => !!(n.decision && n.decision.draft) && drState(n.decision) === "open";
const mailDraftHeld = n => !!(n.decision && n.decision.draft) && ["open", "revising"].includes(drState(n.decision));
// The newest reply draft of each mail (and of each computer): a draft a newer one replaced for the same mail is stale and asks nothing.
// A draft of anything that is not a mail (an id-keyed decision) is its own.
const mailDraftKey = n => `${n.pc ? n.pc.url : ""}|${String(n.decision.to || "").startsWith("mail:") ? n.decision.to : `#${n.id}`}`;
function mailDraftLive(notices) {
  const newest = new Map();
  for (const n of notices) {
    if (!n.decision || !n.decision.draft) continue;
    const k = mailDraftKey(n), cur = newest.get(k);
    if (!cur || ntAt(n) > ntAt(cur) || (ntAt(n) === ntAt(cur) && String(n.ts) > String(cur.ts))) newest.set(k, n);
  }
  return newest;
}
// 보내지 않기 was answered: the card leaves every view, like a stale one. A sent or otherwise handled mail draft leaves the list too and is
// folded inside its mail's conversation (30-mail-sent.js).
const mailDraftDone = n => !!(n.decision && n.decision.draft) && String(n.decision.to || "").startsWith("mail:") && !mailDraftHeld(n);
const mailDraftGone = (n, newest) => !!(n.decision && n.decision.draft) && String(n.decision.to || "").startsWith("mail:") && (drState(n.decision) === "drop" || newest.get(mailDraftKey(n)) !== n);
// Opening a mail app while reply drafts wait lands on 확인 대기 (once per opening, so a filter the owner picks stays); with none waiting a
// left-over 확인 대기 goes back to 전체. It waits for the notices, so a draft that loads late still decides the landing.
function mailLand(sel) {
  if (!monMailList(sel)) { MON.land = ""; return; }
  if (MON.land === sel.key || !NT.loaded) return;
  MON.land = sel.key;
  const waiting = [...mailDraftLive(sel.notices).values()].some(mailDraftOpen);
  if (waiting) MON.mailFilter = "pending"; else if (MON.mailFilter === "pending") MON.mailFilter = "all";
}
function mailFilterBar(mails, notices) {
  const cur = mailFilterOf()[0];
  return el("div", { class: "mr-filter", role: "tablist", "aria-label": "메일 보기" }, ...MAIL_FILTERS.map(([k, label, ok]) => {
    const n = k === "all" ? 0 : k === "pending" ? [...mailDraftLive(notices).values()].filter(mailDraftOpen).length : mails.filter(t => MAILS.has(t) && ok(MAILS.get(t), t)).length;
    return el("button", { class: `cchip mr-f${k === cur ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(k === cur), "data-filter": k, onclick: () => { MON.mailFilter = k; MON.sig = ""; monSchedule(); } }, label, n ? el("span", { class: "mr-fn", text: String(n) }) : null);
  }));
}
// A mail or chat of an integration is its own conversation in 채팅. A mail is a compact result-card row: sender and time on one line (with
// a paperclip and the file count when it has files), the subject, a summary of up to 3 lines and, at the bottom, the reply state. The
// whole card is the way in: it opens the mail's conversation, where the original and its files are (11-todo-strip.js "mail").
// Every mail row has one layout: sender · reply-state tag (only when there is a reply state; the orange 미답장 pill while one is owed) · 안 읽음 N ·
// paperclip · time · ⋯. A mail conversation whose mail is gone (deleted) is no row at all.
function monConvNode(t, label) {
  const m = MAILS.get(t), last = CONV.get(t), n = ts(t).unread, open = () => go("monitoring", `c:${t}`);
  if (!m && isMailT(t)) return null;
  const [stateText, stateTone] = m && m.dir !== "out" ? mailStateOf(m) : ["", ""];
  // A mail is one item: unread is one mark, however many messages (the mail, the bot's note on it) its conversation holds unread.
  const tag = m ? (n && m.dir !== "out" ? el("span", { class: "tag warn mr-unread", text: "안 읽음" }) : null) : n ? el("span", { class: "tag warn", text: `안 읽음 ${n}` }) : ntHasDecision(t) ? el("span", { class: "tag warn", text: "답변 필요" }) : null;
  const stateTag = stateText ? (m.unreplied ? unrepPill(stateText) : el("span", { class: `tag mr-state${stateTone ? ` ${stateTone}` : ""}`, "data-state": stateText, text: stateText })) : null;
  // The 자동 초안 규칙 that drafted this mail (hub/mail.ts MailRecord.rule): its name, as a plain tag beside the reply state.
  const ruleTag = m && m.rule && m.dir !== "out" ? draftRuleTag(m.rule, "mr-rule") : null;
  const inline = m ? mailRowActs(m).map(a => mailActButton(t, a)) : [];
  const files = m ? mailRealFiles(m.attachments).map(x => x.f) : [], brief = m ? mailBrief(m, t) : "", when = rcWhen(last ? last.ts : m && m.at), chip = m && (m.dir === "out" || !m.reply || (m.suggest && m.suggest.state === "sent")) ? mailReplyChip(m.suggest) : null;
  const title = m ? m.subject || "(제목 없음)" : rcPlain(String(last ? last.text : "").split("\n").find(l => l.trim() && !/^\s*>/.test(l)) || "") || label;
  const clip = files.length ? el("span", { class: "mr-clip", title: `첨부파일 ${files.length}개`, "aria-label": `첨부파일 ${files.length}개` }, icon("clip"), String(files.length)) : null;
  return el("div", { class: "bm alert rc mr", role: "button", tabindex: "0", "aria-label": `${title} ${m ? "원문 열기" : "대화 열기"}`, onclick: open,
    onkeydown: e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } } },
    el("div", { class: "rc-hd" }, el("span", { class: "rc-src", text: m ? m.dir === "out" ? `나 → ${mailSender(m.to) || "받는 사람"}` : mailSender(m.from) || label : label }), stateTag, ruleTag, tag, clip, when ? el("span", { class: "rc-time", text: when }) : null, m ? mailMenuBtn(t) : null),
    el("div", { class: "rc-title", text: title }),
    m && m.to ? el("div", { class: "mr-to", text: mailToText(m) }) : null,
    ...mailSumNodes(m, t, brief),
    chip || inline.length ? el("div", { class: "mr-slot" }, chip, ...inline) : null);
}
// The summary lines of a mail row: a bulleted 요약 as a two-point list, else the brief as one clamped text; then the first 할 일.
function mailSumNodes(m, t, brief) {
  if (!m) return brief ? [el("div", { class: "mr-sum", text: brief })] : [];
  const p = mailParts(m.summary || "", mailSkip(m));
  const sum = p.points.length ? el("ul", { class: "mr-sum mr-pts" }, ...p.points.map(x => el("li", { text: x }))) : brief ? el("div", { class: "mr-sum", text: brief }) : null;
  const todo = p.todo ? el("div", { class: "mr-todo" }, el("b", { text: "할 일" }), el("span", { text: p.more ? `${p.todo} 외 ${p.more}건` : p.todo })) : null;
  return [sum, todo].filter(Boolean);
}
// 초안 작성: the owner asks for a reply draft of this mail (POST /api/mail/<key>/draft, made behind the request); the draft arrives as the send-approval
// card in the mail's conversation. In a row and in the open mail's head.
const mailDraftAsk = async (t, btn, instruction = "") => {
  await api(`/api/mail/${t.slice(5)}/draft`, "POST", instruction ? { instruction } : {});
  toast("답장 초안을 만들고 있어요. 다 되면 이 메일에 승인 카드가 떠요");
  if (btn) { btn.disabled = true; btn.textContent = "만드는 중…"; }
};
// The sample in the 초안 작성 box, made from the summary the mail already has (hub/mail.ts MailRecord.summary: 요약, 할 일), no model call:
// the first 할 일, else the first point of 요약, quoted in one example instruction that fits it. "" without a summary (the fixed hint then).
const mailDraftCut = s => { const one = s.split(/(?<=[.!?])\s+/)[0].replace(/[.!?。]+$/, "").trim(); return one.length > 28 ? `${one.slice(0, 27).trim()}…` : one; };
function mailDraftSample(m) {
  if (!m || !m.summary) return "";
  const skip = mailSkip(m), p = mailParts(m.summary, skip), lead = p.todo || p.points[0] || mailLines(m.summary, skip)[0] || "";
  if (!lead) return "";
  const cut = mailDraftCut(lead), x = `‘${cut}’`;
  if (p.todo) return `예: ${x} 건은 이번 주 안에 처리하겠다고 써 줘`;
  // a point is a sentence: quoted with 라는 / 이라는 by the last syllable (a final consonant takes 이라는)
  const h = [...cut].reverse().find(c => c >= "가" && c <= "힣"), said = `${x}${h && (h.charCodeAt(0) - 0xac00) % 28 ? "이라는" : "라는"}`;
  if (/일정|회의|미팅|약속|방문|참석/.test(lead)) return `예: ${said} 제안에 그 시간 괜찮다고, 장소만 다시 알려 달라고 써 줘`;
  if (/요청|문의|부탁|검토|확인|회신|답변|제안/.test(lead)) return `예: ${said} 내용은 확인하고 금요일까지 답드린다고 써 줘`;
  return `예: ${said} 내용 잘 받았다고, 감사 인사와 함께 짧게 써 줘`;
}
// 초안 작성 asks first what the reply should say (owner 2026-10-28); an empty box makes the draft on its own, as before. Above the box: the mail
// it answers (sender, subject, the row's summary lines), so the owner writes the instruction without going back to the mail.
function mailDraftDialog(t, btn) {
  const m = MAILS.get(t), sample = mailDraftSample(m);
  const ta = el("textarea", { class: "fi", rows: "3", maxlength: "500", "data-k": "draft-instruction", "aria-label": "초안에 넣을 내용",
    placeholder: sample || "비워 두면 메일을 읽고 알아서 써요.\n예: 금요일까지 보내 드린다고, 견적서도 첨부한다고 써 줘" });
  const ctx = m ? el("div", { class: "md-ctx", "data-k": "draft-mail" },
    el("div", { class: "md-from" }, icon("mail"), el("span", { text: mailSender(m.from) || m.from || "보낸 사람 없음" })),
    el("div", { class: "md-subj", text: m.subject || "(제목 없음)" }),
    ...mailSumNodes(m, t, mailBrief(m, t))) : null;
  const go = (close, b) => busy(b, async () => { close(); await mailDraftAsk(t, btn, ta.value.trim()).catch(e => toast(e.message || "초안을 요청하지 못했어요", true)); });
  const d = dialog({ title: "답장 초안 만들기", body: el("div", { class: "col md-dlg" }, ctx,
      el("div", { class: "md-ask" }, el("div", { class: "md-lbl", text: "어떻게 답할까요?" }), ta, el("div", { class: "sup", text: sample ? "적은 내용을 그대로 반영해요. 비워 두면 메일을 읽고 알아서 써요." : "적은 내용을 그대로 반영해요." }))),
    actions: [{ label: "초안 만들기", kind: "pri", onclick: (close, b) => go(close, b) }] });
  ta.addEventListener("keydown", ev => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) { ev.preventDefault(); d.node.querySelector(".dact .btn:last-child").click(); } });
  ta.focus();
}
const mailDraftRun = (t, b) => mailDraftDialog(t, b);
const mailDraftButton = (t, cls = "cchip mr-act mr-draft") => el("button", { class: cls, type: "button", "data-k": "mail-draft", onclick: ev => { ev.stopPropagation(); mailDraftDialog(t, ev.currentTarget); } }, icon("pencil"), "초안 작성");
// 답장 안 함 / 답장 필요로 표시: the owner's own mark (POST / DELETE /api/mail/<key>/fyi, recorded as his with the time; a peer's mail on the computer
// that holds it: 34-peer-monitoring.js pqRoute). The row, its tag, the filter counts and the app badges change at once; 답장 안 함 drops the mail's
// waiting reply draft (확인 대기). 답장 필요로 표시 works from no state, from 답장 안 함 and from 답장함 (it needs another answer).
async function mailSetFyi(t, on) {
  const pc = pqPc(t);
  await api(`/api/mail/${t.slice(5)}/fyi`, on ? "POST" : "DELETE", on ? {} : undefined);
  const m = MAILS.get(t);
  if (m) { m.reply = on ? "fyi" : m.reply === "draft" ? "draft" : "needs"; m.unreplied = !on; }
  MON.sig = ""; MON.side = ""; monSchedule();
  toast(on ? "답장 안 함으로 표시했어요" : "답장 필요로 표시했어요", false, on ? { label: "되돌리기", onclick: () => busy(null, () => mailSetFyi(t, false)) } : undefined);
  await Promise.allSettled([pc ? pqLoad() : convLoad(), loadIntegrations(), pc ? null : loadNotices()]);
}
// The actions of a mail, one list for the ⋯ of every mail card and for the buttons of every row. Incoming: 초안 작성, then 답장 안 함 while a reply
// is owed (답장 필요 / 초안 있음) or 답장 필요로 표시 in any other state, then 삭제. Outgoing: 삭제. The one rule for a row's buttons: every incoming row
// shows 초안 작성 under its summary, without a tap on the ⋯ (owner 2026-10-29); a row whose reply is owed adds 답장 안 함. The rest stays in the ⋯.
const MAIL_ACT = { draft: "초안 작성", no: "답장 안 함", need: "답장 필요로 표시", delete: "삭제" };
const mailOwed = m => m.dir !== "out" && (m.reply === "needs" || m.reply === "draft");
const mailActs = m => m.dir === "out" ? ["delete"] : ["draft", mailOwed(m) ? "no" : "need", "delete"];
const mailRowActs = m => m.dir === "out" ? [] : mailOwed(m) ? ["draft", "no"] : ["draft"];
const mailActRun = (t, a, b) => a === "draft" ? mailDraftRun(t, b) : a === "delete" ? mailDelete(t) : mailSetFyi(t, a === "no");
// busy: a second tap while it posts does nothing
const mailActButton = (t, a) => a === "draft" ? mailDraftButton(t) : el("button", { class: "cchip mr-act unrep-no", type: "button", "data-k": `mail-${a}`, text: MAIL_ACT[a], onclick: ev => { ev.stopPropagation(); busy(ev.currentTarget, () => mailActRun(t, a, null)); } });
// 삭제: the mail leaves dotz on the computer that holds it (DELETE /api/mail/<key>); the real mailbox keeps it. A newer message of the thread brings it back.
async function mailDelete(t) {
  if (!await ask("메일 삭제", "이 메일을 목록에서 지울까요? 실제 메일함의 메일은 그대로 있어요", "삭제", true)) return;
  const pc = pqPc(t);
  await api(`/api/mail/${t.slice(5)}`, "DELETE");
  MAILS.delete(t); CONV.delete(t);
  const p = pc && PQ.list.find(x => x && x.url === pc.url);
  if (p && p.items) p.items.conversations = (p.items.conversations || []).filter(c => String(c.target) !== t);
  if (monCtx === t && current === "chat") go("monitoring", MON.sel);   // deleted from its open conversation: back to the list
  PQ.of.delete(t);
  MON.sig = ""; MON.side = ""; monSchedule();
  toast("메일을 목록에서 지웠어요");
  await Promise.allSettled([pc ? pqLoad() : convLoad(), loadIntegrations(), pc ? null : loadNotices()]);
}
// The ⋯ at the top right of a mail card (every row of the list and the card at the top of the mail's conversation): mailActs, built from the
// mail's state at the tap.
function mailMenuBtn(t) {
  return el("button", { class: "ib mr-more", type: "button", "aria-label": "메일 메뉴", title: "메일 메뉴", "aria-haspopup": "listbox", "aria-expanded": "false", "data-k": "mail-menu", onclick: ev => {
    ev.stopPropagation();
    const b = ev.currentTarget, m = MAILS.get(t) || {};
    showMenu(b, mailActs(m).map(a => ({ value: a, label: MAIL_ACT[a] })), { onPick: v => busy(null, () => mailActRun(t, v, null)) });
  }, onkeydown: ev => ev.stopPropagation() }, icon("more"));
}
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
    toast(r && r.approved ? MON_RECONNECT : r && r.item && r.item.connection === "disconnected" ? "확인했지만 아직 연결이 끊겨 있어요" : "확인했어요");
  } finally {
    MON.running.delete(m.watch); MON.sig = ""; MON.side = ""; monSchedule();
    if (btn) btn.textContent = was;
  }
});
// A down watch behind an approval gate is approved by the tap (hub/routes-lanes.ts run): its login may now ask the owner on his phone.
const MON_RECONNECT = "다시 연결을 요청했어요. 승인 요청이 오면 눌러 주세요";
// 다시 연결 on a disconnected app: every watch the app owns runs on this computer, then the app and the list are read again.
const monRecheckApp = (btn, it, names) => busy(btn, async () => {
  for (const n of names) MON.running.add(n);
  MON.sig = ""; MON.side = ""; monSchedule();
  // allSettled: one watch failing to run still lets the others finish, the data reload and the owner hear how it went.
  // A peer's app: its watches run (and a gated login is approved) on the computer that owns them.
  const runOne = n => it.pc ? api(pqProxy(it.pc, "/api/peer/act"), "POST", { action: "watch", args: { op: "run", name: n } }) : api(`/api/watches/${enc(n)}/run`, "POST", {});
  const res = await Promise.allSettled(names.map(runOne));
  for (const n of names) MON.running.delete(n);
  await Promise.allSettled([loadMonitors(), it.pc ? pqLoad() : loadIntegrations()]);
  MON.sig = ""; MON.side = ""; monSchedule();
  const bad = res.filter(r => r.status === "rejected").length, asked = res.some(r => r.status === "fulfilled" && r.value && r.value.approved);
  toast(bad ? `${names.length}개 중 ${bad}개는 확인하지 못했어요` : asked ? MON_RECONNECT : "지금 다시 확인했어요", !!bad);
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
const monBarWanted = it => !it.mails.some(t => MAILS.has(t)) && (it.notices.length > 6 || it.notices.some(n => monNeed(n) || (monFailed(n) && !n.read)));
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
// A peer's reports are read on the computer that holds them (pqNoticesRead).
const monReadAll = (btn, list) => busy(btn, async () => {
  const mine = list.filter(n => !n.pc), ids = mine.map(n => String(n.id));
  try { await pqNoticesRead(list); } catch (err) { for (const n of list) if (n.pc) n.read = false; pqSoon(); throw err; }
  if (ids.length) {
    for (const n of mine) n.read = true;
    NT.unread = Math.max(0, NT.unread - ids.length); ntPaint(); homeSoon();
    let r;
    try { r = await api("/api/notices/read", "POST", { ids }); }
    catch (err) { for (const n of mine) n.read = false; NT.unread += ids.length; ntPaint(); homeSoon(); loadNotices(); throw err; }
    if (r && typeof r.unread === "number") NT.unread = r.unread;
    ntPaint();
  }
  toast(`${list.length}개를 읽음으로 표시했어요`);
});
// One report as a row: source, state, time and a two-line summary; a tap unfolds the whole card in place (sections, the original, 답하러 가기).
// A report that waits on the owner carries 답하러 가기 on the row itself. A decision is always the whole card: it is answered in place.
function monRowNode(n, names) {
  if (ntIsDec(n) || n.item) return monNoticeNode(n, names);   // a report about an app item shows the item (a mail row) as the app draws it
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
  const ok = monFilterOf()[2], withMails = it.mails.some(t => MAILS.has(t)), mf = withMails ? mailFilterOf() : null, held = mf && mf[0] === "pending";
  // a mail list keeps the reply drafts awaiting the owner under 확인 대기 alone; every other view drops them. A draft answered 보내지 않기, and one a
  // newer draft of the same mail replaced, is gone from every view.
  const newestDraft = mailDraftLive(it.notices);
  // A message about one mail (the bot's note in its conversation, src/open = that mail) is read inside that mail, not as a card of its own between
  // the mail rows: every row of a mail list is a mail. Reply drafts keep their own place (확인 대기).
  const rowMail = n => !!mf && !(n.decision && n.decision.draft) && MAILS.has(n.src || n.open) && it.mails.includes(n.src || n.open);
  const notices = it.notices.filter(n => ok(n) && !rowMail(n) && (!mf || (mailDraftHeld(n) === held && !mailDraftDone(n))) && !mailDraftGone(n, newestDraft));
  const runs = [];
  for (const n of notices.sort((a, b) => ntAt(a) - ntAt(b))) {
    const last = runs[runs.length - 1], k = monNeed(n) || ntIsDec(n) ? "" : monFoldKey(n, names);
    if (k && last && last.k === k) { last.all.push(n); last.n = n; } else runs.push({ k, n, all: [n] });
  }
  const page = MON.more.get(it.key) || MON_PAGE, cut = Math.max(0, runs.length - page);
  const rep = r => {
    if (r.all.length < MON_FOLD_MIN) return r.all.map(n => ({ at: ntAt(n), node: () => monNoticeNode(n, names) }));
    return [{ at: ntAt(r.n), node: () => { const x = monNoticeNode(r.n, names); if (!x) return null; x.dataset.nids = r.all.map(n => n.id).join(","); x.querySelector(".rc-hd").after(el("div", { class: "mon-rep", text: `같은 결과 ${r.all.length}번 · 처음 ${monWhen(r.all[0])}` })); return x; } }];
  };
  const msgs = [...runs.slice(cut).flatMap(rep), ...(held ? [] : mf ? it.mails.filter(t => MAILS.has(t) && mf[2](MAILS.get(t), t)) : it.mails).map(t => ({ at: Date.parse((CONV.get(t) || {}).ts) || Date.parse((MAILS.get(t) || {}).at) || 0, node: () => monConvNode(t, it.name) })),
    ...(it.mon && !held ? [{ at: Date.parse(it.mon.last_run) || 0, node: () => monRunNode(it) }] : [])];
  // A mail app reads like a mailbox, newest on top (owner 2026-10-27); a monitor stays a chat, oldest to newest. Equal times keep their order.
  const newestTop = monMailList(it);
  msgs.sort((a, b) => newestTop ? b.at - a.at : a.at - b.at);
  const nodes = msgs.map(x => x.node()).filter(Boolean);
  if (cut && newestTop) nodes.push(monMoreBtn(it.key, cut, `이전 소식 ${cut}개 보기`));
  else if (cut) nodes.unshift(monOlderSentinel(it.key, cut), monMoreBtn(it.key, cut, `이전 소식 ${cut}개 보기`));
  if (withMails) return [mailFilterBar(it.mails, it.notices.filter(ok)), ...(nodes.length ? nodes : [el("div", { class: "empty", text: held ? "확인할 초안이 없어요" : "이 보기에 해당하는 메일이 없어요" })])];
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
// Every plain monitor of the list, this computer's and the others' (monItems already drops an app's own watches and merges the peers): a peer row
// keeps its machine chip, and one whose hub sent no next run says '다른 컴퓨터' instead of drawing a bar from made-up times.
function monOverview(it) {
  if (it.key !== "notice") return null;
  const now = Date.now(), list = monItems().filter(i => i.mon);
  const rank = i => { const m = i.mon; return m.connection === "disconnected" ? 0 : m.last_result === "fail" ? 1 : m.paused ? 4 : (Date.parse(m.next_run) || Infinity) < now ? 2 : m.last_run ? 3 : 2; };
  const sorted = list.slice().sort((a, b) => rank(a) - rank(b) || (Date.parse(a.mon.next_run) || Infinity) - (Date.parse(b.mon.next_run) || Infinity));
  return el("div", { class: "mon-ov" }, el("div", { class: "mon-ov-h", text: "모니터링 상태" }),
    ...(sorted.length ? sorted.map(i => {
      const m = i.mon, peerBar = i.pc && !m.paused && !(Date.parse(m.next_run) > 0);   // a paused peer monitor draws the grey 꺼짐 bar like a local one
      return el("button", { class: "mon-ov-row", type: "button", "data-ov": i.key, onclick: () => go("monitoring", i.key) },
        el("span", { class: "mon-ov-hd" }, el("span", { class: "mon-ov-n", text: monTitle(m) }), i.pc ? el("span", { class: "tag", text: i.pc.name }) : null),
        peerBar ? el("span", { class: "mon-ov-peer", text: "다른 컴퓨터" }) : monProgNode(m, { compact: true }),
        el("span", { class: "mon-ov-s", text: m.connection === "disconnected" ? monConnLine(m) : m.last_summary || monRunLine(m) }));
    }) : [el("div", { class: "mon-ov-empty", text: "아직 일반 모니터링이 없어요" })]));
}
function monTimeline(it) {
  if (it.off) return [el("div", { class: "empty", text: "연결 안 됨" })];
  const names = it.mon ? monNames(it.mon) : [];
  const bar = monBarWanted(it) ? [monBar(it)] : [], nodes = !monFeed(it) ? monChronoNodes(it, names) : it.notices.length > MON_COMPACT ? monFeedNodes(it, names) : monFeedCards(it, names);
  const ov = monOverview(it), head = [...monTopNodes(it), ...bar, ...(ov ? [ov] : [])];
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
  const st = monStatus(m);
  const facts = [m.fails ? `연속 실패 ${m.fails}번` : "", m.last_ok ? `마지막 정상 ${monTime(m.last_ok)}` : "", m.last_output ? `마지막 결과: ${m.last_output}` : ""].filter(Boolean);
  return el("div", { class: "as-row as-stat", "data-watch": m.watch || m.name },
    el("span", { class: "as-b" }, el("span", { class: "as-n", text: monTitle(m) }), el("span", { class: "as-h", text: [st.text, ntMonRun(m), ntMonNext(m)].filter(Boolean).join(" · ") }), ...facts.map(t => el("span", { class: "as-h", text: t }))),
    st.tone === "err" ? el("span", { class: "tag err", text: st.text }) : null);
}
// A peer's app is `<its key>~<computer hash>`: the same key may exist on this computer too (34-peer-monitoring.js pqApp).
const monSettingsApp = it => !it || it.off ? "" : it.app && !it.pc ? it.key.slice(2) : it.app && it.pc ? pqApp(it.inst, it.pc) : it.mon && it.mon.kind === "watch" && it.mon.watch ? `w:${it.mon.watch}` : "";
// A connection that is down says so at the top of the conversation, whether or not an alert went out, with the way to check again.
// Two states, two banners: kind "down" (the connection is gone: err tone, 연결이 끊겼어요) and "fail" (connected, the last check failed: err tone too,
// 확인 실패). The head is passed in, never guessed from the detail text.
function monBannerNode(kind, detail, btn) {
  const head = kind === "down" ? "연결이 끊겼어요" : "확인 실패", t = String(detail || "").trim();
  return el("div", { class: `mon-banner ${kind}`, role: kind === "down" ? "alert" : "status", "data-kind": kind }, icon("refresh"), el("span", { class: "mon-banner-tx" }, el("b", { text: head }), t ? ` · ${t}` : ""), btn);
}
// The app hint the hub writes for a down app starts with the row word ("연결 끊김 · ..."); the banner has its own head, so only the why is kept.
const monHintWhy = h => String(h || "").replace(/^\s*연결\s*(끊김|이 끊겼어요)\s*(·\s*)?/, "");
const monRunBtn = (m, text) => el("button", { class: "btn tonal sm mon-run", type: "button", "data-run": m.watch, text: text || "지금 확인", onclick: ev => monRunNow(ev.currentTarget, m) });
const monRecheckBtn = (watch, onclick, text = "지금 다시 확인") => el("button", { class: "btn tonal sm mon-recheck", type: "button", "data-watch": watch, text, onclick });
// One re-check control per conversation: a down or failing monitor, and a down app, get the banner and its button; a healthy one gets 지금 확인
// in the head (a phone at the top of the timeline). The latest-run card never repeats it.
function monBannerOf(it) {
  if (it.mon) {
    const m = it.mon, down = m.connection === "disconnected";
    if (!down && m.last_result !== "fail") return null;
    const detail = down ? monConnWhy(m) : [m.fails > 1 ? `${m.fails}번 연속 실패했어요` : "마지막 확인이 실패했어요", m.last_summary || ""].filter(Boolean).join(" · ");
    return monBannerNode(down ? "down" : "fail", detail, m.watch ? monRecheckBtn(m.watch, ev => monRunNow(ev.currentTarget, m), down ? "다시 연결" : undefined) : null);
  }
  if (!it.conn) return null;
  const names = (it.owned || []).map(m => m.watch).filter(Boolean);
  return monBannerNode("down", monHintWhy(it.hint), names.length ? monRecheckBtn(it.key, ev => monRecheckApp(ev.currentTarget, it, names), "다시 연결") : null);
}
// The title bar of an open item; the kakao pane puts the gear in its room head once a room is open.
// A monitor adds its own progress block and 지금 확인 under the name, so the conversation always says how far the wait has come.
const monHead = it => {
  const banner = monBannerOf(it), st = monState(it);
  // An app with reply drafts waiting opens the one 답장 확인 queue on its own drafts (30-replies.js).
  const rqBtn = it.app && it.drafts ? el("button", { class: "btn tonal sm rq-go", type: "button", "data-k": "replies", text: `답장 확인 ${it.drafts}`, onclick: () => rqOpen(it.inst, it.pc) }) : null;
  const row = [monIcon(it.ic), el("span", { class: "cv-b" }, el("span", { class: "cv-n" }, it.name, pqLabel(it)), st ? el("span", { class: "cv-p", text: st }) : null), rqBtn, it.mon && it.mon.watch && !banner ? monRunBtn(it.mon) : null, it.unreplied ? unrepPill(`미답장 ${it.unreplied}`) : null, ...(kkItem(it) && KK.open ? [] : asEntry(monSettingsApp(it)))].filter(Boolean);
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
    if (!it || !box.clientHeight) return;
    const a = box.getBoundingClientRect(), seen = new Set();
    for (const m of box.querySelectorAll("[data-nid], [data-nids]")) {
      const r = m.getBoundingClientRect();
      if (r.bottom > a.top && r.top < a.bottom) for (const id of String(m.dataset.nids || m.dataset.nid || "").split(",")) if (id) seen.add(id);
    }
    // a peer's report is read on its computer (a failed read is re-read from the next snapshot)
    const fresh = it.notices.filter(n => n.id && !n.read && !ntNeeds(n) && seen.has(String(n.id)) && (n.pc ? pqNoticeOf(n) : ntById(n.id)));
    if (!fresh.length) return;
    const mine = fresh.filter(n => !n.pc);
    pqNoticesRead(fresh).catch(() => pqSoon());
    if (!mine.length) return;
    for (const n of mine) n.read = true;
    NT.unread = Math.max(0, NT.unread - mine.length);
    ntPaint(); homeSoon();
    ntMarkRead({ ids: mine.map(n => n.id) });
  }, 700);
}

let monRaf = 0;
const monSchedule = () => { monAttnSoon(); if (!monRaf) monRaf = requestAnimationFrame(renderMonitoring); };   // the nav badge reads the same data (09-needs-you.js)
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
  cmMode(cm, !!cm && !(narrowChat() && MON.list), cm ? sel.pc : null);
  mailLand(sel);
  if (!sel) { MON.sig = ""; MON.shown = ""; convTitle(); return; }
  if (kakao || cm) {   // 30-kakao.js / 30-monitoring-comments.js draw this item's pane (rooms and chat); only the head is the usual one
    const head = JSON.stringify([sel.name, monState(sel), sel.unreplied | 0, sel.drafts | 0, !!AS.by[monSettingsApp(sel)], !!KK.open, pqSig(sel)]);
    if (head !== MON.kkHead) { MON.kkHead = head; clear($("#mon-head")).append(...monHead(sel)); }
    MON.sig = ""; MON.shown = sel.key;
    convTitle();
    return;
  }
  MON.kkHead = "";
  if (sel.rq) {   // 답장 확인: the cards of 30-replies.js, redrawn only when a draft or the queue's own state changes
    const sig = rqSig();
    if (sig !== MON.sig) {
      const keep = MON.shown === sel.key ? box.scrollTop : 0;
      MON.sig = sig; MON.shown = sel.key;
      clear($("#mon-head")).append(...monHead(sel));
      clear(tl).append(...rqNodes());
      box.scrollTop = keep;
      edgeFade(box);
    }
    convTitle();
    return;
  }
  const sig = JSON.stringify([sel.key, sel.name, monState(sel), sel.unreplied | 0, sel.conn | 0, sel.mon && !!sel.mon.watch && MON.running.has(sel.mon.watch), sel.notices.map(n => [n.id, n.updated, n.read, n.text, n.decision, n.tone, n.item, n.item && n.item.key ? MAILS.get(`mail:${n.item.key}`) : null]), sel.mails.map(t => [t, (CONV.get(t) || {}).ts, ts(t).unread, MAILS.get(t), MAILS.has(t) ? mailBrief(MAILS.get(t), t) : ""]), sel.mon, NM.loaded, NT.loaded, MON.mailFilter || "all", pqSig(sel)]);
  if (sig !== MON.sig) {
    MON.sig = sig;
    const again = MON.shown === sel.key, keep = box.scrollTop, was = box.scrollHeight, stick = !again || box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    MON.shown = sel.key;
    clear($("#mon-head")).append(...monHead(sel));
    clear(tl).append(...monTimeline(sel));
    // Older reports added above (이전 소식 보기) keep what was on screen where it is.
    if (MON.grew) { MON.grew = false; box.scrollTop = keep + (box.scrollHeight - was); }
    else box.scrollTop = monFeed(sel) || monMailList(sel) ? (again ? keep : 0) : stick ? box.scrollHeight : keep;
    edgeFade(box);
  }
  MON.olderBusy = false;
  monObserveOlder();
  convTitle();
  monSeen();
}
// A monitor row in the list carries the same bar under its status line; the row itself is the shared convRow, so the block is appended here.
// A monitor row carries its bar as the last child of the whole row (not of the text column), so the bar and its meta line take the full left-column
// width even when a peer row's machine chip and result badge leave the text column narrow.
function monDecorateRows(side, items) {
  for (const row of side.querySelectorAll(".cv-row[data-k]")) {
    const it = items.find(i => i.key === row.dataset.k);
    if (!it || !it.mon) continue;
    row.classList.add("has-mon-prog");
    const status = row.querySelector(".cv-b .cv-p"), old = row.querySelector(".mon-prog-wrap");
    // The bar's colour says the result; only a disconnected monitor keeps its words (연결 끊김 and since when).
    if (status && it.mon.connection === "disconnected") { status.classList.add("mon-row-status"); row.append(status); }
    else if (status) status.remove();
    if (old) old.remove();
    row.append(monProgNode(it.mon, { compact: true, tag: false, short: true }));
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
    bar.classList.toggle("warn", late || bar.dataset.tone === "warn");
    const wrap = bar.parentElement && bar.parentElement.parentElement;
    if (!wrap) continue;
    const tx = wrap.querySelector(".mon-prog-tx");
    if (tx) tx.textContent = monProgLine(from, to, now, null, bar.dataset.short === "1");
    const tag = wrap.querySelector(".mon-ptag");
    if (tag && !tag.dataset.fixed) {
      const [text, tone] = monPTagOf(late ? "late" : tag.dataset.tag || "ok");
      if (tag.textContent !== text) tag.textContent = text;
      tag.className = `mon-ptag${tone ? ` ${tone}` : ""}`;
    }
  }
}
// Once a second is plenty: the words change once a minute and a bar moves under a pixel per frame. The timer stops itself when the tab or the
// page is not shown and the next paint of 모니터링 (or the page coming back) starts it again.
let monTickT = 0;
function monTickStop() { if (monTickT) clearInterval(monTickT); monTickT = 0; }
function monTickStart() {
  if (monTickT || current !== "monitoring" || document.hidden) return;
  monTick();
  monTickT = setInterval(() => { if (document.hidden || current !== "monitoring") monTickStop(); else monTick(); }, 1000);
}
document.addEventListener("visibilitychange", () => { if (document.hidden) monTickStop(); else monTickStart(); });
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
