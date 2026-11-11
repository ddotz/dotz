/* ---------- settings: the short list and its sub-pages (prototype #settings and #settings/<page>) ---------- */
// 설정 is a short list of links in four groups; 앱과 알림, 표시, 업데이트 and 실행 하네스 are pages of their own. 04-state.js and
// 05-command-palette.js know the older views by name, so the pages join them here (the view list, the sub-screen set that keeps
// the 설정 tab lit and sends 뒤로 to 설정, the title and icon, the empty section) and go() loads their data on entry.
const SET_PAGE = {
  notifications: { title: TX("settings.page.notifications"), ic: "bell", build: () => pushSection() },
  display: { title: TX("settings.page.display"), ic: "settings", build: () => displayPage() },
  update: { title: TX("settings.page.update"), ic: "download", build: () => updateSection() },
  runtime: { title: TX("settings.page.runtime"), ic: "term", build: () => { const s = hvSection(); return s.length ? s : [emptyNode(UPD.info && UPD.info.error ? TX("settings.runtime.check_failed") : TX("settings.runtime.checking"))]; } },
};
for (const [id, p] of Object.entries(SET_PAGE)) {
  views.push(id); SUB.add(id); titles[id] = p.title; VIEW_ICON[id] = p.ic;
  $("#views").append(el("section", { class: "view", id: `v-${id}`, hidden: "" }, el("div", { id, class: "st-page" })));
}
const inSettings = () => current === "settings" || Object.hasOwn(SET_PAGE, current);
const goBeforeSettingPages = go;
go = function (name, tgt) {
  goBeforeSettingPages(name, tgt);
  if (current === "settings" && !ACC) loadAccounts();
  if (!Object.hasOwn(SET_PAGE, current)) return;
  if (current === "update" || current === "runtime") loadUpdate();
  if (current === "runtime") loadRuntimes();
  renderSettings();
};

/* ---------- the rows these pages share ---------- */
const stSec = title => el("div", { class: "sec", text: title });
const stList = (...rows) => el("div", { class: "list" }, ...rows.filter(Boolean));
// One link row: lead icon, a title with its one-line description, then the right slot (a status tag) and the chevron.
const stRow = (ic, title, sub, onclick, trail) => el("button", { class: "li tap", type: "button", onclick: ev => onclick(ev.currentTarget) },
  el("span", { class: "lead" }, icon(ic)),
  el("span", { class: "tx" }, el("div", { class: "hd", text: title }), sub ? el("div", { class: "sup", text: sub }) : null),
  trail === null ? null : el("span", { class: "li-end" }, trail === undefined ? null : trail, icon("chev", "chev")));
// A setting with exactly two values keeps its one right-hand control: the two-value pill (docs/ui-spec.md 두 값 설정), not a tag beside a chevron.
const stToggle = (ic, title, sub, label, opts, value, onPick) => el("div", { class: "li" },
  el("span", { class: "lead" }, icon(ic)),
  el("span", { class: "tx" }, el("div", { class: "hd", text: title }), sub ? el("div", { class: "sup", text: sub }) : null),
  liEnd(rowToggle({ label, opts, value, onPick: (v, btn) => onPick(v, btn) })));
const stTag = (text, tone = "warn") => el("span", { class: `tag ${tone}${tone === "warn" ? " upd-new" : ""}`, text });

/* ---------- one-line summaries under the link rows ---------- */
function stUsageSub() {
  const q = typeof SQ !== "undefined" && SQ ? SQ : null;
  const lims = q ? (q.providers || []).flatMap(p => (p.limits || []).filter(l => !l.scope).map(l => ({ l, f: limitFrac(l) }))).filter(x => x.f != null) : [];
  const low = lims.sort((a, b) => a.f - b.f)[0];
  return [low ? `${limitName(low.l)} ${pctText(low.l)}` : "", budgetSub()].filter(Boolean).join(" · ");
}
function stAccountSub() {
  const a = ACC && ACC.accounts ? ACC.accounts.find(x => x.current) : null;
  return a ? TX("settings.row.account_in_use", { name: a.label || a.alias || a.name }) : "";
}
const stUpdShort = v => (v && v.commit ? (v.release ? `v${v.release}` : v.commit.short) : "");
function stUpdateSub() {
  const i = UPD.info;
  if (!i) return "";
  if (i.error) return i.error;
  if (updRestartPending()) return TX("settings.row.update_restart", { version: stUpdShort(i.disk) });
  const c = updState(i).c;
  return TX(c && c.ok && !updAvailable() ? "settings.row.update_latest" : "settings.row.update_now", { version: stUpdShort(i.running) || TX("settings.unknown") });
}
// The main conversation's context share, from the figure the page already holds (no request); empty until it is loaded.
function stContextSub() {
  const p = typeof C !== "undefined" && C ? ctxSession(MAIN) : null;
  return p && p.running && p.percent != null ? TX("settings.row.context_used", { pct: Math.round(p.percent) }) : "";
}
function stRuntimeSub() {
  const names = [...new Set(hvRt().filter(r => (r.roles || []).length).map(r => r.label))];
  return names.join(" · ");
}
function stPushSub() {
  if (PWA.gw && PWA.gw.app) { const on = PWA.gw.gateways.filter(g => g.on).length; return on ? TX("settings.row.push_on") : TX("settings.row.push_off"); }
  if (PWA.sub && PWA.info && PWA.info.subscribed) return TX("settings.row.push_on");
  return pushCapable() ? TX("settings.row.push_off") : TX("settings.row.push_unsupported");
}

/* ---------- 설정 (the list) ---------- */
// The first screen's groups (a .sec title + its .list) go into two .set-col boxes: 앱 and 시스템 on the right, every other group on the left. One column on a narrow window (18-app-settings.css).
function settingsCols(nodes) {
  const left = el("div", { class: "set-col" }), right = el("div", { class: "set-col" });
  let col = left;
  for (const n of nodes) {
    if (n.classList.contains("sec")) col = n.textContent === TX("common.apps") || n.textContent === TX("settings.sec.system") ? right : left;
    col.append(n);
  }
  return [left, right];
}
function settingsList(go) {
  const om = M && M.orchestrator;
  const connected = P ? P.providers.filter(isConnected).length : null;
  const nodes = [
    stSec(TX("settings.sec.accounts_models")), stList(
      stRow("key", TX("common.accounts"), [stAccountSub(), connected != null ? TX("settings.prov.connected_n", { n: connected }) : ""].filter(Boolean).join(" · "), () => go("accounts")),
      stRow("model", TX("common.model"), om ? [modelName(om.model), thinkKo(om.thinking)].filter(Boolean).join(" · ") : "", () => openModels("orchestrator")),
      stRow("usage", TX("settings.row.usage"), stUsageSub(), () => go("usage")),
      stRow("context", TX("common.context"), stContextSub(), () => go("context"))),
    stSec(TX("settings.sec.connect")), stList(
      msHubRow(),
      webAccessRow(stRow),
      devicesRow(stRow),
      mnRow()),
    ...dskSettings(),
    stSec(TX("common.apps")), stList(
      stRow("bell", TX("settings.page.notifications"), stPushSub(), () => go("notifications")),
      navOff("apps") ? null : stRow("apps", TX("settings.row.apps"), "", () => go("apps")),
      stRow("spark", TX("settings.row.intro"), "", () => introOpen()),
      stRow(themeIc(), TX("settings.page.display"), [themeIs() === "dark" ? TX("settings.theme.dark") : TX("settings.theme.light"), chatTabMode() === "main" ? TX("settings.row.chat_tab_main") : TX("settings.row.chat_tab_last")].join(" · "), () => go("display"))),
    stSec(TX("settings.sec.system")), stList(
      stRow("download", TX("settings.page.update"), stUpdateSub(), () => go("update"), updRestartPending() ? stTag(TX("settings.tag.restart_needed")) : updAvailable() ? stTag(TX("settings.tag.new_version")) : undefined),
      stRow("term", TX("settings.page.runtime"), stRuntimeSub(), () => go("runtime"), hvNew() ? stTag(TX("settings.tag.new_version")) : undefined),
      stRow("harness", TX("common.system"), "", () => go("harness"))),
  ];
  return nodes;
}

/* ---------- 표시 ---------- */
function displayPage() {
  return [stList(
    stToggle(themeIc(), TX("settings.display.mode"), "", TX("settings.display.mode"), [["light", TX("settings.theme.light")], ["dark", TX("settings.theme.dark")]], themeIs(), v => { if (v !== themeIs()) toggleTheme(); renderSettings(); }),
    stToggle("chat", TX("settings.display.chat_tab"), chatTabMode() === "main" ? TX("settings.display.chat_main") : TX("settings.display.chat_last"), TX("settings.display.chat_tab"), [["main", TX("settings.display.opt_main")], ["last", TX("settings.display.opt_last")]], chatTabMode(), v => { chatTabModeSet(v); renderSettings(); })),
    stSec(TX("settings.sec.diagnostics")), stList(...kbdRows())];
}
