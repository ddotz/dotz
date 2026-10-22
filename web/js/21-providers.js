/* ---------- providers ---------- */
async function loadProviderData() {
  const r = await api("/api/providers");
  P = { providers: r.providers || [], addable: Array.isArray(r.addable) ? r.addable : null };
  return P;
}
async function loadProviders() {
  const box = $("#providers");
  if (!P) clear(box).append(emptyNode("불러오는 중…"));
  try { await loadProviderData(); }
  catch (e) { clear(box).append(emptyNode("공급자를 불러오지 못했어요")); return; }
  if (current === "providers") renderProviders();
}
function renderProviders() {
  const box = $("#providers");
  const list = P.providers;
  const wrap = el("div", {});
  wrap.append(el("div", { class: "tools-bar" }, el("span", { class: "sec", text: `${list.filter(isConnected).length}개 연결` }),
    el("button", { class: "btn tonal", type: "button", onclick: () => addProviderDialog() }, icon("add"), "추가")));
  if (!list.length) wrap.append(emptyNode("공급자가 없어요"));
  const row = p => {
    const name = p.name || p.id;
    const canLogout = p.can_logout ?? p.removable;
    const sub = p.account || p.masked || (isConnected(p) ? "" : "연결 안 됨");
    const btns = el("div", { class: "btns" });
    if (p.can_login) btns.append(el("button", { class: `btn ${isConnected(p) ? "text" : "tonal"}`, type: "button", onclick: () => startLogin(p) }, isConnected(p) ? "다시 로그인" : "로그인"));
    if (canLogout) btns.append(el("button", { class: "btn danger", type: "button", onclick: ev => busy(ev.currentTarget, () => logoutProvider(p)) }, p.auth === "api_key" ? "키 삭제" : "로그아웃"));
    return el("div", { class: "li prow" }, el("span", { class: "avatar", text: [...name][0] || "?" }),
      el("div", { class: "tx" }, el("div", { class: "heads" }, el("span", { class: "hd", text: name }), p.in_use ? el("span", { class: "tag pri", text: "사용 중" }) : null),
        sub ? el("div", { class: "sup", text: sub }) : null),
      el("span", { class: `tag ${isConnected(p) ? "ok" : needsAttention(p) ? "err" : ""}`, text: p.auth === "oauth" ? "로그인됨" : p.auth === "api_key" ? "API 키" : "연결 안 됨" }),
      btns.children.length ? btns : null);
  };
  // Login accounts first, then API keys; an unconfigured provider sits with the way it can be set up.
  const isLogin = p => p.auth === "oauth" || (p.auth === "none" && p.can_login);
  for (const [title, items] of [["로그인", list.filter(isLogin)], ["API 키", list.filter(p => !isLogin(p))]]) {
    if (!items.length) continue;
    wrap.append(el("div", { class: "sec", text: title }), el("div", { class: "list" }, ...items.map(row)));
  }
  clear(box).append(wrap);
}
function addProviderDialog() {
  const addable = P && P.addable;
  let pick = null, keyIn = null, free = null;
  const body = el("div", { class: "col", style: "gap:16px" });
  const keyBox = el("div", { class: "col kb" });
  const rowsByKey = new Map();
  let dlg;
  function paintKey() {
    clear(keyBox); keyIn = null;
    for (const [id, n] of rowsByKey) { n.classList.toggle("on", !!pick && pick.id === id); n.setAttribute("aria-pressed", pick && pick.id === id ? "true" : "false"); }
    if (pick && pick.kind === "api_key") { keyIn = input({ type: "password", autocomplete: "new-password" }); keyBox.append(textField(free ? "API 키" : `${pick.name || pick.id} API 키`, keyIn)); if (!free) keyIn.focus(); }
    const actions = [{ label: "취소", onclick: c => c() }];
    if (pick && pick.kind === "api_key") actions.push({ label: "저장", kind: "pri", onclick: (c, btn) => busy(btn, async () => {
      const provider = free ? free.value.trim() : pick.id, key = keyIn.value;
      if (!provider || !key.trim()) { toast("공급자와 API 키를 입력해 주세요", true); return; }
      try { await api("/api/providers", "POST", { provider, key }); } finally { keyIn.value = ""; }
      c(); toast("저장했어요"); loadProviders(); loadModels(true);
    }) });
    dlg && dlg.setActions(actions);
  }
  const group = (title, hint, items) => {
    const box = el("div", {}, el("div", { class: "sec", text: title }), el("div", { class: "list" }));
    for (const a of items) {
      const n = el("button", { type: "button", class: "li tap", "aria-pressed": "false", onclick: () => {
        if (a.kind === "oauth") { dlg.close(); startLogin(a); return; }
        pick = a; paintKey();
      } }, el("span", { class: "avatar", text: [...(a.name || a.id)][0] || "?" }), el("span", { class: "tx" }, el("div", { class: "hd", text: a.name || a.id })),
        el("span", { class: "sup", text: hint }), icon(a.kind === "oauth" ? "chev" : "key", "lead"));
      rowsByKey.set(a.id, n); box.lastChild.append(n);
    }
    return box;
  };
  if (addable) {
    const login = addable.filter(a => a.kind === "oauth"), keys = addable.filter(a => a.kind !== "oauth");
    if (!addable.length) body.append(el("p", { text: "추가할 공급자가 없어요" }));
    else {
      const pk = el("div", { class: "pickbox" });
      if (login.length) pk.append(group("로그인", "계정으로 로그인", login));
      if (keys.length) pk.append(group("API 키", "키 입력", keys));
      body.append(pk, keyBox);
    }
  } else { free = input({ type: "text" }); pick = { kind: "api_key" }; body.append(textField("공급자", free), keyBox); }
  dlg = dialog({ title: "공급자 추가", body });
  if (addable && !addable.length) dlg.setActions([{ label: "닫기", onclick: c => c() }]);
  else paintKey();
}
async function startLogin(p) {
  let r;
  try { r = await api(`/api/providers/${enc(p.id)}/login`, "POST", {}); }
  catch (e) { toast(e.message, true); return; }
  const name = p.name || p.id;
  let finished = false, timer, dlg;
  const code = input({ type: "text" });
  const msg = el("p", { class: "err-t", hidden: true });
  const open = el("a", { class: "btn tonal", href: /^https?:\/\//.test(r.url || "") ? r.url : null, target: "_blank", rel: "noopener noreferrer" }, icon("open"), "로그인 페이지 열기");
  const stop = () => { clearTimeout(timer); };
  const success = async () => {
    finished = true; stop(); dlg.close();
    toast(`${name} 로그인했어요`);
    try { await loadProviderData(); } catch {}
    if (current === "providers") renderProviders();
    if (current === "home") renderHome();
    loadModels(true);
  };
  const fail = text => { msg.textContent = text; msg.hidden = false; };
  const poll = async () => {
    try {
      const s = await api(`/api/providers/${enc(p.id)}/login?login_id=${enc(r.login_id)}`);
      if (finished) return;
      if (s.status === "done") { success(); return; }
      if (s.status === "failed") { stop(); fail(s.error || "로그인에 실패했어요"); return; }
    } catch {}
    if (!finished) timer = setTimeout(poll, 2000);
  };
  const submit = btn => busy(btn, async () => {
    const v = code.value.trim();
    if (!v) { fail("코드나 주소를 붙여 넣어 주세요"); return; }
    msg.hidden = true;
    stop();
    try { await api(`/api/providers/${enc(p.id)}/login/complete`, "POST", { login_id: r.login_id, code: v }); await success(); }
    catch (e) { fail(e.message); if (!finished) timer = setTimeout(poll, 2000); }
  });
  dlg = dialog({
    title: `${name} 로그인`,
    body: [el("div", {}, open), textField("코드 또는 주소", code), msg],
    onclose: () => { stop(); if (!finished) api(`/api/providers/${enc(p.id)}/login`, "DELETE").catch(() => {}); },
    actions: [{ label: "취소", onclick: c => c() }, { label: "완료", kind: "pri", onclick: (c, btn) => submit(btn) }],
  });
  code.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); const b = dlg.node.querySelector(".dact .btn:last-child"); if (b) b.click(); } });
  timer = setTimeout(poll, 2000);
}

/* ---------- usage ---------- */
let quotaTimer;
async function loadQuota() {
  clearTimeout(quotaTimer);
  const box = $("#usage");
  let q;
  try { q = await api("/api/quota"); }
  catch (e) { clear(box).append(emptyNode("사용량을 불러오지 못했어요")); return; }
  noteQuota(q);
  if (current === "usage") quotaTimer = setTimeout(loadQuota, 60000);
  clear(box);
  box.append(el("div", { class: "tools-bar" }, el("span", { class: "sup", text: q.fetched_at ? kstStamp(q.fetched_at) : "" }),
    el("button", { class: "btn text", type: "button", onclick: ev => busy(ev.currentTarget, loadQuota) }, icon("refresh"), "새로고침")));
  const grid = el("div", { class: "grid" });
  for (const p of q.providers || []) {
    const card = el("div", { class: "card" }, el("div", { class: "ch" }, el("h3", { text: providerName(p.provider) })));
    for (const l of p.limits || []) {
      card.append(el("div", { class: "lim" },
        el("div", { class: "kv" }, el("span", { class: "k", text: l.label || l.id }), el("span", { style: "font-weight:500", text: pctText(l) })),
        bar(l),
        l.resets_at || l.window ? el("div", { class: "kv", style: "margin-top:4px" }, el("span", { class: "v", text: l.window || "" }), el("span", { class: "v", text: l.resets_at ? rel(l.resets_at) : "" })) : null));
    }
    if (!(p.limits || []).length) card.append(el("div", { class: "sup", text: "없어요" }));
    grid.append(card);
  }
  // Anthropic's limits for the whole organization (hub/org-limits.ts), not for one key; what needs an admin key says so.
  if (q.org) {
    const O = q.org, card = el("div", { class: "card" }, el("div", { class: "ch" }, el("h3", { text: "Anthropic 조직 전체" })));
    for (const l of O.limits || []) {
      card.append(el("div", { class: "lim" },
        el("div", { class: "kv" }, el("span", { class: "k", text: l.label }), el("span", { style: "font-weight:500", text: pctText(l) })),
        bar(l),
        el("div", { class: "v", style: "margin-top:4px", text: l.limit != null ? `${l.window} 한도 ${l.limit.toLocaleString()}${l.unit}` : l.window })));
    }
    if (O.admin) {
      const A = O.admin, costText = A.cost_usd == null ? "비용 정보 없음" : `비용 $${A.cost_usd.toFixed(2)}`;
      card.append(el("div", { class: "lim" }, el("div", { class: "kv" }, el("span", { class: "k", text: "최근 7일 사용량" }), el("span", { style: "font-weight:500", text: costText })),
        el("div", { class: "v", text: `입력 ${A.input_tokens.toLocaleString()} · 출력 ${A.output_tokens.toLocaleString()} 토큰` })));
    }
    for (const u of O.unavailable || []) card.append(el("div", { class: "lim" }, el("div", { class: "kv" }, el("span", { class: "k", text: u.item }), el("span", { class: "v", text: u.reason }))));
    grid.prepend(card);
  }
  if (grid.children.length) box.append(grid);
  // The one Claude account the assistant and its lanes run on, and every switch with its reason (hub/account-sticky.ts).
  if (q.account && q.account.account) {
    const A = q.account, KIND = { start: "처음 선택", limit: "한도", owner: "직접 변경", gone: "계정 사라짐" };
    box.append(el("div", { class: "sec", text: "사용 계정" }));
    // The latest 5 switches (newest first); the older ones (the hub keeps 20) fold behind a toggle.
    const SHOWN = 5, all = A.switches || [];
    const row = s => el("div", { class: "li", style: "display:block" },
      el("div", { class: "hd", text: `${s.from ? `${s.from_label || s.from} → ` : ""}${s.to_label || s.to} · ${s.kind_text || KIND[s.kind] || s.kind}` }),
      el("div", { class: "sup", text: `${kstStamp(Date.parse(s.at))} · ${s.reason}` }));
    const older = all.slice(SHOWN).map(row);
    older.forEach(n => { n.hidden = true; });
    const more = older.length ? el("button", { class: "btn text", type: "button", text: `이전 기록 ${older.length}개 더 보기`, onclick: ev => {
      const open = older[0].hidden;
      older.forEach(n => { n.hidden = !open; });
      ev.currentTarget.textContent = open ? "이전 기록 접기" : `이전 기록 ${older.length}개 더 보기`;
    } }) : null;
    box.append(el("div", { class: "list" },
      el("div", { class: "li", style: "display:block" }, el("div", { class: "hd", text: A.account_label || A.account }), el("div", { class: "sup", text: `${A.since ? `${kstStamp(Date.parse(A.since))}부터 · ` : ""}규칙이나 한도로 바뀌기 전까지 이 계정을 계속 써요` })),
      ...all.slice(0, SHOWN).map(row), ...older));
    if (more) box.append(more);
  }
  if ((q.unavailable || []).length) {
    box.append(el("div", { class: "sec", text: "정보가 없어요" }));
    box.append(el("div", { class: "list" }, ...q.unavailable.map(u => el("div", { class: "li", style: "display:block" }, el("div", { class: "hd", text: providerName(u.provider) }), el("div", { class: "sup", text: u.reason })))));
  }
  if (!(q.providers || []).length && !(q.unavailable || []).length) box.append(emptyNode("사용량 정보가 없어요"));
}
