/* ---------- settings: model fallback chains (orchestrator / lanes / task workers) ---------- */
const FB_LAYERS = [
  { id: "orchestrator", title: () => botName, sub: TX("settings.fb.main_sub"), cur: () => M.orchestrator, confirm: TX("settings.fb.confirm_restart") },
  { id: "lanes", title: () => TX("settings.fb.lanes_title"), sub: TX("settings.fb.lanes_sub"), cur: () => M.lanes_default },
  { id: "workers", title: () => TX("common.subagent"), sub: TX("settings.fb.workers_sub"), cur: () => M.workers },
];
const FB_KEYS = ["model", "when", "cap", "revert", "key_file", "base_url", "api", "enabled", "workers"];
const FB_WHEN = { quota: TX("settings.fb.when.quota"), error: TX("settings.fb.when.error") };
const fbStored = e => { const o = {}; for (const k of FB_KEYS) if (e[k] != null) o[k] = e[k]; return Object.keys(o).length === 1 ? o.model : o; };
const fbBase = s => String(s || "").replace(/:(off|minimal|low|medium|high|xhigh|max|auto)$/, "");
// The id a running process reports for an entry: an API-key entry runs as its own "<provider>-apikey" provider.
const fbRunId = e => { const m = fbBase(e.model); if (!e.key_file) return m; const i = m.indexOf("/"); return `${m.slice(0, i)}-apikey${m.slice(i)}`; };
const fbMoney = n => `$${I18N_LANG === "ko" ? (Number.isInteger(n) ? n : n.toFixed(2)) : n.toLocaleString(TX_LOCALE, { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const fbCapText = c => c.usd ? TX(c.period === "day" ? "settings.fb.cap.day_usd" : "settings.fb.cap.month_usd", { amount: fbMoney(c.usd) }) : TX(c.period === "day" ? "settings.fb.cap.day_tokens" : "settings.fb.cap.month_tokens", { n: Number(c.tokens), tokens: num(c.tokens) });
let fbDragging = false;
// A long model id breaks after its separators, not inside a word; the text itself stays the same.
const fbNameParts = nm => nm.split(/(?<=[-/])/).flatMap((p, i) => (i ? [el("wbr"), p] : [p]));
// A step's row says at most two of these; the rest sit behind the tap (and in the row's title).
const fbFacts = e => [e.key_file ? TX("settings.api_key") : "", e.cap ? fbCapText(e.cap) : "", e.when ? FB_WHEN[e.when] : "", e.revert === false ? TX("settings.fb.no_revert") : ""].filter(Boolean);
function fbDownTag(e) {
  if (!e.down) return null;
  return el("span", { class: "tag warn", title: e.until ? TX("settings.fb.until", { at: new Date(e.until).toLocaleString(TX_LOCALE) }) : "", text: e.down === "cap" ? TX("settings.fb.down.cap") : e.down === "quota" ? TX("settings.fb.down.quota") : e.down_reason === "api_key_ban" ? TX("settings.fb.down.shared") : e.down_reason === "api_key_off" ? TX("settings.fb.down.key_off") : TX("settings.fb.down.unavailable") });
}
// Usage against the cap. The row draws it only from this share of the cap on; the step's editor always does.
const FB_NEAR = 80;
function fbBar(e, nearOnly) {
  if (!e.cap || !e.used) return null;
  const byUsd = e.cap.usd && (e.used.usd > 0 || !e.used.tokens);
  const used = byUsd ? e.used.usd : e.used.tokens, cap = byUsd ? e.cap.usd : (e.cap.tokens || e.cap.usd);
  const pct = Math.max(0, Math.min(100, cap ? (used / cap) * 100 : 0)), near = pct >= FB_NEAR;
  if (nearOnly && !near) return null;
  const when = e.cap.period === "day" ? TX("settings.fb.today") : TX("settings.fb.month");
  const label = byUsd ? TX("settings.fb.bar_usd", { when, used: fbMoney(e.used.usd), cap: fbMoney(e.cap.usd) }) : TX("settings.fb.bar_tokens", { when, used: num(e.used.tokens), cap: num(e.cap.tokens || 0) });
  return el("div", { class: `fb-usage${near ? " warn" : ""}` }, el("div", { class: "fb-bar", role: "progressbar", "aria-valuenow": String(Math.round(pct)), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": label }, el("i", { style: `width:${pct}%` })), el("div", { class: "fb-bar-l", text: label }));
}
async function fbSave(layer, list) {
  try {
    const r = await api("/api/fallbacks", "PUT", { target: layer, chain: list.map(fbStored) });
    toast(r && (r.applied === "updated" || r.applied === "restarted") ? TX("settings.fb.saved_now") : r && r.applied === "after-turn" ? TX("settings.fb.saved_after") : TX("settings.fb.saved_next"));
    await loadModels(true);
    return true;
  } catch (e) { toast(e.message || TX("settings.save_failed"), true); await loadModels(true); return false; }
}
// One fallback step edited in place (owner 2026-10-20: "클릭하면 설정하는 부분에 해당 부분 옵션 띄우고 바로 수정가능하게"): clicking a
// step opens its options right under it, kept as a draft across re-renders until 저장 writes the chain once or 취소 drops it.
let fbOpen = null, fbKeys = null;
const fbSplit = m => { const s = String(m || ""), b = fbBase(s); return { base: b, level: s.length > b.length ? s.slice(b.length + 1) : "" }; };
const fbDraftOf = e => ({ ...e, _cap: { period: (e.cap && e.cap.period) || "month", usd: (e.cap && e.cap.usd) || "", tokens: (e.cap && e.cap.tokens) || "" } });
function fbOpenStep(layer, list, i) {
  fbOpen = fbOpen && fbOpen.layer === layer && fbOpen.i === i ? null : { layer, i, draft: fbDraftOf(list[i]) };
  if (fbOpen) api("/api/apikeys").then(k => { fbKeys = k; if (current === "models") renderModels(); }, () => {});
  renderModels();
}
function fbEditor(L, F, list, i, move) {
  const d = fbOpen.draft, { base, level } = fbSplit(d.model), nm = modelName(base);
  const redraw = () => renderModels();
  const setModel = (b, lv) => { d.model = lv ? `${b}:${lv}` : b; redraw(); };
  const only = F.providers && F.providers.length === 1 ? F.providers[0] : "";
  const seg = (label, opts, val, pick) => el("div", { class: "tf" }, el("span", { class: "lb", text: label }), el("div", { class: "seg", role: "radiogroup", "aria-label": label },
    ...opts.map(([v, t]) => el("button", { type: "button", role: "radio", "aria-checked": String(v === val), class: v === val ? "on" : "", onclick: () => pick(v) }, t))));
  const hub = F.conditions;
  // The subagents' chain keeps bare models plain; only its API-key entries take a condition, a cap and a revert.
  const cond = hub && (L.id !== "workers" || Boolean(d.key_file));
  const keyable = hub && ["anthropic", "openai", "openrouter"].includes(base.split("/")[0]);
  const pickKey = () => fbKeyDialog({ ...d, model: base }, f => { d.key_file = f || undefined; redraw(); });
  const kp = d.key_file && fbKeys ? (fbKeys.providers || []).find(p => p.file === d.key_file) : null;
  const keyText = !d.key_file ? "" : kp ? (kp.present ? TX("settings.fb.saved_key", { masked: kp.masked }) : TX("settings.fb.no_saved_key")) : TX("settings.fb.key_file", { file: d.key_file });
  const c = d._cap;
  const capNum = (k, opts) => input({ type: "number", min: "0", ...opts, value: c[k] ? String(c[k]) : "", placeholder: TX("settings.none"), oninput: ev => { c[k] = ev.target.value; } });
  const save = btn => busy(btn, async () => {
    const { _cap, ...e } = d, u = Number(_cap.usd), t = Number(_cap.tokens);
    e.cap = cond && (u > 0 || t > 0) ? { period: _cap.period, ...(u > 0 ? { usd: u } : {}), ...(t > 0 ? { tokens: t } : {}) } : undefined;
    if (!cond) for (const k of ["when", "revert"]) delete e[k];
    if (!hub) delete e.key_file;
    if (await fbSave(L.id, list.map((x, j) => (j === i ? e : x)))) { fbOpen = null; renderModels(); }
  });
  const remove = btn => busy(btn, async () => { if (await fbSave(L.id, list.filter((_, j) => j !== i))) { fbOpen = null; renderModels(); } });
  return el("li", { class: "fbe", "aria-label": TX("settings.fb.edit_aria", { name: nm }) },
    el("div", { class: "fbe-grid" },
      selectField(TX("common.model"), nm, () => modelItems(`fbe:${L.id}`, base, only), base, v => setModel(fbBase(v), level)),
      selectField(TX("common.reasoning"), level ? thinkKo(level) : TX("settings.fb.same_as_base"), [{ value: "", label: TX("settings.fb.same_as_base") }, ...effortItems(base, level)], level, v => setModel(base, v))),
    seg(TX("settings.fb.enabled"), [["on", TX("settings.fb.opt_on")], ["off", TX("settings.fb.opt_off")]], d.enabled === false ? "off" : "on", v => { d.enabled = v === "on"; redraw(); }),
    d.key_file && keyable && L.id !== "workers" ? seg(TX("settings.fb.workers_label"), [["", TX("settings.fb.workers_no_key")], ["on", TX("settings.fb.workers_same_key")]], d.workers ? "on" : "", v => { d.workers = v === "on" ? true : undefined; redraw(); }) : null,
    keyable ? seg(TX("settings.fb.mode"), [["login", TX("settings.fb.mode_login")], ["key", TX("settings.api_key")]], d.key_file ? "key" : "login", v => { if (v === "login") { d.key_file = undefined; redraw(); } else pickKey(); }) : null,
    d.key_file && keyable ? el("div", { class: "fbe-key" }, el("span", { class: `sup${kp && !kp.present ? " warn" : ""}`, text: keyText }), el("button", { type: "button", class: "btn text", onclick: pickKey }, TX("settings.fb.change_key"))) : null,
    cond ? seg(TX("settings.fb.when_label"), [["", TX("settings.fb.when_prev")], ["quota", TX("settings.fb.when_quota")], ["error", TX("settings.fb.when_error")]], d.when || "", v => { d.when = v || undefined; redraw(); }) : null,
    cond ? seg(TX("settings.fb.revert_label"), [["", TX("settings.fb.revert_when")], ["keep", TX("settings.fb.revert_keep")]], d.revert === false ? "keep" : "", v => { d.revert = v === "keep" ? false : undefined; redraw(); }) : null,
    cond ? el("div", { class: "fbe-cap" },
      seg(TX("settings.fb.cap_label"), [["month", TX("settings.fb.period_month")], ["day", TX("settings.fb.period_day")]], c.period, v => { c.period = v; redraw(); }),
      textField(TX("settings.fb.amount"), capNum("usd", { step: "any", inputmode: "decimal" })),
      textField(TX("settings.fb.tokens"), capNum("tokens", { step: "1", inputmode: "numeric" }))) : null,
    cond ? fbBar(d) : null,
    el("div", { class: "btns fbe-act" },
      el("button", { type: "button", class: "btn text danger", onclick: ev => remove(ev.currentTarget) }, TX("common.delete")),
      list.length > 1 ? el("button", { type: "button", class: "ib up", title: TX("settings.fb.up"), "aria-label": TX("settings.fb.up_aria", { name: nm }), disabled: i === 0, onclick: () => move(i, i - 1) }, icon("down")) : null,
      list.length > 1 ? el("button", { type: "button", class: "ib", title: TX("settings.fb.down"), "aria-label": TX("settings.fb.down_aria", { name: nm }), disabled: i === list.length - 1, onclick: () => move(i, i + 1) }, icon("down")) : null,
      el("span", { class: "sp" }),
      el("button", { type: "button", class: "btn text", onclick: () => { fbOpen = null; renderModels(); } }, TX("common.cancel")),
      el("button", { type: "button", class: "btn pri", onclick: ev => save(ev.currentTarget) }, TX("common.save"))));
}
// The API key of a fallback entry: the owner pastes the key (hub/apikey-store.ts checks it once with the provider and keeps it
// in the data folder's secrets); the page only ever sees its prefix and last 4. A key file name stays as an advanced option.
async function fbKeyDialog(e, done) {
  const provider = fbBase(e.model).split("/")[0];
  let K;
  try { K = await api("/api/apikeys"); } catch (err) { return toast(err.message, true); }
  const cur = (K.providers || []).find(p => p.provider === provider);
  if (!cur) return toast(TX("settings.fb.no_key_provider", { provider }), true);
  const key = input({ type: "password", autocomplete: "new-password", name: "api-key", placeholder: provider === "anthropic" ? "sk-ant-…" : provider === "openrouter" ? "sk-or-…" : "sk-…" });
  const custom = e.key_file && e.key_file !== cur.file ? e.key_file : "";
  const file = input({ value: custom, placeholder: cur.file });
  const status = el("p", { class: "sup", text: cur.present ? TX(e.key_file === cur.file ? "settings.fb.key_status_use" : "settings.fb.key_status", { masked: cur.masked }) : TX("settings.fb.no_saved_key") });
  const adv = msAdvanced("data-fbk-advanced", Boolean(custom), () => el("div", { class: "col" }, el("p", { class: "sup", text: TX("settings.fb.key_paste_note") }), textField(TX("settings.fb.file_name"), file)), TX("settings.fb.advanced"));
  const err = usErr();
  const saveWith = async (c, body) => { const r = await api("/api/apikeys", "PUT", body); key.value = ""; toast(TX("settings.fb.key_saved", { masked: r.masked })); done(r.file); c(); };
  const actions = [{ label: TX("common.cancel"), onclick: c => c() }];
  if (provider === "anthropic" && K.omo_anthropic) actions.push({ label: TX("settings.fb.use_omo"), onclick: (c, b) => usRun(b, err, () => saveWith(c, { from: "omo" })) });
  if (e.key_file) actions.push({ label: TX("settings.fb.key_off"), onclick: c => { done(""); c(); } });
  // off until there is something to save: a pasted key, a changed file name, or the stored key that is not the one in use yet
  actions.push({ label: TX("common.save"), kind: "pri", onclick: (c, b) => usRun(b, err, async () => {
    const v = key.value.trim();
    if (v) return saveWith(c, { provider, key: v });
    if (file.value.trim()) { done(file.value.trim()); return c(); }
    done(cur.file); c();
  }) });
  const d = dialog({ title: TX("settings.prov.key_of", { name: providerName(provider) }), body: el("div", { class: "col" }, el("p", { class: "sup", text: TX("settings.fb.key_hidden") }), status, textField(TX("settings.api_key"), key), adv, err), actions, mid: true });
  usDirty(d, [key, file], () => cur.present && e.key_file !== cur.file);
  setTimeout(() => key.focus(), 0);
}
// Drag a fallback step by its handle to another place in its chain (pointer events); the handle's arrow keys and the editor's arrow
// buttons do the same. Only the handle takes the touch, so a finger on a row still scrolls the page.
function fbDrag(grip, item, i, move) {
  grip.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    const chips = [...item.parentNode.querySelectorAll(".fb-item[data-i]")];
    const rects = chips.map(c => c.getBoundingClientRect());
    const x0 = ev.clientX, y0 = ev.clientY;
    let moving = false, to = i;
    const drag = m => {
      const dx = m.clientX - x0, dy = m.clientY - y0;
      if (!moving) {
        if (Math.hypot(dx, dy) < 6) return;
        moving = true; fbDragging = true; item.classList.add("drag");
        try { grip.setPointerCapture(ev.pointerId); } catch {}
      }
      item.style.transform = `translate(${dx}px,${dy}px)`;
      let best = i, bd = Infinity;
      rects.forEach((r, k) => { const d = Math.hypot(m.clientX - (r.left + r.width / 2), m.clientY - (r.top + r.height / 2)); if (d < bd) { bd = d; best = k; } });
      to = best;
      chips.forEach((c, k) => c.classList.toggle("over", k === to && to !== i));
    };
    const end = () => {
      grip.removeEventListener("pointermove", drag); grip.removeEventListener("pointerup", end); grip.removeEventListener("pointercancel", end);
      if (!moving) return;
      item.classList.remove("drag"); item.style.transform = ""; chips.forEach(c => c.classList.remove("over"));
      setTimeout(() => { fbDragging = false; }, 0);
      if (to !== i) move(i, to);
    };
    grip.addEventListener("pointermove", drag); grip.addEventListener("pointerup", end); grip.addEventListener("pointercancel", end);
  });
}
// The fallback part of a target's card: the numbered chain, step 1 being the target's own model and effort pickers, then one compact row
// per fallback (the rest of a step opens under its row). Harness-aware: conditions only where the hub drives the chain, the add menu
// limited to what the harness can run.
const FB_ADD_KEY = "apikey";
function fbParts(L) {
  const F = (M.fallbacks || {})[L.id] || { chain: [], active: [] };
  const list = F.chain, cur = L.cur(), used = new Set(F.active || []), prim = fbBase(cur && cur.model);
  const runs = e => !F.providers || F.providers.includes(fbBase(e.model).split("/")[0]);
  const open = i => Boolean(fbOpen && fbOpen.layer === L.id && fbOpen.i === i);
  const move = async (i, to) => {
    const n = list.slice(), wasOpen = open(i);
    n.splice(to, 0, n.splice(i, 1)[0]);
    if (wasOpen) fbOpen.i = to;
    const ok = await fbSave(L.id, n);
    if (!ok && wasOpen) { fbOpen = null; renderModels(); }
  };
  const itemFor = (e, i) => {
    const nm = modelChipText(fbBase(e.model)), inUse = used.has(fbRunId(e)), on = e.enabled !== false;
    const facts = fbFacts(e), short = facts.slice(0, 2).join(" · ");
    const all = [fbBase(e.model), ...facts, e.key_file && e.workers ? TX("settings.fb.workers_too") : ""].filter(Boolean).join(" · ");
    const grip = list.length > 1 ? el("button", { type: "button", class: "fb-grip", title: TX("settings.fb.drag"), "aria-label": TX("settings.fb.reorder_aria", { name: nm }), onkeydown: ev => {
      const to = ev.key === "ArrowUp" ? i - 1 : ev.key === "ArrowDown" ? i + 1 : -1;
      if (to < 0 || to >= list.length) return;
      ev.preventDefault();
      move(i, to).then(() => { const g = document.querySelector(`[data-target="${L.id}"] .fb-item[data-i="${to}"] .fb-grip`); if (g) g.focus(); });
    } }, icon("grip")) : null;
    const node = el("li", { class: `fb-item${inUse ? " in-use" : ""}${on ? "" : " off"}${open(i) ? " open" : ""}`, "data-i": String(i), title: all },
      el("span", { class: "fb-n", text: String(i + 2) }),
      el("button", { type: "button", class: "fb-body", "aria-expanded": String(open(i)), "aria-label": TX("settings.fb.edit_aria", { name: [nm, short].filter(Boolean).join(" · ") }) },
        el("span", { class: "nm" }, ...fbNameParts(nm)),
        short ? el("span", { class: "fb-sum", text: short }) : null,
        inUse ? el("span", { class: "tag pri", text: TX("settings.fb.in_use") }) : null,
        fbDownTag(e),
        runs(e) ? null : el("span", { class: "tag warn", text: TX("settings.fb.cant_use") })),
      el("button", { type: "button", class: "fb-sw", role: "switch", "aria-checked": String(on), title: on ? TX("settings.fb.sw_on_title") : TX("settings.fb.sw_off_title"), "aria-label": on ? TX("settings.fb.switch_off", { name: nm }) : TX("settings.fb.switch_on", { name: nm }), onclick: () => fbSave(L.id, list.map((x, j) => (j === i ? { ...x, enabled: !on } : x))) }, el("span", { class: `dot${on ? " ok" : ""}`, "aria-hidden": "true" }), on ? TX("settings.fb.sw_on") : TX("settings.fb.sw_off")),
      grip,
      open(i) ? null : fbBar(e, true));
    if (grip) fbDrag(grip, node, i, move);
    node.addEventListener("click", ev => { if (!ev.target.closest(".fb-sw, .fb-grip") && !fbDragging) fbOpenStep(L.id, list, i); });
    return node;
  };
  if (fbOpen && fbOpen.layer === L.id && fbOpen.i >= list.length) fbOpen = null;
  const full = list.length >= ((M.fallbacks || {}).max || 6);
  // The usual case first in the add menu: the subscription ran out, so the same model goes on through an API key (only after a usage limit).
  const keyStep = F.conditions && prim && !list.some(x => x.key_file && fbBase(x.model) === prim);
  const add = el("button", { type: "button", class: "fb-add", "aria-haspopup": "listbox", disabled: full, onclick: ev => {
    const only = F.providers && F.providers.length === 1 ? F.providers[0] : "";
    const items = [...(keyStep ? [{ value: FB_ADD_KEY, label: TX("settings.fb.continue_key", { model: modelName(prim) }), sub: TX("settings.fb.when.quota") }] : []), ...modelItems(`fb:${L.id}`, "", only)];
    showMenu(ev.currentTarget, items, { value: "", onPick: v => {
      if (v === FB_ADD_KEY) fbKeyDialog({ model: prim }, file => file && fbSave(L.id, [...list, { model: prim, key_file: file, when: "quota" }]));
      else if (list.some(x => x.model === v && !x.key_file) || fbBase(v) === prim) toast(TX("settings.fb.exists"), true);
      else { fbOpen = { layer: L.id, i: list.length, draft: fbDraftOf({ model: v }) }; fbSave(L.id, [...list, { model: v }]); }
    } });
  } }, icon("add"), full ? TX("settings.fb.full") : TX("settings.fb.add"));
  const how = L.id === "workers" ? TX("settings.fb.how_workers")
    : F.harness && F.harness.id === "claude" ? TX("settings.fb.how_claude")
    : "";
  return {
    sub: L.sub,
    chain: (pick, notes) => el("div", { class: "mt-fb" },
      el("ol", { class: "fb-list", "aria-label": TX("settings.fb.list_aria", { name: L.title() }) },
        el("li", { class: `fb-item base${used.has(prim) ? " in-use" : ""}` }, el("span", { class: "fb-n", text: "1" }), pick),
        notes.length ? el("li", { class: "fb-sub" }, ...notes) : null,
        ...list.flatMap((e, i) => (open(i) ? [itemFor(e, i), fbEditor(L, F, list, i, move)] : [itemFor(e, i)]))),
      el("div", { class: "mt-fb-foot" }, add, how ? el("span", { class: "sup", text: how }) : null)),
  };
}
/* ---------- settings ---------- */