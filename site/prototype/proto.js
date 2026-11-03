(() => {
  const root = document.documentElement;
  const P = (window.P = { S: { gw: "맥북", sheet: null, pop: null, first: true }, acts: {}, routes: {}, order: [] });
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  P.$ = $; P.$$ = $$;

  P.h = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const h = P.h;

  const IC = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/>',
    chat: '<path d="M20 12a8 8 0 0 1-11.5 7.2L4 20l1-4.3A8 8 0 1 1 20 12z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 6"/>',
    file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    chevd: '<path d="m6 9 6 6 6-6"/>',
    back: '<path d="m15 6-6 6 6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    send: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
    clip: '<path d="m20 11-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    star: '<path d="m12 3.5 2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.3 9.9l6-.9z"/>',
    undo: '<path d="m9 14-5-5 5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 10 3 2-3 2M12 15h5"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l3 3"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1"/>',
    shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/>',
    download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
    quote: '<path d="M7 7h4v5a4 4 0 0 1-4 4M15 7h4v5a4 4 0 0 1-4 4"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".6"/><circle cx="4" cy="12" r=".6"/><circle cx="4" cy="18" r=".6"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6z"/>',
    pointer: '<path d="M6 4l12 7-5 1.5L11 18z"/>',
    dots: '<circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/>',
  };
  P.ic = (n, c = "") => `<svg class="ic ${c}" viewBox="0 0 24 24" aria-hidden="true">${IC[n] || IC.dots}</svg>`;
  const ic = P.ic;

  /* motion: transform and opacity only; every helper is a no-op when the switch is off */
  const EASE = "cubic-bezier(.2, .7, .2, 1)";
  const FROM = { rise: "translateY(8px)", top: "translateY(-8px)", fade: "none", side: "translateX(12px)" };
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  P.motionOn = () => root.dataset.motion !== "off" && !reduced();
  P.mIn = (el, from = "rise", ms = 220, delay = 0) => {
    if (!el || !el.animate || !P.motionOn()) return;
    el.animate([{ opacity: 0, transform: FROM[from] || FROM.rise }, { opacity: 1, transform: "none" }], { duration: ms, delay, easing: EASE, fill: "backwards" });
  };
  P.mOut = (el, to = "fade", ms = 150) => {
    if (!el || !el.animate || !P.motionOn()) return Promise.resolve();
    const a = el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: FROM[to] || "none" }], { duration: ms, easing: EASE, fill: "forwards" });
    return a.finished.then(() => a, () => a);
  };
  P.mSwap = (el, change, ms = 220) => {
    change();
    if (!el || !el.animate || !P.motionOn()) return;
    el.animate([{ opacity: 0.25, transform: "scale(.985)" }, { opacity: 1, transform: "none" }], { duration: ms, easing: EASE });
  };
  P.mPop = (el) => {
    if (!el || !el.animate || !P.motionOn()) return;
    el.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: 200, easing: EASE });
  };
  P.roll = (el, next) => {
    if (!el) return;
    const now = String(next ?? ""), was = el.textContent;
    if (now === was) return;
    if (!P.motionOn() || !/^\d+$/.test(now) || !/^\d+$/.test(was)) { el.textContent = now; return; }
    const up = Number(now) > Number(was), pad = was.padStart(now.length, " ");
    el.textContent = "";
    for (let i = 0; i < now.length; i++) {
      const d = document.createElement("span");
      d.className = "m-dg"; d.textContent = now[i]; el.append(d);
      if (pad[pad.length - now.length + i] !== now[i] && d.animate)
        d.animate([{ opacity: 0, transform: `translateY(${up ? "60%" : "-60%"})` }, { opacity: 1, transform: "none" }], { duration: 220, easing: EASE });
    }
  };
  P.stagger = (box, sel = ".li, .card, .rc, .msg") => {
    if (P.S.first) return;
    $$(sel, box).slice(0, 8).forEach((el, i) => P.mIn(el, "rise", 220, i * 35));
  };

  /* markup for the bot's own words: status mark, 선택지 block, 목록 block, [file] chips (MODE.md Message layout) */
  P.inline = (s) => h(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const STAT = { done: ["ok", "완료"], run: ["pri", "진행 중"], ask: ["warn", "확인 필요"], fail: ["err", "실패"] };
  const fileChip = (p) => `<span class="fchip">${ic("file")}<span class="nm">${h(p)}</span></span>`;
  P.fileChip = fileChip;
  P.listBlock = (title, rows) => `<div class="lb">${title ? `<div class="lt">${h(title)}</div>` : ""}${rows.map((r) => {
    const [t, sub, meta, badge] = r;
    return `<div class="li"><span class="av">${h((t || "-").slice(0, 1))}</span><span class="tx"><span class="hd">${h(t)}</span>${sub ? `<span class="sup">${h(sub)}</span>` : ""}</span><span class="end">${meta ? h(meta) : ""}${badge ? `<span class="bd">${h(badge)}</span>` : ""}</span></div>`;
  }).join("")}</div>`;
  P.md = (src) => {
    const L = String(src).split("\n");
    let out = "", i = 0, para = [];
    const m0 = /^\[(done|run|ask|fail)\]\s*(.*)$/.exec(L[0] || "");
    if (m0) { const [t, label] = STAT[m0[1]]; out += `<div class="st"><span class="tag ${t}">${label}</span><span>${P.inline(m0[2])}</span></div>`; i = 1; }
    const flush = () => { if (para.length) { out += `<p>${para.map(P.inline).join("<br>")}</p>`; para = []; } };
    for (; i < L.length; i++) {
      const l = L[i];
      if (/^```목록/.test(l)) {
        flush(); let title = ""; const rows = [];
        for (i++; i < L.length && !/^```/.test(L[i]); i++) {
          if (/^# /.test(L[i])) title = L[i].slice(2); else if (L[i].trim()) rows.push(L[i].split(" | "));
        }
        out += P.listBlock(title, rows);
      } else if (/^```/.test(l)) {
        flush(); const code = [];
        for (i++; i < L.length && !/^```/.test(L[i]); i++) code.push(L[i]);
        out += `<pre><code>${h(code.join("\n"))}</code></pre>`;
      } else if (/^결정:/.test(l)) {
        flush(); let blk = `<div class="ch-blk"><div class="cq">${h(l.slice(3).trim())}</div>`;
        for (i++; i < L.length && L[i].trim(); i++) {
          const m = /^\*{0,2}(\d)\) (.+?)\*{0,2}( ← 추천)?$/.exec(L[i]);
          if (m) { const d = L[i + 1] && !/^\*{0,2}\d\)/.test(L[i + 1]) ? L[++i] : ""; blk += `<div class="co"><b>${h(m[1])}) ${h(m[2])}</b>${m[3] ? ' <span class="tag pri">추천</span>' : ""}${d ? `<div>${h(d)}</div>` : ""}</div>`; }
        }
        out += blk + "</div>";
      } else if (/^- /.test(l)) {
        flush(); const li = [];
        for (; i < L.length && /^- /.test(L[i]); i++) li.push(L[i].slice(2));
        i--; out += `<ul>${li.map((x) => `<li>${P.inline(x)}</li>`).join("")}</ul>`;
      } else if (/^> ?/.test(l)) {
        flush(); const q = [];
        for (; i < L.length && /^> ?/.test(L[i]); i++) q.push(L[i].replace(/^> ?/, ""));
        i--; out += `<div class="qt">${q.map((x) => `<div>${P.inline(x)}</div>`).join("")}</div>`;
      } else if (/^\[file\] /.test(l)) {
        flush(); out += fileChip(l.slice(7).trim());
      } else if (!l.trim()) flush();
      else para.push(l);
    }
    flush();
    return out;
  };

  /* toast */
  P.toast = (msg, o = {}) => {
    const box = $("#toasts"), t = document.createElement("div");
    t.className = "toast"; t.innerHTML = `<span>${h(msg)}</span>${o.undo ? "<button>실행 취소</button>" : ""}`;
    box.append(t); P.mIn(t, "rise", 220);
    let gone = false;
    const kill = async () => { if (gone) return; gone = true; clearTimeout(timer); await P.mOut(t, "fade", 150); t.remove(); };
    const timer = setTimeout(kill, o.ms || 5000);
    if (o.undo) $("button", t).onclick = () => { o.undo(); kill(); };
    return { dismiss: kill };
  };

  /* sheet + popover */
  const phone = () => matchMedia("(max-width: 639px)").matches;
  P.sheet = (o) => {
    P.closeSheet(true);
    const layer = $("#layer"), scrim = document.createElement("div"), el = document.createElement("div");
    scrim.className = "scrim"; el.className = "sheet " + (o.cls || "");
    el.setAttribute("role", "dialog");
    el.innerHTML = `<div class="sh-hd"><h2>${h(o.title || "")}</h2><button class="ib" data-act="sheet-close" aria-label="닫기">${ic("x")}</button></div><div class="sh-bd">${o.body || ""}</div>${o.foot ? `<div class="sh-ft">${o.foot}</div>` : ""}`;
    layer.append(scrim, el);
    if (P.motionOn()) {
      scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: EASE });
      el.animate(phone() ? [{ transform: "translateY(100%)" }, { transform: "none" }] : [{ opacity: 0, transform: "translate(-50%, calc(-50% + 16px))" }, { opacity: 1, transform: "translate(-50%, -50%)" }], { duration: 280, easing: EASE });
    }
    scrim.onclick = () => P.closeSheet();
    P.S.sheet = { el, scrim, onClose: o.onClose };
    if (o.mount) o.mount(el);
    return el;
  };
  P.closeSheet = async (instant) => {
    const s = P.S.sheet; if (!s) return;
    P.S.sheet = null;
    if (!instant && P.motionOn()) await Promise.all([P.mOut(s.scrim, "fade", 150), P.mOut(s.el, phone() ? "fade" : "fade", 150)]);
    s.el.remove(); s.scrim.remove(); if (s.onClose) s.onClose();
  };
  P.closePop = () => { if (P.S.pop) { P.S.pop.remove(); P.S.pop = null; } };
  P.pop = (anchor, html) => {
    P.closePop();
    const el = document.createElement("div"); el.className = "pop"; el.innerHTML = html;
    document.body.append(el);
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth;
    el.style.top = Math.min(r.bottom + 6, innerHeight - el.offsetHeight - 8) + "px";
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
    P.mIn(el, "top", 150);
    P.S.pop = el;
    return el;
  };

  /* reply draft card: one component for mail, kakao, comments; the state changes in place */
  const DR = {};
  P.registerDraft = (d, orig) => { DR[d.id] = Object.assign({ state: "ask", edited: false }, d, orig); return d.id; };
  P.pending = () => Object.values(DR).filter((d) => d.state === "ask" || d.state === "edit").length;
  const drInner = (d) => {
    const head = `<div class="rh"><h3>${h(d.to)}님께 답장</h3><span class="tag ${d.state === "sent" ? "ok" : d.state === "skip" ? "" : "warn"}">${d.state === "sent" ? "보냈어요" : d.state === "skip" ? "보내지 않았어요" : d.edited && d.state === "ask" ? "다시 확인" : "확인 필요"}</span><span class="meta" style="margin-left:auto">${h(d.kind)}</span></div>`;
    const orig = `<div class="orig"><span class="av">${h((d.fromName || d.to).slice(0, 1))}</span><div><div class="who">${h(d.fromName || d.to)} · ${h(d.when || "방금")}</div><div>${h(d.origText || "")}</div></div></div>`;
    let body;
    if (d.state === "sent") body = `<div class="done-st"><span class="ck">${ic("check")}</span><div><div>${h(d.to)}님에게 보냈어요</div><div class="sub">${h(d.kind)} · 방금</div></div></div>`;
    else if (d.state === "skip") body = `<div class="done-st skip"><span class="ck">${ic("x")}</span><div><div>보내지 않고 닫았어요</div><div class="sub">초안은 이 카드에 남아 있어요</div></div><button class="btn text inrow" style="margin-left:auto" data-act="dr-undo">되돌리기</button></div>`;
    else if (d.state === "edit") body = `<div class="ed"><textarea class="field" rows="4" data-dr-text>${h(d.text)}</textarea><div class="ask">고친 뒤 "다시 확인"을 누르면 다시 물어봐요</div><div class="cf"><button class="btn" data-act="dr-recheck">다시 확인</button><button class="btn text" data-act="dr-cancel">취소</button></div></div>`;
    else body = `<div class="dr"><div class="to">${d.subj ? `제목: ${h(d.subj)}` : `대화방: ${h(d.to)}`}${d.edited ? " · 고쳤어요" : ""}</div><div>${h(d.text).replace(/\n/g, "<br>")}</div></div><div class="cf"><button class="btn" data-act="dr-send">보내기</button><button class="btn tonal" data-act="dr-edit">고치기</button><button class="btn text" data-act="dr-skip">보내지 않기</button></div>`;
    return head + orig + body;
  };
  P.draftCard = (id) => { const d = DR[id]; return d ? `<div class="rc" data-dr="${h(id)}">${drInner(d)}</div>` : ""; };
  const drSet = (el, state, patch = {}) => {
    const card = el.closest("[data-dr]"), d = DR[card.dataset.dr];
    Object.assign(d, patch, { state });
    P.mSwap(card, () => { card.innerHTML = drInner(d); });
    P.refreshBadges();
    document.dispatchEvent(new CustomEvent("dz-draft", { detail: { id: d.id, state } }));
  };
  Object.assign(P.acts, {
    "dr-send": (el) => drSet(el, "sent"),
    "dr-edit": (el) => drSet(el, "edit"),
    "dr-skip": (el) => drSet(el, "skip"),
    "dr-undo": (el) => drSet(el, "ask"),
    "dr-cancel": (el) => drSet(el, "ask"),
    "dr-recheck": (el) => drSet(el, "ask", { text: $("[data-dr-text]", el.closest("[data-dr]")).value.trim() || DR[el.closest("[data-dr]").dataset.dr].text, edited: true }),
    "sheet-close": () => P.closeSheet(),
  });

  /* badges: the bell, the 채팅 tab and the 모니터링 tab */
  P.S.notices = D.notices.slice();
  P.S.unread = () => P.S.notices.filter((n) => n.unread).length;
  const chatUnread = () => D.convs.reduce((a, c) => a + (c.unread || 0), 0);
  const badge = (key, n, cls) => (n > 0 ? `<span class="${cls}" data-bd="${key}">${n}</span>` : "");
  P.refreshBadges = () => {
    const vals = { bell: P.S.unread(), chat: chatUnread(), mon: P.pending() };
    $$("[data-bd]").forEach((el) => P.roll(el, vals[el.dataset.bd]));
    Object.keys(vals).forEach((k) => { $$(`[data-bdhost="${k}"]`).forEach((host) => {
      const has = $("[data-bd]", host);
      if (vals[k] > 0 && !has) { host.insertAdjacentHTML("beforeend", badge(k, vals[k], host.dataset.bdcls)); P.mPop($("[data-bd]", host)); }
      if (vals[k] === 0 && has) has.remove();
    }); });
    $$("[data-count=drafts]").forEach((el) => P.roll(el, String(vals.mon)));
  };

  /* shell */
  const NAV = [["home", "홈", "home"], ["chat", "채팅", "chat"], ["projects", "프로젝트", "folder"], ["monitoring", "모니터링", "eye"], ["settings", "설정", "sliders"]];
  const BD = { chat: "chat", monitoring: "mon" };
  const buildShell = () => {
    $("#side").innerHTML = `<button class="brand" data-act="gw"><span class="logo"></span><span>dotz</span><span class="cn">${ic("laptop")}<span data-gwn>${h(P.S.gw)}</span>${ic("chevd")}</span></button><nav class="nav">${NAV.map(([id, l, i]) => `<a class="ni" data-tab="${id}" href="#${id}">${ic(i)}<span>${l}</span><span data-bdhost="${BD[id] || ""}" data-bdcls="nb" style="display:contents">${BD[id] ? badge(BD[id], BD[id] === "chat" ? chatUnread() : P.pending(), "nb") : ""}</span></a>`).join("")}</nav>`;
    $("#tabbar").innerHTML = NAV.map(([id, l, i]) => `<a data-tab="${id}" href="#${id}">${ic(i, "s20")}<span>${l}</span>${BD[id] ? `<span data-bdhost="${BD[id]}" data-bdcls="nb" style="display:contents">${badge(BD[id], BD[id] === "chat" ? chatUnread() : P.pending(), "nb")}</span>` : ""}</a>`).join("");
  };
  const buildBar = (r) => {
    const back = r.back ? `<a class="ib" href="#${r.back}" aria-label="뒤로">${ic("back")}</a>` : "";
    $("#appbar").className = "appbar" + (back ? " back" : "");
    $("#appbar").innerHTML = `${back}<h1>${h(r.title)}</h1><button class="gw" data-act="gw">${ic("laptop")}<span data-gwn>${h(P.S.gw)}</span>${ic("chevd")}</button><button class="cmdk" data-act="palette" aria-label="검색">${ic("search")}<span>검색</span><kbd>⌘K</kbd></button><a class="ib" href="#notices" aria-label="알림">${ic("bell")}<span data-bdhost="bell" data-bdcls="bd" style="display:contents">${badge("bell", P.S.unread(), "bd")}</span></a>`;
  };

  P.reg = (r) => { P.routes[r.id] = r; P.order.push(r.id); };

  const render = () => {
    const id = decodeURIComponent(location.hash.slice(1)).replace(/^\/+/, "") || "home";
    const r = P.routes[id] || { id, title: "없는 화면", tab: "home", back: "index", render: () => `<div class="empty">#${h(id)} 화면은 없어요.<br><a class="btn tonal sm" href="#index" style="margin-top:12px">화면 목록 열기</a></div>` };
    P.closeSheet(true); P.closePop(); closePalette(true);
    buildBar(r);
    $$("[data-tab]").forEach((a) => a.classList.toggle("on", a.dataset.tab === r.tab));
    const view = $("#view");
    view.className = "view" + (r.view ? " " + r.view : "");
    view.innerHTML = r.render();
    $("#views").scrollTop = 0;
    document.title = `${r.title} · dotz prototype`;
    if (!P.S.first) { P.mIn(view, "rise", 220); }
    if (r.mount) r.mount(view);
    P.stagger(view);
    P.S.route = r;
  };

  /* command palette */
  let pal = null;
  const closePalette = async (instant) => {
    if (!pal) return; const p = pal; pal = null;
    if (!instant) await Promise.all([P.mOut(p.scrim, "fade", 150), P.mOut(p.el, "fade", 150)]);
    p.el.remove(); p.scrim.remove();
  };
  P.openPalette = () => {
    if (pal) return;
    const layer = $("#layer"), scrim = document.createElement("div"), el = document.createElement("div");
    scrim.className = "scrim"; el.className = "pal";
    el.innerHTML = `<input placeholder="화면 이름이나 명령을 찾아보세요" aria-label="검색" autocomplete="off"><div class="pl"></div>`;
    layer.append(scrim, el); pal = { el, scrim };
    if (P.motionOn()) {
      scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: EASE });
      el.animate([{ opacity: 0, transform: "translateX(-50%) scale(.98)" }, { opacity: 1, transform: "translateX(-50%) scale(1)" }], { duration: 180, easing: EASE });
    }
    const input = $("input", el), list = $(".pl", el);
    const all = [...D.palette.map(([id, t, k]) => ({ id, t, k })), ...P.order.filter((id) => !D.palette.some((p) => p[0] === id)).map((id) => ({ id, t: P.routes[id].title, k: P.routes[id].group || "" }))];
    let sel = 0, rows = [];
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      rows = all.filter((x) => !q || (x.t + " " + x.k + " " + x.id).toLowerCase().includes(q)).slice(0, 12);
      sel = Math.min(sel, Math.max(0, rows.length - 1));
      list.innerHTML = rows.length ? rows.map((x, i) => `<button class="pi${i === sel ? " on" : ""}" data-pid="${h(x.id)}">${ic("search")}<span class="tx"><span class="hd">${h(x.t)}</span></span><span class="g">${h(x.k)}</span></button>`).join("") : `<div class="pe">찾는 화면이 없어요</div>`;
    };
    input.oninput = () => { sel = 0; draw(); };
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown") { sel = Math.min(sel + 1, rows.length - 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && rows[sel]) { closePalette(); location.hash = "#" + rows[sel].id; }
    };
    list.onclick = (e) => { const b = e.target.closest("[data-pid]"); if (b) { closePalette(); location.hash = "#" + b.dataset.pid; } };
    scrim.onclick = () => closePalette();
    draw(); input.focus();
  };
  P.acts.palette = () => P.openPalette();

  P.acts.gw = (el) => {
    const p = P.pop(el, `<div class="pt">내 컴퓨터</div>${D.computers.map((c) => `<button class="li" data-act="gw-pick" data-n="${h(c.name)}"><span class="dot ${c.online ? "ok" : ""}"></span><span class="tx"><span class="hd">${h(c.name)}</span><span class="sup">${h(c.sub)}</span></span><span class="end">${c.name === P.S.gw ? ic("check") : c.need ? `<span class="bd">${c.need}</span>` : ""}</span></button>`).join("")}<a class="li" href="#peers" data-act="pop-close"><span class="lead">${ic("users")}</span><span class="tx"><span class="hd">컴퓨터 관리</span></span></a>`);
    return p;
  };
  P.acts["gw-pick"] = (el) => {
    const n = el.dataset.n; if (!D.computers.find((c) => c.name === n).online) { P.toast(`${n}은 꺼져 있어요`); return; }
    P.S.gw = n; $$("[data-gwn]").forEach((x) => (x.textContent = n)); P.closePop(); P.toast(`${n}으로 바꿨어요 (프로토타입에서는 화면이 그대로예요)`);
  };
  P.acts["pop-close"] = () => P.closePop();

  /* toolbar: theme + motion */
  const storedMotion = () => localStorage.getItem("dz-proto-motion") || "on";
  const applyMotion = () => {
    const eff = reduced() ? "off" : storedMotion();
    root.dataset.motion = eff;
    $$("[data-motion-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.motionSet === eff)));
  };
  const applyTheme = (t) => { root.dataset.theme = t; $$("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === t))); };
  P.acts["theme-set"] = (el) => { localStorage.setItem("dz-proto-theme", el.dataset.themeSet); applyTheme(el.dataset.themeSet); };
  P.acts["motion-set"] = (el) => { localStorage.setItem("dz-proto-motion", el.dataset.motionSet); applyMotion(); };

  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (a && P.acts[a.dataset.act]) { if (a.tagName !== "A") e.preventDefault(); P.acts[a.dataset.act](a, e); }
    if (P.S.pop && !e.target.closest(".pop") && !(a && a.dataset.act === "gw")) P.closePop();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal ? closePalette() : P.openPalette(); }
    if (e.key === "Escape") { if (pal) closePalette(); else if (P.S.sheet) P.closeSheet(); else P.closePop(); }
  });
  addEventListener("hashchange", render);

  /* index screen */
  const GROUPS = ["홈", "채팅", "프로젝트", "모니터링", "메일", "알림", "설정", "기타"];
  P.reg({ id: "index", title: "화면 목록", tab: "home", back: "home", group: "기타", desc: "프로토타입의 모든 화면",
    render: () => `<div class="hint">디자인 시안이에요. 실제 제품과 연결돼 있지 않고, 보내기나 저장은 모두 화면 안에서만 일어나요. 화면 ${P.order.length}개.</div><div class="idx-grid" style="margin-top:12px">${GROUPS.map((g) => {
      const rs = P.order.map((id) => P.routes[id]).filter((r) => r.group === g);
      return rs.length ? `<div class="idx-g"><h3>${g} ${rs.length}</h3>${rs.map((r) => `<a class="li" data-r="${h(r.id)}" href="#${h(r.id)}"><span class="tx"><span class="hd">${h(r.title)}</span><span class="sup">${h(r.desc || "")}</span></span><span class="end hash">#${h(r.id)}</span></a>`).join("")}</div>` : "";
    }).join("")}</div>
    <div class="sec">동작 시연 (화면이 아니라 동작이에요)</div>
    <div class="list"><button class="li" data-act="palette"><span class="lead">${ic("search")}</span><span class="tx"><span class="hd">명령 팔레트 열기</span><span class="sup">⌘K / Ctrl+K 도 돼요</span></span></button><button class="li" data-act="gw"><span class="lead">${ic("laptop")}</span><span class="tx"><span class="hd">컴퓨터 전환 팝오버</span></span></button><button class="li" data-act="demo-price"><span class="lead">${ic("bell")}</span><span class="tx"><span class="hd">가격 변경 알림 도착</span><span class="sup">알림 맨 위에 들어오고 종 숫자가 굴러요</span></span></button><button class="li" data-act="demo-toast"><span class="lead">${ic("undo")}</span><span class="tx"><span class="hd">삭제 되돌리기 토스트</span><span class="sup">5초 뒤 저절로 사라져요</span></span></button></div>`,
  });
  P.acts["demo-toast"] = () => P.toast("메일 1통을 휴지통으로 옮겼어요", { undo: () => P.toast("되돌렸어요") });

  const boot = () => {
    const sTheme = localStorage.getItem("dz-proto-theme");
    applyTheme(sTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    applyMotion();
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", applyMotion);
    buildShell();
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => { P.S.first = false; }));
  };
  P.boot = boot;
  window.addEventListener("error", (e) => { (window.__errs = window.__errs || []).push(e.message); });
})();
