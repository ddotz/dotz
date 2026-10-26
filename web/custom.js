/* dotz custom layer (web side): custom cards on 홈, pinned projects / routines / links, the project page.
   Classic script loaded after index.html's main script; it uses that script's globals (el, $, api, icon, go, toast, busy,
   openTarget, lastChatView, statusKo, statusTone, current, parseHash, clear, enc). Data: GET /api/custom. */
(() => {
  "use strict";

  const CSS = `
.cu-r { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 10px 16px; border: 0; border-radius: 0; background: var(--card); color: var(--fg); font: 500 15px/22px var(--font); text-align: left; text-decoration: none; }
button.cu-r, a.cu-r { cursor: pointer; }
button.cu-r:hover, a.cu-r:hover { background: var(--card-hover); }
.cu-r svg.ic { color: var(--fg-3); }
.cu-rn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cu-r > .dot { margin-left: auto; }
.cu-r > .ib { margin-left: auto; }
.cu-m { color: var(--fg-3); font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
.cf .btn:disabled, .pv-acts .btn:disabled { opacity: .4; cursor: default; }
.cu-cause { margin-top: 8px; color: var(--err); font-size: 12px; line-height: 16px; }
/* card editor (dialog): the app's fields, two to a row where they are short, one tonal block per action */
.cu-form { display: flex; flex-direction: column; gap: 14px; padding-top: 8px; }
.cu-form .fi { font-size: 14px; }
.cu-form textarea.fi { height: auto; min-height: 76px; padding: 8px 12px; resize: vertical; font: inherit; font-size: 14px; line-height: 21px; }
.cu-form .fi[aria-invalid="true"] { border-color: var(--err); }
.cu-form .seg button { height: 32px; }
.cu-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.cu-hint { margin-top: -8px; color: var(--fg-3); font-size: 12px; line-height: 16px; }
.cu-acts { display: flex; flex-direction: column; gap: 8px; }
.cu-act { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--r-ctl); background: var(--layer); }
.cu-act .fi, .cu-act .seg button.on { background: var(--card); }
.cu-act-h { display: flex; align-items: center; gap: 8px; }
.cu-act-h .fi { flex: 1; }
.cu-act-h .seg { flex: none; width: 112px; }
.cu-act-f { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cu-chk { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; color: var(--fg-2); font-size: 13px; cursor: pointer; }
.cu-chk input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.cu-ferr { display: flex; gap: 8px; align-items: flex-start; color: var(--err); font-size: 13px; line-height: 18px; overflow-wrap: anywhere; }
.cu-ferr:empty { display: none; }
.cu-add { align-self: flex-start; }
@media (pointer: coarse) { .cu-form textarea.fi { font-size: 16px; } .cu-form .fi { font-size: 16px; } }
@media (max-width: 639px) { .cu-2 { grid-template-columns: minmax(0, 1fr); } }
.pv-cnt { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 12px; line-height: 16px; font-weight: 600; }
.pv-path { max-width: 100%; color: var(--fg-3); font: 13px/18px var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.pv-path { padding: 0; border: 0; background: none; cursor: copy; }
button.pv-path:hover { color: var(--fg-2); }
.pv-desc { color: var(--fg); font-size: 15px; line-height: 23px; }
.pv-hint { margin-top: 8px; color: var(--fg-3); font-size: 12.5px; line-height: 18px; }
#v-project.pv { max-width: 1180px; }
.pv-top { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.pv-ov { display: flex; flex-direction: column; gap: 16px; padding: 18px 20px; }
.pv-last { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin-top: auto; padding-top: 14px; border-top: 1px solid var(--line); font-size: 13px; line-height: 20px; }
.pv-last > .pv-lx { flex: 1; min-width: 0; color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-last > .cu-m { flex: none; }
.pv-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; color: var(--fg-3); font-size: 13px; line-height: 18px; }

.pv-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.pv-tile { min-width: 0; }
.pv-tile + .pv-tile { padding-left: 12px; border-left: 1px solid var(--line); }
.pv-tv { display: flex; align-items: center; gap: 8px; font: 700 20px/28px var(--font); letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pv-cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 24px; align-items: start; }
.pv-col { display: flex; flex-direction: column; min-width: 0; }
.pv-sh { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.pv-sh .sec { margin: 28px 4px 10px; }
.pv-sh > .cu-m { margin-right: 4px; }
.pv-lane { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "lt acts" "line line"; align-items: center; column-gap: 8px; row-gap: 2px; padding: 12px 16px; cursor: pointer; }
.pv-lane > .pv-lt { grid-area: lt; }
.pv-lane > .pv-acts { grid-area: acts; }
.pv-lane > .pv-line { grid-area: line; }
.pv-lane:hover { background: var(--card-hover); }
.pv-lane:focus-visible, .pv-res:focus-visible, .pv-task:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.pv-lane + .pv-lane, .pv-task + .pv-task, .pv-res + .pv-res { border-top: 1px solid var(--line); }
.pv-lt { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 28px; }
.pv-ln { flex: none; max-width: 50%; font: 600 15px/22px var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-lt > .cu-m { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-acts { display: flex; gap: 6px; }
.pv-acts .btn { height: 28px; padding: 0 10px; font-size: 13px; }
.pv-line { padding-left: 16px; color: var(--fg-2); font-size: 14px; line-height: 21px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-line.none { color: var(--fg-3); }
.pv-day { padding: 12px 16px 4px; color: var(--fg-3); font: 600 12px/16px var(--font); }
.pv-day + .pv-res { border-top: 0; }
.pv-res { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: baseline; column-gap: 10px; width: 100%; padding: 9px 16px; border: 0; border-radius: 0; background: transparent; color: var(--fg); text-align: left; font: inherit; }
button.pv-res { cursor: pointer; }
button.pv-res:hover { background: var(--card-hover); }
.pv-kind { justify-self: start; height: 20px; padding: 0 7px; border-radius: 10px; background: var(--layer); color: var(--fg-2); font-size: 11px; line-height: 20px; font-weight: 600; white-space: nowrap; }
.pv-rt { min-width: 0; font-size: 14px; line-height: 21px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-res.report .pv-rt { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.pv-rt.mono { font: 12px/21px var(--mono); color: var(--fg-2); }
.pv-rt .pv-h { margin-right: 8px; color: var(--fg-3); font: 12px/21px var(--mono); }
.pv-rr { display: flex; align-items: center; gap: 6px; color: var(--fg-3); font-size: 12px; line-height: 16px; white-space: nowrap; }
.pv-rsub { grid-column: 2 / 4; color: var(--fg-3); font-size: 12px; line-height: 16px; }
.pv-box2 { padding: 4px 0; }
.pv-sub { padding: 12px 16px 4px; color: var(--fg-3); font: 600 12px/16px var(--font); }
.pv-task { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 10px 16px; border: 0; border-radius: 0; background: transparent; color: var(--fg); text-align: left; font: inherit; cursor: pointer; }
.pv-task:hover { background: var(--card-hover); }
.pv-ring { flex: none; width: 16px; height: 16px; margin-top: 3px; border: 1.5px solid var(--line-2); border-radius: 50%; }
.pv-task:hover .pv-ring { border-color: var(--accent); }
.pv-tw { min-width: 0; font-size: 14px; line-height: 21px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pv-links { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 16px 12px; }
.pv-link { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 30px; padding: 0 10px; border-radius: 15px; background: var(--layer); color: var(--fg-2); font-size: 13px; line-height: 18px; }
.pv-link svg.ic { width: 14px; height: 14px; }
.pv-link .tx { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-link button { display: inline-grid; place-items: center; width: 20px; height: 20px; margin-right: -4px; border: 0; border-radius: 10px; background: transparent; color: var(--fg-2); cursor: pointer; }
.pv-link button:hover { background: var(--hover); }
.pv-link button svg.ic { width: 12px; height: 12px; }
.pv-req { display: flex; flex-direction: column; padding: 16px; }
.pv-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pv-chips > .cu-m { margin-right: 2px; }
.pv-chips .chip { background: var(--layer); }
.pv-chips .chip.on { background: var(--fg); color: var(--bg); }
.pv-box { display: flex; align-items: flex-end; gap: 8px; margin-top: 12px; padding: 6px 6px 6px 14px; border: 1px solid var(--line-2); border-radius: 22px; background: var(--card); }
.pv-box:focus-within { border-color: var(--accent); }
.pv-ta { flex: 1; min-width: 0; height: 32px; max-height: 180px; padding: 5px 0; border: 0; background: transparent; color: var(--fg); outline: 0; resize: none; font: 14px/22px var(--font); }
.pv-ta::placeholder { color: var(--fg-3); }
.pv-send { width: 32px; height: 32px; border-radius: 16px; background: var(--accent); color: var(--on-accent); }
.pv-send:disabled { background: var(--layer); color: var(--fg-3); cursor: default; }
.pv-quick { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.pv-q { height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 14px; background: transparent; color: var(--fg-2); font: 500 12.5px/26px var(--font); cursor: pointer; }
.pv-q:hover { background: var(--hover); color: var(--fg); }
@media (pointer: coarse) { .pv-ta { font-size: 16px; line-height: 22px; } .pv-q { height: 34px; line-height: 32px; } }
@media (min-width: 1100px) {
  .pv-top { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); }
  .pv-cols { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); }
}
@media (max-width: 639px) {
  .pv-ov { padding: 16px; gap: 14px; }
  .pv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 14px; }
  .pv-tile:nth-child(3) { padding-left: 0; border-left: 0; }
  .pv-tv { font-size: 18px; line-height: 26px; }
  .pv-res { grid-template-columns: 40px minmax(0, 1fr); }
  .pv-rr { grid-column: 2; }
  .pv-lane { grid-template-columns: minmax(0, 1fr); grid-template-areas: "lt" "line" "acts"; }
  .pv-lane > .pv-acts { margin: 6px 0 0 16px; }
  .pv-lane > .pv-acts:empty { display: none; }
}
`;
  document.head.append(el("style", { text: CSS }));

  let DATA = null, loadedAt = 0, flight = null, projKey = "";
  const str = v => v == null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  const isHttp = u => typeof u === "string" && /^https?:\/\//i.test(u);
  // Card values as people read them: an ISO date-time in the browser's local time, an empty value as "없음".
  const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;
  const clock = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  function localTime(iso, now = new Date()) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const min = Math.floor((now - d) / 60000), day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    if (min >= 0 && min < 1) return "방금";
    if (min >= 1 && min < 60) return `${min}분 전`;
    const dd = Math.round((day(now) - day(d)) / 86400000);
    if (dd === 0) return clock(d);
    if (dd === 1) return `어제 ${clock(d)}`;
    return `${d.getFullYear() === now.getFullYear() ? "" : `${d.getFullYear()}년 `}${d.getMonth() + 1}월 ${d.getDate()}일 ${clock(d)}`;
  }
  const show = (v, now) => { const s = str(v).trim(); return !s || /^[-–—]$/.test(s) ? "없음" : s.replace(ISO, m => localTime(m, now)).replace(/([:：])\s*[-–—]$/, "$1 없음"); };
  const openLink = l => { if (isHttp(l)) window.open(l, "_blank", "noopener,noreferrer"); else if (typeof l === "string" && l[0] === "#") location.hash = l; };
  const same = (box, sig) => { if (box.dataset.sig === sig) return true; box.dataset.sig = sig; return false; };

  /* ---------- data ---------- */
  function load(maxAge) {
    if (DATA && Date.now() - loadedAt < maxAge) return Promise.resolve(DATA);
    if (!flight) flight = api("/api/custom").then(d => { DATA = d; loadedAt = Date.now(); onData(); return d; }).catch(() => DATA).finally(() => { flight = null; });
    return flight;
  }
  function onData() {
    if (current === "home") renderHome();
    if (current === "project") paintProject();
  }

  /* ---------- cards ---------- */
  // One standard for every generated card (docs/customization.md "Card design"): only the classes the built-in home cards use
  // (.card .ch h3 .tag .big .sup .kv .row .more .cf .btn), at most 2 buttons in the footer, the rest in the card's ⋯ menu.
  const KV_MAX = 6, LIST_MAX = 5, ACT_MAX = 4, ACT_SHOWN = 2;
  const splitActions = list => ({ shown: list.slice(0, ACT_SHOWN), rest: list.slice(ACT_SHOWN, ACT_MAX) });
  const moreRow = n => n > 0 ? el("div", { class: "more", text: `더 보기 · ${n}개` }) : null;
  // One line of state inside a card (empty, loading, failed), the same element the built-in 알림 / 작업내역 / 모니터링 cards use.
  const stateLine = (text, cls = "") => el("div", { class: `hc-none${cls ? ` ${cls}` : ""}`, text });
  // A card whose file cannot be read: the same header as every card (title, state tag, ⋯ menu with 수정… / 삭제…), the cause as its body.
  const errorCard = c => el("div", { class: "card" },
    el("div", { class: "ch" }, el("h3", { text: c.title || c.id || c.file || "카드" }), el("span", { class: "tag err", text: "오류" }), c.id ? menuBtn(`custom:${c.id}`) : null),
    stateLine(str(c.error) || "카드를 그리지 못했어요", "clamp c4"));

  function viewBody(c) {
    const d = c.data, v = c.view || "text";
    if (d === undefined || d === null) return stateLine(c.error ? "값을 받지 못했어요" : "값 없음");
    if (v === "stat") {
      const o = typeof d === "object" && !Array.isArray(d) ? d : { value: d };
      return el("div", null, el("div", { class: "big", text: show(o.value) }),
        o.label != null ? el("div", { class: "sup", text: show(o.label) }) : null,
        o.sub != null ? el("div", { class: "sup", text: show(o.sub) }) : null);
    }
    if (v === "list") {
      const all = Array.isArray(d) ? d : [];
      if (!all.length) return stateLine("비어 있어요");
      return el("div", null, ...all.slice(0, LIST_MAX).map(it => {
        const o = it && typeof it === "object" ? it : { title: it };
        const kids = [el("span", { class: "nm", text: show(o.title) }), o.sub != null ? el("span", { class: "sup", text: show(o.sub) }) : null];
        return isHttp(o.url)
          ? el("div", { class: "row tap", role: "link", tabindex: "0", onclick: ev => { ev.stopPropagation(); openLink(o.url); }, onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); openLink(o.url); } } }, ...kids)
          : el("div", { class: "row" }, ...kids);
      }), moreRow(all.length - LIST_MAX));
    }
    if (v === "kv") {
      const pairs = Array.isArray(d) ? d.filter(Array.isArray).map(p => [p[0], p[1]]) : d && typeof d === "object" ? Object.entries(d) : [];
      if (!pairs.length) return stateLine("비어 있어요");
      return el("div", null, ...pairs.slice(0, KV_MAX).map(([k, val]) => el("div", { class: "kv" }, el("span", { class: "k", text: str(k) }), el("span", { class: "v", text: show(val) }))), moreRow(pairs.length - KV_MAX));
    }
    return el("div", { class: "clamp c4", text: show(typeof d === "object" && !Array.isArray(d) && "text" in d ? d.text : d) });
  }

  const firstLine = s => (String(s || "").split("\n").map(x => x.trim()).find(Boolean) || "").slice(0, 80);
  const runAction = (c, i, a) => async () => {
    if (a.confirm && !await ask(a.label, "실행할까요?", "실행", true)) return;
    const r = await api("/api/custom/action", "POST", { id: c.id, index: i });
    if (a.kind === "prompt") { toast(`${botName}에게 보냈어요`); return; }
    const line = firstLine(r.output);
    toast(r.ok ? line || "끝냈어요" : `실패했어요${line ? ` · ${line}` : ""}`, !r.ok);
    if (r.card) applyCard(r.card);
  };
  function actionButton(c, i, a) {
    const b = el("button", { class: "btn tonal", type: "button", title: a.label, text: a.label });
    b.addEventListener("click", ev => { ev.stopPropagation(); busy(b, runAction(c, i, a)); });
    return b;
  }

  function cardNode(c) {
    try {
      if (c.error && c.data === undefined) return errorCard(c);
      const body = el("div", { class: c.note ? "mt8" : "" });
      // the cause of a failed data command sits under the body: next to the value it could not refresh (오래된 값) or replace
      const cause = c.error ? el("div", { class: "cu-cause clamp", text: str(c.error), title: str(c.error) }) : null;
      const kids = [el("div", { class: "ch" }, el("h3", { text: c.title || c.id }), c.stale ? el("span", { class: "tag warn", text: "오래된 값" }) : c.error ? el("span", { class: "tag err", text: "실패" }) : null, menuBtn(`custom:${c.id}`)),
        c.note ? el("div", { class: "sup", text: show(c.note) }) : null, body, cause];
      const { shown } = splitActions(c.actions || []);
      if (shown.length) kids.push(el("div", { class: "cf" }, ...shown.map((a, i) => actionButton(c, i, a))));
      const card = c.link ? tapCard(() => openLink(c.link), ...kids) : el("div", { class: "card" }, ...kids);
      card.dataset.card = c.id;
      if (shown.length) card.classList.add("foot");
      if (c.render) {
        const loading = stateLine("불러오는 중…");
        body.append(loading);
        import(`/api/custom/render?id=${enc(c.id)}&v=${enc(c.rev || "")}`)
          .then(m => m.default(c.data, { el, card: c }))
          .then(out => { loading.remove(); if (out && out.nodeType) body.append(out); else if (out != null) body.append(el("div", { class: "clamp c4", text: str(out) })); })
          .catch(e => card.replaceWith(errorCard({ id: c.id, title: c.title, error: e && e.message ? e.message : "render.js 오류" })));
      } else body.append(viewBody(c));
      return card;
    } catch (e) {
      return errorCard({ id: c && c.id, error: e && e.message });
    }
  }

  const SCHED = r => !r.schedule ? "" : r.schedule.at ? `매일 ${r.schedule.at}` : r.schedule.every_minutes ? `${r.schedule.every_minutes}분마다` : "";

  /* ---------- 홈 ---------- */
  // The cards are items of the home board (08-home.js renderHome), so they move, resize and persist like every other home card.
  const HIDDEN_KEY = "dotz-home-hidden-custom", nodes = new Map();
  let hidden = new Set((a => Array.isArray(a) ? a.filter(x => typeof x === "string") : [])(lsJson(HIDDEN_KEY, [])));
  const saveHidden = () => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* storage full or blocked */ } };
  function homeNode(c) {
    const sig = JSON.stringify(c), hit = nodes.get(c.id);
    if (hit && hit.sig === sig) return hit.node;
    const node = cardNode(c);
    nodes.set(c.id, { sig, node });
    return node;
  }
  // Default size: a third of the width, tall enough for the content (header, rows, buttons); wider only for long text.
  function homeSize(c) {
    const d = c.data, v = c.view || "text", n = Array.isArray(d) ? d.length : d && typeof d === "object" ? Object.keys(d).length : 1;
    const text = str(d && typeof d === "object" && !Array.isArray(d) && "text" in d ? d.text : d);
    const rows = Math.min(n, v === "kv" ? KV_MAX : LIST_MAX), more = (v === "kv" || v === "list") && n > rows ? 28 : 0;
    const body = c.error && d === undefined ? 44 : c.render ? 140 : v === "kv" || v === "list" ? rows * 30 + more : v === "stat" ? 60 : Math.min(4, Math.ceil(text.length / 40)) * 22;
    const px = 24 + 30 + (c.note ? 24 : 0) + body + (c.error && d !== undefined ? 24 : 0) + ((c.actions || []).length ? 40 : 0) + 4;
    return { w: !c.render && v === "text" && text.length > 160 ? 6 : 4, h: Math.min(10, Math.max(3, Math.ceil((px + BGAP) / BSTEP))) };
  }
  function homeItems() {
    if (!DATA) return [];
    return (DATA.cards || []).filter(c => !hidden.has(c.id)).map(c => ({ id: `custom:${c.id}`, node: homeNode(c), head: ".ch", def: homeSize(c), min: { w: 3, h: 2 }, max: { w: 12, h: 14 } }));
  }
  // Saved places of cards stay while the list has not loaded or the card is only hidden.
  const keepPlace = id => !DATA || hidden.has(id.slice(7));
  function applyCard(card) {
    if (DATA) DATA.cards = (DATA.cards || []).map(x => x.id === card.id ? card : x);
    onData();
  }
  function menuActs(id) {
    const c = ((DATA && DATA.cards) || []).find(x => x.id === id);
    if (!c) return [];
    const key = `custom:${id}`, def = homeSize(c), broken = c.error && c.data === undefined;
    const acts = broken ? [] : [{ label: "새로고침", run: () => busy(null, async () => { applyCard(await api("/api/custom/refresh", "POST", { id })); }) }];
    if (c.link) acts.push({ label: "열기", run: () => openLink(c.link) });
    splitActions(c.actions || []).rest.forEach((a, j) => acts.push({ label: a.label, run: () => busy(null, runAction(c, ACT_SHOWN + j, a)) }));
    acts.push({ label: "수정…", run: () => edit(id) });
    if (!broken) acts.push({ label: "작게", run: () => homeBoard.resize(key, 3, def.h) }, { label: "보통", run: () => homeBoard.resize(key, def.w, def.h) }, { label: "크게", run: () => homeBoard.resize(key, 6, def.h + 2) });
    acts.push({ label: "숨기기", run: () => { hidden.add(id); saveHidden(); renderHome(); } });
    acts.push({ label: "삭제…", run: () => remove(id) });
    return acts;
  }
  function unhide() { hidden = new Set(); saveHidden(); }

  /* ---------- add / edit / remove: the card file, written by the gateway (POST / PUT / DELETE /api/custom/cards) ---------- */
  const VIEW_KO = { text: "글", stat: "숫자", list: "목록", kv: "항목별 값" };
  const FIELD_KO = { title: "제목", note: "설명", view: "보기", text: "내용", command: "명령", cwd: "폴더", every_minutes: "갱신 주기", timeout_seconds: "제한 시간", link: "링크", actions: "동작", id: "아이디" };
  const ACT_MAX_EDIT = 4;
  const seg = (items, value, onPick) => {
    const box = el("div", { class: "seg", role: "radiogroup" });
    const paint = v => { for (const b of box.children) { const on = b.dataset.v === v; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); } };
    for (const [v, label] of items) box.append(el("button", { type: "button", role: "radio", "data-v": v, text: label, onclick: () => { paint(v); onPick(v); } }));
    paint(value);
    return box;
  };
  const field = (key, ctrl) => { const lb = el("label", { text: FIELD_KO[key], for: ctrl.id }); return el("div", { class: "tf", "data-f": key }, lb, ctrl); };
  // The editor: one dialog for a new card and for an existing one. Saving sends the form as the card file's keys; the gateway's
  // validation message comes back next to the field it names (the message starts with that key), else above the buttons.
  function cardForm(spec, cur) {
    const s = spec || {}, acts0 = Array.isArray(s.actions) ? s.actions.slice(0, ACT_MAX_EDIT) : [];
    let view = VIEW_KO[s.view] ? s.view : "text", src = s.command !== undefined ? "command" : "text";
    const title = input({ value: s.title || "", maxlength: "40", placeholder: "예: 디스크 남은 공간", required: true });
    const note = input({ value: s.note || "", maxlength: "120", placeholder: "제목 아래 한 줄 (선택)" });
    const id = cur ? null : input({ value: "", maxlength: "40", placeholder: "비우면 제목으로 만들어요", pattern: "[a-z0-9][a-z0-9-]{0,39}" });
    const body = el("textarea", { id: `f${++fieldSeq}`, class: "fi", rows: "3", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
    body.value = src === "command" ? s.command || "" : typeof s.text === "string" ? s.text : "";
    const cwd = input({ value: s.cwd || "", placeholder: "~/Code/… (선택)" });
    const every = input({ value: s.every_minutes != null ? String(s.every_minutes) : "", type: "number", min: "1", step: "1", inputmode: "numeric", placeholder: "10" });
    const timeout = input({ value: s.timeout_seconds != null ? String(s.timeout_seconds) : "", type: "number", min: "1", max: "60", step: "1", inputmode: "numeric", placeholder: "10" });
    const link = input({ value: s.link || "", type: "url", inputmode: "url", placeholder: "https://… 또는 #화면 (선택)" });
    const bodyField = field("text", body), cmdOnly = el("div", { class: "cu-2" }, field("cwd", cwd), field("every_minutes", every)), tmoField = field("timeout_seconds", timeout);
    const hint = el("div", { class: "cu-hint" });
    const paintSrc = () => {
      bodyField.querySelector("label").textContent = src === "command" ? FIELD_KO.command : FIELD_KO.text;
      bodyField.dataset.f = src;
      body.placeholder = src === "command" ? "예: df -h ~ | tail -1   (출력이 JSON이면 그대로 읽어요)" : "카드에 보일 글";
      cmdOnly.hidden = src !== "command"; tmoField.hidden = src !== "command";
      hint.textContent = src === "command" ? `갱신 주기는 분, 제한 시간은 초(1~60). 출력은 ${VIEW_KO[view]} 보기로 그려요.` : `적은 글을 ${VIEW_KO[view]} 보기로 그려요.`;
    };
    const viewSeg = seg(Object.entries(VIEW_KO), view, v => { view = v; paintSrc(); });
    const srcSeg = seg([["text", "직접 입력"], ["command", "명령 실행"]], src, v => { src = v; paintSrc(); });
    paintSrc();
    // actions: label, 명령 or 요청, its text, and whether to ask first
    const actsBox = el("div", { class: "cu-acts" });
    const addAct = el("button", { class: "btn text cu-add", type: "button", text: "동작 추가" });
    const actRow = a => {
      let kind = a.prompt !== undefined && a.command === undefined ? "prompt" : "command";
      const label = input({ value: a.label || "", maxlength: "20", placeholder: "버튼 이름", "aria-label": "동작 이름" });
      const text = el("textarea", { id: `f${++fieldSeq}`, class: "fi", rows: "2", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "동작 내용" });
      text.value = kind === "prompt" ? a.prompt || "" : a.command || "";
      const paintKind = () => { text.placeholder = kind === "prompt" ? `${botName}에게 보낼 요청` : "실행할 명령"; };
      const confirm = el("input", { type: "checkbox", ...(a.confirm ? { checked: true } : {}) });
      const row = el("div", { class: "cu-act" },
        el("div", { class: "cu-act-h" }, label, seg([["command", "명령"], ["prompt", "요청"]], kind, v => { kind = v; paintKind(); })),
        text,
        el("div", { class: "cu-act-f" }, el("label", { class: "cu-chk" }, confirm, "실행 전에 묻기"), el("button", { class: "btn text", type: "button", text: "빼기", onclick: () => { row.remove(); addAct.disabled = false; } })));
      paintKind();
      row._value = () => ({ label: label.value.trim(), [kind]: text.value, ...(confirm.checked ? { confirm: true } : {}) });
      return row;
    };
    for (const a of acts0) actsBox.append(actRow(a));
    addAct.addEventListener("click", () => { if (actsBox.children.length >= ACT_MAX_EDIT) return; const r = actRow({}); actsBox.append(r); r.querySelector(".fi").focus(); addAct.disabled = actsBox.children.length >= ACT_MAX_EDIT; });
    addAct.disabled = acts0.length >= ACT_MAX_EDIT;
    const ferr = el("div", { class: "cu-ferr", role: "alert" });
    const form = el("div", { class: "cu-form" },
      cur ? el("div", { class: "cu-m", text: `파일 · ${cur.file}` }) : null,
      cur && cur.error ? el("div", { class: "cu-ferr", text: `지금 파일에 문제가 있어요: ${cur.error}. 저장하면 이 내용으로 바꿔 써요.` }) : null,
      field("title", title), field("note", note), id ? field("id", id) : null,
      el("div", { class: "tf" }, el("span", { class: "lb", text: FIELD_KO.view }), viewSeg),
      el("div", { class: "tf" }, el("span", { class: "lb", text: "내용 출처" }), srcSeg),
      bodyField, hint, cmdOnly, tmoField, field("link", link),
      el("div", { class: "tf" }, el("span", { class: "lb", text: `${FIELD_KO.actions} · 최대 ${ACT_MAX_EDIT}개, 앞의 2개는 버튼으로` }), actsBox, addAct),
      ferr);
    const value = () => ({
      ...(id && id.value.trim() ? { id: id.value.trim() } : {}),
      title: title.value.trim(), note: note.value.trim(), view,
      ...(src === "command" ? { command: body.value, cwd: cwd.value.trim(), every_minutes: every.value, timeout_seconds: timeout.value } : { text: body.value }),
      link: link.value.trim(),
      actions: [...actsBox.children].map(r => r._value()),
      ...(s.order !== undefined ? { order: s.order } : {}),
    });
    // the message names the field it is about ("title은 …", "actions[1]: …"): that field is marked and focused
    const fail = message => {
      for (const n of form.querySelectorAll("[aria-invalid]")) n.removeAttribute("aria-invalid");
      ferr.textContent = message;
      const key = (/^([a-z_]+)/.exec(message) || [])[1], box = key && form.querySelector(`[data-f="${key}"]`);
      const ctrl = box ? box.querySelector(".fi") : key === "actions" ? actsBox.querySelector(".fi") : null;
      if (ctrl) { ctrl.setAttribute("aria-invalid", "true"); ctrl.focus(); }
    };
    return new Promise(res => {
      let saved = null;
      const d = dialog({ title: cur ? "카드 수정" : "카드 추가", body: form, onclose: () => res(saved), actions: [
        { label: "취소", onclick: c => c() },
        { label: "저장", kind: "pri", onclick: (c, btn) => busy(btn, async () => {
          if (!title.value.trim()) return fail("title은 1~40자여야 해요");
          try {
            saved = cur ? await api(`/api/custom/cards/${enc(cur.id)}`, "PUT", value()) : await api("/api/custom/cards", "POST", value());
          } catch (e) { return fail(e.message || "저장하지 못했어요"); }
          c();
        }) }] });
      d.node.classList.add("wide");
      title.focus();
    });
  }
  // A new card lands in the first free place of the board; the page scrolls to it and its header takes focus so the place is seen.
  function reveal(id) {
    const w = document.querySelector(`.bi[data-id="custom:${CSS.escape(id)}"]`), h = w && w.querySelector(".bhead");
    if (!w) return;
    w.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    if (h) h.focus({ preventScroll: true });
  }
  async function add() {
    const card = await cardForm(null, null);
    if (!card) return;
    if (!DATA) DATA = { cards: [] };
    DATA.cards = [...(DATA.cards || []).filter(x => x.id !== card.id), card];
    hidden.delete(card.id); saveHidden();
    onData();
    toast(`${card.title || card.id} 카드를 추가했어요`);
    setTimeout(() => reveal(card.id), 50);
  }
  async function edit(id) {
    let r;
    try { r = await api(`/api/custom/cards/${enc(id)}`); } catch (e) { toast(e.message, true); return; }
    const card = await cardForm(r.spec || null, { id, file: r.file, error: r.error });
    if (!card) return;
    applyCard(card);
    nodes.delete(id);
    onData();
    toast(`${card.title || id} 카드를 저장했어요`);
  }
  async function remove(id) {
    const c = ((DATA && DATA.cards) || []).find(x => x.id === id), name = (c && c.title) || id;
    if (!await ask("카드 삭제", `${name} 카드와 그 파일(${(c && c.file) || `cards/${id}.json`})을 지워요. 되돌릴 수 없어요.`, "삭제", true)) return;
    try { await api(`/api/custom/cards/${enc(id)}`, "DELETE"); } catch (e) { toast(e.message, true); return; }
    if (DATA) DATA.cards = (DATA.cards || []).filter(x => x.id !== id);
    nodes.delete(id); hidden.delete(id); saveHidden();
    onData();
    toast(`${name} 카드를 지웠어요`);
  }

  /* ---------- project page ---------- */
  // Data: the project from /api/custom (name, path, lanes) plus GET /api/custom/project?key= (reports, receipts, commits,
  // repo state, open tasks, linked routines/schedules/watches/channels). Two columns on a wide screen (status and lanes
  // left, request and results right); one column on a phone, with the sections reordered by CSS `order`.
  let DETAIL = null, detailKey = "", detailAt = 0, detailFlight = null, reqTarget = "main";
  function loadDetail(maxAge) {
    const key = projKey;
    if (!key) return Promise.resolve(null);
    if (DETAIL && detailKey === key && Date.now() - detailAt < maxAge) return Promise.resolve(DETAIL);
    if (!detailFlight) detailFlight = api(`/api/custom/project?key=${enc(key)}`)
      .then(d => { if (projKey === key) { DETAIL = d; detailKey = key; detailAt = Date.now(); if (current === "project") paintProject(); } return d; })
      .catch(() => { if (projKey === key && detailKey !== key) { DETAIL = { missing: true }; detailKey = key; if (current === "project") paintProject(); } return null; })
      .finally(() => { detailFlight = null; });
    return detailFlight;
  }
  const curProject = () => ((DATA && DATA.projects) || []).find(x => x.key === projKey);
  const prefixOf = p => `[프로젝트 ${p.name}${p.path ? ` · ${p.path}` : ""}]`;
  const ts = s => Date.parse(s || "") || 0;
  function when(s) {
    const t = ts(s);
    if (!t) return "";
    const d = new Date(t), n = new Date(), hm = d.toLocaleTimeString("ko-KR", { ...KST, hour: "2-digit", minute: "2-digit", hour12: false });
    const day = x => x.toLocaleDateString("ko-KR", KST);
    if (day(d) === day(n)) return `오늘 ${hm}`;
    if (day(d) === day(new Date(n.getTime() - 86400000))) return `어제 ${hm}`;
    return `${d.toLocaleDateString("ko-KR", { ...KST, month: "long", day: "numeric" })} ${hm}`;
  }
  function ago(s) {
    const m = Math.round((Date.now() - ts(s)) / 60000);
    if (!ts(s)) return "기록 없음";
    if (m < 1) return "방금";
    if (m < 60) return `${m}분 전`;
    if (m < 24 * 60) return `${Math.floor(m / 60)}시간 전`;
    return `${Math.floor(m / 1440)}일 전`;
  }
  // A folder as the rest of the app shows it (shortPath + pathCopy in 15-attachments.js): a short line, the full path in the title, a tap copies it.
  const pathNode = path => pathCopy(path, "pv-path");
  const sec = (label, extra) => el("div", { class: "pv-sh" }, el("div", { class: "sec", text: label }), extra || null);
  const emptyCard = t => el("div", { class: "card empty", text: t });

  async function sendReq(text, target) {
    const p = curProject();
    if (!p || !text) return false;
    if (target.startsWith("lane:")) {
      await api("/api/message", "POST", { lane: target.slice(5), text });
      toast(`${target.slice(5)} 레인에 보냈어요`);
    } else {
      await api("/api/message", "POST", { text: target === "new" ? `${prefixOf(p)} 새 레인을 열어서 맡겨 주세요: ${text}` : `${prefixOf(p)} ${text}` });
      toast(`${botName}에게 보냈어요`);
    }
    return true;
  }

  // One overview card (where, how it stands), the request box beside it, then lanes on the left and one day-grouped
  // timeline on the right. Each fact shows once: a lane's report line sits on its row, an unmerged lane branch as a tag
  // on that lane, commits only in the timeline.
  function overviewNode(p, D) {
    const s = (D && D.summary) || {}, g = D && D.repo, tasks = (D && D.tasks) || [];
    const own = new Set(((D && D.lanes) || []).map(l => `lane/${l.name}`));
    const loose = g ? g.unmerged.filter(u => !own.has(u.branch)) : [];
    const fact = t => el("span", { text: t });
    const facts = el("div", { class: "pv-facts" }, ...[p.path ? pathNode(p.path) : null,
      g ? fact(`${g.branch} 브랜치`) : null, g ? fact(g.dirty ? `커밋 안 한 파일 ${g.dirty}개` : "커밋 안 한 파일 없음") : null,
      loose.length ? el("span", { text: `${g.base}에 안 들어간 브랜치 ${loose.length}개`, title: loose.map(u => `${u.branch} (커밋 ${u.ahead}개)`).join("\n") }) : null,
      p.channel ? fact(`#${p.channel.name}`) : null].filter(Boolean));
    const tile = (v, label, tone) => el("div", { class: "pv-tile" }, el("div", { class: "pv-tv" }, tone ? el("span", { class: `dot ${tone}` }) : null, el("span", { text: String(v) })), el("div", { class: "cu-m", text: label }));
    // The newest report, else the newest result: what happened last, in one line.
    const rs = (D && D.results) || [], last = rs.find(r => r.kind === "report") || rs[0];
    const lastRow = last ? el("div", { class: "pv-last" }, el("span", { class: "cu-m", text: last.kind === "report" ? `${last.lane} 마지막 보고` : `마지막 ${KIND[last.kind] || ""}` }), el("span", { class: "pv-lx", text: last.title || "" }), el("span", { class: "cu-m", text: when(last.at) })) : null;
    return el("div", { class: "card pv-ov" }, p.note ? el("div", { class: "pv-desc", text: p.note }) : null, facts, el("div", { class: "pv-stats" },
      tile(s.running ?? 0, "작업 중인 레인", s.running ? "pri" : ""),
      tile(s.waiting ?? 0, "답을 기다리는 레인", s.waiting ? "att" : ""),
      tile(D ? tasks.length : "…", "열린 할 일"),
      tile(s.lastActivity ? ago(s.lastActivity) : D ? "기록 없음" : "…", "마지막 활동")), lastRow);
  }

  function laneNode(l) {
    const tone = l.live ? statusTone(l.status) : l.waiting ? "att" : l.tone === "fail" ? "warn" : "";
    const state = [l.waiting ? "답을 기다려요" : l.live ? statusKo(l.status) : "끝남", l.finishedAt ? when(l.finishedAt) : ""].filter(Boolean).join(" · ");
    const acts = el("div", { class: "pv-acts" });
    const stop = ev => ev.stopPropagation();
    if (l.resumable) {
      const b = el("button", { class: "btn tonal", type: "button", text: "이어서 진행" });
      b.addEventListener("click", ev => { stop(ev); busy(b, async () => { await api(`/api/lanes/${enc(l.name)}/resume`, "POST", {}); toast(`${l.name} 레인을 이어서 진행해요`); loadDetail(0); }); });
      acts.append(b);
    }
    if (!l.live) {
      const b = el("button", { class: "btn tonal", type: "button", text: "정리" });
      b.addEventListener("click", ev => { stop(ev); busy(b, async () => {
        if (!await ask(`${l.name} 정리`, "휴지통으로 옮겨요. 7일 안에는 되돌릴 수 있어요.", "정리")) return;
        const r = await api("/api/lanes/delete", "POST", { names: [l.name] }).catch(e => { if (e.data && e.data.results) return e.data; throw e; });
        const res = (r.results || [])[0] || {};
        if (res.ok) { toast(`${l.name} 레인을 정리했어요`); load(0); loadDetail(0); }
        else toast(typeof keptWhy === "function" ? keptWhy(res.error || "") : "지금은 정리하지 못했어요");
      }); });
      acts.append(b);
    }
    const row = el("div", { class: "pv-lane", role: "button", tabindex: "0", title: l.line ? `${l.line}\n\n누르면 ${l.name} 채팅이 열려요` : `${l.name} 채팅 열기` },
      el("div", { class: "pv-lt" }, el("span", { class: `dot ${tone}` }), el("span", { class: "pv-ln", text: l.name }), el("span", { class: "cu-m", text: state }),
        l.claim === "verified" ? el("span", { class: "tag ok", text: "확인됨" }) : l.claim === "reported" ? el("span", { class: "tag", text: "보고만 함" }) : null,
        l.unmerged ? el("span", { class: "tag", text: `안 합침 ${l.unmerged}`, title: `lane/${l.name} 브랜치에 main에 없는 커밋이 ${l.unmerged}개 있어요` }) : null),
      acts, el("div", { class: `pv-line${l.line ? "" : " none"}`, text: l.line || "아직 보고가 없어요" }));
    const open = () => openTarget(`lane:${l.name}`, lastChatView());
    row.addEventListener("click", open);
    row.addEventListener("keydown", ev => { if (ev.target === row && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(); } });
    return row;
  }

  const KIND = { report: "보고", verify: "확인", commit: "커밋" };
  const hm = s => new Date(ts(s)).toLocaleTimeString("ko-KR", { ...KST, hour: "2-digit", minute: "2-digit", hour12: false });
  function dayOf(s) {
    const w = when(s);
    return w.startsWith("오늘") ? "오늘" : w.startsWith("어제") ? "어제" : w.replace(/ \d\d:\d\d$/, "");
  }
  function resultNode(r) {
    const report = r.kind === "report", tap = report && r.lane;
    const right = el("span", { class: "pv-rr" },
      report ? el("span", { class: `tag${r.verified ? " ok" : ""}`, text: r.tone === "fail" ? "안 됨" : r.verified ? "확인됨" : "보고만 함" }) : null,
      r.kind === "verify" ? el("span", { class: `tag${r.ok ? " ok" : ""}`, text: r.ok ? "통과" : "안 됨" }) : null,
      el("span", { text: hm(r.at) }));
    const title = r.kind === "commit" ? el("span", { class: "pv-rt" }, el("span", { class: "pv-h", text: r.hash }), r.title)
      : el("span", { class: `pv-rt${r.kind === "verify" ? " mono" : ""}`, text: r.title || "", title: r.title || "" });
    const node = el(tap ? "button" : "div", { class: `pv-res ${r.kind}`, type: tap ? "button" : null },
      el("span", { class: "pv-kind", text: KIND[r.kind] || r.kind }), title, right,
      r.lane ? el("span", { class: "pv-rsub", text: `${r.lane} 레인` }) : null);
    if (tap) node.addEventListener("click", () => openTarget(`lane:${r.lane}`, lastChatView()));
    return node;
  }
  function resultsNode(results) {
    const kids = [];
    let day = "";
    for (const r of results) {
      const d = dayOf(r.at);
      if (d !== day) { day = d; kids.push(el("div", { class: "pv-day", text: d })); }
      kids.push(resultNode(r));
    }
    return el("div", { class: "list" }, ...kids);
  }

  function taskNode(t) {
    const b = el("button", { class: "pv-task", type: "button", title: `${t.next ? `다음: ${t.next}\n\n` : ""}누르면 ${botName}에게 요청으로 보내요` },
      el("span", { class: "pv-ring" }), el("span", { class: "pv-tw", text: t.what || t.id }));
    b.addEventListener("click", () => busy(b, async () => {
      if (!await ask("할 일 보내기", `${botName}에게 이어서 진행하도록 요청해요: ${t.what}`, "보내기")) return;
      await sendReq(`할 일 ${t.id}: ${t.what} - 이어서 해 주세요.`, "main");
    }));
    return b;
  }

  function linkChips(L) {
    const chip = (ic, text, title, btn) => el("span", { class: "pv-link", title: title || text }, icon(ic), el("span", { class: "tx", text }), btn || null);
    const out = [];
    if (L.channel) out.push(chip("discord", `#${L.channel.name}`, `작업 채널${L.threads.length ? ` · 스레드 ${L.threads.length}개: ${L.threads.map(t => t.name).join(", ")}` : ""}`));
    for (const c of L.laneChannels || []) out.push(chip("discord", `${c.lane} 레인 채널`));
    for (const r of L.routines || []) {
      const b = el("button", { type: "button", "aria-label": `${r.name} 지금 실행`, title: "지금 실행" }, icon("send"));
      b.addEventListener("click", () => busy(b, async () => { await api("/api/custom/routine", "POST", { id: r.id }); toast("루틴을 보냈어요"); }));
      out.push(chip("spark", r.name, `루틴${SCHED(r) ? ` · ${SCHED(r)}` : ""}`, b));
    }
    for (const s of L.schedules || []) out.push(chip("bell", s.text, `일정 · ${when(s.at)}${s.every_minutes ? ` · ${s.every_minutes}분마다` : ""}`));
    for (const w of L.watches || []) out.push(chip("activity", w.name, `모니터링 · ${w.every_minutes}분마다${w.paused ? " · 쉬는 중" : ""}`));
    return out;
  }
  function moreNode(D) {
    if (!D) return emptyCard("불러오는 중…");
    const tasks = D.tasks || [], links = D.linked ? linkChips(D.linked) : [];
    return el("div", { class: "list pv-box2" },
      el("div", { class: "pv-sub", text: tasks.length ? `열린 할 일 ${tasks.length} · 누르면 요청으로 보내요` : "열린 할 일 없음" }), ...tasks.map(taskNode),
      el("div", { class: "pv-sub", text: links.length ? "연결된 채널 · 루틴 · 일정" : "연결된 채널 · 루틴 · 일정 없음" }), links.length ? el("div", { class: "pv-links" }, ...links) : null);
  }

  function requestNode(p, D) {
    const live = ((D && D.lanes) || p.lanes || []).filter(l => l.live).map(l => l.name);
    if (reqTarget.startsWith("lane:") && !live.includes(reqTarget.slice(5))) reqTarget = "main";
    const ta = el("textarea", { class: "pv-ta", rows: 1, placeholder: "이 프로젝트에 맡길 일을 적어 주세요", "aria-label": "요청" });
    const send = el("button", { class: "ib pv-send", type: "button", "aria-label": "보내기", title: "보내기", disabled: true }, icon("send"));
    const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`; send.disabled = !ta.value.trim(); };
    ta.addEventListener("input", grow);
    const fire = () => busy(send, async () => { if (await sendReq(ta.value.trim(), reqTarget)) { ta.value = ""; grow(); } });
    send.addEventListener("click", fire);
    ta.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !matchMedia("(pointer: coarse)").matches) { ev.preventDefault(); if (ta.value.trim()) fire(); } });
    // Who takes the request, in words: the assistant decides where it goes, a lane adds it to what it is doing, or a new lane.
    const targets = [["main", botName, "알맞은 곳을 골라 맡겨요"], ...live.map(n => [`lane:${n}`, `${n} 레인`, `${n} 레인이 하던 일에 이어서 넣어요`]), ["new", "새 레인으로", "새 레인을 열어 따로 진행해요"]];
    const chips = el("div", { class: "pv-chips", role: "radiogroup", "aria-label": "맡길 곳" });
    const hint = el("div", { class: "pv-hint" });
    const paintChips = () => { clear(chips).append(el("span", { class: "cu-m", text: "맡길 곳" }), ...targets.map(([v, label]) => {
      const c = el("button", { class: `chip${reqTarget === v ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(reqTarget === v) }, el("span", { class: "tx", text: label }));
      c.addEventListener("click", () => { reqTarget = v; paintChips(); ta.focus(); });
      return c;
    })); hint.textContent = (targets.find(t => t[0] === reqTarget) || targets[0])[2]; };
    paintChips();
    const quick = ["지금 상태 알려줘", "남은 할 일 정리해줘", "잘 되는지 확인해줘", "끝난 작업 합쳐줘"];
    const qs = el("div", { class: "pv-quick" }, ...quick.map(q => el("button", { class: "pv-q", type: "button", text: q, onclick: () => { ta.value = q; grow(); ta.focus(); } })));
    return el("div", { class: "card pv-req" }, chips, hint, el("div", { class: "pv-box" }, ta, send), qs);
  }

  function paintProject() {
    const root = $("#v-project");
    if (!root || current !== "project" || typeof pmPaint === "function") return;
    root.classList.add("pv");
    const p = curProject();
    $("#title").textContent = p ? p.name : "프로젝트";
    const D = DETAIL && detailKey === projKey ? DETAIL : null;
    if (!p) {
      root.dataset.sig = "";
      clear(root).append(emptyCard(DATA ? "프로젝트를 찾지 못했어요" : "불러오는 중…"));
      return;
    }
    if (same(root, JSON.stringify([p, D, reqTarget, botName]))) return;
    // Keep what the owner was typing across a refresh.
    const old = $(".pv-ta", root), draft = old ? old.value : "", focused = old && document.activeElement === old;
    const ls = D && D.lanes ? D.lanes : (p.lanes || []).map(l => ({ ...l, line: "" }));
    const sorted = ls.slice().sort((a, b) => (b.live - a.live) || (b.waiting - a.waiting) || ts(b.finishedAt || b.startedAt) - ts(a.finishedAt || a.startedAt));
    const results = D && D.results ? D.results : null;
    clear(root).append(
      el("div", { class: "pv-top" }, overviewNode(p, D), requestNode(p, D)),
      el("div", { class: "pv-cols" },
        el("div", { class: "pv-col" },
          sec(`레인 ${ls.length}`), ls.length ? el("div", { class: "list" }, ...sorted.map(laneNode)) : emptyCard("아직 레인이 없어요"),
          sec("할 일과 연결"), moreNode(D)),
        el("div", { class: "pv-col" },
          sec("최근 결과", el("span", { class: "cu-m", text: "보고 · 확인 · 커밋" })),
          !results ? emptyCard("불러오는 중…") : results.length ? resultsNode(results) : emptyCard("아직 결과가 없어요"))));
    const ta = $(".pv-ta", root);
    if (draft) { ta.value = draft; ta.dispatchEvent(new Event("input")); }
    if (focused) ta.focus();
  }

  /* ---------- hooks called from index.html ---------- */
  function home() {
    load(10000);
  }
  function view(name, tgt) {
    if (name !== "project") return;
    projKey = tgt || "";
    if (detailKey !== projKey) DETAIL = null;
    load(5000);
    if (typeof pmPaint !== "function") { paintProject(); loadDetail(5000); }
  }
  function pins() {
    return load(55000);
  }
  window.dotzCustom = { home, view, pins, items: homeItems, keep: keepPlace, menuActs, unhide, add, edit, remove, fmt: localTime, show, split: splitActions };

  // The main script may already have rendered the first view: catch up, then keep the sidebar and open pages fresh.
  pins();
  if (current === "home") home();
  else if (current === "project") view("project", parseHash().t);
  setInterval(() => {
    if (document.hidden) return;
    if (current === "home" || current === "project") load(25000); else pins();
    if (current === "project" && typeof pmPaint !== "function") loadDetail(25000);
  }, 30000);
  setInterval(() => { if (!document.hidden && current !== "home" && current !== "project") pins(); }, 60000);
})();
