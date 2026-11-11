/* ---------- answer shapes: an assistant answer drawn by its written shape (site/prototype s-answers.js) ---------- */
// The shapes are read in one place, hub/message-spec-derive.ts (web/js/01-message-spec.js is that code, deriveSpec); this file only draws the spec it returns, one html builder
// per component in SPEC_HTML. Only the shape of the text decides, never a model or a list of label names; text with no shape stays as today's text
// (docs/ui-principles.md 12). The stored text is never touched, and a card holds only the words it shows, so a selection copies what it covers.
// answerNode is the one way a model's text reaches the screen: a chat answer, a session report, a notice sheet, a monitoring card. A surface that calls mdNode instead draws the
// same text differently, and hub/answer-surfaces-web.test.ts fails on it. An answer reaches the page whole (11-todo-strip.js streamIn), so it is drawn once, on
// its first paint: the live status and progress notes never come through here, and there is no text that later turns into a card.
const ANS_SENTENCE = /^.+?[.!?](?=\s|$)/;
const ANS_WORDY = 30, ANS_LEAD_MAX = 80, ANS_TABLE_COLS = 5;
// shaped: the answer already has a shape (its files). lead: false where a title above the body is already the one bold thing (a sheet, a result card).
// spec: the spec the hub stored with the answer (event.spec); a spec that fails validateSpec is not drawn, the text is.
const answerNode = (text, { cls = "md", shaped = false, lead = true, spec } = {}) => mdNode(text, cls, false, { shaped, lead, spec: spec && validateSpec(spec).ok ? spec : null });
// A body with its `[file]` lines taken out (fileLines): the text, the file rows, then the evidence line, which stays the last thing.
function answerParts({ text, files }, o = {}) {
  const md = answerNode(text, { ...o, shaped: files.length > 0 }), ev = files.length ? md.querySelector(":scope > .ans-ev:last-child") : null;
  return [md, ...ansFiles(files), ev].filter(Boolean);
}
const ansRow = (key, value) => `<div class="rc-row"><span class="rc-k">${inline(key)}</span><span class="rc-w">${value}</span></div>`;
// The answer's one bold thing is its first sentence, drawn only when a shape below it carries the rest. A first line with no sentence end counts when it
// is short; a mark left open across the cut (** or a backtick) keeps the paragraph as written.
function ansLeadHtml(para) {
  const first = para[0], one = (ANS_SENTENCE.exec(first) || [first.length <= ANS_LEAD_MAX ? first : ""])[0];
  if (!one || one.split("**").length % 2 === 0 || one.split("`").length % 2 === 0) return "";
  return `<p><span class="ans-lead">${inline(one)}</span>${[inline(first.slice(one.length)), ...para.slice(1).map(inline)].join("<br>")}</p>`;
}
// An answer's files as rows in one card, the name first and selectable; a picture keeps its thumbnail.
function ansFiles(files) {
  const isImg = f => IMG_RE.test(f.name || f.path), box = filesNode(files.filter(f => !isImg(f)).map(f => ({ ...f, row: true })));
  if (box) box.classList.add("ans-card", "ans-files");
  return [box, filesNode(files.filter(isImg))];
}

/* ---------- the spec as html ---------- */
// A changed value ("5,308ms → 36ms") is the old one struck and the new one strong; any other value is a line of text.
const specValue = r => r.from !== undefined ? `<span class="rc-d nw-chg"><s>${inline(r.from)}</s> → <em>${inline(r.to)}</em></span>` : inline(r.value);
const specHead = head => head ? `<p>${inline(`**${head}**`)}</p>` : "";
const specCard = body => `<div class="ans-card">${body}</div>`;
const specLines = text => text.split("\n").map(inline).join("<br>");
// A fence tagged 목록 is a list shown as UI rows (hub/listblock.ts writes it): each row gets a round initial, the meta on the right and a count badge.
function specRowsHtml({ title, rows }) {
  const html = rows.map(({ title: t, sub: s = "", meta = "", badge = "" }) => {
    const initial = Array.from(t.replace(/^[^\p{L}\p{N}]+/u, ""))[0] || "·";
    return `<div class="mlist-row"><span class="mlist-av" aria-hidden="true">${esc(initial)}</span><div class="mlist-main"><div class="mlist-t" title="${esc(t)}">${esc(t)}</div>${s ? `<div class="mlist-s">${esc(s)}</div>` : ""}</div>${meta || badge ? `<div class="mlist-r">${meta ? `<span class="mlist-m">${esc(meta)}</span>` : ""}${/^\d+\+?$/.test(badge) && badge !== "0" ? `<span class="mlist-b">${esc(badge)}</span>` : ""}</div>` : ""}</div>`;
  });
  return `<div class="mlist">${title ? `<div class="mlist-h">${esc(title)}</div>` : ""}${html.join("")}</div>`;
}
// A table of a head and rows within ANS_TABLE_COLS columns is a card (its first column the row names); any other table is the plain one.
function specTableHtml({ head, rows }, c) {
  const card = !c.basic && !!head && rows.length > 0 && head.length <= ANS_TABLE_COLS;
  return `<div class="${card ? "ans-card ans-tb" : "tbl"}"><table>${head ? `<thead><tr>${head.map(x => `<th>${inline(x)}</th>`).join("")}</tr></thead>` : ""}<tbody>${rows.map(r => `<tr>${r.map((x, i) => card && !i ? `<th>${inline(x)}</th>` : `<td>${inline(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function specCodeHtml({ code, lang }, c) {
  const l = (lang || "").trim();
  if (c.relayed) return `<pre><code>${esc(code)}</code></pre>`;
  // A fence tagged 원문 is a post's raw machine output (hub/watchtext.ts rawFence): folded, monospace, tap to open.
  return l === "dotz-settings" ? settingsCardHtml(code) : l === "원문" ? `<details class="more raw"><summary>${esc(TX("base.raw"))}</summary><pre>${esc(code)}</pre></details>` : codeBlockHtml(lang || "", code);
}
// component -> html; the catalog is hub/message-spec.ts CATALOG. Every string goes through inline or esc. A Files element draws nothing: the files of an answer are rows drawn from its [file] lines (ansFiles).
const SPEC_HTML = {
  Message: () => "",
  Text: p => `<p>${specLines(p.text)}</p>`,
  Heading: p => `<p class="h"><b>${inline(p.text)}</b></p>`,
  Bullets: p => { const t = p.ordered ? "ol" : "ul"; return `${specHead(p.head)}<${t}>${p.items.map(i => `<li${i.sub ? ' class="sub"' : ""}>${inline(i.text)}</li>`).join("")}</${t}>`; },
  Steps: p => specHead(p.head) + specCard(`<div class="rc-rows ans-steps">${p.items.map((x, i) => ansRow(String(i + 1), inline(x))).join("")}</div>`),
  Schedule: p => specHead(p.head) + specCard(timeRowsHtml(p.rows.map(r => ({ text: `${r.time} ${r.text}` })))),
  Facts: p => specHead(p.head) + specCard(`<div class="rc-rows ans-keys${p.rows.some(r => (r.value ?? `${r.from} → ${r.to}`).length > ANS_WORDY) ? " ans-wordy" : ""}">${p.rows.map(r => ansRow(r.key, specValue(r))).join("")}</div>`),
  Section: p => `<div class="rc-sh"><span>${inline(p.title)}</span></div>${p.rows.map(r => `<div class="rc-row ans-li"><span class="rc-k">${inline(r.key)}</span>${r.count ? `<span class="ans-n">${esc(r.count)}</span>` : ""}<span class="rc-w">${specValue(r)}</span></div>`).join("")}`,
  Table: specTableHtml,
  Rows: specRowsHtml,
  Chart: (p, c) => c.relayed ? `<pre><code>${esc(p.spec)}</code></pre>` : `<figure class="ans-chart" data-chart="${esc(p.spec)}" aria-label="${esc(p.title || TX("base.chart.label"))}"></figure>`,
  Sources: p => sourceListHtml({ head: p.head, items: p.items }),
  Quote: p => `<blockquote>${p.lines.map(inline).join("<br>")}</blockquote>`,
  Meta: p => `<p class="meta">${inline(p.text === CHART_NOTE ? TX("base.chart.bad_spec") : p.text)}</p>`,
  Evidence: p => `<div class="ans-ev">${p.items.map(x => `<span>${inline(x)}</span>`).join("")}</div>`,
  Code: specCodeHtml,
  Rule: () => "<hr>",
  Choice: (p, c, e) => `<p>${specLines(elementPlain(e))}</p>`,
  Files: () => "",
};
const SPEC_SHAPES = new Set(["Steps", "Schedule", "Facts", "Section", "Evidence"]);
// shaped: the answer has a shape already (its files); a shape in the spec makes it one too, and then its first paragraph leads with its first sentence (ansLeadHtml).
// basic: text that is not an answer, so a table is a plain table. relayed: another computer's text, every fence a plain code block.
// Neighbouring Sections share one card.
// A Status is the caller's status tag in front of the first line (toneLead), which knows whether a [run] still runs: it is not drawn here.
function specHtml(spec, { shaped = false, lead = true, basic = false, relayed = false } = {}) {
  const els = specChildren(spec).filter(e => e.type !== "Status"), c = { basic, relayed }, html = [];
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (e.type === "Section") {
      const run = [];
      for (; i < els.length && els[i].type === "Section"; i++) run.push(els[i]);
      i--;
      html.push(specCard(`<div class="rc-rows ans-secs">${run.map(s => SPEC_HTML.Section(s.props)).join("")}</div>`));
      shaped = true;
      continue;
    }
    if (!basic && (SPEC_SHAPES.has(e.type) || (e.type === "Table" && e.props.head && e.props.rows.length > 0 && e.props.head.length <= ANS_TABLE_COLS))) shaped = true;
    html.push((SPEC_HTML[e.type] || (() => ""))(e.props, c, e));
  }
  const first = els[0], para = first && (first.type === "Text" ? first.props.text.split("\n") : first.type === "Choice" ? elementPlain(first).split("\n") : null), rich = shaped && lead && para ? ansLeadHtml(para) : "";
  if (rich) html[0] = rich;
  return html.join("");
}
