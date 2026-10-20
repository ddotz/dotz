/* ---------- notification bell: the one hub for 알림, 작업내역 and 모니터링 (header bell, unread badge, tabbed panel) ---------- */
// Data: GET /api/notices, POST /api/notices/read, GET /api/monitors; live frames {kind:"notice"} / {kind:"notice_read"} from the event stream
// (routed here by 29-harness-features.js, never into the chat timeline or the corner toasts).
// Panel: a popover under the bell from 700px up, a full-height sheet below it (same breakpoint as 09-notices.css).
// Tabs: 알림 = alert + result, 작업내역 = worklog, 모니터링 = watch (watch and schedule runs); 전체 = everything, grouped by kind.
const NT_TABS = [["all", "전체"], ["alert", "알림"], ["worklog", "작업내역"], ["watch", "모니터링"]];
const NT_TAB_KEY = "dotz-notice-tab";
const ntTabOf = n => n.kind === "worklog" ? "worklog" : n.kind === "watch" ? "watch" : "alert";
const NT = { items: [], unread: 0, loaded: false, failed: false, open: false, tab: (() => { try { const v = localStorage.getItem(NT_TAB_KEY); if (NT_TABS.some(t => t[0] === v)) return v; } catch {} return "all"; })() };
// The monitor list under the 모니터링 tab and in the home card.
const NM = { items: [], loaded: false, failed: false };
const NT_GROUPS = [["result", "결과 보고"], ["alert", "알림"], ["worklog", "작업로그"], ["watch", "감시·예약"]];
const NT_RESULT = { ok: ["정상", "done"], changed: ["바뀜", "ask"], fail: ["실패", "fail"] };
const ntUnreadIn = tab => NT.items.reduce((c, n) => c + (!n.read && (tab === "all" || ntTabOf(n) === tab) ? 1 : 0), 0);
const NT_READ_MAX = 30;
const ntWide = matchMedia("(min-width: 700px)");
let ntPanel = null;

const ntAt = n => Date.parse(n.updated || n.ts) || 0;
const ntTime = t => kstDay(t) === kstDay(Date.now()) ? kstHM(t) : `${dayLabel(t)} ${kstHM(t)}`;
const ntWhen = n => ntTime(n.updated || n.ts);
// Row text is plain: markdown marks (links, headings, bullets, emphasis, code) are dropped.
const ntPlain = s => String(s ?? "")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
  .replace(/\*+|~~|`+/g, "")
  .replace(/(^|\s)_+([^_\s][^_]*)_+(?=\s|$)/g, "$1$2")
  .replace(/\s+/g, " ").trim();

function paintBell() {
  const b = $("#bell"), n = $("#bell-n"), c = Math.max(0, NT.unread | 0);
  n.hidden = c === 0;
  n.textContent = c > 99 ? "99+" : String(c);
  b.setAttribute("aria-label", c ? `알림, 안 읽은 알림 ${c > 99 ? "99개 이상" : `${c}개`}` : "알림");
}

async function loadNotices() {
  try {
    const r = await api("/api/notices?limit=100");
    NT.items = Array.isArray(r.items) ? r.items : [];
    NT.unread = r.unread | 0; NT.loaded = true; NT.failed = false;
  } catch { NT.failed = !NT.loaded; }
  paintBell();
  if (NT.open) renderNotices();
  homeSoon();
}

async function loadMonitors() {
  try {
    const r = await api("/api/monitors");
    NM.items = Array.isArray(r.items) ? r.items : [];
    NM.loaded = true; NM.failed = false;
  } catch { NM.failed = !NM.loaded; }
  if (NT.open && NT.tab === "watch") renderNotices();
  homeSoon();
}
// Failed ones first, then the soonest next run.
const ntMons = () => NM.items.slice().sort((a, b) => (b.last_result === "fail") - (a.last_result === "fail") || (Date.parse(a.next_run) || Infinity) - (Date.parse(b.next_run) || Infinity));
const ntMonRun = m => m.last_run ? `마지막 ${ntTime(m.last_run)}` : "아직 실행 전이에요";
const ntMonNext = m => m.next_run ? `다음 ${ntTime(m.next_run)}` : "";

// /api/state carries notices_unread: a count that disagrees with ours means a frame was missed, so refetch.
function ntSync(s) {
  if (!s || typeof s.notices_unread !== "number" || s.notices_unread === NT.unread) return;
  NT.unread = s.notices_unread; paintBell(); loadNotices();
}

function noticeLive(e) {
  if (e.kind === "notice" && e.item && e.item.id != null) {
    const i = NT.items.findIndex(x => x.id === e.item.id);
    if (i < 0) NT.items.push(e.item); else NT.items[i] = e.item;
    if (e.item.kind === "watch") loadMonitors();
  } else if (e.kind === "notice_read") {
    const ids = new Set(e.ids || []);
    for (const n of NT.items) if (e.all || ids.has(n.id)) n.read = true;
  }
  if (typeof e.unread === "number") NT.unread = e.unread;
  paintBell();
  if (NT.open) renderNotices();
  homeSoon();
}

async function ntMarkRead(body) {
  try {
    const r = await api("/api/notices/read", "POST", body);
    if (r && typeof r.unread === "number") { NT.unread = r.unread; paintBell(); if (NT.open) renderNotices(); }
  } catch (err) { toast(err.message, true); loadNotices(); }
}

function ntNavigate(open) {
  const t = String(open || "main");
  if (t === "main") { openTarget(MAIN, "chat"); return; }
  if (isLaneT(t)) {
    if (S && !S.lanes.some(l => `lane:${l.name}` === t)) { toast("이 세션은 이미 끝났어요"); go("lanes"); return; }
    openTarget(t, "chat"); return;
  }
  if (isProjT(t)) {
    if (S && !projTargets().includes(t)) { toast("이 프로젝트를 찾을 수 없어요"); go("projects"); return; }
    openTarget(t, "chat"); return;
  }
  go("home");
}

function openNotice(n) {
  closeNotices(false);
  if (!n.read) { n.read = true; NT.unread = Math.max(0, NT.unread - 1); paintBell(); ntMarkRead({ ids: [n.id] }); }
  ntNavigate(n.open);
}

function ntRow(n) {
  const un = !n.read, text = ntPlain(n.text);
  return el("button", { type: "button", class: `nt-row${un ? " un" : ""}`, "data-id": String(n.id), onclick: () => openNotice(n) },
    el("span", { class: `nt-dot tone-${n.tone || "none"}`, "aria-hidden": "true" }),
    el("span", { class: "nt-b" },
      el("span", { class: "nt-t", text: ntPlain(n.title) || "알림" }),
      text ? el("span", { class: "nt-x", text }) : null,
      el("span", { class: "nt-m", text: ntWhen(n) })),
    un ? el("span", { class: "nt-un", role: "img", "aria-label": "안 읽음" }) : null);
}

function ntMonRow(m) {
  const [word, tone] = m.last_result ? NT_RESULT[m.last_result] || ["", "none"] : ["", "none"];
  const run = [ntMonRun(m), word].filter(Boolean).join(" · "), next = [ntMonNext(m), m.every].filter(Boolean).join(" · ");
  const kids = [el("span", { class: `nt-dot tone-${tone}`, "aria-hidden": "true" }),
    el("span", { class: "nt-b" }, el("span", { class: "nt-t", text: ntPlain(m.name) || "감시" }), el("span", { class: "nt-x", text: run }), next ? el("span", { class: "nt-m", text: next }) : null)];
  return m.channel && isProjT(m.channel) ? el("button", { type: "button", class: "nt-row nt-mon", onclick: () => { closeNotices(false); ntNavigate(m.channel); } }, ...kids) : el("div", { class: "nt-row nt-mon" }, ...kids);
}

function ntMonSection() {
  const sec = el("section", { class: "nt-grp" }, el("h3", { class: "nt-gh", text: "감시·예약 현황" }));
  if (!NM.loaded) sec.append(el("div", { class: "nt-empty nt-empty-s", text: NM.failed ? "불러오지 못했어요" : "불러오는 중…" }));
  else if (!NM.items.length) sec.append(el("div", { class: "nt-empty nt-empty-s", text: "감시 중인 것이 없어요" }));
  else sec.append(ntMons().map(ntMonRow));
  return sec;
}

function ntPaintTabs() {
  for (const b of ntPanel.querySelectorAll(".nt-tabs button")) {
    const id = b.dataset.tab, c = id === "all" ? NT.unread : ntUnreadIn(id), on = id === NT.tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    const n = $(".nt-c", b);
    n.hidden = c <= 0;
    n.textContent = c > 99 ? "99+" : String(c);
    b.setAttribute("aria-label", c > 0 ? `${b.dataset.label}, 안 읽음 ${c}개` : b.dataset.label);
  }
}

function ntSetTab(id) {
  if (!NT_TABS.some(t => t[0] === id)) id = "all";
  const changed = NT.tab !== id;
  NT.tab = id;
  try { localStorage.setItem(NT_TAB_KEY, id); } catch {}
  if (!NT.open) return;
  renderNotices();
  if (changed) $(".nt-body", ntPanel).scrollTop = 0;
  if (id === "watch") loadMonitors();
}

// "모두 읽음" applies to the tab you are on: the other tabs keep their unread items.
function ntReadAll() {
  if (NT.tab === "all") {
    for (const n of NT.items) n.read = true;
    NT.unread = 0; paintBell(); renderNotices(); ntMarkRead({ all: true });
    return;
  }
  const hit = NT.items.filter(n => !n.read && ntTabOf(n) === NT.tab);
  if (!hit.length) return;
  for (const n of hit) n.read = true;
  NT.unread = Math.max(0, NT.unread - hit.length); paintBell(); renderNotices(); ntMarkRead({ ids: hit.map(n => n.id) });
}

const NT_EMPTY = { all: "새 알림이 없어요", alert: "새 알림이 없어요", worklog: "새 작업내역이 없어요", watch: "새 모니터링 소식이 없어요" };
const NT_SEEN = { all: "읽은 알림", alert: "읽은 알림", worklog: "읽은 작업내역", watch: "읽은 소식" };

function renderNotices() {
  if (!ntPanel) return;
  const body = $(".nt-body", ntPanel), all = $(".nt-all", ntPanel), tab = NT.tab;
  const keepTop = body.scrollTop, focusId = ntPanel.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const sorted = NT.items.filter(n => tab === "all" || ntTabOf(n) === tab).sort((a, b) => ntAt(b) - ntAt(a));
  const fresh = sorted.filter(n => !n.read), seen = sorted.filter(n => n.read).slice(0, NT_READ_MAX);
  all.hidden = (tab === "all" ? NT.unread : fresh.length) <= 0;
  ntPaintTabs();
  clear(body);
  if (tab === "watch") body.append(ntMonSection());
  if (!NT.loaded && NT.failed) body.append(el("div", { class: "nt-empty", text: "알림을 불러오지 못했어요" }));
  else if (!NT.loaded) body.append(el("div", { class: "nt-empty", text: "불러오는 중…" }));
  else if (tab === "all") {
    if (!fresh.length) body.append(el("div", { class: "nt-empty", text: NT_EMPTY.all }));
    for (const [kind, label] of NT_GROUPS) {
      const list = fresh.filter(n => n.kind === kind);
      if (list.length) body.append(el("section", { class: "nt-grp" }, el("h3", { class: "nt-gh", text: label }), list.map(ntRow)));
    }
    const other = fresh.filter(n => !NT_GROUPS.some(([k]) => k === n.kind));
    if (other.length) body.append(el("section", { class: "nt-grp" }, el("h3", { class: "nt-gh", text: "알림" }), other.map(ntRow)));
    if (seen.length) body.append(el("section", { class: "nt-grp" }, el("h3", { class: "nt-gh", text: NT_SEEN.all }), seen.map(ntRow)));
  } else {
    const bare = tab === "watch" && NM.loaded && !NM.items.length && !fresh.length && !seen.length;
    if (!fresh.length && !bare) body.append(el("div", { class: "nt-empty", text: NT_EMPTY[tab] }));
    if (fresh.length) body.append(el("section", { class: "nt-grp" }, el("h3", { class: "nt-gh", text: "안 읽은 것" }), fresh.map(ntRow)));
    if (seen.length) body.append(el("section", { class: "nt-grp" }, el("h3", { class: "nt-gh", text: NT_SEEN[tab] }), seen.map(ntRow)));
  }
  body.scrollTop = keepTop;
  if (focusId) { const f = ntPanel.querySelector(`.nt-row[data-id="${CSS.escape(focusId)}"]`); if (f) f.focus({ preventScroll: true }); }
}

function ntPlace() {
  if (!ntPanel || !ntWide.matches) return;
  const r = $("#bell").getBoundingClientRect();
  ntPanel.style.setProperty("--nt-top", `${Math.round(r.bottom + 8)}px`);
  ntPanel.style.setProperty("--nt-right", `${Math.max(12, Math.round(innerWidth - r.right))}px`);
}

function ntOutside(ev) {
  if (ntPanel && !ntPanel.contains(ev.target) && !$("#bell").contains(ev.target)) closeNotices();
}
function ntKey(ev) {
  if (!ntPanel) return;
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeNotices(); return; }
  if (ev.key !== "Tab" || ntWide.matches) return;   // the phone sheet is modal: keep Tab inside it
  const f = [...ntPanel.querySelectorAll("button:not([hidden]):not([disabled])")];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], at = document.activeElement;
  if (!ntPanel.contains(at)) { ev.preventDefault(); first.focus(); }
  else if (ev.shiftKey && at === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
}

// Opens the panel on `tab` ("all" | "alert" | "worklog" | "watch"); no tab means the one used last. Also the entry point of the home cards.
function openNotices(tab) {
  if (tab) ntSetTab(tab);
  if (NT.open) { if (tab) ntPanel.focus({ preventScroll: true }); return; }
  closeMenu(false);
  NT.open = true;
  const all = el("button", { type: "button", class: "nt-all", text: "모두 읽음", onclick: ntReadAll });
  const tabs = el("div", { class: "seg nt-tabs", role: "tablist", "aria-label": "알림 종류", onkeydown: ev => {
    const i = NT_TABS.findIndex(t => t[0] === NT.tab), d = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    ev.preventDefault();
    ntSetTab(NT_TABS[(i + d + NT_TABS.length) % NT_TABS.length][0]);
    $(".nt-tabs .on", ntPanel).focus();
  } }, NT_TABS.map(([id, label]) => el("button", { type: "button", role: "tab", "data-tab": id, "data-label": label, onclick: () => ntSetTab(id) }, el("span", { text: label }), el("span", { class: "nt-c", hidden: true }))));
  const x = el("button", { type: "button", class: "ib nt-x-btn", "aria-label": "알림 닫기", onclick: () => closeNotices() });
  x.append(icon("close"));
  ntPanel = el("div", { class: "nt-panel", id: "nt-panel", role: "dialog", "aria-label": "알림", tabindex: "-1" },
    el("div", { class: "nt-head" }, el("h2", { class: "nt-title", text: "알림" }), all, x),
    tabs,
    el("div", { class: "nt-body" }));
  document.body.append(ntPanel);
  $("#bell").setAttribute("aria-expanded", "true");
  ntPlace(); renderNotices();
  document.addEventListener("pointerdown", ntOutside, true);
  document.addEventListener("keydown", ntKey, true);
  addEventListener("resize", ntPlace);
  ntPanel.focus({ preventScroll: true });
  loadNotices();
  loadMonitors();
}

function closeNotices(restore = true) {
  if (!NT.open) return;
  NT.open = false;
  document.removeEventListener("pointerdown", ntOutside, true);
  document.removeEventListener("keydown", ntKey, true);
  removeEventListener("resize", ntPlace);
  if (ntPanel) ntPanel.remove();
  ntPanel = null;
  $("#bell").setAttribute("aria-expanded", "false");
  if (restore) $("#bell").focus({ preventScroll: true });
}

$("#bell").append(icon("bell"));
$("#bell").onclick = () => (NT.open ? closeNotices() : openNotices());
paintBell();
loadNotices();
loadMonitors();
