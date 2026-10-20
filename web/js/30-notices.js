/* ---------- notification bell: the header bell, its unread badge and the notice panel ---------- */
// Data: GET /api/notices, POST /api/notices/read; live frames {kind:"notice"} / {kind:"notice_read"} from the event stream
// (routed here by 29-harness-features.js, never into the chat timeline or the corner toasts).
// Panel: a popover under the bell from 700px up, a full-height sheet below it (same breakpoint as 09-notices.css).
const NT = { items: [], unread: 0, loaded: false, failed: false, open: false };
const NT_GROUPS = [["result", "결과 보고"], ["alert", "알림"], ["worklog", "작업로그"], ["watch", "감시·예약"]];
const NT_READ_MAX = 30;
const ntWide = matchMedia("(min-width: 700px)");
let ntPanel = null;

const ntAt = n => Date.parse(n.updated || n.ts) || 0;
const ntWhen = n => { const t = n.updated || n.ts; return kstDay(t) === kstDay(Date.now()) ? kstHM(t) : `${dayLabel(t)} ${kstHM(t)}`; };
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
}

// /api/state carries notices_unread: a count that disagrees with ours means a frame was missed, so refetch.
function ntSync(s) {
  if (!s || typeof s.notices_unread !== "number" || s.notices_unread === NT.unread) return;
  NT.unread = s.notices_unread; paintBell(); loadNotices();
}

function noticeLive(e) {
  if (e.kind === "notice" && e.item && e.item.id != null) {
    const i = NT.items.findIndex(x => x.id === e.item.id);
    if (i < 0) NT.items.push(e.item); else NT.items[i] = e.item;
  } else if (e.kind === "notice_read") {
    const ids = new Set(e.ids || []);
    for (const n of NT.items) if (e.all || ids.has(n.id)) n.read = true;
  }
  if (typeof e.unread === "number") NT.unread = e.unread;
  paintBell();
  if (NT.open) renderNotices();
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

function renderNotices() {
  if (!ntPanel) return;
  const body = $(".nt-body", ntPanel), all = $(".nt-all", ntPanel);
  const keepTop = body.scrollTop, focusId = ntPanel.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const sorted = NT.items.slice().sort((a, b) => ntAt(b) - ntAt(a));
  const fresh = sorted.filter(n => !n.read), seen = sorted.filter(n => n.read).slice(0, NT_READ_MAX);
  all.hidden = NT.unread <= 0;
  clear(body);
  if (!NT.loaded && NT.failed) body.append(el("div", { class: "nt-empty", text: "알림을 불러오지 못했어요" }));
  else if (!NT.loaded) body.append(el("div", { class: "nt-empty", text: "불러오는 중…" }));
  else {
    if (!fresh.length) body.append(el("div", { class: "nt-empty", text: "새 알림이 없어요" }));
    for (const [kind, label] of NT_GROUPS) {
      const list = fresh.filter(n => n.kind === kind);
      if (list.length) body.append(el("section", { class: "nt-grp" }, el("h3", { class: "nt-gh", text: label }), list.map(ntRow)));
    }
    const other = fresh.filter(n => !NT_GROUPS.some(([k]) => k === n.kind));
    if (other.length) body.append(el("section", { class: "nt-grp" }, el("h3", { class: "nt-gh", text: "알림" }), other.map(ntRow)));
    if (seen.length) body.append(el("section", { class: "nt-grp" }, el("h3", { class: "nt-gh", text: "읽은 알림" }), seen.map(ntRow)));
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

function openNotices() {
  if (NT.open) return;
  closeMenu(false);
  NT.open = true;
  const all = el("button", { type: "button", class: "nt-all", text: "모두 읽음", onclick: () => { for (const n of NT.items) n.read = true; NT.unread = 0; paintBell(); renderNotices(); ntMarkRead({ all: true }); } });
  const x = el("button", { type: "button", class: "ib nt-x-btn", "aria-label": "알림 닫기", onclick: () => closeNotices() });
  x.append(icon("close"));
  ntPanel = el("div", { class: "nt-panel", id: "nt-panel", role: "dialog", "aria-label": "알림", tabindex: "-1" },
    el("div", { class: "nt-head" }, el("h2", { class: "nt-title", text: "알림" }), all, x),
    el("div", { class: "nt-body" }));
  document.body.append(ntPanel);
  $("#bell").setAttribute("aria-expanded", "true");
  ntPlace(); renderNotices();
  document.addEventListener("pointerdown", ntOutside, true);
  document.addEventListener("keydown", ntKey, true);
  addEventListener("resize", ntPlace);
  ntPanel.focus({ preventScroll: true });
  loadNotices();
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
