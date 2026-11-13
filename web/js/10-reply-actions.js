/* ---------- 답장 하나의 흐름: the one client of GET /api/reply/queue and POST /api/reply/act (hub/reply-actions.ts) ---------- */
// Every surface that shows a reply draws it with rqItemCard(item, opts) from the server's ReplyItem and acts on it with raAct: the card has no
// per-channel code, and the server says which buttons a failed or unsure send gets. The `reply` event updates one item and swaps a replaced
// card in place (99-boot.js). opts: { bare (no head, original or attach line), lead (this card's 보내기 is the filled one) }.
const RA = { items: new Map(), loaded: false, busy: new Map(), fail: new Map(), edit: new Map(), rev: new Map(), nodes: new Map(), t: 0, ticking: false };

async function raLoad() {
  try {
    const r = await api("/api/reply/queue");
    // A gateway without the one queue (an older one) answers no list: the screens keep their own reads.
    if (!r || !Array.isArray(r.items)) return;
    RA.items = new Map(r.items.map(i => [i.ref, i]));
    RA.loaded = true;
  } catch (e) { console.warn("reply queue not read", e); }   // the next event or open reads it again; what was shown stays
  for (const ref of [...RA.nodes.keys()]) raPaint(ref);
}
const raSoon = () => { clearTimeout(RA.t); RA.t = setTimeout(raLoad, 300); };

// The reply event: one item changed (its draft, its send) or was replaced by a revise (`next`); a card shown anywhere follows at once.
function raLive(e) {
  if (!e || !e.ref) return;
  if (e.item) RA.items.set(e.item.ref, e.item);
  const it = RA.items.get(e.ref);
  if (e.send && it) it.send = e.send;
  if (e.why) RA.fail.set(e.ref, { text: e.why });
  if (e.next && RA.nodes.has(e.ref)) {
    const reg = RA.nodes.get(e.ref);
    RA.nodes.delete(e.ref);
    RA.nodes.set(e.next, reg);
    if (RA.items.has(e.next)) raPaint(e.next, e.ref); else raSoon();
    return;
  }
  if (!it && !e.item) raSoon();
  raPaint(e.ref);
}

// One action on one item, posted once: a second press while it waits does nothing. A refusal stays on the card (422 keeps the typed text).
async function raAct(item, action, args = {}) {
  const ref = item.ref;
  if (RA.busy.has(ref)) return false;
  RA.busy.set(ref, action);
  RA.fail.delete(ref);
  raPaint(ref);
  try {
    // Another computer's item runs there, through its own queue (hub/peer-monitor.ts "reply").
    const body = { ref, action, ...args }, r = item.pc ? await api(pqProxy(item.pc, "/api/peer/act"), "POST", { action: "reply", args: body }) : await api("/api/reply/act", "POST", body);
    if (r && r.item) RA.items.set(ref, { ...RA.items.get(ref), ...r.item });
    if (action === "edit") RA.edit.delete(ref);
    if (action === "revise") RA.rev.delete(ref);
    return true;
  } catch (e) {
    const d = (e && e.data) || {};
    RA.fail.set(ref, { text: d.error || TX("reply.act_fail"), why: Array.isArray(d.lint) ? d.lint.join(" · ") : "" });
    return false;
  } finally {
    RA.busy.delete(ref);
    raPaint(ref);
  }
}

/** The items a surface lists: "waiting" (a pending draft with no send), "attention" (a failed or unsure send), or every one. */
const raItems = filter => [...RA.items.values(), ...raPeerItems()].filter(i => (filter === "waiting" ? i.draft.state === "pending" && !i.send : filter === "attention" ? i.send && (i.send.state === "failed" || i.send.state === "unsure") : true));
// The other computers' queues (their snapshot's `reply` part), each item carrying its computer.
const raPeerItems = () => PQ.list.filter(p => p && p.items && p.items.reply).flatMap(p => (p.items.reply.items || []).map(i => ({ ...i, pc: pqPcOf(p) })));
const raCounts = () => {
  const all = [...RA.items.values(), ...raPeerItems()], st = s => all.filter(i => i.send && i.send.state === s).length;
  return { waiting: raItems("waiting").length, failed: st("failed"), unsure: st("unsure"), sending: st("undo") + st("queued") + st("sending") };
};

// A card drawn again in its own place; the field that had the focus keeps it.
function raPaint(ref, was) {
  const reg = RA.nodes.get(ref), it = RA.items.get(ref);
  if (!reg || !it) return;
  if (!reg.node.isConnected) { RA.nodes.delete(ref); return; }
  const k = reg.node.contains(document.activeElement) ? document.activeElement.getAttribute("data-k") : null;
  const next = rqItemCard(it, reg.opts);
  reg.node.replaceWith(next);
  if (was) RA.nodes.delete(was);
  if (k) { const f = next.querySelector(`[data-k="${k}"]`); if (f) f.focus(); }
}

// The undo window counts down in place: one timer for every card that shows one, stopped when none does.
function raTick() {
  const left = [...document.querySelectorAll(".rq-send.undo [data-until]")];
  if (!left.length) { RA.ticking = false; return; }
  RA.ticking = true;
  for (const n of left) n.textContent = TX("reply.undo_in", { n: Math.max(0, Math.ceil((Number(n.dataset.until) - Date.now()) / 1000)) });
  setTimeout(raTick, 1000);
}

/** The foot of a card whose send the queue holds: the countdown with 되돌리기, sending, sent, or the cause with the server's buttons. */
function rqSendNode(item) {
  const s = item.send, busy = RA.busy.has(item.ref), btn = (k, text, fn, cls = "btn text sm") => el("button", { class: cls, type: "button", "data-k": k, disabled: busy, text, onclick: fn });
  if (s.state === "undo") {
    const left = el("span", { "data-until": String(s.until), text: TX("reply.undo_in", { n: Math.max(0, Math.ceil((s.until - Date.now()) / 1000)) }) });
    if (!RA.ticking) setTimeout(raTick, 1000);
    return el("div", { class: "rq-send undo", role: "status" }, left, btn("undo", TX("common.undo"), () => raAct(item, "undo")));
  }
  if (s.state === "queued" || s.state === "sending") return el("div", { class: "rq-send sending", role: "status", text: TX("reply.sending") });
  if (s.state === "sent") return rqSentNode();
  const why = s.reason ? s.reason.text : "";
  if (s.state === "failed" && s.auto && s.safeToAuto) return el("div", { class: "rq-send failed auto", role: "status", text: `${why} · ${TX("reply.auto_retry", { n: s.auto.attempt, max: s.auto.max })}` });
  if (s.state === "failed") {
    const acts = (s.actions || []).includes("retry") ? [btn("retry", TX("reply.retry"), () => raAct(item, "retry"), "btn tonal sm")] : [];
    if (item.can.revise) acts.push(btn("edit", TX("decision.edit"), () => { RA.rev.set(item.ref, ""); raPaint(item.ref); }));
    if (item.can.drop) acts.push(btn("drop", TX("decision.drop"), () => raAct(item, "drop")));
    return el("div", { class: "rq-send failed" }, el("div", { class: "rq-why", role: "alert", text: TX("reply.failed", { why }) }), el("div", { class: "dr-act dr-row rq-acts" }, ...acts));
  }
  return el("div", { class: "rq-send unsure" },
    el("div", { class: "rq-why warn", role: "alert", text: TX("reply.unsure") }), el("div", { class: "rq-sub2", text: `${why} · ${TX("reply.no_auto")}` }),
    el("div", { class: "dr-act dr-row rq-acts" }, btn("resolve-sent", TX("reply.went_out"), () => raAct(item, "resolve", { as: "sent" }), "btn tonal sm"),
      btn("open", TX("reply.check"), () => go("monitoring", `c:${item.conv}`)), btn("resolve-retry", TX("reply.retry"), () => raAct(item, "resolve", { as: "retry" }))));
}

/** 직접 수정: the draft as a text field; 이대로 보내기 saves it as written and sends it, 취소 keeps nothing. The causes of a refusal stay under it. */
function rqEditNode(item) {
  const ref = item.ref, busy = RA.busy.has(ref), f = RA.fail.get(ref);
  const area = el("textarea", { class: "ra-edit", "data-k": "edit-text", rows: "5", "aria-label": TX("reply.edit_label"), disabled: busy });
  area.value = RA.edit.get(ref) ?? item.draft.text;
  const send = () => { const text = area.value.trim(); if (text) raAct(item, "edit", { text, send: true }); };
  const cancel = () => { RA.edit.delete(ref); RA.fail.delete(ref); raPaint(ref); };
  area.oninput = () => RA.edit.set(ref, area.value);
  area.onkeydown = ev => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) { ev.preventDefault(); send(); }
    else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
  };
  return el("div", { class: "rq-edit ra-editbox" }, area,
    f && f.why ? el("div", { class: "ra-lint err", role: "alert", text: f.why }) : null,
    el("div", { class: "btns" }, el("button", { class: "btn sm", type: "button", "data-k": "edit-send", disabled: busy, text: TX("reply.send_as_is"), onclick: send }),
      el("button", { class: "btn text sm", type: "button", "data-k": "edit-cancel", disabled: busy, text: TX("common.cancel"), onclick: cancel })));
}

/** The one card of a reply, on every surface. */
function rqItemCard(item, opts = {}) {
  const ref = item.ref, d = item.draft, busy = RA.busy.has(ref), fail = RA.fail.get(ref);
  let foot = null;
  if (RA.edit.has(ref)) foot = rqEditNode(item);
  else if (RA.rev.has(ref)) foot = rqReviseNode({ value: RA.rev.get(ref), busy, onInput: v => RA.rev.set(ref, v), go: change => raAct(item, "revise", { change }), cancel: () => { RA.rev.delete(ref); raPaint(ref); } });
  else if (d.revising) foot = el("div", { class: "kk-st", role: "status", text: TX("reply.revising") });
  else if (item.send) foot = rqSendNode(item);
  const node = rqCard({
    key: `ra:${item.item}`, cls: `ra-card${opts.lead ? " lead" : ""}`, attrs: { "data-ref": ref, "data-item": item.item }, bare: !!opts.bare,
    // The head names the person: a mail sender's address ("이름 <a@b>") stays in the quoted original only.
    head: { app: item.app, label: item.label, who: item.original && (String(item.original.who).replace(/\s*<[^<>]*>\s*$/, "") || item.original.who), at: item.at },
    original: item.original ? { who: item.original.who, text: item.original.text } : null,
    label: d.replaces ? TX("reply.revised") : "", to: [d.toLabel, d.to], subject: d.subject,
    body: { text: d.text, parts: d.parts, sentParts: d.sentParts },
    attach: d.attachments ? { attachments: d.attachments } : { cannotAttach: [] },
    extra: (d.notes || []).map(n => el("div", { class: "dr-wn", text: n })),
    fail: fail && !RA.edit.has(ref) ? fail : null,
    foot,
    acts: { quiet: !opts.lead, busy, press: RA.busy.get(ref), send: item.can.send ? () => raAct(item, "send") : null, edit: item.can.revise ? () => { RA.rev.set(ref, ""); raPaint(ref); } : null, drop: item.can.drop ? () => raAct(item, "drop") : null, manual: item.can.edit ? () => { RA.edit.set(ref, d.text); raPaint(ref); } : null },
  });
  RA.nodes.set(ref, { node, opts });
  return node;
}

raLoad();
