// 설정의 메신저 화면: Discord · JANDI · Slack · Telegram each has its own view. Every view reads the shared index
// (GET /api/messengers), one settings view (GET/PUT /api/messengers/<id>, POST .../test, hub/messengers-api.ts), and the
// onboarding panel. Manual IDs/tokens live only in the closed "직접 입력" disclosure.
const MS_IDS = ["discord", "jandi", "slack", "telegram"];
const MS_LABELS = { discord: "Discord", jandi: "JANDI", slack: "Slack", telegram: "Telegram" };
const MS_KINDS = [["main", "메인 대화"], ["project", "프로젝트"], ["alert", "알림"], ["worklog", "작업내역"]];
const MS_AS_USER = "내 계정으로 보냅니다";
const MSS = { items: null, fail: "", asked: false, loading: false, page: null };
const msItem = id => (MSS.items || []).find(x => x.id === id) || null;
const msTag = m => !m ? ["", ""] : !m.configured ? ["설정 안 됨", "warn"] : m.state === "error" ? ["연결 안 됨", "err"] : ["연결됨", "ok"];
const msConnectLabel = m => (!m || !m.configured || m.error ? "연결" : !m.enabled ? "켜기" : "연결");
const msKind = k => (MS_KINDS.find(x => x[0] === k) || [k, k])[1];
const msAgo = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? "방금" : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`; };
const msPage = id => {
  if (!MSS.page || MSS.page.id !== id) MSS.page = { id, s: null, fail: "", enabled: false, vals: {}, allow: null, add: "", test: null, advOpen: false };
  return MSS.page;
};
// 설정 목록의 네 줄: the index supplies label and status; before it arrives the rows stay with no tag.
function msSettingsRows(row) {
  if (!MSS.asked) loadMessengerIndex();
  return MS_IDS.map(id => {
    const m = msItem(id), [tag, tone] = m ? msTag(m) : ["", ""];
    const r = row(id === "discord" ? "discord" : "chat", (m && m.label) || MS_LABELS[id], "", () => go(id),
      el("span", { class: "dcs-trail" }, ...(tag ? [el("span", { class: `tag ${tone}`, text: tag, title: (m && m.error) || "" })] : []), icon("chev", "lead")));
    r.dataset.msRow = id;
    return r;
  });
}
function msPaint() {
  if (current === "settings") renderSettings();
  else if (current === "discord") renderDiscord();
  else if (MS_IDS.includes(current)) renderMessenger(current);
}
// The index is fetched when a screen opens, never on every render; the rows stay while it is in flight.
async function loadMessengerIndex() {
  MSS.asked = true;
  if (MSS.loading) return;
  MSS.loading = true;
  try { const j = await api("/api/messengers"); MSS.items = Array.isArray(j.items) ? j.items : []; MSS.fail = ""; }
  catch (e) { MSS.fail = e.message; }
  finally { MSS.loading = false; }
  msPaint();
}
async function loadMessengerSettings(id) {
  const p = msPage(id);
  p.loading = true;
  try {
    const s = await api(`/api/messengers/${enc(id)}`);
    p.s = s; p.fail = ""; p.enabled = !!s.enabled; p.vals = {}; p.add = ""; p.test = null;
    p.allow = s.allow ? s.allow.items.slice() : null;
  } catch (e) { p.s = null; p.fail = e.message; }
  p.loading = false;
  if (current === id) renderMessenger(id);
}
function msLine(id, m, s) {
  if (m && m.error) return m.error;
  if (!m) return "";
  if (!m.configured) return "아직 연결되지 않았어요. 연결을 누르면 자동으로 설정해요.";
  if (!m.enabled) return "설정은 돼 있어요. 켜기를 누르면 알림을 보내요.";
  if (id === "jandi" && s && s.rooms) return `연결돼 있어요 · 방 ${s.rooms.items.length}개`;
  return "연결돼 있어요.";
}
function msConnect(id, btn) {
  const m = msItem(id);
  if (m && m.configured && !m.enabled && !m.error) {
    return busy(btn, async () => {
      const p = msPage(id);
      p.s = await api(`/api/messengers/${enc(id)}`, "PUT", { enabled: true });
      p.enabled = !!p.s.enabled;
      await loadMessengerIndex();
      if (current === id) renderMessenger(id);
    });
  }
  return obStart(id, btn);
}
// 알림 switches save at once (PUT { notify }): they need no restart and no other field.
async function msNotifySet(id, k, on) {
  const p = msPage(id);
  if (p.s && p.s.notify) p.s = { ...p.s, notify: { ...p.s.notify, [k]: on } };
  if (current === id) renderMessenger(id);
  try {
    const s = await api(`/api/messengers/${enc(id)}`, "PUT", { notify: { [k]: on } });
    if (p.s && s.notify) p.s = { ...p.s, notify: s.notify };
  } catch (e) {
    if (p.s && p.s.notify) p.s = { ...p.s, notify: { ...p.s.notify, [k]: !on } };
    toast(e.message, true);
  }
  if (current === id) renderMessenger(id);
}
function msDirty(p) {
  const s = p.s;
  if (!s) return { vals: [], allow: false, any: false };
  const vals = Object.keys(p.vals).filter(k => String(p.vals[k]) !== String((s.fields.find(f => f.key === k) || {}).value));
  const allow = !!p.allow && JSON.stringify(p.allow) !== JSON.stringify(s.allow ? s.allow.items : []);
  return { vals, allow, any: p.enabled !== s.enabled || vals.length > 0 || allow };
}
function msSync() {
  const b = document.querySelector(`${MSS.page ? `#${MSS.page.id}` : ""} [data-ms-save]`);
  if (b && MSS.page) b.disabled = !msDirty(MSS.page).any;
}
async function msSave(btn) {
  const p = MSS.page;
  if (!p || !p.s) return;
  const dirty = msDirty(p), put = {};
  if (p.enabled !== p.s.enabled) put.enabled = p.enabled;
  if (dirty.vals.length) put.values = Object.fromEntries(dirty.vals.map(k => [k, p.vals[k]]));
  if (dirty.allow) put.allow = p.allow;
  if (!Object.keys(put).length) return;
  await busy(btn, async () => {
    p.s = await api(`/api/messengers/${enc(p.id)}`, "PUT", put);
    p.enabled = !!p.s.enabled; p.vals = {}; p.add = "";
    p.allow = p.s.allow ? p.s.allow.items.slice() : null;
    toast("저장했어요");
    await loadMessengerIndex();
  });
  if (current === p.id) renderMessenger(p.id);
}
async function msTest(btn) {
  const p = MSS.page;
  if (!p || !p.s) return;
  await busy(btn, async () => { p.test = (await api(`/api/messengers/${enc(p.id)}/test`, "POST", {})).results; });
  if (current === p.id) renderMessenger(p.id);
}
function msFieldInput(f) {
  const p = MSS.page;
  if (f.type === "readonly") return el("div", { class: "tf" }, el("span", { class: "lb", text: f.label }), el("div", { class: "sup", text: String(f.value ?? "") }));
  if (f.type === "secret") {
    const i = input({ type: "password", autocomplete: "new-password", name: `ms-${f.key}`, placeholder: f.set ? "바꾸려면 새로 붙여 넣기" : f.label, oninput: ev => { const v = ev.target.value.trim(); if (v) p.vals[f.key] = v; else delete p.vals[f.key]; msSync(); } });
    return el("div", {}, textField(f.label, i), f.set ? el("div", { class: "tag ok dcs-saved", "data-set": f.key, text: "저장됨" }) : null,
      f.as_user ? el("div", { class: "tag warn", "data-as-user": f.key, text: MS_AS_USER }) : null, f.hint ? el("div", { class: "sup", text: f.hint }) : null);
  }
  const cur = p.vals[f.key] !== undefined ? p.vals[f.key] : f.value;
  const i = input({ value: cur == null ? "" : String(cur), ...(f.type === "number" ? { type: "number", inputmode: "numeric", min: "0" } : {}), name: `ms-${f.key}`, oninput: ev => { p.vals[f.key] = f.type === "number" ? Number(ev.target.value) : ev.target.value; msSync(); } });
  return el("div", {}, textField(f.label, i), f.hint ? el("div", { class: "sup", text: f.hint }) : null);
}
function msAllowEditor(p, s) {
  const rows = p.allow.map((a, i) => el("div", { class: "li", "data-allow": a }, el("span", { class: "tx" }, el("div", { class: "hd", text: a })),
    el("button", { type: "button", class: "ib", "aria-label": `${a} 빼기`, onclick: () => { p.allow.splice(i, 1); renderMessenger(p.id); } }, icon("close"))));
  rows.push(el("div", { class: "li ms-addrow" },
    el("span", { class: "tx" }, input({ value: p.add, placeholder: s.allow.hint || "", name: "ms-allow", oninput: ev => { p.add = ev.target.value; } })),
    el("button", { type: "button", class: "btn tonal", "data-ms-allow-add": "1", onclick: () => { const v = p.add.trim(); if (v && !p.allow.includes(v)) { p.allow.push(v); p.add = ""; renderMessenger(p.id); } }, text: "추가" })));
  return rows;
}
function msAdvancedBody(p, s) {
  const head = el("div", { class: "list" });
  if (s.fields.length) head.append(el("div", { class: "li dcs-form" }, ...s.fields.map(msFieldInput)));
  head.append(el("div", { class: "li" }, el("span", { class: "lead" }, icon("bell")), el("span", { class: "tx" },
    el("div", { class: "hd", text: "사용" }), el("div", { class: "sup", text: p.enabled ? "켜져 있어요" : "꺼져 있어요" })),
  el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(p.enabled), "aria-label": "사용", "data-ms-enabled": "1",
    onclick: ev => { p.enabled = !p.enabled; ev.currentTarget.setAttribute("aria-checked", String(p.enabled)); msSync(); } })));
  head.append(el("div", { class: "li dcs-form" }, el("div", { class: "dcs-acts" },
    el("button", { type: "button", class: "btn", "data-ms-save": "1", disabled: !msDirty(p).any, onclick: ev => msSave(ev.currentTarget), text: "저장" }))));
  const out = el("div", {}, head);
  if (s.allow) out.append(el("div", { class: "sec", text: s.allow.label }), el("div", { class: "list" }, ...msAllowEditor(p, s)));
  return out;
}
function renderMessenger(id) {
  const box = $(`#${id}`);
  if (!box) return;
  const p = msPage(id), m = msItem(id);
  if (!p.s) {
    clear(box).append(emptyNode(p.fail ? "메신저 설정을 불러오지 못했어요" : "불러오는 중"));
    if (!p.fail && !p.loading) loadMessengerSettings(id);
    return;
  }
  const s = p.s, [tag, tone] = m ? msTag(m) : ["", ""];
  const nodes = [el("div", { class: "sec", text: "연결" }),
    el("div", { class: "list" },
      el("div", { class: "li", "data-ms-status": id }, el("span", { class: "lead" }, icon("chat")),
        el("span", { class: "tx" }, el("div", { class: "hd", text: (m && m.label) || MS_LABELS[id] }), el("div", { class: "sup", text: msLine(id, m, s) })),
        tag ? el("span", { class: `tag ${tone}`, text: tag, title: (m && m.error) || "" }) : null),
      el("div", { class: "li ms-act" }, el("button", { type: "button", class: "btn", "data-ms-connect": id, onclick: ev => msConnect(id, ev.currentTarget) }, msConnectLabel(m)))),
    el("div", { class: "sec", text: "자동 연결" }), onboardingPanel(id)];
  if (s.notify) nodes.push(el("div", { class: "sec", text: "알림" }), el("div", { class: "list" },
    ...notifyRows(k => s.notify[k] !== false, (k, on) => msNotifySet(id, k, on)),
    el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: "끄면 그 알림은 여기로 보내지 않고 앱에만 와요." })))));
  if (s.rooms) nodes.push(el("div", { class: "sec", text: s.rooms.label }), el("div", { class: "list" },
    ...s.rooms.items.map(r => el("div", { class: "li", "data-room": r.id },
      el("span", { class: "tx" }, el("div", { class: "hd", text: r.name }), el("div", { class: "sup", text: [`→ ${msKind(r.kind)}${r.project ? ` · ${r.project.name}` : ""}`, r.last_in ? `받음 ${msAgo(r.last_in)}` : "", r.last_out ? `보냄 ${msAgo(r.last_out)}` : ""].filter(Boolean).join(" · ") }),
        r.last_error ? el("div", { class: "dcs-err", text: r.last_error }) : null))),
    ...(s.rooms.hint ? [el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", "data-ms-hint": "1", text: s.rooms.hint })))] : [])));
  if (s.allow) nodes.push(el("div", { class: "sec", text: s.allow.label }), el("div", { class: "list" },
    ...p.allow.map(a => el("div", { class: "li", "data-allow": a }, el("span", { class: "tx" }, el("div", { class: "hd", text: a }))))));
  nodes.push(el("div", { class: "list" }, el("div", { class: "li dcs-form" }, el("div", { class: "dcs-acts" },
    el("button", { type: "button", class: "btn tonal", "data-ms-test": "1", onclick: ev => msTest(ev.currentTarget), text: "연결 확인" })),
  p.test ? el("div", { class: "dcs-res" }, ...(p.test.length ? p.test.map(t => el("div", { class: t.ok ? "dcs-ok" : "dcs-err", text: t.ok ? `${t.name}: 보냈어요` : `${t.name}: ${t.error || "보내지 못했어요"}` })) : [el("div", { class: "sup", text: "방이 없어요" })])) : null)));
  nodes.push(msAdvanced("data-ms-advanced", p.advOpen, () => msAdvancedBody(p, s)));
  const det = nodes[nodes.length - 1];
  det.addEventListener("toggle", () => { p.advOpen = det.open; });
  clear(box).append(...nodes);
}
