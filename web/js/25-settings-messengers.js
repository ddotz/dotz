// 설정의 메신저 화면: Discord · JANDI · Slack · Telegram each has its own view. Every view reads the shared index
// (GET /api/messengers), one settings view (GET/PUT /api/messengers/<id>, POST .../test, hub/messengers-api.ts), and the
// onboarding panel. Manual IDs/tokens live only in the closed "직접 입력" disclosure.
const MS_IDS = ["discord", "jandi", "slack", "telegram"];
const MS_LABELS = { discord: "Discord", jandi: "JANDI", slack: "Slack", telegram: "Telegram" };
const MS_KINDS = [["main", TX("common.main_chat")], ["project", TX("common.project")], ["alert", TX("common.alerts")], ["worklog", TX("common.worklog")]];
const MS_AS_USER = TX("connect.ms.as_user");
const MSS = { items: null, fail: "", asked: false, loading: false, page: null };
const msItem = id => (MSS.items || []).find(x => x.id === id) || null;
const msTag = m => !m ? ["", ""] : !m.configured ? [TX("connect.state.unset"), "warn"] : m.state === "error" ? [TX("settings.prov.not_connected"), "err"] : [TX("connect.state.on"), "ok"];
const msConnectLabel = m => (!m || !m.configured || m.error ? TX("connect.connect") : !m.enabled ? TX("connect.turn_on") : TX("mail.reconnect"));
const msKind = k => (MS_KINDS.find(x => x[0] === k) || [k, k])[1];
const msAgo = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? TX("home.ago.now") : s < 3600 ? TX("home.ago.m", { n: Math.floor(s / 60) }) : s < 86400 ? TX("home.ago.h", { n: Math.floor(s / 3600) }) : TX("project.ago.d", { n: Math.floor(s / 86400) }); };
const msPage = id => {
  if (!MSS.page || MSS.page.id !== id) MSS.page = { id, s: null, fail: "", enabled: false, vals: {}, allow: null, add: "", test: null, advOpen: false };
  return MSS.page;
};
// 설정 목록의 한 줄 "메신저": its right side says which messengers are connected; the four messengers sit on their own screen.
function msSummary() {
  if (!MSS.asked) loadMessengerIndex();
  if (!MSS.items) return "";
  const on = MS_IDS.map(msItem).filter(m => m && msTag(m)[1] === "ok").map(m => m.label || MS_LABELS[m.id]);
  return on.length ? (on.length > 1 ? TX("connect.ms.sum_more", { name: on[0], n: on.length - 1 }) : TX("connect.ms.sum_one", { name: on[0] })) : TX("connect.state.unset");
}
function msHubRow() {
  const r = el("button", { class: "li tap", type: "button", onclick: () => go("messengers") }, el("span", { class: "lead" }, icon("chat")),
    el("span", { class: "tx" }, el("div", { class: "hd", text: TX("connect.ms.title") }), el("div", { class: "sup", text: msSummary() })), el("span", { class: "li-end" }, icon("chev", "chev")));
  r.dataset.msHub = "";
  return r;
}
// The messenger screen: Discord · JANDI · Slack · Telegram, each a row with its status tag that opens that messenger's own screen.
function renderMessengers() {
  if (!MSS.asked) loadMessengerIndex();
  clear($("#messengers")).append(el("div", { class: "list" }, ...MS_IDS.map(id => {
    const m = msItem(id), [tag, tone] = m ? msTag(m) : ["", ""];
    const r = el("button", { class: "li tap", type: "button", onclick: () => go(id) }, el("span", { class: "lead" }, icon(id === "discord" ? "discord" : "chat")),
      el("span", { class: "tx" }, el("div", { class: "hd", text: (m && m.label) || MS_LABELS[id] }), m && m.error ? el("div", { class: "sup", text: m.error }) : null),
      el("span", { class: "li-end" }, tag ? el("span", { class: `tag ${tone}`, text: tag }) : null, icon("chev", "chev")));
    r.dataset.msRow = id;
    return r;
  })));
}
function msPaint() {
  if (inSettings()) renderSettings();
  else if (current === "messengers") renderMessengers();
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
// After a run the owner started ends, the row says when it did (the 자동 연결 panel is gone by then).
const msConnectedNote = id => (OB[id] && OB[id].doneAt ? TX("connect.ms.connected_ago", { ago: msAgo(OB[id].doneAt) }) : "");
function msLine(id, m, s) {
  if (m && m.error) return m.error;
  if (!m) return "";
  const run = OB[id] && OB[id].state;
  if (OB_WAIT.has(id) || run === "running" || run === "waiting" || run === "failed") return "";   // the 자동 연결 row under the card says where it is
  if (!m.configured) return TX("connect.ms.tap_connect");
  if (!m.enabled) return TX("connect.ms.tap_on");
  return [id === "jandi" && s && s.rooms ? TX("connect.ms.rooms_n", { n: s.rooms.items.length }) : "", msConnectedNote(id)].filter(Boolean).join(" · ");   // the tag beside it already says 연결됨
}
// JANDI's 나와의 대화 login: one row, every word from settings(); 다시 연결 (lost) is the lead, the other states offer a small button.
function msSelfChatRow(id, s) {
  const c = s.self_chat;
  if (!c) return null;
  const lost = c.state === "lost";
  return el("div", { class: "li", "data-ms-selfchat": c.state }, el("span", { class: "lead" }, icon("chat")),
    el("span", { class: "tx" }, el("div", { class: "hd", text: c.label }), el("div", { class: lost ? "dcs-err" : "sup", text: c.hint })),
    liEnd(el("button", { type: "button", class: lost ? "btn inrow" : "btn tonal inrow", "data-ms-selfchat-connect": id, disabled: OB_WAIT.has(id), onclick: () => obStart(id), text: OB_WAIT.has(id) ? TX("connect.connecting") : c.connect })));
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
  return obStart(id);
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
  let saved = false;
  await busy(btn, async () => {
    p.s = await api(`/api/messengers/${enc(p.id)}`, "PUT", put);
    p.enabled = !!p.s.enabled; p.vals = {}; p.add = "";
    p.allow = p.s.allow ? p.s.allow.items.slice() : null;
    saved = true;
    await loadMessengerIndex();
  });
  if (current === p.id) renderMessenger(p.id);
  if (saved) stFlash(`#${p.id} [data-ms-save]`);
}
// The check leaves its result in its own row: "확인하는 중…" while it runs, then when it ran and how it went; a failure says what to do.
async function msTest() {
  const p = MSS.page;
  if (!p || !p.s || p.testing) return;
  p.testing = true; p.testFail = "";
  renderMessenger(p.id);
  try { p.test = (await api(`/api/messengers/${enc(p.id)}/test`, "POST", {})).results; p.testAt = Date.now(); }
  catch (e) { p.test = null; p.testFail = TX("connect.ms.test_failed", { error: e.message }); }
  p.testing = false;
  if (current === p.id) renderMessenger(p.id);
}
function msTestResult(p) {
  if (p.testing) return el("div", { class: "sup", text: TX("settings.upd.checking") });
  if (p.testFail) return el("div", { class: "dcs-err", role: "alert", text: p.testFail });
  if (!p.test) return null;
  const bad = p.test.some(t => !t.ok);
  return el("div", { class: "dcs-res" }, el("div", { class: "sup", "data-ms-test-sum": "1", text: [TX("connect.ms.checked_ago", { ago: msAgo(p.testAt) }), !p.test.length ? TX("connect.ms.no_rooms") : bad ? TX("connect.ms.some_failed") : TX("connect.ms.all_ok")].join(" · ") }),
    ...p.test.map(t => el("div", { class: t.ok ? "dcs-ok" : "dcs-err", text: t.ok ? TX("connect.ms.sent_to", { name: t.name }) : `${t.name}: ${t.error || TX("connect.ms.send_failed")}` })));
}
function msFieldInput(f) {
  const p = MSS.page;
  if (f.type === "readonly") return el("div", { class: "tf" }, el("span", { class: "lb", text: f.label }), el("div", { class: "sup", text: String(f.value ?? "") }));
  if (f.type === "secret") {
    const i = input({ type: "password", autocomplete: "new-password", name: `ms-${f.key}`, placeholder: f.set ? TX("connect.paste_new") : f.label, oninput: ev => { const v = ev.target.value.trim(); if (v) p.vals[f.key] = v; else delete p.vals[f.key]; msSync(); } });
    return el("div", {}, textField(f.label, i), f.set ? el("div", { class: "tag ok dcs-saved", "data-set": f.key, text: TX("connect.saved_tag") }) : null,
      f.as_user ? el("div", { class: "tag warn", "data-as-user": f.key, text: MS_AS_USER }) : null, f.hint ? el("div", { class: "sup", text: f.hint }) : null);
  }
  const cur = p.vals[f.key] !== undefined ? p.vals[f.key] : f.value;
  const i = input({ value: cur == null ? "" : String(cur), ...(f.type === "number" ? { type: "number", inputmode: "numeric", min: "0" } : {}), name: `ms-${f.key}`, oninput: ev => { p.vals[f.key] = f.type === "number" ? Number(ev.target.value) : ev.target.value; msSync(); } });
  return el("div", {}, textField(f.label, i), f.hint ? el("div", { class: "sup", text: f.hint }) : null);
}
function msAllowEditor(p, s) {
  const rows = p.allow.map((a, i) => el("div", { class: "li", "data-allow": a }, el("span", { class: "tx" }, el("div", { class: "hd", text: a })),
    el("button", { type: "button", class: "ib", "aria-label": TX("decision.remove_named", { name: a }), onclick: () => { p.allow.splice(i, 1); renderMessenger(p.id); } }, icon("close"))));
  rows.push(el("div", { class: "li ms-addrow" },
    el("span", { class: "tx" }, input({ value: p.add, placeholder: s.allow.hint || "", name: "ms-allow", oninput: ev => { p.add = ev.target.value; } })),
    liEnd(el("button", { type: "button", class: "btn tonal inrow", "data-ms-allow-add": "1", onclick: () => { const v = p.add.trim(); if (v && !p.allow.includes(v)) { p.allow.push(v); p.add = ""; renderMessenger(p.id); } }, text: TX("decision.add") }))));
  return rows;
}
function msAdvancedBody(p, s) {
  const head = el("div", { class: "list" });
  if (s.fields.length) head.append(el("div", { class: "li dcs-form" }, ...s.fields.map(msFieldInput)));
  head.append(el("div", { class: "li" }, el("span", { class: "lead" }, icon("bell")), el("span", { class: "tx" },
    el("div", { class: "hd", text: TX("settings.fb.enabled") }), el("div", { class: "sup", text: p.enabled ? TX("connect.ms.on") : TX("connect.ms.off") })),
  liEnd(el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(p.enabled), "aria-label": TX("settings.fb.enabled"), "data-ms-enabled": "1",
    onclick: ev => { p.enabled = !p.enabled; ev.currentTarget.setAttribute("aria-checked", String(p.enabled)); msSync(); } }))));
  head.append(el("div", { class: "li dcs-form" }, el("div", { class: "dcs-acts" },
    el("button", { type: "button", class: "btn", "data-ms-save": "1", disabled: !msDirty(p).any, onclick: ev => msSave(ev.currentTarget), text: TX("common.save") }))));
  const out = el("div", {}, head);
  if (s.allow) out.append(el("div", { class: "sec", text: s.allow.label }), el("div", { class: "list" }, ...msAllowEditor(p, s)));
  return out;
}
function renderMessenger(id) {
  const box = $(`#${id}`);
  if (!box) return;
  const p = msPage(id), m = msItem(id);
  if (!p.s) {
    clear(box).append(emptyNode(p.fail ? TX("connect.ms.load_failed") : TX("connect.loading")));
    if (!p.fail && !p.loading) loadMessengerSettings(id);
    return;
  }
  const s = p.s, [tag, tone] = m ? msTag(m) : ["", ""], c = s.self_chat;
  // With the login row on screen the status row stays only for what the login row does not say, and 연결 would start the same flow a second time.
  const loginOnly = c && (!m || !m.configured || c.state === "lost"), turnOn = m && m.configured && !m.enabled && !m.error;
  // Before it is connected the screen holds the connect card alone: switches, rooms, people and the check have nothing to show yet.
  const fresh = Boolean(m && !m.configured), line = msLine(id, m, s);
  const nodes = [el("div", { class: "sec", text: TX("connect.sec") }),
    el("div", { class: "list" },
      loginOnly ? null : el("div", { class: "li", "data-ms-status": id }, el("span", { class: "lead" }, icon("chat")),
        el("span", { class: "tx" }, el("div", { class: "hd", text: (m && m.label) || MS_LABELS[id] }), line ? el("div", { class: "sup", text: line }) : null),
        liEnd(tag ? el("span", { class: `tag ${tone}`, text: tag, title: (m && m.error) || "" }) : null, c && !turnOn ? null : el("button", { type: "button", class: "btn tonal inrow", "data-ms-connect": id, disabled: OB_WAIT.has(id), onclick: ev => msConnect(id, ev.currentTarget) }, OB_WAIT.has(id) ? TX("connect.connecting") : msConnectLabel(m)))),
      msSelfChatRow(id, s)),
    ...obSection(id, !!m && m.state === "ok")];
  if (s.notify && !fresh) nodes.push(el("div", { class: "sec", text: TX("common.alerts") }), el("div", { class: "list" },
    ...notifyRows(k => s.notify[k] !== false, (k, on) => msNotifySet(id, k, on))));
  if (s.rooms && !fresh) nodes.push(el("div", { class: "sec", text: s.rooms.label }), el("div", { class: "list" },
    ...s.rooms.items.map(r => el("div", { class: "li", "data-room": r.id },
      el("span", { class: "lead" }, el("span", { class: `dot ${r.last_error ? "err" : r.last_in || r.last_out ? "ok" : ""}`, "aria-hidden": "true" })),
      el("span", { class: "tx" }, el("div", { class: "hd", text: r.name }), el("div", { class: "sup", text: [`→ ${msKind(r.kind)}${r.project ? ` · ${r.project.name}` : ""}`, r.last_in ? TX("connect.ms.received", { ago: msAgo(r.last_in) }) : "", r.last_out ? TX("connect.ms.sent", { ago: msAgo(r.last_out) }) : ""].filter(Boolean).join(" · ") }),
        r.last_error ? el("div", { class: "dcs-err", text: r.last_error }) : null))),
    ...(s.rooms.hint ? [el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", "data-ms-hint": "1", text: s.rooms.hint })))] : [])));
  if (!fresh) nodes.push(...msRelaySection(p, s));
  // A person who is also one of the rooms shows by name with the id under it (Telegram's private chats); a bare number says whose id it is.
  const who = a => (s.rooms ? s.rooms.items.find(r => String(r.id) === String(a) && r.name && r.name !== String(a)) : null);
  const idOf = a => (/^-?\d+$/.test(String(a)) ? `${MS_LABELS[id]} ID ${a}` : String(a));
  if (s.allow && !fresh) nodes.push(el("div", { class: "sec", text: s.allow.label }), el("div", { class: "list" },
    ...p.allow.map(a => { const r = who(a); return el("div", { class: "li", "data-allow": a }, el("span", { class: "tx" }, el("div", { class: "hd", text: r ? r.name : idOf(a) }), r ? el("div", { class: "sup", text: idOf(a) }) : null)); })));
  // 연결 확인 is one row: the result shows in this row (under the title), the action sits in .li-end.
  if (!fresh) nodes.push(el("div", { class: "list" }, el("div", { class: "li", "data-ms-test-row": "1" }, el("span", { class: "tx" }, el("div", { class: "hd", text: TX("connect.check_conn") }),
    msTestResult(p)),
  liEnd(el("button", { type: "button", class: "btn tonal inrow", "data-ms-test": "1", disabled: !!p.testing, onclick: () => msTest(), text: TX("connect.check") })))));
  // The toggle event arrives after a redraw can already have replaced the element, so read the live state.
  const prev = box.querySelector("details[data-ms-advanced]");
  if (prev) p.advOpen = prev.open;
  nodes.push(msAdvanced("data-ms-advanced", p.advOpen, () => msAdvancedBody(p, s)));
  const det = nodes[nodes.length - 1];
  det.addEventListener("toggle", () => { p.advOpen = det.open; });
  clear(box).append(...nodes);
}
