/* ---------- 분할 창: named layouts (docs/split-panes.md 배치) ----------
   localStorage dotz-pane-layouts = { name: {root, active} }, kept from the command palette: 배치 저장 (only while split), 배치: <name>, 배치 지우기: <name>. */
const PANE_LAYOUTS = "dotz-pane-layouts";

function paneLayouts() {
  try {
    const d = JSON.parse(localStorage.getItem(PANE_LAYOUTS) || "{}");
    return Object.assign(Object.create(null), d && typeof d === "object" && !Array.isArray(d) ? d : {});
  } catch { return Object.create(null); }
}
function paneLayoutPut(all) {
  try { localStorage.setItem(PANE_LAYOUTS, JSON.stringify(all)); } catch { toast(TX("misc.pl.save_failed"), true); }
}
function paneLayoutSave(name) {
  const all = paneLayouts();
  all[name] = { root: JSON.parse(JSON.stringify(PN.root)), active: PN.active };
  paneLayoutPut(all);
}
function paneLayoutDrop(name) {
  const all = paneLayouts();
  delete all[name];
  paneLayoutPut(all);
}
// The saved tree replaces the panes; the page goes to the layout's active pane. Mirrors are dropped: ids of another layout mean other panes.
function paneLayoutApply(name) {
  const r = panePrune(paneLayouts()[name]);
  if (!r) { toast(TX("misc.pl.cant_open"), true); return; }
  paneMirrorsClear();
  PN = { ...r, seq: Math.max(PN.seq, r.seq) };
  paneEnter(paneFind(PN.active));
  panePersist();
}
function paneLayoutAsk() {
  const inp = input({ type: "text", maxlength: "24", placeholder: TX("misc.pl.ph"), "aria-label": TX("misc.pl.name") });
  const err = usErr();
  const save = close => {
    const name = inp.value.trim();
    paneLayoutSave(name);
    close();
    toast(TX("misc.pl.saved", { name }));
  };
  const d = dialog({ classic: true, title: TX("misc.pl.save"), body: el("div", { class: "col" }, el("div", { class: "sup", text: TX("misc.pl.overwrite") }), inp, err), actions: [{ label: TX("common.save"), kind: "pri", onclick: c => save(c) }] });
  usDirty(d, [inp]);
  inp.addEventListener("input", () => { err.textContent = inp.value.trim() ? "" : TX("misc.pl.need_name"); });
  inp.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); d.node.querySelector(".dact .btn:last-child").click(); } });
  inp.focus();
}
// Rows for the command palette; v is the lower-cased query.
function paneLayoutItems(v) {
  if (narrowChat()) return [];
  const names = Object.keys(paneLayouts()), has = s => !v || s.toLowerCase().includes(v), row = (label, act) => ({ kind: "act", ic: "lanes", label, act });
  return [
    ...(paneCount() > 1 && has(TX("misc.pl.save")) ? [row(TX("misc.pl.save"), paneLayoutAsk)] : []),
    ...names.filter(n => has(TX("misc.pl.open", { name: n }))).map(n => row(TX("misc.pl.open", { name: n }), () => paneLayoutApply(n))),
    ...names.filter(n => has(TX("misc.pl.drop", { name: n }))).map(n => row(TX("misc.pl.drop", { name: n }), () => { paneLayoutDrop(n); toast(TX("misc.pl.dropped", { name: n })); })),
  ];
}
