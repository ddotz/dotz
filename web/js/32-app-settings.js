/* ---------- 모니터링 > 앱 > 설정 대화 ---------- */
// Every app with a settings schema (hub/app-settings.ts) has one pinned "설정" row and one conversation, target settings:<app>. Above the
// conversation the common settings are switches that PATCH /api/integrations/<app>/settings straight away (no model call). The owner's words
// go to the orchestrator, which answers with a ```dotz-settings block; it is drawn as a change card (before -> after) and only 적용 sends the same PATCH.
const AS_KEY = "dotz.settings.cards";
const AS = { by: {}, none: {}, load: {}, busy: {}, rm: {}, feat: {}, done: lsJson(AS_KEY, null) || {},
  lines: lsJson(`${AS_KEY}.lines`, null) || {} };   // lines[card id][key] = {label, text, old}: an applied card keeps the words it showed and the values to put back
const asSave = () => { try { localStorage.setItem(AS_KEY, JSON.stringify(AS.done)); localStorage.setItem(`${AS_KEY}.lines`, JSON.stringify(AS.lines)); } catch { /* storage full or blocked: the card state lasts until reload */ } };

// An app is "mail", "kakao"...; a monitor is "w:<watch name>" (hub/watch-settings.ts), a schedule "s:<id>" (hub/schedule-settings.ts): same schema,
// same screen, a different URL. asOwn: the settings of one monitor or schedule (its own status row and 삭제, no app features).
const asOwn = app => /^[ws]:/.test(app);
const asUrl = app => app.startsWith("w:") ? `/api/watches/${enc(app.slice(2))}/settings` : app.startsWith("s:") ? `/api/schedules/${enc(app.slice(2))}/settings` : `/api/integrations/${enc(app)}/settings`;

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
  try { asFeatSave(app, await api(asFeatUrl(app, "features"), "PATCH", { id, on })); asLoad(app, true); } catch (e) { toast(e.message || TX("appset.feat.fail"), true); }
  AS.busy[app] = false; asPaint();
}
// A row that is logged out (i.down) asks to reconnect: the hub approves a gated login, which may send a push to the owner's phone.
async function asRetry(app, watch, down) {
  if (AS.busy[app]) return;
  AS.busy[app] = true;
  try { asFeatSave(app, await api(asFeatUrl(app, "retry"), "POST", { watch })); toast(down ? MON_RECONNECT : TX("appset.retry.done")); } catch (e) { toast(e.message || TX("appset.retry.fail"), true); }
  AS.busy[app] = false; MON.sig = ""; monSchedule(); asPaint();
}
// 승인 대기 is one row: the count and a chevron that opens 답장 대기 (30-replies.js rqOpen) on this app's own drafts. The answers live there, not in a settings screen.
function asWaitRow(app, n) {
  const pe = PQ.of.get(`settings:${app}`);
  return el("button", { class: "li tap as-row", type: "button", "data-k": "approvals", onclick: () => { if (ASC.h) ASC.h.close(false); rqOpen(app.split("~")[0], pe ? pe.pc : null); } },
    el("span", { class: "tx" }, el("div", { class: "hd", text: TX("appset.pending.title") })), el("span", { class: "li-end" }, el("span", { class: "as-v", text: TX("appset.pending.n", { n }) }), icon("chev", "chev")));
}
// One watch the app owns (로그인 유지 / 동기화 / 파일 점검): its status, when it last ran, and its period. The period is editable when the watch lives on this
// computer; a peer's period is read only (its settings are written through that computer's own act routes). 다시 시도 only on a row that is not ok.
async function asEvery(app, i, v) {
  const n = Math.round(Number(v));
  if (!(n >= 1 && n <= 10080)) { toast(TX("appset.every.range"), true); asPaint(); return; }
  if (AS.busy[app]) return;
  AS.busy[app] = true;
  try { await api(`/api/watches/${enc(i.id)}/settings`, "PATCH", { values: { every_minutes: n } }); await asFeatLoad(app); toast(TX("appset.every.done")); }
  catch (e) { toast(e.message || TX("appset.every.fail"), true); }
  AS.busy[app] = false; asPaint();
}
// A watch's last output in the facts of its status: a raw command never shows, in the detail row or a settings panel alike.
const monLastOut = m => m.last_output && !MON_CMD.test(m.last_output) ? TX("appset.last.out", { text: m.last_output }) : "";
// One row for a watch: the monitor's own facts (the status card its detail shows) and, for a watch an app owns, the app's kind, reason, period and
// 다시 시도. The machine hooks other panels read stay stable: .as-stat, data-watch, data-internal.
function asStatRow(app, m, i) {
  const st = m ? monStatus(m) : null;   // the monitor's one status (30-monitoring.js)
  const dot = i ? i.dot : st ? (st.tone === "err" ? "fail" : st.key === "off" || st.key === "need" ? "idle" : "ok") : "idle";
  const name = m ? monTitle(m) : i ? i.name : "";
  const line = i
    ? [i.status, i.last_run ? TX("appset.last.check", { at: monTime(i.last_run) }) : "", m ? ntMonNext(m) : ""].filter(Boolean).join(" · ")
    : [st && st.text, m ? ntMonRun(m) : "", m ? ntMonNext(m) : ""].filter(Boolean).join(" · ");
  const facts = [m && m.fails ? TX("appset.fails", { n: m.fails }) : "", m ? monLastOk(m) : "", m ? monLastOut(m) : "",
    m && m.kind === "schedule" && m.every ? TX("appset.repeat", { every: m.every }) : "", m && m.kind === "schedule" && m.channel ? TX("appset.send_to", { name: targetName(m.channel) }) : ""].filter(Boolean);
  return el("div", { class: `as-row as-stat${i ? " as-int" : " as-conn"}`, "data-watch": m ? m.watch || m.name : i.id, ...(i ? { "data-internal": i.id, "data-kind": i.kind } : { "data-conn": dot === "fail" ? "disconnected" : dot === "ok" ? "connected" : "unknown" }) },
    el("span", { class: `as-dot ${dot}`, "aria-hidden": "true" }),
    el("span", { class: "as-b" }, el("span", { class: "as-n", text: name }),
      i && i.name !== name ? el("span", { class: "as-h", text: i.name }) : null,
      line ? el("span", { class: "as-h", text: line }) : null,
      ...facts.map(t => el("span", { class: "as-h", text: t })),
      ...(i && i.reason ? [el("span", { class: "as-h as-why", text: TX("appset.reason", { text: i.reason }) })] : [])),
    i && i.every_minutes ? (app.includes("~")
      ? el("span", { class: "as-v", text: TX("appset.every_min", { n: i.every_minutes }) })
      : asStepper(TX("appset.every_aria", { name: i.name }), i.every_minutes, 1, 10080, v => asEvery(app, i, v), TX("appset.min"), `every:${i.id}`)) : null,
    i && i.dot !== "ok" ? el("button", { class: "btn tonal inrow", type: "button", "data-k": `retry:${i.id}`, onclick: () => asRetry(app, i.id, i.down) }, i.down ? TX("appset.reconnect") : TX("appset.retry")) : null,
    !i && st && st.tone === "err" ? el("span", { class: "tag err", text: st.text }) : null);
}
// 지켜볼 글 of a comment app: how many it follows, and the picker (30-monitoring-comments.js cmPickOpen).
function asPickRow(app) {
  const srcs = cmSrcOf(app);
  return srcs.length ? el("div", { class: "as-row", "data-setting": "watch-posts" }, el("span", { class: "as-b" }, el("span", { class: "as-n", text: TX("appset.watch_posts") })),
    el("span", { class: "as-v", text: cmWatchWord(srcs) }), el("button", { class: "btn tonal inrow", type: "button", "data-k": "pick-open", onclick: () => cmPickOpen(app) }, TX("appset.pick"))) : null;
}
// A description that only says the switch's own name or its state (켜져 있어요 / 꺼져 있어요) adds nothing next to the switch: it is left out.
const asEcho = (name, t) => { const a = String(name || "").replace(/\s/g, ""), b = String(t || "").replace(/\s/g, ""); return !b || /^(켜|꺼)져있어요$/.test(b) || a.includes(b); };
function asFeatRow(app, f) {
  return el("div", { class: "as-row as-feat", "data-feature": f.id },
    el("span", { class: "as-b" }, el("span", { class: "as-n", text: f.name }), asEcho(f.name, f.status) ? null : el("span", { class: "as-h", text: f.status })),
    kkSwitch(f.on, f.name, `feat:${f.id}`, on => asFeatSet(app, f.id, on)));
}
async function asPatch(app, values) {
  const r = await api(asUrl(app), "PATCH", { values });
  // The answer changes the rows it names; a row it does not name stays (a switch must not make sections vanish).
  const got = new Map((r.fields || []).map(f => [f.key, f])), prev = AS.by[app] || [];
  AS.by[app] = [...prev.map(f => got.get(f.key) || f), ...[...got.values()].filter(f => !prev.some(p => p.key === f.key))];
  asPaint();
  MON.sig = ""; monSchedule();
  if (app.includes("~") || pqPc(`settings:${app}`)) pqSoon(); else if (asOwn(app)) loadMonitors(); else loadIntegrations();   // a peer's app or monitor is read back from that computer
  // The Kakao room list draws the same watch and draft lists: read it again so its switches and the screen never disagree.
  if (pqBare(app) === "kakao" && typeof KK !== "undefined" && KK.loaded) kkLoadRooms().catch(() => {});
  return r;
}

/* ---- 감시 삭제: a monitor's settings screen deletes the watch for good (DELETE /api/watches/<name>, on the computer that owns it); a schedule's
   the same way through DELETE /api/schedules/<id> (예약 삭제) ---- */
const asSched = app => app.startsWith("s:");
async function asWatchRmGo(app) {
  if (AS.busy[app]) return;
  AS.busy[app] = true;
  const name = monSettingsName(`settings:${app}`), peer = !!pqPc(`settings:${app}`);
  try {
    await api(`/api/${asSched(app) ? "schedules" : "watches"}/${enc(app.slice(2))}`, "DELETE");
    toast(TX("appset.deleted", { name }));
    AS.rm[app] = null; AS.load[app] = null;
    if (peer) await pqLoad(); else await loadMonitors();
    if (ASC.h) ASC.h.close(false);
    go("monitoring");
  } catch (e) {
    // A watch a project's work channel set up comes back from that setup (hub/workchannels.ts), so the hub refuses it (409).
    toast(/work channel/.test(e.message || "") ? TX("appset.rm.bound") : e.message || TX("appset.delete.fail"), true);
  }
  AS.busy[app] = false; asPaint();
}
function asWatchRmNode(app) {
  const sc = asSched(app);
  if (!AS.rm[app]) return el("div", { class: "as-row" }, el("span", { class: "as-b" }, el("span", { class: "as-n", text: TX(sc ? "appset.rm.title_sched" : "appset.rm.title_watch") }), el("span", { class: "as-h", text: TX(sc ? "appset.rm.hint_sched" : "appset.rm.hint_watch") })), el("button", { class: "btn danger inrow", type: "button", "data-as-rm": "ask", onclick: () => { AS.rm[app] = { watch: true }; asPaint(); } }, TX("common.delete")));
  const pc = pqPc(`settings:${app}`), name = monSettingsName(`settings:${app}`);
  const lines = asSched(app) ? [TX("appset.rm.sched1"), TX("appset.rm.sched2")]
    : [pc ? TX("appset.rm.watch1_at", { pc: pc.name }) : TX("appset.rm.watch1"), TX("appset.rm.watch2"), TX("appset.rm.watch3")];
  return el("div", { class: "as-rm" },
    el("div", { class: "as-n", text: koPick(TX("appset.rm.ask", { name })) }),
    el("ul", { class: "as-rml" }, ...lines.map(t => el("li", { text: t }))),
    el("div", { class: "as-act" }, el("button", { class: "btn sm", type: "button", "data-as-rm": "go", disabled: !!AS.busy[app], onclick: () => asWatchRmGo(app) }, TX("appset.rm.confirm")), el("button", { class: "btn tonal sm", type: "button", "data-as-rm": "cancel", onclick: () => { AS.rm[app] = null; asPaint(); } }, TX("common.cancel"))));
}

/* ---- 제거 (this install only) and 앱 추가 ---- */
async function asRemoveAsk(app) {
  // What a peer's app would remove is read there only when it runs (the peer's read list has no remove plan).
  try { AS.rm[app] = { plan: app.includes("~") ? null : await api(`/api/integrations/${enc(app)}/remove`), del: false }; } catch (e) { return toast(e.message || TX("appset.remove.read_fail"), true); }
  asPaint();
}
async function asRemoveGo(app, btn) {
  const rm = AS.rm[app];
  if (!rm || AS.busy[app]) return;
  AS.busy[app] = true;
  if (btn) btn.disabled = true;
  // 제거 can be taken back: the toast's 되돌리기 switches the app on again (asAdd), on the computer it was removed from.
  const pc = app.includes("~") ? pqPc(`settings:${app}`) : null, back = app.includes("~") && !pc ? null : { label: TX("common.undo"), onclick: () => asAdd(app.split("~")[0], pc) };
  try { await api(`/api/integrations/${enc(app)}/remove`, "POST", { deleteData: rm.del }); toast(TX(rm.plan ? "appset.removed_here" : "appset.removed_there", { label: rm.plan ? rm.plan.label : monSettingsName(`settings:${app}`) }), false, back, back ? 6000 : undefined); AS.rm[app] = null; AS.load[app] = null; if (app.includes("~")) await pqLoad(); else await loadIntegrations(); if (ASC.h) ASC.h.close(false); go("monitoring"); }
  catch (e) { toast(e.message || TX("appset.remove.fail"), true); }
  AS.busy[app] = false; asPaint();
}
function asRemoveNode(app) {
  const rm = AS.rm[app];
  if (!rm) return el("div", { class: "as-row" }, el("span", { class: "as-b" }, el("span", { class: "as-n", text: TX("appset.remove.title") }), el("span", { class: "as-h", text: TX("appset.remove.hint") })), el("button", { class: "btn danger inrow", type: "button", "data-as-rm": "ask", onclick: () => asRemoveAsk(app) }, TX("appset.remove.btn")));
  const p = rm.plan, cb = el("input", { type: "checkbox", "data-k": "delete-data", onchange: () => { rm.del = cb.checked; } });
  const lines = p ? [TX("appset.remove.here1"), p.watches.length ? TX("appset.remove.watches", { n: p.watches.length, names: p.watches.join(", ") }) : TX("appset.remove.no_watch"), p.features.length ? TX("appset.remove.feats", { names: p.features.join(", ") }) : TX("appset.remove.no_feat"), TX("appset.remove.others")]
    : [TX("appset.remove.there1"), TX("appset.remove.there2"), TX("appset.remove.there3")];
  return el("div", { class: "as-rm" },
    el("div", { class: "as-n", text: p ? koPick(TX("appset.remove.ask_here", { label: p.label })) : TX("appset.remove.ask_there") }),
    el("ul", { class: "as-rml" }, ...lines.map(t => el("li", { text: t }))),
    !p || p.data.length ? el("label", { class: "as-del" }, cb, el("span", { text: p ? TX("appset.remove.data", { data: p.data.join(", ") }) : TX("appset.remove.data_any") })) : null,
    el("div", { class: "as-act" }, el("button", { class: "btn danger fill", type: "button", "data-as-rm": "go", disabled: !!AS.busy[app], onclick: ev => asRemoveGo(app, ev.currentTarget) }, TX("appset.remove.confirm")), el("button", { class: "btn tonal", type: "button", "data-as-rm": "cancel", onclick: () => { AS.rm[app] = null; asPaint(); } }, TX("common.cancel"))));
}
// 앱 추가: the last row of the 앱 group opens a sheet. It lists only the apps this computer (and each other computer, labeled with its name) had and
// the owner switched off or removed, each with 다시 켜기, under one box on top: what he types there is sent to the main orchestrator at once and
// the bot reads the matching request in docs/app-templates (owner 2026-10-26; the box instead of a button, owner 11-03). 다시 켜기 of an app that needs reconnecting still fills that one app's request (GET /api/app-templates, hub/app-templates.ts).
const AT = { items: [], key: "", h: null, draft: "" };
const asOffApps = () => {
  const peers = PQ.list.filter(p => p && p.url), me = peers.length ? pqSelf() : "";
  return [...INTG.available.map(a => ({ ...a, pc: null, machine: me })),
    ...peers.flatMap(p => ((p.items && p.items.available) || []).map(a => ({ ...a, pc: pqPcOf(p), machine: p.name })))];
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
    toast(TX("appset.deleted", { name: a.label }));
    AD.del = null; AS.load[a.key] = null;
    if (a.pc) await pqLoad(); else await loadIntegrations();
  } catch (e) { d.busy = false; toast(e.message || TX("appset.delete.fail"), true); }
  asAddPaint();
}
function asDelNode(a) {
  const d = AD.del, p = d.plan, cb = el("input", { type: "checkbox", "data-k": "delete-data", onchange: () => { d.data = cb.checked; } });
  cb.checked = d.data;
  const lines = [d.machine ? TX("appset.del.line1_at", { machine: d.machine, label: a.label }) : TX("appset.del.line1", { label: a.label }), TX("appset.del.line2"), p ? (p.watches.length ? TX("appset.remove.watches", { n: p.watches.length, names: p.watches.join(", ") }) : TX("appset.remove.no_watch")) : TX("appset.del.line3")];
  return el("div", { class: "as-rm", "data-k": "del-confirm" },
    el("ul", { class: "as-rml" }, ...lines.map(t => el("li", { text: t }))),
    !p || p.data.length ? el("label", { class: "as-del" }, cb, el("span", { text: p ? TX("appset.remove.data", { data: p.data.join(", ") }) : TX("appset.remove.data_any") })) : null,
    el("div", { class: "as-act" }, el("button", { class: "btn danger fill", type: "button", "data-k": "del-go", disabled: d.busy, onclick: () => asDelGo(a) }, TX("appset.rm.confirm")), el("button", { class: "btn tonal", type: "button", "data-k": "del-cancel", onclick: () => { AD.del = null; asAddPaint(); } }, TX("common.cancel"))));
}
// The 앱 관리 row's second line: what it holds (the apps switched off, then adding a new one), not a bare list of names that reads like apps in use.
const asAddHint = () => { const off = asOffApps().map(a => a.label); return off.length ? TX("appset.add.hint_off", { names: off.join(", ") }) : TX("appset.add.hint_new"); };
async function asTplLoad() {
  try { AT.items = (await api("/api/app-templates")).items || []; } catch { AT.items = []; }
}
// A middle sheet, not full screen (docs/ui-spec.md 시트·대화창): PC a centered box, phone a sheet from the bottom. The box on top takes the request.
async function asAddSheet() {
  if (AT.h) return;
  const h = AT.h = fsOpen({ labelledby: "as-add-t", cls: "mid", onClose: () => { if (AT.h === h) AT.h = null; } });
  asAddPaint();
  const box = h.box.querySelector("[data-k='new-app-text']");
  if (box) box.focus({ preventScroll: true });
}
function asAddPaint() {
  const h = AT.h;
  if (!h) return;
  const off = asOffApps();
  for (const a of off) if (a.iconPath && !ICONS[a.icon]) ICONS[a.icon] = a.iconPath;
  // 맡기기 stays off while the box is empty (an empty request would do nothing).
  const send = el("button", { class: "btn", type: "button", "data-k": "new-app", disabled: (AT.draft || "").trim() ? null : true, onclick: asNewSend }, TX("appset.add.send"));
  const box = el("textarea", { class: "as-new-in", rows: "3", "data-k": "new-app-text", placeholder: TX("appset.add.ph"), "aria-label": TX("appset.add.aria"),
    oninput: ev => { AT.draft = ev.currentTarget.value; send.disabled = !AT.draft.trim(); },
    onkeydown: ev => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); asNewSend(); } } });
  box.value = AT.draft || "";
  clear(h.box).append(
    fsHead([el("h2", { class: "fs-t", id: "as-add-t", text: TX("appset.add.title") })], { close: () => h.close() }),
    el("div", { class: "fs-body" }, el("div", { class: "as-sec", text: TX("appset.add.new") }), box,
      ...(off.length ? [el("div", { class: "as-sec", text: TX("appset.add.off") }), ...off.flatMap(a => [el("div", { class: "as-row", "data-app": a.key },
        el("span", { class: "as-ic", "aria-hidden": "true" }, icon(a.icon)),
        el("span", { class: "as-b" }, el("span", { class: "as-n", text: a.label }), a.machine ? el("span", { class: "as-h", text: a.machine }) : null),
        el("span", { class: "as-btns" },
          el("button", { class: "btn tonal inrow", type: "button", "data-k": `on:${a.key}`, onclick: () => asAdd(a.key, a.pc) }, TX("appset.add.on")),
          el("button", { class: "btn danger inrow", type: "button", "data-k": `del:${a.key}`, "aria-expanded": String(asDelOpen(a)), onclick: () => asDelOpen(a) ? (AD.del = null, asAddPaint()) : asDelAsk(a) }, TX("common.delete")))),
        ...(asDelOpen(a) ? [asDelNode(a)] : [])])] : [])),
    el("div", { class: "fs-ft row" }, el("button", { class: "btn text", type: "button", "data-k": "new-app-cancel", onclick: () => h.close() }, TX("common.cancel")), send));
}
// 보내기: the request goes to the main orchestrator as the owner's message ("연결할 앱: <what he typed>", docs/app-templates) through the chat's
// own send, and the main chat opens on it, so the work that starts is right there.
const NEW_DRAFT = "연결할 앱: ";
async function asNewSend() {
  const text = (AT.draft || "").trim();
  if (!text) { const box = AT.h && AT.h.box.querySelector("[data-k='new-app-text']"); if (box) box.focus(); return; }
  AT.draft = "";
  if (AT.h) AT.h.close(false);
  asTplEnd();
  ts("main").draft = NEW_DRAFT + text;
  go("chat", "main");
  ta.value = NEW_DRAFT + text;
  await sendChat();
}
async function asNewApp(key) {
  if (!AT.items.length) await asTplLoad();
  const t = AT.items.find(x => x.key === key) || AT.items[AT.items.length - 1];
  if (!t) return toast(TX("appset.tpl.fail"), true);
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
// The line above the chat box while an app request is in it (the question, or the {{ }} hint of a refilled request) with its x; it ends when the
// message is sent or another conversation opens.
function asTplPaint() {
  let row = $("#app-tpl"), note = $("#app-tpl-note");
  if (!AT.key) { if (row) row.hidden = true; if (note) note.hidden = true; return; }
  if (!row) {
    row = el("div", { class: "tplrow", id: "app-tpl" }, note = el("div", { class: "tplnote", id: "app-tpl-note" }),
      el("button", { class: "as-tpl as-tpl-x", type: "button", "aria-label": TX("appset.tpl.close_aria"), title: TX("common.close"), onclick: asTplEnd }, icon("close")));
    $("#composer").insertBefore(row, $("#hints"));
  }
  row.hidden = false; note.hidden = false;
  // The {{ }} fields are the owner's own details: the bot asks for them in the secure form after the message is sent, so they can stay as they are.
  note.textContent = TX("appset.tpl.note", { ph: "{{ }}" });
}
function asTplEnd() { AT.key = ""; asTplPaint(); }
function asTplSync() { if (AT.key && (target !== "main" || current !== "chat")) asTplEnd(); }
async function asAdd(key, pc) {
  const a = asOffApps().find(x => x.key === key && (x.pc ? x.pc.url : "") === (pc ? pc.url : ""));
  if (!a) return;
  try {
    if (pc) {
      await api(pqProxy(pc, "/api/peer/act"), "POST", { action: "app", args: { op: "add", app: key } });
      toast(TX("appset.on_at", { pc: pc.name, label: a.label }));
      await pqLoad(); asAddPaint(); return;
    }
    const r = await api(`/api/integrations/${enc(key)}/add`, "POST", {});
    AS.load[key] = null;
    await loadIntegrations();
    if (AT.h) AT.h.close(false);
    if (r.ready) { toast(TX("appset.on_again", { label: a.label })); go("monitoring", `i:${key}`); return; }
    toast(TX("appset.on_refill", { label: a.label }));
    await asNewApp(/^site(-|$)/.test(key) ? "comments" : key);
  } catch (e) { toast(e.message || TX("appset.add.fail"), true); }
}

const asYes = v => v ? TX("system.fmt.on") : TX("system.fmt.off");
function asFmt(f, v) {
  if (f.type === "bool") return asYes(v);
  if (f.type === "list" || f.type === "rules") return v.length ? TX("appset.fmt.items", { n: v.length }) : TX("system.pj.none");
  if (f.type === "enum") return (f.labels || {})[v] || String(v);
  return String(v) || TX("system.pj.none");
}
// A list changes by what leaves and what comes in; the rest by before -> after.
function asChange(f, before, after) {
  if (f.type !== "list") return `${asFmt(f, before)} → ${asFmt(f, after)}`;
  const add = after.filter(x => !before.includes(x)), del = before.filter(x => !after.includes(x));
  return [add.length ? TX("appset.chg.add", { names: add.join(", ") }) : "", del.length ? TX("appset.chg.del", { names: del.join(", ") }) : "", !add.length && !del.length ? TX("appset.chg.none") : ""].filter(Boolean).join(" · ");
}

/* ---- the controls above the conversation: a switch, a menu or a box per common setting ---- */
function asControl(f, set) {
  if (f.type === "bool") return kkSwitch(f.value, f.label, f.key, set);
  // Two choices are the prototype's segment, a number its − + stepper around the same field (a longer list stays a select).
  if (f.type === "enum" && (f.options || []).length === 2) {
    const seg = el("div", { class: "seg as-seg", role: "radiogroup", "aria-label": f.label, "data-k": f.key }, ...f.options.map(o => el("button", { type: "button", role: "radio", class: String(f.value) === String(o) ? "on" : "", "aria-checked": String(String(f.value) === String(o)), "data-v": o, text: (f.labels || {})[o] || o, onclick: ev => {
      for (const b of seg.children) { const on = b === ev.currentTarget; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); }
      set(o);
    } })));
    return seg;
  }
  if (f.type === "enum") {
    const b = selectButton({ label: f.label, items: (f.options || []).map(o => ({ value: String(o), label: (f.labels || {})[o] || String(o) })), value: String(f.value), onPick: set });
    b.classList.add("as-in"); b.dataset.k = f.key;
    return b;
  }
  if (f.type === "number") return asStepper(f.label, f.value, f.min, f.max, set, f.unit || (/\(([^)]+)\)\s*$/.exec(f.label) || [])[1] || "", f.key);
  const c = el("input", { class: "fi as-in", type: "text", "aria-label": f.label, "data-k": f.key, onchange: () => set(c.value.trim()) });
  c.value = String(f.value);
  return c;
}
// The one control for a number (a period in minutes, a count): − and + around the field, with its unit after it. The check interval of an app, a watch's period and the login keeper's all use it.
function asStepper(label, value, min, max, set, unit, k) {
  const c = el("input", { class: "fi as-in", type: "number", min, max, inputmode: "numeric", "aria-label": label, "data-k": k, onchange: () => set(Number(c.value)) });
  c.value = String(value);
  const step = d => { const v = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number(c.value) + d)); if (v !== Number(c.value)) { c.value = String(v); set(v); } };
  return el("span", { class: "as-step" }, el("button", { class: "ib", type: "button", "aria-label": TX("appset.step.dec", { label }), text: "−", onclick: () => step(-1) }), c, el("button", { class: "ib", type: "button", "aria-label": TX("appset.step.inc", { label }), text: "+", onclick: () => step(1) }), unit ? el("span", { class: "as-unit", text: unit }) : null);
}
/* ---- 자동 초안 규칙 (hub/app-settings.ts draft_rules, draft_default): the rules of a mail app, edited here or by the bot (bin/rules.ts) ---- */
// A rule = 이름 (the badge), 언제 (a plain condition one short model call checks), 어떻게 (the draft's instruction) and 붙일 파일; the 기본 규칙 goes into every
// draft. Every change is the same settings PATCH, so a peer computer's mail app is edited through its own proxy like any other setting.
const AR_PH = {
  name: TX("appset.rule.ph_name"),
  when: TX("appset.rule.ph_when"),
  how: TX("appset.rule.ph_how"),
  files: TX("appset.rule.ph_files"),
};
const AR = { edit: {} };   // app -> { id: rule id or "" for a new rule, v: { name, when, how, files } }
async function arSave(app, list, done) {
  if (AS.busy[app]) return;
  AS.busy[app] = true;
  try { await asPatch(app, { draft_rules: list }); if (done) done(); } catch (e) { toast(e.message || TX("appset.rule.save_fail"), true); }
  AS.busy[app] = false; asPaint();
}
const arFiles = s => String(s || "").split(/[,\n]/).map(x => x.trim()).filter(Boolean);
function arForm(app, rules, ed) {
  const v = ed.v, box = (k, tag, extra) => { const c = el(tag, { class: `fi as-in as-ta`, "data-k": `rule-${k}`, placeholder: AR_PH[k], "aria-label": AR_PH[k].split(":")[0], ...extra, oninput: () => { v[k] = c.value; } }); c.value = v[k] || ""; return el("label", { class: "as-rl" }, el("span", { class: "as-h", text: AR_PH[k].split(":")[0] }), c); };   // the box's name stays above it once the greyed text is gone
  const save = () => {
    const name = (v.name || "").trim(), when = (v.when || "").trim();
    if (!name || !when) return toast(TX("appset.rule.need"), true);
    const rule = { name, when, how: (v.how || "").trim(), files: arFiles(v.files) };
    const list = ed.id ? rules.map(r => r.id === ed.id ? { ...r, ...rule } : r) : [...rules, { ...rule, on: true }];
    arSave(app, list, () => { delete AR.edit[app]; });
  };
  return el("div", { class: "as-row as-col as-rform", "data-rule-form": ed.id || "new" },
    box("name", "input", { type: "text", maxlength: 20 }), box("when", "textarea", { rows: 2, maxlength: 300 }), box("how", "textarea", { rows: 3, maxlength: 1000 }), box("files", "input", { type: "text" }),
    el("div", { class: "as-act" }, el("button", { class: "btn sm", type: "button", "data-k": "rule-save", disabled: !!AS.busy[app], onclick: save }, TX("common.save")),
      el("button", { class: "btn tonal sm", type: "button", "data-k": "rule-cancel", onclick: () => { delete AR.edit[app]; asPaint(); } }, TX("common.cancel"))));
}
function arRow(app, rules, r) {
  const files = (r.files || []).length ? TX("appset.rule.files", { files: r.files.join(", ") }) : "";
  return el("div", { class: "as-row as-rule", "data-rule": r.id },
    el("span", { class: "as-b" }, el("span", { class: "as-n" }, draftRuleTag(r.name, "as-rtag")), el("span", { class: "as-h", text: TX("appset.rule.when", { text: r.when }) }),
      r.how ? el("span", { class: "as-h", text: TX("appset.rule.how", { text: r.how }) }) : null, files ? el("span", { class: "as-h", text: files }) : null),
    el("span", { class: "as-btns" },
      kkSwitch(r.on, r.name, `rule:${r.id}`, on => arSave(app, rules.map(x => x.id === r.id ? { ...x, on } : x))),
      el("button", { class: "btn text inrow", type: "button", "data-k": `rule-edit:${r.id}`, onclick: () => { AR.edit[app] = { id: r.id, v: { name: r.name, when: r.when, how: r.how, files: (r.files || []).join(", ") } }; asPaint(); } }, TX("appset.rule.edit")),
      el("button", { class: "btn text inrow", type: "button", "data-k": `rule-del:${r.id}`, onclick: () => arSave(app, rules.filter(x => x.id !== r.id), () => toast(TX("appset.rule.deleted", { name: r.name }))) }, TX("appset.rule.del"))));
}
// The rows of the section, in order: heading, what rules do, the 기본 규칙 box, each rule (or its form), then 규칙 추가 (or the new rule's form).
function arNodes(app, fRules, fDef) {
  const rules = Array.isArray(fRules.value) ? fRules.value : [], ed = AR.edit[app];
  const def = el("textarea", { class: "fi as-in as-ta", rows: 2, maxlength: fDef.max || 1000, "data-k": "draft_default", placeholder: fDef.placeholder || "", "aria-label": fDef.label,
    onchange: async () => { if (AS.busy[app]) return; AS.busy[app] = true; try { await asPatch(app, { draft_default: def.value.trim() }); toast(TX("appset.rule.default_saved")); } catch (e) { toast(e.message || TX("appset.rule.default_fail"), true); } AS.busy[app] = false; asPaint(); } });
  def.value = fDef.value || "";
  return [
    el("div", { class: "as-sub", "data-sub": "rules", text: fRules.label }),
    el("div", { class: "as-row", "data-setting": "draft_rules" }, el("span", { class: "as-b" }, el("span", { class: "as-h", text: fRules.help }))),
    el("div", { class: "as-row as-col", "data-setting": "draft_default" }, el("span", { class: "as-b" }, el("span", { class: "as-n", text: fDef.label }), el("span", { class: "as-h", text: fDef.help })), def),
    ...rules.map(r => ed && ed.id === r.id ? arForm(app, rules, ed) : arRow(app, rules, r)),
    ed && !ed.id ? arForm(app, rules, ed) : el("div", { class: "as-row" }, el("button", { class: "btn tonal inrow", type: "button", "data-k": "rule-add", disabled: rules.length >= 20, onclick: () => { AR.edit[app] = { id: "", v: {} }; asPaint(); } }, TX("appset.rule.add"))),
  ];
}
// The sections of the settings screen in the order the owner reads them (hub/app-settings.ts SettingSection); a row is drawn once, under one heading.
const asSecName = (k, title) => { const s = stSec(title); s.dataset.sec = k; return s; };
const AS_SECTIONS = [["notify", TX("common.alerts")], ["draft", TX("appset.sec.draft")], ["watch", TX("appset.sec.watch")], ["more", TX("appset.sec.more")], ["advanced", TX("appset.sec.advanced")]];
// 연결 상태 at the top of an app: whether it is connected to its site (and since when it is not). A monitor's own top row is its status card (asStatRow).
// The integration item behind an app's settings: this computer's, or the peer's when the app is `<key>~<computer>`.
function asConnItem(app) {
  const pc = typeof pqPc === "function" ? pqPc(`settings:${app}`) : null;
  const peer = pc && typeof PQ !== "undefined" ? PQ.list.find(p => p && p.url === pc.url) : null;
  return { pc, it: pc ? ((peer && peer.items && peer.items.integrations) || []).find(x => x.key === app.split("~")[0]) : INTG.items.find(x => x.key === app) };
}
function asConnNode(app) {
  if (asOwn(app)) return null;
  const { pc, it } = asConnItem(app);
  const off = !!(it && it.state === "disconnected");
  const last = pc ? "" : monStatMons(app).map(m => m && (m.last_ok || m.last_run)).filter(Boolean).sort().pop();
  const sub = off ? (it.since ? TX("appset.conn.since", { at: monTime(it.since) }) : it.hint || TX("appset.conn.relogin")) : !it ? "" : pc ? TX("appset.conn.at_pc", { pc: pc.name }) : last ? TX("appset.last.check", { at: monTime(last) }) : "";
  return el("div", { class: "as-row as-conn", "data-conn": off ? "disconnected" : it ? "connected" : "unknown" },
    el("span", { class: `as-dot ${off ? "fail" : it ? "ok" : "idle"}`, "aria-hidden": "true" }),
    el("span", { class: "as-b" }, el("span", { class: "as-n", text: off ? TX("appset.conn.off") : it ? TX("appset.conn.on") : TX("appset.conn.checking") }), sub ? el("span", { class: "as-h", text: sub }) : null));
}
// One settings row. A feature whose switch IS this setting is not drawn again under 기능; only its waiting count rides along here.
function asSettingRow(app, f, feat, box) {
  const bound = feat && feat.features.find(x => x.setting === f.key), wait = bound && /승인 대기/.test(bound.status) ? bound.status : "";
  return el("div", { class: "as-row", "data-setting": f.key },
    el("span", { class: "as-b" }, el("span", { class: "as-n", text: f.type === "number" && !f.blocked ? f.label.replace(/\s*\([^)]+\)\s*$/, "") : f.label }), f.blocked || (f.help && !asEcho(f.label, f.help)) ? el("span", { class: "as-h", text: f.blocked || f.help }) : null, wait ? el("span", { class: "as-h", "data-wait": "1", text: wait }) : null),
    // A list is edited in the conversation (a change card); here it only says how many.
    f.type === "list" ? el("span", { class: "as-v", text: asFmt(f, f.value) }) : f.blocked ? Object.assign(kkSwitch(false, f.label, f.key, () => {}), { disabled: true }) : asControl(f, async v => {
      if (AS.busy[app]) return;
      AS.busy[app] = true;
      try { await asPatch(app, { [f.key]: v }); } catch (e) { toast(e.message || TX("appset.set.fail")); }
      AS.busy[app] = false; delete box.dataset.sig; asPaint();
    }));
}
// The options and the status of the settings screen (asScreen) - never of the conversation, which is chat only.
function asPaint() {
  // the open sheet's own box: a closed one keeps its #app-sw in the page while it fades out (fsOpen)
  const box = ASC.h && ASC.h.box.querySelector("#app-sw"), app = ASC.app;
  if (!box || !app) return;
  const fields = AS.by[app];
  if (!fields) {
    const sig = AS.none[app] ? "none" : "load";
    if (box.dataset.sig !== sig) { box.dataset.sig = sig; clear(box).append(AS.none[app] ? emptyNode(TX("appset.set.load_fail"), () => asLoad(app, true)) : el("div", { class: "as-row" }, el("span", { class: "as-h", text: TX("common.loading") }))); }
    return;
  }
  const feat = asOwn(app) ? null : AS.feat[app] || null;
  // The watch status rows and the connection row are drawn from the monitor and integration data, so their changes repaint too.
  const statSig = asOwn(app) ? [asMon(app)] : [monStatMons(app), (({ it }) => it ? [it.state, it.since, it.hint] : null)(asConnItem(app))];
  const sig = JSON.stringify([app, fields.map(f => f.value), AS.busy[app], !!AS.rm[app], feat, statSig, AR.edit[app] ? AR.edit[app].id || "new" : null, cmSrcOf(app).length && cmWatchWord(cmSrcOf(app))]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  // Within a section: the switch that turns the feature on, then the feature rows, then the other values, then the lists, then what waits or runs.
  const secs = new Map(AS_SECTIONS.map(([k]) => [k, []]));
  const put = (sec, rank, node) => (secs.get(sec) || secs.get("advanced")).push({ rank, node });
  const keys = new Set(fields.map(f => f.key));
  // 기억 항목 (attach folder, follow-up rule) are learned in conversation, never typed here: shown read only, with how to change them.
  const fRules = fields.find(f => f.type === "rules"), fDef = fRules && fields.find(f => f.key === "draft_default");
  if (fRules && fDef) for (const node of arNodes(app, fRules, fDef)) put("draft", 6, node);
  for (const f of fields.filter(f => !f.memory && f !== fRules && f !== fDef)) put(f.section || "advanced", f.type === "list" ? 4 : f.switch ? 1 : 3, asSettingRow(app, f, feat, box));
  if (feat) {
    for (const f of feat.features) if (!(f.setting && keys.has(f.setting))) put(f.section || "more", 2, asFeatRow(app, f));
    if (feat.approvals.length) put("draft", 5, asWaitRow(app, feat.approvals.length));
  }
  // Every watch the app owns gets one status row, whether or not the features route answers (an older hub has none); its kind, reason and period
  // ride on that row when it does.
  const internals = feat ? feat.internal : [], statMons = asOwn(app) ? [] : monStatMons(app);
  const byWatch = new Map(statMons.map(m => [m.watch || m.name, m])), drawn = new Set();
  for (const i of internals) { const m = byWatch.get(i.id); if (m) drawn.add(m); put("watch", 5, asStatRow(app, m || null, i)); }
  for (const m of statMons) if (!drawn.has(m)) put("watch", 5, asStatRow(app, m, null));
  const pick = asPickRow(app);
  if (pick) put("watch", 0, pick);
  const mem = fields.filter(f => f.memory);
  if (mem.length) put("advanced", 6, el("div", { class: "as-row as-mem", "data-setting": "memory" },
    el("span", { class: "as-b" }, el("span", { class: "as-n", text: TX("appset.mem.title") }),
      el("span", { class: "as-h", text: TX("appset.mem.hint") }),
      ...mem.map(f => el("span", { class: "as-h", text: `${f.label}: ${f.value === "" || f.value == null ? TX("appset.mem.none") : asFmt(f, f.value)}` })))));
  put("advanced", 7, asOwn(app) ? asWatchRmNode(app) : asRemoveNode(app));
  const wmon = asOwn(app) ? asMon(app) : null;
  const conn = asOwn(app) ? (wmon ? asStatRow(app, wmon, null) : null) : asConnNode(app);
  // The shape every 설정 page has (22-settings-pages.js): the status card first, then each section as its name (.sec) outside and its own card (.list) of rows.
  const kids = [
    ...(conn ? [stList(conn)] : []),
    ...AS_SECTIONS.flatMap(([k, title]) => {
      const rows = secs.get(k).map((r, i) => ({ ...r, i })).sort((a, b) => a.rank - b.rank || a.i - b.i).map(r => r.node);
      return rows.length ? [asSecName(k, title), stList(...rows)] : [];
    })];
  // A repaint after a switch keeps the place: the scroll position and the focused control (found again by its data-k) stay.
  const sc = box.closest(".fs-body"), top = sc ? sc.scrollTop : 0, fk = box.contains(document.activeElement) ? document.activeElement.dataset.k : "";
  paintKeep(box, kids, asPaint, app);
  if (sc) sc.scrollTop = top;
  const again = fk && [...box.querySelectorAll("[data-k]")].find(x => x.dataset.k === fk);
  if (again && document.activeElement !== again) again.focus({ preventScroll: true });
}
// The settings screen: a view pushed over the conversation (back button on a phone and on a wide screen) with the status card and every option row.
// The conversation keeps only the chat; its header's ⋯ button opens this.
const ASC = { app: "", h: null };
// 모니터링 on a wide screen: the settings stand in the right column of the app frame (the item's list or panel stays at the left), not in a window. Back, the x and Esc close it.
function asPaneOpen(onClose) {
  let pane = $("#as-pane");
  if (!pane) { pane = el("div", { class: "as-pane", id: "as-pane" }); $("#v-monitoring").append(pane); }
  const box = el("section", { class: "as-screen as-card", role: "region", "aria-labelledby": "as-scr-t", tabindex: "-1", onkeydown: ev => { if (ev.key === "Escape") { ev.stopPropagation(); h.close(); } } });
  let ov = null, closed = false;
  const h = { pane: true, sel: MON.sel, box, ends: [], close() {
    if (closed) return;
    closed = true; h.ends.splice(0).forEach(f => f());
    ovDone(ov); box.remove(); $("#v-monitoring").classList.remove("as-on");
    onClose();
  } };
  ov = ovOpen(() => h.close());
  clear(pane).append(box);
  $("#v-monitoring").classList.add("as-on");
  return h;
}
// Called by renderMonitoring and convChrome: the pane goes with its item (another item, the list, another view, a phone width). An item its own settings renamed
// (a schedule's 내용 is its name) is the same item under a new key: the pane follows it.
function asPaneSync() {
  const h = ASC.h;
  if (!h || !h.pane) return;
  if (MON.sel && MON.sel !== h.sel && !monItems().some(i => i.key === h.sel)) h.sel = MON.sel;
  if (current !== "monitoring" || narrowChat() || MON.list || MON.sel !== h.sel) h.close();
}
// Called by renderMonitoring before it looks for the open item: a schedule renamed by its own 내용 comes back under a new key, and the pane follows it.
function asPaneFollow(items) {
  const h = ASC.h;
  if (!h || !h.pane || !asOwn(ASC.app) || items.some(i => i.key === MON.sel)) return;
  const it = items.find(i => monSettingsApp(i) === ASC.app);
  if (it) MON.sel = h.sel = it.key;
}
const asBack = () => !!(current === "monitoring" && ASC.h && ASC.h.pane && (ASC.h.close(), true));
function asScreen(app) {
  if (ASC.h || !app) return;
  asLoad(app);
  const onClose = () => { if (ASC.h === h) { ASC.h = null; ASC.app = ""; } };
  const h = ASC.h = current === "monitoring" && !narrowChat() ? asPaneOpen(onClose) : fsOpen({ labelledby: "as-scr-t", cls: "tall as-screen", onClose });
  ASC.app = app;
  if (!asOwn(app)) asFeatLoad(app);
  // The window of a wide screen closes with the ✕ at the right, the one way its sibling sheets have (fsHead); a phone's full screen keeps the back arrow.
  // (the ✕ keeps the back arrow's data-k: one hook for the one button that leaves this screen)
  const tt = [monSettingsName(`settings:${app}`) === TX("common.settings") ? null : el("span", { class: "fs-ey", text: TX("common.settings") }), el("h2", { class: "fs-t", id: "as-scr-t", text: monSettingsName(`settings:${app}`) })].filter(Boolean);
  const head = phoneWide()
    ? el("div", { class: "fs-hd" }, el("button", { class: "ib fs-x as-back", type: "button", "aria-label": TX("common.back"), "data-k": "as-back", onclick: () => h.close() }, icon("back")), el("div", { class: "fs-tt" }, ...tt))
    : fsHead(tt, { close: () => h.close() });
  if (!phoneWide()) head.querySelector(".fs-x").dataset.k = "as-back";
  clear(h.box).append(
    head,
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
const asMon = app => { const pe = PQ.of.get(`settings:${app}`); return pe ? pe.mon : NM.items.find(x => app.startsWith("s:") ? x.schedule === app.slice(2) : x.watch === app.slice(2)); };
const asChipTexts = m => m && m.last_result === "fail" ? [...(m.keeper ? [TX("appset.chip.relogin")] : []), TX("appset.chip.cause"), m.paused ? TX("appset.chip.resume") : TX("appset.chip.pause")] : [];
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
  if (!row) { row = el("div", { class: "tplrow", id: "mon-chips", role: "group", "aria-label": TX("appset.chips_aria") }); $("#composer").insertBefore(row, $("#hints")); }
  row.hidden = false;
  const sig = JSON.stringify([app, texts]);
  if (row.dataset.sig === sig) return;
  row.dataset.sig = sig;
  clear(row).append(...texts.map(t => el("button", { class: "as-tpl", type: "button", "data-chip": t, onclick: () => asSend(t) }, t)));
}

/* ---- the entries of a detail's title bar (the head on a wide screen, the app bar on a phone): 대화 opens its settings conversation, ⋯ the settings screen ---- */
function asOpen(ev) { go("monitoring", `c:${asConv(ev.currentTarget.dataset.asOpen)}`); }
const asBtn = app => el("button", { class: "ib as-hd", type: "button", "aria-label": TX("common.conversation"), title: TX("common.conversation"), "data-as-open": app, onclick: asOpen }, icon("chat"));
// The two buttons of `app` ("mail", "w:<watch>"): 대화 and ⋯; none while its settings are not loaded (an app without any shows no button).
// A schedule ("s:<id>") has no settings conversation: only ⋯.
function asEntry(app) {
  if (!app) return [];
  if (!AS.load[app]) asLoad(app);
  return !AS.by[app] ? [] : asSched(app) ? [asMoreBtn(app)] : [asBtn(app), asMoreBtn(app)];
}
// The phone has no head: the same button sits in the app bar beside the title and follows the open detail.
var asBar = asBtn("");   // var: the app bar is drawn (31-conversations.js convTitle) before this file runs
asBar.id = "as-bar"; asBar.hidden = true;
$("#vtog").before(asBar);
// ⋯ opens the settings screen (in a detail's title bar and in the settings conversation's head).
function asMoreBtn(app) { return el("button", { class: "ib as-hd as-more", type: "button", "aria-label": TX("common.settings"), title: TX("common.settings"), "data-as-more": app, onclick: ev => asScreen(ev.currentTarget.dataset.asMore) }, icon("more")); }
var asMoreBar = asMoreBtn("");   // var: convTitle runs before this file
asMoreBar.id = "as-more-bar"; asMoreBar.hidden = true;
$("#vtog").before(asMoreBar);
function asMoreSync(app) {
  asMoreBar.hidden = !app || !(isSettingsT(target) || AS.by[app]);
  if (app) asMoreBar.dataset.asMore = app;
}
function asBarSync(app) {
  const on = !!app && !asSched(app) && !!asEntry(app).length;
  asBar.hidden = !on;
  if (on) asBar.dataset.asOpen = app;
}

/* ---- the change card: a ```dotz-settings fence in an answer (mdHtml in 02-basic-markdown.js) ---- */
const asId = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
// A change proposal in an answer that is not applied or cancelled yet: the answer has not done anything, so its head must not say 완료 (11-todo-strip.js).
function asProposalPending(text) {
  return [...String(text).matchAll(/```dotz-settings\n([\s\S]*?)```/g)].some(m => {
    const src = m[1].trim();
    let b = null;
    try { b = JSON.parse(src); } catch { return false; }
    const ch = b && b.changes && typeof b.changes === "object" ? Object.keys(b.changes) : [], fields = AS.by[String(b.app || "")] || [];
    return ch.length > 0 && !AS.done[asId(src)] && !(fields.length && ch.every(k => (fields.find(x => x.key === k) || {}).memory));
  });
}
function settingsCardHtml(src) {
  let b = null;
  try { b = JSON.parse(src); } catch { /* shown as unreadable below */ }
  const ch = b && b.changes && typeof b.changes === "object" && !Array.isArray(b.changes) ? b.changes : null, app = b ? String(b.app || "") : "";
  if (!ch || !Object.keys(ch).length) return `<div class="as-card"><div class="as-ct">${TX("appset.card.bad")}</div></div>`;
  if (!AS.load[app]) asLoad(app).then(() => typeof renderAll === "function" && renderAll());
  const fields = AS.by[app] || [], id = asId(String(src).trim()), state = AS.done[id];
  const rows = Object.entries(ch).map(([k, v]) => {
    const f = fields.find(x => x.key === k), kept = state === "applied" && (AS.lines[id] || {})[k];
    if (kept) return `<div class="as-cr" data-k="${esc(k)}"><span class="as-cn">${esc(kept.label)}</span><span class="as-cv">${esc(kept.text)}</span></div>`;
    const text = !f ? JSON.stringify(v) : state === "applied" ? asFmt(f, v) : asChange(f, f.value, v);
    // a value that changes (not a list): the old one grey and struck through, the new one the only bold thing (docs/ui-principles.md 2)
    const shown = f && state !== "applied" && f.type !== "list" ? `<s class="as-old">${esc(asFmt(f, f.value))}</s> → <span class="as-now">${esc(asFmt(f, v))}</span>` : esc(text);
    return `<div class="as-cr" data-k="${esc(k)}"><span class="as-cn">${esc(f ? f.label : k)}</span><span class="as-cv">${shown}</span></div>`;
  }).join("");
  // only memory keys: the gateway kept them already (hub/app-settings.ts applyMemory), so there is nothing to apply
  const memOnly = fields.length && Object.keys(ch).every(k => (fields.find(x => x.key === k) || {}).memory);
  if (memOnly) return `<div class="as-card applied"><div class="as-ct">${TX("appset.card.mem")}</div>${Object.entries(ch).map(([k, v]) => { const f = fields.find(x => x.key === k); return `<div class="as-cr"><span class="as-cn">${esc(f.label)}</span><span class="as-cv">${esc(asFmt(f, v))}</span></div>`; }).join("")}</div>`;
  const undo = state === "applied" && Object.keys(ch).every(k => (AS.lines[id] || {})[k] && "old" in AS.lines[id][k]) ? `<div class="as-act"><button class="btn text sm" type="button" data-as="undo">${TX("common.undo")}</button></div>` : "";
  const foot = state ? `<div class="as-done ${state}">${TX(state === "applied" ? "appset.card.applied" : "appset.card.cancelled")}</div>${undo}`
    : `<div class="as-act"><button class="btn sm" type="button" data-as="apply">${TX("appset.apply")}</button><button class="btn text sm" type="button" data-as="cancel">${TX("common.cancel")}</button></div>`;
  return `<div class="as-card${state ? ` ${state}` : ""}" data-as-id="${id}" data-as-app="${esc(app)}" data-as-src="${esc(String(src).trim())}"><div class="as-ct">${TX("appset.card.title")}</div>${rows}${foot}</div>`;
}
document.addEventListener("click", async ev => {
  const btn = ev.target.closest && ev.target.closest("[data-as]");
  const card = btn && btn.closest(".as-card");
  if (!card) return;
  const id = card.dataset.asId, app = card.dataset.asApp, src = card.dataset.asSrc;
  // 적용 -> 적용했어요 happens in the same place: the new card replaces the old one and fades up (docs/ui-principles.md 6)
  const redraw = () => { card.insertAdjacentHTML("afterend", settingsCardHtml(src)); const next = card.nextElementSibling; card.remove(); motionSwap(next, () => {}); };
  if (btn.dataset.as === "cancel") { AS.done[id] = "cancelled"; asSave(); redraw(); return; }
  btn.disabled = true;
  const undo = btn.dataset.as === "undo";   // 되돌리기: the old values go back and the card is the proposal again
  // the words the card shows now (label, new value) and the values to put back are kept before the PATCH redraws the settings behind it
  const lines = {}, fields = AS.by[app] || [];
  for (const row of card.querySelectorAll(".as-cr[data-k]")) {
    const k = row.dataset.k, f = fields.find(x => x.key === k), now = row.querySelector(".as-now") || row.querySelector(".as-cv");
    lines[k] = { label: row.querySelector(".as-cn").textContent, text: now.textContent, ...(f && "value" in f ? { old: f.value } : {}) };
  }
  try {
    if (undo) { await asPatch(app, Object.fromEntries(Object.entries(AS.lines[id] || {}).map(([k, l]) => [k, l.old]))); delete AS.done[id]; delete AS.lines[id]; }
    else { await asPatch(app, JSON.parse(src).changes); AS.done[id] = "applied"; AS.lines[id] = lines; }
    asSave(); redraw();
  }
  catch (e) { btn.disabled = false; toast(e.message || TX("appset.set.fail")); }
});
