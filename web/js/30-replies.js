/* ---------- 모니터링 > 답장 대기: every reply that waits for the owner, of every app and every computer, as one list ---------- */
// The prototype's #queue (site/prototype/s-queue.js) on the app's own notice-row classes: tabs 전체 · 답 필요 · 실패 · 보낸 것 with counts, a sticky head with
// 빠른 처리, sections 실패 / 답 필요 / 보낸 것 (failures first, the same app and reason folded into one row with 모두 다시 보내기), and a row that opens ONE sheet
// holding the reply card (10-reply-card.js rqCardOf). Sources: the send-approval notices with a draft of this computer and of the others (their snapshots,
// 34-peer-monitoring.js), the drafts an app keeps in its own store, and the held / hand-written cards of GET /api/approvals (TR.groups, 30-triage.js);
// GET /api/replies adds failed, sent (today) and stops (why an enabled rule did not send a draft). Each peer snapshot carries the same.
// The stop reason of a row is real data only: failed.why, else stops[ref], draft.warning, recipientWarning, the first draft.decide, a comment note; none -> no tag.
// rqWaiting() (답 필요 + 실패) is the ONE number: #nav-mon, the tab counts, the list row and 홈 read it. An action runs on the computer that holds the item, once:
// a notice through its answer path (answerInline / ntPost, a peer's through /api/peer/act), a store draft through its app's route or the peer act, a held card
// through trPost. 모두 다시 보내기 hands back only sends the owner already approved and that failed, each by its own route; nothing else sends from here.
// Reached from 홈 답장 대기, the app rows' 답장 대기 button, the chat's 답장 초안 line and the list row itself; the row shows only while something waits (or it is open).
const RQ = { local: [], failed: [], done: [], stops: {}, loaded: false, app: "", tab: "all", edit: "", note: {}, busy: new Set(), gone: new Set(), just: new Map(), fold: new Set(), cur: "", sheet: null, shSig: "", rows: null, t: 0 };   // just: a store draft just sent stays as its card, 보냈어요 in the action row's place, until the queue is opened again
const RQ_KEY = "replies";

async function rqLoad() {
  try {
    const r = await api("/api/replies");
    RQ.local = Array.isArray(r.items) ? r.items : [];
    RQ.failed = Array.isArray(r.failed) ? r.failed : [];
    RQ.done = Array.isArray(r.sent) ? r.sent : [];
    RQ.stops = r.stops && typeof r.stops === "object" ? r.stops : {};
  } catch { RQ.local = RQ.local || []; }
  RQ.loaded = true;
  monSchedule(); homeSoon(); rqSheetPaint(); paintDecision();
}
const rqSoon = () => { clearTimeout(RQ.t); RQ.t = setTimeout(rqLoad, 400); };

// The apps of this computer and of the others, with their notices (a peer's as copies carrying its computer, like pqMerge's rows).
function rqApps() {
  const out = INTG.items.map(it => ({ inst: it.key, label: it.label, pc: null, notices: (it.notices || []).map(ntById).filter(Boolean) }));
  for (const p of PQ.list) {
    if (!p || !p.items) continue;
    const pc = pqPcOf(p), sn = p.items.notices || [];
    for (const it of p.items.integrations || []) out.push({ inst: it.key, label: it.label, pc, notices: (it.notices || []).map(id => sn.find(n => String(n.id) === String(id))).filter(Boolean).map(n => ({ ...n, pc })) });
  }
  return out;
}
const rqPcKey = pc => (pc ? pc.url : "");
const rqPcName = pc => (pc ? pc.name : pqSelf());
const rqFilterKey = (pc, inst) => `${rqPcKey(pc)}|${inst}`;
// Every waiting draft, newest first: one per mail (the newest draft of a mail replaces the older), a store draft a notice already shows left out by the hub,
// and the held / hand-written cards of TR.groups that no entry above already shows (answered through trPost).
function rqAll() {
  const apps = rqApps(), out = [];
  // A send approval no app of this computer lists (the assistant's own) is still a waiting card: it joins as an app-less group.
  const owned = new Set(apps.filter(a => !a.pc).flatMap(a => a.notices.map(n => n.id))), loose = NT.items.filter(n => n.decision && n.decision.draft && !owned.has(n.id));
  if (loose.length) apps.push({ inst: "", label: "", pc: null, notices: loose });
  const labelOf = (pc, inst) => (apps.find(a => rqPcKey(a.pc) === rqPcKey(pc) && a.inst === inst) || {}).label || "";
  for (const a of apps) {
    const newest = mailDraftLive(a.notices);
    for (const n of newest.values()) {
      if (!mailDraftOpen(n) || n.ignored) continue;
      out.push({ key: `n:${rqPcKey(a.pc)}|${n.id}`, kind: "notice", inst: a.inst, label: a.label, pc: a.pc, at: ntAt(n), n });
    }
  }
  const store = [...RQ.local.map(d => ({ d, pc: null })), ...PQ.list.filter(p => p && p.items).flatMap(p => (p.items.replies || []).map(d => ({ d, pc: pqPcOf(p) })))];
  for (const { d, pc } of store) {
    if (!d || (d.kind !== "kakao" && d.kind !== "comment") || !d.code) continue;
    out.push({ key: `${d.kind}:${rqPcKey(pc)}|${d.code}`, kind: d.kind, inst: d.app || d.kind, label: labelOf(pc, d.app || d.kind), pc, at: Number(d.at) || 0, d });
  }
  const listed = new Set(out.map(x => (x.kind === "notice" ? x.n.decision.draft.ref : x.d.code)).filter(Boolean)), notices = new Set(out.filter(x => x.n).map(x => x.n.id));
  for (const g of TR.groups) for (const c of g.cards) if (!listed.has(c.ref) && !(c.notice && notices.has(c.notice)) && !out.some(x => x.key === `t:${c.to}|${c.ref}`))
    out.push({ key: `t:${c.to}|${c.ref}`, kind: "held", inst: g.key, label: g.label, pc: null, at: 0, tr: c });
  const seen = new Set();
  return out.filter(x => !RQ.gone.has(x.key) && !seen.has(x.key) && seen.add(x.key)).sort((a, b) => b.at - a.at);
}

/* ---- the rows ---- */
const RQ_SENT = { owner: "확인 후 발송", rule: "자동 발송", retry: "다시 보냄" };   // the prototype's words by `how`
const RQ_TONE = { ask: "warn", fail: "err", sent: "ok" };
const rqNorm = v => String(v || "").replace(/^확인:\s*/, "").trim();
// The computer's own failed / sent / stops, or a peer's snapshot copy (an older peer leaves them out).
const rqPeerItems = pc => (PQ.list.find(p => p && p.url === pc.url) || {}).items || {};
const rqStopsOf = pc => (pc ? rqPeerItems(pc).stops : RQ.stops) || {};
// Why an ask row stopped: the first that exists, never invented.
function rqAskWhy(x) {
  const dr = x.kind === "notice" ? x.n.decision.draft : x.kind === "held" ? x.tr.draft : null, d = x.d, src = dr || d || {}, ref = dr ? dr.ref : d && d.code;
  return [rqStopsOf(x.pc)[ref], src.warning, src.recipientWarning, (src.decide || [])[0], ((d && d.notes) || [])[0]].map(rqNorm).find(Boolean) || "";
}
const rqRefOf = x => (x.kind === "notice" ? x.n.decision.draft.ref : x.kind === "held" ? x.tr.ref : x.d.code);
function rqAskRow(x) {
  const o = rqOriginalOf(x), dr = x.kind === "notice" ? x.n.decision.draft : x.kind === "held" ? x.tr.draft : null;
  const who = x.kind === "notice" ? (o && o.who) || (dr && dr.to) || "" : x.kind === "held" ? (dr && dr.to) || "" : x.kind === "kakao" ? x.d.room || "" : (x.d.original && x.d.original.who) || x.d.to || "";
  const what = x.kind === "notice" ? ntPlain(x.n.title).replace(/\s*\([^()]*\)\s*$/, "") : x.kind === "held" ? draftQ(x.tr.question) : x.kind === "kakao" ? "카카오톡 답장" : x.d.title || "";
  return { key: x.key, state: "ask", who, what, inst: x.inst, app: x.label || rqAppName(x.inst), pc: x.pc, at: x.at, why: rqAskWhy(x), x };
}
// Every row of the screen: ask (rqAll), fail and sent (this computer's and the peers'), failures first. A failed send whose draft still waits shows once, as the failure,
// unless the draft came back after it (a new card of the same ref): that one is what waits on the owner.
function rqRows() {
  const apps = rqApps(), labelOf = (pc, inst) => (apps.find(a => rqPcKey(a.pc) === rqPcKey(pc) && a.inst === inst) || {}).label || rqAppName(inst) || "";
  const from = [[null, RQ.failed, RQ.done], ...PQ.list.filter(p => p && p.items).map(p => [pqPcOf(p), p.items.failed || [], p.items.sent || []])];
  const fail = [], sent = [];
  for (const [pc, failed, done] of from) {
    for (const f of failed) { const key = `f:${rqPcKey(pc)}|${f.key}`; if (!RQ.gone.has(key)) fail.push({ key, state: "fail", who: f.who || "", what: f.what || "", inst: f.app, app: labelOf(pc, f.app), pc, at: f.at, why: rqNorm(f.why), f }); }
    for (const s of done) sent.push({ key: `s:${rqPcKey(pc)}|${s.key}`, state: "sent", who: s.who || "", what: s.what || "", inst: s.app, app: labelOf(pc, s.app), pc, at: s.at, why: RQ_SENT[s.how] || "", s });
  }
  const failedAt = new Map(fail.filter(r => r.f.ref).map(r => [r.f.ref, r.at || 0]));
  const waiting = rqAll().filter(x => !failedAt.has(rqRefOf(x)) || x.at > failedAt.get(rqRefOf(x))), back = new Set(waiting.map(rqRefOf).filter(r => failedAt.has(r))), byAt = (a, b) => (b.at || 0) - (a.at || 0);
  return [...fail.filter(r => !back.has(r.f.ref)).sort(byAt), ...waiting.map(rqAskRow), ...sent.sort(byAt)];
}
// The one number: what waits on the owner (답 필요 + 실패 as the screen shows them), of every computer.
const rqWaiting = () => rqRows().filter(r => r.state !== "sent").length;
const rqAskCount = () => rqRows().filter(r => r.state === "ask").length;

// The 모니터링 list row (monItems, 30-monitoring.js): under 감시 소식, only while something waits or the queue is open.
function rqMonItem() {
  const rows = rqRows().filter(r => r.state !== "sent"), n = rows.length;
  if (!n && MON.sel !== RQ_KEY) return null;
  const names = [...new Set(rows.map(r => rqAppName(r.inst) || r.app).filter(Boolean))], at = Math.max(0, ...rows.map(r => r.at || 0));
  return { key: RQ_KEY, group: "", name: "답장 대기", ic: "send", notices: [], mails: [], unread: n, rq: true,
    hint: n ? `${names.slice(0, 3).join(" · ")} 답장 ${n}건` : "기다리는 답장이 없어요", at: at ? new Date(at).toISOString() : "" };
}
// Opens the queue, filtered to one app of one computer when given (an app's own 답장 대기 button).
function rqOpen(inst, pc) { RQ.just.clear(); RQ.app = inst ? rqFilterKey(pc || null, inst) : ""; MON.sig = ""; go("monitoring", RQ_KEY); }

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
    send: () => rqRun(x, async () => {
      await rqStoreCall(x, "send");
      RQ.just.set(x.key, x);
      const foot = [...document.querySelectorAll(".rq[data-rq] .rq-acts")].find(f => f.closest(".rq").dataset.rq === x.key), node = rqSentNode();
      if (foot) motionSwap(node, () => foot.replaceWith(node));
      rqAfter(x, false);
    }),
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
      else if (x.kind === "held") await trPost([{ ref: x.tr.ref, to: x.tr.to, n: 2, note: change }]);
      else await rqStoreCall(x, "revise", { change });
      cancel(); rqAfter(x, false);
      toast("고쳐 달라고 했어요. 새 초안이 오면 여기 다시 떠요");
    }) });
}
function rqOriginalOf(x) {
  if (x.kind === "held") return null;
  if (x.kind !== "notice") return x.d.original ? { who: x.d.original.who, text: x.d.original.text, ref: x.d.ref } : null;
  const d = x.n.decision, m = String(d.to || "").startsWith("mail:") ? MAILS.get(d.to) : null, src = { ref: d.draft.ref, t: d.to };   // ref: 원문 보기 loads the full original
  if (m) return { who: mailSender(m.from), text: m.subject || mailBrief(m, d.to), ...src };
  if (d.draft.origin && d.draft.origin.text) return { who: "", text: d.draft.origin.text, ...src };
  return d.draft.ref ? { who: "", text: d.draft.subject || "", ...src } : null;
}
function rqCardOf(x) {
  if (x.kind === "held") return rqHeldCard(x);
  const dr = x.kind === "notice" ? x.n.decision.draft : null;
  const head = { app: x.inst, label: x.label, pc: rqPcName(x.pc), model: (dr && dr.model) || (x.d && x.d.model) || "", at: x.at, tail: [el("button", { class: "btn text rq-open", type: "button", "data-k": "open", text: "열기", onclick: () => rqGoTo(x) })] };
  const editing = RQ.edit === x.key, busy = rqIsBusy(x), base = { key: x.key, cls: busy ? "busy" : "", attrs: { "data-rq": x.key, "data-kind": x.kind }, head, original: rqOriginalOf(x) };
  if (x.kind === "notice") {
    // The mail draft's own 첨부 줄 (files, or 첨부: 없음) is editable in its conversation and read-only here; anything else says it cannot attach.
    const attach = dr.toLabel === "받는이" ? draftFilesNode(dr, { t: x.n.decision.to, edit: false }) : { attachments: dr.attachments, cannotAttach: [] };
    // The 받는이·참조 of a mail draft are read here as they are on its card; the queue does not edit them (its mail's own card does).
    const recv = dr.toLabel === "받는이" || !dr.toLabel ? draftToNode(dr, { t: x.n.decision.to, edit: false }) : null;
    return rqCard({ ...base, ...(recv ? { recv } : { to: [dr.toLabel || "받는이", dr.to] }), subject: dr.subject, body: { text: dr.body }, attach,
      extra: [draftMailNode(dr.mail)],
      ...(editing ? { revise: rqRevise(x) } : { acts: { ...rqNoticeActs(x), busy } }) });
  }
  const d = x.d, kakao = x.kind === "kakao";
  if (!kakao) { const an = rqAppName(x.inst); head.who = (d.original && d.original.who) || d.to || ""; head.src = an.endsWith("댓글") ? an : `${an || "답장"} 댓글`; }   // a comment draft: the landing card's head
  return rqCard({ ...base, label: kakao && d.intent ? "새 메시지 초안" : "", to: kakao ? ["대화방", d.room] : ["댓글", d.to], subject: kakao ? "" : d.title,
    body: { text: d.text, parts: kakao ? d.parts : null, sentParts: d.sentParts },
    attach: d,
    extra: kakao ? [] : [draftMailNode(d.mail), (d.notes || []).length ? el("div", { class: "kk-note", role: "status", text: d.notes.join(" / ") }) : null],
    ...(RQ.just.has(x.key) ? { sent: true } : editing ? { revise: rqRevise(x) } : { acts: { ...rqStoreActs(x), busy } }) });
}
// 열기: where the draft lives, on its own screen (the mail's conversation, the app's pane).
function rqGoTo(x) {
  if (x.kind === "notice" && String(x.n.decision.to || "").startsWith("mail:")) { go("monitoring", `c:${x.n.decision.to}`); return; }
  go("monitoring", x.pc ? `p:${x.pc.url}|i:${x.inst}` : `i:${x.inst}`);
}

/* ---- the held cards, a failed send and a sent one as the same reply card ---- */
function rqHeldCard(x) {
  const c = x.tr, dr = c.draft || {}, busy = rqIsBusy(x);
  const go = (n, note) => rqRun(x, async () => {
    await trPost([{ ref: c.ref, to: c.to, n, ...(note ? { note } : {}) }]);
    if (n !== 2) RQ.gone.add(x.key);
    trSoon(); rqSoon();
    if (n === 1) rqSentToast(); else if (n === 3) rqDroppedToast();
  });
  const acts = { send: () => { if (dr.warning || (dr.attachments || []).length) drfSure(dr, c.to).then(ok => ok && go(1)); else go(1); }, edit: () => { RQ.edit = x.key; MON.sig = ""; monSchedule(); }, drop: () => go(3), busy };
  return rqCard({ key: x.key, cls: busy ? "busy" : "", attrs: { "data-rq": x.key, "data-kind": "held" }, head: { app: x.inst, label: x.label, pc: rqPcName(null), model: dr.model || "", at: 0 }, to: [dr.toLabel || "받는이", dr.to], subject: dr.subject,
    body: { text: dr.body }, attach: { attachments: dr.attachments, cannotAttach: [] }, extra: [draftMailNode(dr.mail)], ...(RQ.edit === x.key ? { revise: rqRevise(x) } : { acts }) });
}
// The record of a failed or a sent reply (hub/reply-outcomes.ts) in the one reply card; foot = its own { revise } (the failed actions) or { sent, sentAt }.
function rqRecordCard(r, rec, foot) {
  const kind = rec.kind, o = rec.original;
  return rqCard({ key: r.key, cls: RQ.busy.has(r.key) ? "busy" : "", attrs: { "data-rq": r.key, "data-kind": kind }, head: { app: r.inst, label: r.app, pc: rqPcName(r.pc), at: rec.at },
    original: o ? { who: o.who, text: o.text } : null, to: rec.who ? [kind === "kakao" ? "대화방" : kind === "comment" ? "댓글" : "받는이", rec.who] : null, subject: kind === "comment" ? rec.what : "",
    body: { text: rec.text }, attach: el("div", { hidden: true }), ...foot });
}
const rqFailActs = r => el("div", { class: "dr-act dr-row rq-acts" },
  el("button", { class: "btn sm dr-send", type: "button", "data-k": "retry", disabled: RQ.busy.has(r.key), text: "다시 보내기", onclick: () => rqRetryAll([r]) }),
  el("button", { class: "btn text sm dr-drop", type: "button", "data-k": "drop", disabled: RQ.busy.has(r.key), text: "보내지 않기", onclick: () => rqDropFailed(r) }));

/* ---- failed sends: only what the owner already approved, each by its own route ---- */
// This computer's route, or the other computer's act (hub/peer-monitor.ts "comments" / "kakao" / "approvals").
const rqSendIt = (pc, path, body, act, args) => (pc ? api(pqProxy(pc, "/api/peer/act"), "POST", { action: act, args }) : api(path, "POST", body));
async function rqRunKey(key, job) {
  if (RQ.busy.has(key)) return;
  RQ.busy.add(key); MON.sig = ""; monSchedule(); rqSheetPaint();
  try { await job(); } catch (e) { toast(e instanceof TypeError ? "연결이 끊겨 처리하지 못했어요" : e.message, true); }
  RQ.busy.delete(key); MON.sig = ""; monSchedule(); rqSheetPaint();
}
// 다시 보내기 / 모두 다시 보내기: a comment reply and a KakaoTalk send by their own retry, a mail or gateway send through POST /api/approvals/failed (the owner's pick is
// read back there and refused when it is not a send), once per computer. A refusal is counted and toasted; what stays failed stays listed.
function rqRetryAll(rows, key) {
  return rqRunKey(key || rows[0].key, async () => {
    const bad = [], batch = new Map(), app = rqAppName(rows[0].inst) || rows[0].app;
    for (const r of rows) {
      const f = r.f;
      try {
        if (f.kind === "comment" && f.sendId) await rqSendIt(r.pc, `/api/comments/sends/${enc(f.sendId)}/retry`, {}, "comments", { op: "send-retry", id: f.sendId });
        else if (f.kind === "kakao") await rqSendIt(r.pc, `/api/kakao/chat/${enc(f.chatId)}/send/${enc(f.sendId)}/retry`, {}, "kakao", { op: "send-retry", chatId: f.chatId, sendId: f.sendId });
        else { const k = rqPcKey(r.pc), cur = batch.get(k); batch.set(k, { pc: r.pc, items: [...(cur ? cur.items : []), { ref: f.ref, to: f.conv || "" }] }); }
      } catch (e) { bad.push(e.message); }
    }
    for (const { pc, items } of batch.values()) {
      const body = { op: "retry", items };
      try { const res = await rqSendIt(pc, "/api/approvals/failed", body, "approvals", body); for (const x of (res && res.results) || []) if (!x.ok) bad.push(x.reason || "다시 보내지 못했어요"); }
      catch (e) { bad.push(...items.map(() => e.message)); }
    }
    toast(bad.length ? `${bad.length}건은 다시 보내지 못했어요 · ${bad[0]}` : `${app} ${rows.length}건을 다시 보내고 있어요`, bad.length > 0);
    if (rows.some(r => r.pc)) pqLoad();
    rqLoad();
  });
}
// 보내지 않기 of a failed send: the draft is dropped by its own route and leaves the list.
function rqDropFailed(r) {
  const f = r.f;
  return rqRunKey(r.key, async () => {
    if (f.kind === "kakao") await rqSendIt(r.pc, `/api/kakao/drafts/${enc(f.ref)}/drop`, {}, "kakao", { op: "draft-drop", code: f.ref });
    else {
      const body = { op: "drop", items: [{ ref: f.ref, to: f.conv || "" }] }, res = await rqSendIt(r.pc, "/api/approvals/failed", body, "approvals", body), x = ((res && res.results) || [])[0];
      if (x && !x.ok) throw new Error(x.reason || "지우지 못했어요");
    }
    RQ.gone.add(r.key); rqDroppedToast();
    if (r.pc) pqLoad();
    rqLoad(); loadIntegrations();
  });
}

/* ---- the screen ---- */
const RQ_TABS = [["all", "전체"], ["ask", "답 필요"], ["fail", "실패"], ["sent", "보낸 것"]];
const RQ_SECS = [["fail", "실패"], ["ask", "답 필요"], ["sent", "보낸 것"]];
const RQ_EMPTY = { all: "기다리는 답장이 없어요", ask: "답을 기다리는 초안이 없어요", fail: "못 보낸 답장이 없어요", sent: "오늘 보낸 답장이 없어요" };
const RQ_UI = {};
// The sticky head (tabs, meta row with 빠른 처리, the app chips) and the list box are built once and repainted in place, so scroll, focus and the counts' roll survive.
function rqUi() {
  if (RQ_UI.hd) return RQ_UI;
  const tabs = el("div", { class: "nsc-f rq-tabs", role: "tablist", "aria-label": "답장 상태" }, ...RQ_TABS.map(([k, l]) =>
    el("button", { class: "nsc-fb", type: "button", role: "tab", "data-f": k, onclick: () => rqTab(k) }, l, el("span", { class: `n${k === "fail" ? " err" : ""}`, "data-n": k }))));
  const mt = el("span", { class: "meta" }), fast = el("button", { class: "btn tonal sm rq-fast", type: "button", "data-k": "triage", onclick: () => trOpen("*") }, icon("spark"), el("span", { text: "빠른 처리" }));
  const meta = el("div", { class: "nsc-m rq-qm" }, mt, el("span", { class: "sp" }), fast), chips = el("div", { class: "rq-chips" });
  return Object.assign(RQ_UI, { hd: el("div", { class: "rq-hd2" }, tabs, meta, chips), tabs, mt, fast, meta, chips, ls: el("div", { class: "rq-ls" }), seq: 0 });
}
function rqTab(k) {
  if (RQ.tab === k) return;
  RQ.tab = k; RQ.now = true;
  motionSwap(rqUi().ls, () => { MON.sig = ""; renderMonitoring(); });
  const box = $("#mon-timeline"); if (box) box.scrollTop = 0;
}
function rqFold(key) {
  const open = !RQ.fold.has(key);
  if (open) RQ.fold.add(key); else RQ.fold.delete(key);
  RQ.now = true; MON.sig = ""; renderMonitoring();
  if (open) for (const k of rqUi().ls.querySelectorAll("[data-kid]")) if (k.dataset.kid === key) motionIn(k, "top");
}
// The app chips: shown while one app is picked (an app row's 답장 대기 button), to get back to 전체.
function rqFilterBar(rows) {
  const by = new Map();
  for (const r of rows) { if (r.state === "sent") continue; const k = rqFilterKey(r.pc, r.inst), cur = by.get(k); by.set(k, { n: (cur ? cur.n : 0) + 1, text: `${r.app || rqAppName(r.inst)}${r.pc ? ` · ${r.pc.name}` : ""}` }); }
  if (RQ.app && !by.has(RQ.app)) RQ.app = "";
  const chip = (k, text, n) => el("button", { class: `cchip mr-f${RQ.app === k ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(RQ.app === k), "data-filter": k || "all", onclick: () => { RQ.app = k; MON.sig = ""; monSchedule(); } }, text, n ? el("span", { class: "mr-fn", text: String(n) }) : null);
  return RQ.app ? el("div", { class: "mr-filter rq-filter", role: "tablist", "aria-label": "앱별 답장" }, chip("", "전체", [...by.values()].reduce((c, v) => c + v.n, 0)), ...[...by].map(([k, v]) => chip(k, v.text, v.n))) : null;
}
// 방금 / N분 전 within the hour, as the prototype's rows, then the plain time.
const rqWhen = at => { const m = at ? Math.floor((Date.now() - at) / 60_000) : -1; return !at ? "" : m < 1 ? "방금" : m < 60 ? `${m}분 전` : rcWhen(new Date(at).toISOString()); };
// One row, the notice row's own classes: the state dot, who and the time, then "앱 · 무엇" with the tag (the stop reason, or how a sent one went).
function rqRowNode(r, kid) {
  const at = rqWhen(r.at), head = r.who || r.what || r.app, sub = [r.app, r.who ? r.what : ""].filter(Boolean).join(" · ");
  return el("div", { class: `li nsc-r rq-r ${r.state}`, "data-qr": r.key, ...(kid ? { "data-kid": kid } : {}) },
    el("span", { class: "lead" }, el("span", { class: `dot ${RQ_TONE[r.state]}` })),
    el("button", { class: "tx nsc-tx", type: "button", onclick: () => rqSheetOpen(r) },
      el("span", { class: "ln" }, el("span", { class: "hd", text: head }), at ? el("span", { class: "t", text: at }) : null),
      sub || r.why ? el("span", { class: "ln" }, sub ? el("span", { class: "nsc-s", text: sub }) : null, r.why ? el("span", { class: `tag${r.state === "fail" ? " err" : ""}`, text: r.why }) : null) : null));
}
// 2 or more failures of one app with the same reason fold into one row; the others stay plain rows.
function rqFailNodes(rows) {
  const by = new Map(), out = [];
  for (const r of rows) { const k = `${rqPcKey(r.pc)}|${r.inst}|${r.why}`; if (r.why) by.set(k, [...(by.get(k) || []), r]); }
  const done = new Set();
  for (const r of rows) {
    const k = `${rqPcKey(r.pc)}|${r.inst}|${r.why}`, g = r.why ? by.get(k) : null;
    if (!g || g.length < 2) { out.push(rqRowNode(r)); continue; }
    if (done.has(k)) continue;
    done.add(k);
    const open = RQ.fold.has(k), busy = RQ.busy.has(k);
    out.push(el("div", { class: "li nsc-r rq-r rq-g fail", "data-qg": k },
      el("span", { class: "lead" }, el("span", { class: `dot ${busy ? "pri" : "err"}` })),
      el("button", { class: "tx nsc-tx", type: "button", "aria-expanded": String(open), onclick: () => rqFold(k) },
        el("span", { class: "ln" }, el("span", { class: "hd", text: `${rqAppName(r.inst) || r.app} ${g.length}건을 못 보냈어요` })),
        el("span", { class: "ln" }, el("span", { class: "nsc-s", text: busy ? "다시 보내는 중" : r.why }))),
      el("button", { class: "btn tonal sm rq-retry", type: "button", "data-k": "retry-all", disabled: busy, text: "모두 다시 보내기", onclick: () => rqRetryAll(g, k) }),
      el("span", { class: "nsc-tr", "aria-hidden": "true" }, icon("drop"))), ...(open ? g.map(x => rqRowNode(x, k)) : []));
  }
  return out;
}
function rqPaintHead(rows) {
  const u = rqUi(), n = { ask: 0, fail: 0, sent: 0 };
  for (const r of rows) n[r.state]++;
  for (const b of u.tabs.children) {
    const k = b.dataset.f, on = RQ.tab === k;
    b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on));
    rollCount(b.querySelector(".n"), k === "all" || !n[k] ? "" : String(n[k]));
  }
  const fast = (RQ.tab === "all" || RQ.tab === "ask") && n.ask >= TR.min, apps = new Set(rows.filter(r => r.state === "ask").map(r => rqFilterKey(r.pc, r.inst))).size;
  const text = fast ? `앱 ${apps}곳에서 ${n.ask}건 기다려요` : RQ.tab === "sent" && n.sent ? `오늘 보낸 답장 ${n.sent}건` : "";
  u.mt.textContent = text; u.fast.hidden = !fast; u.meta.hidden = !text;
}
function rqPaintList(rows) {
  const u = rqUi(), shown = RQ.tab === "all" ? rows : rows.filter(r => r.state === RQ.tab);
  const build = () => {
    const nodes = [];
    if (!shown.length) nodes.push(el("div", { class: "list" }, el("div", { class: "empty", text: RQ.loaded || NT.loaded ? RQ_EMPTY[RQ.tab] : "불러오는 중…" })));
    else for (const [s, label] of RQ_SECS) {
      const part = shown.filter(r => r.state === s);
      if (!part.length) continue;
      if (RQ.tab === "all") nodes.push(el("div", { class: "sec" }, label, " ", el("span", { class: "meta", text: `${part.length}건` })));
      nodes.push(el("div", { class: "list rq-list" }, ...(s === "fail" ? rqFailNodes(part) : part.map(r => rqRowNode(r)))));
    }
    return nodes;
  };
  const apply = () => {
    const at = document.activeElement, f = at && u.ls.contains(at) ? at.closest("[data-qr],[data-qg]") : null, fk = f ? (f.dataset.qr ? ["qr", f.dataset.qr] : ["qg", f.dataset.qg]) : null;
    clear(u.ls).append(...build());
    u.ls.dataset.on = "1";
    if (fk) { const n = [...u.ls.querySelectorAll(`[data-${fk[0]}]`)].find(e => e.dataset[fk[0]] === fk[1]); const b = n && n.querySelector(".tx"); if (b) b.focus({ preventScroll: true }); }
  };
  // Rows that left (answered, sent again, dropped) fade out first; a tab change or a fold redraws at once.
  const keys = new Set(shown.map(r => r.key)), gone = RQ.now || !u.ls.dataset.on ? [] : [...u.ls.querySelectorAll("[data-qr]")].filter(n => !keys.has(n.dataset.qr));
  RQ.now = false;
  const seq = ++u.seq;
  if (gone.length) Promise.all(gone.map(n => motionOut(n))).then(() => { if (u.seq === seq) apply(); });
  else apply();
}
function rqPaint(rows) {
  const u = rqUi(), bar = rqFilterBar(rows), mine = RQ.app ? rows.filter(r => rqFilterKey(r.pc, r.inst) === RQ.app) : rows;
  clear(u.chips).append(...(bar ? [bar] : []));
  rqPaintHead(mine); rqPaintList(mine);
  rqSheetPaint();
}
// The nodes of the screen: the sticky head, then the list.
function rqNodes() { rqPaint(RQ.rows || rqRows()); return [rqUi().hd, rqUi().ls]; }

/* ---- the sheet: ONE sheet for every row, holding the reply card (10-reply-card.js) with the why line on top ---- */
function rqSheetOpen(r) {
  if (RQ.sheet) RQ.sheet.close(false);
  RQ.cur = r.key; RQ.shSig = "";
  const h = fsOpen({ label: "답장 확인", cls: "mid rq-sheet", onClose: () => { if (RQ.sheet === h) { RQ.sheet = null; RQ.cur = ""; } } });
  RQ.sheet = h;
  rqSheetPaint(r);
}
function rqSheetPaint(found) {
  const h = RQ.sheet;
  if (!h) return;
  const r = found || rqRows().find(x => x.key === RQ.cur) || (RQ.just.has(RQ.cur) ? rqAskRow(RQ.just.get(RQ.cur)) : null);
  if (!r) { h.close(false); return; }   // its item left: answered, sent, dropped
  const sig = JSON.stringify([r.state, r.why, rqXSig(r), RQ.edit === r.key, RQ.busy.has(r.key), RQ.just.has(r.key)]);
  if (sig === RQ.shSig) return;
  RQ.shSig = sig;
  const card = r.state === "ask" ? rqCardOf(r.x) : r.state === "fail" ? rqRecordCard(r, r.f, { revise: rqFailActs(r) }) : rqRecordCard(r, r.s, { sent: true, sentAt: rqWhen(r.at) || "방금" });
  // A comment's note already stands in its card: the why line does not say it twice.
  const said = r.x && r.x.d && (r.x.d.notes || []).some(n => rqNorm(n) === r.why);
  const body = el("div", { class: "rq-sb" }, r.why && r.state !== "sent" && !said ? el("div", { class: "note rq-why", role: "note", text: r.why }) : null, card), old = h.box.querySelector(".rq-sb");
  if (!h.box.querySelector(".fs-hd")) h.box.append(fsHead([el("div", { class: "fs-t", text: "답장 확인" })], { close: () => h.close() }));
  if (old) old.replaceWith(body); else h.box.append(body);
}
// What a row shows beyond its text: a draft's own state (redrawn when it changes; typing in 고치기 changes none of it).
const rqXSig = r => (r.x ? (r.x.kind === "notice" ? [r.x.n.decision.state, r.x.n.decision.draft, dcSending.has(r.x.n.id)] : r.x.kind === "held" ? [r.x.tr.draft, r.x.tr.sendable] : r.x.d) : r.f || r.s);
// What the screen shows; it is redrawn only when this changes.
function rqSig() {
  const rows = (RQ.rows = rqRows());
  return JSON.stringify([RQ.app, RQ.tab, RQ.edit, [...RQ.busy], [...RQ.just.keys()], [...RQ.fold], TR.min, RQ.loaded, rows.map(r => [r.key, r.state, r.at, r.who, r.what, r.app, r.why, rqXSig(r)])]);
}
rqLoad();
