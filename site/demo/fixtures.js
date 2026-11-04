/* dotz demo fixtures: everything here is invented. No real people, companies, addresses or channels.
   The demo transport (demo-api.js) answers /api/* from this store; typed messages and the scripted replies are appended here too. */
(() => {
  const now = Date.now();
  const ago = m => new Date(now - m * 60_000).toISOString();
  const MODEL = "dotz/dotz-ai";
  const model = { provider: "dotz", selector: MODEL, name: "dotz AI", family: "dotz AI", reasoning: true, thinking: [] };
  // The times of the two open questions: the notice's decision.reply_to must equal its asking message's ts.
  const T_ASK2 = ago(20), T_ASKM1 = ago(40);
  const la = { name: "site-check", title: "랜딩 페이지 점검", status: "idle", live: true, home: "ch:1", model: MODEL, startedAt: ago(58), lastText: "배포 전 점검 목록을 정리했어요" };

  // 메일: received (dir "in") and sent (dir "out"). Addresses are on the reserved example.* domains.
  const CAN = ["read", "unread", "archive", "unarchive", "star", "unstar", "trash"];
  const mails = [
    {
      key: "m-1", at: ago(47), dir: "in", read: false, reply: "draft", suggest: { kind: "reply-draft", label: "메일 초안", ref: "dr-m1", state: "draft", at: ago(40) },
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
    {
      // a sent mail the collector stored with its html body: no summary, the row and the event carry only the start of the body (hub/mail.ts sentMailEvent)
      key: "s-3", at: ago(1000), dir: "out", read: true, html: true,
      from: "나 <me@example.com>", to: "서하은 <haeun.seo@example.com>", name: "서하은", short: "하은님",
      subject: "견적 일정 안내드려요",
      text: "하은님, 안녕하세요.\n요청하신 견적은 이번 주 금요일까지 정리해서 보내드릴게요.\n먼저 범위와 일정부터 맞춰 보면 좋겠어요.\n\n- 1차 범위 확정: 수요일\n- 견적서 전달: 금요일\n\n궁금한 점은 편하게 말씀해 주세요.",
    },
  ];
  const mailBody = m => m.html ? "<!doctype html><meta charset=utf-8><body style=\"font:15px/1.6 sans-serif;margin:16px\">" + m.text.split("\n").map(l => l.trim() ? "<p>" + l + "</p>" : "").join("") + "</body>" : "";
  const mailCard = m => ({ subject: m.subject, from: m.from, to: m.to, at: m.at, summary: m.summary, preview: m.html ? m.text.split("\n").filter(l => l.trim()).slice(0, 3).join("\n") : m.text.split("\n").find(l => l.trim()) || "", dir: m.dir, read: m.read, ...(m.html ? { html: true } : {}), ...(m.reply ? { reply: m.reply } : {}), ...(m.suggest ? { suggest: m.suggest } : {}), can: CAN, attachments: m.attachments || [] });
  const mailEvent = m => m.dir === "out" && m.html ? ({ ts: m.at, kind: "mail", dir: "out", source: "mail", target: `mail:${m.key}`, mail: m.key, conv: `mail:${m.key}`, subject: m.subject, from: m.from, to: m.to, preview: mailCard(m).preview, html: true, attachments: [], text: `${m.from} · ${m.subject}\n\n${m.text.split("\n").filter(l => l.trim()).slice(0, 3).join("\n")}` }) : ({ ts: m.at, kind: "mail", source: "mail", target: `mail:${m.key}`, mail: m.key, conv: `mail:${m.key}`, subject: m.subject, from: m.from, to: m.to, summary: m.summary, preview: mailCard(m).preview, attachments: m.attachments || [], text: `${m.subject}\n${m.summary}\n\n\`\`\`원문\n${m.text}\n\`\`\`` });

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
      { ts: ago(22), kind: "out", source: "orchestrator", target: "main", text: "[run] 캠핑 의자 가격이 바뀌었어요.\n\n- 캠핑 의자 89,000원 → 72,000원" },
      { ts: ago(18), kind: "out", source: "orchestrator", target: "main", text: "[fail] 인스타그램 확인에 실패했어요.\n\n- 원인: 로그인이 풀렸어요\n- 다음: 설정에서 다시 로그인해 주세요" },
      { ts: ago(14), kind: "out", source: "gateway", target: "main", system: true, worker: "st_report", text: "백그라운드 작업으로 맡겼어요: 주간 보고서 정리" },
      { ts: ago(4), kind: "out", source: "gateway", target: "main", system: true, worker: "st_price", text: "백그라운드 작업으로 맡겼어요: 경쟁 서비스 가격 조사" },
      { ts: ago(8), kind: "out", source: "orchestrator", target: "main", text: "dotz 데모예요. 실제로 보내지 않으니\n편하게 말 걸어 보세요.\n\n- 메일 정리해 줘\n- 오늘 일정 알려 줘\n- 댓글 답글 써 줘\n- 가격 페이지 바뀌면 알려 줘\n- 매일 아침 9시에 브리핑해 줘\n- 경쟁 서비스 가격 조사해 줘" },
    ],
    alert: [
      { ts: ago(35), kind: "out", source: "gateway", target: "alert", text: "댓글 3개에 답글을 달 수 있어요. 채팅에서 \"댓글 답글 써 줘\"라고 해 보세요." },
      { ts: ago(18), kind: "out", source: "gateway", target: "alert", text: "[가격 페이지] 확인했어요. 바뀐 곳은 없어요." },
      { ts: ago(9), kind: "out", source: "gateway", target: "alert", text: "[캠핑 의자 가격] 가격이 바뀌었어요.\n\n- 캠핑 의자 89,000원 → 72,000원" },
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
        ts: T_ASK2, kind: "out", source: "orchestrator", target: "ch:2",
        text: "[ask] 배포 공지를 어떤 형태로 정리할까요?\n\n결정: 공지 형태\n1) 짧은 공지 ← 추천\n한 문단으로 핵심만 전해요\n2) 목록 공지\n바뀐 항목을 순서대로 적어요\n3) 공지 없이 배포\n릴리스 노트만 남겨요",
      },
    ],
    "lane:site-check": [
      { ts: ago(58), kind: "out", source: "lane:site-check", lane: "site-check", target: "lane:site-check", text: "점검을 시작했어요. 문구, 링크, 모바일 세 가지를 봐요." },
      { ts: ago(57), kind: "lane_report", source: "lane:site-check", lane: "site-check", target: "lane:site-check", text: "[done] 배포 전 점검 목록을 정리했어요.\n\n- 문구: 확인\n- 링크: 확인\n- 모바일: 확인" },
    ],
  };
  for (const m of mails) histories[`mail:${m.key}`] = [mailEvent(m)];
  histories["settings:kakao"] = [
    { ts: ago(12), kind: "message", source: "web", channel: "web", target: "settings:kakao", text: "확인 주기를 10분으로 바꾸고 자동 초안은 꺼 줘" },
    { ts: ago(11), kind: "out", source: "orchestrator", target: "settings:kakao", text: "[done] 이렇게 바꿀까요?\n\n```dotz-settings\n{\"app\":\"kakao\",\"changes\":{\"every_minutes\":10,\"auto_draft\":false}}\n```" },
  ];

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
    { key: "kakao", label: "카카오톡", icon: "chat", conv: ["kakao:"], notices: [], state: "connected" },
  ];

  // 카카오톡: the room list (GET /api/kakao/rooms) and one room's chat (GET /api/kakao/chat/<id>), epoch milliseconds like the real hub.
  const kakaoRooms = [
    { chatId: "r1", name: "정우", kind: "direct", watched: true, autoDraft: true, unread: 2, unreplied: true, lastAt: now - 6 * 60_000 },
    { chatId: "r2", name: "캠핑 모임", kind: "group", watched: true, autoDraft: false, unread: 14, lastAt: now - 38 * 60_000 },
    { chatId: "r3", name: "엄마", kind: "direct", watched: true, autoDraft: false, unread: 0, lastAt: now - 26 * 3600_000 },
    { chatId: "r4", name: "동네 이웃", kind: "group", watched: false, autoDraft: false, unread: 0, lastAt: now - 3 * 86400_000 },
    { chatId: "r5", name: "나와의 채팅", kind: "self", watched: false, autoDraft: false, unread: 0, lastAt: now - 5 * 86400_000 },
  ];
  const kakaoChat = {
    r1: { room: { chatId: "r1", name: "정우", kind: "direct", group: false, watched: true }, read: null, kakaoUnread: 2, sends: [],
      drafts: [{ code: "dk1", text: "가는 길에 마트에 들러서 사자.\n내가 사 갈게!", parts: ["가는 길에 마트에 들러서 사자.", "내가 사 갈게!"], basisLogId: "104", created: now - 5 * 60_000 }], messages: [
      { id: 1, logId: "101", authorId: "u2", sender: "정우", text: "형, 이번 주말에 캠핑 가기로 한 거 기억나?", type: 1, sentAt: now - 52 * 60_000, fromMe: false, unread: 0 },
      { id: 2, logId: "102", authorId: "u1", sender: "나", text: "응, 토요일 아침에 출발하자", type: 1, sentAt: now - 49 * 60_000, fromMe: true, unread: 0 },
      { id: 3, logId: "103", authorId: "u2", sender: "정우", text: "좋아. 의자는 내가 챙길게", type: 1, sentAt: now - 8 * 60_000, fromMe: false, unread: 0 },
      { id: 4, logId: "104", authorId: "u2", sender: "정우", text: "그리고 장작은 어디서 살까?", type: 1, sentAt: now - 6 * 60_000, fromMe: false, unread: 0 },
    ] },
  };
  // 설정 화면 (GET /api/integrations/<app>/settings and /features, hub/app-settings.ts, hub/app-features.ts).
  const appFields = [
    { key: "notify", label: "새 메시지 알림", type: "bool", help: "지켜보는 방에 새 메시지가 오면 알려 줘요", section: "notify", switch: true, value: true },
    { key: "auto_draft", label: "자동 초안", type: "bool", help: "답할 거리가 있으면 초안을 만들어요", section: "draft", switch: true, value: true },
    { key: "tone", label: "말투", type: "enum", help: "초안을 쓸 때 따라 할 말투예요", section: "draft", options: ["mine", "polite"], labels: { mine: "내 말투", polite: "존댓말" }, value: "mine" },
    { key: "every_minutes", label: "확인 주기", type: "number", help: "새 메시지를 몇 분마다 볼지 정해요", section: "watch", min: 1, max: 60, value: 5 },
    { key: "use_here", label: "이 기기에서 쓰기", type: "bool", help: "끄면 이 컴퓨터의 앱 목록에서 빠져요", section: "advanced", value: true },
  ];
  const appFeatures = {
    features: [{ id: "kakao-new", name: "새 메시지 확인", status: "켜져 있어요", on: true, section: "watch" }],
    internal: [{ id: "kakao-keeper", name: "로그인 유지", kind: "keeper", dot: "ok", status: "정상", last_run: ago(4), every_minutes: 10 }],
    approvals: [{ id: "ap-1", title: "정우 방에 답장 보내기", kind: "카카오톡", at: ago(5), options: [{ label: "보내기", n: 1 }, { label: "버리기", n: 2 }] }],
  };
  // 앱 페이지 (GET /api/apps).
  const apps = [
    { id: "kakao", label: "카카오톡", kind: "monitor", source: "registry", icon: "chat", status: "running" },
    { id: "mail", label: "메일", kind: "monitor", source: "registry", icon: "mail", status: "running" },
    { id: "insta", label: "인스타그램", kind: "monitor", source: "registry", icon: "image", status: "unreachable", hint: "로그인이 풀렸어요" },
    { id: "memo", label: "메모장", kind: "tool", source: "manifest", icon: "file", status: "running", web: { href: "/apps/memo/", url: "/apps/memo/", path: "/apps/memo/", mode: "frame" } },
    { id: "timer", label: "집중 타이머", kind: "tool", source: "manifest", icon: "clock", status: "off", off: true, web: { href: "/apps/timer/", url: "/apps/timer/", path: "/apps/timer/", mode: "frame" } },
  ];
  const monitors = [
    { name: "가격 페이지", kind: "watch", watch: "price-page", scope: "plain", last_run: ago(18), next_run: new Date(now + 12 * 60_000).toISOString(), last_result: "ok" },
    { name: "캠핑 의자 가격", kind: "watch", watch: "camp-chair", scope: "plain", last_run: ago(9), next_run: new Date(now + 21 * 60_000).toISOString(), last_result: "changed" },
    { name: "아침 브리핑", kind: "schedule", watch: "", scope: "plain", last_run: ago(61), next_run: new Date(now + 20 * 3600_000).toISOString(), last_result: "ok" },
  ];

  const projects = [
    {
      key: "ch:1", name: "랜딩 페이지", pinned: true, recordKey: "ch:1",
      channel: { id: "1", name: "랜딩 페이지" },
      record: { title: "랜딩 페이지", purpose: "첫 화면 문구와 배포 전 점검", updated: ago(29), milestones: [{ text: "문구 확정", done: true }, { text: "링크 점검", done: true }, { text: "모바일 점검", done: false }] },
      lanes: [{ name: "site-check", title: "랜딩 페이지 점검", live: true, status: "idle", home: "ch:1", startedAt: ago(58) }],
      work: [
        { id: "w-1", status: "running", description: "모바일 화면 캡처 모으기", started_at: now - 7 * 60_000 },
        { id: "w-2", status: "done", description: "링크 40개 점검", started_at: now - 95 * 60_000, ended_at: now - 80 * 60_000 },
      ],
      results: [
        { kind: "report", title: "링크 40개 중 38개가 열려요. 2개는 주소를 고쳐야 해요", lane: "site-check", verified: true, at: now - 80 * 60_000 },
        { kind: "commit", title: "문구 확정본 반영", hash: "a3f9c21", at: now - 26 * 3600_000 },
      ],
      monitors: [{ id: "price-page", name: "가격 페이지 변경", on: "change", every_minutes: 30, lastRun: ago(18), lastOk: true, fails: 0, nextAt: new Date(now + 12 * 60_000).toISOString(), script: "watch/price-page.sh" }],
      summary: { lastActivity: ago(29) },
    },
    {
      key: "ch:2", name: "릴리스 노트", pinned: false, recordKey: "ch:2",
      channel: { id: "2", name: "릴리스 노트" },
      record: { title: "릴리스 노트", purpose: "이번 주 변경 사항 정리", updated: ago(20), milestones: [{ text: "항목 정리", done: true }, { text: "배포 공지", done: false }] },
      lanes: [{ name: "notes-draft", title: "배포 공지 초안", live: true, status: "idle", waiting: true, home: "ch:2", startedAt: ago(40) }],
      work: [], results: [], monitors: [], summary: { lastActivity: ago(20) },
    },
    {
      key: "ch:3", name: "가격 조사", pinned: false, recordKey: "ch:3",
      channel: { id: "3", name: "가격 조사" },
      record: { title: "가격 조사", purpose: "경쟁 서비스 요금표 비교", updated: ago(3), milestones: [{ text: "요금표 모으기", done: true }, { text: "비교표 정리", done: false }, { text: "추천안 작성", done: false }] },
      lanes: [{ name: "price-research", title: "경쟁 서비스 가격 조사", live: true, status: "working", home: "ch:3", startedAt: ago(14), lastReportAt: ago(3) }],
      work: [], results: [], monitors: [], summary: { lastActivity: ago(3) },
    },
    {
      key: "ch:4", name: "주간 보고서", pinned: false, recordKey: "ch:4",
      channel: { id: "4", name: "주간 보고서" },
      record: { title: "주간 보고서", purpose: "매주 금요일 정리", updated: ago(1500), milestones: [{ text: "초안", done: true }, { text: "발송", done: true }] },
      lanes: [], work: [], results: [], monitors: [], summary: { lastActivity: ago(1500) },
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

  // The reply draft awaiting 보내기 / 고치기 / 보내지 않기 for m-1, in the asking-message format of hub/draft-approval.ts.
  const mailDraftBody = "안녕하세요, 서윤님.\n\n다음 주 화요일 오후 2시가 좋아요.\n온라인으로 뵐까요?\n\n감사합니다.";
  const mailDraftAsk = `[ask] 서윤님에게 보낼 답장 초안이에요.\n\n> 받는이: 한서윤 <seoyun.han@example.com>\n> 제목: Re: 다음 주 미팅 일정 확인 부탁드려요\n>\n${mailDraftBody.split("\n").map(l => `> ${l}`.trimEnd()).join("\n")}\n\n결정: 이대로 보낼까요?\n1) 보내기 ← 추천\n이 초안으로 답장해요\n2) 고치기 …\n고칠 내용을 적어 주세요\n3) 보내지 않기\n초안을 버려요`;

  const notices = {
    unread: 3,
    items: [
      // 답장 초안 확인 (a send approval): the card in the chat of mail:m-1 and the sheet answer it through POST /api/notices/<id>/answer.
      { id: "n-demo-1", kind: "decision", cls: "ask", tone: "ask", src: "mail:m-1", open: "mail:m-1", at: T_ASKM1, title: "한서윤님에게 보낼 답장을 확인해 주세요", text: mailDraftAsk, read: false,
        decision: { options: [{ n: 1, label: "보내기", desc: "이 초안으로 답장해요", rec: true }, { n: 2, label: "고치기", desc: "고칠 내용을 적어 주세요", rec: false, detail: true }, { n: 3, label: "보내지 않기", desc: "초안을 버려요", rec: false }], to: "mail:m-1", reply_to: T_ASKM1, group: 1, state: "open",
          draft: { toLabel: "받는이", to: "한서윤 <seoyun.han@example.com>", mode: "reply", subject: "Re: 다음 주 미팅 일정 확인 부탁드려요", body: mailDraftBody, ref: "dr-m1" } } },
      { id: "n-demo-2", kind: "decision", cls: "ask", tone: "ask", src: "ch:2", open: "ch:2", at: T_ASK2, title: "배포 공지 형태를 정해 주세요", text: "[ask] 배포 공지를 어떤 형태로 정리할까요?", read: false,
        decision: { options: [{ n: 1, label: "짧은 공지", desc: "한 문단으로 핵심만 전해요", rec: true }, { n: 2, label: "목록 공지", desc: "바뀐 항목을 순서대로 적어요", rec: false }, { n: 3, label: "공지 없이 배포", desc: "릴리스 노트만 남겨요", rec: false }], to: "ch:2", reply_to: T_ASK2, group: 1, state: "open" } },
      { id: "n-demo-3", kind: "watch", cls: "news", tone: "", app: "유튜브", src: "alert", open: "alert", at: ago(35), title: "댓글 3개에 답글을 달 수 있어요", text: "댓글 3개에 답글을 달 수 있어요.", read: false },
      { id: "n-demo-8", kind: "alert", cls: "alert", tone: "fail", src: "alert", open: "alert", at: ago(18), title: "인스타그램 로그인이 풀렸어요", text: "[fail] 인스타그램 확인에 실패했어요.\n\n- 원인: 로그인이 풀렸어요\n- 다음: 설정에서 다시 로그인해 주세요", read: false },
      { id: "n-demo-4", kind: "worklog", cls: "result", tone: "done", src: "worklog", open: "worklog", at: ago(310), title: "밤 사이 정리를 마쳤어요", read: true },
      { id: "n-demo-5", kind: "watch", cls: "news", tone: "", watch: "캠핑 의자 가격", src: "alert", open: "alert", at: ago(9), title: "캠핑 의자 가격", text: "[캠핑 의자 가격] 가격이 바뀌었어요.\n\n- 캠핑 의자 89,000원 → 72,000원", read: false },
      { id: "n-demo-6", kind: "result", cls: "result", tone: "done", src: "ch:4", open: "ch:4", at: ago(52), title: "주간 보고서 정리를 마쳤어요", read: false },
      { id: "n-demo-7", kind: "worklog", cls: "result", tone: "done", src: "worklog", open: "worklog", at: ago(180), title: "아침 브리핑을 보냈어요", read: true },
    ],
    gone: [],
  };
  for (const n of notices.items) n.ts = n.at;   // the web reads a notice's time from ts / updated

  const canvases = {
    "notes/release.md": "# 릴리스 노트\n\n- 데모 페이지 추가\n- 모바일 문구 정리\n",
    "notes/landing.md": "# 랜딩 페이지\n\n- 제목: 내 기기에서 계속 도는 비서\n- 설명: 대화로 맡기고, 승인하고, 결과를 받아요\n",
  };
  // [file] lines in scripted replies open these through GET /api/file.
  const files = { "reports/주간-보고서.md": "# 주간 보고서\n\n- 이번 주 한 일: 메일 정리, 댓글 답글, 감시 설정\n- 다음 주 할 일: 견적 확정, 배포 공지\n" };

  window.DEMO_FIXTURES = {
    now, ago, T_ASKM1, mailDraftAsk, mailDraftBody, MODEL, model, la, mails, mailBody, mailCard, mailEvent, calendar, comments, histories, state, conversations,
    integrations, kakaoRooms, kakaoChat, appFields, appFeatures, apps, monitors, projects, todo, subagents, queue, notices, canvases, files,
  };
})();
