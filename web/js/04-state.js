/* ---------- state ---------- */
let S = null;          // /api/state (no events)
let M = null;          // /api/models
let P = null;          // /api/providers
let botName = "dotz";
let current = "home", prevView = null;
// Narrow screens: 채팅 shows the chat list (31-conversations.js) until a row is opened; from 1100px the list always sits beside the conversation.
let chatList = false;
const narrowChat = () => matchMedia("(max-width: 1099px)").matches;
const convListing = () => current === "chat" && chatList && narrowChat();
// 채팅 is one tab: its 대화 | 터미널 toggle picks the "chat" or "activity" view, and the tab reopens the last one used.
const NAV = [["home", "홈"], ["chat", "채팅"], ["projects", "프로젝트"], ["lanes", "세션"], ["settings", "설정"]];
const CHAT_MODE_KEY = "dotz-chat-mode";
const navView = v => v === "activity" ? "chat" : v === "project" ? "projects" : v;
// 대화 or 로그 for a target: the main chat and projects share one global choice; a session (lane:<name>) remembers its own and starts in 대화.
const viewFor = t => { try { return localStorage.getItem(t && t.startsWith("lane:") ? `dotz-lane-view:${t}` : CHAT_MODE_KEY) === "activity" ? "activity" : "chat"; } catch { return "chat"; } };
const lastChatView = () => viewFor(target);
const SUB = new Set(["models", "providers", "usage", "context", "harness"]);
const views = ["home", "chat", "activity", "lanes", "harness", "settings", "models", "providers", "usage", "context", "project", "projects"];
const titles = { home: "홈", chat: "채팅", activity: "채팅", lanes: "세션", harness: "구성", settings: "설정", models: "모델 · 폴백", providers: "공급자", usage: "사용량", context: "컨텍스트", project: "프로젝트", projects: "프로젝트" };
// The gateway's one live-lane rule (lanes.ts laneLive: not exited, process up, not a temp test project) drives every list.
const laneAlive = l => !!l && (l.live ?? l.status !== "exited");
const endedLanes = () => ((S && S.lanes) || []).filter(l => !laneAlive(l)).sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
// Ended lanes fold into one "종료된 레인 n" row; opening one shows its history (and resume). Each row has a delete button,
// and 선택 turns the rows into checkboxes for deleting several at once. Delete moves the lane into the gateway's trash
// (lanetrash.ts, kept 7 days); the toast's 되돌리기 restores it.
let endedOpen = false, endedSel = null;
const UNDO_MS = 8000;
function refreshEnded() {
  const box = $("#lanes-ended");
  if (box) box.dataset.sig = "";
  document.querySelectorAll("details.ended").forEach(d => d.replaceWith(endedGroup() || ""));
}
function endedGroup() {
  const list = endedLanes();
  if (endedSel) for (const n of endedSel) if (!list.some(l => l.name === n)) endedSel.delete(n);
  if (!list.length) { endedSel = null; return null; }
  const sel = endedSel;
  const stop = fn => ev => { ev.preventDefault(); ev.stopPropagation(); fn(ev); };
  const tools = sel
    ? el("span", { class: "etools" },
        el("button", { type: "button", class: "btn text", onclick: stop(() => { endedSel = null; refreshEnded(); }) }, "취소"),
        el("button", { type: "button", class: "btn danger fill", disabled: !sel.size, onclick: stop(() => deleteEnded([...sel])) }, `삭제 ${sel.size}개`))
    : el("span", { class: "etools" }, el("button", { type: "button", class: "btn text", onclick: stop(() => { endedSel = new Set(); endedOpen = true; refreshEnded(); }) }, "선택"));
  const all = sel && el("label", { class: "er ck-all" },
    el("input", { type: "checkbox", class: "ck", checked: sel.size === list.length, onchange: ev => { endedSel = new Set(ev.currentTarget.checked ? list.map(l => l.name) : []); refreshEnded(); } }),
    el("span", { text: "전체 선택" }), el("span", { class: "sup", text: `${sel.size}/${list.length}` }));
  const row = l => sel
    ? el("label", { class: "er" },
        el("input", { type: "checkbox", class: "ck", checked: sel.has(l.name), onchange: ev => { if (ev.currentTarget.checked) sel.add(l.name); else sel.delete(l.name); refreshEnded(); } }),
        el("span", { class: "en", text: l.name }), el("span", { class: "sup", text: l.startedAt ? kstDay(l.startedAt) : "" }))
    : el("div", { class: "erow" },
        el("button", { class: "er", type: "button", onclick: () => openTarget(`lane:${l.name}`, lastChatView()) },
          el("span", { class: "dot" }), el("span", { class: "en", text: l.title || l.name }), el("span", { class: "sup", text: l.startedAt ? kstDay(l.startedAt) : "" })),
        el("button", { class: "ib edel", type: "button", "aria-label": `${l.name} 삭제`, title: "삭제", onclick: () => deleteEnded([l.name]) }, icon("trash")));
  const d = el("details", { class: `ended${sel ? " selecting" : ""}` }, el("summary", {}, icon("chev"), el("span", { text: `종료된 세션 ${list.length}` }), tools),
    ...(all ? [all] : []), ...list.map(row));
  d.open = endedOpen;
  d.addEventListener("toggle", () => { endedOpen = d.open; if (!d.open && endedSel) { endedSel = null; refreshEnded(); } });
  return d;
}
async function deleteEnded(names) {
  if (!names.length) return;
  const one = names.length === 1;
  const sure = await new Promise(res => {
    let v = false;
    dialog({ title: one ? `${names[0]} 삭제` : `세션 ${names.length}개 삭제`, onclose: () => res(v),
      body: el("div", { class: "dl-body" }, el("p", { text: "휴지통으로 옮겨요. 7일 안에는 되돌릴 수 있어요." }),
        el("ul", { class: "dl-list" }, ...names.map(n => el("li", { text: n })))),
      actions: [{ label: "취소", onclick: c => c() }, { label: one ? "삭제" : `${names.length}개 삭제`, kind: "danger fill", onclick: c => { v = true; c(); } }] });
  });
  if (!sure) return;
  try {
    // 409 = nothing could be deleted; its body carries the same per-lane results, shown as the calm note below.
    const r = await api("/api/lanes/delete", "POST", { names }).catch(e => { if (e.data && e.data.results) return e.data; throw e; });
    const ok = r.results.filter(x => x.ok), bad = r.results.filter(x => !x.ok);
    endedSel = null;
    if (S && S.lanes) S.lanes = S.lanes.filter(l => !ok.some(x => x.name === l.name));
    refreshEnded();
    refreshState();
    if (ok.length) toast(`${ok.length === 1 ? ok[0].name : `${ok.length}개`} 삭제했어요`, false, { label: "되돌리기", onclick: () => restoreEnded(ok.map(x => x.id)) }, UNDO_MS);
    if (bad.length) keptLanes(bad);
  } catch (e) { toast(e.message, true); }
}
// Lanes the gateway refused to delete: a calm note with the reason in plain words, not an error (lanetrash.ts reasons).
const keptWhy = err => /uncommitted/i.test(err) ? "아직 커밋하지 않은 변경이 있어요. 커밋하거나 정리하면 지울 수 있어요."
  : /live|running|working|busy|실행 중|작업 중/i.test(err) ? "아직 돌고 있어요. 멈춘 뒤에 지울 수 있어요."
  : "작업 폴더를 정리하지 못했어요. 잠시 뒤에 다시 해 보세요.";
function keptLanes(bad) {
  dialog({ title: bad.length === 1 ? `${bad[0].name} 세션은 그대로 뒀어요` : `세션 ${bad.length}개는 그대로 뒀어요`,
    body: el("div", { class: "dl-body" }, el("p", { text: "아무것도 지우지 않았어요. 안전하게 남겨 두었어요." }),
      el("ul", { class: "dl-list" }, ...bad.map(x => el("li", { text: `${x.name} · ${keptWhy(String(x.error || ""))}` })))),
    actions: [{ label: "확인", kind: "fill", onclick: c => c() }] });
}
async function restoreEnded(ids) {
  try {
    const r = await api("/api/lanes/restore", "POST", { ids }).catch(e => { if (e.data && e.data.results) return e.data; throw e; });
    const bad = r.results.filter(x => !x.ok);
    toast(bad.length ? `${bad.length}개는 되돌리지 못했어요. 휴지통에 그대로 있어요` : "되돌렸어요", bad.length > 0);
    refreshState();
  } catch (e) { toast(e.message, true); }
}
// An exited or stopped lane is a normal end, so it gets the neutral dot; red is kept for real failures.
const statusTone = s => ({ working: "pri", idle: "ok", "rate-limited": "warn" })[s] || (/dead|error|fail/.test(s || "") ? "err" : "");
const statusKo = s => ({ working: "작업 중", idle: "대기", starting: "시작 중", stopped: "멈춤", "rate-limited": "한도 제한", exited: "종료됨" })[s] || s || "알 수 없음";
const providerName = id => { const p = ((P && P.providers) || []).find(x => x.id === id); return (p && p.name) || id; };
// Thinking levels said in Korean (the stored value stays the API id).
const THINK_KO = { off: "끔", minimal: "최소", low: "낮음", medium: "보통", high: "높음", xhigh: "최고", max: "최고", auto: "자동" };
const thinkKo = v => THINK_KO[String(v || "").toLowerCase()] || String(v || "");
const modelName = sel => { if (!sel) return "–"; const a = ((M && M.pickable) || []).find(x => x.selector === sel) || ((M && M.available) || []).find(x => x.selector === sel); return a ? a.name || sel : String(sel).split("/").pop(); };

/* ---------- chrome: nav, theme, back ---------- */
// Phone: tapping 채팅 again while in it opens the session list as a bottom sheet above the tab bar (owner 2026-10-20).
for (const [id, label] of NAV) $("#nav").append(el("button", { class: "ni", type: "button", "data-view": id, onclick: () => (id === "chat" && narrowChat() ? go("chat", "list") : go(id === "chat" ? lastChatView() : id)) }, icon(id), el("span", { class: "nl", text: label }), id === "chat" ? el("span", { class: "nb nnb", id: "nav-att", hidden: true }) : null));
// Light<->dark switch (settings row and palette; the app bar has no theme button, so the system setting rules until one is picked).
const themeIs = () => dotzTheme.get();
const themeIc = () => themeIs() === "dark" ? "sun" : "moon";
const themeNext = () => themeIs() === "dark" ? "라이트" : "다크";
function toggleTheme() { dotzTheme.toggle(); if (current === "settings") renderSettings(); }
window.addEventListener("dotz-theme", () => { if (current === "settings") renderSettings(); });
$("#pal").append(icon("search"));
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
$("#cmdk").append(icon("search"), el("span", { class: "tx", text: "명령" }), el("kbd", { text: isMac ? "⌘K" : "Ctrl K" }));
const setBrand = () => { $("#brand-name").textContent = botName; paintAttn(); };
$("#brand").onclick = () => go("home");
function renderSideStatus() {
  const o = (S && S.orchestrator) || {};
  $("#side-dot").className = `dot ${S ? statusTone(o.status) : ""}`;
  $("#side-st").textContent = S ? statusKo(o.status) : "연결 중";
}
$("#send-btn").append(icon("send"));
$("#back").append(icon("back"));
const backTarget = () => current === "harness" ? "settings" : SUB.has(current) ? (prevView && !SUB.has(prevView) && prevView !== current ? prevView : "settings") : current === "project" ? "projects" : null;
$("#back").onclick = () => (convOnPhone() ? go("chat", "list") : go(backTarget() || "home"));
