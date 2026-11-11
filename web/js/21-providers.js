/* ---------- providers ---------- */
// Callers that ask while a read is out share it (the page's first read and the home's ask for it at the same time).
let provFlight = null;
function loadProviderData() { return provFlight || (provFlight = provFetch().finally(() => { provFlight = null; })); }
async function provFetch() {
  const r = await api("/api/providers");
  P = { providers: r.providers || [], addable: Array.isArray(r.addable) ? r.addable : null, at: Date.now() };
  return P;
}
// Opening settings reads the providers again only when the last read is older than a minute.
const provFresh = () => !!P && Date.now() - P.at < 60000;
let provFail = false;
async function loadProviders() {
  try { await loadProviderData(); provFail = false; }
  catch (e) { provFail = !P; }
  if (current === "accounts") renderAccounts();
}
// A usage window in plain Korean: the report's "Claude 5 Hour" / "Claude 7 Day Opus" read as 5시간 한도 / 7일 한도 Opus.
function limitName(l) {
  const m = /^Claude\s+(\d+)\s+(Hour|Day)s?\b\s*(.*)$/i.exec(l.label || "");
  if (!m) return l.label || l.id;
  const n = m[1], rest = m[3];
  return /hour/i.test(m[2]) ? (rest ? TX("settings.limit.hours_of", { n, rest }) : TX("settings.limit.hours", { n })) : (rest ? TX("settings.limit.days_of", { n, rest }) : TX("settings.limit.days", { n }));
}
// The window name without the word 한도, for the usage lines at the top of an account card: 5시간, 7일, 7일 Opus.
const limitShort = l => {
  const m = /^Claude\s+(\d+)\s+(Hour|Day)s?\b\s*(.*)$/i.exec(l.label || "");
  if (!m) return limitName(l);
  const n = m[1], rest = m[3];
  return /hour/i.test(m[2]) ? (rest ? TX("settings.limit.hours_short_of", { n, rest }) : TX("settings.limit.hours_short", { n })) : (rest ? TX("settings.limit.days_short_of", { n, rest }) : TX("settings.limit.days_short", { n }));
};
// The usage windows the report holds for one provider (the ones with a figure).
function provLimits(p) {
  const q = typeof SQ !== "undefined" && SQ ? (SQ.providers || []).find(x => x.provider === p.id || (p.id === "anthropic" && x.provider === "claude")) : null;
  return q ? (q.limits || []).filter(l => limitFrac(l) != null) : [];
}
// One provider's row on the 계정 screen: its way in (login or key), status, usage windows and actions. In a provider's own section
// (`own`) the section head names it; in 다른 공급자 the row does, and a key with a pool entry opens its alias.
function provRow(p, g, own) {
  const on = isConnected(p), key = p.auth === "api_key", tone = on ? "ok" : needsAttention(p) ? "warn" : "";
  const out = key ? TX("settings.prov.key_delete") : TX("settings.logout.btn");
  const act = p.can_add_account ? null
    : p.can_login ? el("button", { class: `btn inrow ${on ? "text" : "tonal"}`, type: "button", onclick: ev => busy(ev.currentTarget, () => startLogin(p)) }, on ? TX("settings.prov.relogin") : TX("settings.login")) : null;   // the start can take seconds: the button stays off until the dialog is up, so a second press cannot start a second login
  const rm = (p.can_logout ?? p.removable) ? el("button", { class: "ib", type: "button", title: out, "aria-label": out, onclick: ev => busy(ev.currentTarget, () => logoutProvider(p)) }, icon("trash")) : null;
  const slot = key && g ? g.accounts[0] : null;
  const sub = [slot && slot.label !== "API 키" && slot.label !== TX("settings.api_key") ? slot.label : "", p.account ? accName(p.account) : p.masked || "", p.in_use ? TX("settings.prov.in_use") : "", p.accounts > 1 ? TX("settings.prov.accounts_n", { n: p.accounts }) : ""].filter(Boolean).join(" · ");
  const tx = el("div", { class: "tx" }, el("div", { class: "heads" }, el("span", { class: "hd", text: own ? (key ? TX("settings.api_key") : TX("settings.login")) : p.name || p.id }),
      own && on ? null : el("span", { class: `tag ${tone}`, text: p.auth === "oauth" ? TX("settings.prov.signed_in") : key ? TX("settings.api_key") : TX("settings.prov.not_connected") })),
    sub ? el("div", { class: "sup", text: sub }) : null,
    ...provLimits(p).map(l => el("div", { class: "prow-lim" }, el("span", { class: "k", text: limitName(l) }), bar(l), el("span", { class: "v", text: pctText(l) }))));
  return el("div", { class: "li prow", "data-prov": own ? null : p.id, "data-prov-conn": p.id },
    slot ? el("button", { class: "acc-main", type: "button", onclick: () => accProviderDialog(g, slot) }, tx) : tx, liEnd(act, rm));
}
// 계정: one screen for what used to be 공급자, each provider's screen and the accounts block. OmO keeps a pool per provider, so the
// provider is the group: a login provider has its own section with its accounts, and the rest (keys, not set up) share one list.
function renderAccounts() {
  const box = $("#accounts");
  if (!P) { clear(box).append(emptyNode(provFail ? TX("settings.prov.load_failed") : TX("common.loading"), provFail ? () => loadProviders() : null)); return; }
  const groupOf = p => ((ACC && ACC.providers) || []).find(x => x.id === p.id);
  const own = p => p.auth === "oauth" || (p.id === "anthropic" && ACC && ACC.accounts.length > 0) || (groupOf(p) || {}).multi;
  const list = P.providers, rest = list.filter(p => !own(p));
  const wrap = el("div", {}, el("div", { class: "tools-bar" }, el("span", { class: "sup", text: TX("settings.prov.connected_n", { n: list.filter(isConnected).length }) }),
    el("button", { class: "btn tonal sm", type: "button", onclick: () => addProviderDialog() }, icon("add"), TX("settings.prov.add"))));
  if (!list.length) wrap.append(emptyNode(TX("settings.prov.none")));
  for (const p of list.filter(own)) wrap.append(...accSection(p, groupOf(p), provRow(p, groupOf(p), true)));
  // the ones that can log in come first, then the API keys and the providers not set up yet
  const canLogin = p => p.auth === "none" && p.can_login;
  if (rest.length) wrap.append(el("div", { class: "sec", text: TX("settings.prov.other") }), el("div", { class: "list" }, ...[...rest.filter(canLogin), ...rest.filter(p => !canLogin(p))].map(p => provRow(p, groupOf(p), false))));
  clear(box).append(wrap);
  // an old provider address or a home card lands on that provider, once both lists are in
  if (accFocus && ACC) { const n = box.querySelector(`[data-prov="${CSS.escape(accFocus)}"]`); accFocus = ""; if (n) n.scrollIntoView({ block: "start" }); }
}
function addProviderDialog() {
  const addable = P && P.addable;
  let pick = null, keyIn = null, free = null;
  const body = el("div", { class: "col", style: "gap:var(--sp-4)" });
  const keyBox = el("div", { class: "col kb" });
  const rowsByKey = new Map();
  let dlg;
  function paintKey() {
    clear(keyBox); keyIn = null;
    for (const [id, n] of rowsByKey) { n.classList.toggle("on", !!pick && pick.id === id); n.setAttribute("aria-pressed", pick && pick.id === id ? "true" : "false"); }
    if (pick && pick.kind === "api_key") { keyIn = input({ type: "password", autocomplete: "new-password" }); keyBox.append(textField(free ? TX("settings.api_key") : TX("settings.prov.key_of", { name: pick.name || pick.id }), keyIn)); if (!free) keyIn.focus(); }
    const actions = pick && pick.kind === "api_key" ? [{ label: TX("common.cancel"), kind: "tonal", onclick: c => c() }] : [];   // only a list to pick from: the ✕ is the one way out
    if (pick && pick.kind === "api_key") actions.push({ label: TX("common.save"), kind: "pri", onclick: (c, btn) => busy(btn, async () => {
      const provider = free ? free.value.trim() : pick.id, key = keyIn.value;
      if (!provider || !key.trim()) { toast(TX("settings.prov.need_key"), true); return; }
      try { await api("/api/providers", "POST", { provider, key }); } finally { keyIn.value = ""; }
      c(); toast(TX("settings.saved")); loadProviders(); loadModels(true);
    }) });
    dlg && dlg.setActions(actions);
  }
  const group = (title, items) => {
    const box = el("div", {}, el("div", { class: "sec", text: title }), el("div", { class: "list" }));
    for (const a of items) {
      const n = el("button", { type: "button", class: "li tap", "aria-pressed": "false", onclick: () => {
        if (a.kind === "oauth") { dlg.close(); startLogin(a); return; }
        pick = a; paintKey();
      } }, el("span", { class: "avatar", text: [...(a.name || a.id)][0] || "?" }), el("span", { class: "tx" }, el("div", { class: "hd", text: a.name || a.id })),
        liEnd(a.add_account ? el("span", { class: "sup", text: TX("settings.prov.add_account") }) : null, icon("chev")));   // the whole row is the tap target: the section says login or key, the arrow says it opens
      rowsByKey.set(a.id, n); box.lastChild.append(n);
    }
    return box;
  };
  if (addable) {
    const login = addable.filter(a => a.kind === "oauth"), keys = addable.filter(a => a.kind !== "oauth");
    if (!addable.length) body.append(el("p", { text: TX("settings.prov.nothing_to_add") }));
    else {
      const pk = el("div", { class: "pickbox" });
      if (login.length) pk.append(group(TX("settings.login"), login));
      if (keys.length) pk.append(group(TX("settings.api_key"), keys));
      body.append(pk, keyBox);
    }
  } else { free = input({ type: "text" }); pick = { kind: "api_key" }; body.append(textField(TX("settings.provider"), free), keyBox); }
  dlg = dialog({ title: TX("settings.prov.add"), body, mid: true });
  if (addable && !addable.length) dlg.setActions([]);
  else paintKey();
}
// A login still open (a closed tab, /login in the chat) blocks a new one: pick it up where it stopped, or drop it and start over.
function pendingLoginAsk(p, pending) {
  const same = pending.provider === p.id;
  const go = mode => c => { c(); startLogin(p, mode); };
  const dg = dialog({ confirm: true, title: TX("settings.login.pending_title"),
    body: same ? null : el("p", { text: TX("settings.login.pending_other", { name: providerName(pending.provider) }) }),
    actions: [{ label: TX("common.close"), onclick: c => c() }, ...(same
      ? [{ label: TX("settings.login.restart"), onclick: go("restart") }, { label: TX("settings.login.resume"), kind: "pri", onclick: go("resume") }]
      : [{ label: TX("settings.login.restart"), kind: "pri", onclick: go("restart") }])] });
  ovFocus(dg.node, dg.node.querySelector(".dact .btn.pri"));   // by the keyboard the main way out gets the focus, not the close beside it
}
async function startLogin(p, pending) {
  let r;
  try { r = await api(`/api/providers/${enc(p.id)}/login`, "POST", pending ? { pending } : {}); }
  catch (e) {
    if (!pending && e.data && e.data.pending) pendingLoginAsk(p, e.data.pending);
    else toast(e.message, true);
    return;
  }
  const name = p.name || p.id;
  let finished = false, timer, dlg;
  const code = input({ type: "text" });
  const msg = el("p", { class: "err-t", hidden: true });
  // A sign-in can ask its questions first (Claude: account name, then method) and name the page only in a later step, so the
  // dialog shows the step it is on: a question is the field's label with its default filled in, a choice is a list of rows,
  // and the page link and the code field come with the URL.
  const label = el("label", { for: code.id });
  const field = el("div", { class: "tf" }, label, code);
  const intro = el("p", { hidden: true });
  const how = el("p", { class: "sup", hidden: true });   // where the code comes from, and what to do with it
  const picks = el("div", { class: "list", hidden: true });
  const ask = el("div", { class: "sup", hidden: true });
  // One filled button at a time: the page link leads until it was opened, then 완료 does.
  const open = el("a", { class: "btn", target: "_blank", rel: "noopener noreferrer" }, icon("open"), TX("settings.login.open_page"));
  const openBox = el("div", {}, open);
  let lastUrl = "", opened = false, choosing = false, plain = false;
  const paintHow = () => {
    how.hidden = !plain;
    how.textContent = !lastUrl ? TX("settings.login.how_none") : opened ? TX("settings.login.how_opened") : TX("settings.login.how_open");
  };
  // 완료 stays off while there is nothing to send: the field is empty and has no default
  const syncDone = () => { const b = choosing ? null : dlg.node.querySelector(".dact .btn:last-child"); if (b && b.textContent === TX("settings.done")) b.disabled = !(code.value.trim() || code.placeholder); };
  const paintActs = () => {
    dlg.setActions([{ label: TX("common.cancel"), kind: "tonal", onclick: c => c() },
      ...(choosing ? [] : [{ label: TX("settings.done"), kind: openBox.hidden || opened ? "pri" : "tonal", onclick: (c, btn) => submit(btn) }])]);
    syncDone();
  };
  code.addEventListener("input", syncDone);
  open.addEventListener("click", () => { opened = true; open.className = "btn tonal"; paintHow(); paintActs(); });
  const paintStep = v => {
    if (/^https?:\/\//.test(v.url || "")) { if (v.url !== lastUrl) opened = false; lastUrl = v.url; }
    const choose = !!(v.options && v.options.length), url = !choose && !!lastUrl, question = !choose && !url && !!v.prompt;
    intro.textContent = choose ? v.prompt || "" : ""; intro.hidden = !choose || !v.prompt;
    plain = !choose && !question; paintHow();
    clear(picks); picks.hidden = !choose;
    for (const o of choose ? v.options : []) picks.append(el("button", { type: "button", class: "li tap", onclick: ev => { code.value = o; submit(ev.currentTarget); } },
      el("span", { class: "tx" }, el("div", { class: "hd", text: o })), icon("chev", "lead")));
    field.hidden = choose;
    label.textContent = question ? v.prompt : TX("settings.login.code_label");
    code.value = question && v.placeholder ? v.placeholder : "";
    code.placeholder = question && v.placeholder ? v.placeholder : "";
    ask.textContent = url ? v.prompt || "" : ""; ask.hidden = !url || !v.prompt;
    if (url) open.href = lastUrl; else open.removeAttribute("href");
    openBox.hidden = !url;
    open.className = opened ? "btn tonal" : "btn";
    choosing = choose;
    paintActs();
  };
  const stop = () => { clearTimeout(timer); };
  // the hub says what the login did to the pool: a new account, or one it already held and refreshed (hub/providers.ts loginResult)
  const success = async s => {
    finished = true; stop(); dlg.close();
    toast(s.outcome === "refreshed" ? TX("settings.login.refreshed", { account: accLabel(s.account) }) : s.outcome === "added" ? TX("settings.login.added", { account: s.account }) : TX("settings.login.done", { name }));
    try { await loadProviderData(); } catch {}
    if (current === "accounts") renderAccounts();
    if (current === "home") renderHome();
    loadModels(true);
    loadAccounts();
  };
  const fail = text => { msg.textContent = text; msg.hidden = false; };
  const poll = async () => {
    try {
      const s = await api(`/api/providers/${enc(p.id)}/login?login_id=${enc(r.login_id)}`);
      if (finished) return;
      if (s.status === "done") { success(s); return; }
      if (s.status === "failed") { stop(); fail(s.error || TX("settings.login.failed")); return; }
    } catch {}
    if (!finished) timer = setTimeout(poll, 2000);
  };
  const submit = btn => busy(btn, async () => {
    const v = code.value.trim() || code.placeholder;
    if (!v) { fail(TX("settings.login.need_code")); return; }
    msg.hidden = true;
    stop();
    try {
      const s = await api(`/api/providers/${enc(p.id)}/login/complete`, "POST", { login_id: r.login_id, code: v });
      // a sign-in with more than one step answers with the next question instead of finishing
      if (s.status === "waiting") { paintStep(s); code.focus(); timer = setTimeout(poll, 2000); return; }
      await success(s);
    }
    catch (e) { fail(e.message); if (!finished) timer = setTimeout(poll, 2000); }
  });
  dlg = dialog({
    title: p.can_add_account || p.add_account ? TX("settings.login.title_add", { name }) : TX("settings.login.title", { name }),
    body: [intro, how, openBox, field, ask, picks, msg], mid: true,
    onclose: () => { stop(); if (!finished) api(`/api/providers/${enc(p.id)}/login`, "DELETE").catch(() => {}); },
  });
  paintStep(r);
  const first = choosing ? null : openBox.hidden ? code : open; if (first) first.focus({ preventScroll: true });   // not the ✕ in the head
  code.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); const b = dlg.node.querySelector(".dact .btn:last-child"); if (b) b.click(); } });
  timer = setTimeout(poll, 2000);
}

/* ---------- usage ---------- */
let quotaTimer;
// 리셋권 of one account (hub/codex-usage.ts, Claude: hub/usage-account.ts claudeResets): how many it holds (Claude: by kind) and the nearest
// expiry. 사용 works only with one usable, and asks first, naming the pass (Claude) or the limits it refills and how many stay; only that
// confirm sends POST /api/quota/reset-credit with confirm: true.
// A Claude account draws one row per kind (주간, Fable, ...), each with its own count, expiry and grant; without kinds, and for Codex, one row.
function resetRow(p, name) {
  const ks = p.provider === "anthropic" && p.resets.kinds && p.resets.kinds.length ? p.resets.kinds : [null];
  return ks.map(k => resetLine(p, name, k));
}
function resetLine(p, name, k) {
  const r = p.resets, claude = p.provider === "anthropic", wins = (p.limits || []).map(limitName).reduce((a, b) => a ? TX("settings.reset.pair", { a, b }) : b, "");
  const held = k ? k.left : r.held, usable = k ? k.usable : r.usable, expires = k ? k.expires_at : r.expires_at, grant = k ? (k.grant_id ? { id: k.grant_id, kind: k.kind } : null) : r.grant;
  const label = k ? TX("settings.reset.kind_label", { kind: k.kind }) : TX("settings.reset.label");
  const why = !claude && r.held && !r.usable ? TX("settings.reset.when_limited") : "";
  const sub = [held && expires ? TX("settings.reset.expires", { day: dayLabel(expires) }) : "", why].filter(Boolean).join(" · ");
  const say = { reset: TX("settings.reset.say.reset"), nothing_to_reset: TX("settings.reset.say.nothing"), not_limited: TX("settings.reset.say.nothing"), no_credit: TX("settings.reset.say.no_credit"), already_redeemed: TX("settings.reset.say.used"), already_used: TX("settings.reset.say.used"), cooldown: TX("settings.reset.say.cooldown") };
  const body = claude ? (grant ? TX("settings.reset.body_kind", { name, account: p.account_label || p.account, kind: grant.kind, label, n: held - 1 }) : TX("settings.reset.body_claude", { name, account: p.account_label || p.account, label, n: held - 1 })) : TX("settings.reset.body_codex", { name, account: p.account, wins: wins || TX("common.limit"), label, n: held - 1 });
  const send = claude ? { provider: "anthropic", account: p.account, grant_id: grant && grant.id, confirm: true } : { account: p.account, confirm: true };
  const use = () => dialog({ confirm: true, title: TX("settings.reset.ask_title"),
    body: el("div", { class: "sup", text: body }),
    actions: [{ label: TX("common.cancel"), onclick: c => c() }, { label: TX("settings.reset.use"), kind: "pri", onclick: (c, b) => busy(b, async () => {
      // whatever the answer, the usage is read again so the percent and the 리셋권 count on screen are the server's
      try { const out = await api("/api/quota/reset-credit", "POST", send); c(); toast(say[out.outcome] || TX("settings.reset.used")); }
      catch (e) { c(); toast(e.message || TX("settings.reset.use_failed"), true); }
      finally { loadQuota(true); }
    }) }] });
  return el("div", { class: "lim rc" },
    el("div", { class: "kv" }, el("span", { class: "k", text: label }),
      el("span", { class: "rc-end" }, el("b", { text: TX("settings.reset.held", { n: held }) }), el("button", { class: "btn tonal inrow", type: "button", disabled: !(held > 0 && usable), "aria-label": TX("settings.reset.use_aria", { name, label }), onclick: use }, TX("settings.use")))),
    sub ? el("div", { class: "sup", text: sub }) : null);
}
// The bar above the cards: when it was read, and the one 새로고침 (also the way out of a failed read: no second retry button).
const quotaBar = at => el("div", { class: "tools-bar" }, el("span", { class: "sup", text: at ? monTime(at) : "" }),
  el("button", { class: "btn text sm", type: "button", onclick: ev => busy(ev.currentTarget, () => loadQuota(true)) }, icon("refresh"), TX("settings.refresh")));
// The same 새로고침 at the right end of the first card's head (the screen has no bar of its own above the cards), with when it was read.
const usRefresh = at => [at ? el("span", { class: "sup", text: monTime(at) }) : null,
  el("button", { class: "btn text inrow", type: "button", onclick: ev => busy(ev.currentTarget, () => loadQuota(true)) }, icon("refresh"), TX("settings.refresh"))].filter(Boolean);
// One limit's bar and share left for the cards: a gauge (01-motion-gauge.js) keyed by the account's own window, so a read that raises
// what is left fills the bar and counts the number from what the card showed, and a card drawn on opening shows the value as it is.
function limitGauge(key, l) {
  const f = limitFrac(l), track = bar(l);
  if (f == null) return { num: el("b", { text: pctText(l) }), track };
  const t = gaugeSplit(TX("base.pct_left", { n: GAUGE_MARK })), fill = track.firstChild;
  fill.classList.add("gfill");
  gaugeSet(key, f * 100, s => { fill.style.width = `${s.w.toFixed(2)}%`; gaugeNum(t.sp, s); });
  return { num: el("b", {}, ...t.nodes), track };
}
let quotaDrawn = 0;
async function loadQuota(fresh) {
  clearTimeout(quotaTimer);
  const box = $("#usage");
  if (!box.firstChild) box.append(emptyNode(TX("common.loading")));
  let q;
  // the cards are titled by provider name (providerName reads P), so a direct open of 사용량 loads the providers too
  try { [q] = await Promise.all([api(fresh === true ? "/api/quota?fresh=1" : "/api/quota"), P ? null : loadProviderData().catch(() => null)]); }
  catch (e) { clear(box).append(quotaBar(""), emptyNode(TX("settings.usage.load_failed"))); return; }
  noteQuota(q);
  if (current === "usage") quotaTimer = setTimeout(loadQuota, 60000);
  paintQuota(q);
}
// Draws the usage screen from one read, a fetched one or the one the gateway pushed. A read older than the one on screen is dropped,
// so a slow answer cannot put smaller numbers back after a recovery has shown.
function paintQuota(q) {
  if (q.fetched_at < quotaDrawn) return;
  quotaDrawn = q.fetched_at || 0;
  const box = $("#usage");
  clear(box);
  const grid = el("div", { class: "grid" });
  for (const p of q.providers || []) {
    // a subscription names its plan as Anthropic does (Pro, Max 5x, Max 20x, Ultra, ...; hub/usage-account.ts planName)
    const name = p.name || providerName(p.provider);
    const card = el("div", { class: "card" }, el("div", { class: "ch lo" }, el("h3", { text: p.plan ? `${name} · ${p.plan}` : name })));
    for (const l of p.limits || []) {
      const g = limitGauge(`usage:${p.provider}|${p.account || ""}|${l.id}`, l);
      card.append(el("div", { class: "lim" },
        el("div", { class: "kv" }, el("span", { class: "k", text: limitName(l) }), g.num),
        g.track,
        l.resets_at ? el("div", { class: "sup", text: rel(l.resets_at) }) : null));
    }
    if (!(p.limits || []).length) card.append(el("div", { class: "sup", text: TX("settings.usage.no_limits") }));
    if (p.resets) card.append(...resetRow(p, name));
    grid.append(card);
  }
  // The monthly API spend limit the owner set on the platform console, and how much of it is used (hub/api-budget.ts).
  if (q.budget) grid.prepend(budgetCard(q.budget));
  else box.append(el("div", { class: "list" }, budgetRow()));
  if (grid.children.length) box.append(grid);
  const firstHead = grid.querySelector(".ch");
  if (firstHead) firstHead.append(...usRefresh(q.fetched_at)); else box.prepend(quotaBar(q.fetched_at));
  // The one Claude account the assistant and its lanes run on, and every switch with its reason (hub/account-sticky.ts).
  if (q.account && q.account.account) {
    const A = q.account, KIND = { start: TX("settings.usage.kind.start"), limit: TX("common.limit"), owner: TX("settings.usage.kind.owner"), gone: TX("settings.usage.kind.gone") };
    box.append(el("div", { class: "sec", text: TX("settings.usage.account") }));
    // The latest 5 switches (newest first); the older ones (the hub keeps 20) fold behind a toggle.
    const SHOWN = 5, all = A.switches || [];
    // Entries older than 3 days are pruned by the hub; the X deletes one entry, 모두 지우기 (confirmed) all of them (DELETE /api/accounts/switches).
    const drop = async (at, msg) => { try { await api(`/api/accounts/switches${at ? `?at=${enc(at)}` : ""}`, "DELETE"); toast(msg); loadQuota(); } catch (e) { toast(TX("settings.usage.clear_failed"), true); } };
    // the why is said once: the reason line, or the kind when there is no reason
    const row = s => el("div", { class: "li" }, el("span", { class: "tx" },
      el("div", { class: "hd", text: `${s.from ? `${s.from_label || s.from} → ` : ""}${s.to_label || s.to}` }),
      el("div", { class: "sup", text: `${monTime(Date.parse(s.at))} · ${s.reason || s.kind_text || KIND[s.kind] || s.kind}` })),
      el("button", { class: "ib", type: "button", "aria-label": TX("settings.usage.clear_one"), onclick: () => drop(s.at, TX("settings.usage.cleared_one")) }, icon("close")));
    const older = all.slice(SHOWN).map(row);
    older.forEach(n => { n.hidden = true; });
    const more = older.length ? el("button", { class: "btn text", type: "button", text: TX("settings.usage.more_n", { n: older.length }), onclick: ev => {
      const open = older[0].hidden;
      older.forEach(n => { n.hidden = !open; });
      ev.currentTarget.textContent = open ? TX("settings.usage.less") : TX("settings.usage.more_n", { n: older.length });
    } }) : null;
    const cur = [A.since ? TX("settings.usage.since", { at: monTime(Date.parse(A.since)) }) : "", A.pinned ? TX("settings.usage.pinned") : ""].filter(Boolean).join(" · ");
    box.append(el("div", { class: "list" },
      el("div", { class: "li", style: "display:block" }, el("div", { class: "hd", text: A.account_label || A.account }), cur ? el("div", { class: "sup", text: cur }) : null),
      ...all.slice(0, SHOWN).map(row), ...older));
    if (more) box.append(more);
    if (all.length) box.append(el("button", { class: "btn text danger", type: "button", text: TX("settings.usage.clear_all"), onclick: () => dialog({ confirm: true, title: TX("settings.usage.clear_all_ask"), body: el("div", { class: "sup", text: TX("settings.usage.clear_all_body", { n: all.length }) }), actions: [{ label: TX("common.cancel") , onclick: c => c() }, { label: TX("settings.usage.clear_all_btn"), kind: "danger fill", onclick: c => { c(); drop("", TX("settings.usage.cleared_all")); } }] }) }));
  }
  if ((q.unavailable || []).length) {
    box.append(el("div", { class: "sec", text: TX("settings.usage.unavailable") }));
    box.append(el("div", { class: "list" }, ...q.unavailable.map(u => el("div", { class: "li", style: "display:block" }, el("div", { class: "hd", text: u.name || providerName(u.provider) }), el("div", { class: "sup", text: u.reason })))));
  }
  if (!(q.providers || []).length && !(q.unavailable || []).length && !q.budget) box.append(emptyNode(TX("settings.usage.empty")));
}
