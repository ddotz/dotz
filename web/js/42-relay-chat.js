/* ---------- a relayed computer's chat: the normal chat view over a messenger (hub/messenger.ts relay, docs/messengers/jandi.ko.md) ---------- */
// Picking a relay row of the computer list (33-peers.js prPick) makes the target relay:<adapter>:<key>. The conversation is drawn by the same code as any other
// (renderAll, chatPush, msgNode): its lines are read from GET /api/relay/<adapter>/<key>/messages (hub/relay-route.ts) -> [{id, at, me, text}] and kept in
// ts(target).msgs as ordinary events (the owner's lines as "message", the computer's replies as "out" with relay: true, which msgNode draws as plain text),
// polled while the page is visible; the composer sends through POST .../send. Nothing of it goes to this gateway's own chat API.
// What a messenger cannot carry (a running turn, tool cards, choices, files, the other computer's settings) is hidden by body.rl (css/11-peers.css).
// Function declarations, not arrows: prPaint (33-peers.js) and setBrand (04-state.js) call these while the bundle is still running, before a const of this file exists.
const RELAY_POLL_MS = 4000, RELAY_PEND_MS = 90_000;
function relayTargetOf(p) { return `relay:${p.via}:${p.key}`; }
function isRelayRow(p) { return !p.self && !!p.via && typeof p.key === "string"; }
const relayApi = t => { const [, adapter, ...key] = t.split(":"); return `/api/relay/${enc(adapter)}/${enc(key.join(":"))}`; };
const relayNorm = x => String(x).replace(/\s+/g, " ").trim();
function relayOn() { return isRelayT(target) && current === "chat" && !chatList; }
const relayOwned = (list, text) => list.filter(e => e.kind === "message" && relayNorm(e.text) === relayNorm(text)).length;
function relayBrand() { return relayOn() ? targetName(target) : botName; }

// The rows' names and notes (the title and the header line name the computer before the list is drawn again), and this view's state on the screen.
function relayNames() { for (const p of PR.list) if (isRelayRow(p)) { RELAY.name[relayTargetOf(p)] = p.name; RELAY.note[relayTargetOf(p)] = p.note || ""; } }
function relayPaint() {
  const on = relayOn(), note = $("#relaynote"), line = on ? RELAY.note[target] || "" : "";
  document.body.classList.toggle("rl", on);
  if (note) { note.hidden = !line; note.textContent = line ? `${line}. 파일 첨부와 진행 표시는 쓸 수 없어요.` : ""; }
  const name = relayBrand();
  if ($("#brand-name").textContent !== name) $("#brand-name").textContent = name;
  if (on) { ta.placeholder = `${targetName(target)}에게 보내요`; ta.disabled = false; $("#send-btn").disabled = false; }
  if (on !== RELAY.on) { RELAY.on = on; prPaint(); }
}
function relayEnter(p) {
  const t = relayTargetOf(p);
  RELAY.name[t] = p.name; RELAY.note[t] = p.note || "";
  if (!isRelayT(target)) RELAY.back = target;
  go("chat", t);
  relayLoad(t, true);
}
// Picking this computer again: back to the conversation the owner came from (the main chat when that is not known).
function relayLeave() {
  const back = validTarget(RELAY.back) && !isRelayT(RELAY.back) ? RELAY.back : MAIN;
  if (current === "chat") go("chat", back); else setTarget(back);
}

// The lines as events. A line with no known time follows the one before it.
function relayEvents(t, lines) {
  let last = Date.now();
  return lines.map(l => {
    last = l.at > 0 ? l.at : last;
    const ts = new Date(last).toISOString();
    return l.me ? { ts, kind: "message", source: "web", text: l.text } : { ts, kind: "out", source: "relay", target: t, relay: true, text: l.text };
  });
}
const relaySig = s => JSON.stringify([s.rids, s.rerr, s.serr, (s.rpend || []).length]);
async function relayLoad(t, quiet) {
  const s = ts(t), before = relaySig(s);
  if (s.loading) return s.loading;
  s.loading = (async () => {
    try {
      const lines = await api(`${relayApi(t)}/messages`);
      const list = Array.isArray(lines) ? lines : [];
      s.msgs = relayEvents(t, list); s.mk = new Set(s.msgs.map(msgKey)); s.rids = list.map(l => l.id).join(",");
      const now = Date.now();
      s.rpend = (s.rpend || []).filter(p => now - p.at < RELAY_PEND_MS && relayOwned(s.msgs, p.text) <= p.n);
      s.rerr = "";
    } catch (e) { s.rerr = e.message; }
    s.hLoaded = s.aLoaded = true;
  })().finally(() => { s.loading = null; });
  await s.loading;
  if (t === target && (!quiet || relaySig(s) !== before)) renderAll();
}
// After the lines (renderAll0): what was sent and is not in the room yet, and the last error of a read or a send.
function relayTail(s) {
  for (const p of s.rpend || []) tl.append(el("div", { class: "um rl-pend" }, el("div", { class: "ub", text: p.text }), el("div", { class: "mt", text: "보내는 중…" })));
  for (const m of [s.rerr, s.serr]) if (m) tl.append(el("div", { class: "a-error", role: "alert", text: m }));
}
async function relaySend(text) {
  const t = target, s = ts(t);
  ta.value = ""; s.draft = ""; try { localStorage.removeItem(DRAFT_KEY(t)); } catch { /* no storage here: there is no stored draft to clear */ } autosize(); updateHints();
  const mine = { text, at: Date.now(), n: relayOwned(s.msgs, text) + (s.rpend || []).filter(p => relayNorm(p.text) === relayNorm(text)).length };
  s.rpend = (s.rpend || []).concat(mine); s.serr = "";
  chatStick = true; renderAll(); scrollChat(true);
  try { await api(`${relayApi(t)}/send`, "POST", { text }); }
  catch (e) {
    s.rpend = s.rpend.filter(p => p !== mine); s.serr = `보내지 못했어요: ${e.message}`;
    if (t === target) { if (!ta.value) { ta.value = text; autosize(); } renderAll(); scrollChat(true); }
    return;
  }
  await relayLoad(t, true);
}
const relayTick = () => { if (relayOn() && !document.hidden) relayLoad(target, true); };
setInterval(relayTick, RELAY_POLL_MS);
document.addEventListener("visibilitychange", relayTick);

// 설정 > JANDI: which computers this messenger reaches (settings().relays, hub/messenger-jandi.ts). A change is saved at once, like the 알림 switches on that
// screen, and the computer list is read again, so a new computer shows without a restart.
function msRelaySave(p, items, btn) {
  return busy(btn, async () => {
    p.s = await api(`/api/messengers/${enc(p.id)}`, "PUT", { relays: items });
    p.relAdd = {};
    prLoad();
    if (current === p.id) renderMessenger(p.id);
  });
}
function msRelaySection(p, s) {
  const r = s.relays;
  if (!r) return [];
  const add = p.relAdd = p.relAdd || {}, label = key => r.fields.find(f => f.key === key).label;
  const rows = r.items.map((c, i) => el("div", { class: "li", "data-relay": c.keyword },
    el("span", { class: "tx" }, el("div", { class: "hd", text: c.name }), el("div", { class: "sup", text: `${label("keyword")} ${c.keyword} · ${label("reply_prefix")} ${c.reply_prefix}` })),
    liEnd(el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(c.notify), "aria-label": `${c.name} ${r.notify}`, title: r.notify,
      onclick: ev => msRelaySave(p, r.items.map((x, j) => (j === i ? { ...x, notify: !x.notify } : x)), ev.currentTarget) }),
    el("button", { type: "button", class: "ib", "aria-label": `${c.name} 빼기`, onclick: ev => msRelaySave(p, r.items.filter((_, j) => j !== i), ev.currentTarget) }, icon("close")))));
  const form = el("div", { class: "li dcs-form", "data-relay-add": "1" },
    ...r.fields.map(f => el("div", {}, textField(f.label, input({ value: add[f.key] || "", name: `ms-relay-${f.key}`, oninput: ev => { add[f.key] = ev.target.value; } })), el("div", { class: "sup", text: f.hint }))),
    el("div", { class: "dcs-acts" }, el("button", { type: "button", class: "btn tonal", onclick: ev => msRelaySave(p, [...r.items, { ...add }], ev.currentTarget), text: r.add })));
  return [el("div", { class: "sec", text: r.label }), el("div", { class: "list" }, ...rows, form, el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: r.hint }))))];
}
