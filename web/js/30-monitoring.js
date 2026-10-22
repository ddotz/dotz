/* ---------- 모니터링: every dotz_watch monitor and schedule, with its last result and next run ---------- */
// Data: GET /api/monitors (hub/monitors.ts) -> {items: [{name, kind, channel?, last_run?, last_result?, next_run?, every?}]}. The screen (#v-monitoring)
// is opened from the chat list, the 홈 card and the palette; it repaints when a watch notice arrives and once a minute while it is open.
const NM = { items: [], loaded: false, failed: false };
const NT_RESULT = { ok: ["정상", "done"], changed: ["바뀜", "ask"], fail: ["실패", "fail"] };
const MON_KIND = { watch: "모니터링", schedule: "예약" };

async function loadMonitors() {
  try {
    const r = await api("/api/monitors");
    NM.items = Array.isArray(r.items) ? r.items : [];
    NM.loaded = true; NM.failed = false;
  } catch { NM.failed = !NM.loaded; }
  if (current === "monitoring") renderMonitoring();
  homeSoon();
}
// Failed ones first, then the soonest next run.
const ntMons = () => NM.items.slice().sort((a, b) => (b.last_result === "fail") - (a.last_result === "fail") || (Date.parse(a.next_run) || Infinity) - (Date.parse(b.next_run) || Infinity));
const monTime = t => kstDay(t) === kstDay(Date.now()) ? kstHM(t) : `${dayLabel(t)} ${kstHM(t)}`;
const ntMonRun = m => m.last_run ? `마지막 ${monTime(m.last_run)}` : "아직 실행 전이에요";
const ntMonNext = m => m.next_run ? `다음 ${monTime(m.next_run)}` : "";

function monRow(m) {
  const [word, tone] = m.last_result ? NT_RESULT[m.last_result] || ["", "none"] : ["", "none"];
  const run = [ntMonRun(m), word].filter(Boolean).join(" · "), next = [ntMonNext(m), m.every].filter(Boolean).join(" · ");
  const kids = [el("span", { class: `nt-dot tone-${tone}`, "aria-hidden": "true" }),
    el("span", { class: "nt-b" },
      el("span", { class: "nt-t" }, ntPlain(m.name) || MON_KIND[m.kind] || "모니터링", m.kind === "schedule" ? el("span", { class: "tag mon-kind", text: MON_KIND.schedule }) : null),
      el("span", { class: "nt-x", text: run }),
      next ? el("span", { class: "nt-m", text: next }) : null)];
  if (!(m.channel && isProjT(m.channel))) return el("div", { class: "nt-row nt-mon", "data-mon-name": m.name }, ...kids);
  return el("button", { type: "button", class: "nt-row nt-mon", "data-mon-name": m.name, onclick: () => { if (S && !projTargets().includes(m.channel)) toast("이 프로젝트를 찾을 수 없어요"); else openTarget(m.channel, "chat"); } }, ...kids, icon("chev", "chev"));
}

function renderMonitoring() {
  const box = $("#v-monitoring"), list = ntMons(), bad = list.filter(m => m.last_result === "fail").length;
  clear(box);
  if (INTG.view && INTG.items.some(i => i.key === INTG.view)) return renderIntegration(box);
  if (!NM.loaded) { box.append(emptyNode(NM.failed ? "불러오지 못했어요" : "불러오는 중…")); return; }
  if (!list.length) { box.append(emptyNode("모니터링 중인 것이 없어요")); return; }
  box.append(el("div", { class: "mon-sum", text: `모니터링 ${list.length}개${bad ? ` · 실패 ${bad}개` : ""}` }), el("div", { class: "card mon-list" }, ...list.map(monRow)));
}
setInterval(() => { if (current === "monitoring" && !document.hidden) loadMonitors(); }, 60_000);
loadMonitors();
