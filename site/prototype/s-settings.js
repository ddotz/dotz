(() => {
  const { $, $$, h, ic } = P;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const link = (href, ico, title, sup, end = "") => `<a class="li" href="#${href}"><span class="lead">${ic(ico)}</span><span class="tx"><span class="hd">${h(title)}</span>${sup ? `<span class="sup">${h(sup)}</span>` : ""}</span><span class="end">${end}${ic("chev", "chev")}</span></a>`;
  const row = (title, sup, end) => `<div class="li"><span class="tx"><span class="hd">${h(title)}</span>${sup ? `<span class="sup">${h(sup)}</span>` : ""}</span><span class="end">${end}</span></div>`;
  const sw = (on, label) => `<button class="sw" role="switch" aria-checked="${on}" data-act="sw" aria-label="${h(label)}"><i></i></button>`;
  const seg = (a, b, v = 0) => `<div class="seg" data-v="${v}"><i></i><button class="${v === 0 ? "on" : ""}" data-act="seg">${h(a)}</button><button class="${v === 1 ? "on" : ""}" data-act="seg">${h(b)}</button></div>`;
  const S = (id, title, group, desc, render, mount) => P.reg({ id, title, tab: "settings", back: id === "settings" ? "" : id.split("/").length > 2 ? id.split("/").slice(0, 2).join("/") : "settings", group, desc, render, mount });
  const sec = (t, ac = "") => `<div class="sec">${h(t)}${ac ? `<span class="ac">${ac}</span>` : ""}</div>`;

  S("settings", "설정", "설정", "설정 목록", () => `${sec("모델")}<div class="list">${link("settings/providers", "bolt", "공급자와 계정", "구독 1개 · API 키 1개")}${link("settings/models", "list", "모델 순서", "dotz AI · 한도에 걸리면 다음 모델로")}${link("settings/accounts", "users", "계정", "개인 계정 사용 중")}${link("settings/usage", "clock", "사용량과 월 한도", "5시간 한도 62%")}</div>
    ${sec("연결")}<div class="list">${link("settings/messengers", "chat", "메신저", "Discord 연결됨 · Slack · JANDI · Telegram")}${link("settings/webaccess", "globe", "웹 접속", "Tailscale")}${link("settings/devices", "phone", "연결된 기기", "기기 2대")}${link("peers", "laptop", "컴퓨터", "노트북 · 데스크톱")}</div>
    ${sec("앱")}<div class="list">${link("settings/notifications", "bell", "앱과 알림", "푸시 알림 켬")}${link("apps", "grid", "앱 관리", "내 앱 2개")}${link("intro", "bolt", "화면 안내 다시 보기", "화면 설명과 단축키")}${link("settings/display", "sliders", "표시", "테마 · 문체")}</div>
    ${sec("시스템")}<div class="list">${link("settings/update", "download", "업데이트", "새 버전 0.15.0", '<span class="tag pri">새 버전</span>')}${link("settings/runtime", "terminal", "실행 하네스", "OmO")}${link("settings/harness", "shield", "구성", "기능 지도")}</div>` );

  const providers = [["Anthropic 구독", "dotz AI · 구독 로그인", "ok", "연결됨", [["5시간 한도", 62], ["7일 한도", 38]]], ["API 키", "dotz AI · API 키", "ok", "연결됨", [["월 한도", 41]]], ["다른 공급자", "로그인이 필요해요", "warn", "로그인", []]];
  S("settings/providers", "공급자와 계정", "설정", "공급자 목록 · 한도 · 공급자 추가 시트", () => `${sec("공급자", `<button class="btn tonal sm" data-act="prov-add">${ic("plus")}추가</button>`)}<div class="list" data-prov>${providers.map(provRow).join("")}</div><div class="note">모델 이름은 모두 "dotz AI"로 보여요. 어느 경로로 쓰는지는 공급자 줄에서 구분해요.</div>`);
  function provRow(p) { return `<div class="li"><span class="lead"><span class="dot ${p[2]}"></span></span><span class="tx"><span class="hd">${h(p[0])}</span><span class="sup">${h(p[1])}</span>${p[4].map((u) => `<span style="display:flex;align-items:center;gap:8px;margin-top:4px;font-size:12px;color:var(--fg-2)"><span style="width:64px">${u[0]}</span><span class="bar ${u[1] > 60 ? "warn" : ""}" style="flex:1;max-width:160px"><i style="--p:${u[1]}%"></i></span>${u[1]}%</span>`).join("")}</span><span class="end"><span class="tag ${p[2] === "ok" ? "ok" : "warn"}">${p[3]}</span></span></div>`; }
  P.acts["prov-add"] = () => P.sheet({ title: "공급자 추가", cls: "mid", body: `<label class="lbl" style="margin-top:0">공급자</label><select class="sel field" style="width:100%"><option>Anthropic</option><option>OpenAI</option><option>Google</option></select><label class="lbl">API 키</label><input class="field mono" placeholder="sk-…" data-key><div class="note" style="margin-left:0">키는 이 컴퓨터에만 저장돼요.</div>`, foot: `<button class="btn text" data-act="sheet-close">취소</button><button class="btn" data-act="prov-do">저장</button>` });
  P.acts["prov-do"] = async () => { await P.closeSheet(); const b = $("[data-prov]"); if (!b) return; b.insertAdjacentHTML("beforeend", provRow(["새 공급자", "방금 추가했어요", "ok", "연결됨", []])); P.mIn(b.lastElementChild, "rise"); P.toast("공급자를 저장했어요"); };

  const chain = ["dotz AI · 구독", "dotz AI · API 키", "dotz AI mini"];
  S("settings/models", "모델 순서", "설정", "한도에 걸리면 다음 모델로 넘어가는 순서", () => `${["오케스트레이터", "세션", "작업 일꾼"].map((t, g) => `${sec(t)}<div class="list" data-chain>${chain.map((c, i) => `<div class="li"><span class="lead">${i + 1}</span><span class="tx"><span class="hd">${h(c)}</span></span><span class="end"><button class="ib" data-act="chain-up" aria-label="위로">${ic("chevd", "")}</button><button class="ib" data-act="toast" data-msg="목록에서 뺐어요" aria-label="빼기">${ic("x")}</button></span></div>`).join("")}</div>`).join("")}<div class="note">위에 있는 모델부터 써요. 한도에 걸리면 다음 줄로 넘어가요.</div>`);
  P.acts["chain-up"] = (el) => { const r = el.closest(".li"), n = r.nextElementSibling; if (n) { n.after(r); P.mIn(r, "rise", 150); $$(".lead", r.parentElement).forEach((l, i) => (l.textContent = i + 1)); } };

  S("settings/accounts", "계정", "설정", "계정 별칭 · 지금 쓰는 계정 · 바꾸는 규칙", () => `${sec("계정")}<div class="list"><div class="li"><span class="lead"><span class="dot ok"></span></span><span class="tx"><span class="hd">개인</span><span class="sup">지금 쓰는 계정</span></span><span class="end"><span class="tag ok">사용 중</span></span></div><div class="li"><span class="lead"><span class="dot warn"></span></span><span class="tx"><span class="hd">회사</span><span class="sup">한도 걸림 · 01:00까지</span></span><span class="end"><span class="tag warn">쉬는 중</span></span></div></div>
    ${sec("바꾸는 규칙")}<div class="list">${row("한도에 걸리면 다른 계정으로", "5시간 한도가 차면 자동으로 넘어가요", sw(true, "자동 전환"))}${row("바꿀 때 알려 주기", "", sw(true, "알려 주기"))}${row("전환 방식", "", seg("자동", "내가 고름"))}</div>`);

  const MS = { discord: ["Discord", "ok", "연결됨"], jandi: ["JANDI", "", "연결 안 됨"], slack: ["Slack", "", "연결 안 됨"], telegram: ["Telegram", "warn", "토큰 확인 필요"] };
  S("settings/messengers", "메신저", "설정", "Discord · JANDI · Slack · Telegram", () => `<div class="list">${Object.entries(MS).map(([id, m]) => link("settings/" + id, "chat", m[0], m[2], `<span class="dot ${m[1]}"></span>`)).join("")}</div><div class="note">메신저로도 같은 대화를 받을 수 있어요. 웹 앱은 항상 모두 받아요.</div>`);
  const steps = ["봇 만들기", "서버에 초대하기", "내 계정 확인하기", "테스트 메시지 보내기"];
  Object.entries(MS).forEach(([id, m]) => S("settings/" + id, m[0], "설정", `${m[0]} 연결 · 자동 설정 · 테스트`, () => `<div class="list">${row("연결", m[2], `<span class="tag ${m[1] === "ok" ? "ok" : m[1] === "warn" ? "warn" : ""}">${m[2]}</span>`)}${row("토큰", "비밀값은 이 컴퓨터에만 저장돼요", `<input class="fi mono" type="password" value="${m[1] === "ok" ? "••••••••" : ""}" placeholder="붙여넣기" aria-label="토큰">`)}${row("테스트", "", `<button class="btn tonal inrow" data-act="ms-test">보내 보기</button>`)}</div>
    ${sec("자동 설정", `<button class="btn tonal sm" data-act="ms-auto">시작</button>`)}<div class="list" data-steps>${steps.map((s, i) => `<div class="li" data-st="${i}"><span class="lead"><span class="dot"></span></span><span class="tx"><span class="hd">${s}</span></span><span class="end"></span></div>`).join("")}</div>
    ${id === "discord" ? `${sec("Discord로도 보낼 것")}<div class="list">${row("답장 확인", "", sw(true, "답장 확인"))}${row("가격 변경", "", sw(true, "가격 변경"))}${row("작업 기록", "", sw(false, "작업 기록"))}</div>` : ""}`));
  Object.keys(MS).forEach((id) => (P.routes["settings/" + id].back = "settings/messengers"));
  P.acts["ms-test"] = (el) => { P.mSwap(el, () => { el.textContent = "보냈어요"; }); setTimeout(() => P.mSwap(el, () => { el.textContent = "보내 보기"; }), 1800); };
  P.acts["ms-auto"] = async (el) => {
    el.disabled = true;
    for (const r of $$("[data-st]")) {
      P.mSwap(r, () => { $(".dot", r).className = "dot work"; $(".end", r).innerHTML = '<span class="tag pri">진행 중</span>'; });
      await delay(700);
      const wait = r.dataset.st === "2";
      if (wait) { P.mSwap(r, () => { $(".dot", r).className = "dot warn"; $(".end", r).innerHTML = '<button class="btn tonal inrow" data-act="ms-owner">했어요</button>'; }); await new Promise((res) => (P.S.ownerGo = res)); }
      P.mSwap(r, () => { $(".dot", r).className = "dot ok"; $(".end", r).innerHTML = '<span class="tag ok">완료</span>'; });
    }
    el.disabled = false; P.toast("연결됐어요");
  };
  P.acts["ms-owner"] = () => { if (P.S.ownerGo) P.S.ownerGo(); };

  S("settings/notifications", "앱과 알림", "설정", "푸시 · 앱 설치 · 알림 종류", () => `${sec("이 기기")}<div class="list">${row("홈 화면에 추가", "앱처럼 열 수 있어요", '<button class="btn tonal inrow" data-act="toast" data-msg="공유 메뉴에서 홈 화면에 추가를 눌러 주세요">방법 보기</button>')}${row("푸시 알림", "이 기기로 알림을 받아요", sw(true, "푸시 알림"))}</div>
    ${sec("알림 종류")}<div class="list">${row("답장 확인", "보내기를 기다리는 초안", sw(true, "답장 확인"))}${row("가격 변경", "감시하는 값이 바뀔 때", sw(true, "가격 변경"))}${row("작업 완료", "맡긴 작업이 끝났을 때", sw(true, "작업 완료"))}${row("경고", "로그인이나 연결 문제", sw(true, "경고"))}${row("조용한 시간", "밤에는 알림을 모아서 받아요", seg("끔", "켬"))}</div>`);

  S("settings/display", "표시", "설정", "두 값 중 하나 고르는 설정 (테마 · 문체 · 시간)", () => `<div class="list">${row("테마", "밝게 또는 어둡게", `<div class="seg" data-v="${document.documentElement.dataset.theme === "dark" ? 1 : 0}"><i></i><button class="${document.documentElement.dataset.theme === "dark" ? "" : "on"}" data-act="theme-seg" data-t="light">라이트</button><button class="${document.documentElement.dataset.theme === "dark" ? "on" : ""}" data-act="theme-seg" data-t="dark">다크</button></div>`)}${row("알림 문체", "작업 기록과 알림을 쓰는 말투", seg("일상", "간결"))}${row("시간 표시", "", seg("12시간", "24시간"))}${row("첨부 미리보기", "", seg("끔", "켬", 1))}${row("긴 글 접기", "", sw(true, "긴 글 접기"))}</div>`);
  P.acts["theme-seg"] = (el) => { P.acts["theme-set"]({ dataset: { themeSet: el.dataset.t } }); P.acts.seg(el); };

  S("settings/webaccess", "웹 접속", "설정", "웹 앱에 들어오는 방법", () => `<div class="list" data-radio>${[["Tailscale", "내 기기들끼리만 안전하게 (기본)"], ["Cloudflare", "어디서나, 기기마다 패스키로 확인"], ["이 컴퓨터만", "밖에서는 열 수 없어요"]].map((m, i) => `<button class="li" data-act="radio"><span class="lead"><span class="dot ${i === 0 ? "pri" : ""}"></span></span><span class="tx"><span class="hd">${m[0]}</span><span class="sup">${m[1]}</span></span><span class="end">${i === 0 ? ic("check") : ""}</span></button>`).join("")}</div>${sec("주소")}<div class="list">${row("이 컴퓨터", "http://macbook.tailnet.example:4141", '<button class="btn tonal inrow" data-act="toast" data-msg="주소를 복사했어요">복사</button>')}</div>`);
  P.acts.radio = (el) => { const box = el.closest("[data-radio]"); $$(".li", box).forEach((l) => { const on = l === el; $(".dot", l).className = "dot " + (on ? "pri" : ""); $(".end", l).innerHTML = on ? ic("check") : ""; }); P.mSwap(el, () => {}); };

  S("settings/devices", "연결된 기기", "설정", "패스키로 연결한 브라우저", () => `<div class="list" data-dev>${[["노트북 · Safari", "이 기기 · 지금", true], ["아이폰 · Safari", "방금 전", false]].map((d) => `<div class="li"><span class="ico">${ic(d[2] ? "laptop" : "phone")}</span><span class="tx"><span class="hd">${d[0]}${d[2] ? ' <span class="tag">이 기기</span>' : ""}</span><span class="sup">${d[1]}</span></span><span class="end">${d[2] ? "" : `<button class="ib" data-act="dev-x" aria-label="빼기">${ic("x")}</button>`}</span></div>`).join("")}</div><div class="cf"><button class="btn tonal" data-act="dev-code">새 기기 연결 코드</button></div><div data-code></div>`);
  P.acts["dev-x"] = async (el) => { const r = el.closest(".li"); await P.mOut(r); r.remove(); P.toast("기기를 뺐어요"); };
  P.acts["dev-code"] = () => { const c = $("[data-code]"); P.mSwap(c, () => { c.innerHTML = `<div class="card" style="margin-top:12px"><div class="meta">새 기기에서 입력해 주세요 · 10분 안에</div><div class="big mono" style="letter-spacing:.2em">482 916</div></div>`; }); };

  S("settings/update", "업데이트", "설정", "새 버전 확인 · 설치 · 다시 시작", () => `<div class="card" data-upd><div class="ch"><h3>새 버전이 있어요</h3><span class="tag pri">0.15.0</span></div><div class="meta">지금 쓰는 버전 0.14.2 · 마지막 확인 5분 전</div><div class="bar pri" style="margin-top:12px" hidden data-ubar><i style="--p:0%"></i></div><div class="cf" data-ubtn><button class="btn" data-act="upd-go">업데이트</button><button class="btn text" data-act="toast" data-msg="나중에 알려 드려요">나중에</button></div></div>`);
  P.acts["upd-go"] = async () => {
    const bar = $("[data-ubar]"), fill = $("i", bar), btn = $("[data-ubtn]"); bar.hidden = false; P.mIn(bar, "rise", 150);
    P.mSwap(btn, () => { btn.innerHTML = '<span class="tag pri">설치하는 중</span>'; });
    for (const p of [30, 65, 100]) { await delay(600); fill.style.setProperty("--p", p + "%"); }
    P.mSwap(btn, () => { btn.innerHTML = '<span class="tag ok">설치했어요</span><button class="btn sm" data-act="toast" data-msg="다시 시작은 프로토타입에서 하지 않아요">다시 시작</button>'; });
  };

  S("settings/usage", "사용량과 월 한도", "설정", "5시간 · 7일 한도, API 월 한도", () => `<div class="card col">${[["5시간 한도", 62, "01:40 뒤에 풀려요"], ["7일 한도", 38, "목요일에 풀려요"], ["API 월 한도", 41, "₩41,000 / ₩100,000"]].map((u) => `<div class="stat"><div class="row"><span>${u[0]}</span><span class="sp"></span><b>${u[1]}%</b></div><div class="bar ${u[1] > 60 ? "warn" : ""}"><i style="--p:${u[1]}%"></i></div><div class="meta">${u[2]}</div></div>`).join("")}</div><div class="cf"><button class="btn tonal sm" data-act="budget">월 한도 바꾸기</button></div>`);
  P.acts.budget = () => P.sheet({ title: "API 월 한도", cls: "mid", body: `<label class="lbl" style="margin-top:0">한 달에 쓸 수 있는 금액</label><input class="field" value="100,000원" aria-label="월 한도"><div class="note" style="margin-left:0">넘기면 API 키 모델은 멈추고 알려 드려요.</div>`, foot: `<button class="btn text" data-act="sheet-close">취소</button><button class="btn" data-act="budget-do">저장</button>` });
  P.acts["budget-do"] = async () => { await P.closeSheet(); P.toast("월 한도를 저장했어요"); };

  S("settings/runtime", "실행 하네스", "설정", "지금 도는 하네스 · 호환 확인", () => `<div class="list">${row("오케스트레이터", "OmO", '<span class="tag ok">정상</span>')}${row("세션", "OmO", '<span class="tag ok">정상</span>')}</div><div class="cf"><button class="btn tonal sm" data-act="rt-check">호환 확인</button></div><div data-rt></div>`);
  P.acts["rt-check"] = async () => { const b = $("[data-rt]"); b.innerHTML = '<div class="card" style="margin-top:12px"><div class="row"><span class="dot work"></span>확인하는 중</div></div>'; await delay(900); P.mSwap(b, () => { b.innerHTML = '<div class="card" style="margin-top:12px"><div class="row"><span class="dot ok"></span>모두 호환돼요</div></div>'; }); };

  S("settings/harness", "구성", "설정", "기능 지도 · 내가 추가한 기능", () => `<div class="card"><div class="ch"><h3>흐름</h3></div><div class="chips">${["입력", "라우팅", "오케스트레이터", "세션", "결과", "알림"].map((s, i) => `${i ? ic("chev") : ""}<span class="chip">${s}</span>`).join("")}</div></div>${sec("내가 추가한 기능")}<div class="list">${row("사용자 앱", "메모장 · 집중 타이머", '<span class="tag">앱 2</span>')}${row("감시", "가격 페이지 · 캠핑 의자 가격", '<span class="tag">감시 2</span>')}${row("예약", "아침 브리핑", '<span class="tag">예약 1</span>')}${row("규칙", "앞으로 답장은 존댓말로", '<span class="tag">규칙 3</span>')}</div>`);
})();
