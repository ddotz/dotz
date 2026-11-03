/* ---------- a JANDI computer's chat: the normal chat view over another transport (docs/messengers/jandi.ko.md) ---------- */
// Picking a JANDI row of the computer list (33-peers.js prPick) makes the target jandi:<keyword>. The conversation is drawn by the same code as any
// other (renderAll, chatPush, msgNode): its lines are read from GET /api/jandi-peer/<keyword>/messages (hub/jandi-peers.ts) -> [{id, at, me, text}]
// and kept in ts(target).msgs as ordinary events (the owner's lines as "message", the computer's replies as "out"), polled while the page is
// visible; the composer sends through POST /api/jandi-peer/<keyword>/send. Nothing of it goes to this gateway's own chat API.
// What JANDI cannot carry (a running turn, tool cards, choices, files, the other computer's settings) is hidden by body.jp (css/11-peers.css).
const JP_POLL_MS = 4000, JP_PEND_MS = 90_000;
const jpKeyOf = p => { const k = p.url.slice(p.url.lastIndexOf("/") + 1); try { return decodeURIComponent(k); } catch { return k; } };
const jpNorm = x => String(x).replace(/\s+/g, " ").trim();
const jpOn = () => isJandiT(target) && current === "chat" && !chatList;
const jpBrand = () => (jpOn() ? targetName(target) : botName);
const jpOwned = (list, text) => list.filter(e => e.kind === "message" && jpNorm(e.text) === jpNorm(text)).length;

// The computers' names from the list (the title and the chip name the computer before the list is drawn again), and this page's state in the screen.
function jpNames() { for (const p of PR.list) if (p.via === "jandi" && !p.self) JP.name[`jandi:${jpKeyOf(p)}`] = p.name; }
function jpPaint() {
  const on = jpOn();
  document.body.classList.toggle("jp", on);
  const note = $("#jpnote");
  if (note) note.hidden = !on;
  const name = jpBrand();
  if ($("#brand-name").textContent !== name) $("#brand-name").textContent = name;
  if (on) {
    ta.placeholder = `${targetName(target)}에게 잔디로 보내요`;
    ta.disabled = false; $("#send-btn").disabled = false;
  }
  if (on !== JP.on) { JP.on = on; if (typeof prPaint === "function") prPaint(); }
}
function jpEnter(p) {
  const t = `jandi:${jpKeyOf(p)}`;
  JP.name[t] = p.name;
  if (!isJandiT(target)) JP.back = target;
  go("chat", t);
}
// Picking this computer again: back to the conversation the owner came from (the main chat when that is not known).
function jpLeave() { go("chat", validTarget(JP.back) && !isJandiT(JP.back) ? JP.back : MAIN); }

// The lines as events. A line with no known time follows the one before it.
function jpEvents(t, lines) {
  let last = Date.now();
  return lines.map(l => {
    last = l.at > 0 ? l.at : last;
    const ts = new Date(last).toISOString();
    return l.me ? { ts, kind: "message", source: "web", text: l.text } : { ts, kind: "out", source: "jandi", target: t, peer: targetName(t), text: l.text };
  });
}
const jpSig = s => JSON.stringify([s.jids, s.jerr, s.jserr, (s.jpend || []).length]);
async function jpLoad(t, quiet) {
  const s = ts(t), before = jpSig(s);
  if (s.loading) return s.loading;
  s.loading = (async () => {
    try {
      const lines = await api(`/api/jandi-peer/${enc(t.slice(6))}/messages`);
      const list = Array.isArray(lines) ? lines : [];
      s.msgs = jpEvents(t, list); s.mk = new Set(s.msgs.map(msgKey)); s.jids = list.map(l => l.id).join(",");
      const now = Date.now();
      s.jpend = (s.jpend || []).filter(p => now - p.at < JP_PEND_MS && jpOwned(s.msgs, p.text) <= p.n);
      s.jerr = "";
    } catch (e) { s.jerr = `잔디: ${e.message}`; }
    s.hLoaded = s.aLoaded = true;
  })().finally(() => { s.loading = null; });
  await s.loading;
  if (t === target && (!quiet || jpSig(s) !== before)) renderAll();
}
// After the lines (renderAll0): what was sent and is not in the room yet, and the last error of a read or a send.
function jpTail(s) {
  for (const p of s.jpend || []) tl.append(el("div", { class: "um jp-pend" }, el("div", { class: "ub", text: p.text }), el("div", { class: "mt", text: "보내는 중…" })));
  for (const m of [s.jerr, s.jserr]) if (m) tl.append(el("div", { class: "a-error", role: "alert", text: m }));
}
async function jpSend(text) {
  const t = target, s = ts(t);
  ta.value = ""; s.draft = ""; try { localStorage.removeItem(DRAFT_KEY(t)); } catch {} autosize(); updateHints();
  const mine = { text, at: Date.now(), n: jpOwned(s.msgs, text) + (s.jpend || []).filter(p => jpNorm(p.text) === jpNorm(text)).length };
  s.jpend = (s.jpend || []).concat(mine); s.jserr = "";
  chatStick = true; renderAll(); scrollChat(true);
  try { await api(`/api/jandi-peer/${enc(t.slice(6))}/send`, "POST", { text }); }
  catch (e) {
    s.jpend = s.jpend.filter(p => p !== mine); s.jserr = `보내지 못했어요: ${e.message}`;
    if (t === target) { if (!ta.value) { ta.value = text; autosize(); } renderAll(); scrollChat(true); }
    return;
  }
  await jpLoad(t, true);
}
const jpTick = () => { if (jpOn() && !document.hidden) jpLoad(target, true); };
setInterval(jpTick, JP_POLL_MS);
document.addEventListener("visibilitychange", jpTick);
