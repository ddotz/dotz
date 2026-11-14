/* ---------- 빠른 처리: every waiting reply of every channel and computer, answered fast over the one reply queue (10-reply-actions.js, docs/layers.md section 5) ---------- */
// The 답장 대기 screen's head offers it once `triageMin` items wait (the queue's own number). One item fills the view as the same card every surface
// draws (rqItemCard) and raAct answers it; 목록 picks per row, and nothing unpicked is sent.
// 모니터링 on a wide screen: the screen stands in the right column of the frame, in place of the queue (the reply card's pane, 30-replies.js rqPaneOpen); the list stays at the left.
// It is RQ.sheet, so the queue's own redraw, back and item changes treat it like that card. Back, the browser's back and Esc close it one step.
const trPaneNow = () => current === "monitoring" && !narrowChat() && !!$("#v-monitoring.rq-on");
function trPaneOpen(onClose) {
  if (RQ.sheet) RQ.sheet.close(false);
  RQ.top = $("#mon-timeline").scrollTop;
  let ov = null, closed = false;
  const box = el("div", { class: "rq-pane tr-pane", tabindex: "-1", onkeydown: ev => { if (ev.key === "Escape" && !document.querySelector("dialog[open]:not([data-leaving])")) { ev.preventDefault(); ev.stopPropagation(); h.close(); } } });
  const h = { pane: true, tr: true, box, close() {
    if (closed) return;
    closed = true; ovDone(ov); onClose();
    if (RQ.sheet === h) { RQ.sheet = null; RQ.cur = ""; MON.sig = ""; monSchedule(); }
  } };
  ov = ovOpen(() => h.close());
  RQ.sheet = h; MON.sig = ""; renderMonitoring();   // drawn now, so the box is on the page when it takes the focus
  return h;
}
// One by one: the head counts the place and the channels, the card is rqItemCard with the filled 보내기, and 진행 lists every item with its live state.
// After 보내기 the view moves on at once; the send waits its undo window in the common queue and its state shows in the rail. 목록: one compact row per item,
// 보내기 | 고치기 | 건너뛰기 picked per row, and 고른 것 처리 posts only the picks. Keys: Enter 보내기, E 직접 수정, X 보내지 않기, → 건너뛰기, ← back, L list.
// press: sends posted and not answered yet; bad: sends the hub never took (a lost press, a refusal), shown as failed in the rail.
const TQ = { h: null, items: [], i: 0, list: false, picks: {}, notes: {}, press: new Set(), bad: new Set() };
const tqItem = ref => RA.items.get(ref) || TQ.items.find(i => i.ref === ref);
const TQ_ST = { undo: "reply.q.st.undo", queued: "reply.sending", sending: "reply.sending", sent: "reply.q.st.sent", failed: "reply.q.st.failed", unsure: "reply.q.st.unsure" };
function tqStateOf(ref) {
  const it = tqItem(ref), s = it && it.send;
  if (s) return s.state;
  if (TQ.press.has(ref)) return "queued";
  if (TQ.bad.has(ref)) return "failed";
  return it && it.draft.state === "dropped" ? "dropped" : "";
}
function tqOpen(ref) {
  const items = raItems("waiting").sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!items.length) { toast(TX("triage.none")); return; }
  if (TQ.h) TQ.h.close(false);
  Object.assign(TQ, { items, i: Math.max(0, ref ? items.findIndex(i => i.ref === ref) : 0), list: false, picks: {}, notes: {}, press: new Set(), bad: new Set() });
  const onClose = () => { if (TQ.h === h) TQ.h = null; document.removeEventListener("keydown", tqKey); };
  const h = trPaneNow() ? trPaneOpen(onClose) : fsOpen({ label: TX("triage.fast"), cls: "tall tr", onClose });
  TQ.h = h;
  document.addEventListener("keydown", tqKey);
  tqPaint();
  h.box.focus({ preventScroll: true });
}
const tqStep = d => { const j = TQ.i + d; if (j < 0 || j > TQ.items.length) return; TQ.i = j; tqPaint(); };
function tqKey(ev) {
  if (!TQ.h || (TQ.h.pane ? current !== "monitoring" || RQ.sheet !== TQ.h || (ev.target instanceof Element && ev.target !== document.body && !TQ.h.box.contains(ev.target)) : FS[FS.length - 1] !== TQ.h) || document.querySelector("dialog[open]:not([data-leaving])")) return;
  if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement || ev.metaKey || ev.ctrlKey || ev.altKey) return;   // keys do nothing while a field has the focus
  const k = ev.key.toLowerCase(), it = TQ.items[TQ.i] && tqItem(TQ.items[TQ.i].ref);
  if (k === "l") { ev.preventDefault(); TQ.list = !TQ.list; tqPaint(); return; }
  if (TQ.list) return;
  if (k === "arrowright") { ev.preventDefault(); tqStep(1); return; }
  if (k === "arrowleft") { ev.preventDefault(); tqStep(-1); return; }
  if (!it || RA.busy.has(it.ref) || it.send || (k === "enter" && ev.target instanceof HTMLElement && ev.target.closest("button, a"))) return;
  if (k === "enter" && it.can.send) { ev.preventDefault(); tqSend(it); }
  else if (k === "e" && it.can.edit) { ev.preventDefault(); RA.edit.set(it.ref, it.draft.text); tqPaint(); const f = TQ.h.box.querySelector(".ra-edit"); if (f) f.focus(); }
  else if (k === "x" && it.can.drop) { ev.preventDefault(); raAct(it, "drop").then(ok => ok && tqAfter()); }
}
const tqAfter = () => { if (TQ.h) tqStep(1); };
// 보내기 counts at once and moves on; the post goes behind, so a phone that loses the answer does not hold the view (issue #5). raAct reads the queue
// again on a lost answer and the hub refuses a second send of the same item (already_sending), so nothing goes twice. A send the hub did not take
// comes back as failed in the rail with one toast, the card keeping its line and a live 보내기.
function tqSend(it) {
  if (RA.busy.has(it.ref)) return;
  TQ.press.add(it.ref); TQ.bad.delete(it.ref);
  const sent = raAct(it, "send");
  tqAfter();
  sent.then(ok => {
    TQ.press.delete(it.ref);
    if (!ok) { TQ.bad.add(it.ref); toast((RA.fail.get(it.ref) || {}).text || TX("reply.act_fail"), true); }
    tqPaint();
  });
}
function tqLive() { if (TQ.h) tqPaint(); }
function tqPaint() {
  if (!TQ.h) return;
  const n = TQ.items.length, handled = TQ.items.filter(i => tqStateOf(i.ref)).length, by = new Map();
  for (const i of TQ.items) by.set(i.label, (by.get(i.label) || 0) + 1);
  const bar = el("div", { class: "tr-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(n), "aria-valuenow": String(handled), "aria-label": TX("triage.bar") }, el("span", { style: `width:${n ? (handled / n) * 100 : 0}%` }));
  const head = fsHead([el("span", { class: "fs-ey", text: countsLine(by) }), el("h2", { class: "fs-t tr-pos", text: TQ.list ? TX("triage.head.list", { n }) : TX("reply.q.head", { i: Math.min(TQ.i + 1, n), n }) }), bar], { close: () => TQ.h && TQ.h.close() });
  const tog = el("button", { class: "btn text sm tr-tog", type: "button", "aria-pressed": String(TQ.list), onclick: () => { TQ.list = !TQ.list; tqPaint(); } }, icon("list"), el("span", { text: TQ.list ? TX("triage.tog.one") : TX("triage.tog.list") }));
  $(".fs-hb", head).prepend(tog);
  const body = TQ.list ? tqListView() : TQ.i >= n ? tqDoneView() : [rqItemCard(tqItem(TQ.items[TQ.i].ref), { lead: true, after: tqAfter, send: tqSend }), tqRail()];
  const keep = TQ.h.box.querySelector("textarea:focus, input:focus");
  if (keep && TQ.h.box.contains(keep) && !TQ.list) return;   // typing in the card's field: the next event repaints
  // The body scrolls under the fixed head; a repaint (a pick, a live send state) keeps the place in a long list, a new card starts at its top.
  const was = TQ.h.box.querySelector(".tq-body"), top = was && was.dataset.at === String(TQ.list ? "list" : TQ.i) ? was.scrollTop : 0;
  const nb = el("div", { class: "tq-body", "data-at": TQ.list ? "list" : String(TQ.i) }, ...body);
  clear(TQ.h.box).append(head, nb);
  nb.scrollTop = top;
}
// 진행: every item and its live state; the one on screen is marked, a tap opens it.
function tqRail() {
  return el("div", { class: "tq-rail", role: "list", "aria-label": TX("reply.q.rail") }, el("div", { class: "tr-k", text: TX("reply.q.rail") }),
    ...TQ.items.map((i, k) => {
      const st = tqStateOf(i.ref), it = tqItem(i.ref), who = (it.original && String(it.original.who).replace(/\s*<[^<>]*>\s*$/, "")) || it.draft.to || it.label;
      return el("button", { class: `tq-r${k === TQ.i ? " on" : ""}${st === "failed" || st === "unsure" ? " bad" : ""}`, type: "button", role: "listitem", "data-ref": i.ref, onclick: () => { TQ.i = k; TQ.list = false; tqPaint(); } },
        el("span", { class: "tq-who", text: who }), el("span", { class: `tq-st${st === "failed" || st === "unsure" ? " err" : ""}`, text: k === TQ.i && !st ? TX("reply.q.st.now") : st === "dropped" ? TX("decision.not_sent") : TQ_ST[st] ? TX(TQ_ST[st], st === "undo" ? { n: Math.max(0, Math.ceil(((it.send.until || 0) - Date.now()) / 1000)) } : {}) : "" }));
    }));
}
function tqDoneView() {
  const bad = TQ.items.filter(i => ["failed", "unsure"].includes(tqStateOf(i.ref)));
  return [el("div", { class: "tr-none", role: "status", text: TX("reply.q.done", { n: TQ.items.filter(i => tqStateOf(i.ref)).length }) }),
    bad.length ? el("button", { class: "btn tonal sm", type: "button", "data-k": "fails", text: TX("reply.q.fails", { n: bad.length }), onclick: () => { TQ.items = bad; TQ.i = 0; tqPaint(); } }) : null, tqRail()].filter(Boolean);
}
// 목록: a pick per row; a revise opens a one-line field, and the new draft shows in the same row and waits for a new pick. Nothing unpicked is sent.
function tqListView() {
  const picked = Object.values(TQ.picks).filter(v => v === "send" || v === "revise").length;
  const rows = TQ.items.map(i => {
    const it = tqItem(i.ref), pick = TQ.picks[i.ref] || "", st = tqStateOf(i.ref);
    const b = (k, label) => el("button", { class: `btn ${pick === k ? "tonal" : "text"} sm`, type: "button", "aria-pressed": String(pick === k), "data-k": k, disabled: !!st || RA.busy.has(i.ref), text: label, onclick: () => { TQ.picks[i.ref] = pick === k ? "" : k; tqPaint(); } });
    const note = pick === "revise" ? el("input", { class: "kk-rv rq-rv", type: "text", maxlength: "500", placeholder: DRAFT_HINT, "aria-label": TX("decision.revise.what"), value: TQ.notes[i.ref] || "", oninput: ev => (TQ.notes[i.ref] = ev.target.value) }) : null;
    return el("div", { class: "tq-row", role: "group", "data-ref": i.ref },
      el("div", { class: "tq-line" }, el("span", { class: "tq-who", text: (it.original && String(it.original.who).replace(/\s*<[^<>]*>\s*$/, "")) || it.draft.to }), el("span", { class: "tq-app", text: it.label }), st ? el("span", { class: "tq-st", text: TQ_ST[st] ? TX(TQ_ST[st], { n: 0 }) : "" }) : null),
      el("div", { class: "tq-tx", text: it.draft.text }), note,
      el("div", { class: "dr-act dr-row rq-acts" }, b("send", TX("common.send")), b("revise", TX("decision.edit")), b("skip", TX("reply.q.skip"))));
  });
  return [...rows, el("div", { class: "tq-foot" }, el("button", { class: "btn sm", type: "button", "data-k": "go-picked", disabled: !picked, text: TX("reply.q.go", { n: picked }), onclick: tqGoPicked }))];
}
async function tqGoPicked() {
  for (const i of TQ.items) {
    const pick = TQ.picks[i.ref], it = tqItem(i.ref);
    if (pick === "send") await raAct(it, "send");
    else if (pick === "revise" && (TQ.notes[i.ref] || "").trim()) await raAct(it, "revise", { change: TQ.notes[i.ref].trim() });
    if (pick === "send" || pick === "revise") delete TQ.picks[i.ref];
  }
  tqPaint();
}
