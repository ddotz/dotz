/* ---------- basic markdown (input is escaped before any markup is produced) ---------- */
// Links only for http(s) targets; the text and URL are already escaped when the anchor is built.
// A `code` span stands in as one \0n\0 token, so bold, italics and links can run across it ("**`a.ts` 고침:**").
function inline(s) {
  const codes = [];
  const held = String(s).replace(/\0/g, "").replace(/`[^`\n]+`/g, c => {
    const t = c.slice(1, -1);
    codes.push(`<code${/^(~|\.{0,2}\/)[^\s]*$|^[\w.-]+\/[\w./-]+(:\d+(-\d+)?)?$/.test(t) ? ' class="path"' : ""}>${esc(t)}</code>`);
    return `\0${codes.length - 1}\0`;
  });
  return dropIdNote(esc(held)).replace(/&lt;#(\d{10,})&gt;|(?<![\w/:=-])ch:(\d{10,})\b/g, (_, a, b) => `<a href="#chat/ch:${a || b}">${esc(targetName(`ch:${a || b}`))}</a>`).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)\0]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[^"'>=\w])(https?:\/\/[^\s<\0]*[^\s<.,;:!?)\]'"\0])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>").replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, "$1<i>$2</i>")
    .replace(/\0(\d+)\0/g, (_, n) => codes[n]);
}
// A "|---|" separator row of a table.
const isSep = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Source lists (a heading line over link lines) are read in hub/message-spec-derive.ts; each becomes a row of the card drawn here from the URL string alone: no fetch, no favicon.
// The given name over the site and a short path, or the site over the short path. The full URL stays in the row as clipped text, the only selectable part, so copying the message gives the original URLs.
const sourcePart = s => { try { return decodeURIComponent(s); } catch { return s; } };
// The last two path segments, "…/" when more came before them; a bare domain has none.
function sourcePath(url) {
  const segs = url.pathname.split("/").filter(Boolean).map(sourcePart);
  return (segs.length > 2 ? "…/" : "") + segs.slice(-2).join("/");
}
// A tap after a drag-selection inside a row is the end of the selection, not a request to open it (as 15-attachments.js does for a file row).
// The press itself clears a selection, so a press on a row with text selected is kept for its click.
let sourceRowPressedSelected = null;
const sourceRowSelected = row => { const sel = getSelection(); return !sel.isCollapsed && sel.containsNode(row, true); };
document.addEventListener("click", ev => {
  const row = ev.target.closest?.(".mlist-src a.mlist-row"), pressed = sourceRowPressedSelected;
  sourceRowPressedSelected = null;
  if (row && (row === pressed || sourceRowSelected(row))) ev.preventDefault();
});
// Chromium starts no selection inside a link, only a link drag, so a row gives up its href for the press and takes it back before the click; a plain tap still opens it.
document.addEventListener("mousedown", ev => {
  const row = ev.button === 0 && !ev.ctrlKey ? ev.target.closest?.(".mlist-src a.mlist-row[href]") : null;
  if (!row) return;
  sourceRowPressedSelected = sourceRowSelected(row) ? row : null;
  const href = row.getAttribute("href"), done = new AbortController();
  row.removeAttribute("href");
  for (const end of ["mouseup", "dragend"]) addEventListener(end, () => { row.setAttribute("href", href); done.abort(); }, { capture: true, signal: done.signal });
}, true);
function sourceListHtml({ head, items }) {
  const rows = items.map(({ title, href }) => {
    const url = new URL(href), site = url.hostname.replace(/^www\./, ""), path = sourcePath(url), sub = title ? [site, path].filter(Boolean).join(" · ") : path;
    return `<a class="mlist-row" href="${esc(href)}" title="${esc(href)}" target="_blank" rel="noopener noreferrer"><span class="mlist-url" aria-hidden="true">${esc(href)}</span><span class="mlist-av" aria-hidden="true">${esc(site[0].toUpperCase())}</span><div class="mlist-main"><div class="mlist-t">${esc(title || site)}</div>${sub ? `<div class="mlist-s">${esc(sub)}</div>` : ""}</div></a>`;
  });
  return `<div class="mlist mlist-src">${head ? `<div class="mlist-h">${esc(head)}</div>` : ""}${rows.join("")}</div>`;
}
// One key-column row (.rc-rows): the key muted, what it is, the detail after " · " muted (tail: a ready-made detail instead).
function rcRowHtml(key, text, tail = "") {
  const d = tail ? null : /^(.*?)\s+·\s+(.*)$/.exec(text);
  return `<div class="rc-row"><span class="rc-k">${esc(key)}</span><span class="rc-w"><b>${inline(d ? d[1] : text)}</b> ${d ? `<span class="rc-d">${inline(d[2])}</span>` : tail}</span></div>`;
}
// A schedule: the rows of an answer's card (02-answer-shapes.js) and of a briefing (11-resultcard.js).
const TIME_ROW = /^(\d{1,2}:\d{2})\s+(\S.*)$/;
function timeRowsHtml(items) {
  return `<div class="rc-rows">${items.map(i => { const m = TIME_ROW.exec(i.text); return rcRowHtml(m[1], m[2]); }).join("")}</div>`;
}
// relayed: another computer's reply (42-relay-chat.js) is text only: `[file]` lines stay text and a fence is a plain code block, with no run button and no settings card to act on here.
// answer: a model's text is drawn by its shapes through answerNode (02-answer-shapes.js), the one caller that passes this; a direct mdNode() keeps its text (hub/answer-surfaces-web.test.ts).
// Both read the blocks from hub/message-spec-derive.ts (01-message-spec.js): deriveSpec for an answer (answer.spec when the hub sent one), deriveBasicSpec for any other text.
function mdHtml(src, relayed = false, answer = false) {
  const text = stripMarkers(src, relayed), spec = answer ? answer.spec || deriveSpec(text, botName) : null;
  if (spec) return specHtml(spec, { shaped: !!answer.shaped, lead: answer.lead !== false });
  return specHtml(deriveBasicSpec(text, relayed, botName), { basic: true, relayed, shaped: !!(answer && answer.shaped), lead: !answer || answer.lead !== false });
}
const mdNode = (src, cls = "md", relayed = false, answer = false) => el("div", { class: cls, safeHtml: mdHtml(src, relayed, answer) });

/* ---------- message status (only an explicit line-1 marker sets it; it becomes one leading emoji) ---------- */
const TONE_TAGS = new Map(Object.entries({ done: "done", "완료": "done", run: "run", "진행": "run", wait: "wait", "대기": "wait", ask: "ask", "결정": "ask", fail: "fail", "실패": "fail", warn: "fail", "경고": "fail" }));
// The marker word is drawn as one status tag at the start of the message's first line (prototype .bub .st), never as the raw marker or an emoji.
const LANE_TONE = { done: ["ok", TX("base.mark.done")], run: ["pri", TX("base.mark.run")], wait: ["warn", TX("base.tone.wait")], ask: ["warn", TX("base.mark.ask")], fail: ["err", TX("base.mark.fail")] };
// [run] and [wait] are true only of the moment they were written: 41-runstate.js syncLiveTags draws them from the current state.
const parkedTone = tone => tone === "run" || tone === "wait";
const toneTag = tone => LANE_TONE[tone] ? el("span", { class: `tag ${LANE_TONE[tone][0]} st-tag`, text: LANE_TONE[tone][1] }) : null;
// A lane's worklog entry says whether its report was checked in words (hub/laneops.ts claimPrefix, which Discord shows as subtext); here it is the tag of a project's result row (19-project-main.js pmResultRow).
const CLAIM_LEAD = /^(?:(?:확인됨|보고됨|verified|reported) · )+/, CLAIM_TAG = { verified: ["ok", TX("base.claim.verified")], reported: ["", TX("base.claim.reported")] };
const claimTag = claim => CLAIM_TAG[claim] ? el("span", { class: `tag ${CLAIM_TAG[claim][0]} st-tag claim-tag`, text: CLAIM_TAG[claim][1] }) : null;
// The tag goes in front of the first paragraph's text; a body that opens with a list or a card gets a line of its own.
function toneLead(root, tone, claim = "") {
  const tags = [toneTag(tone), claimTag(claim)].filter(Boolean), f = root.firstElementChild;
  if (!tags.length) return root;
  if (f && /^(P|LI)$/.test(f.tagName)) f.prepend(...tags); else root.prepend(el("p", {}, ...tags));
  return root;
}
// Machine markers never reach the owner as text (owner 2026-10-23). Same shapes as hub/tone.ts stripMarkers (keep in step):
// known marker shapes at line start (behind an optional list dash, `**` or `**name**: ` lead), outside ``` fences; any
// other bracket is content. Status words, [lane <word>], [dotz ...], [orchestrator-guard], [지금 도는 것], [attachment],
// [system], [owner via <x>], [ok | 12ms], [routine:...], [10-23]; a left-over [file] line is dropped. A control word also acts as one opening the
// message, alone on a line, or closing it after a finished sentence (bare, in a code span or bold); a word that names it, a particle or a list keeps it.
// A lone `-` closing a message and a "For <bot>:" line (hub/forline.ts) go too; the page reads no other rule of these.
const MK_BODY = "(?:run|wait|done|ask|fail|warn|blocked|partial|later|ok|error|err|완료|진행|대기|결정|실패|경고|차단|부분|나중|오류|attachment|system|handover|keepalive|orchestrator-guard|gateway check|web:[a-z-]+|지금 도는 것|now running|dotz(?: [a-z][\\w:-]*(?: [^\\]\\n]{1,40})?)?|lane [a-z가-힣][^\\]\\n]{0,30}|owner via [^\\]\\n]{1,30}|(?:ok|error|err|fail)[ ]*\\|[^\\]\\n]{1,24}|routine:[^\\]\\n]{1,60}|\\d{2}-\\d{2})";
const MK_LEAD = new RegExp("^([ \\t]*(?:[-*][ \\t]+)?(?:\uc9c4\ud589 \uc911:[ \\t]*)?(?:\\*\\*[^*\\n]{1,60}\\*\\*:?[ \\t]+)?)(\\*\\*)?\\[" + MK_BODY + "\\](\\*\\*)?[ \\t]*", "i");
const MK_WORD = "\\[(?:run|wait|done|ask|fail|later|keepalive)\\]";
const MK_OPEN = new RegExp("^[ \\t]*(`|\\*\\*)?" + MK_WORD + "\\1(?:[ \\t]+(?!(?:\ub9c8\ucee4|\ud45c\uc2dc|\ud45c\uc2dd|\ubb38\uad6c|\uc81c\uc5b4\uc5b4|\ub2e8\uc5b4|\ud1a0\ud070|\uae00\uc790|\uc2e0\ud638|\ucc98\ub9ac|\ub204\ucd9c|\uac19\uc740|marker|sentinel|token|word))|[ \\t]*$)", "i");
const MK_ALONE = new RegExp("^[ \\t]*(`|\\*\\*)?" + MK_WORD + "\\1[ \\t]*$", "i");
const MK_CLOSE = new RegExp("(?<=[.!?\u2026\uc694\ub2e4])[ \\t]+(`|\\*\\*)?" + MK_WORD + "\\1[ \\t]*$", "i");
// A dropped fail word leaves the failure (the page has no emoji: the word, where the hub leaves its emoji), and a status word in prose reads as its plain word (hub/tone.ts FAIL_WORD, MENTION, keep in step).
const MK_FAIL = /\[(?:fail|실패|warn|경고)\]/i;
const mkFail = gone => MK_FAIL.test(gone) ? `${TX("base.mark.fail")}: ` : "";
const MK_WORDS = { done: TX("base.mark.done"), "완료": TX("base.mark.done"), run: TX("base.mark.run"), "진행": TX("base.mark.run"), wait: TX("base.mark.wait"), "대기": TX("base.mark.wait"), ask: TX("base.mark.ask"), "결정": TX("base.mark.ask"), fail: TX("base.mark.fail"), "실패": TX("base.mark.fail"), warn: TX("base.mark.fail"), "경고": TX("base.mark.fail") };
const MK_STATUS = Object.keys(MK_WORDS).join("|");
const MK_TOKEN = `(?:\`\\[(?:${MK_STATUS})\\]\`|\\*\\*\\[(?:${MK_STATUS})\\]\\*\\*|\\[(?:${MK_STATUS})\\])`;
const MK_JOIN = "[ \\t]*[,/·][ \\t]*";
const MK_NAMES = "(?:\uB9C8\uCEE4|\uD45C\uC2DC|\uD45C\uC2DD|\uBB38\uAD6C|\uC81C\uC5B4\uC5B4|\uB2E8\uC5B4|\uD1A0\uD070|\uAE00\uC790|\uC2E0\uD638|\uCC98\uB9AC|\uB204\uCD9C|\uAC19\uC740|marker|sentinel|token|word)";
const MK_MENTION = new RegExp(`(?<![\\w가-힣"'\\[\`*/])${MK_TOKEN}(?:${MK_JOIN}${MK_TOKEN}){0,7}(?!${MK_JOIN}(?:\`|\\*\\*)?\\[)(?=[,!?…)]|\\.(?![A-Za-z0-9])|[ \\t]+(?!${MK_NAMES})|[ \\t]*$)|(\`[^\`\\n]+\`)`, "gi");
const mkPlainWords = line => line.includes("[") ? line.replace(MK_MENTION, (m, span) => span ?? m.replace(/(?:`|\*\*)?\[([^\]]+)\](?:`|\*\*)?/g, (_, word) => MK_WORDS[word.toLowerCase()])) : line;
const forRe = () => new RegExp(`^\\s*(?:-#?\\s+)?(?:\\*\\*)?(?:For (?:${escRe(botName)}|땃쥐):|(?:${escRe(botName)}|땃쥐) 몫:)`, "i");
// keepFiles: a message body keeps its `[file]` lines for the attachment chips (fileLines, 15-attachments.js); mdNode drops them.
function stripMarkers(text, keepFiles = false, own = true) {
  text = String(text ?? "");
  if (!/\[|몫:|For |<project-info>|\n[ \t]*-\s*$/.test(text)) return text;
  text = text.replace(/\s*<project-info>[\s\S]*?(?:<\/project-info>|$)/g, "");
  let fence = false, opened = false, tail = -1;
  const out = [], fors = [], prose = [], forLine = forRe();
  for (const [i, line] of text.split("\n").entries()) {
    if (/^\s*```/.test(line) || fence) {
      if (/^\s*```/.test(line)) fence = !fence;
      out.push(line);
      if (line.trim()) tail = -1;
      continue;
    }
    if (/^[ \t]*\[file\][ \t]/i.test(line)) { if (keepFiles) out.push(line); continue; }
    if (forLine.test(line)) { fors.push(line); continue; }
    let l = line, mark = "", at = 0;
    const lead = i === 0 && /^\[([^\]\n]+)\]/.exec(l);
    let tone = own && !!lead && TONE_TAGS.has(lead[1].toLowerCase());
    for (let m = MK_LEAD.exec(l); m; m = MK_LEAD.exec(l), tone = false) {
      if (!tone) mark ||= mkFail(m[0]);
      at = m[1].length;
      l = m[1] + l.slice(m[0].length);
    }
    if (!opened && l.trim()) {
      opened = true;
      const m = MK_OPEN.exec(l);
      if (m) {
        mark ||= mkFail(m[0]);
        at = 0;
        l = l.slice(m[0].length);
      }
    }
    if (MK_ALONE.test(l)) {
      mark ||= mkFail(l);
      l = "";
      at = 0;
    }
    if (mark) {
      const rest = l.slice(at).replace(/^:[ \t]*/, "");
      l = rest.trim() ? `${l.slice(0, at)}${mark}${rest}` : `${l.slice(0, at)}${mark.slice(0, -2)}`;
    }
    if (l.trim()) tail = out.length;
    prose.push(out.length);
    out.push(l);
  }
  // A message that is only the line keeps it: nothing else would be drawn.
  if (!out.some(l => l.trim())) return [...out, ...fors].join("\n");
  if (tail >= 0) {
    if (out[tail].trim() === "-" && out.slice(0, tail).some(l => l.trim())) out[tail] = "";
    else out[tail] = out[tail].replace(MK_CLOSE, m => MK_FAIL.test(m) ? ` ${TX("base.mark.fail")}` : "");
  }
  for (const i of prose) out[i] = mkPlainWords(out[i]);
  return out.join("\n");
}
const MK_FAIL_LEAD = /^\s*(?:\*\*|`)?\[(?:fail|실패|warn|경고)\]/i;
function parseTone(text, keepFiles = false) {
  text = String(text ?? "");
  const m = text.match(/^\[([^\]\n]+)\][ \t]*/), tag = m && TONE_TAGS.get(m[1].toLowerCase());
  const body = tag ? text.slice(m[0].length) : text, c = CLAIM_LEAD.exec(body);
  const shown = stripMarkers(c ? body.slice(c[0].length) : body, keepFiles, !tag), said = shown.trimStart();
  const word = (!tag ? MK_FAIL_LEAD.test(body) : tag === "fail") && ["실패", TX("base.mark.fail")].find(w => said.startsWith(w) && (said.length === w.length || said.startsWith(": ", w.length)));
  const led = word ? shown.length - said.length + word.length + (said.length === word.length ? 0 : 2) : 0;
  // A failure marker the tone did not read (bold, indented) still draws the failure tag; under the tag the word is said already.
  return { tone: tag || (led ? "fail" : ""), claim: c ? (/^(?:확인됨|verified)/.test(c[0]) ? "verified" : "reported") : "", text: led ? shown.slice(led) : shown };
}
// An answer's status mark in its emoji form (hub/tone.ts TONE_EMOJI) is read as the marker is, the rule of hub/tone.ts statedTone: the marker wins and an emoji after it goes too.
// emoji: the text had one, so a spec stored before the hub read it (its first line still starts with the mark) is not drawn.
const MARK_TONE = new Map([["\u2705", "done"], ["\u23f3", "run"], ["\u23f8", "wait"], ["\u2753", "ask"], ["\u274c", "fail"]]);
const LED_MARK = new RegExp(`^\\s*(${[...MARK_TONE.keys()].join("|")})\\ufe0f?[ \\t]*`, "u");
function statedTone(text, keepFiles = false) {
  const p = parseTone(text, keepFiles), m = LED_MARK.exec(p.text);
  return m ? { ...p, tone: p.tone || MARK_TONE.get(m[1]), text: p.text.slice(m[0].length), emoji: true } : p;
}

/* ---------- api ---------- */
// index.html starts the first answers (state, history, plan, read positions, activity) in <head>, before this 480KB script is downloaded and parsed; the first api() of that path takes it over.
// A GET that is already in flight is shared (the same path asked twice at boot is one request); each caller parses its own copy of the text.
const apiGets = new Map();
// Names this page's event stream to the gateway: every request carries it, so a stream whose page stopped asking (a phone asleep, the network gone) is closed by the gateway (hub/events.ts noteLive).
const LIVE_TOK = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");
async function api(path, method = "GET", body) {
  [path, method, body] = pqRoute(path, method, body);   // a peer's item is read and acted on through /api/peer/proxy (34-peer-monitoring.js)
  const go = () => fetch(path, { method, cache: "no-store", headers: { "x-dotz-live": LIVE_TOK, ...(body !== undefined && { "Content-Type": "application/json" }) }, body: body !== undefined ? JSON.stringify(body) : undefined });
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
  if (!res.ok) throw Object.assign(new Error(res.status === 503 && path.startsWith("/api/peer/proxy") ? (data && data.reason) || TX("base.peer.read_only") : (data && data.error) || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

/* ---------- snackbar ---------- */
// How notification text names things (01-notice-ko.js): a session by its title, never its code name.
const NK = { lane: name => { try { const l = S && S.lanes.find(x => x.name === name); return (l && l.title) || undefined; } catch { return undefined; } } };
let toastTimer, toastNew = null;   // toastNew: the toast raised in this very run; it tells of the move that follows it, so go() leaves it up
// A toast that times out or whose 되돌리기 was pressed fades out (150ms) and is then removed; a new toast replaces the old one at once.
function toastGone(n) {
  if (!n.isConnected) return;
  n.style.pointerEvents = "none";
  motionOut(n).then(() => n.remove());
}
// A written alternation after a name ("메모장을(를)", "맥미니(으)로") settles by the name's last syllable; a name that does not end in hangul keeps it as written.
const koPick = s => String(s).replace(/([가-힣])(을\(를\)|이\(가\)|은\(는\)|\(으\)로)/g, (_, ch, p) => { const b = (ch.charCodeAt(0) - 0xac00) % 28; return ch + (p === "(으)로" ? (b === 0 || b === 8 ? "로" : "으로") : b ? p[0] : p[2]); });
function toast(msg, bad, action, ms) {
  document.querySelectorAll(".snack").forEach(n => n.remove());
  const n = el("div", { class: `snack${bad ? " bad" : ""}${action ? " act" : ""}`, role: "status" }, el("span", { text: noticeKo(koPick(msg), { ...NK, error: !!bad }) }), action ? el("button", { type: "button", class: "sa", text: action.label, onclick: () => { toastGone(n); action.onclick(); } }) : null);
  (document.querySelector("dialog[open]:not([data-leaving])") || document.body).append(n);
  // A conversation has its composer at the bottom instead of the tab bar: the toast rises above its top edge, a token gap clear of it.
  const tops = ["#composer"].map(s => document.querySelector(s)).map(x => x && x.getBoundingClientRect()).filter(r => r && r.height > 0 && r.top > innerHeight / 2).map(r => r.top);
  if (tops.length) n.style.setProperty("--snack-b", `${Math.round(innerHeight - Math.min(...tops) + parseFloat(getComputedStyle(n).getPropertyValue("--sp-2")))}px`);
  clearTimeout(toastTimer);
  toastNew = n; queueMicrotask(() => { if (toastNew === n) toastNew = null; });
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
  if (paneNotify(e)) return;
  ntfShown.add(key);
  const alertish = e.kind === "out" && e.target === "alert";
  const box = document.querySelector(".ntf-box") || document.body.appendChild(el("div", { class: "ntf-box", "aria-live": "polite" }));
  const lane = e.kind === "lane_report" ? String(e.lane || "") : "";
  const title = noticeKo(e.title || (lane ? NK.lane(lane) || TX("common.session") : alertish ? TX("common.alerts") : TX("base.notice.worklog", { name: botName })), NK);
  const at = e.ts ? new Date(e.ts) : null;
  const tm = at && !isNaN(at) ? at.toLocaleTimeString(TX_LOCALE, { hour: "numeric", minute: "2-digit" }) : "";
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
    lsSet(NTF_KEY, JSON.stringify([...ntfDone].slice(-300)));
    n.classList.add("out");
    setTimeout(() => n.remove(), M_MS.fast);
  }
  n.append(el("button", { type: "button", class: "x", "aria-label": TX("common.close"), text: "×", onclick: ev => { ev.stopPropagation(); close(); } }));
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
document.addEventListener("pointerdown", ev => { CF_PT = { x: ev.clientX, y: ev.clientY, t: Date.now() }; document.documentElement.dataset.pointer = "1"; }, true);
// The ring on a window's first control (the ✕ or 취소, which a window takes focus on opening) shows only after a key was pressed (14-overlay.css).
document.addEventListener("keydown", () => { delete document.documentElement.dataset.pointer; }, true);
function cfPlace(d) {
  if (!CF_PT || Date.now() - CF_PT.t > 2000 || matchMedia("(max-width: 639px)").matches) return;
  const r = d.getBoundingClientRect(), vw = innerWidth, vh = innerHeight, gap = 12;
  const left = Math.min(Math.max(CF_PT.x - r.width / 2, gap), vw - r.width - gap);
  const below = CF_PT.y + gap, top = below + r.height <= vh - gap ? below : Math.max(gap, CF_PT.y - r.height - gap);
  Object.assign(d.style, { margin: "0", right: "auto", bottom: "auto", left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}
// A confirm asked while a sheet or box is open is shown inside it and gives it back after the answer: one window at a time (docs/ui-spec.md 대화창).
function openSheet() {
  const d = document.querySelector("dialog[open]:not([data-leaving]):not(.cf)");
  if (d) return { host: d, onEnd: f => d.addEventListener("close", f, { once: true }) };
  const top = FS[FS.length - 1];
  return top ? { host: top.box, onEnd: f => top.ends.push(f) } : null;
}
function confirmInSheet({ host, onEnd }, { title, body, actions, onclose }) {
  const sheet = host.classList.contains("fs-card"), from = document.activeElement, kept = [...host.children].map(n => [n, n.hidden]);
  let over = false;
  const back = () => h.close();
  const name = el("h2", { class: "dtitle", text: title });
  const head = sheet ? fsHead([name], { close: back }) : el("div", { class: "dhd" }, name, el("button", { type: "button", class: "ib dx", "aria-label": TX("common.close"), onclick: back }, icon("close")));
  const bodyBox = el("div", { class: sheet ? "dbody fs-body" : "dbody" }, body), actBox = el("div", { class: sheet ? "dact fs-ft row" : "dact" });
  const noCancel = ev => ev.preventDefault();
  const esc = ev => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); h.close(); } };
  const watch = new MutationObserver(() => { if (!head.isConnected) end(false); });   // the sheet repainted itself: the question is gone with it
  function end(restore) {
    if (over) return;
    over = true; watch.disconnect(); removeEventListener("keydown", esc, true); host.removeEventListener("cancel", noCancel);
    if (restore && host.isConnected) {
      motionSwap(host, () => { head.remove(); bodyBox.remove(); actBox.remove(); for (const [n, hid] of kept) n.hidden = hid; });
      if (from && from.isConnected) from.focus({ preventScroll: true });
    }
    if (onclose) onclose();
  }
  const h = { node: host, body: bodyBox, close: () => end(true), setActions };
  function setActions(list) {
    clear(actBox).append(...list.map(a => el("button", { type: "button", class: `btn ${a.kind || "text"}`, disabled: a.disabled, onclick: ev => a.onclick && a.onclick(h.close, ev.currentTarget) }, a.label)));
  }
  setActions(actions);
  motionSwap(host, () => { for (const [n] of kept) n.hidden = true; host.append(head, bodyBox, actBox); });
  watch.observe(host, { childList: true });
  addEventListener("keydown", esc, true); host.addEventListener("cancel", noCancel);
  onEnd(() => end(false));
  ovFocus(host, actBox.querySelector(".btn:last-child"));
  return h;
}
function dialog({ title, body, actions = [], onclose, wide, classic, confirm, mid }) {
  if (confirm) { const sheet = openSheet(); if (sheet) return confirmInSheet(sheet, { title, body, actions, onclose }); }
  const small = classic || confirm;
  const d = el("dialog", { class: `dlg${wide ? " wide" : ""}${confirm ? " cf" : classic ? " cl" : mid ? " fs-card mid" : " fs-card"}` });
  const bodyBox = el("div", { class: small ? "dbody" : "dbody fs-body" }, body);
  const actBox = el("div", { class: small ? "dact" : "dact fs-ft row" });
  // The ✕ and a tap outside the box both close it and drop the edit, like Esc and the Android back gesture (dialogHist) already do.
  const head = confirm ? el("h2", { class: "dtitle", text: title })
    : classic
    ? el("div", { class: "dhd" }, el("h2", { class: "dtitle", text: title }), el("button", { type: "button", class: "ib dx", "aria-label": TX("common.close"), onclick: () => d.close() }, icon("close")))
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
  if (document.documentElement.dataset.pointer) ovFocus(d);   // showModal puts the focus on the first control; a pointer open keeps it on the window
  if (confirm) cfPlace(d);
  motionDialog(d);
  return h;
}
function ask(title, text, ok = TX("common.ok"), danger = false) {
  return new Promise(res => {
    let v = false;
    dialog({ confirm: true, title, body: text ? el("p", { text }) : null, onclose: () => res(v), actions: [
      { label: TX("common.cancel"), onclick: c => c() },
      { label: ok, kind: danger ? "danger fill" : "pri", onclick: c => { v = true; c(); } }] });
  });
}
