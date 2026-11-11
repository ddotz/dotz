/* ---------- settings: 계정 (/api/accounts: aliases, current account and why, switch rules, script) ---------- */
let ACC = null;
const ACC_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d, i) => [d, new Intl.DateTimeFormat(TX_LOCALE, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + i)))]);
const ACC_COND = [["", TX("connect.cond.none")], ["five_hour_left_below", TX("connect.cond.five_hour")], ["seven_day_left_below", TX("connect.cond.week")], ["rate_limited", TX("common.status.rate_limited")], ["auth_error", TX("connect.cond.auth")], ["unavailable", TX("connect.cond.unavailable")]];
const ACC_DO = [["pin", TX("connect.do.pin")], ["prefer", TX("connect.do.prefer")], ["auto", TX("connect.do.auto")]];
const accTx = (hd, ...sup) => el("span", { class: "tx" }, hd ? el("div", { class: "hd", text: hd }) : null, sup.length ? el("div", { class: "sup" }, ...sup) : null);
async function loadAccounts() {
  try { ACC = await api("/api/accounts"); } catch { ACC = null; }
  accPaint();
}
let accFocus = "";   // the provider an old address or a home card asked for (21-providers.js renderAccounts)
const accPaint = () => { if (current === "accounts") renderAccounts(); else if (current === "settings") renderSettings(); };
const accName = n => (n === "default" ? TX("connect.acc.default") : n);   // the stored name stays "default"; the screen says 기본
// A provider's section head on the 계정 screen: its name, 사용 중 on the right while requests go through it, and (a provider with no account yet) `add` for its first login.
const accHead = (p, g, add) => el("div", { class: "sec sec-act", "data-prov": p.id }, (g || p).name || p.id, p.in_use ? el("span", { class: "tag pri acc-use", text: TX("settings.fb.in_use") }) : null, add ? el("button", { class: "btn tonal sm", type: "button", "data-acc-add": "", onclick: () => startLogin({ id: p.id, name: (g || p).name || p.id, add_account: true }) }, icon("add"), TX("settings.prov.add_account")) : null);
// The rows of a card that holds accounts: the usage windows on top (none for a provider that reports none), a small section name, and 계정 추가 at the foot of the accounts.
const accLimRow = p => { const ls = provLimits(p); return ls.length ? el("div", { class: "li prow" }, el("div", { class: "tx" }, ...ls.map(l => el("div", { class: "prow-lim" }, el("span", { class: "k", text: limitShort(l) }), bar(l), el("span", { class: "v", text: pctText(l) }))))) : null; };
const accLbl = text => el("div", { class: "li acc-lbl" }, el("span", { class: "lbl", text }));
const accAddRow = (p, g) => el("button", { class: "li tap acc-add", type: "button", "data-acc-add": "", onclick: () => startLogin({ id: p.id, name: (g || p).name || p.id, add_account: true }) }, icon("add"), el("span", { class: "tx", text: TX("settings.prov.add_account") }));
// Only an account whose login ran out gets this; the row itself still opens its window.
const accRelogin = p => el("button", { class: "btn text inrow", type: "button", "data-acc-relogin": p.id, onclick: () => startLogin(p) }, TX("settings.prov.relogin"));
const accSection = (p, g, conn) => (p.id === "anthropic" ? accountSection(p, g, conn) : accProviderSection(p, g, conn));
const accLabel = id => { const a = ACC && ACC.accounts.find(x => x.name === id || x.alias === id); return a ? accName(a.label || a.alias || a.name) : id; };
// `err` (a dialog's usErr note): a failure stays in that dialog; without it a failure is a toast
const accMut = (btn, call, msg, close, err) => {
  const run = async () => { ACC = await call(); if (close) close(); if (msg) toast(msg); accPaint(); if (current === "usage") loadQuota(); };
  return err ? usRun(btn, err, run) : busy(btn, run);
};
async function accCopy(text) { try { await navigator.clipboard.writeText(text); toast(TX("connect.copied")); } catch { toast(TX("chat.att.copy_failed"), true); } }
function accTags(a, pin) {
  const t = [];
  // a.current: the account requests really use (OmO skips a blocked one); blocked_tag: "한도 걸림 · 01:00까지"
  // 고정: the fixed account (pin) carries the badge instead
  if (pin ? a.name === pin : a.current) t.push([pin ? TX("connect.acc.in_use_pinned") : TX("settings.fb.in_use"), "pri"]);
  if (a.blocked && a.blocked !== "auth_error") t.push([a.blocked_tag || TX("settings.fb.down.unavailable"), "warn"]);   // a limit only time fixes: orange; a lost login has the 다시 로그인 button instead
  return t;
}
// Drag a 계정 row to reorder: from its grip at once (after a 4px move), or after a long press on the row (touch; a move before that is a scroll).
// The row lifts, the rows it passes shift, and the drop calls onDrop(newIndex). The listeners live on the document, so a pointer that leaves the row keeps dragging.
let accSwallow = false; // the click that follows a drop must not pick the row; the next pointerdown clears it
function accDrag(ev, row, longPress, onDrop) {
  if (!row || !ev.isPrimary || (ev.pointerType === "mouse" && ev.button !== 0)) return;
  const list = row.parentNode, rows = [...list.querySelectorAll(":scope > .li.acc")], from = rows.indexOf(row);
  const rects = rows.map(r => r.getBoundingClientRect()), h = rects[from].height, y0 = ev.clientY, id = ev.pointerId;
  let to = from, dragging = false, timer = 0;
  const shift = (r, dy) => { r.style.transform = dy ? `translateY(${dy}px)` : ""; };
  const begin = () => { dragging = true; row.classList.add("drag"); list.classList.add("acc-dragging"); };
  const move = e => {
    if (e.pointerId !== id) return;
    const dy = e.clientY - y0;
    if (!dragging) {
      if (Math.abs(dy) < (longPress ? 8 : 4) && Math.abs(e.clientX - ev.clientX) < (longPress ? 8 : 4)) return;
      if (longPress) return end(false);
      begin();
    }
    const c = rects[from].top + h / 2 + dy;
    to = rects.filter((r, i) => i !== from && r.top + r.height / 2 < c).length;
    shift(row, dy);
    rows.forEach((r, i) => { if (i !== from) shift(r, from < to && i > from && i <= to ? -h : from > to && i < from && i >= to ? h : 0); });
  };
  const touch = e => { if (dragging) e.preventDefault(); };
  const key = e => { if (e.key === "Escape") end(false); };
  function end(drop) {
    clearTimeout(timer);
    for (const [t, fn, o] of [["pointermove", move], ["pointerup", up], ["pointercancel", cancel], ["touchmove", touch, { passive: false }], ["keydown", key]]) document.removeEventListener(t, fn, o);
    if (dragging) { accSwallow = true; document.addEventListener("pointerdown", () => { accSwallow = false; }, { capture: true, once: true }); rows.forEach(r => shift(r, 0)); row.classList.remove("drag"); list.classList.remove("acc-dragging"); }
    if (dragging && drop && to !== from) onDrop(to);
  }
  function up(e) { if (e.pointerId === id) end(true); }
  function cancel(e) { if (e.pointerId === id) end(false); }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("touchmove", touch, { passive: false });
  document.addEventListener("keydown", key);
  if (longPress) timer = setTimeout(begin, 450);
  else ev.preventDefault();
}
function accountSection(p, g, conn) {
  if (!ACC) return [accHead(p, g, p.can_add_account), el("div", { class: "list" }, conn)];
  const dec = ACC.decision, sc = ACC.script, lines = ACC.rules_text || [], pct = n => `${Math.round(n)}%`;
  const tx = (hd, ...sup) => el("span", { class: "tx" }, hd ? el("div", { class: "hd", text: hd }) : null, sup.length ? el("div", { class: "sup" }, ...sup) : null);
  // two modes: 자동 전환 (rules, and a switch when the account is blocked) or 고정 (one account, requests never move to another)
  const pinned = ACC.mode === "pinned", ch = ACC.chosen, pin = pinned && ch ? ch.name : "";
  const setMode = (btn, body, msg) => accMut(btn, () => api("/api/accounts/mode", "PUT", body), msg);
  // the order is the fallback order of 자동 전환: the first usable account by number takes over when the current one is blocked
  const reorder = (btn, from, to) => { const names = ACC.accounts.map(x => x.name); names.splice(to, 0, names.splice(from, 1)[0]); return accMut(btn, () => api("/api/accounts/order", "PUT", { order: names })); };
  const accRows = ACC.accounts.map((a, i) => {
    const label = accName(a.label || a.alias || a.name);
    // every account's own windows with their reset time (the group mirrors OmO's usage file), else the two numbers dotz read
    const wins = ((g && g.accounts.find(x => x.name === a.name)) || {}).windows || [];
    const sub = [accName(a.name) !== label ? accName(a.name) : "", ...(wins.length ? accUsage(wins) : a.five_hour_left != null || a.seven_day_left != null ? [a.five_hour_left != null ? TX("connect.acc.left_5h", { pct: pct(a.five_hour_left) }) : "", a.seven_day_left != null ? TX("connect.acc.left_week", { pct: pct(a.seven_day_left) }) : ""] : [ACC_NO_USAGE])].filter(Boolean).join(" · ");
    // 고정: tapping a row fixes that account; 자동 전환: tapping it opens its name and details (not the click right after a drag)
    const onclick = ev => { if (accSwallow) { accSwallow = false; return; } if (pinned) { if (a.name !== pin) setMode(ev.currentTarget, { mode: "pinned", account: a.name }, TX("connect.acc.pin_changed")); } else accDialog(a); };
    const rowOf = ev => ev.currentTarget.closest(".li.acc");
    // the grip drags at once; a long press on the row drags too (touch); ArrowUp/ArrowDown on the focused grip moves it one place
    const grip = el("button", { class: "acc-grip", type: "button", "data-acc": a.name, "aria-label": TX("connect.acc.reorder", { name: label }), "aria-keyshortcuts": "ArrowUp ArrowDown",
      onpointerdown: ev => accDrag(ev, rowOf(ev), false, to => reorder(ev.target.closest(".acc-grip"), i, to)),
      onkeydown: ev => {
        const to = i + (ev.key === "ArrowUp" ? -1 : ev.key === "ArrowDown" ? 1 : 0);
        if (to === i || to < 0 || to >= ACC.accounts.length) return;
        ev.preventDefault();
        Promise.resolve(reorder(ev.currentTarget, i, to)).then(() => globalThis.document?.querySelector(`.acc-grip[data-acc="${CSS.escape(a.name)}"]`)?.focus());
      } });
    return el("div", { class: `li acc${pinned && a.name === pin ? " on" : ""}` }, grip,
      el("button", { class: "acc-main", type: "button", ...(pinned ? { role: "radio", "aria-checked": String(a.name === pin) } : {}), onclick,
        onpointerdown: ev => { if (ev.pointerType !== "mouse") accDrag(ev, rowOf(ev), true, to => reorder(ev.target.closest(".acc-main"), i, to)); } },
        el("span", { class: "lead acc-no", text: String(a.order || i + 1) }), tx(label, sub), ...accTags(a, pin).map(([t, tone]) => el("span", { class: `tag ${tone}`, text: t }))),
      a.blocked === "auth_error" ? accRelogin(p) : null,
      pinned ? el("button", { class: "acc-mv", type: "button", "aria-label": TX("connect.acc.rename", { name: label }), onclick: () => accDialog(a) }, icon("chev", "lead")) : null);
  });
  const rows = [];
  const caption = pinned ? (ch && ch.blocked ? `${ch.text}.` : TX("connect.acc.pinned_note", { name: ch ? accName(ch.label) : TX("connect.acc.chosen") })) : "";
  // on = 자동 전환, off = 고정 (the account to fix is the row tapped below)
  rows.unshift(el("div", { class: "li" }, tx(TX("connect.acc.auto"), ...(caption ? [caption] : [])),
    liEnd(el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(!pinned), "aria-label": TX("connect.acc.auto"), onclick: ev => setMode(ev.currentTarget, { mode: pinned ? "auto" : "pinned" }, pinned ? TX("connect.acc.auto_done") : TX("connect.acc.pin_done")) }))));
  // What a 고정 account at its limit does next: unset asks once (the alert's question), then this is followed quietly.
  const onLimit = (ACC.rules && ACC.rules.on_limit) || "";
  const onLimitSub = onLimit === "switch" ? TX("connect.limit.switch_sub") : onLimit === "wait" ? TX("connect.limit.wait_sub") : TX("connect.limit.unset_sub");
  const setOnLimit = (btn, value) => accMut(btn, () => api("/api/accounts/on-limit", "PUT", { on_limit: value }), value === "wait" ? TX("connect.limit.wait_done") : TX("connect.limit.switch_done"));
  rows.splice(1, 0, el("div", { class: "li" }, tx(TX("connect.limit.ask"), onLimitSub),
    liEnd(rowToggle({ label: TX("connect.limit.ask"), opts: [["wait", TX("connect.limit.wait")], ["switch", TX("connect.acc.auto")]], value: onLimit, onPick: (v, btn) => setOnLimit(btn, v) }))));
  if (!pinned) {
    rows.push(el("div", { class: "li" }, tx(TX("connect.rules.title"), lines.length ? [lines[0].text, lines.length > 1 ? TX("settings.upd.more_n", { n: lines.length - 1 }) : ""].filter(Boolean).join(" · ") : TX("connect.rules.none")), liEnd(el("button", { class: "btn tonal inrow", type: "button", onclick: () => rulesDialog() }, TX("connect.edit")))));
  }
  const run = sc && [sc.timeout_ms ? TX("connect.script.timeout", { n: Math.round(sc.timeout_ms / 1000) }) : "", sc.every_minutes ? TX("connect.script.every", { n: sc.every_minutes }) : ""].filter(Boolean).join(" · ");
  if (!pinned && sc && sc.path) rows.push(el("button", { class: "li tap", type: "button", title: sc.path, onclick: () => accCopy(sc.path) }, tx(TX("project.rt.script"), el("code", { class: "path-short", text: shortPath(sc.path) }), run ? ` · ${run}` : "")));
  const last = sc && sc.last;
  if (!pinned && last) rows.push(el("div", { class: "li" }, tx(last.error || last.error_text ? TX("connect.script.failed") : TX("connect.script.last", { result: last.label || (last.account ? accLabel(last.account) : TX("connect.script.none")) }), [last.error_text || last.reason, last.at ? kstStamp(Date.parse(last.at)) : ""].filter(Boolean).join(" · "))));
  rows.push(el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: TX("settings.models.reply_note") }))));
  // accounts first (their usage on top); a provider with none keeps its login row and the 계정 추가 button in the head
  const hasAcc = accRows.length > 0;
  const top = hasAcc ? [accLimRow(p), accLbl(TX("common.accounts")), ...accRows, p.can_add_account ? accAddRow(p, g) : null] : [conn];
  return [accHead(p, g, !hasAcc && p.can_add_account), el("div", { class: "list", "data-prov-conn": hasAcc ? p.id : null }, ...top.filter(Boolean), accLbl(TX("connect.limit.title")), ...rows)];
}
// An account's usage as row parts: what is left in each window, then the soonest reset still ahead (one reset per row, not one per window).
// A logged-in subscription account whose usage has not been read yet (it has made no request so far).
const ACC_NO_USAGE = TX("connect.acc.no_usage");
const accUsage = ws => { const next = Math.min(...ws.map(w => w.resets_at).filter(t => t > Date.now())); return [...ws.map(w => TX("connect.acc.left", { label: w.label, pct: Math.round(w.left) })), ...(Number.isFinite(next) ? [rel(next)] : [])]; };
// A provider OmO holds accounts for besides Claude 구독 (its own block above): its login row, then its accounts with their state and usage
// windows, and an empty state when the pool has none.
function accProviderSection(p, g, conn) {
  const add = p.can_add_account || (g && g.can_add);
  if (!g || !g.accounts.length) {
    const rows = [conn];
    if (g) rows.push(el("div", { class: "li" }, accTx(TX("connect.acc.none", { name: g.name }), g.can_add ? TX("connect.acc.none_add") : TX("connect.acc.none_login"))));
    return [accHead(p, g, add), el("div", { class: "list" }, ...rows)];
  }
  const rows = [];
  for (const a of g.accounts) {
    const sub = accUsage(a.windows || []).join(" · ");
    const tags = [];
    if (a.current) tags.push([TX("settings.fb.in_use"), "pri"]);
    if (a.pinned) tags.push([TX("project.group.pinned"), "ok"]);
    if (a.blocked && a.blocked !== "auth_error") tags.push([a.blocked_tag || TX("settings.fb.down.unavailable"), "warn"]);
    const label = accName(a.label || a.name);
    rows.push(el("div", { class: `li acc gen${a.current ? " on" : ""}` },
      el("button", { class: "acc-main", type: "button", onclick: () => accProviderDialog(g, a) },
        el("span", { class: "lead acc-no", text: String(a.order) }), accTx(label, sub), ...tags.map(([t, tone]) => el("span", { class: `tag ${tone}`, text: t }))),
      a.blocked === "auth_error" ? accRelogin(p) : null));
  }
  return [accHead(p, g), el("div", { class: "list", "data-prov-conn": p.id }, ...[accLimRow(p), accLbl(TX("common.accounts")), ...rows, add ? accAddRow(p, g) : null].filter(Boolean))];
}
// One account of another provider: its alias (kept per provider so two pools can hold the same account name), OmO's pin, deletion.
// The delete actions stand together on the left of the button row; the rest (pin, save) stay on the right.
function acGap(list) {
  const k = list.findLastIndex(a => a.kind === "danger");
  return k < 0 ? list : list.map((a, i) => (i === k ? { ...a, kind: "danger ac-gap" } : a));
}
function accProviderDialog(g, a) {
  const label = accName(a.label || a.name);
  const key = `${g.id}:${a.name}`;
  const inp = el("input", { class: "fi", type: "text", value: a.label !== a.name ? a.label : "", maxlength: "40", autocomplete: "off", placeholder: TX("connect.alias.ph"), "aria-label": TX("connect.alias") });
  const err = usErr();
  const alias = (v, msg) => (btn, close) => accMut(btn, () => api("/api/accounts/alias", "PUT", { key, alias: v }), msg, close, err);
  const actions = [
    g.can_delete ? { label: TX("connect.acc.delete"), kind: "danger", onclick: async (c, b) => { b.disabled = true; if (!await ask(TX("connect.delete_named", { name: label }), TX("connect.acc.delete_body"), TX("common.delete"), true)) { b.disabled = false; return; } accMut(b, () => api(`/api/accounts?provider=${enc(g.id)}&name=${enc(a.name)}`, "DELETE"), TX("connect.acc.deleted", { name: label }), c, err); } } : null,
    g.can_pin ? (a.pinned ? { label: TX("connect.acc.unpin"), kind: "tonal", onclick: (c, b) => accMut(b, () => api("/api/accounts/pin", "PUT", { provider: g.id, account: null }), TX("connect.acc.unpinned"), c, err) } : { label: TX("connect.acc.pin_this"), kind: "tonal", onclick: (c, b) => accMut(b, () => api("/api/accounts/pin", "PUT", { provider: g.id, account: a.name }), TX("connect.acc.pinned_to", { name: label }), c, err) }) : null,
    { label: TX("common.save"), kind: "pri", onclick: (c, b) => alias(inp.value.trim(), inp.value.trim() ? TX("connect.alias.saved") : TX("connect.alias.removed"))(b, c) },
  ].filter(Boolean);
  const d = dialog({ classic: true, title: `${g.name} · ${label}`, body: el("div", { class: "col" }, accName(a.name) !== label ? el("div", { class: "sup" }, TX("connect.acc.name_prefix"), el("code", { text: accName(a.name) })) : null, el("div", {}, el("div", { class: "lbl", style: "margin:0 0 var(--sp-15)", text: TX("connect.alias") }), inp), err), actions: acGap(actions) });
  inp.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); d.node.querySelector(".dact .btn:last-child").click(); } });
  usDirty(d, [inp]);
  inp.focus();
}
function accDialog(a) {
  const label = accName(a.label || a.alias || a.name);
  const inp = el("input", { class: "fi", type: "text", value: a.alias || "", maxlength: "40", autocomplete: "off", placeholder: TX("connect.alias.ph"), "aria-label": TX("connect.alias") });
  const err = usErr();
  const alias = (v, msg) => (btn, close) => accMut(btn, () => api("/api/accounts/alias", "PUT", { key: a.name, alias: v }), msg, close, err);
  // the only account cannot be deleted from the pool; leaving it is the provider's 로그아웃 (the card has no trash can)
  const out = ACC.accounts.length > 1 ? null : (P.providers || []).find(x => x.id === "anthropic" && (x.can_logout ?? x.removable));
  const d = dialog({ classic: true, title: label, body: el("div", { class: "col" }, accName(a.name) !== label ? el("div", { class: "sup" }, TX("connect.acc.name_prefix"), el("code", { text: accName(a.name) })) : null, el("div", {}, el("div", { class: "lbl", style: "margin:0 0 var(--sp-15)", text: TX("connect.alias") }), inp), err), actions: acGap([
    ACC.accounts.length > 1 ? { label: TX("connect.acc.delete"), kind: "danger", onclick: async (c, b) => { b.disabled = true; if (!await ask(TX("connect.delete_named", { name: label }), TX("connect.acc.delete_body"), TX("common.delete"), true)) { b.disabled = false; return; } accMut(b, () => api(`/api/accounts?name=${enc(a.name)}`, "DELETE"), TX("connect.acc.deleted", { name: label }), c, err); } } : out ? { label: TX("settings.logout.btn"), kind: "danger", onclick: c => { c(); logoutProvider(out); } } : null,
    { label: TX("connect.acc.pin_this"), kind: "tonal", disabled: ACC.mode === "pinned" && ACC.chosen && ACC.chosen.name === a.name, onclick: (c, b) => accMut(b, () => api("/api/accounts/mode", "PUT", { mode: "pinned", account: a.name }), TX("connect.acc.pinned_to", { name: label }), c, err) },
    { label: TX("common.save"), kind: "pri", onclick: (c, b) => alias(inp.value.trim(), inp.value.trim() ? TX("connect.alias.saved") : TX("connect.alias.removed"))(b, c) }].filter(Boolean)) });
  inp.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); d.node.querySelector(".dact .btn:last-child").click(); } });
  usDirty(d, [inp]);
  inp.focus();
}
function rulesDialog() {
  const accts = ACC.accounts;
  let R = JSON.parse(JSON.stringify(ACC.rules || {})), json = false;
  const list = () => (Array.isArray(R.rules) ? R.rules : (R.rules = []));
  const clean = o => {
    const c = JSON.parse(JSON.stringify(o));
    if (Array.isArray(c.rules)) { for (const r of c.rules) { if (!r.name) delete r.name; if (r.when && !Object.keys(r.when).length) delete r.when; } if (!c.rules.length) delete c.rules; }
    return c;
  };
  const acctPairs = cur => { const p = accts.map(a => [a.name, accName(a.label || a.alias || a.name)]); if (cur && !p.some(([v]) => v === cur)) p.push([cur, accLabel(cur)]); return p; };
  const select = (pairs, cur, label, onPick) => selectButton({ label, items: pairs.map(([value, text]) => ({ value, label: text })), value: cur, onPick: v => { onPick(v); touch(); } });
  const field = (label, ...ctrl) => el("div", {}, el("div", { class: "lbl", style: "margin:0 0 var(--sp-15)", text: label }), el("div", { class: "row", style: "flex-wrap:wrap" }, ...ctrl));
  // the seven weekdays are one row of seven equal chips (a phone cannot leave one on a second line)
  const dayField = (...ctrl) => el("div", {}, el("div", { class: "lbl", style: "margin:0 0 var(--sp-15)", text: TX("connect.rules.days") }), el("div", { class: "row rl-days" }, ...ctrl));
  const ta = el("textarea", { class: "fi hs-ta hs-mono", rows: 14, spellcheck: "false", "aria-label": TX("connect.rules.json") });
  const box = el("div", { class: "col" }), err = usErr(), tick = el("input");
  // 저장 stays off until the rules differ from what was loaded: any edit in the rows pings `tick`, which usDirty listens to
  const touch = () => tick.dispatchEvent(new Event("input"));
  box.addEventListener("input", touch); box.addEventListener("change", touch);
  const move = (i, to) => { const l = list(); [l[i], l[to]] = [l[to], l[i]]; paint(); };
  function card(r, i, n) {
    r.do = r.do || { auto: true };
    const w = r.when || {}, cond = ACC_COND.find(([k]) => k && k in w), ck = cond ? cond[0] : "";
    const set = (k, v) => { r.when = r.when || {}; if (v === "" || v == null) delete r.when[k]; else r.when[k] = v; };
    const nm = el("input", { class: "fi", type: "text", style: "flex:1 1 200px", value: r.name || "", maxlength: "40", placeholder: TX("connect.rules.name_ph", { n: i + 1 }), "aria-label": TX("connect.rules.name") });
    nm.addEventListener("input", () => { r.name = nm.value; });
    const time = (k, label) => { const t = el("input", { class: "fi", type: "time", value: w[k] || "", "aria-label": label, style: "flex:1;min-width:96px" }); t.addEventListener("change", () => set(k, t.value)); return t; };
    const days = ACC_DAYS.map(([k, t]) => { const on = (w.days || []).includes(k); return el("button", { type: "button", class: `chip${on ? " on" : ""}`, "aria-pressed": String(on), text: t, onclick: () => { const s = new Set(w.days || []); on ? s.delete(k) : s.add(k); set("days", ACC_DAYS.map(([x]) => x).filter(x => s.has(x))); if (!(r.when.days || []).length) delete r.when.days; paint(); } }); });
    const condCtl = [select(ACC_COND, ck, TX("connect.rules.cond"), v => {
      if (ck) delete r.when[ck];
      if (v === "five_hour_left_below" || v === "seven_day_left_below") set(v, 20);
      else if (v === "rate_limited" || v === "auth_error") set(v, true);
      else if (v === "unavailable") set(v, accts[0] ? accts[0].name : "");
      paint();
    })];
    if (ck === "five_hour_left_below" || ck === "seven_day_left_below") {
      const num = el("input", { class: "fi", type: "number", min: "0", max: "100", value: String(w[ck]), "aria-label": TX("connect.rules.left"), style: "width:96px;flex:none" });
      num.addEventListener("input", () => { if (num.value !== "") r.when[ck] = Number(num.value); });
      condCtl.push(num, el("span", { class: "sup", text: TX("connect.rules.below") }));
    } else if (ck === "unavailable") condCtl.push(select(acctPairs(w.unavailable), w.unavailable, TX("chat.arg.account"), v => { r.when.unavailable = v; }));
    const dk = "pin" in r.do ? "pin" : "prefer" in r.do ? "prefer" : "auto";
    const doCtl = [select(ACC_DO, dk, TX("connect.rules.action"), v => { r.do = v === "pin" ? { pin: accts[0] ? accts[0].name : "" } : v === "prefer" ? { prefer: [] } : { auto: true }; paint(); })];
    if (dk === "pin") doCtl.push(select(acctPairs(r.do.pin), r.do.pin, TX("chat.arg.account"), v => { r.do.pin = v; }));
    if (dk === "prefer") {
      const pref = Array.isArray(r.do.prefer) ? r.do.prefer : (r.do.prefer = []);
      for (const [v, t] of acctPairs()) { const at = pref.indexOf(v); doCtl.push(el("button", { type: "button", class: `chip${at >= 0 ? " on" : ""}`, "aria-pressed": String(at >= 0), text: at >= 0 ? `${at + 1} ${t}` : t, onclick: () => { at >= 0 ? pref.splice(at, 1) : pref.push(v); paint(); } })); }
    }
    const nCond = Object.keys(w).filter(k => ACC_COND.some(([c]) => c === k)).length;
    return el("div", { class: "list" }, el("div", { class: "li", style: "flex-direction:column;align-items:stretch;gap:var(--sp-3)" },
      el("div", { class: "row", style: "flex-wrap:wrap" }, nm,
        el("div", { class: "row rl-ord" },
          el("button", { type: "button", class: "btn text", disabled: i === 0, onclick: () => move(i, i - 1) }, TX("settings.fb.up")),
          el("button", { type: "button", class: "btn text", disabled: i === n - 1, onclick: () => move(i, i + 1) }, TX("settings.fb.down")),
          el("button", { type: "button", class: "btn danger", onclick: () => { list().splice(i, 1); paint(); } }, TX("common.delete")))),
      dayField(...days),
      field(TX("connect.rules.hours"), time("from", TX("connect.rules.from")), el("span", { class: "sup", text: "~" }), time("to", TX("connect.rules.to"))),
      field(TX("connect.rules.cond"), ...condCtl), nCond > 1 ? el("div", { class: "sup", text: TX("connect.rules.cond_n", { n: nCond }) }) : null,
      field(TX("connect.rules.action"), ...doCtl)));
  }
  function paint() {
    clear(box);
    if (json) { box.append(ta); return; }
    const l = Array.isArray(R.rules) ? R.rules : [];
    if (!l.length) box.append(el("div", { class: "sup", text: TX("connect.rules.none") }));
    l.forEach((r, i) => box.append(card(r, i, l.length)));
    box.append(el("div", {}, el("button", { type: "button", class: "btn tonal", onclick: () => { list().push({ do: { auto: true } }); paint(); } }, TX("connect.rules.add"))));
    touch();
  }
  const parse = () => { let o; try { o = JSON.parse(ta.value || "{}"); } catch { throw new Error(TX("connect.rules.bad_json")); } if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(TX("connect.rules.bad_json")); return o; };
  const toggle = () => {
    if (!json) { ta.value = JSON.stringify(clean(R), null, 2); json = true; }
    else { try { R = parse(); } catch (e) { return toast(e.message, true); } json = false; }
    d.node.querySelector(".dact .ac-gap").textContent = json ? TX("connect.rules.as_fields") : TX("connect.rules.as_json");
    paint(); touch();
  };
  const snap = () => json ? parse() : clean(R), start = JSON.stringify(clean(R));
  const dirty = () => { try { return JSON.stringify(snap()) !== start; } catch { return true; } };
  const d = dialog({ classic: true, title: TX("connect.rules.title"), body: [box, err], wide: true, actions: [
    { label: TX("connect.rules.as_json"), kind: "text ac-gap", onclick: toggle },
    { label: TX("common.cancel"), onclick: c => c() },
    { label: TX("common.save"), kind: "pri", onclick: (c, b) => accMut(b, () => api("/api/accounts/rules", "PUT", { rules: snap() }), TX("connect.rules.saved"), c, err) }] });
  usDirty(d, [tick], dirty);
  paint();
}
