/* ---------- 답장 초안 카드: one card for every reply draft (메일, 카카오톡, 댓글) of every computer ---------- */
// One component for the 답장 확인 queue (30-replies.js), the mail list's 확인 대기 (30-monitoring.js draftCardNode), the KakaoTalk room
// (30-kakao.js kkDraftCard) and a comment thread (30-monitoring-comments.js cmDraftCard): the same head (앱 · 계정 · 컴퓨터 · 모델 when known),
// the body clamped to about six lines with 펼치기, and the same three actions with the same words, 보내기 · 고치기 · 보내지 않기.
// Each caller passes what its actions do; the card never decides where a draft is sent.
const RQ_APPS = { mail: ["메일", "mail"], kakao: ["카카오톡", "chat"], instagram: ["인스타그램", "chat"], youtube: ["유튜브", "chat"], site: ["웹사이트 댓글", "chat"] };
const RQ_LINES = 6;
const RQ_OPEN = new Set();   // card keys whose long body was unfolded (펼치기); kept across repaints
// The app key of an instance id ("mail-2" -> "mail", a peer's "kakao~h1" -> "kakao").
const rqBase = app => String(app || "").split("~")[0].split("-")[0];
const rqAppName = app => (RQ_APPS[rqBase(app)] || [""])[0];
// h: { app (instance id), label (the instance's own name), pc (computer name), model, at (ms or ISO), tail (nodes at the end) }
// ONE tight line (owner 2026-11-03): who the draft answers and where it came from, the state at the right. The author's initial is a small
// 20px mark, so the head never takes a second line and the original below it is the only thing that reads as a quote.
function rqHeadNode(h) {
  const [name, ic] = RQ_APPS[rqBase(h.app)] || [h.appName || "답장", "send"];
  const at = h.at ? new Date(h.at) : null, when = at && !isNaN(at) ? rcWhen(at.toISOString()) : "";
  const to = h.who ? `${h.who}님께 답장` : name, src = h.who ? h.src || name : [h.label && h.label !== name ? h.label : "", h.model || ""].filter(Boolean).join(" · ");
  return el("div", { class: `rq-hd${h.who ? " rq-who" : ""}` },
    h.who ? el("span", { class: "rq-av", "aria-hidden": "true", text: [...h.who][0] || "?" }) : el("span", { class: "dr-ic" }, icon(ICONS[ic] ? ic : "send")),
    el("span", { class: "rq-meta", title: [to, src].filter(Boolean).join(" · ") }, el("b", { class: "rq-wt", text: to }),
      src ? el("span", { class: "rq-src", text: ` · ${src}` }) : null, h.pc ? el("span", { class: "mon-pc", text: ` · ${h.pc}` }) : null),
    when ? el("span", { class: "rc-time", text: when }) : null, ...(h.tail || []));
}
// A body is long when it would take more than RQ_LINES lines at a phone's width (about 36 Korean characters a line).
const rqLong = text => String(text || "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / 36)), 0) > RQ_LINES;
// b: { text, parts (a KakaoTalk draft's messages: one bubble each, sentParts of them already in the room), node (the caller's own body), cls, partCls }
function rqBodyNode(key, b) {
  const parts = Array.isArray(b.parts) && b.parts.length > 1 ? b.parts : null, long = rqLong(parts ? parts.join("\n") : b.text), open = RQ_OPEN.has(key);
  const inner = b.node || (parts ? el("div", { class: `${b.cls || "rq-text"} rq-parts` }, ...parts.map((p, i) => el("div", { class: `${b.partCls || "rq-part"}${i < (b.sentParts | 0) ? " sent" : ""}`, text: p }))) : el("div", { class: b.cls || "rq-text", text: b.text }));
  const box = el("div", { class: `rq-body${long && !open ? " clamp" : ""}` }, inner);
  if (!long) return box;
  const more = el("button", { class: "btn text rq-more", type: "button", "data-k": "more", "aria-expanded": String(open), text: open ? "접기" : "펼치기", onclick: ev => {
    ev.stopPropagation();
    if (RQ_OPEN.has(key)) RQ_OPEN.delete(key); else RQ_OPEN.add(key);
    const on = RQ_OPEN.has(key);
    box.classList.toggle("clamp", !on); more.textContent = on ? "접기" : "펼치기"; more.setAttribute("aria-expanded", String(on));
  } });
  return el("div", { class: "rq-bodywrap" }, box, more);
}
// The three actions, the same words everywhere. A missing handler leaves its button disabled; `busy` disables all three.
function rqActsNode(a) {
  const b = (cls, k, text, fn) => el("button", { class: cls, type: "button", "data-k": k, disabled: !!a.busy || !fn, text, onclick: fn });
  return el("div", { class: "dr-act dr-row rq-acts" }, b("btn sm dr-send", "send", "보내기", a.send), b("btn tonal sm", "edit", "고치기", a.edit), b("btn text sm dr-drop", "drop", "보내지 않기", a.drop));
}
// 고치기: what to change, typed once; the bot rewrites the draft. o: { go(change), cancel(), manual() (직접 수정, optional), pick (a node before the field, such
// as which part of a comment reply with a mail to change), value, onInput(text), busy }
function rqReviseNode(o) {
  const inp = el("input", { class: "kk-rv rq-rv", type: "text", maxlength: "500", placeholder: DRAFT_HINT, "aria-label": "고칠 내용", autocomplete: "off", disabled: !!o.busy });
  inp.value = o.value || "";
  const go = el("button", { class: "btn", type: "button", "data-k": "revise-go", text: "고쳐 달라고 하기", disabled: !!o.busy || !inp.value.trim(), onclick: () => { const change = inp.value.trim(); if (change) o.go(change); } });
  inp.oninput = () => { if (o.onInput) o.onInput(inp.value); go.disabled = !inp.value.trim(); };
  inp.onkeydown = ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); go.click(); } };
  return el("div", { class: "rq-edit" }, el("div", { class: "kk-rq", text: "어떻게 고칠까요?" }), o.pick || null, inp,
    el("div", { class: "btns" }, go,
      el("button", { class: "btn text", type: "button", "data-k": "revise-cancel", text: "취소", disabled: !!o.busy, onclick: o.cancel }),
      o.manual ? el("button", { class: "btn text kk-manual", type: "button", "data-k": "manual", "aria-label": "직접 수정", onclick: o.manual }, icon("pencil"), el("span", { text: "직접 수정" })) : null));
}
// The attachment line: every card says what goes with the draft before 보내기 - the files that go (name + size), or 첨부: 없음, or, for a source that cannot
// attach, that it cannot and the names of the files that stay behind (hub/draft-approval.ts attachments / attachmentsNone / cannotAttach). Never hidden.
function rqAttachNode(d = {}) {
  const fl = Array.isArray(d.attachments) ? d.attachments : [], left = Array.isArray(d.cannotAttach) ? d.cannotAttach.filter(n => n && String(n).trim()) : null;
  if (fl.length) return el("div", { class: "rq-att", "data-k": "files" }, el("div", { class: "dr-fh", text: `첨부 ${fl.length}개` }),
    ...fl.map(f => el("div", { class: "rq-af" }, icon("file"), el("span", { class: "rq-afn", text: f.name }), f.size ? el("span", { class: "dr-fm", text: f.size }) : null)));
  return el("div", { class: "rq-att", "data-k": "none" }, el("div", { class: "dr-none", role: "status" }, icon("clip"),
    el("span", { text: left ? "첨부: 없음 · 파일을 붙일 수 없는 곳이에요" : "첨부: 없음" }),
    left && left.length ? el("span", { class: "dr-wn", text: `남는 파일: ${left.join(", ")}` }) : null));
}
// The original a draft answers, as a quiet quote (owner 2026-11-03): muted, behind one 2px left rule, two lines by default with a
// 원문 보기 toggle. It reads as someone else's words, plainly separate from the draft under it (원칙 5). Open state is kept per card key.
// When the draft has a ref (o.ref, o.t = its conversation), 원문 보기 always shows and opens the full original under the quote: a mail's sender, subject, date and
// whole body, or the original comment (owner 2026-11-04), loaded through the 원문 panel's own loader and pane (10-draft-original.js orgLoad / orgFill).
const RQ_OG = new Set();
function rqOrigNode(key, o) {
  const text = String(o.text || ""), long = [...text].length > 84 || text.includes("\n"), open = RQ_OG.has(key), full = !!o.ref;
  const box = el("div", { class: `rq-orig${long && !open ? " clamp" : ""}`, title: text },
    el("div", { class: "rq-oh" }, el("span", { class: "rq-ow", text: o.who || "원문" })),
    el("span", { class: "rq-ot", text }));
  if (!long && !full) return el("div", { class: "rq-og-wrap" }, box);
  const pane = full ? el("div", { class: "od-pane rq-op", role: "region", "aria-label": "원문", hidden: !open }) : null;
  const s = full ? orgSt(o.ref) : null;
  const paint = () => { if (!RQ_OG.has(key)) return; orgFill(pane, { ref: o.ref }, o.t, () => { s.load = ""; load(); }); };
  const load = () => { (s.subs ||= new Set()).add(paint); orgLoad(o.ref, o.t, paint); paint(); };
  const btn = el("button", { class: "btn text rq-og", type: "button", "aria-expanded": String(open), text: open ? "원문 접기" : "원문 보기", onclick: ev => {
    ev.stopPropagation();
    const on = !RQ_OG.has(key); if (on) RQ_OG.add(key); else RQ_OG.delete(key);
    box.classList.toggle("clamp", long && !on); btn.setAttribute("aria-expanded", String(on)); btn.textContent = on ? "원문 접기" : "원문 보기";
    if (pane) { pane.hidden = !on; if (on) load(); }
  } });
  if (pane && open) load();
  return el("div", { class: "rq-og-wrap" }, box, btn, pane);
}
// The card. c: { key, cls, attrs, head (rqHeadNode), label + labelCls (a sub-head such as "답장 초안 · 메시지 2개"), to: [label, value],
// recv (a mail draft's own 받는이·참조 rows, 10-decision-card.js draftToNode; given instead of `to`), subject,
// original: {who, text} (what the draft answers), body, attach (a draft's attachments / attachmentsNone / cannotAttach, or the caller's own files node),
// extra (nodes under the body: the mail that goes along), then one of: status (a line such as 고치는 중…), revise (rqReviseNode or the caller's own),
// acts (rqActsNode) }.
function rqCard(c) {
  const foot = c.sent ? rqSentNode(c.sentAt) : c.status ? el("div", { class: "kk-st", role: "status", text: c.status }) : c.revise ? c.revise : c.acts ? rqActsNode(c.acts) : null;
  const att = c.attach && c.attach.nodeType ? c.attach : rqAttachNode(c.attach || {});
  const cm = !!c.head.who;   // a comment card: its text quoted under the head, the post title a grey hint, the draft as the body
  return el("div", { class: `rq${cm ? " cm" : ""}${c.cls ? ` ${c.cls}` : ""}`, ...(c.attrs || {}) },
    rqHeadNode(c.head),
    c.original && c.original.text ? rqOrigNode(c.key, c.original) : null,
    c.label ? el("div", { class: c.labelCls || "rq-lb", text: c.label }) : null,
    c.to ? (cm ? null : el("div", { class: "rq-to dr-to" }, el("span", { class: "dr-k", text: c.to[0] }), el("span", { class: "dr-chip", text: c.to[1] || "-" }))) : c.recv || null,   // a mail keeps its 받는이 rows
    c.subject ? el("div", { class: "dr-sub rq-sub", text: c.subject }) : null,
    rqBodyNode(c.key, c.body), att, ...(c.extra || []).filter(Boolean), foot);
}
// 보냈어요 in the card's own foot: the action row's place, so nothing below moves (the landing demo card's 보냈어요 · 방금).
const rqSentNode = (at = "방금") => el("div", { class: "rq-sent", role: "status", "data-state": "send" }, icon("check"), el("span", { text: "보냈어요" }), el("span", { class: "rq-sent-at", text: `· ${at}` }));
// What an answer did, in the same words everywhere: 보냈어요, and 보내지 않았어요 with 되돌리기 where the store can bring the draft back.
const rqSentToast = action => toast("보냈어요", false, action || null);
const rqDroppedToast = undo => toast("보내지 않았어요", false, undo ? { label: "되돌리기", onclick: undo } : null, undo ? 6000 : undefined);
