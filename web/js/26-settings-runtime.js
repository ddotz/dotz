/* ---------- settings: 실행 하네스 (runtime menu + compatibility check; data from /api/runtimes) ---------- */
let RT = null, rtLive = null;
const RT_ICON = { omp: "term", claude: "spark", codex: "code", omo: "braces" };
const RT_ROLE = { orchestrator: TX("common.assistant"), lanes: TX("common.session") };
const RT_RESULT = { ok: [TX("project.res.passed"), "ok"], adapted: [TX("connect.rt.adapted"), "pri"], disabled: [TX("connect.rt.disabled"), ""], unsupported: [TX("connect.rt.unsupported"), "warn"], fail: [TX("home.sys.failed"), "err"] };
async function loadRuntimes(refresh) {
  try { RT = await api(`/api/runtimes${refresh ? "?refresh=1" : ""}`); } catch { return; }
  if (current === "settings" || current === "runtime") renderSettings();
}
function rtSection() {
  if (!RT) return [];
  // Only the running harness is listed (two rows when the assistant and the sessions run on different ones); tapping a row opens the
  // shared menu with the other installed harnesses, and picking one starts the existing compatibility-check + switch flow.
  const others = RT.runtimes.filter(r => r.installed).map(r => ({ value: r.id, label: r.label, sub: [r.version ? `v${r.version}` : "", r.roles.length ? TX("connect.rt.current") : ""].filter(Boolean).join(" · ") || undefined }));
  const rows = RT.runtimes.filter(r => r.roles.length > 0).map(r => {
    const sub = [r.version ? `v${r.version}` : "", r.roles.length === 2 ? TX("settings.fb.in_use") : TX("settings.upd.roles_in_use", { roles: r.roles.map(k => RT_ROLE[k]).join("·") })].filter(Boolean).join(" · ");
    const b = el("button", { class: "li tap", type: "button", "data-runtime": r.id, "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": TX("connect.rt.row_aria", { name: r.label }) },
      el("span", { class: "lead" }, icon(RT_ICON[r.id] || "harness")), el("span", { class: "tx" }, el("div", { class: "hd", text: r.label }), el("div", { class: "sup", text: sub })), icon("drop"));
    b.addEventListener("click", () => showMenu(b, others.filter(o => o.value !== r.id), { onPick: id => rtFlow(RT.runtimes.find(x => x.id === id)) }));
    return b;
  });
  return [el("div", { class: "sec", text: TX("settings.page.runtime") }), el("div", { class: "list" }, ...rows), el("div", { class: "note", text: TX("settings.upd.rt_note") })];
}
function rtBadge(it) {
  const [label, tone] = RT_RESULT[it.result] || [it.result, ""];
  return el("span", { class: `tag ${it.core && it.result !== "ok" && tone === "warn" ? "err" : tone}`, text: label });
}
function rtReportView(r, report) {
  const core = report.items.filter(i => i.core && (i.result === "fail" || i.result === "unsupported"));
  const changed = report.items.filter(i => i.result === "adapted" || i.result === "disabled").length;
  const stale = !!(r.version && report.version !== r.version);
  const sum = !r.hasAdapter ? TX("connect.rt.no_adapter")
    : report.verdict === "blocked" ? TX("connect.rt.blocked", { list: core.map(i => i.label).join(", ") })
    : stale ? TX("connect.rt.stale", { from: report.version || "?", to: r.version })
    : report.verdict === "adjusted" ? TX("connect.rt.adjusted", { n: changed }) : TX("connect.rt.all_ok");
  const meta = `${new Date(report.at).toLocaleString(TX_LOCALE, { dateStyle: "short", timeStyle: "short" })}${report.version ? ` · v${report.version}` : ""}`;
  return el("div", { class: "rt-rep", style: "display:flex;flex-direction:column;gap:var(--sp-2)" },
    el("p", { text: sum }), el("div", { class: "note", text: TX("connect.rt.checked", { meta }) }),
    el("div", { class: "list rt-rows" }, ...report.items.map(i => el("div", { class: "rt-row" },
      el("div", { class: "top" }, el("span", { class: "nm", title: i.label, text: i.label }), i.core ? el("span", { class: "tag", text: TX("connect.rt.core") }) : null, el("span", { class: "sp" }), rtBadge(i)),
      i.note ? el("div", { class: "sup", text: i.note }) : null))));
}
function rtFlow(r) {
  const roles = new Set(["orchestrator", "lanes"]);
  let report = null, st = null, timer = 0, checking = false;
  const box = el("div", { style: "display:flex;flex-direction:column;gap:var(--sp-3)" });
  const err = usErr();
  const d = dialog({ classic: true, title: TX("connect.rt.switch_to", { name: r.label }), body: [box, err], wide: true, onclose: () => { clearInterval(timer); rtLive = null; loadRuntimes(true); } });
  const usable = () => r.hasAdapter && (r.id === "omp" || (r.id === "omo" && r.installed !== false) || (report && report.verdict !== "blocked" && !(r.version && report.version !== r.version)));
  async function pull() {
    try { const x = await api(`/api/runtimes/${r.id}`); report = x.report; st = x.state; } catch { return; }
    if (checking && !(st && st.running)) { checking = false; clearInterval(timer); rtLive = null; }
    paint();
  }
  // The two targets are separate on/off choices (switch rows), not one either/or pick; 바꾸기 needs at least one on.
  const roleBar = () => el("div", { class: "col" }, el("div", { class: "sup", text: TX("connect.rt.applies") }),
    el("div", { class: "list" }, ...Object.entries(RT_ROLE).map(([k, v]) => {
      const flip = () => { roles.has(k) ? roles.delete(k) : roles.add(k); err.textContent = ""; paint(); };
      return el("div", { class: "li tap", "data-role": k, onclick: flip }, el("span", { class: "tx" }, el("div", { class: "hd", text: v })),
        liEnd(el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(roles.has(k)), "aria-label": v, onclick: ev => { ev.stopPropagation(); flip(); } })));
    })),
    roles.size ? null : el("div", { class: "sup", text: TX("connect.rt.need_one") }));
  async function check() {
    try { await api(`/api/runtimes/${r.id}/verify`, "POST", { real: true }); } catch (e) { toast(e.message, true); return; }
    checking = true; st = { running: true, done: 0, total: 0 }; rtLive = pull; clearInterval(timer); timer = setInterval(pull, 1000); paint();
  }
  function paint() {
    clear(box);
    const running = checking || (st && st.running);
    if (r.id !== "omp") {
      if (running) box.append(el("div", {}, el("p", { text: [TX("connect.rt.checking"), st && st.current].filter(Boolean).join(" · ") }), el("div", { class: "bar" }, el("i", { style: `width:${st && st.total ? Math.round((st.done / st.total) * 100) : 4}%` })), el("div", { class: "note", text: st && st.total ? TX("connect.rt.progress", { done: st.done, total: st.total }) : TX("connect.rt.starting") })));
      else if (report) box.append(rtReportView(r, report));
      else if (r.id === "omo" && r.hasAdapter) box.append(el("p", { text: TX("connect.rt.omo_note") }));
      else box.append(el("p", { text: r.hasAdapter ? TX("connect.rt.check_note") : TX("connect.rt.no_adapter_check") }));
    } else box.append(el("p", { text: TX("connect.rt.omp_note") }));
    if (r.hasAdapter) box.append(roleBar());
    const acts = [{ label: TX("common.cancel"), onclick: c => c() }];
    if (r.id !== "omp" && !running) acts.push({ label: report ? TX("connect.rt.recheck") : TX("connect.rt.run_check"), kind: report ? "text" : "tonal", onclick: () => check() });
    acts.push({ label: TX("connect.rt.switch"), kind: "pri", disabled: running || !usable() || !roles.size, onclick: (c, btn) => usRun(btn, err, async () => {
      try { const res = await api(`/api/runtimes/${r.id}/use`, "POST", { roles: [...roles] }); toast(res.applies); c(); }
      catch (e) { await pull(); throw e; } }) });
    d.setActions(acts);
  }
  pull().then(() => { if (st && st.running) { checking = true; rtLive = pull; timer = setInterval(pull, 1000); paint(); } });
  paint();
}
