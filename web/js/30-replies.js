/* ---------- 모니터링 > 답장 확인: every reply draft that waits for 보내기, of every app and every computer, in one list ---------- */
// Sources: the send-approval notices with a draft (mail, and the bot's KakaoTalk or comment drafts) of this computer and of the other ones (their
// snapshots, 34-peer-monitoring.js), and the drafts an app keeps in its own store: GET /api/replies here (hub/routes.ts) and `replies` in each
// peer snapshot. Newest first, each drawn as the one reply card (10-reply-card.js). An action runs on the computer that holds the draft, once:
// a notice through its answer path (answerInline / ntPost, a peer's through /api/peer/act), a store draft through its app's route or the peer act.
// Reached from 홈 답장 대기, the app rows' 답장 확인 button and the list row itself; the row shows only while something waits (or it is open).
const RQ = { local: [], loaded: false, app: "", edit: "", note: {}, busy: new Set(), gone: new Set(), t: 0 };
const RQ_KEY = "replies";

async function rqLoad() {
  try {
    const r = await api("/api/replies");
    RQ.local = Array.isArray(r.items) ? r.items : [];
  } catch { RQ.local = RQ.local || []; }
  RQ.loaded = true;
  monSchedule(); homeSoon();
}
const rqSoon = () => { clearTimeout(RQ.t); RQ.t = setTimeout(rqLoad, 400); };

// The apps of this computer and of the others, with their notices (a peer's as copies carrying its computer, like pqMerge's rows).
function rqApps() {
  const out = INTG.items.map(it => ({ inst: it.key, label: it.label, pc: null, notices: (it.notices || []).map(ntById).filter(Boolean) }));
  for (const p of PQ.list) {
    if (!p || !p.items) continue;
    const pc = { name: p.name, url: p.url }, sn = p.items.notices || [];
    for (const it of p.items.integrations || []) out.push({ inst: it.key, label: it.label, pc, notices: (it.notices || []).map(id => sn.find(n => String(n.id) === String(id))).filter(Boolean).map(n => ({ ...n, pc })) });
  }
  return out;
}
const rqPcKey = pc => (pc ? pc.url : "");
const rqPcName = pc => (pc ? pc.name : pqSelf());
const rqFilterKey = (pc, inst) => `${rqPcKey(pc)}|${inst}`;
// Every waiting draft, newest first: one per mail (the newest draft of a mail replaces the older), a store draft a notice already shows left out by the hub.
function rqAll() {
  const apps = rqApps(), out = [];
  const labelOf = (pc, inst) => (apps.find(a => rqPcKey(a.pc) === rqPcKey(pc) && a.inst === inst) || {}).label || "";
  for (const a of apps) {
    const newest = mailDraftLive(a.notices);
    for (const n of newest.values()) {
      if (!mailDraftOpen(n) || n.ignored) continue;
      out.push({ key: `n:${rqPcKey(a.pc)}|${n.id}`, kind: "notice", inst: a.inst, label: a.label, pc: a.pc, at: ntAt(n), n });
    }
  }
  const store = [...RQ.local.map(d => ({ d, pc: null })), ...PQ.list.filter(p => p && p.items).flatMap(p => (p.items.replies || []).map(d => ({ d, pc: { name: p.name, url: p.url } })))];
  for (const { d, pc } of store) {
    if (!d || (d.kind !== "kakao" && d.kind !== "comment") || !d.code) continue;
    out.push({ key: `${d.kind}:${rqPcKey(pc)}|${d.code}`, kind: d.kind, inst: d.app || d.kind, label: labelOf(pc, d.app || d.kind), pc, at: Number(d.at) || 0, d });
  }
  const seen = new Set();
  return out.filter(x => !RQ.gone.has(x.key) && !seen.has(x.key) && seen.add(x.key)).sort((a, b) => b.at - a.at);
}
const rqCount = () => rqAll().length;
const rqShown = list => (RQ.app ? list.filter(x => rqFilterKey(x.pc, x.inst) === RQ.app) : list);

// The 모니터링 list row (monItems, 30-monitoring.js): under 감시 소식, only while a draft waits or the queue is open.
function rqMonItem() {
  const list = rqAll();
  if (!list.length && MON.sel !== RQ_KEY) return null;
  const names = [...new Set(list.map(x => rqAppName(x.inst) || x.label).filter(Boolean))];
  return { key: RQ_KEY, group: "", name: "답장 확인", ic: "send", notices: [], mails: [], unread: list.length, rq: true,
    hint: list.length ? `${names.slice(0, 3).join(" · ")} 답장 ${list.length}건` : "확인할 답장이 없어요", at: list[0] ? new Date(list[0].at || Date.now()).toISOString() : "" };
}
// Opens the queue, filtered to one app of one computer when given (an app's own 답장 확인 button).
function rqOpen(inst, pc) { RQ.app = inst ? rqFilterKey(pc || null, inst) : ""; MON.sig = ""; go("monitoring", RQ_KEY); }

/* ---- one card ---- */
const rqIsBusy = x => RQ.busy.has(x.key) || (x.kind === "notice" && dcSending.has(x.n.id));
async function rqRun(x, job) {
  if (rqIsBusy(x)) return;
  RQ.busy.add(x.key); MON.sig = ""; monSchedule();
  try { await job(); } catch (e) { toast(e instanceof TypeError ? "연결이 끊겨 처리하지 못했어요" : e.message, true); }
  RQ.busy.delete(x.key); MON.sig = ""; monSchedule();
}
// A store draft's action on the computer that holds it: this gateway's own route, or that computer's act (hub/peer-monitor.ts "kakao" / "comments").
function rqStoreCall(x, op, extra = {}) {
  const d = x.d, kakao = x.kind === "kakao";
  if (x.pc) {
    const args = op === "revise" ? (kakao ? { op: "draft", chatId: d.chatId, revise: { code: d.code, change: extra.change } } : { op: "draft-revise", code: d.code, change: extra.change }) : { op: `draft-${op}`, code: d.code };
    return api(pqProxy(x.pc, "/api/peer/act"), "POST", { action: kakao ? "kakao" : "comments", args });
  }
  if (op === "revise") return kakao ? api(`/api/kakao/chat/${enc(d.chatId)}/draft`, "POST", { revise: { code: d.code, change: extra.change } }) : api(`/api/comments/drafts/${enc(d.code)}/revise`, "POST", { change: extra.change });
  return api(`/api/${kakao ? "kakao" : "comments"}/drafts/${enc(d.code)}/${op}`, "POST", {});
}
// After a change: the card leaves at once, then the list is read again where the draft lives (the peer proxy already re-read its snapshot).
function rqAfter(x, gone) {
  if (gone) RQ.gone.add(x.key);
  if (x.pc) pqLoad(); else rqLoad();
  loadIntegrations();
}
async function rqRestore(x) {
  try { await rqStoreCall(x, "restore"); RQ.gone.delete(x.key); rqAfter(x, false); toast("초안을 되돌렸어요"); } catch (e) { toast(e.message, true); }
}
function rqStoreActs(x) {
  return {
    send: () => rqRun(x, async () => { await rqStoreCall(x, "send"); rqAfter(x, true); rqSentToast(); }),
    edit: () => { RQ.edit = x.key; MON.sig = ""; monSchedule(); },
    drop: () => rqRun(x, async () => { await rqStoreCall(x, "drop"); rqAfter(x, true); rqDroppedToast(x.kind === "comment" && x.d.mail ? null : () => rqRestore(x)); }),
  };
}
function rqNoticeActs(x) {
  const n = x.n, d = n.decision, dr = d.draft, opt = k => d.options.find(o => o.label === k) || null, oSend = opt("보내기"), oDrop = opt("보내지 않기");
  return {
    send: oSend ? () => { if (dr.warning || (dr.attachments || []).length) drfSure(dr, d.to).then(ok => ok && answerInline(n, oSend)); else answerInline(n, oSend); } : null,
    edit: opt("고치기") ? () => { RQ.edit = x.key; MON.sig = ""; monSchedule(); } : null,
    drop: oDrop ? () => answerInline(n, oDrop) : null,
  };
}
function rqRevise(x) {
  const cancel = () => { RQ.edit = ""; delete RQ.note[x.key]; MON.sig = ""; monSchedule(); };
  return rqReviseNode({ value: RQ.note[x.key] || "", busy: rqIsBusy(x), onInput: v => { RQ.note[x.key] = v; }, cancel,
    go: change => rqRun(x, async () => {
      if (x.kind === "notice") { const o = x.n.decision.options.find(v => v.label === "고치기"); await ntPost(x.n, o.n, change); }
      else await rqStoreCall(x, "revise", { change });
      cancel(); rqAfter(x, false);
      toast("고쳐 달라고 했어요. 새 초안이 오면 여기 다시 떠요");
    }) });
}
function rqOriginalOf(x) {
  if (x.kind !== "notice") return x.d.original ? { who: x.d.original.who, text: x.d.original.text } : null;
  const d = x.n.decision, m = String(d.to || "").startsWith("mail:") ? MAILS.get(d.to) : null;
  if (m) return { who: mailSender(m.from), text: m.subject || mailBrief(m, d.to) };
  return d.draft.origin && d.draft.origin.text ? { who: "", text: d.draft.origin.text } : null;
}
function rqCardOf(x) {
  const dr = x.kind === "notice" ? x.n.decision.draft : null;
  const head = { app: x.inst, label: x.label, pc: rqPcName(x.pc), model: (dr && dr.model) || (x.d && x.d.model) || "", at: x.at, tail: [el("button", { class: "btn text rq-open", type: "button", "data-k": "open", text: "열기", onclick: () => rqGoTo(x) })] };
  const editing = RQ.edit === x.key, busy = rqIsBusy(x), base = { key: x.key, cls: busy ? "busy" : "", attrs: { "data-rq": x.key, "data-kind": x.kind }, head, original: rqOriginalOf(x) };
  if (x.kind === "notice") {
    // The mail draft's own 첨부 줄 (files, or 첨부: 없음) is editable in its conversation and read-only here; anything else says it cannot attach.
    const attach = dr.toLabel === "받는이" ? draftFilesNode(dr, { t: x.n.decision.to, edit: false }) : { attachments: dr.attachments, cannotAttach: [] };
    return rqCard({ ...base, to: [dr.toLabel || "받는이", dr.to], subject: dr.subject, body: { text: dr.body }, attach,
      extra: [draftMailNode(dr.mail)],
      ...(editing ? { revise: rqRevise(x) } : { acts: { ...rqNoticeActs(x), busy } }) });
  }
  const d = x.d, kakao = x.kind === "kakao";
  return rqCard({ ...base, label: kakao && d.intent ? "새 메시지 초안" : "", to: kakao ? ["대화방", d.room] : ["댓글", d.to], subject: kakao ? "" : d.title,
    body: { text: d.text, parts: kakao ? d.parts : null, sentParts: d.sentParts },
    attach: d,
    extra: kakao ? [] : [draftMailNode(d.mail), (d.notes || []).length ? el("div", { class: "kk-note", role: "status", text: d.notes.join(" / ") }) : null],
    ...(editing ? { revise: rqRevise(x) } : { acts: { ...rqStoreActs(x), busy } }) });
}
// 열기: where the draft lives, on its own screen (the mail's conversation, the app's pane).
function rqGoTo(x) {
  if (x.kind === "notice" && String(x.n.decision.to || "").startsWith("mail:")) { go("monitoring", `c:${x.n.decision.to}`); return; }
  go("monitoring", x.pc ? `p:${x.pc.url}|i:${x.inst}` : `i:${x.inst}`);
}

/* ---- the queue ---- */
function rqFilterBar(all) {
  const by = new Map();
  for (const x of all) { const k = rqFilterKey(x.pc, x.inst), cur = by.get(k); by.set(k, { n: (cur ? cur.n : 0) + 1, text: `${x.label || rqAppName(x.inst)}${x.pc ? ` · ${x.pc.name}` : ""}` }); }
  if (RQ.app && !by.has(RQ.app)) RQ.app = "";
  const chip = (k, text, n) => el("button", { class: `cchip mr-f${RQ.app === k ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(RQ.app === k), "data-filter": k || "all", onclick: () => { RQ.app = k; MON.sig = ""; monSchedule(); } }, text, n ? el("span", { class: "mr-fn", text: String(n) }) : null);
  return el("div", { class: "mr-filter rq-filter", role: "tablist", "aria-label": "앱별 답장" }, chip("", "전체", all.length), ...[...by].map(([k, v]) => chip(k, v.text, v.n)));
}
function rqNodes() {
  const all = rqAll(), list = rqShown(all);
  if (!all.length) return [el("div", { class: "empty", text: RQ.loaded || NT.loaded ? "확인할 답장이 없어요" : "불러오는 중…" })];
  return [rqFilterBar(all), el("div", { class: "rq-q" }, ...list.map(rqCardOf))];
}
// What the queue shows; it is redrawn only when this changes (typing in 고치기 changes none of it).
const rqSig = () => JSON.stringify([RQ.app, RQ.edit, [...RQ.busy], rqAll().map(x => [x.key, x.at, x.label, x.kind === "notice" ? [x.n.decision.state, x.n.decision.draft, dcSending.has(x.n.id)] : x.d])]);
rqLoad();
