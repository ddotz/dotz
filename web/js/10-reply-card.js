/* ---------- 답장 초안 카드: one card for every reply draft (메일, 카카오톡, 댓글) of every computer ---------- */
// One component under the queue card (10-reply-actions.js rqItemCard) that the 답장 대기 list, 빠른 처리, the KakaoTalk room and a comment thread
// draw, and under the mail list's 확인 대기 (30-monitoring.js draftCardNode): the same head (앱 · 계정 · 컴퓨터 · 모델 when known),
// the body clamped to about six lines with 펼치기, the 첨부 줄, and the same actions with the same words, 보내기 · 고치기 · 보내지 않기.
// Each caller passes what its actions do; the card never decides where a draft is sent.
const RQ_APPS = { mail: [TX("common.mail"), "mail"], kakao: [TX("decision.app.kakao"), "chat"], instagram: [TX("decision.app.instagram"), "chat"], youtube: [TX("decision.app.youtube"), "chat"], site: [TX("decision.app.site"), "chat"] };
const RQ_LINES = 6;
const RQ_OPEN = new Set();   // card keys whose long body was unfolded (펼치기); kept across repaints
// A press waits for its answer in the card itself: rqPress = the action in flight (its button says so, the others stay off in place), rqFail = the line a failed
// action leaves right above the buttons (never a toast over the card's rows). Both are keyed by the notice (rqNtKey); a queue item keeps its own (RA.busy, RA.fail).
const rqPress = new Map(), rqFail = new Map();
const RQ_PRESS = { send: TX("decision.pending.send"), fix: TX("decision.pending.revise"), drop: TX("decision.pending.drop") };
const rqNtKey = n => `nt:${n.id}`;
const rqFailOf = (e, act) => ((e && e.data) || {}).code === "changed" ? { text: TX("reply.changed"), code: "changed" } : ({ text: act === "send" ? (e instanceof TypeError ? TX("decision.fail.send_offline") : TX("decision.fail.send")) : e instanceof TypeError ? TX("decision.fail.act_offline") : TX("decision.fail.act"), why: e instanceof TypeError ? "" : String((e && e.message) || "") });   // changed: the hub refused a 보내기 of a version the card no longer shows
// The app key of an instance id ("mail-2" -> "mail", a peer's "kakao~h1" -> "kakao").
const rqBase = app => String(app || "").split("~")[0].split("-")[0];
const rqAppName = app => (RQ_APPS[rqBase(app)] || [""])[0];
// h: { app (instance id), label (the instance's own name), pc (computer name), model, at (ms or ISO), tail (nodes at the end) }
// ONE tight line (owner 2026-11-03): who the draft answers and where it came from, the state at the right. The author's initial is a small
// 20px mark, so the head never takes a second line and the original below it is the only thing that reads as a quote.
function rqHeadNode(h) {
  const [name, ic] = RQ_APPS[rqBase(h.app)] || [h.appName || TX("decision.reply"), "send"];
  const at = h.at ? new Date(h.at) : null, when = at && !isNaN(at) ? rcWhen(at.toISOString()) : "";
  const to = h.who ? TX("decision.rq.reply_to", { who: h.who }) : name, src = h.who ? h.src ?? name : [h.label && h.label !== name ? h.label : "", h.model || ""].filter(Boolean).join(" · ");
  return el("div", { class: `rq-hd${h.who ? " rq-who" : ""}` },
    h.who && !h.ic ? el("span", { class: "rq-av", "aria-hidden": "true", text: [...h.who][0] || "?" }) : el("span", { class: "dr-ic" }, icon(h.ic || (ICONS[ic] ? ic : "send"))),   // h.ic (a mail draft): the app's icon, as on a card with no person
    el("span", { class: "rq-meta", title: [to, src].filter(Boolean).join(" · ") }, el("b", { class: "rq-wt", text: to }),
      src ? el("span", { class: "rq-src", text: ` · ${src}` }) : null, h.pc ? el("span", { class: "mon-pc", text: ` · ${h.pc}` }) : null),
    when ? el("span", { class: "rc-time", text: when }) : null, ...(h.tail || []));
}
// A body is long when it would take more than RQ_LINES lines at a phone's width (about 36 Korean characters a line).
const rqLong = text => String(text || "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / 36)), 0) > RQ_LINES;
// c.bare: a card with only its label, body, 첨부 줄 and buttons (the room's draft card sits right under the chat it answers, 30-kakao.js); b.one: a single part is a bubble too.
// b: { text, parts (a KakaoTalk draft's messages: one bubble each, sentParts of them already in the room), node (the caller's own body), cls, partCls, full (never clamped: a sheet scrolls it),
// fold(open) + long (a body that folds itself: 펼치기 only asks it to, as the changed lines of a long revised draft do, rqDiffBody) }
function rqBodyNode(key, b) {
  const parts = Array.isArray(b.parts) && b.parts.length > (b.one ? 0 : 1) ? b.parts : null, long = !b.full && (b.fold ? !!b.long : rqLong(parts ? parts.join("\n") : b.text)), open = RQ_OPEN.has(key);
  const inner = b.node || (parts ? el("div", { class: `${b.cls || "rq-text"} rq-parts` }, ...parts.map((p, i) => el("div", { class: `${b.partCls || "rq-part"}${i < (b.sentParts | 0) ? " sent" : ""}`, text: p }))) : el("div", { class: b.cls || "rq-text", text: b.text }));
  const box = el("div", { class: `rq-body${long && !open && !b.fold ? " clamp" : ""}` }, inner);
  if (b.fold) b.fold(!long || open);
  if (!long) return box;
  const more = el("button", { class: "btn text rq-more", type: "button", "data-k": "more", "aria-expanded": String(open), text: open ? TX("decision.less") : TX("decision.more"), onclick: ev => {
    ev.stopPropagation();
    if (RQ_OPEN.has(key)) RQ_OPEN.delete(key); else RQ_OPEN.add(key);
    const on = RQ_OPEN.has(key);
    if (b.fold) b.fold(on); else box.classList.toggle("clamp", !on);
    more.textContent = on ? TX("decision.less") : TX("decision.more"); more.setAttribute("aria-expanded", String(on));
  } });
  return el("div", { class: "rq-bodywrap" }, box, more);
}
// The actions, the same three on every surface: 보내기 `send`, 고치기 `fix` and 보내지 않기 `drop`. 고치기 is one button for both ways to change a draft: on a draft the
// queue holds it opens the panel (10-reply-actions.js rqFixNodes: the owner's own text, an instruction to the AI, or both), on any other its notice's card. A missing
// handler leaves its button disabled; `busy` disables them all. a.quiet: 보내기 is tonal (one filled control per screen: only the lead card's is filled).
function rqActsNode(a) {
  const b = (cls, k, text, fn) => el("button", { class: cls, type: "button", "data-k": k, disabled: !!a.busy || !fn, text: a.busy && a.press === k ? RQ_PRESS[k] : text, onclick: fn });
  return el("div", { class: "dr-act dr-row rq-acts" }, b(`btn${a.quiet ? " tonal" : ""} sm dr-send`, "send", TX("common.send"), a.send), ...(a.only || []).map(o => b("btn text sm", o.k, o.text, a.send && o.fn)), b("btn tonal sm", "fix", TX("decision.fix"), a.fix), b("btn text sm dr-drop", "drop", TX("decision.drop"), a.drop));
}
// An AI-revised draft shows what changed against the draft it replaced (the item's draft.replaces.text): the words that came in are marked (<ins>), the ones that went
// stand struck (<del>) where they were. rqDiffOps is the word-level diff as ops in the new text's order, ["=" | "+" | "-", word, the white space after it]; null when
// nothing differs or the texts are too long to compare. `parts` (a KakaoTalk draft's messages) end each message with a form feed, so no bubble mixes two.
function rqDiffOps(before, after, parts) {
  const tok = s => [...String(s || "").matchAll(/(\S+)(\s*)/g)].map(m => [m[1], m[2]]);
  const x = tok(before), y = parts ? parts.flatMap(p => { const t = tok(p); if (t.length) t[t.length - 1][1] = "\f"; return t; }) : tok(after);
  let p = 0, q = 0;
  while (p < x.length && p < y.length && x[p][0] === y[p][0]) p++;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q][0] === y[y.length - 1 - q][0]) q++;
  const n = x.length - p - q, m = y.length - p - q, w = m + 1;
  if ((!n && !m) || n * m > 1e6) return null;
  const L = new Uint16Array((n + 1) * w);   // the longest common run of words from each pair of places on
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = x[p + i][0] === y[p + j][0] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const ops = y.slice(0, p).map(t => ["=", ...t]);
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && x[p + i][0] === y[p + j][0]) { ops.push(["=", ...y[p + j]]); i++; j++; }
    else if (i < n && (j === m || L[(i + 1) * w + j] >= L[i * w + j + 1])) ops.push(["-", ...x[p + i++]]);
    else ops.push(["+", ...y[p + j++]]);
  }
  return ops.concat(y.slice(y.length - q).map(t => ["=", ...t]));
}
// The ops as rows, one per line of the new text: { part (which message), nodes, changed }. Removed words stand before the white space that followed the word ahead of
// them, so every line break stays where the new text has it.
function rqDiffRows(ops) {
  const rows = [{ part: 0, nodes: [], changed: false }], row = () => rows[rows.length - 1];
  let held = "";
  const flush = () => {   // the white space held back: a space stays in the line, a line break starts a row, a form feed the next message
    for (const ch of held.replace(/[^\n\f]+/g, " ").replace(/ *([\n\f]) */g, "$1")) { if (ch === " ") row().nodes.push(" "); else rows.push({ part: row().part + (ch === "\f" ? 1 : 0), nodes: [], changed: false }); }
    held = "";
  };
  for (let i = 0, j; i < ops.length; i = j) {
    const t = ops[i][0];
    for (j = i + 1; j < ops.length && ops[j][0] === t && (t === "-" || !/[\n\f]/.test(ops[j - 1][2])); j++);   // a run ends with its line
    const run = ops.slice(i, j), words = run.map((o, k) => o[1] + (k < run.length - 1 ? (t === "-" ? " " : o[2]) : "")).join("");
    if (t === "-") { row().nodes.push(row().nodes.length ? " " : "", el("del", { text: words })); row().changed = true; held ||= " "; continue; }
    flush();
    row().nodes.push(t === "+" ? el("ins", { text: words }) : words);
    if (t === "+") row().changed = true;
    held = run[run.length - 1][2];
  }
  return rows;
}
// The body of a revised draft (rqBodyNode's `b`), or null when there is nothing to show (the same words, or too long to compare). A long one shows only its changed lines,
// with "…" where lines are left out, until 펼치기; a KakaoTalk draft keeps one bubble per message.
function rqDiffBody(d) {
  const parts = Array.isArray(d.parts) && d.parts.length > 1 ? d.parts : null, ops = d.sentParts ? null : rqDiffOps(d.replaces.text, d.text, parts);
  if (!ops) return null;
  const rows = rqDiffRows(ops), line = r => el("div", { class: "rq-dl" }, ...r.nodes);
  if (parts) return { text: d.text, node: el("div", { class: "rq-text rq-parts rq-diff" }, ...parts.map((_, i) => el("div", { class: "rq-part" }, ...rows.filter(r => r.part === i).map(line)))) };
  const node = el("div", { class: "rq-text rq-diff" });
  return { node, long: rqLong(d.text) && rows.some(r => !r.changed), fold: open => {
    const kids = [], gap = () => el("div", { class: "rq-dgap", "aria-hidden": "true", text: "…" });
    let cut = false;
    for (const r of rows) { if (!open && !r.changed) { cut = true; continue; } if (cut) kids.push(gap()); cut = false; kids.push(line(r)); }
    clear(node).append(...kids, ...(cut ? [gap()] : []));
  } };
}
// The attachment line: every card of every surface says what goes with the draft before 보내기 (owner 2026-11-16) - the files that go (name + size), or 첨부 없음,
// also where nothing can be attached (a comment reply, a KakaoTalk message). `fl`: the draft's attachments, [{ name, size }] or nothing.
function rqAttachNode(fl) {
  if (Array.isArray(fl) && fl.length) return el("div", { class: "rq-att", "data-k": "files" }, el("div", { class: "dr-fh", text: TX("decision.attach.count", { n: fl.length }) }),
    ...fl.map(f => el("div", { class: "rq-af" }, icon("file"), el("span", { class: "rq-afn", text: f.name }), f.size ? el("span", { class: "dr-fm", text: f.size }) : null)));
  return el("div", { class: "rq-att", "data-k": "none" }, el("div", { class: "dr-none", role: "status" }, icon("clip"), el("span", { text: TX("decision.attach.none") })));
}
// The line a failed action leaves above the buttons. f: { text, why, code (the server's reason when the card must tell one from another: `changed`) }
const rqFailNode = f => el("div", { class: "rq-fail", role: "alert", "data-code": f.code || null, title: f.why || "", text: f.text });
// The original a draft answers, as a quiet quote (owner 2026-11-03): muted, behind one 2px left rule, two lines by default with a
// 원문 보기 toggle. It reads as someone else's words, plainly separate from the draft under it (원칙 5). Open state is kept per card key.
// When the draft has a ref (o.ref, o.t = its conversation), 원문 보기 always shows and opens the full original under the quote: a mail's sender, subject, date and
// whole body, or the original comment (owner 2026-11-04), loaded through the 원문 panel's own loader and pane (10-draft-original.js orgLoad / orgFill).
// With no text to quote (the original is not on this page) the button stands alone: nothing else is ever shown in the quote's place.
const RQ_OG = new Set();
function rqOrigNode(key, o) {
  const text = String(o.text || ""), long = [...text].length > 84 || text.includes("\n"), open = RQ_OG.has(key), full = !!o.ref;
  const box = text ? el("div", { class: `rq-orig${long && !open ? " clamp" : ""}`, title: text },
    el("div", { class: "rq-oh" }, el("span", { class: "rq-ow", text: o.who || TX("decision.org.original") })),
    el("span", { class: "rq-ot", text })) : null;
  if (!long && !full) return el("div", { class: "rq-og-wrap" }, box);
  const pane = full ? el("div", { class: "od-pane rq-op", role: "region", "aria-label": TX("decision.org.original"), hidden: !open }) : null;
  const s = full ? orgSt(o.ref) : null;
  const paint = () => { if (!RQ_OG.has(key)) return; orgFill(pane, { ref: o.ref }, o.t, () => { s.load = ""; load(); }); };
  const load = () => { (s.subs ||= new Set()).add(paint); orgLoad(o.ref, o.t, paint); paint(); };
  const btn = el("button", { class: "btn text rq-og", type: "button", "aria-expanded": String(open), text: open ? TX("decision.org.hide") : TX("decision.org.show"), onclick: ev => {
    ev.stopPropagation();
    const on = !RQ_OG.has(key); if (on) RQ_OG.add(key); else RQ_OG.delete(key);
    if (box) box.classList.toggle("clamp", long && !on);
    btn.setAttribute("aria-expanded", String(on)); btn.textContent = on ? TX("decision.org.hide") : TX("decision.org.show");
    if (pane) { pane.hidden = !on; if (on) { load(); motionIn(pane, "fade", M_MS.fast); } }   // the opened original fades in (opacity only; reduced motion: none)
  } });
  if (pane && open) load();
  return el("div", { class: "rq-og-wrap" }, box, btn, pane);
}
// A mail draft's parts, the same on every screen that shows one (the notice's sheet, the 답장 대기 sheet, the mail's own card): the head line (who it answers, 메일,
// the time), the mail it answers as a quote, the subject, the 받는이 line folded to one button (draftRecvFold, below) and the 첨부 줄.
// o: { t (the mail's conversation), at, edit (the 받는이 and 첨부 rows can change), pc, tail (nodes at the head's end), warn (a box for the 첨부 warnings),
// seen (the brief lines were shown already: 11-mailtext.js mailLinesOpen), src (the head's source word; "" inside the 메일 screen, where it says nothing new) }
const rqRcptName = s => { const a = String(s || "").split(/\s*,\s*/)[0].trim(), m = /^"?([^"<]*?)"?\s*<([^>]*)>$/.exec(a); return m ? m[1].trim() || m[2] : a; };
function rqMailOriginal(dr, t) {
  const m = String(t || "").startsWith("mail:") ? MAILS.get(t) : null, src = { ref: dr.ref, t };   // ref: 원문 보기 loads the full original
  if (m) return { who: mailSender(m.from), text: m.subject || mailBrief(m, t), ...src };
  if (dr.origin && dr.origin.text) return { who: "", text: dr.origin.text, ...src };
  // The mail is not on this page: 원문 보기 alone loads it. The draft's own subject ("Re: …") is not what the other side wrote, so it never stands as the quote.
  return dr.ref ? { who: "", text: "", ...src } : null;
}
function rqMailParts(dr, o) {
  const m = String(o.t || "").startsWith("mail:") ? MAILS.get(o.t) : null, b = dr.brief || {}, who = (m && mailSender(m.from)) || rqRcptName(dr.to);
  return { cls: "rq-ml", head: { app: "mail", who, src: o.src ?? TX("common.mail"), ic: "mail", pc: o.pc || "", at: o.at || null, tail: o.tail || [] }, original: rqMailOriginal(dr, o.t),
    brief: b.summary || (!o.seen && (b.todo || b.questions)) ? el("div", { class: "rq-brief" }, b.summary ? el("div", { class: "rq-sumline", text: b.summary }) : null, o.seen ? null : mailLinesNode(b.todo, b.questions)) : null, recv: draftRecvFold(dr, { t: o.t, edit: o.edit, hold: o.hold }), subject: dr.subject,
    attach: draftFilesNode(dr, { t: o.t, edit: o.edit, warn: o.warn, hold: o.hold }) };
}
// The card. c: { key, cls, attrs, head (rqHeadNode), label + labelCls (a sub-head such as "답장 초안 · 메시지 2개"),
// original: {who, text, ref} (what the draft answers) or its node, body, attach (the draft's attachments [{ name, size }], or the caller's own files node),
// extra (nodes under the body: the mail that goes along), then one of: sent (보냈어요 at sentAt), acts (rqActsNode: { send, fix, drop, busy, press, quiet }),
// fail (rqFailNode: the line above the buttons after a failed action), foot (a node that stands in the foot instead: 10-reply-actions.js rqSendNode, or the
// AI line and 반영 / 닫기 of rqFixNodes) }.
const rqRcptNode = r => el("div", { class: "rq-rcpt", "data-k": "rcpt" },
  ...[[r.label, r.to || "-"], ...(r.mail ? [[TX("decision.cc"), (r.cc || []).join(", ") || TX("reply.rcpt.none")], [TX("reply.rcpt.account"), r.accountHeld ? TX("reply.rcpt.account_held") : r.account || TX("reply.rcpt.account_default")]] : [])]
    .map(([k, v]) => el("span", { class: "rq-rc" }, el("span", { class: "dr-k", text: k }), el("span", { class: "rq-rv", text: v }))));
function rqCard(c) {
  const foot = c.foot ? c.foot : c.sent ? rqSentNode(c.sentAt) : c.acts ? rqActsNode(c.acts) : null;
  const att = c.attach && c.attach.nodeType ? c.attach : rqAttachNode(c.attach);
  const cm = !!(c.head && c.head.who);   // a comment card: its text quoted under the head, the post title a grey hint, the draft as the body
  return el("div", { class: `rq${cm ? " cm" : ""}${c.cls ? ` ${c.cls}` : ""}`, ...(c.attrs || {}) },
    c.bare ? null : rqHeadNode(c.head), c.rcpt ? rqRcptNode(c.rcpt) : null,
    c.bare || !c.original ? null : c.original.nodeType ? c.original : c.original.text || c.original.ref ? rqOrigNode(c.key, c.original) : null,   // a node: the caller's own block
    c.brief || null,
    c.label ? el("div", { class: c.labelCls || "rq-lb", text: c.label }) : null,
    c.recv || null,
    c.subject && c.subject.nodeType ? c.subject : c.subject ? el("div", { class: "dr-sub rq-sub", text: c.subject }) : null,
    rqBodyNode(c.key, c.body), att, ...(c.extra || []).filter(Boolean),
    c.fail ? rqFailNode(c.fail) : null, foot);
}
// 보냈어요 in the card's own foot: the action row's place, so nothing below moves (the landing demo card's 보냈어요 · 방금).
const rqSentNode = (at = TX("decision.just_now")) => el("div", { class: "rq-sent", role: "status", "data-state": "send" }, icon("check"), el("span", { text: TX("decision.sent") }), el("span", { class: "rq-sent-at", text: `· ${at}` }));
// The 받는이 of a mail draft, folded to one text button under the body ("받는이 한서윤 · 답장"); it opens the rows of draftToNode in place. A draft with nobody to send to,
// or an address that is not one, stands open from the start. Once the owner presses the button, that choice stays.
const DR_ADDR = /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/;
const draftAddr = a => DR_ADDR.test(String(a).replace(/^.*<([^>]*)>\s*$/, "$1").trim());
function draftRecvFold(d, o = {}) {
  let open = null, bad = false, panel = null;   // open: null until the owner presses the button
  const text = el("span", { class: "rq-rs" }), btn = el("button", { class: "btn text sm rq-recv", type: "button", "aria-expanded": "false", onclick: () => { open = !(open ?? bad); sync(); } }, text, icon("drop"));
  const sync = () => { const on = open ?? bad; btn.setAttribute("aria-expanded", String(on)); if (panel) panel.hidden = !on; };
  const inner = draftToNode(d, { ...o, always: true, onpaint: live => {
    const first = rqRcptName(live.to[0]) || TX("decision.rcpt.none"), more = live.to.length - 1;
    bad = !live.to.length || live.to.some(a => !draftAddr(a));
    text.textContent = [more > 0 ? TX("decision.rcpt.to_more", { first, n: more }) : TX("decision.rcpt.to", { first }), live.reply ? (live.mode === "all" ? TX("decision.reply_all") : TX("decision.reply")) : "", live.cc.length ? TX("decision.rcpt.cc", { n: live.cc.length }) : ""].filter(Boolean).join(" · ");
    sync();
  } });
  panel = el("div", { class: "rq-recvbox" }, inner);
  sync();
  return el("div", { class: "rq-recvfold" }, btn, panel);
}
// A mail draft's sheet (owner 2026-11-10): the same sheet as the 답장 확인 of a comment (30-replies.js rqSheetOpen) - one head, 답장 확인 and a close x - with the
// reply card's parts (10-reply-card.js rqMailParts) straight on the sheet and the choices in the footer. Only the body scrolls.
function mailSheetBody(dc, d, st, warnBox) {
  const open = String(dc.t || "").startsWith("mail:") ? el("button", { class: "btn text rq-open", type: "button", "data-k": "open", text: TX("decision.open"), onclick: () => { dc.close(); go("monitoring", `c:${dc.t}`); } }) : null;
  const p = rqMailParts(d, { t: dc.t, at: dc.at, edit: true, hold: !!st, warn: warnBox, tail: [open] });   // sending: the rows stay where they are, off, so nothing under them moves
  return el("div", { class: "fs-body rq-sb", tabindex: "0", role: "region", "aria-label": TX("decision.body_label") },
    d.recipientWarning ? el("div", { class: "dr-warn dc-rw", role: "alert" }, el("span", { text: TX("decision.rcpt.check", { warning: d.recipientWarning }) })) : null, decideNode(d), draftRuleNode(d),
    rqCard({ key: dc.key, ...p, body: { node: draftBodyNode(d.body, "dc-dr-b"), full: true }, extra: [draftOriginNode(d)] }));
}
