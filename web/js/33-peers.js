/* ---------- computers: switch between this owner's gateways (맥북, 맥미니) ---------- */
// Data: GET /api/peers (hub/peers.ts) -> [{name, url, self, online, unread?, need?}]. The chip next to the title shows this computer
// and appears only with 2 or more, with a dot on its chevron while another computer has something unread (the counts live in the sheet rows); the sheet lists them; choosing one opens that computer's own address (its own PWA, login and push).
// The bell lists the other computers' unread counts at its top (renderNotices in 30-notices.js calls prBellLines).
const PR = { list: [], node: null, ov: null, opener: null };
const prSelf = () => PR.list.find(p => p.self);
const prOthers = () => PR.list.filter(p => !p.self);
const prText = p => [p.need > 0 ? `답변 필요 ${p.need}` : "", p.unread > 0 ? `새 알림 ${p.unread}` : ""].filter(Boolean).join(" · ");

async function prLoad() {
  try { const r = await api("/api/peers"); PR.list = Array.isArray(r) ? r : []; } catch { return; }
  prPaint();
  if (NT.open) renderNotices();
}

function prPaint() {
  const chip = $("#pchip"), me = prSelf(), on = !!me && PR.list.length >= 2;
  $("#appbar").classList.toggle("hasp", on);
  chip.hidden = !on;
  if (!on) { prClose(false); return; }
  const others = prOthers(), more = others.some(p => p.unread > 0 || p.need > 0), need = others.some(p => p.need > 0);
  // el() skips a null child; Node.append() would write it as the text "null" (the chip once read "맥북 null"), so the chip is built with el().
  clear(chip).append(el("span", { class: "pc-n", text: me.name }), el("span", { class: "pc-c" }, icon("chev", "pc-i"), more ? el("span", { class: `pc-d${need ? " need" : ""}`, role: "img", "aria-label": "다른 컴퓨터에 새 알림" }) : null));
  chip.setAttribute("aria-label", `컴퓨터 바꾸기, 지금은 ${me.name}`);
  if (PR.node) prSheet();
}

// The same screen on the other computer where it makes sense: the page (home, sessions, settings...) but not a conversation, whose name exists only here.
function prUrl(p, extra = "") {
  const v = parseHash().view;
  return `${p.url}/${extra}${v && v !== "chat" && views.includes(v) ? `#${v}` : ""}`;
}
function prPick(p) {
  if (p.self) { prClose(); return; }
  if (!p.online) { toast(`${p.name}에 연결할 수 없어요`, true); return; }
  location.href = prUrl(p);
}

function prSheet() {
  const x = el("button", { type: "button", class: "ib", "aria-label": "닫기", onclick: () => prClose() });
  x.append(icon("close"));
  const rows = PR.list.map(p => {
    const sub = p.self ? "지금 보고 있어요" : p.online ? "연결됨" : "꺼져 있어요";
    const note = prText(p);
    return el("button", { type: "button", class: `pr-row${p.self ? " on" : ""}`, "aria-current": p.self ? "true" : null, onclick: () => prPick(p) },
      el("span", { class: `dot ${p.online ? "ok" : ""}`, "aria-hidden": "true" }),
      el("span", { class: "pr-b" }, el("span", { class: "pr-t", text: p.name }), el("span", { class: "pr-s", text: sub })),
      note ? el("span", { class: `pr-bd${p.need > 0 ? " need" : ""}`, text: note }) : null);
  });
  clear(PR.node.firstElementChild).append(
    el("div", { class: "ds-hd" }, el("span", { class: "ds-ey pr-ey", text: "컴퓨터" }), x),
    el("div", { class: "ds-body" }, el("h2", { class: "ds-t", id: "pr-t", text: "어느 컴퓨터를 볼까요?" }), el("div", { class: "ds-m", text: "고르면 그 컴퓨터의 화면으로 넘어가요" }), el("div", { class: "pr-list" }, rows)));
}

function prKey(ev) {
  if (!PR.node) return;
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); prClose(); return; }
  if (ev.key !== "Tab") return;
  const f = [...PR.node.querySelectorAll("button:not([disabled])")];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], at = document.activeElement;
  if (!PR.node.contains(at)) { ev.preventDefault(); first.focus(); }
  else if (ev.shiftKey && at === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
}

function prOpen() {
  if (PR.node) return;
  closeNotices(false);
  PR.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  PR.node = el("div", { class: "ds-bd", onpointerdown: ev => { if (ev.target === PR.node) prClose(); } }, el("div", { class: "ds-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "pr-t" }));
  document.body.append(PR.node);
  // On the phone the tab bar stays free below the sheet, so tapping 홈 again (homeTabTap) can close it, as the 채팅 tab does with its list.
  const nr = $("#nav").getBoundingClientRect();
  if (nr.top > innerHeight / 2 && nr.height < innerHeight / 4) PR.node.style.bottom = `${Math.max(0, innerHeight - nr.top)}px`;
  PR.ov = ovOpen(() => prClose(false));
  document.addEventListener("keydown", prKey, true);
  prSheet();
  const cur = PR.node.querySelector(".pr-row.on") || PR.node.querySelector(".pr-row");
  if (cur) cur.focus({ preventScroll: true });
  prLoad();
}

function prClose(restore = true) {
  if (!PR.node) return;
  PR.node.remove(); PR.node = null;
  ovDone(PR.ov); PR.ov = null;
  document.removeEventListener("keydown", prKey, true);
  if (restore && PR.opener && PR.opener.isConnected) PR.opener.focus({ preventScroll: true });
  PR.opener = null;
}

// One line per other computer with something new, at the top of the bell: "맥미니 · 새 알림 3". Tapping it opens that computer's bell.
function prBellLines() {
  const rows = prOthers().filter(p => p.online && (p.unread > 0 || p.need > 0));
  if (!rows.length) return null;
  return el("section", { class: "nt-grp pr-lines" }, rows.map(p =>
    el("button", { type: "button", class: "nt-row pr-line", onclick: () => { location.href = `${p.url}/?bell=1`; } },
      el("span", { class: `nt-dot tone-${p.need > 0 ? "ask" : "none"}`, "aria-hidden": "true" }),
      el("span", { class: "nt-b" }, el("span", { class: "nt-t", text: `${p.name} · ${prText(p)}` }), el("span", { class: "nt-m", text: "눌러서 그 컴퓨터의 알림 보기" })),
      icon("chev", "chev"))));
}

// This computer's own name (settings -> 이 컴퓨터 이름): GET/PUT /api/machine -> {name, custom, default}; empty = the hostname-derived default.
// The other computers read it from this gateway's public /api/peer-info, so a rename shows up on their switcher within a minute.
const MN = { info: null };
async function mnLoad() {
  try { MN.info = await api("/api/machine"); } catch { return; }
  if (current === "settings") renderSettings();
}
function mnDialog() {
  const i = MN.info;
  const inp = el("input", { class: "fi", type: "text", value: i.custom || "", maxlength: "24", autocomplete: "off", placeholder: i.default, "aria-label": "컴퓨터 이름" });
  const save = (v, msg) => (btn, close) => busy(btn, async () => { MN.info = await api("/api/machine", "PUT", { name: v }); close(); toast(msg); prLoad(); renderSettings(); });
  const d = dialog({ title: "이 컴퓨터 이름", body: el("div", { class: "col" }, el("div", { class: "sup", text: "다른 컴퓨터의 컴퓨터 목록에도 이 이름으로 보여요. 비우면 기본 이름(" + i.default + ")을 써요." }), inp), actions: [
    i.custom ? { label: "기본 이름으로", kind: "text", onclick: (c, b) => save("", "기본 이름으로 돌렸어요")(b, c) } : null,
    { label: "저장", kind: "pri", onclick: (c, b) => save(inp.value.trim(), "이름을 저장했어요")(b, c) }].filter(Boolean) });
  inp.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); d.node.querySelector(".dact .btn:last-child").click(); } });
  inp.focus();
}
const mnRow = () => MN.info && el("button", { class: "li tap", type: "button", onclick: mnDialog },
  el("span", { class: "lead" }, icon("term")), el("span", { class: "tx" }, el("div", { class: "hd", text: "이 컴퓨터 이름" })), el("span", { class: "sup", text: MN.info.name }), icon("chev", "lead"));
mnLoad();

$("#pchip").onclick = prOpen;
// Tapping 홈 again while on 홈 opens the computer sheet (like the 채팅 tab's re-tap, 04-state.js chatTabTap) and the next tap closes it; with one gateway the tab behaves as before.
const homeTabTap = () => { if (PR.node) prClose(); else if (current === "home" && PR.list.length >= 2) prOpen(); else go("home"); };
prLoad();
setInterval(() => { if (!document.hidden) prLoad(); }, 60_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) prLoad(); });
{
  const u = new URL(location.href);
  if (u.searchParams.get("bell")) {
    u.searchParams.delete("bell");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    setTimeout(() => openNotices(), 500);
  }
}
