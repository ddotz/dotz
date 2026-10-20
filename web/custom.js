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
.cu-ph { display: flex; flex-direction: column; gap: 2px; margin: 0 4px 4px; }
.cu-ph .cu-m + .cu-m { margin-top: 0; }
.cu-res + .cu-res { margin-top: 12px; }
.cu-rt { margin: 0 0 4px; font: 600 16px/22px var(--font); letter-spacing: -.01em; }
.cu-ta { display: block; width: 100%; min-height: 88px; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: var(--r-ctl); background: var(--card); color: var(--fg); outline: 0; font: 14px/22px var(--font); resize: vertical; }
.cu-ta::placeholder { color: var(--fg-3); }
.cu-ta:focus { border-color: var(--accent); }
.cu-send { display: flex; justify-content: flex-end; margin-top: 12px; }
.cu-send .btn:disabled, .cu-acts .btn:disabled { opacity: .4; cursor: default; }
@media (pointer: coarse) { .cu-ta { font-size: 16px; line-height: 24px; } }
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
        if (a.kind === "prompt") { toast("땃쥐에게 보냈어요"); return; }
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

  /* ---------- pinned rows (sidebar on desktop, 고정 on 홈 on phone) ---------- */
  const SCHED = r => !r.schedule ? "" : r.schedule.at ? `매일 ${r.schedule.at}` : r.schedule.every_minutes ? `${r.schedule.every_minutes}분마다` : "";
  function groups(v) {
    const D = DATA || {}, side = v === "side", base = side ? "ni" : "cu-r", nm = side ? "nl" : "cu-rn", out = [];
    const sub = t => !side && t ? el("span", { class: "cu-m", text: t }) : null;
    const projects = (D.projects || []).map(p => {
      const on = side && current === "project" && projKey === p.key, live = (p.lanes || []).some(l => l.live);
      return el("button", { class: `${base}${on ? " on" : ""}`, type: "button", title: p.path || p.name, onclick: () => go("project", p.key) },
        icon("lanes"), el("span", { class: nm, text: p.name }), sub(p.path && p.path.split("/").pop() !== p.name ? p.path : ""), live ? el("span", { class: "dot ok" }) : null);
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
      el("div", { class: "sec", text: "고정" }),
      ...g.flatMap(([label, rows]) => [el("div", { class: "cu-gl", text: label }), el("div", { class: "list" }, ...rows)])));
    if (cards.length) box.append(el("div", { class: "sec", text: "내 카드" }), el("div", { class: "grid" }, ...cards.map(cardNode)));
  }

  /* ---------- project page ---------- */
  function paintProject() {
    const root = $("#v-project");
    if (!root || current !== "project") return;
    if (root.dataset.key !== projKey) {
      root.dataset.key = projKey; root.dataset.sig = "";
      clear(root);
      const ta = el("textarea", { class: "cu-ta", rows: 3, placeholder: "이 프로젝트에 전할 말", "aria-label": "메시지" });
      const send = el("button", { class: "btn", type: "button", text: "땃쥐에게 보내기", disabled: true });
      ta.addEventListener("input", () => { send.disabled = !ta.value.trim(); });
      send.addEventListener("click", () => busy(send, async () => {
        const p = ((DATA && DATA.projects) || []).find(x => x.key === projKey), text = ta.value.trim();
        if (!p || !text) return;
        await api("/api/message", "POST", { text: `[프로젝트 ${p.name}${p.path ? ` · ${p.path}` : ""}] ${text}` });
        ta.value = ""; send.disabled = true;
        toast("땃쥐에게 보냈어요");
      }));
      root.append(el("div", { class: "cu-ph" }), el("div", { class: "sec", text: "레인" }), el("div", { class: "cu-lanes" }),
        el("div", { class: "sec", text: "최근 결과" }), el("div", { class: "cu-results" }),
        el("div", { class: "sec", text: "요청" }), el("div", { class: "card" }, ta, el("div", { class: "cu-send" }, send)));
    }
    const p = ((DATA && DATA.projects) || []).find(x => x.key === projKey);
    const [head, lanes, results] = [".cu-ph", ".cu-lanes", ".cu-results"].map(s => $(s, root));
    const form = root.lastElementChild;
    $("#title").textContent = p ? p.name : "프로젝트";
    form.hidden = !p;
    for (const s of root.querySelectorAll(".sec")) if (s.textContent === "요청") s.hidden = !p;
    if (!p) {
      clear(head); clear(results);
      clear(lanes).append(el("div", { class: "card empty", text: DATA ? "프로젝트를 찾지 못했어요" : "불러오는 중…" }));
      return;
    }
    if (same(root, JSON.stringify(p))) return;
    clear(head).append(p.path ? el("div", { class: "cu-m", text: p.path }) : null, p.channel ? el("div", { class: "cu-m", text: `#${p.channel.name}` }) : null, p.note ? el("div", { class: "cu-m", text: p.note }) : null);
    const ls = p.lanes || [];
    clear(lanes).append(ls.length
      ? el("div", { class: "list" }, ...ls.map(l => el("button", { class: "cu-r", type: "button", onclick: () => openTarget(`lane:${l.name}`, lastChatView()) },
        el("span", { class: `dot ${l.live ? statusTone(l.status) : ""}` }), el("span", { class: "cu-rn", text: l.name }), el("span", { class: "cu-m", text: l.live ? statusKo(l.status) : "종료됨" }))))
      : el("div", { class: "card empty", text: "레인 없음" }));
    const rec = ls.filter(l => l.lastText).slice(0, 3);
    clear(results).append(...(rec.length
      ? rec.map(l => el("div", { class: "card cu-res" }, el("h3", { class: "cu-rt", text: l.name }), el("div", { class: "cu-text", text: l.lastText })))
      : [el("div", { class: "card empty", text: "결과 없음" })]));
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
    paintPins();
    paintProject();
    load(5000);
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
  }, 30000);
  setInterval(() => { if (!document.hidden && current !== "home" && current !== "project") pins(); }, 60000);
})();
