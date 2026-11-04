// Test-only data for the kakao screen of hub/layout-measure.ts. The public demo must not name this app (site/AGENTS.md), so it lives
// outside site/ and is never deployed: the measure server injects it after site/demo/demo-api.js, adds the app to the demo's
// lists and answers the two GET routes that screen reads from. Its other routes stay unknown to the demo, as no measure sends them.
(() => {
  const F = window.DEMO_FIXTURES, min = 60_000, hour = 60 * min, day = 24 * hour;
  const rooms = [
    { chatId: "r1", name: "정우", kind: "direct", hint: "그리고 장작은 어디서 살까?", watched: true, autoDraft: true, unread: 2, unreplied: true, lastAt: F.now - 6 * min },
    { chatId: "r2", name: "캠핑 모임", kind: "group", hint: "토요일 날씨 괜찮대요", watched: true, autoDraft: false, unread: 14, lastAt: F.now - 38 * min },
    { chatId: "r3", name: "엄마", kind: "direct", hint: "밥은 먹었니?", watched: true, autoDraft: false, unread: 0, lastAt: F.now - 26 * hour },
    { chatId: "r4", name: "동네 이웃", kind: "group", hint: "분리수거 요일 바뀌었어요", watched: false, autoDraft: false, unread: 0, lastAt: F.now - 3 * day },
    { chatId: "r5", name: "나와의 채팅", kind: "self", hint: "메모", watched: false, autoDraft: false, unread: 0, lastAt: F.now - 5 * day },
  ];
  const message = (id, fromMe, text, ago) => ({ id, logId: String(100 + id), authorId: fromMe ? "u1" : "u2", sender: fromMe ? "나" : "정우", text, type: 1, sentAt: F.now - ago * min, fromMe, unread: 0 });
  const chats = {
    r1: {
      room: { chatId: "r1", name: "정우", kind: "direct", group: false, watched: true }, read: null, kakaoUnread: 2, sends: [],
      drafts: [{ code: "dk1", text: "가는 길에 마트에 들러서 사자.\n내가 사 갈게!", parts: ["가는 길에 마트에 들러서 사자.", "내가 사 갈게!"], basisLogId: "104", created: F.now - 5 * min }],
      messages: [
        message(1, false, "형, 이번 주말에 캠핑 가기로 한 거 기억나?", 52),
        message(2, true, "응, 토요일 아침에 출발하자", 49),
        message(3, false, "좋아. 의자는 내가 챙길게", 8),
        message(4, false, "그리고 장작은 어디서 살까?", 6),
      ],
    },
  };
  F.integrations.push({ key: "kakao", label: "카카오톡", icon: "chat", conv: ["kakao:"], notices: [], state: "connected" });
  F.apps.unshift({ id: "kakao", label: "카카오톡", kind: "monitor", source: "registry", icon: "chat", status: "running" });

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const demoFetch = window.fetch;
  window.fetch = async (input, init = {}) => {
    const p = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
    if (p === "/api/kakao/rooms") return json({ on: true, rooms });
    const chat = /^\/api\/kakao\/chat\/([^/]+)$/.exec(p);
    if (chat) return chats[chat[1]] ? json(chats[chat[1]]) : json({ error: "대화방을 찾지 못했어요" }, 404);
    return demoFetch(input, init);
  };
})();
