/* 대기함 시안: 자동발송이 멈춘 답장을 앱을 가리지 않고 한 목록으로 모아요. 실패는 맨 위, 이유가 같은 실패는 한 줄로 묶어요.
   많이 처리할 때는 기존 빠른 처리(#triage)로 가요. 채팅에서는 2건부터 카드 대신 한 줄만 보여 줘요 */
(() => {
  const { $, $$, h, ic } = P;
  const S = P.S;
  const TABS = [["all", "전체"], ["ask", "답 필요"], ["fail", "실패"], ["sent", "보낸 것"]];
  const SECS = [["fail", "실패"], ["ask", "답 필요"], ["sent", "보낸 것"]];
  const EMPTY = { all: "기다리는 답장이 없어요", ask: "답을 기다리는 초안이 없어요", fail: "못 보낸 답장이 없어요", sent: "오늘 보낸 답장이 없어요" };
  const TONE = { ask: "warn", fail: "err", sent: "ok" };
  const SEEDS = { full: (l) => l, one: (l) => l.filter((i) => i.state === "ask").slice(0, 1), fails: (l) => l.filter((i) => i.state === "fail"), empty: () => [] };
  const TRIAGE_MIN = 3;   /* web.triage_min 기본값 */
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const seed = (state) => { S.q = SEEDS[state](structuredClone(D.queue)); S.qState = state; S.qOpen = new Set(); S.qBusy = new Set(); };
  const of = (state) => S.q.filter((i) => i.state === state);
  const find = (id) => S.q.find((i) => i.id === id);
  const shortApp = (i) => i.app.split(" ")[0];
  /* 같은 이유로 실패한 2건 이상은 한 줄로 묶어요 */
  const fails = () => {
    const by = new Map();
    of("fail").forEach((i) => by.set(i.why, [...(by.get(i.why) || []), i]));
    return [...by].map(([why, items]) => ({ why, items }));
  };

  const row = (i, kid) => '<div class="li nr q ' + i.state + '" data-qr="' + i.id + '"' + (kid ? " data-qkid" : "") + '><span class="lead"><span class="dot ' + TONE[i.state] + '"></span></span><button class="tx" data-act="q-open" data-qid="' + i.id + '"><span class="ln"><span class="hd">' + h(i.who) + '</span><span class="t">' + h(i.t) + '</span></span><span class="ln"><span class="sup">' + h(i.app) + " · " + h(i.what) + '</span><span class="tag' + (i.state === "fail" ? " err" : "") + '">' + h(i.why) + "</span></span></button></div>";
  const groupRow = ({ why, items }) => {
    const open = S.qOpen.has(why), busy = S.qBusy.has(why), n = items.length;
    return '<div class="li nr q fail qg" data-qg="' + h(why) + '"><span class="lead"><span class="dot ' + (busy ? "pri" : "err") + '"></span></span><button class="tx" data-act="q-fold" data-why="' + h(why) + '" aria-expanded="' + open + '"><span class="ln"><span class="hd">' + h(shortApp(items[0])) + " " + n + '건을 못 보냈어요</span></span><span class="ln"><span class="sup">' + (busy ? "다시 보내는 중" : h(why)) + '</span></span></button><button class="btn tonal inrow" data-act="q-retry" data-why="' + h(why) + '"' + (busy ? " disabled" : "") + '>모두 다시 보내기</button><span class="tr">' + ic("chevd") + "</span></div>" + (open ? items.map((i) => row(i, true)).join("") : "");
  };
  const failHtml = () => fails().map((g) => (g.items.length > 1 ? groupRow(g) : row(g.items[0]))).join("");
  const rowsOf = (state) => (state === "fail" ? failHtml() : of(state).map((i) => row(i)).join(""));
  const listHtml = () => {
    const secs = S.qf === "all" ? SECS.filter(([s]) => of(s).length) : of(S.qf).length ? [[S.qf]] : [];
    if (!secs.length) return '<div class="list"><div class="empty">' + EMPTY[S.qf] + "</div></div>";
    return secs.map(([s, label]) => (label ? '<div class="sec">' + label + ' <span class="meta">' + of(s).length + "건</span></div>" : "") + '<div class="list">' + rowsOf(s) + "</div>").join("");
  };
  const apps = () => new Set(of("ask").map((i) => i.app.split(" ")[0])).size;
  const showFast = () => (S.qf === "all" || S.qf === "ask") && of("ask").length >= TRIAGE_MIN;
  const metaText = () => {
    if (showFast()) return "앱 " + apps() + "곳에서 " + of("ask").length + "건 기다려요";
    return S.qf === "sent" && of("sent").length ? "오늘 보낸 답장 " + of("sent").length + "건" : "";
  };
  const tabCount = (k) => (k === "all" ? "" : of(k).length || "");
  const paint = () => {
    const box = $("[data-ql]"); if (!box) return;
    $$("[data-qf] button").forEach((b) => { const on = b.dataset.f === S.qf; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
    $$("[data-qc]").forEach((el) => P.roll(el, tabCount(el.dataset.qc)));
    const m = metaText();
    $("[data-qm]").hidden = !m;
    $("[data-qmt]").textContent = m;
    $("[data-qfast]").hidden = !showFast();
    box.innerHTML = listHtml();
  };
  const screen = () => '<div class="qhd"><div class="tabs nf" role="tablist" aria-label="답장 상태" data-qf>' + TABS.map(([k, l]) => '<button role="tab" data-act="q-filter" data-f="' + k + '" class="' + (k === S.qf ? "on" : "") + '" aria-selected="' + (k === S.qf) + '">' + l + '<span class="n' + (k === "fail" ? " err" : "") + '" data-qc="' + k + '">' + tabCount(k) + "</span></button>").join("") + '</div><div class="row nm" data-qm' + (metaText() ? "" : " hidden") + '><span class="meta" data-qmt>' + metaText() + '</span><span class="sp"></span><a class="btn tonal sm" href="#triage" data-act="q-fast" data-qfast' + (showFast() ? "" : " hidden") + ">" + ic("bolt") + "빠른 처리</a></div></div><div data-ql>" + listHtml() + "</div>";

  /* 답장 시트: 초안 카드와 같은 모양, 맨 위에 멈춘 이유 한 줄 */
  const sheetInner = (i) => {
    const sent = i.state === "sent", fail = i.state === "fail", noAddr = i.why === "메일 주소 없음" && !sent;
    const head = '<div class="rh"><h3>' + h(i.who) + '님께 답장</h3><span class="tag ' + (sent ? "ok" : fail ? "err" : "warn") + '">' + h(i.why) + '</span><span class="meta" style="margin-left:auto">' + h(i.app) + "</span></div>";
    const why = D.queueWhy[i.why] ? '<div class="note qwhy">' + h(D.queueWhy[i.why]) + "</div>" : "";
    const orig = '<div class="orig"><span class="av">' + h(i.who.slice(0, 1)) + '</span><div><div class="who">' + h(i.who) + " · " + h(i.t) + "</div><div>" + h(i.orig) + "</div></div></div>";
    if (S.qEdit) return head + orig + '<div class="ed"><textarea class="field" rows="4" data-q-text>' + h(i.text) + '</textarea><div class="cf"><button class="btn" data-act="q-keep">고친 대로 두기</button><button class="btn text" data-act="q-cancel">취소</button></div></div>';
    const text = '<div class="dr"><div>' + h(i.text).replace(/\n/g, "<br>") + "</div></div>";
    if (sent) return head + orig + text + '<div class="done-st"><span class="ck">' + ic("check") + "</span><div><div>" + h(i.who) + '님에게 보냈어요</div><div class="sub">' + h(i.app) + " · " + h(i.t) + "</div></div></div>";
    const addr = noAddr ? '<label class="qaddr"><span class="meta">받는 주소</span><input class="field" type="email" inputmode="email" placeholder="name@example.com" data-q-addr></label>' : "";
    return head + why + orig + text + addr + '<div class="cf"><button class="btn" data-act="q-send" data-q-go' + (noAddr ? " disabled" : "") + ">" + (fail ? "다시 보내기" : "보내기") + "</button>" + (fail ? "" : '<button class="btn tonal" data-act="q-edit">고치기</button>') + '<button class="btn text" data-act="q-skip">보내지 않기</button></div>';
  };
  const repaintSheet = () => { const c = $(".sheet [data-qs]"); if (c) P.mSwap(c, () => { c.innerHTML = sheetInner(S.qCur); }); };
  /* 보낸 것 맨 위로 옮겨요 */
  const toSent = (i, why) => {
    S.q.splice(S.q.indexOf(i), 1);
    const at = S.q.findIndex((x) => x.state === "sent");
    S.q.splice(at < 0 ? S.q.length : at, 0, Object.assign(i, { state: "sent", why, t: "방금" }));
  };
  const leave = async (ids, change) => {
    await Promise.all(ids.flatMap((id) => $$('[data-qr="' + id + '"]')).map((el) => P.mOut(el)));
    change(); paint();
  };

  Object.assign(P.acts, {
    "q-filter": (el) => { S.qf = el.dataset.f; P.mSwap($("[data-ql]"), paint); $("#views").scrollTop = 0; },
    "q-fast": () => { S.backTo = S.route.id; },
    "q-chat": () => { S.backTo = S.route.id; },
    "q-open": (el) => { S.qCur = find(el.dataset.qid); S.qEdit = false; P.sheet({ title: "답장 확인", cls: "mid", body: '<div class="rc qs" data-qs>' + sheetInner(S.qCur) + "</div>" }); },
    "q-fold": (el) => {
      const why = el.dataset.why, was = S.qOpen.has(why);
      S.qOpen[was ? "delete" : "add"](why); paint();
      if (!was) $$("[data-qkid]").filter((k) => find(k.dataset.qr).why === why).forEach((k) => P.mIn(k, "top"));
    },
    "q-retry": async (el) => {
      const why = el.dataset.why, items = of("fail").filter((i) => i.why === why), first = items[0];
      S.qBusy.add(why); paint();
      await delay(900);
      S.qBusy.delete(why);
      const box = $$("[data-qg]").find((g) => g.dataset.qg === why);
      if (box) await P.mOut(box);
      await leave(items.map((i) => i.id), () => items.slice().reverse().forEach((i) => toSent(i, "다시 보냄")));
      P.toast(shortApp(first) + " " + items.length + "건을 다시 보냈어요");
    },
    "q-send": async () => {
      const i = S.qCur, why = i.state === "fail" ? "다시 보냄" : "확인 후 발송";
      await P.closeSheet();
      await leave([i.id], () => toSent(i, why));
      P.toast(i.who + "님께 보냈어요");
    },
    "q-edit": () => { S.qEdit = true; repaintSheet(); },
    "q-cancel": () => { S.qEdit = false; repaintSheet(); },
    "q-keep": () => { S.qCur.text = $("[data-q-text]").value; S.qEdit = false; repaintSheet(); },
    "q-skip": async () => {
      const i = S.qCur, at = S.q.indexOf(i);
      await P.closeSheet();
      await leave([i.id], () => S.q.splice(at, 1));
      P.toast("보내지 않기로 했어요", { undo: () => { S.q.splice(at, 0, i); paint(); P.mIn($('[data-qr="' + i.id + '"]'), "top"); } });
    },
  });
  document.addEventListener("input", (e) => { if (e.target.matches("[data-q-addr]")) $("[data-q-go]").disabled = !/.@.+\../.test(e.target.value); });

  const reg = (id, desc, o = {}) => P.reg({ id, title: "대기함", tab: "monitoring", back: "monitoring", group: "모니터링", desc,
    render: () => {
      const state = o.state || "full";
      if (S.qState !== state) seed(state);
      S.qf = o.filter || "all";
      return screen();
    } });
  reg("queue", "시안: 앱을 가리지 않는 한 목록 · 실패가 맨 위 · 42건");
  reg("queue/ask", "시안: 답 필요만", { filter: "ask" });
  reg("queue/failed", "시안: 실패만 · 같은 이유는 한 줄", { filter: "fail" });
  reg("queue/sent", "시안: 보낸 것만", { filter: "sent" });
  reg("queue/one", "시안: 1건일 때", { state: "one" });
  reg("queue/fails", "시안: 실패만 남았을 때", { state: "fails" });
  reg("queue/empty", "시안: 빈 대기함", { state: "empty" });

  /* 채팅: 카드를 대화에 쌓지 않고, 입력창 바로 위에 한 줄만 둬요. 대화는 평소처럼 위로 스크롤돼요 */
  const line = (n) => '<a class="qline" href="#queue" data-act="q-chat"><span class="dot warn"></span><span class="tx">답장 초안 <b data-qn>' + n + '</b>건 기다려요</span><span class="sep">·</span><span class="go">확인하기</span></a>';
  const chatMain = () => P.routes["chat/main"];
  const CHAT = { group: "채팅", tab: "chat", back: "chat", view: "fill wide" };
  P.reg({ ...CHAT, id: "queue/chat", title: "dotz AI", desc: "시안: 초안 2건부터 입력창 위 한 줄",
    render: () => chatMain().render(),
    mount: (v) => {
      if (S.qState !== "full") seed("full");
      chatMain().mount(v);
      const n = of("ask").length;
      if (n >= 2) $(".cmp", v).insertAdjacentHTML("afterbegin", line(n));
    } });
  P.reg({ ...CHAT, id: "queue/chat/one", title: "dotz AI", desc: "시안: 초안 1건은 그대로 카드",
    render: () => {
      S.extra = Object.assign(S.extra || {}, { main: '<div class="msg bot"><div class="mm">dotz AI · 방금</div>' + P.draftCard("d-m1") + "</div>" });
      return chatMain().render();
    },
    mount: (v) => { delete S.extra.main; chatMain().mount(v); } });
})();
