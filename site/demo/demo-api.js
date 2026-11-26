/* dotz demo transport: answers every /api/* request from demo/fixtures.js and plays a scripted assistant.
   Loaded before app.js, so no request leaves this page and no real gateway is needed. Replies reach the page through the
   same event stream frames the gateway sends (kind "message" / "out" / "notice"), so the app draws them as it draws real ones. */
(() => {
  const F = window.DEMO_FIXTURES;
  // The page language is picked once in demo-lang.js; L(ko, en) keeps both texts of one line side by side (regexes too, for what a visitor types).
  const L = dotzDemoLang.L;
  const pl = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  // 한글 문서 자동화: the prototype's first project (site/prototype/data.js), so #project/ch:5 reads like #project/docgen. Its purpose is the raw
  // text a real project carries (paths, repos, ports, file names) on purpose: the screens must show it as a plain sentence.
  {
    const { now, ago } = F;
    const lane = { name: F.LANE.docs, title: L("공문 초안 채우기", "Filling in form drafts"), live: true, status: "working", home: "ch:5", model: F.MODEL, startedAt: ago(35), lastReportAt: ago(5), lastText: L("표 서식을 맞추는 중이에요", "Matching the table format") };
    F.projects.unshift({
      key: "ch:5", name: L("한글 문서 자동화", "Form document automation"), pinned: true, recordKey: "ch:5", channel: { id: "5", name: L("한글 문서 자동화", "Form document automation") },
      record: { title: L("한글 문서 자동화", "Form document automation"), purpose: L("공문 양식에 맞춰 HWPX 문서를 만드는 서비스예요. 저장소 ~/Code/docs/docs-web (github example/docs main), 라이브 ~/Code/docs/docs-web-live (4417, tailnet 8444). 규칙은 RULES.md 프로젝트 규칙(docs).", "A service that builds HWPX documents to fit official form templates. Repo ~/Code/docs/docs-web (github example/docs main), live copy ~/Code/docs/docs-web-live (4417, tailnet 8444). Rules are in RULES.md, project rules (docs)."), updated: ago(5), milestones: [{ text: L("양식 분석", "Analyze forms"), done: true }, { text: L("공문 초안 생성", "Generate form drafts"), done: true }, { text: L("표 서식 맞추기", "Match table format"), done: false }, { text: L("검수와 전달", "Review and hand-off"), done: false }] },
      lanes: [lane],
      work: [
        { id: "w-h1", status: "running", description: L("표 서식 점검", "Checking table format"), started_at: now - 6 * 60_000 },
        { id: "w-h2", status: "done", description: L("공문 양식 12종 읽기", "Reading 12 form templates"), started_at: now - 70 * 60_000, ended_at: now - 55 * 60_000 },
      ],
      results: [
        { kind: "report", title: L("공문 초안 3건을 만들었어요", "Made 3 form drafts"), lane: F.LANE.docs, verified: true, at: now - 20 * 60_000 },
        { kind: "report", title: L("양식 12종 분석 보고", "Analysis of 12 form templates"), lane: F.LANE.docs, verified: false, at: now - 26 * 3600_000 },
      ],
      monitors: [{ id: "form-page", name: L("공문 양식 변경", "Form template changes"), on: "change", every_minutes: 720, lastRun: ago(90), lastOk: true, fails: 0, nextAt: new Date(now + 630 * 60_000).toISOString(), script: "watch/form-page.sh" }], summary: { lastActivity: ago(5) },
    });
    F.state.lanes.push(lane);
    F.state.channels.work["5"] = L("한글 문서 자동화", "Form document automation");
    F.state.channels.homes[F.LANE.docs] = "5";
    // 나머지 프로젝트의 세션과 대화: 채팅 목록과 프로젝트 화면이 빈 미리보기나 영문 세션 이름을 보이지 않게 채워요.
    F.state.channels.work["3"] = L("가격 조사", "Price research");
    F.state.channels.work["4"] = L("주간 보고서", "Weekly report");
    F.state.channels.homes[F.LANE.notice] = "2";
    F.state.channels.homes[F.LANE.price] = "3";
    for (const pj of F.projects) for (const l of pj.lanes) if (!F.state.lanes.some(x => x.name === l.name)) F.state.lanes.push({ ...l, model: F.MODEL, lastText: { "ch:2": L("배포 공지 형태를 기다려요", "Waiting for the notice format"), "ch:3": L("요금표 세 곳을 비교하고 있어요", "Comparing three price lists"), "ch:4": L("주간 보고서를 보냈어요", "Sent the weekly report") }[pj.key] });
    const chat = (t, ask, m, reply) => {
      F.histories[t] = [
        { ts: ago(m + 1), kind: "message", source: "web", channel: "web", target: t, text: ask },
        { ts: ago(m), kind: "out", source: "orchestrator", target: t, text: `[done] ${reply}` },
      ];
      F.conversations.push({ target: t, last: { ts: ago(m), text: reply, from: "bot" }, unread: 0, read: ago(m) });
    };
    chat("ch:3", L("경쟁 서비스 세 곳 요금표를 모아 줘", "Collect the price lists of three competitors"), 3, L("요금표 세 곳을 모았어요. 비교표를 만들고 있어요.", "Collected three price lists. Building the comparison table."));
    chat("ch:4", L("이번 주 보고서 정리해 줘", "Write up this week's report"), 52, L("주간 보고서를 정리했어요.", "Wrote up the weekly report."));
    chat("ch:5", L("공문 초안 세 건 만들어 줘", "Make three form drafts"), 5, L("공문 초안 3건을 만들었어요. 표 서식을 맞추고 있어요.", "Made 3 form drafts. Matching the table format now."));
    for (const n of [F.LANE.notice, F.LANE.price, F.LANE.docs, F.LANE.weekly]) {
      const l = F.state.lanes.find(x => x.name === n);
      F.histories[`lane:${n}`] = [{ ts: ago(4), kind: "out", source: `lane:${n}`, lane: n, target: `lane:${n}`, text: l.lastText }];
      F.conversations.push({ target: `lane:${n}`, last: { ts: ago(4), text: l.lastText, from: "session" }, unread: 0, read: ago(4) });
    }
  }
  const NOTE = L("데모에서는 실제로 보내지 않아요", "The demo does not really send anything");
  /* Mail summaries in the format the hub writes now (hub/mail-summary.ts): two lines, what the mail is about, then what to do with the to-do and its
     deadline in **bold**. m-4 keeps its one-line summary so the demo also shows an older mail. The history and conversation records are built from
     the mail when fixtures.js loads, so they are rebuilt here. */
  const TWO = {
    "m-1": L("한서윤님이 다음 주 미팅 시간을 정하려는 메일이에요.\n**화요일 오후 2시와 수요일 오전 10시 중 편한 시간을 회신**해 주세요.", "Seoyun Han wants to set a time for next week's meeting.\n**Reply with the time that suits you, Tuesday 2 PM or Wednesday 10 AM.**"),
    "m-2": L("책상 램프가 오늘 출발해 목요일에 도착한다는 배송 안내예요.\n따로 할 일은 없어요.", "Shipping notice: the desk lamp left today and arrives Thursday.\nNothing to do."),
    "m-3": L("오지훈님이 견적서 수정본을 보내 왔다는 메일이에요.\n**금요일까지 견적서 검토 의견을 회신**해 주세요.", "Jihoon Oh sent a revised quote.\n**Reply with your comments on the quote by Friday.**"),
  };
  for (const [k, summary] of Object.entries(TWO)) {
    const m = F.mails.find(x => x.key === k);
    if (!m) continue;
    m.summary = summary;
    F.histories[`mail:${k}`] = [F.mailEvent(m)];
    const c = F.conversations.find(x => x.target === `mail:${k}`);
    if (c) c.mail = F.mailCard(m);
  }
  // m-1 has a reply draft awaiting confirmation: its asking message is the card of the mail's chat (the open decision notice n-demo-1 carries the same draft).
  F.histories["mail:m-1"].push({ ts: F.T_ASKM1, kind: "out", source: "orchestrator", target: "mail:m-1", text: F.mailDraftAsk });
  const log = { unknown: [], posts: [], said: [] };
  window.__demoApi = log;

  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fail = message => json({ error: message }, 409);
  const isOutward = body => /(^|["\s])(보내기|전송|send)(["\s]|$)/i.test(JSON.stringify(body || {}));
  const lastTs = t => (F.histories[t] || []).reduce((m, e) => Math.max(m, Date.parse(e.ts) || 0), 0);
  const stamp = t => new Date(Math.max(Date.now(), lastTs(t) + 1)).toISOString();
  const conv = t => F.conversations.find(c => c.target === t);
  const plain = s => String(s || "").replace(/^\s*\[[a-z]+\]\s*/i, "").replace(/[#*`>[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  // The web counts the list: items with an id whose class is not log / conv, unread and not dismissed.
  const unread = () => F.notices.items.filter(n => n.id != null && n.cls !== "log" && n.cls !== "conv" && !n.read && !n.dismissed).length;
  const later = (ms, fn) => setTimeout(fn, ms);

  // 댓글 (유튜브 · 인스타그램 · 웹사이트)와 인스타그램 DM: the shapes of GET /api/comments/{sources,threads,thread/<source>/<thread>} and /api/ig-dm (hub/comments/engine.ts
  // threads / threadView, docs/comments-api.md). Each comment shows a different step of its follow-up: draft waiting, reply sent, mail drafted / sent / failed, nothing yet.
  const cmDemo = (() => {
    const now = F.now;
    const min = m => now - m * 60_000;
    const src = (key, kind, app, label) => ({ key, kind, app, label, watch: ["*"], autoDraft: kind !== "website", autoSend: false, autoMail: kind !== "website", mailApp: kind !== "website" ? "mail" : null, error: null, ranAt: min(4) });
    const sources = [src("yt-main", "youtube", "youtube", L("dotz 채널", "dotz channel")), src("ig-main", "instagram", "instagram", "@dotz.daily"), src("site-main", "website", "site", L("dotz 소개 사이트", "dotz intro site"))];
    const views = {};
    // c: [native, parent, author, text, minutes ago, flags]; d: [code, native, text, mail?]; s: [native, state, minutes ago, reason?, mail outcome?]
    const thread = (key, id, title, link, read, c, d = [], s = []) => {
      const source = sources.find(x => x.key === key), cid = n => `cm:${key}:${n}`;
      const sent = new Map(s.filter(x => x[2] !== undefined).map(x => [x[0], x]));
      const mark = n => { const dr = d.find(x => x[1] === n), se = sent.get(n); const mo = se && se[4];
        return mo ? (mo.state === "sent" ? { state: "sent", label: L("메일 보냄", "Mail sent") } : { state: "failed", label: L(`메일 실패: ${mo.text}`, `Mail failed: ${mo.text}`) }) : dr && dr[3] ? { state: "drafted", label: L("메일 초안 작성됨", "Mail drafted") } : undefined; };
      const comments = c.map(([n, parent, author, text, m, f = {}]) => ({ id: cid(n), parent, author, text, at: min(m), mine: !!f.mine, needsReply: !!f.needs, unreplied: !!f.unrep, ...(mark(n) ? { mail: mark(n) } : {}) }));
      views[`${key}/${id}`] = { source: { key, kind: source.kind, label: source.label }, thread: { id, title, link, thumb: null }, comments, read: read === null ? null : min(read),
        drafts: d.map(([code, n, text, mail]) => ({ code, commentId: cid(n), text, notes: [], clean: !mail, created: min(2), ...(mail ? { mail, mailMark: mark(n) } : {}) })),
        sends: s.map(([n, state, m, reason, mail]) => ({ id: `send:${cid(n)}`, commentId: cid(n), text: L("답글을 보냈어요", "Reply sent"), state, at: min(m), via: "owner", ...(reason ? { reason } : {}), ...(mail ? { mail } : {}) })) };
    };
    thread("yt-main", "v1", L("키보드 6개월 사용기", "6 months with the keyboard"), "https://example.com/watch/v1", null, [
      ["k5", null, L("지나가던사람", "Passerby"), L("영상 잘 봤어요! 다음 편도 기대할게요", "Great video. Looking forward to the next one."), 20, { needs: true, unrep: true }],
      ["k1", null, L("구름산책", "CloudWalker"), L("영상에 나온 키보드는 어디서 사요?", "Where can I buy the keyboard from the video?"), 12, { unrep: true }],
      ["k2", null, L("별빛독서", "StarlightReader"), L("스위치 타건음 샘플 파일 받을 수 있을까요? 메일은 reader@example.com 이에요", "Can I get a sample file of the switch typing sound? My email is reader@example.com"), 35, { unrep: true }],
      ["k3", null, L("하나", "Hana"), L("가격표 파일을 메일로 받고 싶어요. hana@example.net", "I'd like the price list file by email. hana@example.net"), 190],
      ["k3r", "k3", L("나", "Me"), L("가격표는 메일로도 보냈어요. 봐 주셔서 고마워요!", "I also emailed the price list. Thanks for watching."), 98, { mine: true }],
      ["k4", null, L("나무늘보", "Sloth"), L("자막이 없어서 아쉬워요", "Too bad there are no subtitles"), 300, { unrep: true }],
      ["k6", null, L("사라", "Sara"), L("사용기 PDF를 메일로 부탁드려요. sara@example.org", "Could you email me the review PDF? sara@example.org"), 1200],
    ], [["DY1", "k1", L("영상 설명란에 구매 링크를 달아 뒀어요.\n봐 주셔서 고마워요!", "I put the purchase link in the video description.\nThanks for watching.")],
      ["DY2", "k2", L("타건음 샘플은 메일로 보내 드릴게요.\n봐 주셔서 고마워요!", "I'll email you the typing sound samples.\nThanks for watching."), { id: "mail-d1", to: "reader@example.com", subject: L("타건음 샘플 파일", "Typing sound sample file"), body: L("안녕하세요. 영상에서 말씀하신 타건음 샘플 파일을 보내 드려요.", "Hello. Here is the typing sound sample file you asked about in the video."), attachments: [{ name: L("타건음-샘플.zip", "typing-sound-samples.zip"), size: "4.2MB" }] }]],
    [["k3", "sent", 100, undefined, { state: "sent", text: L("메일을 보냈어요", "Mail sent") }], ["k4", "failed", 290, L("유튜브가 잠시 거절했어요", "YouTube refused it for now")], ["k6", "sent", 1190, undefined, { state: "failed", text: L("받는 주소가 거절했어요", "The address refused it") }]]);
    thread("yt-main", "v2", L("책상 정리 루틴", "Desk tidy-up routine"), "https://example.com/watch/v2", 40, [
      ["r1", null, L("오리너구리", "Platypus"), L("책상 조명은 뭐 쓰세요?", "Which desk light do you use?"), 70, { needs: true, unrep: true }],
      ["r2", null, L("하루한컷", "OneFramePerDay"), L("배경 음악 제목이 궁금해요", "What's the title of the background music?"), 400],
      ["r2r", "r2", L("나", "Me"), L("음악은 설명란 아래쪽에 적어 뒀어요", "The music is listed lower in the description"), 380, { mine: true }],
    ]);
    thread("ig-main", "p1", L("금요일 라이브 공지", "Friday live announcement"), "https://example.com/p/p1", null, [
      ["i1", null, L("달빛고양이", "MoonlightCat"), L("다음 라이브는 언제 해요?", "When is the next live stream?"), 34, { unrep: true }],
      ["i2", null, L("모카", "Mocha"), L("알림 설정했어요!", "I turned on notifications."), 25, { needs: true, unrep: true }],
      ["i3", null, L("책읽는곰", "BookwormBear"), L("응원해요, 오늘도 화이팅", "Cheering you on, keep it up"), 8, { unrep: true }],
      ["i5", null, L("연필깎이", "Sharpener"), L("라이브 자료를 메일로 받고 싶어요. pencil@example.com", "I'd like the live materials by email. pencil@example.com"), 50, { unrep: true }],
    ], [["DI1", "i1", L("이번 주 금요일 저녁 8시에 해요.\n알림 설정해 두시면 바로 알려 드릴게요.", "It's this Friday at 8 PM.\nTurn on notifications and I'll let you know right away.")],
      ["DI2", "i5", L("라이브 자료는 메일로 보내 드릴게요.", "I'll email you the live materials."), { id: "mail-d2", to: "pencil@example.com", subject: L("금요일 라이브 자료", "Friday live materials"), body: L("안녕하세요. 말씀하신 라이브 자료를 보내 드려요.", "Hello. Here are the live materials you asked about."), attachments: [] }]], [["i3", "sending", 0]]);
    thread("ig-main", "p2", L("신상 노트 입고", "New notebooks in stock"), "https://example.com/p/p2", 60, [
      ["i4", null, L("종이비행기", "PaperPlane"), L("재입고는 언제쯤이에요?", "When will it be restocked?"), 900],
      ["i4r", "i4", L("나", "Me"), L("다음 주 화요일에 들어와요", "It arrives next Tuesday"), 880, { mine: true }],
    ]);
    thread("site-main", "contact", L("문의하기 페이지", "Contact page"), "https://example.com/contact", null, [
      ["w1", null, L("방문자 민트", "Visitor Mint"), L("환불 문의는 어디로 하면 되나요?", "Where do I send a refund request?"), 120, { unrep: true }],
      ["w2", null, L("방문자 도토리", "Visitor Acorn"), L("견적서를 메일로 보내 주세요. buyer@example.com", "Please email me the quote. buyer@example.com"), 600],
    ], [["DW1", "w1", L("문의하기 페이지에 남겨 주시면\n하루 안에 답드릴게요.", "Please leave it on the Contact page,\nand we'll reply within a day.")]], [["w2", "sent", 560, undefined, { state: "sent", text: L("메일을 보냈어요", "Mail sent") }]]);
    const clip = (t, n) => ([...t].length > n ? `${[...t].slice(0, n).join("")}…` : t);
    const mailCounts = list => { const marks = list.filter(c => c.mail), n = s => marks.filter(c => c.mail.state === s).length; return marks.length ? { mails: { drafted: n("drafted"), sent: n("sent"), failed: n("failed") } } : {}; };
    const threads = app => Object.values(views).filter(v => sources.find(s => s.key === v.source.key).app === app).map(v => {
      const last = v.comments[v.comments.length - 1], mineLast = last.mine;
      return { source: v.source.key, thread: v.thread.id, kind: v.source.kind, title: v.thread.title, link: v.thread.link, thumb: null, lastAt: last.at, lastText: clip(last.text, 80), lastAuthor: mineLast ? L("나", "Me") : last.author,
        unread: v.comments.filter(c => !c.mine && (v.read === null || c.at > v.read)).length, drafts: v.drafts.length, unreplied: v.comments.filter(c => c.unreplied).length, ...mailCounts(v.comments) };
    }).sort((a, b) => b.lastAt - a.lastAt);
    // 인스타그램 DM (GET /api/ig-dm, /api/ig-dm/<id>): read only.
    const dmList = { on: true, connected: true, perm: "ok", line: "", convs: [
      { id: "dm1", peer: L("봄이엄마", "Bom's mom"), last: L("배송은 언제쯤 시작돼요?", "When will shipping start?"), lastAt: min(3) },
      { id: "dm2", peer: L("책읽는곰", "BookwormBear"), last: L("후기 영상 잘 봤어요", "I enjoyed the review video"), lastAt: min(1500) },
    ] };
    const dm = {
      dm1: { peer: L("봄이엄마", "Bom's mom"), messages: [{ id: "m1", mine: false, at: min(6), text: L("안녕하세요, 어제 주문했어요.", "Hello, I ordered yesterday.") }, { id: "m2", mine: false, at: min(3), text: L("배송은 언제쯤 시작돼요?", "When will shipping start?") }] },
      dm2: { peer: L("책읽는곰", "BookwormBear"), messages: [{ id: "m3", mine: false, at: min(1510), text: L("후기 영상 잘 봤어요", "I enjoyed the review video") }, { id: "m4", mine: true, at: min(1500), text: L("봐 주셔서 고마워요!", "Thanks for watching.") }] },
    };
    return { sources, views, threads, dmList, dm, needs: { youtube: { drafts: 3, unread: 6, unreplied: 5, sentToday: 1 }, instagram: { drafts: 1, unread: 3, unreplied: 3, sentToday: 0 }, site: { drafts: 1, unread: 2, unreplied: 1, sentToday: 0 } } };
  })();
  cmDemo.integrations = [
    { key: "youtube", label: L("유튜브", "YouTube"), icon: "image", conv: [], notices: [], state: "connected" },
    { key: "instagram", label: L("인스타그램", "Instagram"), icon: "image", conv: [], notices: [], state: "connected" },
    { key: "site", label: L("웹사이트", "Website"), icon: "image", conv: [], notices: [], state: "connected" },
  ];

  // 구성 탭: 지도(단계 카드)와 기능 목록, 프로젝트 비교 카드를 보여 줄 만큼의 손으로 쓴 데이터예요.
  const hn = (id, kind, group, label, summary, extra = {}) => ({ id, kind, group, label, summary, desc: summary + L(" 이 단계가 하는 일을 한 줄로 적었어요.", " A one-line note on what this step does."), status: "ok", facts: [], settings: [], ...extra });
  const hset = (key, label, value, type, extra = {}) => ({ key, label, value, type, editable: true, applies: "live", source: "config.json:" + key, ...extra });
  const HARNESS_FX = {
    generated: new Date().toISOString(), data_dir: "~/.dotz", layers: [],
    nodes: [
      hn("ch-web", "channel", "flow", L("웹 채팅", "Web chat"), L("브라우저에서 보낸 글", "Messages sent from the browser"), { facts: [{ label: L("연결", "Connection"), value: L("2개 기기", "2 devices") }] }),
      hn("ch-discord", "channel", "flow", "Discord", L("서버 1곳 · 채널 3개", "1 server · 3 channels"), { status: "warn", facts: [{ label: L("연결", "Connection"), value: L("재연결 중", "Reconnecting") }] }),
      hn("gateway", "gateway", "flow", L("게이트웨이", "Gateway"), L("들어온 글을 모아 어시스턴트에게 넘겨요", "Collects incoming messages and passes them to the assistant"), { facts: [{ label: L("열린 길", "Open port"), value: "8080" }], settings: [hset("gateway.debounce", L("글 묶는 시간", "Message batching time"), 1200, "number", { unit: "ms", default: 800, min: 0, max: 5000 }), hset("gateway.quiet", L("조용한 시간 알림 끄기", "Mute notifications at quiet hours"), true, "bool", { default: false })] }),
      hn("orchestrator", "orchestrator", "flow", L("어시스턴트", "Assistant"), L("받은 글을 읽고 할 일을 나눠요", "Reads messages and splits up the work"), { status: "busy", facts: [{ label: L("모델", "Model"), value: "Opus 4.8" }], settings: [hset("orchestrator.thinking", L("생각 강도", "Thinking level"), "high", "select", { options: [{ value: "low", label: L("낮음", "Low") }, { value: "high", label: L("높음", "High") }], default: "medium" }), hset("orchestrator.reply_style", L("답 말투", "Reply tone"), L("해요체", "Plain and friendly"), "text", { default: L("해요체", "Plain and friendly") })] }),
      hn("lanes", "lanes", "flow", L("세션", "Sessions"), L("채널마다 이어지는 작업 줄 4개", "4 work threads, one per channel"), { status: "busy", facts: [{ label: L("돌아가는 중", "Running"), value: L("2개", "2") }] }),
      hn("workers", "workers", "flow", L("서브에이전트", "Subagents"), L("나눠 맡은 일을 따로 처리해요", "Handle split-off work separately")),
      hn("rules", "file", "files", "RULES.md", L("지킬 규칙 12줄", "12 lines of rules to follow"), { anchor: "orchestrator", file: "RULES.md", fileEditable: true, order: 1 }),
      hn("lessons", "file", "files", "LESSONS.md", L("배운 것 8줄", "8 lines of lessons"), { anchor: "orchestrator", file: "LESSONS.md", fileEditable: true, order: 2 }),
      hn("memory", "system", "support", L("기억", "Memory"), L("메모 41개", "41 notes"), { anchor: "orchestrator", order: 3 }),
      hn("monitor", "system", "support", L("모니터링", "Monitoring"), L("점검 3개", "3 checks"), { anchor: "lanes", order: 1 }),
    ],
    edges: [
      { from: "ch-web", to: "gateway", label: L("들어온 글", "Incoming messages") }, { from: "ch-discord", to: "gateway", label: L("들어온 글", "Incoming messages") },
      { from: "gateway", to: "orchestrator", label: L("묶은 글", "Batched messages") }, { from: "orchestrator", to: "lanes", label: L("일 맡기기", "Hand off work") }, { from: "lanes", to: "workers", label: L("나눈 일", "Split work") },
      { from: "rules", to: "orchestrator", label: L("규칙", "Rules") }, { from: "lessons", to: "orchestrator", label: L("배운 것", "Lessons") }, { from: "memory", to: "orchestrator", label: L("기억", "Memory") }, { from: "monitor", to: "lanes", label: L("변화", "Changes") },
    ],
    projects: [
      { id: "p-blog", name: L("블로그 정리", "Blog cleanup"), status: "working", status_text: L("작업 중", "Working"), overrides: 2, cwd: "~/projects/blog", channels: [{ kind: "work", kind_text: L("작업 채널", "Work channel"), name: L("블로그", "Blog") }],
        fields: { model: { value: "claude-opus-4-8", global: "claude-opus-4-8", source: "global" }, effort: { value: "xhigh", global: "high", source: "project" }, worker_model: { value: "claude-sonnet-5-5", global: "claude-sonnet-5-5", source: "global" }, worker_effort: { value: "medium", global: "medium", source: "global" }, runtime: { value: "omo", global: "omo", source: "global" }, fallback: { value: [], global: [], source: "global" }, worker_fallback: { value: [], global: [], source: "global" } },
        files: [{ name: "AGENTS.md", bytes: 2480, modified: new Date(Date.now() - 864e5).toISOString() }], features: [{ name: L("글 올리기 전 맞춤법", "Spell check before posting") }], deny: ["rm -rf"], setup: { purpose: L("블로그 글을 다듬고 올려요.", "Polishes and posts blog entries."), logins: [{ name: L("티스토리", "Tistory") }], monitors: [1], standing: "" },
        map: { nodes: [], edges: [] } },
      { id: "p-home", name: L("집안일", "Household"), status: "idle", status_text: L("대기", "Idle"), overrides: 0, cwd: "~/projects/home", channels: [{ kind: "home", kind_text: L("홈 채널", "Home channel"), name: L("집", "Home") }],
        fields: { model: { value: "claude-opus-4-8", global: "claude-opus-4-8", source: "global" }, effort: { value: "high", global: "high", source: "global" }, worker_model: { value: "claude-sonnet-5-5", global: "claude-sonnet-5-5", source: "global" }, worker_effort: { value: "medium", global: "medium", source: "global" }, runtime: { value: "omo", global: "omo", source: "global" }, fallback: { value: [], global: [], source: "global" }, worker_fallback: { value: [], global: [], source: "global" } },
        files: [], features: [], deny: [], setup: null, map: { nodes: [], edges: [] } },
    ],
  };
  HARNESS_FX.projects.forEach(p => { p.map = { nodes: HARNESS_FX.nodes.filter(n => n.group === "flow" && !n.id.startsWith("ch-")).concat(HARNESS_FX.nodes.filter(n => n.id === "ch-web")), edges: HARNESS_FX.edges.filter(e => !/^ch-discord/.test(e.from) && !["rules", "lessons", "memory", "monitor"].includes(e.from)) }; });
  const hf = (id, form, name, what, trigger, stage, strength, label, extra = {}) => ({ id, form, name, what, trigger, stage, strength, source: { label }, enabled: true, toggleable: false, origin: "personal", ...extra });
  const FEATURES_FX = {
    generated: new Date().toISOString(), harness: { id: "omo", name: "OmO", dirs: [] }, data_dir: "~/.dotz", skipped_dirs: [],
    forms: [L("글 지시", "Text instruction"), L("차단 명령", "Blocked command"), L("기능 폴더", "Feature folder"), L("예약", "Schedule"), L("모니터링", "Monitoring")],
    triggers: [L("메시지 도착", "Message arrives"), L("정해진 시각", "Set time"), L("변화 감지", "Change detected"), L("도구 실행 직전", "Before a tool runs"), L("항상(프롬프트)", "Always (prompt)")],
    stages: HARNESS_FX.nodes.map(n => n.id),
    features: [
      hf("f1", L("글 지시", "Text instruction"), L("답은 해요체로 짧게", "Short, friendly replies"), L("답장은 해요체로, 세 줄 안에 끝내요.", "Replies are friendly and end within three lines."), L("항상(프롬프트)", "Always (prompt)"), "rules", "advisory", "RULES.md:4", { source: { label: "RULES.md:4", file: "RULES.md", line: 4 } }),
      hf("f2", L("차단 명령", "Blocked command"), L("강제 삭제 막기", "Block forced delete"), L("rm -rf 가 들어간 명령은 실행 직전에 막아요.", "Commands containing rm -rf are blocked right before they run."), L("도구 실행 직전", "Before a tool runs"), "rules", "enforced", "RULES.md:9", { source: { label: "RULES.md:9", file: "RULES.md", line: 9 } }),
      hf("f3", L("기능 폴더", "Feature folder"), L("아침 요약", "Morning summary"), L("매일 아침 일정과 메일을 한 번에 요약해요.", "Summarizes your schedule and mail every morning."), L("정해진 시각", "Set time"), "lanes", "advisory", "features/morning/feature.md", { toggleable: true, enabled: true }),
      hf("f4", L("기능 폴더", "Feature folder"), L("가격 변화 알림", "Price change alert"), L("관심 상품 가격이 내려가면 알려 줘요.", "Tells you when a product you follow gets cheaper."), L("변화 감지", "Change detected"), "lanes", "enforced", "features/price/feature.md", { toggleable: true, enabled: false }),
      hf("f5", L("예약", "Schedule"), L("주간 정리", "Weekly wrap-up"), L("금요일 저녁에 한 주를 정리해요.", "Wraps up the week on Friday evening."), L("정해진 시각", "Set time"), "lanes", "advisory", "schedules.json"),
      hf("f6", L("모니터링", "Monitoring"), L("블로그 댓글 확인", "Blog comment check"), L("10분마다 새 댓글만 알려요.", "Every 10 minutes, tells you about new comments only."), L("변화 감지", "Change detected"), "lanes", "enforced", "watches.json"),
    ],
  };

  /* ---------- the event stream: the page's EventSource is this stub, and every scripted frame goes through its onmessage ---------- */
  const streams = new Set();
  const ES = function () {
    this.readyState = 1;
    this.url = "/api/events";
    this.onopen = null; this.onmessage = null; this.onerror = null;
    this.listeners = {};
    streams.add(this);
    setTimeout(() => { if (this.readyState === 1) for (const f of this.listeners.reset || []) f({ data: "{}" }); }, 0);
  };
  ES.CONNECTING = 0; ES.OPEN = 1; ES.CLOSED = 2;
  ES.prototype.addEventListener = function (k, f) { (this.listeners[k] ||= []).push(f); };
  ES.prototype.removeEventListener = function (k, f) { this.listeners[k] = (this.listeners[k] || []).filter(x => x !== f); };
  ES.prototype.close = function () { this.readyState = 2; streams.delete(this); };
  window.EventSource = ES;
  const emit = frame => { for (const es of streams) if (es.onmessage) es.onmessage({ data: JSON.stringify(frame) }); };
  const repaint = () => { if (typeof refreshState === "function") refreshState(); };

  function remember(t, e) {
    (F.histories[t] ||= []).push(e);
    const c = conv(t) || (F.conversations.push({ target: t, last: null, unread: 0, read: null }), conv(t));
    c.last = { ts: e.ts, text: plain(e.text), from: e.kind === "message" ? "owner" : "bot" };
    c.unread = 0;
    c.read = e.ts;
  }
  function post(t, text, extra = {}) {
    const e = { ts: stamp(t), kind: "out", source: "orchestrator", target: t, text, ...extra };
    remember(t, e);
    emit(e);
    return e;
  }
  function ownerSays(t, text, picks) {
    const e = { ts: stamp(t), kind: "message", source: "web", channel: "web", target: t, text, ...(picks && picks.length ? { picks } : {}) };
    remember(t, e);
    emit(e);
  }
  function setWorking(on) {
    F.state.orchestrator.status = on ? "working" : "idle";
    repaint();
  }
  function notice(item, alertText) {
    const n = { id: `n-live-${Date.now()}`, kind: "notice", cls: "news", tone: "", at: new Date().toISOString(), read: false, ...item };
    F.notices.items.unshift(n);
    F.state.notices_unread = unread();
    emit({ kind: "notice", item: n });
    if (alertText) {
      const e = { ts: stamp("alert"), kind: "out", source: "gateway", target: "alert", text: alertText };
      remember("alert", e);
      conv("alert").unread = (conv("alert").unread | 0) + 1;
      emit(e);
    }
    repaint();
  }
  function worklog(text) {
    const e = { ts: stamp("worklog"), kind: "out", source: "gateway", target: "worklog", text };
    remember("worklog", e);
  }

  /* ---------- the script: per-conversation state, so follow-ups work several rounds deep ---------- */
  const ST = {};
  const st = t => (ST[t] ||= { card: null, draft: null, list: null, last: null, awaitEdit: false, alt: 0 });
  ST["ch:2"] = { ...st("ch:2"), card: { kind: "pick", options: L(["짧은 공지", "목록 공지", "공지 없이 배포"], ["Short notice", "List notice", "Release without notice"]) } };
  ST["mail:m-1"] = { ...st("mail:m-1"), card: { kind: "send" }, draft: { kind: "mail", key: "m-1", variant: "normal" } };

  const mail = k => F.mails.find(m => m.key === k);
  const who = m => (m.org ? m.name : L(`${m.name}님`, m.name));
  const inbox = () => F.mails.filter(m => m.dir === "in" && !m.archived);
  const owed = () => inbox().filter(m => m.reply === "needs" || m.reply === "draft");
  const quote = lines => lines.map(l => `> ${l}`).join("\n");
  const rx = (s, re) => re.test(s);
  const SUGGEST = L("이렇게 말해 보세요.\n\n- 메일 정리해 줘\n- 오늘 일정 알려 줘\n- 가격 페이지 바뀌면 알려 줘", "Try saying:\n\n- Sort my mail\n- What's on my schedule today\n- Tell me when the price page changes");

  const ORD = L([[/(첫\s*번?째|첫\s*번|1\s*번|하나)/, 1], [/(두\s*번?째|2\s*번|둘)/, 2], [/(세\s*번?째|3\s*번|셋)/, 3], [/(네\s*번?째|4\s*번|넷)/, 4], [/마지막/, -1]], [[/\b(first|1st|one)\b/i, 1], [/\b(second|2nd|two)\b/i, 2], [/\b(third|3rd|three)\b/i, 3], [/\b(fourth|4th|four)\b/i, 4], [/\blast\b/i, -1]]);
  function ordinal(s) {
    const bare = L(/^\s*([1-4])\s*(?:\)|번)?\s*(?:[-–:]\s*(.*))?$/, /^\s*([1-4])\s*(?:\)|\.)?\s*(?:[-–:]\s*(.*))?$/).exec(s);
    if (bare) return { n: Number(bare[1]), note: (bare[2] || "").trim() };
    for (const [re, n] of ORD) if (re.test(s)) return { n, note: "" };
    return null;
  }
  const pickFrom = (list, n) => (n === -1 ? list[list.length - 1] : list[n - 1]);

  /* ---- drafts: a mail reply or a comment reply, each with a few variants ---- */
  const MAIL_DRAFT = {
    "m-1": {
      normal: L(["안녕하세요, 서윤님.", "다음 주 화요일 오후 2시가 좋아요.", "온라인으로 뵐까요?", "감사합니다."], ["Hi Seoyun,", "Tuesday at 2 PM next week works for me.", "Shall we meet online?", "Thanks."]),
      short: L(["서윤님, 화요일 오후 2시 좋아요.", "온라인으로 뵐게요."], ["Seoyun, Tuesday at 2 PM works.", "Let's do it online."]),
      formal: L(["안녕하십니까, 한서윤 님.", "다음 주 화요일 오후 2시에 뵙겠습니다.", "장소는 온라인으로 제안드립니다.", "감사합니다."], ["Dear Seoyun Han,", "I would like to meet next Tuesday at 2 PM.", "I suggest we meet online.", "Thank you."]),
      casual: L(["서윤님, 화요일 2시 어때요?", "온라인으로 편하게 봬요!"], ["Seoyun, how about Tuesday at 2?", "Let's just do it online."]),
      time: L(p => ["안녕하세요, 서윤님.", `다음 주 ${p}가 좋아요.`, "온라인으로 뵐까요?", "감사합니다."], p => ["Hi Seoyun,", `${p} works for me.`, "Shall we meet online?", "Thanks."]),
    },
    "m-3": {
      normal: L(["지훈님, 수정본 잘 받았어요.", "금요일까지 검토하고 의견 드릴게요.", "감사합니다."], ["Jihoon, I got the revised quote.", "I'll review it and send my comments by Friday.", "Thanks."]),
      short: L(["지훈님, 잘 받았어요.", "금요일까지 의견 드릴게요."], ["Jihoon, got it.", "I'll send comments by Friday."]),
      formal: L(["오지훈 님, 수정본 잘 받았습니다.", "금요일까지 검토 후 회신드리겠습니다.", "감사합니다."], ["Dear Jihoon Oh, I received the revised quote.", "I will review it and reply by Friday.", "Thank you."]),
      casual: L(["지훈님, 받았어요!", "금요일 전에 의견 드릴게요."], ["Jihoon, got it.", "I'll send comments before Friday."]),
      time: L(p => ["지훈님, 수정본 잘 받았어요.", `${p}까지 검토하고 의견 드릴게요.`, "감사합니다."], p => ["Jihoon, I got the revised quote.", `I'll review it and send my comments by ${p}.`, "Thanks."]),
    },
  };
  const genericDraft = m => ({
    normal: L([`${m.short}, 메일 잘 받았어요.`, "확인하고 다시 연락드릴게요.", "감사합니다."], [`${m.short}, thanks for your mail.`, "I'll check and get back to you.", "Thanks."]),
    short: L([`${m.short}, 잘 받았어요. 고마워요.`], [`${m.short}, got it. Thanks.`]),
    formal: L([`${m.name} 님, 메일 잘 받았습니다.`, "확인 후 다시 연락드리겠습니다."], [`Dear ${m.name}, thank you for your mail.`, "I will check and get back to you."]),
    casual: L([`${m.short}, 받았어요!`, "곧 다시 연락할게요."], [`${m.short}, got it.`, "I'll get back to you soon."]),
    time: L(p => [`${m.short}, 메일 잘 받았어요.`, `${p}까지 다시 연락드릴게요.`], p => [`${m.short}, thanks for your mail.`, `I'll get back to you by ${p}.`]),
  });
  const VARIANT_KO = L({ normal: "기본", short: "짧게", formal: "정중하게", casual: "편하게" }, { normal: "Default", short: "Shorter", formal: "More formal", casual: "More casual" });
  const TIME_RE = L(/((?:다음\s*주\s*)?(?:[월화수목금토일]요일)(?:\s*(?:오전|오후|아침|저녁))?(?:\s*\d{1,2}\s*시(?:\s*반)?)?|(?:내일|모레)(?:\s*(?:오전|오후))?(?:\s*\d{1,2}\s*시)?|(?:오전|오후)\s*\d{1,2}\s*시(?:\s*반)?)/, /((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))?|(?:tomorrow|day after tomorrow)(?:\s+(?:morning|afternoon))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))?|\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);

  function draftLines(d) {
    if (d.kind === "mail") {
      const set = MAIL_DRAFT[d.key] || genericDraft(mail(d.key));
      const base = d.time ? set.time(d.time) : set[d.variant] || set.normal;
      return d.extra ? [...base.slice(0, -1), d.extra, base[base.length - 1]] : base;
    }
    const c = F.comments.find(x => x.n === d.n);
    const base = d.variant === "short" ? c.short : d.variant === "formal" ? L([`${c.author} 님, 문의 감사합니다.`, ...c.reply], [`${c.author}, thank you for your question.`, ...c.reply]) : d.variant === "casual" ? L([`${c.author}님!`, ...c.short], [`Hi ${c.author}.`, ...c.short]) : c.reply;
    return d.extra ? [...base, d.extra] : base;
  }
  function draftCard(t, d, lead) {
    st(t).draft = d;
    st(t).card = { kind: "send" };
    st(t).awaitEdit = false;
    const head = d.kind === "mail"
      ? L(`받는이: ${mail(d.key).name}\n제목: Re: ${mail(d.key).subject}`, `To: ${mail(d.key).name}\nSubject: Re: ${mail(d.key).subject}`)
      : L(`${d.platform} · ${F.comments.find(x => x.n === d.n).author}님 댓글에 답글`, `Reply to ${F.comments.find(x => x.n === d.n).author}'s ${d.platform} comment`);
    return L(`[ask] ${lead}\n\n${head}\n\n${quote(draftLines(d))}\n\n결정: 이대로 보낼까요?\n1) 보내기 ← 추천\n${d.kind === "mail" ? "이 초안으로 답장해요" : "이 답글을 달아요"}\n2) 고치기\n고칠 내용을 적어 주세요\n3) 보내지 않기\n초안을 버려요`, `[ask] ${lead}\n\n${head}\n\n${quote(draftLines(d))}\n\nDecision: Send it as is?\n1) Send ← recommended\n${d.kind === "mail" ? "Reply with this draft" : "Post this reply"}\n2) Edit\nTell me what to change\n3) Don't send\nDiscard the draft`);
  }
  function revise(t, how) {
    const d = { ...st(t).draft };
    const time = TIME_RE.exec(how);
    if (rx(how, L(/짧|줄여|간단|간결/, /short|brief|concise|trim/i))) { d.variant = "short"; d.time = ""; }
    else if (rx(how, L(/정중|공손|격식|예의|딱딱/, /formal|polite|professional|respectful/i))) { d.variant = "formal"; d.time = ""; }
    else if (rx(how, L(/편하|친근|캐주얼|가볍|부드럽/, /casual|friendly|relaxed|warm|light/i))) { d.variant = "casual"; d.time = ""; }
    else if (time && d.kind === "mail") d.time = time[1].replace(/\s+/g, " ").trim();
    else {
      const ask = L(how.replace(/(?:도|을|를)?\s*(?:넣어|추가해|덧붙여|말해|적어|써|물어봐)\s*(?:줘|주세요|줄래)?[.!]?$/, "").replace(/라고$/, "").trim(), how.replace(/^(?:please\s+)?(?:also\s+)?(?:add|include|mention|say|write|put|ask)\s+(?:that\s+)?/i, "").trim());
      d.extra = ask ? L(`${ask.replace(/[.!?]$/, "")}도 함께 전해 드려요.`, `${cap(ask.replace(/[.!?]$/, ""))}.`) : d.extra;
    }
    return draftCard(t, d, L("고쳤어요. 다시 확인해 주세요.", "Updated. Please check it again."));
  }
  function sendDraft(t) {
    const d = st(t).draft;
    st(t).card = null; st(t).draft = null;
    if (d.kind === "mail") {
      const m = mail(d.key);
      m.reply = "replied"; delete m.suggest;
      const sent = { key: `s-${Date.now()}`, at: new Date().toISOString(), dir: "out", read: true, from: L("나 <me@example.com>", "Me <me@example.com>"), to: m.from, name: m.name, short: m.short, subject: `Re: ${m.subject}`, summary: L("dotz가 쓴 답장이에요.", "A reply written by dotz."), text: draftLines(d).join("\n") };
      F.mails.push(sent);
      const c = conv(`mail:${m.key}`); if (c && c.mail) { c.mail.reply = "replied"; delete c.mail.suggest; }
      F.histories[`mail:${sent.key}`] = [F.mailEvent(sent)];
      F.conversations.push({ target: `mail:${sent.key}`, last: { ts: sent.at, text: sent.subject, from: "owner" }, unread: 0, read: sent.at, mail: F.mailCard(sent) });
      worklog(L(`${who(m)}에게 답장을 보냈어요. (데모)`, `Sent a reply to ${who(m)}. (demo)`));
      later(200, () => { if (typeof convLoad === "function") convLoad(); });
      return L(`[done] 보냈어요. 보낸 메일함에서 볼 수 있어요.\n\n- 받는이: ${m.name}\n- 제목: Re: ${m.subject}\n\n데모라 실제로 나가지는 않아요.`, `[done] Sent. You can see it in your sent mail.\n\n- To: ${m.name}\n- Subject: Re: ${m.subject}\n\nThis is a demo, so nothing really went out.`);
    }
    const c = F.comments.find(x => x.n === d.n);
    c.done = true;
    worklog(L(`${c.platform} 댓글에 답글을 달았어요. (데모)`, `Replied to a ${c.platform} comment. (demo)`));
    const left = F.comments.filter(x => !x.done);
    return L(`[done] ${c.platform}에 답글을 달았어요.\n데모라 실제로 올라가지는 않아요.${left.length ? `\n\n남은 댓글이 ${left.length}개예요. "다음 댓글"이라고 하면 이어서 써요.` : ""}`, `[done] Replied on ${c.platform}.\nThis is a demo, so nothing was really posted.${left.length ? `\n\n${pl(left.length, "comment")} left. Say "next comment" to keep going.` : ""}`);
  }
  const DROPPED = L("알겠어요. 초안은 버렸고 아무것도 보내지 않았어요.", "Okay. I dropped the draft and sent nothing.");
  function dropDraft(t) {
    const d = st(t).draft, m = d && d.kind === "mail" && mail(d.key);
    if (m && m.suggest) { delete m.suggest; if (m.reply === "draft") m.reply = "needs"; const c = conv(`mail:${m.key}`); if (c && c.mail) { c.mail.reply = m.reply; delete c.mail.suggest; } }
    st(t).card = null; st(t).draft = null; st(t).awaitEdit = false;
    return DROPPED;
  }

  /* ---- topics ---- */
  function mailSummary(t) {
    const list = inbox();
    st(t).list = { kind: "mail", items: list.map(m => m.key) };
    const lines = list.map((m, i) => `${i + 1}. ${m.name} · ${m.subject}${m.reply === "needs" ? L(" (답장 필요)", " (reply needed)") : ""}`);
    return {
      text: L(`받은 메일 ${list.length}통을 정리했어요.\n답장할 메일은 ${owed().length}통이에요.\n\n${lines.join("\n")}\n\n번호를 말하면 읽어 드리고,\n"답장 써 줘"라고 하면 초안을 써요.`, `Your inbox has ${pl(list.length, "mail")}.\n${owed().length} to reply to.\n\n${lines.join("\n")}\n\nSay a number and I'll read it out,\nor say "write a reply" and I'll draft one.`),
      short: L(`답장할 메일은 ${owed().map(who).join(", ")} 메일이에요.`, `You need to reply to the mail from ${owed().map(who).join(", ")}.`),
    };
  }
  function readMail(t, m) {
    st(t).focus = m.key;
    m.read = true;
    const c = conv(`mail:${m.key}`); if (c && c.mail) c.mail.read = true;
    return {
      text: L(`${who(m)} 메일이에요.\n제목: ${m.subject}\n\n${quote(m.text.split("\n").filter(l => l.trim()))}${m.attachments ? `\n\n첨부: ${m.attachments.map(a => a.name).join(", ")}` : ""}\n\n${m.reply === "needs" ? "답장 초안을 써 드릴까요?" : "답장은 필요 없어 보여요."}`, `Mail from ${who(m)}.\nSubject: ${m.subject}\n\n${quote(m.text.split("\n").filter(l => l.trim()))}${m.attachments ? `\n\nAttached: ${m.attachments.map(a => a.name).join(", ")}` : ""}\n\n${m.reply === "needs" ? "Want me to draft a reply?" : "It doesn't look like it needs a reply."}`),
      short: m.summary,
    };
  }
  function pickMail(t, s) {
    if (t.startsWith("mail:")) return mail(t.slice(5));
    const by = F.mails.find(m => m.dir === "in" && (s.toLowerCase().includes(m.name.toLowerCase()) || s.toLowerCase().includes(m.short.replace(/님$/, "").toLowerCase()) || (m.key === "m-3" && L(/견적/, /quote|estimate/i).test(s)) || (m.key === "m-1" && L(/미팅/, /meeting/i).test(s)) || (m.key === "m-2" && L(/배송|램프|주문/, /shipping|delivery|lamp|order/i).test(s)) || (m.key === "m-4" && L(/소식지|뉴스레터/, /newsletter|news/i).test(s))));
    if (by) return by;
    const o = ordinal(s), lst = st(t).list;
    if (o && lst && lst.kind === "mail") return mail(pickFrom(lst.items, o.n));
    if (st(t).focus) return mail(st(t).focus);
    return null;
  }
  function mailReply(t, m) {
    m = m || owed()[0];
    if (!m) return { text: L("답장할 메일이 없어요. 받은 메일은 모두 처리됐어요.", "No mail needs a reply. Your inbox is all handled.") };
    return { text: draftCard(t, { kind: "mail", key: m.key, variant: "normal" }, L(`${who(m)}에게 보낼 답장 초안이에요.`, `Here is a draft reply to ${who(m)}.`)) };
  }
  const evLine = e => `- ${e.at} ${e.title}${e.where ? ` · ${e.where}` : ""}`;
  function schedule(t, day) {
    const list = F.calendar[day];
    st(t).list = { kind: "event", items: list };
    return {
      text: L(`${day === "today" ? "오늘" : "내일"} 일정은 ${list.length}개예요.\n\n${list.map(evLine).join("\n")}\n\n${day === "today" ? "\"내일은?\"이라고 물어봐도 돼요." : "오늘 일정으로 돌아가려면 \"오늘 일정\"이라고 해 주세요."}`, `You have ${pl(list.length, "event")} ${day === "today" ? "today" : "tomorrow"}.\n\n${list.map(evLine).join("\n")}\n\n${day === "today" ? "You can also ask \"What about tomorrow?\"" : "Say \"today's schedule\" to go back to today."}`),
      short: L(`${day === "today" ? "오늘" : "내일"} 첫 일정은 ${list[0].at} ${list[0].title}이에요.`, `Your first event ${day === "today" ? "today" : "tomorrow"} is ${list[0].at} ${list[0].title}.`),
    };
  }
  function briefing() {
    const ev = F.calendar.today;
    return {
      text: L(`좋은 아침이에요. 오늘 브리핑이에요.\n\n- 일정 ${ev.length}개, 첫 일정은 ${ev[0].at} ${ev[0].title}\n- 안 읽은 메일 ${inbox().filter(m => !m.read).length}통, 답장할 메일 ${owed().length}통\n- 댓글 ${F.comments.filter(c => !c.done).length}개가 답글을 기다려요\n- 감시 중인 페이지는 변화 없어요\n\n하나씩 볼까요? "메일부터"처럼 말해 주세요.`, `Good morning. Here is today's briefing.\n\n- ${pl(ev.length, "event")}, the first is ${ev[0].at} ${ev[0].title}\n- ${pl(inbox().filter(m => !m.read).length, "unread mail")}, ${owed().length} to reply to\n- ${pl(F.comments.filter(c => !c.done).length, "comment")} waiting for a reply\n- No changes on the pages I'm watching\n\nShall we go through them one by one? Try "mail first".`),
      short: L(`오늘은 일정 ${ev.length}개, 답장할 메일 ${owed().length}통이에요.`, `Today: ${pl(ev.length, "event")}, ${owed().length} to reply to.`),
    };
  }
  function commentList(t) {
    const left = F.comments.filter(c => !c.done);
    if (!left.length) return { text: L("답글을 기다리는 댓글이 없어요. 모두 처리했어요.", "No comments are waiting for a reply. All done.") };
    st(t).list = { kind: "comment", items: left.map(c => c.n) };
    st(t).card = { kind: "comment" };
    return { text: L(`[ask] 답글을 기다리는 댓글이 ${left.length}개예요.\n\n${left.map((c, i) => `${i + 1}. ${c.platform} · ${c.author}: "${c.text}"`).join("\n")}\n\n결정: 어느 댓글에 답글을 쓸까요?\n${left.map((c, i) => `${i + 1}) ${c.platform} 댓글${i === 0 ? " ← 추천" : ""}\n${c.author}님`).join("\n")}`, `[ask] ${pl(left.length, "comment")} waiting for a reply.\n\n${left.map((c, i) => `${i + 1}. ${c.platform} · ${c.author}: "${c.text}"`).join("\n")}\n\nDecision: Which comment should I reply to?\n${left.map((c, i) => `${i + 1}) ${c.platform} comment${i === 0 ? " ← recommended" : ""}\n${c.author}`).join("\n")}`) };
  }
  function commentReply(t, c) {
    return { text: draftCard(t, { kind: "comment", n: c.n, platform: c.platform, variant: "normal" }, L(`${c.author}님 댓글에 달 답글 초안이에요.\n원댓글: "${c.text}"`, `Here is a draft reply to ${c.author}'s comment.\nOriginal: "${c.text}"`)) };
  }
  function pickComment(t, s) {
    const plat = L(/유튜브|youtube/i, /youtube/i).test(s) ? L("유튜브", "YouTube") : L(/인스타/, /insta/i).test(s) ? L("인스타그램", "Instagram") : L(/웹사이트|사이트|홈페이지/, /website|site|web ?page/i).test(s) ? L("웹사이트", "Website") : "";
    const left = F.comments.filter(c => !c.done);
    return (plat && left.find(c => c.platform === plat)) || null;
  }
  const WHAT = { price: L("가격", "price"), stock: L("재고", "stock"), notice: L("공지", "announcements"), content: L("내용", "content") };
  function watchAsk(t, s) {
    const url = (/(https?:\/\/\S+|[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?)/i.exec(s) || [])[1] || "example.com/pricing";
    const what = L(/가격|요금/, /price|pricing|cost|fee|rate/i).test(s) ? "price" : L(/재고|품절/, /stock|sold out|availability/i).test(s) ? "stock" : L(/공지|뉴스/, /announcement|news|notice/i).test(s) ? "notice" : "content";
    st(t).card = { kind: "watch", url, what };
    return { text: L(`[ask] ${url} 페이지의 ${WHAT[what]}이 바뀌면 알려 드릴게요.\n바뀐 곳만 짧게 알림으로 보내요.\n\n결정: 얼마나 자주 확인할까요?\n1) 30분마다 ← 추천\n빠르게 알아요\n2) 하루 한 번\n아침 9시에 확인해요\n3) 그만두기\n감시를 만들지 않아요`, `[ask] I'll tell you when the ${WHAT[what]} on ${url} changes.\nYou get a short notification with just what changed.\n\nDecision: How often should I check?\n1) Every 30 minutes ← recommended\nCatch changes quickly\n2) Once a day\nCheck at 9 AM\n3) Never mind\nDon't create the watch`) };
  }
  function watchOn(t, n) {
    const c = st(t).card; st(t).card = null;
    if (n === 3) return L("알겠어요. 감시는 만들지 않았어요.", "Okay. I didn't create the watch.");
    const every = n === 1 ? L("30분마다", "every 30 minutes") : L("하루 한 번", "once a day");
    const name = L(`${c.url.replace(/^https?:\/\//, "").split("/")[0]} ${WHAT[c.what]} 감시`, `${c.url.replace(/^https?:\/\//, "").split("/")[0]} ${WHAT[c.what]} watch`);
    F.monitors.push({ name, kind: "watch", watch: `demo-${Date.now()}`, scope: "plain", last_run: new Date().toISOString(), next_run: new Date(Date.now() + (n === 1 ? 30 : 1440) * 60_000).toISOString(), last_result: "ok" });
    worklog(L(`감시를 켰어요: ${name} (${every})`, `Watch turned on: ${name} (${every})`));
    later(9000, () => {
      const m = F.monitors.find(x => x.name === name); if (m) m.last_result = "changed";
      notice({ src: "alert", open: "alert", title: L(`${name}: 바뀐 곳이 있어요`, `${name}: something changed`) }, L(`[${name}] 바뀐 곳이 있어요.\n\n- ${c.what === "price" ? "기본 요금이 9,900원에서 8,900원으로 내려갔어요" : "새 문단이 하나 추가됐어요"}`, `[${name}] Something changed.\n\n- ${c.what === "price" ? "The base plan dropped from KRW 9,900 to KRW 8,900" : "One new paragraph was added"}`));
      post(t, L(`방금 ${name}에서 변화를 찾았어요.\n${c.what === "price" ? "기본 요금이 8,900원으로 내려갔어요." : "새 문단이 하나 추가됐어요."}\n\n알림 탭에도 남겨 뒀어요.`, `I just found a change on ${name}.\n${c.what === "price" ? "The base plan dropped to KRW 8,900." : "One new paragraph was added."}\n\nI also left it in the Notices tab.`));
    });
    return L(`[done] 감시를 켰어요.\n\n- 대상: ${c.url}\n- 주기: ${every}\n- 바뀌면: 알림으로 알려 드려요\n\n데모에서는 잠시 뒤에 변화 알림이 하나 와요.`, `[done] Watch is on.\n\n- Target: ${c.url}\n- Interval: ${every}\n- On change: I'll notify you\n\nIn the demo, a change notice arrives in a few seconds.`);
  }
  function parseTimeKo(s) {
    const m = /(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*시(\s*반|\s*\d{1,2}\s*분)?/.exec(s);
    if (!m) return null;
    let h = Number(m[2]);
    const pm = m[1] === "오후" || m[1] === "저녁" || m[1] === "밤";
    if (pm && h < 12) h += 12;
    const min = m[3] ? (/반/.test(m[3]) ? 30 : Number(m[3].replace(/\D/g, ""))) : 0;
    return { h, min, text: `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}시${min ? ` ${min}분` : ""}` };
  }
  function parseTimeEn(s) {
    const m = /(?:\bat\s+)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2})(?::(\d{2}))?\b/i.exec(s);
    if (!m) return null;
    let h = Number(m[1] ?? m[4]);
    const min = Number(m[2] ?? m[5] ?? 0), ap = (m[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return { h, min, text: `${h % 12 || 12}${min ? `:${String(min).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}` };
  }
  const parseTime = L(parseTimeKo, parseTimeEn);
  function routineAsk(t, s) {
    const time = parseTime(s) || { h: 9, min: 0, text: L("오전 9시", "9 AM") };
    const day = L(/주말/.test(s) ? "주말마다" : /평일/.test(s) ? "평일마다" : /매주\s*([월화수목금토일])/.test(s) ? `매주 ${/매주\s*([월화수목금토일])/.exec(s)[1]}요일` : "매일", /weekend/i.test(s) ? "every weekend" : /weekday/i.test(s) ? "every weekday" : /every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(s) ? `every ${cap(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.exec(s)[1].toLowerCase())}` : "every day");
    const job = L(/메일/, /mail/i).test(s) ? L("메일 요약", "mail summary") : L(/일정/, /schedule|calendar|agenda/i).test(s) ? L("일정 알림", "schedule reminder") : L(/댓글/, /comment/i).test(s) ? L("댓글 확인", "comment check") : L(/뉴스|소식/, /news|digest/i).test(s) ? L("소식 정리", "news digest") : L("아침 브리핑", "morning briefing");
    st(t).card = { kind: "routine", time, day, job };
    return { text: L(`[ask] ${day} ${time.text}에 ${job}을 보내 드릴게요.\n\n결정: 이대로 등록할까요?\n1) 등록 ← 추천\n${day} ${time.text}에 돌아요\n2) 시간 바꾸기 …\n원하는 시간을 적어 주세요\n3) 그만두기\n등록하지 않아요`, `[ask] I'll send you the ${job} ${day} at ${time.text}.\n\nDecision: Set this up?\n1) Set up ← recommended\nRuns ${day} at ${time.text}\n2) Change the time …\nTell me the time you want\n3) Never mind\nDon't set it up`) };
  }
  function routineOn(t, n, note) {
    const c = st(t).card;
    if (n === 3) { st(t).card = null; return { text: L("알겠어요. 루틴은 등록하지 않았어요.", "Okay. I didn't set up the routine.") }; }
    if (n === 2) {
      const time = note && parseTime(note);
      if (!time) { st(t).awaitTime = true; return { text: L("몇 시로 바꿀까요? \"오후 6시\"처럼 적어 주세요.", "What time should I use? Write it like \"6 PM\".") }; }
      st(t).awaitTime = false;
      return routineAsk(t, L(`${c.day} ${time.text} ${c.job}`, `${c.day} at ${time.text} ${c.job}`));
    }
    st(t).card = null;
    F.monitors.push({ name: L(`${c.job} 루틴`, `${cap(c.job)} routine`), kind: "schedule", watch: "", scope: "plain", last_run: "", next_run: new Date(Date.now() + 18 * 3600_000).toISOString(), last_result: "" });
    worklog(L(`루틴을 등록했어요: ${c.day} ${c.time.text} ${c.job}`, `Routine set up: ${c.day} at ${c.time.text} ${c.job}`));
    return { text: L(`[done] 등록했어요.\n\n- 언제: ${c.day} ${c.time.text}\n- 할 일: ${c.job}\n- 첫 실행: 내일 ${c.time.text}\n\n바꾸고 싶으면 "시간 바꿔 줘"라고 해 주세요.`, `[done] Set up.\n\n- When: ${c.day} at ${c.time.text}\n- What: ${c.job}\n- First run: tomorrow at ${c.time.text}\n\nSay "change the time" to adjust it.`) };
  }
  function startTask(t, s) {
    const topic = s.replace(L(/(?:좀|좀\s*)?(?:해\s*줘|해\s*주세요|해\s*줄래|부탁해|해\s*봐)[.!?]?$/, /\s*(?:for me\s*)?(?:please\s*)?[.!?]*$/i), "").replace(/\s+/g, " ").trim().slice(0, L(30, 40)) || L("요청하신 작업", "your task");
    const id = `st_${Date.now()}`;
    const job = { id, description: topic, status: "running", started_at: Date.now() };
    F.state.work.unshift(job);
    st(t).task = { id, topic, step: 0, done: false };
    later(600, () => { post(t, L(`백그라운드 작업으로 맡겼어요: ${topic}`, `Handed to a background task: ${topic}`), { source: "gateway", system: true, worker: id }); repaint(); });
    later(4500, () => { const k = st(t).task; if (k && k.id === id) k.step = 1; });
    later(9000, () => {
      job.status = "done"; job.ended_at = Date.now();
      const k = st(t).task; if (k && k.id === id) k.done = true;
      const file = `reports/${topic.replace(/[^\w가-힣]+/g, "-").replace(/^-|-$/g, "")}.md`;
      F.files[file] = L(`# ${topic}\n\n데모로 만든 결과예요.\n\n## 요약\n\n- 비교한 곳: 세 곳\n- 가장 싼 곳: 가상의 서비스 B (월 8,900원)\n- 눈여겨볼 점: 연간 결제 할인이 커요\n`, `# ${topic}\n\nThis result was made by the demo.\n\n## Summary\n\n- Compared: three services\n- Cheapest: fictional Service B (KRW 8,900 a month)\n- Worth noting: the annual billing discount is large\n`);
      post(t, L(`[done] 다 했어요: ${topic}\n\n- 세 곳을 비교했어요\n- 가장 싼 곳은 가상의 서비스 B예요\n- 연간 결제 할인이 가장 커요\n\n[file] ${file}`, `[done] Finished: ${topic}\n\n- Compared three services\n- The cheapest is the fictional Service B\n- Annual billing gives the biggest discount\n\n[file] ${file}`));
      notice({ src: t, open: t, title: L(`작업이 끝났어요: ${topic}`, `Task finished: ${topic}`) });
      worklog(L(`작업을 마쳤어요: ${topic}`, `Finished task: ${topic}`));
      repaint();
    });
    return { text: L(`맡았어요. 백그라운드에서 진행하고\n끝나면 이 대화에 결과를 올릴게요.\n\n진행 상황이 궁금하면 "어디까지 됐어?"라고 물어봐 주세요.`, `Got it. I'll work on it in the background\nand post the result in this chat when it's done.\n\nAsk "how far along is it?" to check progress.`) };
  }
  function taskStatus(t) {
    const k = st(t).task;
    if (!k) return { text: L("지금 진행 중인 작업은 없어요.\n\"경쟁 서비스 가격 조사해 줘\"처럼 맡겨 보세요.", "Nothing is running right now.\nTry handing one over, like \"research competitor pricing\".") };
    if (k.done) return { text: L(`"${k.topic}" 작업은 끝났어요. 위에 결과 파일을 올려 뒀어요.\n"더 자세히"라고 하면 풀어서 설명해요.`, `"${k.topic}" is finished. The result file is posted above.\nSay "more detail" and I'll explain it.`) };
    return { text: k.step ? L(`"${k.topic}" 작업은 절반쯤 왔어요.\n자료를 모았고, 지금 비교하고 있어요.`, `"${k.topic}" is about halfway.\nI gathered the material and am comparing it now.`) : L(`"${k.topic}" 작업을 막 시작했어요.\n자료를 모으고 있어요.`, `"${k.topic}" just started.\nI'm gathering material.`) };
  }
  function makeFile(t, s) {
    const kind = L(/엑셀|표|스프레드|csv/i, /excel|spreadsheet|table|csv/i).test(s) ? L(["표", "csv"], ["table", "csv"]) : L(/슬라이드|발표|ppt/i, /slide|presentation|deck|ppt/i).test(s) ? L(["발표 개요", "md"], ["slide outline", "md"]) : L(["문서", "md"], ["document", "md"]);
    const name = L(/주간|보고/.test(s) ? "주간-보고서" : /회의|미팅/.test(s) ? "회의-메모" : /견적/.test(s) ? "견적-검토" : "정리-문서", /weekly|report/i.test(s) ? "weekly-report" : /meeting/i.test(s) ? "meeting-notes" : /quote/i.test(s) ? "quote-review" : "summary-doc");
    const path = `docs/${name}.${kind[1]}`;
    F.files[path] = kind[1] === "csv" ? L("항목,상태,담당\n메일 답장,진행 중,나\n견적서 검토,대기,나\n댓글 정리,대기,dotz\n", "Item,Status,Owner\nReply to mail,In progress,Me\nQuote review,Waiting,Me\nComment cleanup,Waiting,dotz\n") : L(`# ${name.replace(/-/g, " ")}\n\n- 이번 주 한 일: 메일 정리, 댓글 답글, 감시 설정\n- 다음 주 할 일: 견적 확정, 배포 공지\n`, `# ${name.replace(/-/g, " ")}\n\n- Done this week: mail cleanup, comment replies, watch setup\n- Next week: confirm the quote, release notice\n`);
    return { text: L(`[done] ${kind[0]}로 만들었어요.\n눌러서 바로 열어 볼 수 있어요.\n\n[file] ${path}`, `[done] Made it as a ${kind[0]}.\nTap to open it right away.\n\n[file] ${path}`), short: L(`${path} 파일로 만들었어요.`, `Made it as ${path}.`) };
  }
  const TOPICS = [
    [L(/보안|안전|개인\s*정보|데이터.*(어디|저장)|어디에\s*저장|유출|해킹|믿어도|비밀번호/, /secur|safe|privacy|private|personal (?:data|info)|where.*(?:stored|saved)|stored|leak|hack|trust|password/i), () => ({ text: L("데이터는 내 컴퓨터에 그대로 있어요.\n메일과 대화 기록도 내 기기에 저장돼요.\n\n- 메일·댓글·메시지는 \"보내기\"를 누르기 전엔 나가지 않아요\n- 보내기 전에 늘 승인 카드를 보여 드려요\n- 연결한 계정은 설정에서 언제든 끊을 수 있어요", "Your data stays on your computer.\nMail and chat history are stored on your device too.\n\n- Mail, comments and messages don't leave until you press Send\n- You always see an approval card before anything goes out\n- You can disconnect any account in Settings at any time"), short: L("내 기기에 저장되고, 보내기를 눌러야만 나가요.", "It's stored on your device and only leaves when you press Send.") })],
    [L(/메신저|텔레그램|디스코드|discord|telegram|슬랙|폰에서|휴대폰|모바일|밖에서/i, /messenger|telegram|discord|slack|phone|mobile|outside|away from/i), () => ({ text: L("밖에서도 이어서 쓸 수 있어요.\n\n- 휴대폰 브라우저에서 이 화면을 앱처럼 설치해요\n- 디스코드나 텔레그램을 연결하면\n  메신저로 말 걸고 알림도 받아요\n\n설정 > 메신저에서 연결해요.", "You can keep using it away from your desk.\n\n- Install this screen as an app from your phone browser\n- Connect Discord or Telegram to message dotz\n  there and get notifications\n\nConnect them in Settings > Messengers."), short: L("휴대폰 앱이나 디스코드·텔레그램으로 이어서 써요.", "Use the phone app, or Discord or Telegram.") })],
  ];

  function topic(t, s) {
    for (const [re, f] of TOPICS) if (re.test(s)) return f(t, s);
    if (rx(s, L(/댓글|유튜브|인스타|리뷰|답글/i, /comment|youtube|instagram|review|replies to/i))) {
      const c = pickComment(t, s);
      if (c || rx(s, L(/답글|답\s*달|써/, /reply|replies|respond|write/i))) return c ? commentReply(t, c) : rx(s, L(/다음/, /next/i)) && F.comments.find(x => !x.done) ? commentReply(t, F.comments.find(x => !x.done)) : commentList(t);
      return commentList(t);
    }
    if (rx(s, L(/감시|지켜|모니터|바뀌면|변하면|올라오면|떨어지면|생기면|재고/, /watch|monitor|keep an eye|tell me when|let me know when|notify me|alert me|changes\b|restock/i))) return watchAsk(t, s);
    if (rx(s, L(/매일|매주|평일|주말마다|아침마다|저녁마다|루틴|예약|반복|정기/, /every (?:day|morning|evening|night|week|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|routine|recurring|each (?:day|morning)/i))) return routineAsk(t, s);
    if (rx(s, L(/브리핑|오늘\s*(뭐|어때)|하루\s*요약/, /briefing|brief me|morning summary|daily summary|how does today look/i))) return briefing(t);
    if (rx(s, L(/내일/, /tomorrow/i)) && rx(s, L(/일정|약속|뭐|은\??$|는\??$/, /schedule|calendar|plans?|events?|meetings?|appointments?|what|how|\?$/i))) return schedule(t, "tomorrow");
    if (rx(s, L(/일정|캘린더|스케줄|약속|회의|미팅\s*몇|오늘/, /schedule|calendar|agenda|appointments?|meetings?|events?|today|plans/i)) && !rx(s, L(/메일/, /mail/i))) return schedule(t, "today");
    if (rx(s, L(/메일|이메일|편지|받은\s*함|답장|회신/, /mail|inbox|letter|reply|respond/i)) || t.startsWith("mail:")) {
      const m = pickMail(t, s);
      if (rx(s, L(/답장|회신|초안|답\s*써|답해/, /reply|respond|draft|write back/i))) return mailReply(t, m && m.reply === "needs" ? m : m && t.startsWith("mail:") ? m : null);
      if (m && rx(s, L(/읽|열|보여|내용|뭐래|무슨/, /read|open|show|content|what does|says?/i))) return readMail(t, m);
      if (t.startsWith("mail:") && m) return readMail(t, m);
      return mailSummary(t);
    }
    if (rx(s, L(/어디까지|진행\s*상황|다\s*됐|얼마나\s*됐|끝났/, /how far|progress|status|done yet|finished|how long|is it done/i))) return taskStatus(t);
    if (rx(s, L(/파일|문서|보고서|엑셀|표로|슬라이드|pdf|csv|만들어\s*줘.*(정리|목록)|정리해서\s*줘/i, /file|document|report|spreadsheet|excel|slides?|presentation|pdf|csv|as a table/i))) return makeFile(t, s);
    if (rx(s, L(/조사|리서치|분석|비교|알아봐|찾아봐|맡길|맡겨|작업|프로젝트.*(시작|해)/, /research|investigate|look into|analy[sz]e|compare|find out|look up|task|hand (?:off|over)|delegate/i))) return startTask(t, s);
    if (rx(s, L(/프로젝트/, /project/i))) return { text: L(`프로젝트는 ${F.projects.length}개예요.\n\n${F.projects.map(p => `- ${p.name}: ${p.record.milestones.filter(x => x.done).length}/${p.record.milestones.length} 단계 완료`).join("\n")}\n\n일을 맡기려면 "경쟁 서비스 가격 조사해 줘"처럼 말해 주세요.`, `You have ${pl(F.projects.length, "project")}.\n\n${F.projects.map(p => `- ${p.name}: ${p.record.milestones.filter(x => x.done).length}/${p.record.milestones.length} steps done`).join("\n")}\n\nTo hand something over, say "research competitor pricing".`) };
    if (rx(s, L(/고마|감사|땡큐|thank|최고|좋아요?$|굿/i, /thank|thanks|great|awesome|cool|nice/i))) return { text: L("천만에요. 또 필요한 게 있으면 말해 주세요.", "You're welcome. Tell me if you need anything else.") };
    if (rx(s, L(/^(안녕|하이|hi|hello|헬로|ㅎㅇ)/i, /^(hi|hello|hey|good (?:morning|evening))/i))) return { text: L(`안녕하세요. 저는 dotz예요.\n메일, 일정, 댓글, 감시를 대신 챙겨요.\n\n${SUGGEST}`, `Hi, I'm dotz.\nI keep up with your mail, schedule, comments and watched pages.\n\n${SUGGEST}`) };
    if (rx(s, L(/누구|뭘\s*할\s*수|뭐\s*할\s*수|뭐\s*해\s*줄|기능|도움말|help|사용법|어떻게\s*써/i, /who are you|what can you do|what do you do|features|help|how (?:do|to) (?:i )?use|capabilities/i))) return { text: L("제가 할 수 있는 일이에요.\n\n- 메일 요약, 읽기, 답장 초안\n- 오늘 일정과 아침 브리핑\n- 유튜브·인스타·웹사이트 댓글 답글\n- 페이지 감시와 변화 알림\n- 매일 정해진 시간에 할 일\n- 조사 같은 긴 작업과 결과 파일\n\n보내는 일은 늘 승인을 받고 해요.", "Here is what I can do.\n\n- Summarize and read mail, and draft replies\n- Today's schedule and the morning briefing\n- Replies to YouTube, Instagram and website comments\n- Page watching and change notifications\n- Tasks at a set time every day\n- Long jobs like research, with a result file\n\nI always ask for approval before anything is sent.") };
    return null;
  }

  function onCard(t, n, note, s) {
    const S = st(t), c = S.card;
    if (!c) return null;
    if (c.kind === "send") {
      if (n === 1) return { text: sendDraft(t) };
      if (n === 2) {
        if (note) return { text: revise(t, note) };
        S.awaitEdit = true; S.card = null;
        return { text: L("어떻게 고칠까요?\n\"더 짧게\", \"정중하게\", \"수요일 오전 10시로\"처럼 말해 주세요.", "How should I change it?\nSay \"shorter\", \"more formal\" or \"Wednesday at 10 AM\".") };
      }
      if (n === 3) return { text: dropDraft(t) };
    }
    if (c.kind === "comment" && S.list) {
      const id = pickFrom(S.list.items, n);
      const cm = F.comments.find(x => x.n === id);
      if (cm) return commentReply(t, cm);
    }
    if (c.kind === "watch" && n >= 1 && n <= 3) return { text: watchOn(t, n) };
    if (c.kind === "routine" && n >= 1 && n <= 3) return routineOn(t, n, note);
    if (c.kind === "pick" && n >= 1 && n <= c.options.length) {
      S.card = null;
      const label = c.options[n - 1];
      return { text: n === 3 ? L("알겠어요. 공지 없이 배포하고, 릴리스 노트만 남겨 둘게요.", "Okay. I'll release without a notice and keep only the release notes.") : L(`정했어요. ${label}로 다듬어 둘게요.\n\n"보여 줘"라고 하면 초안을 보여 드려요.`, `Decided. I'll write it up as a ${label.toLowerCase()}.\n\nSay "show me" to see the draft.`), after: () => { S.notice = label; } };
    }
    return null;
  }
  const CARD_WORDS = [[L(/(보내지\s*마|안\s*보내|보내지\s*않|버려|취소|그만|됐어|필요\s*없)/, /(don'?t send|do not send|discard|cancel|stop|never ?mind|no need)/i), 3], [L(/^(보내|보내줘|보내\s*줘|전송|그대로\s*보내|좋아\s*보내|ㅇㅇ\s*보내|응\s*보내)/, /^(send|send it|send as is|yes,? send|go ahead)/i), 1], [L(/^(고쳐|수정|고치기|바꿔)/, /^(edit|revise|change|fix)/i), 2], [L(/^(등록|켜|켜줘|좋아|응|네|그래|ㅇㅇ|오케이|ok)/i, /^(set up|turn on|yes|yep|ok|okay|sure|do it|go ahead)/i), 1]];

  function respond(t, s, picks) {
    const S = st(t);
    const pick = picks && picks[0];
    if (pick && S.card) {
      const n = Number(pick.n), note = pick.note || (/\s-\s(.+)$/.exec(s) || [])[1] || "";
      const r = onCard(t, n, note.trim(), s);
      if (r) return r;
    }
    if (S.awaitEdit && S.draft && !rx(s, L(/취소|그만|보내지\s*마|버려/, /cancel|stop|don'?t send|discard|never ?mind/i))) return { text: revise(t, s) };
    if (S.awaitTime && S.card && S.card.kind === "routine") { const r = routineOn(t, 2, s); if (!S.awaitTime) return r; return r; }
    if (L(/^\s*아니/, /^\s*(?:no|nope|not that)\b/i).test(s) && S.list) {
      const o = ordinal(s);
      if (o) {
        const id = pickFrom(S.list.items, o.n);
        if (S.list.kind === "comment") { const cm = F.comments.find(x => x.n === id); if (cm) return commentReply(t, cm); }
        if (S.list.kind === "mail") { const m = mail(id); if (S.draft && S.draft.kind === "mail") return mailReply(t, m); return readMail(t, m); }
        if (S.list.kind === "event" && id) return { text: L(`${id.at} ${id.title}${id.where ? ` (${id.where})` : ""}이에요.\n30분 전에 알려 드릴까요?`, `${id.at} ${id.title}${id.where ? ` (${id.where})` : ""}.\nWant a reminder 30 minutes before?`) };
      }
    }
    if (S.card) {
      const o = ordinal(s);
      if (o && L(/^\s*(\d|첫|두|세|네|마지막)/, /^\s*(\d|first|second|third|fourth|last|1st|2nd|3rd|4th|one|two|three|four)/i).test(s)) { const r = onCard(t, o.n, o.note, s); if (r) return r; }
      if (S.card.kind === "send" && rx(s, L(/짧|줄여|정중|편하|공손|캐주얼|[월화수목금]요일|\d+\s*시|넣어|추가/, /short|formal|polite|casual|friendly|monday|tuesday|wednesday|thursday|friday|\d+\s*(?:am|pm)|add|include|mention/i))) return { text: revise(t, s) };
      for (const [re, n] of CARD_WORDS) if (re.test(s.trim())) { const r = onCard(t, n, "", s); if (r) return r; }
      if (S.card.kind === "routine" && parseTime(s) && rx(s, L(/바꿔|으로|로$/, /change|make it|set it|instead|to\b/i))) return routineOn(t, 2, s);
    }
    if (rx(s, L(/다시\s*(해|써|만들|정리|줘)|한\s*번\s*더|다른\s*(버전|걸로)/, /again|redo|one more time|another version|different version|rewrite/i)) && S.last) {
      if (S.draft) { const order = ["normal", "casual", "formal", "short"]; const d = { ...S.draft, time: "", extra: "" }; d.variant = order[(order.indexOf(d.variant) + 1) % order.length]; return { text: draftCard(t, d, L(`다시 써 봤어요. (${VARIANT_KO[d.variant]})`, `Here is another version. (${VARIANT_KO[d.variant]})`)) }; }
      if (S.lastFn) { const r = S.lastFn(); return { ...r, text: L(`다시 정리했어요.\n\n${plainAsk(r.text)}`, `Here it is again.\n\n${plainAsk(r.text)}`) }; }
    }
    if (rx(s, L(/짧게|줄여|간단히|한\s*줄로/, /shorter|short|one line|summari[sz]e|tl;?dr/i)) && S.last) {
      if (S.draft) return { text: revise(t, L("짧게", "shorter")) };
      return { text: S.last.short || L(`핵심만 남겼어요.\n${plain(S.last.text).split(/(?<=요\.)\s/)[0]}`, `Short version:\n${plain(S.last.text).split(/(?<=\.)\s/)[0]}`) };
    }
    if (rx(s, L(/더\s*자세히|자세하게|풀어서/, /more detail|in detail|detailed|explain|elaborate/i)) && S.task && S.task.done) return { text: L(`조금 더 풀어 볼게요.\n\n- 서비스 A: 월 12,000원, 기능이 가장 많아요\n- 서비스 B: 월 8,900원, 가장 싸요\n- 서비스 C: 월 10,500원, 연간 결제 시 30% 할인\n\n세 곳 모두 가상의 이름이에요.`, `Here is a bit more.\n\n- Service A: KRW 12,000 a month, the most features\n- Service B: KRW 8,900 a month, the cheapest\n- Service C: KRW 10,500 a month, 30% off with annual billing\n\nAll three names are made up.`) };
    if (rx(s, L(/보여\s*줘|초안\s*줘/, /show me|show it|let me see|draft/i)) && S.notice) return { text: S.notice === L("목록 공지", "List notice") ? L("목록 공지 초안이에요.\n\n- 데모 페이지를 추가했어요\n- 모바일 문구 줄바꿈을 고쳤어요", "Here is the list notice draft.\n\n- Added the demo page\n- Fixed line breaks in the mobile copy") : L("짧은 공지 초안이에요.\n\n이번 주에는 데모 페이지가 생기고\n모바일 문구가 더 읽기 쉬워졌어요.", "Here is the short notice draft.\n\nThis week adds the demo page\nand makes the mobile copy easier to read.") };
    if (rx(s, L(/^(보내|보내줘|보내\s*줘)$/, /^(send|send it)$/i)) && !S.card) return { text: L("지금 보낼 초안이 없어요.\n\"서윤님 메일 답장 써 줘\"처럼 먼저 초안을 만들어 볼까요?", "There is no draft to send right now.\nShall I write one first, like \"write a reply to Seoyun\"?") };
    if (rx(s, L(/^(취소|그만|됐어|아니야)$/, /^(cancel|stop|never ?mind|no)$/i))) { S.card = null; S.awaitEdit = false; return { text: L("알겠어요. 멈췄고 아무것도 보내지 않았어요.", "Okay. Stopped, and nothing was sent.") }; }
    if (S.list && S.list.kind === "mail") { const o = ordinal(s); if (o) return readMail(t, mail(pickFrom(S.list.items, o.n))); }
    const r = topic(t, s);
    if (r) { S.lastFn = () => topic(t, s); return r; }
    if (L(/^\s*[1-4]\s*(?:\)|번)?\s*$/, /^\s*[1-4]\s*(?:\)|\.)?\s*$/).test(s)) return { text: L(`지금은 고를 항목이 없어요.\n${SUGGEST}`, `There is nothing to choose right now.\n${SUGGEST}`) };
    return { text: L(`그건 데모에서 준비하지 못했어요.\n${SUGGEST}`, `I haven't prepared that in the demo.\n${SUGGEST}`) };
  }
  const plainAsk = text => text.replace(/^\[[a-z]+\]\s*/i, "");

  // The open decision notice of a conversation follows its scripted card: answered once the card is used up, rewritten while 고치기 keeps it going.
  const openDecision = t => F.notices.items.find(x => x.kind === "decision" && x.decision.state === "open" && x.decision.to === t);
  function settleDecision(n, t, had, r, pick) {
    if (!n || !had) return;
    const d = st(t).draft;
    if (st(t).card) {
      if (d && n.decision.draft) { n.decision.draft.body = draftLines(d).join("\n"); emit({ kind: "notice", item: n }); }
      return;
    }
    const num = pick ? Number(pick.n) : /^\[done\]/.test(r.text) ? 1 : r.text === DROPPED ? 3 : 1;
    const opt = n.decision.options.find(o => o.n === num) || n.decision.options[0];
    Object.assign(n.decision, { state: "answered", answer: `${opt.n}) ${opt.label}`, answered_at: new Date().toISOString(), ...(opt.n === 1 && n.decision.draft ? { send: { state: "sent", at: new Date().toISOString() } } : {}) });
    n.read = true;
    F.state.notices_unread = unread();
    emit({ kind: "notice", item: n });
  }
  function answer(body, to) {
    const t = to || (typeof target === "string" ? target : "main");
    const picks = Array.isArray(body.picks) ? body.picks : [];
    const text = String(body.text || "").trim() || (picks.length ? `${picks[0].n}) ${picks[0].label}` : L("메시지", "Message"));
    ownerSays(t, text, picks);
    setWorking(true);
    let r;
    const openN = openDecision(t), had = !!st(t).card;
    try { r = respond(t, text, picks); settleDecision(openN, t, had, r, picks[0]); }
    catch (e) { console.warn(`demo script: ${e.message}`); r = { text: L(`잠깐 헷갈렸어요. 다시 말해 주세요.\n${SUGGEST}`, `I got confused for a second. Please say it again.\n${SUGGEST}`) }; }
    st(t).last = r;
    log.said.push({ t, text, reply: r.text });
    const wait = 700 + Math.min(1100, r.text.length * 6);
    later(wait, () => {
      F.state.orchestrator.status = "idle";
      post(t, r.text);
      if (r.after) r.after();
      repaint();
    });
    return { ok: true };
  }

  const models = {
    orchestrator: { model: F.MODEL, thinking: "" },
    lanes_default: { model: F.MODEL, thinking: "" },
    workers: { model: F.MODEL, thinking: "" },
    notes: {},
    fallbacks: {
      max: 6,
      orchestrator: { chain: [], hub_driven: true, active: [], harness: { id: "omo", name: "OmO" }, conditions: true },
      lanes: { chain: [], hub_driven: true, active: [], harness: { id: "omo", name: "OmO" }, conditions: true },
      workers: { chain: [], hub_driven: false, active: [], harness: { id: "omo", name: "OmO" }, conditions: true },
    },
    thinking_levels: ["off", "low", "medium", "high"],
    available: [F.model],
    pickable: [F.model],
    lanes: [{ name: F.LANE.landing, model: F.MODEL, thinking: "" }],
    targets: [],
    in_use: [{ key: "main", label: "dotz", model: F.MODEL }],
    fallbacks: {},
  };
  const BUDGET = { limit_usd: 50, spent_usd: 12.4, pct: 24.8, month: new Date().toISOString().slice(0, 7), resets_at: Date.now() + 26 * 864e5, source: "estimate" };
  // 업데이트 화면: the version the demo says it runs, and what a check or a settings change leaves behind (hub/selfupdate.ts).
  const updVersion = { kind: "git", branch: "main", commit: { sha: "3f9c2e1".padEnd(40, "0"), short: "3f9c2e1", date: new Date(Date.now() - 3 * 864e5).toISOString() } };
  const upd = { lastCheck: null, settings: { auto_check: true, auto_apply: false, at: "09:00" } };
  const lists = {
    "/api/workers": { items: [] },
    "/api/apps": { items: [] },
    "/api/approvals": { items: [] },
    "/api/devices": [
      { id: "cred-mac", name: L("노트북 Safari", "Laptop Safari"), created: new Date(Date.now() - 40 * 864e5).toISOString(), last_used: new Date(Date.now() - 6e5).toISOString(), current: true },
      { id: "cred-phone", name: L("아이폰", "iPhone"), created: new Date(Date.now() - 12 * 864e5).toISOString(), last_used: new Date(Date.now() - 2 * 864e5).toISOString(), current: false },
    ],
    "/api/accounts": {
      mode: "auto", chosen: { name: "default", label: L("개인 계정", "Personal account"), source: "auto", blocked: null, text: "" },
      accounts: [{ name: "default", order: 1, alias: null, label: L("개인 계정", "Personal account"), current: true, blocked: null, blocked_until: null, blocked_tag: null, five_hour_left: 62, seven_day_left: 80 }],
      rules: {}, rules_text: [], script: { path: null, timeout_ms: 5000, every_minutes: 5, last: null },
      providers: [
        { id: "anthropic", name: L("Claude 구독", "Claude subscription"), auth: "oauth", multi: true, can_add: true, can_pin: true, can_delete: true, accounts: [
          { name: "default", order: 1, label: L("개인 계정", "Personal account"), current: true, pinned: true, blocked: null, blocked_until: null, blocked_tag: null, windows: [{ id: "5h", label: L("5시간", "5 hours"), left: 62, resets_at: null }, { id: "7d", label: L("7일", "7 days"), left: 80, resets_at: null }] },
          { name: "work", order: 2, label: L("회사 계정", "Work account"), current: false, pinned: false, blocked: null, blocked_until: null, blocked_tag: null, windows: [] }] },
        { id: "google", name: "Gemini", auth: "api_key", multi: false, can_add: false, can_pin: false, can_delete: false, accounts: [
          { name: "default", order: 1, label: L("API 키", "API key"), current: true, pinned: false, blocked: null, blocked_until: null, blocked_tag: null, windows: [] }] },
      ],
      login_providers: [{ id: "anthropic", name: L("Claude 구독", "Claude subscription"), configured: true }, { id: "cursor", name: "Cursor", configured: false }],
    },
    "/api/discord/connection": { enabled: true, connected: true, user: "dotz-bot", error: "", guild: "111111111111111111", owner_id: "222222222222222222", app_id: "999000111222333444", has_token: true, restart_needed: false },
    "/api/discord/post": { chat: true, lanes: true, alert: true, worklog: true, web_lanes: false, ask: true, result: false, news: true, conv: true },
    "/api/messengers/jandi": {
      enabled: true, help: [], fields: [{ key: "host", label: L("받는 주소", "Listen address"), type: "text", value: "0.0.0.0" }, { key: "incoming_url", label: L("기본 수신 웹훅 URL", "Default incoming webhook URL"), type: "secret", set: true }],
      allow: { label: L("말을 걸 수 있는 사람", "People who can message"), hint: L("이메일이나 JANDI 이름", "Email or JANDI name"), items: [L("박지훈", "Minjun Park"), "kim@example.com"] },
      rooms: { label: L("방", "Rooms"), editable: true, hint: "", fields: [], items: [{ id: "m1", name: L("메인", "Main"), kind: "main", values: {}, set: {}, last_in: Date.now() - 12e4, last_out: Date.now() - 3e4 }] },
      notify: { ask: true, alert: true, result: true, news: true, conv: true, log: true },
    },
    "/api/messengers/slack": {
      enabled: false, help: [], fields: [{ key: "token", label: L("봇 토큰", "Bot token"), type: "secret", set: false }],
      allow: { label: L("말을 걸 수 있는 사람", "People who can message"), hint: L("Slack 사용자 ID", "Slack user ID"), items: [] },
      rooms: { label: L("채널", "Channels"), editable: true, hint: L("연결하면 채널을 읽어요", "Channels load once connected"), fields: [], items: [] },
      notify: { ask: true, alert: true, result: true, news: true, conv: true, log: true },
    },
    "/api/messengers/telegram": {
      enabled: true, help: [], fields: [{ key: "token", label: L("봇 토큰", "Bot token"), type: "secret", set: true }],
      allow: { label: L("말을 걸 수 있는 사람", "People who can message"), hint: L("Telegram 사용자 ID", "Telegram user ID"), items: ["123456789"] },
      rooms: { label: L("대화", "Chats"), editable: true, hint: "", fields: [], items: [{ id: "c1", name: L("나", "Me"), kind: "main", values: {}, set: {} }] },
      notify: { ask: true, alert: true, result: true, news: true, conv: true, log: true },
    },
    "/api/runtimes": { runtimes: [
      { id: "omo", label: "OmO", installed: true, version: "0.14.2", roles: ["orchestrator", "lanes"], hasAdapter: true },
      { id: "claude", label: "Claude Code", installed: true, version: "2.1.9", roles: [], hasAdapter: true },
    ] },
    "/api/messengers": { items: [
      { id: "discord", label: "Discord", enabled: true, state: "ok", configured: true },
      { id: "jandi", label: "JANDI", enabled: true, state: "ok", configured: true },
      { id: "slack", label: "Slack", enabled: false, state: "off", configured: false },
      { id: "telegram", label: "Telegram", enabled: true, state: "ok", configured: true },
    ] },
    // 답장 확인: 댓글 답글 초안 둘 (유튜브·인스타그램). 보내기는 아래 postApi에서 그냥 받아 줘요.
    "/api/replies": { items: [
      { kind: "comment", app: "youtube", code: "DM1", at: Date.now() - 6 * 6e4, to: L("산책하는고양이", "WalkingCat"), title: L("책상 정리 브이로그", "Desk tidy-up vlog"), text: L("다음 주 금요일에 올라가요.\n봐 주셔서 고마워요!", "It goes up next Friday.\nThanks for watching."), original: { who: L("산책하는고양이", "WalkingCat"), text: L("영상 잘 봤어요! 다음 편은 언제 올라와요?", "Great video. When does the next one come out?") }, attachmentsNone: true, cannotAttach: [] },
      { kind: "comment", app: "instagram", code: "DM2", at: Date.now() - 52 * 6e4, to: L("달빛고양이", "MoonlightCat"), title: L("라이브 예고 게시물", "Live preview post"), text: L("이번 주 금요일 저녁 8시에 해요.\n알림 설정해 두시면 바로 알려 드릴게요.", "It's this Friday at 8 PM.\nTurn on notifications and I'll let you know right away."), original: { who: L("달빛고양이", "MoonlightCat"), text: L("다음 라이브는 언제 해요?", "When is the next live stream?") }, attachmentsNone: true, cannotAttach: [] },
    ] },
    "/api/features": FEATURES_FX,
    "/api/harness": HARNESS_FX,
    "/api/api-budget": BUDGET,
    "/api/web-access": { mode: "tailscale", hostname: "", team: "", aud: "", token_set: false, tunnel: { state: "off" }, devices: 2, cloudflared_found: true },
    "/api/push/gateways": { items: [] },
    "/api/push": { subscribed: false },
    "/api/harness/update": { checking: false, harnesses: [
      { id: "omo", name: "OmO", current: "0.14.2", latest: "0.14.2", available: false, installMethod: "bun-global", checkedAt: new Date(Date.now() - 36e5).toISOString() },
    ] },
    "/api/push/classes": { classes: { ask: true, alert: true, result: true, news: true, conv: true, log: false } },
    "/api/context": { processes: [
      { name: "orchestrator", kind: "orchestrator", running: true, percent: 42, tokens: 84000 },
      { name: F.LANE.landing, kind: "lane", running: true, percent: 83, tokens: 166000 },
    ] },
    "/api/models": models,
    "/api/providers": { providers: [
      { id: "anthropic", name: L("Claude 구독", "Claude subscription"), auth: "oauth", account: L("개인 계정", "Personal account"), accounts: 2, in_use: true, can_add_account: true, can_logout: true },
      { id: "chatgpt-subscription", name: L("ChatGPT 구독", "ChatGPT subscription"), auth: "oauth", account: L("회사용 GPT", "Work GPT"), can_login: true, can_logout: true },
      { id: "google", name: "Gemini", auth: "api_key", masked: "AIza…x9Qd", can_login: true, can_logout: true },
      { id: "cursor", name: "Cursor", auth: "none", can_login: true },
    ] },
    "/api/quota": { budget: BUDGET, providers: [{ provider: "anthropic", limits: [
      { id: "five_hour", label: "Claude 5 Hour", limit: 100, remaining: 64, status: "ok" },
      { id: "seven_day", label: "Claude 7 Day", limit: 100, remaining: 18, status: "warn" },
    ] }], use: { at: Date.now() - 6 * 36e5, hours: 24, cost: 214.6, tokens: 0, sessions: 23, rows: [{ kind: "orchestrator", name: "", model: "claude-opus-5-5", pct: 41.2 }, { kind: "lane", name: "site-fix", model: "claude-opus-5-5", pct: 22.5 }, { kind: "worker", name: L("블로그 정리", "Blog cleanup"), model: "claude-sonnet-5-5", pct: 12.1 }], models: [{ model: "claude-opus-5-5", pct: 71.3 }, { model: "claude-sonnet-5-5", pct: 28.7 }], rest: { sessions: 20, pct: 24.2 }, fixes: [{ id: "worker:lane:site-fix:claude-opus-5-5", fix: "worker", target: "lane:site-fix", model: "claude-opus-5-5", who: { kind: "lane", name: "site-fix" }, cost: 18.4, n: 3 }, { id: "watch:site-up", fix: "watch", watch: "site-up", who: { kind: "other", name: "site-up" }, cost: 6.1, n: 48 }, { id: "compact:orchestrator", fix: "compact", target: "orchestrator", who: { kind: "orchestrator", name: "" }, cost: 5.2 }, { id: "check:bust:a", fix: "check", who: { kind: "lane", name: "blog" }, cost: 2.3, n: 4 }] } },
    "/api/machine": {},
    "/api/peers": [
      { name: "노트북", url: "https://laptop.demo.ts.net", self: true, online: true },
      { name: "데스크톱", url: "https://desktop.demo.ts.net", online: true, unread: 2, need: 1 },
      { name: "서버", url: "https://server.demo.ts.net", online: false },
    ].map(p => ({ ...p, name: L(p.name, { 노트북: "Laptop", 데스크톱: "Desktop", 서버: "Server" }[p.name]) })),
  };

  // 기본 프로젝트 커스텀 (hub/custom.ts builtinDetail): 넓은 화면의 프로젝트 탭이 처음 여는 페이지예요.
  const BUILTIN = { key: "builtin:custom", name: L("커스텀", "Custom"), builtin: true, note: L("내가 바꾼 것을 한곳에서 봐요", "See everything you changed in one place"), lanes: [], work: [], results: [], monitors: [], summary: {} };
  const BUILTIN_DETAIL = { groups: [
    { id: "cards", label: L("홈 카드", "Home cards"), empty: L("아직 만든 카드가 없어요", "No cards yet"), items: [{ title: L("오늘 일정", "Today's schedule"), line: L("오늘 일정을 홈에서 바로 봐요", "See today's schedule right on Home") }, { title: L("이번 달 지출", "This month's spending"), line: L("카드 사용액을 매일 아침 모아요", "Card spending is collected every morning") }] },
    { id: "pins", label: L("고정 항목", "Pinned items"), empty: L("사이드바에 고정한 게 없어요", "Nothing is pinned to the sidebar"), items: [{ title: L("한글 문서 자동화", "Form document automation"), line: L("자주 여는 프로젝트예요", "A project you open often") }, { title: L("랜딩 페이지", "Landing page"), line: L("이번 주에 끝낼 일이에요", "To finish this week") }] },
    { id: "routines", label: L("루틴", "Routines"), empty: L("아직 만든 루틴이 없어요", "No routines yet"), items: [{ title: L("아침 브리핑", "Morning briefing"), line: L("매일 오전 9시", "Every day at 9 AM") }, { title: L("주간 정리", "Weekly wrap-up"), line: L("매주 금요일 오후 6시", "Every Friday at 6 PM") }] },
    { id: "rules", label: L("내 규칙", "My rules"), empty: L("아직 적은 규칙이 없어요", "No rules yet"), items: [{ title: L("답은 해요체로 짧게", "Short, friendly replies"), line: L("세 줄 안에 끝내요", "Keep it within three lines") }, { title: L("메일은 확인 후 발송", "Mail goes out after you approve"), line: L("내가 보내기를 눌러야 나가요", "It only goes out when I press Send") }] },
    { id: "said", label: L("비서 설정", "Assistant settings"), empty: L("아직 정한 게 없어요", "Nothing set yet"), items: [{ title: L("이름", "Name"), line: "dotz" }, { title: L("말투", "Tone"), line: L("편한 해요체", "Easygoing and friendly") }] },
  ] };
  const onboard = key => ({ key, state: key === "slack" ? "idle" : "done", step: null, owner: null, error: null, url: null, updated_at: new Date().toISOString() });
  const todoOf = t => t === "main" ? json(F.todo)
    : t === "quick" || /^ch:\d+$/.test(t) ? json({ phases: [] })
    : t.startsWith("lane:") ? (F.state.lanes.some(l => l.name === t.slice(5)) ? json({ phases: [] }) : json({ error: `no lane ${t.slice(5)}` }, 404))
    : json({ error: "target must be main, quick, lane:<name> or ch:<id>" }, 400);

  const owns = (app, t) => (app.conv || []).some(p => t.startsWith(p)) && !(app.convNot || []).some(p => t.startsWith(p));
  const mailApps = () => F.integrations.filter(i => i.app === "mail");
  const mailAppOf = k => mailApps().find(i => owns(i, `mail:${k}`));
  const boxOf = (appKey, id) => { const a = mailApps().find(i => i.key === appKey); return a && a.boxes.find(b => b.id === id); };
  const voiceOf = (appKey, id) => ({ state: mailApps().find(i => i.key === appKey).boxes.length < 2 ? "single" : "few", count: F.mails.filter(m => m.dir === "out" && mailAppOf(m.key).key === appKey && (m.box || "base") === id).length, need: 20 });
  const putMail = (m, patch) => { Object.assign(m, patch); const c = conv(`mail:${m.key}`); if (c && c.mail) Object.assign(c.mail, patch); };
  const setBox = (m, id) => { putMail(m, id === "base" ? { box: undefined, boxWhy: undefined } : { box: id, boxWhy: { kind: "moved" } }); };
  const dropMail = k => { F.mails.splice(F.mails.findIndex(m => m.key === k), 1); F.conversations.splice(F.conversations.findIndex(c => c.target === `mail:${k}`), 1); };
  const bad = (error, status = 400) => json({ error }, status);
  function mailRoute(method, u, b) {
    const route = `${method} ${u.pathname}`, q = k => u.searchParams.get(k) || "";
    if (route === "POST /api/mailbox/move") {
      const picked = [...new Set(b.keys || [])].map(mail);
      if (!picked.length || picked.some(m => !m)) return bad(L("메일을 찾을 수 없어요", "Can't find that mail"), 404);
      const apps = new Set(picked.map(m => mailAppOf(m.key)));
      if (apps.size !== 1) return bad(L("다른 계정의 메일은 한 번에 옮길 수 없어요", "Mail from different accounts can't be moved together"));
      if (!boxOf([...apps][0].key, b.box)) return bad(L("이 계정에 없는 메일함이에요", "This account has no such mailbox"));
      const was = Object.fromEntries(picked.map(m => [m.key, m.box || "base"]));
      for (const m of picked) setBox(m, b.box);
      return json({ ok: true, moved: picked.map(m => m.key), was });
    }
    if (route === "POST /api/mailbox/learn") {
      const box = mailApps().flatMap(a => a.boxes).find(x => x.id === b.box && !x.base);
      if (!box) return bad(L("메일함을 찾을 수 없어요", "Can't find that mailbox"), 404);
      const list = b.kind === "not" ? box.not.from : box.conds[b.kind];
      const added = !!list && !list.includes(b.value);
      if (added) list.push(b.value);
      return json({ ok: true, added });
    }
    if (route === "PUT /api/mailbox/box") {
      const app = mailApps().find(i => i.key === b.app);
      if (!app) return bad(L("메일 계정을 찾을 수 없어요", "Can't find that mail account"), 404);
      if (!b.box || !String(b.box.name || "").trim()) return bad("name is required");
      const box = { icon: "mail", notify: true, conds: { from: [], subj: [], body: [], src: [] }, not: { from: [] }, judge: { on: false, text: "" }, how: "", greets: [], folders: [], bans: [], rules: [], ...b.box, id: b.box.id || `b-${Math.random().toString(36).slice(2, 10)}` };
      const at = app.boxes.findIndex(x => x.id === box.id);
      if (at >= 0) app.boxes[at] = box; else app.boxes.push(box);
      return json({ ok: true, box });
    }
    if (route === "DELETE /api/mailbox/box") {
      if (b.id === "base") return bad(L("일반 메일함은 지울 수 없어요", "The General mailbox can't be deleted"));
      const app = mailApps().find(i => i.key === b.app);
      if (!app || !app.boxes.some(x => x.id === b.id)) return bad(L("메일함을 찾을 수 없어요", "Can't find that mailbox"), 404);
      app.boxes = app.boxes.filter(x => x.id !== b.id);
      for (const m of F.mails) if (m.box === b.id && mailAppOf(m.key) === app) putMail(m, { box: undefined, boxWhy: undefined });
      return json({ ok: true });
    }
    if (route === "GET /api/mailbox/tone") return boxOf(q("app"), q("box")) ? json({ ok: true, own: false, summary: L("편한 해요체로 짧게 답해요.", "Replies are short and friendly."), corrections: [], voice: voiceOf(q("app"), q("box")) }) : bad(L("메일함을 찾을 수 없어요", "Can't find that mailbox"), 404);
    if (route === "POST /api/mailbox/relearn") return boxOf(b.app, b.box) ? json({ ok: true, result: "few", voice: voiceOf(b.app, b.box) }) : bad(L("메일함을 찾을 수 없어요", "Can't find that mailbox"), 404);
    if (route === "GET /api/mailbox/examples") return boxOf(q("app"), q("box")) ? json({ ok: true, examples: [] }) : bad(L("메일함을 찾을 수 없어요", "Can't find that mailbox"), 404);
    if (route === "GET /api/mailbox/suggest") {
      if (!mailApps().some(i => i.key === q("app"))) return bad(L("메일 계정을 찾을 수 없어요", "Can't find that mail account"), 404);
      const by = new Map();
      for (const m of F.mails) {
        const domain = m.dir === "in" && !m.box && mailAppOf(m.key).key === q("app") && (/@([^>\s]+)/.exec(m.from) || [])[1];
        if (domain) by.set(domain, [...(by.get(domain) || []), m]);
      }
      return json({ ok: true, groups: [...by].filter(([, l]) => l.length >= 2).map(([domain, l]) => ({ domain: `@${domain}`, label: domain.split(".")[0], count: l.length, senders: [...new Set(l.map(m => m.name))].slice(0, 3), keys: l.map(m => m.key) })) });
    }
    const one = /^\/api\/mail\/([^/]+)(\/fyi)?$/.exec(u.pathname), m = one && mail(one[1]);
    if (one && one[2] && (method === "POST" || method === "DELETE")) { if (!m) return bad(L("메일을 찾을 수 없어요", "Can't find that mail"), 404); putMail(m, { reply: method === "POST" ? "fyi" : "needs" }); return json({ ok: true }); }
    if (route === "POST /api/mail/fyi") return json({ ok: true, results: (b.keys || []).map(key => { const x = mail(key); if (x) putMail(x, { reply: b.on ? "fyi" : "needs" }); return { key, ok: !!x }; }) });
    if (one && !one[2] && method === "DELETE") { if (!m) return bad(L("메일을 찾을 수 없어요", "Can't find that mail"), 404); dropMail(m.key); return json({ ok: true }); }
    if (route === "POST /api/mail/delete-original") return json({ ok: true, results: (b.keys || []).map(key => { const x = mail(key); if (x) dropMail(key); return { key, ok: !!x, synced: !!x }; }) });
    return null;
  }
  function get(u) {
    const p = u.pathname;
    if (p === "/api/state") return json({ ...F.state, work_now: Date.now(), notices_unread: unread() });
    if (p === "/api/update") return json({ boot: "demo", running: updVersion, disk: updVersion, lastCheck: upd.lastCheck, job: null, flow: null, busy: [], settings: upd.settings });
    if (p === "/api/history") return json({ target: u.searchParams.get("target") || "main", events: F.histories[u.searchParams.get("target")] || [] });
    if (p === "/api/todo") return todoOf(u.searchParams.get("target") || "main");
    if (p === "/api/queue") return json(F.queue);
    if (p === "/api/subagents") return json(F.subagents);
    if (p === "/api/conversations") return json({ items: F.conversations });
    if (p.startsWith("/api/mailbox/")) return mailRoute("GET", u, {}) || bad("not found", 404);
    if (p === "/api/integrations") return json({ items: [...F.integrations, ...cmDemo.integrations].map(i => ({ ...i, needs: cmDemo.needs[i.key] || { drafts: 0, unread: F.mails.filter(m => m.dir === "in" && !m.read && owns(i, `mail:${m.key}`)).length, unreplied: 0, sentToday: 0 } })), available: [{ key: "naver-blog", label: L("네이버 블로그", "Naver Blog"), icon: "image" }] });
    if (p === "/api/apps") return json({ items: F.apps, errors: [] });
    // 댓글 (유튜브 · 인스타그램 · 웹사이트) and 인스타그램 DM: fixtures.js cmDemo
    if (p === "/api/comments/sources") return json({ on: true, sources: cmDemo.sources });
    if (p === "/api/comments/threads") return json({ threads: cmDemo.threads(u.searchParams.get("app") || "") });
    if (/^\/api\/comments\/thread\/[^/]+\/[^/]+$/.test(p)) { const q = p.split("/"), v = cmDemo.views[`${decodeURIComponent(q[4])}/${decodeURIComponent(q[5])}`]; return v ? json(v) : fail(L("이 글은 보고 있지 않아요", "This post isn't being watched")); }
    if (p === "/api/ig-dm") return json(cmDemo.dmList);
    if (/^\/api\/ig-dm\/[^/]+$/.test(p)) { const v = cmDemo.dm[p.split("/")[3]]; return v ? json(v) : fail(L("대화를 찾지 못했어요", "Can't find that conversation")); }
    if (/^\/api\/mail\/[^/]+\/body$/.test(p)) { const m = mail(p.split("/")[3]); return m && m.html ? new Response(F.mailBody(m), { headers: { "Content-Type": "text/html; charset=utf-8" } }) : new Response("", { status: 404 }); }
    if (/^\/api\/integrations\/[^/]+\/settings$/.test(p)) return json({ fields: F.appFields });
    if (/^\/api\/integrations\/[^/]+\/features$/.test(p)) return json(F.appFeatures);
    if (p === "/api/monitors") return json({ items: F.monitors });
    if (p === "/api/monitoring/peers") return json([]);
    // 감시·예약 설정 (hub/app-settings.ts), 답장 초안의 받는 사람·첨부 (hub/draft-recipients.ts, hub/draft-attach.ts), 연결 자동 설정 (hub/onboarding.ts)
    if (/^\/api\/(watches|schedules)\/[^/]+\/settings$/.test(p)) return json({ fields: [{ key: "every_minutes", label: L("확인 주기", "Check interval"), type: "number", help: L("몇 분마다 확인할지 정해요", "Set how many minutes between checks"), section: "watch", min: 1, max: 1440, value: 30 }] });
    if (/^\/api\/drafts\/[^/]+\/recipients$/.test(p)) return json({ to: [L("한서윤 <seoyun.han@example.com>", "Seoyun Han <seoyun.han@example.com>")], cc: [], mode: "reply", editable: true, reply: true });
    if (/^\/api\/drafts\/[^/]+\/files$/.test(p)) return json({ files: [], canAttach: true, library: false, editable: true });
    if (/^\/api\/onboarding\/[^/]+$/.test(p)) return json(onboard(p.split("/")[3]));
    if (p === "/api/notices") return json({ ...F.notices, items: F.notices.items.filter(n => !n.dismissed), unread: unread() });
    if (p === "/api/custom") return json({ dir: "", cards: [], projects: [...F.projects, BUILTIN], routines: [], links: [] });
    if (p === "/api/custom/project") return json(u.searchParams.get("key") === BUILTIN.key ? BUILTIN_DETAIL : F.projects.find(x => x.key === u.searchParams.get("key")) || {});
    if (p === "/api/activity") return json({ items: [], more: false, history: false });
    if (p === "/api/canvas") return json({ path: u.searchParams.get("path") || "", text: F.canvases[u.searchParams.get("path")] || "" });
    if (p === "/api/target") return json({ key: "orchestrator", target: u.searchParams.get("target") || "main", model: F.MODEL, thinking: "", models: [F.model], running: false, busy: false, context: {} });
    if (p === "/api/file") {
      const f = F.files[u.searchParams.get("path")];
      return f == null ? new Response(L("데모 파일이 없어요", "No such demo file"), { status: 404 }) : new Response(f, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (lists[p] !== undefined) return json(lists[p]);
    log.unknown.push(`GET ${p}`);
    return json({});
  }

  function postApi(u, body, method) {
    const p = u.pathname;
    log.posts.push(p);
    const mailAnswer = mailRoute(method, u, body);
    if (mailAnswer) return mailAnswer;
    const ob = /^\/api\/onboarding\/([^/]+)\//.exec(p);
    if (ob) return json(onboard(ob[1]));
    if (/^\/api\/comments\/drafts\/[^/]+\/send$/.test(p)) return json({ ok: true });
    if (/^\/api\/comments\/thread\/[^/]+\/[^/]+\/read$/.test(p) || p === "/api/ig-dm/refresh") return json({ ok: true });
    if (/^\/api\/comments\/comment\/[^/]+\/draft$/.test(p)) return json({ state: "drafting" }, 202);
    if (p === "/api/message") return json(answer(body));
    // 업데이트 설정 화면 (hub/selfupdate.ts updateRoute, hub/harness-update.ts, hub/push.ts): the web reads these answers back, so they carry the real hub's whole shape.
    if (p === "/api/update/check") { upd.lastCheck = { at: new Date().toISOString(), version: updVersion, ok: true, upstream: "origin/main", remoteHead: updVersion.commit.sha, summary: L("업데이트 없음", "No updates"), incoming: [], incomingTotal: 0, ahead: [], dropped: [], dirty: [], blocked: [] }; return json(upd.lastCheck); }
    if (p === "/api/update/settings") { for (const k of ["auto_check", "auto_apply"]) if (typeof body[k] === "boolean") upd.settings[k] = body[k]; return json({ ok: true, settings: upd.settings }); }
    if (p === "/api/harness/update/check") { const h = lists["/api/harness/update"]; for (const x of h.harnesses) x.checkedAt = new Date().toISOString(); return json({ ...h, busy: [], checking: false }); }
    if (p === "/api/push/classes") { Object.assign(lists[p].classes, body.classes); return json({ classes: lists[p].classes }); }
    if (p === "/api/command") return json({ output: L("데모에서는 명령을 실행하지 않아요.", "The demo doesn't run commands.") });
    if (p === "/api/read") { const c = conv(body.target); if (c) c.unread = 0; return json({}); }
    if (p === "/api/notices/read") { for (const n of F.notices.items) if (!body.ids || body.ids.includes(String(n.id))) n.read = true; F.state.notices_unread = unread(); return json({ unread: unread() }); }
    if (p === "/api/notices/seen") { let read = 0; for (const n of F.notices.items) if (!n.read && n.at === body.ts && n.tone !== "ask" && (n.kind === "result" || n.kind === "worklog") && [n.msg, n.src, n.open].includes(body.target)) { n.read = true; read++; } F.state.notices_unread = unread(); return json({ ok: true, read, unread: unread() }); }
    if (p === "/api/notices/reopen") return json({ unread: unread() });
    if (/^\/api\/mail\/[^/]+\/action$/.test(p)) { const m = mail(p.split("/")[3]); if (m && body.action === "read") m.read = true; if (m && body.action === "unread") m.read = false; return json({ ok: true, synced: true }); }
    if (p === "/api/mail/actions") return json({ ok: true, results: (body.keys || []).map(key => ({ key, ok: true, synced: true })) });
    if (p === "/api/mail/compose") return json({ ok: true, note: NOTE });
    if (p === "/api/projects" && body.key) {
      const pj = F.projects.find(x => x.key === body.key || x.recordKey === body.key);
      if (pj) for (const k of ["title", "purpose", "goal", "milestones"]) if (body[k] !== undefined) pj.record[k] = body[k];
      return json({ ok: true });
    }
    const nr = /^\/api\/notices\/([^/]+)\/(answer|ignore|unignore|dismiss|undismiss|handled)$/.exec(p);
    if (nr) {
      const n = F.notices.items.find(x => String(x.id) === decodeURIComponent(nr[1]));
      if (!n) return fail(L("이 알림은 이미 처리됐어요", "This notice was already handled"));
      if (nr[2] === "answer") {
        const opt = n.decision && n.decision.options.find(o => o.n === Number(body.n));
        if (!opt) return fail(L("고를 수 없는 항목이에요", "That option can't be picked"));
        answer({ text: `${opt.n}) ${opt.label}${body.note ? ` - ${body.note}` : ""}`, picks: [{ q: n.title, n: opt.n, label: opt.label, ...(body.note ? { note: body.note } : {}) }] }, n.decision.to);
      } else if (nr[2] === "ignore") { n.ignored = new Date().toISOString(); if (n.decision) n.decision.state = "ignored"; }
      else if (nr[2] === "unignore") { delete n.ignored; if (n.decision) n.decision.state = "open"; }
      else if (nr[2] === "handled") {
        // ✕ on a failure that waits (waits "fail"): read, closed with a time, and out of 처리할 것; anything else is refused like the hub.
        if (n.waits !== "fail") return json({ error: L("처리할 것이 아니에요", "This isn't something to handle") }, 409);
        n.read = true; n.handled = new Date().toISOString(); delete n.waits;
      }
      else if (nr[2] === "dismiss") { n.dismissed = new Date().toISOString(); }
      else if (nr[2] === "undismiss") { delete n.dismissed; }   // the toast's 실행 취소
      F.state.notices_unread = unread();
      if (nr[2] === "dismiss") emit({ kind: "notice", item: { ...n } });
      else if (nr[2] === "handled" || nr[2] === "undismiss") emit({ kind: "notice", item: n });
      return json({ ok: true, item: nr[2] === "dismiss" ? undefined : n, unread: unread() });
    }
    if (isOutward(body)) return fail(NOTE);
    return json({});
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) {
      log.unknown.push(`external ${url.href}`);
      return json({});
    }
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = String(init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    let body;
    if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = {}; } }
    if (method === "GET") return get(url);
    if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") return postApi(url, body || {}, method);
    return json({});
  };

  const sw = navigator.serviceWorker;
  if (sw) {
    const reg = { active: null, waiting: null, installing: null, pushManager: { getSubscription: async () => null, subscribe: async () => { throw new Error("demo"); } }, getNotifications: async () => [] };
    try { Object.defineProperty(sw, "register", { configurable: true, value: async () => reg }); } catch {}
    try { Object.defineProperty(sw, "ready", { configurable: true, get: () => Promise.resolve(reg) }); } catch {}
  }

  if (!location.hash) history.replaceState(null, "", `${location.pathname}${location.search}#chat/main`);
})();
