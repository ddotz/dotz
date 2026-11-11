// Generated from hub/message-spec.ts and hub/message-spec-derive.ts by hub/gen-message-spec-web.ts; do not edit.
const { validateSpec, specChildren, elementPlain, deriveSpec, deriveBasicSpec, CHART_NOTE } = (() => {
const SPEC_LIMITS = { bytes: 64 * 1024, elements: 200, depth: 2, string: 20000, rows: 200, cells: 12 };
const str = (v) => typeof v === "string" && v.length <= SPEC_LIMITS.string;
const nonEmpty = (v) => str(v) && !!v.trim();
const bool = (v) => typeof v === "boolean";
const obj = (need, may = {}) => (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return false;
  const o = v;
  return Object.keys(need).every((k) => need[k](o[k])) && Object.keys(o).every((k) => (need[k] ?? may[k])?.(o[k]) === true);
};
const list = (one) => (v) => Array.isArray(v) && v.length > 0 && v.length <= SPEC_LIMITS.rows && v.every(one);
const WEB_URL = /^https?:\/\/[^\s<>\p{Cc}]+$/iu;
const BAD_LINK = /\]\(\s*<?(?!https?:\/\/)[a-z][a-z0-9+.-]*:|<(?!https?:\/\/)[a-z][a-z0-9+.-]{2,}:[^\s>]*>/i;
const webUrl = (href) => typeof href === "string" && WEB_URL.test(href) && URL.canParse(href);
const lines = (prefix, rows) => rows.map((r) => `${prefix}${r}`).join(`
`);
const headed = (head, body) => head ? `**${head}**
${body}` : body;
const factValue = (r) => r.value ?? `${r.from} → ${r.to}`;
const CATALOG = {
  Message: { props: obj({}), plain: () => "" },
  Status: { props: obj({ tone: (v) => typeof v === "string" && ["done", "run", "wait", "ask", "fail"].includes(v) }), plain: (p) => `[${p.tone}]` },
  Text: { props: obj({ text: nonEmpty }), plain: (p) => p.text },
  Heading: { props: obj({ text: nonEmpty }), plain: (p) => `## ${p.text}` },
  Bullets: {
    props: obj({ ordered: bool, items: list(obj({ text: str }, { sub: bool })) }, { head: nonEmpty }),
    plain: (p) => headed(p.head, p.items.map((x, i) => `${x.sub ? "  " : ""}${p.ordered ? `${i + 1}.` : "-"} ${x.text}`).join(`
`))
  },
  Steps: { props: obj({ items: list(nonEmpty) }, { head: nonEmpty }), plain: (p) => headed(p.head, p.items.map((x, i) => `${i + 1}. ${x}`).join(`
`)) },
  Schedule: {
    props: obj({ rows: list(obj({ time: (v) => typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v), text: nonEmpty })) }, { head: nonEmpty }),
    plain: (p) => headed(p.head, lines("- ", p.rows.map((r) => `${r.time} ${r.text}`)))
  },
  Facts: {
    props: obj({ rows: list(obj({ key: nonEmpty }, { value: str, from: str, to: str })) }, { head: nonEmpty }),
    plain: (p) => headed(p.head, lines("- ", p.rows.map((r) => `${r.key}: ${factValue(r)}`)))
  },
  Section: {
    props: obj({ title: nonEmpty, rows: list(obj({ key: nonEmpty }, { value: str, from: str, to: str, count: str })) }),
    plain: (p) => headed(p.title, lines("- ", p.rows.map((r) => `**${r.key}${r.count ? ` (${r.count})` : ""}:** ${factValue(r)}`)))
  },
  Table: {
    props: obj({ rows: list((v) => Array.isArray(v) && v.length <= SPEC_LIMITS.cells && v.every(str)) }, { head: list(str) }),
    plain: (p) => {
      const row = (r) => `| ${r.join(" | ")} |`;
      return [...p.head ? [row(p.head), row(p.head.map(() => "---"))] : [], ...p.rows.map(row)].join(`
`);
    }
  },
  Rows: {
    props: obj({ rows: list(obj({ title: nonEmpty }, { sub: str, meta: str, badge: str })) }, { title: nonEmpty }),
    plain: (p) => {
      const row = (r) => {
        const cells = [r.title, r.sub ?? "", r.meta ?? "", r.badge ?? ""];
        while (cells.length > 1 && !cells.at(-1))
          cells.pop();
        return cells.join(" | ");
      };
      return ["```목록", ...p.title ? [`# ${p.title}`] : [], ...p.rows.map(row), "```"].join(`
`);
    }
  },
  Chart: { props: obj({ spec: nonEmpty }, { title: nonEmpty }), plain: (p) => `\`\`\`chart
${p.spec}
\`\`\`` },
  Sources: {
    props: obj({ items: list(obj({ href: webUrl }, { title: nonEmpty })) }, { head: nonEmpty }),
    plain: (p) => [...p.head ? [`${p.head}:`] : [], ...p.items.map((x) => x.title ? `- ${x.title}: ${x.href}` : x.href)].join(`
`)
  },
  Quote: { props: obj({ lines: list(str) }), plain: (p) => lines("> ", p.lines) },
  Meta: { props: obj({ text: nonEmpty }), plain: (p) => `-# ${p.text}` },
  Evidence: { props: obj({ items: list(nonEmpty) }), plain: (p) => `근거: ${p.items.join(" · ")}` },
  Code: { props: obj({ code: str }, { lang: str }), plain: (p) => `\`\`\`${p.lang ?? ""}
${p.code}
\`\`\`` },
  Rule: { props: obj({}), plain: () => "---" },
  Choice: {
    props: obj({ question: nonEmpty, options: list(obj({ n: (v) => Number.isInteger(v), label: nonEmpty }, { desc: str })) }),
    plain: (p) => [`결정: ${p.question}`, ...p.options.flatMap((o) => [`**${o.n}) ${o.label}**`, ...o.desc ? [o.desc] : []])].join(`
`)
  },
  Files: { props: obj({ items: list(obj({ path: nonEmpty })) }), plain: (p) => lines("[file] ", p.items.map((x) => x.path)) }
};
function strings(v, out = []) {
  if (typeof v === "string")
    out.push(v);
  else if (Array.isArray(v))
    for (const x of v)
      strings(x, out);
  else if (v && typeof v === "object")
    for (const x of Object.values(v))
      strings(x, out);
  return out;
}
function validateSpec(x) {
  const issues = [];
  const s = x;
  if (!s || typeof s !== "object" || Array.isArray(s) || s.v !== 1 || typeof s.root !== "string" || !s.elements || typeof s.elements !== "object")
    return { ok: false, issues: ["not a spec"] };
  if (Object.keys(s).length !== 3)
    issues.push("extra top-level key");
  const ids = Object.keys(s.elements);
  if (ids.length > SPEC_LIMITS.elements)
    issues.push("too many elements");
  if (JSON.stringify(s).length > SPEC_LIMITS.bytes)
    issues.push("too large");
  if (s.elements[s.root]?.type !== "Message")
    issues.push("root must be a Message");
  if (issues.length)
    return { ok: false, issues };
  for (const id of ids) {
    const e = s.elements[id], c = Object.hasOwn(CATALOG, e?.type) ? CATALOG[e.type] : undefined;
    if (!c) {
      issues.push(`${id}: unknown type`);
      continue;
    }
    if (Object.keys(e).some((k) => k !== "type" && k !== "props" && k !== "children"))
      issues.push(`${id}: extra key`);
    if (!c.props(e.props))
      issues.push(`${id}: bad props for ${e.type}`);
    if (e.children !== undefined && (!Array.isArray(e.children) || e.type !== "Message"))
      issues.push(`${id}: only the Message holds children`);
    if (strings(e.props).some((t) => BAD_LINK.test(t)))
      issues.push(`${id}: link scheme`);
  }
  const kids = s.elements[s.root]?.children ?? [];
  if (!Array.isArray(kids) || new Set(kids).size !== kids.length)
    issues.push("children repeat");
  else {
    for (const k of kids)
      if (!Object.hasOwn(s.elements, k) || k === s.root)
        issues.push(`${k}: bad child`);
    if (kids.length !== ids.length - 1)
      issues.push("element outside the tree");
  }
  return issues.length ? { ok: false, issues } : { ok: true, spec: s };
}
const specChildren = (s) => (s.elements[s.root].children ?? []).map((id) => s.elements[id]);
const elementPlain = (e) => CATALOG[e.type].plain(e.props);
const specPlain = (s) => specChildren(s).map((e, i, all) => (i === 0 ? "" : all[i - 1].type === "Status" ? " " : `
`) + elementPlain(e)).join("");
function specOfElements(els) {
  const elements = { m: { type: "Message", props: {}, children: els.map((_, i) => `e${i}`) } };
  els.forEach((e, i) => {
    elements[`e${i}`] = e;
  });
  return { v: 1, root: "m", elements };
}
const mk = (type, props) => ({ type, props });
const ANS_LABEL = /^\*\*([^*\n]{1,24}?):?\*\*:?\s+(\S.*)$/;
const ANS_PLAIN = /^((?:`[^`\n]+`|[^*:：`.,?!()\n])+?)\s*[:：]\s+(\S.*)$/;
const ANS_NAME_MAX = 24, ANS_PLAIN_MAX = 60;
const ANS_SENTENCE_END = /[.!?요다죠]\s*$/;
const ANS_CHANGE = /^([^→\n]*\d[^→\n]*?)\s*→\s*([^→\n]*\d[^→\n]*)$/;
const ANS_SIDE_MAX = 24, ANS_NOT_VALUE = /[()[\]{}"'“”‘’!?;:]|(?<!\d)[.,]|[.,](?!\d)/;
const isValueSide = (s) => s.length <= ANS_SIDE_MAX && !ANS_NOT_VALUE.test(s);
const ANS_EVIDENCE = /^근거:\s*(\S.*)$/;
const ANS_HEAD = /^\*\*([^*\n]+)\*\*$/, ANS_COUNT = /^(.+?)\s*\((\d+회)\)$/;
const TIME_ROW = /^(\d{1,2}:\d{2})\s+(\S.*)$/;
const RULE_LINE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const metaLine = (bot) => {
  const name = bot.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  return new RegExp(`^\\s*(?:-\\s+)?(?:근거:|출처:|Evidence:|Source:${name ? `|For ${name}:|${name} 몫:` : ""})`, "i");
};
const FILE_LINE = /^\s*\[file\]\s+`?(.+?)`?\s*$/;
const kvOf = (text) => {
  const m = ANS_LABEL.exec(text);
  if (m)
    return m;
  const p = ANS_PLAIN.exec(text);
  return p && p[1].replace(/`/g, "").length <= ANS_NAME_MAX && p[2].length <= ANS_PLAIN_MAX && !ANS_SENTENCE_END.test(p[2]) ? p : null;
};
const changeOf = (value) => {
  const c = ANS_CHANGE.exec(value);
  return c && isValueSide(c[1]) && isValueSide(c[2]) ? { from: c[1], to: c[2] } : { value };
};
const REC_MARK = /^([ \t]*>?[ \t]*(?:\*\*)?[ \t]*\d{1,2}(?:\)|\.[ \t]).*?)[ \t]*(?:(?:←|<-)[ \t]*(?:추천|recommended)|\([ \t]*(?:추천|권장|recommended)[ \t]*\))/gim;
function unquoteChoices(src) {
  const out = [];
  for (let i = 0;i < src.length; ) {
    if (!/^\s*>/.test(src[i])) {
      out.push(src[i++]);
      continue;
    }
    let j = i;
    while (j < src.length && /^\s*>/.test(src[j]))
      j++;
    const run = src.slice(i, j), choice = run.some((l) => /^\s*>?\s*\*\*\d+\)/.test(l));
    out.push(...choice ? run.map((l) => l.replace(/^\s*>\s?/, "")) : run);
    i = j;
  }
  return out;
}
const SRC_HEAD = /^\s*(?:#{1,6}\s+)?(?:\*\*)?(출처|참고(?: 자료| 링크)?|근거|Sources?|References?)(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;
const SRC_BULLET = /^\s*(?:[-*•]|\d+[.)])\s/;
const SRC_ITEM = /^\s*(?:(?:[-*•]|\d+[.)])\s+)?(?:\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(\S(?:(?!:\/\/).)*?)(?::|\s-)\s+<?(https?:\/\/[^\s<>]+)>?|<?(https?:\/\/[^\s<>]+)>?)\s*$/;
function sourceItem(line) {
  const m = line.match(SRC_ITEM), href = m && (m[2] || m[4] || m[5]);
  if (!m || !href || !URL.canParse(href))
    return null;
  const title = (m[1] || m[3] || "").replace(/\*\*|`/g, "");
  return title ? { href, title } : { href };
}
function sourceRuns(src, last) {
  const runs = new Map;
  if (!src.some((l) => l.includes("://")))
    return runs;
  let taken = 0;
  for (let i = 0;i < src.length; i++) {
    const h = src[i].match(SRC_HEAD);
    if (!h)
      continue;
    const items = [];
    let end = i + 1, mixed = false;
    for (let j = end;j < src.length; j++) {
      if (!src[j].trim())
        continue;
      const item = sourceItem(src[j]);
      if (!item) {
        mixed = h[1] === "근거" && (j === end || SRC_BULLET.test(src[j]));
        break;
      }
      items.push(item);
      end = j + 1;
    }
    if (mixed)
      taken = src.length;
    else if (items.length) {
      runs.set(i, { head: h[1], items, end });
      taken = end;
      i = end - 1;
    }
  }
  if (!last)
    return runs;
  let end = src.length;
  while (end && !src[end - 1].trim())
    end--;
  const items = [];
  let start = end;
  for (let item;start > taken && (item = sourceItem(src[start - 1])) && !item.title; start--)
    items.unshift(item);
  if (items.length > 1)
    runs.set(start, { head: "", items, end });
  return runs;
}
const DECISION_HEAD = /^\s*(?:\*\*)?\s*(?:결정|decision(?: needed)?)(?:\s*#?\d{1,2})?\s*[:：]\s*(.*?)\s*(?:\*\*)?\s*$/i;
const D_OPT = /^\s*(?:\*\*)?\s*(\d+)\)\s*(.+?)\s*(?:\*\*)?\s*$/;
const DRAFT_REF = /\(\s*[A-Za-z0-9][A-Za-z0-9_.:-]{1,63}\)\s*$/;
function isDraft(text) {
  let fence = false, head = false, quoted = false;
  for (const line of text.split(`
`)) {
    if (/^\s*```/.test(line))
      fence = !fence;
    if (fence)
      continue;
    const h = DECISION_HEAD.exec(line);
    if (h) {
      if (DRAFT_REF.test(h[1]))
        return true;
      head = true;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const bare = line.replace(/^\s*>\s?/, "");
      if (!D_OPT.test(bare) && !DECISION_HEAD.test(bare))
        quoted = true;
    } else if (quoted && head && D_OPT.test(line))
      return true;
  }
  return quoted && head && text.split(`
`).some((l) => D_OPT.test(l.replace(/^\s*>\s?/, "")));
}
function choiceOf(p) {
  const h = /^결정: (\S.*)$/.exec(p[0]), options = [];
  if (!h)
    return null;
  const OPT = /^\*\*([1-9]\d{0,2})\) (\S[^*]*)\*\*$/;
  for (let i = 1;i < p.length; i++) {
    const o = OPT.exec(p[i]);
    if (!o)
      return null;
    const next = p[i + 1];
    const desc = next !== undefined && !OPT.test(next) ? next : undefined;
    if (desc !== undefined)
      i++;
    options.push({ n: Number(o[1]), label: o[2], ...desc !== undefined ? { desc } : {} });
  }
  return options.length >= 2 ? mk("Choice", { question: h[1], options }) : null;
}
function blocks(text, last, shape, meta) {
  const items = [], src = unquoteChoices(text.split(`
`)), sources = sourceRuns(src, last);
  let list = null, table = null;
  let para = [], quote = [], files = [];
  const add = (e, extra = {}) => void items.push({ el: e, ...extra });
  const flushQ = () => {
    if (quote.length)
      add(mk("Quote", { lines: quote }));
    quote = [];
  };
  const flushP = () => {
    flushQ();
    if (para.length)
      add(shape && choiceOf(para) || mk("Text", { text: para.join(`
`) }));
    para = [];
  };
  const flushF = () => {
    if (files.length)
      add(mk("Files", { items: files.map((path) => ({ path })) }));
    files = [];
  };
  const flushL = () => {
    if (!list)
      return;
    const l = list;
    list = null;
    const head = l.head ? ANS_HEAD.exec(l.head)[1] : "";
    const bullets = () => mk("Bullets", { ordered: l.t === "ol", items: l.items.map((i) => i.sub ? { text: i.text, sub: true } : { text: i.text }), ...head ? { head } : {} });
    if (!shape)
      return add(bullets());
    const kv = l.items.map((i) => kvOf(i.text)), flat = !l.items.some((i) => i.sub), allKv = kv.every(Boolean);
    const headed = head ? { head } : {};
    if (head && allKv && flat) {
      const rows = kv.map((m) => {
        const c = ANS_COUNT.exec(m[1]);
        return { key: c ? c[1] : m[1], ...c ? { count: c[2] } : {}, ...changeOf(m[2]) };
      });
      return add(mk("Section", { title: head, rows }), { alt: bullets(), n: rows.length });
    }
    if (l.items.length >= 2 && flat) {
      if (l.t === "ol")
        return add(mk("Steps", { items: l.items.map((i) => i.text), ...headed }));
      if (l.items.every((i) => TIME_ROW.test(i.text))) {
        return add(mk("Schedule", { rows: l.items.map((i) => {
          const t = TIME_ROW.exec(i.text);
          return { time: t[1], text: t[2] };
        }), ...headed }));
      }
      if (allKv)
        return add(mk("Facts", { rows: kv.map((m) => ({ key: m[1], ...changeOf(m[2]) })), ...headed }));
    }
    add(bullets());
  };
  const flushT = () => {
    if (!table)
      return;
    const [head, ...rest] = table.head ? table.rows : [null, ...table.rows];
    add(mk("Table", { rows: rest, ...head ? { head } : {} }));
    table = null;
  };
  for (let i = 0;i < src.length; i++) {
    const line = src[i], run = sources.get(i);
    let m;
    const file = shape && FILE_LINE.exec(line);
    if (file) {
      flushT();
      flushP();
      flushL();
      files.push(file[1]);
      continue;
    }
    flushF();
    if (run) {
      flushT();
      flushP();
      flushL();
      add(mk("Sources", { ...run.head ? { head: run.head } : {}, items: run.items }));
      i = run.end - 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushP();
      flushL();
      if (!table)
        table = { rows: [], head: false };
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) {
        if (table.rows.length === 1)
          table.head = true;
      } else
        table.rows.push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      continue;
    }
    flushT();
    if (meta.test(line) || /^\s*-#\s/.test(line)) {
      flushP();
      flushL();
      const ev = shape && last ? ANS_EVIDENCE.exec(line.trim()) : null;
      if (ev && !src.slice(i + 1).some((l) => l.trim()))
        add(mk("Evidence", { items: ev[1].split(/\s+·\s+/) }));
      else
        add(mk("Meta", { text: line.replace(/^\s*-#?\s+/, "") }));
      continue;
    }
    if (m = line.match(/^(\s*)(?:[-*•]|(\d+)[.)])\s+(.*)/)) {
      const head = shape && para.length === 1 && ANS_HEAD.test(para[0].trim()) ? para.pop().trim() : "";
      flushP();
      const t = m[2] ? "ol" : "ul", sub = m[1].length >= 2 && !!list;
      if (!sub && (!list || list.t !== t)) {
        flushL();
        list = { t, items: [], head };
      }
      list.items.push({ text: m[3], sub });
    } else if (m = line.match(/^\s*>\s?(.*)/)) {
      flushL();
      if (para.length) {
        const q = quote;
        quote = [];
        flushP();
        quote = q;
      }
      quote.push(m[1]);
    } else if (m = line.match(/^#{1,6}\s+(.*)/)) {
      flushP();
      flushL();
      add(mk("Heading", { text: m[1] }));
    } else if (RULE_LINE.test(line)) {
      flushP();
      flushL();
      add(mk("Rule", {}));
    } else if (!line.trim()) {
      flushP();
      flushL();
    } else {
      flushL();
      para.push(line);
    }
  }
  flushP();
  flushL();
  flushT();
  flushF();
  const out = [];
  for (let i = 0;i < items.length; i++) {
    if (!items[i].alt) {
      out.push(items[i].el);
      continue;
    }
    let j = i, n = 0;
    while (j < items.length && items[j].alt)
      n += items[j++].n;
    for (;i < j; i++)
      out.push(n >= 2 ? items[i].el : items[i].alt);
    i = j - 1;
  }
  return out;
}
function rowsOf(code) {
  const src = code.split(`
`).map((l) => l.trim()).filter(Boolean);
  const title = src[0] && src[0].startsWith("# ") ? src.shift().slice(2) : "";
  const rows = src.map((l) => {
    const [t = "", sub = "", meta = "", badge = ""] = l.split(" | ").map((x) => x.trim());
    return { title: t, ...sub ? { sub } : {}, ...meta ? { meta } : {}, ...badge ? { badge } : {} };
  });
  return mk("Rows", { ...title ? { title } : {}, rows });
}
const CHART_NOTE = "차트 형식이 맞지 않아 JSON으로 보여 드려요";
function chartOf(code) {
  const spec = code.trim();
  let json;
  try {
    json = JSON.parse(spec);
  } catch {
    json = null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json))
    return [mk("Code", { code: spec, lang: "json" }), mk("Meta", { text: CHART_NOTE })];
  const title = json.card?.title;
  return [mk("Chart", { spec, ...typeof title === "string" && title.trim() ? { title } : {} })];
}
const FENCE_SPLIT = /(?:^|\n)[ \t]{0,3}```([^\n`]*)\n?([\s\S]*?)(?:```[ \t]*(?=\n|$)|$)/;
function parse(source, shape, relayed, bot) {
  const text = source.replace(REC_MARK, "$1");
  if (shape && isDraft(text))
    return null;
  const parts = text.split(FENCE_SPLIT), out = [], meta = metaLine(bot);
  for (let i = 0;i < parts.length; i += 3) {
    out.push(...blocks(parts[i], i === parts.length - 1, shape, meta));
    if (i + 2 >= parts.length)
      break;
    const lang = parts[i + 1], code = parts[i + 2];
    if (!relayed && lang.trim() === "목록")
      out.push(rowsOf(code));
    else if (!relayed && lang.trim() === "chart" && code.trim())
      out.push(...chartOf(code));
    else
      out.push(mk("Code", { code: code.replace(/\n$/, ""), ...!relayed && lang ? { lang } : {} }));
  }
  return out;
}
const PLAIN_TYPES = new Set(["Text", "Heading", "Bullets", "Quote", "Meta", "Rule", "Code", "Files"]);
function deriveSpec(text, bot = "", tone) {
  try {
    if (typeof text !== "string" || !text.trim())
      return null;
    const els = parse(text, true, false, bot);
    if (!els || els.every((e) => PLAIN_TYPES.has(e.type) && e.props.text !== CHART_NOTE))
      return null;
    const spec = specOfElements(tone ? [mk("Status", { tone }), ...els] : els);
    return validateSpec(spec).ok ? spec : null;
  } catch {
    return null;
  }
}
function deriveBasicSpec(text, relayed = false, bot = "") {
  return specOfElements(parse(String(text ?? ""), false, relayed, bot) ?? []);
}
const SPEC_FENCE = /(\n|^)([ \t]{0,3})```([^\n`]*)\n?([\s\S]*?)(?:```[ \t]*(?=\n|$)|$)/g;
function readable(v, out = []) {
  if (typeof v === "string") {
    if (v.trim())
      out.push(v);
  } else if (Array.isArray(v))
    for (const x of v)
      readable(x, out);
  else if (v && typeof v === "object")
    for (const x of Object.values(v))
      readable(x, out);
  return out;
}
function fenceBody(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const ok = validateSpec(json);
  if (ok.ok)
    return specPlain(ok.spec);
  const els = json?.elements;
  const words = els && typeof els === "object" && !Array.isArray(els) ? Object.values(els).map((e) => readable(e?.props).join(`
`)).filter(Boolean) : readable(json);
  return words.length ? words.join(`
`) : null;
}
function resolveSpecFence(text) {
  if (typeof text !== "string" || !text.includes("dotz-spec"))
    return text;
  try {
    return text.replace(SPEC_FENCE, (all, lead, _indent, lang, body) => {
      if (lang.trim() !== "dotz-spec")
        return all;
      const plain = fenceBody(body);
      return plain === null ? all : lead + plain;
    });
  } catch {
    return text;
  }
}
return { validateSpec, specChildren, elementPlain, deriveSpec, deriveBasicSpec, CHART_NOTE };
})();
