/* 폼 시안: 카드 추가(web/custom.js cardForm)를 보더 없는 칸, 썸네일 보기, 실시간 미리보기로 다시 그려요. #form/settings는 같은 칸을 설정 폼에 입힌 모습이에요 */
(() => {
  const { $, $$, h, ic } = P;
  const VIEWS = [["text", "글"], ["stat", "숫자"], ["list", "목록"], ["kv", "항목별 값"]];
  const KO = Object.fromEntries(VIEWS);
  const ACT_MAX = 4, ACT_SHOWN = 2, LIST_MAX = 5, KV_MAX = 6;
  const PH = { text: "카드에 보일 글", stat: "예: 128GB", list: "우유 사기\n치과 예약", kv: "남은 공간: 128GB\n마지막 확인: 어제" };
  const HINT = { stat: "숫자나 짧은 값 하나를 적어요.", list: "한 줄에 하나씩 적어요.", kv: "한 줄에 이름: 값으로 적어요." };
  const GHOST = { stat: "128GB", list: ["첫 번째 항목", "두 번째 항목"], kv: [["이름", "값"], ["이름", "값"]] };
  const SEEDS = {
    empty: {},
    filled: { title: "오늘 할 일", note: "회사 일정에서 가져와요", view: "list", body: "공문 초안 확인\n치과 예약\n캠핑 의자 주문", acts: [{ label: "새로고침", kind: "command", text: "bun run todo", confirm: false }, { label: "정리해 줘", kind: "prompt", text: "오늘 할 일을 정리해 줘", confirm: false }] },
  };
  const fresh = (k) => ({ title: "", note: "", view: "text", src: "text", body: "", cwd: "", every: "", timeout: "", link: "", id: "", acts: [], ...SEEDS[k] });
  let S = fresh("empty");

  const lines = (t) => t.split("\n").map((l) => l.trim()).filter(Boolean);
  const pair = (l) => { const i = l.indexOf(":"); return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; };
  const more = (n) => (n > 0 ? `<div class="more">더 보기 · ${n}개</div>` : "");

  /* 카드 본문은 web/custom.js viewBody와 같은 네 모양이에요. 아직 비었으면 같은 모양을 옅은 글씨로 그려요 */
  const body = () => {
    if (S.src === "command") return `<div class="hc-none">저장하면 명령을 실행해 결과를 그려요</div>`;
    const t = S.body.trim(), g = t ? "" : " fp-g";
    if (S.view === "stat") return `<div class="big${g}">${h(t || GHOST.stat)}</div>`;
    if (S.view === "list") {
      const all = t ? lines(t) : GHOST.list;
      return `<div class="fp-rows${g}">${all.slice(0, LIST_MAX).map((x) => `<div class="row">${h(x)}</div>`).join("")}</div>${more(all.length - LIST_MAX)}`;
    }
    if (S.view === "kv") {
      const all = t ? lines(t).map(pair) : GHOST.kv;
      return `<div class="fp-kvs${g}">${all.slice(0, KV_MAX).map(([k, v]) => `<div class="kv"><span class="k">${h(k)}</span><span class="v">${h(v)}</span></div>`).join("")}</div>${more(all.length - KV_MAX)}`;
    }
    return `<div class="clamp c4${g}">${h(t || PH.text)}</div>`;
  };
  const cardInner = () => {
    const shown = S.acts.slice(0, ACT_SHOWN).filter((a) => a.label.trim());
    return `<div class="ch"><h3 class="${S.title.trim() ? "" : "fp-g"}">${h(S.title.trim() || "카드 제목")}</h3><span class="ac">${ic("dots")}</span></div>${S.note.trim() ? `<div class="sup">${h(S.note.trim())}</div>` : ""}<div class="fp-b${S.note.trim() ? " mt8" : ""}">${body()}</div>${shown.length ? `<div class="cf">${shown.map((a) => `<span class="btn tonal inrow">${h(a.label.trim())}</span>`).join("")}</div>` : ""}`;
  };

  const seg = (name, a, b, v, label) => `<div class="seg bg" data-v="${v}" role="radiogroup" aria-label="${h(label)}"><i></i>${[a, b].map((t, i) => `<button type="button" role="radio" class="${i === v ? "on" : ""}" aria-checked="${i === v}" data-act="fp-seg" data-seg="${name}" data-i="${i}">${h(t)}</button>`).join("")}</div>`;
  const fld = (key, label, ctrl, hint = "") => `<div class="ff-f" data-f="${key}"><label class="ff-l" for="fp-${key}">${h(label)}</label>${ctrl}${hint ? `<div class="ff-h">${h(hint)}</div>` : ""}</div>`;
  const inp = (key, ph, attrs = "") => `<input class="ff" id="fp-${key}" data-k="${key}" value="${h(S[key])}" placeholder="${h(ph)}" autocomplete="off" ${attrs}>`;
  const thumb = ([v, label]) => {
    const marks = { text: "<i></i><i></i><i class=\"s\"></i>", stat: "<b></b><i class=\"s\"></i>", list: "<i></i><i></i><i></i>", kv: "<u><i></i><i></i></u><u><i></i><i></i></u><u><i></i><i></i></u>" }[v];
    return `<label class="vt"><input type="radio" name="fp-view" value="${v}"${S.view === v ? " checked" : ""}><span class="vt-c k-${v}" aria-hidden="true">${marks}</span><span class="vt-n">${h(label)}</span></label>`;
  };
  const actRow = (a, i) => `<div class="fp-act" data-a="${i}"><div class="fp-act-h"><input class="ff" data-ak="label" value="${h(a.label)}" maxlength="20" placeholder="버튼 이름" aria-label="동작 ${i + 1} 이름" autocomplete="off">${seg(`act-${i}`, "명령", "요청", a.kind === "prompt" ? 1 : 0, `동작 ${i + 1} 종류`)}</div><input class="ff" data-ak="text" value="${h(a.text)}" placeholder="${a.kind === "prompt" ? "dotz AI에게 보낼 요청" : "실행할 명령"}" aria-label="동작 ${i + 1} 내용" autocomplete="off"><div class="fp-act-f"><label class="fp-ck"><input type="checkbox" data-ak="confirm"${a.confirm ? " checked" : ""}>누르기 전에 확인</label><button type="button" class="btn text inrow" data-act="fp-act-del" data-i="${i}">빼기</button></div></div>`;
  const actsHtml = () => `${S.acts.map(actRow).join("")}<button type="button" class="btn tonal sm" data-act="fp-act-add"${S.acts.length >= ACT_MAX ? " disabled" : ""}>동작 추가</button>`;
  const hintFor = () => (S.src === "command" ? `갱신 주기는 분, 제한 시간은 초(1~60). 출력은 ${KO[S.view]} 보기로 그려요.` : HINT[S.view] || "");
  const moreSub = () => {
    const n = [S.note, S.link, S.id].filter((x) => x.trim()).length + (S.acts.length ? 1 : 0);
    return `설명 · 링크 · 동작 · 아이디${n ? ` · ${n}개 채움` : ""}`;
  };

  const form = (k, open = false) => {
    S = fresh(k);
    return `<div class="fp">
      <aside class="fp-pv" aria-label="미리보기"><div class="meta">홈에서 이렇게 보여요</div><div class="card fp-c" data-card>${cardInner()}</div></aside>
      <form class="fp-f" novalidate>
        ${fld("title", "제목", inp("title", "예: 디스크 남은 공간", 'maxlength="40" required').replace('class="ff"', 'class="ff t"'))}
        <div class="ff-f" role="radiogroup" aria-labelledby="fp-vl"><span class="ff-l" id="fp-vl">보기</span><div class="vts">${VIEWS.map(thumb).join("")}</div></div>
        <div class="ff-f" data-f="body">
          <div class="fp-h"><label class="ff-l" for="fp-body" data-bl>${S.src === "command" ? "명령" : "내용"}</label>${seg("src", "직접 입력", "명령 실행", S.src === "command" ? 1 : 0, "내용 출처")}</div>
          <textarea class="ff" id="fp-body" data-k="body" rows="3" autocomplete="off" spellcheck="false" placeholder="${h(PH[S.view])}">${h(S.body)}</textarea>
          <div class="ff-h" data-hint${hintFor() ? "" : " hidden"}>${h(hintFor())}</div>
        </div>
        <div class="fp-cmd" data-cmd${S.src === "command" ? "" : " hidden"}>
          ${fld("cwd", "폴더", inp("cwd", "~/Code/… (선택)"))}
          <div class="fp-2">${fld("every", "갱신 주기", inp("every", "10", 'type="number" min="1" step="1" inputmode="numeric"'))}${fld("timeout", "제한 시간", inp("timeout", "10", 'type="number" min="1" max="60" step="1" inputmode="numeric"'))}</div>
        </div>
        <details class="fp-more"${open ? " open" : ""}>
          <summary><span class="ff-l">더 보기</span><span class="ff-h" data-more>${h(moreSub())}</span>${ic("chevd", "chev")}</summary>
          <div class="fp-mb">
            ${fld("note", "설명", inp("note", "제목 아래 한 줄", 'maxlength="120"'))}
            ${fld("link", "링크", inp("link", "https://… 또는 #화면", 'type="url" inputmode="url"'))}
            <div class="ff-f"><span class="ff-l">동작</span><div class="ff-h">최대 4개, 앞의 2개는 카드에 버튼으로 보여요.</div><div class="fp-acts" data-acts>${actsHtml()}</div></div>
            ${fld("id", "아이디", inp("id", "비우면 제목으로 만들어요", 'maxlength="40" pattern="[a-z0-9][a-z0-9-]{0,39}"'))}
          </div>
        </details>
        <div class="fp-ft"><a class="btn text" href="#home">취소</a><button type="submit" class="btn">저장</button></div>
      </form>
    </div>`;
  };

  const paint = (view, swap) => {
    const c = $("[data-card]", view), put = () => { c.innerHTML = cardInner(); };
    swap ? P.mSwap(c, put) : put();
    const hint = $("[data-hint]", view), t = hintFor();
    hint.textContent = t; hint.hidden = !t;
    $("[data-more]", view).textContent = moreSub();
  };
  const clearFail = (view) => $$("[aria-invalid]", view).forEach((n) => { n.removeAttribute("aria-invalid"); $(".ff-e", n.parentElement)?.remove(); });
  const fail = (view, key, msg) => {
    const f = $(`[data-f="${key}"]`, view), ctrl = $(".ff", f);
    ctrl.closest("details")?.setAttribute("open", "");
    ctrl.setAttribute("aria-invalid", "true");
    ctrl.insertAdjacentHTML("afterend", `<div class="ff-e" role="alert">${h(msg)}</div>`);
    ctrl.focus();
  };

  const mount = (view) => {
    const f = $(".fp-f", view);
    f.addEventListener("input", (e) => {
      const t = e.target;
      if (t.name === "fp-view") return;
      if (t.dataset.k) { S[t.dataset.k] = t.value; clearFail(view); paint(view); return; }
      if (t.dataset.ak) { const a = S.acts[+t.closest("[data-a]").dataset.a], k = t.dataset.ak; a[k] = k === "confirm" ? t.checked : t.value; paint(view); }
    });
    f.addEventListener("change", (e) => {
      if (e.target.name !== "fp-view") return;
      S.view = e.target.value;
      $("#fp-body", view).placeholder = S.src === "command" ? P.fpCmdPh : PH[S.view];
      paint(view, true);
    });
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      clearFail(view);
      if (!S.title.trim()) return fail(view, "title", "제목을 적어 주세요");
      const id = $("#fp-id", view);
      if (!id.checkValidity()) return fail(view, "id", "영어 소문자, 숫자, 빼기(-)만 쓸 수 있어요");
      P.toast("카드를 추가했어요");
    });
    $(".fp-more", view).addEventListener("toggle", (e) => { if (e.target.open) P.mIn($(".fp-mb", view), "rise", 220); });
  };
  P.fpCmdPh = "예: df -h ~ | tail -1   (출력이 JSON이면 그대로 읽어요)";

  P.acts["fp-seg"] = (b) => {
    const box = b.parentElement, i = +b.dataset.i, view = $("#view");
    box.dataset.v = i;
    [...box.querySelectorAll("button")].forEach((x, n) => { x.classList.toggle("on", n === i); x.setAttribute("aria-checked", String(n === i)); });
    if (b.dataset.seg === "src") {
      S.src = i ? "command" : "text";
      $("[data-bl]", view).textContent = i ? "명령" : "내용";
      $("#fp-body", view).placeholder = i ? P.fpCmdPh : PH[S.view];
      $("[data-cmd]", view).hidden = !i;
      paint(view, true);
    } else {
      const a = S.acts[+b.dataset.seg.slice(4)];
      a.kind = i ? "prompt" : "command";
      $('[data-ak="text"]', b.closest("[data-a]")).placeholder = i ? "dotz AI에게 보낼 요청" : "실행할 명령";
    }
  };
  const repaintActs = (view) => { $("[data-acts]", view).innerHTML = actsHtml(); paint(view); };
  P.acts["fp-act-add"] = () => {
    const view = $("#view");
    S.acts.push({ label: "", kind: "command", text: "", confirm: false });
    repaintActs(view);
    const rows = $$(".fp-act", view), last = rows[rows.length - 1];
    P.mIn(last, "rise", 220);
    $(".ff", last).focus();
  };
  P.acts["fp-act-del"] = (b) => { S.acts.splice(+b.dataset.i, 1); repaintActs($("#view")); };

  P.reg({ id: "form", title: "카드 추가", tab: "home", back: "home", group: "홈", view: "fp-v", desc: "새 폼 시안: 미리보기 · 썸네일 보기 · 더 보기", render: () => form("empty"), mount });
  P.reg({ id: "form/more", title: "카드 추가", tab: "home", back: "home", group: "홈", view: "fp-v", desc: "새 폼 시안: 더 보기를 연 상태", render: () => form("filled", true), mount });
  P.reg({ id: "form/filled", title: "카드 추가", tab: "home", back: "home", group: "홈", view: "fp-v", desc: "새 폼 시안: 내용이 찬 상태", render: () => form("filled"), mount });

  /* 두 번째 화면: web/js/25-settings-web-access.js waAdvanced의 칸과 25-settings-accounts.js의 별칭 행. 흰 면 안에서는 칸이 --layer로 채워져요 */
  const W = [["hostname", "주소", "dotz.example.com", "터널에 연결해 둔 주소예요. 주소를 바꾸면 기기를 다시 연결해야 해요.", "url"], ["team", "팀 이름 (선택)", "myteam", "Cloudflare Access로 한 번 더 확인할 때만 적어요.", "text"], ["aud", "확인 번호 (선택)", "", "Access 앱 화면의 Audience Tag 값이에요.", "text"]];
  const wfld = ([k, l, ph, hint, mode]) => `<div class="ff-f"><label class="ff-l" for="wa-${k}">${h(l)}</label><input class="ff" id="wa-${k}" value="${k === "hostname" ? "dotz.example.com" : ""}" placeholder="${h(ph)}" inputmode="${mode}" autocomplete="off"><div class="ff-h">${h(hint)}</div></div>`;
  const alias = (name, sup, val) => `<div class="li"><span class="tx"><span class="hd">${h(name)}</span><span class="sup">${h(sup)}</span></span><span class="end"><input class="ff in" value="${h(val)}" placeholder="별칭" aria-label="${h(name)} 별칭" maxlength="40" autocomplete="off"></span></div>`;
  P.reg({ id: "form/settings", title: "웹 접속", tab: "settings", back: "settings/webaccess", group: "설정", view: "fp-s", desc: "같은 입력칸을 설정 폼에 적용한 시안",
    render: () => `<div class="sec">Cloudflare 터널</div>
      <div class="list fp-sf">${W.map(wfld).join("")}
        <div class="ff-f"><div class="fp-h"><label class="ff-l" for="wa-token">터널 토큰</label><span class="tag ok">저장됨</span></div><input class="ff" id="wa-token" type="password" placeholder="바꾸려면 새로 붙여 넣기" autocomplete="new-password"><div class="ff-h">저장하면 이 컴퓨터에만 보관하고, 화면에는 다시 보여 주지 않아요.</div></div>
        <div class="fp-ft"><button type="button" class="btn text" data-wa-reset hidden>되돌리기</button><button type="button" class="btn" data-wa-save disabled>저장</button></div>
      </div>
      <div class="sec">계정 별칭</div>
      <div class="list">${alias("개인", "지금 쓰는 계정", "개인")}${alias("회사", "쉬는 중", "")}</div>`,
    mount: (view) => {
      const save = $("[data-wa-save]", view), reset = $("[data-wa-reset]", view), box = $(".fp-sf", view);
      const dirty = (on) => { save.disabled = !on; reset.hidden = !on; };
      box.addEventListener("input", () => dirty(true));
      reset.onclick = () => { $$(".ff", box).forEach((i) => { i.value = i.defaultValue; }); dirty(false); };
      save.onclick = () => { dirty(false); P.toast("저장했어요"); };
    } });
})();
