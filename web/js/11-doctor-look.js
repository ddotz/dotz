const DL_KEY = "dotz.doctor-look", DL_KEEP = 100, DL_STATUS_MARK = /^\s*\[[^\]\n]{1,10}\][ \t]*/, DL_WATCH_MS = 1000;
const DL = { st: new Map(), watch: new Map(), sent: (() => { try { return new Set(JSON.parse(localStorage.getItem(DL_KEY)) || []); } catch { return new Set(); } })() };
const dlWord = () => TX("home.doctor_look.mark");
function dlSplit(text, wk) {
  const lines = String(text ?? "").split("\n"), mark = ` · ${dlWord()}`, lead = `${TX("home.worklog.doctor")}:`;
  const first = lines.map(l => l.replace(DL_STATUS_MARK, "")).find((l, i) => (i === 0 || !lines[i - 1].trim()) && l.startsWith(lead)) || "";
  const doctor = wk === "doctor" || !!first;
  const head = first ? first.slice(lead.length).split(" · ")[0].trim() : "";
  return { doctor, head, lines: lines.map(l => {
    const told = /^\s*- /.test(l), look = doctor && told && l.trimEnd().endsWith(mark);
    return { text: look ? l.trimEnd().slice(0, -mark.length).replace(/^\s*- /, "").trim() : l, look, hint: doctor && !told && !!l.trim() && l.includes(dlWord()) && !l.trimEnd().endsWith(mark) };
  }) };
}
const dlReply = (head, line) => TX("home.doctor_look.reply", { day: head, line });
const dlSaid = (m, reply) => (m.kind === "message" || m.kind === "lane_message") && String(m.text ?? "").trim() === reply;
const dlQueued = (t, reply) => OUTBOX.some(o => o.t === t && o.text === reply);
function dlState(key, t, reply) {
  if (DL.st.has(key)) return DL.st.get(key);
  if (DL.sent.has(key)) return "sent";
  if (dlQueued(t, reply)) return "sending";
  return S && ts(t).msgs.some(m => dlSaid(m, reply)) ? "sent" : "";
}
function dlLabel(b) {
  const st = dlState(b.dataset.dl, b.dataset.dlt, b.dataset.dlr);
  const word = TX(st === "sending" ? "home.doctor_look.sending" : st === "sent" ? "home.doctor_look.sent" : st === "failed" ? "home.doctor_look.again" : "home.doctor_look.go");
  b.textContent = word;
  b.setAttribute("aria-label", TX("home.doctor_look.aria", { state: word, line: b.dataset.dll }));
  b.disabled = st === "sending" || st === "sent";
  b.classList.toggle("dl-sent", st === "sent");
  if (st === "sending" && !DL.st.has(b.dataset.dl)) dlWatch(b.dataset.dl, b.dataset.dlt, b.dataset.dlr, b.dataset.dla);
}
const dlPaint = key => { for (const b of document.querySelectorAll(".dl-btn")) if (b.dataset.dl === key) dlLabel(b); };
function dlKeep(key) {
  DL.sent.add(key);
  try { localStorage.setItem(DL_KEY, JSON.stringify([...DL.sent].slice(-DL_KEEP))); } catch { return; }
}
async function dlHas(t, reply, since) {
  try {
    const r = await api(`/api/history?target=${enc(t)}&limit=500&after=${enc(since)}`);
    return (r.events || []).some(m => dlSaid(m, reply));
  } catch (e) {
    if (outboxDown(e)) return null;
    throw e;
  }
}
function dlWatch(key, t, reply, since) {
  if (DL.watch.has(key)) return;
  const tick = async () => {
    let has = null;
    try { has = dlQueued(t, reply) ? null : await dlHas(t, reply, since); } catch (e) { has = false; toast(e.message, true); }
    if (has === null) return void DL.watch.set(key, setTimeout(tick, DL_WATCH_MS));
    DL.watch.delete(key);
    if (has) dlKeep(key); else DL.st.set(key, "failed");
    dlPaint(key);
  };
  DL.watch.set(key, setTimeout(tick, DL_WATCH_MS));
}
async function dlSend(key, t, text, since) {
  const st = dlState(key, t, text);
  if (st === "sending" || st === "sent") { dlPaint(key); return; }
  DL.st.set(key, "sending"); dlPaint(key);
  try {
    if (await dlHas(t, text, since)) { dlKeep(key); DL.st.delete(key); dlPaint(key); return; }
    const r = await sendMsgOut(t, text, { text, ...(isRowT(t) ? { conv: t } : {}), ...(isWorking(t) ? { mode: "steer" } : {}) });
    if (r && r.queued) { putQueue(QUEUE.filter(i => i.id !== r.queued.id).concat(r.queued)); renderQueue(); }
    DL.st.delete(key);
    if (r) dlKeep(key);
    if (t === target) { putChatStick(true); scrollChat(true); }
  } catch (e) { DL.st.set(key, "failed"); toast(e.message, true); }
  dlPaint(key);
}
function dlMarkedTextNode(li) {
  const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.trim()) last = n;
  return last && last.data.trimEnd().endsWith(`· ${dlWord()}`) ? last : null;
}
function dlMarks(nodes, src) {
  if (!nodes || !src || !["out", "decision"].includes(src.kind) || (src.source || src.by) !== "gateway") return nodes;
  const sp = dlSplit(src.text, src.wk), looks = sp.lines.filter(l => l.look);
  if (!looks.length) return nodes;
  const roots = (Array.isArray(nodes) ? nodes : [nodes]).filter(n => n && n.querySelectorAll), t = src.target || src.open || "alert";
  const plain = s => String(s).replace(/[*`_]/g, "").replace(/\s+/g, " ").trim(), done = new Set();
  for (const li of roots.flatMap(r => [...r.querySelectorAll("li")]).filter(x => !x.querySelector("li, .dl-btn"))) {
    const n = dlMarkedTextNode(li);
    if (!n) continue;
    const said = plain(li.textContent.trimEnd().slice(0, -`· ${dlWord()}`.length)), look = looks.find(l => !done.has(l) && [l.text, noticeKo(l.text, NK)].some(x => plain(x) === said));
    if (!look) continue;
    done.add(look);
    const line = look.text, text = dlReply(sp.head, line), key = `${src.ts}|${line}`;
    n.data = n.data.trimEnd().slice(0, -`· ${dlWord()}`.length).trimEnd();
    const b = el("button", { class: "btn tonal inrow dl-btn", type: "button", "data-dl": key, "data-dlt": t, "data-dlr": text, "data-dll": line, "data-dla": src.ts,
      onclick: ev => { ev.stopPropagation(); dlSend(key, t, text, src.ts); } });
    dlLabel(b);
    li.append(" ", b);
  }
  if (done.size === looks.length) for (const h of sp.lines.filter(l => l.hint)) dlDropHint(roots, ntPlain(h.text).trim());
  return nodes;
}
function dlDropHint(roots, hint) {
  for (const r of roots) for (const p of r.querySelectorAll("p")) {
    if (p.textContent.trim() === hint) { p.remove(); continue; }
    for (const n of [...p.childNodes]) if (n.nodeType === 3 && n.data.trim() === hint) {
      const br = n.nextSibling && n.nextSibling.nodeName === "BR" ? n.nextSibling : n.previousSibling && n.previousSibling.nodeName === "BR" ? n.previousSibling : null;
      if (br) br.remove();
      n.remove();
    }
  }
}
