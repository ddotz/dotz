/* ---------- a relayed computer's other screens: its last snapshot, read-only (hub/relay-snapshot.ts, docs/messengers/jandi.ko.md 8) ---------- */
// A computer reached only through a messenger has no gateway to ask, so while it is the chosen one (RELAY.cur, 42-relay-chat.js relayPaint) 홈, 프로젝트 and
// 모니터링 draw what it last posted about itself instead of this computer's data: GET /api/relay/<adapter>/<key>/status -> {snapshot, received_at?}, kept per
// target in RV.by and read again every 30s while one of those screens is visible. 설정 (and its pages) give way to one note. Nothing here changes anything:
// the only buttons open that computer's chat. Each render function of those screens asks rvPaint(name) first and stops when it returns true.
// The drawing goes into a `.rv` child of the screen's section and `.rv-on` hides the section's own children (css/11-relay-views.css), so leaving the
// mode is removing the child: the screen's own markup was never touched.
// Function declarations, not arrows: 33-peers.js, 42-relay-chat.js and the render functions call these before a const of this file exists.
const RV_POLL_MS = 30_000, RV_FRESH_MS = 10_000;
const RV_SCREENS = { home: 1, projects: 1, monitoring: 1, settings: 1 };
const RV = { by: {} };

/** The relay target shown as THE computer right now: its chat on screen, or a snapshot screen opened from it. "" for this computer. */
function relayCur() { return relayOn() ? target : RELAY.cur; }

async function rvLoad(t, quiet) {
  const c = RV.by[t] || (RV.by[t] = { snap: null, rcv: 0, at: 0, loaded: false, err: "", flight: null });
  if (c.flight) return c.flight;
  c.flight = (async () => {
    try {
      const r = await api(`${relayApi(t)}/status`);
      c.snap = r && r.snapshot ? r.snapshot : null; c.rcv = (r && r.received_at) || 0; c.err = "";
    } catch (e) { c.err = e.message; }
    c.loaded = true; c.at = Date.now();
  })().finally(() => { c.flight = null; });
  await c.flight;
  if (relayCur() === t) rvRefresh();
}
function rvRefresh() {
  const draw = { home: renderHome, projects: renderProjects, monitoring: renderMonitoring, settings: renderSettings }[current];
  if (draw) draw();
}
const rvTick = () => { const t = relayCur(); if (t && !document.hidden && RV_SCREENS[current]) rvLoad(t, true); };
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

/** Choose a relay computer from outside its chat (the 프로젝트 list's computer group) and show it on `view`. */
function relayShow(t, name, view) {
  RELAY.name[t] = name;
  if (!isRelayT(target)) RELAY.back = target;
  RELAY.cur = t;
  if (target !== t) setTarget(t, true);
  go(view);
}
function relayOpenChat(t) { go("chat", t); relayLoad(t, true); }

function rvWhen(c) {
  const at = (c.snap && c.snap.at) || c.rcv;
  return at ? prjAgo(at) : "";
}
// The sender's times are ISO strings: a past one reads as "N분 전", a coming one as its clock time; anything else is shown as sent.
function rvTime(v) {
  const ms = Date.parse(v);
  if (!v || Number.isNaN(ms)) return v || "";
  return ms > Date.now() ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : prjAgo(ms);
}
const rvDotTone = tone => (/^(ask|warn|need)/.test(tone) ? "warn" : /^(err|fail)/.test(tone) ? "err" : /^(ok|done)/.test(tone) ? "ok" : "");

function rvBody(name, t, c) {
  const who = targetName(t);
  if (name === "settings") return [el("div", { class: "card empty rv-off" }, el("div", { text: TX("relay.settings_off") }),
    el("div", { class: "rv-acts" },
      el("button", { class: "btn tonal sm", type: "button", "data-k": "relay-chat", onclick: () => relayOpenChat(t), text: TX("relay.open_chat") }),
      el("button", { class: "btn text sm", type: "button", "data-k": "relay-leave", onclick: () => relayLeave(), text: TX("relay.back_here") })))];
  if (!c.loaded) return [emptyNode(TX("relay.loading"))];
  if (c.err && !c.snap) return [emptyNode(TX("relay.failed"), () => rvLoad(t))];
  if (!c.snap) return [el("div", { class: "card empty rv-none" }, el("div", { text: TX("relay.none_title", { name: who }) }), el("div", { class: "sup", text: TX("relay.none_hint") })), rvFoot(t, null)];
  const s = c.snap;
  const head = el("div", { class: "rv-head" }, name === "home" ? null : el("span", { class: "rv-n", text: who }), el("span", { class: "sup", text: TX("relay.updated", { when: rvWhen(c) }) }));
  const body = name === "projects" ? rvProjects(s) : name === "monitoring" ? rvMonitors(s) : rvHome(s);
  return [head, ...body, rvFoot(t, s)];
}

function rvFoot(t, s) {
  return el("div", { class: "rv-foot" },
    s && s.cut ? el("div", { class: "sup", text: TX("relay.cut") }) : null,
    el("div", { class: "sup", text: TX("relay.readonly") }),
    el("button", { class: "btn tonal sm", type: "button", "data-k": "relay-chat", onclick: () => relayOpenChat(t), text: TX("relay.open_chat") }));
}

const rvLine = text => el("div", { class: "empty rv-empty", text });
function rvSession(x) {
  const tone = x.waiting ? "warn" : x.live ? "pri" : "", sub = [x.title ? x.name : "", rvTime(x.at)].filter(Boolean).join(" · ");
  return el("div", { class: "hr rv-row" },
    el("span", { class: `dot ${tone}` }),
    el("span", { class: "hb" }, el("span", { class: "hn1" }, el("span", { class: "nm", text: x.title || x.name })), sub ? el("span", { class: "ha", text: sub }) : null),
    x.status ? el("span", { class: `hs ${tone}`, text: x.status }) : null);
}
function rvHome(s) {
  const nodes = [el("div", { class: "sec", text: TX("relay.sessions") }), el("div", { class: "list" }, ...(s.sessions.length ? s.sessions.map(rvSession) : [rvLine(TX("relay.no_sessions"))]))];
  const todo = s.todos || { open: 0, items: [] }, more = todo.open - todo.items.length;
  nodes.push(el("div", { class: "sec", text: todo.open ? TX("relay.todos", { n: todo.open }) : TX("relay.todos_title") }));
  nodes.push(el("div", { class: "list" }, ...(todo.items.length || more > 0
    ? [...todo.items.map(x => el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "hd", text: x })))), more > 0 ? el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: TX("relay.todo_more", { n: more }) }))) : null]
    : [rvLine(TX("relay.no_todos"))])));
  if (s.notices.length) {
    nodes.push(el("div", { class: "sec", text: TX("relay.notices") }));
    nodes.push(el("div", { class: "list" }, ...s.notices.map(n => el("div", { class: "li" },
      el("span", { class: `dot ${rvDotTone(n.tone)}` }),
      el("span", { class: "tx" }, el("div", { class: "hd", text: n.title }), n.at ? el("div", { class: "sup", text: rvTime(n.at) }) : null)))));
  }
  return nodes;
}
function rvProjects(s) {
  if (!s.projects.length) return [emptyNode(TX("relay.no_projects"))];
  return [el("div", { class: "pl-list" }, ...s.projects.map(p => el("div", { class: "pl-row rv-row", "data-key": p.key },
    el("span", { class: "ico" }, icon("projects")),
    el("span", { class: "pl-b" }, el("span", { class: "pl-1" }, el("span", { class: "pl-n", text: p.name })), p.note ? el("span", { class: "pl-s" }, el("span", { class: "pl-sw", text: p.note })) : null),
    p.live > 0 ? el("span", { class: "li-end" }, el("span", { class: "tag pri", text: TX("relay.live", { n: p.live }) })) : null)))];
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
