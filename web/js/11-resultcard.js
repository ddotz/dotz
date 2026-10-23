// Result card: how a mail or a monitoring result (watch report, schedule run, service post) is drawn, in 채팅 and in 모니터링 alike.
// Header (who, when in KST, a status tag), the title (subject / result in words), the summary split into labelled sections, and the raw
// original folded behind "원문 보기" with pipe text drawn as a table. No run stats, ids or paths - only what the owner acts on.
const RC_LABELS = new Set(["요약", "할 일", "할일", "다음 할 일", "핵심", "결과", "변경", "참고", "상세", "확인할 것"]);
// "요약", "## 요약", "**할 일**", "할 일:" -> the label; any other line -> "".
function rcLabel(line) {
  const m = String(line).trim().match(/^(?:#{1,6}\s*)?(?:\*\*)?\s*([^*#:\n]{1,12}?)\s*:?\s*(?:\*\*)?\s*:?$/);
  return m && RC_LABELS.has(m[1].trim()) ? m[1].trim() : "";
}
// The original goes under a "원문" line (a mail) or a ```원문 fence (a watch report); everything before it is what the poster said.
function rcSplit(text) {
  let t = String(text ?? "").replace(/\r/g, "").trim();
  const raws = [];
  t = t.replace(/(?:^|\n)```원문\n([\s\S]*?)\n?```[ \t]*(?=\n|$)/g, (_, r) => { raws.push(r); return "\n"; }).trim();
  const m = t.match(/(?:^|\n)원문[ \t]*\n([\s\S]*)$/);
  if (m) { raws.push(m[1]); t = t.slice(0, m.index).trim(); }
  return { text: t, raw: raws.join("\n\n").trim() };
}
// [{h: label or "", body}]: text before the first label is its own unlabelled section.
function rcSections(text) {
  const out = [];
  let cur = { h: "", lines: [] };
  const push = () => { const body = cur.lines.join("\n").trim(); if (body) out.push({ h: cur.h, body }); };
  for (const line of String(text ?? "").split("\n")) {
    const h = rcLabel(line);
    if (h) { push(); cur = { h, lines: [] }; } else cur.lines.push(line);
  }
  push();
  return out;
}
// Lines like "a | b | c" (no outer pipes) in a run of two or more are a table: give them the outer pipes and a header separator so the
// markdown renderer (02-basic-markdown.js) draws a table. Code fences stay as they are.
function rcRawMd(raw) {
  const out = [];
  let run = [], fence = false;
  const cellRow = l => /^\s*\|/.test(l) ? false : (l.match(/\s\|\s/g) || []).length >= 1;
  const flush = () => {
    if (run.length >= 2) out.push(...run.map((l, i) => `| ${l.split("|").map(c => c.trim()).join(" | ")} |${i === 0 ? `\n|${" --- |".repeat(l.split("|").length)}` : ""}`));
    else out.push(...run);
    run = [];
  };
  for (const l of String(raw ?? "").replace(/\r/g, "").split("\n")) {
    if (/^\s*```/.test(l)) { flush(); fence = !fence; out.push(l); continue; }
    if (!fence && cellRow(l)) run.push(l); else { flush(); out.push(l); }
  }
  flush();
  return out.join("\n");
}
const rcWhen = t => !t || !Number.isFinite(Date.parse(t)) ? "" : kstDay(t) === kstDay(Date.now()) ? kstHM(t) : `${dayLabel(t)} ${kstHM(t)}`;
const rcPlain = s => String(s ?? "").replace(/^\s*#{1,6}\s*/, "").replace(/\*\*/g, "").trim();
// opts: src (sender or source), at (ISO), title (else the first line of text), text (summary; may carry the original), raw (else taken
// from text), tag (a node), actions (buttons), rawNode (raw -> node: draws the original itself, as a mail does), rawOpen (the original starts open).
// null when there is nothing to show.
function resultCard(opts) {
  const sp = rcSplit(opts.text), raw = opts.raw !== undefined ? String(opts.raw).trim() : sp.raw;
  let title = opts.title !== undefined ? rcPlain(opts.title) : "", body = sp.text;
  if (opts.title === undefined && body) {
    const [first, ...rest] = body.split("\n"), t = rcPlain(first);
    if (t && t.length <= 120 && !rcLabel(first)) { title = t; body = rest.join("\n").trim(); }
  }
  if (!title && !body && !raw && !opts.rawNode) return null;
  const when = rcWhen(opts.at);
  const kids = [el("div", { class: "rc-hd" }, opts.src ? el("span", { class: "rc-src", text: opts.src }) : null, opts.tag || null, when ? el("span", { class: "rc-time", text: when }) : null)];
  if (title) kids.push(el("div", { class: "rc-title", text: title }));
  for (const s of rcSections(body)) kids.push(el("div", { class: "rc-sec" }, s.h ? el("div", { class: "rc-sh", text: s.h }) : null, mdNode(s.body)));
  if (raw || opts.rawNode) {
    const sum = el("summary", { text: opts.rawOpen ? "원문 접기" : "원문 보기" }), box = el("div", { class: `rc-rawbody${opts.rawNode ? " own" : ""}` }), d = el("details", { class: "rc-raw" }, sum, box);
    const fill = () => { if (d.open && !box.firstChild) box.append(opts.rawNode ? opts.rawNode(raw) : mdNode(rcRawMd(raw))); };
    d.addEventListener("toggle", () => { sum.textContent = d.open ? "원문 접기" : "원문 보기"; fill(); });
    if (opts.rawOpen) { d.open = true; fill(); }
    kids.push(d);
  }
  if (opts.actions && opts.actions.length) kids.push(el("div", { class: "btns cc-act" }, ...opts.actions));
  return el("div", { class: "bm alert rc" }, ...kids);
}
