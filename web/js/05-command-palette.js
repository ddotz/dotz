/* ---------- command palette: jump to a view or run a /command ---------- */
// A command's answer (the card /api/command returns) in the app's own components: a status line, the facts as list rows,
// a note, and buttons that run the next command in the palette. Never a text dump.
const PAL_TONE = { ok: "완료", busy: "진행 중", warn: "주의", err: "실패" };
const PAL_LINE = /^(\/\S+)\s{2,}(.+)$/;
function palFact(f) {
  const lines = String(f.value ?? "").split("\n").filter(l => l !== "");
  const multi = lines.length > 1;
  const val = el("div", { class: "pal-v" }, ...lines.map(l => { const m = PAL_LINE.exec(l); return m ? el("div", { class: "pal-vl" }, el("code", { text: m[1] }), el("span", { text: m[2] })) : el("div", { class: "pal-vl", text: l }); }));
  return el("div", { class: `li pal-f${multi ? " multi" : ""}` }, el("div", { class: "tx" }, el("div", { class: "hd", text: f.label }), multi ? val : null), multi ? null : val);
}
function palResult(c, run) {
  const tone = c.tone || "";
  const head = el("div", { class: "pal-rh" }, el("span", { class: `dot${tone ? ` ${tone === "busy" ? "pri" : tone}` : ""}` }), el("span", { class: "pal-rt", text: c.title }), PAL_TONE[tone] ? el("span", { class: `tag ${tone === "busy" ? "pri" : tone}`, text: PAL_TONE[tone] }) : null);
  const facts = c.facts || [], acts = c.actions || [];
  return el("div", { class: `pal-res${tone === "err" ? " err" : ""}`, role: "status" }, head,
    facts.length ? el("div", { class: "list pal-facts" }, ...facts.map(palFact)) : null,
    c.note ? el("div", { class: "cc-note", text: c.note }) : null,
    acts.length ? el("div", { class: "btns cc-act" }, ...acts.map(a => el("button", { type: "button", class: "btn tonal", title: a.send, text: a.label, onclick: () => run(a.send) }))) : null);
}
function openPalette() {
  if (document.querySelector("dialog.pal")) return;
  closeMenu(false);
  const inp = el("input", { class: "pal-in", type: "text", placeholder: "도구 또는 명령", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "명령" });
  const list = el("div", { class: "pal-list", role: "listbox" });
  const out = el("div", { class: "pal-out", hidden: true });
  const d = el("dialog", { class: "pal", "aria-label": "명령" }, el("div", { class: "pal-head" }, icon("search"), inp, el("kbd", { text: "esc" })), list, out);
  let items = [], idx = 0;
  const mark = () => {
    [...list.querySelectorAll(".pal-i")].forEach((n, i) => { n.classList.toggle("on", i === idx); n.setAttribute("aria-selected", i === idx ? "true" : "false"); if (i === idx) n.scrollIntoView({ block: "nearest" }); });
  };
  const runCmd = async text => {
    list.hidden = true; out.hidden = false;
    clear(out).append(el("div", { class: "pal-res", role: "status" }, el("div", { class: "pal-rh" }, el("span", { class: "dot pri" }), el("span", { class: "pal-rt", text: "실행 중" }))));
    try {
      const r = await api("/api/command", "POST", { text });
      clear(out).append(palResult(r.card || { title: firstLine(String(r.output ?? "")) || "완료", tone: "ok", facts: [], note: String(r.output ?? "").split("\n").slice(1).join("\n").trim() }, runCmd));
      if (/^\/(model|effort|compact|restart|resume|stop|abort)\b/i.test(text)) { refreshState(); loadModels(true); loadContext(true); }
    } catch (e) { clear(out).append(palResult(e.data && e.data.card ? e.data.card : { title: "실패", tone: "err", facts: [], note: e.message }, runCmd)); }
  };
  const exec = it => { if (it.kind === "nav") { d.close(); go(it.go); } else if (it.kind === "act") { d.close(); it.act(); } else runCmd(it.run); };
  const build = () => {
    const raw = inp.value.trim(), v = raw.toLowerCase();
    items = [];
    if (v.startsWith("/")) {
      if (/\s/.test(v)) items.push({ kind: "cmd", ic: "send", label: raw, run: raw });
      else for (const [c, desc] of hintList) if (c.startsWith(v)) items.push({ kind: "cmd", ic: "chev", label: c, desc, run: c });
    } else {
      for (const [c, desc] of hintList) if (!v || c.includes(v)) items.push({ kind: "cmd", ic: "chev", label: c, desc, run: c });
      for (const id of views) if (id !== "activity" && id !== "project" && !navOff(id) && (!v || titles[id].toLowerCase().includes(v) || id.includes(v))) items.push({ kind: "nav", ic: VIEW_ICON[id], label: titles[id], desc: navKeyHint(id), go: id === "chat" ? lastChatView() : id });
      // Ended lanes stay folded: one row without a query, each lane once the query names it (or "종료").
      const ended = endedLanes();
      if (ended.length && !v) items.push({ kind: "act", ic: "lanes", label: `종료된 세션 ${ended.length}`, act: () => { endedOpen = true; go("chat", "list"); } });
      else for (const l of ended) if (v && (l.name.toLowerCase().includes(v) || "종료된 세션".startsWith(v))) items.push({ kind: "act", ic: "lanes", label: `종료된 세션 · ${l.name}`, act: () => openTarget(`lane:${l.name}`, lastChatView()) });
      if (!v || "셸 터미널 명령줄 shell terminal".includes(v)) items.push({ kind: "act", ic: "shell", label: "셸 터미널 열기", act: () => openShell() });
      if (!v || "화면 모드 전환 라이트 다크 theme dark light".includes(v)) items.push({ kind: "act", ic: themeIc(), label: `${themeNext()} 모드로 전환`, act: toggleTheme });
    }
    const rank = { nav: 0, act: 1, cmd: 2 };   // 도구 first, 명령 last; the arrow keys walk the list in this order
    items.sort((a, b) => rank[a.kind] - rank[b.kind]);
    idx = 0;
    clear(list);
    let last = "";
    items.forEach((it, i) => {
      const g = it.kind === "nav" ? "도구" : it.kind === "act" ? "화면" : "명령";
      if (g !== last) { list.append(el("div", { class: "ph", role: "presentation", text: g })); last = g; }
      list.append(el("button", { type: "button", role: "option", tabindex: "-1", class: `pal-i${it.kind === "cmd" ? " cmd" : ""}`, onmouseenter: () => { idx = i; mark(); }, onclick: () => exec(it) },
        icon(it.ic), el("span", { class: "nm", text: it.label }), it.desc ? el("span", { class: "pd", text: it.desc }) : null));
    });
    if (!items.length) list.append(el("div", { class: "a-div", text: "결과가 없어요" }));
    mark();
  };
  inp.addEventListener("input", () => { out.hidden = true; list.hidden = false; build(); });
  inp.addEventListener("keydown", ev => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "ArrowDown") { ev.preventDefault(); if (items.length) { idx = (idx + 1) % items.length; mark(); } }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); if (items.length) { idx = (idx - 1 + items.length) % items.length; mark(); } }
    else if (ev.key === "Tab") { const it = items[idx]; if (it && it.kind === "cmd") { ev.preventDefault(); inp.value = `${it.run} `; build(); } }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      const raw = inp.value.trim();
      if (raw.startsWith("/") && /\s/.test(raw)) runCmd(raw);
      else if (items[idx]) exec(items[idx]);
    }
  });
  d.addEventListener("click", ev => { if (ev.target === d) d.close(); });
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal(); dialogHist(d);
  build();
  inp.focus();
}
$("#cmdk").onclick = openPalette;
document.addEventListener("keydown", ev => { if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") { ev.preventDefault(); openPalette(); } });


function parseHash(hash = location.hash) {
  const h = hash.slice(1), i = h.indexOf("/");
  let t = i < 0 ? "" : h.slice(i + 1);
  try { t = decodeURIComponent(t); } catch {}
  return { view: i < 0 ? h : h.slice(0, i), t };
}
// The 세션 tab is gone: an old #lanes address opens the chat (its list on a phone), where running sessions sit under 진행 중.
const routeAlias = (name, tgt) => (name === "lanes" ? ["chat", "list"] : [name, tgt]);
function go(name, tgt) {
  closeMenu(false);
  [name, tgt] = routeAlias(name, tgt);
  // A mail (or any "monitoring/c:<target>") opens inside 모니터링: the chat view is drawn, the tab, the list and the address stay 모니터링's.
  const inChat = name === "chat" || name === "activity";
  let mc = false;
  if (name === "monitoring" && tgt && tgt.startsWith("c:")) { name = "chat"; tgt = tgt.slice(2); mc = true; }
  else if (inChat && (tgt ? tgt !== "list" && monOwned(tgt) : monOwned(target))) { name = "chat"; mc = true; }
  else if (inChat && !tgt && monCtx && target === monCtx) mc = true;
  monCtx = mc ? tgt || target : "";
  if (mc) { const k = monItemOf(tgt || target); if (k) MON.sel = k; MON.list = false; }
  if (!views.includes(name) || navOff(name)) name = "home";
  if (name === "projects" && ppWide()) { name = "project"; tgt = ppCur && (!PRJ || PRJ.projects.some(p => p.key === ppCur)) ? ppCur : "builtin:custom"; }
  if (name === "project" && !tgt) name = "projects";
  if (name === "project") ppCur = tgt;
  if (name === "monitoring") monRoute(tgt);
  // "chat/list" is the phone's chat list; any other way into 채팅 opens a conversation.
  chatList = name === "chat" && tgt === "list" && narrowChat();
  if (name === "chat" && tgt === "list") tgt = undefined;
  if (tgt && name !== "project" && tgt !== target && validTarget(tgt)) setTarget(tgt);
  if (name === "activity" && (!LOG_VIEW || isFixedT(target))) name = "chat";   // 알림 / 작업 기록 have no terminal view; LOG_VIEW off: no log view at all
  if (name !== current) prevView = current;
  current = name;
  if (name === "apps") appsOpen(tgt);   // after current is set: appsRender draws only the shown 앱 tab
  if (convSync()) renderAll();
  const tv = name === "chat" || name === "activity";
  if (name === "harness") hProjId = tgt && tgt.startsWith("project/") ? tgt.slice(8) : "";
  const hash = tv ? (chatList ? "chat/list" : mc ? `monitoring/c:${enc(target)}` : `${name}/${target}`) : name === "harness" && hProjId ? `harness/project/${enc(hProjId)}` : name === "project" && tgt ? `project/${enc(tgt)}` : name === "monitoring" ? monHash() : name === "apps" ? appsHash() : name;
  navSync(name, hash);
  const pp = name === "project" && ppWide();
  for (const v of views) $(`#v-${v}`).hidden = v !== name && !(pp && v === "projects");
  $("#views").classList.toggle("pp", pp);
  if ((name === "chat" || name === "activity") && !chatList) try { localStorage.setItem(isLaneT(target) ? `dotz-lane-view:${target}` : CHAT_MODE_KEY, name); } catch {}
  document.querySelectorAll("#nav .ni").forEach(b => { const on = b.dataset.view === navView(SUB.has(name) ? "settings" : mc ? "monitoring" : name); b.classList.toggle("on", on); b.setAttribute("aria-current", on ? "page" : "false"); });
  $("#appbar").classList.toggle("tv", tv);
  const th = $("#thead"), mode = name === "chat" ? "chat" : "term";
  th.hidden = !tv; $("#vtog").hidden = !tv || !LOG_VIEW;
  if (tv && th.dataset.mode !== mode) { th.dataset.mode = mode; th.dataset.sig = ""; }
  if (MT_READY) mailThreadSync();   // the same-sender mail panel belongs to the mail conversation that is open (30-mail-thread.js)
  $("#title").textContent = name === "home" ? botName : titles[name];
  convChrome();
  $("#views").scrollTop = 0; $("#appbar").classList.remove("scrolled");
  if (name === "harness") loadHarness(); else closeHSheet();
  if (tv) enterTarget();
  if (name === "home") { renderHome(); loadHomeData(); }
  if (name === "projects" || pp) { renderProjects(); prjLoad(); }
  if (name === "monitoring" || mc) { renderMonitoring(); loadMonitors(); loadNotices(); loadIntegrations(); }
  if (name === "project") pmOpen(tgt);
  if (name === "settings") { loadUpdate(); loadAccounts(); renderSettings(); loadProviderData().then(() => current === "settings" && renderSettings(), () => {}); loadRuntimes(); }
  if (name === "models") { renderModels(); loadModels(); loadProviderData().then(() => current === "models" && renderModels(), () => {}); }
  if (name === "providers") loadProviders();
  if (name === "usage") loadQuota();
  if (name === "context") loadContext();
  window.dotzCustom && dotzCustom.view(name, tgt);
}
// Entries the app made are handled by popstate; this is for a hash typed into the address bar or an old foreign entry.
window.addEventListener("hashchange", () => { if (history.state && history.state.dz) return; const h = parseHash(); go(h.view, h.t); });

/* ---------- shared bits ---------- */
const limitFrac = l => l.limit ? Math.max(0, Math.min(1, l.remaining != null ? l.remaining / l.limit : 1 - (l.used || 0) / l.limit)) : null;
function limitTone(l) {
  const st = String(l.status || "").toLowerCase(), f = limitFrac(l);
  if (/exhaust|reach|over|critical|block|deni|limit_hit|full/.test(st) || (f != null && f <= .1)) return "err";
  if (/warn|low|near|high/.test(st) || (f != null && f <= .3)) return "warn";
  return "";
}
const bar = l => { const f = limitFrac(l); return f == null ? null : el("div", { class: `bar ${limitTone(l)}`, role: "progressbar", "aria-valuenow": Math.round(f * 100), "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${(f * 100).toFixed(1)}%` })); };
const pctText = l => { const f = limitFrac(l); return f == null ? "–" : `${Math.round(f * 100)}% 남음`; };
// "Claude 5 Hour" -> "5시간", "Claude 7 Day" -> "7일", "Claude 7 Day (Opus)" -> "주간 Opus" (the label comes from the provider in English; ids stay as they are).
const limitKo = s => String(s).replace(/^Claude\s+/i, "").replace(/^7\s*Day\s*\((.+)\)$/i, "주간 $1").replace(/(\d+)\s*Hours?\b/i, "$1시간").replace(/(\d+)\s*Days?\b/i, "$1일");
const limitLabel = (p, l, multi) => `${multi ? `${providerName(p.provider)} · ` : ""}${limitKo(l.label || l.id)}`;
const isConnected = p => p.auth && p.auth !== "none";
const needsAttention = p => p.in_use && !isConnected(p);
const emptyNode = t => el("div", { class: "card empty", text: t });

