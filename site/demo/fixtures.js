/* dotz demo fixtures: everything here is invented. No real people, companies, addresses or channels.
   The demo transport (demo-api.js) answers /api/* from this store; typed messages and the scripted replies are appended here too.
   Every visitor-visible text is L(ko, en): dotzDemoLang (demo-lang.js) picks the page language once, so one source carries both. */
(() => {
  const L = dotzDemoLang.L;
  const now = Date.now();
  const ago = m => new Date(now - m * 60_000).toISOString();
  const MODEL = "dotz/dotz-ai";
  const model = { provider: "dotz", selector: MODEL, name: "dotz AI", family: "dotz AI", reasoning: true, thinking: [] };
  // The lane names are identifiers demo-api.js uses too (F.LANE): one table, so a lane reads the same everywhere it shows.
  const LANE = { landing: L("랜딩-점검", "landing-check"), notice: L("공지-초안", "notice-draft"), price: L("가격-조사", "price-research"), docs: L("공문-채우기", "form-filling"), weekly: L("주간-정리", "weekly-wrap") };
  // The times of the two open questions: the notice's decision.reply_to must equal its asking message's ts.
  const T_ASK2 = ago(20), T_ASKM1 = ago(40);
  const CHECKLIST_DONE = L("배포 전 점검 목록을 정리했어요", "The pre-release checklist is ready");
  const la = { name: LANE.landing, title: L("랜딩 페이지 점검", "Landing page check"), status: "idle", live: true, home: "ch:1", model: MODEL, startedAt: ago(58), lastText: CHECKLIST_DONE };

  // 메일: received (dir "in") and sent (dir "out"). Addresses are on the reserved example.* domains.
  const ME = L("나 <me@example.com>", "Me <me@example.com>");
  const ME_WORK = L("나 <me@work.example.com>", "Me <me@work.example.com>");
  const SEOYUN = L("한서윤 <seoyun.han@example.com>", "Seoyun Han <seoyun.han@example.com>");
  const JIHOON = L("오지훈 <jihoon.oh@example.org>", "Jihoon Oh <jihoon.oh@example.org>");
  const CAN = ["read", "unread", "archive", "unarchive", "star", "unstar", "trash"];
  const mails = [
    {
      key: "m-1", at: ago(47), dir: "in", read: false, reply: "draft", suggest: { kind: "reply-draft", label: L("메일 초안", "Mail draft"), ref: "dr-m1", state: "draft", at: ago(40) },
      from: SEOYUN, to: ME, name: L("한서윤", "Seoyun Han"), short: L("서윤님", "Seoyun"),
      subject: L("다음 주 미팅 일정 확인 부탁드려요", "Please confirm next week's meeting time"),
      summary: L("다음 주 미팅 시간을 화요일 오후 2시와 수요일 오전 10시 중에서 골라 달라는 메일이에요.", "Seoyun asks you to pick a time for next week's meeting: Tuesday at 2 PM or Wednesday at 10 AM."),
      text: L("안녕하세요.\n\n다음 주 미팅 시간을 정하려고 해요.\n화요일 오후 2시나 수요일 오전 10시 중에\n편한 시간을 알려 주세요.\n\n한서윤 드림", "Hello,\n\nI'd like to set a time for next week's meeting.\nPlease let me know which works for you,\nTuesday at 2 PM or Wednesday at 10 AM.\n\nThanks,\nSeoyun Han"),
    },
    {
      key: "m-2", at: ago(95), dir: "in", read: false, reply: "fyi", box: "b-shop",
      from: L("별빛상회 주문팀 <orders@example.net>", "Starlight Shop Orders <orders@example.net>"), to: ME, name: L("별빛상회 주문팀", "Starlight Shop Orders"), short: L("주문팀", "Orders"), org: true,
      subject: L("주문하신 책상 램프가 출발했어요", "Your desk lamp has shipped"),
      summary: L("책상 램프가 오늘 출발했고 목요일에 도착한다는 배송 안내예요. 답장은 필요 없어요.", "Your desk lamp shipped today and should arrive on Thursday. No reply needed."),
      text: L("주문하신 책상 램프가 오늘 출발했어요.\n도착 예정일은 목요일이에요.\n\n별빛상회 드림", "Your desk lamp shipped today.\nIt should arrive on Thursday.\n\nStarlight Shop"),
    },
    {
      key: "m-3", at: ago(180), dir: "in", read: true, reply: "needs",
      from: JIHOON, to: ME, name: L("오지훈", "Jihoon Oh"), short: L("지훈님", "Jihoon"),
      subject: L("견적서 수정본 보내드려요", "Revised quote attached"),
      summary: L("견적서 수정본이 첨부돼 있고, 금요일까지 의견을 달라는 메일이에요.", "A revised quote is attached, and Jihoon asks for your comments by Friday."),
      text: L("안녕하세요.\n\n말씀하신 부분을 고친 견적서를 보내드려요.\n금요일까지 의견 주시면\n다음 주에 확정할게요.\n\n오지훈 드림", "Hello,\n\nHere is the quote with the changes you asked for.\nIf you can send comments by Friday,\nI'll finalize it next week.\n\nThanks,\nJihoon Oh"),
      attachments: [{ name: L("견적서-수정본.pdf", "revised-quote.pdf"), size: 182000 }],
    },
    {
      key: "m-4", at: ago(420), dir: "in", read: true, reply: "fyi", box: "b-news",
      from: L("달무리 소식지 <news@example.com>", "Moonhalo Newsletter <news@example.com>"), to: ME, name: L("달무리 소식지", "Moonhalo Newsletter"), short: L("소식지", "Newsletter"), org: true,
      subject: L("11월 첫째 주 소식", "November, week 1 news"),
      summary: L("새 기능 소개와 다음 달 일정이 담긴 소식지예요.", "A newsletter with the new features and next month's schedule."),
      text: L("11월 첫째 주 소식이에요.\n\n- 새 기능 두 가지\n- 다음 달 모임 일정", "News for the first week of November.\n\n- Two new features\n- Next month's meetup schedule"),
    },
    {
      key: "s-1", at: ago(1500), dir: "out", read: true,
      from: ME, to: SEOYUN, name: L("한서윤", "Seoyun Han"), short: L("서윤님", "Seoyun"),
      subject: L("Re: 지난 회의 자료", "Re: Last meeting's materials"),
      summary: L("지난 회의 자료를 첨부해서 보냈어요.", "I sent last meeting's materials as an attachment."),
      text: L("서윤님, 지난 회의 자료 보내드려요.\n확인해 보시고 궁금한 점 알려 주세요.", "Seoyun, here are the materials from the last meeting.\nTake a look and let me know if you have any questions."),
    },
    {
      key: "s-2", at: ago(2900), dir: "out", read: true,
      from: ME, to: JIHOON, name: L("오지훈", "Jihoon Oh"), short: L("지훈님", "Jihoon"),
      subject: L("Re: 견적 문의", "Re: Quote inquiry"),
      summary: L("견적 범위를 정리해서 보냈어요.", "I sent the scope of the quote."),
      text: L("지훈님, 견적 범위를 정리해 보내드려요.\n수정할 부분이 있으면 말씀해 주세요.", "Jihoon, here is the scope of the quote.\nLet me know if anything needs changing."),
    },
    {
      // a sent mail the collector stored with its html body: no summary, the row and the event carry only the start of the body (hub/mail.ts sentMailEvent)
      key: "s-3", at: ago(1000), dir: "out", read: true, html: true,
      from: ME, to: L("서하은 <haeun.seo@example.com>", "Haeun Seo <haeun.seo@example.com>"), name: L("서하은", "Haeun Seo"), short: L("하은님", "Haeun"),
      subject: L("견적 일정 안내드려요", "Quote schedule"),
      text: L("하은님, 안녕하세요.\n요청하신 견적은 이번 주 금요일까지 정리해서 보내드릴게요.\n먼저 범위와 일정부터 맞춰 보면 좋겠어요.\n\n- 1차 범위 확정: 수요일\n- 견적서 전달: 금요일\n\n궁금한 점은 편하게 말씀해 주세요.", "Hi Haeun,\nI'll send the quote you asked for by this Friday.\nIt would help to settle the scope and schedule first.\n\n- First scope confirmed: Wednesday\n- Quote delivered: Friday\n\nFeel free to ask if you have any questions."),
    },
    {
      key: "w-1", at: ago(130), dir: "in", read: true, reply: "fyi", box: "b-team",
      from: L("운영팀 <ops@work.example.com>", "Operations <ops@work.example.com>"), to: ME_WORK, name: L("운영팀", "Operations"), short: L("운영팀", "Operations"), org: true,
      subject: L("[공지] 다음 주 수요일 사무실 전기 점검", "[Notice] Office power check next Wednesday"),
      summary: L("다음 주 수요일 오후 2시부터 한 시간 동안 사무실 전기 점검이 있다는 공지예요. 따로 할 일은 없어요.", "A notice that the office power will be checked for one hour from 2 PM next Wednesday. Nothing for you to do."),
      text: L("안녕하세요, 운영팀이에요.\n\n다음 주 수요일 오후 2시부터 한 시간 동안\n사무실 전기 점검이 있어요.\n그 시간에는 회의실을 쓸 수 없어요.\n\n운영팀 드림", "Hello, this is Operations.\n\nThe office power will be checked for one hour\nstarting at 2 PM next Wednesday.\nThe meeting rooms won't be available then.\n\nOperations"),
    },
    {
      key: "w-2", at: ago(260), dir: "in", read: true, reply: "fyi",
      from: L("문가람 <garam.moon@work.example.com>", "Garam Moon <garam.moon@work.example.com>"), to: ME_WORK, name: L("문가람", "Garam Moon"), short: L("가람님", "Garam"),
      subject: L("어제 회의록 공유드려요", "Meeting notes from yesterday"),
      summary: L("어제 회의에서 정한 일정과 담당을 정리한 회의록이에요. 확인만 하면 돼요.", "Notes from yesterday's meeting with the schedule and who owns what. Just give them a look."),
      text: L("안녕하세요.\n\n어제 회의록 공유드려요.\n정한 일정과 담당은 아래와 같아요.\n\n- 시안 정리: 금요일, 가람\n- 검토: 다음 주 월요일, 전원\n\n문가람 드림", "Hello,\n\nHere are yesterday's meeting notes.\nThe schedule and owners are below.\n\n- Draft cleanup: Friday, Garam\n- Review: next Monday, everyone\n\nGaram Moon"),
    },
  ];
  const mailBody = m => m.html ? "<!doctype html><meta charset=utf-8><body style=\"font:15px/1.6 sans-serif;margin:16px\">" + m.text.split("\n").map(l => l.trim() ? "<p>" + l + "</p>" : "").join("") + "</body>" : "";
  const mailCard = m => ({ subject: m.subject, from: m.from, to: m.to, at: m.at, summary: m.summary, preview: m.html ? m.text.split("\n").filter(l => l.trim()).slice(0, 3).join("\n") : m.text.split("\n").find(l => l.trim()) || "", dir: m.dir, read: m.read, ...(m.html ? { html: true } : {}), ...(m.reply ? { reply: m.reply } : {}), ...(m.suggest ? { suggest: m.suggest } : {}), ...(m.box ? { box: m.box } : {}), can: CAN, attachments: m.attachments || [] });
  const mailEvent = m => m.dir === "out" && m.html ? ({ ts: m.at, kind: "mail", dir: "out", source: "mail", target: `mail:${m.key}`, mail: m.key, conv: `mail:${m.key}`, subject: m.subject, from: m.from, to: m.to, preview: mailCard(m).preview, html: true, attachments: [], text: `${m.from} · ${m.subject}\n\n${m.text.split("\n").filter(l => l.trim()).slice(0, 3).join("\n")}` }) : ({ ts: m.at, kind: "mail", source: "mail", target: `mail:${m.key}`, mail: m.key, conv: `mail:${m.key}`, subject: m.subject, from: m.from, to: m.to, summary: m.summary, preview: mailCard(m).preview, attachments: m.attachments || [], text: `${m.subject}\n${m.summary}\n\n\`\`\`원문\n${m.text}\n\`\`\`` });

  // 오늘·내일 일정 (아침 브리핑과 일정 질문이 읽어요)
  const calendar = {
    today: [
      { at: "10:00", title: L("주간 회의", "Weekly meeting"), where: L("온라인", "Online") },
      { at: "13:00", title: L("점심", "Lunch"), where: L("한서윤님과", "with Seoyun") },
      { at: "15:30", title: L("견적서 검토", "Quote review"), where: L("오지훈님 자료", "Jihoon's file") },
      { at: "19:00", title: L("운동", "Workout"), where: "" },
    ],
    tomorrow: [
      { at: "09:30", title: L("치과 예약", "Dentist"), where: "" },
      { at: "14:00", title: L("디자인 리뷰", "Design review"), where: L("온라인", "Online") },
    ],
  };

  // 댓글 (유튜브·인스타그램·웹사이트): 답글 초안의 재료
  const comments = [
    { n: 1, platform: L("유튜브", "YouTube"), author: L("구름산책", "CloudWalker"), text: L("영상에 나온 키보드는 어디서 사요?", "Where can I buy the keyboard from the video?"), reply: [L("영상 설명란에 구매 링크를 달아 뒀어요.", "I put the purchase link in the video description."), L("봐 주셔서 고마워요!", "Thanks for watching.")], short: [L("설명란에 링크 있어요. 고마워요!", "The link is in the description. Thanks.")] },
    { n: 2, platform: L("인스타그램", "Instagram"), author: L("달빛고양이", "MoonlightCat"), text: L("다음 라이브는 언제 해요?", "When is the next live stream?"), reply: [L("이번 주 금요일 저녁 8시에 해요.", "It's this Friday at 8 PM."), L("알림 설정해 두시면 바로 알려 드릴게요.", "Turn on notifications and I'll let you know right away.")], short: [L("금요일 저녁 8시에 해요!", "Friday at 8 PM.")] },
    { n: 3, platform: L("웹사이트", "Website"), author: L("방문자 민트", "Visitor Mint"), text: L("환불 문의는 어디로 하면 되나요?", "Where do I send a refund request?"), reply: [L("문의하기 페이지에 남겨 주시면", "Please leave it on the Contact page,"), L("하루 안에 답드릴게요.", "and we'll reply within a day.")], short: [L("문의하기 페이지에 남겨 주세요.", "Please leave it on the Contact page.")] },
  ];

  const PRICE_FROM_89 = L("- 캠핑 의자 89,000원 → 72,000원", "- Camping chair KRW 89,000 → KRW 72,000");
  const LANDING_TITLE = L("내 기기에서 계속 도는 비서", "An assistant that keeps running on your device");
  const LANDING_DESC = L("대화로 맡기고, 승인하고, 결과를 받아요", "Hand it work in chat, approve, and get the results");
  const histories = {
    main: [
      { ts: ago(1442), kind: "message", source: "web", channel: "web", target: "main", text: L("서윤님한테 지난 회의 자료 보내 줘", "Send Seoyun last meeting's materials") },
      { ts: ago(1441), kind: "out", source: "orchestrator", target: "main", text: L("[done] 보냈어요.\n\n- 받는이: 한서윤\n- 제목: Re: 지난 회의 자료", "[done] Sent.\n\n- To: Seoyun Han\n- Subject: Re: Last meeting's materials") },
      { ts: ago(62), kind: "message", source: "web", channel: "web", target: "main", text: L("아침 브리핑 해 줘", "Give me a morning briefing") },
      { ts: ago(61), kind: "out", source: "orchestrator", target: "main", text: L("좋은 아침이에요. 오늘은 이래요.\n\n- 일정 4개, 첫 일정은 10시 주간 회의예요\n- 안 읽은 메일 2통, 답장할 메일 2통\n- 감시 중인 페이지는 변화 없어요", "Good morning. Here is today's plan.\n\n- 4 events, the first is the 10 AM weekly meeting\n- 2 unread mails, 2 mails to reply to\n- No changes on the watched pages") },
      { ts: ago(31), kind: "message", source: "web", channel: "web", target: "main", text: L("오늘 일정이랑 메일 묶어서 브리핑해 줘", "Brief me on today's schedule and mail together") },
      { ts: ago(30), kind: "out", source: "orchestrator", target: "main", text: L("좋은 아침이에요. 아침 브리핑이에요.\n\n오늘 일정 4개\n- 10:00 팀 주간 회의\n- 13:00 한서윤님과 점심\n- 15:30 견적서 검토\n- 19:00 운동\n\n새 메일 2통, 답장할 메일 2통이에요.\n댓글 3개가 답글을 기다려요.\n\n하나씩 볼까요?", "Good morning. Here is your morning briefing.\n\n4 events today\n- 10:00 Team weekly meeting\n- 13:00 Lunch with Seoyun\n- 15:30 Quote review\n- 19:00 Workout\n\n2 new mails, 2 mails to reply to.\n3 comments are waiting for replies.\n\nShall we go through them one by one?") },
      { ts: ago(22), kind: "out", source: "orchestrator", target: "main", text: L("[run] 캠핑 의자 가격이 바뀌었어요.\n\n- 캠핑 의자 89,000원 → 72,000원", "[run] The camping chair price changed.\n\n- Camping chair KRW 89,000 → KRW 72,000") },
      { ts: ago(18), kind: "out", source: "orchestrator", target: "main", text: L("[fail] 인스타그램 확인에 실패했어요.\n\n- 원인: 로그인이 풀렸어요\n- 다음: 설정에서 다시 로그인해 주세요", "[fail] Checking Instagram failed.\n\n- Cause: you were signed out\n- Next: please sign in again in Settings") },
      { ts: ago(14), kind: "out", source: "gateway", target: "main", system: true, worker: "st_report", text: L("백그라운드 작업으로 맡겼어요: 주간 보고서 정리", "Handed to a background task: Weekly report wrap-up") },
      { ts: ago(4), kind: "out", source: "gateway", target: "main", system: true, worker: "st_price", text: L("백그라운드 작업으로 맡겼어요: 경쟁 서비스 가격 조사", "Handed to a background task: Competitor pricing research") },
      { ts: ago(8), kind: "out", source: "orchestrator", target: "main", text: L("dotz 데모예요. 실제로 보내지 않으니\n편하게 말 걸어 보세요.\n\n- 메일 정리해 줘\n- 오늘 일정 알려 줘\n- 댓글 답글 써 줘\n- 가격 페이지 바뀌면 알려 줘\n- 매일 아침 9시에 브리핑해 줘\n- 경쟁 서비스 가격 조사해 줘", "This is the dotz demo. Nothing is really sent,\nso feel free to talk to it.\n\n- Sort my mail\n- What's on my schedule today\n- Write replies to my comments\n- Tell me when the price page changes\n- Brief me every morning at 9\n- Research competitor pricing") },
    ],
    alert: [
      { ts: ago(35), kind: "out", source: "gateway", target: "alert", text: L("댓글 3개에 답글을 달 수 있어요. 채팅에서 \"댓글 답글 써 줘\"라고 해 보세요.", "You can reply to 3 comments. In chat, try \"Write replies to my comments\".") },
      { ts: ago(18), kind: "out", source: "gateway", target: "alert", text: L("[가격 페이지] 확인했어요. 바뀐 곳은 없어요.", "[Price page] Checked. Nothing changed.") },
      { ts: ago(9), kind: "out", source: "gateway", target: "alert", text: L("[캠핑 의자 가격] 가격이 바뀌었어요.\n\n- 캠핑 의자 89,000원 → 72,000원", "[Camping chair price] The price changed.\n\n- Camping chair KRW 89,000 → KRW 72,000") },
    ],
    worklog: [
      { ts: ago(310), kind: "out", source: "gateway", target: "worklog", text: L("밤 사이 정리 기록\n\n- 메일 4통을 분류했어요\n- 답장할 메일 2통을 표시했어요\n- 가격 페이지를 6번 확인했어요", "Overnight log\n\n- Sorted 4 mails\n- Marked 2 mails to reply to\n- Checked the price page 6 times") },
      { ts: ago(61), kind: "out", source: "gateway", target: "worklog", text: L("아침 브리핑을 보냈어요.", "Sent the morning briefing.") },
    ],
    "ch:1": [
      { ts: ago(52), kind: "message", source: "web", channel: "web", target: "ch:1", text: L("랜딩 페이지 첫 화면 문구를 조금 더 짧게 다듬어 줘", "Tighten the text on the landing page's first screen a bit") },
      { ts: ago(51), kind: "out", source: "orchestrator", target: "ch:1", text: L(`[done] 두 가지로 나눠 봤어요.\n\n- 제목: ${LANDING_TITLE}\n- 설명: ${LANDING_DESC}`, `[done] Here are two parts.\n\n- Title: ${LANDING_TITLE}\n- Description: ${LANDING_DESC}`) },
      { ts: ago(30), kind: "message", source: "web", channel: "web", target: "ch:1", text: L("점검 목록도 같이 만들어 줘", "Make a checklist too") },
      { ts: ago(29), kind: "out", source: "orchestrator", target: "ch:1", text: L("[done] 배포 전 점검 목록이에요.\n\n- 제목과 설명 문구 확인\n- 링크와 이미지 확인\n- 모바일 화면 확인", "[done] Here is the pre-release checklist.\n\n- Check the title and description text\n- Check links and images\n- Check the mobile view") },
    ],
    "ch:2": [
      { ts: ago(190), kind: "message", source: "web", channel: "web", target: "ch:2", text: L("릴리스 노트 항목을 정리해 줘", "Put together the release note items") },
      { ts: ago(189), kind: "out", source: "orchestrator", target: "ch:2", text: L("[done] 초안을 정리했어요.\n\n- 새로 추가한 것: 데모 페이지\n- 고친 것: 모바일 문구 줄바꿈\n- 남은 것: 배포 공지", "[done] The draft is ready.\n\n- Added: demo page\n- Fixed: mobile text line breaks\n- Left: release notice") },
      {
        ts: T_ASK2, kind: "out", source: "orchestrator", target: "ch:2",
        text: L("[ask] 배포 공지를 어떤 형태로 정리할까요?", "[ask] How should I put together the release notice?"),
      },
    ],
    [`lane:${LANE.landing}`]: [
      { ts: ago(58), kind: "out", source: `lane:${LANE.landing}`, lane: LANE.landing, target: `lane:${LANE.landing}`, text: L("점검을 시작했어요. 문구, 링크, 모바일 세 가지를 봐요.", "I've started the check. I'm looking at text, links and mobile.") },
      { ts: ago(57), kind: "lane_report", source: `lane:${LANE.landing}`, lane: LANE.landing, target: `lane:${LANE.landing}`, text: L("[done] 배포 전 점검 목록을 정리했어요.\n\n- 문구: 확인\n- 링크: 확인\n- 모바일: 확인", "[done] The pre-release checklist is ready.\n\n- Text: checked\n- Links: checked\n- Mobile: checked") },
    ],
  };
  for (const m of mails) histories[`mail:${m.key}`] = [mailEvent(m)];
  histories["settings:mail"] = [
    { ts: ago(12), kind: "message", source: "web", channel: "web", target: "settings:mail", text: L("확인 주기를 10분으로 바꾸고 자동 초안은 꺼 줘", "Change the check interval to 10 minutes and turn off auto drafts") },
    { ts: ago(11), kind: "out", source: "orchestrator", target: "settings:mail", text: L("[done] 이렇게 바꿀까요?\n\n```dotz-settings\n{\"app\":\"mail\",\"changes\":{\"every_minutes\":10,\"auto_draft\":false}}\n```", "[done] Change it like this?\n\n```dotz-settings\n{\"app\":\"mail\",\"changes\":{\"every_minutes\":10,\"auto_draft\":false}}\n```") },
  ];

  const WEEKLY_PATH = L("reports/주간-보고서.md", "reports/weekly-report.md");
  const state = {
    name: "dotz",
    orchestrator: { status: "idle", model: MODEL },
    lanes: [la],
    terminals: {},
    channels: { work: { "1": L("랜딩 페이지", "Landing page"), "2": L("릴리스 노트", "Release notes") }, homes: { [LANE.landing]: "1" }, lanes: {}, threads: {} },
    discord: {},
    notices_unread: 8,
    work: [
      { id: "st_price", description: L("경쟁 서비스 가격 조사", "Competitor pricing research"), status: "running", started_at: now - 4 * 60_000, model: "dotz AI" },
      { id: "st_report", description: L("주간 보고서 정리", "Weekly report wrap-up"), status: "done", started_at: now - 14 * 60_000, ended_at: now - 3 * 60_000, files: [{ path: WEEKLY_PATH, name: L("주간-보고서.md", "weekly-report.md"), size: 2400 }] },
      { id: "st_demo", description: L("배포 공지 초안 다듬기", "Polish the release notice draft"), status: "done", started_at: now - 23 * 60_000, ended_at: now - 9 * 60_000 },
      { id: "st_night", description: L("밤 사이 메일 분류", "Overnight mail sorting"), status: "done", started_at: now - 320 * 60_000, ended_at: now - 290 * 60_000 },
    ],
    runs: {},
    work_now: now,
    web_build: "",
  };

  const conversations = [
    { target: "main", last: { ts: ago(8), text: L("dotz 데모예요. 편하게 말 걸어 보세요.", "This is the dotz demo. Feel free to talk to it."), from: "bot" }, unread: 0, read: ago(8) },
    { target: "alert", last: { ts: ago(18), text: L("[가격 페이지] 확인했어요. 바뀐 곳은 없어요.", "[Price page] Checked. Nothing changed."), from: "bot" }, unread: 2, read: null },
    { target: "worklog", last: { ts: ago(61), text: L("아침 브리핑을 보냈어요.", "Sent the morning briefing."), from: "bot" }, unread: 0, read: ago(61) },
    { target: "ch:1", last: { ts: ago(29), text: L("배포 전 점검 목록이에요", "Here is the pre-release checklist"), from: "bot" }, unread: 0, read: ago(29) },
    { target: "ch:2", last: { ts: ago(20), text: L("배포 공지를 어떤 형태로 정리할까요?", "How should I put together the release notice?"), from: "bot" }, unread: 1, read: ago(189) },
    { target: `lane:${LANE.landing}`, last: { ts: ago(57), text: CHECKLIST_DONE, from: "session" }, unread: 0, read: ago(57) },
    ...mails.map(m => ({ target: `mail:${m.key}`, last: { ts: m.at, text: m.subject, from: m.dir === "out" ? "owner" : "bot" }, unread: m.read ? 0 : 1, read: m.read ? m.at : null, mail: mailCard(m) })),
  ];

  const mailbox = (id, name, icon, mode, conds = {}) => ({ id, name, icon, ...(mode ? { mode } : { base: true }), notify: mode !== "quiet", conds: { from: [], subj: [], body: [], src: [], ...conds }, not: { from: [] }, judge: { on: false, text: "" }, how: "", greets: [], folders: [], bans: [], rules: [] });
  const integrations = [
    { key: "mail", app: "mail", label: L("구름 메일", "Cloud Mail"), icon: "mail", kind: "app", conv: ["mail:"], convNot: ["mail:w-"], notices: ["n-demo-1"], state: "connected", account: "me@example.com",
      boxes: [mailbox("base", L("일반", "General"), "mail"), mailbox("b-shop", L("쇼핑", "Shopping"), "tag", "notify", { from: ["orders@example.net"] }), mailbox("b-news", L("소식지", "Newsletters"), "folder", "quiet", { from: ["news@example.com"] })] },
    { key: "mail-2", app: "mail", label: L("회사 메일", "Work Mail"), icon: "mail", kind: "app", conv: ["mail:w-"], notices: [], state: "connected", account: "me@work.example.com",
      boxes: [mailbox("base", L("일반", "General"), "mail"), mailbox("b-team", L("팀 공지", "Team notices"), "users", "ask", { subj: [L("공지", "Notice")] })] },
  ];

  // 설정 화면 (GET /api/integrations/<app>/settings and /features, hub/app-settings.ts, hub/app-features.ts).
  const appFields = [
    { key: "notify", label: L("새 메시지 알림", "New message alerts"), type: "bool", help: L("새 메시지가 오면 알려 줘요", "Tell me when a new message arrives"), section: "notify", switch: true, value: true },
    { key: "auto_draft", label: L("자동 초안", "Auto drafts"), type: "bool", help: L("답할 거리가 있으면 초안을 만들어요", "Write a draft when there is something to answer"), section: "draft", switch: true, value: true },
    { key: "tone", label: L("말투", "Tone"), type: "enum", help: L("초안을 쓸 때 따라 할 말투예요", "The tone to follow when writing drafts"), section: "draft", options: ["mine", "polite"], labels: { mine: L("내 말투", "My tone"), polite: L("존댓말", "Formal") }, value: "mine" },
    { key: "every_minutes", label: L("확인 주기", "Check interval"), type: "number", help: L("새 메시지를 몇 분마다 볼지 정해요", "Set how many minutes between checks for new messages"), section: "watch", min: 1, max: 60, value: 5 },
    { key: "use_here", label: L("이 기기에서 쓰기", "Use on this device"), type: "bool", help: L("끄면 이 컴퓨터의 앱 목록에서 빠져요", "Turn off to remove it from this computer's app list"), section: "advanced", value: true },
  ];
  const appFeatures = {
    features: [{ id: "mail-new", name: L("새 메시지 확인", "Check for new messages"), status: L("켜져 있어요", "On"), on: true, section: "watch" }],
    internal: [{ id: "mail-keeper", name: L("로그인 유지", "Stay signed in"), kind: "keeper", dot: "ok", status: L("정상", "OK"), last_run: ago(4), every_minutes: 10 }],
    approvals: [{ id: "ap-1", title: L("한서윤님에게 답장 보내기", "Send a reply to Seoyun"), kind: L("메일", "Mail"), at: ago(5), options: [{ label: L("보내기", "Send"), n: 1 }, { label: L("버리기", "Discard"), n: 2 }] }],
  };
  // 앱 페이지 (GET /api/apps).
  const apps = [
    { id: "mail", label: L("메일", "Mail"), kind: "monitor", source: "registry", icon: "mail", status: "running" },
    { id: "insta", label: L("인스타그램", "Instagram"), kind: "monitor", source: "registry", icon: "image", status: "unreachable", hint: L("로그인이 풀렸어요", "You were signed out") },
    { id: "memo", label: L("메모장", "Notes"), kind: "tool", source: "manifest", icon: "file", status: "running", web: { href: "/apps/memo/", url: "/apps/memo/", path: "/apps/memo/", mode: "frame" } },
    { id: "timer", label: L("집중 타이머", "Focus timer"), kind: "tool", source: "manifest", icon: "clock", status: "off", off: true, web: { href: "/apps/timer/", url: "/apps/timer/", path: "/apps/timer/", mode: "frame" } },
  ];
  const monitors = [
    { name: L("가격 페이지", "Price page"), kind: "watch", watch: "price-page", scope: "plain", last_run: ago(18), next_run: new Date(now + 12 * 60_000).toISOString(), last_result: "ok" },
    { name: L("캠핑 의자 가격", "Camping chair price"), kind: "watch", watch: "camp-chair", scope: "plain", last_run: ago(9), next_run: new Date(now + 21 * 60_000).toISOString(), last_result: "changed" },
    { name: L("아침 브리핑", "Morning briefing"), kind: "schedule", watch: "", scope: "plain", last_run: ago(61), next_run: new Date(now + 20 * 3600_000).toISOString(), last_result: "ok" },
    // A schedule's text is the prompt it runs: the screen shows its plain first sentence, never the paths and commands after it (30-monitoring.js monHuman).
    { name: L("주간 점검 시간이에요. ~/notes/weekly/README.md대로 돌려요. `bun ~/notes/weekly/collect.ts`로 요청을 모으고 report.md를 써요.", "It's time for the weekly check. Run it as ~/notes/weekly/README.md says. Collect the requests with `bun ~/notes/weekly/collect.ts` and write report.md."), kind: "schedule", watch: "", scope: "plain", every: L("하루에 한 번", "Once a day"), last_run: ago(95), next_run: new Date(now + 22 * 3600_000).toISOString(), last_result: "ok", last_summary: L("주간 점검 확인(state.json weekly-1104, w…", "Weekly check done (state.json weekly-1104, w…") },
  ];

  const projects = [
    {
      key: "ch:1", name: L("랜딩 페이지", "Landing page"), pinned: true, recordKey: "ch:1",
      channel: { id: "1", name: L("랜딩 페이지", "Landing page") },
      record: { title: L("랜딩 페이지", "Landing page"), purpose: L("첫 화면 문구와 배포 전 점검", "First screen text and pre-release checks"), updated: ago(29), milestones: [{ text: L("문구 확정", "Text finalized"), done: true }, { text: L("링크 점검", "Links checked"), done: true }, { text: L("모바일 점검", "Mobile checked"), done: false }] },
      lanes: [{ name: LANE.landing, title: L("랜딩 페이지 점검", "Landing page check"), live: true, status: "idle", home: "ch:1", startedAt: ago(58) }],
      work: [
        { id: "w-1", status: "running", description: L("모바일 화면 캡처 모으기", "Collect mobile screenshots"), started_at: now - 7 * 60_000 },
        { id: "w-2", status: "done", description: L("링크 40개 점검", "Check 40 links"), started_at: now - 95 * 60_000, ended_at: now - 80 * 60_000 },
      ],
      results: [
        { kind: "report", title: L("링크 40개 중 38개가 열려요. 2개는 주소를 고쳐야 해요", "38 of 40 links open. 2 need their addresses fixed"), lane: LANE.landing, verified: true, at: now - 80 * 60_000 },
        { kind: "commit", title: L("문구 확정본 반영", "Final text applied"), hash: "a3f9c21", at: now - 26 * 3600_000 },
      ],
      monitors: [{ id: "price-page", name: L("가격 페이지 변경", "Price page changes"), on: "change", every_minutes: 30, lastRun: ago(18), lastOk: true, fails: 0, nextAt: new Date(now + 12 * 60_000).toISOString(), script: "watch/price-page.sh" }],
      summary: { lastActivity: ago(29) },
    },
    {
      key: "ch:2", name: L("릴리스 노트", "Release notes"), pinned: false, recordKey: "ch:2",
      channel: { id: "2", name: L("릴리스 노트", "Release notes") },
      record: { title: L("릴리스 노트", "Release notes"), purpose: L("이번 주 변경 사항 정리", "Sort out this week's changes"), updated: ago(20), milestones: [{ text: L("항목 정리", "Sort items"), done: true }, { text: L("배포 공지", "Release notice"), done: false }] },
      lanes: [{ name: LANE.notice, title: L("배포 공지 초안", "Release notice draft"), live: true, status: "idle", waiting: true, home: "ch:2", startedAt: ago(40) }],
      work: [{ id: "w-n1", status: "done", description: L("이번 주 변경 사항 모으기", "Collect this week's changes"), started_at: now - 200 * 60_000, ended_at: now - 189 * 60_000 }],
      results: [{ kind: "report", title: L("릴리스 노트 초안을 정리했어요", "The release notes draft is ready"), lane: LANE.notice, verified: true, at: now - 189 * 60_000 }],
      monitors: [{ id: "release-page", name: L("릴리스 페이지 변경", "Release page changes"), on: "change", every_minutes: 60, lastRun: ago(25), lastOk: true, fails: 0, nextAt: new Date(now + 35 * 60_000).toISOString(), script: "watch/release-page.sh" }], summary: { lastActivity: ago(20) },
    },
    {
      key: "ch:3", name: L("가격 조사", "Price research"), pinned: false, recordKey: "ch:3",
      channel: { id: "3", name: L("가격 조사", "Price research") },
      record: { title: L("가격 조사", "Price research"), purpose: L("경쟁 서비스 요금표 비교", "Compare competitors' price lists"), updated: ago(3), milestones: [{ text: L("요금표 모으기", "Collect price lists"), done: true }, { text: L("비교표 정리", "Make the comparison table"), done: false }, { text: L("추천안 작성", "Write a recommendation"), done: false }] },
      lanes: [{ name: LANE.price, title: L("경쟁 서비스 가격 조사", "Competitor pricing research"), live: true, status: "working", home: "ch:3", startedAt: ago(14), lastReportAt: ago(3) }],
      work: [{ id: "w-p1", status: "running", description: L("요금제별 비교표 만들기", "Build a comparison table by plan"), started_at: now - 4 * 60_000 }, { id: "w-p2", status: "done", description: L("요금표 세 곳 모으기", "Collect three price lists"), started_at: now - 14 * 60_000, ended_at: now - 6 * 60_000 }],
      results: [{ kind: "report", title: L("요금표 세 곳을 모았어요", "Collected three price lists"), lane: LANE.price, verified: false, at: now - 6 * 60_000 }],
      monitors: [{ id: "camp-chair", name: L("경쟁 서비스 요금 변경", "Competitor price changes"), on: "change", every_minutes: 180, lastRun: ago(40), lastOk: true, fails: 0, nextAt: new Date(now + 140 * 60_000).toISOString(), script: "watch/price.sh" }], summary: { lastActivity: ago(3) },
    },
    {
      key: "ch:4", name: L("주간 보고서", "Weekly report"), pinned: false, recordKey: "ch:4",
      channel: { id: "4", name: L("주간 보고서", "Weekly report") },
      record: { title: L("주간 보고서", "Weekly report"), purpose: L("매주 금요일 정리", "Wrap up every Friday"), updated: ago(1500), milestones: [{ text: L("초안", "Draft"), done: true }, { text: L("발송", "Sent"), done: true }] },
      lanes: [{ name: LANE.weekly, title: L("이번 주 보고서 정리", "This week's report wrap-up"), live: false, status: "done", home: "ch:4", startedAt: ago(1560), finishedAt: ago(1500) }],
      work: [{ id: "w-r1", status: "done", description: L("이번 주 한 일 모으기", "Collect this week's work"), started_at: now - 1560 * 60_000, ended_at: now - 1500 * 60_000 }],
      results: [{ kind: "report", title: L("주간 보고서를 보냈어요", "Sent the weekly report"), lane: LANE.weekly, verified: true, at: now - 1500 * 60_000 }],
      monitors: [{ id: "weekly", name: L("금요일 정리 알림", "Friday wrap-up reminder"), on: "change", every_minutes: 1440, lastRun: ago(1500), lastOk: true, fails: 0, nextAt: new Date(now + 1200 * 60_000).toISOString(), script: "watch/weekly.sh" }], summary: { lastActivity: ago(1500) },
    },
  ];

  const todo = {
    phases: [
      { name: L("오늘 할 일", "Today"), tasks: [
        { content: L("서윤님 미팅 메일 답장", "Reply to Seoyun's meeting mail"), status: "in_progress" },
        { content: L("견적서 수정본 검토", "Review the revised quote"), status: "pending" },
        { content: L("댓글 답글 정리", "Sort out comment replies"), status: "pending" },
      ] },
      { name: L("이번 주", "This week"), tasks: [{ content: L("배포 공지 형태 정하기", "Decide the release notice format"), status: "pending" }] },
    ],
  };

  // Running subagents of the main chat and one message waiting for the running task (GET /api/subagents, /api/queue).
  const subagents = { sources: { orchestrator: [
    { id: "sa-1", status: "running", agent: "researcher", description: L("경쟁 서비스 가격 조사", "Competitor pricing research"), intent: L("가격 페이지 3곳의 요금표를 모으고 있어요", "Collecting the price lists from 3 pricing pages"), started_at: now - 4 * 60_000 },
    { id: "sa-2", status: "running", agent: "writer", description: L("조사 결과 표 정리", "Organize the research table"), intent: L("요금제별 비교표 초안을 만들고 있어요", "Drafting a comparison table by plan"), started_at: now - 90_000 },
  ] } };
  const queue = { items: [{ id: "q-demo-1", target: "main", text: L("끝나면 요금제별 표로 보여 줘", "When you're done, show me a table by plan") }] };

  // The reply draft awaiting 보내기 / 고치기 / 보내지 않기 for m-1, in the asking-message format of hub/draft-approval.ts.
  const mailDraftBody = L("안녕하세요, 서윤님.\n\n다음 주 화요일 오후 2시가 좋아요.\n온라인으로 뵐까요?\n\n감사합니다.", "Hi Seoyun,\n\nTuesday at 2 PM next week works for me.\nShall we meet online?\n\nThanks.");
  const mailDraftAsk = L(`[ask] 서윤님에게 보낼 답장 초안이에요.\n\n> 받는이: 한서윤 <seoyun.han@example.com>\n> 제목: Re: 다음 주 미팅 일정 확인 부탁드려요\n>\n${mailDraftBody.split("\n").map(l => `> ${l}`.trimEnd()).join("\n")}\n\n결정: 이대로 보낼까요?\n1) 보내기 ← 추천\n이 초안으로 답장해요\n2) 고치기 …\n고칠 내용을 적어 주세요\n3) 보내지 않기\n초안을 버려요`, `[ask] Here is the draft reply to Seoyun.\n\n> To: Seoyun Han <seoyun.han@example.com>\n> Subject: Re: Please confirm next week's meeting time\n>\n${mailDraftBody.split("\n").map(l => `> ${l}`.trimEnd()).join("\n")}\n\nDecision: Send it as is?\n1) Send ← recommended\nReply with this draft\n2) Edit …\nTell me what to change\n3) Don't send\nDiscard the draft`);

  // Mirrors the real hub notice: cls / waits / handled / repeats are what hub/notice-class.ts withClass and hub/notices.ts add.
  //   처리할 것: the open decisions (ask), the failure (waits "fail", handled null) and the dropped login (waits "login").
  //   새 소식: the other unread items, the price change folding three older reports into repeats.   지난 알림: the read rest. The unchanged check is cls "log" (not listed).
  const CHAIR_CHANGED = L("[캠핑 의자 가격] 가격이 바뀌었어요.", "[Camping chair price] The price changed.");
  const notices = {
    unread: 8,
    items: [
      { id: "n-demo-2", kind: "decision", cls: "ask", tone: "ask", src: "ch:2", open: "ch:2", at: T_ASK2, title: L("배포 공지 형태를 정해 주세요", "Choose the release notice format"), text: L("[ask] 배포 공지를 어떤 형태로 정리할까요?", "[ask] How should I put together the release notice?"), read: false,
        decision: { options: [{ n: 1, label: L("짧은 공지", "Short notice"), desc: L("한 문단으로 핵심만 전해요", "Just the key points in one paragraph"), rec: true }, { n: 2, label: L("목록 공지", "List notice"), desc: L("바뀐 항목을 순서대로 적어요", "List the changed items in order"), rec: false }, { n: 3, label: L("공지 없이 배포", "Release without notice"), desc: L("릴리스 노트만 남겨요", "Keep only the release notes"), rec: false }], to: "ch:2", reply_to: T_ASK2, group: 1, state: "open" } },
      // 답장 초안 확인 (a send approval): the card in the chat of mail:m-1 and the sheet answer it through POST /api/notices/<id>/answer.
      { id: "n-demo-1", kind: "decision", cls: "ask", tone: "ask", src: "mail:m-1", open: "mail:m-1", at: T_ASKM1, title: L("한서윤님에게 보낼 답장을 확인해 주세요", "Check the reply to send to Seoyun Han"), text: mailDraftAsk, read: false,
        decision: { options: [{ n: 1, label: L("보내기", "Send"), desc: L("이 초안으로 답장해요", "Reply with this draft"), rec: true }, { n: 2, label: L("고치기", "Edit"), desc: L("고칠 내용을 적어 주세요", "Tell me what to change"), rec: false, detail: true }, { n: 3, label: L("보내지 않기", "Don't send"), desc: L("초안을 버려요", "Discard the draft"), rec: false }], to: "mail:m-1", reply_to: T_ASKM1, group: 1, state: "open",
          draft: { toLabel: L("받는이", "To"), to: SEOYUN, mode: "reply", subject: L("Re: 다음 주 미팅 일정 확인 부탁드려요", "Re: Please confirm next week's meeting time"), body: mailDraftBody, ref: "dr-m1" } } },
      { id: "n-demo-12", kind: "watch", cls: "alert", tone: "fail", watch: L("캠핑 의자 가격", "Camping chair price"), src: "alert", open: "alert", at: ago(80), title: L("가격 페이지를 확인하지 못했어요", "Couldn't check the price page"), text: L("[fail] 캠핑 의자 가격 확인에 실패했어요.\n\n- 원인: 페이지가 열리지 않아요\n- 다음: 잠시 뒤 다시 확인해요", "[fail] Checking the camping chair price failed.\n\n- Cause: the page won't open\n- Next: I'll check again in a bit"), read: false, waits: "fail", handled: null },
      { id: "n-demo-8", kind: "alert", cls: "alert", tone: "fail", src: "alert", open: "alert", at: ago(105), title: L("인스타그램 로그인이 풀렸어요", "Instagram signed you out"), text: L("[fail] 인스타그램 확인에 실패했어요.\n\n- 원인: 로그인이 풀렸어요\n- 다음: 설정에서 다시 로그인해 주세요", "[fail] Checking Instagram failed.\n\n- Cause: you were signed out\n- Next: please sign in again in Settings"), read: false, waits: "login", handled: null },
      { id: "n-demo-5", kind: "watch", cls: "news", tone: "", watch: L("캠핑 의자 가격", "Camping chair price"), src: "alert", open: "alert", at: ago(9), title: L("캠핑 의자 가격이 바뀌었어요", "The camping chair price changed"), text: `${CHAIR_CHANGED}\n\n${PRICE_FROM_89}`, read: false,
        repeats: [
          { at: ago(75), text: L(`${CHAIR_CHANGED}\n\n- 캠핑 의자 92,000원 → 89,000원`, `${CHAIR_CHANGED}\n\n- Camping chair KRW 92,000 → KRW 89,000`) },
          { at: ago(225), text: L(`${CHAIR_CHANGED}\n\n- 캠핑 의자 95,000원 → 92,000원`, `${CHAIR_CHANGED}\n\n- Camping chair KRW 95,000 → KRW 92,000`) },
          { at: ago(400), text: L(`${CHAIR_CHANGED}\n\n- 캠핑 의자 98,000원 → 95,000원`, `${CHAIR_CHANGED}\n\n- Camping chair KRW 98,000 → KRW 95,000`) },
        ] },
      { id: "n-demo-3", kind: "watch", cls: "news", tone: "", app: L("유튜브", "YouTube"), src: "alert", open: "alert", at: ago(35), title: L("댓글 4개에 답글을 달 수 있어요", "You can reply to 4 comments"), text: L("댓글 4개에 답글을 달 수 있어요.\n\n- 유튜브 2 · 인스타그램 1 · 웹사이트 1", "You can reply to 4 comments.\n\n- YouTube 2 · Instagram 1 · Website 1"), read: false },
      { id: "n-demo-13", kind: "watch", cls: "news", tone: "", app: L("일정", "Calendar"), src: "alert", open: "alert", at: ago(120), title: L("다음 주 수요일 팀 회의 장소가 본관 3층 회의실에서 별관 1층 세미나실로 바뀌었고 시작 시간도 30분 앞당겨졌으니 참석자 모두 공유 일정을 다시 확인해 주세요", "Next Wednesday's team meeting moved from the 3rd floor meeting room in the main building to the 1st floor seminar room in the annex, and it now starts 30 minutes earlier, so all attendees should check the shared calendar again"), text: L("공유 일정에서 온 소식이에요. 참석자 8명에게 같은 내용이 전달됐고 회의 자료는 그대로 쓰면 돼요.", "This news came from the shared calendar. The same note went to all 8 attendees, and the meeting materials can be used as they are."), read: false },
      { id: "n-demo-6", kind: "result", cls: "result", tone: "done", src: "ch:4", open: "ch:4", at: ago(150), title: L("주간 보고서 정리를 마쳤어요", "Weekly report wrap-up is done"), read: false },
      // 변화 없는 감시: cls "log" keeps it out of the list (it stays in the monitor's 확인 기록).
      { id: "n-demo-14", kind: "watch", cls: "log", tone: "", watch: L("가격 페이지", "Price page"), src: "alert", open: "alert", at: ago(200), title: L("가격 페이지: 확인했어요. 바뀐 곳은 없어요.", "Price page: Checked. Nothing changed."), text: L("가격 페이지: 확인했어요. 바뀐 곳은 없어요.", "Price page: Checked. Nothing changed."), read: true },
      { id: "n-demo-7", kind: "worklog", cls: "result", tone: "done", src: "worklog", open: "worklog", at: ago(180), title: L("아침 브리핑을 보냈어요", "Sent the morning briefing"), read: true },
      { id: "n-demo-4", kind: "worklog", cls: "result", tone: "done", src: "worklog", open: "worklog", at: ago(310), title: L("밤 사이 정리를 마쳤어요", "Overnight cleanup is done"), read: true },
      { id: "n-demo-10", kind: "watch", cls: "news", tone: "", src: "alert", open: "alert", at: ago(1500), title: L("도서관 예약", "Library hold"), text: L("예약한 책이 도착했어요.", "The book you reserved has arrived."), read: true },
      { id: "n-demo-15", kind: "result", cls: "result", tone: "done", src: "ch:2", open: "ch:2", at: ago(1560), title: L("릴리스 노트 초안을 만들었어요", "The release notes draft is ready"), read: true },
    ],
    gone: [],
  };
  for (const n of notices.items) { n.ts = n.at; n.updated = n.at; }   // the web reads a notice's time from ts / updated

  const canvases = {
    "notes/release.md": L("# 릴리스 노트\n\n- 데모 페이지 추가\n- 모바일 문구 정리\n", "# Release notes\n\n- Added the demo page\n- Cleaned up mobile text\n"),
    "notes/landing.md": L(`# 랜딩 페이지\n\n- 제목: ${LANDING_TITLE}\n- 설명: ${LANDING_DESC}\n`, `# Landing page\n\n- Title: ${LANDING_TITLE}\n- Description: ${LANDING_DESC}\n`),
  };
  // [file] lines in scripted replies open these through GET /api/file.
  const files = { [WEEKLY_PATH]: L("# 주간 보고서\n\n- 이번 주 한 일: 메일 정리, 댓글 답글, 감시 설정\n- 다음 주 할 일: 견적 확정, 배포 공지\n", "# Weekly report\n\n- Done this week: mail sorting, comment replies, watch setup\n- Next week: finalize the quote, release notice\n") };

  window.DEMO_FIXTURES = {
    now, ago, T_ASKM1, mailDraftAsk, mailDraftBody, MODEL, model, la, LANE, mails, mailBody, mailCard, mailEvent, calendar, comments, histories, state, conversations,
    integrations, appFields, appFeatures, apps, monitors, projects, todo, subagents, queue, notices, canvases, files,
  };
})();
