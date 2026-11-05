/* ---------- basic markdown (input is escaped before any markup is produced) ---------- */
// Links only for http(s) targets; the text and URL are already escaped when the anchor is built.
function inline(s) {
  return String(s).split(/(`[^`\n]+`)/).map((p, i) => i % 2 ? `<code${/^(~|\.{0,2}\/)[^\s]*$|^[\w.-]+\/[\w./-]+(:\d+(-\d+)?)?$/.test(p.slice(1, -1)) ? ' class="path"' : ""}>${esc(p.slice(1, -1))}</code>` : esc(p).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[^"'>=\w])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>").replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, "$1<i>$2</i>")).join("");
}
// "| a | b |" rows; the "|---|" separator row after the first one makes that row the header.
const cells = line => line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
const isSep = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
// Meta lines: evidence/source/"for NAME" lines render small and muted.
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const metaRe = () => new RegExp(`^\\s*(?:-\\s+)?(?:근거:|출처:|Evidence:|Source:|For ${escRe(botName)}:|${escRe(botName)} 몫:)`, "i");
// A run of "> " lines that contains an option line ("**1) ...") is a choice block: its quote prefixes are dropped. Other quotes stay.
function unquoteChoices(lines) {
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (!/^\s*>/.test(lines[i])) { out.push(lines[i++]); continue; }
    let j = i;
    while (j < lines.length && /^\s*>/.test(lines[j])) j++;
    const run = lines.slice(i, j), choice = run.some(l => /^\s*>?\s*\*\*\d+\)/.test(l));
    out.push(...(choice ? run.map(l => l.replace(/^\s*>\s?/, "")) : run));
    i = j;
  }
  return out;
}
// A source list at the end of an answer: a heading line (출처:, 참고:, Sources:) over URL lines, or a last run of two or more bare URL lines,
// becomes 목록 rows (site, then a short path or the link's own title). Everything comes from the URL string: no fetch, no favicon.
// The full URL stays in the row as clipped text, the only selectable part, so copying the message gives the original URLs.
const SRC_HEAD = /^\s*(?:#{1,6}\s+)?(?:\*\*)?(출처|참고(?: 자료| 링크)?|Sources?|References?)(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;
const SRC_ITEM = /^\s*(?:(?:[-*•]|\d+[.)])\s+)?(?:\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|<?(https?:\/\/[^\s<>]+)>?)\s*$/;
function sourceItem(line) {
  const m = line.match(SRC_ITEM), href = m && (m[2] || m[3]);
  return href && URL.canParse(href) ? { title: m[1] || "", href } : null;
}
// start line -> { head, items, end } for each source list in these lines; only the message's last text part (last) can hold a list without a heading.
function sourceRuns(lines, last) {
  const runs = new Map();
  if (!lines.some(l => l.includes("://"))) return runs;
  let taken = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(SRC_HEAD);
    if (!h) continue;
    const items = [];
    let end = i + 1;
    for (let j = end; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      const item = sourceItem(lines[j]);
      if (!item) break;
      items.push(item); end = j + 1;
    }
    if (items.length) { runs.set(i, { head: h[1], items, end }); taken = end; i = end - 1; }
  }
  if (!last) return runs;
  let end = lines.length;
  while (end && !lines[end - 1].trim()) end--;
  const items = [];
  let start = end;
  for (let item; start > taken && (item = sourceItem(lines[start - 1])) && !item.title; start--) items.unshift(item);
  if (items.length > 1) runs.set(start, { head: "", items, end });
  return runs;
}
const sourcePart = s => { try { return decodeURIComponent(s); } catch { return s; } };
// The last two path segments, "…/" when more came before them; a bare domain has none.
function sourcePath(url) {
  const segs = url.pathname.split("/").filter(Boolean).map(sourcePart);
  return (segs.length > 2 ? "…/" : "") + segs.slice(-2).join("/");
}
function sourceListHtml({ head, items }) {
  const rows = items.map(({ title, href }) => {
    const url = new URL(href), site = url.hostname.replace(/^www\./, ""), sub = title || sourcePath(url);
    return `<a class="mlist-row" href="${esc(href)}" title="${esc(href)}" target="_blank" rel="noopener noreferrer"><span class="mlist-url" aria-hidden="true">${esc(href)}</span><span class="mlist-av" aria-hidden="true">${esc(site[0].toUpperCase())}</span><div class="mlist-main"><div class="mlist-t">${esc(site)}</div>${sub ? `<div class="mlist-s">${esc(sub)}</div>` : ""}</div></a>`;
  });
  return `<div class="mlist mlist-src">${head ? `<div class="mlist-h">${esc(head)}</div>` : ""}${rows.join("")}</div>`;
}
// One key-column row (.rc-rows): the key muted, what it is, the detail after " · " muted (tail: a ready-made detail instead).
function rcRowHtml(key, text, tail = "") {
  const d = tail ? null : /^(.*?)\s+·\s+(.*)$/.exec(text);
  return `<div class="rc-row"><span class="rc-k">${esc(key)}</span><span class="rc-w"><b>${inline(d ? d[1] : text)}</b> ${d ? `<span class="rc-d">${inline(d[2])}</span>` : tail}</span></div>`;
}
// A list of "10:00 what" items and nothing else is a schedule: the rows of an answer's card (02-answer-shapes.js) and of a briefing (11-resultcard.js).
const TIME_ROW = /^(\d{1,2}:\d{2})\s+(\S.*)$/;
const timeList = l => l.t === "ul" && l.items.length >= 2 && l.items.every(i => !i.sub && TIME_ROW.test(i.text));
function timeRowsHtml(items) {
  return `<div class="rc-rows">${items.map(i => { const m = TIME_ROW.exec(i.text); return rcRowHtml(m[1], m[2]); }).join("")}</div>`;
}
// answer: the shape state of one answer (02-answer-shapes.js), null for every other caller.
function blocks(text, last, answer) {
  const html = [], meta = metaRe(), lines = unquoteChoices(text.split("\n")), sources = sourceRuns(lines, last);
  let list = null, para = [], table = null, quote = [];
  const flushQ = () => { if (quote.length) html.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`); quote = []; };
  const flushP = () => {
    flushQ();
    if (para.length) {
      const p = `<p>${para.map(inline).join("<br>")}</p>`;
      if (answer && !answer.opened && !html.length) { answer.plain = p; answer.rich = ansLeadHtml(para); }
      html.push(p);
    }
    para = [];
  };
  const flushL = () => {
    if (!list) return;
    const head = list.head ? `<p>${inline(list.head)}</p>` : "", plain = `<${list.t}>${list.items.map(i => `<li${i.sub ? ' class="sub"' : ""}>${inline(i.text)}</li>`).join("")}</${list.t}>`;
    const part = answer && head ? ansSection(list, head + plain) : null, card = answer && !part ? ansListHtml(list) : null;
    if (card) answer.shaped = true;
    html.push(part || head + (card || plain));
    list = null;
  };
  const flushT = () => {
    if (!table) return;
    const [head, ...rest] = table.head ? table.rows : [null, ...table.rows], card = answer && head && rest.length > 0 && head.length <= ANS_TABLE_COLS;
    if (card) answer.shaped = true;
    html.push(`<div class="${card ? "ans-card ans-tb" : "tbl"}"><table>${head ? `<thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead>` : ""}<tbody>${rest.map(r => `<tr>${r.map((c, i) => card && !i ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    table = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], run = sources.get(i);
    let m;
    if (run) { flushT(); flushP(); flushL(); html.push(sourceListHtml(run)); i = run.end - 1; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushP(); flushL();
      if (!table) table = { rows: [], head: false };
      if (isSep(line)) { if (table.rows.length === 1) table.head = true; } else table.rows.push(cells(line));
      continue;
    }
    flushT();
    // Discord's "-# " subtext line renders like the meta lines.
    if (meta.test(line) || /^\s*-#\s/.test(line)) {
      flushP(); flushL();
      const ev = answer && last && ansEvidenceHtml(line, lines.slice(i + 1));
      if (ev) answer.shaped = true;
      html.push(ev || `<p class="meta">${inline(line.replace(/^\s*-#?\s+/, ""))}</p>`);
      continue;
    }
    // An indented item (2+ spaces) is a sub-item of the list it sits in, whatever its own marker.
    if ((m = line.match(/^(\s*)(?:[-*•]|(\d+)[.)])\s+(.*)/))) {
      const head = answer && para.length === 1 && ANS_HEAD.test(para[0].trim()) ? para.pop().trim() : "";   // a title right above a list
      flushP();
      const t = m[2] ? "ol" : "ul", sub = m[1].length >= 2 && !!list;
      if (!sub && (!list || list.t !== t)) { flushL(); list = { t, items: [], head }; }
      list.items.push({ text: m[3], sub });
    }
    else if ((m = line.match(/^\s*>\s?(.*)/))) { flushL(); if (para.length) { const q = quote; quote = []; flushP(); quote = q; } quote.push(m[1]); }
    else if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushP(); flushL(); html.push(`<p class="h"><b>${inline(m[1])}</b></p>`); }
    else if (!line.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(line); }
  }
  flushP(); flushL(); flushT();
  if (answer && html.length) answer.opened = true;
  return (answer ? ansJoin(html, answer) : html).join("");
}
// A fence tagged 목록 is a list shown as UI rows (hub/listblock.ts writes it): an optional "# " title line, then one row per line
// "title | subtitle | meta | badge" (the last three optional). Each row gets a round initial, the meta on the right and a count badge.
function listBlockHtml(src) {
  const lines = String(src ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  const head = lines[0] && lines[0].startsWith("# ") ? lines.shift().slice(2) : "";
  const rows = lines.map(l => {
    const [t = "", s = "", meta = "", badge = ""] = l.split(" | ").map(x => x.trim());
    const initial = Array.from(t.replace(/^[^\p{L}\p{N}]+/u, ""))[0] || "·";
    return `<div class="mlist-row"><span class="mlist-av" aria-hidden="true">${esc(initial)}</span><div class="mlist-main"><div class="mlist-t" title="${esc(t)}">${esc(t)}</div>${s ? `<div class="mlist-s">${esc(s)}</div>` : ""}</div>${meta || badge ? `<div class="mlist-r">${meta ? `<span class="mlist-m">${esc(meta)}</span>` : ""}${/^\d+\+?$/.test(badge) && badge !== "0" ? `<span class="mlist-b">${esc(badge)}</span>` : ""}</div>` : ""}</div>`;
  });
  return `<div class="mlist">${head ? `<div class="mlist-h">${esc(head)}</div>` : ""}${rows.join("")}</div>`;
}
// relayed: another computer's reply (42-relay-chat.js) is text only: `[file]` lines stay text and a fence is a plain code block, with no run button and no settings card to act on here.
// answer: an assistant answer (11-todo-strip.js) is drawn by its shapes (02-answer-shapes.js), { shaped: true } when it already has one (its files); every other caller keeps its text.
function mdHtml(src, relayed = false, answer = false) {
  const shape = answer ? { shaped: !!answer.shaped, opened: false, plain: "", rich: "" } : null;
  // split() with two groups: [text, language, code, text, language, code, ...]; each code block gets its copy / run bar (35-code-blocks.js).
  // A fence opens only at the start of a line (``` in the middle of a sentence stays text) and closes with ``` at the end of a line.
  const parts = stripRecMark(stripMarkers(src, relayed)).split(/(?:^|\n)[ \t]{0,3}```([^\n`]*)\n?([\s\S]*?)(?:```[ \t]*(?=\n|$)|$)/);
  // A fence tagged 원문 is a post's raw machine output (hub/watchtext.ts rawFence): folded, monospace, tap to open.
  const out = parts.map((p, i) => i % 3 === 0 ? blocks(p, i === parts.length - 1, shape) : i % 3 === 2 ? (relayed ? `<pre><code>${esc(p.replace(/\n$/, ""))}</code></pre>` : parts[i - 1].trim() === "목록" ? listBlockHtml(p) : parts[i - 1].trim() === "dotz-settings" ? settingsCardHtml(p) : parts[i - 1].trim() === "원문" ? `<details class="more raw"><summary>원문</summary><pre>${esc(p.replace(/\n$/, ""))}</pre></details>` : codeBlockHtml(parts[i - 1], p)) : "").join("");
  return shape && shape.shaped && shape.rich && out.startsWith(shape.plain) ? shape.rich + out.slice(shape.plain.length) : out;
}
const mdNode = (src, cls = "md", relayed = false, answer = false) => el("div", { class: cls, safeHtml: mdHtml(src, relayed, answer) });

/* ---------- message status (only an explicit line-1 marker sets it; it becomes one leading emoji) ---------- */
const TONE_TAGS = new Map(Object.entries({ done: "done", "완료": "done", run: "run", "진행": "run", wait: "wait", "대기": "wait", ask: "ask", "결정": "ask", fail: "fail", "실패": "fail", warn: "fail", "경고": "fail" }));
// The marker word is drawn as one status tag at the start of the message's first line (prototype .bub .st), never as the raw marker or an emoji.
const LANE_TONE = { done: ["ok", "완료"], run: ["pri", "진행 중"], wait: ["warn", "답을 기다려요"], ask: ["warn", "확인 필요"], fail: ["err", "실패"] };
// [run] and [wait] are true only of the moment they were written: 41-runstate.js syncLiveTags draws them from the current state.
const parkedTone = tone => tone === "run" || tone === "wait";
const toneTag = tone => LANE_TONE[tone] ? el("span", { class: `tag ${LANE_TONE[tone][0]} st-tag`, text: LANE_TONE[tone][1] }) : null;
// The tag goes in front of the first paragraph's text; a body that opens with a list or a card gets a line of its own.
function toneLead(root, tone) {
  const tag = toneTag(tone), f = root.firstElementChild;
  if (!tag) return root;
  if (f && /^(P|LI)$/.test(f.tagName)) f.prepend(tag); else root.prepend(el("p", {}, tag));
  return root;
}
// Machine markers never reach the owner as text (owner 2026-10-23). Same shapes as hub/tone.ts stripMarkers (keep in step):
// known marker shapes at line start (behind an optional list dash, `**` or `**name**: ` lead), outside ``` fences; any
// other bracket is content. Status words, [lane <word>], [dotz ...], [orchestrator-guard], [지금 도는 것], [attachment],
// [system], [owner via <x>], [ok | 12ms], [routine:...], [10-23]; a left-over [file] line is dropped.
const MK_BODY = "(?:run|wait|done|ask|fail|warn|blocked|partial|later|ok|error|err|완료|진행|대기|결정|실패|경고|차단|부분|나중|오류|attachment|system|handover|keepalive|orchestrator-guard|지금 도는 것|now running|dotz(?: [a-z][\\w:-]*(?: [^\\]\\n]{1,40})?)?|lane [a-z가-힣][^\\]\\n]{0,30}|owner via [^\\]\\n]{1,30}|(?:ok|error|err|fail)[ ]*\\|[^\\]\\n]{1,24}|routine:[^\\]\\n]{1,60}|\\d{2}-\\d{2})";
const MK_LEAD = new RegExp("^([ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*[^*\\n]{1,60}\\*\\*:?[ \\t]+)?)(\\*\\*)?\\[" + MK_BODY + "\\](\\*\\*)?[ \\t]*", "i");
// keepFiles: a message body keeps its `[file]` lines for the attachment chips (fileLines, 15-attachments.js); mdNode drops them.
function stripMarkers(text, keepFiles = false) {
  text = String(text ?? "");
  if (!text.includes("[")) return text;
  let fence = false;
  const out = [];
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { fence = !fence; out.push(line); continue; }
    if (fence) { out.push(line); continue; }
    if (/^[ \t]*\[file\][ \t]/i.test(line)) { if (keepFiles) out.push(line); continue; }
    let l = line;
    for (let m = MK_LEAD.exec(l); m; m = MK_LEAD.exec(l)) l = m[1] + l.slice(m[0].length);
    out.push(l);
  }
  return out.join("\n");
}
function parseTone(text, keepFiles = false) {
  text = String(text ?? "");
  const m = text.match(/^\[([^\]\n]+)\][ \t]*/), tag = m && TONE_TAGS.get(m[1].toLowerCase());
  return tag ? { tone: tag, text: stripMarkers(text.slice(m[0].length), keepFiles) } : { tone: "", text: stripMarkers(text, keepFiles) };
}

/* ---------- api ---------- */
// index.html starts the first answers (state, history, plan, read positions, activity) in <head>, before this 480KB script is downloaded and parsed; the first api() of that path takes it over.
// A GET that is already in flight is shared (the same path asked twice at boot is one request); each caller parses its own copy of the text.
const apiGets = new Map();
async function api(path, method = "GET", body) {
  [path, method, body] = pqRoute(path, method, body);   // a peer's item is read and acted on through /api/peer/proxy (34-peer-monitoring.js)
  const go = () => fetch(path, { method, cache: "no-store", headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const read = async r => ({ ok: r.ok, status: r.status, text: await r.text() });
  let res;
  if (method === "GET") {
    let p = apiGets.get(path);
    if (!p) {
      const early = window.__early && window.__early[path];
      if (early) delete window.__early[path];
      p = (early ? early.catch(go) : go()).then(read);
      apiGets.set(path, p);
      const done = () => { if (apiGets.get(path) === p) apiGets.delete(path); };
      p.then(done, done);
    }
    res = await p;
  } else res = await read(await go());
  let data = null;
  try { data = JSON.parse(res.text); } catch {}
  if (!res.ok) throw Object.assign(new Error(res.status === 503 && path.startsWith("/api/peer/proxy") ? (data && data.reason) || "이 컴퓨터에서는 읽기만 돼요" : (data && data.error) || `HTTP ${res.status}`), { data });
  return data;
}
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

/* ---------- snackbar ---------- */
// How notification text names things (01-notice-ko.js): a session by its title, never its code name.
const NK = { lane: name => { try { const l = S && S.lanes.find(x => x.name === name); return (l && l.title) || undefined; } catch { return undefined; } } };
let toastTimer;
// A toast that times out or whose 되돌리기 was pressed fades out (150ms) and is then removed; a new toast replaces the old one at once.
function toastGone(n) {
  if (!n.isConnected) return;
  n.style.pointerEvents = "none";
  motionOut(n).then(() => n.remove());
}
function toast(msg, bad, action, ms) {
  document.querySelectorAll(".snack").forEach(n => n.remove());
  const n = el("div", { class: `snack${bad ? " bad" : ""}${action ? " act" : ""}`, role: "status" }, el("span", { text: noticeKo(msg, { ...NK, error: !!bad }) }), action ? el("button", { type: "button", class: "sa", text: action.label, onclick: () => { toastGone(n); action.onclick(); } }) : null);
  (document.querySelector("dialog[open]:not([data-leaving])") || document.body).append(n);
  clearTimeout(toastTimer);
  motionIn(n, "rise");
  toastTimer = setTimeout(() => toastGone(n), ms || (bad || action ? 6000 : 3500));
}

/* ---------- floating notices: top-right cards that leave ~4s after the owner has seen them ---------- */
// "Seen" = the tab is visible and the window focused: a notice that arrives while away waits, and its countdown starts
// when the window becomes active again; hovering pauses it. A dismissed notice (closed, clicked or timed out) is kept in
// localStorage so neither a reconnect replay nor a reload brings it back.
const NTF_MAX = 3, NTF_MS = 4000, NTF_KEY = "dotz-ntf-done";
const ntfDone = new Set((() => { const v = lsJson(NTF_KEY, []); return Array.isArray(v) ? v : []; })());
const ntfShown = new Set(), ntfLive = new Set();
// The open "needs" card of each conversation (09-needs-you.js attnToast): it goes as soon as that conversation no longer needs the owner.
const NTF_BY = new Map();
function ntfDropFor(target) { const c = NTF_BY.get(target); if (c) c(); }
const ntfActive = () => document.visibilityState === "visible" && document.hasFocus();
const ntfSync = () => { for (const t of ntfLive) t.sync(); };
addEventListener("focus", ntfSync); addEventListener("blur", ntfSync); document.addEventListener("visibilitychange", ntfSync);
function notify(e) {
  const text = String(e.text || "").replace(/\s+\n/g, "\n").trim();
  const key = `${e.ts}|${e.kind}|${e.target || e.lane || ""}|${text.slice(0, 80)}`;
  if (!text || ntfDone.has(key) || ntfShown.has(key)) return;
  ntfShown.add(key);
  const alertish = e.kind === "out" && e.target === "alert";
  const box = document.querySelector(".ntf-box") || document.body.appendChild(el("div", { class: "ntf-box", "aria-live": "polite" }));
  const lane = e.kind === "lane_report" ? String(e.lane || "") : "";
  const title = noticeKo(e.title || (lane ? NK.lane(lane) || "세션" : alertish ? "알림" : `${botName} 작업 기록`), NK);
  const at = e.ts ? new Date(e.ts) : null;
  const tm = at && !isNaN(at) ? at.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" }) : "";
  const first = noticeKo(text, NK).split("\n").find(l => l.trim()) || "";
  const n = el("div", { class: "ntf in", role: alertish ? "alert" : "status" },
    el("span", { class: `dot ${e.tone || (alertish ? "err" : lane ? "ok" : "")}` }),
    el("div", { class: "tx" }, el("div", { class: "hd" }, el("span", { class: "nm", text: title }), tm ? el("span", { class: "tm", text: tm }) : null), el("div", { class: "bd2", text: first.slice(0, 240) })));
  let left = NTF_MS, t0 = 0, timer = 0, hover = false, gone = false;
  const t = {
    sync() {
      if (gone) return;
      const run = ntfActive() && !hover;
      if (run && !timer) { t0 = Date.now(); timer = setTimeout(() => close(), left); }
      else if (!run && timer) { clearTimeout(timer); timer = 0; left = Math.max(800, left - (Date.now() - t0)); }
    },
  };
  function close() {
    if (gone) return;
    gone = true; clearTimeout(timer); ntfLive.delete(t);
    if (NTF_BY.get(e.target) === close) NTF_BY.delete(e.target);
    ntfDone.add(key);
    try { localStorage.setItem(NTF_KEY, JSON.stringify([...ntfDone].slice(-300))); } catch {}
    n.classList.add("out");
    setTimeout(() => n.remove(), M_MS.fast);
  }
  n.append(el("button", { type: "button", class: "x", "aria-label": "닫기", text: "×", onclick: ev => { ev.stopPropagation(); close(); } }));
  // A tap opens the item by its kind, like every other notice entry point (30-notices.js noticeOpen).
  n.addEventListener("click", () => { close(); noticeOpen(ntOfEvent(e)); });
  n.addEventListener("pointerenter", () => { hover = true; t.sync(); });
  n.addEventListener("pointerleave", () => { hover = false; t.sync(); });
  n.addEventListener("animationend", () => n.classList.remove("in"), { once: true });
  box.prepend(n);
  ntfLive.add(t);
  if (e.kind === "needs" && e.target) NTF_BY.set(e.target, close);
  // Over the cap the oldest card leaves; it was on screen, so it counts as dismissed.
  const cards = [...box.querySelectorAll(".ntf:not(.out)")];
  for (const c of cards.slice(NTF_MAX)) c.querySelector(".x").click();
  t.sync();
}

/* ---------- dialog ---------- */
// classic: the small centered box with its own header, not the full-screen frame (the settings tab's dialogs, 03-base.css dialog.dlg.cl).
// confirm: a short confirm (a title, a sentence or two, two buttons): on a PC a small box next to the click that opened it (centered when
// nothing was clicked just before), a low bottom sheet on a phone (docs/ui-spec.md 확인 상자).
let CF_PT = null;
document.addEventListener("pointerdown", ev => { CF_PT = { x: ev.clientX, y: ev.clientY, t: Date.now() }; }, true);
function cfPlace(d) {
  if (!CF_PT || Date.now() - CF_PT.t > 2000 || matchMedia("(max-width: 639px)").matches) return;
  const r = d.getBoundingClientRect(), vw = innerWidth, vh = innerHeight, gap = 12;
  const left = Math.min(Math.max(CF_PT.x - r.width / 2, gap), vw - r.width - gap);
  const below = CF_PT.y + gap, top = below + r.height <= vh - gap ? below : Math.max(gap, CF_PT.y - r.height - gap);
  Object.assign(d.style, { margin: "0", right: "auto", bottom: "auto", left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}
function dialog({ title, body, actions = [], onclose, wide, classic, confirm }) {
  const small = classic || confirm;
  const d = el("dialog", { class: `dlg${wide ? " wide" : ""}${confirm ? " cf" : classic ? " cl" : " fs-card"}` });
  const bodyBox = el("div", { class: small ? "dbody" : "dbody fs-body" }, body);
  const actBox = el("div", { class: small ? "dact" : "dact fs-ft row" });
  // The ✕ and a tap outside the box both close it and drop the edit, like Esc and the Android back gesture (dialogHist) already do.
  const head = confirm ? el("h2", { class: "dtitle", text: title })
    : classic
    ? el("div", { class: "dhd" }, el("h2", { class: "dtitle", text: title }), el("button", { type: "button", class: "ib dx", "aria-label": "닫기", onclick: () => d.close() }, icon("close")))
    : fsHead([el("h2", { class: "dtitle", text: title })], { close: () => d.close() });
  d.append(head, bodyBox, actBox);
  let downOutside = false;
  const outside = ev => { const r = d.getBoundingClientRect(); return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom; };
  d.addEventListener("pointerdown", ev => { downOutside = outside(ev); });
  d.addEventListener("click", ev => { if (downOutside && outside(ev) && !openMenu) d.close(); downOutside = false; });
  const h = { node: d, body: bodyBox, close: () => d.close(), setActions };
  function setActions(list) {
    clear(actBox).append(...list.map(a => el("button", { type: "button", class: `btn ${a.kind || "text"}`, disabled: a.disabled, onclick: ev => a.onclick && a.onclick(h.close, ev.currentTarget) }, a.label)));
  }
  setActions(actions);
  d.addEventListener("close", () => { closeMenu(false); d.remove(); if (onclose) onclose(); });
  d.addEventListener("cancel", ev => { if (openMenu) ev.preventDefault(); });
  document.body.append(d);
  d.showModal(); dialogHist(d);
  if (confirm) cfPlace(d);
  motionDialog(d);
  return h;
}
function ask(title, text, ok = "확인", danger = false) {
  return new Promise(res => {
    let v = false;
    dialog({ confirm: true, title, body: text ? el("p", { text }) : null, onclose: () => res(v), actions: [
      { label: "취소", onclick: c => c() },
      { label: ok, kind: danger ? "danger fill" : "pri", onclick: c => { v = true; c(); } }] });
  });
}
