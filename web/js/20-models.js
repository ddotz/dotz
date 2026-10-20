/* ---------- models ---------- */
const pending = {};
let providerFilter = "";
const applyKo = { live: "적용했어요", restarted: "적용했어요 · 재시작됨", "next-start": "다음 시작부터 적용돼요" };
async function loadModels(quiet) {
  try { M = await api("/api/models"); }
  catch (e) { if (!quiet && current === "models") clear($("#models")).append(emptyNode("모델 정보를 불러오지 못했어요")); return; }
  if (current === "models") renderModels();
  if (current === "home") renderHome();
  if (current === "settings") renderSettings();
  if (current === "context") renderContext();
  if (current === "lanes") { laneSig = ""; renderLanes(); }
}
// Model picker rows from the server's choices: one "<Family> <version>" per model grouped by family, the latest two per
// family shown and the rest folded under '이전 모델' (the current selection is never folded).
function modelPickItems(avail, val) {
  const items = [], groups = new Map(), older = [];
  for (const a of avail) { const g = a.family || providerName(a.provider); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); }
  const row = a => ({ value: a.selector, label: a.name || a.selector });
  for (const [g, list] of groups) {
    const now = list.filter(a => !a.older || a.selector === val);
    if (now.length) items.push({ header: g }, ...now.map(row));
    older.push(...list.filter(a => a.older && a.selector !== val));
  }
  if (older.length) items.push({ fold: [{ header: "이전 모델" }, ...older.map(row)], label: `이전 모델 ${older.length}개` });
  return items;
}
function modelItems(key, curModel, filter = providerFilter) {
  const val = (pending[key] || {}).model ?? curModel;
  // Pickers list M.pickable (no Haiku, no Fable); a target already on a hidden model still shows it under "현재".
  const avail = M.pickable || M.available || [];
  const shown = avail.filter(a => !filter || a.provider === filter);
  const items = [];
  if (val && !shown.some(a => a.selector === val)) items.push({ header: "현재" }, { value: val, label: modelName(val) });
  items.push(...modelPickItems(shown, val));
  return items;
}
// PUT /api/models for one target (the 모델 view and the 홈 card menus share it); confirms first when `confirmText` is set and again when the cache would be rewritten.
async function putModel(key, title, change, confirmText, label) {
  const body = { target: key, ...change };
  if (confirmText && !await ask(title, `${confirmText}\n${label}`, "적용")) return false;
  let r;
  try { r = await api("/api/models", "PUT", body); }
  catch (e) {
    if (!(e.data && e.data.requires_force)) throw e;
    if (!await ask(title, `캐시가 다시 쓰여요 · 컨텍스트 ${num(e.data.context_tokens)} 토큰\n${label}`, "적용")) return false;
    r = await api("/api/models", "PUT", { ...body, force: true });
  }
  delete pending[key];
  toast(applyKo[r.applied] || "적용했어요");
  await loadModels(true); refreshState();
  return true;
}
async function logoutProvider(p) {
  const name = p.name || p.id, key = p.auth === "api_key";
  if (!await ask(key ? `${name} 키 삭제` : `${name} 로그아웃`, key ? "저장된 API 키를 삭제할까요?" : "저장된 로그인 정보가 삭제돼요.", key ? "삭제" : "로그아웃", true)) return;
  await api(`/api/providers/${enc(p.id)}/logout`, "POST", {});
  toast(key ? "키를 삭제했어요" : "로그아웃했어요");
  await loadProviders(); loadModels(true);
  if (current === "home") renderHome();
}
// 모델 · 폴백: one card per target - its model and effort, then (orchestrator, lane default, workers) the ordered fallback
// chain that target's harness walks. The composer chips, the home card menu, 구성 and 설정 all open this screen.
let modelsFocus = "";
const openModels = key => { modelsFocus = key || ""; if (current === "models") renderModels(); else go("models"); };
function targetCard(key, title, status, cur, confirmText, extra = {}) {
  const p = pending[key] || {};
  const model = p.model ?? cur.model, thinking = p.thinking ?? cur.thinking;
  const dirty = (p.model != null && p.model !== cur.model) || (p.thinking != null && p.thinking !== cur.thinking);
  const levels = M.thinking_levels || [];
  const modelField = selectField("모델", modelName(model), () => modelItems(key, cur.model), model, v => { (pending[key] ||= {}).model = v; renderModels(); });
  // Effort is a dropdown next to the model, not a row of eight buttons (owner 2026-10-20: "드랍다운으로 모델이랑 추론정도 각각").
  const effField = selectField("추론 강도", thinking || "–", levels.map(lv => ({ value: lv, label: lv })), thinking, v => { (pending[key] ||= {}).thinking = v; renderModels(); });
  const info = (M.available || []).find(a => a.selector === model);
  const apply = el("button", { class: "btn", type: "button", disabled: !dirty, onclick: ev => busy(ev.currentTarget, async () => {
    const change = {};
    if (p.model != null && p.model !== cur.model) change.model = p.model;
    if (p.thinking != null && p.thinking !== cur.thinking) change.thinking = p.thinking;
    await putModel(key, title, change, confirmText, `${modelName(model)} · ${thinking}`);
  }) }, "적용");
  return el("section", { class: "card mt-card", "data-target": key, "aria-label": title },
    el("div", { class: "mt-head" }, status ? el("span", { class: `dot ${statusTone(status)}` }) : null, el("span", { class: "t", text: title }), extra.sub ? el("span", { class: "sup", text: extra.sub }) : null, el("span", { class: "sp" }), ...(extra.tags || [])),
    el("div", { class: "mt-pick" },
      el("div", { class: "mt-model" }, modelField),
      el("div", { class: "mt-eff" }, effField)),
    info && !info.reasoning && thinking && thinking !== "off" ? el("div", { class: "sup mt8", text: "이 모델은 추론 강도를 쓰지 않아요" }) : null,
    dirty ? el("div", { class: "btns mt-apply" }, el("button", { class: "btn text", type: "button", onclick: () => { delete pending[key]; renderModels(); } }, "되돌리기"), apply) : null,
    ...(extra.body || []));
}
function renderModels() {
  const box = $("#models");
  if (fbDragging) return;
  closeMenu(false);
  if (!M) { clear(box).append(emptyNode("불러오는 중…")); return; }
  const provs = [...new Set((M.available || []).map(a => a.provider))].sort((a, b) => providerName(a).localeCompare(providerName(b)));
  const filter = selectField("공급자", providerFilter ? providerName(providerFilter) : "전체", [{ value: "", label: "전체" }, ...provs.map(p => ({ value: p, label: providerName(p) }))], providerFilter, v => { providerFilter = v; renderModels(); });
  const lanes = (M.lanes || []).filter(laneAlive);
  clear(box).append(
    el("div", { class: "col mt" },
      el("div", { class: "mt-top" }, el("p", { class: "mt-intro", text: "대상마다 모델과 추론 강도, 막혔을 때 넘어갈 순서를 정해요. 어시스턴트·세션 폴백은 저장하면 바로 적용돼요." }), el("div", { class: "mt-filter" }, filter)),
      ...FB_LAYERS.map(L => targetCard(L.id, L.title(), "", L.cur(), L.confirm, fbParts(L))),
      lanes.length ? el("div", { class: "sec", text: "실행 중 세션" }) : null,
      ...lanes.map(l => targetCard(`lane:${l.name}`, l.name, l.status, l, "", { body: [el("div", { class: "note mt-foot", text: "폴백은 세션 기본값 순서를 따라요" })] }))));
  if (modelsFocus) {
    const n = box.querySelector(`[data-target="${CSS.escape(modelsFocus)}"]`);
    modelsFocus = "";
    if (n) requestAnimationFrame(() => n.scrollIntoView({ block: "start" }));
  }
}
