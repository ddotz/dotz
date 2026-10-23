/* ---------- 모니터링 > 앱 > 설정 대화 ---------- */
// Every app with a settings schema (hub/app-settings.ts) has one pinned "설정" row and one conversation, target settings:<app>. Above the
// conversation the common settings are switches that PATCH /api/integrations/<app>/settings straight away (no model call). The owner's words
// go to the orchestrator, which answers with a ```dotz-settings block; it is drawn as a change card (before -> after) and only 적용 sends the same PATCH.
const AS_KEY = "dotz.settings.cards";
const AS = { by: {}, none: {}, load: {}, busy: {}, done: (() => { try { return JSON.parse(localStorage.getItem(AS_KEY)) || {}; } catch { return {}; } })() };
const asSave = () => { try { localStorage.setItem(AS_KEY, JSON.stringify(AS.done)); } catch { /* storage full or blocked: the card state lasts until reload */ } };

// An app is "mail", "kakao"...; a monitor is "w:<watch name>" (hub/watch-settings.ts): same schema, same card, a different URL.
const asUrl = app => app.startsWith("w:") ? `/api/watches/${enc(app.slice(2))}/settings` : `/api/integrations/${enc(app)}/settings`;

function asLoad(app, again) {
  if (AS.load[app] && !again) return AS.load[app];
  return AS.load[app] = (async () => {
    try { AS.by[app] = (await api(asUrl(app))).fields || []; delete AS.none[app]; }
    catch { AS.none[app] = true; }
    asPaint();
    MON.sig = ""; monSchedule();
    if (typeof KK !== "undefined" && KK.loaded && app === "kakao") kkPaintRooms();
  })();
}
async function asPatch(app, values) {
  const r = await api(asUrl(app), "PATCH", { values });
  AS.by[app] = r.fields || [];
  asPaint();
  MON.sig = ""; monSchedule();
  return r;
}

const asYes = v => v ? "켜짐" : "꺼짐";
function asFmt(f, v) {
  if (f.type === "bool") return asYes(v);
  if (f.type === "list") return v.length ? `${v.length}개` : "없음";
  if (f.type === "enum") return (f.labels || {})[v] || String(v);
  return String(v) || "없음";
}
// A list changes by what leaves and what comes in; the rest by before -> after.
function asChange(f, before, after) {
  if (f.type !== "list") return `${asFmt(f, before)} → ${asFmt(f, after)}`;
  const add = after.filter(x => !before.includes(x)), del = before.filter(x => !after.includes(x));
  return [add.length ? `추가 ${add.join(", ")}` : "", del.length ? `뺌 ${del.join(", ")}` : "", !add.length && !del.length ? "달라지는 것 없음" : ""].filter(Boolean).join(" · ");
}

/* ---- the controls above the conversation: a switch, a menu or a box per common setting ---- */
function asControl(f, set) {
  if (f.type === "bool") return kkSwitch(f.value, f.label, f.key, set);
  const num = f.type === "number";
  const c = f.type === "enum"
    ? el("select", { class: "fi as-in", "aria-label": f.label, "data-k": f.key, onchange: () => set(c.value) }, ...(f.options || []).map(o => el("option", { value: o, text: (f.labels || {})[o] || o })))
    : el("input", { class: "fi as-in", type: num ? "number" : "text", ...(num ? { min: f.min, max: f.max, inputmode: "numeric" } : {}), "aria-label": f.label, "data-k": f.key, onchange: () => set(num ? Number(c.value) : c.value.trim()) });
  c.value = String(f.value);
  return c;
}
function asPaint() {
  const box = $("#app-sw");
  if (!box) return;
  const app = isSettingsT(target) ? settingsApp(target) : "", fields = app ? AS.by[app] : null;
  if (!fields) { box.hidden = true; delete box.dataset.sig; clear(box); return; }
  const sig = JSON.stringify([app, fields.map(f => f.value), AS.busy[app]]);
  box.hidden = false;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const sw = fields.filter(f => f.switch), other = fields.filter(f => !f.switch);
  clear(box).append(
    ...sw.map(f => el("div", { class: "as-row" },
      el("span", { class: "as-b" }, el("span", { class: "as-n", text: f.label }), el("span", { class: "as-h", text: f.help })),
      asControl(f, async v => {
        if (AS.busy[app]) return;
        AS.busy[app] = true;
        try { await asPatch(app, { [f.key]: v }); } catch (e) { toast(e.message || "설정을 바꾸지 못했어요"); }
        AS.busy[app] = false; delete box.dataset.sig; asPaint();
      }))),
    ...(other.length ? [el("div", { class: "as-sum" }, ...other.map(f => el("span", { class: "as-chip", title: f.help, text: `${f.label} ${asFmt(f, f.value)}` })))] : []));
}
// Called when the conversation head is drawn (31-conversations.js convPaintHead).
function asSync() {
  if (isSettingsT(target)) asLoad(settingsApp(target));
  asPaint();
}

/* ---- the pinned row of an app's list ---- */
function asPinnedRow(app) {
  if (!AS.load[app]) asLoad(app);
  if (!AS.by[app]) return null;
  const sw = AS.by[app].filter(f => f.switch), hint = sw.length ? sw.map(f => `${f.label} ${asFmt(f, f.value)}`).join(" · ") : "말로 설정을 바꿔요";
  return el("button", { class: "cv-row pv as-pin", type: "button", onclick: () => go("monitoring", `c:settings:${app}`) },
    el("span", { class: "cv-av nt", "aria-hidden": "true" }, icon("settings")),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: "설정" }), el("span", { class: "cv-p", text: hint })));
}

/* ---- the change card: a ```dotz-settings fence in an answer (mdHtml in 02-basic-markdown.js) ---- */
const asId = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
function settingsCardHtml(src) {
  let b = null;
  try { b = JSON.parse(src); } catch { /* shown as unreadable below */ }
  const ch = b && b.changes && typeof b.changes === "object" && !Array.isArray(b.changes) ? b.changes : null, app = b ? String(b.app || "") : "";
  if (!ch || !Object.keys(ch).length) return `<div class="as-card"><div class="as-ct">변경 제안을 읽지 못했어요</div></div>`;
  if (!AS.load[app]) asLoad(app).then(() => typeof renderAll === "function" && renderAll());
  const fields = AS.by[app] || [], id = asId(String(src).trim()), state = AS.done[id];
  const rows = Object.entries(ch).map(([k, v]) => {
    const f = fields.find(x => x.key === k);
    const text = !f ? JSON.stringify(v) : state === "applied" ? asFmt(f, v) : asChange(f, f.value, v);
    return `<div class="as-cr"><span class="as-cn">${esc(f ? f.label : k)}</span><span class="as-cv">${esc(text)}</span></div>`;
  }).join("");
  const foot = state ? `<div class="as-done ${state}">${state === "applied" ? "적용했어요" : "취소했어요"}</div>`
    : `<div class="as-act"><button class="btn" type="button" data-as="apply">적용</button><button class="btn tonal" type="button" data-as="cancel">취소</button></div>`;
  return `<div class="as-card${state ? ` ${state}` : ""}" data-as-id="${id}" data-as-app="${esc(app)}" data-as-src="${esc(String(src).trim())}"><div class="as-ct">설정 바꾸기 제안</div>${rows}${foot}</div>`;
}
document.addEventListener("click", async ev => {
  const btn = ev.target.closest && ev.target.closest("[data-as]");
  const card = btn && btn.closest(".as-card");
  if (!card) return;
  const id = card.dataset.asId, app = card.dataset.asApp, src = card.dataset.asSrc;
  const redraw = () => { card.outerHTML = settingsCardHtml(src); };
  if (btn.dataset.as === "cancel") { AS.done[id] = "cancelled"; asSave(); redraw(); return; }
  btn.disabled = true;
  try { await asPatch(app, JSON.parse(src).changes); AS.done[id] = "applied"; asSave(); redraw(); }
  catch (e) { btn.disabled = false; toast(e.message || "설정을 바꾸지 못했어요"); }
});
