/* 웹 온보딩 시제품 (docs/web-onboarding.md). #onboard 는 전체 화면 온보딩, #intro 와 #intro/spot 은 끝난 뒤 뜨는 화면 안내의 두 안이에요.
   값은 localStorage(dz-proto-ob)에 남아서 새로고침해도 이어져요. 설치, 로그인, 저장은 전부 흉내예요. */
(() => {
  const { $, $$, h, ic } = P;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEY = "dz-proto-ob";
  const STEPS = [["harness", "하네스"], ["tools", "도구"], ["bot", "봇"], ["discord", "Discord"], ["web", "웹 앱"], ["review", "확인"]];
  const CHAR = ["차분하고 믿음직한 개인 비서", "장난기 있지만 일은 확실한 친구 같은 조수", "꼼꼼한 엔지니어"];
  const CHAR_SUP = ["먼저 결과를 말하고 필요한 것만 물어요", "가볍게 말하되 사실은 정확하게 말해요", "근거와 검증을 먼저 챙기고 불확실하면 그렇다고 말해요"];
  const TONE = [["편한 해요체", "확인해 봤어요. 내일 회의가 11시로 바뀌어서 일정도 옮겨 뒀어요."], ["반말", "응, 끝났어. 메일도 보냈어."], ["존댓말, 간결하게", "네, 끝났어요. 메일도 보냈어요."], ["존댓말, 정중하게", "완료했습니다. 메일도 발송했습니다."]];
  const NOTE = [["일상", "자료 정리 끝났어요. 빠진 파일 없고 남은 일 없어요."], ["간결", "자료 정리를 마쳤어요. 빠진 파일은 없어요."], ["STE 80%", "자료 정리를 완료했습니다. 빠진 파일이 없습니다."]];
  const seed = () => ({ harness: "omo", omo: "none", login: "none", aside: "none", asideCli: "none", asideLogin: "none", ts: "ok", zele: "none", mail: "none", failed: false, name: "", char: 0, tone: 0, note: 0, address: "", guild: "", owner: "", botMode: 0, dc: true, machine: "노트북", logins: "me@example.com", done: {} });
  let S = Object.assign(seed(), JSON.parse(localStorage.getItem(KEY) || "{}"));
  const save = () => localStorage.setItem(KEY, JSON.stringify(S));
  const idx = (id) => STEPS.findIndex((s) => s[0] === id);

  const row = (lead, title, sup, end = "", attrs = "") => '<div class="li" ' + attrs + '><span class="lead">' + lead + '</span><span class="tx"><span class="hd">' + h(title) + "</span>" + (sup ? '<span class="sup">' + h(sup) + "</span>" : "") + '</span><span class="end">' + end + "</span></div>";
  const dot = (t) => '<span class="dot ' + t + '"></span>';
  const btn = (act, label, cls = "tonal inrow", data = "") => '<button class="btn ' + cls + '" data-act="' + act + '" ' + data + ">" + h(label) + "</button>";
  const pick = (act, i, on, title, sup, off) => '<button class="li ob-pick' + (on ? " on" : "") + '" role="radio" aria-checked="' + on + '" data-act="' + act + '" data-i="' + i + '"' + (off ? " disabled" : "") + '><span class="tx"><span class="hd">' + h(title) + "</span>" + (sup ? '<span class="sup">' + h(sup) + "</span>" : "") + '</span><span class="end">' + (on ? ic("check") : "") + "</span></button>";
  const field = (k, label, ph = "", hint = "", type = "text") => '<label class="lbl" for="ob-' + k + '">' + h(label) + '</label><input class="field" id="ob-' + k + '" data-k="' + k + '" type="' + type + '" placeholder="' + h(ph) + '" value="' + h(S[k] || "") + '">' + (hint ? '<div class="note">' + h(hint) + "</div>" : "");

  /* 한 단계의 틀: 1280 은 왼쪽 단계 목록, 412 는 위 막대 */
  const shell = (id, title, sup, body, foot) => {
    const at = idx(id);
    const rail = STEPS.map(([s, l], i) => {
      const st = S.done[s] ? "ok" : i === at ? "pri" : "";
      return '<a class="ni' + (i === at ? " on" : "") + '" href="#onboard/' + s + '"' + (i === at ? ' aria-current="step"' : "") + ">" + dot(st) + "<span>" + h(l) + "</span></a>";
    }).join("");
    const top = at < 0 ? "" : '<div class="ob-top"><span class="meta">' + (at + 1) + "/" + STEPS.length + " " + h(STEPS[at][1]) + '</span><div class="bar pri"><i style="--p:' + ((at + 1) / STEPS.length) * 100 + '%"></i></div></div>';
    return '<div class="ob"><aside class="ob-rail"><div class="brand"><span class="logo"></span><span>dotz</span></div><nav class="nav" aria-label="온보딩 단계">' + rail + '</nav></aside><div class="ob-main"><div class="ob-scroll">' + top + '<div class="ob-col"><h1>' + h(title) + "</h1>" + (sup ? '<p class="ob-sup">' + h(sup) + "</p>" : "") + '<div data-ob-body>' + body() + "</div></div></div>" + (foot ? '<footer class="ob-ft"><div class="ob-ft-in">' + foot + "</div></footer>" : "") + "</div></div>";
  };
  const refresh = () => { const b = $("[data-ob-body]"), id = P.S.route && P.S.route.obStep; if (b && BODY[id]) P.mSwap(b, () => { b.innerHTML = BODY[id](); }); save(); };
  const next = (id, label = "다음") => '<a class="btn" href="#onboard/' + id + '" data-act="ob-next">' + h(label) + "</a>";
  const prev = (id) => '<a class="btn text" href="#onboard' + (id ? "/" + id : "") + '">이전</a>';
  const sp = '<span class="sp"></span>';

  /* 단계 내용 */
  const stateTag = (v, wait = "준비할 게 있어요") => v === "ok" ? '<span class="tag ok">준비됨</span>' : v === "run" ? '<span class="tag pri">진행 중</span>' : v === "fail" ? '<span class="tag err">안 됐어요</span>' : v === "skip" ? '<span class="tag">나중에</span>' : '<span class="tag warn">' + wait + "</span>";
  const BODY = {
    start: () => '<div class="sec">이 컴퓨터에서 찾은 것</div><div class="list">' +
      row(dot("warn"), "OmO", S.omo === "ok" ? "설치됨" : "설치돼 있지 않아요", "") +
      row(dot("warn"), "Aside", "앱과 명령어가 없어요", "") +
      row(dot("ok"), "Tailscale", "me@example.com 으로 로그인돼 있어요", "") +
      row(dot("warn"), "메일과 일정 도구", "zele 가 없어요", "") + "</div>" +
      '<div class="sec">언어</div><div class="list"><div class="li"><span class="tx"><span class="hd">화면과 봇이 쓸 언어</span></span><span class="end"><div class="seg" data-v="0"><i></i><button class="on" data-act="ob-lang">한국어</button><button data-act="ob-lang">English</button></div></span></div></div>',
    harness: () => {
      const H = [["omo", "OmO", S.omo === "ok" ? "설치됨 · 기본" : "설치돼 있지 않아요 · 기본"], ["omp", "omp", "먼저 설치가 필요해요"], ["claude", "Claude Code", "먼저 설치가 필요해요"], ["codex", "Codex", "아직 dotz에서 쓸 수 없어요", true]];
      const list = '<div class="list" role="radiogroup" aria-label="하네스">' + H.map(([v, t, s, off]) => pick("ob-h", v, S.harness === v, t, s, off)).join("") + "</div>";
      const inst = S.omo === "ok" ? "" : '<div class="list ob-gap" data-log="omo">' + row(dot(S.omo === "run" ? "pri" : "warn"), "OmO 설치", S.omoLine || "bun add -g --trust omo-ai", S.omo === "run" ? stateTag("run") : btn("ob-omo", "설치")) + "</div>";
      const log = S.omo !== "ok" ? "" : '<div class="list ob-gap">' + row(dot(S.login === "ok" ? "ok" : "warn"), "Claude 구독 로그인", S.login === "ok" ? "계정 1개가 연결됐어요" : "봇이 이 계정으로 일해요", S.login === "ok" ? stateTag("ok") : btn("ob-login", "로그인")) + "</div>";
      return list + inst + log;
    },
    tools: () => {
      const r = (k, title, sup, act, label) => row(dot(S[k] === "ok" ? "ok" : S[k] === "run" ? "pri" : S[k] === "fail" ? "err" : S[k] === "skip" ? "" : "warn"), title, S[k + "Line"] || sup, S[k] === "ok" || S[k] === "run" || S[k] === "skip" ? stateTag(S[k]) : btn(act, S[k] === "fail" ? "다시 시도" : label, "tonal inrow", 'data-k="' + k + '"') + (S[k] === "none" ? btn("ob-skip", "나중에", "text inrow", 'data-k="' + k + '"') : ""), 'data-t="' + k + '"');
      return '<div class="sec">Aside 브라우저</div><div class="list">' + r("aside", "Aside 앱", "로그인 유지와 웹 작업에 써요", "ob-tool", "설치") + r("asideCli", "Aside 명령어", "봇이 브라우저를 다룰 때 써요", "ob-tool", "설치") + r("asideLogin", "Aside 로그인", "코드를 앱에서 승인하면 돼요", "ob-term", "로그인") + "</div>" +
        '<div class="sec">Tailscale</div><div class="list">' + row(dot("ok"), "Tailscale", "me@example.com · 휴대폰에서 웹 앱을 열 때 써요", stateTag("ok")) + "</div>" +
        '<div class="sec">메일과 일정</div><div class="list">' + r("zele", "zele", "메일과 캘린더를 읽는 도구예요", "ob-tool", "설치") + r("mail", "계정 연결", "Google, Outlook, 네이버 같은 IMAP", "ob-term", "연결") + "</div>";
    },
    bot: () => {
      const name = S.name || "봇";
      return field("name", "이름", "루미, 모모, 비서", "2~32자예요. Discord 봇 이름과 카테고리도 이 이름을 써요.") +
        '<div class="sec">성격</div><div class="list" role="radiogroup" aria-label="성격">' + CHAR.map((c, i) => pick("ob-c", i, S.char === i, c, CHAR_SUP[i])).join("") + pick("ob-c", 9, S.char === 9, "직접 쓰기", "") + "</div>" +
        '<div class="sec">말투</div><div class="list" role="radiogroup" aria-label="말투">' + TONE.map((c, i) => pick("ob-t", i, S.tone === i, c[0], c[1])).join("") + pick("ob-t", 9, S.tone === 9, "직접 쓰기", "") + "</div>" +
        '<div class="sec">작업 기록과 알림 문체</div><div class="list" role="radiogroup" aria-label="알림 문체">' + NOTE.map((c, i) => pick("ob-n", i, S.note === i, c[0], c[1])).join("") + pick("ob-n", 9, S.note === 9, "직접 쓰기", "") + "</div>" +
        '<div class="note">나중에 대화에서 바꿀 수 있어요.</div>' +
        field("address", "나를 부르는 말", "형, 대표님, 이름", "비워 두면 호칭 없이 말해요.") +
        '<div class="sec">프로필 이미지</div><div class="list">' + row(ic("image"), "이미지 고르기", "png, jpg · " + h(name) + "의 얼굴이 돼요", btn("ob-avatar", "파일 고르기")) + "</div>";
    },
    discord: () => {
      if (!S.dc) return '<div class="list">' + row(dot(""), "Discord 없이 써요", "웹과 터미널로 쓸 수 있어요. 나중에 설정에서 연결하면 돼요.", btn("ob-dc", "다시 켜기")) + "</div>";
      return field("guild", "서버 ID", "17~20자리 숫자", "Discord 설정 > 고급 > 개발자 모드를 켜고, 서버 이름을 우클릭해 ID 복사를 눌러요.") +
        field("owner", "내 Discord ID", "17~20자리 숫자", "이 계정의 말만 명령으로 들어요. 내 프로필을 우클릭해 복사해요.") +
        '<div class="sec">봇</div><div class="list"><div class="li"><span class="tx"><span class="hd">봇을 어떻게 만들까요</span><span class="sup">' + (S.botMode ? "개발자 포털에서 만든 토큰을 붙여넣어요" : "Aside로 만들어요. 2단계 인증만 승인해 주세요") + '</span></span><span class="end"><div class="seg" data-v="' + S.botMode + '"><i></i><button class="' + (S.botMode ? "" : "on") + '" data-act="ob-bot" data-i="0">자동</button><button class="' + (S.botMode ? "on" : "") + '" data-act="ob-bot" data-i="1">토큰</button></div></span></div></div>' +
        (S.botMode ? field("token", "봇 토큰", "", "화면에도 기록에도 남지 않아요. 비밀 저장소로 바로 들어가요.", "password") : "");
    },
    web: () => field("machine", "이 컴퓨터 이름", "", "웹 앱의 컴퓨터 목록에 이 이름으로 보여요.") +
      field("logins", "들어올 수 있는 Tailscale 로그인", "", "쉼표로 여러 개 적을 수 있어요. 비우면 이 컴퓨터에서만 열려요.") +
      '<details class="ob-more"><summary>다른 컴퓨터와 함께 보기</summary>' + field("peer", "공유 키", "", "다른 컴퓨터의 공유 키를 붙여넣어요. 처음이면 비워 두세요.", "password") + "</details>" +
      '<details class="ob-more"><summary>포트와 모델</summary><div class="ob-two">' + field("p1", "로컬 포트", "7420") + field("p2", "테일넷 포트", "8443") + "</div>" + field("m1", "봇 모델", "claude-opus-5-5:medium") + field("m2", "세션 모델", "claude-opus-5-5:medium") + "</details>",
    review: () => {
      const line = (s, t, v) => row("", t, v, '<a class="btn text inrow" href="#onboard/' + s + '">고치기</a>');
      if (S.applying) return '<div class="list" data-apply>' + APPLY.map((a, i) => row(dot(""), a[0], a[1], '<span class="tag">기다리는 중</span>', 'data-a="' + i + '"')).join("") + "</div>";
      return '<div class="list">' + line("harness", "하네스", "OmO" + (S.login === "ok" ? " · 로그인됨" : " · 나중에 로그인")) + line("tools", "도구", "Aside " + (S.aside === "ok" ? "준비됨" : "나중에") + " · Tailscale 준비됨 · zele " + (S.zele === "ok" ? "준비됨" : "나중에")) + line("bot", "봇", (S.name || "이름 없음") + " · " + TONE[S.tone === 9 ? 0 : S.tone][0] + " · " + NOTE[S.note === 9 ? 0 : S.note][0]) + line("discord", "Discord", S.dc ? (S.guild ? "서버 " + S.guild : "서버 없음") + " · 봇 " + (S.botMode ? "붙여넣은 토큰" : "자동으로 만들기") : "쓰지 않음") + line("web", "웹 앱", S.machine + " · " + (S.logins || "이 컴퓨터에서만")) + "</div>" + (S.name.length < 2 ? '<div class="note ob-err" role="alert">봇 이름이 필요해요. 봇 단계에서 적어 주세요.</div>' : "");
    },
  };
  const APPLY = [["설정 저장", "secrets, config, 이름과 말투"], ["테일넷에 열기", "tailscale serve · 테일넷 안에서만"], ["macOS 권한", "게이트웨이가 쓸 권한을 켜요", "전체 디스크 접근을 켜 주세요", "열린 설정 창에서 bun 스위치를 켜면 돼요. Touch ID를 물어볼 수 있어요."], ["Discord 봇", "앱 만들기, 토큰, 서버 초대", "Discord 2단계 인증을 승인해 주세요", "휴대폰 앱에서 승인하면 이어서 해요."], ["게이트웨이 다시 시작", "새 설정으로 켜요"]];

  const reg = (id, title, desc, sup, body, foot, step) => P.reg({ id: "onboard" + (id ? "/" + id : ""), title, group: "온보딩", desc, tab: "home", back: "", obStep: step || id || "start", render: () => shell(id, title, sup, body, foot()) });
  reg("", "dotz를 설정할게요", "시작: 이 컴퓨터를 훑고 언어를 고르는 화면", "준비된 것은 건너뛰고 필요한 것만 물어볼게요.", () => BODY.start(), () => sp + next("harness", "시작하기"));
  reg("harness", "봇이 돌아갈 하네스를 골라요", "하네스 고르기 · 설치 진행 · 로그인", "봇과 세션이 이 코딩 에이전트로 일해요.", () => BODY.harness(), () => prev("") + sp + '<a class="btn text" href="#onboard/tools" data-act="ob-later">로그인은 나중에</a>' + next("tools"));
  reg("tools", "봇이 쓸 도구를 준비해요", "Aside · Tailscale · zele · 실패하고 다시 시도", "없는 것만 설치해요. 지금 안 해도 나중에 설정에서 할 수 있어요.", () => BODY.tools(), () => prev("harness") + sp + next("bot"));
  reg("bot", "봇을 소개해 주세요", "이름 · 성격 · 말투 · 알림 문체 · 호칭 · 이미지", "Discord, 웹, 터미널 어디서나 이렇게 말해요.", () => BODY.bot(), () => prev("tools") + sp + next("discord"));
  reg("discord", "Discord를 연결해요", "서버 ID · 내 ID · 봇 토큰 또는 자동 생성", "밖에서 Discord로 말을 걸 수 있어요.", () => BODY.discord(), () => prev("bot") + sp + btn("ob-nodc", "Discord 없이 쓰기", "text") + next("web"));
  reg("web", "웹 앱을 정리해요", "컴퓨터 이름 · Tailscale 로그인 · 공유 키 · 포트와 모델", "", () => BODY.web(), () => prev("discord") + sp + next("review"));
  reg("review", "이대로 설정할까요", "정리해서 보여 주고 적용 · 진행 상황 · 주인이 할 일 하나", "", () => BODY.review(), () => prev("web") + sp + btn("ob-apply", "설정하기", ""));
  P.reg({ id: "onboard/done", title: "다 됐어요", group: "온보딩", desc: "끝 화면: 주소와 다음 행동", tab: "home", back: "", obStep: "done",
    render: () => shell("done", (S.name || "봇") + " 준비가 끝났어요", "", () => '<div class="list">' + row(ic("laptop"), "이 컴퓨터", "http://127.0.0.1:7420/", '<span class="tag ok">열림</span>') + row(ic("phone"), "휴대폰이나 다른 컴퓨터", "https://mac.example.ts.net:8443/ · 같은 Tailscale 계정으로 로그인해서 열어요", '<span class="tag ok">열림</span>') + (S.dc ? row(ic("chat"), "Discord", (S.name || "봇") + " 카테고리의 대화 채널에 말을 걸면 돼요", '<span class="tag ok">연결됨</span>') : "") + "</div>", sp + '<a class="btn" href="#intro">웹 앱 열기</a>') });
  const dead = (id, title, desc, text) => P.reg({ id: "onboard/" + id, title, group: "온보딩", desc, tab: "home", back: "", obStep: "x", render: () => '<div class="ob ob-dead"><div class="ob-col"><div class="brand"><span class="logo"></span><span>dotz</span></div><h1>' + h(title) + '</h1><p class="ob-sup">' + h(text) + "</p></div></div>" });
  dead("expired", "주소가 만료됐어요", "토큰이 틀렸거나 지났을 때", "터미널에서 bun setup.ts --web-link 를 실행하면 새 주소가 나와요.");
  dead("closed", "설정이 끝났어요", "온보딩이 끝난 뒤 주소를 다시 열었을 때", "이 주소는 닫혔어요. 웹 앱은 첫 화면에서 열면 돼요.");

  /* 동작 */
  const a = P.acts;
  document.addEventListener("input", (e) => { const k = e.target.dataset && e.target.dataset.k; if (k && e.target.closest(".ob")) { if (e.target.type !== "password") S[k] = e.target.value; save(); } });
  a["ob-next"] = () => { const id = P.S.route && P.S.route.obStep; if (id) { S.done[id] = true; save(); } };
  a["ob-later"] = () => { S.done.harness = true; save(); };
  a["ob-lang"] = () => P.toast("시제품은 한국어만 있어요. 실제 화면은 영어도 있어요");
  const sel = (key) => (el) => { S[key] = isNaN(+el.dataset.i) ? el.dataset.i : +el.dataset.i; refresh(); };
  a["ob-h"] = sel("harness"); a["ob-c"] = sel("char"); a["ob-t"] = sel("tone"); a["ob-n"] = sel("note"); a["ob-bot"] = sel("botMode");
  a["ob-avatar"] = () => P.toast("파일 고르기는 실제 화면에서 열려요");
  a["ob-dc"] = () => { S.dc = true; refresh(); };
  a["ob-nodc"] = () => { S.dc = false; S.done.discord = true; save(); location.hash = "#onboard/web"; };
  a["ob-skip"] = (el) => { S[el.dataset.k] = "skip"; refresh(); };
  const stream = async (k, lines, done) => { S[k] = "run"; for (const l of lines) { S[k + "Line"] = l; refresh(); await delay(650); } delete S[k + "Line"]; done(); refresh(); };
  a["ob-omo"] = () => stream("omo", ["bun add -g --trust omo-ai", "패키지 받는 중 · 42개", "omo 5.1.60 확인"], () => { S.omo = "ok"; });
  a["ob-tool"] = (el) => {
    const k = el.dataset.k;
    if (k === "aside" && !S.failed) { S.failed = true; return stream(k, ["brew install --cask aside"], () => { S[k] = "fail"; S[k + "Line"] = "Homebrew가 없어요. aside.com/download 에서 받은 뒤 다시 시도해 주세요."; }); }
    delete S[k + "Line"];
    stream(k, ["내려받는 중", "설치 확인"], () => { S[k] = "ok"; });
  };
  a["ob-login"] = () => P.sheet({ title: "Claude 구독 로그인", cls: "mid", body: '<p class="ob-sup">새 탭에서 로그인하고, 나온 코드를 붙여넣어 주세요.</p><label class="lbl">코드</label><input class="field" autocomplete="off">', foot: btn("sheet-close", "취소", "text") + btn("ob-login-ok", "확인", "") });
  a["ob-login-ok"] = async () => { await P.closeSheet(); S.login = "ok"; refresh(); };
  a["ob-term"] = (el) => { const k = el.dataset.k; S.termK = k; const cmd = k === "mail" ? "zele login" : "aside login"; const out = k === "mail" ? "? 어떤 계정을 연결할까요\n> Google\n  Outlook\n  IMAP/SMTP" : "기기 코드: WXYZ-1234\nAside 앱 설정 > 계정 > 기기에서 승인해 주세요\n기다리는 중..."; P.sheet({ title: k === "mail" ? "메일 계정 연결" : "Aside 로그인", cls: "mid", body: '<p class="ob-sup">정해진 명령 하나만 도는 창이에요. 끝나면 저절로 닫혀요.</p><pre class="ob-term"><b>$ ' + cmd + "</b>\n" + h(out) + "</pre>", foot: btn("sheet-close", "닫기", "text") + btn("ob-term-ok", "끝났어요", "") }); };
  a["ob-term-ok"] = async () => { await P.closeSheet(); S[S.termK] = "ok"; refresh(); };
  a["ob-apply"] = async (el) => {
    if (S.name.length < 2) { P.toast("봇 이름을 먼저 적어 주세요"); return; }
    S.applying = true; el.disabled = true; $$(".ob-ft .btn.text").forEach((b) => b.remove()); refresh(); await delay(260);
    for (let i = 0; i < APPLY.length; i++) {
      const [t, sup, ow, hint] = APPLY[i]; const r = $('[data-a="' + i + '"]');
      if (!r) return;
      if (i === 3 && !S.dc) { $(".end", r).innerHTML = '<span class="tag">건너뜀</span>'; continue; }
      P.mSwap(r, () => { $(".dot", r).className = "dot pri"; $(".end", r).innerHTML = '<span class="tag pri">진행 중</span>'; });
      await delay(800);
      if (ow) {
        P.mSwap(r, () => { $(".dot", r).className = "dot warn"; $(".hd", r).textContent = ow; $(".sup", r).textContent = hint; $(".end", r).innerHTML = btn("ob-owner", "했어요"); });
        await new Promise((res) => (S._go = res));
        P.mSwap(r, () => { $(".dot", r).className = "dot pri"; $(".hd", r).textContent = t; $(".sup", r).textContent = sup; $(".end", r).innerHTML = '<span class="tag pri">진행 중</span>'; });
        await delay(600);
      }
      P.mSwap(r, () => { $(".dot", r).className = "dot ok"; $(".end", r).innerHTML = '<span class="tag ok">끝났어요</span>'; });
    }
    await delay(500); S.applying = false; S.done.review = true; save(); location.hash = "#onboard/done";
  };
  a["ob-owner"] = () => S._go && S._go();
  a["ob-reset"] = () => { localStorage.removeItem(KEY); S = seed(); location.hash = "#onboard"; location.reload(); };

  /* 화면 안내. A안은 시트, B안은 진짜 메뉴를 가리켜요 */
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const M = mac ? "⌘" : "Ctrl+";
  const KEYS = [[M + "K", "검색과 명령"], [M + "/", "알림"], [M + ".", "메인 대화"], [M + "\\", "사이드바 접기"], [M + "1 ~ " + M + "6", "탭 이동"], ["Ctrl+\`", "다음 컴퓨터"], ["Enter", "보내기, 일하는 중이면 끼어들기"], [M + "Enter", "다음 턴으로 미루기"], [mac ? "⌥Enter" : "Alt+Enter", "멈추고 보내기"], ["Esc", "일 멈추기"]];
  const INTRO = [
    { tab: "home", ico: "home", t: "홈에서 오늘 볼 것을 봐요", b: "새 메일, 답을 기다리는 일, 돌고 있는 작업이 카드로 모여요. 위의 종을 누르면 알림만 따로 볼 수 있어요." },
    { tab: "chat", ico: "chat", t: "채팅으로 일을 시켜요", b: "말하듯 쓰면 돼요. 일하는 중에 보내면 바로 끼어들어요. 메일처럼 밖으로 나가는 것은 보내기 전에 꼭 물어봐요." },
    { tab: "projects", ico: "folder", t: "프로젝트마다 대화가 따로예요", b: "폴더 하나가 프로젝트 하나예요. 세션과 결과가 프로젝트별로 남아서 섞이지 않아요." },
    { tab: "monitoring", ico: "eye", t: "모니터링은 대신 지켜봐요", b: "메일, 댓글, 사이트 변화를 보고 있다가 알려 줘요. 답장 초안도 여기서 고치고 보내요." },
    { tab: "settings", ico: "sliders", t: "앱과 설정은 필요할 때 열어요", b: "내가 붙인 앱은 앱 탭에서 열어요. 계정, 메신저, 웹 접속은 설정에서 바꿔요. 이 안내도 설정에서 다시 볼 수 있어요." },
    { keys: true, ico: "bolt", t: "단축키를 쓰면 더 빨라요", b: "" },
  ];
  const keysHtml = '<div class="ob-keys">' + KEYS.map(([k, d]) => '<div class="ob-key"><kbd>' + h(k) + "</kbd><span>" + h(d) + "</span></div>").join("") + "</div>";
  const home = () => P.routes.home;
  const finish = async () => { await P.closeSheet(); $(".ob-spot")?.remove(); $(".ob-tip")?.remove(); location.hash = "#home"; };
  a["in-skip"] = finish;
  const counter = (i) => '<div class="meta ob-count">' + (i + 1) + "/" + INTRO.length + '</div><div class="bar pri"><i style="--p:' + ((i + 1) / INTRO.length) * 100 + '%"></i></div>';
  const foot = (i) => btn("in-skip", "건너뛰기", "text") + sp + (i ? btn("in-go", "이전", "tonal", 'data-i="' + (i - 1) + '"') : "") + btn(i === INTRO.length - 1 ? "in-skip" : "in-go", i === INTRO.length - 1 ? "시작하기" : "다음", "", 'data-i="' + (i + 1) + '"');
  const showA = (i) => {
    const s = INTRO[i];
    P.sheet({ title: s.t, cls: "mid ob-in", body: counter(i) + (s.b ? '<p class="ob-sup">' + h(s.b) + "</p>" : "") + (s.keys ? keysHtml : ""), foot: foot(i) });
    P.S.sheet.scrim.onclick = null; $(".sh-hd .ib", P.S.sheet.el).remove();
  };
  const target = (s) => { const ph = matchMedia("(max-width: 899px)").matches; return ph ? $('#tabbar a[data-tab="' + s.tab + '"]') : $('#side a[href="#' + s.tab + '"]'); };
  const showB = (i) => {
    const s = INTRO[i];
    $(".ob-spot")?.remove(); $(".ob-tip")?.remove();
    const layer = $("#layer"), tip = document.createElement("div"), t = s.keys ? null : target(s);
    tip.className = "ob-tip" + (t ? "" : " mid");
    tip.innerHTML = counter(i) + "<h2>" + h(s.t) + "</h2>" + (s.b ? '<p class="ob-sup">' + h(s.b) + "</p>" : "") + (s.keys ? keysHtml : "") + '<div class="ob-tip-ft">' + foot(i).replaceAll("in-go", "in-spot") + "</div>";
    if (t) {
      const r = t.getBoundingClientRect(), box = layer.getBoundingClientRect(), spot = document.createElement("div");
      spot.className = "ob-spot";
      spot.style.cssText = "left:" + (r.left - box.left - 4) + "px;top:" + (r.top - box.top - 4) + "px;width:" + (r.width + 8) + "px;height:" + (r.height + 8) + "px";
      layer.append(spot);
      if (innerWidth >= 900) { tip.style.left = r.right - box.left + 16 + "px"; tip.style.top = Math.max(16, r.top - box.top - 8) + "px"; }
    } else { const sc = document.createElement("div"); sc.className = "ob-spot none"; layer.append(sc); }
    layer.append(tip); P.mIn(tip, "rise", 220);
  };
  a["in-go"] = (el) => showA(+el.dataset.i);
  a["in-spot"] = (el) => showB(+el.dataset.i);
  const intro = (id, title, desc, show) => P.reg({ id, title: home().title, group: "온보딩", desc, tab: "home", back: "", view: home().view, render: () => home().render(), mount: (v) => { home().mount && home().mount(v); requestAnimationFrame(() => requestAnimationFrame(() => show(0))); } });
  intro("intro", "화면 안내 A", "화면 안내 A안: 가운데 시트", showA);
  intro("intro/spot", "화면 안내 B", "화면 안내 B안: 진짜 메뉴를 가리키기", showB);

  /* 전체 화면 표시와 시제품 전용 줄 */
  const sync = () => {
    const on = /^#onboard/.test(location.hash);
    document.documentElement.classList.toggle("ob-full", on);
    if (!/^#intro/.test(location.hash)) { $(".ob-spot")?.remove(); $(".ob-tip")?.remove(); }
    let bar = $("#ob-proto");
    if (on && !bar) { $("#ptb .sp").insertAdjacentHTML("afterend", '<span id="ob-proto" class="g"><button data-act="ob-reset">온보딩 처음부터</button></span>'); } else if (!on && bar) bar.remove();
  };
  addEventListener("hashchange", sync);
  sync();
})();
