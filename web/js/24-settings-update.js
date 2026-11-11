/* ---------- settings: 업데이트 (hub/selfupdate.ts, /api/update*) ---------- */
// Version on disk vs the version this gateway runs, the last check, the running/finished update job, and the restart that
// applies it. After a restart request the page polls until the gateway answers with a new boot id.
const UPD = { info: null, wait: null, timer: 0, at: 0, checking: false };
// Opening settings reads both again only when the last read (boot, the 5 min tick, an update_available event) is older than that tick.
const UPD_FRESH_MS = 5 * 60000;
const updFresh = () => !!UPD.info && !UPD.info.error && !!HV.info && Date.now() - UPD.at < UPD_FRESH_MS;
// 실행 하네스 (hub/harness-update.ts, /api/harness/update): the harness binary itself, checked beside dotz's own version.
const HV = { info: null, timer: 0, press: false, at: 0 };
const updWhen = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); };
// A released version is the version: the commit and the branch are printed only for a checkout that has no release.
const updVer = v => !v ? TX("settings.unknown") : v.kind === "git" ? (v.release ? `v${v.release}` : `${v.commit.short} · ${updWhen(v.commit.date)}${v.branch !== "main" ? ` · ${v.branch}` : ""}`) : v.kind === "tarball" ? (v.release ? TX("settings.upd.v_installed", { release: v.release }) : `${TX("settings.upd.installed_commit", { commit: v.commit.short, when: updWhen(v.installed) })}${v.ref && v.ref !== "main" ? ` · ${v.ref}` : ""}`) : v.kind === "install" ? TX("settings.upd.installed_when", { when: updWhen(v.installed) }) : TX("settings.unknown");
// Released versions (hub/selfupdate.ts compareReleases): numeric on date, N, then the forced part; missing sorts below any version.
const updRel = s => { const m = /^(\d{6})\.([1-3])(?:\.(\d+))?$/.exec(String(s || "").replace(/^v/, "")); return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null; };
const updRelNewer = (disk, available) => { const a = updRel(disk), b = updRel(available); if (!b) return false; if (!a) return true; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
// `cmd` spans in server hints become <code>.
const updAgo = at => { const t = Date.parse(at); return isNaN(t) ? "" : TX("settings.upd.checked_ago", { ago: msAgo(t) }); };
const updCode = s => String(s || "").split("`").map((p, i) => i % 2 ? el("code", { text: p }) : p);
// A pulled-but-not-restarted update (running != disk), and the last check when it still describes the checkout. A check made
// before the checkout moved (an update just landed) no longer describes it.
function updState(i) {
  const { running: run, disk } = i || {};
  const pending = !!(run && disk && run.commit && disk.commit && run.commit.sha !== disk.commit.sha);
  const c = i && i.lastCheck && !(disk && disk.commit && i.lastCheck.version && i.lastCheck.version.commit && i.lastCheck.version.commit.sha !== disk.commit.sha) ? i.lastCheck : null;
  return { pending, c };
}
// A new version is waiting to be applied (from /api/update, not the toast).
function updAvailable() {
  const i = UPD.info;
  if (!i || i.error) return false;
  const { pending, c } = updState(i);
  if (!c || !c.ok || pending) return false;
  if (c.rewrite) return true;
  return c.available ? updRelNewer(c.version && c.version.release, c.available) : c.incomingTotal > 0;
}
const hvList = () => (HV.info && Array.isArray(HV.info.harnesses) ? HV.info.harnesses : []);
const hvNew = () => hvList().filter(h => h.available).length;
const hvJob = () => hvList().map(h => h.job).find(j => j && (j.status === "running" || j.status === "deferred")) || null;
// A new version was pulled and waits for the restart that applies it (running != disk).
function updRestartPending() {
  const i = UPD.info;
  return !!(i && !i.error && updState(i).pending);
}
// One badge for both: dotz's own version and every running harness, each named (owner 2026-11-09: an OmO update read as a dotz one). A pulled
// update that still waits for its restart keeps the badge as 재시작 필요 (it is the next step, ahead of a newer version), so it does not vanish half done.
function paintUpdBadge() {
  const b = $("#nav-upd");
  if (!b) return;
  const names = [...(updAvailable() ? ["dotz"] : []), ...hvList().filter(h => h.available).map(h => h.name)], restart = updRestartPending();
  b.hidden = !names.length && !restart;
  b.textContent = restart ? TX("settings.tag.restart_needed") : TX("settings.upd.bar_new", { names: names.join(" · ") });
  b.title = restart ? TX("settings.upd.restart_applies") : TX("settings.upd.names_new", { names: names.join(", ") });
  paintUpdBar();
}
// The top update bar (hub/update-now.ts, owner 2026-11-01: "상단 알림바 누르고 나서 설정가서 다시 업뎃하는게 번거롭네"): a new version offers
// itself here and one tap runs the whole update: 받는 중 → 진행 중인 작업이 끝나면 적용 → 다시 켜는 중 → 완료 or 실패 with the reason.
// A dismissed offer (its remote head) or a seen result (its flow id) stays away (localStorage).
const UB = { tapped: false, down: false, busy: false, timer: 0, doneTimer: 0 };
const UB_KEY = "dotz-upd-bar", UB_ACTIVE = ["download", "waiting", "restarting"], UB_RESULT_MS = 60 * 60_000;
const ubSeen = () => { try { return localStorage.getItem(UB_KEY) || ""; } catch { return ""; } };
const ubSee = k => { lsSet(UB_KEY, k); paintUpdBar(); };
function updBarState() {
  const i = UPD.info, f = i && !i.error ? i.flow : null;
  if (UB.down && (UB.tapped || (f && UB_ACTIVE.includes(f.phase)))) return { phase: "restarting", text: TX("settings.upd.restarting") };
  if (f && UB_ACTIVE.includes(f.phase)) return f;
  if (f && (f.phase === "done" || f.phase === "failed") && ubSeen() !== f.id && Date.now() - Date.parse(f.at) < UB_RESULT_MS) return f;
  if (updAvailable() && i.lastCheck.remoteHead && ubSeen() !== i.lastCheck.remoteHead) return { phase: "new", text: TX("settings.upd.bar_offer"), id: i.lastCheck.remoteHead };
  return null;
}
// The bar wraps to two lines on a phone: the app below it starts at the bar's real height (03-base.css --upd-h).
function ubFit() {
  const b = $("#upd-bar"), root = document.documentElement.style;
  if (b) root.setProperty("--upd-h", `${b.offsetHeight}px`); else root.removeProperty("--upd-h");
}
addEventListener("resize", ubFit);
// A bar with nothing more to say leaves the way it came: it fades while its height folds (250 ms), then the app moves up; reduced motion = at once.
const UB_DONE_MS = 2400;
function ubOut(b) {
  b.removeAttribute("id");
  const gone = () => { b.remove(); ubFit(); };
  if (reducedMotion() || !b.animate) return gone();
  b.style.overflow = "hidden";
  b.animate([{ opacity: 1, height: `${b.offsetHeight}px` }, { opacity: 0, height: "0px", paddingTop: "0px", paddingBottom: "0px" }], { duration: 250, easing: "ease", fill: "forwards" }).finished.then(gone, gone);
}
function paintUpdBar() {
  const s = updBarState();
  let b = $("#upd-bar");
  if (!s) { if (b) ubOut(b); else ubFit(); return; }
  if (!b) { b = el("div", { id: "upd-bar", role: "status", "aria-live": "polite" }); document.body.append(b); }
  b.className = `upd-bar ${s.phase}`;
  const tap = s.phase === "new" || s.phase === "failed";
  const run = UPD.info && UPD.info.running && UPD.info.running.commit;
  const failHead = TX("settings.upd.failed"), failSrv = "업데이트하지 못했어요";
  const text = s.phase === "failed" ? `${!s.text || s.text.startsWith(failSrv) ? s.text || failHead : TX("settings.upd.failed_why", { reason: s.text })}${tap ? ` · ${TX("settings.upd.tap_retry")}` : ""}` : s.phase === "done" && run ? TX("settings.upd.done_now", { text: s.text, version: run.short }) : s.text;
  b.replaceChildren(
    el(tap ? "button" : "span", { class: "ub-tx", ...(tap ? { type: "button", onclick: updNow } : {}), text }),
    ...(UB_ACTIVE.includes(s.phase) || s.phase === "done" ? [] : [el("button", { type: "button", class: "x", "aria-label": TX("common.close"), text: "×", onclick: () => ubSee(s.id) })]));
  ubFit();
  // A finished update says 완료 for a moment and then goes by itself (owner 2026-11-03: no × to press); before that the bar stays as it is.
  if (s.phase === "done" && !UB.doneTimer) UB.doneTimer = setTimeout(() => { UB.doneTimer = 0; ubSee(s.id); }, UB_DONE_MS);
}
// The tap: the hub downloads, tests and restarts when idle; the page follows it until the restarted gateway answers.
async function updNow() {
  if (UB.busy) return;
  UB.busy = true;
  try {
    const r = await api("/api/update/now", "POST");
    UPD.info = { ...(UPD.info || {}), flow: r.flow };
    UB.tapped = true;
    paintUpdBar();
    updBarTick();
  } catch (e) { toast(e.message, true); } finally { UB.busy = false; }
}
async function updBarTick() {
  clearTimeout(UB.timer);
  UB.timer = 0;
  const r = await fetch("/api/update", { cache: "no-store" }).then(x => (x.ok ? x.json() : null), () => null);
  UB.down = !r;
  if (r) { UPD.info = r; paintUpdBadge(); if (inSettings()) renderSettings(); }
  paintUpdBar();
  const f = UPD.info && UPD.info.flow;
  if (UB.down || (f && UB_ACTIVE.includes(f.phase))) UB.timer = setTimeout(updBarTick, 2000);
  else UB.tapped = false;
}
async function loadUpdate() {
  clearTimeout(UPD.timer);
  clearTimeout(HV.timer);
  const [dotz, hv] = await Promise.all([api("/api/update").catch(e => ({ error: e.message })), api("/api/harness/update").catch(() => null)]);
  UPD.info = dotz;
  HV.info = hv;
  UPD.at = Date.now();
  paintUpdBadge();
  if (UPD.info.flow && UB_ACTIVE.includes(UPD.info.flow.phase) && !UB.timer) updBarTick();
  if (UPD.info.job && UPD.info.job.status === "running") UPD.timer = setTimeout(loadUpdate, 1500);
  else if (HV.info && (HV.info.checking || hvJob())) HV.timer = setTimeout(loadUpdate, 2000);
  if (inSettings()) renderSettings();
}
// The pressed button says 확인하는 중… and the list stays; the cards' sub lines keep when it was checked after the band is gone.
async function hvCheck(btn) {
  if (HV.press) return;
  HV.press = true;
  renderSettings();
  await busy(btn, async () => {
    HV.info = await api("/api/harness/update/check", "POST");
    HV.at = Date.now();
    const n = hvNew();
    toast(n ? TX("settings.upd.rt_new_n", { n }) : TX("settings.upd.rt_latest"));
  });
  HV.press = false;
  paintUpdBadge();
  renderSettings();
}
async function hvApply(btn, id) {
  await busy(btn, async () => { await api("/api/harness/update/apply", "POST", { id }); });
  loadUpdate();
}
// The pressed row says 확인하는 중… and keeps its card while the check runs; the result comes back into the same row.
async function updCheck(btn) {
  if (UPD.checking) return;
  UPD.checking = true;
  renderSettings();
  await busy(btn, async () => {
    const c = await api("/api/update/check", "POST");
    UPD.info = { ...UPD.info, lastCheck: c };
    paintUpdBadge();
    if (c.ok) toast(c.rewrite ? TX("settings.upd.rewrite") : c.available && updRelNewer(c.version && c.version.release, c.available) ? TX("settings.upd.new_version", { version: c.available }) : c.incomingTotal ? TX("settings.upd.new_commits", { n: c.incomingTotal }) : TX("settings.upd.latest"));
  });
  UPD.checking = false;
  renderSettings();
}
// Local work the update carries as a local patch (hub/selfupdate.ts apply): one Korean line and what was saved; the update itself goes on.
function updKeepBox(k) {
  const sv = k.saved || {};
  const where = [sv.branch, sv.patch, sv.dirtyPatch].filter(Boolean).join(" · ");
  return el("div", { class: "upd-block" }, el("div", { text: k.line }),
    el("ul", { class: "upd-log" }, ...k.dirty.slice(0, 8).map(d => el("li", {}, el("code", { text: d.slice(0, 2).trim() || "?" }), el("span", { text: d.slice(3) }))), ...k.commits.slice(0, 8).map(a => el("li", {}, el("code", { text: a.short }), el("span", { text: a.subject, title: a.subject })))),
    where ? el("div", { class: "sup", text: TX("settings.upd.kept", { where }) }) : null);
}
async function updSet(values) {
  try { UPD.info.settings = (await api("/api/update/settings", "PUT", values)).settings; } catch (e) { toast(e.message, true); }
  renderSettings();
}
function updRestart() {
  const working = (UPD.info && UPD.info.busy) || [];
  const fire = async when => {
    const boot = UPD.info.boot;
    await api("/api/update/restart", "POST", { when });
    UPD.wait = { boot, when };
    renderSettings();
    updWaitTick();
  };
  if (!working.length) return fire("idle").catch(e => toast(e.message, true));
  // a failure stays in the dialog (usErr) so the person can press again; both buttons send once
  const err = usErr();
  let sending = false;
  const send = when => (c, b) => { if (sending) return; sending = true; return usRun(b, err, async () => { try { await fire(when); } catch (e) { sending = false; throw e; } c(); }); };
  const d = dialog({ classic: true, title: TX("common.restart"), body: el("div", { class: "col" }, el("p", { class: "sup", text: TX("settings.upd.working", { names: working.join(", ") }) }), el("p", { class: "sup", text: TX("settings.upd.resend") }), err), actions: [
    { label: TX("settings.upd.when_idle"), onclick: send("idle") },
    { label: TX("settings.upd.restart_now"), kind: "pri", onclick: send("now") }] });
  ovFocus(d.node, d.node.querySelector(".dact .btn"));   // by the keyboard the safer way gets the focus first, not the ✕
}
async function updWaitTick() {
  if (!UPD.wait) return;
  const info = await fetch("/api/update", { cache: "no-store" }).then(r => r.ok ? r.json() : null, () => null);
  if (info && info.boot !== UPD.wait.boot) {
    UPD.wait = null;
    UPD.info = info;
    paintUpdBadge();
    toast(TX("settings.upd.restarted_now", { version: info.running && info.running.commit ? info.running.commit.short : "?" }));
    if (inSettings()) renderSettings();
    return;
  }
  if (info) { UPD.info = info; paintUpdBadge(); if (inSettings()) renderSettings(); }
  setTimeout(updWaitTick, 2000);
}
const hvCanUpd = h => h.available && (h.installMethod === "bun-global" || h.installMethod === "omp-update");
// The runtime picker's data (web/js/26-settings-runtime.js): the same two rows, folded into this one section so the screen
// carries a single 실행 하네스 heading.
const hvRt = () => (typeof RT !== "undefined" && RT && Array.isArray(RT.runtimes) ? RT.runtimes : []);
const hvRoles = rt => (rt && rt.roles && rt.roles.length ? TX("settings.upd.roles_in_use", { roles: rt.roles.map(k => (typeof RT_ROLE !== "undefined" ? RT_ROLE[k] : "") || k).join("·") }) : "");
const hvSub = h => {
  if (!h.current) return h.error || TX("settings.upd.checking_short");
  const rt = hvRt().find(r => r.id === h.id);
  const role = hvRoles(rt);
  const ver = TX("settings.upd.rt_now", { version: `${h.current}${h.latest && h.latest !== h.current ? ` → ${h.latest}` : ""}` });
  const withRole = s => [s, role, HV.at ? TX("settings.upd.checked_ago", { ago: msAgo(HV.at) }) : ""].filter(Boolean).join(" · ");
  if (h.installMethod === "managed") return withRole(TX("settings.upd.managed_by", { ver, by: h.managedBy || TX("settings.upd.another_program") }));
  if (h.installMethod === "app") return withRole(TX("settings.upd.as_app", { ver }));
  if (h.error) return withRole(`${ver} · ${h.error}`);
  if (!h.latest && !h.checkedAt) return withRole(ver);
  return withRole(h.available ? ver : TX("settings.upd.ver_latest", { ver }));
};
function hvSwitcher(h) {
  const rt = hvRt().find(r => r.id === h.id);
  // Every installed program is listed and the one in use carries the check, like any other choice menu.
  const all = hvRt().filter(r => r.installed).map(r => ({ value: r.id, label: r.label, sub: [r.version ? `v${r.version}` : "", hvRoles(r)].filter(Boolean).join(" · ") || undefined }));
  if (!rt || all.length < 2) return null;
  return el("button", { class: "btn tonal inrow", type: "button", "aria-label": TX("settings.upd.change", { name: h.name }), "aria-haspopup": "listbox", "aria-expanded": "false", title: TX("settings.upd.change_rt"), onclick: ev => showMenu(ev.currentTarget, all, { value: rt.roles.length ? h.id : "", onPick: id => { if (id !== h.id) rtFlow(hvRt().find(x => x.id === id)); } }) }, icon("drop"));
}
const hvNote = text => el("div", { class: "note", text });
function hvJobLine(j) {
  if (j.status === "running" || j.status === "deferred") return el("div", { class: "li" }, el("span", { class: "lead" }, el("span", { class: "dot pri", "aria-hidden": "true" })), el("span", { class: "tx" }, el("div", { class: "hd", text: j.status === "deferred" ? TX("settings.upd.deferred") : TX("settings.upd.updating_phase", { phase: j.phase }) }), el("div", { class: "sup", text: j.message })));
  return el("div", { class: `upd-box ${j.status === "updated" ? "ok" : j.status === "failed" ? "err" : ""}` }, el("div", { class: "upd-msg", text: j.message }),
    j.steps.length ? el("ul", { class: "upd-log" }, ...j.steps.slice(-4).map(s => el("li", { class: "dim" }, el("span", { text: s.text })))) : null);
}
// 실행 하네스: the harness the agents run on, its version and update, and the picker that switches harnesses - one section.
// A busy gateway defers the install to idle.
function hvSection() {
  const hs = hvList();
  const running = hvRt().filter(r => (r.roles || []).length > 0);
  const ids = [...new Set([...hs.map(h => h.id), ...running.map(r => r.id)])];
  if (!ids.length) return [];
  const pending = hvJob();
  const list = ids.map(id => {
    const rt = hvRt().find(r => r.id === id);
    const h = hs.find(x => x.id === id) || { id, name: (rt && rt.label) || id, current: (rt && rt.version) || null, latest: null, available: false, installMethod: "unknown", checkedAt: null };
    const job = h.job;
    const mine = job && (job.status === "running" || job.status === "deferred");
    const state = mine
      ? el("span", { class: "tag pri", "aria-live": "polite" }, el("span", { class: "dot pri", "aria-hidden": "true" }), job.status === "deferred" ? TX("settings.upd.waiting") : TX("settings.upd.in_progress"))
      : h.available && h.installMethod !== "managed" && h.installMethod !== "app" ? el("button", { class: "btn inrow", type: "button", disabled: !hvCanUpd(h) || !!pending, onclick: ev => hvApply(ev.currentTarget, h.id) }, TX("settings.upd.btn")) : null;
    return el("div", { class: "li" }, el("span", { class: "lead" }, icon("harness")), el("span", { class: "tx" }, el("div", { class: "hd", text: h.name }), el("div", { class: "sup", text: hvSub(h) })),
      liEnd(h.available && !mine ? el("span", { class: "tag warn upd-new", text: TX("settings.tag.new_version") }) : null, state, hvSwitcher(h)));
  });
  if (pending) list.push(hvJobLine(pending));
  else for (const h of hs) if (h.job && h.job.status !== "current") list.push(hvJobLine(h.job));
  const notes = [hvNote(TX("settings.upd.rt_note"))];
  return [el("div", { class: "sec sec-act" }, el("span", { text: TX("settings.upd.rt_versions") }), hvNew() ? el("span", { class: "tag warn upd-new", text: TX("settings.tag.new_version") }) : null,
    el("button", { class: "btn tonal sm", type: "button", disabled: HV.press || !!(HV.info && HV.info.checking), onclick: ev => hvCheck(ev.currentTarget) }, HV.press ? TX("settings.upd.checking") : TX("settings.upd.check"))), el("div", { class: "list" }, ...list), ...notes];
}
function updateSection() {
  const i = UPD.info;
  const liDot = (title, sub) => el("div", { class: "li" }, el("span", { class: "lead" }, el("span", { class: "dot pri", "aria-hidden": "true" })), el("span", { class: "tx" }, el("div", { class: "hd", text: title }), sub ? el("div", { class: "sup", text: sub }) : null));
  const li = (title, sub, ...trail) => el("div", { class: "li" }, el("span", { class: "lead" }, icon("download")), el("span", { class: "tx" }, el("div", { class: "hd", text: title }), sub ? el("div", { class: "sup", text: sub }) : null), trail.length ? liEnd(...trail) : null);
  if (!i || i.error) return [el("div", { class: "list", id: "upd-sec" }, li(TX("settings.upd.app_version"), i ? i.error : TX("common.loading")))];
  const { running: run, disk, job, settings: s } = i;
  const jobRunning = job && job.status === "running";
  const { pending, c } = updState(i);
  const off = jobRunning || UPD.wait || UPD.checking ? { disabled: true } : {};
  // One row says the version; after a check its sub line also says it is the latest and when it was checked.
  const latest = !!(c && c.ok && !updAvailable() && !pending);
  const sub = UPD.checking ? TX("settings.upd.checking") : [TX("settings.upd.running", { version: updVer(run) }), latest ? TX("settings.upd.latest") : "", latest ? updAgo(c.at) : "", latest && c.ahead.length ? TX("settings.upd.ahead_n", { n: c.ahead.length }) : "", latest && c.dirty.length ? TX("settings.upd.dirty_n", { n: c.dirty.length }) : ""].filter(Boolean).join(" · ");
  const rows = [li(TX("settings.upd.app_version"), sub, el("button", { class: "btn tonal inrow", type: "button", ...off, onclick: ev => updCheck(ev.currentTarget) }, TX("settings.upd.check")))];
  if (c && !c.ok) rows.push(el("div", { class: "upd-box err" }, el("div", { class: "hd", text: c.error.reason }), el("div", { class: "sup" }, ...updCode(c.error.fix)), c.error.detail ? el("div", { class: "upd-detail", text: c.error.detail }) : null));
  else if (c && updAvailable()) {
    const more = c.incomingTotal - c.incoming.slice(0, 8).length;
    rows.push(el("div", { class: "upd-box" },
      el("div", { class: "hd", text: c.available ? TX("settings.upd.hd_new", { from: c.version && c.version.release ? c.version.release : TX("settings.upd.installed"), to: c.available }) : TX("settings.upd.hd_commits", { n: c.incomingTotal, upstream: c.upstream }) }),
      el("ul", { class: "upd-log" }, ...c.incoming.slice(0, 8).map(x => el("li", {}, el("code", { text: x.short }), el("span", { text: x.subject, title: x.subject }))), more > 0 ? el("li", { class: "dim" }, el("span", { text: TX("settings.upd.more_n", { n: more }) })) : null),
      c.available ? el("a", { class: "sup", href: `https://github.com/ddotz/dotz/releases/tag/v${c.available}`, target: "_blank", rel: "noopener", text: TX("settings.upd.release_notes") }) : null,
      c.blocked.length ? el("div", { class: "upd-block" }, ...c.blocked.map(b => el("div", { text: b }))) : null,
      c.keep ? updKeepBox(c.keep) : null,
      c.ahead.length && !c.keep ? el("div", { class: "sup", text: TX("settings.upd.ahead_note", { n: c.ahead.length }) }) : null,
      el("div", { class: "upd-act" }, el("button", { class: "btn", type: "button", ...(c.blocked.length || pending ? { disabled: true } : off), onclick: () => updNow() }, TX("settings.upd.now")), el("span", { class: "sup", text: TX("settings.upd.fail_stays") }))));
  }
  if (jobRunning) rows.push(liDot(TX("settings.upd.updating_phase", { phase: job.phase }), job.message));
  else if (job && job.status !== "current" && !(job.status === "updated" && !pending)) rows.push(el("div", { class: `upd-box ${job.status === "updated" ? "ok" : "err"}` }, el("div", { class: "upd-msg", text: job.keep && !(c && c.keep) ? job.keep.line : job.message }), job.keep && !(c && c.keep) ? updKeepBox(job.keep) : null));
  if (UPD.wait) rows.push(liDot(TX("settings.upd.wait_title"), UPD.wait.when === "now" ? TX("settings.upd.wait_now") : i.busy.length ? TX("settings.upd.wait_idle_busy", { busy: i.busy.join(", ") }) : TX("settings.upd.wait_idle")));
  else if (pending) rows.push(li(TX("settings.upd.got", { version: disk.commit.short }), TX("settings.upd.restart_to_apply"), el("button", { class: "btn inrow", type: "button", onclick: () => updRestart() }, TX("common.restart"))));
  const prefs = [el("div", { class: "li" }, el("span", { class: "lead" }, icon("bell")), el("span", { class: "tx" }, el("div", { class: "hd", text: TX("settings.upd.auto_check") }), el("div", { class: "sup", text: s.auto_apply ? TX("settings.upd.auto_check_apply") : TX("settings.upd.auto_check_note") })),
    liEnd(el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(s.auto_check), "aria-label": TX("settings.upd.auto_check"), onclick: () => updSet({ auto_check: !s.auto_check }) }))),
    el("div", { class: "li" }, el("span", { class: "lead" }, icon("download")), el("span", { class: "tx" }, el("div", { class: "hd", text: TX("settings.upd.auto_apply") }), el("div", { class: "sup", text: TX("settings.upd.auto_apply_note") })),
    liEnd(el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(!!s.auto_apply), "aria-label": TX("settings.upd.auto_apply"), onclick: () => updSet({ auto_apply: !s.auto_apply }) })))];
  return [el("div", { class: "list", id: "upd-sec" }, ...rows, ...prefs)];
}

/* ---------- settings: 앱 알림 per class (hub/notify-route.ts pushClasses; GET/PUT /api/push/classes) ---------- */
// The web app and the phone are one place, "앱 알림": one switch per notice class, the same on every device. The bell keeps every notice
// either way; a switch decides whether that class notifies. Each messenger has its own 알림 switches in its connection sheet (설정 → 메신저).
const NOTIFY_CLASSES = [["ask", TX("common.needs_reply"), TX("settings.notify.ask")], ["alert", TX("settings.notify.alert_label"), TX("settings.notify.alert")], ["result", TX("settings.notify.result_label"), TX("settings.notify.result")],
  ["news", TX("settings.notify.news_label"), TX("settings.notify.news")], ["conv", TX("common.conversation"), TX("settings.notify.conv")], ["log", TX("settings.notify.log_label"), TX("settings.notify.log")]];
// One plain row per class with a switch; `on(k)` reads a class's state, `set(k, on)` changes it, `only` limits the classes shown.
const notifyRows = (on, set, only) => NOTIFY_CLASSES.filter(([k]) => !only || only.includes(k)).map(([k, label, desc]) => el("div", { class: "li", "data-notify": k }, el("span", { class: "tx" }, el("div", { class: "hd", text: label }), el("div", { class: "sup", text: desc })),
  liEnd(el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(on(k)), "aria-label": TX("settings.app.gw_alerts", { name: label }), "data-k": k, onclick: () => set(k, !on(k)) }))));
const APPN = { v: null, asked: false };
async function appNotifyLoad() { APPN.asked = true; try { APPN.v = (await api("/api/push/classes")).classes; } catch { APPN.v = null; } if (inSettings()) renderSettings(); }
// Only the switches change: the page is not drawn again, so no section blinks away while the answer is on its way.
const appNotifyFlip = v => { for (const [k] of NOTIFY_CLASSES) { const b = document.querySelector(`[data-notify="${k}"] .hs-sw`); if (b) b.setAttribute("aria-checked", String(v[k] === true)); } };
async function appNotifySet(k, on) {
  const was = APPN.v[k];
  APPN.v = { ...APPN.v, [k]: on }; appNotifyFlip(APPN.v);
  try { APPN.v = (await api("/api/push/classes", "PUT", { classes: { [k]: on } })).classes; } catch (e) { APPN.v = { ...APPN.v, [k]: was }; toast(e.message, true); }
  appNotifyFlip(APPN.v);
}
function appNotifyRows() {
  if (!APPN.v && !APPN.asked) appNotifyLoad();
  if (!APPN.v) return [];
  return [...notifyRows(k => APPN.v[k] === true, appNotifySet), el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: TX("settings.notify.stays") })))];
}

function renderSettings() {
  if (rvPaint("settings")) return;   // a messenger-only computer is chosen: this computer's settings give way to a note (44-relay-views.js)
  const page = Object.hasOwn(SET_PAGE, current) ? SET_PAGE[current] : null;
  const box = $(page ? `#${current}` : "#settings");
  if (box.contains(document.activeElement) && openMenu) return;
  clear(box).append(...(page ? page.build() : settingsCols(settingsList(go))));
}
