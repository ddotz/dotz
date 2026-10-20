/* dotz custom layer (web side): custom cards on 홈, pinned projects / routines / links, the project page.
   Classic script loaded after index.html's main script; it uses that script's globals (el, $, api, icon, go, toast, busy,
   openTarget, lastChatView, statusKo, statusTone, current, parseHash, clear, enc). Data: GET /api/custom. */
(() => {
  "use strict";

  const CSS = `
.pins { display: flex; flex-direction: column; flex: 0 1 auto; gap: 2px; min-height: 0; margin-top: 12px; overflow-y: auto; }
.pins:empty { display: none; }
.cu-gl { margin: 12px 8px 4px; color: var(--fg-3); font-size: 12px; line-height: 16px; font-weight: 600; }
.pins .cu-gl:first-child { margin-top: 0; }
.pins .ni > .dot, .pins .ni > .ib { margin-left: auto; }
.pins .ni > .ib { width: 24px; height: 24px; }
.pins a.ni { text-decoration: none; }
.pins .ni.on .ib:hover { background: var(--hover); }
.cu-home .grid { align-items: start; }
.cu-pinhome { display: none; }
.cu-r { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 10px 16px; border: 0; border-radius: 0; background: var(--card); color: var(--fg); font: 500 15px/22px var(--font); text-align: left; text-decoration: none; }
button.cu-r, a.cu-r { cursor: pointer; }
button.cu-r:hover, a.cu-r:hover { background: var(--card-hover); }
.cu-r svg.ic { color: var(--fg-3); }
.cu-rn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cu-r > .dot { margin-left: auto; }
.cu-r > .ib { margin-left: auto; }
.cu-card.tap { cursor: pointer; }
.cu-th { display: flex; align-items: baseline; gap: 8px; }
.cu-t { flex: 1; min-width: 0; margin: 0; font: 600 16px/22px var(--font); letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cu-m { color: var(--fg-3); font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
.cu-th > .cu-m { flex: none; }
.cu-th > .cu-err { flex: none; color: var(--err); font-size: 12px; line-height: 16px; font-weight: 600; }
.cu-card > .cu-m { margin-top: 2px; }
.cu-body { margin-top: 12px; }
.cu-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.cu-body:empty { display: none; }
.cu-text { font-size: 14px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }
.cu-big { font: 700 20px/28px var(--font); letter-spacing: -.01em; overflow-wrap: anywhere; }
.cu-li { display: flex; flex-direction: column; min-width: 0; padding: 6px 0; color: var(--fg); font-size: 14px; line-height: 22px; text-decoration: none; }
a.cu-li:hover .cu-lt { color: var(--accent); }
.cu-li + .cu-li { border-top: 1px solid var(--line); }
.cu-lt { overflow-wrap: anywhere; }
.cu-kv { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 14px; line-height: 22px; }
.cu-kv > :first-child { min-width: 0; overflow-wrap: anywhere; }
.cu-kv > :last-child { flex: none; max-width: 60%; color: var(--fg-2); text-align: right; overflow-wrap: anywhere; }
.cu-acts .btn:disabled, .pv-acts .btn:disabled { opacity: .4; cursor: default; }
.pins .pv-cnt { margin-left: auto; }
.pv-cnt { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 12px; line-height: 16px; font-weight: 600; }
.pv-ptiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.pv-ptile { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; padding: 14px 16px; border: 0; border-radius: var(--r-card); background: var(--card); color: var(--fg); text-align: left; cursor: pointer; }
.pv-ptile:hover { background: var(--card-hover); }
.pv-ptn { max-width: 100%; font: 600 16px/22px var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-pts { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--fg-2); font-size: 13px; line-height: 18px; }
.pv-path { max-width: 100%; color: var(--fg-3); font: 12px/16px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#v-project.pv { max-width: 1180px; }
.pv-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin: 0 4px 16px; }
.pv-cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 24px; align-items: start; }
.pv-col { display: flex; flex-direction: column; min-width: 0; }
.pv-sh { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.pv-sh .sec { margin: 28px 4px 10px; }
.pv-sh > .cu-m { margin-right: 4px; }
.pv-sum { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 18px 20px; }
.pv-tile + .pv-tile { padding-left: 12px; border-left: 1px solid var(--line); }
.pv-tv { display: flex; align-items: center; gap: 8px; font: 700 20px/28px var(--font); letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pv-lane { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; cursor: pointer; }
.pv-lane:hover { background: var(--card-hover); }
.pv-lane:focus-visible, .pv-res:focus-visible, .pv-task:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.pv-lane + .pv-lane, .pv-res + .pv-res, .pv-task + .pv-task { border-top: 1px solid var(--line); }
.pv-lt { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 28px; }
.pv-ln { min-width: 0; font: 600 15px/22px var(--font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-acts { display: flex; gap: 6px; margin-left: auto; }
.pv-acts .btn { height: 28px; padding: 0 10px; font-size: 13px; }
.pv-line { color: var(--fg-2); font-size: 14px; line-height: 21px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.pv-line.none { color: var(--fg-3); }
.pv-res { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 14px 16px; border: 0; border-radius: 0; background: transparent; color: var(--fg); text-align: left; font: inherit; }
button.pv-res { cursor: pointer; }
button.pv-res:hover { background: var(--card-hover); }
.pv-rh { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pv-kind { flex: none; height: 20px; padding: 0 8px; border-radius: 10px; background: var(--layer); color: var(--fg-2); font-size: 11px; line-height: 20px; font-weight: 600; }
.pv-rm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-rt { font: 500 14px/21px var(--font); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pv-rt.mono, .pv-cs.mono { font: 12px/18px var(--mono); color: var(--fg-2); }
.pv-rt.mono { -webkit-line-clamp: 2; }
.pv-rb { color: var(--fg-3); font-size: 13px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pv-repo { padding: 16px 20px; }
.pv-sub { margin: 14px 0 6px; color: var(--fg-2); font: 600 13px/18px var(--font); }
.pv-cm { display: flex; align-items: baseline; gap: 10px; min-width: 0; padding: 4px 0; font-size: 13px; line-height: 20px; }
.pv-h { flex: none; color: var(--fg-3); font: 12px/20px var(--mono); }
.pv-cs { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-cm > .cu-m { flex: none; }
.pv-task { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 12px 16px; border: 0; border-radius: 0; background: transparent; color: var(--fg); text-align: left; font: inherit; cursor: pointer; }
.pv-task:hover { background: var(--card-hover); }
.pv-ring { flex: none; width: 18px; height: 18px; margin-top: 2px; border: 1.5px solid var(--line-2); border-radius: 50%; }
.pv-task:hover .pv-ring { border-color: var(--accent); }
.pv-tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pv-tw { font-size: 14px; line-height: 21px; overflow-wrap: anywhere; }
.pv-tx .cu-m { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pv-rs { display: block; }
.cu-rn > .pv-rs { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; }
.pv-req { padding: 16px; }
.pv-to { margin-bottom: 6px; }
.pv-chips { display: flex; flex-wrap: wrap; gap: 6px; }
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
@media (pointer: coarse) { .pv-ta { font-size: 16px; line-height: 22px; } .pv-acts .btn { height: 36px; } .pv-q { height: 34px; line-height: 32px; } }
@media (min-width: 1100px) { .pv-cols { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); } .pv-col > .pv-s:first-child .pv-sh .sec { margin-top: 0; } }
@media (max-width: 1099px) {
  .pv-cols { display: flex; flex-direction: column; align-items: stretch; }
  .pv-col { display: contents; }
  .o-sum { order: 1; } .o-req { order: 2; } .o-lanes { order: 3; } .o-res { order: 4; } .o-repo { order: 5; } .o-tasks { order: 6; } .o-linked { order: 7; }
}
@media (max-width: 639px) { .pv-sum { padding: 14px 16px; gap: 8px; } .pv-tv { font-size: 17px; line-height: 24px; } .pv-tile + .pv-tile { padding-left: 8px; } }
@media (max-width: 639px) {
  .pins { display: none; }
  .cu-pinhome { display: block; }
}`;
  document.head.append(el("style", { text: CSS }));

  let DATA = null, loadedAt = 0, flight = null, projKey = "";
  const str = v => v == null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  const isHttp = u => typeof u === "string" && /^https?:\/\//i.test(u);
  const openLink = l => { if (isHttp(l)) window.open(l, "_blank", "noopener,noreferrer"); else if (typeof l === "string" && l[0] === "#") location.hash = l; };
  const same = (box, sig) => { if (box.dataset.sig === sig) return true; box.dataset.sig = sig; return false; };

  /* ---------- data ---------- */
  function load(maxAge) {
    if (DATA && Date.now() - loadedAt < maxAge) return Promise.resolve(DATA);
    if (!flight) flight = api("/api/custom").then(d => { DATA = d; loadedAt = Date.now(); onData(); return d; }).catch(() => DATA).finally(() => { flight = null; });
    return flight;
  }
  function onData() {
    paintPins();
    if (current === "home") paintHome();
    if (current === "project") paintProject();
  }

  /* ---------- cards ---------- */
  const errorCard = c => el("div", { class: "card cu-card" },
    el("div", { class: "cu-th" }, el("h3", { class: "cu-t", text: c.id || c.file || "카드" }), el("span", { class: "cu-err", text: "오류" })),
    el("div", { class: "cu-m", text: str(c.error) || "카드를 그리지 못했어요" }));

  function viewBody(c) {
    const d = c.data, v = c.view || "text";
    if (d === undefined || d === null) return el("div", { class: "cu-m", text: "값 없음" });
    if (v === "stat") {
      const o = typeof d === "object" && !Array.isArray(d) ? d : { value: d };
      return el("div", null, el("div", { class: "cu-big", text: str(o.value) }),
        o.label != null ? el("div", { class: "cu-m", text: str(o.label) }) : null,
        o.sub != null ? el("div", { class: "cu-m", text: str(o.sub) }) : null);
    }
    if (v === "list") {
      const items = (Array.isArray(d) ? d : []).slice(0, 50);
      if (!items.length) return el("div", { class: "cu-m", text: "비어 있어요" });
      return el("div", null, ...items.map(it => {
        const o = it && typeof it === "object" ? it : { title: it };
        const kids = [el("span", { class: "cu-lt", text: str(o.title) }), o.sub != null ? el("span", { class: "cu-m", text: str(o.sub) }) : null];
        return isHttp(o.url)
          ? el("a", { class: "cu-li", href: o.url, target: "_blank", rel: "noopener noreferrer", onclick: ev => ev.stopPropagation() }, ...kids)
          : el("div", { class: "cu-li" }, ...kids);
      }));
    }
    if (v === "kv") {
      const pairs = Array.isArray(d) ? d.filter(Array.isArray).map(p => [p[0], p[1]]) : d && typeof d === "object" ? Object.entries(d) : [];
      if (!pairs.length) return el("div", { class: "cu-m", text: "비어 있어요" });
      return el("div", null, ...pairs.map(([k, val]) => el("div", { class: "cu-kv" }, el("span", { text: str(k) }), el("span", { text: str(val) }))));
    }
    return el("div", { class: "cu-text", text: typeof d === "object" && !Array.isArray(d) && "text" in d ? str(d.text) : str(d) });
  }

  const firstLine = s => (String(s || "").split("\n").map(x => x.trim()).find(Boolean) || "").slice(0, 80);
  function actionButton(c, i, a, card) {
    const b = el("button", { class: "btn tonal", type: "button", text: a.label });
    b.addEventListener("click", ev => {
      ev.stopPropagation();
      busy(b, async () => {
        if (a.confirm && !await ask(a.label, "실행할까요?", "실행", true)) return;
        const r = await api("/api/custom/action", "POST", { id: c.id, index: i });
        if (a.kind === "prompt") { toast(`${botName}에게 보냈어요`); return; }
        const line = firstLine(r.output);
        toast(r.ok ? line || "끝냈어요" : `실패했어요${line ? ` · ${line}` : ""}`, !r.ok);
        if (r.card) {
          if (DATA) DATA.cards = (DATA.cards || []).map(x => x.id === c.id ? r.card : x);
          if (card.isConnected) card.replaceWith(cardNode(r.card));
        }
      });
    });
    return b;
  }

  function cardNode(c) {
    try {
      if (c.error && c.data === undefined) return errorCard(c);
      const tap = !!c.link;
      const body = el("div", { class: "cu-body" });
      const card = el("div", { class: `card cu-card${tap ? " tap" : ""}`, "data-card": c.id },
        el("div", { class: "cu-th" }, el("h3", { class: "cu-t", text: c.title || c.id }), c.stale ? el("span", { class: "cu-m", text: "오래된 값" }) : null),
        c.note ? el("div", { class: "cu-m", text: c.note }) : null, body);
      if (tap) {
        card.setAttribute("role", "button"); card.tabIndex = 0;
        card.addEventListener("click", () => openLink(c.link));
        card.addEventListener("keydown", ev => { if (ev.target === card && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); openLink(c.link); } });
      }
      const acts = (c.actions || []).slice(0, 4);
      if (acts.length) card.append(el("div", { class: "cu-acts" }, ...acts.map((a, i) => actionButton(c, i, a, card))));
      if (c.render) {
        import(`/api/custom/render?id=${enc(c.id)}&v=${enc(c.rev || "")}`)
          .then(m => m.default(c.data, { el, card: c }))
          .then(out => { if (out && out.nodeType) body.append(out); else if (out != null) body.append(el("div", { class: "cu-text", text: str(out) })); })
          .catch(e => card.replaceWith(errorCard({ id: c.id, error: e && e.message ? e.message : "render.js 오류" })));
      } else body.append(viewBody(c));
      return card;
    } catch (e) {
      return errorCard({ id: c && c.id, error: e && e.message });
    }
  }

  /* ---------- pinned rows (sidebar on desktop, 바로가기 on 홈 on phone) ---------- */
  const SCHED = r => !r.schedule ? "" : r.schedule.at ? `매일 ${r.schedule.at}` : r.schedule.every_minutes ? `${r.schedule.every_minutes}분마다` : "";
  function groups(v) {
    const D = DATA || {}, side = v === "side", base = side ? "ni" : "cu-r", nm = side ? "nl" : "cu-rn", out = [];
    const sub = t => !side && t ? el("span", { class: "cu-m", text: t }) : null;
    const projects = (D.projects || []).map(p => {
      const on = side && current === "project" && projKey === p.key, ls = p.lanes || [];
      const running = ls.filter(l => l.live).length, waiting = ls.filter(l => l.waiting).length;
      if (!side) {
        // Phone 바로가기: one tile per project with what is going on there.
        const state = waiting ? `답을 기다리는 레인 ${waiting}` : running ? `도는 레인 ${running}` : ls.length ? `레인 ${ls.length}개 · 쉬는 중` : "레인 없음";
        return el("button", { class: "pv-ptile", type: "button", onclick: () => go("project", p.key) },
          el("span", { class: "pv-ptn", text: p.name }), p.path ? el("span", { class: "pv-path", text: p.path }) : null,
          el("span", { class: "pv-pts" }, el("span", { class: `dot ${waiting ? "att" : running ? "pri" : ""}` }), el("span", { text: state })));
      }
      const badge = waiting ? el("span", { class: "dot att", title: `답을 기다리는 레인 ${waiting}` }) : running ? el("span", { class: "pv-cnt", title: `도는 레인 ${running}`, text: String(running) }) : null;
      return el("button", { class: `${base}${on ? " on" : ""}`, type: "button", title: p.path || p.name, onclick: () => go("project", p.key) },
        icon("lanes"), el("span", { class: nm, text: p.name }), badge);
    });
    const routines = (D.routines || []).map(r => {
      const b = el("button", { class: "ib", type: "button", "aria-label": `${r.name} 실행`, title: "지금 실행" }, icon("send"));
      b.addEventListener("click", () => busy(b, async () => { await api("/api/custom/routine", "POST", { id: r.id }); toast("루틴을 보냈어요"); }));
      return el("div", { class: base, title: SCHED(r) || r.name }, icon("spark"), el("span", { class: nm, text: r.name }), sub(SCHED(r)), b);
    });
    const links = (D.links || []).filter(l => isHttp(l.url)).map(l =>
      el("a", { class: base, href: l.url, target: "_blank", rel: "noopener noreferrer", title: l.url }, icon("open"), el("span", { class: nm, text: l.name })));
    if (projects.length) out.push(["프로젝트", projects]);
    if (routines.length) out.push(["루틴", routines]);
    if (links.length) out.push(["링크", links]);
    return out;
  }
  function paintPins() {
    const box = $("#pins");
    if (!box) return;
    const g = groups("side");
    if (same(box, JSON.stringify([DATA && [DATA.projects, DATA.routines, DATA.links], current === "project" ? projKey : ""]))) return;
    clear(box);
    for (const [label, rows] of g) box.append(el("div", { class: "cu-gl", text: label }), ...rows);
  }

  /* ---------- 홈 ---------- */
  function paintHome() {
    const box = $("#home-custom");
    if (!box || !DATA) return;
    const cards = (DATA.cards || []).slice(), g = groups("home");
    if (same(box, JSON.stringify([cards, DATA.projects, DATA.routines, DATA.links]))) return;
    clear(box);
    if (!cards.length && !g.length) return;
    box.classList.add("cu-home");
    if (g.length) box.append(el("div", { class: "cu-pinhome" },
      // The phone has no sidebar: its pinned projects, routines and links show here as shortcuts.
      el("div", { class: "sec", text: "바로가기" }),
      ...g.flatMap(([label, rows]) => [el("div", { class: "cu-gl", text: label }), el("div", { class: label === "프로젝트" ? "pv-ptiles" : "list" }, ...rows)])));
    if (cards.length) box.append(el("div", { class: "sec", text: "내 카드" }), el("div", { class: "grid" }, ...cards.map(cardNode)));
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

  function summaryNode(D) {
    const s = (D && D.summary) || {};
    const tile = (v, label, tone) => el("div", { class: "pv-tile" }, el("div", { class: "pv-tv" }, tone ? el("span", { class: `dot ${tone}` }) : null, el("span", { text: String(v) })), el("div", { class: "cu-m", text: label }));
    return el("div", { class: "card pv-sum" },
      tile(s.running ?? 0, "돌고 있는 레인", s.running ? "pri" : ""),
      tile(s.waiting ?? 0, "답을 기다리는 레인", s.waiting ? "att" : ""),
      tile(s.lastActivity ? ago(s.lastActivity) : "기록 없음", "마지막 활동"));
  }

  function laneNode(l) {
    const tone = l.live ? statusTone(l.status) : l.waiting ? "att" : l.tone === "fail" ? "warn" : "";
    const state = l.waiting ? "답을 기다려요" : l.live ? statusKo(l.status) : "끝남";
    const acts = el("div", { class: "pv-acts" });
    const stop = ev => ev.stopPropagation();
    if (l.resumable) {
      const b = el("button", { class: "btn tonal", type: "button", text: "이어서 하기" });
      b.addEventListener("click", ev => { stop(ev); busy(b, async () => { await api(`/api/lanes/${enc(l.name)}/resume`, "POST", {}); toast(`${l.name} 레인을 이어서 해요`); loadDetail(0); }); });
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
    const meta = l.finishedAt ? `${when(l.finishedAt)} ${l.live ? "마지막 보고" : "끝남"}` : "";
    const row = el("div", { class: "pv-lane", role: "button", tabindex: "0", title: `${l.name} 채팅 열기` },
      el("div", { class: "pv-lt" }, el("span", { class: `dot ${tone}` }), el("span", { class: "pv-ln", text: l.name }), el("span", { class: "cu-m", text: state }),
        l.claim === "verified" ? el("span", { class: "tag ok", text: "확인됨" }) : l.claim === "reported" ? el("span", { class: "tag", text: "보고만 함" }) : null, acts),
      l.line ? el("div", { class: "pv-line", text: l.line }) : el("div", { class: "pv-line none", text: "아직 보고가 없어요" }),
      meta ? el("div", { class: "cu-m", text: meta }) : null);
    const open = () => openTarget(`lane:${l.name}`, lastChatView());
    row.addEventListener("click", open);
    row.addEventListener("keydown", ev => { if (ev.target === row && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(); } });
    return row;
  }

  const KIND = { report: "보고", verify: "확인", commit: "커밋" };
  function resultNode(r) {
    const tags = [];
    if (r.kind === "report") tags.push(r.verified ? el("span", { class: "tag ok", text: "확인됨" }) : el("span", { class: "tag", text: "보고만 함" }));
    if (r.kind === "verify") tags.push(el("span", { class: `tag${r.ok ? " ok" : ""}`, text: r.ok ? "통과" : "안 됨" }));
    const meta = [when(r.at), r.lane || "", r.hash || ""].filter(Boolean).join(" · ");
    const tone = r.kind === "report" ? (r.tone === "fail" ? "안 됨 · " : "") : "";
    const node = el(r.lane && r.kind === "report" ? "button" : "div", { class: `pv-res ${r.kind}`, type: r.lane && r.kind === "report" ? "button" : null },
      el("div", { class: "pv-rh" }, el("span", { class: "pv-kind", text: KIND[r.kind] || r.kind }), el("span", { class: "cu-m pv-rm", text: tone + meta }), ...tags),
      el("div", { class: `pv-rt${r.kind === "verify" ? " mono" : ""}`, text: r.title || "" }),
      r.text ? el("div", { class: "pv-rb", text: r.text }) : null);
    if (node.tagName === "BUTTON") node.addEventListener("click", () => openTarget(`lane:${r.lane}`, lastChatView()));
    return node;
  }

  function repoNode(g) {
    const kv = (k, v) => el("div", { class: "cu-kv" }, el("span", { text: k }), el("span", { text: v }));
    return el("div", { class: "card pv-repo" },
      kv("브랜치", g.branch), kv("커밋 안 한 파일", g.dirty ? `${g.dirty}개` : "없음"),
      el("div", { class: "pv-sub", text: "최근 커밋" }),
      ...(g.commits.length ? g.commits.map(c => el("div", { class: "pv-cm" }, el("span", { class: "pv-h", text: c.hash }), el("span", { class: "pv-cs", text: c.subject }), el("span", { class: "cu-m", text: when(c.at) }))) : [el("div", { class: "cu-m", text: "커밋이 없어요" })]),
      el("div", { class: "pv-sub", text: `${g.base}에 안 들어간 레인 브랜치` }),
      ...(g.unmerged.length ? g.unmerged.map(u => el("div", { class: "pv-cm" }, el("span", { class: "pv-cs mono", text: u.branch }), el("span", { class: "cu-m", text: `커밋 ${u.ahead}개 · ${when(u.at)}` }))) : [el("div", { class: "cu-m", text: "모두 들어갔어요" })]));
  }

  function taskNode(t) {
    const b = el("button", { class: "pv-task", type: "button", title: "이 할 일을 요청으로 보내기" },
      el("span", { class: "pv-ring" }), el("span", { class: "pv-tx" }, el("span", { class: "pv-tw", text: t.what || t.id }), t.next ? el("span", { class: "cu-m", text: `다음: ${t.next}` }) : null));
    b.addEventListener("click", () => busy(b, async () => {
      if (!await ask("할 일 보내기", `${botName}에게 이어서 해 달라고 보내요: ${t.what}`, "보내기")) return;
      await sendReq(`할 일 ${t.id}: ${t.what} - 이어서 해 주세요.`, "main");
    }));
    return b;
  }

  function linkedNode(L) {
    const rows = [];
    const row = (ic, name, sub, tail) => el("div", { class: "cu-r" }, icon(ic), el("span", { class: "cu-rn" }, el("span", { text: name }), sub ? el("span", { class: "cu-m pv-rs", text: sub }) : null), tail || null);
    if (L.channel) rows.push(row("discord", `#${L.channel.name}`, `작업 채널${L.threads.length ? ` · 스레드 ${L.threads.length}개` : ""}`));
    for (const c of L.laneChannels || []) rows.push(row("discord", `${c.lane} 레인 채널`, "레인 보고가 올라오는 곳"));
    for (const r of L.routines || []) {
      const b = el("button", { class: "ib", type: "button", "aria-label": `${r.name} 실행`, title: "지금 실행" }, icon("send"));
      b.addEventListener("click", () => busy(b, async () => { await api("/api/custom/routine", "POST", { id: r.id }); toast("루틴을 보냈어요"); }));
      rows.push(row("spark", r.name, `루틴${SCHED(r) ? ` · ${SCHED(r)}` : ""}`, b));
    }
    for (const s of L.schedules || []) rows.push(row("bell", s.text, `일정 · ${when(s.at)}${s.every_minutes ? ` · ${s.every_minutes}분마다` : ""}`));
    for (const w of L.watches || []) rows.push(row("activity", w.name, `감시 · ${w.every_minutes}분마다${w.paused ? " · 쉬는 중" : ""}`));
    return rows.length ? el("div", { class: "list" }, ...rows) : emptyCard("이 프로젝트에 묶인 루틴·일정·감시가 없어요");
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
    const targets = [["main", botName], ...live.map(n => [`lane:${n}`, n]), ["new", "새 레인"]];
    const chips = el("div", { class: "pv-chips", role: "radiogroup", "aria-label": "받는 곳" });
    const paintChips = () => { clear(chips).append(...targets.map(([v, label]) => {
      const c = el("button", { class: `chip${reqTarget === v ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(reqTarget === v) }, el("span", { class: "tx", text: label }));
      c.addEventListener("click", () => { reqTarget = v; paintChips(); ta.focus(); });
      return c;
    })); };
    paintChips();
    const quick = ["지금 상태 알려줘", "남은 할 일 정리해줘", "테스트 돌려서 확인해줘", "끝난 작업 main에 반영해줘"];
    const qs = el("div", { class: "pv-quick" }, ...quick.map(q => el("button", { class: "pv-q", type: "button", text: q, onclick: () => { ta.value = q; grow(); ta.focus(); } })));
    return el("div", { class: "card pv-req" }, el("div", { class: "cu-m pv-to", text: "받는 곳" }), chips, el("div", { class: "pv-box" }, ta, send), qs);
  }

  function paintProject() {
    const root = $("#v-project");
    if (!root || current !== "project") return;
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
    const head = el("div", { class: "pv-head" }, ...[p.path ? el("span", { class: "pv-path", text: p.path }) : null,
      D && D.repo ? el("span", { class: "cu-m", text: `${D.repo.branch} 브랜치` }) : null,
      p.channel ? el("span", { class: "cu-m", text: `#${p.channel.name}` }) : null, p.note ? el("span", { class: "cu-m", text: p.note }) : null].filter(Boolean));
    const sorted = ls.slice().sort((a, b) => (b.live - a.live) || (b.waiting - a.waiting) || ts(b.finishedAt || b.startedAt) - ts(a.finishedAt || a.startedAt));
    const results = D && D.results ? D.results : null;
    const section = (cls, ...kids) => el("section", { class: `pv-s ${cls}` }, ...kids);
    const left = el("div", { class: "pv-col" },
      section("o-sum", summaryNode(D)),
      section("o-lanes", sec(`레인 ${ls.length}`), ls.length ? el("div", { class: "list pv-lanes" }, ...sorted.map(laneNode)) : emptyCard("아직 레인이 없어요")),
      D && D.repo ? section("o-repo", sec("저장소"), repoNode(D.repo)) : null,
      section("o-tasks", sec("열린 할 일", D && D.tasks && D.tasks.length ? el("span", { class: "cu-m", text: "누르면 요청으로 보내요" }) : null),
        !D ? emptyCard("불러오는 중…") : D.tasks && D.tasks.length ? el("div", { class: "list" }, ...D.tasks.map(taskNode)) : emptyCard("열린 할 일이 없어요")),
      section("o-linked", sec("루틴 · 일정 · 채널"), D && D.linked ? linkedNode(D.linked) : emptyCard("불러오는 중…")));
    const right = el("div", { class: "pv-col" },
      section("o-req", sec("요청"), requestNode(p, D)),
      section("o-res", sec("최근 결과"), !results ? emptyCard("불러오는 중…") : results.length ? el("div", { class: "list pv-results" }, ...results.map(resultNode)) : emptyCard("아직 결과가 없어요")));
    clear(root).append(head, el("div", { class: "pv-cols" }, left, right));
    const ta = $(".pv-ta", root);
    if (draft) { ta.value = draft; ta.dispatchEvent(new Event("input")); }
    if (focused) ta.focus();
  }

  /* ---------- hooks called from index.html ---------- */
  function home() {
    paintHome();
    load(10000);
  }
  function view(name, tgt) {
    if (name !== "project") return;
    projKey = tgt || "";
    if (matchMedia("(max-width: 639px)").matches) $('#nav .ni[data-view="home"]')?.classList.add("on");
    if (detailKey !== projKey) DETAIL = null;
    paintPins();
    paintProject();
    load(5000);
    loadDetail(5000);
  }
  function pins() {
    paintPins();
    return load(55000);
  }
  window.dotzCustom = { home, view, pins };

  // The main script may already have rendered the first view: catch up, then keep the sidebar and open pages fresh.
  pins();
  if (current === "home") home();
  else if (current === "project") view("project", parseHash().t);
  setInterval(() => {
    if (document.hidden) return;
    if (current === "home" || current === "project") load(25000); else pins();
    if (current === "project") loadDetail(25000);
  }, 30000);
  setInterval(() => { if (!document.hidden && current !== "home" && current !== "project") pins(); }, 60000);
})();
