/* dotz demo fixtures: everything here is invented. No real people, companies, addresses or channels.
   The demo transport (demo-api.js) answers /api/* from this store; typed messages and the scripted replies are appended here too. */
(() => {
  const now = Date.now();
  const ago = m => new Date(now - m * 60_000).toISOString();
  const MODEL = "dotz/dotz-ai";
  const model = { provider: "dotz", selector: MODEL, name: "dotz AI", family: "dotz AI", reasoning: true, thinking: [] };
  const la = { name: "site-check", title: "랜딩 페이지 점검", status: "idle", live: true, home: "ch:1", model: MODEL, startedAt: ago(58), lastText: "배포 전 점검 목록을 정리했어요" };

  // 메일: received (dir "in") and sent (dir "out"). Addresses are on the reserved example.* domains.
  const CAN = ["read", "unread", "archive", "unarchive", "star", "unstar", "trash"];
  const mails = [
    {
      key: "m-1", at: ago(47), dir: "in", read: false, reply: "needs",
      from: "한서윤 <seoyun.han@example.com>", to: "나 <me@example.com>", name: "한서윤", short: "서윤님",
      subject: "다음 주 미팅 일정 확인 부탁드려요",
      summary: "다음 주 미팅 시간을 화요일 오후 2시와 수요일 오전 10시 중에서 골라 달라는 메일이에요.",
      text: "안녕하세요.\n\n다음 주 미팅 시간을 정하려고 해요.\n화요일 오후 2시나 수요일 오전 10시 중에\n편한 시간을 알려 주세요.\n\n한서윤 드림",
    },
    {
      key: "m-2", at: ago(95), dir: "in", read: false, reply: "fyi",
      from: "별빛상회 주문팀 <orders@example.net>", to: "나 <me@example.com>", name: "별빛상회 주문팀", short: "주문팀", org: true,
      subject: "주문하신 책상 램프가 출발했어요",
      summary: "책상 램프가 오늘 출발했고 목요일에 도착한다는 배송 안내예요. 답장은 필요 없어요.",
      text: "주문하신 책상 램프가 오늘 출발했어요.\n도착 예정일은 목요일이에요.\n\n별빛상회 드림",
    },
    {
      key: "m-3", at: ago(180), dir: "in", read: true, reply: "needs",
      from: "오지훈 <jihoon.oh@example.org>", to: "나 <me@example.com>", name: "오지훈", short: "지훈님",
      subject: "견적서 수정본 보내드려요",
      summary: "견적서 수정본이 첨부돼 있고, 금요일까지 의견을 달라는 메일이에요.",
      text: "안녕하세요.\n\n말씀하신 부분을 고친 견적서를 보내드려요.\n금요일까지 의견 주시면\n다음 주에 확정할게요.\n\n오지훈 드림",
      attachments: [{ name: "견적서-수정본.pdf", size: 182000 }],
    },
    {
      key: "m-4", at: ago(420), dir: "in", read: true, reply: "fyi",
      from: "달무리 소식지 <news@example.com>", to: "나 <me@example.com>", name: "달무리 소식지", short: "소식지", org: true,
      subject: "11월 첫째 주 소식",
      summary: "새 기능 소개와 다음 달 일정이 담긴 소식지예요.",
      text: "11월 첫째 주 소식이에요.\n\n- 새 기능 두 가지\n- 다음 달 모임 일정",
    },
    {
      key: "s-1", at: ago(1500), dir: "out", read: true,
      from: "나 <me@example.com>", to: "한서윤 <seoyun.han@example.com>", name: "한서윤", short: "서윤님",
      subject: "Re: 지난 회의 자료",
      summary: "지난 회의 자료를 첨부해서 보냈어요.",
      text: "서윤님, 지난 회의 자료 보내드려요.\n확인해 보시고 궁금한 점 알려 주세요.",
    },
    {
      key: "s-2", at: ago(2900), dir: "out", read: true,
      from: "나 <me@example.com>", to: "오지훈 <jihoon.oh@example.org>", name: "오지훈", short: "지훈님",
      subject: "Re: 견적 문의",
      summary: "견적 범위를 정리해서 보냈어요.",
      text: "지훈님, 견적 범위를 정리해 보내드려요.\n수정할 부분이 있으면 말씀해 주세요.",
    },
  ];
  const mailCard = m => ({ subject: m.subject, from: m.from, to: m.to, at: m.at, summary: m.summary, preview: m.text.split("\n").find(l => l.trim()) || "", dir: m.dir, read: m.read, ...(m.reply ? { reply: m.reply } : {}), can: CAN, attachments: m.attachments || [] });
  const mailEvent = m => ({ ts: m.at, kind: "mail", source: "mail", target: `mail:${m.key}`, subject: m.subject, from: m.from, to: m.to, summary: m.summary, preview: mailCard(m).preview, attachments: m.attachments || [], text: m.text });

  // 오늘·내일 일정 (아침 브리핑과 일정 질문이 읽어요)
  const calendar = {
    today: [
      { at: "10:00", title: "주간 회의", where: "온라인" },
      { at: "13:00", title: "점심", where: "한서윤님과" },
      { at: "15:30", title: "견적서 검토", where: "오지훈님 자료" },
      { at: "19:00", title: "운동", where: "" },
    ],
    tomorrow: [
      { at: "09:30", title: "치과 예약", where: "" },
      { at: "14:00", title: "디자인 리뷰", where: "온라인" },
    ],
  };

  // 댓글 (유튜브·인스타그램·웹사이트): 답글 초안의 재료
  const comments = [
    { n: 1, platform: "유튜브", author: "구름산책", text: "영상에 나온 키보드는 어디서 사요?", reply: ["영상 설명란에 구매 링크를 달아 뒀어요.", "봐 주셔서 고마워요!"], short: ["설명란에 링크 있어요. 고마워요!"] },
    { n: 2, platform: "인스타그램", author: "달빛고양이", text: "다음 라이브는 언제 해요?", reply: ["이번 주 금요일 저녁 8시에 해요.", "알림 설정해 두시면 바로 알려 드릴게요."], short: ["금요일 저녁 8시에 해요!"] },
    { n: 3, platform: "웹사이트", author: "방문자 민트", text: "환불 문의는 어디로 하면 되나요?", reply: ["문의하기 페이지에 남겨 주시면", "하루 안에 답드릴게요."], short: ["문의하기 페이지에 남겨 주세요."] },
  ];

  const histories = {
    main: [
      { ts: ago(1442), kind: "message", source: "web", channel: "web", target: "main", text: "서윤님한테 지난 회의 자료 보내 줘" },
      { ts: ago(1441), kind: "out", source: "orchestrator", target: "main", text: "[done] 보냈어요.\n\n- 받는이: 한서윤\n- 제목: Re: 지난 회의 자료" },
      { ts: ago(62), kind: "message", source: "web", channel: "web", target: "main", text: "아침 브리핑 해 줘" },
      { ts: ago(61), kind: "out", source: "orchestrator", target: "main", text: "좋은 아침이에요. 오늘은 이래요.\n\n- 일정 4개, 첫 일정은 10시 주간 회의예요\n- 안 읽은 메일 2통, 답장할 메일 2통\n- 감시 중인 페이지는 변화 없어요" },
      { ts: ago(31), kind: "message", source: "web", channel: "web", target: "main", text: "오늘 일정이랑 메일 묶어서 브리핑해 줘" },
      { ts: ago(30), kind: "out", source: "orchestrator", target: "main", text: "좋은 아침이에요. 아침 브리핑이에요.\n\n오늘 일정 4개\n- 10:00 팀 주간 회의\n- 13:00 한서윤님과 점심\n- 15:30 견적서 검토\n- 19:00 운동\n\n새 메일 2통, 답장할 메일 2통이에요.\n댓글 3개가 답글을 기다려요.\n\n하나씩 볼까요?" },
      { ts: ago(14), kind: "out", source: "gateway", target: "main", system: true, worker: "st_report", text: "백그라운드 작업으로 맡겼어요: 주간 보고서 정리" },
      { ts: ago(4), kind: "out", source: "gateway", target: "main", system: true, worker: "st_price", text: "백그라운드 작업으로 맡겼어요: 경쟁 서비스 가격 조사" },
      { ts: ago(8), kind: "out", source: "orchestrator", target: "main", text: "dotz 데모예요. 실제로 보내지 않으니\n편하게 말 걸어 보세요.\n\n- 메일 정리해 줘\n- 오늘 일정 알려 줘\n- 댓글 답글 써 줘\n- 가격 페이지 바뀌면 알려 줘\n- 매일 아침 9시에 브리핑해 줘\n- 경쟁 서비스 가격 조사해 줘" },
    ],
    alert: [
      { ts: ago(35), kind: "out", source: "gateway", target: "alert", text: "댓글 3개에 답글을 달 수 있어요. 채팅에서 \"댓글 답글 써 줘\"라고 해 보세요." },
      { ts: ago(18), kind: "out", source: "gateway", target: "alert", text: "[가격 페이지] 확인했어요. 바뀐 곳은 없어요." },
    ],
    worklog: [
      { ts: ago(310), kind: "out", source: "gateway", target: "worklog", text: "밤 사이 정리 기록\n\n- 메일 4통을 분류했어요\n- 답장할 메일 2통을 표시했어요\n- 가격 페이지를 6번 확인했어요" },
      { ts: ago(61), kind: "out", source: "gateway", target: "worklog", text: "아침 브리핑을 보냈어요." },
    ],
    "ch:1": [
      { ts: ago(52), kind: "message", source: "web", channel: "web", target: "ch:1", text: "랜딩 페이지 첫 화면 문구를 조금 더 짧게 다듬어 줘" },
      { ts: ago(51), kind: "out", source: "orchestrator", target: "ch:1", text: "[done] 두 가지로 나눠 봤어요.\n\n- 제목: 내 기기에서 계속 도는 비서\n- 설명: 대화로 맡기고, 승인하고, 결과를 받아요" },
      { ts: ago(30), kind: "message", source: "web", channel: "web", target: "ch:1", text: "점검 목록도 같이 만들어 줘" },
      { ts: ago(29), kind: "out", source: "orchestrator", target: "ch:1", text: "[done] 배포 전 점검 목록이에요.\n\n- 제목과 설명 문구 확인\n- 링크와 이미지 확인\n- 모바일 화면 확인" },
    ],
    "ch:2": [
      { ts: ago(190), kind: "message", source: "web", channel: "web", target: "ch:2", text: "릴리스 노트 항목을 정리해 줘" },
      { ts: ago(189), kind: "out", source: "orchestrator", target: "ch:2", text: "[done] 초안을 정리했어요.\n\n- 새로 추가한 것: 데모 페이지\n- 고친 것: 모바일 문구 줄바꿈\n- 남은 것: 배포 공지" },
      {
        ts: ago(20), kind: "out", source: "orchestrator", target: "ch:2",
        text: "[ask] 배포 공지를 어떤 형태로 정리할까요?\n\n결정: 공지 형태\n1) 짧은 공지 ← 추천\n한 문단으로 핵심만 전해요\n2) 목록 공지\n바뀐 항목을 순서대로 적어요\n3) 공지 없이 배포\n릴리스 노트만 남겨요",
      },
    ],
    "lane:site-check": [
      { ts: ago(58), kind: "out", source: "lane:site-check", lane: "site-check", target: "lane:site-check", text: "점검을 시작했어요. 문구, 링크, 모바일 세 가지를 봐요." },
      { ts: ago(57), kind: "lane_report", source: "lane:site-check", lane: "site-check", target: "lane:site-check", text: "[done] 배포 전 점검 목록을 정리했어요.\n\n- 문구: 확인\n- 링크: 확인\n- 모바일: 확인" },
    ],
  };
  for (const m of mails) histories[`mail:${m.key}`] = [mailEvent(m)];

  const state = {
    name: "dotz",
    orchestrator: { status: "idle", model: MODEL },
    lanes: [la],
    terminals: {},
    channels: { work: { "1": "랜딩 페이지", "2": "릴리스 노트" }, homes: { "site-check": "1" }, lanes: {}, threads: {} },
    discord: {},
    notices_unread: 3,
    work: [
      { id: "st_price", description: "경쟁 서비스 가격 조사", status: "running", started_at: now - 4 * 60_000, model: "dotz AI" },
      { id: "st_report", description: "주간 보고서 정리", status: "done", started_at: now - 14 * 60_000, ended_at: now - 3 * 60_000, files: [{ path: "reports/주간-보고서.md", name: "주간-보고서.md", size: 2400 }] },
      { id: "st_demo", description: "배포 공지 초안 다듬기", status: "done", started_at: now - 23 * 60_000, ended_at: now - 9 * 60_000 },
      { id: "st_night", description: "밤 사이 메일 분류", status: "done", started_at: now - 320 * 60_000, ended_at: now - 290 * 60_000 },
    ],
    runs: {},
    work_now: now,
    web_build: "",
  };

  const conversations = [
    { target: "main", last: { ts: ago(8), text: "dotz 데모예요. 편하게 말 걸어 보세요.", from: "bot" }, unread: 0, read: ago(8) },
    { target: "alert", last: { ts: ago(18), text: "[가격 페이지] 확인했어요. 바뀐 곳은 없어요.", from: "bot" }, unread: 2, read: null },
    { target: "worklog", last: { ts: ago(61), text: "아침 브리핑을 보냈어요.", from: "bot" }, unread: 0, read: ago(61) },
    { target: "ch:1", last: { ts: ago(29), text: "배포 전 점검 목록이에요", from: "bot" }, unread: 0, read: ago(29) },
    { target: "ch:2", last: { ts: ago(20), text: "배포 공지를 어떤 형태로 정리할까요?", from: "bot" }, unread: 1, read: ago(189) },
    { target: "lane:site-check", last: { ts: ago(57), text: "배포 전 점검 목록을 정리했어요", from: "session" }, unread: 0, read: ago(57) },
    ...mails.map(m => ({ target: `mail:${m.key}`, last: { ts: m.at, text: m.subject, from: m.dir === "out" ? "owner" : "bot" }, unread: m.read ? 0 : 1, read: m.read ? m.at : null, mail: mailCard(m) })),
  ];

  const integrations = [
    { key: "mail", label: "메일", icon: "mail", conv: ["mail:"], notices: ["n-demo-1"], state: "connected" },
  ];
  const monitors = [
    { name: "가격 페이지", kind: "watch", watch: "price-page", scope: "plain", last_run: ago(18), next_run: new Date(now + 12 * 60_000).toISOString(), last_result: "ok" },
    { name: "아침 브리핑", kind: "schedule", watch: "", scope: "plain", last_run: ago(61), next_run: new Date(now + 20 * 3600_000).toISOString(), last_result: "ok" },
  ];

  const projects = [
    {
      key: "ch:1", name: "랜딩 페이지", pinned: true, recordKey: "ch:1",
      channel: { id: "1", name: "랜딩 페이지" },
      record: { title: "랜딩 페이지", purpose: "첫 화면 문구와 배포 전 점검", updated: ago(29), milestones: [{ text: "문구 확정", done: true }, { text: "링크 점검", done: true }, { text: "모바일 점검", done: false }] },
      lanes: [{ name: "site-check", title: "랜딩 페이지 점검", live: true, status: "idle", home: "ch:1", startedAt: ago(58) }],
    },
    {
      key: "ch:2", name: "릴리스 노트", pinned: false, recordKey: "ch:2",
      channel: { id: "2", name: "릴리스 노트" },
      record: { title: "릴리스 노트", purpose: "이번 주 변경 사항 정리", updated: ago(20), milestones: [{ text: "항목 정리", done: true }, { text: "배포 공지", done: false }] },
      lanes: [],
    },
  ];

  const todo = {
    phases: [
      { name: "오늘 할 일", tasks: [
        { content: "서윤님 미팅 메일 답장", status: "in_progress" },
        { content: "견적서 수정본 검토", status: "pending" },
        { content: "댓글 답글 정리", status: "pending" },
      ] },
      { name: "이번 주", tasks: [{ content: "배포 공지 형태 정하기", status: "pending" }] },
    ],
  };

  // Running subagents of the main chat and one message waiting for the running task (GET /api/subagents, /api/queue).
  const subagents = { sources: { orchestrator: [
    { id: "sa-1", status: "running", agent: "researcher", description: "경쟁 서비스 가격 조사", intent: "가격 페이지 3곳의 요금표를 모으고 있어요", started_at: now - 4 * 60_000 },
    { id: "sa-2", status: "running", agent: "writer", description: "조사 결과 표 정리", intent: "요금제별 비교표 초안을 만들고 있어요", started_at: now - 90_000 },
  ] } };
  const queue = { items: [{ id: "q-demo-1", target: "main", text: "끝나면 요금제별 표로 보여 줘" }] };

  const notices = {
    unread: 3,
    items: [
      { id: "n-demo-1", kind: "notice", cls: "news", tone: "", src: "mail:m-1", open: "mail:m-1", at: ago(47), title: "한서윤님 메일에 답장이 필요해요", read: false },
      { id: "n-demo-2", kind: "notice", cls: "news", tone: "", src: "ch:2", open: "ch:2", at: ago(20), title: "배포 공지 형태를 정해 주세요", read: false },
      { id: "n-demo-3", kind: "notice", cls: "alert", tone: "", src: "alert", open: "alert", at: ago(35), title: "댓글 3개에 답글을 달 수 있어요", read: false },
      { id: "n-demo-4", kind: "notice", cls: "news", tone: "", src: "worklog", open: "worklog", at: ago(310), title: "밤 사이 정리를 마쳤어요", read: true },
    ],
    gone: [],
  };

  const canvases = {
    "notes/release.md": "# 릴리스 노트\n\n- 데모 페이지 추가\n- 모바일 문구 정리\n",
    "notes/landing.md": "# 랜딩 페이지\n\n- 제목: 내 기기에서 계속 도는 비서\n- 설명: 대화로 맡기고, 승인하고, 결과를 받아요\n",
  };
  // [file] lines in scripted replies open these through GET /api/file.
  const files = { "reports/주간-보고서.md": "# 주간 보고서\n\n- 이번 주 한 일: 메일 정리, 댓글 답글, 감시 설정\n- 다음 주 할 일: 견적 확정, 배포 공지\n" };

  window.DEMO_FIXTURES = {
    now, ago, MODEL, model, la, mails, mailCard, mailEvent, calendar, comments, histories, state, conversations,
    integrations, monitors, projects, todo, subagents, queue, notices, canvases, files,
  };
})();
