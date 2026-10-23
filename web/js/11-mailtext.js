/* ---------- a mail's original as text (no HTML kept): read top-down, laid out ---------- */
// Plain-text mail is parsed once per message into blocks (mtParse, no DOM, cached by its text) and drawn from them when the original opens:
// paragraphs, small headings ("| 요약 정보", "[제목]"), "key: value" runs as a two-column list, pipe lines as a table, bullet and numbered lines as
// lists, '>' quotes and "-----Original Message-----" / "보낸 사람:" tails folded, long rules as a rule, URLs and e-mail addresses as links.
// Nothing here runs on an event tick: the timeline only draws the blocks of a message that is on screen.
const MT = { cache: new Map(), max: 60, quoteFold: 4, maxLines: 4000 };
const MT_RULE = /^\s*(?:[=\-_*~#+]\s*){4,}$/;
const MT_QUOTE = /^\s*>/;
const MT_FOLD_MARK = /^\s*[-=_*~]{2,}\s*(?:original message|forwarded message|reply message|원본 메시지|원본 메일|전달된 메시지|전달한 메시지|이전 메시지)\s*[-=_*~]{2,}\s*$/i;
const MT_HDR_KEY = /^\s*(?:from|to|cc|sent|date|subject|보낸\s*사람|보낸\s*이|보낸\s*날짜|보낸\s*시간|받는\s*사람|받는\s*이|참조|날짜|제목)\s*[:：]/i;
const MT_HDR_START = /^\s*(?:from|보낸\s*사람|보낸\s*이)\s*[:：]/i;
const MT_WROTE = /^\s*(?:on\s.{8,120}\swrote:|.{4,120}(?:님이|님께서)\s*(?:작성|쓴\s*글).{0,10})\s*$/i;
const MT_HEAD = [/^\s*\|\s+([^|]{1,60}?)\s*$/, /^\s*\[([^\[\]]{1,50})\]\s*$/, /^\s*#{1,6}\s+(.{1,60}?)\s*$/, /^\s*[■◆◈]\s*(.{1,50}?)\s*$/];
const MT_KV = /^\s*([A-Za-z가-힣][^:：|\n]{0,23}?)\s*[:：]\s+(\S.*?)\s*$/;
const MT_LI = /^(\s*)(?:([-*•·▪‣◦○●▶▷■□])|(\d{1,3})[.)])\s+(\S.*?)\s*$/;
const MT_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const mtHead = l => { for (const re of MT_HEAD) { const m = l.match(re); if (m) return m[1]; } return ""; };
const mtKv = l => { const m = l.match(MT_KV); return m && !/^https?$/i.test(m[1]) ? [m[1].trim(), m[2]] : null; };
function mtCells(l) {
  if (!l.includes("|")) return null;
  const c = l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(s => s.trim());
  return c.length >= 2 && c.filter(Boolean).length >= 2 ? c : null;
}
// Where the quoted tail of the mail starts (marker line, "On … wrote:", or a header run of From:/To:/Date:), or -1. Never at the very top.
function mtFoldAt(lines) {
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (MT_FOLD_MARK.test(l) || MT_WROTE.test(l)) return i;
    if (MT_HDR_START.test(l) && lines.slice(i + 1, i + 6).filter(x => MT_HDR_KEY.test(x)).length >= 2) return i;
  }
  return -1;
}
function mtBlocks(lines) {
  const out = [], n = lines.length;
  const run = (from, ok) => { let k = from; while (k < n && ok(lines[k])) k++; return k; };
  const startsBlock = i => {
    const l = lines[i];
    return !l.trim() || MT_RULE.test(l) || MT_QUOTE.test(l) || !!mtHead(l) || MT_LI.test(l)
      || (!!mtCells(l) && i + 1 < n && !!mtCells(lines[i + 1])) || (!!mtKv(l) && i + 1 < n && !!mtKv(lines[i + 1]));
  };
  let i = 0;
  while (i < n) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (MT_RULE.test(l)) { out.push({ t: "hr" }); i++; continue; }
    if (MT_QUOTE.test(l)) {
      const e = run(i, x => MT_QUOTE.test(x));
      const inner = lines.slice(i, e).map(x => x.replace(/^(\s*>)+\s?/, ""));
      out.push({ t: "quote", n: inner.filter(x => x.trim()).length, blocks: mtBlocks(inner) });
      i = e; continue;
    }
    const h = mtHead(l);
    if (h) { out.push({ t: "h", text: h }); i++; continue; }
    if (mtCells(l) && i + 1 < n && mtCells(lines[i + 1])) {
      const e = run(i, x => !!mtCells(x) || MT_SEP.test(x));
      const rows = [];
      let sep = false;
      for (const x of lines.slice(i, e)) {
        const c = mtCells(x);
        if (c && c.every(s => /^:?-{2,}:?$/.test(s))) { sep = rows.length === 1; continue; }
        if (c) rows.push(c);
      }
      const w = Math.max(...rows.map(r => r.length)), pad = r => r.concat(Array(w - r.length).fill(""));
      // a header row: after a markdown separator, or when it is all words and the next row carries numbers
      const head = rows.length >= 2 && (sep || (!rows[0].some(c => /\d/.test(c)) && rows[1].some(c => /\d/.test(c))));
      out.push({ t: "table", head: head ? pad(rows[0]) : null, rows: rows.slice(head ? 1 : 0).map(pad) });
      i = e; continue;
    }
    if (mtKv(l) && i + 1 < n && mtKv(lines[i + 1])) {
      const e = run(i, x => !!mtKv(x));
      out.push({ t: "kv", rows: lines.slice(i, e).map(mtKv) });
      i = e; continue;
    }
    const li = l.match(MT_LI);
    if (li) {
      const ordered = !!li[3], items = [];
      let k = i;
      while (k < n) {
        const m = lines[k].match(MT_LI);
        if (m) { if (!!m[3] !== ordered) break; items.push(m[4]); k++; continue; }
        if (!lines[k].trim()) {
          const m2 = k + 1 < n && lines[k + 1].match(MT_LI);
          if (m2 && !!m2[3] === ordered) { k++; continue; }
          break;
        }
        if (/^\s{2,}\S/.test(lines[k]) && !startsBlock(k)) { items[items.length - 1] += " " + lines[k].trim(); k++; continue; }
        break;
      }
      out.push({ t: ordered ? "ol" : "ul", start: ordered ? Number(li[3]) : 1, items });
      i = k; continue;
    }
    let k = i + 1;
    while (k < n && !startsBlock(k)) k++;
    out.push({ t: "p", lines: lines.slice(i, k).map(x => x.trim()) });
    i = k;
  }
  return out;
}
// raw text -> blocks, cached per text. A quoted tail ("-----Original Message-----", "보낸 사람:" run) becomes one folded block at the end.
function mtParse(raw) {
  const key = String(raw ?? "");
  const hit = MT.cache.get(key);
  if (hit) { MT.cache.delete(key); MT.cache.set(key, hit); return hit; }
  const lines = key.replace(/\r\n?/g, "\n").replace(/[\u00a0\u3000]/g, " ").replace(/\t/g, "  ").split("\n").slice(0, MT.maxLines);
  const at = mtFoldAt(lines);
  const blocks = mtBlocks(at < 0 ? lines : lines.slice(0, at));
  if (at >= 0) {
    const rest = lines.slice(at).filter(l => !MT_FOLD_MARK.test(l) && !MT_RULE.test(l));
    blocks.push({ t: "fold", n: rest.filter(x => x.trim()).length, blocks: mtBlocks(rest) });
  }
  MT.cache.set(key, blocks);
  while (MT.cache.size > MT.max) MT.cache.delete(MT.cache.keys().next().value);
  return blocks;
}

const MT_LINK = /https?:\/\/[^\s<>"']+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
function mtInline(parent, line) {
  let last = 0;
  for (const m of line.matchAll(MT_LINK)) {
    const s = m[0].replace(/[.,;:!?)\]}>'"]+$/, "");
    if (!s) continue;
    const mail = !s.startsWith("http");
    parent.append(line.slice(last, m.index), el("a", { href: mail ? "mailto:" + s : s, ...(mail ? {} : { target: "_blank" }), rel: "noopener noreferrer", text: s }));
    last = m.index + s.length;
  }
  parent.append(line.slice(last));
}
function mtNode(blocks) {
  const box = document.createDocumentFragment();
  for (const b of blocks) {
    switch (b.t) {
      case "p": {
        const p = el("p");
        b.lines.forEach((l, i) => { if (i) p.append(el("br")); mtInline(p, l); });
        box.append(p);
        break;
      }
      case "h": box.append(el("h4", { class: "mt-h", text: b.text })); break;
      case "hr": box.append(el("hr")); break;
      case "kv": box.append(el("dl", { class: "mt-kv" }, ...b.rows.map(([k, v]) => { const dd = el("dd"); mtInline(dd, v); return el("div", {}, el("dt", { text: k }), dd); }))); break;
      case "ul": case "ol": {
        const l = el(b.t, b.start > 1 ? { start: String(b.start) } : {});
        for (const it of b.items) { const li = el("li"); mtInline(li, it); l.append(li); }
        box.append(l);
        break;
      }
      case "table": {
        const cell = (tag, c) => { const x = el(tag); mtInline(x, c); if (/^[+-]?[\d.,]+%?$/.test(c)) x.className = "num"; return x; };
        const t = el("table", {}, b.head ? el("thead", {}, el("tr", {}, ...b.head.map(c => cell("th", c)))) : null, el("tbody", {}, ...b.rows.map(r => el("tr", {}, ...r.map(c => cell("td", c))))));
        box.append(el("div", { class: "mt-tbl" }, t));
        break;
      }
      case "quote": case "fold": {
        const inner = el("div", { class: b.t === "fold" ? "mt-fold-body" : "mt-quote-body" });
        inner.append(mtNode(b.blocks));
        if (b.t === "quote" && b.n <= MT.quoteFold) box.append(el("blockquote", { class: "mt-quote" }, inner));
        else box.append(el("details", { class: b.t === "fold" ? "mt-fold" : "mt-quote" }, el("summary", { text: b.t === "fold" ? "이전 메일 " + b.n + "줄 보기" : "인용 " + b.n + "줄 보기" }), inner));
        break;
      }
    }
  }
  return box;
}
function mailTextNode(raw) {
  const out = el("div", { class: "mb-txt" });
  out.append(mtNode(mtParse(raw)));
  return out;
}
