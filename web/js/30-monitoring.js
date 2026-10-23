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
// The list's groups after 감시 소식: app-type integrations (hub/integrations.ts kind "app"), then the plain monitors.
const MON_GROUP = { app: "앱", plain: "일반 모니터링" };
// sel: the open item's key ("notice", "i:<integration>", "m:<monitor name>"); list: a phone shows the list instead of the conversation.
const MON = { sel: "", list: true, shown: "", sig: "", side: "", seenT: 0 };
const monConv = () => current === "monitoring" && narrowChat() && !MON.list;
const monHash = () => (!MON.list && MON.sel ? `monitoring/${enc(MON.sel)}` : "monitoring");
// A mail is a conversation of 모니터링 (go() in 05-command-palette.js draws it with the chat view while the tab stays 모니터링); monItemOf: the list item it sits under.
const monOwned = t => isMailT(String(t || ""));
const monItemOf = t => {
  if (!monOwned(t)) return "";
  const it = INTG.items.find(x => (x.conv || []).some(p => String(t).startsWith(p)));
  return `i:${it ? it.key : "mail"}`;
};
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
function monItems() {
  intgWatch();
  const mons = ntMons(), shown = new Set(), items = [];
  for (const it of INTG.items) {
    const notices = (it.notices || []).map(ntById).filter(n => n && monMine(n, it)), mails = [...CONV.keys()].filter(t => (it.conv || []).some(p => t.startsWith(p)));
    for (const n of notices) shown.add(n.id);
    const cands = [...notices.map(n => ({ at: monNoticeAt(n), text: monLine(n) })), ...mails.filter(t => CONV.get(t)).map(t => ({ at: CONV.get(t).ts, text: (MAILS.get(t) || {}).subject || CONV.get(t).text }))].sort((a, b) => b.at.localeCompare(a.at));
    const needs = it.needs || { drafts: 0, unread: monUnread(notices) + mails.reduce((c, t) => c + (ts(t).unread | 0), 0), sentToday: 0 };
    items.push({ key: `i:${it.key}`, group: MON_GROUP[it.kind || "app"] || MON_GROUP.app, name: it.label, ic: it.icon, notices, mails, app: true, unread: needs.drafts || needs.unread, hint: monNeedLine(needs), at: cands[0] ? cands[0].at : "" });
  }
  for (const m of mons) {
    const notices = NT.items.filter(n => monHas(m, n)), last = monNewest(notices), names = monNames(m);
    for (const n of notices) shown.add(n.id);
    // The row says the newest result in words: the newest report, unless a later run said nothing (an "ok" run posts no report).
    const fresh = last && (!m.last_run || ntAt(last) >= Date.parse(m.last_run) - 60_000);
    items.push({ key: `m:${m.name}`, group: MON_GROUP.plain, name: monTitle(m), raw: monRaw(m), ic: "activity", notices, mails: [], mon: m, unread: monUnread(notices),
      hint: fresh ? monStrip(monLine(last), names) : monRunLine(m), at: m.last_run || (last ? monNoticeAt(last) : ""),
      badge: m.last_result === "fail" ? ["실패", "err"] : m.kind === "schedule" ? [MON_KIND.schedule, ""] : null });
  }
  // A report the hub marked as an app's (n.app, hub/notices.ts) is never here, even before the app list below has loaded.
  const feed = NT.items.filter(n => n.kind === "watch" && !n.app && !shown.has(n.id)), last = monNewest(feed);
  items.unshift({ key: "notice", group: "", name: MON_FEED, ic: "list", notices: feed, mails: [], unread: monUnread(feed), hint: last ? monLine(last) : "새 감시 소식이 없어요", at: last ? monNoticeAt(last) : "" });
  return items;
}
// The open item: the one picked, else on a wide screen the first (a phone shows its list until one is picked).
const monSel = items => items.find(i => i.key === MON.sel) || (narrowChat() ? null : items[0] || null);
const monName = () => { const it = monItems().find(i => i.key === MON.sel); return it && it.key === KK_KEY && KK.open && KK.room ? KK.room.name : it ? it.name : titles.monitoring; };
function monState(it) {
  if (it.mon) { const res = it.mon.last_result ? NT_RESULT[it.mon.last_result] : null; return [res && res[0], ntMonRun(it.mon), ntMonNext(it.mon)].filter(Boolean).join(" · "); }
  if (it.key === "notice") return it.unread ? `안 읽은 소식 ${it.unread}개` : "감시와 예약 결과";
  return it.app ? it.hint : it.unread ? `안 읽음 ${it.unread}개` : "연결돼 있어요";
}

/* ---- the list ---- */
function monRows(items, sel) {
  const rows = [];
  let group = null;
  for (const it of items) {
    if (it.group && it.group !== group) rows.push({ header: it.group });
    group = it.group;
    rows.push({ k: it.key, name: it.name, av: monIcon(it.ic), hint: it.hint, unread: it.unread, badge: it.badge || null, sel: !!sel && it.key === sel.key && !MON.list, open: () => go("monitoring", it.key) });
  }
  if (!NM.loaded) rows.push({ header: NM.failed ? "모니터링을 불러오지 못했어요" : "모니터링 불러오는 중…" });
  return rows;
}

/* ---- the conversation ---- */
const MON_TONE = { fail: ["실패", "err"], warn: ["주의", "warn"], ask: ["답변 필요", "warn"], ok: ["정상", "ok"], changed: ["바뀜", "warn"] };
const monWhen = n => ntTime(n.updated || n.ts);
const monTag = tone => { const t = MON_TONE[tone]; return t ? el("span", { class: `tag ${t[1]}`, text: t[0] }) : null; };
// A send approval (hub/draft-approval.ts): drawn as the mail it would send - the one question, the mail being answered when known, the recipient chip,
// the subject in bold, the body in paragraphs - with its state as a badge with the time. 보내기 sends, 고치기 opens a box with the draft to change,
// 보내지 않기 is the quiet way out. The whole answer path is the notice's (answerInline / ntPost), so the chat card and this one stay in step.
const DR = { edit: new Set(), note: {} };
const DR_STATE = { open: ["승인 대기", "warn"], send: ["보냄", "ok"], edit: ["고침", "pri"], drop: ["보내지 않음", ""], expired: ["만료", ""], ignored: ["무시함", ""] };
function drState(d) {
  if (d.state === "open" || d.state === "ignored") return d.state;
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
  const files = Array.isArray(dr.files) ? dr.files : [];
  const editing = open && DR.edit.has(n.id);
  const ta = editing ? el("textarea", { class: "dr-edit", rows: "8", maxlength: "6000", "aria-label": "초안 고치기", disabled: busy, oninput: () => { DR.note[n.id] = ta.value; go2.disabled = !ta.value.trim(); } }) : null;
  if (ta) ta.value = DR.note[n.id] ?? drParas(dr.body).join("\n\n");
  const mailBox = el("div", { class: "dr-mail" },
    el("div", { class: "dr-to" }, el("span", { class: "dr-k", text: dr.toLabel || "받는이" }), el("span", { class: "dr-chip", text: dr.to || "-" })),
    dr.subject ? el("div", { class: "dr-sub", text: dr.subject }) : null,
    editing ? ta : el("div", { class: "dr-body" }, ...drParas(dr.body).map(t => el("p", { text: t }))),
    files.length ? el("div", { class: "dr-files" }, ...files.map(f => el("span", { class: "dr-file" }, icon("clip"), f.name || String(f)))) : null);
  const kids = [
    el("div", { class: "rc-hd" }, el("span", { class: "dr-ic" }, icon(mail ? "mail" : "send")), el("span", { class: "rc-src", text: mail ? "메일" : (targetName(d.to) || "초안") }), el("span", { class: `tag dr-st${stTone ? ` ${stTone}` : ""}`, "data-state": st, text: `${stText} · ${when}` })),
    q ? el("div", { class: "rc-title dr-q", text: q }) : null, mail ? drOriginal(d.to) : null, mailBox];
  if (editing) {
    const go2 = el("button", { class: "btn", type: "button", disabled: busy || !ta.value.trim(), text: "고친 내용 보내기", onclick: async () => {
      const text = ta.value.trim();
      if (!text || !oEdit) return;
      dcSending.add(n.id); syncInlineChoices(); redraw();
      try { await ntPost(n, oEdit.n, `이 내용으로 고쳐 주세요: ${text}`); DR.edit.delete(n.id); delete DR.note[n.id]; } catch (e) { toast(e.message, true); }
      dcSending.delete(n.id); syncInlineChoices();
    } });
    kids.push(el("div", { class: "dr-act dr-row" }, go2, el("button", { class: "btn text", type: "button", disabled: busy, text: "취소", onclick: () => { DR.edit.delete(n.id); redraw(); } })));
  } else if (open) {
    const go = o => () => { if (o && !busy) answerInline(n, o); };
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
  if (d.draft) return draftCardNode(n);
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
  if (ntIsDec(n)) return monDecisionNode(n);
  const node = monCard(ntPlain(names[0] || n.title) || "알림", n.updated || n.ts, monStrip(String(n.text || ""), [...names, ntPlain(n.title)]), n.tone);
  if (!node) return null;
  node.dataset.nid = n.id;
  if (ntNeeds(n)) node.append(el("div", { class: "btns cc-act" }, el("button", { class: "btn tonal", type: "button", onclick: () => noticeOpen(n), text: "답하러 가기" })));
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
const mailFileUrl = (key, i, dl) => `/api/mail/${enc(key)}/files/${i}${dl ? "?dl=1" : ""}`;
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
// A mail or chat of an integration is its own conversation in 채팅. A mail is a compact result-card row: sender and time on one line (with
// a paperclip and the file count when it has files), the subject, a summary of up to 3 lines and, at the bottom, the reply state. The
// whole card is the way in: it opens the mail's conversation, where the original and its files are (11-todo-strip.js "mail").
function monConvNode(t, label) {
  const m = MAILS.get(t), last = CONV.get(t), n = ts(t).unread, open = () => go("monitoring", `c:${t}`);
  const tag = n ? el("span", { class: "tag warn", text: `안 읽음 ${n}` }) : !m && ntHasDecision(t) ? el("span", { class: "tag warn", text: "답변 필요" }) : null;
  const files = m ? m.attachments || [] : [], brief = m ? mailBrief(m, t) : "", when = rcWhen(last ? last.ts : m && m.at), chip = m ? mailReplyChip(m.suggest) : null;
  const title = m ? m.subject || "(제목 없음)" : rcPlain(String(last ? last.text : "").split("\n").find(l => l.trim() && !/^\s*>/.test(l)) || "") || label;
  const clip = files.length ? el("span", { class: "mr-clip", title: `첨부파일 ${files.length}개`, "aria-label": `첨부파일 ${files.length}개` }, icon("clip"), String(files.length)) : null;
  return el("div", { class: "bm alert rc mr", role: "button", tabindex: "0", "aria-label": `${title} ${m ? "원문 열기" : "대화 열기"}`, onclick: open,
    onkeydown: e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } } },
    el("div", { class: "rc-hd" }, el("span", { class: "rc-src", text: m ? mailSender(m.from) || label : label }), tag, clip, when ? el("span", { class: "rc-time", text: when }) : null),
    el("div", { class: "rc-title", text: title }),
    brief ? el("div", { class: "mr-sum", text: brief }) : null,
    chip ? el("div", { class: "mr-slot" }, chip) : null);
}
// A monitor's latest run, as the newest message of its conversation: the result in words, when it checks next, and its project chat.
function monRunNode(it) {
  const m = it.mon;
  if (!m.last_run) return null;
  const next = [m.next_run ? `다음 확인 ${monTime(m.next_run)}` : "", m.every || ""].filter(Boolean).join(" · ");
  const node = monCard(it.name, m.last_run, next, m.kind === "watch" ? m.last_result : "", monRunLine(m));
  if (node && m.channel && isProjT(m.channel)) node.append(el("div", { class: "btns cc-act" }, el("button", { class: "btn tonal", type: "button", onclick: () => { if (S && !projTargets().includes(m.channel)) toast("이 프로젝트를 찾을 수 없어요"); else go("monitoring", `c:${m.channel}`); }, text: "프로젝트 대화 열기" })));
  return node;
}
// An item reads like a chat: its reports and mails oldest to newest, a monitor's latest run last. The 감시 소식 feed is a list, not a chat: newest on top.
const monFeed = it => it.key === "notice";
function monTimeline(it) {
  const names = it.mon ? monNames(it.mon) : [];
  const msgs = [...it.notices.map(n => ({ at: ntAt(n), node: () => monNoticeNode(n, names) })), ...it.mails.map(t => ({ at: Date.parse((CONV.get(t) || {}).ts) || 0, node: () => monConvNode(t, it.name) })),
    ...(it.mon ? [{ at: Date.parse(it.mon.last_run) || 0, node: () => monRunNode(it) }] : [])].sort((a, b) => monFeed(it) ? b.at - a.at : a.at - b.at);
  const nodes = msgs.map(x => x.node()).filter(Boolean);
  if (nodes.length) return nodes;
  const next = it.mon && it.mon.next_run ? ` · 다음 확인 ${monTime(it.mon.next_run)}` : "";
  return [el("div", { class: "empty", text: !NT.loaded && !NM.loaded ? "불러오는 중…" : it.mon ? `${monRunLine(it.mon)}${next}` : "아직 소식이 없어요" })];
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
  if (current !== "monitoring") { if (monCtx && current === "chat") convSchedule(); return; }
  const items = monItems(), sel = monSel(items), side = $("#mon-side"), box = $("#mon-timeline"), tl = $("#mon-tl");
  const rows = monRows(items, sel), sideSig = JSON.stringify([rows.map(r => [r.k, r.name, r.hint, r.unread, r.badge, r.header, r.sel])]);
  if (sideSig !== MON.side) {
    MON.side = sideSig;
    const top = side.scrollTop;
    clear(side).append(...rows.map(convRow));
    side.scrollTop = top;
  }
  const kakao = !!sel && sel.key === KK_KEY;
  const cm = !kakao && sel ? cmAppOf(sel.key) : "";
  kkMode(kakao, kakao && !(narrowChat() && MON.list));
  cmMode(cm, !!cm && !(narrowChat() && MON.list));
  if (!sel) { MON.sig = ""; MON.shown = ""; convTitle(); return; }
  if (kakao || cm) {   // 30-kakao.js / 30-monitoring-comments.js draw this item's pane (rooms and chat); only the head is the usual one
    const head = JSON.stringify([sel.name, monState(sel)]);
    if (head !== MON.kkHead) { MON.kkHead = head; clear($("#mon-head")).append(...monHead(sel)); }
    MON.sig = ""; MON.shown = sel.key;
    convTitle();
    return;
  }
  MON.kkHead = "";
  const sig = JSON.stringify([sel.key, sel.name, monState(sel), sel.notices.map(n => [n.id, n.updated, n.read, n.text, n.decision, n.tone, n.item, n.item && n.item.key ? MAILS.get(`mail:${n.item.key}`) : null]), sel.mails.map(t => [t, (CONV.get(t) || {}).ts, ts(t).unread, MAILS.get(t), MAILS.has(t) ? mailBrief(MAILS.get(t), t) : ""]), sel.mon, NM.loaded, NT.loaded]);
  if (sig !== MON.sig) {
    MON.sig = sig;
    const again = MON.shown === sel.key, keep = box.scrollTop, stick = !again || box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    MON.shown = sel.key;
    clear($("#mon-head")).append(...monHead(sel));
    clear(tl).append(...monTimeline(sel));
    box.scrollTop = monFeed(sel) ? (again ? keep : 0) : stick ? box.scrollHeight : keep;
    edgeFade(box);
  }
  convTitle();
  monSeen();
}
$("#mon-timeline").addEventListener("scroll", () => edgeFade($("#mon-timeline")), { passive: true });
setInterval(() => { if ((current === "monitoring" || monCtx) && !document.hidden) loadMonitors(); }, 60_000);
loadMonitors();
