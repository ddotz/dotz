/* ---------- a message sent while the gateway cannot be reached ---------- */
// The owner's text is never lost and no error shows for an unreachable gateway (a reverse proxy's 502/503/504, or no answer at all): the message waits here as a dimmed bubble
// of the owner's, like a queued one (14-slash-commands.js qdBubble), and goes out by itself when the gateway answers. A real refusal (4xx, a validation error) is an error as before.
// Never twice: the send keeps its `cid` (the gateway answers a repeated cid as the first, hub/routes.ts), and because that memory is lost with a gateway restart, the
// gateway's history is read first (GET /api/history?after=): a message of the same text stored since the first try was delivered, and is not sent again.
// The list is kept in this browser (localStorage), so a reload keeps the waiting messages and sends them at the next attach of the stream. Files are already uploaded when
// a message is sent and travel in its body. A message with none of this (a conversation of another computer) fails as before.
const OUTBOX_KEY = "dotz.outbox";
let OUTBOX = (() => { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch { return []; } })();
let obT = 0, obN = 0, obBusy = false;
const newCid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const outboxSave = () => { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(OUTBOX)); } catch { return; } };
const outboxDown = e => !e.data && ((e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) || [502, 503, 504].includes(e.status));
const outboxItems = () => OUTBOX.map(o => ({ id: o.body.cid, text: o.text, target: o.t, local: true }));
const outboxBubble = i => el("div", { class: "um qd" }, el("div", { class: "ub", text: i.text }), el("div", { class: "qd-ln" }, el("span", { text: TX("decision.pending.send") })));
// POST /api/message; null when the gateway could not be reached and the message waits in the outbox.
async function sendMsgOut(t, text, body, peer) {
  const b = body.cid ? body : { ...body, cid: newCid() };
  try { return await api("/api/message", "POST", b); } catch (e) {
    if (peer || !outboxDown(e)) throw e;
    OUTBOX.push({ t, text, body: b, at: Date.now() }); outboxSave(); renderQueue(); outboxLater();
    return null;
  }
}
const outboxLater = () => { if (!obT) obT = setTimeout(outboxFlush, Math.min(1000 * 2 ** obN++, 15000)); };
const outboxGo = () => { if (OUTBOX.length) outboxFlush(); };
// Was this message stored by the gateway after the first try? The clocks differ by S.work_skew; 5 s of margin.
async function outboxHas(o) {
  const after = new Date(o.at + ((S && S.work_skew) || 0) - 5000).toISOString();
  const r = await api(`/api/history?target=${enc(o.t)}&limit=100&after=${enc(after)}`);
  return (r.events || []).some(e => (e.kind === "message" || e.kind === "lane_message") && e.source === "web" && String(e.text ?? "").trim() === o.text.trim());
}
async function outboxFlush() {
  clearTimeout(obT); obT = 0;
  if (obBusy) return;
  obBusy = true;
  try {
    while (OUTBOX.length) {
      const o = OUTBOX[0];
      try {
        if (await outboxHas(o)) loadTarget(o.t, true); else await api("/api/message", "POST", o.body);
      } catch (e) {
        if (outboxDown(e)) { outboxLater(); return; }
        toast(e.message, true);
      }
      OUTBOX.shift(); obN = 0; outboxSave(); renderQueue();
    }
  } finally { obBusy = false; }
}
