/* dotz demo transport: answers every /api/* request from demo/fixtures.js and plays a scripted assistant.
   Loaded before app.js, so no request leaves this page and no real gateway is needed. Replies reach the page through the
   same event stream frames the gateway sends (kind "message" / "out" / "notice"), so the app draws them as it draws real ones. */
(() => {
  const F = window.DEMO_FIXTURES;
  const NOTE = "데모에서는 실제로 보내지 않아요";
  const log = { unknown: [], posts: [], said: [] };
  window.__demoApi = log;

  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fail = message => json({ error: message }, 409);
  const isOutward = body => /(^|["\s])(보내기|전송|send)(["\s]|$)/i.test(JSON.stringify(body || {}));
  const lastTs = t => (F.histories[t] || []).reduce((m, e) => Math.max(m, Date.parse(e.ts) || 0), 0);
  const stamp = t => new Date(Math.max(Date.now(), lastTs(t) + 1)).toISOString();
  const conv = t => F.conversations.find(c => c.target === t);
  const plain = s => String(s || "").replace(/^\s*\[[a-z]+\]\s*/i, "").replace(/[#*`>[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  const unread = () => F.notices.items.filter(n => !n.read).length;
  const later = (ms, fn) => setTimeout(fn, ms);

  // 구성 탭: 지도(단계 카드)와 기능 목록, 프로젝트 비교 카드를 보여 줄 만큼의 손으로 쓴 데이터예요.
  const hn = (id, kind, group, label, summary, extra = {}) => ({ id, kind, group, label, summary, desc: summary + " 이 단계가 하는 일을 한 줄로 적었어요.", status: "ok", facts: [], settings: [], ...extra });
  const hset = (key, label, value, type, extra = {}) => ({ key, label, value, type, editable: true, applies: "live", source: "config.json:" + key, ...extra });
  const HARNESS_FX = {
    generated: new Date().toISOString(), data_dir: "~/.dotz", layers: [],
    nodes: [
      hn("ch-web", "channel", "flow", "웹 채팅", "브라우저에서 보낸 글", { facts: [{ label: "연결", value: "2개 기기" }] }),
      hn("ch-discord", "channel", "flow", "Discord", "서버 1곳 · 채널 3개", { status: "warn", facts: [{ label: "연결", value: "재연결 중" }] }),
      hn("ch-kakao", "channel", "flow", "카카오톡", "나와의 채팅 1개", { status: "off" }),
      hn("gateway", "gateway", "flow", "게이트웨이", "들어온 글을 모아 어시스턴트에게 넘겨요", { facts: [{ label: "열린 길", value: "8080" }], settings: [hset("gateway.debounce", "글 묶는 시간", 1200, "number", { unit: "ms", default: 800, min: 0, max: 5000 }), hset("gateway.quiet", "조용한 시간 알림 끄기", true, "bool", { default: false })] }),
      hn("orchestrator", "orchestrator", "flow", "어시스턴트", "받은 글을 읽고 할 일을 나눠요", { status: "busy", facts: [{ label: "모델", value: "Opus 4.8" }], settings: [hset("orchestrator.thinking", "생각 강도", "high", "select", { options: [{ value: "low", label: "낮음" }, { value: "high", label: "높음" }], default: "medium" }), hset("orchestrator.reply_style", "답 말투", "해요체", "text", { default: "해요체" })] }),
      hn("lanes", "lanes", "flow", "세션", "채널마다 이어지는 작업 줄 4개", { status: "busy", facts: [{ label: "돌아가는 중", value: "2개" }] }),
      hn("workers", "workers", "flow", "서브에이전트", "나눠 맡은 일을 따로 처리해요"),
      hn("rules", "file", "files", "RULES.md", "지킬 규칙 12줄", { anchor: "orchestrator", file: "RULES.md", fileEditable: true, order: 1 }),
      hn("lessons", "file", "files", "LESSONS.md", "배운 것 8줄", { anchor: "orchestrator", file: "LESSONS.md", fileEditable: true, order: 2 }),
      hn("memory", "system", "support", "기억", "메모 41개", { anchor: "orchestrator", order: 3 }),
      hn("monitor", "system", "support", "모니터링", "점검 3개", { anchor: "lanes", order: 1 }),
    ],
    edges: [
      { from: "ch-web", to: "gateway", label: "들어온 글" }, { from: "ch-discord", to: "gateway", label: "들어온 글" }, { from: "ch-kakao", to: "gateway", label: "들어온 글" },
      { from: "gateway", to: "orchestrator", label: "묶은 글" }, { from: "orchestrator", to: "lanes", label: "일 맡기기" }, { from: "lanes", to: "workers", label: "나눈 일" },
      { from: "rules", to: "orchestrator", label: "규칙" }, { from: "lessons", to: "orchestrator", label: "배운 것" }, { from: "memory", to: "orchestrator", label: "기억" }, { from: "monitor", to: "lanes", label: "변화" },
    ],
    projects: [
      { id: "p-blog", name: "블로그 정리", status: "working", status_text: "작업 중", overrides: 2, cwd: "/home/me/Code/blog", channels: [{ kind: "work", kind_text: "작업 채널", name: "블로그" }],
        fields: { model: { value: "claude-opus-4-8", global: "claude-opus-4-8", source: "global" }, effort: { value: "xhigh", global: "high", source: "project" }, worker_model: { value: "claude-sonnet-5-5", global: "claude-sonnet-5-5", source: "global" }, worker_effort: { value: "medium", global: "medium", source: "global" }, runtime: { value: "omo", global: "omo", source: "global" }, fallback: { value: [], global: [], source: "global" }, worker_fallback: { value: [], global: [], source: "global" } },
        files: [{ name: "AGENTS.md", bytes: 2480, modified: new Date(Date.now() - 864e5).toISOString() }], features: [{ name: "글 올리기 전 맞춤법" }], deny: ["rm -rf"], setup: { purpose: "블로그 글을 다듬고 올려요.", logins: [{ name: "티스토리" }], monitors: [1], standing: "" },
        map: { nodes: [], edges: [] } },
      { id: "p-home", name: "집안일", status: "idle", status_text: "대기", overrides: 0, cwd: "/home/me/Code/home", channels: [{ kind: "home", kind_text: "홈 채널", name: "집" }],
        fields: { model: { value: "claude-opus-4-8", global: "claude-opus-4-8", source: "global" }, effort: { value: "high", global: "high", source: "global" }, worker_model: { value: "claude-sonnet-5-5", global: "claude-sonnet-5-5", source: "global" }, worker_effort: { value: "medium", global: "medium", source: "global" }, runtime: { value: "omo", global: "omo", source: "global" }, fallback: { value: [], global: [], source: "global" }, worker_fallback: { value: [], global: [], source: "global" } },
        files: [], features: [], deny: [], setup: null, map: { nodes: [], edges: [] } },
    ],
  };
  HARNESS_FX.projects.forEach(p => { p.map = { nodes: HARNESS_FX.nodes.filter(n => n.group === "flow" && !n.id.startsWith("ch-")).concat(HARNESS_FX.nodes.filter(n => n.id === "ch-web")), edges: HARNESS_FX.edges.filter(e => !/^ch-(discord|kakao)/.test(e.from) && !["rules", "lessons", "memory", "monitor"].includes(e.from)) }; });
  const hf = (id, form, name, what, trigger, stage, strength, label, extra = {}) => ({ id, form, name, what, trigger, stage, strength, source: { label }, enabled: true, toggleable: false, origin: "personal", ...extra });
  const FEATURES_FX = {
    generated: new Date().toISOString(), harness: { id: "omo", name: "OmO", dirs: [] }, data_dir: "~/.dotz", skipped_dirs: [],
    forms: ["글 지시", "차단 명령", "기능 폴더", "예약", "모니터링"],
    triggers: ["메시지 도착", "정해진 시각", "변화 감지", "도구 실행 직전", "항상(프롬프트)"],
    stages: HARNESS_FX.nodes.map(n => n.id),
    features: [
      hf("f1", "글 지시", "답은 해요체로 짧게", "답장은 해요체로, 세 줄 안에 끝내요.", "항상(프롬프트)", "rules", "advisory", "RULES.md:4", { source: { label: "RULES.md:4", file: "RULES.md", line: 4 } }),
      hf("f2", "차단 명령", "강제 삭제 막기", "rm -rf 가 들어간 명령은 실행 직전에 막아요.", "도구 실행 직전", "rules", "enforced", "RULES.md:9", { source: { label: "RULES.md:9", file: "RULES.md", line: 9 } }),
      hf("f3", "기능 폴더", "아침 요약", "매일 아침 일정과 메일을 한 번에 요약해요.", "정해진 시각", "lanes", "advisory", "features/morning/feature.md", { toggleable: true, enabled: true }),
      hf("f4", "기능 폴더", "가격 변화 알림", "관심 상품 가격이 내려가면 알려 줘요.", "변화 감지", "lanes", "enforced", "features/price/feature.md", { toggleable: true, enabled: false }),
      hf("f5", "예약", "주간 정리", "금요일 저녁에 한 주를 정리해요.", "정해진 시각", "lanes", "advisory", "schedules.json"),
      hf("f6", "모니터링", "블로그 댓글 확인", "10분마다 새 댓글만 알려요.", "변화 감지", "lanes", "enforced", "watches.json"),
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
  ST["ch:2"] = { ...st("ch:2"), card: { kind: "pick", options: ["짧은 공지", "목록 공지", "공지 없이 배포"] } };

  const mail = k => F.mails.find(m => m.key === k);
  const who = m => (m.org ? m.name : `${m.name}님`);
  const inbox = () => F.mails.filter(m => m.dir === "in" && !m.archived);
  const owed = () => inbox().filter(m => m.reply === "needs");
  const quote = lines => lines.map(l => `> ${l}`).join("\n");
  const rx = (s, re) => re.test(s);
  const SUGGEST = "이렇게 말해 보세요.\n\n- 메일 정리해 줘\n- 오늘 일정 알려 줘\n- 가격 페이지 바뀌면 알려 줘";

  const ORD = [[/(첫\s*번?째|첫\s*번|1\s*번|하나)/, 1], [/(두\s*번?째|2\s*번|둘)/, 2], [/(세\s*번?째|3\s*번|셋)/, 3], [/(네\s*번?째|4\s*번|넷)/, 4], [/마지막/, -1]];
  function ordinal(s) {
    const bare = /^\s*([1-4])\s*(?:\)|번)?\s*(?:[-–:]\s*(.*))?$/.exec(s);
    if (bare) return { n: Number(bare[1]), note: (bare[2] || "").trim() };
    for (const [re, n] of ORD) if (re.test(s)) return { n, note: "" };
    return null;
  }
  const pickFrom = (list, n) => (n === -1 ? list[list.length - 1] : list[n - 1]);

  /* ---- drafts: a mail reply or a comment reply, each with a few variants ---- */
  const MAIL_DRAFT = {
    "m-1": {
      normal: ["안녕하세요, 서윤님.", "다음 주 화요일 오후 2시가 좋아요.", "온라인으로 뵐까요?", "감사합니다."],
      short: ["서윤님, 화요일 오후 2시 좋아요.", "온라인으로 뵐게요."],
      formal: ["안녕하십니까, 한서윤 님.", "다음 주 화요일 오후 2시에 뵙겠습니다.", "장소는 온라인으로 제안드립니다.", "감사합니다."],
      casual: ["서윤님, 화요일 2시 어때요?", "온라인으로 편하게 봬요!"],
      time: p => ["안녕하세요, 서윤님.", `다음 주 ${p}가 좋아요.`, "온라인으로 뵐까요?", "감사합니다."],
    },
    "m-3": {
      normal: ["지훈님, 수정본 잘 받았어요.", "금요일까지 검토하고 의견 드릴게요.", "감사합니다."],
      short: ["지훈님, 잘 받았어요.", "금요일까지 의견 드릴게요."],
      formal: ["오지훈 님, 수정본 잘 받았습니다.", "금요일까지 검토 후 회신드리겠습니다.", "감사합니다."],
      casual: ["지훈님, 받았어요!", "금요일 전에 의견 드릴게요."],
      time: p => ["지훈님, 수정본 잘 받았어요.", `${p}까지 검토하고 의견 드릴게요.`, "감사합니다."],
    },
  };
  const genericDraft = m => ({
    normal: [`${m.short}, 메일 잘 받았어요.`, "확인하고 다시 연락드릴게요.", "감사합니다."],
    short: [`${m.short}, 잘 받았어요. 고마워요.`],
    formal: [`${m.name} 님, 메일 잘 받았습니다.`, "확인 후 다시 연락드리겠습니다."],
    casual: [`${m.short}, 받았어요!`, "곧 다시 연락할게요."],
    time: p => [`${m.short}, 메일 잘 받았어요.`, `${p}까지 다시 연락드릴게요.`],
  });
  const VARIANT_KO = { normal: "기본", short: "짧게", formal: "정중하게", casual: "편하게" };
  const TIME_RE = /((?:다음\s*주\s*)?(?:[월화수목금토일]요일)(?:\s*(?:오전|오후|아침|저녁))?(?:\s*\d{1,2}\s*시(?:\s*반)?)?|(?:내일|모레)(?:\s*(?:오전|오후))?(?:\s*\d{1,2}\s*시)?|(?:오전|오후)\s*\d{1,2}\s*시(?:\s*반)?)/;

  function draftLines(d) {
    if (d.kind === "mail") {
      const set = MAIL_DRAFT[d.key] || genericDraft(mail(d.key));
      const base = d.time ? set.time(d.time) : set[d.variant] || set.normal;
      return d.extra ? [...base.slice(0, -1), d.extra, base[base.length - 1]] : base;
    }
    const c = F.comments.find(x => x.n === d.n);
    const base = d.variant === "short" ? c.short : d.variant === "formal" ? [`${c.author} 님, 문의 감사합니다.`, ...c.reply] : d.variant === "casual" ? [`${c.author}님!`, ...c.short] : c.reply;
    return d.extra ? [...base, d.extra] : base;
  }
  function draftCard(t, d, lead) {
    st(t).draft = d;
    st(t).card = { kind: "send" };
    st(t).awaitEdit = false;
    const head = d.kind === "mail"
      ? `받는이: ${mail(d.key).name}\n제목: Re: ${mail(d.key).subject}`
      : `${d.platform} · ${F.comments.find(x => x.n === d.n).author}님 댓글에 답글`;
    return `[ask] ${lead}\n\n${head}\n\n${quote(draftLines(d))}\n\n결정: 이대로 보낼까요?\n1) 보내기 ← 추천\n${d.kind === "mail" ? "이 초안으로 답장해요" : "이 답글을 달아요"}\n2) 고치기\n고칠 내용을 적어 주세요\n3) 보내지 않기\n초안을 버려요`;
  }
  function revise(t, how) {
    const d = { ...st(t).draft };
    const time = TIME_RE.exec(how);
    if (rx(how, /짧|줄여|간단|간결/)) { d.variant = "short"; d.time = ""; }
    else if (rx(how, /정중|공손|격식|예의|딱딱/)) { d.variant = "formal"; d.time = ""; }
    else if (rx(how, /편하|친근|캐주얼|가볍|부드럽/)) { d.variant = "casual"; d.time = ""; }
    else if (time && d.kind === "mail") d.time = time[1].replace(/\s+/g, " ").trim();
    else {
      const ask = how.replace(/(?:도|을|를)?\s*(?:넣어|추가해|덧붙여|말해|적어|써|물어봐)\s*(?:줘|주세요|줄래)?[.!]?$/, "").replace(/라고$/, "").trim();
      d.extra = ask ? `${ask.replace(/[.!?]$/, "")}도 함께 전해 드려요.` : d.extra;
    }
    return draftCard(t, d, "고쳤어요. 다시 확인해 주세요.");
  }
  function sendDraft(t) {
    const d = st(t).draft;
    st(t).card = null; st(t).draft = null;
    if (d.kind === "mail") {
      const m = mail(d.key);
      m.reply = "replied";
      const sent = { key: `s-${Date.now()}`, at: new Date().toISOString(), dir: "out", read: true, from: "나 <me@example.com>", to: m.from, name: m.name, short: m.short, subject: `Re: ${m.subject}`, summary: "dotz가 쓴 답장이에요.", text: draftLines(d).join("\n") };
      F.mails.push(sent);
      const c = conv(`mail:${m.key}`); if (c && c.mail) c.mail.reply = "replied";
      F.histories[`mail:${sent.key}`] = [F.mailEvent(sent)];
      F.conversations.push({ target: `mail:${sent.key}`, last: { ts: sent.at, text: sent.subject, from: "owner" }, unread: 0, read: sent.at, mail: F.mailCard(sent) });
      worklog(`${who(m)}에게 답장을 보냈어요. (데모)`);
      later(200, () => { if (typeof convLoad === "function") convLoad(); });
      return `[done] 보냈어요. 보낸 메일함에서 볼 수 있어요.\n\n- 받는이: ${m.name}\n- 제목: Re: ${m.subject}\n\n데모라 실제로 나가지는 않아요.`;
    }
    const c = F.comments.find(x => x.n === d.n);
    c.done = true;
    worklog(`${c.platform} 댓글에 답글을 달았어요. (데모)`);
    const left = F.comments.filter(x => !x.done);
    return `[done] ${c.platform}에 답글을 달았어요.\n데모라 실제로 올라가지는 않아요.${left.length ? `\n\n남은 댓글이 ${left.length}개예요. "다음 댓글"이라고 하면 이어서 써요.` : ""}`;
  }
  function dropDraft(t) {
    st(t).card = null; st(t).draft = null; st(t).awaitEdit = false;
    return "알겠어요. 초안은 버렸고 아무것도 보내지 않았어요.";
  }

  /* ---- topics ---- */
  function mailSummary(t) {
    const list = inbox();
    st(t).list = { kind: "mail", items: list.map(m => m.key) };
    const lines = list.map((m, i) => `${i + 1}. ${m.name} · ${m.subject}${m.reply === "needs" ? " (답장 필요)" : ""}`);
    return {
      text: `받은 메일 ${list.length}통을 정리했어요.\n답장할 메일은 ${owed().length}통이에요.\n\n${lines.join("\n")}\n\n번호를 말하면 읽어 드리고,\n"답장 써 줘"라고 하면 초안을 써요.`,
      short: `답장할 메일은 ${owed().map(who).join(", ")} 메일이에요.`,
    };
  }
  function readMail(t, m) {
    st(t).focus = m.key;
    m.read = true;
    const c = conv(`mail:${m.key}`); if (c && c.mail) c.mail.read = true;
    return {
      text: `${who(m)} 메일이에요.\n제목: ${m.subject}\n\n${quote(m.text.split("\n").filter(l => l.trim()))}${m.attachments ? `\n\n첨부: ${m.attachments.map(a => a.name).join(", ")}` : ""}\n\n${m.reply === "needs" ? "답장 초안을 써 드릴까요?" : "답장은 필요 없어 보여요."}`,
      short: m.summary,
    };
  }
  function pickMail(t, s) {
    if (t.startsWith("mail:")) return mail(t.slice(5));
    const by = F.mails.find(m => m.dir === "in" && (s.includes(m.name) || s.includes(m.short.replace(/님$/, "")) || (m.key === "m-3" && /견적/.test(s)) || (m.key === "m-1" && /미팅/.test(s)) || (m.key === "m-2" && /배송|램프|주문/.test(s)) || (m.key === "m-4" && /소식지|뉴스레터/.test(s))));
    if (by) return by;
    const o = ordinal(s), L = st(t).list;
    if (o && L && L.kind === "mail") return mail(pickFrom(L.items, o.n));
    if (st(t).focus) return mail(st(t).focus);
    return null;
  }
  function mailReply(t, m) {
    m = m || owed()[0];
    if (!m) return { text: "답장할 메일이 없어요. 받은 메일은 모두 처리됐어요." };
    return { text: draftCard(t, { kind: "mail", key: m.key, variant: "normal" }, `${who(m)}에게 보낼 답장 초안이에요.`) };
  }
  const evLine = e => `- ${e.at} ${e.title}${e.where ? ` · ${e.where}` : ""}`;
  function schedule(t, day) {
    const list = F.calendar[day];
    st(t).list = { kind: "event", items: list };
    return {
      text: `${day === "today" ? "오늘" : "내일"} 일정은 ${list.length}개예요.\n\n${list.map(evLine).join("\n")}\n\n${day === "today" ? "\"내일은?\"이라고 물어봐도 돼요." : "오늘 일정으로 돌아가려면 \"오늘 일정\"이라고 해 주세요."}`,
      short: `${day === "today" ? "오늘" : "내일"} 첫 일정은 ${list[0].at} ${list[0].title}이에요.`,
    };
  }
  function briefing() {
    const ev = F.calendar.today;
    return {
      text: `좋은 아침이에요. 오늘 브리핑이에요.\n\n- 일정 ${ev.length}개, 첫 일정은 ${ev[0].at} ${ev[0].title}\n- 안 읽은 메일 ${inbox().filter(m => !m.read).length}통, 답장할 메일 ${owed().length}통\n- 댓글 ${F.comments.filter(c => !c.done).length}개가 답글을 기다려요\n- 감시 중인 페이지는 변화 없어요\n\n하나씩 볼까요? "메일부터"처럼 말해 주세요.`,
      short: `오늘은 일정 ${ev.length}개, 답장할 메일 ${owed().length}통이에요.`,
    };
  }
  function commentList(t) {
    const left = F.comments.filter(c => !c.done);
    if (!left.length) return { text: "답글을 기다리는 댓글이 없어요. 모두 처리했어요." };
    st(t).list = { kind: "comment", items: left.map(c => c.n) };
    st(t).card = { kind: "comment" };
    return { text: `[ask] 답글을 기다리는 댓글이 ${left.length}개예요.\n\n${left.map((c, i) => `${i + 1}. ${c.platform} · ${c.author}: "${c.text}"`).join("\n")}\n\n결정: 어느 댓글에 답글을 쓸까요?\n${left.map((c, i) => `${i + 1}) ${c.platform} 댓글${i === 0 ? " ← 추천" : ""}\n${c.author}님`).join("\n")}` };
  }
  function commentReply(t, c) {
    return { text: draftCard(t, { kind: "comment", n: c.n, platform: c.platform, variant: "normal" }, `${c.author}님 댓글에 달 답글 초안이에요.\n원댓글: "${c.text}"`) };
  }
  function pickComment(t, s) {
    const plat = /유튜브|youtube/i.test(s) ? "유튜브" : /인스타/.test(s) ? "인스타그램" : /웹사이트|사이트|홈페이지/.test(s) ? "웹사이트" : "";
    const left = F.comments.filter(c => !c.done);
    return (plat && left.find(c => c.platform === plat)) || null;
  }
  function watchAsk(t, s) {
    const url = (/(https?:\/\/\S+|[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?)/i.exec(s) || [])[1] || "example.com/pricing";
    const what = /가격|요금/.test(s) ? "가격" : /재고|품절/.test(s) ? "재고" : /공지|뉴스/.test(s) ? "공지" : "내용";
    st(t).card = { kind: "watch", url, what };
    return { text: `[ask] ${url} 페이지의 ${what}이 바뀌면 알려 드릴게요.\n바뀐 곳만 짧게 알림으로 보내요.\n\n결정: 얼마나 자주 확인할까요?\n1) 30분마다 ← 추천\n빠르게 알아요\n2) 하루 한 번\n아침 9시에 확인해요\n3) 그만두기\n감시를 만들지 않아요` };
  }
  function watchOn(t, n) {
    const c = st(t).card; st(t).card = null;
    if (n === 3) return "알겠어요. 감시는 만들지 않았어요.";
    const every = n === 1 ? "30분마다" : "하루 한 번";
    const name = `${c.url.replace(/^https?:\/\//, "").split("/")[0]} ${c.what} 감시`;
    F.monitors.push({ name, kind: "watch", watch: `demo-${Date.now()}`, scope: "plain", last_run: new Date().toISOString(), next_run: new Date(Date.now() + (n === 1 ? 30 : 1440) * 60_000).toISOString(), last_result: "ok" });
    worklog(`감시를 켰어요: ${name} (${every})`);
    later(9000, () => {
      const m = F.monitors.find(x => x.name === name); if (m) m.last_result = "changed";
      notice({ src: "alert", open: "alert", title: `${name}: 바뀐 곳이 있어요` }, `[${name}] 바뀐 곳이 있어요.\n\n- ${c.what === "가격" ? "기본 요금이 9,900원에서 8,900원으로 내려갔어요" : "새 문단이 하나 추가됐어요"}`);
      post(t, `방금 ${name}에서 변화를 찾았어요.\n${c.what === "가격" ? "기본 요금이 8,900원으로 내려갔어요." : "새 문단이 하나 추가됐어요."}\n\n알림 탭에도 남겨 뒀어요.`);
    });
    return `[done] 감시를 켰어요.\n\n- 대상: ${c.url}\n- 주기: ${every}\n- 바뀌면: 알림으로 알려 드려요\n\n데모에서는 잠시 뒤에 변화 알림이 하나 와요.`;
  }
  function parseTime(s) {
    const m = /(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*시(\s*반|\s*\d{1,2}\s*분)?/.exec(s);
    if (!m) return null;
    let h = Number(m[2]);
    const pm = m[1] === "오후" || m[1] === "저녁" || m[1] === "밤";
    if (pm && h < 12) h += 12;
    const min = m[3] ? (/반/.test(m[3]) ? 30 : Number(m[3].replace(/\D/g, ""))) : 0;
    return { h, min, ko: `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}시${min ? ` ${min}분` : ""}` };
  }
  function routineAsk(t, s) {
    const time = parseTime(s) || { h: 9, min: 0, ko: "오전 9시" };
    const day = /주말/.test(s) ? "주말마다" : /평일/.test(s) ? "평일마다" : /매주\s*([월화수목금토일])/.test(s) ? `매주 ${/매주\s*([월화수목금토일])/.exec(s)[1]}요일` : "매일";
    const job = /메일/.test(s) ? "메일 요약" : /일정/.test(s) ? "일정 알림" : /댓글/.test(s) ? "댓글 확인" : /뉴스|소식/.test(s) ? "소식 정리" : "아침 브리핑";
    st(t).card = { kind: "routine", time, day, job };
    return { text: `[ask] ${day} ${time.ko}에 ${job}을 보내 드릴게요.\n\n결정: 이대로 등록할까요?\n1) 등록 ← 추천\n${day} ${time.ko}에 돌아요\n2) 시간 바꾸기 …\n원하는 시간을 적어 주세요\n3) 그만두기\n등록하지 않아요` };
  }
  function routineOn(t, n, note) {
    const c = st(t).card;
    if (n === 3) { st(t).card = null; return { text: "알겠어요. 루틴은 등록하지 않았어요." }; }
    if (n === 2) {
      const time = note && parseTime(note);
      if (!time) { st(t).awaitTime = true; return { text: "몇 시로 바꿀까요? \"오후 6시\"처럼 적어 주세요." }; }
      st(t).awaitTime = false;
      return routineAsk(t, `${c.day} ${time.ko} ${c.job}`);
    }
    st(t).card = null;
    F.monitors.push({ name: `${c.job} 루틴`, kind: "schedule", watch: "", scope: "plain", last_run: "", next_run: new Date(Date.now() + 18 * 3600_000).toISOString(), last_result: "" });
    worklog(`루틴을 등록했어요: ${c.day} ${c.time.ko} ${c.job}`);
    return { text: `[done] 등록했어요.\n\n- 언제: ${c.day} ${c.time.ko}\n- 할 일: ${c.job}\n- 첫 실행: 내일 ${c.time.ko}\n\n바꾸고 싶으면 "시간 바꿔 줘"라고 해 주세요.` };
  }
  function startTask(t, s) {
    const topic = s.replace(/(?:좀|좀\s*)?(?:해\s*줘|해\s*주세요|해\s*줄래|부탁해|해\s*봐)[.!?]?$/, "").replace(/\s+/g, " ").trim().slice(0, 30) || "요청하신 작업";
    const id = `st_${Date.now()}`;
    const job = { id, description: topic, status: "running", started_at: Date.now() };
    F.state.work.unshift(job);
    st(t).task = { id, topic, step: 0, done: false };
    later(600, () => { post(t, `백그라운드 작업으로 맡겼어요: ${topic}`, { source: "gateway", system: true, worker: id }); repaint(); });
    later(4500, () => { const k = st(t).task; if (k && k.id === id) k.step = 1; });
    later(9000, () => {
      job.status = "done"; job.ended_at = Date.now();
      const k = st(t).task; if (k && k.id === id) k.done = true;
      const file = `reports/${topic.replace(/[^\w가-힣]+/g, "-").replace(/^-|-$/g, "")}.md`;
      F.files[file] = `# ${topic}\n\n데모로 만든 결과예요.\n\n## 요약\n\n- 비교한 곳: 세 곳\n- 가장 싼 곳: 가상의 서비스 B (월 8,900원)\n- 눈여겨볼 점: 연간 결제 할인이 커요\n`;
      post(t, `[done] 다 했어요: ${topic}\n\n- 세 곳을 비교했어요\n- 가장 싼 곳은 가상의 서비스 B예요\n- 연간 결제 할인이 가장 커요\n\n[file] ${file}`);
      notice({ src: t, open: t, title: `작업이 끝났어요: ${topic}` });
      worklog(`작업을 마쳤어요: ${topic}`);
      repaint();
    });
    return { text: `맡았어요. 백그라운드에서 진행하고\n끝나면 이 대화에 결과를 올릴게요.\n\n진행 상황이 궁금하면 "어디까지 됐어?"라고 물어봐 주세요.` };
  }
  function taskStatus(t) {
    const k = st(t).task;
    if (!k) return { text: "지금 진행 중인 작업은 없어요.\n\"경쟁 서비스 가격 조사해 줘\"처럼 맡겨 보세요." };
    if (k.done) return { text: `"${k.topic}" 작업은 끝났어요. 위에 결과 파일을 올려 뒀어요.\n"더 자세히"라고 하면 풀어서 설명해요.` };
    return { text: k.step ? `"${k.topic}" 작업은 절반쯤 왔어요.\n자료를 모았고, 지금 비교하고 있어요.` : `"${k.topic}" 작업을 막 시작했어요.\n자료를 모으고 있어요.` };
  }
  function makeFile(t, s) {
    const kind = /엑셀|표|스프레드|csv/i.test(s) ? ["표", "csv"] : /슬라이드|발표|ppt/i.test(s) ? ["발표 개요", "md"] : ["문서", "md"];
    const name = /주간|보고/.test(s) ? "주간-보고서" : /회의|미팅/.test(s) ? "회의-메모" : /견적/.test(s) ? "견적-검토" : "정리-문서";
    const path = `docs/${name}.${kind[1]}`;
    F.files[path] = kind[1] === "csv" ? "항목,상태,담당\n메일 답장,진행 중,나\n견적서 검토,대기,나\n댓글 정리,대기,dotz\n" : `# ${name.replace(/-/g, " ")}\n\n- 이번 주 한 일: 메일 정리, 댓글 답글, 감시 설정\n- 다음 주 할 일: 견적 확정, 배포 공지\n`;
    return { text: `[done] ${kind[0]}로 만들었어요.\n눌러서 바로 열어 볼 수 있어요.\n\n[file] ${path}`, short: `${path} 파일로 만들었어요.` };
  }
  const TOPICS = [
    [/보안|안전|개인\s*정보|데이터.*(어디|저장)|어디에\s*저장|유출|해킹|믿어도|비밀번호/, () => ({ text: "데이터는 내 컴퓨터에 그대로 있어요.\n메일과 대화 기록도 내 기기에 저장돼요.\n\n- 메일·댓글·메시지는 \"보내기\"를 누르기 전엔 나가지 않아요\n- 보내기 전에 늘 승인 카드를 보여 드려요\n- 연결한 계정은 설정에서 언제든 끊을 수 있어요", short: "내 기기에 저장되고, 보내기를 눌러야만 나가요." })],
    [/메신저|텔레그램|디스코드|discord|telegram|슬랙|폰에서|휴대폰|모바일|밖에서/i, () => ({ text: "밖에서도 이어서 쓸 수 있어요.\n\n- 휴대폰 브라우저에서 이 화면을 앱처럼 설치해요\n- 디스코드나 텔레그램을 연결하면\n  메신저로 말 걸고 알림도 받아요\n\n설정 > 메신저에서 연결해요.", short: "휴대폰 앱이나 디스코드·텔레그램으로 이어서 써요." })],
  ];

  function topic(t, s) {
    for (const [re, f] of TOPICS) if (re.test(s)) return f(t, s);
    if (rx(s, /댓글|유튜브|인스타|리뷰|답글/i)) {
      const c = pickComment(t, s);
      if (c || rx(s, /답글|답\s*달|써/)) return c ? commentReply(t, c) : rx(s, /다음/) && F.comments.find(x => !x.done) ? commentReply(t, F.comments.find(x => !x.done)) : commentList(t);
      return commentList(t);
    }
    if (rx(s, /감시|지켜|모니터|바뀌면|변하면|올라오면|떨어지면|생기면|재고/)) return watchAsk(t, s);
    if (rx(s, /매일|매주|평일|주말마다|아침마다|저녁마다|루틴|예약|반복|정기/)) return routineAsk(t, s);
    if (rx(s, /브리핑|오늘\s*(뭐|어때)|하루\s*요약/)) return briefing(t);
    if (rx(s, /내일/) && rx(s, /일정|약속|뭐|은\??$|는\??$/)) return schedule(t, "tomorrow");
    if (rx(s, /일정|캘린더|스케줄|약속|회의|미팅\s*몇|오늘/) && !rx(s, /메일/)) return schedule(t, "today");
    if (rx(s, /메일|이메일|편지|받은\s*함|답장|회신/) || t.startsWith("mail:")) {
      const m = pickMail(t, s);
      if (rx(s, /답장|회신|초안|답\s*써|답해/)) return mailReply(t, m && m.reply === "needs" ? m : m && t.startsWith("mail:") ? m : null);
      if (m && rx(s, /읽|열|보여|내용|뭐래|무슨/)) return readMail(t, m);
      if (t.startsWith("mail:") && m) return readMail(t, m);
      return mailSummary(t);
    }
    if (rx(s, /어디까지|진행\s*상황|다\s*됐|얼마나\s*됐|끝났/)) return taskStatus(t);
    if (rx(s, /파일|문서|보고서|엑셀|표로|슬라이드|pdf|csv|만들어\s*줘.*(정리|목록)|정리해서\s*줘/i)) return makeFile(t, s);
    if (rx(s, /조사|리서치|분석|비교|알아봐|찾아봐|맡길|맡겨|작업|프로젝트.*(시작|해)/)) return startTask(t, s);
    if (rx(s, /프로젝트/)) return { text: `프로젝트는 ${F.projects.length}개예요.\n\n${F.projects.map(p => `- ${p.name}: ${p.record.milestones.filter(x => x.done).length}/${p.record.milestones.length} 단계 완료`).join("\n")}\n\n일을 맡기려면 "경쟁 서비스 가격 조사해 줘"처럼 말해 주세요.` };
    if (rx(s, /고마|감사|땡큐|thank|최고|좋아요?$|굿/i)) return { text: "천만에요. 또 필요한 게 있으면 말해 주세요." };
    if (rx(s, /^(안녕|하이|hi|hello|헬로|ㅎㅇ)/i)) return { text: `안녕하세요. 저는 dotz예요.\n메일, 일정, 댓글, 감시를 대신 챙겨요.\n\n${SUGGEST}` };
    if (rx(s, /누구|뭘\s*할\s*수|뭐\s*할\s*수|뭐\s*해\s*줄|기능|도움말|help|사용법|어떻게\s*써/i)) return { text: "제가 할 수 있는 일이에요.\n\n- 메일 요약, 읽기, 답장 초안\n- 오늘 일정과 아침 브리핑\n- 유튜브·인스타·웹사이트 댓글 답글\n- 페이지 감시와 변화 알림\n- 매일 정해진 시간에 할 일\n- 조사 같은 긴 작업과 결과 파일\n\n보내는 일은 늘 승인을 받고 해요." };
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
        return { text: "어떻게 고칠까요?\n\"더 짧게\", \"정중하게\", \"수요일 오전 10시로\"처럼 말해 주세요." };
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
      return { text: n === 3 ? "알겠어요. 공지 없이 배포하고, 릴리스 노트만 남겨 둘게요." : `정했어요. ${label}로 다듬어 둘게요.\n\n"보여 줘"라고 하면 초안을 보여 드려요.`, after: () => { S.notice = label; } };
    }
    return null;
  }
  const CARD_WORDS = [[/(보내지\s*마|안\s*보내|보내지\s*않|버려|취소|그만|됐어|필요\s*없)/, 3], [/^(보내|보내줘|보내\s*줘|전송|그대로\s*보내|좋아\s*보내|ㅇㅇ\s*보내|응\s*보내)/, 1], [/^(고쳐|수정|고치기|바꿔)/, 2], [/^(등록|켜|켜줘|좋아|응|네|그래|ㅇㅇ|오케이|ok)/i, 1]];

  function respond(t, s, picks) {
    const S = st(t);
    const pick = picks && picks[0];
    if (pick && S.card) {
      const n = Number(pick.n), note = pick.note || (/\s-\s(.+)$/.exec(s) || [])[1] || "";
      const r = onCard(t, n, note.trim(), s);
      if (r) return r;
    }
    if (S.awaitEdit && S.draft && !rx(s, /취소|그만|보내지\s*마|버려/)) return { text: revise(t, s) };
    if (S.awaitTime && S.card && S.card.kind === "routine") { const r = routineOn(t, 2, s); if (!S.awaitTime) return r; return r; }
    if (/^\s*아니/.test(s) && S.list) {
      const o = ordinal(s);
      if (o) {
        const id = pickFrom(S.list.items, o.n);
        if (S.list.kind === "comment") { const cm = F.comments.find(x => x.n === id); if (cm) return commentReply(t, cm); }
        if (S.list.kind === "mail") { const m = mail(id); if (S.draft && S.draft.kind === "mail") return mailReply(t, m); return readMail(t, m); }
        if (S.list.kind === "event" && id) return { text: `${id.at} ${id.title}${id.where ? ` (${id.where})` : ""}이에요.\n30분 전에 알려 드릴까요?` };
      }
    }
    if (S.card) {
      const o = ordinal(s);
      if (o && /^\s*(\d|첫|두|세|네|마지막)/.test(s)) { const r = onCard(t, o.n, o.note, s); if (r) return r; }
      if (S.card.kind === "send" && rx(s, /짧|줄여|정중|편하|공손|캐주얼|[월화수목금]요일|\d+\s*시|넣어|추가/)) return { text: revise(t, s) };
      for (const [re, n] of CARD_WORDS) if (re.test(s.trim())) { const r = onCard(t, n, "", s); if (r) return r; }
      if (S.card.kind === "routine" && parseTime(s) && rx(s, /바꿔|으로|로$/)) return routineOn(t, 2, s);
    }
    if (rx(s, /다시\s*(해|써|만들|정리|줘)|한\s*번\s*더|다른\s*(버전|걸로)/) && S.last) {
      if (S.draft) { const order = ["normal", "casual", "formal", "short"]; const d = { ...S.draft, time: "", extra: "" }; d.variant = order[(order.indexOf(d.variant) + 1) % order.length]; return { text: draftCard(t, d, `다시 써 봤어요. (${VARIANT_KO[d.variant]})`) }; }
      if (S.lastFn) { const r = S.lastFn(); return { ...r, text: `다시 정리했어요.\n\n${plainAsk(r.text)}` }; }
    }
    if (rx(s, /짧게|줄여|간단히|한\s*줄로/) && S.last) {
      if (S.draft) return { text: revise(t, "짧게") };
      return { text: S.last.short || `핵심만 남겼어요.\n${plain(S.last.text).split(/(?<=요\.)\s/)[0]}` };
    }
    if (rx(s, /더\s*자세히|자세하게|풀어서/) && S.task && S.task.done) return { text: `조금 더 풀어 볼게요.\n\n- 서비스 A: 월 12,000원, 기능이 가장 많아요\n- 서비스 B: 월 8,900원, 가장 싸요\n- 서비스 C: 월 10,500원, 연간 결제 시 30% 할인\n\n세 곳 모두 가상의 이름이에요.` };
    if (rx(s, /보여\s*줘|초안\s*줘/) && S.notice) return { text: S.notice === "목록 공지" ? "목록 공지 초안이에요.\n\n- 데모 페이지를 추가했어요\n- 모바일 문구 줄바꿈을 고쳤어요" : "짧은 공지 초안이에요.\n\n이번 주에는 데모 페이지가 생기고\n모바일 문구가 더 읽기 쉬워졌어요." };
    if (rx(s, /^(보내|보내줘|보내\s*줘)$/) && !S.card) return { text: "지금 보낼 초안이 없어요.\n\"서윤님 메일 답장 써 줘\"처럼 먼저 초안을 만들어 볼까요?" };
    if (rx(s, /^(취소|그만|됐어|아니야)$/)) { S.card = null; S.awaitEdit = false; return { text: "알겠어요. 멈췄고 아무것도 보내지 않았어요." }; }
    if (S.list && S.list.kind === "mail") { const o = ordinal(s); if (o) return readMail(t, mail(pickFrom(S.list.items, o.n))); }
    const r = topic(t, s);
    if (r) { S.lastFn = () => topic(t, s); return r; }
    if (/^\s*[1-4]\s*(?:\)|번)?\s*$/.test(s)) return { text: `지금은 고를 항목이 없어요.\n${SUGGEST}` };
    return { text: `그건 데모에서 준비하지 못했어요.\n${SUGGEST}` };
  }
  const plainAsk = text => text.replace(/^\[[a-z]+\]\s*/i, "");

  function answer(body) {
    const t = typeof target === "string" ? target : "main";
    const picks = Array.isArray(body.picks) ? body.picks : [];
    const text = String(body.text || "").trim() || (picks.length ? `${picks[0].n}) ${picks[0].label}` : "메시지");
    ownerSays(t, text, picks);
    setWorking(true);
    let r;
    try { r = respond(t, text, picks); }
    catch (e) { console.warn(`demo script: ${e.message}`); r = { text: `잠깐 헷갈렸어요. 다시 말해 주세요.\n${SUGGEST}` }; }
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
    lanes: [{ name: "site-check", model: F.MODEL, thinking: "" }],
    targets: [],
    in_use: [{ key: "main", label: "dotz", model: F.MODEL }],
    fallbacks: {},
  };
  const lists = {
    "/api/workers": { items: [] },
    "/api/apps": { items: [] },
    "/api/approvals": { items: [] },
    "/api/devices": [
      { id: "cred-mac", name: "맥북 Safari", created: new Date(Date.now() - 40 * 864e5).toISOString(), last_used: new Date(Date.now() - 6e5).toISOString(), current: true },
      { id: "cred-phone", name: "아이폰", created: new Date(Date.now() - 12 * 864e5).toISOString(), last_used: new Date(Date.now() - 2 * 864e5).toISOString(), current: false },
    ],
    "/api/accounts": {
      mode: "auto", chosen: { name: "default", label: "개인 계정", source: "auto", blocked: null, text: "" },
      accounts: [{ name: "default", order: 1, alias: null, label: "개인 계정", current: true, blocked: null, blocked_until: null, blocked_tag: null, five_hour_left: 62, seven_day_left: 80 }],
      rules: {}, rules_text: [], script: { path: null, timeout_ms: 5000, every_minutes: 5, last: null },
      providers: [
        { id: "anthropic", name: "Claude 구독", auth: "oauth", multi: true, can_add: true, can_pin: true, can_delete: true, accounts: [
          { name: "default", order: 1, label: "개인 계정", current: true, pinned: true, blocked: null, blocked_until: null, blocked_tag: null, windows: [{ id: "5h", label: "5시간", left: 62, resets_at: null }, { id: "7d", label: "7일", left: 80, resets_at: null }] },
          { name: "work", order: 2, label: "회사 계정", current: false, pinned: false, blocked: null, blocked_until: null, blocked_tag: null, windows: [] }] },
        { id: "google", name: "Gemini", auth: "api_key", multi: false, can_add: false, can_pin: false, can_delete: false, accounts: [
          { name: "default", order: 1, label: "API 키", current: true, pinned: false, blocked: null, blocked_until: null, blocked_tag: null, windows: [] }] },
      ],
      login_providers: [{ id: "anthropic", name: "Claude 구독", configured: true }, { id: "cursor", name: "Cursor", configured: false }],
    },
    "/api/discord/connection": { enabled: true, connected: true, user: "dotz-bot", error: "", guild: "111111111111111111", owner_id: "222222222222222222", app_id: "999000111222333444", has_token: true, restart_needed: false },
    "/api/discord/post": { chat: true, lanes: true, alert: true, worklog: true, web_lanes: false, ask: true, result: false, news: true, conv: true },
    "/api/messengers/jandi": {
      enabled: true, help: [], fields: [{ key: "host", label: "받는 주소", type: "text", value: "0.0.0.0" }, { key: "incoming_url", label: "기본 수신 웹훅 URL", type: "secret", set: true }],
      allow: { label: "말을 걸 수 있는 사람", hint: "이메일이나 JANDI 이름", items: ["박지훈", "kim@example.com"] },
      rooms: { label: "방", editable: true, hint: "", fields: [], items: [{ id: "m1", name: "메인", kind: "main", values: {}, set: {}, last_in: Date.now() - 12e4, last_out: Date.now() - 3e4 }] },
      notify: { ask: true, alert: true, result: true, news: true, conv: true, log: true },
    },
    "/api/messengers/slack": {
      enabled: false, help: [], fields: [{ key: "token", label: "봇 토큰", type: "secret", set: false }],
      allow: { label: "말을 걸 수 있는 사람", hint: "Slack 사용자 ID", items: [] },
      rooms: { label: "채널", editable: true, hint: "연결하면 채널을 읽어요", fields: [], items: [] },
      notify: { ask: true, alert: true, result: true, news: true, conv: true, log: true },
    },
    "/api/messengers/telegram": {
      enabled: true, help: [], fields: [{ key: "token", label: "봇 토큰", type: "secret", set: true }],
      allow: { label: "말을 걸 수 있는 사람", hint: "Telegram 사용자 ID", items: ["123456789"] },
      rooms: { label: "대화", editable: true, hint: "", fields: [], items: [{ id: "c1", name: "나", kind: "main", values: {}, set: {} }] },
      notify: { ask: true, alert: true, result: true, news: true, conv: true, log: true },
    },
    "/api/runtimes": { runtimes: [] },
    "/api/messengers": { items: [
      { id: "discord", label: "Discord", enabled: true, state: "ok", configured: true },
      { id: "jandi", label: "JANDI", enabled: true, state: "ok", configured: true },
      { id: "slack", label: "Slack", enabled: false, state: "off", configured: false },
      { id: "telegram", label: "Telegram", enabled: true, state: "ok", configured: true },
    ] },
    // 답장 확인: 댓글 답글 초안 둘 (유튜브·인스타그램). 보내기는 아래 postApi에서 그냥 받아 줘요.
    "/api/replies": { items: [
      { kind: "comment", app: "youtube", code: "DM1", at: Date.now() - 6 * 6e4, to: "산책하는고양이", title: "책상 정리 브이로그", text: "다음 주 금요일에 올라가요.\n봐 주셔서 고마워요!", original: { who: "산책하는고양이", text: "영상 잘 봤어요! 다음 편은 언제 올라와요?" }, attachmentsNone: true, cannotAttach: [] },
      { kind: "comment", app: "instagram", code: "DM2", at: Date.now() - 52 * 6e4, to: "달빛고양이", title: "라이브 예고 게시물", text: "이번 주 금요일 저녁 8시에 해요.\n알림 설정해 두시면 바로 알려 드릴게요.", original: { who: "달빛고양이", text: "다음 라이브는 언제 해요?" }, attachmentsNone: true, cannotAttach: [] },
    ] },
    "/api/features": FEATURES_FX,
    "/api/harness": HARNESS_FX,
    "/api/api-budget": {},
    "/api/web-access": { mode: "tailscale", hostname: "", team: "", aud: "", token_set: false, tunnel: { state: "off" }, devices: 2, cloudflared_found: true },
    "/api/push/gateways": { items: [] },
    "/api/push": { subscribed: false },
    "/api/update": { running: { kind: "git", branch: "main", commit: { sha: "a".repeat(40), short: "aaaaaaa", date: new Date(0).toISOString() } }, disk: { kind: "git", branch: "main", commit: { sha: "a".repeat(40), short: "aaaaaaa", date: new Date(0).toISOString() } }, settings: { auto_check: true, auto_apply: false, at: "09:00" }, busy: [] },
    "/api/harness/update": {},
    "/api/context": { processes: [] },
    "/api/models": models,
    "/api/providers": { providers: [
      { id: "anthropic", name: "Claude 구독", auth: "oauth", account: "개인 계정", accounts: 2, in_use: true, can_add_account: true, can_logout: true },
      { id: "chatgpt-subscription", name: "ChatGPT 구독", auth: "oauth", account: "회사용 GPT", can_login: true, can_logout: true },
      { id: "google", name: "Gemini", auth: "api_key", masked: "AIza…x9Qd", can_login: true, can_logout: true },
      { id: "cursor", name: "Cursor", auth: "none", can_login: true },
    ] },
    "/api/quota": {},
    "/api/machine": {},
    "/api/peers": [
      { name: "맥북", url: "https://macbook.demo.ts.net", self: true, online: true },
      { name: "맥미니", url: "https://macmini.demo.ts.net", online: true, unread: 2, need: 1 },
      { name: "서버", url: "https://server.demo.ts.net", online: false },
    ],
  };

  function get(u) {
    const p = u.pathname;
    if (p === "/api/state") return json({ ...F.state, work_now: Date.now(), notices_unread: unread() });
    if (p === "/api/history") return json({ target: u.searchParams.get("target") || "main", events: F.histories[u.searchParams.get("target")] || [] });
    if (p === "/api/todo") return json(F.todo);
    if (p === "/api/queue") return json(F.queue);
    if (p === "/api/subagents") return json(F.subagents);
    if (p === "/api/conversations") return json({ items: F.conversations });
    if (p === "/api/integrations") return json({ items: F.integrations.map(i => ({ ...i, needs: { drafts: 0, unread: F.mails.filter(m => m.dir === "in" && !m.read).length, unreplied: 0, sentToday: 0 } })), available: [{ key: "youtube", label: "유튜브", icon: "image" }] });
    if (p === "/api/apps") return json({ items: F.apps, errors: [] });
    if (p === "/api/kakao/rooms") return json({ on: true, rooms: F.kakaoRooms });
    if (/^\/api\/kakao\/chat\/[^/]+$/.test(p)) { const c = F.kakaoChat[p.split("/")[4]]; return c ? json(c) : new Response(JSON.stringify({ error: "대화방을 찾지 못했어요" }), { status: 404, headers: { "Content-Type": "application/json" } }); }
    if (/^\/api\/integrations\/[^/]+\/settings$/.test(p)) return json({ fields: F.appFields });
    if (/^\/api\/integrations\/[^/]+\/features$/.test(p)) return json(F.appFeatures);
    if (p === "/api/monitors") return json({ items: F.monitors });
    if (p === "/api/notices") return json({ ...F.notices, unread: unread() });
    if (p === "/api/custom") return json({ dir: "", cards: [], projects: F.projects, routines: [], links: [] });
    if (p === "/api/custom/project") return json(F.projects.find(x => x.key === u.searchParams.get("key")) || {});
    if (p === "/api/activity") return json({ items: [], more: false, history: false });
    if (p === "/api/canvas") return json({ path: u.searchParams.get("path") || "", text: F.canvases[u.searchParams.get("path")] || "" });
    if (p === "/api/target") return json({ key: "orchestrator", target: u.searchParams.get("target") || "main", model: F.MODEL, thinking: "", models: [F.model], running: false, busy: false, context: {} });
    if (p === "/api/file") {
      const f = F.files[u.searchParams.get("path")];
      return f == null ? new Response("데모 파일이 없어요", { status: 404 }) : new Response(f, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (lists[p] !== undefined) return json(lists[p]);
    return json({});
  }

  function postApi(u, body) {
    const p = u.pathname;
    log.posts.push(p);
    if (/^\/api\/comments\/drafts\/[^/]+\/send$/.test(p)) return json({ ok: true });
    if (p === "/api/message") return json(answer(body));
    if (p === "/api/command") return json({ output: "데모에서는 명령을 실행하지 않아요." });
    if (p === "/api/read") { const c = conv(body.target); if (c) c.unread = 0; return json({}); }
    if (p === "/api/notices/read") { for (const n of F.notices.items) if (!body.ids || body.ids.includes(String(n.id))) n.read = true; return json({ unread: unread() }); }
    if (p === "/api/notices/reopen") return json({ unread: unread() });
    if (/^\/api\/mail\/[^/]+\/action$/.test(p)) { const m = mail(p.split("/")[3]); if (m && body.action === "read") m.read = true; if (m && body.action === "unread") m.read = false; return json({ ok: true, synced: true }); }
    if (p === "/api/mail/actions") return json({ ok: true, results: (body.keys || []).map(key => ({ key, ok: true, synced: true })) });
    if (p === "/api/mail/compose") return json({ ok: true, note: NOTE });
    if (/^\/api\/notices\/[^/]+\/answer$/.test(p)) return isOutward(body) ? fail(NOTE) : json({});
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
    if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") return postApi(url, body || {});
    return json({});
  };

  const sw = navigator.serviceWorker;
  if (sw) {
    const reg = { active: null, waiting: null, installing: null, pushManager: { getSubscription: async () => null, subscribe: async () => { throw new Error("demo"); } }, getNotifications: async () => [] };
    try { Object.defineProperty(sw, "register", { configurable: true, value: async () => reg }); } catch {}
    try { Object.defineProperty(sw, "ready", { configurable: true, get: () => Promise.resolve(reg) }); } catch {}
  }

  if (!location.hash) history.replaceState(null, "", `${location.pathname}#chat/main`);
})();
