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
  try { localStorage.setItem(PANE_LAYOUTS, JSON.stringify(all)); } catch { toast("배치를 저장하지 못했어요", true); }
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
  if (!r) { toast("이 배치는 열 수 없어요", true); return; }
  paneMirrorsClear();
  PN = { ...r, seq: Math.max(PN.seq, r.seq) };
  paneEnter(paneFind(PN.active));
  panePersist();
}
function paneLayoutAsk() {
  const inp = input({ type: "text", maxlength: "24", placeholder: "예: 메일 보면서 작업", "aria-label": "배치 이름" });
  const err = usErr();
  const save = close => {
    const name = inp.value.trim();
    paneLayoutSave(name);
    close();
    toast(`'${name}' 배치를 저장했어요`);
  };
  const d = dialog({ classic: true, title: "배치 저장", body: el("div", { class: "col" }, el("div", { class: "sup", text: "같은 이름이 있으면 덮어써요." }), inp, err), actions: [{ label: "저장", kind: "pri", onclick: c => save(c) }] });
  usDirty(d, [inp]);
  inp.addEventListener("input", () => { err.textContent = inp.value.trim() ? "" : "이름을 적어 주세요."; });
  inp.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); d.node.querySelector(".dact .btn:last-child").click(); } });
  inp.focus();
}
// Rows for the command palette; v is the lower-cased query.
function paneLayoutItems(v) {
  if (narrowChat()) return [];
  const names = Object.keys(paneLayouts()), has = s => !v || s.toLowerCase().includes(v), row = (label, act) => ({ kind: "act", ic: "lanes", label, act });
  return [
    ...(paneCount() > 1 && has("배치 저장") ? [row("배치 저장", paneLayoutAsk)] : []),
    ...names.filter(n => has(`배치: ${n}`)).map(n => row(`배치: ${n}`, () => paneLayoutApply(n))),
    ...names.filter(n => has(`배치 지우기: ${n}`)).map(n => row(`배치 지우기: ${n}`, () => { paneLayoutDrop(n); toast(`'${n}' 배치를 지웠어요`); })),
  ];
}
