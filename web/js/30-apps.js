/* ---------- 앱: the one place every app lives, the shipped 모니터링 apps and the owner's own (hub/user-apps.ts) ---------- */
// Data: GET /api/apps -> {items: [{id, label, kind: "monitor"|"tool", source: "registry"|"manifest", icon, iconPath?, status:
// "running"|"unreachable"|"unknown"|"off", reason?, off?, web?: {href, url, path, mode}, health, watches, settings, start?}],
// errors: [{id, dir, reason}]}. A tool app's own page is served by the gateway at /apps/<id>/ (hub/app-proxy.ts) and shown in
// the frame under the standard header: back, name, status, 새 탭, ⋯ (설정 / 끄기 / 제거). The rows are the 모니터링 list's rows.
// window.appsMonItems() lets 30-monitoring.js (not ours) add the tool apps to its 앱 group; nothing here edits that file.
const APPS = { items: [], errors: [], loaded: false, failed: false, sel: "", list: true, sig: "", timer: 0 };
const APP_STATUS = { running: [TX("apps.status.running"), "ok"], unreachable: [TX("apps.status.unreachable"), "err"], unknown: [TX("apps.status.unknown"), ""], off: [TX("apps.status.off"), ""] };
const appsNarrow = () => narrowChat();
const appsTool = a => a && a.source === "manifest" && a.kind === "tool" && a.web;

function appsLoadIcons() {
  for (const a of [...APPS.items, ...APPS.errors]) if (a.iconPath && !ICONS[a.icon]) ICONS[a.icon] = a.iconPath;
}
async function loadApps() {
  try {
    const r = await api("/api/apps");
    APPS.items = Array.isArray(r.items) ? r.items : [];
    APPS.errors = Array.isArray(r.errors) ? r.errors : [];
    APPS.loaded = true; APPS.failed = false;
  } catch { APPS.failed = !APPS.loaded; }
  appsLoadIcons();
  appsSchedule();
}
// An app's icon: a name the icon set does not know (an app that sent none) takes the app list's file icon, never an empty box.
const appsAv = ic => el("span", { class: "cv-av app-av", "aria-hidden": "true" }, icon(ICONS[ic] ? ic : "file"));
// The state is said once, at the row's right as dot + word (appsBadge); the line under the name says only what the word does not (why it does not answer, what kind of app).
const appsBadge = a => { const s = a.off ? APP_STATUS.off : APP_STATUS[a.status] || APP_STATUS.unknown; return [s[0], s[1]]; };
const appsStatusLine = a => {
  if (a.source === "registry") return a.status === "unreachable" ? a.hint || "" : "";
  if (a.off) return "";
  return a.status === "unreachable" ? a.reason || "" : a.kind === "monitor" ? TX("apps.row.monitor_hint") : "";
};

// The list: 사용자 앱 (the manifests), then 모니터링 앱 (the shipped contact-first apps), then the manifests that did not load.
function appsRows() {
  const rows = [], tools = APPS.items.filter(a => a.source === "manifest");
  rows.push({ header: TX("apps.group.own") });
  if (!tools.length) rows.push({ k: "empty-apps", name: TX("apps.empty.name"), av: appsAv("add"), hint: TX("apps.empty.hint"), open: () => go("chat") });
  for (const a of tools) {
    rows.push({ k: a.id, name: a.label, av: appsAv(a.icon), hint: appsStatusLine(a), badge: appsBadge(a), sel: APP_STATE_ON() && a.id === (appsPicked() || {}).id, open: () => appsPick(a.id) });
  }
  const reg = APPS.items.filter(a => a.source === "registry");
  if (reg.length) {
    rows.push({ header: TX("apps.group.monitor") });
    for (const a of reg) rows.push({ k: `r:${a.id}`, name: a.label, av: appsAv(a.icon), hint: appsStatusLine(a), badge: appsBadge(a), open: () => go("monitoring", `i:${a.id}`) });
  }
  if (APPS.errors.length) {
    rows.push({ header: TX("apps.group.failed") });
    for (const e of APPS.errors) rows.push({ k: `e:${e.id}`, name: e.id, av: appsAv("file"), hint: e.reason, badge: [TX("apps.status.error"), "err"], open: () => dialog({ title: TX("apps.err.title"), body: el("div", { class: "apps-err" }, el("p", {}, el("b", { text: e.id })), el("p", { text: e.reason }), el("p", { class: "sup", text: e.dir })), mid: true,
      actions: [{ label: TX("apps.recheck"), kind: "pri", onclick: close => { close(); loadApps().then(() => { APPS.sig = ""; appsSchedule(); }); } }] }) });
  }
  if (!APPS.loaded) rows.push({ header: APPS.failed ? TX("apps.load_failed") : TX("apps.loading") });
  return rows;
}
const APP_STATE_ON = () => current === "apps" && !APPS.list;
function appsRowScrollOn() {
  const side = $("#apps-side");
  return side ? side.scrollTop : 0;
}
// The open app: on a phone only after a row is picked (the list is a screen of its own); on a wide screen the pick, else the first tool app.
function appsPicked() {
  const picked = APPS.sel && APPS.items.find(a => a.id === APPS.sel);
  if (appsNarrow()) return APPS.list ? null : picked || null;
  return picked || APPS.items.find(a => appsTool(a)) || APPS.items[0] || null;
}
// A row picked beside the open app (wide) is the same screen: the address changes in place, so back does not step through every row picked. A phone's pick is a screen of its own.
function appsPick(id) {
  if (current !== "apps" || appsNarrow()) { go("apps", id); return; }
  APPS.sel = id; APPS.list = false;
  routeReplace(`apps/${enc(id)}`);
  appsRender();
}
const appsHash = () => (APPS.sel && !(appsNarrow() && APPS.list) ? `apps/${enc(APPS.sel)}` : "apps");
function appsOpen(tgt) {
  if (tgt && tgt !== "list") { APPS.sel = tgt; APPS.list = false; }
  else APPS.list = appsNarrow();
  appsRender();
  if (appsNarrow() && !APPS.list) $("#apps-pane").scrollTop = 0;
}

function appsHeader(a) {
  const st = a.off ? APP_STATUS.off : APP_STATUS[a.status] || APP_STATUS.unknown;
  const hint = appsTool(a) && !a.off && a.status !== "unreachable" ? pkHint() : null;   // a phone: a line under the status, the title keeps its width
  return el("header", { class: "apps-hd" },
    appsNarrow() ? el("button", { class: "ib", type: "button", "aria-label": TX("apps.list"), title: TX("apps.list"), onclick: () => go("apps") }, icon("back")) : null,
    appsAv(a.icon),
    el("div", { class: "apps-hb" }, el("h2", { class: "apps-n", text: a.label }), el("p", { class: "apps-p" }, st[0], a.reason && !a.off ? ` · ${a.reason}` : ""), appsNarrow() ? hint : null),
    appsNarrow() ? null : hint,
    appsTool(a) && !a.off ? el("a", { class: "ib", href: a.web.href, target: "_blank", rel: "noopener", "aria-label": TX("apps.open_tab"), title: TX("apps.open_tab") }, icon("open")) : null,
    el("button", { class: "ib", type: "button", "aria-label": TX("apps.menu"), title: TX("apps.menu"), "aria-haspopup": "listbox", "aria-expanded": "false", onclick: ev => appsMenu(ev.currentTarget, a) }, icon("more")));
}

const kvRows = (obj) => el("div", { class: "apps-kv" }, ...Object.entries(obj).map(([k, v]) => el("div", { class: "apps-kr" }, el("span", { class: "apps-kk", text: k }), el("span", { class: "apps-kv2", text: String(v) }))));
function appsSettings(a) {
  const body = el("div", { class: "apps-set" },
    kvRows({ [TX("apps.set.address")]: a.web ? a.web.href : a.kind === "monitor" ? TX("apps.set.in_monitoring") : "", [TX("apps.set.status")]: (APP_STATUS[a.off ? "off" : a.status] || APP_STATUS.unknown)[0] }),
    a.start ? el("div", { class: "apps-block" }, el("div", { class: "apps-kk", text: TX("apps.set.run") }), el("p", { class: "apps-note", text: TX("apps.set.run_note") }), el("pre", { class: "apps-pre", text: [a.start.cwd ? `cd ${a.start.cwd}` : "", `${a.start.env ? Object.entries(a.start.env).map(([k, v]) => `${k}=${v}`).join(" ") + " " : ""}${a.start.command}`].filter(Boolean).join("\n") })) : null,
    a.watches && a.watches.length ? el("div", { class: "apps-block" }, el("div", { class: "apps-kk", text: TX("apps.set.watches") }), el("p", { class: "apps-note", text: a.watches.join(", ") })) : null,
    a.settings && Object.keys(a.settings).length ? el("div", { class: "apps-block" }, el("div", { class: "apps-kk", text: TX("common.settings") }), kvRows(a.settings)) : null);
  dialog({ title: TX("apps.set.title", { label: a.label }), body, mid: true });
}
function appsMenu(anchor, a) {
  const own = a.source === "manifest";
  const items = [{ value: "settings", label: TX("common.settings") }, ...(own ? [{ value: "off", label: a.off ? TX("apps.on") : TX("apps.off") }] : []), ...(own ? [{ value: "remove", label: TX("apps.remove"), danger: true }] : [])];
  showMenu(anchor, items, { onPick: v => { if (v === "settings") appsSettings(a); else if (v === "off") appsToggle(a); else if (v === "remove") appsRemove(a); } });
}
async function appsToggle(a) {
  try {
    await api(`/api/apps/${enc(a.id)}`, "PATCH", { off: !a.off });
    toast(a.off ? TX("apps.toast.on", { label: a.label }) : TX("apps.toast.off", { label: a.label }));
    await loadApps();
  } catch (e) { toast(e.message, true); }
}
async function appsRemove(a) {
  const sure = await ask(TX("apps.remove.title", { label: a.label }), TX("apps.remove.body"), TX("apps.remove"), true);
  if (!sure) return;
  try {
    await api(`/api/apps/${enc(a.id)}`, "DELETE");
    APPS.sel = ""; APPS.list = true;
    toast(TX("apps.toast.removed", { label: a.label }));
    navSync("apps", "apps");
    await loadApps();
  } catch (e) { toast(e.message, true); }
}

function appsBody(a) {
  if (!appsTool(a)) {
    return el("div", { class: "apps-card" },
      el("p", { class: "apps-note", text: a.kind === "monitor" ? TX("apps.body.monitor") : TX("apps.body.no_screen") }),
      a.source === "registry" ? el("button", { class: "btn tonal sm", type: "button", text: TX("apps.open_monitoring"), onclick: () => go("monitoring", `i:${a.id}`) }) : null);
  }
  if (a.off) return el("div", { class: "apps-card" }, el("p", { class: "apps-note", text: TX("apps.status.off") }), el("button", { class: "btn tonal sm", type: "button", text: TX("apps.on"), onclick: () => appsToggle(a) }));
  if (a.status === "unreachable") {
    return el("div", { class: "apps-card" },
      el("p", { class: "apps-note", text: a.reason ? TX("apps.body.no_response_why", { label: a.label, reason: a.reason }) : TX("apps.body.no_response", { label: a.label }) }),
      a.start ? el("p", { class: "apps-note", text: TX("apps.body.check_running") }) : null,
      el("button", { class: "btn tonal sm", type: "button", text: TX("apps.recheck"), onclick: () => loadApps().then(() => { APPS.sig = ""; appsSchedule(); }) }));
  }
  const frame = el("iframe", { class: "apps-frame", src: a.web.href, title: a.label, referrerpolicy: "same-origin", onload: () => appsFrameCheck(frame, a) });
  return frame;
}
// The gateway answers a plain-text page ("not found", or why the app did not answer) when the app is not there; an app's own page is never plain text.
// Say that in the app's words, with a way to open it again.
function appsFrameCheck(frame, a) {
  let plain = false;
  try { plain = frame.contentDocument.contentType === "text/plain"; } catch { return; }
  if (!plain) return;
  frame.replaceWith(emptyNode(TX("apps.body.wont_open", { label: a.label }), async () => { await loadApps(); APPS.sig = ""; $("#apps-pane").dataset.key = ""; appsRender(); }));
}

let appsRaf = 0;
// Only the shown 앱 tab is drawn, so an app's iframe (its page, sockets, CPU) never loads behind another tab.
const appsSchedule = () => { if (!appsRaf) appsRaf = requestAnimationFrame(() => appsRender()); };
function appsRender() {
  appsRaf = 0;
  if (current !== "apps") return;
  const side = $("#apps-side"), pane = $("#apps-pane");
  $("#v-apps").classList.toggle("cv-listing", appsNarrow() && APPS.list);
  const rows = appsRows(), sig = JSON.stringify([rows.map(r => [r.k, r.name, r.hint, r.badge, r.header, r.sel]), APPS.sel, APPS.list, appsNarrow()]);
  if (sig !== APPS.sig) {
    APPS.sig = sig;
    const top = appsRowScrollOn();
    clear(side).append(...convCards(rows));   // the cards of the chat list, so a row stands where chat's row stands
    side.scrollTop = top;
  }
  const a = appsPicked();
  const head = a ? appsHeader(a) : el("header", { class: "apps-hd" }, el("div", { class: "apps-hb" }, el("h2", { class: "apps-n", text: TX("apps.title") }), el("p", { class: "apps-p", text: TX("apps.subtitle") })));
  const bodyKey = a ? `${a.id}:${a.off}:${a.status}:${a.reason || ""}:${appsNarrow()}` : "none";
  if (pane.dataset.key === bodyKey && pane.firstChild) { /* same app, same state: keep the frame (a reload would lose the app's own state) */ }
  else {
    pane.dataset.key = bodyKey;
    clear(pane).append(head, a ? appsBody(a) : el("div", { class: "apps-card" }, el("p", { class: "apps-note", text: TX("apps.pick") })));
  }
}

// The hook for 30-monitoring.js (that file is not ours): its 앱 group can show the tool apps as rows of its own shape.
//   in monItems(), after the INTG.items loop:  for (const a of (window.appsMonItems ? appsMonItems() : [])) items.push(a);
//   in monRows(), the row's opener:            open: () => it.tool ? go("apps", it.id) : go("monitoring", it.key)
window.appsMonItems = () => APPS.items.filter(a => a.source === "manifest" && a.kind === "tool").map(a => ({
  key: `x:${a.id}`, id: a.id, tool: true, group: MON_GROUP.app, name: a.label, ic: a.icon, notices: [], mails: [], app: true, unread: 0, unreplied: 0,
  hint: appsStatusLine(a), badge: appsBadge(a), at: "",
}));

loadApps();
setInterval(() => { if (current === "apps" && !document.hidden) loadApps(); }, 30000);
