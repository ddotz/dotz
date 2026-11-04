(() => {
  const { $, $$, h, ic } = P;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  P.registerDraft(D.mailDraft[1], { fromName: "한서윤", origText: D.mails[0].sum, when: "오전 9:12" });
  P.registerDraft(D.mailDraft[3], { fromName: "오지훈", origText: D.mails[2].sum, when: "어제" });
  Object.values(D.comments).flat().forEach((c) => P.registerDraft({ id: c.id, to: c.author, text: c.draft, kind: c.kind, subj: "" }, { fromName: c.author, origText: c.text, when: `${c.t} · ${c.post}` }));
  P.registerDraft(D.kakaoDraft, { fromName: "정우", origText: "그리고 장작은 어디서 살까?", when: "6분 전" });

  const tagFor = (t) => (t === "warn" ? "warn" : t === "ok" ? "ok" : t === "pri" ? "pri" : t === "err" ? "err" : "");
  const link = (href, ico, title, sup, end = "") => `<a class="li" href="#${href}"><span class="lead">${ic(ico)}</span><span class="tx"><span class="hd">${h(title)}</span>${sup ? `<span class="sup">${sup}</span>` : ""}</span><span class="end">${end}${ic("chev", "chev")}</span></a>`;
  const card = (title, body, ac = "", tag = "") => `<div class="card"><div class="ch"><h3>${h(title)}</h3>${tag}${ac}</div>${body}</div>`;
  const more = (href, label = "더 보기") => `<a class="ac" href="#${href}">${label}${ic("chev")}</a>`;

  /* 홈 */
  const needs = () => [
    ["chat/ch2", "릴리스 노트", "배포 공지를 어떤 형태로 정리할까요?", "결정"],
    ["mail/1", "한서윤", "다음 주 미팅 답장 초안을 확인해 주세요", "답장"],
    ["comments", "댓글 4개", "유튜브 · 인스타그램 · 웹사이트 답글 초안", "답글"],
    ["kakao/r1", "정우", "장작은 어디서 살까? · 답장 초안", "미답장"],
  ];
  P.reg({ id: "home", title: "홈", tab: "home", group: "홈", desc: "상태 카드: 답변 필요 · 알림 · 진행 중 · 끝난 작업 · 사용량",
    render: () => {
      const running = P.S.tasks.filter((t) => t.state === "running"), done = P.S.tasks.filter((t) => t.state === "done");
      return `<div class="col"><div style="padding:0 4px"><div class="big">좋은 아침이에요</div><div class="meta">dotz AI가 일하는 중 · 세션 2개 · 맥북 · 오전 9:20</div></div>
      <a class="li" href="#settings/providers" style="background:var(--card);border-radius:var(--r-card)"><span class="lead"><span class="dot err"></span></span><span class="tx"><span class="hd">인스타그램 로그인이 풀렸어요</span><span class="sup">경고 · 다시 로그인해야 댓글을 볼 수 있어요</span></span><span class="end"><span class="tag err">경고</span>${ic("chev", "chev")}</span></a>
      <div class="grid2">
      <div class="full">${card("답변 필요", `<div class="list">${needs().map((n) => `<a class="li" href="#${n[0]}"><span class="lead"><span class="dot warn"></span></span><span class="tx"><span class="hd">${h(n[1])}</span><span class="sup">${h(n[2])}</span></span><span class="end"><span class="tag ${n[3] === "미답장" ? "unrep" : "warn"}">${n[3]}</span></span></a>`).join("")}</div>`, "", `<span class="bd" data-count="drafts" style="margin-left:2px">${P.pending()}</span>`)}</div>
      ${card("알림", `<div class="list">${P.S.notices.slice(0, 3).map(noticeRow).join("")}</div>`, more("notices", "모두 보기"))}
      ${card("진행 중", `<div class="list">${running.map(P.taskRow).join("")}<a class="li" href="#sessions"><span class="lead"><span class="dot work"></span></span><span class="tx"><span class="hd">공문 초안 채우기</span><span class="sup">한글 문서 자동화 · 세션</span></span><span class="end"><span class="tag pri">일하는 중</span></span></a></div>`, more("tasks", "작업"))}
      ${card("최근 끝난 작업", `<div class="list">${done.slice(0, 2).map(P.taskRow).join("")}</div>`, more("tasks", "작업"))}
      ${card("아침 점검", `<div class="big">일정 4개, 답장할 메일 2통</div>${D.calendar.slice(0, 3).map((c) => `<div class="cal"><span class="tm">${c.at}</span><span><span class="ti">${h(c.title)}</span>${c.where ? `<span class="wh">${h(c.where)}</span>` : ""}</span></div>`).join("")}`, more("briefing", "브리핑"), '<span class="tag pri">브리핑</span>')}
      ${card("모니터링", `<div class="list">${link("watch/price", "tag", "캠핑 의자 가격", '<s class="old">89,000원</s> → 72,000원', '<span class="tag pri">바뀜</span>')}${link("watch/page", "eye", "가격 페이지", "바뀐 곳 없음 · 18분 전")}</div>`, more("monitoring", "모니터링"))}
      ${card("작업내역", `<div class="list"><div class="li"><span class="tx"><span class="hd">밤 사이 정리</span><span class="sup">메일 4통 분류 · 답장할 메일 2통 표시</span></span><span class="end">오전 2:10</span></div><div class="li"><span class="tx"><span class="hd">아침 브리핑을 보냈어요</span></span><span class="end">오전 7:30</span></div></div>`, more("chat/worklog", "작업 기록"))}
      ${card("사용량", `<div class="stat"><div class="row"><span>5시간 한도</span><span class="sp"></span><b>62%</b></div><div class="bar"><i style="--p:62%"></i></div></div><div class="stat" style="margin-top:12px"><div class="row"><span>7일 한도</span><span class="sp"></span><b>38%</b></div><div class="bar"><i style="--p:38%"></i></div></div>`, more("settings/usage", "자세히"))}
      </div></div>`;
    } });

  /* 알림 */
  const noticeRow = (n) => `<a class="li${n.unread ? " unread" : ""}" href="#${n.href}" data-act="notice-open" data-nid="${n.id}"><span class="lead"><span class="dot ${n.unread ? n.tone : ""}"></span></span><span class="tx"><span class="hd">${h(n.title)}</span><span class="sup">${n.price ? `<s class="old">${n.price[0]}</s> → ${n.price[1]}` : h(n.sub)}</span></span><span class="end"><span class="tag ${tagFor(n.tone)}">${h(n.tag)}</span><span>${h(n.t)}</span></span></a>`;
  P.acts["notice-open"] = (el) => { const n = P.S.notices.find((x) => x.id === el.dataset.nid); if (n) n.unread = false; P.refreshBadges(); };

  /* 프로젝트 */
  const stTone = { pri: "pri", warn: "warn" };
  P.reg({ id: "projects", title: "프로젝트", tab: "projects", group: "프로젝트", desc: "프로젝트 목록 · 고정 · 상태",
    render: () => { const row = (p) => `<a class="li" href="#project/${p.id}"><span class="ico">${ic("folder")}</span><span class="tx"><span class="hd">${h(p.name)}</span><span class="sup">${h(p.purpose)}</span></span><span class="end">${p.need ? `<span class="bd">${p.need}</span>` : ""}<span class="tag ${stTone[p.state] || ""}">${h(p.st)}</span></span></a>`;
      return `<div class="sec">고정</div><div class="list">${D.projects.filter((p) => p.pinned).map(row).join("")}</div><div class="sec">전체</div><div class="list">${D.projects.filter((p) => !p.pinned).map(row).join("")}</div><div class="sec">세션</div><div class="list">${link("sessions", "terminal", "세션과 채널", "일하는 세션 2개 · 작업 채널 4개")}</div>`; } });
  D.projects.forEach((p) => P.reg({ id: "project/" + p.id, title: p.name, tab: "projects", back: "projects", group: "프로젝트", desc: p.purpose,
    render: () => {
      const done = p.ms.filter((m) => m[1]).length, pct = Math.round((done / p.ms.length) * 100);
      return `<div class="col"><div class="card"><div class="ch"><h3>${h(p.name)}</h3><span class="tag ${stTone[p.state] || ""}">${h(p.st)}</span><span class="ac">${h(p.upd)}</span></div><div class="meta">${h(p.purpose)}</div><div class="bar pri" style="margin-top:12px"><i data-pbar style="--p:${pct}%"></i></div><div class="meta" style="margin-top:6px"><span data-ms-n>${done}</span>/${p.ms.length} 단계 끝났어요</div></div>
      ${p.ask ? `<div class="card"><div class="ch"><h3>확인 필요</h3><span class="tag warn">답 기다림</span></div><div>${h(p.ask.ti)}</div><div class="cf"><a class="btn sm" href="#${p.ask.href}">대화에서 답하기</a></div></div>` : ""}
      <div class="sec" style="margin:12px 4px 0">단계</div><div class="list" data-ms>${p.ms.map((m, i) => `<button class="li" data-act="ms-toggle" data-i="${i}"><span class="ck-box" style="display:grid;${m[1] ? "background:var(--ok);border-color:var(--ok)" : ""}">${m[1] ? ic("check") : ""}</span><span class="tx"><span class="hd" ${m[1] ? 'style="color:var(--fg-3)"' : ""}>${h(m[0])}</span></span></button>`).join("")}</div>
      <div class="sec" style="margin:12px 4px 0">세션 ${p.lanes.length}</div><div class="list">${p.lanes.map((l) => `<a class="li" href="#chat/lane"><span class="lead"><span class="dot ${l.tone}"></span></span><span class="tx"><span class="hd">${h(l.ti)}</span><span class="sup">${h(l.n)}</span></span><span class="end"><span class="tag ${tagFor(l.tone)}">${h(l.s)}</span></span></a>`).join("")}</div>
      <div class="sec" style="margin:12px 4px 0">작업 ${p.work.length}</div>${p.work.length ? `<div class="list">${p.work.map((w) => `<div class="li"><span class="lead"><span class="dot ${w.s === "running" ? "work" : "ok"}"></span></span><span class="tx"><span class="hd">${h(w.ti)}</span></span><span class="end"><span class="tag ${w.s === "running" ? "pri" : "ok"}">${w.s === "running" ? "진행 중" : "완료"}</span></span></div>`).join("")}</div>` : '<div class="empty">진행 중인 작업이 없어요</div>'}
      <div class="sec" style="margin:12px 4px 0">결과 ${p.results.length}</div>${p.results.length ? `<div class="list">${p.results.map((r) => `<div class="li"><span class="tx"><span class="hd">${h(r.ti)}</span><span class="sup">${h(r.at)}${r.hash ? ` · <code>${r.hash}</code>` : ""}</span></span><span class="end">${r.f ? `<span class="chip" style="height:28px">${ic("file")}<span class="nm">${h(r.f)}</span></span>` : '<span class="tag">커밋</span>'}</span></div>`).join("")}</div>` : '<div class="empty">아직 결과가 없어요</div>'}
      <div class="sec" style="margin:12px 4px 0">감시 ${p.monitors.length}</div>${p.monitors.length ? `<div class="list">${p.monitors.map((m) => `<a class="li" href="#watch/${m.ok ? "page" : "price"}"><span class="lead"><span class="dot ${m.ok ? "ok" : "pri"}"></span></span><span class="tx"><span class="hd">${h(m.ti)}</span><span class="sup">${h(m.ev)}</span></span></a>`).join("")}</div>` : '<div class="empty">연결된 감시가 없어요</div>'}</div>`;
    },
    mount: (v) => { v._p = p; } }));
  P.acts["ms-toggle"] = (el) => {
    const view = $("#view"), p = D.projects.find((x) => "project/" + x.id === P.S.route.id), i = Number(el.dataset.i);
    p.ms[i][1] = p.ms[i][1] ? 0 : 1;
    const m = p.ms[i], box = $(".ck-box", el), name = $(".hd", el);
    P.mSwap(el, () => { box.style.background = m[1] ? "var(--ok)" : ""; box.style.borderColor = m[1] ? "var(--ok)" : ""; box.innerHTML = m[1] ? ic("check") : ""; name.style.color = m[1] ? "var(--fg-3)" : ""; });
    const done = p.ms.filter((x) => x[1]).length;
    $("[data-pbar]", view).style.setProperty("--p", Math.round((done / p.ms.length) * 100) + "%");
    P.roll($("[data-ms-n]", view), String(done));
  };

  const laneRow = (l) => `<a class="li" href="#chat/lane"><span class="lead"><span class="dot ${l[3]}"></span></span><span class="tx"><span class="hd">${h(l[0])}</span><span class="sup">${h(l[1])}</span></span><span class="end"><span class="tag ${tagFor(l[3])}">${h(l[2])}</span></span></a>`;
  P.reg({ id: "sessions", title: "세션과 채널", tab: "projects", back: "projects", group: "프로젝트", desc: "세션 목록 · 작업 채널 · 홈 채널",
    render: () => `<div class="sec">세션</div><div class="list">${[["공문 초안 채우기", "hdocs-fill · 한글 문서 자동화", "일하는 중", "pri"], ["가격 수집", "price-scan · 가격 조사", "일하는 중", "pri"], ["배포 공지 초안", "notes-draft · 릴리스 노트", "답을 기다려요", "warn"], ["랜딩 페이지 점검", "site-check · 랜딩 페이지", "쉬는 중", ""]].map(laneRow).join("")}</div>
    <div class="sec">작업 채널</div><div class="list">${D.projects.map((p) => `<a class="li" href="#project/${p.id}"><span class="ico">${ic("folder")}</span><span class="tx"><span class="hd">${h(p.name)}</span><span class="sup">세션 ${p.lanes.length}개 연결</span></span><span class="end">${ic("chev", "chev")}</span></a>`).join("")}</div>
    <div class="sec">홈 채널</div><div class="list">${link("chat/alert", "bell", "알림", "밖에서 오너가 필요한 일", '<span class="bd">2</span>')}${link("chat/worklog", "list", "작업 기록", "오너가 안 보는 동안 일어난 일")}</div>` });

  /* 모니터링 */
  P.reg({ id: "monitoring", title: "모니터링", tab: "monitoring", group: "모니터링", desc: "앱 · 감시 · 예약 · 답장 확인 · 다른 컴퓨터",
    render: () => `<div class="list">${link("replies", "mail", "답장 확인", "보내기를 기다리는 초안 · 메일 · 메신저 · 댓글", `<span class="bd" data-count="drafts">${P.pending()}</span>`)}</div>
    <div class="sec">앱</div><div class="list">${link("mail", "mail", "메일", "안 읽은 메일 2통", '<span class="bd">2</span>')}${link("kakao", "chat", "메신저", "지켜보는 방 3개", '<span class="tag unrep">미답장 1</span>')}${link("comments", "play", "유튜브 댓글", "답글 초안 2개")}${link("comments/instagram", "image", "인스타그램", "로그인이 풀렸어요", '<span class="tag err">연결 끊김</span>')}${link("comments/website", "globe", "웹사이트 댓글", "답글 초안 1개")}</div>
    <div class="sec">감시</div><div class="list">${link("watch/price", "tag", "캠핑 의자 가격", '<s class="old">89,000원</s> → 72,000원 · 9분 전', '<span class="tag pri">바뀜</span>')}${link("watch/page", "eye", "가격 페이지", "바뀐 곳 없음 · 18분 전", '<span class="tag ok">정상</span>')}</div>
    <div class="sec">예약</div><div class="list">${link("schedule/briefing", "clock", "아침 브리핑", "매일 오전 7:30 · 다음은 내일")}</div>
    <div class="sec">다른 컴퓨터</div><div class="list">${link("peers", "laptop", "맥미니", "감시 2 · 확인 1 · 알림 3", '<span class="bd">1</span>')}</div>
    <div class="sec">앱 관리</div><div class="list">${link("apps", "grid", "앱", "모니터링 앱과 내 앱")}</div>` });

  const spark = (pts) => `<svg viewBox="0 0 240 56" width="100%" height="56" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  P.reg({ id: "watch/price", title: "캠핑 의자 가격", tab: "monitoring", back: "monitoring", group: "모니터링", desc: "감시 상세 · 가격 변경 (취소선 → 새 값) · 확인 기록",
    render: () => `<div class="col"><div class="card"><div class="ch"><h3>캠핑 의자 가격</h3><span class="tag pri">바뀜</span><span class="ac">9분 전</span></div><div class="pv"><span class="old">89,000원</span>${ic("chev")}<span class="new">72,000원</span><span class="ch-pct">-19%</span></div><div style="margin-top:12px">${spark("0,10 40,10 80,12 120,10 160,12 200,46 240,46")}</div></div>
      <div class="list"><div class="li"><span class="tx"><span class="hd">확인 주기</span><span class="sup">바뀌면 알림으로 알려 드려요</span></span><span class="end"><div class="seg bg" data-v="1" data-seg style="background:var(--layer)"><i></i><button data-act="seg">15분</button><button class="on" data-act="seg">30분</button></div></span></div><div class="li"><span class="tx"><span class="hd">알림 받기</span></span><span class="end"><button class="sw" role="switch" aria-checked="true" data-act="sw" aria-label="알림 받기"><i></i></button></span></div></div>
      <div class="sec" style="margin:12px 4px 0">확인 기록<span class="ac"><button class="btn tonal sm" data-act="watch-now">${ic("refresh")}지금 확인</button></span></div><div class="list" data-checks><div class="li"><span class="lead"><span class="dot pri"></span></span><span class="tx"><span class="hd"><s class="old">89,000원</s> → 72,000원</span><span class="sup">가격이 바뀌었어요</span></span><span class="end">9분 전</span></div><div class="li"><span class="lead"><span class="dot ok"></span></span><span class="tx"><span class="hd">89,000원</span><span class="sup">바뀐 곳 없음</span></span><span class="end">39분 전</span></div><div class="li"><span class="lead"><span class="dot ok"></span></span><span class="tx"><span class="hd">89,000원</span><span class="sup">바뀐 곳 없음</span></span><span class="end">1시간 전</span></div></div></div>` });
  P.acts["watch-now"] = (el) => { const box = $("[data-checks]"); box.insertAdjacentHTML("afterbegin", `<div class="li"><span class="lead"><span class="dot ok"></span></span><span class="tx"><span class="hd">72,000원</span><span class="sup">바뀐 곳 없음</span></span><span class="end">방금</span></div>`); P.mIn(box.firstElementChild, "top"); };
  P.reg({ id: "watch/page", title: "가격 페이지", tab: "monitoring", back: "monitoring", group: "모니터링", desc: "감시 상세 · 바뀐 곳 없음",
    render: () => `<div class="card"><div class="ch"><h3>가격 페이지</h3><span class="tag ok">정상</span><span class="ac">18분 전</span></div><div class="meta">바뀐 곳은 없어요. 30분마다 확인해요.</div></div><div class="sec">확인 기록</div><div class="list"><div class="li"><span class="lead"><span class="dot ok"></span></span><span class="tx"><span class="hd">바뀐 곳 없음</span></span><span class="end">18분 전</span></div><div class="li"><span class="lead"><span class="dot ok"></span></span><span class="tx"><span class="hd">바뀐 곳 없음</span></span><span class="end">48분 전</span></div></div>` });
  P.reg({ id: "schedule/briefing", title: "아침 브리핑 예약", tab: "monitoring", back: "monitoring", group: "모니터링", desc: "예약 작업 상세",
    render: () => `<div class="list"><div class="li"><span class="tx"><span class="hd">반복</span></span><span class="end">매일 오전 7:30</span></div><div class="li"><span class="tx"><span class="hd">다음 실행</span></span><span class="end">내일 오전 7:30</span></div><div class="li"><span class="tx"><span class="hd">켜 두기</span></span><span class="end"><button class="sw" role="switch" aria-checked="true" data-act="sw" aria-label="켜 두기"><i></i></button></span></div></div><div class="sec">마지막 결과</div><div class="list">${link("briefing", "file", "아침 브리핑", "일정 4개 · 답장할 메일 2통", "오전 7:30")}</div>` });

  /* 답장 확인 + 빠른 처리 */
  P.reg({ id: "replies", title: "답장 확인", tab: "monitoring", back: "monitoring", group: "모니터링", desc: "보내기를 기다리는 모든 초안 (메일 · 메신저 · 댓글)",
    render: () => `<div class="row" style="margin-bottom:12px"><span class="meta">기다리는 초안 <b data-count="drafts">${P.pending()}</b>개</span><span class="sp"></span><a class="btn tonal sm" href="#triage">${ic("bolt")}빠른 처리</a></div>
    <div class="sec" style="margin-top:0">메일</div><div class="col">${P.draftCard("d-m1")}${P.draftCard("d-m3")}</div><div class="sec">메신저</div>${P.draftCard("d-k1")}<div class="sec">댓글</div><div class="col">${["d-y1", "d-y2", "d-i1", "d-w1"].map(P.draftCard).join("")}</div>` });
  const TR = ["d-y1", "d-y2", "d-i1", "d-w1"];
  P.reg({ id: "triage", title: "빠른 처리", tab: "monitoring", back: "replies", group: "모니터링", desc: "초안이 3개 넘게 쌓이면 하나씩 빠르게 답해요",
    render: () => `<div class="row" style="margin-bottom:12px"><span class="meta">댓글 답글 · <b data-tr-i>1</b> / ${TR.length}</span><span class="sp"></span><div class="bar" style="width:96px"><i data-tr-bar style="--p:${100 / TR.length}%"></i></div></div><div data-tr>${P.draftCard(TR[0])}</div><div class="note">보내거나 보내지 않으면 다음 초안으로 넘어가요.</div>`,
    mount: () => { P.S.tr = 0; } });
  document.addEventListener("dz-draft", async (e) => {
    if (!P.S.route || P.S.route.id !== "triage") return;
    if (e.detail.state !== "sent" && e.detail.state !== "skip") return;
    if (e.detail.id !== TR[P.S.tr]) return;
    await delay(700);
    const box = $("[data-tr]"); if (!box) return;
    P.S.tr += 1;
    if (P.S.tr >= TR.length) { P.mSwap(box, () => { box.innerHTML = `<div class="card"><div class="done-st" style="display:flex;gap:10px;align-items:center"><span class="big">다 처리했어요</span></div><div class="meta">기다리는 초안이 없어요.</div></div>`; }); return; }
    P.mSwap(box, () => { box.innerHTML = P.draftCard(TR[P.S.tr]); });
    P.roll($("[data-tr-i]"), String(P.S.tr + 1)); $("[data-tr-bar]").style.setProperty("--p", ((P.S.tr + 1) * 100) / TR.length + "%");
  });

  /* 댓글 */
  const cTabs = (cur) => `<div class="tabs">${[["comments", "유튜브"], ["comments/instagram", "인스타그램"], ["comments/website", "웹사이트"], ["comments/dm", "DM"]].map(([id, l]) => `<a href="#${id}" class="${id === cur ? "on" : ""}">${l}</a>`).join("")}</div>`;
  const cScreen = (id, key) => P.reg({ id, title: { youtube: "유튜브 댓글", instagram: "인스타그램 댓글", website: "웹사이트 댓글" }[key], tab: "monitoring", back: "monitoring", group: "모니터링", desc: "댓글마다 답글 초안 카드 · 보내기 · 고치기 · 보내지 않기",
    render: () => `${cTabs(id)}<div class="col">${D.comments[key].map((c) => P.draftCard(c.id)).join("")}</div>` });
  cScreen("comments", "youtube"); cScreen("comments/instagram", "instagram"); cScreen("comments/website", "website");
  P.reg({ id: "comments/dm", title: "인스타그램 DM", tab: "monitoring", back: "monitoring", group: "모니터링", desc: "DM 목록 · 읽기만 (답장은 채팅에서)",
    render: () => `${cTabs("comments/dm")}<div class="list">${D.dm.map((d) => `<button class="li" data-act="dm-open" data-id="${d.id}"><span class="av">${h(d.who.slice(0, 1))}</span><span class="tx"><span class="hd${d.n ? " b" : ""}">${h(d.who)}</span><span class="sup">${h(d.last)}</span></span><span class="end"><span>${h(d.t)}</span>${d.n ? `<span class="bd">${d.n}</span>` : ""}</span></button>`).join("")}</div><div data-dm></div><div class="note">DM은 읽기만 해요. 답장 초안은 채팅에서 만들어 달라고 해요.</div>` });
  P.acts["dm-open"] = (el) => {
    const d = D.dm.find((x) => x.id === el.dataset.id), box = $("[data-dm]");
    P.mSwap(box, () => { box.innerHTML = `<div class="sec">${h(d.who)}</div><div class="card col">${d.msgs.map((m) => `<div class="msg ${m[0] === "out" ? "me" : "bot"}" style="margin:0"><div class="bub" style="${m[0] === "out" ? "" : "background:var(--layer);padding:8px 12px;border-radius:14px"}">${h(m[1])}</div></div>`).join("")}</div>`; });
  };

  /* 메신저 */
  P.reg({ id: "kakao", title: "메신저", tab: "monitoring", back: "monitoring", group: "모니터링", desc: "지켜볼 방 고르기 · 미답장 · 안 읽음",
    render: () => `<div class="list">${D.kakao.map((r) => `<div class="li"><a class="row" style="flex:1;min-width:0;gap:12px" href="#kakao/${r.id}"><span class="av">${h(r.name.slice(0, 1))}</span><span class="tx" style="min-width:0"><span class="hd${r.unread ? " b" : ""}" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(r.name)}${r.kind === "group" ? ' <span class="meta">단체</span>' : ""}</span><span class="sup" style="display:block;font-size:12px;color:var(--fg-2)">${h(r.last)}</span></span></a><span class="end">${r.unrep ? '<span class="tag unrep">미답장</span>' : ""}${r.unread ? `<span class="bd">${r.unread}</span>` : ""}<button class="sw" role="switch" aria-checked="${r.watched}" data-act="sw" aria-label="${h(r.name)} 지켜보기"><i></i></button></span></div>`).join("")}</div><div class="note">스위치를 켜면 그 방을 지켜봐요. 단체방은 내가 불렸을 때만 알려요.</div>` });
  P.reg({ id: "kakao/r1", title: "정우", tab: "monitoring", back: "kakao", group: "모니터링", desc: "메신저 방 · 말풍선 · 답장 초안 카드",
    render: () => `<div class="col"><div class="list"><div class="li"><span class="tx"><span class="hd">자동 초안</span><span class="sup">답할 거리가 있으면 초안을 만들어요</span></span><span class="end"><button class="sw" role="switch" aria-checked="true" data-act="sw" aria-label="자동 초안"><i></i></button></span></div></div>
    <div class="kk"><div class="kd">오늘</div>${D.kakaoChat.map((m) => `<div><div class="kn" ${m[0] === "own" ? "hidden" : ""}>${h(m[1])}</div><div class="kb ${m[0] === "own" ? "own" : ""}"><div class="bb">${h(m[2])}</div><div class="kt">${h(m[3])}</div></div></div>`).join("")}</div>${P.draftCard("d-k1")}</div>` });

  /* 메일 */
  P.S.mailDel = new Set();
  const mailRow = (m) => `<a class="li${m.read ? "" : " unread"}" data-mid="${m.id}" data-act="mail-row" href="#mail/${m.id}"><span class="ck-box">${ic("check")}</span><span class="lead">${m.read ? "" : '<span class="dot pri"></span>'}</span><span class="tx"><span class="hd">${h(m.from)}${m.reply === "needs" ? ' <span class="tag warn" style="margin-left:6px">답장 필요</span>' : ""}</span><span class="sup"><b style="font-weight:${m.read ? 400 : 600}">${h(m.subject)}</b> · ${h(m.sum)}</span></span><span class="end">${m.att ? ic("clip") : ""}<span>${h(m.t)}</span></span></a>`;
  const mailTabs = (cur) => `<div class="row" style="margin-bottom:12px"><div class="tabs" style="margin:0"><a href="#mail" class="${cur === "mail" ? "on" : ""}">받은 편지함</a><a href="#mail/sent" class="${cur === "mail/sent" ? "on" : ""}">보낸 편지함</a></div><span class="sp"></span><button class="btn text sm" data-act="mail-sel">선택</button><a class="btn sm" href="#mail/compose">${ic("edit")}메일 쓰기</a></div>`;
  const mailList = (dir) => `<div class="list" data-mails>${D.mails.filter((m) => m.dir === dir && !P.S.mailDel.has(m.id)).map(mailRow).join("") || '<div class="empty">메일이 없어요</div>'}</div><div class="selbar" data-selbar hidden><span class="sp"><b data-sel-n>0</b>개 선택</span><button class="btn text sm" data-act="mail-del">${ic("trash")}삭제</button><button class="btn text sm" data-act="mail-arch">${ic("archive")}보관</button></div>`;
  P.reg({ id: "mail", title: "메일", tab: "monitoring", back: "monitoring", group: "메일", desc: "받은 편지함 · 선택 → 삭제 → 되돌리기 토스트", render: () => mailTabs("mail") + mailList("in") });
  P.reg({ id: "mail/sent", title: "보낸 편지함", tab: "monitoring", back: "monitoring", group: "메일", desc: "보낸 메일", render: () => mailTabs("mail/sent") + mailList("out") });
  P.acts["mail-sel"] = (el) => { const box = $("[data-mails]"); box.classList.toggle("selmode"); const on = box.classList.contains("selmode"); el.textContent = on ? "취소" : "선택"; $("[data-selbar]").hidden = !on; if (on) P.mIn($("[data-selbar]"), "rise"); $$(".li.on", box).forEach((l) => l.classList.remove("on")); P.roll($("[data-sel-n]"), "0"); };
  P.acts["mail-row"] = (el, e) => { const box = el.closest("[data-mails]"); if (box.classList.contains("selmode")) { e.preventDefault(); el.classList.toggle("on"); P.roll($("[data-sel-n]"), String($$(".li.on", box).length)); } };
  P.acts["mail-arch"] = () => { const rows = $$("[data-mails] .li.on"); if (!rows.length) return P.toast("보관할 메일을 골라 주세요"); rows.forEach(async (r) => { await P.mOut(r, "fade"); r.remove(); }); P.toast(`메일 ${rows.length}통을 보관했어요`); };
  P.acts["mail-del"] = async () => {
    const rows = $$("[data-mails] .li.on"); if (!rows.length) return P.toast("삭제할 메일을 골라 주세요");
    const saved = rows.map((r) => ({ id: Number(r.dataset.mid), next: r.nextElementSibling ? r.nextElementSibling.dataset.mid : null }));
    saved.forEach((s) => P.S.mailDel.add(s.id));
    await Promise.all(rows.map((r) => P.mOut(r, "fade", 150))); rows.forEach((r) => r.remove());
    P.roll($("[data-sel-n]"), "0");
    P.toast(`메일 ${rows.length}통을 휴지통으로 옮겼어요`, { undo: () => {
      const box = $("[data-mails]");
      saved.forEach((s) => { P.S.mailDel.delete(s.id); if (!box) return; const m = D.mails.find((x) => x.id === s.id), nx = s.next && $(`[data-mid="${s.next}"]`, box); if (nx) nx.insertAdjacentHTML("beforebegin", mailRow(m)); else box.insertAdjacentHTML("beforeend", mailRow(m)); P.mIn(nx ? nx.previousElementSibling : box.lastElementChild, "top"); });
    } });
  };
  D.mails.forEach((m) => P.reg({ id: "mail/" + m.id, title: m.subject, tab: "monitoring", back: m.dir === "in" ? "mail" : "mail/sent", group: "메일", desc: `${m.from} · ${m.dir === "in" ? "받은" : "보낸"} 메일${D.mailDraft[m.id] ? " · 답장 초안" : ""}`,
    render: () => `<div class="col"><div class="card"><div class="ch"><h3>${h(m.subject)}</h3></div><div class="meta">${m.dir === "in" ? "보낸 사람" : "받는 사람"} ${h(m.from)} &lt;${h(m.addr)}&gt; · ${h(m.t)}</div>
      <div class="hint" style="margin-top:12px">${ic("bolt")} 요약 · ${h(m.sum)}</div><div class="mailbody" style="margin-top:16px">${h(m.text)}</div>${m.att ? `<div class="chips" style="margin-top:12px">${m.att.map((a) => `<span class="chip">${ic("file")}<span class="nm">${h(a.name)}</span><span class="sz">${h(a.size)}</span></span>`).join("")}</div>` : ""}
      <div class="cf"><button class="btn tonal sm" data-act="mail-star">${ic("star")}별표</button><button class="btn tonal sm" data-act="toast" data-msg="보관했어요">${ic("archive")}보관</button><button class="btn text sm" data-act="mail-del-one" data-id="${m.id}">${ic("trash")}삭제</button></div></div>
      ${D.mailDraft[m.id] ? P.draftCard(D.mailDraft[m.id].id) : ""}
      ${m.id === 1 ? `<div class="sec" style="margin:12px 4px 0">같은 사람의 메일</div><div class="list"><a class="li" href="#mail/5"><span class="tx"><span class="hd">Re: 지난 회의 자료</span><span class="sup">보낸 메일 · 지난 회의 자료를 첨부해서 보냈어요</span></span><span class="end">11월 2일</span></a></div><div class="fold-box"><button data-act="fold">${ic("chevd")}보낸 답장 1건</button><pre hidden>서윤님, 지난 회의 자료 보내드려요.\n확인해 보시고 궁금한 점 알려 주세요.</pre></div>` : ""}</div>`,
    mount: () => { m.read = true; } }));
  P.acts["mail-star"] = (el) => P.mSwap(el, () => { const on = el.dataset.on !== "1"; el.dataset.on = on ? "1" : "0"; el.innerHTML = ic("star") + (on ? "별표 뺌" : "별표"); });
  P.acts.toast = (el) => P.toast(el.dataset.msg);
  P.acts["mail-del-one"] = (el) => {
    const id = Number(el.dataset.id), back = D.mails.find((m) => m.id === id).dir === "in" ? "mail" : "mail/sent";
    P.S.mailDel.add(id); location.hash = "#" + back;
    setTimeout(() => P.toast("메일 1통을 휴지통으로 옮겼어요", { undo: () => { P.S.mailDel.delete(id); if (P.S.route.id === back) { const box = $("[data-mails]"); box.insertAdjacentHTML("afterbegin", mailRow(D.mails.find((m) => m.id === id))); P.mIn(box.firstElementChild, "top"); } } }), 30);
  };
  P.reg({ id: "mail/compose", title: "메일 쓰기", tab: "monitoring", back: "mail", group: "메일", desc: "새 메일 · 보내기 → 보냈어요",
    render: () => `<div data-compose><div class="sec" style="margin-top:0">새 메일</div><div class="fgroup"><div class="rowf"><label>받는이</label><input value="오지훈 &lt;jihoon.oh@example.org&gt;" aria-label="받는이"></div><div class="rowf"><label>제목</label><input value="견적서 의견 드려요" aria-label="제목"></div><textarea aria-label="본문">지훈님, 수정본 잘 받았어요.\n금요일 오전까지 검토하고 의견 드릴게요.</textarea></div><div class="cf"><button class="btn" data-act="compose-send">보내기</button><a class="btn text" href="#mail">닫기</a></div></div>` });
  P.acts["compose-send"] = () => { const box = $("[data-compose]"); P.mSwap(box, () => { box.innerHTML = `<div class="card"><div class="done-st rc" style="display:flex;gap:10px;align-items:center;padding:0"><div class="done-st" style="width:100%"><span class="ck">${ic("check")}</span><div><div>보냈어요</div><div class="sub">오지훈 · 방금</div></div></div></div><div class="cf"><a class="btn tonal" href="#mail">받은 편지함으로</a></div></div>`; }); };

  /* 컴퓨터 */
  P.reg({ id: "peers", title: "컴퓨터", tab: "monitoring", back: "monitoring", group: "모니터링", desc: "내 컴퓨터들 · 다른 컴퓨터의 모니터링",
    render: () => `<div class="list">${D.computers.map((c) => `<button class="li" data-act="gw-pick" data-n="${h(c.name)}"><span class="ico">${ic("laptop")}</span><span class="tx"><span class="hd">${h(c.name)}${c.self ? ' <span class="tag">이 컴퓨터</span>' : ""}</span><span class="sup">${h(c.sub)}</span></span><span class="end"><span class="dot ${c.online ? "ok" : ""}"></span>${c.need ? `<span class="bd">${c.need}</span>` : ""}</span></button>`).join("")}</div>
    <div class="sec">맥미니의 모니터링</div><div class="list">${link("monitoring", "tag", "중고 모니터 가격", "맥미니가 감시 중 · 12분 전", '<span class="tag">맥미니</span>')}${link("monitoring", "mail", "답장 확인 1", "맥미니의 메일 초안", '<span class="tag warn">확인</span>')}</div>
    <div class="sec">스튜디오 PC</div><div class="list"><div class="li"><span class="tx"><span class="hd">꺼져 있어요</span><span class="sup">마지막으로 본 것은 이틀 전이에요</span></span><span class="end"><span class="tag">오래된 정보</span></span></div></div>` });

  /* 앱 */
  const appRow = (a) => `<a class="li" href="#${a.href}"><span class="ico">${ic(a.icon)}</span><span class="tx"><span class="hd">${h(a.label)}</span><span class="sup">${h(a.sub)}</span></span><span class="end"><span class="dot ${a.status === "ok" ? "ok" : a.status === "err" ? "err" : ""}"></span>${ic("chev", "chev")}</span></a>`;
  const appsHtml = () => `<div class="sec" style="margin-top:0">모니터링 앱</div><div class="list">${D.apps.filter((a) => a.kind === "monitor").map(appRow).join("")}</div><div class="sec">내 앱<span class="ac"><button class="btn tonal sm" data-act="app-add">${ic("plus")}앱 추가</button></span></div><div class="list" data-apps>${D.apps.filter((a) => a.kind === "tool").map(appRow).join("")}</div><div class="sec">앱 설정</div><div class="list">${link("apps/settings", "sliders", "메신저 설정 대화", "대화로 설정을 바꿔요")}</div>`;
  const addSheet = () => P.sheet({ title: "앱 추가", cls: "mid", body: `<label class="lbl" style="margin-top:0">앱 이름</label><input class="field" data-app-name placeholder="예: 일정 보기"><div class="sec" style="margin:16px 0 8px">만들어 둔 틀</div><div class="list" style="background:var(--layer)">${D.appTemplates.map((t) => `<button class="li" data-act="app-tpl" data-t="${h(t[0])}"><span class="tx"><span class="hd">${h(t[0])}</span><span class="sup">${h(t[1])}</span></span></button>`).join("")}</div>`, foot: `<button class="btn text" data-act="sheet-close">취소</button><button class="btn" data-act="app-add-do">추가</button>` });
  P.reg({ id: "apps", title: "앱", tab: "monitoring", back: "monitoring", group: "모니터링", desc: "모니터링 앱 · 내 앱 · 앱 추가", render: appsHtml });
  P.reg({ id: "apps/add", title: "앱", tab: "monitoring", back: "monitoring", group: "모니터링", desc: "앱 추가 시트가 아래에서 올라와요", render: appsHtml, mount: () => setTimeout(addSheet, 60) });
  P.acts["app-add"] = () => addSheet();
  P.acts["app-tpl"] = (el) => { $("[data-app-name]").value = el.dataset.t; };
  P.acts["app-add-do"] = async () => {
    const name = ($("[data-app-name]").value || "").trim() || "새 앱";
    await P.closeSheet();
    const box = $("[data-apps]"); if (!box) return;
    D.apps.push({ id: "n" + Date.now(), label: name, icon: "grid", kind: "tool", status: "ok", sub: "방금 추가했어요", href: "app/memo" });
    box.insertAdjacentHTML("afterbegin", appRow(D.apps[D.apps.length - 1])); P.mIn(box.firstElementChild, "top"); P.toast(`${name}을 추가했어요`);
  };
  P.reg({ id: "app/memo", title: "메모장", tab: "monitoring", back: "apps", group: "모니터링", desc: "내 앱 화면 · 요소 고르기",
    render: () => `<div class="row" style="margin-bottom:12px"><span class="meta">앱 화면 안의 요소를 골라 메시지에 붙일 수 있어요</span><span class="sp"></span><button class="btn tonal sm" data-act="pick-toggle">${ic("pointer")}요소 고르기</button></div><div class="frame" data-frame><div class="fbar">${ic("lock")}/apps/memo/</div><div class="fbody col"><div data-pk="제목 입력칸" class="field">오늘 할 일</div><div data-pk="메모 목록" class="list" style="background:var(--layer)"><div class="li"><span class="hd">견적서 검토</span></div><div class="li"><span class="hd">램프 도착 확인</span></div></div><button class="btn sm" data-pk="저장 버튼" style="width:auto">저장</button></div></div><div class="chips" data-picked style="margin-top:12px"></div>` });
  P.acts["pick-toggle"] = (el) => { const f = $("[data-frame]"); f.classList.toggle("pick-on"); el.textContent = f.classList.contains("pick-on") ? "끄기" : "요소 고르기"; };
  document.addEventListener("click", (e) => { const t = e.target.closest("[data-pk]"); if (t && t.closest(".pick-on")) { const box = $("[data-picked]"); box.insertAdjacentHTML("beforeend", `<span class="chip">${ic("pointer")}<span class="nm">${h(t.dataset.pk)}</span></span>`); P.mIn(box.lastElementChild, "rise", 150); } });
  P.reg({ id: "apps/settings", title: "메신저 설정", tab: "monitoring", back: "apps", group: "모니터링", desc: "앱 설정 대화 · 바꿀 값을 확인받고 적용",
    render: () => `<div class="cv" style="min-height:0"><div class="tl"><div class="msg me"><div class="bub">확인 주기를 10분으로 바꾸고 자동 초안은 꺼 줘</div></div><div class="msg bot"><div class="bub"><div class="st"><span class="tag ok">완료</span><span>이렇게 바꿀까요?</span></div><div class="lb" data-chg><div class="li"><span class="tx"><span class="hd">확인 주기</span></span><span class="end"><s class="old">5분</s> → 10분</span></div><div class="li"><span class="tx"><span class="hd">자동 초안</span></span><span class="end"><s class="old">켬</s> → 끔</span></div></div><div class="cf" data-chg-btn><button class="btn sm" data-act="chg-ok">적용</button><button class="btn text sm" data-act="toast" data-msg="바꾸지 않았어요">취소</button></div></div></div></div></div>
    <div class="sec">지금 값</div><div class="list"><div class="li"><span class="tx"><span class="hd">새 메시지 알림</span><span class="sup">지켜보는 방에 새 메시지가 오면 알려 줘요</span></span><span class="end"><button class="sw" role="switch" aria-checked="true" data-act="sw" aria-label="새 메시지 알림"><i></i></button></span></div><div class="li"><span class="tx"><span class="hd">말투</span><span class="sup">초안을 쓸 때 따라 할 말투예요</span></span><span class="end"><div class="seg" data-v="0"><i></i><button class="on" data-act="seg">내 말투</button><button data-act="seg">존댓말</button></div></span></div><div class="li"><span class="tx"><span class="hd">확인 주기</span><span class="sup">새 메시지를 몇 분마다 볼지 정해요</span></span><span class="end"><span class="stepper"><button class="ib" data-act="step" data-d="-1" aria-label="줄이기">−</button><span data-step>5</span><button class="ib" data-act="step" data-d="1" aria-label="늘리기">+</button></span><span>분</span></span></div></div>` });
  P.acts["chg-ok"] = (el) => { const b = el.closest("[data-chg-btn]"); P.mSwap(b, () => { b.innerHTML = '<span class="tag ok">적용했어요</span>'; }); const s = $("[data-step]"); if (s) P.roll(s, "10"); };
  P.acts.step = (el) => { const s = $("[data-step]"); P.roll(s, String(Math.max(1, Math.min(60, Number(s.textContent) + Number(el.dataset.d))))); };

  P.reg({ id: "canvas", title: "캔버스", tab: "chat", back: "chat", group: "채팅", desc: "봇이 만든 HTML 페이지를 파일 칩에서 열어 봐요",
    render: () => `<div class="row" style="margin-bottom:12px">${P.fileChip("/Users/me/landing/미리보기.html")}<span class="sp"></span><button class="btn tonal sm" data-act="toast" data-msg="새 탭에서 열어요 (프로토타입에서는 열지 않아요)">${ic("link")}새 탭</button></div><div class="frame"><div class="fbar">${ic("lock")}샌드박스 페이지</div><div class="fbody col"><div class="big">내 기기에서 계속 도는 비서</div><div style="color:var(--fg-2)">대화로 맡기고, 승인하고, 결과를 받아요.</div><div class="btns"><span class="btn sm" style="pointer-events:none">시작하기</span></div></div></div>` });
  P.reg({ id: "palette", title: "검색", tab: "home", back: "home", group: "홈", desc: "명령 팔레트 (⌘K) · 화면 이름으로 찾기", render: () => P.routes.home.render(), mount: () => setTimeout(() => P.openPalette(), 60) });

  Object.assign(P.acts, {
    sw: (el) => { el.setAttribute("aria-checked", String(el.getAttribute("aria-checked") !== "true")); },
    seg: (el) => { const s = el.closest(".seg"); $$("button", s).forEach((b, i) => { b.classList.toggle("on", b === el); if (b === el) s.dataset.v = String(i); }); },
  });
})();
