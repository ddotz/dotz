/* ---------- 모니터링 > 앱 > 설정 대화 ---------- */
// Every app with a settings schema (hub/app-settings.ts) has one pinned "설정" row and one conversation, target settings:<app>. Above the
// conversation the common settings are switches that PATCH /api/integrations/<app>/settings straight away (no model call). The owner's words
// go to the orchestrator, which answers with a ```dotz-settings block; it is drawn as a change card (before -> after) and only 적용 sends the same PATCH.
const AS_KEY = "dotz.settings.cards";
const AS = { by: {}, none: {}, load: {}, busy: {}, rm: {}, feat: {}, done: (() => { try { return JSON.parse(localStorage.getItem(AS_KEY)) || {}; } catch { return {}; } })() };
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
    if (typeof KK !== "undefined" && KK.loaded && app === "kakao") kkPaintAll();
    if (monCtx) convSchedule();
  })();
}
/* ---- 기능 and 내부 기능 (hub/app-features.ts): the app's features with switches, its approvals, and the login keepers and syncs it owns ---- */
const asFeatUrl = (app, op) => `/api/integrations/${enc(app)}/${op}`;
async function asFeatLoad(app) {
  try { asFeatSave(app, await api(asFeatUrl(app, "features"))); } catch { /* an older hub has no features route: the screen shows no 기능 section */ }
  asPaint();
}
const asFeatSave = (app, v) => { if (v && Array.isArray(v.features) && Array.isArray(v.internal) && Array.isArray(v.approvals)) AS.feat[app] = v; };
async function asFeatSet(app, id, on) {
  if (AS.busy[app]) return;
  AS.busy[app] = true;
  try { asFeatSave(app, await api(asFeatUrl(app, "features"), "PATCH", { id, on })); asLoad(app, true); } catch (e) { toast(e.message || "기능을 바꾸지 못했어요", true); }
  AS.busy[app] = false; asPaint();
}
async function asRetry(app, watch) {
  if (AS.busy[app]) return;
  AS.busy[app] = true;
  try { asFeatSave(app, await api(asFeatUrl(app, "retry"), "POST", { watch })); toast("다시 확인했어요"); } catch (e) { toast(e.message || "다시 시도하지 못했어요", true); }
  AS.busy[app] = false; MON.sig = ""; monSchedule(); asPaint();
}
// An answer from the row: the notice's own answer route on this computer, or - for a peer's app - the same answer sent to that computer (/api/peer/act, 34-peer-monitoring.js).
async function asApprove(app, a, o) {
  if (AS.busy[app]) return;
  AS.busy[app] = true; asPaint();
  try {
    const n = !app.includes("~") && typeof ntById === "function" ? ntById(a.id) : null;
    if (n) await ntPost(n, o.n);
    else await api(app.includes("~") ? `/api/integrations/${enc(app)}/approve` : `/api/notices/${enc(a.id)}/answer`, "POST", app.includes("~") ? { id: a.id, n: o.n } : { n: o.n });
    toast(`${o.label}(으)로 답했어요`);
    await asFeatLoad(app);
  } catch (e) { toast(e.message || "답하지 못했어요", true); }
  AS.busy[app] = false; asPaint();
}
function asApprovalNode(app, a) {
  const opts = a.options || [], when = a.at ? `승인 대기 · ${monTime(a.at)}` : "승인 대기";
  return el("div", { class: "as-row as-appr", "data-approval": a.id },
    el("span", { class: "as-b" }, el("span", { class: "as-n", text: a.title || "승인 요청" }), el("span", { class: "as-h", text: a.kind ? `${a.kind} · ${when}` : when }), ...(a.note ? [el("span", { class: "as-h as-warn", "data-note": "blocked", text: a.note })] : [])),
    el("span", { class: "as-btns" }, ...opts.map(o => el("button", { class: "btn tonal", type: "button", "data-k": `appr:${o.label}`, onclick: () => asApprove(app, a, o) }, o.label)),
      el("button", { class: "btn text", type: "button", "data-k": "appr:open", onclick: () => { if (ASC.h) ASC.h.close(false); go("monitoring", `i:${app.split("~")[0]}`); } }, "자세히")));
}
function asInternalNode(app, i) {
  const lines = [i.status, i.last_run ? `마지막 확인 ${monTime(i.last_run)}` : ""].filter(Boolean).join(" · ");
  return el("div", { class: "as-row as-int", "data-internal": i.id, "data-kind": i.kind },
    el("span", { class: `as-dot ${i.dot}`, "aria-hidden": "true" }),
    el("span", { class: "as-b" }, el("span", { class: "as-n", text: i.name }), el("span", { class: "as-h", text: lines }), ...(i.reason ? [el("span", { class: "as-h as-why", text: `이유: ${i.reason}` })] : [])),
    el("button", { class: "btn tonal", type: "button", "data-k": `retry:${i.id}`, onclick: () => asRetry(app, i.id) }, "다시 시도"));
}
function asFeatNodes(app, v) {
  return [
    ...(v.features.length ? [el("div", { class: "as-sec", text: "기능" }), ...v.features.map(f => el("div", { class: "as-row as-feat", "data-feature": f.id },
      el("span", { class: "as-b" }, el("span", { class: "as-n", text: f.name }), el("span", { class: "as-h", text: f.status })),
      kkSwitch(f.on, f.name, `feat:${f.id}`, on => asFeatSet(app, f.id, on))))] : []),
    ...(v.approvals.length ? [el("div", { class: "as-sec", text: "승인 대기" }), ...v.approvals.map(a => asApprovalNode(app, a))] : []),
    ...(v.internal.length ? [el("div", { class: "as-sec", text: "내부 기능" }), ...v.internal.map(i => asInternalNode(app, i))] : []),
    ...(v.features.length || v.approvals.length || v.internal.length ? [el("div", { class: "as-sec", text: "설정" })] : [])];
}
async function asPatch(app, values) {
  const r = await api(asUrl(app), "PATCH", { values });
  AS.by[app] = r.fields || [];
  asPaint();
  MON.sig = ""; monSchedule();
  if (app.includes("~")) pqSoon(); else loadIntegrations();   // a peer app's name and switches are read back from that computer
  return r;
}

/* ---- 제거 (this install only) and 앱 추가 ---- */
async function asRemoveAsk(app) {
  // What a peer's app would remove is read there only when it runs (the peer's read list has no remove plan).
  try { AS.rm[app] = { plan: app.includes("~") ? null : await api(`/api/integrations/${enc(app)}/remove`), del: false }; } catch (e) { return toast(e.message || "제거할 내용을 읽지 못했어요", true); }
  asPaint();
}
async function asRemoveGo(app) {
  const rm = AS.rm[app];
  if (!rm || AS.busy[app]) return;
  AS.busy[app] = true;
  try { await api(`/api/integrations/${enc(app)}/remove`, "POST", { deleteData: rm.del }); toast(`${rm.plan ? rm.plan.label : monSettingsName(`settings:${app}`)}을(를) ${rm.plan ? "이 기기에서" : "그 컴퓨터에서"} 제거했어요`); AS.rm[app] = null; AS.load[app] = null; if (app.includes("~")) await pqLoad(); else await loadIntegrations(); if (ASC.h) ASC.h.close(false); go("monitoring"); }
  catch (e) { toast(e.message || "제거하지 못했어요", true); }
  AS.busy[app] = false; asPaint();
}
function asRemoveNode(app) {
  const rm = AS.rm[app];
  if (!rm) return el("div", { class: "as-row" }, el("span", { class: "as-b" }, el("span", { class: "as-n", text: "앱 제거" }), el("span", { class: "as-h", text: "이 기기에서만 지워요. 다른 컴퓨터는 그대로예요" })), el("button", { class: "btn tonal", type: "button", "data-as-rm": "ask", onclick: () => asRemoveAsk(app) }, "제거"));
  const p = rm.plan, cb = el("input", { type: "checkbox", "data-k": "delete-data", onchange: () => { rm.del = cb.checked; } });
  const lines = p ? ["이 기기의 앱 목록에서 빼고, 알림과 푸시를 멈춰요", p.watches.length ? `감시 ${p.watches.length}개를 지워요: ${p.watches.join(", ")}` : "지울 감시는 없어요", p.features.length ? `기능을 이 기기에서 꺼요: ${p.features.join(", ")}` : "끌 기능은 없어요", "다른 컴퓨터의 같은 앱은 그대로예요"]
    : ["그 컴퓨터의 앱 목록에서 빼고, 알림과 푸시를 멈춰요", "이 앱의 감시도 함께 꺼요", "이 컴퓨터와 다른 컴퓨터의 같은 앱은 그대로예요"];
  return el("div", { class: "as-rm" },
    el("div", { class: "as-n", text: p ? `${p.label}을(를) 이 기기에서 제거할까요?` : "이 앱을 그 컴퓨터에서 제거할까요?" }),
    el("ul", { class: "as-rml" }, ...lines.map(t => el("li", { text: t }))),
    !p || p.data.length ? el("label", { class: "as-del" }, cb, el("span", { text: p ? `저장된 데이터(${p.data.join(", ")})도 지우기. 체크하지 않으면 남겨요` : "저장된 데이터도 지우기. 체크하지 않으면 남겨요" })) : null,
    el("div", { class: "as-act" }, el("button", { class: "btn", type: "button", "data-as-rm": "go", onclick: () => asRemoveGo(app) }, "제거 확인"), el("button", { class: "btn tonal", type: "button", "data-as-rm": "cancel", onclick: () => { AS.rm[app] = null; asPaint(); } }, "취소")));
}
// 앱 추가: the last row of the 앱 group opens a sheet. It lists only the apps this computer (and each other computer, labeled with its name) had and
// the owner switched off or removed, each with 다시 켜기, then 새로 추가하기: the chat box opens on the main orchestrator with a detailed activation
// prompt (GET /api/app-templates, hub/app-templates.ts) the owner edits before sending. A chip row above the box swaps the template. The sheet lists
// every kind of app (메일, 카카오톡, ..., 직접 쓰기) so one tap picks the right template.
const AT = { items: [], key: "", h: null };
const asOffApps = () => {
  const peers = PQ.list.filter(p => p && p.url), me = peers.length ? pqSelf() : "";
  return [...INTG.available.map(a => ({ ...a, pc: null, machine: me })),
    ...peers.flatMap(p => ((p.items && p.items.available) || []).map(a => ({ ...a, pc: { name: p.name, url: p.url }, machine: p.name })))];
};
// 삭제: an off instance is deleted for good (DELETE /api/apps/<id>, hub/app-off.ts deleteApp). AD.del = the row with its confirm open: {key, pcUrl, label, machine, plan, data, busy}.
const AD = { del: null };
const asDelOpen = a => AD.del && AD.del.key === a.key && AD.del.pcUrl === (a.pc ? a.pc.url : "");
async function asDelAsk(a) {
  const d = AD.del = { key: a.key, pcUrl: a.pc ? a.pc.url : "", label: a.label, machine: a.machine, plan: null, data: false, busy: false };
  asAddPaint();
  if (a.pc) return;   // what the other computer would delete is read there only when it runs
  try { d.plan = await api(`/api/integrations/${enc(a.key)}/remove`); } catch { /* the confirm still lists the general parts */ }
  asAddPaint();
}
async function asDelGo(a) {
  const d = AD.del;
  if (!d || d.busy) return;
  d.busy = true;
  try {
    if (a.pc) await api(pqProxy(a.pc, "/api/peer/act"), "POST", { action: "app", args: { op: "delete", app: a.key, deleteData: d.data } });
    else await api(`/api/apps/${enc(a.key)}${d.data ? "?data=1" : ""}`, "DELETE");
    toast(`${a.label}을(를) 삭제했어요`);
    AD.del = null; AS.load[a.key] = null;
    if (a.pc) await pqLoad(); else await loadIntegrations();
  } catch (e) { d.busy = false; toast(e.message || "삭제하지 못했어요", true); }
  asAddPaint();
}
function asDelNode(a) {
  const d = AD.del, p = d.plan, cb = el("input", { type: "checkbox", "data-k": "delete-data", onchange: () => { d.data = cb.checked; } });
  cb.checked = d.data;
  const lines = [`${d.machine ? `${d.machine}에서 ` : ""}${a.label}을(를) 완전히 지워요. 되돌릴 수 없어요`, "이름과 설정을 지우고, 앱 목록에서 빠져요", p ? (p.watches.length ? `감시 ${p.watches.length}개를 지워요: ${p.watches.join(", ")}` : "지울 감시는 없어요") : "이 앱의 감시도 함께 지워요"];
  return el("div", { class: "as-rm", "data-k": "del-confirm" },
    el("ul", { class: "as-rml" }, ...lines.map(t => el("li", { text: t }))),
    !p || p.data.length ? el("label", { class: "as-del" }, cb, el("span", { text: p ? `저장된 데이터(${p.data.join(", ")})도 지우기. 체크하지 않으면 남겨요` : "저장된 데이터도 지우기. 체크하지 않으면 남겨요" })) : null,
    el("div", { class: "as-act" }, el("button", { class: "btn", type: "button", "data-k": "del-go", disabled: d.busy, onclick: () => asDelGo(a) }, "삭제 확인"), el("button", { class: "btn tonal", type: "button", "data-k": "del-cancel", onclick: () => { AD.del = null; asAddPaint(); } }, "취소")));
}
// The 앱 관리 row's second line: what it holds (the apps switched off, then adding a new one), not a bare list of names that reads like apps in use.
const asAddHint = () => { const off = asOffApps().map(a => a.label); return off.length ? `꺼 둔 앱 ${off.join(", ")} · 새로 추가` : "새로 추가하기"; };
async function asTplLoad() {
  try { AT.items = (await api("/api/app-templates")).items || []; } catch { AT.items = []; }
}
async function asAddSheet() {
  if (AT.h) return;
  const h = AT.h = fsOpen({ labelledby: "as-add-t", onClose: () => { if (AT.h === h) AT.h = null; } });
  asAddPaint();
  await asTplLoad();
  asAddPaint();
}
function asAddPaint() {
  const h = AT.h;
  if (!h) return;
  const off = asOffApps();
  for (const a of off) if (a.iconPath && !ICONS[a.icon]) ICONS[a.icon] = a.iconPath;
  clear(h.box).append(
    fsHead([el("h2", { class: "fs-t", id: "as-add-t", text: "앱 관리" })], { close: () => h.close() }),
    el("div", { class: "fs-body" },
      ...(off.length ? [el("div", { class: "as-sec", text: "꺼 둔 앱" }), ...off.flatMap(a => [el("div", { class: "as-row", "data-app": a.key },
        el("span", { class: "as-ic", "aria-hidden": "true" }, icon(a.icon)),
        el("span", { class: "as-b" }, el("span", { class: "as-n", text: a.label }), el("span", { class: "as-h", text: a.machine ? `${a.machine} · 꺼져 있어요` : "꺼져 있어요" })),
        el("span", { class: "as-btns" },
          el("button", { class: "btn tonal", type: "button", "data-k": `on:${a.key}`, onclick: () => asAdd(a.key, a.pc) }, "다시 켜기"),
          el("button", { class: "btn tonal", type: "button", "data-k": `del:${a.key}`, "aria-expanded": String(asDelOpen(a)), onclick: () => asDelOpen(a) ? (AD.del = null, asAddPaint()) : asDelAsk(a) }, "삭제"))),
        ...(asDelOpen(a) ? [asDelNode(a)] : [])])] : []),
      // 새로 추가: one tap per kind of app opens its template; 직접 쓰기 is the free-form one.
      el("div", { class: "as-sec", text: "새로 추가" }),
      AT.items.length ? el("div", { class: "as-tpls", role: "group", "aria-label": "새로 추가할 앱" }, ...AT.items.map(t => el("button", { class: "as-tpl", type: "button", "data-tpl": t.key, onclick: () => asNewApp(t.key) }, t.label)))
        : el("div", { class: "as-h", text: "불러오는 중…" })));
}
async function asNewApp(key) {
  if (!AT.items.length) await asTplLoad();
  const t = AT.items.find(x => x.key === key) || AT.items[AT.items.length - 1];
  if (!t) return toast("템플릿을 불러오지 못했어요", true);
  if (AT.h) AT.h.close(false);
  ts("main").draft = t.text;
  go("chat", "main");
  AT.key = t.key;
  asTplFill(t);
}
function asTplFill(t) {
  ta.value = t.text; saveDraft(); autosize(); updateHints();
  asTplPaint();
  ta.focus({ preventScroll: true }); ta.setSelectionRange(0, 0); ta.scrollTop = 0;
}
// The chip row above the chat box while a template is in it; it ends when the message is sent or another conversation opens.
function asTplPaint() {
  let row = $("#app-tpl");
  if (!AT.key) { if (row) row.hidden = true; const n = $("#app-tpl-note"); if (n) n.hidden = true; return; }
  if (!row) { row = el("div", { class: "tplrow", id: "app-tpl", role: "group", "aria-label": "앱 템플릿" }); $("#composer").insertBefore(row, $("#hints")); }
  row.hidden = false;
  clear(row).append(...AT.items.map(t => el("button", { class: "as-tpl", type: "button", "data-tpl": t.key, "aria-pressed": String(t.key === AT.key), onclick: () => { AT.key = t.key; asTplFill(t); } }, t.label)),
    el("button", { class: "as-tpl as-tpl-x", type: "button", "aria-label": "템플릿 닫기", onclick: asTplEnd }, icon("close")));
  const on = row.querySelector('[aria-pressed="true"]');
  if (on) row.scrollLeft = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
  // The {{ }} fields are the owner's own details: the bot asks for them in the secure form after the message is sent, so they can stay as they are.
  let note = $("#app-tpl-note");
  if (!note) { note = el("div", { class: "tplnote", id: "app-tpl-note", text: "{{ }} 칸은 그대로 보내도 돼요. 보내면 보안 입력 양식으로 물어봐요" }); row.after(note); }
  note.hidden = false;
}
function asTplEnd() { AT.key = ""; asTplPaint(); }
function asTplSync() { if (AT.key && (target !== "main" || current !== "chat")) asTplEnd(); }
async function asAdd(key, pc) {
  const a = asOffApps().find(x => x.key === key && (x.pc ? x.pc.url : "") === (pc ? pc.url : ""));
  if (!a) return;
  try {
    if (pc) {
      await api(pqProxy(pc, "/api/peer/act"), "POST", { action: "app", args: { op: "add", app: key } });
      toast(`${pc.name}에서 ${a.label}을(를) 다시 켰어요`);
      await pqLoad(); asAddPaint(); return;
    }
    const r = await api(`/api/integrations/${enc(key)}/add`, "POST", {});
    AS.load[key] = null;
    await loadIntegrations();
    if (AT.h) AT.h.close(false);
    if (r.ready) { toast(`${a.label}을(를) 다시 켰어요`); go("monitoring", `i:${key}`); return; }
    toast(`${a.label}을(를) 켰어요. 다시 연결할 내용을 채워 두었어요`);
    await asNewApp(/^site(-|$)/.test(key) ? "comments" : key);
  } catch (e) { toast(e.message || "앱을 추가하지 못했어요", true); }
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
// The options and the status of the settings screen (asScreen) - never of the conversation, which is chat only.
function asPaint() {
  const box = $("#app-sw"), app = ASC.app;
  if (!box || !app) return;
  const fields = AS.by[app];
  if (!fields) {
    const sig = AS.none[app] ? "none" : "load";
    if (box.dataset.sig !== sig) { box.dataset.sig = sig; clear(box).append(el("div", { class: "as-row" }, el("span", { class: "as-h", text: AS.none[app] ? "설정을 불러오지 못했어요" : "불러오는 중…" }))); }
    return;
  }
  const feat = app.startsWith("w:") ? null : AS.feat[app] || null, stat = feat ? [] : monStatMons(app);
  const sig = JSON.stringify([app, fields.map(f => f.value), AS.busy[app], !!AS.rm[app], stat, feat]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  // 기억 항목 (attach folder, follow-up rule) are learned in conversation, never typed here: shown read only, with how to change them.
  const sw = fields.filter(f => f.switch), other = fields.filter(f => !f.switch && !f.memory), mem = fields.filter(f => f.memory);
  clear(box).append(
    ...stat.map(monStatNode),
    ...(feat ? asFeatNodes(app, feat) : []),
    ...[...sw, ...other].map(f => el("div", { class: "as-row", "data-setting": f.key },
      el("span", { class: "as-b" }, el("span", { class: "as-n", text: f.label }), el("span", { class: "as-h", text: f.help })),
      // A list is edited in the conversation (a change card); here it only says how many.
      f.type === "list" ? el("span", { class: "as-v", text: asFmt(f, f.value) }) : asControl(f, async v => {
        if (AS.busy[app]) return;
        AS.busy[app] = true;
        try { await asPatch(app, { [f.key]: v }); } catch (e) { toast(e.message || "설정을 바꾸지 못했어요"); }
        AS.busy[app] = false; delete box.dataset.sig; asPaint();
      }))),
    ...(mem.length ? [el("div", { class: "as-row as-mem", "data-setting": "memory" },
      el("span", { class: "as-b" }, el("span", { class: "as-n", text: "기억해 둔 것" }),
        el("span", { class: "as-h", text: "대화에서 알려 주면 봇이 기억하고 참고해요. 바꾸려면 대화에서 말해 주세요" }),
        ...mem.map(f => el("span", { class: "as-h", text: `${f.label}: ${f.value === "" || f.value == null ? "아직 없어요" : asFmt(f, f.value)}` }))))] : []),
    ...(app.startsWith("w:") ? [] : [asRemoveNode(app)]));
}
// The settings screen: a view pushed over the conversation (back button on a phone and on a wide screen) with the status card and every option row.
// The conversation keeps only the chat; its header's ⋯ button opens this.
const ASC = { app: "", h: null };
function asScreen(app) {
  if (ASC.h || !app) return;
  asLoad(app);
  const h = ASC.h = fsOpen({ labelledby: "as-scr-t", cls: "tall as-screen", onClose: () => { if (ASC.h === h) { ASC.h = null; ASC.app = ""; } } });
  ASC.app = app;
  if (!app.startsWith("w:")) asFeatLoad(app);
  clear(h.box).append(
    el("div", { class: "fs-hd" }, el("button", { class: "ib fs-x as-back", type: "button", "aria-label": "뒤로", "data-k": "as-back", onclick: () => h.close() }, icon("back")),
      el("div", { class: "fs-tt" }, el("span", { class: "fs-ey", text: "설정" }), el("h2", { class: "fs-t", id: "as-scr-t", text: monSettingsName(`settings:${app}`) }))),
    el("div", { class: "fs-body" }, el("div", { class: "app-sw", id: "app-sw" })));
  asPaint();
}
// Called when the conversation head is drawn (31-conversations.js convPaintHead).
function asSync() {
  if (isSettingsT(target)) asLoad(settingsApp(target));
  asPaint();
  asChipPaint();
}

/* ---- a failing monitor's quick actions: chips that only fill the composer of its conversation (the owner reads and sends) ---- */
const asMon = app => { const pe = PQ.of.get(`settings:${app}`); return pe ? pe.mon : NM.items.find(x => x.watch === app.slice(2)); };
const asChipTexts = m => m && m.last_result === "fail" ? [...(m.keeper ? ["다시 로그인해 줘"] : []), "원인 찾아 줘", "일시정지"] : [];
// Every monitor and app has its own settings conversation, also a monitor a project created (it is not the project's).
const asConv = app => `settings:${app}`;
// A quick instruction is sent as it is; whatever the owner had typed stays in the box.
function asSend(text) {
  const draft = ta.value;
  ta.value = text;
  sendChat();
  ta.value = draft;
  saveDraft(); autosize(); updateHints();
}
function asAsk(app, text) {
  const t = asConv(app);
  if (target !== t || current !== "monitoring") go("monitoring", `c:${t}`);
  asSend(text);
}
function asChipPaint() {
  const app = isSettingsT(target) ? settingsApp(target) : "", texts = app.startsWith("w:") ? asChipTexts(asMon(app)) : [];
  let row = $("#mon-chips");
  if (!texts.length) { if (row) row.hidden = true; return; }
  if (!row) { row = el("div", { class: "tplrow", id: "mon-chips", role: "group", "aria-label": "빠른 지시" }); $("#composer").insertBefore(row, $("#hints")); }
  row.hidden = false;
  const sig = JSON.stringify([app, texts]);
  if (row.dataset.sig === sig) return;
  row.dataset.sig = sig;
  clear(row).append(...texts.map(t => el("button", { class: "as-tpl", type: "button", "data-chip": t, onclick: () => asSend(t) }, t)));
}

/* ---- the entries of a detail's title bar (the head on a wide screen, the app bar on a phone): 대화 opens its settings conversation, ⋯ the settings screen ---- */
function asOpen(ev) { go("monitoring", `c:${asConv(ev.currentTarget.dataset.asOpen)}`); }
const asBtn = app => el("button", { class: "ib as-hd", type: "button", "aria-label": "대화", title: "대화", "data-as-open": app, onclick: asOpen }, icon("chat"));
// The two buttons of `app` ("mail", "w:<watch>"): 대화 and ⋯; none while its settings are not loaded (an app without any shows no button).
function asEntry(app) {
  if (!app) return [];
  if (!AS.load[app]) asLoad(app);
  return AS.by[app] ? [asBtn(app), asMoreBtn(app)] : [];
}
// The phone has no head: the same button sits in the app bar beside the title and follows the open detail.
var asBar = asBtn("");   // var: the app bar is drawn (31-conversations.js convTitle) before this file runs
asBar.id = "as-bar"; asBar.hidden = true;
$("#vtog").before(asBar);
// ⋯ opens the settings screen (in a detail's title bar and in the settings conversation's head).
function asMoreBtn(app) { return el("button", { class: "ib as-hd as-more", type: "button", "aria-label": "설정", title: "설정", "data-as-more": app, onclick: ev => asScreen(ev.currentTarget.dataset.asMore) }, icon("more")); }
var asMoreBar = asMoreBtn("");   // var: convTitle runs before this file
asMoreBar.id = "as-more-bar"; asMoreBar.hidden = true;
$("#vtog").before(asMoreBar);
function asMoreSync(app) {
  asMoreBar.hidden = !app || !(isSettingsT(target) || AS.by[app]);
  if (app) asMoreBar.dataset.asMore = app;
}
function asBarSync(app) {
  const on = !!app && !!asEntry(app).length;
  asBar.hidden = !on;
  if (on) asBar.dataset.asOpen = app;
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
  // only memory keys: the gateway kept them already (hub/app-settings.ts applyMemory), so there is nothing to apply
  const memOnly = fields.length && Object.keys(ch).every(k => (fields.find(x => x.key === k) || {}).memory);
  if (memOnly) return `<div class="as-card applied"><div class="as-ct">기억해 뒀어요</div>${Object.entries(ch).map(([k, v]) => { const f = fields.find(x => x.key === k); return `<div class="as-cr"><span class="as-cn">${esc(f.label)}</span><span class="as-cv">${esc(asFmt(f, v))}</span></div>`; }).join("")}</div>`;
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
