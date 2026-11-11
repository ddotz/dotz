/* 메일함 시안: 메일 앱 하나 안에서 계정 > 메일함 순서로 나누고, 메일함마다 처리 방식과 말투를 따로 정해요.
   계정이 하나면 계정 표시는 나오지 않아요. 화면을 다시 그릴 때는 S.mbPaint를 불러요. 설정은 한 번에 한 항목만 펼쳐져요 */
(() => {
  const { $, $$, h, ic } = P;
  const S = P.S;
  const MODES = { auto: ["자동 초안", "메일이 오면 초안을 써 둬요. 보내기 전에 확인해요."], ask: ["확인 먼저", "답장할지 먼저 물어요. 쓰라고 하면 그때 초안을 써요."], notify: ["알림만", "새 메일을 알려 줘요. 초안은 쓰지 않아요."], quiet: ["조용히 모으기", "알리지 않고 여기 모아 둬요."] };
  const KINDS = [["from", "보낸 사람", "주소나 @도메인"], ["subj", "제목", "제목에 든 말"], ["body", "내용", "내용에 든 말"]];
  const FILTERS = [["all", "전체"], ["unread", "안 읽음"], ["need", "답장 필요"], ["draft", "확인 대기"], ["replied", "답장함"], ["arch", "보관함"], ["sent", "보낸 메일"]];
  const TAGS = { need: ["warn", "답장 필요"], draft: ["warn", "초안 있음"], replied: ["", "답장함"], sent: ["", "보낸 메일"], arch: ["", "보관함"], none: ["", "답장 안 함"] };
  const CHIP_CAP = 4, FIX_CAP = 2;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const seed = () => { if (!S.mb) { S.mb = structuredClone({ accounts: D.mailAccounts, boxes: D.mailboxes, mails: D.mailboxMails, suggest: D.mailboxSuggest }); S.mbSel = new Set(); S.mbMore = new Set(); S.mbF = "all"; S.mbA = "all"; S.mbScene = ""; } };
  const box = (id) => S.mb.boxes.find((b) => b.id === id);
  const mail = (id) => S.mb.mails.find((m) => m.id === id);
  const acct = (id) => S.mb.accounts.find((a) => a.id === id);
  const accts = () => (S.mbScene === "solo" ? S.mb.accounts.slice(0, 1) : S.mb.accounts);
  const multi = () => accts().length > 1;
  const boxesOf = (a) => S.mb.boxes.filter((b) => b.acct === a);
  const baseOf = (a) => boxesOf(a).find((b) => b.base);
  const acctOf = (m) => box(m.box).acct;
  const isGroup = (id) => id.startsWith("n:");
  /* all은 고른 계정의 전체, n:은 같은 이름의 메일함 묶음 */
  const inBox = (id) => S.mb.mails.filter((m) => (id === "all" ? S.mbA === "all" || acctOf(m) === S.mbA : isGroup(id) ? box(m.box).name === box(id.slice(2)).name : m.box === id));
  const live = (l) => l.filter((m) => m.st !== "arch" && m.st !== "sent");
  const unread = (id) => inBox(id).filter((m) => m.unread).length;
  const needs = (id) => inBox(id).filter((m) => m.st === "need" || m.st === "draft").length;
  const pass = (m, f) => (f === "all" ? m.st !== "arch" && m.st !== "sent" : f === "unread" ? m.unread : m.st === f);
  const paint = () => { if (S.mbPaint) $("#view").innerHTML = S.mbPaint(); };
  const go = (hash) => { location.hash = hash; };
  const home = () => (S.mbA !== "all" && S.mbScene !== "solo" ? "mailbox/a/" + S.mbA : "mailbox" + (S.mbScene ? "/" + S.mbScene : ""));
  const boxHref = (id) => (id === "all" ? "#" + home() : isGroup(id) ? "#mailbox/n/" + id.slice(2) : "#mailbox/b/" + id);
  const stateDot = (id) => (needs(id) ? '<span class="dot warn" title="답장 필요"></span>' : unread(id) ? '<span class="dot pri" title="안 읽음"></span>' : "");
  const pick = (o, path) => path.split(".").reduce((a, k) => a[k], o);
  const put = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
  const markOf = (id) => '<span class="mx-am t-' + id + '" title="' + h(acct(id).name) + ' 계정">' + h(acct(id).mark) + "</span>";
  const merged = () => multi() && S.mbA === "all";
  const markIf = (b) => (merged() ? markOf(b.acct) : "");
  /* 한 계정이면 그 계정 메일함만, 모든 계정이면 이름이 같은 메일함을 하나로 묶어요 */
  const entries = () => {
    if (S.mbA !== "all") return boxesOf(S.mbA).map((b) => ({ id: b.id, b }));
    const names = [...new Set(S.mb.boxes.map((b) => b.name))].map((n) => S.mb.boxes.filter((b) => b.name === n));
    return [...names.filter((l) => l.length === 1).map(([b]) => ({ id: b.id, b })), ...names.filter((l) => l.length > 1).map((l) => ({ id: "n:" + l[0].id, b: l[0], n: l.length }))];
  };
  const acctDot = (a) => { const l = S.mb.mails.filter((m) => acctOf(m) === a.id); return a.expired || l.some((m) => m.st === "need" || m.st === "draft") ? '<span class="dot warn" title="답장 필요"></span>' : l.some((m) => m.unread) ? '<span class="dot pri" title="안 읽음"></span>' : ""; };
  /* 숫자로 된 시각을 비교할 값으로: 오늘, 어제, 날짜 순 */
  const stamp = (t) => { const a = /(오전|오후) (\d+):(\d+)/.exec(t), d = /(\d+)월 (\d+)일/.exec(t); return a ? 1e6 + (a[1] === "오후" && a[2] !== "12" ? 720 : 0) + a[2] * 60 + Number(a[3]) : t === "어제" ? 1e5 : d ? d[1] * 100 + Number(d[2]) : 0; };
  const expRow = (a) => '<div class="mx-exp"><span class="dot warn"></span><span class="tx"><b>' + h(a.name) + ' 계정 로그인이 풀렸어요</b><span>받은 메일은 그대로 있어요. 다시 연결하면 새 메일도 들어와요.</span></span>' + reconnect(a) + "</div>";
  const reconnect = (a) => '<button class="btn tonal sm" data-act="mx-reconnect" data-a="' + a.id + '"' + (a.busy ? " disabled" : "") + ">" + (a.busy ? "연결하는 중" : "다시 연결") + "</button>";
  const expBanner = (cur) => accts().filter((a) => a.expired && (box(cur) ? box(cur).acct === a.id : S.mbA === "all" || S.mbA === a.id)).map(expRow).join("");

  /* 메일함 목록: 넓은 화면은 왼쪽 목록, 좁은 화면은 칩 */
  const paneRow = (id, name, sub, icon, cur, extra = "") => '<a class="mx-pr' + (cur === id ? " on" : "") + '" href="' + boxHref(id) + '"' + (cur === id ? ' aria-current="true"' : "") + '><span class="av">' + ic(icon) + '</span><span class="tx"><span class="hd">' + h(name) + extra + '</span><span class="sup">' + h(sub) + '</span></span><span class="mx-pn">' + stateDot(id) + "<span>" + live(inBox(id)).length + "</span></span></a>";
  const pane = (cur) => '<nav class="mx-pane" aria-label="메일함"><div class="list">' + paneRow("all", "전체", "안 읽음 " + unread("all"), "mail", cur) + '</div><div class="list">' + entries().map(({ id, b, n }) => paneRow(id, b.name, n ? "계정 " + n + "개" : MODES[b.mode][0], b.icon, cur, (b.base ? '<span class="tag mx-base">기본</span>' : "") + (n ? "" : markIf(b)))).join("") + '</div><a class="btn text sm mx-add" href="#mailbox/new">' + ic("plus") + "메일함 추가</a></nav>";
  const chipRow = (cur) => '<div class="mx-tabs" role="tablist" aria-label="메일함">' + [{ id: "all", name: "전체" }, ...entries().map((e) => ({ id: e.id, name: e.b.name, mark: e.n ? "" : markIf(e.b) }))].map(({ id, name, mark }) => '<a role="tab" aria-selected="' + (cur === id) + '" class="mx-tab' + (cur === id ? " on" : "") + '" href="' + boxHref(id) + '">' + h(name) + (mark || "") + stateDot(id) + "<span>" + live(inBox(id)).length + "</span></a>").join("") + '<a class="mx-tab" href="#mailbox/new" aria-label="메일함 추가">' + ic("plus") + "</a></div>";
  const head = () => '<div class="mx-hd"><span class="av">' + ic("mail") + '</span><span class="tx"><span class="hd">메일<span class="mx-pc">노트북</span></span><span class="sup">' + (multi() ? h(S.mbA === "all" ? "계정 " + accts().length + "개" : acct(S.mbA).addr) + " · " : "") + "안 읽음 " + unread("all") + " · 메일함 " + (S.mbA === "all" ? S.mb.boxes : boxesOf(S.mbA)).length + '개</span></span><a class="ib" href="#mail" aria-label="지금 메일 화면으로" title="지금 메일 화면으로">' + ic("list") + "</a></div>";

  /* 메일 줄: 실제 메일 앱의 한 줄(.mr)과 같은 순서 */
  const row = (m, cur) => {
    const [tone, label] = TAGS[m.st], on = S.mbSel.has(m.id), n = m.thread ? m.thread.length : 0;
    const boxTag = (cur === "all" || isGroup(cur) ? markIf(box(m.box)) : "") + (cur === "all" ? '<span class="mx-bt">' + h(box(m.box).name) + "</span>" : "");
    return '<div class="mxr' + (m.unread ? " new" : "") + (on ? " sel" : "") + '" role="link" tabindex="0" data-act="mx-open" data-id="' + m.id + '">' + (m.unread ? '<span class="dot pri mxr-dot"></span>' : "") +
      '<span class="mxr-lead"><button class="mx-chk" role="checkbox" aria-checked="' + on + '" aria-label="' + h(m.subj) + ' 선택" data-act="mx-sel" data-id="' + m.id + '">' + ic("check") + '</button><button class="mx-star" aria-label="별표 달기" data-act="mx-star">' + ic("star") + "</button></span>" +
      '<span class="mxr-src"><span>' + h(m.from) + "</span>" + (n > 1 ? "<i>" + n + "</i>" : "") + "</span>" +
      '<span class="mxr-sub">' + boxTag + '<span class="tag' + (tone ? " " + tone : " mxr-plain") + '">' + label + "</span></span>" +
      '<span class="mxr-t">' + h(m.subj) + '</span><span class="mxr-sum">' + h(m.sum) + "</span>" +
      '<span class="mxr-end">' + (m.att ? '<span class="mxr-att">' + ic("clip") + m.att + "</span>" : "") + '<span class="mxr-time">' + h(m.t) + '</span><button class="ib mxr-b" aria-label="메일함 옮기기" title="메일함 옮기기" data-act="mx-move" data-id="' + m.id + '">' + ic("folder") + '</button><button class="ib mxr-b mxr-more" aria-label="더 보기" title="더 보기" data-act="mx-more" data-id="' + m.id + '">' + ic("dots") + "</button></span></div>";
  };
  const bar = (rows, cur) => {
    const n = S.mbSel.size;
    if (n) return '<div class="mx-bar on"><button class="mx-chk" role="checkbox" aria-checked="true" aria-label="선택 풀기" data-act="mx-clear">' + ic("check") + '</button><span class="mx-n">' + n + '개 선택</span><button class="mbx-b" data-act="mx-move-sel">' + ic("folder") + '옮기기</button><button class="mbx-b" data-act="mx-arch-sel">' + ic("archive") + '보관</button><button class="ib mx-barx" aria-label="선택 해제" data-act="mx-clear">' + ic("x") + "</button></div>";
    return '<div class="mx-bar"><button class="mx-chk" role="checkbox" aria-checked="false" aria-label="모두 선택" data-act="mx-all" data-b="' + cur + '">' + ic("check") + '</button><span class="mx-n">메일 ' + rows.length + "개</span></div>";
  };
  const boxTitle = (cur) => {
    if (cur === "all") return '<div class="mx-bh"><h2>전체</h2><span class="meta">' + (merged() ? "모든 계정의 메일을 모아서 보여요" : multi() ? h(acct(S.mbA).addr) : "메일함을 나눠도 모든 메일이 여기 보여요") + "</span></div>";
    if (isGroup(cur)) { const f = box(cur.slice(2)); return '<div class="mx-bh"><h2>' + h(f.name) + '</h2><span class="meta">두 계정을 합쳐서 보여요</span><button class="btn tonal sm mx-setb" data-act="mx-grp-set" data-b="' + f.id + '">' + ic("sliders") + "<span>메일함 설정</span></button></div>"; }
    const b = box(cur);
    return '<div class="mx-bh"><h2>' + h(b.name) + "</h2>" + markIf(b) + '<span class="tag">' + MODES[b.mode][0] + '</span><a class="btn tonal sm mx-setb" href="#mailbox/set/' + cur + '">' + ic("sliders") + "<span>메일함 설정</span></a></div>";
  };
  const baseNote = (cur) => {
    if (isGroup(cur)) return box(cur.slice(2)).base ? '<div class="mx-note"><div>계정마다 어느 메일함에도 맞지 않는 메일이 여기로 와요. 빠지는 메일은 없어요.</div></div>' : "";
    const b = box(cur);
    if (!b || !b.base) return "";
    const s = S.mb.suggest.filter((x) => x.ids.some((id) => mail(id).box === cur));
    return '<div class="mx-note"><div>어느 메일함에도 맞지 않는 메일은 여기로 와요. 빠지는 메일은 없어요.</div>' + (s.length ? '<a class="btn tonal sm" href="#mailbox/new/' + b.acct + '">비슷한 메일 묶음 ' + s.length + "개 보기</a>" : "") + "</div>";
  };
  const list = (cur) => {
    const rows = inBox(cur).filter((m) => pass(m, S.mbF));
    if (multi() && (cur === "all" || isGroup(cur))) rows.sort((a, b) => stamp(b.t) - stamp(a.t));
    const tabs = '<div class="mx-st" role="tablist" aria-label="메일 보기">' + FILTERS.map(([k, l]) => { const n = k === "all" ? 0 : inBox(cur).filter((m) => pass(m, k)).length; return '<button class="mx-f' + (S.mbF === k ? " on" : "") + '" role="tab" aria-selected="' + (S.mbF === k) + '" data-act="mx-f" data-f="' + k + '">' + l + (n && k !== "replied" && k !== "arch" ? "<span>" + n + "</span>" : "") + "</button>"; }).join("") + "</div>";
    return boxTitle(cur) + expBanner(cur) + baseNote(cur) + tabs + bar(rows, cur) + '<div class="list mx-list">' + (rows.map((m) => row(m, cur)).join("") || '<div class="empty">이 보기에 메일이 없어요</div>') + "</div>";
  };
  const screen = (cur) => { if (cur !== "all" && !isGroup(cur) && !box(cur)) return '<div class="empty">지운 메일함이에요.<br><a class="btn tonal sm" href="#mailbox" style="margin-top:12px">전체로 가기</a></div>'; return head() + chipRow(cur) + '<div class="mx-wrap">' + pane(cur) + '<div class="mx-main">' + list(cur) + '</div></div><a class="mx-fab" href="#mail/compose" aria-label="메일 쓰기">' + ic("edit") + "<span>메일 쓰기</span></a>"; };

  /* 메일 화면의 계정 칩: 노트북 칩과 같은 모양으로 머리줄의 노트북 칩 옆에 놓여요 */
  const acctBar = () => {
    $("#appbar .mx-acc")?.remove();
    if (!multi()) return;
    const hidden = accts().filter((a) => a.expired || (S.mbA !== "all" && a.id !== S.mbA)), dot = hidden.some((a) => a.expired) ? '<span class="dot warn"></span>' : hidden.map(acctDot).sort().pop() || "";
    $("#appbar .gw").insertAdjacentHTML("beforebegin", '<button class="mx-acc" data-act="mx-acct" aria-haspopup="true" aria-label="메일 계정 바꾸기">' + (S.mbA === "all" ? "" : markOf(S.mbA)) + "<span>" + h(S.mbA === "all" ? "모든 계정" : acct(S.mbA).name) + "</span>" + dot + ic("chevd") + "</button>");
  };
  const acctPop = () => {
    const on = (id) => (S.mbA === id ? ic("check") : "");
    const li = (a) => '<button class="li" data-act="mx-acct-pick" data-a="' + a.id + '"><span class="lead">' + markOf(a.id) + '</span><span class="tx"><span class="hd">' + h(a.name) + '</span><span class="sup">' + (a.expired ? "로그인이 풀렸어요" : h(a.addr)) + '</span></span><span class="end mx-ae">' + (a.expired ? "" : acctDot(a)) + on(a.id) + "</span></button>";
    return '<div class="pt">메일 계정</div><button class="li" data-act="mx-acct-pick" data-a="all"><span class="lead">' + ic("mail") + '</span><span class="tx"><span class="hd">모든 계정</span><span class="sup">안 읽음 ' + S.mb.mails.filter((m) => m.unread).length + " · 답장 필요 " + S.mb.mails.filter((m) => m.st === "need" || m.st === "draft").length + '</span></span><span class="end mx-ae">' + on("all") + "</span></button>" +
      accts().map((a) => (a.expired ? '<div class="mx-acr">' + li(a) + reconnect(a) + "</div>" : li(a))).join("") + '<button class="li" data-act="mx-acct-add"><span class="lead">' + ic("plus") + '</span><span class="tx"><span class="hd">계정 추가</span></span></button>';
  };

  /* 옮기기: 어디로 보낼지 고르고, 앞으로도 그럴지는 작은 선택으로 물어요. 메일은 계정을 넘어가지 못해요 */
  const moveList = (ids) => {
    const from = mail(ids[0]).box, as = [...new Set(ids.map((i) => acctOf(mail(i))))];
    if (as.length > 1) return '<div class="mx-mvn">' + as.map((a) => h(acct(a).name)).join(", ") + " 메일이 섞여 있어요. 계정마다 따로 골라서 옮겨 주세요.</div>";
    return (multi() ? '<div class="mx-mvn">' + h(acct(as[0]).name) + " 계정 안에서만 옮길 수 있어요</div>" : "") + boxesOf(as[0]).filter((b) => b.id !== from || ids.some((i) => mail(i).box !== from)).map((b) => '<button class="li" data-act="mx-move-to" data-b="' + b.id + '"><span class="lead">' + ic(b.icon) + '</span><span class="tx"><span class="hd">' + h(b.name) + '</span></span><span class="end">' + MODES[b.mode][0] + "</span></button>").join("");
  };
  const openMove = (el, ids) => {
    S.mbMoving = ids;
    if (matchMedia("(max-width: 639px)").matches) return P.sheet({ title: "메일함 옮기기", body: '<div class="list mx-sheetl">' + moveList(ids) + "</div>" });
    setTimeout(() => P.pop(el, '<div class="pt">어느 메일함으로 옮길까요?</div>' + moveList(ids)));
  };
  const closeTeach = () => { const t = $(".mx-teach"); if (t) t.remove(); S.mbTeach = null; };
  const teachInner = () => {
    const t = S.mbTeach, to = box(t.to), m = mail(t.ids[0]), one = t.ids.length === 1, same = t.ids.every((i) => mail(i).addr === m.addr);
    const opts = [["only", one ? "이 메일만" : "이 메일들만"]];
    if (to.base) { if (same) opts.push(["ex", m.from + " 메일은 " + box(t.from).name + "에 넣지 않기"]); }
    else { if (same) opts.push(["from", m.from + " 메일은 앞으로 여기로"]); if (one) opts.push(["subj", "제목에 ‘" + m.kw + "’ 들어가면 앞으로 여기로"]); }
    const n = t.ids.reduce((a, i) => a + (mail(i).thread ? mail(i).thread.length : 1), 0);
    return '<div class="mx-tt"><b>' + h(to.name) + "에 넣었어요</b>" + (n > t.ids.length ? '<span class="meta">같은 대화 ' + n + "통이 함께 옮겨졌어요</span>" : "") + '<button class="ib" aria-label="닫기" data-act="mx-teach-x">' + ic("x") + '</button></div><div class="mx-tq">앞으로는 어떻게 할까요?</div><div class="mx-to" role="radiogroup">' + opts.map(([k, l]) => '<button role="radio" aria-checked="' + (t.pick === k) + '" class="' + (t.pick === k ? "on" : "") + '" data-act="mx-teach" data-k="' + k + '"><span class="mx-rd"></span>' + h(l) + "</button>").join("") + '</div><div class="mx-tf">' + (t.pick !== "only" ? '<a class="btn text sm" href="#mailbox/set/' + (t.pick === "ex" ? t.from : t.to) + '/match" data-act="mx-teach-x">기준 보기</a>' : "") + '<button class="btn text sm" data-act="mx-undo">되돌리기</button></div>';
  };
  const showTeach = () => { let el = $(".mx-teach"); if (!el) { el = document.createElement("div"); el.className = "mx-teach"; el.setAttribute("role", "status"); document.body.append(el); P.mIn(el, "rise", 220); } el.innerHTML = teachInner(); };
  const clearRule = (t) => { const c = box(t.done?.box)?.conds; if (c) c[t.done.k] = c[t.done.k].filter((v) => v !== t.done.v); t.done = null; };
  const doMove = async (ids, to) => {
    const was = ids.map((i) => [i, mail(i).box]), from = was[0][1];
    await Promise.all(ids.flatMap((i) => $$('[data-id="' + i + '"].mxr')).map((r) => P.mOut(r, "fade", 150)));
    ids.forEach((i) => { const m = mail(i); m.box = to; m.why = "직접 옮겼어요"; });
    S.mbSel.clear(); paint();
    S.mbTeach = { ids, to, from, was, pick: "only", done: null }; showTeach();
  };

  /* 칩 목록: 많으면 접어요 */
  const chipsEd = (ctx, path, add, ph) => {
    const l = pick(ctx, path), open = S.mbMore.has(path), shown = open ? l : l.slice(0, CHIP_CAP);
    return '<div class="chips mx-chips">' + shown.map((v, i) => '<span class="chip mx-c"><span class="mx-cn">' + h(v) + '</span><button class="mx-cx" aria-label="' + h(v) + ' 지우기" data-act="mx-chip-x" data-p="' + path + '" data-i="' + i + '">' + ic("x") + "</button></span>").join("") + (l.length > shown.length ? '<button class="chip mx-c2" data-act="mx-chip-more" data-p="' + path + '">더 보기 · ' + (l.length - shown.length) + "개</button>" : "") + (S.mbAdd === path ? '<input class="ff in mx-ci" data-mx-add="' + path + '" placeholder="' + h(ph) + '" aria-label="' + h(add) + '">' : '<button class="chip mx-c2" data-act="mx-chip-add" data-p="' + path + '">' + ic("plus") + h(add) + "</button>") + "</div>";
  };
  const condBody = (b) => KINDS.map(([k, l, ph]) => '<div class="mx-kv"><div class="mx-k">' + l + "</div>" + chipsEd(b, "conds." + k, "추가", ph) + "</div>").join("") + '<div class="mx-kv"><div class="mx-k">내용을 보고 판단</div><div class="mx-j"><div class="mx-jr"><span class="ff-h">메일을 읽고 이 설명에 맞는지 판단해요</span><button class="sw' + (b.judge.on ? " on" : "") + '" role="switch" aria-checked="' + b.judge.on + '" aria-label="내용을 보고 판단" data-act="mx-judge"><i></i></button></div>' + (b.judge.on ? '<input class="ff" data-mx-f="judge.text" value="' + h(b.judge.text) + '" placeholder="예: 강의 자료를 달라는 메일" aria-label="판단 설명">' : "") + "</div></div>";
  const condSum = (b) => { const p = KINDS.filter(([k]) => b.conds[k].length).map(([k, l]) => l + " " + b.conds[k].length); if (b.judge.on) p.push("내용을 보고 판단"); return p.join(" · ") || "기준 없음"; };
  const modeTiles = (cur) => '<div class="mx-modes" role="radiogroup" aria-label="처리 방식">' + Object.entries(MODES).map(([k, [l, d]]) => '<button role="radio" aria-checked="' + (cur === k) + '" class="mx-mode' + (cur === k ? " on" : "") + '" data-act="mx-mode" data-m="' + k + '"><span class="mx-mt"><span class="mx-rd"></span>' + l + "</span><span class=\"mx-md\">" + d + "</span></button>").join("") + "</div>";

  const toneBody = (b) => {
    const t = b.tone, busy = S.mbLearn === b.id, open = S.mbMore.has("fix"), fixes = open ? t.fixes : t.fixes.slice(0, FIX_CAP);
    return '<div class="msumx">' + h(t.sum) + '</div><div class="mx-rowb"><span class="meta">' + (busy ? '<span class="dot pri"></span> 지난 메일을 다시 읽고 있어요' : h(t.learned)) + '</span><span class="sp"></span><button class="btn tonal inrow" data-act="mx-ex"' + (t.samples.length ? "" : " disabled") + '>예시 보기</button><button class="btn tonal inrow" data-act="mx-learn"' + (busy ? " disabled" : "") + ">다시 배우기</button></div>" +
      (t.fixes.length ? '<div class="mx-k mx-kt">고친 점</div><ul class="mx-fx">' + fixes.map((f) => "<li>" + h(f) + "</li>").join("") + "</ul>" + (t.fixes.length > FIX_CAP && !open ? '<button class="mx-lk" data-act="mx-chip-more" data-p="fix">더 보기 · ' + (t.fixes.length - FIX_CAP) + "개</button>" : "") : '<div class="meta mx-kt">아직 고친 점이 없어요. 초안을 고치면 여기에 쌓여요.</div>');
  };
  const greetBody = (b) => '<div class="mx-gl">' + b.greets.map((g, i) => '<div class="mx-g"><div class="tx"><input class="mx-in" data-mx-g="' + i + '" data-k="who" value="' + h(g.who) + '" placeholder="이름" aria-label="이름"><input class="mx-in s" data-mx-g="' + i + '" data-k="addr" value="' + h(g.addr) + '" placeholder="주소나 @도메인" aria-label="주소"></div><input class="ff mx-gh" data-mx-g="' + i + '" data-k="hello" value="' + h(g.hello) + '" placeholder="첫 인사" aria-label="첫 인사"><button class="ib" aria-label="지우기" data-act="mx-g-x" data-i="' + i + '">' + ic("x") + "</button></div>").join("") + '</div><button class="mx-lk" data-act="mx-g-add">' + ic("plus") + "받는 사람 추가</button>";
  /* 접힌 줄에는 지금 값만 보여요 */
  const ROWS = {
    name: { l: "이름", sum: (b) => b.name, body: (b) => '<input class="ff" data-mx-f="name" value="' + h(b.name) + '" aria-label="메일함 이름">' },
    match: { l: "분류 기준", sum: condSum, body: (b) => condBody(b) + '<div class="ff-h mx-fn">여러 메일함에 맞으면 목록에서 위에 있는 메일함으로 가요. 지금 기준으로 메일 ' + inBox(b.id).length + "통이 여기 있어요.</div>" },
    tone: { l: "말투", sum: (b) => b.tone.fixes.length ? "고친 점 " + b.tone.fixes.length + "개" : b.tone.learned, body: toneBody },
    how: { l: "기본 지시", sum: (b) => b.how || "없음", body: (b) => '<textarea class="ff" rows="3" data-mx-f="how" placeholder="이 메일함의 초안을 쓸 때마다 지킬 말" aria-label="기본 지시">' + h(b.how) + '</textarea><div class="ff-h">이 메일함의 모든 초안에 붙어요.</div>' },
    greet: { l: "받는 사람별 인사", sum: (b) => (b.greets.length ? b.greets.length + "명" : "없음"), body: greetBody },
    files: { l: "첨부 폴더", sum: (b) => (b.folders.length ? b.folders[0] + (b.folders.length > 1 ? " 외 " + (b.folders.length - 1) + "곳" : "") : "없음"), body: (b) => chipsEd(b, "folders", "폴더 추가", "~/폴더") + '<div class="ff-h">초안이 약속한 파일을 이 폴더에서 찾아 붙여요.</div>' },
    ban: { l: "금지 문구", sum: (b) => (b.bans.length ? b.bans.length + "개" : "없음"), body: (b) => chipsEd(b, "bans", "문구 추가", "쓰지 않을 말") + '<div class="ff-h">초안에 이 말이 나오면 다시 써요.</div>' },
  };
  const acRow = (b, k) => {
    const r = ROWS[k], open = S.mbOpen === k;
    return '<div class="mx-ac' + (open ? " open" : "") + '"><button class="mx-ah" aria-expanded="' + open + '" data-act="mx-ac" data-k="' + k + '"><span class="mx-al">' + r.l + '</span><span class="mx-av">' + (open ? "" : h(r.sum(b))) + "</span>" + ic("chevd") + "</button>" + (open ? '<div class="mx-ab">' + r.body(b) + "</div>" : "") + "</div>";
  };
  const notifyRow = (b) => {
    const fixed = b.mode === "quiet" ? "조용히 모으는 메일함은 알리지 않아요" : b.mode === "notify" ? "알림만 받는 메일함이라 켜져 있어요" : "";
    const on = b.mode === "notify" || (b.mode !== "quiet" && b.notify);
    return '<div class="li nr"><span class="tx"><span class="hd">알림 켜기</span><span class="sup">' + (fixed || "새 메일이 오면 알려 줘요") + '</span></span><button class="sw' + (on ? " on" : "") + '" role="switch" aria-checked="' + on + '" aria-label="알림 켜기" data-act="mx-notify"' + (fixed ? " disabled" : "") + "><i></i></button></div>";
  };
  const drafts = (b) => b.mode === "auto" || b.mode === "ask";
  const acctRow = (b) => { const a = acct(b.acct); return '<div class="li nr"><span class="tx"><span class="hd mx-hf">계정</span><span class="sup mx-sw">' + (a.expired ? h(a.addr) + " · 로그인이 풀렸어요" : "답장은 메일을 받은 주소 " + h(a.addr) + "에서 나가요") + "</span></span>" + (a.expired ? reconnect(a) : '<span class="mx-av2">' + markOf(a.id) + h(a.name) + "</span>") + "</div>"; };
  const setScreen = (b) => {
    const replyRows = ["tone", "how", "greet", "files", "ban"];
    const reply = drafts(b) || S.mbShowReply === b.id
      ? '<div class="sec">답장 쓸 때</div><div class="list">' + replyRows.map((k) => acRow(b, k)).join("") + "</div>"
      : '<div class="sec">답장 쓸 때</div><div class="list"><button class="li" data-act="mx-reply-show"><span class="tx"><span class="hd">말투와 기본 지시</span><span class="sup">' + MODES[b.mode][0] + " 메일함은 초안을 쓰지 않아서 접어 뒀어요</span></span>" + ic("chevd") + "</button></div>";
    const match = b.base
      ? '<div class="li nr"><span class="tx"><span class="hd">분류 기준</span><span class="sup">기준이 없어요. ' + (multi() ? h(acct(b.acct).name) + " 계정의 " : "") + '다른 메일함에 맞지 않는 메일이 모두 여기로 와요.</span></span><span class="tag">기본</span></div>'
      : acRow(b, "match");
    return '<div class="mx-set"><div class="mx-hd"><span class="av">' + ic(b.icon) + '</span><span class="tx"><span class="hd">' + h(b.name) + (b.base ? '<span class="tag mx-base">기본</span>' : "") + '</span><span class="sup">메일 ' + inBox(b.id).length + "통 · 안 읽음 " + unread(b.id) + '</span></span><a class="btn tonal sm" href="#mailbox/b/' + b.id + '">메일 보기</a></div>' +
      '<div class="sec">처리 방식</div>' + modeTiles(b.mode) + '<div class="sec">이 메일함</div><div class="list">' + (multi() ? acctRow(b) : "") + acRow(b, "name") + match + "</div>" + reply +
      '<div class="sec">알림</div><div class="list">' + notifyRow(b) + "</div>" + (b.base ? "" : '<div class="mx-del"><button class="btn danger sm" data-act="mx-del">메일함 지우기</button></div>') + "</div>";
  };

  /* 메일함 추가 */
  const blank = (a) => ({ acct: a, name: "", mode: "ask", notify: true, icon: "folder", ids: [], conds: { from: [], subj: [], body: [] }, judge: { on: false, text: "" }, tone: { sum: "메일 앱 말투를 그대로 써요.", learned: "메일이 쌓이면 이 메일함 말투를 배워요", fixes: [], samples: [] }, how: "", greets: [], folders: [], bans: [], bring: true });
  const fromSuggest = (s, a) => Object.assign(blank(a), { name: s.name, mode: s.mode, notify: s.mode !== "quiet", ids: s.ids, conds: structuredClone(s.conds), judge: { on: !!s.judge, text: s.judge || "" } });
  const copyOf = (f, a) => Object.assign(blank(a), structuredClone({ name: f.name, mode: f.mode, notify: f.notify, icon: f.icon, conds: f.conds, judge: f.judge, tone: { ...f.tone, learned: acct(f.acct).name + " 계정 " + f.name + "에서 가져왔어요" }, how: f.how, greets: f.greets, folders: f.folders, bans: f.bans }), { copied: f.name });
  const newAcct = (a, change) => (multi() ? '<div class="sec">계정</div><div class="list"><div class="li nr"><span class="av">' + markOf(a) + '</span><span class="tx"><span class="hd mx-hf">' + h(acct(a).name) + '</span><span class="sup">' + h(acct(a).addr) + "</span></span>" + (change ? '<a class="btn text sm" href="#mailbox/new">바꾸기</a>' : "") + "</div></div>" : "");
  const newPick = () => '<div class="mx-set"><div class="sec">어느 계정에 만들까요?</div><div class="list">' + accts().map((a) => { const inner = '<span class="av">' + markOf(a.id) + '</span><span class="tx"><span class="hd mx-hf">' + h(a.name) + '</span><span class="sup">' + h(a.addr) + (a.expired ? " · 로그인이 풀렸어요" : " · 메일함 " + boxesOf(a.id).length + "개") + "</span></span>"; return a.expired ? '<div class="li nr">' + inner + reconnect(a) + "</div>" : '<a class="li" href="#mailbox/new/' + a.id + '">' + inner + ic("chev", "chev") + "</a>"; }).join("") + "</div></div>";
  const newCopy = (a) => '<div class="mx-set">' + newAcct(a, false) + '<div class="sec">어느 메일함 설정을 가져올까요?</div><div class="list">' + S.mb.boxes.filter((b) => b.acct !== a && !b.base).map((b) => '<button class="li" data-act="mx-new-dup" data-b="' + b.id + '"><span class="av">' + ic(b.icon) + '</span><span class="tx"><span class="hd">' + h(b.name) + markOf(b.acct) + '</span><span class="sup">' + MODES[b.mode][0] + " · " + h(condSum(b)) + "</span></span>" + ic("chev", "chev") + "</button>").join("") + '</div><div class="ff-h mx-fn">처리 방식, 분류 기준, 말투, 기본 지시를 그대로 가져와요. 원래 메일함은 바뀌지 않아요.</div></div>';
  const newStart = (a) => {
    const s = S.mb.suggest.filter((x) => x.ids.some((id) => mail(id).box === baseOf(a).id));
    return '<div class="mx-set">' + newAcct(a, S.mbA === "all") + '<div class="sec">메일을 보니 이런 묶음이 있어요</div>' + (s.length ? '<div class="list">' + s.map((x) => '<button class="li" data-act="mx-new-from" data-s="' + x.id + '"><span class="av">' + ic("folder") + '</span><span class="tx"><span class="hd">' + h(x.name) + '</span><span class="sup">' + h(x.line) + " · 메일 " + x.ids.length + "통 · " + MODES[x.mode][0] + "</span></span>" + ic("chev", "chev") + "</button>").join("") + "</div>" : '<div class="list"><div class="empty">지금은 눈에 띄는 묶음이 없어요</div></div>') + '<div class="sec">직접 만들기</div><div class="list"><button class="li" data-act="mx-new-empty"><span class="av">' + ic("plus") + '</span><span class="tx"><span class="hd">빈 메일함으로 시작</span><span class="sup">이름과 기준을 직접 정해요</span></span>' + ic("chev", "chev") + "</button>" + (multi() ? '<a class="li" href="#mailbox/new/' + a + '/copy"><span class="av">' + ic("file") + '</span><span class="tx"><span class="hd">다른 계정에서 설정 복사</span><span class="sup">같은 말투와 기준을 다시 적지 않아도 돼요</span></span>' + ic("chev", "chev") + "</a>" : "") + "</div></div>";
  };
  const newSetup = () => {
    const d = S.mbD;
    const ms = d.ids.map(mail);
    const prev = ms.length ? '<div class="sec">지금 있는 메일</div><div class="list"><div class="li nr"><span class="tx"><span class="hd">메일 ' + ms.length + '통도 옮기기</span><span class="sup">' + h(ms.map((m) => m.from).join(" · ")) + '</span></span><button class="sw' + (d.bring ? " on" : "") + '" role="switch" aria-checked="' + d.bring + '" aria-label="지금 있는 메일도 옮기기" data-act="mx-bring"><i></i></button></div></div>' : "";
    return '<div class="mx-set">' + newAcct(d.acct, false) + '<div class="sec">이름</div><div class="list mx-pad"><input class="ff" data-mx-f="name" data-mx-new value="' + h(d.name) + '" placeholder="예: 강의 자료" aria-label="메일함 이름"></div><div class="sec">처리 방식</div>' + modeTiles(d.mode) + '<div class="sec">분류 기준</div><div class="list mx-pad">' + condBody(d) + "</div>" + prev + '<div class="ff-h mx-fn">' + (d.copied ? h(d.copied) + " 설정을 가져왔어요. 말투와 기본 지시도 함께 왔으니 분류 기준이 이 계정에 맞는지만 봐 주세요." : "말투와 기본 지시는 만든 뒤 설정에서 정해요.") + " 맞지 않는 메일은 계속 " + h(baseOf(d.acct).name) + '으로 가요.</div><div class="mx-foot"><a class="btn text" href="#mailbox/new/' + d.acct + '">취소</a><button class="btn" data-act="mx-create" data-mx-go' + (d.name.trim() ? "" : " disabled") + ">메일함 만들기</button></div></div>";
  };

  /* 대화 한 개는 메일함 하나에 있어요 */
  const openScreen = (m) => {
    const b = box(m.box), msgs = m.thread || [{ from: m.from, t: m.t, text: m.text }], last = msgs.length - 1;
    const old = msgs.slice(0, last).map((x, i) => S.mbOld === m.id + i
      ? '<div class="mx-msg"><div class="rc-hdx"><b>' + h(x.from) + "</b><span>" + h(x.t) + '</span></div><div class="mx-body">' + h(x.text).replace(/\n/g, "<br>") + "</div></div>"
      : '<button class="mx-old" data-act="mx-old" data-k="' + (m.id + i) + '"><b>' + h(x.from) + "</b><span>" + h(x.text.split("\n")[0]) + "</span><i>" + h(x.t) + "</i></button>").join("");
    const lm = msgs[last], also = lm.also && box(lm.also) && lm.also !== m.box ? '<div class="mx-also">' + ic("mail") + "<span>이 메일은 " + h(box(lm.also).name) + " 기준에도 맞아요. 같은 대화라 " + h(b.name) + "에 남았어요.</span></div>" : "";
    const draft = m.st === "draft" && b.mode === "auto" ? P.draftCard(regDraft(m)) : "";
    const btn = (act, icon, label, extra = "") => '<button class="ib" aria-label="' + label + '" title="' + label + '" data-act="' + act + '" data-id="' + m.id + '"' + extra + ">" + ic(icon) + "</button>";
    return '<div class="mx-open"><div class="mx-top">' + btn("mx-move", "folder", "메일함 옮기기") + btn("mx-arch", "archive", "보관") + btn("toast", "star", "별표", ' data-msg="별표를 달았어요"') + btn("mx-more", "dots", "더 보기") + '</div><h2 class="mx-subj">' + h(m.subj) + '</h2><div class="mx-who"><b>' + h(m.from) + "</b><span>" + h(m.addr) + '</span><i>' + h(lm.t) + '</i></div><div class="mx-where">' + (multi() ? markOf(b.acct) : "") + '<a class="tag" href="#mailbox/b/' + b.id + '">' + ic(b.icon) + h(b.name) + '</a><span class="meta">' + h(m.why) + "</span></div>" +
      (msgs.length > 1 ? '<div class="ff-h mx-ct">이 대화 ' + msgs.length + "통은 모두 " + h(b.name) + "에 있어요. 새 답장이 와도 같은 메일함에 남고, 옮기면 함께 옮겨져요.</div>" : "") +
      '<div class="mx-thread">' + old + '<div class="msumx">' + ic("bolt") + "<span>" + h(m.sum) + '</span></div><div class="mx-body">' + h(lm.text).replace(/\n/g, "<br>") + "</div>" + also + "</div></div>" + draft;
  };
  const regDraft = (m) => { const id = "d-" + m.id; if (!S.mbDr) S.mbDr = new Set(); if (!S.mbDr.has(id)) { S.mbDr.add(id); const s = box(m.box).tone.samples[0]; P.registerDraft({ id, to: m.from, subj: "Re: " + m.subj, text: s ? s.a : "안녕하세요.\n메일 잘 받았어요.", kind: "메일" }, { fromName: m.from, origText: m.sum, when: m.t }); } return id; };

  Object.assign(P.acts, {
    "mx-acct": (el) => { setTimeout(() => P.pop(el, acctPop())); },
    "mx-acct-pick": (el) => { const a = el.dataset.a; P.closePop(); go("#" + (a === "all" ? "mailbox" + (S.mbScene ? "/" + S.mbScene : "") : "mailbox/a/" + a)); },
    "mx-acct-add": () => { P.closePop(); P.sheet({ title: "계정 추가", cls: "mid", body: '<div class="mx-del-t">메일 로그인 화면을 열어요. 로그인하면 이 계정의 일반 메일함이 생기고 메일이 바로 들어와요.</div>', foot: '<button class="btn text" data-act="sheet-close">취소</button><button class="btn" data-act="mx-acct-go">로그인 화면 열기</button>' }); },
    "mx-acct-go": async () => { await P.closeSheet(true); P.toast("시안이라 로그인 화면은 열리지 않아요"); },
    "mx-reconnect": async (el) => { const a = acct(el.dataset.a); a.busy = true; P.closePop(); paint(); await delay(900); a.busy = a.expired = false; S.mbScene = ""; if (S.route.id === "mailbox/expired") go("#mailbox"); else paint(); P.toast(a.name + " 계정을 다시 연결했어요"); },
    "mx-grp-set": (el) => { const l = S.mb.boxes.filter((b) => b.name === box(el.dataset.b).name); setTimeout(() => P.pop(el, '<div class="pt">어느 계정의 메일함인가요?</div>' + l.map((b) => '<a class="li" href="#mailbox/set/' + b.id + '" data-act="pop-close"><span class="lead">' + markOf(b.acct) + '</span><span class="tx"><span class="hd">' + h(acct(b.acct).name) + '</span><span class="sup">' + h(acct(b.acct).addr) + "</span></span></a>").join(""))); },
    "mx-f": (el) => { S.mbF = el.dataset.f; paint(); },
    "mx-open": (el) => go("#mailbox/m/" + el.dataset.id),
    "mx-sel": (el) => { const id = el.dataset.id; S.mbSel[S.mbSel.has(id) ? "delete" : "add"](id); paint(); },
    "mx-all": (el) => { inBox(el.dataset.b).filter((m) => pass(m, S.mbF)).forEach((m) => S.mbSel.add(m.id)); paint(); },
    "mx-clear": () => { S.mbSel.clear(); paint(); },
    "mx-star": (el) => el.classList.toggle("on"),
    "mx-move": (el) => openMove(el, [el.dataset.id]),
    "mx-move-sel": (el) => openMove(el, [...S.mbSel]),
    "mx-move-to": async (el) => { const ids = S.mbMoving, to = el.dataset.b; P.closePop(); await P.closeSheet(true); await doMove(ids, to); },
    "mx-teach-x": () => closeTeach(),
    "mx-teach": (el) => {
      const t = S.mbTeach, k = el.dataset.k, m = mail(t.ids[0]);
      clearRule(t); t.pick = k;
      if (k === "from") { box(t.to).conds.from.push(m.addr); t.done = { box: t.to, k: "from", v: m.addr }; }
      if (k === "subj") { box(t.to).conds.subj.push(m.kw); t.done = { box: t.to, k: "subj", v: m.kw }; }
      if (k === "ex") { const v = "제외: " + m.addr; box(t.from).conds.from.push(v); t.done = { box: t.from, k: "from", v }; }
      showTeach();
    },
    "mx-undo": () => { const t = S.mbTeach; clearRule(t); t.was.forEach(([i, b]) => { mail(i).box = b; }); closeTeach(); paint(); P.toast("되돌렸어요"); },
    "mx-more": (el) => { const id = el.dataset.id; setTimeout(() => P.pop(el, '<button class="li" data-act="mx-read" data-id="' + id + '">' + ic("eye") + '<span class="tx"><span class="hd">읽음으로 표시</span></span></button><button class="li" data-act="mx-arch" data-id="' + id + '">' + ic("archive") + '<span class="tx"><span class="hd">보관</span></span></button>')); },
    "mx-read": (el) => { mail(el.dataset.id).unread = false; P.closePop(); paint(); },
    "mx-arch": (el) => { const m = mail(el.dataset.id), was = m.st; m.st = "arch"; m.unread = false; P.closePop(); if (S.route.id.startsWith("mailbox/m/")) go(boxHref(m.box)); else paint(); P.toast("보관했어요", { undo: () => { m.st = was; paint(); } }); },
    "mx-arch-sel": () => { const n = S.mbSel.size; S.mbSel.forEach((i) => { mail(i).st = "arch"; }); S.mbSel.clear(); paint(); P.toast("메일 " + n + "통을 보관했어요"); },
    "mx-old": (el) => { S.mbOld = el.dataset.k; paint(); },
    "mx-ac": (el) => { const k = el.dataset.k; S.mbOpen = S.mbOpen === k ? null : k; S.mbAdd = null; paint(); const b = $(".mx-ac.open .mx-ab"); if (b) P.mIn(b, "top", 150); },
    "mx-mode": (el) => { const c = S.mbCtx, m = el.dataset.m; c.mode = m; c.notify = m !== "quiet"; S.mbShowReply = null; if (["tone", "how", "greet", "files", "ban"].includes(S.mbOpen) && !drafts(c)) S.mbOpen = null; paint(); },
    "mx-reply-show": () => { S.mbShowReply = S.mbCtx.id; paint(); },
    "mx-notify": (el) => { const on = !S.mbCtx.notify; S.mbCtx.notify = on; el.classList.toggle("on", on); el.setAttribute("aria-checked", String(on)); },
    "mx-judge": () => { S.mbCtx.judge.on = !S.mbCtx.judge.on; paint(); },
    "mx-bring": () => { S.mbD.bring = !S.mbD.bring; paint(); },
    "mx-chip-x": (el) => { const l = pick(S.mbCtx, el.dataset.p); l.splice(Number(el.dataset.i), 1); paint(); },
    "mx-chip-more": (el) => { S.mbMore.add(el.dataset.p); paint(); },
    "mx-chip-add": (el) => { S.mbAdd = el.dataset.p; paint(); const i = $("[data-mx-add]"); if (i) i.focus(); },
    "mx-g-x": (el) => { S.mbCtx.greets.splice(Number(el.dataset.i), 1); paint(); },
    "mx-g-add": () => { S.mbCtx.greets.push({ who: "", addr: "", hello: "" }); paint(); const l = $$('[data-k="who"]').pop(); if (l) l.focus(); },
    "mx-ex": () => { const t = S.mbCtx.tone; P.sheet({ title: "예시 보기", cls: "mid", body: '<div class="mx-exl">' + t.samples.map((s) => '<div><div class="mx-k">받은 메일</div><div class="mx-body">' + h(s.q) + '</div><div class="mx-k mx-kt">이 말투로 쓴 답장</div><div class="msumx">' + h(s.a).replace(/\n/g, "<br>") + "</div></div>").join("") + "</div>" }); },
    "mx-learn": async () => { const b = S.mbCtx; S.mbLearn = b.id; paint(); await delay(900); S.mbLearn = null; b.tone.learned = "방금 다시 배웠어요"; paint(); P.toast(b.name + " 말투를 다시 배웠어요"); },
    "mx-del": () => { const b = S.mbCtx; P.sheet({ title: b.name + " 지우기", cls: "mid", body: '<div class="mx-del-t">메일 ' + inBox(b.id).length + "통은 일반으로 옮겨요. 메일은 지워지지 않아요.</div>", foot: '<button class="btn text" data-act="sheet-close">취소</button><button class="btn" data-act="mx-del-go">지우기</button>' }); },
    "mx-del-go": async () => { const b = S.mbCtx, base = baseOf(b.acct); inBox(b.id).forEach((m) => { m.box = base.id; m.why = "메일함을 지워서 일반으로 왔어요"; }); S.mb.boxes.splice(S.mb.boxes.indexOf(b), 1); await P.closeSheet(true); go("#mailbox/b/" + base.id); P.toast(b.name + " 메일함을 지웠어요"); },
    "mx-new-from": (el) => { S.mbD = fromSuggest(S.mb.suggest.find((x) => x.id === el.dataset.s), S.mbNew); go("#mailbox/new/setup"); },
    "mx-new-empty": () => { S.mbD = blank(S.mbNew); go("#mailbox/new/setup"); },
    "mx-new-dup": (el) => { S.mbD = copyOf(box(el.dataset.b), S.mbNew); go("#mailbox/new/setup"); },
    "mx-create": () => {
      const d = S.mbD, id = "box" + Date.now();
      const b = Object.assign(d, { id, name: d.name.trim(), notify: d.mode !== "quiet", copied: undefined });
      S.mb.boxes.splice(S.mb.boxes.indexOf(baseOf(d.acct)), 0, b);
      if (d.bring) d.ids.forEach((i) => { const m = mail(i); m.box = id; m.why = "새 메일함 기준에 맞아서 옮겼어요"; });
      regBox(b); regGroup(b); S.mbD = null; go("#mailbox/b/" + id); P.toast(b.name + " 메일함을 만들었어요");
    },
  });
  document.addEventListener("input", (e) => {
    const el = e.target, c = S.mbCtx; if (!c) return;
    if (el.dataset.mxF) { put(c, el.dataset.mxF, el.value); if ("mxNew" in el.dataset) $("[data-mx-go]").disabled = !el.value.trim(); }
    if (el.dataset.mxG) c.greets[Number(el.dataset.mxG)][el.dataset.k] = el.value;
  });
  document.addEventListener("keydown", (e) => {
    const el = e.target;
    if (el.matches?.(".mxr") && e.key === "Enter") go("#mailbox/m/" + el.dataset.id);
    if (!el.matches?.("[data-mx-add]")) return;
    if (e.key === "Escape") { S.mbAdd = null; paint(); }
    if (e.key === "Enter") { const v = el.value.trim(); if (v) pick(S.mbCtx, el.dataset.mxAdd).push(v); S.mbMore.add(el.dataset.mxAdd); paint(); const i = $("[data-mx-add]"); if (i) i.focus(); }
  });
  addEventListener("hashchange", () => { S.mbSel?.clear(); S.mbAdd = null; closeTeach(); });

  const BASE = { tab: "monitoring", group: "메일함 시안", view: "wide" };
  const onScreen = (paintFn) => { seed(); S.mbPaint = paintFn; return paintFn(); };
  const onList = (cur) => { S.mbF = "all"; return onScreen(() => { acctBar(); return screen(cur); }); };
  const backHome = () => (S.mb ? home() : "mailbox");
  const scene = (name, a) => { seed(); S.mbScene = name; S.mbA = a; S.mb.accounts[1].expired = name === "expired"; return onList("all"); };
  /* 같은 이름의 메일함 묶음: 앞선 메일함 id로 찾아요. 복사로 새로 생기면 그때 더해요 */
  const regGroup = (b) => { const f = S.mb ? S.mb.boxes.find((x) => x.name === b.name) : b; P.routes["mailbox/n/" + f.id] = { ...BASE, id: "mailbox/n/" + f.id, title: "메일", back: backHome, desc: "시안: 두 계정의 " + f.name + "을 합친 보기", render: () => { S.mbA = "all"; return onList("n:" + f.id); } }; };
  const regBox = (b) => {
    P.reg({ ...BASE, id: "mailbox/b/" + b.id, title: "메일", back: backHome, desc: b.name + " 메일함 · " + D.mailAccounts.find((a) => a.id === b.acct)?.name + " · " + (b.base ? "맞는 기준이 없는 메일이 오는 곳" : MODES[b.mode][0]), render: () => { seed(); if (S.mbA !== "all") S.mbA = b.acct; return onList(b.id); } });
    regSet(b, "");
  };
  const regSet = (b, open) => P.reg({ ...BASE, view: "", id: "mailbox/set/" + b.id + (open ? "/" + open : ""), title: "메일함 설정", back: "mailbox/b/" + b.id, desc: b.name + (open ? " · " + ROWS[open].l + " 펼침" : " 설정"), render: () => {
    seed(); const cur = box(b.id); if (!cur) return '<div class="empty">지운 메일함이에요.</div>';
    S.mbCtx = cur; S.mbOpen = open || null; S.mbShowReply = null; S.mbMore = new Set();
    return onScreen(() => setScreen(cur)); } });

  P.reg({ ...BASE, id: "mailbox", title: "메일", back: "monitoring", desc: "시안: 모든 계정 · 메일함으로 나눈 메일 앱 · 옮기면 앞으로의 기준을 물어요", render: () => scene("", "all") });
  D.mailAccounts.forEach((a) => P.reg({ ...BASE, id: "mailbox/a/" + a.id, title: "메일", back: "mailbox", desc: "시안: " + a.name + " 계정만 · " + a.addr, render: () => { seed(); S.mbA = a.id; return onList("all"); } }));
  P.reg({ ...BASE, id: "mailbox/solo", title: "메일", back: "monitoring", desc: "시안: 계정이 하나면 계정 칩이 없어요", render: () => scene("solo", "p") });
  P.reg({ ...BASE, id: "mailbox/expired", title: "메일", back: "monitoring", desc: "시안: 회사 계정 로그인이 풀린 상태 · 다시 연결", render: () => scene("expired", "all") });
  regGroup(D.mailboxes.find((b) => b.name === "일반"));
  D.mailboxes.forEach(regBox);
  regSet(D.mailboxes[0], "match");
  regSet(D.mailboxes[0], "tone");
  P.reg({ ...BASE, view: "", id: "mailbox/new", title: "메일함 추가", back: backHome, desc: "시안: 계정을 먼저 고르고, 앱이 찾은 묶음에서 시작하거나 빈 메일함으로", render: () => { seed(); if (S.mbA === "all") return onScreen(newPick); S.mbNew = S.mbA; return onScreen(() => newStart(S.mbA)); } });
  D.mailAccounts.forEach((a) => {
    P.routes["mailbox/new/" + a.id] = { ...BASE, view: "", id: "mailbox/new/" + a.id, title: "메일함 추가", back: () => (S.mbA === "all" ? "mailbox/new" : backHome()), desc: "시안: " + a.name + " 계정에 추가", render: () => { S.mbNew = a.id; return onScreen(() => newStart(a.id)); } };
    P.reg({ ...BASE, view: "", id: "mailbox/new/" + a.id + "/copy", title: "다른 계정에서 설정 복사", back: "mailbox/new/" + a.id, desc: "시안: " + a.name + " 계정으로 다른 계정 메일함의 설정을 가져와요", render: () => { S.mbNew = a.id; return onScreen(() => newCopy(a.id)); } });
  });
  P.reg({ ...BASE, view: "", id: "mailbox/new/setup", title: "메일함 추가", back: () => "mailbox/new/" + (S.mbD ? S.mbD.acct : "p"), desc: "시안: 이름, 처리 방식, 분류 기준", render: () => { seed(); if (!S.mbD) S.mbD = blank(S.mbNew || "p"); S.mbCtx = S.mbD; S.mbMore = new Set(); return onScreen(newSetup); } });
  /* 메일 화면은 목록에는 대표 두 개만 올려요 */
  D.mailboxMails.forEach((m) => {
    const r = { ...BASE, view: "", id: "mailbox/m/" + m.id, title: "메일", back: () => "mailbox/b/" + (S.mb ? mail(m.id).box : m.box), desc: m.thread ? "시안: 대화 " + m.thread.length + "통이 한 메일함에 · " + m.from : m.from, render: () => { seed(); mail(m.id).unread = false; return onScreen(() => openScreen(mail(m.id))); } };
    if (m.thread) P.reg(r); else P.routes[r.id] = r;
  });
})();
