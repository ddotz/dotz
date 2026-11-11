/* ---------- API 월 한도: usage card and settings dialog (/api/quota budget, /api/api-budget) ---------- */
let AB;
const abUsd = n => `$${n.toFixed(2)}`;
function budgetCard(B) {
  const card = el("div", { class: "card" }, el("div", { class: "ch lo" }, el("h3", { text: TX("misc.ab.title") }),
    el("button", { class: "btn text inrow", type: "button", onclick: () => budgetDialog() }, TX("common.settings"))));
  const src = B.source === "admin" ? TX("misc.ab.src_admin") : TX("misc.ab.src_est");
  if (B.limit_usd) {
    const pct = B.pct || 0, tone = pct >= 80 ? "warn" : "", left = Math.max(0, Math.min(100, 100 - pct));   // the bar says what is left, as the subscription cards do
    card.append(el("div", { class: "lim" },
      el("div", { class: "kv" }, el("span", { class: "k", text: `${abUsd(B.spent_usd)} / ${abUsd(B.limit_usd)}` }), el("span", { style: "font-weight:500", text: TX("misc.ab.left", { pct: Math.round(left) }) })),
      el("div", { class: `bar ${tone}`, role: "progressbar", "aria-valuenow": Math.round(left), "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${left.toFixed(1)}%` })),
      el("div", { class: "sup", text: rel(B.resets_at) })));
  } else {
    card.append(el("div", { class: "lim" }, el("div", { class: "kv" }, el("span", { class: "k", text: TX("misc.ab.this_month", { usd: abUsd(B.spent_usd) }) }), el("span", { class: "v", text: TX("misc.ab.no_limit") })),
      el("div", { class: "sup", text: TX("misc.ab.hint") })));
  }
  card.append(el("div", { class: "sup", text: `${B.month} · ${src}` }));
  if (B.error) card.append(el("div", { class: "sup warn", text: B.error }));
  if (B.hint) card.append(el("div", { class: "sup", text: B.hint }));
  return card;
}
// Without a console limit the usage page still carries the way in: one row that opens the same dialog.
function budgetRow() {
  return el("button", { class: "li tap budget-row", type: "button", onclick: () => budgetDialog() },
    el("span", { class: "tx" }, el("div", { class: "hd", text: TX("misc.ab.title") }), el("div", { class: "sup", text: budgetSub() || TX("misc.ab.unset") })),
    el("span", { class: "li-end" }, el("span", { class: "btn tonal inrow", text: TX("misc.ab.change") })));
}
function budgetSub() {
  if (AB === undefined) {
    AB = null;
    // a failed read is tried again on the next render instead of leaving the row blank for the session
    api("/api/api-budget").then(r => { AB = r; if (inSettings()) renderSettings(); }).catch(() => { AB = undefined; });
  }
  return AB && AB.monthly_usd ? TX("misc.ab.monthly", { usd: abUsd(AB.monthly_usd) }) : "";
}
async function budgetDialog() {
  try { AB = await api("/api/api-budget"); } catch (e) { toast(e.message, true); return; }
  const limit = input({ type: "number", inputmode: "decimal", min: "0", step: "any", placeholder: TX("misc.ab.ph_limit"), value: AB.monthly_usd == null ? "" : String(AB.monthly_usd) });
  const key = input({ type: "password", autocomplete: "new-password", name: "admin-key", placeholder: TX("misc.ab.ph_key") });
  const has = AB.admin_key && AB.admin_key.present;
  const done = (c, msg) => { c(); toast(msg); renderSettings(); if (current === "usage") loadQuota(); };
  const err = usErr();
  const send = (c, btn, body, msg) => usRun(btn, err, async () => {
    AB = await api("/api/api-budget", "PUT", body); key.value = "";
    done(c, msg);
  });
  const actions = [{ label: TX("common.cancel"), onclick: c => c() }];
  if (has) actions.push({ label: TX("misc.ab.key_delete"), onclick: (c, btn) => send(c, btn, { clear_admin_key: true }, TX("misc.ab.key_deleted")) });
  actions.push({ label: TX("common.save"), kind: "pri", onclick: (c, btn) => {
    const body = { monthly_usd: limit.value.trim() === "" ? null : limit.value.trim() };
    if (key.value.trim()) body.admin_key = key.value;
    return send(c, btn, body, TX("settings.saved"));
  } });
  const d = dialog({
    classic: true,
    title: TX("misc.ab.title"),
    body: el("div", { class: "col" },
      el("p", { class: "sup", text: TX("misc.ab.body") }),
      textField(TX("misc.ab.field_limit"), limit),
      el("p", { class: "sup", text: has ? TX("misc.ab.key_masked", { key: AB.admin_key.masked }) : TX("misc.ab.no_key") }),
      textField(TX("misc.ab.field_key"), key),
      el("p", { class: "sup", text: TX("misc.ab.key_note") }), err),
    actions,
  });
  usDirty(d, [limit, key]);
  limit.focus();
}
