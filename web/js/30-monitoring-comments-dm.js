/* ---------- 모니터링 > 앱 > 인스타그램 > DM: the conversation list and its messages, read only ---------- */
// API: docs/ig-dm-api.md. It draws into the comment pane (30-monitoring-comments.js: cmRooms / cmHead / cmIn) when its DM tab is chosen and reuses
// the KakaoTalk pane's classes (30-kakao.js, 17-kakao.css). This file sorts before the comment file, so it only touches CM / cm* inside functions.
// There is no composer and no send: a DM is never answered from here (one read-only line at the bottom, the KakaoTalk room's .kk-ro). Text only goes through el({text}), never innerHTML.
const DM_APP = "instagram";
// The one line at the bottom of an open DM, where the KakaoTalk room has its composer; it is put in place on the first paint (the comment pane is built after this file).
const dmRo = el("div", { class: "kk-ro", id: "dm-ro", role: "status", hidden: true }, el("span", { class: "kk-ro-t", text: TX("mon.dm.ro") }));
const DM = { on: false, connected: false, perm: "unknown", line: "", convs: [], loaded: false, error: "", open: null, view: null, loading: false, viewErr: "", seq: 0, busy: false };

async function dmLoadList() {
  try {
    const r = await api("/api/ig-dm");
    Object.assign(DM, { on: r.on === true, connected: r.connected === true, perm: r.perm || "unknown", line: r.line || "", convs: Array.isArray(r.convs) ? r.convs : [], loaded: true, error: "" });
  } catch { DM.error = TX("mon.dm.list_fail"); }
}
// Asks the gateway to read the Instagram API once (only the conversations that moved are fetched), then shows the stored list.
async function dmRefresh() {
  if (DM.busy) return;
  DM.busy = true; if (CM.vis && CM.tab === "dm") dmPaintRooms();
  try { await api("/api/ig-dm/refresh", "POST", {}); DM.error = ""; }
  catch (e) { DM.error = appFail(e, TX("mon.dm.fail")); }
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
  const sig = JSON.stringify(["dm", DM.perm, DM.line, DM.error, DM.convs, DM.loaded, DM.busy, DM.open && DM.open.id, !!tabs]);
  if (sig === CM.roomsSig) return;
  CM.roomsSig = sig;
  const bar = el("div", { class: "dm-bar" }, el("span", { class: "dm-note", text: TX("mon.dm.ro") }),
    el("button", { class: "btn text", type: "button", id: "dm-refresh", disabled: DM.busy, text: DM.busy ? TX("common.loading") : TX("settings.refresh"), onclick: dmRefresh }));
  const list = el("section", { class: "kk-watch", "aria-label": TX("mon.dm.aria") });
  list.append(el("div", { class: "cv-gh", role: "presentation", text: TX("common.conversation") }));
  if (DM.perm === "missing") list.append(el("div", { class: "kk-note", id: "dm-perm", role: "status", text: DM.line }));
  else if (DM.error) list.append(el("div", { class: "kk-note", role: "status", text: DM.error }));
  if (DM.convs.length) list.append(...DM.convs.map(dmRow));
  else if (DM.loaded && DM.perm !== "missing") list.append(el("div", { class: "kk-note", id: "dm-empty", text: TX("mon.dm.empty") }));
  clear(cmRooms).append(...(tabs ? [tabs] : []), bar, list);
  cmRooms.scrollTop = top;
}
async function dmOpen(c) {
  const seq = ++DM.seq;
  DM.open = { id: c.id, peer: c.peer }; DM.view = null; DM.loading = true; DM.viewErr = "";
  cmPaintAll(); convTitle(); bkCmSync();
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
    DM.loading = false; DM.viewErr = appFail(e, TX("mon.dm.fail"));
  }
  dmPaintChat(scroll);
}
function dmClose() { DM.open = null; DM.view = null; DM.seq++; DM.loading = false; cmPaintAll(); convTitle(); bkCmSync(); }
const DM_ATTACH = { image: TX("mon.dm.image"), video: TX("mon.dm.video"), audio: TX("mon.dm.audio"), file: TX("mon.dm.file") };
const dmText = m => m.text || (m.attach && m.attach.length ? DM_ATTACH[m.attach[0]] || TX("mon.dm.file") : TX("mon.dm.blank"));
// A DM message in the shape of a KakaoTalk one, so the room's own renderer draws it (30-kakao.js kkMsgNode: bubbles, the time under a run, the date line).
const dmAsKk = (m, peer) => ({ logId: m.id, fromMe: !!m.mine, sender: peer, type: 1, text: dmText(m), sentAt: new Date(m.at).getTime(), group: false });
function dmPaintChat(stick) {
  const open = DM.open, v = DM.view;
  cmFoot.hidden = true;
  if (!dmRo.isConnected) cmChat.insertBefore(dmRo, cmFoot);
  dmRo.hidden = !open;
  const sig = open ? `dm/${open.id}/${open.peer}` : "";
  if (sig !== CM.headSig) {
    CM.headSig = sig; clear(cmHead);
    if (open) cmHead.append(kkAvatar(open.peer), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: open.peer })));
  }
  const csig = JSON.stringify(["dm", open, DM.loading, DM.viewErr, v]);
  if (!stick && csig === CM.chatSig) return;
  CM.chatSig = csig;
  if (!open) { clear(cmIn).append(el("div", { class: "kk-note", text: TX("mon.dm.pick") })); return; }
  if (DM.loading) { clear(cmIn).append(el("div", { class: "kk-note", text: TX("common.loading") })); return; }
  if (DM.viewErr || !v) { clear(cmIn).append(el("div", { class: "kk-note", role: "status", text: DM.viewErr }), appRetry(() => { DM.loading = true; DM.viewErr = ""; cmPaintChat(false); dmReload(); })); return; }
  const nodes = [], msgs = v.messages.map(m => dmAsKk(m, v.peer));
  msgs.forEach((m, i) => {
    const prev = msgs[i - 1], next = msgs[i + 1], newDay = !prev || kkDay(prev.sentAt) !== kkDay(m.sentAt);
    if (newDay) nodes.push(kkDateNode(m.sentAt));
    nodes.push(kkMsgNode(m, newDay || kkWho(prev) !== kkWho(m), !(next && kkDay(next.sentAt) === kkDay(m.sentAt) && kkSame(m, next))));
  });
  if (!nodes.length) nodes.push(el("div", { class: "kk-note", text: TX("mon.dm.no_msgs") }));
  const keep = cmTl.scrollTop;
  clear(cmIn).append(...nodes);
  cmTl.scrollTop = stick ? cmTl.scrollHeight : keep;
}
