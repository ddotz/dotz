/* ---------- 구성: 기능 보기 (what the owner added, by implementation form; data from /api/features) ---------- */
const FC_NOTE = {
  "글 지시": "프롬프트에 들어가는 글이에요. 모델이 따르도록 부탁하는 것이라 어길 수도 있어요 (권고).",
  "차단 명령": "RULES 의 deny 줄이에요. 실행 직전에 코드가 막아요 (강제).",
  "기능 폴더": "features/<id>/ 폴더 하나가 기능 하나예요. 글은 권고, deny 줄·감시 파일이 있으면 코드가 강제해요. 스위치로 켜고 꺼요.",
  "스킬": "SKILL.md 절차서예요. 모델이 필요할 때 읽고 따라요 (권고).",
  "확장": "하네스가 불러오는 코드예요. 훅으로 호출·도구 실행을 막거나 고쳐요 (강제).",
  "예약": "정해진 시각에 문장을 오케스트레이터에게 보내는 타이머예요.",
  "감시": "모델을 깨우지 않고 주기적으로 명령을 돌려 변화만 알리는 점검이에요.",
  "작업 채널 설정": "작업 채널마다 묶어 둔 로그인 유지와 감시예요.",
  "게이트웨이 기능": "게이트웨이 코드에 들어 있는 기능이에요.",
  "외부 연동": "Discord·메일(zele)·브라우저(Aside) 같은 바깥 서비스와의 연결이에요.",
  "웹 맞춤": "~/.dotz/custom 의 홈 카드·사이드바 고정·루틴이에요. 봇이 파일로 만들고 재시작 없이 바로 보여요.",
};
const FC_STR = { enforced: "강제", advisory: "권고" };
// Extensions installed for another harness are not loaded by the one running dotz: they leave every count and stage card
// and sit in one folded "이 하네스에선 꺼짐" group at the end of the list.
function fcSplit(c) { if (c && !c.off) { c.off = c.features.filter(f => f.inactive); c.features = c.features.filter(f => !f.inactive); } return c; }
const fcHarness = () => (FC && FC.harness ? FC.harness.name : "하네스");
const fcFormLabel = form => (form === "확장" ? `${fcHarness()} 확장` : form);
const fcNote = form => (form === "확장" && FC && FC.harness ? `${fcHarness()} 가 실제로 불러오는 코드예요 (${["dotz/extension", ...FC.harness.dirs].join(", ")}). 훅으로 호출·도구 실행을 막거나 고쳐요 (강제).` : FC_NOTE[form] || "");
const FC_FILE_NODE = { "RULES.md": "rules", "LESSONS.md": "lessons", "identity/IDENTITY.md": "identity" };
const fcOf = id => (FC ? FC.features.filter(f => f.stage === id) : []);
const fcDupText = f => (f.dup && f.dup.length ? `같은 일을 ${f.strength === "advisory" ? "코드(강제)" : "글(권고)"}로도 적어 뒀어요: ${f.dup.map(d => d.name).join(", ")}` : "");

function fcBadges(ids, compact) {
  if (!hFeat || !FC || hPj()) return null;
  const set = new Set([].concat(ids)), list = FC.features.filter(f => set.has(f.stage)), e = list.filter(f => f.strength === "enforced").length, a = list.length - e;
  if (!list.length) return null;
  return el("span", { class: "hm-bd", title: `여기서 작동하는 기능: 강제 ${e}개 · 권고 ${a}개` }, e ? el("span", { class: "bd f", text: compact ? String(e) : `강제 ${e}` }) : null, a ? el("span", { class: "bd a", text: compact ? String(a) : `권고 ${a}` }) : null);
}

// A switch only asks: it sends "<name> 끄기/켜기 (<source>)" to the orchestrator and keeps showing the real state until
// the catalog reports the change (the "요청 보냄" tag marks the pending request). With ui.origin_view the request also
// carries its 범위 (개인/배포); a shipped feature folder is turned off by default with a personal override
// (~/.dotz/features/<id>/ with the same id), and the switch offers the shipped repo file as an explicit second choice.
const fcCfgKey = f => (/config\.json:([\w.]+)/.exec(f.source.label) || [])[1];
const fcDirId = f => (/features\/([^/]+)\/feature\.md$/.exec(f.source.label) || [])[1];
const fcCanToggle = f => f.toggleable || (hOrigin() && f.form === "기능 폴더" && !!fcDirId(f));
function fcScopeOf(f) {
  const key = fcCfgKey(f), dir = fcDirId(f);
  if (key) return { kind: "personal", where: `config.json:${key}` };
  if (dir && f.origin === "shipped") return { kind: "personal", where: `${hData()}/features/${dir}/`, override: dir };
  return { kind: f.origin === "shipped" ? "shipped" : "personal", where: f.source.label };
}
const fcAsked = new Map();
function fcSwitch(f) {
  const ask = fcAsked.get(f.id);
  if (ask && ask.to === f.enabled) fcAsked.delete(f.id);
  const pend = fcAsked.get(f.id), word = f.enabled ? "끄기" : "켜기", def = fcScopeOf(f);
  const sw = el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(f.enabled), "aria-label": `${f.name} ${word} 요청`, title: `${botName}에게 ${word} 요청` });
  const sent = el("span", { class: "tag pri", text: pend ? `요청 보냄 · ${pend.at}` : "", hidden: !pend });
  const tag = hScopeTag(def.kind, def.where, true);
  if (tag && def.override) tag.title = `${hScope(def.kind, def.where)} · 스위치를 누르면 배포 파일 변경 요청도 고를 수 있어요`;
  const post = async choice => {
    const repo = def.override ? `features/${def.override}/feature.md` : f.source.label;
    let { kind, where } = def, text = `${f.name} ${word} (${hOrigin() && def.override ? `배포 기능 ${repo}` : f.source.label})`;
    if (hOrigin() && def.override) {
      if (choice === "shipped") { kind = "shipped"; where = repo; text += `\n배포 저장소의 ${repo} 를 직접 고쳐 주세요 (enabled: ${!f.enabled}). 모든 사용자에게 바뀌는 변경이에요.`; }
      else text += `\n${where} 에 같은 id 로 덮어쓰기: ${repo} 를 그 폴더에 복사해 enabled: ${!f.enabled} 로 두세요. 배포 저장소 파일은 건드리지 마세요.`;
    }
    const at = await hRequest(text, hScope(kind, where));
    fcAsked.set(f.id, { to: !f.enabled, at });
    sent.textContent = `요청 보냄 · ${at}`; sent.hidden = false;
  };
  sw.addEventListener("click", ev => {
    ev.stopPropagation();
    if (hOrigin() && def.override) {
      showMenu(sw, [{ value: "personal", label: "개인 설정으로 덮어쓰기 (기본)", sub: def.where }, { value: "shipped", label: "배포 파일 변경 요청", sub: `features/${def.override}/feature.md · 모든 사용자에게 바뀌어요` }], { value: "personal", onPick: v => busy(sw, () => post(v)) });
      return;
    }
    busy(sw, () => post("personal"));
  });
  return el("span", { class: "fc-sw" }, tag, sent, sw);
}

// A card opens the harness node it works in; text rules open their file editor at the line.
function fcOpenFeature(f) {
  const node = FC_FILE_NODE[f.source.file];
  if (node && f.source.line) openHSheet(node, { line: f.source.line, feature: f.id });
  else openHSheet(f.stage, { feature: f.id });
}

// What a card shows: the two-line summary in the user's language when the hub has one (its first line is the name when the
// original name is not in that language), else the original; the original text goes in the tooltip.
function fcShown(f) {
  if (!f.summary) return { name: f.name, what: f.what, tip: "" };
  const lines = f.summary.split("\n");
  return { name: f.titled ? lines[0] : f.name, what: f.titled ? lines.slice(1).join("\n") : f.summary, tip: [f.name, f.what].filter(Boolean).join("\n") };
}

function fcCard(f) {
  const node = hNode(f.stage), dup = fcDupText(f), sh = fcShown(f);
  const c = el("div", { class: `fc-card ${f.strength}${f.enabled ? "" : " off"}`, tabindex: "0", role: "button", "aria-label": `${sh.name}: ${sh.what}`, ...(sh.tip ? { title: sh.tip } : {}) },
    el("div", { class: "top" }, el("span", { class: "nm", text: sh.name }), fcCanToggle(f) ? fcSwitch(f) : null),
    sh.what ? el("div", { class: "wh", text: sh.what }) : null,
    el("div", { class: "fc-tags" },
      f.inactive ? el("span", { class: "tag", title: `${fcHarness()} 는 이 확장을 불러오지 않아요`, text: "안 불러옴" }) : el("span", { class: `tag st ${f.strength}`, title: f.strength === "enforced" ? "코드·훅·차단 줄이 막거나 실행해요" : "모델에게 따르라고 부탁한 글이에요", text: FC_STR[f.strength] }),
      el("span", { class: "tag", text: f.trigger }),
      hOrigin() && f.origin ? el("span", { class: `tag${f.origin === "personal" ? " pri" : ""}`, title: f.origin === "personal" ? "이 사용자의 파일·설정에만 있는 기능이에요 (~/.dotz, 하네스 확장 폴더)" : "dotz 와 함께 배포되는 기능이에요", text: FC_ORIGIN[f.origin] }) : null,
      node ? el("span", { class: "tag", text: node.label.replace(/\s*\(.*\)$/, "") }) : null,
      !f.enabled && !f.inactive ? el("span", { class: "tag", text: "꺼짐" }) : null,
      dup ? el("span", { class: "tag warn", title: dup, text: "중복" }) : null),
    dup ? el("div", { class: "dup", text: dup }) : null,
    el("div", { class: "src", text: [f.source.label, f.added ? `${f.added} 추가` : "", f.lastRun ? `마지막 ${kstStamp(f.lastRun)}` : ""].filter(Boolean).join(" · ") }));
  c.addEventListener("click", () => fcOpenFeature(f));
  c.addEventListener("keydown", ev => { if ((ev.key === "Enter" || ev.key === " ") && ev.target === c) { ev.preventDefault(); fcOpenFeature(f); } });
  return c;
}

const fcMatch = f => {
  const q = fcFilter.q.trim().toLowerCase();
  return (!fcFilter.form || f.form === fcFilter.form) && (!fcFilter.strength || f.strength === fcFilter.strength) && (!fcFilter.trigger || f.trigger === fcFilter.trigger) && (!fcFilter.origin || FC_ORIGIN[f.origin] === fcFilter.origin)
    && (!q || `${f.name} ${f.what} ${f.summary || ""} ${f.source.label} ${f.trigger} ${f.form} ${f.extra || ""}`.toLowerCase().includes(q));
};

function fcPaintList() {
  const all = FC.features, hit = all.filter(fcMatch), filtering = !!(fcFilter.q.trim() || fcFilter.form || fcFilter.strength || fcFilter.trigger || fcFilter.origin);
  const e = hit.filter(f => f.strength === "enforced").length;
  fcCount.textContent = `${filtering ? `${hit.length} / ${all.length}개` : `${all.length}개`} · 강제 ${e} · 권고 ${hit.length - e}`;
  clear(fcList);
  if (!hit.length) { fcList.append(emptyNode("조건에 맞는 기능이 없어요")); return; }
  for (const form of FC.forms) {
    const items = hit.filter(f => f.form === form);
    if (!items.length) continue;
    const fe = items.filter(f => f.strength === "enforced").length, shut = !filtering && fcCollapsed.has(form);
    const head = el("button", { type: "button", class: "fc-gh", "aria-expanded": String(!shut) }, icon("drop"), el("span", { text: fcFormLabel(form) }), el("span", { class: "tag", text: `${items.length}개` }),
      el("span", { class: "sup", text: `강제 ${fe} · 권고 ${items.length - fe}` }), el("div", { class: "note", text: fcNote(form) }));
    head.addEventListener("click", () => { if (filtering) return; if (fcCollapsed.has(form)) fcCollapsed.delete(form); else fcCollapsed.add(form); fcPaintList(); });
    fcList.append(head);
    if (!shut) fcList.append(el("div", { class: "fc-grid" }, ...items.map(fcCard)));
  }
  const off = (FC.off || []).filter(fcMatch);
  if (off.length) {
    const shut = fcCollapsed.has("__off");
    const head = el("button", { type: "button", class: "fc-gh", "aria-expanded": String(!shut) }, icon("drop"), el("span", { text: "이 하네스에선 꺼짐" }), el("span", { class: "tag", text: `${off.length}개` }),
      el("div", { class: "note", text: `다른 하네스 폴더에 설치돼 있지만 ${fcHarness()} 는 불러오지 않는 확장이에요. 지금은 아무것도 강제하지 않아요.` }));
    head.addEventListener("click", () => { if (fcCollapsed.has("__off")) fcCollapsed.delete("__off"); else fcCollapsed.add("__off"); fcPaintList(); });
    fcList.append(head);
    if (!shut) fcList.append(el("div", { class: "fc-grid" }, ...off.map(fcCard)));
  }
}

// The 기능 목록 shell (search + filters) is built once so typing is not interrupted by the 15 s refresh; only the list repaints.
function fcBuild(box) {
  const q = el("input", { class: "fi", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "기능 검색 (이름·내용·파일)", "aria-label": "기능 검색", value: fcFilter.q });
  q.addEventListener("input", () => { fcFilter.q = q.value; fcPaintList(); });
  const pick = (key, label, options) => {
    const val = el("span", { class: "val" });
    const b = el("button", { type: "button", class: "sel", "aria-haspopup": "listbox", "aria-expanded": "false" }, val, icon("drop"));
    const paint = () => { val.textContent = `${label}: ${fcFilter[key] || "전체"}`; b.setAttribute("aria-label", val.textContent); };
    b.addEventListener("click", () => showMenu(b, [{ value: "", label: "전체" }, ...options().map(v => ({ value: v, label: v }))], { value: fcFilter[key], onPick: v => { fcFilter[key] = v; paint(); fcPaintList(); } }));
    paint();
    return b;
  };
  const seg = el("div", { class: "seg", role: "group", "aria-label": "강제/권고" });
  for (const [v, t] of [["", "전체"], ["enforced", "강제"], ["advisory", "권고"]]) {
    const b = el("button", { type: "button", class: fcFilter.strength === v ? "on" : "", text: t });
    b.addEventListener("click", () => { fcFilter.strength = v; for (const x of seg.children) x.classList.toggle("on", x === b); fcPaintList(); });
    seg.append(b);
  }
  fcCount = el("div", { class: "sup fc-count" });
  fcList = el("div");
  box.append(el("div", { class: "sec", text: "기능 목록" }),
    el("div", { class: "sup", text: "내가 더한 기능을 구현 형식별로 모았어요. 회색으로 채운 카드(강제)는 코드가 막거나 실행하는 것, 테두리만 있는 카드(권고)는 모델에게 따르라고 부탁한 글이에요. 카드를 누르면 작동하는 자리와 파일이 열려요." }),
    el("div", { class: "fc-bar" }, q, pick("form", "형식", () => FC.forms), pick("trigger", "트리거", () => FC.triggers), hOrigin() ? pick("origin", "출처", () => Object.values(FC_ORIGIN)) : null, seg), fcCount, fcList);
}

function renderFeatures() {
  const box = hFcBox;
  if (!box) return;
  if (!FC) { clear(box); fcSig = ""; return; }
  const sig = JSON.stringify(FC.features) + (HG ? HG.nodes.map(n => n.label).join("") : "") + (hOrigin() ? "o" : "");
  if (sig === fcSig && box.firstChild) return;
  fcSig = sig;
  if (!hOrigin()) fcFilter.origin = "";
  if (fcOrig !== hOrigin()) { fcOrig = hOrigin(); clear(box); }
  if (!box.firstChild) fcBuild(box);
  fcPaintList();
}

// 상세 시트: the features that work at this node, enforced first.
function fcSheetSection(n, focusId) {
  const list = fcOf(n.id).sort((a, b) => (a.strength === b.strength ? 0 : a.strength === "enforced" ? -1 : 1));
  if (!list.length) return [];
  const e = list.filter(f => f.strength === "enforced").length;
  const rows = list.map(f => {
    const dup = fcDupText(f), jump = !!(n.file && f.source.file && f.source.line), sh = fcShown(f);
    const r = el("div", { class: `hs-ft ${f.strength}${jump ? " go" : ""}${f.id === focusId ? " on" : ""}`, "data-fid": f.id, ...(sh.tip ? { title: sh.tip } : {}) },
      el("div", { class: "top" }, el("span", { class: `tag st ${f.strength}`, text: FC_STR[f.strength] }), hOrigin() && hOwn(f) ? el("span", { class: "tag m", text: "내 기능" }) : null, el("span", { class: "nm", text: sh.name }), fcCanToggle(f) ? fcSwitch(f) : null),
      sh.what ? el("div", { class: "wh", text: sh.what }) : null,
      el("div", { class: "src", text: `${f.trigger} · ${f.source.label}` }),
      dup ? el("div", { class: "dup", text: dup }) : null);
    if (jump) r.addEventListener("click", () => hGoto && hGoto(f.source.line));
    return r;
  });
  return [el("div", { class: "sec", text: `여기서 작동하는 기능 · 강제 ${e} · 권고 ${list.length - e}` }), el("div", { class: "hs-fts" }, ...rows)];
}

$("#hs-close").append(icon("close"));
$("#hs-close").onclick = closeHSheet;
document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !$("#hsheet").hidden && !openMenu && !document.querySelector("dialog[open]")) closeHSheet(); });
H_MQ.addEventListener("change", () => { if (current === "harness") renderHarness(); });
let hW = 0;
window.addEventListener("resize", () => { if (current !== "harness" || H_MQ.matches || !hDetail) return; clearTimeout(hTimer); hTimer = setTimeout(() => { const w = $("#harness").clientWidth; if (Math.abs(w - hW) > 40) { hW = w; renderHarness(); } }, 150); });
setInterval(() => { if (current === "harness" && !document.hidden && !hLoading) loadHarness(true); }, 15000);

/* ---------- boot ---------- */
(async () => {
  const h = parseHash();
  go(h.view || "home", h.t);
  await refreshState();
  loadTarget(target); loadTodo(target); prjLoad().then(() => renderBars(), () => {});
  loadModels(true);
  loadProviderData().then(() => { if (current === "home") renderHome(); }, () => {});
  loadSubs(); loadQueue(); loadContext(true).then(renderCtxRing);
  let opened = false;
  const es = new EventSource("/api/events");
  // The browser resends the last frame id on reconnect and the gateway replays only what was missed. "reset" comes on
  // the first connect and when the gap cannot be replayed (gateway restarted, or too long away): only then refetch.
  es.onopen = () => setConn(true);
  es.addEventListener("reset", () => {
    if (opened) { refreshState(); for (const k of Object.keys(TS)) TS[k].hLoaded = TS[k].aLoaded = false; renderAll(); loadTarget(target); loadSubs(); loadQueue(); laneTailsStale(); convLoad(); }
    opened = true;
  });
  es.onerror = () => setConn(false);
  es.onmessage = m => {
    let e;
    try { e = JSON.parse(m.data); } catch { return; }
    if (e.kind === "activity") { onActivity(e); laneActivity(e); }
    else if (e.kind === "subagents") setSubs(e.source, e.items);
    else if (e.kind === "queue") { QUEUE = e.items || []; renderQueue(); }
    else if (e.kind === "notice" || e.kind === "notice_read") noticeLive(e);
    else if (e.kind === "read") convOnRead(e);
    else if (e.kind === "runtime_check") { if (rtLive) rtLive(); }
    else if (e.kind === "update_available") { if (!e.ts || Date.now() - Date.parse(e.ts) < 60_000) toast(e.text, false, { label: "보기", onclick: () => go("settings") }, 10000); if (current === "settings") loadUpdate(); }
    // 구성 (lanes node, 프로젝트) is drawn from /api/harness, not the state: reload it too when a lane starts or ends.
    else if (e.kind === "lanes") { if (e.was_live && !e.live) refreshState(); else scheduleState(); if (e.was_live !== e.live && current === "harness") loadHarness(true); }
    else {
      ingestMsg(e); scheduleState();
      // Live notices only (not the replay after a reconnect): alert / worklog posts, the gateway's own notes (sent to the web
      // when Discord is off) and lane reports float in the corner.
      const fresh = !e.ts || Date.now() - Date.parse(e.ts) < 60_000;
      const notice = e.kind === "out" && (e.target === "alert" || e.target === "worklog" || (e.target === "web" && e.source === "gateway"));
      if (fresh && (notice || e.kind === "lane_report")) notify(e);
    }
  };
  setInterval(refreshState, 15000);
  // The plan normally refetches when a todo tool call ends; this is the fallback while the open target works.
  setInterval(() => { if (current === "chat" && !document.hidden && isWorking(target)) loadTodo(target); }, 20000);
  $("#ustrip").onclick = () => go("usage");
  loadStrip(); setInterval(loadStrip, 60000);
  document.addEventListener("visibilitychange", () => { markSeen(); attnChanged(); loadStrip(); });
  setInterval(() => loadModels(true), 60000);
})();
