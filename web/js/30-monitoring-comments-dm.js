/* ---------- 모니터링 > 앱 > 인스타그램 > DM: the conversation list and its messages, read only ---------- */
// API: docs/ig-dm-api.md. It draws into the comment pane (30-monitoring-comments.js: cmRooms / cmHead / cmIn) when its DM tab is chosen and reuses
// the KakaoTalk pane's classes (30-kakao.js, 17-kakao.css). This file sorts before the comment file, so it only touches CM / cm* inside functions.
// There is no composer and no send: a DM is never answered from here. Text only goes through el({text}), never innerHTML.
const DM_APP = "instagram";
const DM = { on: false, connected: false, perm: "unknown", line: "", convs: [], loaded: false, error: "", open: null, view: null, loading: false, viewErr: "", seq: 0, busy: false };

async function dmLoadList() {
  try {
    const r = await api("/api/ig-dm");
    Object.assign(DM, { on: r.on === true, connected: r.connected === true, perm: r.perm || "unknown", line: r.line || "", convs: Array.isArray(r.convs) ? r.convs : [], loaded: true, error: "" });
  } catch { DM.error = "DM 목록을 불러오지 못했어요"; }
}
// Asks the gateway to read the Instagram API once (only the conversations that moved are fetched), then shows the stored list.
async function dmRefresh() {
  if (DM.busy) return;
  DM.busy = true; if (CM.vis && CM.tab === "dm") dmPaintRooms();
  try { await api("/api/ig-dm/refresh", "POST", {}); DM.error = ""; }
  catch (e) { DM.error = e.message || "DM을 불러오지 못했어요"; }
  await dmLoadList();
  DM.busy = false;
  if (CM.vis && CM.tab === "dm") { dmPaintRooms(); if (DM.open) dmReload(DM.seq); }
}
function dmRow(c) {
  const on = DM.open && DM.open.id === c.id;
  return el("button", { class: `cv-row pv kk-row${on ? " on" : ""}`, type: "button", "data-conv": c.id, "aria-current": on ? "true" : null, onclick: () => dmOpen(c) },
    kkAvatar(c.peer),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", title: c.peer, text: c.peer }), el("span", { class: "cv-p", text: c.last })),
    el("span", { class: "cv-m" }, el("span", { class: "kk-t", text: kkListTime(c.lastAt) })));
}
function dmPaintRooms() {
  if (!CM.vis) return;
  const top = cmRooms.scrollTop, tabs = cmTabs();
  const bar = el("div", { class: "dm-bar" }, el("span", { class: "dm-note", text: "받은 DM을 읽기만 해요. 답장은 보내지 않아요" }),
    el("button", { class: "btn text", type: "button", id: "dm-refresh", disabled: DM.busy, text: DM.busy ? "불러오는 중…" : "새로고침", onclick: dmRefresh }));
  const list = el("section", { class: "kk-watch", "aria-label": "DM 대화" });
  list.append(el("div", { class: "cv-gh", role: "presentation", text: "대화" }));
  if (DM.perm === "missing") list.append(el("div", { class: "kk-note", id: "dm-perm", role: "status", text: DM.line }));
  else if (DM.error) list.append(el("div", { class: "kk-note", role: "status", text: DM.error }));
  if (DM.convs.length) list.append(...DM.convs.map(dmRow));
  else if (DM.loaded && DM.perm !== "missing") list.append(el("div", { class: "kk-note", id: "dm-empty", text: "아직 받은 DM이 없어요" }));
  clear(cmRooms).append(...(tabs ? [tabs] : []), bar, list);
  cmRooms.scrollTop = top;
}
async function dmOpen(c) {
  const seq = ++DM.seq;
  DM.open = { id: c.id, peer: c.peer }; DM.view = null; DM.loading = true; DM.viewErr = "";
  cmPaintAll();
  await dmReload(seq, true);
}
async function dmReload(seq = DM.seq, scroll = false) {
  const o = DM.open;
  if (!o) return;
  try {
    const v = await api(`/api/ig-dm/${enc(o.id)}`);
    if (seq !== DM.seq) return;
    DM.view = v; DM.loading = false; DM.viewErr = "";
  } catch (e) {
    if (seq !== DM.seq) return;
    DM.loading = false; DM.viewErr = e.message || "DM을 불러오지 못했어요";
  }
  dmPaintChat(scroll);
}
function dmClose() { DM.open = null; DM.view = null; DM.seq++; DM.loading = false; cmPaintAll(); convTitle(); }
const DM_ATTACH = { image: "(사진)", video: "(동영상)", audio: "(음성 메시지)", file: "(파일)" };
const dmText = m => m.text || (m.attach && m.attach.length ? DM_ATTACH[m.attach[0]] || "(파일)" : "(내용 없음)");
function dmMsgNode(m, peer, first) {
  const bub = el("div", { class: "kk-bub" }, el("span", { text: dmText(m) }));
  if (m.mine) return el("div", { class: `kk-m me${first ? " first" : ""}`, "data-id": m.id }, el("div", { class: "kk-line" }, el("span", { class: "kk-time", text: kkTime(m.at) }), bub));
  return el("div", { class: `kk-m in${first ? " first" : ""}`, "data-id": m.id }, first ? kkAvatar(peer) : el("span", { class: "kk-av sp", "aria-hidden": "true" }),
    el("div", { class: "kk-mb" }, first ? el("div", { class: "kk-name", text: peer }) : null, el("div", { class: "kk-line" }, bub, el("span", { class: "kk-time", text: kkTime(m.at) }))));
}
function dmPaintChat(stick) {
  const open = DM.open, v = DM.view;
  cmFoot.hidden = true;
  const sig = open ? `dm/${open.id}/${open.peer}` : "";
  if (sig !== CM.headSig) {
    CM.headSig = sig; clear(cmHead);
    if (open) cmHead.append(kkAvatar(open.peer), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: open.peer }), el("span", { class: "cv-p", text: "받은 DM · 읽기만 해요" })));
  }
  if (!open) { clear(cmIn).append(el("div", { class: "kk-note", text: "대화를 골라 주세요" })); return; }
  if (DM.loading) { clear(cmIn).append(el("div", { class: "kk-note", text: "불러오는 중…" })); return; }
  if (DM.viewErr || !v) { clear(cmIn).append(el("div", { class: "kk-note", role: "status", text: DM.viewErr })); return; }
  const nodes = []; let prev = null;
  for (const m of v.messages) {
    if (!prev || kkDay(prev.at) !== kkDay(m.at)) nodes.push(el("div", { class: "kk-date", text: kkDate(m.at) }));
    nodes.push(dmMsgNode(m, v.peer, !prev || prev.mine !== m.mine || kkDay(prev.at) !== kkDay(m.at)));
    prev = m;
  }
  if (!nodes.length) nodes.push(el("div", { class: "kk-note", text: "메시지가 없어요" }));
  const keep = cmTl.scrollTop;
  clear(cmIn).append(...nodes);
  cmTl.scrollTop = stick ? cmTl.scrollHeight : keep;
}
