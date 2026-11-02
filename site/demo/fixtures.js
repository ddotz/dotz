/* dotz demo fixtures: everything here is invented. No real people, companies, addresses or channels.
   The demo transport (demo-api.js) answers /api/* from this store; a typed message and its canned reply are appended here too. */
(() => {
  const now = Date.now();
  const ago = m => new Date(now - m * 60_000).toISOString();
  const la = { name: "site-check", title: "랜딩 페이지 점검", status: "idle", live: true, home: "ch:1", startedAt: ago(58), lastText: "배포 전 점검 목록을 정리했어요" };

  const histories = {
    main: [
      { ts: ago(41), kind: "message", source: "web", channel: "web", target: "main", text: "이번 주 배포 전에 남은 일 정리해 줘" },
      { ts: ago(40), kind: "out", source: "orchestrator", target: "main", text: "남은 일은 세 가지예요.\n\n- 릴리스 노트 초안 다듬기\n- 배포 공지 초안 확인\n- 랜딩 페이지 문구 최종 점검" },
      { ts: ago(24), kind: "message", source: "web", channel: "web", target: "main", text: "공지 초안은 어떤 형태로 정리하면 좋을까?" },
      { ts: ago(23), kind: "out", source: "gateway", target: "main", system: true, worker: "st_demo", text: "백그라운드 작업으로 맡겼어요: 배포 공지 초안" },
      {
        ts: ago(9), kind: "out", source: "orchestrator", target: "main",
        text: "[ask] 배포 공지를 어떤 형태로 정리할까요?\n\n결정: 공지 형태\n1) 짧은 공지 ← 추천\n한 문단으로 핵심만 전해요\n2) 목록 공지\n바뀐 항목을 순서대로 적어요\n3) 지금 초안 보내기\n검토 없이 바로 보내요",
      },
    ],
    alert: [
      { ts: ago(35), kind: "out", source: "gateway", target: "alert", text: "댓글 답장 초안이 준비됐어요. 보내기 전에 한번 확인해 주세요." },
      { ts: ago(18), kind: "out", source: "gateway", target: "alert", text: "배포 전에 확인할 항목이 하나 남았어요: 공지 문구." },
    ],
    worklog: [
      { ts: ago(310), kind: "out", source: "gateway", target: "worklog", text: "밤 사이 정리 기록\n\n- 릴리스 노트 항목을 모았어요\n- 랜딩 페이지 링크를 확인했어요\n- 대기 중인 작업은 없어요" },
    ],
    "ch:1": [
      { ts: ago(52), kind: "message", source: "web", channel: "web", target: "ch:1", text: "랜딩 페이지 첫 화면 문구를 조금 더 짧게 다듬어 줘" },
      { ts: ago(51), kind: "out", source: "orchestrator", target: "ch:1", text: "[done] 두 가지로 나눠 봤어요.\n\n- 제목: 내 기기에서 계속 도는 비서\n- 설명: 대화로 맡기고, 승인하고, 결과를 받습니다" },
      { ts: ago(30), kind: "message", source: "web", channel: "web", target: "ch:1", text: "점검 목록도 같이 만들어 줘" },
      { ts: ago(29), kind: "out", source: "orchestrator", target: "ch:1", text: "[done] 배포 전 점검 목록이에요.\n\n- 제목과 설명 문구 확인\n- 링크와 이미지 확인\n- 모바일 화면 확인" },
    ],
    "ch:2": [
      { ts: ago(190), kind: "message", source: "web", channel: "web", target: "ch:2", text: "릴리스 노트 항목을 정리해 줘" },
      { ts: ago(189), kind: "out", source: "orchestrator", target: "ch:2", text: "[done] 초안을 정리했어요.\n\n- 새로 추가한 것: 데모 페이지\n- 고친 것: 모바일 문구 줄바꿈\n- 남은 것: 배포 공지" },
      { ts: ago(120), kind: "message", source: "web", channel: "web", target: "ch:2", text: "제목을 한 줄로 줄여 줘" },
      { ts: ago(119), kind: "out", source: "orchestrator", target: "ch:2", text: "이번 주 변경 사항과 남은 일을 한 줄로 정리했어요: 이번 주에는 데모 페이지가 추가되고 모바일 문구가 다듬어졌습니다." },
    ],
    "lane:site-check": [
      { ts: ago(58), kind: "out", source: "lane:site-check", lane: "site-check", target: "lane:site-check", text: "점검을 시작했어요. 문구, 링크, 모바일 세 가지를 봅니다." },
      { ts: ago(57), kind: "lane_report", source: "lane:site-check", lane: "site-check", target: "lane:site-check", text: "[done] 배포 전 점검 목록을 정리했어요.\n\n- 문구: 확인\n- 링크: 확인\n- 모바일: 확인" },
    ],
  };

  const state = {
    name: "dotz",
    orchestrator: { status: "idle", model: "claude-sonnet-5" },
    lanes: [la],
    terminals: {},
    channels: { work: { "1": "랜딩 페이지", "2": "릴리스 노트" }, homes: { "site-check": "1" }, lanes: {}, threads: {} },
    discord: {},
    notices_unread: 2,
    work: [{ id: "st_demo", description: "배포 공지 초안 다듬기", status: "done", started_at: ago(23) }],
    runs: {},
    work_now: now,
    web_build: "",
  };

  const conversations = [
    { target: "main", last: { ts: ago(9), text: "배포 공지를 어떤 형태로 정리할까요?", from: "bot" }, unread: 0, read: ago(9) },
    { target: "alert", last: { ts: ago(18), text: "배포 전에 확인할 항목이 하나 남았어요", from: "bot" }, unread: 2, read: null },
    { target: "worklog", last: { ts: ago(310), text: "밤 사이 정리 기록", from: "bot" }, unread: 0, read: ago(310) },
    { target: "ch:1", last: { ts: ago(29), text: "배포 전 점검 목록이에요", from: "bot" }, unread: 0, read: ago(29) },
    { target: "ch:2", last: { ts: ago(119), text: "이번 주 변경 사항을 한 줄로 정리했어요", from: "bot" }, unread: 0, read: ago(119) },
    { target: "lane:site-check", last: { ts: ago(57), text: "배포 전 점검 목록을 정리했어요", from: "session" }, unread: 0, read: ago(57) },
  ];

  const projects = [
    {
      key: "ch:1", name: "랜딩 페이지", pinned: true, recordKey: "ch:1",
      channel: { id: "1", name: "랜딩 페이지" },
      record: { title: "랜딩 페이지", purpose: "첫 화면 문구와 배포 전 점검", updated: ago(29), milestones: [{ text: "문구 확정", done: true }, { text: "모바일 점검", done: false }] },
      lanes: [{ name: "site-check", title: "랜딩 페이지 점검", live: true, status: "idle", home: "ch:1", startedAt: ago(58) }],
    },
    {
      key: "ch:2", name: "릴리스 노트", pinned: false, recordKey: "ch:2",
      channel: { id: "2", name: "릴리스 노트" },
      record: { title: "릴리스 노트", purpose: "이번 주 변경 사항 정리", updated: ago(119) },
      lanes: [],
    },
  ];

  const todo = {
    phases: [
      { name: "배포 준비", tasks: [
        { content: "릴리스 노트 초안 다듬기", status: "completed" },
        { content: "배포 공지 형태 정하기", status: "in_progress" },
        { content: "랜딩 페이지 모바일 확인", status: "pending" },
      ] },
      { name: "공지", tasks: [{ content: "공지 문구 확인", status: "pending" }] },
    ],
  };

  const notices = {
    unread: 2,
    items: [
      { id: "n-demo-1", kind: "notice", cls: "news", tone: "", src: "main", open: "main", at: ago(9), title: "배포 공지 형태를 정해 주세요", read: false },
      { id: "n-demo-2", kind: "notice", cls: "alert", tone: "warn", src: "alert", open: "alert", at: ago(18), title: "배포 전에 확인할 항목이 남았어요", read: false },
    ],
    gone: [],
  };

  const canvases = {
    "notes/release.md": "# 릴리스 노트\n\n- 데모 페이지 추가\n- 모바일 문구 정리\n",
    "notes/landing.md": "# 랜딩 페이지\n\n- 제목: 내 기기에서 계속 도는 비서\n- 설명: 대화로 맡기고, 승인하고, 결과를 받습니다\n",
  };

  const replies = [
    "확인했어요. 데모 대화에 한 줄 남겨 뒀어요. 다음 단계는 릴리스 노트 확인이에요.",
    "적어 주신 내용으로 다음 단계를 정리했어요.\n\n- 배포 공지 형태 정하기\n- 랜딩 페이지 모바일 확인",
  ];
  const decisionReplies = [
    "정했어요. 배포 공지 초안을 그 형태로 다듬어 둘게요.",
    "좋아요. 고른 형태로 공지 한 단락을 정리했어요. 배포 전 점검 목록에 남겨 뒀어요.",
  ];

  window.DEMO_FIXTURES = {
    now, ago, la, histories, state, conversations, projects, todo, notices, canvases, replies, decisionReplies,
    replyAt: 0, decisionAt: 0,
  };
})();
