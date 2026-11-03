window.D = (() => {
  const D = {};
  D.computers = [
    { name: "맥북", self: true, online: true, sub: "이 컴퓨터", need: 0 },
    { name: "맥미니", online: true, sub: "집 · 온라인", need: 1, unread: 2 },
    { name: "스튜디오 PC", online: false, sub: "꺼져 있어요" },
  ];

  D.mails = [
    { id: 1, dir: "in", read: false, star: false, reply: "needs", from: "한서윤", addr: "seoyun.han@example.com", subject: "다음 주 미팅 일정 확인 부탁드려요", t: "오전 9:12", sum: "다음 주 미팅 시간을 화요일 오후 2시와 수요일 오전 10시 중에서 골라 달라는 메일이에요.", text: "안녕하세요.\n\n다음 주 미팅 시간을 정하려고 해요.\n화요일 오후 2시나 수요일 오전 10시 중에\n편한 시간을 알려 주세요.\n\n한서윤 드림" },
    { id: 2, dir: "in", read: false, reply: "fyi", from: "별빛상회 주문팀", addr: "orders@example.net", org: true, subject: "주문하신 책상 램프가 출발했어요", t: "오전 8:04", sum: "책상 램프가 오늘 출발했고 목요일에 도착한다는 배송 안내예요. 답장은 필요 없어요.", text: "주문하신 책상 램프가 오늘 출발했어요.\n도착 예정일은 목요일이에요.\n\n별빛상회 드림" },
    { id: 3, dir: "in", read: true, reply: "needs", from: "오지훈", addr: "jihoon.oh@example.org", subject: "견적서 수정본 보내드려요", t: "어제", sum: "견적서 수정본이 첨부돼 있고, 금요일까지 의견을 달라는 메일이에요.", text: "안녕하세요.\n\n말씀하신 부분을 고친 견적서를 보내드려요.\n금요일까지 의견 주시면\n다음 주에 확정할게요.\n\n오지훈 드림", att: [{ name: "견적서-수정본.pdf", size: "178KB" }] },
    { id: 4, dir: "in", read: true, reply: "fyi", from: "달무리 소식지", addr: "news@example.com", org: true, subject: "11월 첫째 주 소식", t: "어제", sum: "새 기능 소개와 다음 달 일정이 담긴 소식지예요.", text: "11월 첫째 주 소식이에요.\n\n- 새 기능 두 가지\n- 다음 달 모임 일정" },
    { id: 5, dir: "out", read: true, from: "한서윤", addr: "seoyun.han@example.com", subject: "Re: 지난 회의 자료", t: "11월 2일", sum: "지난 회의 자료를 첨부해서 보냈어요.", text: "서윤님, 지난 회의 자료 보내드려요.\n확인해 보시고 궁금한 점 알려 주세요.", att: [{ name: "회의자료.pdf", size: "1.2MB" }] },
    { id: 6, dir: "out", read: true, from: "오지훈", addr: "jihoon.oh@example.org", subject: "Re: 견적 문의", t: "11월 1일", sum: "견적 범위를 정리해서 보냈어요.", text: "지훈님, 견적 범위를 정리해 보내드려요.\n수정할 부분이 있으면 말씀해 주세요." },
  ];
  D.mailDraft = { 1: { id: "d-m1", to: "한서윤", subj: "Re: 다음 주 미팅 일정 확인 부탁드려요", text: "서윤님, 화요일 오후 2시가 좋아요.\n그때 뵐게요. 장소는 온라인으로 해요.", kind: "메일" }, 3: { id: "d-m3", to: "오지훈", subj: "Re: 견적서 수정본 보내드려요", text: "지훈님, 수정본 잘 받았어요.\n금요일 오전까지 검토하고 의견 드릴게요.", kind: "메일" } };

  D.calendar = [
    { at: "10:00", title: "주간 회의", where: "온라인" },
    { at: "13:00", title: "점심", where: "한서윤님과" },
    { at: "15:30", title: "견적서 검토", where: "오지훈님 자료" },
    { at: "19:00", title: "운동", where: "" },
  ];

  D.comments = {
    youtube: [
      { id: "d-y1", post: "키보드 6개월 사용기", author: "구름산책", text: "영상에 나온 키보드는 어디서 사요?", t: "12분 전", to: "구름산책", draft: "영상 설명란에 구매 링크를 달아 뒀어요.\n봐 주셔서 고마워요!", kind: "유튜브 댓글" },
      { id: "d-y2", post: "책상 정리 루틴", author: "하루한컷", text: "배경 음악 제목이 궁금해요", t: "1시간 전", to: "하루한컷", draft: "음악은 설명란 아래쪽에 적어 뒀어요.\n즐겁게 들어 주세요!", kind: "유튜브 댓글" },
    ],
    instagram: [
      { id: "d-i1", post: "금요일 라이브 공지", author: "달빛고양이", text: "다음 라이브는 언제 해요?", t: "34분 전", to: "달빛고양이", draft: "이번 주 금요일 저녁 8시에 해요.\n알림 설정해 두시면 바로 알려 드릴게요.", kind: "인스타그램 댓글" },
    ],
    website: [
      { id: "d-w1", post: "문의하기 페이지", author: "방문자 민트", text: "환불 문의는 어디로 하면 되나요?", t: "2시간 전", to: "방문자 민트", draft: "문의하기 페이지에 남겨 주시면\n하루 안에 답드릴게요.", kind: "웹사이트 댓글" },
    ],
  };
  D.dm = [
    { id: "dm1", who: "봄이엄마", last: "배송은 언제쯤 시작돼요?", t: "방금", n: 1, msgs: [["in", "안녕하세요, 어제 주문했어요."], ["in", "배송은 언제쯤 시작돼요?"]] },
    { id: "dm2", who: "책읽는곰", last: "후기 영상 잘 봤어요", t: "어제", n: 0, msgs: [["in", "후기 영상 잘 봤어요"], ["out", "봐 주셔서 고마워요!"]] },
  ];

  D.kakao = [
    { id: "r1", name: "정우", kind: "direct", watched: true, auto: true, unread: 2, unrep: true, t: "6분 전", last: "그리고 장작은 어디서 살까?" },
    { id: "r2", name: "캠핑 모임", kind: "group", watched: true, auto: false, unread: 14, t: "38분 전", last: "토요일 날씨 괜찮대요" },
    { id: "r3", name: "엄마", kind: "direct", watched: true, auto: false, unread: 0, t: "어제", last: "밥은 먹었니?" },
    { id: "r4", name: "동네 이웃", kind: "group", watched: false, auto: false, unread: 0, t: "3일 전", last: "분리수거 요일 바뀌었어요" },
    { id: "r5", name: "나와의 채팅", kind: "self", watched: false, auto: false, unread: 0, t: "5일 전", last: "메모" },
  ];
  D.kakaoChat = [
    ["in", "정우", "형, 이번 주말에 캠핑 가기로 한 거 기억나?", "오전 8:18"],
    ["own", "", "응, 토요일 아침에 출발하자", "오전 8:21"],
    ["in", "정우", "좋아. 의자는 내가 챙길게", "오전 9:02"],
    ["in", "정우", "그리고 장작은 어디서 살까?", "오전 9:04"],
  ];
  D.kakaoDraft = { id: "d-k1", to: "정우", subj: "", text: "가는 길에 마트에 들러서 사자.\n내가 사 갈게!", kind: "카카오톡" };

  D.notices = [
    { id: "n1", tone: "warn", tag: "답장 확인", title: "한서윤님께 보낼 답장 초안", sub: "화요일 오후 2시가 좋다고 답해요", t: "방금", href: "mail/1", unread: true },
    { id: "n3", tone: "warn", tag: "댓글", title: "댓글 3개에 답글을 달 수 있어요", sub: "유튜브 2 · 인스타그램 1 · 웹사이트 1", t: "35분 전", href: "comments", unread: true },
    { id: "n4", tone: "warn", tag: "카카오톡", title: "정우님이 물어봤어요", sub: "그리고 장작은 어디서 살까?", t: "6분 전", href: "kakao/r1", unread: true },
    { id: "n5", tone: "pri", tag: "아침 점검", title: "아침 브리핑이 왔어요", sub: "일정 4개 · 답장할 메일 2통", t: "오전 7:30", href: "briefing", unread: false },
    { id: "n6", tone: "ok", tag: "작업 완료", title: "주간 보고서 정리를 마쳤어요", sub: "주간-보고서.md", t: "어제", href: "tasks", unread: false },
  ];
  D.priceNotice = { id: "n2", tone: "pri", tag: "가격 변경", title: "캠핑 의자 가격이 바뀌었어요", sub: "89,000원 → 72,000원", price: ["89,000원", "72,000원"], t: "방금", href: "watch/price", unread: true };

  D.convs = [
    { id: "main", title: "dotz AI", sub: "무엇을 도와드릴까요?", t: "8분 전", unread: 0, kind: "bot" },
    { id: "ch2", title: "릴리스 노트", sub: "배포 공지를 어떤 형태로 정리할까요?", t: "20분 전", unread: 1, kind: "ch", ask: true },
    { id: "ch1", title: "랜딩 페이지", sub: "배포 전 점검 목록이에요", t: "29분 전", unread: 0, kind: "ch" },
    { id: "alert", title: "알림", sub: "[캠핑 의자 가격] 가격이 바뀌었어요", t: "9분 전", unread: 2, kind: "sys" },
    { id: "worklog", title: "작업 기록", sub: "아침 브리핑을 보냈어요", t: "1시간 전", unread: 0, kind: "sys" },
    { id: "lane", title: "랜딩 페이지 점검", sub: "배포 전 점검 목록을 정리했어요", t: "57분 전", unread: 0, kind: "lane" },
  ];

  D.msgs = {
    main: [
      ["me", "어제 오후 3:20", "서윤님한테 지난 회의 자료 보내 줘"],
      ["bot", "어제 오후 3:21", "[done] 보냈어요.\n\n- 받는이: 한서윤\n- 제목: Re: 지난 회의 자료\n[file] /Users/me/회의자료.pdf"],
      ["me", "오전 7:29", "아침 브리핑 해 줘"],
      ["bot", "오전 7:30", "@briefing"],
      ["sys", "", "백그라운드 작업으로 맡겼어요: 주간 보고서 정리"],
      ["bot", "8분 전", "dotz 데모예요. 실제로 보내지 않으니 편하게 말 걸어 보세요.\n\n- 메일 정리해 줘\n- 오늘 일정 알려 줘\n- 댓글 답글 써 줘\n- 보고서 정리해 줘"],
    ],
    ch1: [
      ["me", "오전 8:40", "랜딩 페이지 첫 화면 문구를 조금 더 짧게 다듬어 줘"],
      ["bot", "오전 8:41", "[done] 두 가지로 나눠 봤어요.\n\n- 제목: 내 기기에서 계속 도는 비서\n- 설명: 대화로 맡기고, 승인하고, 결과를 받아요"],
      ["me", "오전 9:02", "점검 목록도 같이 만들어 줘"],
      ["bot", "오전 9:03", "[done] 배포 전 점검 목록이에요.\n\n- 제목과 설명 문구 확인\n- 링크와 이미지 확인\n- 모바일 화면 확인\n[file] /Users/me/landing/점검-목록.md"],
    ],
    ch2: [
      ["me", "오전 6:00", "릴리스 노트 항목을 정리해 줘"],
      ["bot", "오전 6:01", "[done] 초안을 정리했어요.\n\n- 새로 추가한 것: 데모 페이지\n- 고친 것: 모바일 문구 줄바꿈\n- 남은 것: 배포 공지"],
      ["bot", "20분 전", "[ask] 배포 공지를 어떤 형태로 정리할까요?"],
    ],
    alert: [
      ["bot", "35분 전", "[ask] 댓글 3개에 답글을 달 수 있어요.\n\n채팅에서 \"댓글 답글 써 줘\"라고 해 보세요."],
      ["bot", "18분 전", "[done] 가격 페이지를 확인했어요. 바뀐 곳은 없어요."],
      ["bot", "9분 전", "[run] 캠핑 의자 가격이 바뀌었어요.\n\n- 캠핑 의자 ~~89,000원~~ → 72,000원"],
    ],
    worklog: [
      ["bot", "오전 2:10", "밤 사이 정리 기록\n\n- 메일 4통을 분류했어요\n- 답장할 메일 2통을 표시했어요\n- 가격 페이지를 6번 확인했어요"],
      ["bot", "오전 7:30", "[done] 아침 브리핑을 보냈어요."],
      ["bot", "11분 전", "[run] 랜딩 페이지 점검 세션이 일하고 있어요.\n\n- 모바일 화면 캡처 모으기"],
    ],
    lane: [
      ["bot", "58분 전", "점검을 시작했어요. 문구, 링크, 모바일 세 가지를 봐요."],
      ["bot", "57분 전", "[done] 배포 전 점검 목록을 정리했어요.\n\n- 문구: 확인\n- 링크: 확인\n- 모바일: 확인"],
    ],
  };

  D.decision = {
    q: "공지 형태", ask: "배포 공지를 어떤 형태로 정리할까요?",
    opts: [
      { n: 1, name: "짧은 공지", desc: "한 문단으로 핵심만 전해요", rec: true },
      { n: 2, name: "목록 공지", desc: "바뀐 항목을 순서대로 적어요" },
      { n: 3, name: "공지 없이 배포", desc: "릴리스 노트만 올려요" },
      { n: 4, name: "다른 방식 …", desc: "원하는 방식을 적어 주세요", reason: true },
    ],
    answers: {
      1: "[done] 짧은 공지로 정리했어요.\n\n> 이번 주 변경: 데모 페이지 추가, 모바일 줄바꿈 수정\n\n- 공지 초안을 릴리스 노트 채널에 올렸어요\n[file] /Users/me/release/공지-초안.md",
      2: "[done] 목록 공지로 정리했어요.\n\n- 새로 추가한 것: 데모 페이지\n- 고친 것: 모바일 문구 줄바꿈\n[file] /Users/me/release/공지-초안.md",
      3: "[done] 공지 없이 배포하기로 했어요.\n\n- 릴리스 노트만 올릴게요",
      4: "[done] 말씀하신 방식으로 정리해 볼게요.\n\n- 곧 초안을 보여 드려요",
    },
  };

  D.todo = [
    { t: "문구 확정", done: true },
    { t: "링크 40개 점검", done: true },
    { t: "모바일 화면 캡처", cur: true },
    { t: "배포 전 점검표 정리" },
  ];

  D.projects = [
    { id: "hdocs", name: "한글 문서 자동화", purpose: "공문 양식에 맞춰 HWPX 문서를 만들어요", pinned: true, upd: "5분 전", need: 1, state: "pri", st: "세션 일하는 중",
      ms: [["양식 분석", 1], ["공문 초안 생성", 1], ["표 서식 맞추기", 0], ["검수와 전달", 0]],
      lanes: [{ n: "hdocs-fill", ti: "공문 초안 채우기", s: "일하는 중", tone: "pri" }],
      work: [{ ti: "표 서식 점검", s: "running" }, { ti: "공문 양식 12종 읽기", s: "done" }],
      results: [{ ti: "공문 초안 3건을 만들었어요", at: "20분 전", f: "공문-초안.hwpx" }, { ti: "양식 12종 분석 보고", at: "어제", f: "양식-분석.md" }],
      monitors: [], ask: { ti: "표 머리글을 굵게 할까요?", href: "chat/ch1" } },
    { id: "landing", name: "랜딩 페이지", purpose: "첫 화면 문구와 배포 전 점검", pinned: true, upd: "29분 전", need: 0, state: "pri", st: "세션 쉬는 중",
      ms: [["문구 확정", 1], ["링크 점검", 1], ["모바일 점검", 0]],
      lanes: [{ n: "site-check", ti: "랜딩 페이지 점검", s: "쉬는 중", tone: "" }],
      work: [{ ti: "모바일 화면 캡처 모으기", s: "running" }, { ti: "링크 40개 점검", s: "done" }],
      results: [{ ti: "링크 40개 중 38개가 열려요. 2개는 주소를 고쳐야 해요", at: "1시간 전", f: "링크-점검.md" }, { ti: "문구 확정본 반영", at: "어제", hash: "a3f9c21" }],
      monitors: [{ ti: "가격 페이지 변경", ev: "30분마다", ok: true }] },
    { id: "release", name: "릴리스 노트", purpose: "이번 주 변경 사항 정리", pinned: false, upd: "20분 전", need: 1, state: "warn", st: "답을 기다려요",
      ms: [["항목 정리", 1], ["배포 공지", 0]],
      lanes: [{ n: "notes-draft", ti: "배포 공지 초안", s: "답을 기다려요", tone: "warn" }],
      work: [], results: [{ ti: "릴리스 노트 초안", at: "6시간 전", f: "릴리스-노트.md" }], monitors: [], ask: { ti: "배포 공지를 어떤 형태로 정리할까요?", href: "chat/ch2" } },
    { id: "pricing", name: "가격 조사", purpose: "경쟁 서비스 가격 비교", pinned: false, upd: "4분 전", need: 0, state: "pri", st: "작업 진행 중",
      ms: [["경쟁 서비스 6곳 수집", 1], ["가격표 정리", 0]],
      lanes: [{ n: "price-scan", ti: "가격 수집", s: "일하는 중", tone: "pri" }],
      work: [{ ti: "경쟁 서비스 가격 조사", s: "running" }], results: [], monitors: [{ ti: "캠핑 의자 가격", ev: "30분마다", ok: false }] },
  ];

  D.apps = [
    { id: "kakao", label: "카카오톡", icon: "chat", kind: "monitor", status: "ok", sub: "방 3개 지켜보는 중", href: "kakao" },
    { id: "mail", label: "메일", icon: "mail", kind: "monitor", status: "ok", sub: "안 읽은 메일 2통", href: "mail" },
    { id: "insta", label: "인스타그램", icon: "image", kind: "monitor", status: "err", sub: "로그인이 풀렸어요", href: "comments/instagram" },
    { id: "memo", label: "메모장", icon: "file", kind: "tool", status: "ok", sub: "내가 만든 앱", href: "app/memo" },
    { id: "timer", label: "집중 타이머", icon: "clock", kind: "tool", status: "off", sub: "꺼져 있어요", href: "app/memo" },
  ];
  D.appTemplates = [["일정 보기", "오늘과 내일 일정을 한 화면에"], ["가계부", "영수증 메일을 모아 정리해요"], ["독서 기록", "읽은 책과 메모를 기록해요"]];

  D.palette = [
    ["home", "홈", "상태 한눈에"], ["chat", "채팅", "대화 목록"], ["chat/formats", "답 형식 모음", "채팅 출력 형식"], ["projects", "프로젝트", "프로젝트 목록"],
    ["monitoring", "모니터링", "감시와 앱"], ["mail", "메일", "받은 편지함"], ["mail/compose", "메일 쓰기", "새 메일"], ["kakao", "카카오톡", "지켜보는 방"],
    ["comments", "댓글", "유튜브 · 인스타그램 · 웹사이트"], ["notices", "알림", "알림 목록"], ["settings", "설정", "모든 설정"], ["settings/providers", "공급자와 모델", "모델 설정"],
    ["settings/messengers", "메신저", "Discord · Slack"], ["apps", "앱", "앱 관리"], ["peers", "컴퓨터", "다른 컴퓨터"], ["index", "화면 목록", "프로토타입 전체"],
  ];
  return D;
})();
