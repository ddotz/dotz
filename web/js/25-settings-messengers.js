// 설정 → 메신저: the chat services dotz also talks through (GET /api/messengers, GET/PUT /api/messengers/<id>, POST .../test, hub/messengers-api.ts).
// Each service describes its own settings (hub/messenger.ts Settings), so this screen draws any of them: a list with a state dot, a detail dialog
// (switch, fields, allowlist, and the rooms it mirrors from the web app, read-only: the gateway makes and maps them, hub/messenger-rooms.ts). Secrets are write-only: the page only learns whether one is set ("저장됨").
const MS_KINDS = [["main", "메인 대화"], ["project", "프로젝트"], ["alert", "알림"], ["worklog", "작업내역"]];
const MS_AS_USER = "내 계정으로 보냅니다";
const MSN = { items: null, detail: {}, fail: "", asked: false };
const msKind = k => (MS_KINDS.find(x => x[0] === k) || [k, k])[1];
const msState = m => m.state === "ok" ? ["연결됨", "ok"] : m.state === "error" ? ["연결 안 됨", "err"] : m.state === "connecting" ? ["연결 중", "warn"] : [m.enabled ? "꺼짐" : "사용 안 함", ""];
const msAgo = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? "방금" : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`; };

// The list is drawn as soon as it arrives and again when the details (room counts) are in: a slow or stuck detail never leaves the screen blank.
async function loadMessengers() {
  MSN.asked = true; MSN.fail = "";
  if (current === "messengers") renderMessengers();
  try {
    MSN.items = (await api("/api/messengers")).items; MSN.fail = "";
    if (current === "messengers") renderMessengers();
    await Promise.all(MSN.items.map(async m => { try { MSN.detail[m.id] = await api(`/api/messengers/${enc(m.id)}`); } catch { delete MSN.detail[m.id]; } }));
  } catch (e) { MSN.items = null; MSN.fail = e.message; }
  if (current === "messengers") renderMessengers();
}
const msRoomsOf = m => { const d = MSN.detail[m.id]; return d && d.rooms ? d.rooms.items.length : 0; };

function renderMessengers() {
  const box = $("#messengers");
  if (!MSN.items) { clear(box).append(MSN.asked && MSN.fail ? emptyNode("메신저 설정을 불러오지 못했어요") : emptyNode("불러오는 중")); return; }
  const row = m => {
    const [tag, tone] = msState(m), n = msRoomsOf(m);
    return el("button", { type: "button", class: "li tap", "data-ms": m.id, onclick: () => msOpen(m.id) },
      el("span", { class: "lead" }, icon(m.id === "discord" ? "discord" : "chat")),
      el("span", { class: "tx" }, el("div", { class: "hd", text: m.label }), el("div", { class: "sup", text: m.error || (n ? `방 ${n}개` : "") })),
      el("span", { class: "dcs-trail" }, el("span", { class: `dot ${tone}`, "aria-hidden": "true" }), el("span", { class: `tag ${tone}`, text: tag }), icon("chev", "lead")));
  };
  clear(box).append(el("div", { class: "sec", text: "연결" }), el("div", { class: "list" }, ...MSN.items.map(row)));
}

/* ---------- detail ---------- */
let MD = null;
async function msOpen(id) {
  let s;
  try { s = await api(`/api/messengers/${enc(id)}`); } catch (e) { return toast(e.message, true); }
  const m = (MSN.items || []).find(x => x.id === id) || { id, label: id };
  const body = el("div", { class: "col" });
  MD = { id, s, enabled: s.enabled, vals: {}, allow: s.allow ? s.allow.items.slice() : null, test: null, body, inputs: {}, add: input({ placeholder: s.allow && s.allow.hint || "", name: "ms-allow" }) };
  const d = dialog({ title: m.label, body, onclose: () => { MD = null; }, actions: [] });
  MD.dlg = d;
  msRenderDetail();
}
const msReadOnly = s => !!s.link || !s.rooms && !s.allow && !s.fields.some(f => f.type === "text" || f.type === "number");
function msDirty() {
  const { s } = MD, vals = Object.keys(MD.vals).filter(k => String(MD.vals[k]) !== String((s.fields.find(f => f.key === k) || {}).value));
  const allow = MD.allow && JSON.stringify(MD.allow) !== JSON.stringify(s.allow.items);
  return { vals, allow, any: MD.enabled !== s.enabled || vals.length > 0 || allow };
}
async function msSave(btn) {
  const { s } = MD, dirty = msDirty(), put = {};
  if (MD.enabled !== s.enabled) put.enabled = MD.enabled;
  if (dirty.vals.length) put.values = Object.fromEntries(dirty.vals.map(k => [k, MD.vals[k]]));
  if (dirty.allow) put.allow = MD.allow;
  await busy(btn, async () => {
    MD.s = await api(`/api/messengers/${enc(MD.id)}`, "PUT", put);
    MD.enabled = MD.s.enabled; MD.vals = {}; MD.allow = MD.s.allow ? MD.s.allow.items.slice() : null;
    toast("저장했어요");
    await loadMessengers();
  });
  if (MD) msRenderDetail();
}
// 알림 switches save at once (PUT { notify }, hub/messengers-api.ts): they need no restart, so they skip the sheet's 저장.
async function msNotifySet(k, on) {
  const id = MD.id;
  try {
    const s = await api(`/api/messengers/${enc(id)}`, "PUT", { notify: { [k]: on } });
    if (MD && MD.id === id) { MD.s = { ...MD.s, notify: s.notify }; msRenderDetail(); }
  } catch (e) { toast(e.message, true); }
}
async function msTest(btn) {
  await busy(btn, async () => { MD.test = (await api(`/api/messengers/${enc(MD.id)}/test`, "POST", {})).results; });
  if (MD) msRenderDetail();
}
function msFieldInput(f) {
  const { s } = MD;
  if (f.type === "readonly") return el("div", { class: "tf" }, el("span", { class: "lb", text: f.label }), el("div", { class: "sup", text: String(f.value ?? "") }));
  if (f.type === "secret") {
    const i = input({ type: "password", autocomplete: "new-password", name: `ms-${f.key}`, placeholder: f.set ? "바꾸려면 새로 붙여 넣기" : f.label, oninput: ev => { const v = ev.target.value.trim(); if (v) MD.vals[f.key] = v; else delete MD.vals[f.key]; msSync(); } });
    return el("div", {}, textField(f.label, i), f.set ? el("div", { class: "tag ok dcs-saved", "data-set": f.key, text: "저장됨" }) : null,
      f.as_user ? el("div", { class: "tag warn", "data-as-user": f.key, text: MS_AS_USER }) : null, f.hint ? el("div", { class: "sup", text: f.hint }) : null);
  }
  const cur = MD.vals[f.key] !== undefined ? MD.vals[f.key] : f.value;
  const i = input({ value: cur == null ? "" : String(cur), ...(f.type === "number" ? { type: "number", inputmode: "numeric", min: "0" } : {}), name: `ms-${f.key}`, oninput: ev => { MD.vals[f.key] = f.type === "number" ? Number(ev.target.value) : ev.target.value; msSync(); } });
  return el("div", {}, textField(f.label, i), f.hint ? el("div", { class: "sup", text: f.hint }) : null);
}
function msSync() {
  const save = MD.dlg.node.querySelector("[data-ms-save]");
  if (save) save.disabled = !msDirty().any;
}
function msRenderDetail() {
  const { s } = MD, ro = msReadOnly(s), dirty = msDirty();
  const rows = [];
  if (!ro) rows.push(el("div", { class: "li" }, el("span", { class: "lead" }, icon("bell")), el("span", { class: "tx" }, el("div", { class: "hd", text: "사용" }), el("div", { class: "sup", text: MD.enabled ? "켜져 있어요" : "꺼져 있어요" })),
    el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(MD.enabled), "aria-label": "사용", "data-ms-enabled": "1", onclick: () => { MD.enabled = !MD.enabled; msRenderDetail(); } })));
  const nodes = [el("div", { class: "sec", text: "연결" }), el("div", { class: "list" }, ...rows,
    ...(s.fields.length ? [el("div", { class: "li dcs-form" }, ...s.fields.map(msFieldInput))] : []),
    ...(s.link ? [el("button", { type: "button", class: "li tap", "data-ms-link": s.link.view, onclick: () => { MD.dlg.close(); go(s.link.view); } }, el("span", { class: "tx" }, el("div", { class: "hd", text: s.link.label })), icon("chev", "lead"))] : []))];
  if (s.allow) nodes.push(el("div", { class: "sec", text: s.allow.label }), el("div", { class: "list" }, ...MD.allow.map((a, i) => el("div", { class: "li", "data-allow": a }, el("span", { class: "tx" }, el("div", { class: "hd", text: a })), el("button", { type: "button", class: "ib", "aria-label": `${a} 빼기`, onclick: () => { MD.allow.splice(i, 1); msRenderDetail(); } }, icon("close")))),
    el("div", { class: "li ms-addrow" }, el("span", { class: "tx" }, MD.add), el("button", { type: "button", class: "btn tonal", "data-ms-allow-add": "1", onclick: () => { const v = MD.add.value.trim(); if (v && !MD.allow.includes(v)) { MD.allow.push(v); MD.add.value = ""; msRenderDetail(); } }, text: "추가" }))));
  if (s.rooms) nodes.push(el("div", { class: "sec", text: s.rooms.label }), el("div", { class: "list" },
    ...s.rooms.items.map(r => el("div", { class: "li", "data-room": r.id },
      el("span", { class: "tx" }, el("div", { class: "hd", text: r.name }), el("div", { class: "sup", text: [`→ ${msKind(r.kind)}${r.project ? ` · ${r.project.name}` : ""}`, r.last_in ? `받음 ${msAgo(r.last_in)}` : "", r.last_out ? `보냄 ${msAgo(r.last_out)}` : ""].filter(Boolean).join(" · ") }),
        r.last_error ? el("div", { class: "dcs-err", text: r.last_error }) : null))),
    ...(s.rooms.hint ? [el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", "data-ms-hint": "1", text: s.rooms.hint })))] : [])));
  if (s.notify) nodes.push(el("div", { class: "sec", text: "알림" }), el("div", { class: "list" }, ...notifyRows(k => MD.s.notify[k] !== false, msNotifySet),
    el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: "끄면 그 알림은 여기로 보내지 않고 앱에만 와요." })))));
  if (s.help.length) nodes.push(el("div", { class: "sec", text: "연결하는 방법" }), el("div", { class: "list" }, el("div", { class: "li" }, el("ol", { class: "steps" }, ...s.help.map(h => el("li", { text: h }))))));
  if (!ro && s.rooms) nodes.push(el("div", { class: "list" }, el("div", { class: "li dcs-form" },
    el("div", { class: "dcs-acts" }, el("button", { type: "button", class: "btn tonal", "data-ms-test": "1", onclick: ev => msTest(ev.currentTarget), text: "연결 확인" })),
    MD.test ? el("div", { class: "dcs-res" }, ...(MD.test.length ? MD.test.map(t => el("div", { class: t.ok ? "dcs-ok" : "dcs-err", text: t.ok ? `${t.name}: 보냈어요` : `${t.name}: ${t.error || "보내지 못했어요"}` })) : [el("div", { class: "sup", text: "방이 없어요" })])) : null)));
  clear(MD.body).append(...nodes);
  MD.dlg.setActions([{ label: "닫기", onclick: c => c() }, ...(ro ? [] : [{ label: "저장", kind: "pri", disabled: !dirty.any, onclick: (c, b) => msSave(b) }])]);
  const save = MD.dlg.node.querySelector(".dact .btn.pri, .fs-ft .btn.pri");
  if (save) save.setAttribute("data-ms-save", "1");
}
