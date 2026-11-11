/* ---------- 작업내역 rows ----------
   The 작업내역 conversation draws the gateway's and the sessions' posts as the rows of the 감시 소식 feed (30-monitoring.js monRowNode, CSS .fr-list / .bm.rc.fr):
   a head line (state dot, kind label, state tag, claim tag, time) and ONE title line, the post's first sentence. The posts of one day sit in one list card
   (tlHome puts a row into the list that ends the timeline; the day divider, the owner's message and the answer to it end it). A row is a button only
   when unfolding shows more than the title says (like monHasMore); unfolded it is the message as the chat draws it, with 접기.
   Kind (`wk`) and state (`wst`) come from the hub; an event without them (the demo, an older hub) falls back as wlKind / wlState say.
   The same helpers draw 홈's 작업내역 card (08-home.js hcNotices), so the two never disagree. */
const WL = { open: new Set() };   // unfolded rows, by wlRowKey
const WL_LABEL = { session: TX("common.session"), check: TX("home.worklog.check"), night: TX("home.worklog.night"), update: TX("home.worklog.update"), account: TX("home.worklog.account"), system: TX("home.worklog.system"), note: TX("home.worklog.note") };
const WL_STATES = new Set(["done", "run", "wait", "ask", "fail"]);
const wlKey = o => String(o.update_key || o.key || "");
const wlRowKey = o => `${o.ts}|${wlKey(o)}`;
const wlKind = o => WL_LABEL[o.wk] ? o.wk : o.target === "alert" ? "alert" : wlKey(o).startsWith("lane:") ? "session" : o.source === "gateway" ? "system" : "note";
const wlParse = o => statedTone(noHandoff(String(o.text ?? "")), true);
// The state of a post: the hub's `wst`, else (a session only) the mark of its text, else the tone a stored notice carries.
function wlState(o) {
  if (WL_STATES.has(o.wst)) return o.wst;
  if (wlKind(o) !== "session" && wlKind(o) !== "alert") return "";
  const t = wlParse(o).tone || (o.tone === "warn" ? "ask" : o.tone);
  return WL_STATES.has(t) ? t : "";
}
// The dot class of a state (09-notices.css .nt-dot.tone-*): a wait is the orange of a question.
const wlDot = o => { const s = wlState(o); return s === "wait" ? "ask" : s; };
// The first sentence of a post, without its mark and claim word, files, choice blocks and markdown; `more`: the post says more than that.
// An 알림 post says its one human line (humanAlert) and keeps the raw text folded; `hold`: it is drawn whole, never as a row (a choice, files, or a question that says more).
function wlSplit(o) {
  const p = wlParse(o), alert = o.target === "alert", fl = fileLines(p.text), shown = alert ? noticeKo(p.text, NK) : "", head = alert ? humanAlert(shown) : "";
  const lines = (alert ? [head] : choiceFree(fl.text).split("\n")).map(l => ntPlain(l)).filter(Boolean);
  const first = lines[0] || "", m = /^(.+?[.!?。…])\s+(?=\S)/.exec(first), blocks = parseChoices(p.text).blocks.length, files = fl.files.length || (Array.isArray(o.files) && o.files.length);
  const more = !!(m || lines.length > 1 || files || blocks || (alert && (head.trim() !== shown.trim() || nwChangeLine(p.text))));
  return { title: (m ? m[1] : first).replace(/[.。]$/, ""), more, claim: p.claim, hold: alert && !!(blocks || files || (p.tone === "ask" && more)) };
}
const wlTitle = o => wlSplit(o).title;
// A stored notice that is a 작업내역 post (홈's card): drawn with the same dot and title as the conversation's row.
const wlNotice = n => n.kind === "worklog" || (n.kind === "result" && n.msg === "worklog");
// Which events are drawn as rows: the gateway's and the assistant's posts of the 작업내역 and 알림 conversations. The owner's message, the answer to it (`reply_to`), a card,
// a work row and a live status stay as they are, and so does an 알림 post that waits on the owner (a choice, a question, files).
function wlIs(e) {
  if (e.kind !== "out" || e.system || e.relay || e.card || e.reply_to || e.live || peerMsgOf(e)) return false;
  if (e.target !== "worklog" && (e.target !== "alert" || e.ask)) return false;
  const sp = wlSplit(e);
  return !!sp.title && !sp.hold;
}
function wlSession(o) {
  const k = wlKey(o), s = String(o.source || "");
  return k.startsWith("lane:") ? k.slice(5) : s.startsWith("lane:") ? s.slice(5) : "";
}
function wlLabel(o) {
  const kind = wlKind(o), lane = kind === "session" ? wlSession(o) : "";
  if (!lane) return el("span", { class: "rc-src", text: WL_LABEL[kind] });
  const open = () => openTarget(`lane:${lane}`, "chat"), known = !!(S && (S.lanes || []).some(l => l.name === lane));
  const name = known
    ? el("span", { class: "wl-sess", role: "link", tabindex: "0", text: targetName(`lane:${lane}`), onclick: ev => { ev.stopPropagation(); open(); }, onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); open(); } } })
    : el("span", { text: targetName(`lane:${lane}`) });
  return el("span", { class: "rc-src" }, `${WL_LABEL.session} · `, name);
}
const wlTag = s => { const t = LANE_TONE[s]; return t ? el("span", { class: `tag ${t[0]}`, text: t[1] }) : null; };
const wlClaim = c => { const t = CLAIM_TAG[c]; return t ? el("span", { class: `tag${t[0] ? ` ${t[0]}` : ""}`, text: t[1] }) : null; };
// A row that turns out to show more than it says becomes a button (the quiet check line, once it is laid out and clipped).
function wlPress(row, toggle, label) {
  row.classList.remove("fr-all");
  row.setAttribute("role", "button"); row.tabIndex = 0; row.setAttribute("aria-expanded", "false"); row.setAttribute("aria-label", TX("home.fold.open_label", { label }));
  row.onclick = toggle; row.onkeydown = ev => monKey(ev, toggle);
}
let wlFitQ = [];
// The quiet check line is one line, never a button unless its text is clipped: measured once the row sits in the page.
function wlFitLater(row, toggle, label) {
  wlFitQ.push([row, toggle, label]);
  if (wlFitQ.length === 1) requestAnimationFrame(() => {
    const q = wlFitQ; wlFitQ = [];
    const clipped = q.map(([r]) => { const t = r.isConnected && r.querySelector(".wl-q"); return !!t && t.scrollWidth > t.clientWidth; });
    q.forEach(([r, toggle2, label2], i) => { if (clipped[i]) wlPress(r, toggle2, label2); });
  });
}
// The whole message as the chat draws it (its head line and the state tags the row's own head shows are left out).
function wlFull(e) {
  const b = msgNode({ ...e, update_key: undefined });
  if (!b) return null;
  const body = el("div", { class: "wl-full" }, ...[...b.children].filter(c => !c.classList.contains("mt")));
  for (const t of body.querySelectorAll(":is(p, li):first-child > .st-tag")) { const p = t.parentElement; t.remove(); if (!p.children.length && !p.textContent.trim()) p.remove(); }
  return body;
}
function wlNode(e) {
  const sp = wlSplit(e), st = wlState(e), kind = wlKind(e), key = wlRowKey(e), open = WL.open.has(key), hm = kstHM(e.ts);
  const quiet = kind === "check" && st !== "fail" && !open, button = sp.more && !open, label = WL_LABEL[kind] || TX("common.alerts");   // an 알림 post has no kind label: the conversation is the label
  // The title does not say the kind a second time ("야간 정리: ..." under the label 야간 정리), and a note with no state and no claim has nothing
  // for a head line to say: its title stands in the head's place, beside the time (what is absent leaves no slot).
  const title = sp.title.startsWith(`${label}:`) ? sp.title.slice(label.length + 1).trim() || sp.title : sp.title;
  const plain = (kind === "note" || kind === "alert") && !st && !sp.claim && !open;
  const toggle = () => {
    if (WL.open.has(key)) WL.open.delete(key); else WL.open.add(key);
    const nn = wlNode(e);
    row.replaceWith(nn);
    for (const p of CS.prog.values()) if (p.node === row) p.node = nn;
    (nn.querySelector(".cc-act .btn") || nn).focus({ preventScroll: true });
  };
  const time = el("span", { class: "rc-time", text: hm });
  // The state is said once, by its tag (the tag draws its own dot): no second dot before the label, so every label starts on one left line.
  const hd = quiet ? el("div", { class: "rc-hd" }, wlLabel(e), el("span", { class: "wl-q", text: title }), time)
    : plain ? el("div", { class: "rc-hd" }, el("div", { class: "fr-sum", text: title }), time)
    : el("div", { class: "rc-hd" }, kind === "alert" ? null : wlLabel(e), wlTag(st), wlClaim(sp.claim), time);
  const full = open ? wlFull(e) : null;
  const unread = !!(CV.div && e.ts > CV.div && convIncoming(e));
  const row = el("div", { class: `bm rc fr wl-row${unread ? " un" : ""}${quiet ? " wl-quiet" : ""}${plain ? " wl-plain" : ""}${button ? "" : " fr-all"}${open ? " fr-open" : ""}`, "data-ts": e.ts, "data-wk": kind, "data-wst": st || null,
    role: button ? "button" : null, tabindex: button ? "0" : null, "aria-expanded": button ? "false" : null, "aria-label": button ? TX("home.fold.open_label", { label }) : null, onclick: button ? toggle : null, onkeydown: button ? ev => monKey(ev, toggle) : null },
    hd,
    quiet || plain ? null : open ? full : el("div", { class: "fr-sum", text: title }),
    open ? el("div", { class: "btns cc-act" }, el("button", { class: "btn text", type: "button", "aria-label": TX("home.fold.close_label", { label }), onclick: toggle, text: TX("home.fold.close") })) : null);
  if (quiet && !button) wlFitLater(row, toggle, label);
  return row;
}
// A row joins the list card that ends the timeline, or starts one (the card ends at a day divider, a bubble or any other row).
function wlHome() {
  const last = tlTail();
  return last && last.classList.contains("wl-list") ? last : tl.appendChild(el("div", { class: "fr-list wl-list" }));
}
// A row that goes (a session line edited in place is drawn again at its new time) leaves no empty card behind.
function wlTidy(parent) { if (parent && parent.classList.contains("wl-list") && !parent.firstElementChild) parent.remove(); }
