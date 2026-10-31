/* ---------- home: every status at a glance, each card navigates ---------- */
let HQ = null, homeTimer;
async function loadHomeData() {
  clearTimeout(homeTimer);
  await Promise.all([
    api("/api/quota").then(q => { HQ = q; noteQuota(q); }, () => { HQ = { error: true }; }),
    loadProviderData().catch(() => {}),
    loadMonitors(),
    // the other computers' snapshot, read ahead for 모니터링 and a peer's item opened by link; 홈 itself draws none of it
    typeof pqLoad === "function" ? pqLoad().catch(() => {}) : null,
  ]);
  if (current === "home") { renderHome(); homeTimer = setTimeout(loadHomeData, 60000); }
}
function tapCard(to, ...kids) {
  const open = () => typeof to === "function" ? to() : go(to);
  const c = el("div", { class: "card tap", role: "link", tabindex: "0", onclick: open, onkeydown: ev => { if ((ev.key === "Enter" || ev.key === " ") && ev.target === c) { ev.preventDefault(); open(); } } }, ...kids);
  return c;
}
// tone: "" | "warn" | "err" colours the whole card the same way for every kind of item that needs the owner.
const itemCard = (to, tone, ...kids) => { const c = tapCard(to, ...kids); if (tone) c.classList.add("att", ...(tone === "err" ? ["err"] : [])); return c; };
const menuBtn = id => el("button", { class: "ib", type: "button", "aria-label": "설정", title: "설정", "aria-haspopup": "listbox", "aria-expanded": "false", onclick: ev => { ev.stopPropagation(); homeMenu(ev.currentTarget, id); } }, icon("more"));

// The ⋯ menu of a home card: only what an existing endpoint already does for that item, built from the state at click time.
function homeMenu(anchor, id, inChat) {
  const acts = [];
  const add = (label, run) => acts.push({ value: acts.length, label, run });
  if (id.startsWith("group:")) {
    const kind = id.slice(6);
    add("카드로 나누기", () => setHomeGroup(kind, false));
    add(`${HOME_KINDS[kind][0]} 열기`, () => go(HOME_KINDS[kind][1]));
    homeMoveActs(id, inChat, add);
    return showMenu(anchor, acts, { onPick: i => acts[i].run() });
  }
  if (id === MAIN || isLaneT(id)) {
    const key = id === MAIN ? "orchestrator" : id, name = targetName(id), restartNote = id === MAIN ? "어시스턴트가 다시 시작돼요." : "";
    const cur = M && (id === MAIN ? M.orchestrator : (M.lanes || []).find(l => `lane:${l.name}` === id));
    if (cur) {
      add("모델 변경…", () => showMenu(anchor, modelItems(key, cur.model, ""), { value: cur.model, onPick: v => busy(null, () => putModel(key, name, { model: v }, restartNote, `${modelName(v)} · ${cur.thinking}`)) }));
      add("추론 강도…", () => showMenu(anchor, (M.thinking_levels || []).map(v => ({ value: v, label: thinkKo(v) })), { value: cur.thinking, onPick: v => busy(null, () => putModel(key, name, { thinking: v }, restartNote, `${modelName(cur.model)} · ${thinkKo(v)}`)) }));
      add("모델 · 폴백 설정", () => openModels(key));
    }
    if (id === MAIN) {
      if (S && S.orchestrator && S.orchestrator.status === "working") add("중단", () => abortOrch(null));
      add("재시작", () => restartOrch(null));
    } else {
      const n = laneOf(id);
      add("중단", () => busy(null, async () => { await api(`/api/lanes/${enc(n)}/abort`, "POST", {}); toast("작업을 중단했어요"); refreshState(); }));
      add("재시작", () => busy(null, async () => { if (!await ask(`${n} 재시작`, "이 세션을 다시 시작할까요?", "재시작", true)) return; await api(`/api/lanes/${enc(n)}/restart`, "POST", {}); toast("재시작했어요"); refreshState(); }));
    }
  } else if (id.startsWith("prov:")) {
    const p = ((P && P.providers) || []).find(x => x.id === id.slice(5));
    if (p && p.can_login) add(isConnected(p) ? "다시 로그인" : "로그인", () => startLogin(p));
    if (p && (p.can_logout ?? p.removable)) add(p.auth === "api_key" ? "키 삭제" : "로그아웃", () => busy(null, () => logoutProvider(p)));
    add("공급자 열기", () => go("providers"));
  } else if (id.startsWith("custom:")) {
    for (const a of window.dotzCustom ? dotzCustom.menuActs(id.slice(7)) : []) add(a.label, a.run);
  } else if (id.startsWith("ctx:")) {
    const c = ((C && C.processes) || []).find(x => x.name === id.slice(4));
    if (c && c.running && !(c.compaction && (c.compaction.state === "queued" || c.compaction.state === "compacting"))) add("압축", () => busy(null, async () => {
      const r = await api("/api/compact", "POST", { target: c.name });
      toast(r.state === "queued" ? `${c.name}: 작업 중이라 끝나면 압축해요` : `${c.name}: 압축을 시작했어요`);
      loadContext(true);
    }));
    add("컨텍스트 열기", () => go("context"));
  } else {
    add("사용량 열기", () => go("usage"));
    add("공급자 열기", () => go("providers"));
  }
  const kind = homeKind(id);
  if (kind && !inChat && !homeGroups.has(kind)) add(`${HOME_KINDS[kind][0]} 한 카드로 묶기`, () => setHomeGroup(kind, true));
  homeMoveActs(id, inChat, add);
  showMenu(anchor, acts, { onPick: i => acts[i].run() });
}
// 앞으로 / 뒤로 옮기기: the drag (a long press on a phone) said as a menu item, one place in the reading order per pick.
function homeMoveActs(id, inChat, add) {
  if (inChat || !homeBoard) return;
  const ids = homeBoard.order(), i = ids.indexOf(id);
  if (i < 0) return;
  if (i > 0) add("앞으로 옮기기", () => homeBoard.moveBefore(id, ids[i - 1]));
  if (i < ids.length - 1) add("뒤로 옮기기", () => homeBoard.moveBefore(id, ids[i + 2] || null));
}

// Last meaningful line of each running lane, kept from the live activity stream (fetched once per lane for the first sight).
const LAST = {}, LAST_ASKED = new Set();
let homeSoonT;
const homeSoon = () => { clearTimeout(homeSoonT); homeSoonT = setTimeout(() => { if (current === "home") renderHome(); }, 500); };
// A tool call said in Korean: the kind verb, plus the file's base name for a read or an edit ("파일 수정 · conversations.ts").
const TOOL_VERB = { 명령: "명령 실행", 수정: "파일 수정", 읽기: "읽기", 검색: "검색" };
function toolLineKo(a) {
  const k = kindOf(a.tool), verb = TOOL_VERB[k] || k;
  if (k !== "수정" && k !== "읽기") return verb;
  let p = "";
  try { const o = JSON.parse(a.args); if (o && typeof o === "object") p = [o.path, o.file_path, o.filePath, o.file].find(v => typeof v === "string" && v) || ""; } catch { /* args may be cut off */ }
  if (!p) { const l = laneToolLabel(a); if (/^[^\s]+$/.test(l) && /[./]/.test(l)) p = l; }
  const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return base ? `${verb} · ${base}` : verb;
}
// The runtime's status rows are English internals ("compacting context", "retrying (attempt 2/3)", "orchestrator started (...)"):
// 홈 says the known ones in Korean and skips the rest; a quoted note ("> ...") is shown as written.
function statusLineKo(t) {
  const s = String(t ?? "");
  if (s.startsWith("> ")) return oneLine(s.slice(2));
  const k = [[/^compacting context/, "컨텍스트 압축 중"], [/^context compacted/, "컨텍스트 압축 완료"], [/^retrying/, "다시 시도 중"], [/^aborted/, "중단됨"], [/^model fallback/, "다른 모델로 전환"]].find(([re]) => re.test(s));
  return k ? k[1] : /[가-힣]/.test(s) ? oneLine(s) : "";
}
function actLine(a) {
  switch (a.type) {
    case "text": return friendlyLine(a.text);
    case "error": return oneLine(a.text ?? "");
    case "status": return statusLineKo(a.text);
    case "tool_call": return toolLineKo(a);
    default: return "";
  }
}
function laneLastFetch(name) {
  if (LAST[name] !== undefined || LAST_ASKED.has(name)) return;
  LAST_ASKED.add(name);
  api(`/api/activity?source=${enc(`lane:${name}`)}&limit=30`).then(r => {
    const items = (r && r.items) || [];
    for (let i = items.length - 1; i >= 0 && LAST[name] === undefined; i--) { const s = actLine(items[i]); if (s) LAST[name] = s; }
    if (LAST[name] === undefined) LAST[name] = "";
    homeSoon();
  }, () => {});
}

// The 알림 / 작업내역 / 모니터링 cards: data live in 30-notices.js and 30-monitoring.js; they repaint from its live frames (homeSoon) and open the conversation or screen.
const HOME_NOTICE = { min: { w: 3, h: 4 }, max: { w: 12, h: 10 } };
const hcState = () => (NT.loaded ? "" : NT.failed ? "불러오지 못했어요" : "불러오는 중…");
const hcCard = (open, ...kids) => { const c = tapCard(open, ...kids); c.classList.add("hc"); return c; };
const hcDot = tone => el("span", { class: `nt-dot tone-${tone || "none"}`, "aria-hidden": "true" });
// A generic title (작업 기록, 알림) says nothing in a 3-row card: the row shows the entry's first line instead.
const hcLine = n => { const t = ntPlain(n.title); return !t || t === "작업 기록" || t === "작업내역" || t === "알림" ? ntPlain(String(n.text || "").split("\n")[0]) || t || "알림" : t; };
// Each row opens its own item by kind (30-notices.js noticeOpen); a tap beside the rows still opens the card's conversation.
const hcNotices = list => el("div", { class: "hc-list" }, ...list.map(n => el("div", { class: "hc-row", role: "link", tabindex: "0", onclick: ev => { ev.stopPropagation(); noticeOpen(n); }, onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); noticeOpen(n); } } }, hcDot(n.tone), el("span", { class: "tb" }, el("span", { class: "t", text: hcLine(n) }), ntLaneNote(n) ? el("span", { class: "n", text: ntLaneNote(n) }) : null), el("span", { class: "m", text: ntWhen(n) }), ntNeeds(n) ? ntIgnoreBtn(n) : null)));
// Gateway restarts are kept in the store (born read) but never shown on 홈 (owner 2026-10-19: restarts are not his news).
const hcRecent = pick => NT.items.filter(n => pick(n) && !/^게이트웨이(?: 재시작했어요|를 다시 시작했어요)/.test(String(n.text || ""))).sort((a, b) => ntAt(b) - ntAt(a)).slice(0, 3);
// Only what is news: a question that waits is a row of 답변 필요 above, so it is not counted or listed here a second time; a gateway question it
// handles itself is not asked there (09-needs-you.js nyHandled), so it is news here.
const hcFyi = n => !n.read && ntHomeAlert(n) && (!ntNeeds(n) || nyHandled(n));
function homeAlertCard() {
  const unread = NT.items.filter(hcFyi).length, fresh = hcRecent(hcFyi), state = hcState();
  return hcCard(() => openTarget("alert", "chat"), el("div", { class: "ch" }, el("h3", { text: "알림" })),
    el("div", { class: "big", text: state ? "…" : `${unread}개` }), el("div", { class: "sup", text: "안 읽은 알림" }),
    state || !fresh.length ? el("div", { class: "hc-none", text: state || "새 알림이 없어요" }) : hcNotices(fresh));
}
function homeWorklogCard() {
  const recent = hcRecent(n => n.kind === "worklog" || n.kind === "result"), state = hcState();
  return hcCard(() => openTarget("worklog", "chat"), el("div", { class: "ch" }, el("h3", { text: "작업내역" })),
    state || !recent.length ? el("div", { class: "hc-none", text: state || "아직 작업내역이 없어요" }) : hcNotices(recent));
}
function homeMonitorCard() {
  const list = ntMons(), shown = list.slice(0, 4), bad = list.filter(m => monStatus(m).key === "fail").length;
  const state = NM.loaded ? "" : NM.failed ? "불러오지 못했어요" : "불러오는 중…";
  return hcCard(() => go("monitoring"), el("div", { class: "ch" }, el("h3", { text: "모니터링" }), bad ? el("span", { class: "tag err", text: `실패 ${bad}` }) : null),
    state || !list.length ? el("div", { class: "hc-none", text: state || "모니터링 중인 항목이 없어요" }) : el("div", { class: "hc-list" }, ...shown.map(m => {
      // The same status the 모니터링 row shows (30-monitoring.js monStatus); the dot's colour classes are the notice tones.
      const st = monStatus(m);
      return el("div", { class: "hc-mon", "data-status": st.key }, hcDot({ ok: "done", warn: "ask", err: "fail" }[st.tone]), el("div", { class: "b" }, el("span", { class: "n", text: ntPlain(m.name) || "모니터링" }),
        el("span", { class: "s", text: [ntMonRun(m), st.text, ntMonNext(m)].filter(Boolean).join(" · ") })));
    })),
    list.length > shown.length ? el("div", { class: "hc-more", text: `더 보기 · ${list.length - shown.length}개` }) : null);
}

let homeBoard = null;
const HOME_BIG = { min: { w: 3, h: 3 }, max: { w: 12, h: 10 } }, HOME_SMALL = { min: { w: 2, h: 2 }, max: { w: 12, h: 6 } }, HOME_GROUP = { min: { w: 3, h: 2 }, max: { w: 12, h: 14 } };
// Kinds of home items that can be bundled into one card (title, view the card opens); the bundled kinds are kept per browser.
const HOME_KINDS = { ctx: ["컨텍스트", "context"], limit: ["사용량", "usage"], prov: ["공급자", "providers"] };
const HOME_GROUPS_KEY = "dotz-home-groups";
const homeKind = id => { const k = id.split(":")[0]; return HOME_KINDS[k] ? k : null; };
let homeGroups = (() => { const v = lsJson(HOME_GROUPS_KEY, null); return new Set(Array.isArray(v) ? v : ["ctx", "limit", "prov"]); })();
function setHomeGroup(kind, on) {
  if (on) homeGroups.add(kind); else homeGroups.delete(kind);
  try { localStorage.setItem(HOME_GROUPS_KEY, JSON.stringify([...homeGroups])); } catch {}
  setTimeout(renderHome, 0);
}
const toneCls = t => t ? ` att${t === "err" ? " err" : ""}` : "";
// One item inside a bundle card: clicking it opens the item, its own ⋯ menu keeps the item's actions.
function homeRow(e) {
  const r = el("div", { class: `grow${toneCls(e.tone)}`, role: "link", tabindex: "0", onclick: ev => { ev.stopPropagation(); e.open(); }, onkeydown: ev => { if ((ev.key === "Enter" || ev.key === " ") && ev.target === r) { ev.preventDefault(); ev.stopPropagation(); e.open(); } } },
    el("div", { class: "gm" }, ...e.row()), menuBtn(e.id));
  return r;
}
// Every item is its own floating card (the assistant, each running lane, each context process, each usage limit, each provider),
// except kinds the owner bundled: those share one card with a row per item.
// The newest meaningful line of what a target is doing: its loaded activity, else the lane's last fetched line, else its last text.
function nowLine(t) {
  const acts = ts(t).acts;
  for (let i = acts.length - 1; i >= 0 && i >= acts.length - 40; i--) { const s = actLine(acts[i]); if (s) return s; }
  if (isLaneT(t) && LAST[laneOf(t)]) return LAST[laneOf(t)];
  const l = isLaneT(t) && S ? S.lanes.find(x => x.name === laneOf(t)) : null, last = t === MAIN ? (S && S.orchestrator && S.orchestrator.lastText) : l && l.lastText;
  return last ? friendlyLine(last) : "";
}
// A preview line shows what the owner may read: never the [later] sentinel (a turn handed to a background worker), the handoff
// block, or an "Ask: " label. Same rule as hub/tone.ts previewSource.
const LATER_LINE = "백그라운드 작업 중";
const isLaterText = s => /^\s*\[later\]\s*$/i.test(String(s ?? ""));
function previewSrc(raw) {
  const s = noHandoff(String(raw ?? "")).replace(/^\s*Ask:[ \t]*/i, "");
  return isLaterText(s) ? LATER_LINE : s;
}
const friendlyLine = raw => oneLine(parseTone(previewSrc(raw)).text);
// Same rule as hub/tone.ts stripHandoff: the agent's leading "Ask: ... For you: ... Next: ..." block is not shown.
function noHandoff(text) {
  const m = /^\s*Ask:[^\n]*(?:\n(?!\s*\n)[^\n]*)*/.exec(text);
  if (!m || !/\bFor you:/.test(m[0])) return text;
  const rest = text.slice(m[0].length).replace(/^\s+/, "");
  return rest || ((/\bFor you:\s*([\s\S]*?)(?:\s+Now:[\s\S]*)?$/.exec(m[0]) || [])[1] || "").trim() || text;
}
function askOf(t) {
  if (!isLaneT(t) || !S) return false;
  const l = S.lanes.find(x => x.name === laneOf(t));
  return !!(l && l.lastText && parseTone(noHandoff(String(l.lastText))).tone === "ask" && l.status !== "working");
}
// A row's preview is the conversation's state said in Korean (the run line above the composer, 41-runstate.js), not its last message.
const homeRunLine = t => { const r = S && S.runs && S.runs[t === MAIN ? "main" : t]; return r ? runText(r) : ""; };
function homeNowRow(t, label, tone) {
  const i = targetInfo(t), subs = SUBS[sourceOf(t)] || [], done = subs.filter(s => s.status !== "running").length;
  const lane = isLaneT(t) && S ? S.lanes.find(x => x.name === laneOf(t)) : null;
  if (lane && !homeRunLine(t)) laneLastFetch(lane.name);
  // A session waiting on the owner says its question, so the row tells what to answer.
  const line = (tone === "att" && i.ask && friendlyLine(i.ask.text)) || homeRunLine(t) || nowLine(t) || modelChipText(String(liveModel(t).sel || "").split(":")[0]) || (i.alive ? statusKo(i.status) : "종료됨");
  // A session moved to a fallback model says so on its row (the board has no session card): the model it runs now and why.
  const lv = lane ? liveModel(t) : null, extra = lv && lv.fallback ? el("span", { class: "smodel" }, selText(lv.sel), fbTag(lv.fallback, lv.conf)) : null;
  if (lane) return sessionRow(lane, { line, extra, ...(tone === "att" ? { word: label, tone: "warn" } : {}) });   // a session: title, project, status, one tap to its chat
  return el("button", { class: "hr", type: "button", onclick: () => openTarget(t, lastChatView()), "aria-label": `${targetName(t)} · ${label}` },
    el("span", { class: `dot ${tone === "att" ? "att" : runBusy(t) ? "pri" : statusTone(i.status)}` }),
    el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: targetName(t) })), el("span", { class: "ha", text: line })),
    subs.length ? el("span", { class: "hp", title: "서브에이전트 끝난 수 / 전체", text: `서브에이전트 ${done}/${subs.length}` }) : null,
    el("span", { class: `hs ${tone === "att" ? "warn" : runBusy(t) ? "pri" : statusTone(i.status)}`, text: label }));
}
// 미답장 (hub/unreplied.ts): the apps whose items still wait for the owner's reply, each one row, apart from the read/unread counts.
function homeOwedRow(it) {
  return el("button", { class: "hr", type: "button", onclick: () => go("monitoring", it.key), "aria-label": `${it.name} · 미답장 ${it.unreplied}건` },
    el("span", { class: "dot unreplied" }), el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: it.name })), el("span", { class: "ha", text: "답장을 기다리는 것이 있어요" })),
    el("span", { class: "hs unreplied", text: `미답장 ${it.unreplied}` }));
}
// 답장 확인: the reply drafts of this computer's apps that wait for 보내기, one row that opens the queue (30-replies.js).
function homeRepliesRow(n) {
  return el("button", { class: "hr", type: "button", "data-k": "replies", onclick: () => rqOpen(), "aria-label": `답장 확인 ${n}건` },
    el("span", { class: "dot att" }), el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: "답장 확인" })), el("span", { class: "ha", text: "보내기 전에 확인할 답장 초안이 있어요" })),
    el("span", { class: "hs warn", text: `${n}건` }));
}
function renderHomeNow() {
  const box = $("#home-now");
  if (!box) return;
  const all = [MAIN, ...((S && S.lanes) || []).filter(laneAlive).map(l => `lane:${l.name}`)];
  const needs = nyList(), crit = needs.filter(x => x.crit).length;   // 09-needs-you.js: what only the owner can do, critical first
  // 홈 is this computer's alone (owner 2026-10-31): the other computers' items live in 모니터링, and the computer chip's dot says they want something.
  const owed = monItems().filter(i => i.app && i.unreplied && !i.pc), owedN = owed.reduce((c, i) => c + i.unreplied, 0), drafts = rqAll().filter(x => !x.pc).length;
  const waiting = needs.length;
  // 지금 진행 중 is only what runs now (a turn, a background worker); a waiting or idle conversation is a row of 대기 중 below it,
  // and background work that ended within the hour is listed last (실패 · 이유 · 다시 맡기기).
  const live = t => { const s = targetInfo(t).status; return s === "working" || s === "starting"; };
  const runT = all.filter(live), restT = all.filter(t => !live(t));
  const bg = workRunning(), ended = workEnded(), working = runT.length + bg.length;
  const restRow = t => homeNowRow(t, !targetInfo(t).alive ? "종료됨" : runBusy(t) ? "진행 중" : statusKo(targetInfo(t).status), "");
  clear(box).append(
    // Three kinds, three places: 답변 필요 (a decision only the owner can make), 답장 대기 (replies he owes, per app), 지금 진행 중; plain news is the 알림 card.
    el("div", { class: "hn-h" }, el("h2", { text: "답변 필요" }), crit ? el("span", { class: "tag warn", text: `중요 ${crit}` }) : null, waiting ? el("span", { class: "sup", text: `${waiting}` }) : null),
    nyListNode(needs),
    ...(owed.length || drafts ? [el("div", { class: "hn-h" }, el("h2", { text: "답장 대기" }), owedN ? unrepPill(`미답장 ${owedN}`) : null), el("div", { class: "hn" }, ...(drafts ? [homeRepliesRow(drafts)] : []), ...owed.map(homeOwedRow))] : []),
    el("div", { class: "hn-h" }, el("h2", { text: "지금 진행 중" }), working ? el("span", { class: "sup", text: `${working}개 작업 중` }) : null),
    el("div", { class: "hn", "data-k": "running" }, ...runT.map(restRow), ...bg.map(workRow), ...(working ? [] : [el("div", { class: "empty", text: "진행 중인 작업이 없어요" })])),
    ...(restT.length ? [el("div", { class: "hn-h" }, el("h2", { text: "대기 중" })), el("div", { class: "hn", "data-k": "waiting" }, ...restT.map(restRow))] : []),
    ...(ended.length ? [el("div", { class: "hn-h" }, el("h2", { text: "최근 끝난 작업" })), el("div", { class: "hn", "data-k": "ended-work" }, ...ended.map(workRow))] : []),
    endedGroup() || "");
}
// The home screen always opens at its top: on load, on the tab, and when the installed app comes back to the front (23-installable-app-web.js, 99-boot.js).
const homeTop = () => { if (current === "home") { $("#views").scrollTop = 0; $("#appbar").classList.remove("scrolled"); } };
function renderHome() {
  const box = $("#home-cards");   // not id="home": the address #home would scroll the page down to that element, not to the top
  if (!box || current !== "home") return;
  renderHomeNow();
  if (openMenu && box.contains(openMenu.anchor)) return;   // a ⋯ menu is open: repaint after it closes
  $("#title").textContent = botName;
  if (!homeBoard) homeBoard = makeBoard(box, "home", { actions: [{ label: "카드 추가", run: () => window.dotzCustom && dotzCustom.add() }], onReset: () => { if (window.dotzCustom) dotzCustom.unhide(); setTimeout(renderHome, 0); } });
  const o = (S && S.orchestrator) || {}, om = M && M.orchestrator, live = liveModel(MAIN), [liveBase, liveLevel] = String(live.sel || "").split(":"), items = [], seen = new Set();
  const add = (id, node, def, size) => { if (!seen.has(id)) { seen.add(id); items.push({ id, node, head: ".ch", def, ...size }); } };

  // assistant
  const stText = o.status === "rate-limited" && o.rateLimitedUntil ? `${statusKo(o.status)} · ${kstTime(o.rateLimitedUntil)}까지` : statusKo(o.status);
  const mainAttn = attnKind(MAIN);
  add(MAIN, itemCard(() => openTarget(MAIN, lastChatView()), mainAttn || o.status === "rate-limited" ? "warn" : "",
    el("div", { class: "ch" }, el("span", { class: `dot ${mainAttn ? "att" : statusTone(o.status)}` }), el("h3", { text: botName }), mainAttn ? el("span", { class: "tag warn", text: "확인 필요" }) : null, el("span", { class: `tag ${statusTone(o.status)}`, text: S ? stText : "연결 중" }), menuBtn(MAIN)),
    el("div", { class: "big", text: om && liveBase ? (modelName(liveBase).includes("-") ? modelChipText(liveBase) : modelName(liveBase)) : "…" }),
    el("div", { class: "sup sub" }, liveLevel ? `추론 강도 ${thinkKo(liveLevel)}` : "\u00a0", live.fallback ? fbTag(live.fallback, live.conf) : null),
    subLine("orchestrator")), { w: 4, h: 4 }, HOME_BIG);
  add("notices:alert", homeAlertCard(), { w: 4, h: 4 }, HOME_NOTICE);
  add("notices:worklog", homeWorklogCard(), { w: 4, h: 4 }, HOME_NOTICE);
  add("notices:watch", homeMonitorCard(), { w: 4, h: 4 }, HOME_NOTICE);

  // entries per kind: {id, tone, open, card() (own floating card), row() (contents of its row in a bundle)}. A session is a row of
  // 지금 진행 중 / 대기 중 above, so it has no card here as well.
  const E = { ctx: [], limit: [], prov: [] };
  for (const p of ((C && C.processes) || []).filter(x => x.running)) {
    const id = `ctx:${p.name}`, pct = p.percent, who = p.kind === "lane" ? targetName(`lane:${p.name}`) : botName, v = pct != null ? `${pct}%` : `${num(p.tokens)} 토큰`;
    const bar = () => el("div", { class: `bar ${ctxTone(pct)}`, role: "progressbar", "aria-valuenow": Math.round(pct || 0), "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${Math.min(100, pct || 0).toFixed(1)}%` }));
    E.ctx.push({ id, tone: pct >= 80 ? "warn" : "", open: () => go("context"), size: [{ w: 4, h: 2 }, HOME_SMALL],
      card: () => [el("div", { class: "ch" }, el("h3", { text: `컨텍스트 · ${who}` }), el("span", { class: "sup", text: v }), menuBtn(id)), bar()],
      row: () => [el("div", { class: "kv" }, el("span", { class: "k", text: who }), el("span", { class: "v", text: v })), bar()] });
  }
  if (HQ && !HQ.error) {
    const provs = (HQ.providers || []).filter(p => (p.limits || []).length), multi = provs.length > 1;
    for (const pr of provs) for (const l of pr.limits) {
      const id = `limit:${pr.provider}:${l.id}`, f = limitFrac(l), name = limitLabel(pr, l, multi);
      E.limit.push({ id, tone: limitHit(l) || (f != null && f <= .2) ? "warn" : "", open: () => go("usage"), size: [{ w: 4, h: 2 }, HOME_SMALL],
        card: () => [el("div", { class: "ch" }, el("h3", { text: name }), el("span", { class: "sup", text: pctText(l) }), menuBtn(id)), bar(l)],
        row: () => [el("div", { class: "kv" }, el("span", { class: "k", text: name }), el("span", { class: "v", text: pctText(l) })), bar(l)] });
    }
  }
  for (const p of (P && P.providers) || []) {
    if (!isConnected(p) && !needsAttention(p)) continue;
    const id = `prov:${p.id}`, bad = needsAttention(p), st = bad ? "로그인 필요" : p.auth === "api_key" ? "API 키" : "로그인됨";
    E.prov.push({ id, tone: bad ? "warn" : "", open: () => go("providers"), size: [{ w: 4, h: 2 }, HOME_SMALL],
      card: () => [el("div", { class: "ch" }, el("span", { class: `dot ${bad ? "att" : "ok"}` }), el("h3", { text: p.name || p.id }), el("span", { class: `tag ${bad ? "warn" : ""}`, text: st }), menuBtn(id)),
        p.account ? el("div", { class: "sup", text: p.account }) : null],
      row: () => [el("div", { class: "row" }, el("span", { class: `dot ${bad ? "att" : "ok"}` }), el("span", { class: "nm", text: p.name || p.id }), el("span", { class: "sup", text: bad ? st : p.account || st }))] });
  }
  const loaded = { ctx: !!C, limit: !!HQ, prov: !!P };
  for (const [kind, list] of Object.entries(E)) {
    if (!homeGroups.has(kind)) { for (const e of list) add(e.id, itemCard(e.open, e.tone, ...e.card()), ...e.size); continue; }
    // never shorter than its rows: header ~52px, bar rows ~44px, plain rows ~30px
    const need = Math.min(HOME_GROUP.max.h, Math.max(2, Math.ceil((52 + Math.max(1, list.length) * (kind === "limit" || kind === "ctx" ? 44 : 30) + BGAP) / BSTEP)));
    const [title, view] = HOME_KINDS[kind], nAtt = list.filter(e => e.tone).length;
    const tone = list.some(e => e.tone === "err") ? "err" : nAtt ? "warn" : "";
    const empty = !loaded[kind] ? "불러오는 중…" : kind === "limit" && HQ.error ? "사용량을 불러오지 못했어요" : "없어요";
    add(`group:${kind}`, itemCard(view, tone,
      el("div", { class: "ch" }, el("h3", { text: title }), nAtt ? el("span", { class: "tag warn", text: `확인 필요 ${nAtt}` }) : null, list.length ? el("span", { class: "tag", text: String(list.length) }) : null, menuBtn(`group:${kind}`)),
      list.length ? el("div", { class: "glist" }, ...list.map(homeRow)) : el("div", { class: "sup", text: empty })), { w: 4, h: need }, { min: { w: 3, h: need }, max: HOME_GROUP.max });
  }

  // the owner's custom cards (web/custom.js) are board items like the rest
  for (const it of window.dotzCustom ? dotzCustom.items() : []) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
  // cards of data that has not arrived yet keep their saved place
  homeBoard.set(items, id => id.startsWith("custom:") ? !window.dotzCustom || dotzCustom.keep(id) : id.startsWith("ctx:") ? !C : id.startsWith("limit:") ? !HQ || !!HQ.error : id.startsWith("prov:") ? !P : false);
  window.dotzCustom && dotzCustom.home();
}

/* ---------- assistant actions ---------- */
const restartOrch = btn => busy(btn, async () => {
  if (!await ask("어시스턴트 재시작", "작업 중인 내용이 있으면 멈춰요.", "재시작")) return;
  await api("/api/orchestrator/restart", "POST", {});
  toast("재시작을 요청했어요");
  refreshState();
});
const abortOrch = btn => busy(btn, async () => {
  await api("/api/orchestrator/abort", "POST", {});
  toast("작업을 중단했어요");
  refreshState();
});

/* ---------- target: the one selection shared by 대화 (chat) and 터미널 (terminal) ---------- */
const MAIN = "main", TARGET_KEY = "dotz-target";
const isLaneT = t => t.startsWith("lane:");
// The two fixed conversations next to the main chat (Discord's alert and worklog channels): the gateway's posts live there, not in the main chat.
const isFixedT = t => t === "alert" || t === "worklog";
const FIXED_NAME = { alert: "알림", worklog: "작업내역" };
const laneOf = t => t.slice(5);
// A project orchestrator (hub/projectchat.ts): the one orchestrator in a project's work channel, target ch:<id>. Its
// conversation is the channel's messages; its process, model and log are the orchestrator's.
const isProjT = t => /^ch:\d+$/.test(t);
const projOf = t => t.slice(3);
const projTargets = () => Object.keys((S && S.channels && S.channels.work) || {}).map(id => `ch:${id}`);
// A mail (hub/mail.ts): one conversation per mail, target mail:<key>, answered by the orchestrator. MAILS: target -> { subject, from,
// source, at }, from GET /api/conversations and live mail events (31-conversations.js).
const isMailT = t => t.startsWith("mail:");
const mailOf = t => t.slice(5);
const MAILS = new Map();
// The other computers' items (34-peer-monitoring.js). of: conversation target -> {pc, key: the list item it sits under}; seen: unread/read pair last taken from a snapshot.
const PQ = { list: [], loaded: false, busy: false, again: false, at: 0, t: 0, of: new Map(), apps: new Map(), seen: new Map() };
// An app's settings conversation (hub/app-settings.ts, 32-app-settings.js): target settings:<app>, answered by the orchestrator.
const isSettingsT = t => t.startsWith("settings:");
const settingsApp = t => t.slice(9);
const mailSender = f => String(f || "").replace(/<[^>]*>/g, "").replace(/["']/g, "").trim() || String(f || "");
const validTarget = t => t === MAIN || isFixedT(t) || isProjT(t) || (isLaneT(t) && t.length > 5) || (isMailT(t) && t.length > 5) || (isSettingsT(t) && t.length > 9);
const sourceOf = t => t === MAIN || isProjT(t) || isFixedT(t) || isMailT(t) || isSettingsT(t) ? "orchestrator" : t;
const targetOfSource = s => s === "orchestrator" ? MAIN : s;
// Owner-facing names: a project by its title (else its channel name), a session by its title (else its key).
// The name of a target on the computer `pc` it belongs to (an item from another gateway carries pc = {name, url, bot}): there the main chat is
// that gateway's own bot, never this one's (owner 2026-10-31: 맥북's question read "땃쥐" on 회사). No pc: this computer's targetName.
const pcTargetName = (t, pc) => !pc ? targetName(t) : t === MAIN || t === "chat" ? pc.bot || pc.name : isLaneT(t) ? t.slice(5) : isProjT(t) ? t : targetName(t);
const targetName = t => {
  if (t === MAIN) return botName;
  if (isFixedT(t)) return FIXED_NAME[t];
  if (isMailT(t)) return (MAILS.get(t) || {}).subject || "메일";
  if (isSettingsT(t)) return monSettingsName(t);
  if (isProjT(t)) {
    let list = [];
    try { list = (PRJ && PRJ.projects) || []; } catch { /* PRJ (the project list, declared further down) is not set up yet */ }
    const p = list.find(x => x.recordKey === t || x.key === t);
    return (p && ((p.record && p.record.title) || p.name)) || ((S && S.channels && S.channels.work) || {})[projOf(t)] || "프로젝트";
  }
  const l = S && (S.lanes || []).find(x => x.name === laneOf(t));
  return (l && l.title) || laneOf(t);
};
// Every target the switcher and the needs-you count list: the main assistant, the projects, the live lanes.
const liveTargets = () => S ? [MAIN, ...projTargets(), ...S.lanes.filter(laneAlive).map(l => `lane:${l.name}`)] : [MAIN];
const modeOf = () => current === "activity" ? "term" : "chat";
let target = MAIN;
try { const v = localStorage.getItem(TARGET_KEY); if (v && validTarget(v)) target = v; } catch {}
// A settings conversation (a monitor's or an app's) shows the orchestrator busy only for a turn its own message started: TURN = target -> when that message
// was sent, until the answer comes. A peer's monitor is answered on that computer, so this one's status never applies to it.
const TURN = new Map();
function targetInfo(t) {
  if (isSettingsT(t)) { const o = (S && S.orchestrator) || {}, busy = o.status === "working" || o.status === "starting"; return { status: busy && (!TURN.has(t) || PQ.of.has(t)) ? "idle" : o.status || "", alive: true, known: true }; }
  if (t === MAIN || isFixedT(t) || isMailT(t)) { const o = (S && S.orchestrator) || {}; return { status: o.status || "", alive: true, known: true }; }
  if (isProjT(t)) { const o = (S && S.orchestrator) || {}, known = projTargets().includes(t); return { status: o.status || "", alive: known || !S, known }; }
  const l = S && S.lanes.find(x => x.name === laneOf(t));
  return l ? { status: l.status, alive: laneAlive(l), known: true, resumable: !!l.resumable, ask: l.pendingAsk && l.pendingAsk.text ? l.pendingAsk : null } : { status: "", alive: true, known: false };
}
const isWorking = t => { const i = targetInfo(t); return i.alive && (i.status === "working" || i.status === "starting"); };
// The main assistant's background work (S.work) as a row on Home: tap goes to the message that asked for it, flashed (its own detail when that message is unknown).
async function workGo(w) {
  const t = w.target && validTarget(w.target) ? w.target : MAIN;
  if (!w.reply_to) return openSub("orchestrator", w.id, null, w.description);
  if (!(ts(t).hLoaded && ts(t).aLoaded)) await loadTarget(t).catch(() => {});
  const asked = ts(t).msgs.find(e => e.mid === w.reply_to);
  if (!asked) return openSub("orchestrator", w.id, null, w.description);
  ntJump({ src: t, at: asked.ts });
}
// A running one offers 중단, one the owner stopped 다시 맡기기 (06-subagents.js workCancel / workRetry); a failed one is the agent's to take
// up (blue 이어서 처리 중, no button); the rest of the row goes to the conversation.
function workRow(w) {
  const run = w.status === "running", done = w.status === "done", rec = workRecovering(w);
  const state = run ? "작업 중" : done ? "완료" : w.cancelled ? "중단됨" : rec ? "이어서 처리 중" : "실패";
  const line = run ? [workElapsed(w), w.model].filter(Boolean).join(" · ") : done ? `끝남 · ${workAgo(w)}` : `${workFailText(w)} · ${workAgo(w)}`;
  const act = run ? ["중단", b => workCancel(w.id, b)] : w.cancelled ? ["다시 맡기기", b => workRetry(w.id, b)] : null;
  return el("div", { class: "hr hrx", "data-work": w.id },
    el("button", { class: "hrx-m", type: "button", onclick: () => workGo(w), "aria-label": `${w.description} · ${state} · 대화로 가기` },
      el("span", { class: `dot ${run || rec ? "pri" : done ? "ok" : w.cancelled ? "" : "err"}` }),
      el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: w.description })), el("span", { class: "ha", text: line })),
      el("span", { class: `hs ${run || rec ? "pri" : done || w.cancelled ? "" : "err"}`, text: state })),
    act ? el("button", { class: "btn text", type: "button", style: "flex:none;margin-right:8px", "data-act": run ? "cancel" : "retry", onclick: ev => act[1](ev.currentTarget), text: act[0] }) : null);
}
