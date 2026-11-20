const SCHED_RUN = { fired: TX("sched.run.fired"), answered: TX("sched.run.answered"), silent: TX("sched.run.silent"), held: TX("sched.run.held"), failed: TX("sched.run.failed") };
const SCHED_KIND = { owner: TX("sched.kind.owner"), task: TX("sched.kind.task"), check: TX("sched.kind.check") };
const schedKindOf = k => SCHED_KIND[k] || SCHED_KIND.owner;
const schedDay = t => kstDay(t) === kstDay(Date.now()) ? kstHM(t) : new Date(t).toLocaleDateString(TX_LOCALE, { ...KST, month: "long", day: "numeric" });
const schedStarts = m => TX("sched.starts", { d: schedDay(m.next_run) });
const schedRunLine = m => !m.last_run ? (m.next_run ? schedStarts(m) : TX("mon.run.unchecked")) : [TX("sched.last", { t: monTime(m.last_run) }), SCHED_RUN[m.run_state] || ""].filter(Boolean).join(" · ");
const schedRunNow = (btn, m) => busy(btn, async () => {
  await api(`/api/schedules/${enc(m.schedule)}/run`, "POST", {});
  await loadMonitors();
  toast(TX("sched.ran_now", { name: monTitle(m) }));
});

const SCH = { items: [], runs: [], loaded: false, failed: false, brief: null };
async function schedLoad() {
  try {
    const r = await api("/api/schedules");
    SCH.items = Array.isArray(r) ? r : r.items || [];
    SCH.runs = Array.isArray(r) ? [] : r.runs || [];
    SCH.loaded = true; SCH.failed = false;
  } catch { SCH.failed = !SCH.loaded; }
  if (current === "schedules") renderSettings();
}
async function schedBriefLoad() {
  try {
    const n = ((await api("/api/harness")).nodes || []).find(x => x.id === "mail");
    const h = n && (n.settings || []).find(s => s.key === "zele.brief_hour");
    SCH.brief = n ? { on: n.status === "ok", hour: h ? Number(h.value) : 8 } : null;
  } catch { SCH.brief = null; }
  if (current === "schedules") renderSettings();
}
function schedEnter() { renderSettings(); schedBriefLoad(); loadMonitors(); }
screenHooks("schedules", { enter: schedEnter });

const schedMon = id => NM.items.find(m => m.kind === "schedule" && m.schedule === id) || null;
function schedRow(s) {
  const m = schedMon(s.id);
  const sub = [s.paused ? TX("mon.tag.off") : TX("mon.next_at", { t: monTime(s.at) }), m && m.every ? m.every : ""].filter(Boolean).join(" · ");
  const row = stRow("list", s.name || TX("common.schedule"), sub, () => asScreen(`s:${s.id}`), el("span", { class: "tag", text: schedKindOf(s.kind) }));
  row.dataset.sched = s.id;
  return row;
}
function schedBriefRow() {
  const b = SCH.brief;
  if (!b) return null;
  const row = stRow("spark", TX("sched.brief"), b.on ? TX("sched.brief_at", { h: b.hour }) : TX("sched.brief_off"), () => harnessOpenNode("mail"), el("span", { class: "tag", text: SCHED_KIND.task }));
  row.dataset.sched = "brief";
  return row;
}
const schedPast = () => {
  const live = new Set(SCH.items.map(s => s.id)), seen = new Set();
  return SCH.runs.slice().sort((a, b) => Date.parse(b.firedAt) - Date.parse(a.firedAt))
    .filter(r => r.kind !== "check" && !live.has(r.scheduleId) && !seen.has(r.scheduleId) && seen.add(r.scheduleId));
};
const schedAgain = (iso, now = Date.now()) => { let t = Date.parse(iso); while (t <= now) t += 86_400_000; return new Date(t).toISOString(); };
const schedRebook = (btn, r) => busy(btn, async () => {
  const at = schedAgain(r.firedAt);
  await api("/api/schedules", "POST", { name: r.name, text: r.text, kind: r.kind, at });
  toast(TX("sched.rebooked", { name: r.name, t: `${dayLabel(at)} ${kstHM(at)}` }));
  await loadMonitors();
});
function schedPastRow(r) {
  const sub = [schedKindOf(r.kind), TX("sched.past_at", { t: monTime(r.firedAt) }), SCHED_RUN[r.state] || ""].filter(Boolean).join(" · ");
  return el("div", { class: "li", "data-past": r.run },
    el("span", { class: "lead" }, icon("list")),
    el("span", { class: "tx" }, el("div", { class: "hd", text: r.name }), el("div", { class: "sup", text: sub })),
    liEnd(el("button", { class: "btn tonal sm", type: "button", "data-k": "rebook", text: TX("sched.rebook"), onclick: ev => schedRebook(ev.currentTarget, r) })));
}
function schedPage() {
  if (!SCH.loaded) return [SCH.failed ? emptyNode(TX("sched.load_failed"), () => schedLoad()) : emptyNode(TX("common.loading"))];
  const items = SCH.items.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), brief = schedBriefRow(), past = schedPast();
  return [
    stSec(TX("sched.sec.now")), items.length || brief ? stList(...items.map(schedRow), brief) : emptyNode(TX("sched.none"), null, { compact: true }),
    ...(past.length ? [stSec(TX("sched.sec.past")), stList(...past.map(schedPastRow))] : []),
  ];
}

const maskMail = s => String(s || "").replace(/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***@$2");
function schedWakeResult(group) {
  const n = group.dataset.answer ? ntFind(group.dataset.answer) : null;
  if (!n) { toast(TX("sched.wake.no_result")); return; }
  n.scrollIntoView({ block: "center" });
  ntFlash(n);
}
function schedWakeNode(w, group) {
  const next = el("div", { class: "wk-next", "data-k": "wake-next", hidden: "" });
  const paintNext = () => { const m = schedMon(w.sched); next.hidden = !(m && m.next_run); next.textContent = m && m.next_run ? TX("sched.wake.next", { t: monTime(m.next_run) }) : ""; };
  if (monitorsFresh()) paintNext(); else loadMonitors().then(paintNext);
  const res = el("button", { class: "btn text sm", type: "button", "data-k": "wake-result", text: TX("sched.wake.result"), onclick: () => schedWakeResult(group) });
  const raw = w.raw ? el("details", { class: "wk-raw", "data-k": "wake-raw" }, el("summary", { text: TX("sched.wake.raw") }), el("div", { class: "a-text", text: maskMail(w.raw) })) : null;
  return el("div", { class: "wk-head" }, next, el("div", { class: "btns" }, res), raw);
}
