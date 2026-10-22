/* ---------- command palette: jump to a view or run a /command ---------- */
function openPalette() {
  if (document.querySelector("dialog.pal")) return;
  closeMenu(false);
  const inp = el("input", { class: "pal-in", type: "text", placeholder: "명령 또는 이동", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "명령" });
  const list = el("div", { class: "pal-list", role: "listbox" });
  const out = el("pre", { class: "pal-out", hidden: true });
  const d = el("dialog", { class: "pal", "aria-label": "명령" }, el("div", { class: "pal-head" }, icon("search"), inp, el("kbd", { text: "esc" })), list, out);
  let items = [], idx = 0;
  const mark = () => {
    [...list.querySelectorAll(".pal-i")].forEach((n, i) => { n.classList.toggle("on", i === idx); n.setAttribute("aria-selected", i === idx ? "true" : "false"); if (i === idx) n.scrollIntoView({ block: "nearest" }); });
  };
  const runCmd = async text => {
    list.hidden = true; out.hidden = false; out.className = "pal-out"; out.textContent = "…";
    try {
      const r = await api("/api/command", "POST", { text });
      out.textContent = String(r.output ?? "") || "✓";
      if (/^\/(model|effort|compact|restart|resume|stop|abort)\b/i.test(text)) { refreshState(); loadModels(true); loadContext(true); }
    } catch (e) { out.className = "pal-out err"; out.textContent = e.message; }
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
      for (const id of views) if (id !== "activity" && id !== "project" && (!v || titles[id].toLowerCase().includes(v) || id.includes(v))) items.push({ kind: "nav", ic: VIEW_ICON[id], label: titles[id], go: id === "chat" ? lastChatView() : id });
      // Ended lanes stay folded: one row without a query, each lane once the query names it (or "종료").
      const ended = endedLanes();
      if (ended.length && !v) items.push({ kind: "act", ic: "lanes", label: `종료된 세션 ${ended.length}`, act: () => { endedOpen = true; go("lanes"); } });
      else for (const l of ended) if (v && (l.name.toLowerCase().includes(v) || "종료된 세션".startsWith(v))) items.push({ kind: "act", ic: "lanes", label: `종료된 세션 · ${l.name}`, act: () => openTarget(`lane:${l.name}`, lastChatView()) });
      if (!v || "화면 모드 전환 라이트 다크 theme dark light".includes(v)) items.push({ kind: "act", ic: themeIc(), label: `${themeNext()} 모드로 전환`, act: toggleTheme });
    }
    idx = 0;
    clear(list);
    let last = "";
    items.forEach((it, i) => {
      const g = it.kind === "nav" ? "이동" : it.kind === "act" ? "화면" : "명령";
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
$("#pal").onclick = openPalette;
document.addEventListener("keydown", ev => { if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") { ev.preventDefault(); openPalette(); } });


function parseHash(hash = location.hash) {
  const h = hash.slice(1), i = h.indexOf("/");
  let t = i < 0 ? "" : h.slice(i + 1);
  try { t = decodeURIComponent(t); } catch {}
  return { view: i < 0 ? h : h.slice(0, i), t };
}
function go(name, tgt) {
  closeMenu(false);
  if (!views.includes(name)) name = "home";
  if (name === "project" && !tgt) name = "projects";
  // "chat/list" is the phone's chat list; any other way into 채팅 opens a conversation.
  chatList = name === "chat" && tgt === "list" && narrowChat();
  if (name === "chat" && tgt === "list") tgt = undefined;
  if (tgt && name !== "project" && tgt !== target && validTarget(tgt)) setTarget(tgt);
  if (name === "activity" && isFixedT(target)) name = "chat";   // 알림 / 작업 기록 have no terminal view
  if (name !== current) prevView = current;
  current = name;
  if (convSync()) renderAll();
  const tv = name === "chat" || name === "activity";
  if (name === "harness") hProjId = tgt && tgt.startsWith("project/") ? tgt.slice(8) : "";
  const hash = tv ? (chatList ? "chat/list" : `${name}/${target}`) : name === "harness" && hProjId ? `harness/project/${enc(hProjId)}` : name === "project" && tgt ? `project/${enc(tgt)}` : name;
  navSync(name, hash);
  for (const v of views) $(`#v-${v}`).hidden = v !== name;
  if ((name === "chat" || name === "activity") && !chatList) try { localStorage.setItem(isLaneT(target) ? `dotz-lane-view:${target}` : CHAT_MODE_KEY, name); } catch {}
  document.querySelectorAll("#nav .ni").forEach(b => { const on = b.dataset.view === navView(SUB.has(name) ? "settings" : name); b.classList.toggle("on", on); b.setAttribute("aria-current", on ? "page" : "false"); });
  $("#appbar").classList.toggle("tv", tv);
  const th = $("#thead"), mode = name === "chat" ? "chat" : "term";
  th.hidden = !tv; $("#vtog").hidden = !tv;
  if (tv && th.dataset.mode !== mode) { th.dataset.mode = mode; th.dataset.sig = ""; }
  $("#title").textContent = name === "home" ? botName : titles[name];
  convChrome();
  $("#views").scrollTop = 0; $("#appbar").classList.remove("scrolled");
  if (name === "harness") loadHarness(); else closeHSheet();
  if (tv) enterTarget();
  if (name === "home") { renderHome(); loadHomeData(); }
  if (name === "lanes") { laneSig = ""; renderLanes(); prjLoad(); }
  if (name === "projects") { renderProjects(); prjLoad(); }
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

