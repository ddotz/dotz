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
function rqHeadNode(h) {
  const [name, ic] = RQ_APPS[rqBase(h.app)] || [h.appName || "답장", "send"];
  // The computer is its own .mon-pc span, like every other row's machine chip (a peer's card then differs only by that chip).
  const meta = [name, h.label && h.label !== name ? h.label : "", h.model || ""].filter(Boolean).join(" · ");
  const at = h.at ? new Date(h.at) : null, when = at && !isNaN(at) ? rcWhen(at.toISOString()) : "";
  return el("div", { class: "rq-hd" }, el("span", { class: "dr-ic" }, icon(ICONS[ic] ? ic : "send")),
    el("span", { class: "rq-meta", title: meta }, meta, h.pc ? el("span", { class: "mon-pc", text: ` · ${h.pc}` }) : null),
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
  return el("div", { class: "dr-act dr-row rq-acts" }, b("btn dr-send", "send", "보내기", a.send), b("btn tonal", "edit", "고치기", a.edit), b("btn text dr-drop", "drop", "보내지 않기", a.drop));
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
// The card. c: { key, cls, attrs, head (rqHeadNode), label + labelCls (a sub-head such as "답장 초안 · 메시지 2개"), to: [label, value],
// recv (a mail draft's own 받는이·참조 rows, 10-decision-card.js draftToNode; given instead of `to`), subject,
// original: {who, text} (what the draft answers), body, attach (a draft's attachments / attachmentsNone / cannotAttach, or the caller's own files node),
// extra (nodes under the body: the mail that goes along), then one of: status (a line such as 고치는 중…), revise (rqReviseNode or the caller's own),
// acts (rqActsNode) }.
function rqCard(c) {
  const foot = c.status ? el("div", { class: "kk-st", role: "status", text: c.status }) : c.revise ? c.revise : c.acts ? rqActsNode(c.acts) : null;
  const att = c.attach && c.attach.nodeType ? c.attach : rqAttachNode(c.attach || {});
  return el("div", { class: `rq${c.cls ? ` ${c.cls}` : ""}`, ...(c.attrs || {}) },
    rqHeadNode(c.head),
    c.label ? el("div", { class: c.labelCls || "rq-lb", text: c.label }) : null,
    c.to ? el("div", { class: "rq-to dr-to" }, el("span", { class: "dr-k", text: c.to[0] }), el("span", { class: "dr-chip", text: c.to[1] || "-" })) : c.recv || null,
    c.subject ? el("div", { class: "dr-sub rq-sub", text: c.subject }) : null,
    c.original && c.original.text ? el("div", { class: "rq-orig", title: c.original.text }, c.original.who ? el("b", { class: "rq-ow", text: c.original.who }) : null, el("span", { class: "rq-ot", text: c.original.text })) : null,
    rqBodyNode(c.key, c.body), att, ...(c.extra || []).filter(Boolean), foot);
}
// What an answer did, in the same words everywhere: 보냈어요, and 보내지 않았어요 with 되돌리기 where the store can bring the draft back.
const rqSentToast = action => toast("보냈어요", false, action || null);
const rqDroppedToast = undo => toast("보내지 않았어요", false, undo ? { label: "되돌리기", onclick: undo } : null, undo ? 6000 : undefined);
