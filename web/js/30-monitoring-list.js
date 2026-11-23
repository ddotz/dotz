const MONL = { fold: new Set() };
const APP_PINS = "dotz-app-pins";
const appPins = () => { const l = lsJson(APP_PINS, []); return Array.isArray(l) ? l.filter(k => typeof k === "string") : []; };
const appPinned = k => appPins().includes(k);
function appPinSet(k, on) {
  const rest = appPins().filter(x => x !== k);
  lsSet(APP_PINS, JSON.stringify(on ? [...rest, k] : rest));
  monDirty(true);
}
const appBusy = it => (it.drafts | 0) + (it.unread | 0) + (it.unreplied | 0) > 0;
function appsOrder(apps) {
  const pins = appPins(), at = k => { const i = pins.indexOf(k); return i < 0 ? pins.length : i; };
  return apps.slice().sort((a, b) => at(a.key) - at(b.key) || appBusy(b) - appBusy(a) || String(a.name).localeCompare(String(b.name), TX_LOCALE));
}

const monFine = (m, now) => { const k = monStatus(m, now).key; return k === "ok" || k === "off" || k === "wait"; };
const monCalm = (i, now) => !!i.mon && !i.hostOff && monFine(i.mon, now);
function monFineSum(calm, now) {
  const off = calm.filter(i => i.mon.paused).length, latest = Math.max(0, ...calm.map(i => Date.parse(i.mon.last_run) || 0));
  return [off ? TX("mon.ov.sum_off", { n: calm.length - off, off }) : TX("mon.ov.all_ok"), latest ? TX("mon.ov.last", { t: monRel(now - latest, true) }) : ""].filter(Boolean).join(" · ");
}
function monFoldSet(g, on) { if (on) MONL.fold.add(g); else MONL.fold.delete(g); monDirty(true); }

function monRows(items, sel) {
  const now = Date.now(), on = it => !!sel && it.key === sel.key && !MON.list;
  const row = it => ({ k: it.key, name: it.name, av: monIcon(it.ic), hint: it.hint, unread: it.unread, unreplied: it.unreplied | 0, badge: it.badge || null, chips: it.chips, sel: on(it), open: () => go("monitoring", monRowGo(it)) });
  const rq = items.find(i => i.rq), feed = items.find(i => i.key === "notice"), mons = items.filter(i => i.mon || i.off);
  const apps = [...items.filter(i => i.group === MON_GROUP.app).map(row), { k: "add-app", name: TX("mon.manage_apps"), av: monIcon("add"), hint: asAddHint(), sel: false, open: () => asAddSheet() }];
  apps[0].split = true;
  const pcOf = i => (i.pc ? i.pc.url : "");
  const group = g => {
    const list = mons.filter(i => i.group === g), picked = i => !!sel && i.key === sel.key, calm = list.filter(i => monCalm(i, now) && !picked(i));
    return [...list.filter(i => !calm.includes(i)).map(row), ...[...new Set(calm.map(pcOf))].flatMap(pc => {
      const mine = calm.filter(i => pcOf(i) === pc), k = pc ? `fold:${g}|${pc}` : `fold:${g}`, open = MONL.fold.has(k);
      const where = pc ? TX("misc.pq.runs_on", { name: mine[0].pc.name }) : "";
      return [{ k, fold: true, expanded: open, name: monFineSum(mine, now), hint: [where, TX("mon.ov.count", { n: mine.length })].filter(Boolean).join(" · "), av: monIcon("check"), sel: false, open: () => monFoldSet(k, !open) }, ...(open ? mine.map(row) : [])];
    })];
  };
  const projects = [...new Set(mons.map(i => i.group))].filter(g => g !== MON_GROUP.plain);
  return [...(rq ? [row(rq)] : []), ...apps,
    { header: TX("common.monitoring"), k: "notice", sel: !!feed && on(feed), open: () => go("monitoring", "notice") },
    ...group(MON_GROUP.plain),
    ...(feed && feed.notices.length ? [{ ...row(feed), name: TX("mon.other_log") }] : []),
    ...(NM.loaded ? [] : [{ k: "state", state: NM.failed ? "failed" : "loading", hint: NM.failed ? TX("mon.load_failed") : TX("common.loading") }]),
    ...projects.flatMap(g => [{ header: g }, ...group(g)])];
}
const monSecBtn = r => el("button", { class: `mon-sec mon-sec-go${r.sel ? " on" : ""}`, type: "button", "data-k": r.k, "aria-current": r.sel ? "true" : null, onclick: r.open }, el("span", { class: "mon-sec-t", text: r.header }));
