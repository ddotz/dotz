/* ---------- models ---------- */
const pending = {};
let providerFilter = "";
const applyKo = { live: TX("settings.apply.done"), restarted: TX("settings.apply.restarted"), "next-start": TX("settings.apply.next_start"), "next-turn": TX("settings.apply.next_turn") };
// A load that failed stays said until one succeeds: a later redraw (the providers arriving) must not turn it back into 불러오는 중.
let modelsFail = false;
const modelsFailNode = () => emptyNode(TX("settings.models.load_failed"), () => loadModels());
async function loadModels(quiet) {
  try { M = await api("/api/models"); modelsFail = false; }
  catch (e) { modelsFail = true; if (!quiet && current === "models") clear($("#models")).append(modelsFailNode()); return; }
  if (current === "models") renderModels();
  if (current === "home") renderHome();
  if (current === "settings") renderSettings();
  if (current === "context") renderContext();
}
// Where a model is reached (owner 2026-10-29: two "Opus 5.5" rows could not be told apart): a subscription login says 구독 and the
// account name it is signed in as, an API key says API and the provider (/api/providers: auth, account, name).
function modelSource(provider) {
  const p = ((P && P.providers) || []).find(x => x.id === provider);
  if (!p) return "";
  if (p.auth === "oauth") return TX("settings.model.source_sub", { account: p.account || TX("settings.model.account") });
  if (p.auth === "api_key") return `API ${p.name || p.id}`;
  return "";
}
// Model picker rows from the server's choices: one "<Family> <version>" per model grouped by family, the latest two per
// family shown and the rest folded under '이전 모델' (the current selection is never folded).
function modelPickItems(avail, val) {
  const items = [], groups = new Map(), older = [];
  for (const a of avail) { const g = a.family || providerName(a.provider); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); }
  // Each row says where the model is reached when its group mixes sources (Opus over a subscription and over an API key); a group from
  // one source says it once, in its header.
  const one = list => new Set(list.map(a => a.provider)).size === 1;
  const row = (a, tag = true) => ({ value: a.selector, label: [a.name || a.selector, tag ? modelSource(a.provider) : ""].filter(Boolean).join(" · ") });
  for (const [g, list] of groups) {
    const now = list.filter(a => !a.older || a.selector === val), src = one(list) ? modelSource(list[0].provider) : "";
    if (now.length) items.push({ header: src ? (g === list[0].provider || g === providerName(list[0].provider) ? src : `${g} · ${src}`) : g }, ...now.map(a => row(a, !src)));
    older.push(...list.filter(a => a.older && a.selector !== val));
  }
  if (older.length) items.push({ fold: [{ header: TX("settings.model.older") }, ...older.map(a => row(a))], label: TX("settings.model.older_n", { n: older.length }) });
  return items;
}
function modelItems(key, curModel, filter = providerFilter) {
  const val = (pending[key] || {}).model ?? curModel;
  // Pickers list M.pickable (every connected model, one per version); a target on a model outside it still shows it under "현재".
  const avail = M.pickable || M.available || [];
  const shown = avail.filter(a => !filter || a.provider === filter);
  const items = [];
  if (val && !shown.some(a => a.selector === val)) items.push({ header: TX("settings.model.current") }, { value: val, label: modelName(val) });
  items.push(...modelPickItems(shown, val));
  return items;
}
// PUT /api/models for one target (the 모델 view and the 홈 card menus share it); confirms first when `confirmText` is set and again when the cache would be rewritten.
async function putModel(key, change, confirmText, label) {
  const body = { target: key, ...change };
  if (confirmText && !await ask(TX("settings.model.apply_ask"), `${confirmText}\n${label}`, TX("settings.apply"))) return false;
  let r;
  try {
    try { r = await api("/api/models", "PUT", body); }
    catch (e) {
      if (!(e.data && e.data.requires_force)) throw e;
      if (!await ask(TX("settings.model.apply_ask"), TX("settings.model.cache_rewrite", { n: e.data.context_tokens, tokens: num(e.data.context_tokens), label }), TX("settings.apply"))) return false;
      r = await api("/api/models", "PUT", { ...body, force: true });
    }
  } catch (e) { toast(TX("settings.model.apply_failed", { error: e.message }), true); return false; }   // the choice stays on the screen, still unapplied
  delete pending[key];
  toast(applyKo[r.applied] || TX("settings.apply.done"));
  await loadModels(true); refreshState();
  return true;
}
async function logoutProvider(p) {
  const name = p.name || p.id, key = p.auth === "api_key";
  // the server signs out every login of the provider, so a provider with several accounts says so
  const text = key ? TX("settings.logout.key_text") : [p.account ? TX("settings.logout.info_acc", { account: accName(p.account) }) : TX("settings.logout.info"), p.accounts > 1 ? TX("settings.logout.all", { name, n: p.accounts }) : ""].filter(Boolean).join(" ");
  if (!await ask(key ? TX("settings.logout.key_title", { name }) : TX("settings.logout.title", { name }), text, key ? TX("common.delete") : TX("settings.logout.btn"), true)) return;
  try { await api(`/api/providers/${enc(p.id)}/logout`, "POST", {}); }
  catch (e) { toast(TX(key ? "settings.logout.key_failed" : "settings.logout.failed", { error: e.message }), true); return; }
  toast(key ? TX("settings.logout.key_done") : TX("settings.logout.done"));
  await loadProviders(); loadModels(true);
  if (current === "home") renderHome();
}
// A dialog's save button (accounts, API 한도, API 키, context model, device): `usDirty` keeps it off until a field differs from what was
// loaded (or `also()` says there is something to do); `usRun` sends once (the button stays off while it waits) and a failure stays in the
// dialog, in the `usErr` note that sits last in the body, right above the buttons.
const usErr = () => el("p", { class: "sup err-t", role: "alert" });
async function usRun(btn, err, fn) {
  btn.disabled = true; btn.dataset.usBusy = "1"; err.textContent = "";
  try { await fn(); }
  catch (e) { err.textContent = noticeKo(String(e.message ?? e), { ...NK, error: true }); btn.disabled = false; delete btn.dataset.usBusy; }
}
function usDirty(d, inputs, also = () => false) {
  const save = d.node.querySelector(".dact .btn.pri"), init = inputs.map(i => i.value.trim());
  const sync = () => { if (!save.dataset.usBusy) save.disabled = !(inputs.some((i, k) => i.value.trim() !== init[k]) || also()); };
  for (const i of inputs) i.addEventListener("input", sync);
  sync();
}
// 모델 · 폴백 (owner 2026-11-11): one list of every place a model runs (hub/models-in-use.ts); pressing a row opens that target's editor right
// under it, one at a time: its model and effort on one row, which is step 1 of the fallback chain that target's harness walks where it has one
// (orchestrator, lane default, workers). The composer chips, the home card menu, 구성 and 설정 all open this screen on a row.
let modelsFocus = "", modelsOpen = "", modelsRefocus = "";
const openModels = key => { modelsFocus = key || ""; if (key) modelsOpen = key; if (current === "models") renderModels(); else go("models"); };
function targetEdit(key, title, cur, confirmText, extra = {}) {
  const p = pending[key] || {};
  const model = p.model ?? cur.model, thinking = p.thinking ?? cur.thinking;
  const dirty = (p.model != null && p.model !== cur.model) || (p.thinking != null && p.thinking !== cur.thinking);
  const modelField = selectField(TX("common.model"), modelName(model), () => modelItems(key, cur.model), model, v => {
    const pe = pending[key] ||= {}, hit = [...(M.pickable || []), ...(M.available || [])].find(x => x.selector === v);
    pe.model = v;
    // Another model shows (and sends) its own sweet spot, the one the hub applies when no effort is sent; the current model keeps its effort.
    const effort = v === cur.model ? cur.thinking : hit && hit.effort;
    if (effort) pe.thinking = effort;
    renderModels();
  });
  // Effort is a dropdown next to the model, not a row of eight buttons (owner 2026-10-20: "드랍다운으로 모델이랑 추론정도 각각"), and it
  // lists what this model accepts, so picking another model rebuilds it with that model's levels.
  // A model with no level to choose (only 'off') gets no effort cell at all, not an empty "–" one.
  const effItems = effortItems(model, thinking);
  const effField = effItems.length > 1 ? selectField(TX("common.reasoning"), thinking ? thinkKo(thinking) : "–", effItems, thinking, v => { (pending[key] ||= {}).thinking = v; renderModels(); }) : null;
  const info = (M.available || []).find(a => a.selector === model);
  const apply = el("button", { class: "btn", type: "button", disabled: !dirty, onclick: ev => busy(ev.currentTarget, async () => {
    const change = {};
    if (p.model != null && p.model !== cur.model) change.model = p.model;
    if (p.thinking != null && p.thinking !== cur.thinking) change.thinking = p.thinking;
    await putModel(key, change, confirmText, `${modelName(model)} · ${thinkKo(thinking)}`);
  }) }, TX("settings.apply"));
  const pick = el("div", { class: "mt-pick" }, el("div", { class: "mt-model" }, modelField), effField ? el("div", { class: "mt-eff" }, effField) : null);
  const notes = [
    info && !info.reasoning && thinking && thinking !== "off" ? el("div", { class: "sup mt-note", text: TX("settings.models.no_effort") }) : null,
    dirty ? el("div", { class: "btns mt-apply" }, el("button", { class: "btn text", type: "button", onclick: () => { delete pending[key]; renderModels(); } }, TX("common.undo")), apply) : null,
  ].filter(Boolean);
  return el("div", { class: "mt-list mt-edit", role: "group", "data-target": key, "aria-label": title }, ...(extra.chain ? [extra.chain(pick, notes)] : [pick, ...notes]));
}
function renderModels() {
  const box = $("#models");
  if (fbDragging) return;
  closeMenu(false);
  if (!M) { clear(box).append(modelsFail ? modelsFailNode() : emptyNode(TX("common.loading"))); return; }
  const provs = [...new Set((M.available || []).map(a => a.provider))].sort((a, b) => providerName(a).localeCompare(providerName(b)));
  const filter = selectField(TX("settings.provider"), providerFilter ? providerName(providerFilter) : TX("settings.provider.all"), [{ value: "", label: TX("settings.all") }, ...provs.map(p => ({ value: p, label: providerName(p) }))], providerFilter, v => { providerFilter = v; renderModels(); });
  clear(box).append(
    el("div", { class: "col mt" },
      el("div", { class: "mt-top" }, el("p", { class: "mt-intro", text: TX("settings.models.intro") }), el("div", { class: "mt-filter" }, filter)),
      ...modelGroups()));
  if (modelsRefocus) {
    const r = box.querySelector(`[data-use="${CSS.escape(modelsRefocus)}"]`);
    modelsRefocus = "";
    if (r) r.focus();
  }
  if (modelsFocus) {
    const n = box.querySelector(`[data-target="${CSS.escape(modelsFocus)}"]`);
    modelsFocus = "";
    if (n) requestAnimationFrame(() => n.previousElementSibling.scrollIntoView({ block: "start" }));
  }
}

// The model a chat target (MAIN or "lane:<name>") answers on now: its running process's own (a fallback it moved to included), else the
// configured one. `fallback` is set when that is not the configured model, with why the configured one is out and until when (hub/control.ts primary_down).
const FB_DOWN_KO = { quota: TX("settings.fb.down.quota"), cap: TX("settings.fb.down.cap"), error: TX("settings.fb.down.error") };
const runBaseOf = s => fbBase(s).replace(/^([^/]+)-apikey\//, "$1/");
const withLevel = (model, thinking) => model ? (thinking ? `${model}:${thinking}` : model) : "";
function fbWhy(layer) {
  const pd = ((M && M.fallbacks && M.fallbacks[layer]) || {}).primary_down;
  return { reason: pd ? FB_DOWN_KO[pd.down] || "" : "", until: pd && pd.until && isFinite(Date.parse(pd.until)) ? pd.until : "" };
}
function liveModel(t) {
  // A project or mail conversation: its own choice, else its kind's default (the mail app's), plus its session's model; main's as it is with neither.
  if (isModelT(t)) {
    const c = M && M.conversations && M.conversations[t], m = liveModel(MAIN), tv = TV.get(t);
    const kind = c ? c.kind : tv && tv.inherited_kind ? tv.inherited : "";
    if (!c && !kind) { const p = (isMailT(t) || isQuickT(t)) && ctxSession(t); return p && p.model ? { sel: p.model, conf: "", fallback: null } : m; }
    const conf = (c && c.own) || kind || m.conf, act = c && c.active;
    return { sel: act || conf, conf, fallback: act && conf && runBaseOf(act) !== runBaseOf(conf) ? fbWhy("orchestrator") : null };
  }
  const main = t === MAIN, om = M && M.orchestrator;
  const lm = main ? null : ((M && M.lanes) || []).find(x => `lane:${x.name}` === t), sl = main || !S ? null : (S.lanes || []).find(x => `lane:${x.name}` === t);
  const conf = main ? (om ? withLevel(om.model, om.thinking) : "") : lm ? withLevel(lm.model, lm.thinking) : (sl && sl.model) || "";
  const act = main ? (S && S.orchestrator && S.orchestrator.status !== "stopped" && S.orchestrator.activeModel) || "" : (lm && lm.active_model) || "";
  const sel = act || conf;
  return { sel, conf, fallback: act && conf && runBaseOf(act) !== runBaseOf(conf) ? fbWhy(main ? "orchestrator" : "lanes") : null };
}
const fbTagText = f => [TX("settings.fb.using"), f.reason, f.until ? TX("settings.fb.return_at", { at: kstStamp(Date.parse(f.until)) }) : ""].filter(Boolean).join(" · ");
const selText = sel => { const [b, lv] = String(sel || "").split(":"); return b ? `${modelChipText(b)}${lv ? ` · ${thinkKo(lv)}` : ""}` : "–"; };
const fbTag = (f, conf) => el("span", { class: "tag warn", title: [fbTagText(f), conf ? TX("settings.fb.instead", { model: selText(conf) }) : ""].filter(Boolean).join(" · "), text: fbTagText(f) });
// 실제로 쓰는 모델 (owner 2026-10-27): every place a model runs and the model it runs on now (hub/models-in-use.ts), in three groups. A row
// that is changed on this screen opens its editor in place, one at a time; one that is changed in an app's settings opens that screen.
const MT_GROUPS = [TX("common.assistant"), TX("common.session"), TX("settings.models.group_replies")];
const mtGroupOf = key => key === "main" || key === "background" || key === "lookups" ? 0 : key === "lanes" || key.startsWith("lane:") || key === "workers" || key.startsWith("workers:") ? 1 : 2;
// A hub that names no place to change a row (an older one, the demo's) still gets every row this screen edits, and a session that is alive
// but has no row from the hub its own.
const MT_OWN = { main: "orchestrator", lanes: "lanes", workers: "workers", replies: "replies" };
function mtRows() {
  const rows = (M.in_use || []).map(r => r.change || !MT_OWN[r.key] ? r : { ...r, change: { models: MT_OWN[r.key] } }), own = new Set(rows.map(r => (r.change || {}).models));
  for (const L of FB_LAYERS) if (!own.has(L.id) && L.cur()) rows.push({ key: L.id === "orchestrator" ? "main" : L.id, label: L.title(), sub: L.sub, model: withLevel(L.cur().model, L.cur().thinking), change: { models: L.id } });
  if (M.replies && !own.has("replies")) rows.push({ key: "replies", label: TX("settings.models.replies_default"), model: M.replies.value || "", change: { models: "replies" } });
  const have = new Set(rows.map(r => r.key));
  const extra = (M.lanes || []).filter(l => laneAlive(l) && !have.has(`lane:${l.name}`)).map(l => {
    const conf = withLevel(l.model, l.thinking), act = l.active_model;
    return { key: `lane:${l.name}`, label: TX("settings.models.lane_label", { name: l.title || l.name }), model: act || conf, ...(act && runBaseOf(act) !== runBaseOf(conf) ? { configured: conf, fallback: true } : {}), change: { models: `lane:${l.name}` } };
  });
  rows.splice(rows.findLastIndex(r => r.key === "lanes" || r.key.startsWith("lane:")) + 1, 0, ...extra);
  return rows;
}
function mtEditor(target, title) {
  const L = FB_LAYERS.find(x => x.id === target), lm = (M.lanes || []).find(x => `lane:${x.name}` === target);
  return L ? targetEdit(L.id, title, L.cur(), L.confirm, fbParts(L)) : target === "replies" ? repliesEdit(title) : lm ? targetEdit(target, title, lm, "") : null;
}
// `primary`: the first row that points at a target owns its editor; a later row on the same target (the background work, a session's subagents) only reads.
function mtRow(r, primary) {
  const ch = r.change || {}, target = primary ? ch.models : "", isOpen = Boolean(target) && modelsOpen === target;
  const lm = r.key.startsWith("lane:") ? (M.lanes || []).find(x => `lane:${x.name}` === r.key) : null;
  const run = lm ? runStatus(r.key, lm.status, targetInfo(r.key).ask) : null, sub = [run && run[0], r.sub].filter(Boolean).join(" · ");
  const why = r.fallback ? (r.key === "main" ? fbWhy("orchestrator") : r.key.startsWith("lane:") ? fbWhy("lanes") : { reason: "", until: "" }) : null;
  const chain = FB_LAYERS.some(L => L.id === target) ? ((M.fallbacks || {})[target] || {}).chain || [] : [];
  const model = selText(r.model);
  const act = target ? () => { modelsOpen = isOpen ? "" : target; modelsRefocus = r.key; renderModels(); } : ch.app ? () => asScreen(ch.app) : null;
  const attrs = { class: "mt-use-row", "data-use": r.key };
  if (act) Object.assign(attrs, { role: "button", tabindex: "0", onclick: act, onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); act(); } } });
  if (target) attrs["aria-expanded"] = String(isOpen);
  const end = ch.none ? el("span", { class: "mt-use-end sup", title: ch.none, text: TX("settings.models.fixed") }) : el("span", { class: "mt-use-end" }, target ? icon("drop") : ch.app ? icon("chev") : null);
  const row = el("div", attrs,
    el("div", { class: "mt-use-tx" }, el("span", { class: "nm", title: r.label }, run ? el("span", { class: `dot ${run[1]}` }) : null, r.label), sub ? el("span", { class: "sup", text: sub }) : null),
    el("div", { class: "mt-use-rest" }, el("span", { class: "mt-use-m", title: model, text: model }), chain.length ? el("span", { class: "sup mt-use-fb", text: TX("settings.models.fallbacks_n", { n: chain.length }) }) : null, why ? fbTag(why, r.configured) : null),
    end);
  const editor = isOpen ? mtEditor(target, r.label) : null;
  return editor ? [row, editor] : [row];
}
function modelGroups() {
  const groups = MT_GROUPS.map(() => []), seen = new Set();
  for (const r of mtRows()) {
    const t = (r.change || {}).models;
    groups[mtGroupOf(r.key)].push(...mtRow(r, Boolean(t) && !seen.has(t)));
    if (t) seen.add(t);
  }
  return groups.map((nodes, i) => nodes.length ? el("section", { class: "mt-card", "aria-label": MT_GROUPS[i] }, el("div", { class: "mt-head" }, el("span", { class: "t", text: MT_GROUPS[i] })), el("div", { class: "list mt-use-list" }, ...nodes)) : null);
}
// 답장 기본값: the reply model of every app that has none of its own (hub/reply-model-choices.ts setReplyDefault).
function repliesEdit(title) {
  const R = M.replies;
  if (!R) return null;
  const items = R.options.map(v => ({ value: v, label: v ? R.labels[v] || v : R.default_label }));
  const pick = selectField(TX("settings.models.reply_model"), R.value ? R.labels[R.value] || R.value : R.default_label, items, R.value, v => busy(null, async () => {
    try { await api("/api/models", "PUT", { target: "replies", model: v }); toast(TX("settings.apply.done")); await loadModels(true); }
    catch (e) { toast(e.message || TX("settings.save_failed"), true); }
  }));
  return el("div", { class: "mt-list mt-edit", role: "group", "data-target": "replies", "aria-label": title },
    el("div", { class: "mt-pick" }, el("div", { class: "mt-model" }, pick)),
    el("div", { class: "sup mt-note", text: TX("settings.models.reply_note") }));
}
