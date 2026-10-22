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
function blocks(text) {
  const html = [], meta = metaRe();
  let list = null, para = [], table = null, quote = [];
  const flushQ = () => { if (quote.length) html.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`); quote = []; };
  const flushP = () => { flushQ(); if (para.length) html.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushL = () => { if (list) html.push(`<${list.t}>${list.items.map(i => `<li${i.sub ? ' class="sub"' : ""}>${inline(i.text)}</li>`).join("")}</${list.t}>`); list = null; };
  const flushT = () => {
    if (!table) return;
    const [head, ...rest] = table.head ? table.rows : [null, ...table.rows];
    html.push(`<div class="tbl"><table>${head ? `<thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead>` : ""}<tbody>${rest.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    table = null;
  };
  for (const line of unquoteChoices(text.split("\n"))) {
    let m;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushP(); flushL();
      if (!table) table = { rows: [], head: false };
      if (isSep(line)) { if (table.rows.length === 1) table.head = true; } else table.rows.push(cells(line));
      continue;
    }
    flushT();
    // Discord's "-# " subtext line renders like the meta lines.
    if (meta.test(line) || /^\s*-#\s/.test(line)) { flushP(); flushL(); html.push(`<p class="meta">${inline(line.replace(/^\s*-#?\s+/, ""))}</p>`); continue; }
    // An indented item (2+ spaces) is a sub-item of the list it sits in, whatever its own marker.
    if ((m = line.match(/^(\s*)(?:[-*•]|(\d+)[.)])\s+(.*)/))) {
      flushP();
      const t = m[2] ? "ol" : "ul", sub = m[1].length >= 2 && !!list;
      if (!sub && (!list || list.t !== t)) { flushL(); list = { t, items: [] }; }
      list.items.push({ text: m[3], sub });
    }
    else if ((m = line.match(/^\s*>\s?(.*)/))) { flushL(); if (para.length) { const q = quote; quote = []; flushP(); quote = q; } quote.push(m[1]); }
    else if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushP(); flushL(); html.push(`<p class="h"><b>${inline(m[1])}</b></p>`); }
    else if (!line.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(line); }
  }
  flushP(); flushL(); flushT();
  return html.join("");
}
// A fence tagged 목록 is a list shown as UI rows (hub/listblock.ts writes it): an optional "# " title line, then one row per line
// "title | subtitle | meta | badge" (the last three optional). Each row gets a round initial, the meta on the right and a count badge.
function listBlockHtml(src) {
  const lines = String(src ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  const head = lines[0] && lines[0].startsWith("# ") ? lines.shift().slice(2) : "";
  const rows = lines.map(l => {
    const [t = "", s = "", meta = "", badge = ""] = l.split(" | ").map(x => x.trim());
    const initial = Array.from(t.replace(/^[^\p{L}\p{N}]+/u, ""))[0] || "·";
    return `<div class="mlist-row"><span class="mlist-av" aria-hidden="true">${esc(initial)}</span><div class="mlist-main"><div class="mlist-t">${esc(t)}</div>${s ? `<div class="mlist-s">${esc(s)}</div>` : ""}</div>${meta || badge ? `<div class="mlist-r">${meta ? `<span class="mlist-m">${esc(meta)}</span>` : ""}${/^\d+\+?$/.test(badge) && badge !== "0" ? `<span class="mlist-b">${esc(badge)}</span>` : ""}</div>` : ""}</div>`;
  });
  return `<div class="mlist">${head ? `<div class="mlist-h">${esc(head)}</div>` : ""}${rows.join("")}</div>`;
}
function mdHtml(src) {
  // split() with two groups: [text, language, code, text, language, code, ...]; each code block gets its copy / run bar (35-code-blocks.js).
  const parts = String(src ?? "").split(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/);
  // A fence tagged 원문 is a post's raw machine output (hub/watchtext.ts rawFence): folded, monospace, tap to open.
  return parts.map((p, i) => i % 3 === 0 ? blocks(p) : i % 3 === 2 ? (parts[i - 1].trim() === "목록" ? listBlockHtml(p) : parts[i - 1].trim() === "원문" ? `<details class="more raw"><summary>원문</summary><pre>${esc(p.replace(/\n$/, ""))}</pre></details>` : codeBlockHtml(parts[i - 1], p)) : "").join("");
}
const mdNode = (src, cls = "md") => el("div", { class: cls, safeHtml: mdHtml(src) });

/* ---------- message status (only an explicit line-1 marker sets it; it becomes one leading emoji) ---------- */
const TONE_TAGS = new Map(Object.entries({ done: "done", "완료": "done", run: "run", "진행": "run", ask: "ask", "결정": "ask", fail: "fail", "실패": "fail", warn: "fail", "경고": "fail" }));
const TONE_EMOJI = { done: "✅", run: "⏳", ask: "❓", fail: "❌" };
const LANE_TONE = { done: ["ok", "완료"], run: ["pri", "진행 중"], ask: ["warn", "질문"], fail: ["err", "실패"] };
function parseTone(text) {
  const m = text.match(/^\[([^\]\n]+)\][ \t]*/), tag = m && TONE_TAGS.get(m[1].toLowerCase());
  return tag ? { tone: tag, text: text.slice(m[0].length) } : { tone: "", text };
}

/* ---------- api ---------- */
// index.html starts the first answers (state, history, plan, read positions, activity) in <head>, before this 480KB script is downloaded and parsed; the first api() of that path takes it over.
// A GET that is already in flight is shared (the same path asked twice at boot is one request); each caller parses its own copy of the text.
const apiGets = new Map();
async function api(path, method = "GET", body) {
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
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { data });
  return data;
}
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

/* ---------- snackbar ---------- */
let toastTimer;
function toast(msg, bad, action, ms) {
  document.querySelectorAll(".snack").forEach(n => n.remove());
  const n = el("div", { class: `snack${bad ? " bad" : ""}${action ? " act" : ""}`, role: "status" }, el("span", { text: msg }), action ? el("button", { type: "button", class: "sa", text: action.label, onclick: () => { n.remove(); action.onclick(); } }) : null);
  (document.querySelector("dialog[open]") || document.body).append(n);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.remove(), ms || (bad || action ? 6000 : 3500));
}

/* ---------- floating notices: top-right cards that leave ~4s after the owner has seen them ---------- */
// "Seen" = the tab is visible and the window focused: a notice that arrives while away waits, and its countdown starts
// when the window becomes active again; hovering pauses it. A dismissed notice (closed, clicked or timed out) is kept in
// localStorage so neither a reconnect replay nor a reload brings it back.
const NTF_MAX = 3, NTF_MS = 4000, NTF_KEY = "dotz-ntf-done";
const ntfDone = new Set((() => { const v = lsJson(NTF_KEY, []); return Array.isArray(v) ? v : []; })());
const ntfShown = new Set(), ntfLive = new Set();
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
  const title = e.title || (lane ? `세션 ${lane}` : alertish ? "알림" : `${botName} 작업 기록`);
  const at = e.ts ? new Date(e.ts) : null;
  const tm = at && !isNaN(at) ? at.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" }) : "";
  const first = text.split("\n").find(l => l.trim()) || text;
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
    ntfDone.add(key);
    try { localStorage.setItem(NTF_KEY, JSON.stringify([...ntfDone].slice(-300))); } catch {}
    n.classList.add("out");
    setTimeout(() => n.remove(), 220);
  }
  n.append(el("button", { type: "button", class: "x", "aria-label": "닫기", text: "×", onclick: ev => { ev.stopPropagation(); close(); } }));
  // A tap opens the item by its kind, like every other notice entry point (30-notices.js noticeOpen).
  n.addEventListener("click", () => { close(); noticeOpen(ntOfEvent(e)); });
  n.addEventListener("pointerenter", () => { hover = true; t.sync(); });
  n.addEventListener("pointerleave", () => { hover = false; t.sync(); });
  n.addEventListener("animationend", () => n.classList.remove("in"), { once: true });
  box.prepend(n);
  ntfLive.add(t);
  // Over the cap the oldest card leaves; it was on screen, so it counts as dismissed.
  const cards = [...box.querySelectorAll(".ntf:not(.out)")];
  for (const c of cards.slice(NTF_MAX)) c.querySelector(".x").click();
  t.sync();
}

/* ---------- dialog ---------- */
// classic: the small centered box with its own header, not the full-screen frame (the settings tab's dialogs, 03-base.css dialog.dlg.cl).
function dialog({ title, body, actions = [], onclose, wide, classic }) {
  const d = el("dialog", { class: `dlg${wide ? " wide" : ""}${classic ? " cl" : " fs-card"}` });
  const bodyBox = el("div", { class: classic ? "dbody" : "dbody fs-body" }, body);
  const actBox = el("div", { class: classic ? "dact" : "dact fs-ft row" });
  // The ✕ and a tap outside the box both close it and drop the edit, like Esc and the Android back gesture (dialogHist) already do.
  const head = classic
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
  return h;
}
function ask(title, text, ok = "확인", danger = false) {
  return new Promise(res => {
    let v = false;
    dialog({ title, body: text ? el("p", { text }) : null, onclose: () => res(v), actions: [
      { label: "취소", onclick: c => c() },
      { label: ok, kind: danger ? "danger fill" : "pri", onclick: c => { v = true; c(); } }] });
  });
}
