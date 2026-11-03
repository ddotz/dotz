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
// The original folded behind "원문 보기" (raw: the text; opts.rawNode draws it itself, opts.rawOpen starts it open).
function rcRawFold(raw, opts = {}) {
  const sum = el("summary", { text: opts.rawOpen ? "원문 접기" : "원문 보기" }), box = el("div", { class: `rc-rawbody${opts.rawNode ? " own" : ""}` }), d = el("details", { class: "rc-raw" }, sum, box);
  const fill = () => { if (d.open && !box.firstChild) box.append(opts.rawNode ? opts.rawNode(raw) : mdNode(rcRawMd(raw))); };
  d.addEventListener("toggle", () => { sum.textContent = d.open ? "원문 접기" : "원문 보기"; fill(); });
  if (opts.rawOpen) { d.open = true; fill(); }
  return d;
}
// A section that is a list of "<key> <what> · <detail>" lines (a time, 답장, 가격 ...) is the prototype's key-column rows: the key muted, what it is
// in 500, the detail muted after it, a price change as the old value struck and the new one in the accent. Any other list stays a list.
const RC_KEY = /^(\d{1,2}:\d{2}|답장|가격|재고|새 글|확인|변경)\s+(\S.*)$/;
function rcRowsNode(text) {
  const lines = String(text ?? "").split("\n").map(l => l.trim()).filter(Boolean), out = [];
  let n = 0;
  for (const l of lines) {
    const m = /^[-*\u2022]\s+(.*)$/.exec(l), k = m && RC_KEY.exec(m[1]);
    if (!m) {   // a short line without punctuation is a small heading over the rows below it (오늘 일정 / 메일 / 감시)
      if (l.length > 16 || /[.!?,]/.test(l)) return null;
      out.push(el("div", { class: "rc-sh", text: l }));
      continue;
    }
    if (!k) return null;
    const chg = NW_CHANGE.exec(k[2]), [what, detail] = chg ? [chg[1].trim(), null] : k[2].split(/\s+·\s+/, 2);
    out.push(el("div", { class: "rc-row" }, el("span", { class: "rc-k", text: k[1] }), el("span", { class: "rc-w" }, el("b", { text: what }), chg ? el("span", { class: "rc-d nw-chg" }, el("s", { text: chg[2] }), " → ", el("em", { text: chg[3] })) : detail ? el("span", { class: "rc-d", text: detail }) : null)));
    n++;
  }
  return n >= 2 ? el("div", { class: "rc-rows" }, ...out) : null;
}
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
  for (const s of rcSections(body)) {
    // [file] lines become file chips (as in a chat bubble and on Discord), and a path in the text opens like one
    const fl = fileLines(s.body), rows = rcRowsNode(fl.text), md = !rows && fl.text.trim() ? mdNode(fl.text) : null;
    kids.push(el("div", { class: "rc-sec" }, s.h ? el("div", { class: "rc-sh", text: s.h }) : null, rows || md, md ? pathFiles(md) : null, filesNode(fl.files)));
  }
  if (raw || opts.rawNode) kids.push(rcRawFold(raw, opts));
  if (opts.actions && opts.actions.length) kids.push(el("div", { class: "btns cc-act" }, ...opts.actions));
  return el("div", { class: "bm alert rc" }, ...kids);
}

// A bot answer shaped like a morning briefing (a run of "- 10:00 title" lines, then counts and a mail line) is drawn as rows and chips;
// the words are the bot's own and stay as written. Any other text returns null and is drawn as plain markdown.
const HCB_ROW = /^\s*[-*\u2022]\s*(\d{1,2}:\d{2})\s+(\S.*?)\s*$/;
const HCB_MAIL = /메일\s*\d+통/;
const HCB_COUNT = /\d+\s*(?:개|통|건|명)/;
const hcbNums = s => { const out = []; String(s).split(/(\d+)/).forEach((p, i) => out.push(i % 2 ? el("span", { class: "hcb-n", text: p }) : p)); return out; };
function hcBriefParse(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  let a = -1, b = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!HCB_ROW.test(lines[i])) continue;
    let j = i;
    while (j + 1 < lines.length && HCB_ROW.test(lines[j + 1])) j++;
    if (j > i) { a = i; b = j; break; }
    i = j;
  }
  if (a < 0) return null;
  let h = a - 1;
  while (h >= 0 && !lines[h].trim()) h--;
  const head = h >= 0 && lines[h].trim().length <= 24 && !/[.!?요]$/.test(lines[h].trim()) ? lines[h].trim() : "";
  const pre = lines.slice(0, head ? h : a).join("\n").trim();
  return { pre, head, rows: lines.slice(a, b + 1).map(l => HCB_ROW.exec(l).slice(1, 3)), post: lines.slice(b + 1) };
}
function hcBriefNode(text) {
  const p = hcBriefParse(text);
  if (!p) return null;
  const kids = [];
  if (p.pre) kids.push(mdNode(p.pre));
  const tag = /브리핑|아침/.test(text) ? el("span", { class: "tag pri", text: "아침 점검" }) : null;
  kids.push(el("div", { class: "hcb-card" },
    tag || p.head ? el("div", { class: "hcb-hd" }, tag, p.head ? el("span", { class: "hcb-h" }, ...hcbNums(p.head)) : null) : null,
    el("div", { class: "hcb-rows" }, ...p.rows.map(([t, title]) => el("div", { class: "hcb-r" }, el("span", { class: "hcb-t", text: t }), el("span", { class: "hcb-ti", text: title }))))));
  let plain = [];
  const flush = () => { const s = plain.join("\n").trim(); plain = []; if (s) kids.push(mdNode(s)); };
  for (const l of p.post) {
    if (!l.trim()) { plain.push(l); continue; }
    if (HCB_MAIL.test(l)) { flush(); kids.push(el("div", { class: "hcb-chip" }, icon("mail"), el("span", {}, ...hcbNums(l.trim())))); }
    else if (HCB_COUNT.test(l) && l.trim().length <= 40) { flush(); kids.push(el("div", { class: "hcb-ln" }, ...hcbNums(l.trim()))); }
    else plain.push(l);
  }
  flush();
  return el("div", { class: "hcb" }, ...kids);
}
