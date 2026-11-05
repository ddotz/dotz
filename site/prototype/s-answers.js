/* 채팅 답 모양 시안: 같은 마크다운을 지금 모양과 제안 모양으로 나란히 그려요. 제안은 글자를 바꾸지 않고 블록의 모양만 읽어요. 맞는 모양이 없으면 평소 글로 둬요 */
(() => {
  const { h, ic } = P;
  const LABEL = /^- \*\*([^*\n]{1,24}?):?\*\*:?\s+(.+)$/, PAIR = /^- ([^:\n]{1,16}):\s+(.+)$/, TIME = /^- (\d{1,2}:\d{2})\s+(.+)$/;
  const STEP = /^\d+[.)]\s+(.+)$/, HEAD = /^\*\*([^*\n]+)\*\*$/, ARROW = /^(.{1,24}?)\s+→\s+(.{1,24})$/, STAT = /^[+-]?\d[\d,.]*\s?\S*(?:\s\d+\S*)?$/;
  const TAGS = { done: ["ok", "완료"], run: ["pri", "진행 중"] };
  const lines = (b) => b.split("\n").map((l) => l.trim()).filter(Boolean);
  const all = (L, re) => L.length >= 2 && L.every((l) => re.test(l));
  const stat = (v) => v.length <= 12 && STAT.test(v);
  const cells = (l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  /* 블록 하나가 어떤 모양인지 읽어요. 항목이 둘 이상일 때만 모양으로 쳐요 */
  const kind = (b) => {
    const L = lines(b);
    if (/^근거:/.test(L[0]) && L.length === 1) return "ev";
    if (L.every((l) => /^\[file\] /.test(l))) return "files";
    if (L.length >= 2 && L.every((l) => /^\|.*\|$/.test(l))) return "table";
    if (HEAD.test(L[0]) && L.length >= 2 && L.slice(1).every((l) => LABEL.test(l))) return "sec";
    if (all(L, LABEL)) return "keys";
    if (all(L, TIME)) return "time";
    if (all(L, PAIR)) {
      const vals = L.map((l) => PAIR.exec(l)[2]);
      if (vals.every((v) => ARROW.test(v))) return "chg";
      if (vals.every(stat)) return "stat";
    }
    if (all(L, STEP)) return "steps";
    return "";
  };

  const rows = (L) => {
    const kv = L.map((l) => LABEL.exec(l).slice(1));
    return `<div class="ca-card ca-rows${kv.some(([, v]) => v.length > 30) ? " wordy" : ""}">${kv.map(([k, v]) => `<div class="ca-r"><span class="k">${h(k)}</span><span class="w">${P.inline(v)}</span></div>`).join("")}</div>`;
  };
  const section = (b) => {
    const [head, ...L] = lines(b);
    return `<div class="ca-sh">${h(HEAD.exec(head)[1])}</div>${L.map((l) => {
      const [, t, v] = LABEL.exec(l), m = /^(.+?)\s*\((\d+회)\)$/.exec(t);
      return `<div class="ca-li"><div class="ca-lt"><span class="t">${h(m ? m[1] : t)}</span>${m ? `<span class="n">${h(m[2])}</span>` : ""}</div><div class="s">${P.inline(v)}</div></div>`;
    }).join("")}`;
  };
  const stats = (L) => {
    const [[k0, v0], ...rest] = L.map((l) => PAIR.exec(l).slice(1));
    const cell = ([k, v]) => `<div class="ca-st"><span class="k">${h(k)}</span><span class="v${/^[+-]/.test(v) ? " ca-acc" : ""}">${h(v)}</span></div>`;
    return `<div class="ca-card"><div class="ca-big"><span class="k">${h(k0)}</span><span class="v">${h(v0)}</span></div><div class="ca-sts">${rest.map(cell).join("")}</div></div>`;
  };
  const changes = (L) => `<div class="ca-card ca-rows">${L.map((l, i) => {
    const [, k, v] = PAIR.exec(l), [, a, b] = ARROW.exec(v);
    return `<div class="ca-r"><span class="k">${h(k)}</span><span class="w"><s>${h(a.replace(/~~/g, ""))}</s><span class="to">→</span><span class="${i ? "nw" : "nw ca-acc"}">${h(b)}</span></span></div>`;
  }).join("")}</div>`;
  const times = (L) => `<div class="ca-card ca-rows tm">${L.map((l) => {
    const [, k, r] = TIME.exec(l), [t, d] = r.split(/\s+·\s+/, 2);
    return `<div class="ca-r"><span class="k">${h(k)}</span><span class="w"><span class="t">${h(t)}</span>${d ? `<span class="d"> · ${h(d)}</span>` : ""}</span></div>`;
  }).join("")}</div>`;
  const steps = (L) => `<div class="ca-card ca-steps">${L.map((l, i) => `<div class="ca-step"><span class="n">${i + 1}</span><span>${P.inline(STEP.exec(l)[1])}</span></div>`).join("")}</div>`;
  const files = (L) => `<div class="ca-card ca-files">${L.map((l) => {
    const p = l.slice(7).trim(), name = p.split("/").pop(), ext = name.split(".").pop().toUpperCase();
    return `<div class="ca-f"><span class="av">${ic("file")}</span><span class="fn">${h(name)}</span><span class="ex">${h(ext)}</span></div>`;
  }).join("")}</div>`;
  const evidence = (b) => `<div class="ca-ev">${b.replace(/^근거:\s*/, "").split(/\s+·\s+/).map((x) => `<span>${P.inline(x)}</span>`).join("")}</div>`;
  const parseTable = (b) => {
    const L = lines(b).filter((l) => !/^\|[\s:|-]+\|$/.test(l)).map(cells);
    return { head: L[0], body: L.slice(1) };
  };
  const tableNow = (b) => {
    const { head, body } = parseTable(b);
    return `<div class="ca-tbl"><table><thead><tr>${head.map((c) => `<th>${P.inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${P.inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  };
  const tableNew = (b) => {
    const { head, body } = parseTable(b);
    return `<div class="ca-card ca-tb"><table><thead><tr>${head.map((c) => `<th>${P.inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${P.inline(c)}</td>` : `<th>${P.inline(c)}</th>`)).join("")}</tr>`).join("")}</tbody></table></div>`;
  };
  const DRAW = { files: (b) => files(lines(b)), table: (b) => (parseTable(b).head.length > 5 ? tableNow(b) : tableNew(b)), keys: (b) => rows(lines(b)), time: (b) => times(lines(b)), chg: (b) => changes(lines(b)), stat: (b) => stats(lines(b)), steps: (b) => steps(lines(b)), ev: evidence };

  /* 첫 문장이 메시지의 주인공이에요. 큰 숫자나 바뀐 값이 있으면 그게 주인공이라 첫 문장은 보통 굵기로 둬요 */
  const lead = (b, quiet) => {
    const m = /^\[(done|run)\]\s*/.exec(b), body = m ? b.slice(m[0].length) : b;
    const s = /^(.+?[.!?])(\s[\s\S]*)?$/.exec(body), one = s ? s[1] : body, more = s && s[2] ? s[2] : "";
    const text = `${quiet ? P.inline(one) : `<span class="ca-lead">${P.inline(one)}</span>`}${P.inline(more)}`;
    if (!m) return `<p>${text}</p>`;
    const [t, l] = TAGS[m[1]];
    return `<div class="st"><span class="tag ${t}">${l}</span><span>${text}</span></div>`;
  };

  const draft = (src) => {
    const parts = src.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean), kinds = parts.map(kind);
    if (!kinds.some(Boolean)) return P.md(src);
    const quiet = kinds.some((k) => k === "stat" || k === "chg");
    let out = "", open = false;
    parts.forEach((b, i) => {
      const k = kinds[i];
      if (k !== "sec" && open) { out += "</div>"; open = false; }
      if (k === "sec") { out += `${open ? "" : `<div class="ca-card ca-secs">`}${section(b)}`; open = true; }
      else if (DRAW[k]) out += DRAW[k](b);
      else out += i === 0 ? lead(b, quiet) : P.md(b);
    });
    return out + (open ? "</div>" : "");
  };
  const now = (src) => src.split(/\n\s*\n/).map((b) => {
    const k = kind(b.trim());
    if (k === "ev") return `<p class="ca-meta">${P.inline(b.trim())}</p>`;
    if (k === "table") return tableNow(b.trim());
    if (k === "steps") return `<ol>${lines(b).map((l) => `<li>${P.inline(STEP.exec(l)[1])}</li>`).join("")}</ol>`;
    return P.md(b);
  }).join("");

  const TYPES = [
    { name: "라벨 붙은 보고", count: "300개 중 101개", why: "가장 많은 모양이에요. 굵은 라벨이 줄마다 있어서 어디가 중요한지 안 보였어요. 라벨을 회색 칸으로 물리고 첫 문장만 진하게 해요.",
      when: "`- **라벨:** 내용`이 두 줄 이상 이어질 때. 지금 답 그대로 돼요.",
      src: "[done] 사진 앨범이 안 열리던 문제를 고쳤어요. 앱을 새로고침하면 바로 반영돼요.\n\n- **원인:** 새로 올린 사진의 썸네일이 만들어지기 전에 목록을 먼저 불러왔어요.\n- **고친 것:** 썸네일이 없으면 원본을 줄여서 보여 주고, 다 만들어지면 자리만 바꿔요.\n- **돌아온 것:** 지난주에 올린 사진 12장이 다시 보여요.\n- **확인:** 폰과 PC에서 앨범을 끝까지 넘겨 봤어요.\n\n근거: `a1b2c3d` · 테스트 24개 통과" },
    { name: "묶음 보고", count: "300개 중 12개", why: "제목 아래로 항목이 묶인 긴 답이에요. 묶음마다 한 면에 모으고, 횟수는 오른쪽 작은 글씨로 빼요.",
      when: "`**제목**` 한 줄 아래 라벨 목록이 올 때. 지금 답 그대로 돼요.",
      src: "지난주 문의 31건을 묶어 봤어요. 네 묶음 중 두 묶음은 아직 남았어요.\n\n**아직 남음**\n- **배송 늦음 (6회):** 주말 주문이 월요일에 몰려서 하루씩 밀렸어요.\n- **쿠폰 안 먹힘 (3회):** 할인 상품에 쓰려던 경우라 안내 문구를 고쳐야 해요.\n\n**처리함**\n- **영수증 재발급 (4회):** 주문 화면에서 바로 받을 수 있게 했어요.\n- **비밀번호 찾기 (2회):** 메일이 스팸함으로 가던 걸 고쳤어요." },
    { name: "결과물과 근거", count: "파일 65개 · 커밋 161개 · 테스트 84개", why: "끝난 일은 결과물로 끝나요. 파일은 이름이 먼저 보이는 행으로, 커밋과 테스트는 맨 아래 작은 글씨로 물러나요.",
      when: "`[file]` 줄이 있을 때, 또는 끝줄이 `근거:`일 때. 계약 한 줄: 커밋과 테스트는 본문 대신 끝에 `근거:` 한 줄로 써요.",
      src: "[done] 5월 가계부를 정리했어요. 식비가 지난달보다 늘어서 외식과 장보기로 나눠 뒀어요.\n\n[file] /files/5월-가계부.xlsx\n[file] /files/5월-요약.pdf\n\n근거: 카드 내역 212건 대조 · 빠진 건 없음" },
    { name: "숫자 요약", count: "숫자 셋 이상 66개", why: "지금은 숫자가 문장 속에 흩어져 있어요. 맨 앞 숫자 하나를 크게, 변화 값만 강조색으로 보여 줘요.",
      when: "`- 이름: 값`이 두 줄 이상이고 값이 전부 짧은 숫자일 때. 계약 한 줄: 숫자를 보고할 때는 `- 이름: 값`으로 줄마다 하나씩 써요.",
      src: "이번 달 블로그 방문을 봤어요. 검색으로 들어온 사람이 가장 많아요.\n\n- 방문자: 12,480명\n- 지난달보다: +18%\n- 평균 머문 시간: 2분 14초\n- 구독 신청: 37건" },
    { name: "전후 변경", count: "화살표 18개", why: "바뀌기 전 값은 회색 취소선, 바뀐 값은 진하게 둬요. 강조색은 첫 줄 하나만 써요.",
      when: "`- 이름: 전 → 후`가 두 줄 이상이고 양쪽이 짧을 때. 화살표가 둘 이상인 흐름 설명은 글로 둬요. 계약 한 줄로 쓰게 해요.",
      src: "[done] 휴대폰 요금제를 바꿨어요. 다음 결제일부터 적용돼요.\n\n- 월 요금: 29,000원 → 19,000원\n- 데이터: 무제한 → 20GB\n- 약정: 없음 → 12개월" },
    { name: "시간 목록", count: "줄 목록 0개 · 문장 속 7개", why: "다른 작업(시간 행)이 지금 만드는 모양이에요. 여기서는 같은 답 안에 놓였을 때 어울리는지만 봐요.",
      when: "`- 09:30 할 일 · 설명`이 두 줄 이상일 때. 결과 카드의 시간 행과 같은 규칙이에요.",
      src: "내일 일정이에요. 오전에 병원이 있어서 일찍 나가야 해요.\n\n- 09:30 치과 검진 · 3층 접수\n- 13:00 점심 약속\n- 17:30 아이 학원 데리러 가기 · 차 가져가기" },
    { name: "단계 목록", count: "300개 중 4개", why: "따라 하면서 보는 글이라 번호가 눈에 먼저 들어와야 해요. 번호를 작은 칸에 넣고 줄 간격을 넓혀요.",
      when: "`1.` 또는 `1)`이 두 줄 이상 이어질 때. 지금 답 그대로 돼요.",
      src: "프린터를 다시 연결하려면 이렇게 해 주세요.\n\n1. 전원을 끄고 10초 기다려요.\n2. 뒤쪽 버튼을 누른 채로 전원을 켜요.\n3. 불이 파랗게 바뀌면 앱에서 다시 찾기를 눌러요." },
    { name: "표 비교", count: "300개 중 4개", why: "줄을 벌리고 첫 칸을 회색으로 물려요. 폰에서 옆으로 밀지 않게 칸 안에서 줄을 바꿔요. 다섯 칸이 넘는 표는 지금처럼 밀어서 봐요.",
      when: "`|` 표가 있을 때. 지금 답 그대로 돼요.",
      src: "두 요금제를 비교했어요. 집에서 주로 쓰면 기본형이 나아요.\n\n| | 기본형 | 넉넉형 |\n|---|---|---|\n| 월 요금 | 19,000원 | 33,000원 |\n| 데이터 | 20GB | 무제한 |\n| 약정 | 12개월 | 없음 |" },
    { name: "평범한 대화", count: "짧은 대화 33개 · 단락 설명 42개", why: "모양이 없으면 카드를 쓰지 않아요. 두 쪽이 똑같은 게 맞아요.",
      when: "맞는 모양이 없으면 언제나 평소 글이에요.",
      src: "네, 그렇게 하면 돼요. 내일 아침에 한 번 더 확인해 볼게요." },
  ];
  const NOPE = [
    ["평범한 대화와 단락 설명", "대화에 카드를 씌우면 말투가 사라져요. 75개가 여기에 들어요."],
    ["작업을 시작했다는 알림", "곧 사라질 말이라 한 줄로 둬요. 23개예요."],
    ["결정 카드", "이미 카드가 있어요. 23개는 그대로 둬요."],
    ["항목이 하나뿐인 목록", "한 줄짜리 카드는 글보다 무거워요. 두 줄부터 모양으로 쳐요."],
    ["하위 목록이 있는 항목", "행 하나는 한 줄 요약이에요. 안에 목록이 있으면 글로 둬요."],
    ["답 끝의 마무리 문장", "남은 일과 부탁은 글로 남겨요. 문장을 카드에 넣지 않아요."],
  ];

  const when = (s) => h(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  const pair = (s) => `<div class="ca-cmp">
    <div class="ca-side"><div class="ca-lab">지금</div><div class="msg bot"><div class="bub ca-now">${now(s)}</div></div></div>
    <div class="ca-side"><div class="ca-lab">제안</div><div class="msg bot"><div class="bub ca-new">${draft(s)}</div></div></div>
  </div>`;
  const type = (t) => `<section class="ca-t">
    <div class="ca-h"><h3>${h(t.name)}</h3><span class="tag">${h(t.count)}</span></div>
    <p class="ca-why">${h(t.why)}</p>
    ${pair(t.src)}
    <p class="ca-when">${when(t.when)}</p>
    <details class="ca-raw"><summary>모델이 쓰는 글</summary><pre>${h(t.src)}</pre></details>
  </section>`;

  P.reg({ id: "answers", title: "채팅 답 모양", tab: "chat", back: "chat", group: "채팅", view: "ca-v", desc: "답 모양 시안: 지금과 제안을 나란히, 카드를 쓰지 않는 곳까지",
    render: () => `<div class="hint">최근 답 300개를 모양별로 세고, 같은 글을 지금 모양과 제안 모양으로 그렸어요. 글은 전부 지어낸 예시예요. 모델을 더 부르지 않고 글의 모양만 읽어요.</div>
      ${TYPES.map(type).join("")}
      <section class="ca-t"><div class="ca-h"><h3>카드를 쓰지 않는 곳</h3></div><div class="list">${NOPE.map(([t, s]) => `<div class="li"><span class="tx"><span class="hd">${h(t)}</span><span class="sup">${h(s)}</span></span></div>`).join("")}</div></section>` });
})();
