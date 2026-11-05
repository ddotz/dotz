/* ---------- answer shapes: an assistant answer drawn by its written shape (site/prototype s-answers.js) ---------- */
// Only the shape of the text decides, never a model or a list of label names; a block with no shape returns null and stays as today's text
// (docs/ui-principles.md 12). The stored text is never touched: each row keeps its line as written in a clipped .mlist-url, the only selectable
// part of a card, so a copy gives the original markdown. An answer reaches the page whole (11-todo-strip.js streamIn), so it is drawn once, on
// its first paint: the live status and progress notes never come through here, and there is no text that later turns into a card.
const ANS_LABEL = /^\*\*([^*\n]{1,24}?):?\*\*:?\s+(\S.*)$/;
const ANS_SENTENCE = /^.+?[.!?](?=\s|$)/;
const ANS_WORDY = 30, ANS_LEAD_MAX = 80;
const ansRaw = line => `<span class="mlist-url" aria-hidden="true">${esc(line)}</span>`;
const ansRow = (key, value, raw) => `<div class="rc-row">${ansRaw(raw)}<span class="rc-k">${inline(key)}</span><span class="rc-w">${inline(value)}</span></div>`;
// The list as a card, or null. Two or more flat items only: one line or a nested list is lighter as text.
function ansListHtml(list) {
  if (list.items.length < 2 || list.items.some(i => i.sub)) return null;
  const kv = list.items.map(i => ANS_LABEL.exec(i.text));
  if (!kv.every(Boolean)) return null;
  const rows = kv.map((m, i) => ansRow(m[1], m[2], list.items[i].raw)).join("");
  return `<div class="ans-card"><div class="rc-rows ans-keys${kv.some(m => m[2].length > ANS_WORDY) ? " ans-wordy" : ""}">${rows}</div></div>`;
}
// The answer's one bold thing is its first sentence, drawn only when a shape below it carries the rest. A first line with no sentence end counts when it
// is short; a mark left open across the cut (** or a backtick) keeps the paragraph as written.
function ansLeadHtml(para) {
  const first = para[0], one = (ANS_SENTENCE.exec(first) || [first.length <= ANS_LEAD_MAX ? first : ""])[0];
  if (!one || one.split("**").length % 2 === 0 || one.split("`").length % 2 === 0) return "";
  return `<p><span class="ans-lead">${inline(one)}</span>${[inline(first.slice(one.length)), ...para.slice(1).map(inline)].join("<br>")}</p>`;
}
