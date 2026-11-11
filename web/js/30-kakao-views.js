// The pills of the watched rooms, the same format as the mail, project and 댓글 ones: which rooms the list shows. [key, label, keep, the empty list's line].
const KK_VIEWS = [["all", "전체", () => true, ""], ["unread", "안 읽음", r => r.unread, "안 읽은 대화방이 없어요"], ["unreplied", "미답장", r => r.unreplied, "미답장 대화방이 없어요"]];
const kkViewOf = () => KK_VIEWS.find(v => v[0] === KK.view) || KK_VIEWS[0];
function kkViewBar(watched) {
  return segKeep(el("div", { class: "mr-filter kk-views", role: "tablist", "aria-label": "지켜보는 대화방 보기" }, ...KK_VIEWS.map(([k, label, ok]) => {
    const on = k === kkViewOf()[0];
    return el("button", { class: `cchip mr-f${on ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(on), "data-view": k, onclick: () => { KK.view = k; kkPaintRooms(); } }, label, cntSpan(`kk-view:${k}`, "mr-fn", watched.filter(ok).length));
  })));
}
