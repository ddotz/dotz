/* ---------- answer shapes: an assistant answer drawn by its written shape (site/prototype s-answers.js) ---------- */
// Only the shape of the text decides, never a model or a list of label names; a block with no shape returns null and stays as today's text
// (docs/ui-principles.md 12). The stored text is never touched: each row keeps its line as written in a clipped .mlist-url, the only selectable
// part of a card, so a copy gives the original markdown. An answer reaches the page whole (11-todo-strip.js streamIn), so it is drawn once, on
// its first paint: the live status and progress notes never come through here, and there is no text that later turns into a card.
const ANS_LABEL = /^\*\*([^*\n]{1,24}?):?\*\*:?\s+(\S.*)$/;
const ANS_EVIDENCE = /^근거:\s*(\S.*)$/;
const ANS_HEAD = /^\*\*([^*\n]+)\*\*$/, ANS_COUNT = /^(.+?)\s*\((\d+회)\)$/;
const ANS_SENTENCE = /^.+?[.!?](?=\s|$)/;
const ANS_WORDY = 30, ANS_LEAD_MAX = 80, ANS_TABLE_COLS = 5;
const ansRaw = line => `<span class="mlist-url" aria-hidden="true">${esc(line)}</span>`;
const ansRow = (key, value, raw) => `<div class="rc-row">${ansRaw(raw)}<span class="rc-k">${inline(key)}</span><span class="rc-w">${inline(value)}</span></div>`;
// The list as a card, or null. Two or more flat items only: one line or a nested list is lighter as text.
function ansListHtml(list) {
  if (list.items.length < 2 || list.items.some(i => i.sub)) return null;
  if (list.t === "ol") return `<div class="ans-card"><div class="rc-rows ans-steps">${list.items.map((x, i) => ansRow(String(i + 1), x.text, x.raw)).join("")}</div></div>`;
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
// The answer's last line "근거: a · b" as small pieces under everything else; the same line with text after it stays a meta line.
function ansEvidenceHtml(line, rest) {
  const m = ANS_EVIDENCE.exec(line.trim());
  if (!m || rest.some(l => l.trim())) return "";
  return `<div class="ans-ev">${ansRaw(line.trim())}${m[1].split(/\s+·\s+/).map(x => `<span>${inline(x)}</span>`).join("")}</div>`;
}
// An answer's files as rows in one card, the name first; a picture keeps its thumbnail.
function ansFiles(files) {
  const isImg = f => IMG_RE.test(f.name || f.path), docs = files.filter(f => !isImg(f)), box = filesNode(docs);
  if (box) {
    box.classList.add("ans-card", "ans-files");
    docs.forEach((f, i) => box.children[i].append(el("span", { class: "mlist-url", "aria-hidden": "true", text: `[file] ${f.path}` })));
  }
  return [box, filesNode(files.filter(isImg))];
}
// A "**title**" line over a list of labels: one part of a bundle report, or null when the list is not all labels. ansJoin draws the parts.
function ansSection(list, plain) {
  const kv = list.items.map(i => ANS_LABEL.exec(i.text));
  if (!kv.every(Boolean) || list.items.some(i => i.sub)) return null;
  const rows = kv.map((m, i) => {
    const c = ANS_COUNT.exec(m[1]);
    return `<div class="rc-row ans-li">${ansRaw(list.items[i].raw)}<span class="rc-k">${inline(c ? c[1] : m[1])}</span>${c ? `<span class="ans-n">${esc(c[2])}</span>` : ""}<span class="rc-w">${inline(m[2])}</span></div>`;
  });
  return { n: rows.length, plain, html: `<div class="rc-sh">${ansRaw(list.head)}<span>${inline(ANS_HEAD.exec(list.head)[1])}</span></div>${rows.join("")}` };
}
// Neighbouring parts of a bundle share one card; a lone part with a single item stays text.
function ansJoin(html, answer) {
  const out = [];
  for (let i = 0; i < html.length; i++) {
    if (typeof html[i] === "string") { out.push(html[i]); continue; }
    const run = [];
    for (; typeof html[i] === "object"; i++) run.push(html[i]);
    i--;
    const big = run.reduce((n, p) => n + p.n, 0) >= 2;
    if (big) answer.shaped = true;
    out.push(big ? `<div class="ans-card"><div class="rc-rows ans-secs">${run.map(p => p.html).join("")}</div></div>` : run.map(p => p.plain).join(""));
  }
  return out;
}
