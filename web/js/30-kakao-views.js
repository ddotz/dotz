// The pills of the watched rooms, the same format as the mail, project and 댓글 ones: which rooms the list shows. [key, label, keep, the empty list's line].
const KK_VIEWS = [["all", TX("apps.kk.view.all"), () => true, ""], ["unread", TX("common.unread"), r => r.unread, TX("apps.kk.view.no_unread")], ["unreplied", TX("apps.unreplied"), r => r.unreplied, TX("apps.kk.view.no_unreplied")]];
const kkViewOf = () => KK_VIEWS.find(v => v[0] === KK.view) || KK_VIEWS[0];
function kkViewBar(watched) {
  return segKeep(el("div", { class: "mr-filter kk-views", role: "tablist", "aria-label": TX("apps.kk.view_aria") }, ...KK_VIEWS.map(([k, label, ok]) => {
    const on = k === kkViewOf()[0];
    return el("button", { class: `cchip mr-f${on ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(on), "data-view": k, onclick: () => { KK.view = k; kkPaintRooms(); } }, label, cntSpan(`kk-view:${k}`, "mr-fn", watched.filter(ok).length));
  })));
}
