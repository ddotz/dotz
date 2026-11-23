/* ---------- 앱: the one place every app lives, the shipped 모니터링 apps and the owner's own (hub/user-apps.ts) ---------- */
const APPS = { items: [], errors: [], loaded: false };
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
    APPS.loaded = true;
  } catch { return; }
  appsLoadIcons();
  monDirty();
}
// An app's icon: a name the icon set does not know (an app that sent none) takes the app list's file icon, never an empty box.
const appsAv = ic => el("span", { class: "cv-av app-av", "aria-hidden": "true" }, icon(ICONS[ic] ? ic : "file"));
const appsBadge = a => { const s = a.off ? APP_STATUS.off : APP_STATUS[a.status] || APP_STATUS.unknown; return [s[0], s[1]]; };
const appsStatusLine = a => (!a.off && a.status === "unreachable" ? a.reason || "" : "");

function appsHeader(a) {
  const st = a.off ? APP_STATUS.off : APP_STATUS[a.status] || APP_STATUS.unknown;
  const hint = !a.off && a.status !== "unreachable" ? pkHint() : null;   // a phone: a line under the status, the title keeps its width
  return el("header", { class: "apps-hd" },
    appsNarrow() ? null : appsAv(a.icon),
    el("div", { class: "apps-hb" }, appsNarrow() ? null : el("h2", { class: "apps-n", text: a.label }), el("p", { class: "apps-p" }, st[0], a.reason && !a.off ? ` · ${a.reason}` : ""), appsNarrow() ? hint : null),
    appsNarrow() ? null : hint,
    a.off ? null : el("a", { class: "ib", href: a.web.href, target: "_blank", rel: "noopener", "aria-label": TX("apps.open_tab"), title: TX("apps.open_tab") }, icon("open")),
    el("button", { class: "ib", type: "button", "aria-label": TX("apps.menu"), title: TX("apps.menu"), "aria-haspopup": "listbox", "aria-expanded": "false", onclick: ev => appsMenu(ev.currentTarget, a) }, icon("more")));
}
function appsFailHeader(e) {
  return el("header", { class: "apps-hd" },
    appsNarrow() ? null : appsAv("file"),
    el("div", { class: "apps-hb" }, appsNarrow() ? null : el("h2", { class: "apps-n", text: e.id }), el("p", { class: "apps-p", text: TX("apps.status.error") })));
}

const kvRows = (obj) => el("div", { class: "apps-kv" }, ...Object.entries(obj).map(([k, v]) => el("div", { class: "apps-kr" }, el("span", { class: "apps-kk", text: k }), el("span", { class: "apps-kv2", text: String(v) }))));
function appsSettings(a) {
  const body = el("div", { class: "apps-set" },
    kvRows({ [TX("apps.set.address")]: a.web.href, [TX("apps.set.status")]: (APP_STATUS[a.off ? "off" : a.status] || APP_STATUS.unknown)[0] }),
    a.start ? el("div", { class: "apps-block" }, el("div", { class: "apps-kk", text: TX("apps.set.run") }), el("p", { class: "apps-note", text: TX("apps.set.run_note") }), el("pre", { class: "apps-pre", text: [a.start.cwd ? `cd ${a.start.cwd}` : "", `${a.start.env ? Object.entries(a.start.env).map(([k, v]) => `${k}=${v}`).join(" ") + " " : ""}${a.start.command}`].filter(Boolean).join("\n") })) : null,
    a.watches && a.watches.length ? el("div", { class: "apps-block" }, el("div", { class: "apps-kk", text: TX("apps.set.watches") }), el("p", { class: "apps-note", text: a.watches.join(", ") })) : null,
    a.settings && Object.keys(a.settings).length ? el("div", { class: "apps-block" }, el("div", { class: "apps-kk", text: TX("common.settings") }), kvRows(a.settings)) : null);
  dialog({ title: TX("apps.set.title", { label: a.label }), body, mid: true });
}
function appsMenu(anchor, a) {
  const pin = `x:${a.id}`;
  const items = [{ value: "settings", label: TX("common.settings") }, { value: "pin", label: appPinned(pin) ? TX("apps.unpin") : TX("apps.pin") }, { value: "off", label: a.off ? TX("apps.on") : TX("apps.off") }, { value: "remove", label: TX("apps.remove"), danger: true }];
  showMenu(anchor, items, { onPick: v => { if (v === "settings") appsSettings(a); else if (v === "pin") appPinSet(pin, !appPinned(pin)); else if (v === "off") appsToggle(a); else if (v === "remove") appsRemove(a); } });
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
    toast(TX("apps.toast.removed", { label: a.label }));
    appPinSet(`x:${a.id}`, false);
    monSelSet(""); go("monitoring");
    await loadApps();
  } catch (e) { toast(e.message, true); }
}

function appsBody(a) {
  if (a.off) return el("div", { class: "apps-card" }, el("p", { class: "apps-note", text: TX("apps.status.off") }), el("button", { class: "btn tonal sm", type: "button", text: TX("apps.on"), onclick: () => appsToggle(a) }));
  if (a.status === "unreachable") {
    return el("div", { class: "apps-card" },
      el("p", { class: "apps-note", text: a.reason ? TX("apps.body.no_response_why", { label: a.label, reason: a.reason }) : TX("apps.body.no_response", { label: a.label }) }),
      a.start ? el("p", { class: "apps-note", text: TX("apps.body.check_running") }) : null,
      el("button", { class: "btn tonal sm", type: "button", text: TX("apps.recheck"), onclick: () => loadApps() }));
  }
  const frame = el("iframe", { class: "apps-frame", src: a.web.href, title: a.label, referrerpolicy: "same-origin", onload: () => appsFrameCheck(frame, a) });
  return frame;
}
function appsFailBody(e) {
  return el("div", { class: "apps-card apps-err" },
    el("p", { class: "apps-note", text: TX("apps.err.title") }),
    el("p", { class: "apps-note", text: e.reason }),
    el("p", { class: "sup", text: e.dir }),
    el("button", { class: "btn tonal sm", type: "button", text: TX("apps.recheck"), onclick: () => loadApps().then(() => { if (APPS.items.some(a => a.id === e.id)) go("monitoring", `x:${e.id}`); }) }));
}
// The gateway answers a plain-text page ("not found", or why the app did not answer) when the app is not there; an app's own page is never plain text.
// Say that in the app's words, with a way to open it again.
function appsFrameCheck(frame, a) {
  let plain = false;
  try { plain = frame.contentDocument.contentType === "text/plain"; } catch { return; }
  if (!plain) return;
  frame.replaceWith(emptyNode(TX("apps.body.wont_open", { label: a.label }), async () => { await loadApps(); monApp.dataset.key = ""; monDirty(); }));
}

const monApp = el("div", { class: "apps-pane mon-app", id: "mon-app" });
$("#v-monitoring").append(monApp);
function appsMonPaint(sel) {
  const open = sel && sel.tool && !MON.list;
  const a = open ? APPS.items.find(x => `x:${x.id}` === sel.key) : null, bad = open && !a ? APPS.errors.find(x => `xe:${x.id}` === sel.key) : null;
  $("#v-monitoring").classList.toggle("x-on", !!(a || bad));
  if (!a && !bad) return false;
  const key = a ? `${a.id}:${a.off}:${a.status}:${a.reason || ""}` : `e:${bad.id}:${bad.reason}`, hk = JSON.stringify([key, a ? a.label : bad.id, appsNarrow()]);
  if (monApp.dataset.key !== key || !monApp.firstChild) { monApp.dataset.key = key; monApp.dataset.head = hk; clear(monApp).append(a ? appsHeader(a) : appsFailHeader(bad), a ? appsBody(a) : appsFailBody(bad)); }
  else if (monApp.dataset.head !== hk) { monApp.dataset.head = hk; monApp.firstChild.replaceWith(a ? appsHeader(a) : appsFailHeader(bad)); }
  return true;
}
function appsMonItems() {
  const base = { group: MON_GROUP.app, tool: true, notices: [], mails: [], unread: 0, unreplied: 0, at: "" };
  return [
    ...APPS.items.filter(a => appsTool(a)).map(a => ({ ...base, key: `x:${a.id}`, id: a.id, name: a.label, ic: ICONS[a.icon] ? a.icon : "file", hint: appsStatusLine(a), badge: appsBadge(a) })),
    ...APPS.errors.map(e => ({ ...base, key: `xe:${e.id}`, id: e.id, name: e.id, ic: "file", hint: e.reason, badge: [TX("apps.status.error"), "err"] })),
  ];
}

loadApps();
setInterval(() => { if (current === "monitoring" && !document.hidden) loadApps(); }, 30000);
