/* ---------- a relayed computer's other screens: its last snapshot, read-only (hub/relay-snapshot.ts, docs/messengers/jandi.ko.md 8) ---------- */
// A computer reached only through a messenger has no gateway to ask, so while it is the chosen one (RELAY.cur, 42-relay-chat.js relayPaint) 홈, 프로젝트 and
// 모니터링 draw what it last posted about itself instead of this computer's data: GET /api/relay/<adapter>/<key>/status -> {snapshot, received_at?}, kept per
// target in RV.by and read again every 30s while one of those screens is visible. 설정 (and its pages) give way to one note. Nothing here changes anything:
// its buttons open that computer's chat, or one of its projects' chats (relayOpenProject). Each render function of those screens asks rvPaint(name) first and stops when it returns true.
// The drawing goes into a `.rv` child of the screen's section and `.rv-on` hides the section's own children (css/11-relay-views.css), so leaving the
// mode is removing the child: the screen's own markup was never touched.
// Function declarations, not arrows: 33-peers.js, 42-relay-chat.js and the render functions call these before a const of this file exists.
const RV_POLL_MS = 30_000, RV_FRESH_MS = 10_000;
const RV = { by: {} };

/** The relay target shown as THE computer right now: its chat on screen, or a snapshot screen opened from it. "" for this computer. */
function relayCur() { return relayOn() ? relayPc(target) : RELAY.cur; }

async function rvLoad(t, quiet) {
  const c = RV.by[t] || (RV.by[t] = { snap: null, rcv: 0, at: 0, loaded: false, err: "", flight: null });
  if (c.flight) return c.flight;
  c.flight = (async () => {
    try {
      const r = await api(`${relayApi(t)}/status`);
      c.snap = r && r.snapshot ? r.snapshot : null; c.rcv = (r && r.received_at) || 0; c.err = "";
      for (const p of c.snap ? c.snap.projects : []) if (p.chat) relayProjT(t, p);   // its projects' chats are named before one of them is drawn
    } catch (e) { c.err = e.message; }
    c.loaded = true; c.at = Date.now();
  })().finally(() => { c.flight = null; });
  await c.flight;
  if (relayCur() === t) rvRefresh();
}
// How each relay screen (the SCREENS relay column, RELAY_VIEWS) draws itself again; hub/relay-views-web.test.ts keeps the keys equal to that column.
const rvDraw = () => ({ home: renderHome, projects: renderProjects, monitoring: renderMonitoring, settings: renderSettings, chat: () => { convRepaint(); } });
function rvRefresh() {
  const draw = rvDraw()[current];
  if (draw) draw();
}
const rvTick = () => { const t = relayCur(); if (t && !document.hidden && RELAY_VIEWS.has(current)) rvLoad(t, true); };
setInterval(rvTick, RV_POLL_MS);
document.addEventListener("visibilitychange", rvTick);

// The screen `name` (when it is the one shown): drawn from the snapshot, true; or this computer's own, false (a leftover drawing is taken away first).
function rvPaint(name) {
  const sec = $(`#v-${name}`);
  if (!sec || current !== name) return false;
  const t = relayCur();
  if (!t) {
    if (sec.classList.contains("rv-on")) { sec.classList.remove("rv-on"); const old = sec.querySelector(":scope > .rv"); if (old) old.remove(); }
    return false;
  }
  const c = RV.by[t] || (RV.by[t] = { snap: null, rcv: 0, at: 0, loaded: false, err: "", flight: null });
  if (name !== "settings" && !c.flight && Date.now() - c.at > RV_FRESH_MS) rvLoad(t, true);
  sec.classList.add("rv-on");
  let node = sec.querySelector(":scope > .rv");
  if (!node) { node = el("div", { class: "rv" }); sec.append(node); }
  const sig = JSON.stringify([name, t, RELAY.name[t], c.loaded, c.err, c.snap, c.rcv, rvWhen(c)]);
  if (node.dataset.sig !== sig) { node.dataset.sig = sig; clear(node).append(...rvBody(name, t, c)); }
  if (name === "home") $("#title").textContent = targetName(t);
  return true;
}

// The chat list (31-conversations.js convRows: the side list beside a chat, the 채팅 list on a phone) while that computer is chosen: its own chat first, then
// its live sessions (each opening its read-only 홈) and its projects from its snapshot, each opening that project's chat (a conversation row, so it splits
// like any other). Never this computer's conversations, not even before the snapshot is in.
function rvConvRows(t) {
  const c = RV.by[t] || (RV.by[t] = { snap: null, rcv: 0, at: 0, loaded: false, err: "", flight: null });
  if (!c.flight && Date.now() - c.at > RV_FRESH_MS) rvLoad(t, true);
  const who = targetName(t), show = view => () => relayShow(t, who, view);
  const rows = [{ t, name: who, hint: RELAY.note[t] || "", open: () => relayOpenChat(t) }];
  const s = c.snap;
  if (!s) return [...rows, { split: true }, { empty: !c.loaded ? TX("relay.loading") : c.err ? TX("relay.failed") : TX("relay.conv_none", { name: who }) }];
  const av = ic => el("span", { class: "cv-av", "aria-hidden": "true" }, icon(ic));
  const live = s.sessions.filter(x => x.live);
  if (live.length) rows.push({ header: TX("home.sys.running"), sec: true }, ...live.map(x => ({ k: `rv:s:${x.name}`, name: x.title || x.name, hint: x.waiting ? "" : x.status, last: x.at ? { ts: x.at } : null, av: av("lanes"), chips: x.waiting ? [[x.status, "warn"]] : undefined, open: show("home") })));
  if (s.projects.length) rows.push({ header: TX("common.projects"), sec: true }, ...s.projects.map(p => ({ k: `rv:p:${p.key}`, name: p.name, hint: p.note || "", av: av("projects"), chips: p.live > 0 ? [[TX("relay.live", { n: p.live }), "pri"]] : undefined, open: () => relayOpenProject(t, p) })));
  if (!live.length && !s.projects.length) rows.push({ split: true }, { empty: TX("relay.no_sessions") });
  return rows;
}

/** Choose a relay computer from outside its chat (the 프로젝트 list's computer group) and show it on `view`, or open the chat of `project` (one of its
 *  projects, found again in its snapshot by key, which is what carries the chat tag). */
async function relayShow(t, name, view, project) {
  relayPick(t, name);
  if (!project) {
    if (target !== t) setTarget(t, true);
    go(view);
    return;
  }
  if (!(RV.by[t] && RV.by[t].loaded)) await rvLoad(t, true);
  const s = RV.by[t].snap;
  relayOpenProject(t, (s && s.projects.find(p => p.key === project.key)) || project);
}
function relayOpenChat(t) { go("chat", t); relayLoad(t, true); }
// A project of a computer whose dotz does not read a line addressed to it yet (no chat tag in its snapshot) is asked about in that computer's chat.
function relayOpenProject(t, p) {
  if (!p.chat) { relayOpenChat(t); return; }
  relayOpenChat(relayProjT(t, p));
}

function rvWhen(c) {
  const at = (c.snap && c.snap.at) || c.rcv;
  return at ? prjAgo(at) : "";
}
// The sender's times are ISO strings: a past one reads as "N분 전", a coming one as its clock time; anything else is shown as sent.
function rvTime(v) {
  const ms = Date.parse(v);
  if (!v || Number.isNaN(ms)) return v || "";
  return ms > Date.now() ? new Date(ms).toLocaleTimeString(document.documentElement.lang || undefined, { hour: "2-digit", minute: "2-digit" }) : prjAgo(ms);
}
const rvDotTone = tone => (/^(ask|warn|need)/.test(tone) ? "warn" : /^(err|fail)/.test(tone) ? "err" : /^(ok|done)/.test(tone) ? "ok" : "");

function rvBody(name, t, c) {
  const who = targetName(t);
  if (name === "settings") return [emptyNode(TX("relay.settings_off"), null, { more: [el("div", { class: "rv-acts" },
    el("button", { class: "btn tonal sm", type: "button", "data-k": "relay-chat", onclick: () => relayOpenChat(t), text: TX("relay.open_chat") }),
    el("button", { class: "btn text sm", type: "button", "data-k": "relay-leave", onclick: () => relayLeave(), text: TX("relay.back_here") }))] })];
  if (!c.loaded) return [emptyNode(TX("relay.loading"))];
  if (c.err && !c.snap) return [emptyNode(TX("relay.failed"), () => rvLoad(t))];
  if (!c.snap) return [emptyNode(TX("relay.none_title", { name: who }), null, { more: [el("div", { class: "sup", text: TX("relay.none_hint") })] }), rvFoot(t, null)];
  const s = c.snap;
  const head = el("div", { class: "rv-head" }, name === "home" ? null : el("span", { class: "rv-n", text: who }), el("span", { class: "sup", text: TX("relay.updated", { when: rvWhen(c) }) }));
  const body = name === "projects" ? rvProjects(t, s) : name === "monitoring" ? rvMonitors(s) : rvHome(s);
  return [head, ...body, rvFoot(t, s)];
}

function rvFoot(t, s) {
  return el("div", { class: "rv-foot" },
    s && s.cut ? el("div", { class: "sup", text: TX("relay.cut") }) : null,
    el("div", { class: "sup", text: TX("relay.readonly") }),
    el("button", { class: "btn tonal sm", type: "button", "data-k": "relay-chat", onclick: () => relayOpenChat(t), text: TX("relay.open_chat") }));
}

function rvSession(x) {
  const tone = x.waiting ? "warn" : x.live ? "pri" : "", sub = [x.title ? x.name : "", rvTime(x.at)].filter(Boolean).join(" · ");
  return el("div", { class: "hr rv-row" },
    el("span", { class: `dot ${tone}` }),
    el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: x.title || x.name })), sub ? el("span", { class: "ha", text: sub }) : null),
    x.status ? el("span", { class: `hs ${tone}`, text: x.status }) : null);
}
function rvHome(s) {
  const nodes = [el("div", { class: "sec", text: TX("relay.sessions") }), s.sessions.length ? el("div", { class: "list" }, ...s.sessions.map(rvSession)) : emptyNode(TX("relay.no_sessions"), null, { compact: true })];
  const todo = s.todos || { open: 0, items: [] }, more = todo.open - todo.items.length;
  nodes.push(el("div", { class: "sec", text: todo.open ? TX("relay.todos", { n: todo.open }) : TX("relay.todos_title") }));
  nodes.push(todo.items.length || more > 0
    ? el("div", { class: "list" }, ...todo.items.map(x => el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "hd", text: x })))), more > 0 ? el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: TX("relay.todo_more", { n: more }) }))) : null)
    : emptyNode(TX("relay.no_todos"), null, { compact: true }));
  if (s.notices.length) {
    nodes.push(el("div", { class: "sec", text: TX("relay.notices") }));
    nodes.push(el("div", { class: "list" }, ...s.notices.map(n => el("div", { class: "li" },
      el("span", { class: `dot ${rvDotTone(n.tone)}` }),
      el("span", { class: "tx" }, el("div", { class: "hd", text: n.title }), n.at ? el("div", { class: "sup", text: rvTime(n.at) }) : null)))));
  }
  return nodes;
}
function rvProjects(t, s) {
  if (!s.projects.length) return [emptyNode(TX("relay.no_projects"))];
  return [el("div", { class: "pl-list" }, ...s.projects.map(p => el("button", { class: "pl-row", type: "button", "data-key": p.key, "aria-label": [p.name, TX("project.open")].join(" · "), onclick: () => relayOpenProject(t, p) },
    el("span", { class: "ico" }, icon("projects")),
    el("span", { class: "pl-b" }, el("span", { class: "pl-1" }, el("span", { class: "pl-n", text: p.name })), p.note ? el("span", { class: "pl-s" }, el("span", { class: "pl-sw", text: p.note })) : null),
    el("span", { class: "li-end" }, p.live > 0 ? el("span", { class: "tag pri", text: TX("relay.live", { n: p.live }) }) : null, icon("chev", "chev")))))];
}
function rvMonitor(m) {
  const key = m.conn === "disconnected" ? "disconnected" : m.paused ? "off" : m.result || "", tag = MON_PTAG[key], times = [m.last ? TX("relay.mon_last", { when: rvTime(m.last) }) : "", m.next ? TX("relay.mon_next", { when: rvTime(m.next) }) : ""].filter(Boolean).join(" · ");
  return el("div", { class: "hr rv-row" },
    el("span", { class: `dot ${tag ? tag[1] : ""}` }),
    el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: m.name })), m.summary ? el("span", { class: "ha", text: m.summary }) : null, times ? el("span", { class: "ha", text: times }) : null),
    tag ? el("span", { class: `hs ${tag[1]}`, text: tag[0] }) : null);
}
function rvMonitors(s) {
  return s.monitors.length ? [el("div", { class: "list" }, ...s.monitors.map(rvMonitor))] : [emptyNode(TX("relay.no_monitors"))];
}
