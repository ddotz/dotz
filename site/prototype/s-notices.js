/* 알림 화면: 종에서 여는 독립 화면. 행 모양은 하나, 필터는 거르기만 해요. 읽음은 누르기 · ✕ · 모두 읽음으로만 바뀌어요 */
(() => {
  const { $, $$, h, ic } = P;
  const S = P.S;
  const FILTERS = [["all", "전체"], ["ask", "답변 필요"], ["result", "결과"], ["news", "새 소식"], ["alert", "경고"]];
  const GROUPS = [["need", "처리할 것"], ["news", "새 소식"], ["past", "지난 알림"]];
  const SEEDS = { full: (l) => l, read: (l) => l.filter((n) => !n.need && !n.unread), empty: () => [], long: (l) => l.filter((n) => n.long) };

  const listed = () => S.notices.filter((n) => n.cls !== "log");
  const inFilter = (k) => listed().filter((n) => k === "all" || n.cls === k);
  const unreadIn = (k) => inFilter(k).filter((n) => n.unread).length;
  const groupOf = (n) => (n.need ? "need" : n.unread ? "news" : "past");
  const find = (id) => S.notices.find((n) => n.id === id);
  const rowsOf = (id) => $$(`[data-nr="${id}"]`);
  S.notices = structuredClone(D.notices); S.nState = "full"; S.nOpen = new Set();

  const summary = (n) => (n.price ? `<s class="old">${h(n.price[0])}</s> → ${h(n.price[1])}` : h(n.sub));
  const text = (n, sub) => `<span class="ln"><span class="hd" title="${h(n.title)}">${h(n.title)}</span><span class="t">${h(n.t)}</span></span><span class="ln"><span class="sup">${sub}</span><span class="tag">${h(n.tag)}</span></span>`;
  const xLabel = { need: "처리했어요", news: "읽음으로 표시", past: "지우기" };
  const row = (n) => {
    const g = groupOf(n), tone = g === "past" ? "" : n.tone;
    const body = n.decision && n.need ? `<button class="tx" data-act="nf-decide" data-nid="${n.id}">${text(n, summary(n))}</button>`
      : `<a class="tx" href="#${h(n.href)}" data-act="nf-open" data-nid="${n.id}">${text(n, (n.rep ? `${n.rep.length}번 · ` : "") + summary(n))}</a>`;
    const end = n.rep ? `<button class="ib" data-act="nf-fold" data-nid="${n.id}" aria-expanded="${S.nOpen.has(n.id)}" aria-label="반복 알림 펼치기">${ic("chevd")}</button>`
      : n.need && !n.close ? `<span class="tr">${ic("chev")}</span>`
      : `<button class="ib" data-act="nf-x" data-nid="${n.id}" aria-label="${xLabel[g]}">${ic("x")}</button>`;
    return `<div class="li nr${n.unread ? " unread" : ""}" data-nr="${n.id}"><span class="lead"><span class="dot ${tone}"></span></span>${body}${end}</div>`;
  };
  const child = (n, r) => `<div class="li nr" data-nr="${n.id}" data-nchild><span class="lead"><span class="dot"></span></span><a class="tx" href="#${h(r.href)}" data-act="nf-open" data-nid="${n.id}">${text(r, summary(r))}</a><span class="tr">${ic("chev")}</span></div>`;
  const rowWith = (n) => row(n) + (n.rep && S.nOpen.has(n.id) ? n.rep.map((r) => child(n, r)).join("") : "");

  const listHtml = () => {
    const rows = inFilter(S.nf);
    if (!rows.length) return `<div class="list"><div class="empty">새 알림이 없어요</div></div>`;
    return GROUPS.map(([g, label]) => {
      const inG = rows.filter((n) => groupOf(n) === g);
      return inG.length ? `<div class="sec">${label}</div><div class="list" data-ng="${g}">${inG.map(rowWith).join("")}</div>` : "";
    }).join("");
  };
  const readable = () => inFilter(S.nf).filter((n) => n.unread && n.cls !== "ask");
  const paint = () => {
    const box = $("[data-nl]"); if (!box) return;
    $$("[data-nf] button").forEach((b) => { const on = b.dataset.f === S.nf; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
    $$("[data-nc]").forEach((el) => P.roll(el, unreadIn(el.dataset.nc) || ""));
    $("[data-nm]").hidden = !listed().length;
    P.roll($("[data-nu]"), String(unreadIn(S.nf)));
    $("[data-nall]").hidden = !readable().length;
    box.innerHTML = listHtml();
  };
  const screen = () => `<div class="tabs nf" role="tablist" aria-label="알림 종류" data-nf>${FILTERS.map(([k, l]) => `<button role="tab" data-act="nf-filter" data-f="${k}" class="${k === S.nf ? "on" : ""}" aria-selected="${k === S.nf}">${l}<span class="n" data-nc="${k}">${unreadIn(k) || ""}</span></button>`).join("")}</div>
    <div class="row nm" data-nm${listed().length ? "" : " hidden"}><span class="meta">안 읽은 알림 <span data-nu>${unreadIn(S.nf)}</span>개</span><span class="sp"></span><button class="btn text sm" data-act="nf-readall" data-nall${readable().length ? "" : " hidden"}>모두 읽음</button></div>
    <div data-nl>${listHtml()}</div>`;

  /* 처리되거나 읽힌 행은 motionOut으로 떠나고, 남을 자리가 있으면 그 묶음 맨 위로 들어와요 */
  const leave = async (n, change) => {
    if (n.leaving) return;
    n.leaving = true;
    await Promise.all(rowsOf(n.id).map((el) => P.mOut(el)));
    n.leaving = false; change(); paint(); P.refreshBadges();
    P.mIn($(`[data-nr="${n.id}"]`), "top");
  };
  const done = (n) => { n.need = false; n.unread = false; };
  const settleAsked = () => { if (S.answered && S.answered.ch2) { const n = find("n-dec"); if (n) done(n); } };
  document.addEventListener("dz-draft", (e) => { if (e.detail.state !== "sent" && e.detail.state !== "skip") return; const n = S.notices.find((x) => x.draft === e.detail.id); if (n) done(n); P.refreshBadges(); });

  Object.assign(P.acts, {
    "nf-filter": (el) => { S.nf = el.dataset.f; P.mSwap($("[data-nl]"), paint); },
    "nf-open": (el) => { const n = find(el.dataset.nid); if (n) n.unread = false; S.nKeep = true; S.nScroll = $("#views").scrollTop; S.backTo = S.route.id; P.refreshBadges(); },
    "nf-decide": (el) => {
      const n = find(el.dataset.nid); n.unread = false; paint(); P.refreshBadges();
      P.sheet({ title: "결정", body: `<div class="dc nfd"><div class="dq">${h(D.decision.ask)}</div><div class="dm">${h(D.decision.q)}</div><div class="dos">${D.decision.opts.map((o) => `<button class="do" data-act="nf-pick" data-nid="${n.id}"><span class="n">${o.n}) ${h(o.name)}${o.rec ? ' <span class="tag pri">추천</span>' : ""}</span><span class="d">${h(o.desc)}</span></button>`).join("")}</div></div>` });
    },
    "nf-pick": async (el) => {
      const n = find(el.dataset.nid);
      S.answered = Object.assign(S.answered || {}, { ch2: true });
      const c = D.convs.find((x) => x.id === "ch2"); c.ask = false; c.unread = 0;
      await P.closeSheet();
      leave(n, () => done(n));
    },
    "nf-x": (el) => {
      const n = find(el.dataset.nid);
      if (groupOf(n) !== "past") { leave(n, () => done(n)); return; }
      const at = S.notices.indexOf(n);
      leave(n, () => { S.notices.splice(at, 1); P.toast("알림을 지웠어요", { undo: () => { S.notices.splice(at, 0, n); paint(); P.mIn($(`[data-nr="${n.id}"]`), "top"); } }); });
    },
    "nf-fold": async (el) => {
      const n = find(el.dataset.nid), open = S.nOpen.has(n.id);
      el.setAttribute("aria-expanded", String(!open));
      if (open) {
        S.nOpen.delete(n.id);
        const kids = $$(`[data-nr="${n.id}"][data-nchild]`);
        await Promise.all(kids.map((k) => P.mOut(k))); kids.forEach((k) => k.remove());
        return;
      }
      S.nOpen.add(n.id);
      el.closest(".nr").insertAdjacentHTML("afterend", n.rep.map((r) => child(n, r)).join(""));
      $$(`[data-nr="${n.id}"][data-nchild]`).forEach((k) => P.mIn(k, "top"));
    },
    "nf-readall": async () => {
      const rows = readable(), kept = inFilter(S.nf).some((n) => n.unread && n.cls === "ask");
      await Promise.all(rows.filter((n) => !n.need).flatMap((n) => rowsOf(n.id)).map((el) => P.mOut(el)));
      rows.forEach((n) => (n.unread = false)); paint(); P.refreshBadges();
      if (kept) P.toast("답이 필요한 알림은 그대로 뒀어요");
    },
  });

  /* 경로마다 같은 화면, 시작 상태만 달라요 */
  const backTo = () => { const p = S.route && S.route.id; if (p && !p.startsWith("notices") && !S.nKeep) S.nBack = p; return S.nBack || "home"; };
  const reg = (id, desc, o = {}) => P.reg({ id, title: "알림", tab: "notices", back: backTo, group: "알림", desc,
    render: () => {
      const state = o.state || "full";
      if (S.nState !== state) { S.notices = SEEDS[state](structuredClone(D.notices)); S.nState = state; }
      if (!S.nKeep) { S.nf = o.filter || "all"; S.nOpen = new Set(o.open ? ["n-rep"] : []); }
      settleAsked();
      return screen();
    },
    mount: () => {
      if (S.nKeep) { $("#views").scrollTop = S.nScroll || 0; S.nKeep = false; }
      P.refreshBadges();
      if (o.arrive) requestAnimationFrame(() => requestAnimationFrame(() => { if (S.notices.some((n) => n.id === D.arriveNotice.id)) return; S.notices.unshift(structuredClone(D.arriveNotice)); paint(); P.refreshBadges(); P.mIn($(`[data-nr="${D.arriveNotice.id}"]`), "top"); }));
    } });
  reg("notices", "종에서 여는 화면 · 처리할 것 · 새 소식 · 지난 알림");
  reg("notices/ask", "필터: 답변 필요", { filter: "ask" });
  reg("notices/result", "필터: 결과", { filter: "result" });
  reg("notices/news", "필터: 새 소식", { filter: "news" });
  reg("notices/alert", "필터: 경고", { filter: "alert" });
  reg("notices/read", "다 읽은 목록: 지난 알림만", { state: "read" });
  reg("notices/empty", "빈 화면: 새 알림이 없어요", { state: "empty" });
  reg("notices/long", "긴 제목과 긴 요약은 한 줄로 줄여요", { state: "long" });
  reg("notices/repeat", "같은 감시의 반복을 펼친 행", { open: true });
  reg("notices/arrive", "새 알림이 맨 위로 들어와요", { arrive: true });
})();
