/* ---------- messages from another computer's gateway: a small card and one Korean line instead of the raw text ---------- */
// The three kinds hub/peer-monitor.ts leaves in a conversation: a handoff (the English instruction for the agent around the owner's words and the
// note; its event carries `via`), a dotz_peer send (plain text with `via`) and the handoff ack (a bot line with no `via`). Display only: the stored
// text, and what the agent read, stay as they were. Only the start of a message is looked at, so a chat of any size pays one string check per message.
// The second form is the hub's stored preview of the first (hub/conversations.ts previewOf drops the brackets and the id, then cuts at 120 characters).
const PEER_HANDOFF = /^(?:\[peer handoff from (.{1,40}?) id=([\w-]{1,40})\]|peer handoff from (.{1,40}?) :) The owner explicitly handed /;
const PEER_ACK = /^\u2705 (.{1,40}?)에서 넘긴 작업을 받아 이어서 해요 \(id ([\w-]{1,40})\)\s*$/;
const PEER_WORDS = "\n\nOwner's words (verbatim):\n", PEER_NOTE = "\n\nHandoff note:\n";
const PEER_KIND = { handoff: "작업 넘김", message: "메시지", ack: "작업 받음" };
function peerMsgHead(text) {
  if (text.startsWith("[peer handoff from ") || text.startsWith("peer handoff from ")) { const m = PEER_HANDOFF.exec(text.slice(0, 140)); return m && { kind: "handoff", from: m[1] || m[3], id: m[2] }; }
  if (text.charCodeAt(0) === 0x2705) { const m = PEER_ACK.exec(text.slice(0, 140)); return m && { kind: "ack", from: m[1], id: m[2] }; }
  return null;
}
// A conversation event as a peer message, or null. `via` alone is not enough: the owner's own message or decision answer from the other computer's page
// (a mail or settings conversation of this one, 34-peer-monitoring.js) carries it too, and stays his bubble.
function peerMsgOf(e) {
  const text = String(e.text ?? "");
  if (e.kind === "out") { const h = peerMsgHead(text); return h && h.kind === "ack" ? h : null; }
  if (!e.via || (e.kind !== "message" && e.kind !== "lane_message")) return null;
  if (e.decision || e.picks || /^(?:mail|th|settings):/.test(String(e.conv || e.channel || ""))) return null;
  const h = peerMsgHead(text), w = h && h.kind === "handoff" ? text.indexOf(PEER_WORDS) : -1, n = w < 0 ? -1 : text.indexOf(PEER_NOTE, w);
  if (n >= 0) return { ...h, words: text.slice(w + PEER_WORDS.length, n).trim(), note: text.slice(n + PEER_NOTE.length).trim() };
  return { kind: "message", from: e.via, words: text };
}
// One line for a preview, a notice row or a quote; any other text comes back unchanged. A send is already plain text.
function peerMsgLine(raw) {
  const s = String(raw ?? ""), h = peerMsgHead(s);
  return !h ? s : h.kind === "handoff" ? `${h.from}에서 작업을 넘겼어요` : `${h.from}에서 작업을 이어받았어요`;
}
function peerMsgCard(e, p, hm) {
  const words = p.kind === "ack" ? "넘긴 작업을 이어서 해요" : p.words;
  const body = words ? el("div", { class: "pmc-b" }, answerNode(choiceFree(words))) : null, long = !!body && (words.length > 420 || words.split("\n").length > 6);
  if (long) body.classList.add("clamp");
  const more = long ? el("button", { class: "ubm", type: "button", onclick: () => { const c = body.classList.toggle("clamp"); more.textContent = c ? "더 보기" : "접기"; } }, "더 보기") : null;
  const mt = el("div", { class: "mt", text: hm }), mid = e.mid || e.message_id || "";
  if (p.kind !== "ack" && mid) { DELIV.nodes.set(mid, { mt, base: hm }); if (DELIV.nodes.size > 600) DELIV.nodes.delete(DELIV.nodes.keys().next().value); paintDelivery(mid); }
  return el("div", { class: "bm pmc" }, filesNode(e.files, true), rpQuote(e),
    el("div", { class: "ccard" },
      el("div", { class: "pmc-hd" }, icon("desktop"), el("span", { class: "mn", text: p.from }), el("span", { class: "tag", text: PEER_KIND[p.kind], ...(p.id ? { title: `id ${p.id}` } : {}) }), mt),
      body, more, p.note ? el("details", { class: "more" }, el("summary", { text: "인계 메모" }), el("div", { class: "pmc-n" }, answerNode(choiceFree(p.note)))) : null));
}
