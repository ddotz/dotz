const DCG = new Map();
function dcGoneFail(n, err, opt, note) {
  if (!n || n.pc || !err || !err.data || err.data.code !== "session_ended") return false;
  DCG.set(String(n.id), { n: opt ? opt.n : undefined, note: note || "", label: opt ? `${opt.n}) ${unnumbered(opt.label)}${note ? ` - ${note}` : ""}` : note || "" });
  return true;
}
const dcGoneKey = () => [...DCG].map(([id, g]) => id + (g.busy ? "!" : "")).join();
const dcGoneNotice = dc => { for (const id of DCG.keys()) { const n = ntById(id); if (n && ntOpenDec(n) && n.decision.to === dc.t && (!dc.at || n.decision.reply_to === dc.at)) return n; } return null; };
async function dcHandoff(n) {
  const id = String(n.id), g = DCG.get(id);
  if (!g || g.busy) return;
  g.busy = true; ntSheetPaint(); paintDecision();
  try {
    const r = await api(`/api/notices/${enc(id)}/answer`, "POST", { ...(g.n === undefined ? {} : { n: g.n }), ...(g.note ? { note: g.note } : {}), handoff: "main" });
    DCG.delete(id);
    ntApply(r.item, r.unread);
    toast(TX("decision.gone_sent"));
  } catch (e) { g.busy = false; toast(e instanceof TypeError ? TX("decision.err.offline_act") : e.message, true); }
  ntSheetPaint(); paintDecision();
}
function dcGoneNodes(n, dock) {
  const g = DCG.get(String(n.id));
  if (!g) return [];
  const say = el("div", { class: "dc-gone", role: "status", "data-k": "gone", text: TX("decision.gone_fail") });
  if (dock) return [say, el("button", { class: "btn dc-send", type: "button", "data-k": "main", disabled: !!g.busy, onclick: () => dcHandoff(n) }, TX("decision.gone_main"))];
  return [say, el("button", { type: "button", class: "ds-opt rec", "data-k": "main", disabled: !!g.busy, onclick: () => dcHandoff(n) }, el("span", { class: "ds-lb" }, TX("decision.gone_main")), g.label ? el("span", { class: "ds-ds", text: g.label }) : null)];
}
