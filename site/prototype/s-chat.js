(() => {
  const { $, $$, h, ic, md } = Object.assign({}, P, { md: P.md });
  const baseInline = P.inline;
  P.inline = (s) => baseInline(s).replace(/~~(.+?)~~/g, '<s class="old">$1</s>');

  P.S.tasks = [
    { id: "t-price", title: "경쟁 서비스 가격 조사", state: "running", sub: "4분째 · dotz AI" },
    { id: "t-report", title: "주간 보고서 정리", state: "done", sub: "3분 전 끝남", file: "주간-보고서.md" },
    { id: "t-notice", title: "배포 공지 초안 다듬기", state: "done", sub: "9분 전 끝남" },
    { id: "t-night", title: "밤 사이 메일 분류", state: "done", sub: "새벽 2:10 끝남" },
  ];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const briefingBody = () => `<div class="ch"><h3>아침 점검</h3><span class="tag pri">브리핑</span><span class="ac">오전 7:30</span></div>
    <div class="big">일정 4개, 답장할 메일 2통</div>
    <div class="sec" style="margin-left:0">오늘 일정</div>
    ${D.calendar.map((c) => `<div class="cal"><span class="tm">${c.at}</span><span><span class="ti">${h(c.title)}</span>${c.where ? `<span class="wh">${h(c.where)}</span>` : ""}</span></div>`).join("")}
    <div class="sec" style="margin-left:0">메일</div>
    <div class="cal"><span class="tm">답장</span><span><span class="ti">한서윤</span><span class="wh">다음 주 미팅 시간 고르기</span></span></div>
    <div class="cal"><span class="tm">답장</span><span><span class="ti">오지훈</span><span class="wh">견적서 의견 (금요일까지)</span></span></div>
    <div class="sec" style="margin-left:0">감시</div>
    <div class="cal"><span class="tm">가격</span><span><span class="ti">캠핑 의자</span><span class="wh"><s class="old">89,000원</s> → 72,000원</span></span></div>
    <div>${P.fileChip("/Users/me/briefing/아침-브리핑.md")}</div>
    <div class="fold-box"><button data-act="fold">${ic("chevd")}원문 보기</button><pre hidden>좋은 아침이에요. 아침 브리핑이에요.\n\n오늘 일정 4개\n- 10:00 팀 주간 회의\n- 13:00 한서윤님과 점심\n- 15:30 견적서 검토\n- 19:00 운동</pre></div>`;
  P.briefingBody = briefingBody;

  const msgHtml = ([w, t, x], extra = "") => {
    if (w === "me") return `<div class="msg me"><div class="bub">${extra}${P.inline(x).replace(/\n/g, "<br>")}</div><div class="mm">${h(t)}</div></div>`;
    if (w === "sys") return `<div class="msg sys"><div class="bub">${h(x)}</div></div>`;
    const body = x === "@briefing" ? `<div class="rcard">${briefingBody()}</div>` : md(x);
    return `<div class="msg bot"><div class="mm">dotz AI · ${h(t)}<button class="ib rq" data-act="quote" aria-label="인용" style="width:24px;height:24px">${ic("quote")}</button></div><div class="bub">${body}</div></div>`;
  };
  P.msgHtml = msgHtml;

  const todoHtml = () => {
    const cur = D.todo.findIndex((s) => s.cur), done = D.todo.filter((s) => s.done).length;
    return `<div class="todo" data-todo><button data-act="todo-toggle"><span class="dot pri"></span><span class="tn">${cur >= 0 ? h(D.todo[cur].t) : "모두 끝났어요"}</span><span class="meta"><span data-todo-n>${done}</span>/${D.todo.length}</span>${ic("chevd")}</button><ol hidden>${D.todo.map((s) => `<li class="${s.done ? "done" : s.cur ? "cur" : ""}"><span class="ck">${s.done ? ic("check") : ""}</span><span class="t">${h(s.t)}</span></li>`).join("")}<li style="justify-content:flex-end"><button class="btn text inrow" data-act="todo-next">다음 단계 시연</button></li></ol></div>`;
  };

  const decisionHtml = () => `<div class="dc" data-dc><div class="dq">${h(D.decision.ask)}</div><div class="dm">결정 · ${h(D.decision.q)}</div><div class="dos">${D.decision.opts.map((o) => `<button class="do" data-act="dec-pick" data-n="${o.n}"><span class="n">${o.n}) ${h(o.name)}${o.rec ? ' <span class="tag pri">추천</span>' : ""}</span><span class="d">${h(o.desc)}</span></button>`).join("")}</div></div>`;

  const composerHtml = () => `<div class="cmp"><div class="rqt" hidden></div><div class="atts" hidden></div><div class="box"><button class="ib" data-act="attach" aria-label="파일 붙이기">${ic("plus")}</button><textarea rows="1" placeholder="dotz AI에게 말해 보세요" aria-label="메시지"></textarea><button class="send" data-act="send" aria-label="보내기" disabled>${ic("send")}</button></div><div class="mdl"><span class="dot" data-mdl></span><span>dotz AI</span></div></div>`;

  const convHtml = (id) => {
    const c = D.convs.find((x) => x.id === id);
    const msgs = (D.msgs[id] || []).slice();
    const answered = P.S.answered && P.S.answered[id];
    return `<div class="cv" data-conv="${id}"><div class="cv-hd"><h2>${h(c.title)}</h2>${c.kind === "lane" ? '<span class="tag pri">세션</span>' : c.kind === "ch" ? '<span class="tag">프로젝트 채널</span>' : c.kind === "sys" ? '<span class="tag">자동</span>' : ""}<div class="seg" data-v="0"><i></i><button class="on">대화</button><button data-act="go" data-to="chat/terminal">터미널</button></div></div>
      <div class="targets">${D.convs.map((x) => `<a href="#chat/${x.id}" class="${x.id === id ? "on" : ""}">${h(x.title)}${x.unread && x.id !== id ? `<span class="bd">${x.unread}</span>` : ""}</a>`).join("")}</div>
      ${id === "ch1" ? todoHtml() : ""}
      <div class="tl" data-tl>${msgs.map((m) => msgHtml(m)).join("")}${P.S.extra && P.S.extra[id] ? P.S.extra[id] : ""}</div>
      ${id === "ch1" ? `<div class="run"><span class="dot work"></span>dotz AI가 모바일 화면을 캡처하고 있어요 · 2분</div>` : ""}
      ${id === "ch2" && !answered ? decisionHtml() : ""}${composerHtml()}</div>`;
  };

  const listHtml = (cur) => `<div class="tabs"><button class="on">전체</button><button>답할 것 ${D.convs.filter((c) => c.ask).length}</button><button>세션</button><button>알림</button></div>
    <div class="list">${D.convs.map((c) => `<a class="li${c.id === cur ? " on" : ""}" href="#chat/${c.id}"><span class="ico">${ic(c.kind === "bot" ? "chat" : c.kind === "ch" ? "folder" : c.kind === "lane" ? "terminal" : "bell")}</span><span class="tx"><span class="hd${c.unread ? " b" : ""}">${h(c.title)}</span><span class="sup">${h(c.sub)}</span></span><span class="end"><span>${h(c.t)}</span>${c.ask ? '<span class="dot warn"></span>' : ""}${c.unread ? `<span class="bd">${c.unread}</span>` : ""}</span></a>`).join("")}</div>
    <div class="sec">메일 · 메신저</div><div class="list"><a class="li" href="#mail/1"><span class="av">한</span><span class="tx"><span class="hd b">다음 주 미팅 일정 확인 부탁드려요</span><span class="sup">한서윤 · 답장 초안이 기다려요</span></span><span class="end">9:12</span></a><a class="li" href="#kakao/r1"><span class="av">정</span><span class="tx"><span class="hd b">정우</span><span class="sup">그리고 장작은 어디서 살까?</span></span><span class="end"><span>6분 전</span><span class="tag unrep">미답장</span></span></a></div>`;

  const chatScreen = (id) => `<div class="chat2" data-has="${id ? 1 : 0}"><div class="pane-list">${listHtml(id || "main")}</div><div class="pane-conv">${convHtml(id || "main")}</div></div>`;
  P.reg({ id: "chat", title: "채팅", tab: "chat", group: "채팅", view: "fill wide", desc: "대화 목록 (넓은 화면은 목록 + 대화)", render: () => chatScreen(""), mount: mountConv });
  D.convs.forEach((c) => P.reg({ id: "chat/" + c.id, title: c.title, tab: "chat", back: "chat", group: "채팅", view: "fill wide", desc: { main: "dotz AI와 대화 · 보내면 입력 중 → 답", ch1: "프로젝트 채널 · 할 일 줄 · 진행 상태", ch2: "결정 카드 · 번호 고르기 · 이유 쓰기 …", alert: "알림 대화 · 가격 변경 메시지", worklog: "작업 기록 · 오너가 안 볼 때 일어난 일", lane: "세션 보고 대화" }[c.id], render: () => chatScreen(c.id), mount: mountConv }));

  P.reg({ id: "chat/terminal", title: "터미널 보기", tab: "chat", back: "chat/ch1", group: "채팅", view: "wide", desc: "같은 세션의 작업 기록을 터미널로 보기",
    render: () => `<div class="row" style="margin-bottom:12px"><span class="tag pri">세션</span><b>랜딩 페이지 점검</b><div class="seg bg" data-v="1" style="margin-left:auto"><i></i><button data-act="go" data-to="chat/lane">대화</button><button class="on">터미널</button></div></div>
    <div class="term"><span class="d">12초 작업 · 명령 3 · 읽기 2</span>\n<span class="c">$</span> bun run check:links\n<span class="o">38 열림</span> · <span class="e">2 주소 확인 필요</span>\n<span class="d">  /pricing  404 · /docs/start 301</span>\n<span class="c">$</span> cat dist/index.html | head -5\n<span class="d">&lt;!doctype html&gt;</span>\n<span class="c">$</span> bun run capture --width 390\n<span class="o">캡처 3장 저장했어요</span>\n<span class="d">완료 · 모바일 점검 진행 중</span></div>
    <p class="note">터미널 보기는 대화와 같은 기록을 도구 호출 단위로 보여 줘요. 어두운 패널이에요 (라이트·다크 모두).</p>` });

  function mountConv(view) {
    const cv = $(".cv", view); if (!cv) return;
    const tl = $("[data-tl]", cv);
    tl.scrollTop = tl.scrollHeight;
    const ta = $("textarea", cv), send = $(".send", cv);
    const sync = () => { send.disabled = !ta.value.trim(); ta.style.height = "auto"; ta.style.height = Math.min(120, ta.scrollHeight) + "px"; slashMenu(); };
    const slashMenu = () => {
      let m = $(".slash", cv); const v = ta.value;
      if (!/^\/\S*$/.test(v)) { if (m) m.remove(); return; }
      const cmds = [["/status", "지금 상태"], ["/usage", "사용량 보기"], ["/model", "모델 바꾸기"], ["/new", "새 대화"]].filter((c) => c[0].startsWith(v));
      if (!cmds.length) { if (m) m.remove(); return; }
      if (!m) { m = document.createElement("div"); m.className = "slash"; $(".cmp", cv).append(m); P.mIn(m, "rise", 150); }
      m.innerHTML = cmds.map((c) => `<button data-cmd="${c[0]}"><code>${c[0]}</code><span>${c[1]}</span></button>`).join("");
      m.onclick = (e) => { const b = e.target.closest("[data-cmd]"); if (b) { ta.value = b.dataset.cmd + " "; m.remove(); ta.focus(); sync(); } };
    };
    ta.addEventListener("input", sync);
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!send.disabled) doSend(cv); } });
    cv._sync = sync;
    if (location.hash === "#chat/approve") return;
  }

  const scrollEnd = (tl) => { tl.scrollTop = tl.scrollHeight; };
  const addMsg = (cv, html, from = "rise") => {
    const tl = $("[data-tl]", cv); tl.insertAdjacentHTML("beforeend", html);
    const el = tl.lastElementChild; P.mIn(el, from); scrollEnd(tl); return el;
  };
  const typing = (cv) => addMsg(cv, `<div class="typing" data-typing><span class="dot work"></span>dotz AI가 쓰고 있어요</div>`);

  const replyFor = (t) => {
    if (/^\/status/.test(t)) return "[done] 지금은 이래요.\n\n- 맥북 온라인, 맥미니 온라인\n- 일하는 세션 2개\n- 5시간 한도 62% 사용";
    if (/^\/usage/.test(t)) return "5시간 한도 62%, 7일 한도 38%를 썼어요.\n[usage]";
    if (/일정|스케줄/.test(t)) return "오늘 일정 4개예요.\n\n```목록\n# 오늘 일정\n주간 회의 | 온라인 | 10:00\n점심 | 한서윤님과 | 13:00\n견적서 검토 | 오지훈님 자료 | 15:30\n운동 | | 19:00\n```";
    if (/메일/.test(t)) return "[done] 안 읽은 메일 2통, 답장할 메일 2통이에요.\n\n```목록\n# 받은 편지함\n한서윤 | 다음 주 미팅 일정 확인 부탁드려요 | 오전 9:12 | 답장\n별빛상회 주문팀 | 주문하신 책상 램프가 출발했어요 | 오전 8:04\n오지훈 | 견적서 수정본 보내드려요 | 어제 | 답장\n```";
    if (/댓글/.test(t)) return "[ask] 댓글 4개에 답글 초안을 만들었어요.\n\n- 유튜브 2개, 인스타그램 1개, 웹사이트 1개\n\n모니터링의 댓글에서 확인해 주세요.";
    if (/가격|감시/.test(t)) return "[run] 캠핑 의자 가격이 바뀌었어요.\n\n- 캠핑 의자 ~~89,000원~~ → 72,000원";
    if (/브리핑/.test(t)) return "@briefing";
    if (/실패|오류/.test(t)) return "[fail] 가격 페이지를 열지 못했어요.\n\n- 원인: 연결이 끊겼어요\n- 다음: 10분 뒤에 다시 해 볼게요";
    return "알겠어요. 데모라서 실제로 하지는 않아요.\n\n- 오늘 일정 알려 줘\n- 메일 정리해 줘\n- 보고서 정리해 줘\n- 댓글 답글 써 줘";
  };

  async function doSend(cv) {
    const ta = $("textarea", cv), text = ta.value.trim(); if (!text) return;
    const atts = $$(".atts .chip", cv).map((c) => c.dataset.name), q = $(".rqt .chip", cv);
    const extra = (q ? `<div class="qt" style="margin:0 0 6px">${h(q.dataset.q)}</div>` : "") + atts.map((a) => P.fileChip(a)).join("");
    ta.value = ""; $(".atts", cv).innerHTML = ""; $(".atts", cv).hidden = true; $(".rqt", cv).innerHTML = ""; $(".rqt", cv).hidden = true;
    cv._sync(); const sl = $(".slash", cv); if (sl) sl.remove();
    addMsg(cv, msgHtml(["me", "방금", text], extra));
    const mdl = $("[data-mdl]", cv); if (mdl) mdl.classList.add("work");
    const ty = typing(cv);
    if (/보고서|작업|정리해/.test(text) && !/메일/.test(text)) {
      await delay(700); ty.remove();
      const m = addMsg(cv, `<div class="msg bot"><div class="mm">dotz AI · 방금</div><div class="bub"><div class="st"><span class="tag pri">진행 중</span><span>보고서를 정리하고 있어요</span></div><div class="prog"><div class="pl"><span class="dot work"></span><span data-pg>자료를 모으는 중</span></div></div></div></div>`);
      const pg = $("[data-pg]", m);
      await delay(1100); P.mSwap($(".prog", m), () => (pg.textContent = "문서를 정리하는 중"));
      await delay(1100); P.mSwap($(".prog", m), () => (pg.textContent = "거의 다 됐어요 · 곧 답이 와요"));
      await delay(900); await P.mOut(m, "fade", 150); m.remove();
      addMsg(cv, msgHtml(["bot", "방금", "[done] 주간 보고서를 정리했어요.\n\n- 이번 주 끝낸 일 6건\n- 다음 주 할 일 3건\n[file] /Users/me/reports/주간-보고서.md"]));
    } else {
      await delay(1000 + Math.min(600, text.length * 20)); ty.remove();
      const r = replyFor(text);
      if (r.endsWith("[usage]")) addMsg(cv, msgHtml(["bot", "방금", r.replace("\n[usage]", "")]));
      else addMsg(cv, msgHtml(["bot", "방금", r]));
    }
    if (mdl) mdl.classList.remove("work");
  }

  Object.assign(P.acts, {
    send: (el) => doSend(el.closest(".cv")),
    go: (el) => { location.hash = "#" + el.dataset.to; },
    fold: (el) => { const pre = el.nextElementSibling; pre.hidden = !pre.hidden; },
    attach: (el) => {
      const a = $(".atts", el.closest(".cv")); a.hidden = false;
      const n = ["화면-캡처.png", "견적서.pdf", "메모.txt"][a.children.length % 3];
      a.insertAdjacentHTML("beforeend", `<span class="chip" data-name="${n}">${ic("file")}<span class="nm">${n}</span><button class="ib" style="width:20px;height:20px" data-act="att-x" aria-label="빼기">${ic("x")}</button></span>`);
      P.mIn(a.lastElementChild, "rise", 150); el.closest(".cv")._sync();
      $("textarea", el.closest(".cv")).value ||= ""; $(".send", el.closest(".cv")).disabled = false;
    },
    "att-x": async (el) => { const c = el.closest(".chip"); await P.mOut(c); c.remove(); },
    quote: (el) => {
      const cv = el.closest(".cv"), box = $(".rqt", cv), t = $(".bub", el.closest(".msg")).innerText.replace(/\s+/g, " ").slice(0, 60);
      box.hidden = false; box.innerHTML = `<span class="chip" data-q="${h(t)}">${ic("quote")}<span class="nm">${h(t)}</span></span>`; P.mIn(box.firstElementChild, "rise", 150);
      $("textarea", cv).focus();
    },
    "todo-toggle": (el) => { const ol = $("ol", el.closest(".todo")); ol.hidden = !ol.hidden; if (!ol.hidden) P.mIn(ol, "rise", 150); },
    "todo-next": (el) => {
      const lis = $$("ol > li", el.closest(".todo")).slice(0, D.todo.length), i = D.todo.findIndex((s) => s.cur);
      if (i < 0) return;
      D.todo[i].cur = false; D.todo[i].done = true;
      if (D.todo[i + 1]) D.todo[i + 1].cur = true;
      const strip = el.closest(".todo");
      P.mSwap(lis[i], () => { lis[i].className = "done"; $(".ck", lis[i]).innerHTML = ic("check"); });
      if (lis[i + 1]) P.mSwap(lis[i + 1], () => (lis[i + 1].className = "cur"));
      P.roll($("[data-todo-n]", strip), String(D.todo.filter((s) => s.done).length));
      P.mSwap($(".tn", strip), () => { $(".tn", strip).textContent = D.todo[i + 1] ? D.todo[i + 1].t : "모두 끝났어요"; });
    },
    "dec-pick": async (el) => {
      const dc = el.closest("[data-dc]"), cv = el.closest(".cv"), n = Number(el.dataset.n), o = D.decision.opts.find((x) => x.n === n);
      if (o.reason) {
        P.mSwap(dc, () => { dc.innerHTML = `<div class="dq">${h(o.name.replace(" …", ""))} — 이유나 방식을 적어 주세요</div><div class="rs"><textarea class="field" rows="3" data-reason placeholder="예: 메일 뉴스레터로 먼저 보내 주세요"></textarea><div class="btns"><button class="btn sm" data-act="dec-reason">보내기</button><button class="btn text sm" data-act="dec-back">돌아가기</button></div></div>`; });
        $("[data-reason]", dc).focus(); return;
      }
      finishDecision(cv, dc, n, `${n}) ${o.name}`);
    },
    "dec-reason": (el) => { const dc = el.closest("[data-dc]"), v = $("[data-reason]", dc).value.trim(); if (!v) { P.toast("이유를 한 줄 적어 주세요"); return; } finishDecision(el.closest(".cv"), dc, 4, `4) 다른 방식 … ${v}`); },
    "dec-back": (el) => { const dc = el.closest("[data-dc]"); P.mSwap(dc, () => { dc.outerHTML = decisionHtml(); }); },
  });

  async function finishDecision(cv, dc, n, label) {
    P.S.answered = Object.assign(P.S.answered || {}, { ch2: true });
    D.convs.find((c) => c.id === "ch2").ask = false; D.convs.find((c) => c.id === "ch2").unread = 0; P.refreshBadges();
    await P.mOut(dc, "fade", 150); dc.remove();
    addMsg(cv, msgHtml(["me", "방금", label]));
    const ty = typing(cv); await delay(1100); ty.remove();
    addMsg(cv, msgHtml(["bot", "방금", D.decision.answers[n]]));
  }

  document.addEventListener("dz-draft", (e) => {
    const m = $(`.msg[data-ask="${e.detail.id}"] .tag`);
    if (m && e.detail.state === "sent") P.mSwap(m, () => { m.className = "tag ok"; m.textContent = "보냈어요"; });
  });

  /* 답 형식 모음 */
  const FM = [
    ["채팅 답 (2-4문장, 답 먼저)", "오늘은 일정이 4개예요. 첫 일정은 10시 주간 회의고요, 점심은 한서윤님과 해요.\n저녁 7시에 운동이 있어요."],
    ["[done] 완료 보고 (결론 한 줄 + 글머리표 + 근거)", "[done] 가격 페이지 감시를 켰어요.\n\n- 30분마다 확인해요\n- 바뀌면 알림으로 알려 드려요\n- 확인한 곳: `price-page.sh`"],
    ["[run] 진행 중 보고", "[run] 랜딩 페이지 모바일 점검 중이에요.\n\n- 화면 캡처 3장 완료\n- 링크 점검은 끝났어요"],
    ["[ask] 확인 요청 + 결정 블록 (선택지, ← 추천)", "[ask] 배포 공지를 어떤 형태로 정리할까요?\n\n결정: 공지 형태\n**1) 짧은 공지** ← 추천\n한 문단으로 핵심만 전해요\n**2) 목록 공지**\n바뀐 항목을 순서대로 적어요\n**3) 다른 방식 …**\n원하는 방식과 이유를 적어 주세요\n\n번호로 답해 주세요."],
    ["[fail] 실패 보고", "[fail] 인스타그램 확인에 실패했어요.\n\n- 원인: 로그인이 풀렸어요\n- 다음: 설정에서 다시 로그인해 주세요"],
    ["발송 승인 (보내기 · 고치기 · 보내지 않기)", "[ask] 한서윤님께 보낼 답장이에요.\n\n> 받는이: 한서윤\n> 제목: Re: 다음 주 미팅 일정 확인 부탁드려요\n> 서윤님, 화요일 오후 2시가 좋아요.\n> 그때 뵐게요. 장소는 온라인으로 해요.\n\n결정: 이 답장을 보낼까요? (d-m1)\n1) 보내기\n2) 고치기\n3) 보내지 않기"],
    ["목록 블록 (제목 | 부제 | 시각 | 배지)", "```목록\n# 안 읽은 메일\n한서윤 | 다음 주 미팅 일정 확인 부탁드려요 | 오전 9:12 | 답장\n별빛상회 주문팀 | 주문하신 책상 램프가 출발했어요 | 오전 8:04\n```"],
    ["파일 첨부 ([file] /절대/경로)", "[done] 보고서를 만들었어요.\n[file] /Users/me/reports/주간-보고서.md\n[file] /Users/me/reports/지표.png"],
    ["가격 변경 (바뀌기 전 값은 회색 취소선)", "[run] 캠핑 의자 가격이 바뀌었어요.\n\n- 캠핑 의자 ~~89,000원~~ → 72,000원"],
    ["코드·명령 블록", "다시 시작하려면 이 명령을 써요.\n\n```\nbun run dev\n```"],
    ["세션 보고 4줄 (결과 · 결정 · 글머리표 · For)", "[done] 문구 확정본을 반영했어요.\n\n- 바뀐 곳: 첫 화면 제목과 설명\n- 확인: 모바일 390px에서 줄바꿈 확인\n\nFor dotz AI: 작업로그 항목을 완료로 바꿔 주세요."],
  ];
  P.reg({ id: "chat/formats", title: "답 형식 모음", tab: "chat", back: "chat", group: "채팅", desc: "[done]/[run]/[ask]/[fail], 선택지, 승인, 목록, 파일, 진행 메시지",
    render: () => `<div class="hint">봇이 쓰는 모든 출력 형식이에요. 아래 각 카드는 같은 글이 화면에서 어떻게 그려지는지 보여 주고, "원문 보기"에 계약 그대로의 글이 있어요.</div><div class="fmt" style="margin-top:12px">${FM.map(([lab, raw]) => `<div class="card"><div class="lab">${h(lab)}</div><div class="msg bot"><div class="bub">${md(raw.replace("\n[usage]", ""))}</div></div><div class="fold-box"><button data-act="fold">${ic("chevd")}원문 보기</button><pre hidden>${h(raw)}</pre></div></div>`).join("")}
    <div class="card"><div class="lab">진행 메시지 (같은 메시지가 제자리에서 바뀌어요, 답이 오면 사라져요)</div><div class="msg bot"><div class="bub"><div class="st"><span class="tag pri">진행 중</span><span>보고서를 정리하고 있어요</span></div><div class="prog"><div class="pl"><span class="dot work"></span><span data-fmt-pg>자료를 모으는 중</span></div></div></div></div><div class="cf"><button class="btn tonal sm" data-act="fmt-prog">진행 바꿔 보기</button></div></div>
    <div class="card"><div class="lab">결정 카드 (웹은 입력창 위에 붙어요)</div>${decisionHtml().replace("<div class=\"dc\"", "<div class=\"dc\" style=\"margin:0\"")}</div>
    <div class="card"><div class="lab">결과 카드 (아침 점검)</div>${briefingBody()}</div></div>`,
    mount: (v) => { $$("[data-dc] .do", v).forEach((b) => (b.dataset.act = "fmt-dec")); } });
  const stepTexts = ["자료를 모으는 중", "문서를 정리하는 중", "거의 다 됐어요"];
  P.acts["fmt-prog"] = (el) => { const s = $("[data-fmt-pg]"); const i = (stepTexts.indexOf(s.textContent) + 1) % 3; P.mSwap(s.closest(".prog"), () => (s.textContent = stepTexts[i])); };
  P.acts["fmt-dec"] = (el) => P.toast(`${el.dataset.n}번을 골랐어요 (채팅 화면에서 이어서 볼 수 있어요)`);

  /* 발송 승인 시트 */
  P.reg({ id: "chat/approve", title: "보내기 승인", tab: "chat", back: "chat", group: "채팅", view: "fill wide", desc: "[ask] 발송 승인 → 시트 · 보내기 · 고치기 · 보내지 않기",
    render: () => {
      P.S.extra = Object.assign(P.S.extra || {}, { main: `<div class="msg bot" data-ask="d-m1"><div class="mm">dotz AI · 방금</div><div class="bub">${md(FM[5][1])}<div class="cf"><button class="btn sm" data-act="open-approve">초안 열기</button></div></div></div>` });
      return chatScreen("main");
    },
    mount: (v) => { delete P.S.extra.main; mountConv(v); setTimeout(() => P.acts["open-approve"](), 50); } });
  P.acts["open-approve"] = () => {
    P.sheet({ title: "답장 확인", cls: "mid", body: P.draftCard("d-m1"), onClose: () => {} });
  };

  /* 아침 브리핑 */
  P.reg({ id: "briefing", title: "아침 브리핑", tab: "home", back: "home", group: "홈", desc: "결과 카드: 일정 · 메일 · 감시 · 파일 칩 · 원문 접기",
    render: () => `<div class="card">${briefingBody()}</div><div class="note">채팅에서는 같은 카드가 답 안에 들어가고, 홈에서는 "아침 점검" 카드로 줄어요.</div>` });

  /* 백그라운드 작업 */
  const taskRow = (t) => `<div class="li" data-task="${t.id}"><span class="lead"><span class="dot ${t.state === "running" ? "work" : "ok"}"></span></span><span class="tx"><span class="hd">${h(t.title)}</span><span class="sup">${h(t.sub)}</span></span><span class="end">${t.state === "running" ? '<span class="tag pri">진행 중</span>' : t.file ? `<span class="chip" style="height:28px">${ic("file")}<span class="nm">${h(t.file)}</span></span>` : '<span class="tag ok">완료</span>'}</span></div>`;
  P.taskRow = taskRow;
  const counts = () => { const r = P.S.tasks.filter((t) => t.state === "running").length; return [r, P.S.tasks.length - r]; };
  P.reg({ id: "tasks", title: "백그라운드 작업", tab: "home", back: "home", group: "홈", desc: "맡긴 작업 진행 중 → 끝나면 파일 칩이 붙어요",
    render: () => { const [r, d] = counts(); return `<div class="sum"><div class="card stat"><span class="meta">진행 중</span><span class="big" data-tcount="run">${r}</span></div><div class="card stat"><span class="meta">끝난 작업</span><span class="big" data-tcount="done">${d}</span></div></div>
      <div class="sec">작업<span class="ac"><button class="btn tonal sm" data-act="task-new">${ic("plus")}주간 보고서 맡기기</button></span></div><div class="list" data-tasks>${P.S.tasks.map(taskRow).join("")}</div><div class="note">버튼을 누르면 작업이 들어와서 3초쯤 뒤에 같은 줄에서 "완료 + 파일"로 바뀌어요.</div>`; } });
  P.acts["task-new"] = async (el) => {
    const t = { id: "t-new" + Date.now(), title: "주간 보고서 정리 (새로)", state: "running", sub: "방금 시작 · dotz AI" };
    P.S.tasks.unshift(t);
    const box = $("[data-tasks]"); box.insertAdjacentHTML("afterbegin", taskRow(t)); P.mIn(box.firstElementChild, "top");
    const sync = () => { const [r, d] = counts(); P.roll($("[data-tcount=run]"), String(r)); P.roll($("[data-tcount=done]"), String(d)); };
    sync(); el.disabled = true;
    await delay(3200);
    t.state = "done"; t.sub = "방금 끝남"; t.file = "주간-보고서-새로.md";
    const row = $(`[data-task="${t.id}"]`);
    if (row) P.mSwap(row, () => { row.outerHTML = taskRow(t); });
    sync(); el.disabled = false;
    P.toast("주간 보고서 정리를 마쳤어요");
  };
})();
