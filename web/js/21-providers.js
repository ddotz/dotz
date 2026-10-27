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
// A usage window in plain Korean: the report's "Claude 5 Hour" / "Claude 7 Day Opus" read as 5시간 한도 / 7일 한도 Opus.
function limitName(l) {
  const m = /^Claude\s+(\d+)\s+(Hour|Day)s?\b\s*(.*)$/i.exec(l.label || "");
  return m ? `${m[1]}${/hour/i.test(m[2]) ? "시간" : "일"} 한도${m[3] ? ` ${m[3]}` : ""}` : l.label || l.id;
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
    const sub = [p.account || p.masked || (isConnected(p) ? "" : "연결 안 됨"), p.accounts > 1 ? `계정 ${p.accounts}개` : ""].filter(Boolean).join(" · ");
    const btns = el("div", { class: "btns" });
    // a signed-in Claude subscription: another login adds an account (hub/providers.ts can_add_account), it never replaces one
    if (p.can_add_account) btns.append(el("button", { class: "btn tonal", type: "button", onclick: () => startLogin(p) }, icon("add"), "계정 추가"));
    else if (p.can_login) btns.append(el("button", { class: `btn ${isConnected(p) ? "text" : "tonal"}`, type: "button", onclick: () => startLogin(p) }, isConnected(p) ? "다시 로그인" : "로그인"));
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
  // what the sign-in asks for right now (its own words), and the choices when it asks to pick one
  const ask = el("div", { class: "sup" });
  const picks = el("div", { class: "row", style: "flex-wrap:wrap" });
  const paintAsk = v => {
    ask.textContent = v.prompt || ""; ask.hidden = !v.prompt;
    clear(picks); picks.hidden = !(v.options && v.options.length);
    for (const o of v.options || []) picks.append(el("button", { class: "chip", type: "button", text: o, onclick: ev => { code.value = o; submit(ev.currentTarget); } }));
  };
  const open = el("a", { class: "btn tonal", href: /^https?:\/\//.test(r.url || "") ? r.url : null, target: "_blank", rel: "noopener noreferrer" }, icon("open"), "로그인 페이지 열기");
  const stop = () => { clearTimeout(timer); };
  const success = async () => {
    finished = true; stop(); dlg.close();
    toast(p.can_add_account || p.add_account ? "계정을 추가했어요" : `${name} 로그인했어요`);
    try { await loadProviderData(); } catch {}
    if (current === "providers") renderProviders();
    if (current === "home") renderHome();
    loadModels(true);
    // 설정 → 계정 groups every provider's accounts; a new one shows there at once
    if (p.id === "anthropic" || p.add_account) loadAccounts();
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
    try {
      const s = await api(`/api/providers/${enc(p.id)}/login/complete`, "POST", { login_id: r.login_id, code: v });
      // a sign-in with more than one step answers with the next question instead of finishing
      if (s.status === "waiting") { code.value = ""; paintAsk(s); code.focus(); timer = setTimeout(poll, 2000); return; }
      await success();
    }
    catch (e) { fail(e.message); if (!finished) timer = setTimeout(poll, 2000); }
  });
  dlg = dialog({
    title: p.can_add_account || p.add_account ? `${name} 계정 추가` : `${name} 로그인`,
    body: [el("div", {}, open), textField("코드 또는 주소", code), ask, picks, msg],
    onclose: () => { stop(); if (!finished) api(`/api/providers/${enc(p.id)}/login`, "DELETE").catch(() => {}); },
    actions: [{ label: "취소", onclick: c => c() }, { label: "완료", kind: "pri", onclick: (c, btn) => submit(btn) }],
  });
  paintAsk(r);
  code.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); const b = dlg.node.querySelector(".dact .btn:last-child"); if (b) b.click(); } });
  timer = setTimeout(poll, 2000);
}

/* ---------- usage ---------- */
let quotaTimer;
async function loadQuota() {
  clearTimeout(quotaTimer);
  const box = $("#usage");
  let q;
  // the cards are titled by provider name (providerName reads P), so a direct open of 사용량 loads the providers too
  try { [q] = await Promise.all([api("/api/quota"), P ? null : loadProviderData().catch(() => null)]); }
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
        el("div", { class: "kv" }, el("span", { class: "k", text: limitName(l) }), el("span", { style: "font-weight:500", text: pctText(l) })),
        bar(l),
        l.resets_at ? el("div", { class: "kv", style: "margin-top:4px" }, el("span", { class: "v", text: "" }), el("span", { class: "v", text: rel(l.resets_at) })) : null));
    }
    if (!(p.limits || []).length) card.append(el("div", { class: "sup", text: "없어요" }));
    grid.append(card);
  }
  // The monthly API spend limit the owner set on the platform console, and how much of it is used (hub/api-budget.ts).
  if (q.budget) grid.prepend(budgetCard(q.budget));
  if (grid.children.length) box.append(grid);
  // The one Claude account the assistant and its lanes run on, and every switch with its reason (hub/account-sticky.ts).
  if (q.account && q.account.account) {
    const A = q.account, KIND = { start: "처음 선택", limit: "한도", owner: "직접 변경", gone: "계정 사라짐" };
    box.append(el("div", { class: "sec", text: "사용 계정" }));
    // The latest 5 switches (newest first); the older ones (the hub keeps 20) fold behind a toggle.
    const SHOWN = 5, all = A.switches || [];
    // Entries older than 3 days are pruned by the hub; the X deletes one entry, 모두 지우기 (confirmed) all of them (DELETE /api/accounts/switches).
    const drop = async (at, msg) => { try { await api(`/api/accounts/switches${at ? `?at=${enc(at)}` : ""}`, "DELETE"); toast(msg); loadQuota(); } catch (e) { toast("지우지 못했어요", true); } };
    // the why is said once: the reason line, or the kind when there is no reason
    const row = s => el("div", { class: "li" }, el("span", { class: "tx" },
      el("div", { class: "hd", text: `${s.from ? `${s.from_label || s.from} → ` : ""}${s.to_label || s.to}` }),
      el("div", { class: "sup", text: `${kstStamp(Date.parse(s.at))} · ${s.reason || s.kind_text || KIND[s.kind] || s.kind}` })),
      el("button", { class: "ib", type: "button", "aria-label": "이 기록 지우기", onclick: () => drop(s.at, "기록을 지웠어요") }, icon("close")));
    const older = all.slice(SHOWN).map(row);
    older.forEach(n => { n.hidden = true; });
    const more = older.length ? el("button", { class: "btn text", type: "button", text: `이전 기록 ${older.length}개 더 보기`, onclick: ev => {
      const open = older[0].hidden;
      older.forEach(n => { n.hidden = !open; });
      ev.currentTarget.textContent = open ? "이전 기록 접기" : `이전 기록 ${older.length}개 더 보기`;
    } }) : null;
    box.append(el("div", { class: "list" },
      el("div", { class: "li", style: "display:block" }, el("div", { class: "hd", text: A.account_label || A.account }), el("div", { class: "sup", text: `${A.since ? `${kstStamp(Date.parse(A.since))}부터 · ` : ""}${A.pinned ? "고정한 계정이에요. 한도에 걸리면 다른 계정 대신 폴백 순서를 따라요" : "규칙이나 한도로 바뀌기 전까지 이 계정을 계속 써요"}` })),
      ...all.slice(0, SHOWN).map(row), ...older));
    if (more) box.append(more);
    if (all.length) box.append(el("button", { class: "btn text danger", type: "button", text: "기록 모두 지우기", onclick: () => dialog({ title: "기록을 모두 지울까요?", body: el("div", { class: "sup", text: `계정 전환 기록 ${all.length}개를 지워요. 되돌릴 수 없어요.` }), actions: [{ label: "취소" , onclick: c => c() }, { label: "모두 지우기", kind: "danger", onclick: c => { c(); drop("", "기록을 모두 지웠어요"); } }] }) }));
  }
  if ((q.unavailable || []).length) {
    box.append(el("div", { class: "sec", text: "정보가 없어요" }));
    box.append(el("div", { class: "list" }, ...q.unavailable.map(u => el("div", { class: "li", style: "display:block" }, el("div", { class: "hd", text: providerName(u.provider) }), el("div", { class: "sup", text: u.reason })))));
  }
  if (!(q.providers || []).length && !(q.unavailable || []).length) box.append(emptyNode("사용량 정보가 없어요"));
}
