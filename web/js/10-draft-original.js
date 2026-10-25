/* ---------- 원문 보기: the mail a reply draft answers, beside the draft in the send sheet ---------- */
// Collapsed by default: one line (sender, subject) under the sheet's header. Opening it widens the sheet and slides the original in from the left while the draft
// moves to the right (one 250ms transition of the grid columns, 15-draft-original.css); both columns scroll on their own. The original is fetched on the first
// open (GET /api/drafts/<ref>/original, hub/draft-attach.ts; through the peer proxy for a peer's draft, the same way as the draft's files) and kept per draft.
// Its body is the mail view's own (mailBodyNode: the sandboxed HTML frame or the laid-out text). The state lives here, so a repaint of the sheet keeps it open.
const ORG = { st: {} };
const orgSt = ref => ORG.st[ref] || (ORG.st[ref] = { open: false, load: "", data: null, focus: "" });
const ORG_FOCUS = { "": "orig", orig: "draft", draft: "" };

async function orgLoad(ref, t, paint) {
  const s = orgSt(ref);
  if (s.load === "busy" || s.load === "ok" || s.load === "missing") return;
  s.load = "busy"; paint();
  DRF.pc[ref] = t ? pqPc(t) : null;
  try { s.data = await api(drfPath(ref, "original")); s.load = "ok"; }
  catch (e) { s.load = /찾을 수 없|HTTP 404/.test(e.message) ? "missing" : "fail"; }
  paint();
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
  if (pc) PQ.of.set(`mail:${m.key}`, { pc, key: m.key });   // its body and files are read from the computer that owns the mail
  const files = m.attachments || [];
  pane.append(orgRow("보낸이", m.from), orgRow("받는이", m.to), orgRow("날짜", kstStamp(m.date)), orgRow("제목", m.subject),
    el("div", { class: "od-body" }, mailBodyNode(m.key, m.html, m.text)),
    files.length ? el("div", { class: "od-files" }, ...files.map((f, i) => el("a", { class: "dr-att", href: mailFileUrl(m.key, i), target: "_blank", rel: "noopener", title: `${f.name} 열기` },
      icon("clip"), el("span", { class: "dr-fn", text: f.name }), f.size ? el("span", { class: "dr-fs", text: mailSize(f.size) }) : null))) : null);
}
// The toggle line, the split (original | draft) around `body`, and the sheet's width class on `box`. Nothing is fetched until the first open.
function orgNodes(d, t, box, body) {
  const ref = d.ref, s = orgSt(ref), who = d.to || "", sub = String(d.subject || "").replace(/^\s*(?:re|답장|회신)\s*:\s*/i, "");
  const sum = el("span", { class: "od-sum", text: [who, sub].filter(Boolean).join(" · ") });
  const tt = el("span", { class: "od-tt" }), chev = icon("down", "od-chev");
  const tg = el("button", { class: "od-tg", type: "button", "aria-controls": `od-${ref}` }, icon("mail"), tt, sum, chev);
  const pane = el("div", { class: "od-pane", tabindex: "0", role: "region", "aria-label": "메일 원문" });
  const orig = el("div", { class: "od-orig", id: `od-${ref}` }, pane);
  const div = el("button", { class: "od-div", type: "button", "aria-label": "원문과 초안의 너비 바꾸기" });
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
  sync(); paint();
  if (s.open) orgLoad(ref, t, paint);
  return { bar: tg, split };
}
