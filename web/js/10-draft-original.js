/* ---------- 원문 보기: the mail or comment a reply draft answers, beside the draft (the send sheet, the comment view's draft card) ---------- */
// Collapsed by default: one line (sender, subject) under the sheet's header. Opening it widens the sheet and slides the original in from the left while the draft
// moves to the right (one 250ms transition of the grid columns, 15-draft-original.css); both columns scroll on their own. The original is fetched on the first
// open (GET /api/drafts/<ref>/original, hub/draft-attach.ts; through the peer proxy for a peer's draft, the same way as the draft's files) and kept per draft.
// The answer says what it is (kind "mail" | "comment"). A mail's body is the mail view's own (mailBodyNode: the sandboxed HTML frame or the laid-out text); a comment
// shows its author, time, text, the post it is under (title, thumbnail) and the comment above it in a thread. The state lives here, so a repaint keeps it open.
const ORG = { st: {} };
const orgSt = ref => ORG.st[ref] || (ORG.st[ref] = { open: false, load: "", data: null, focus: "" });
const ORG_FOCUS = { "": "orig", orig: "draft", draft: "" };

async function orgLoad(ref, t, paint) {
  const s = orgSt(ref), go = () => (s.paint || paint)();
  if (s.load === "busy" || s.load === "ok" || s.load === "missing") return;
  s.load = "busy"; go();
  DRF.pc[ref] = t ? pqPc(t) : null;
  try { s.data = await api(drfPath(ref, "original")); s.load = "ok"; }
  catch (e) { s.load = /찾을 수 없|HTTP 404/.test(e.message) ? "missing" : "fail"; }
  go();
}
const ORG_POST = { youtube: "영상", instagram: "게시물" };
// A comment's pane: the post it is under, who wrote it and when, the comment above it when it is a reply, the text, and the way to the original.
function orgComment(pane, m) {
  const p = m.post || {};
  pane.append(...[p.title || p.thumb ? el("div", { class: "od-post" }, cmThumb(p.title || "", p.thumb), el("span", { class: "od-pt" }, el("span", { class: "dc-dr-k", text: ORG_POST[p.kind] || "글" }), p.title ? el("span", { class: "od-ptt", text: p.title }) : null)) : null,
    orgRow("작성자", m.author), orgRow("시간", m.date ? kstStamp(m.date) : ""),
    m.parent ? el("div", { class: "od-parent" }, el("span", { class: "dc-dr-k", text: `↳ ${m.parent.author}의 댓글` }), el("span", { class: "od-pc", text: m.parent.text })) : null,
    el("div", { class: "od-body od-ct", text: m.text }),
    p.link ? el("a", { class: "od-open", href: p.link, target: "_blank", rel: "noopener noreferrer" }, icon("open"), "원본 열기") : null].filter(Boolean));
}
const orgRow = (k, v) => v ? el("div", { class: "dc-dh" }, el("span", { class: "dc-dr-k", text: k }), el("span", { class: "dc-dr-v sub", text: v })) : null;
// The pane's content for the state it is in: loading, gone, failed (with a retry) or the mail.
function orgFill(pane, d, t, retry) {
  const s = orgSt(d.ref), note = (text, ...kids) => pane.append(el("div", { class: "od-note", role: "status" }, text, ...kids));
  clear(pane);
  if (s.load === "missing") { note("원문을 찾을 수 없어요"); return; }
  if (s.load === "fail") { note("원문을 불러오지 못했어요 ", el("button", { class: "btn text", type: "button", onclick: retry }, "다시 시도")); return; }
  if (s.load !== "ok") { note("원문을 불러와요…"); return; }
  const m = s.data, pc = t ? pqPc(t) : null;
  if (m.kind === "comment") { orgComment(pane, m); return; }
  if (pc) PQ.of.set(`mail:${m.key}`, { pc, key: m.key });   // its body and files are read from the computer that owns the mail
  const files = m.attachments || [];
  pane.append(...[orgRow("보낸이", m.from), orgRow("받는이", m.to), orgRow("날짜", kstStamp(m.date)), orgRow("제목", m.subject),
    el("div", { class: "od-body" }, mailBodyNode(m.key, m.html, m.text)),
    files.length ? el("div", { class: "od-files" }, ...files.map((f, i) => el("a", { class: "dr-att", href: mailFileUrl(m.key, i), target: "_blank", rel: "noopener", title: `${f.name} 열기` },
      icon("clip"), el("span", { class: "dr-fn", text: f.name }), f.size ? el("span", { class: "dr-fs", text: mailSize(f.size) }) : null))) : null].filter(Boolean));
}
// The toggle line, the split (original | draft) around `body`, and the width class on `box`. Nothing is fetched until the first open. `d` = { ref, to, toLabel, subject? }:
// toLabel "대상" is a comment reply, "받는이" a mail.
function orgNodes(d, t, box, body) {
  const ref = d.ref, s = orgSt(ref), who = d.to || "", sub = String(d.subject || "").replace(/^\s*(?:re|답장|회신)\s*:\s*/i, ""), cm = d.toLabel === "대상";
  const sum = el("span", { class: "od-sum", text: [who, sub].filter(Boolean).join(" · ") });
  const tt = el("span", { class: "od-tt" }), chev = icon("down", "od-chev");
  const tg = el("button", { class: "od-tg", type: "button", "aria-controls": `od-${ref}` }, icon(cm ? "chat" : "mail"), tt, sum, chev);
  const pane = el("div", { class: "od-pane", tabindex: "0", role: "region", "aria-label": cm ? "댓글 원문" : "메일 원문" });
  const orig = el("div", { class: "od-orig", id: `od-${ref}` }, pane);
  const div = el("button", { class: "od-div", type: "button", "aria-label": "원문과 초안의 너비 바꾸기" });
  body.classList.add("od-main");
  const split = el("div", { class: "od-split" }, orig, body, div);
  const paint = () => { if (split.isConnected || !s.open) orgFill(pane, d, t, () => { s.load = ""; orgLoad(ref, t, paint); }); };
  const sync = () => {
    tg.setAttribute("aria-expanded", String(s.open)); tt.textContent = s.open ? "원문 접기" : "원문 보기";
    split.classList.toggle("open", s.open); box.classList.toggle("od-wide", s.open);
    orig.toggleAttribute("inert", !s.open); div.tabIndex = s.open ? 0 : -1;
    if (s.focus) split.dataset.focus = s.focus; else delete split.dataset.focus;
  };
  tg.onclick = () => { s.open = !s.open; sync(); if (s.open) orgLoad(ref, t, paint); };
  div.onclick = () => { s.focus = ORG_FOCUS[s.focus]; sync(); };
  s.paint = paint;
  sync(); paint();
  if (s.open) orgLoad(ref, t, paint);
  return { bar: tg, split };
}
