/* ---------- settings: 업데이트 (hub/selfupdate.ts, /api/update*) ---------- */
// Version on disk vs the version this gateway runs, the last check, the running/finished update job, and the restart that
// applies it. After a restart request the page polls until the gateway answers with a new boot id.
const UPD = { info: null, wait: null, timer: 0 };
const updWhen = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); };
const updVer = v => !v ? "알 수 없음" : v.kind === "git" ? `${v.commit.short} · ${updWhen(v.commit.date)}${v.branch !== "main" ? ` · ${v.branch}` : ""}` : v.kind === "install" ? `설치본 · ${updWhen(v.installed)}` : "알 수 없음";
// `cmd` spans in server hints become <code>.
const updCode = s => String(s || "").split("`").map((p, i) => i % 2 ? el("code", { text: p }) : p);
// A pulled-but-not-restarted update (running != disk), and the last check when it still describes the checkout. A check made
// before the checkout moved (an update just landed) no longer describes it.
function updState(i) {
  const { running: run, disk } = i || {};
  const pending = !!(run && disk && run.kind === "git" && disk.kind === "git" && run.commit.sha !== disk.commit.sha);
  const c = i && i.lastCheck && !(disk && disk.kind === "git" && i.lastCheck.version.kind === "git" && i.lastCheck.version.commit.sha !== disk.commit.sha) ? i.lastCheck : null;
  return { pending, c };
}
// A new version is waiting to be applied (from /api/update, not the toast).
function updAvailable() {
  const i = UPD.info;
  if (!i || i.error) return false;
  const { pending, c } = updState(i);
  return !!(c && c.ok && c.incomingTotal > 0 && !pending);
}
function paintUpdBadge() { const b = $("#nav-upd"); if (b) b.hidden = !updAvailable(); }
async function loadUpdate() {
  clearTimeout(UPD.timer);
  try { UPD.info = await api("/api/update"); } catch (e) { UPD.info = { error: e.message }; }
  paintUpdBadge();
  if (UPD.info.job && UPD.info.job.status === "running") UPD.timer = setTimeout(loadUpdate, 1500);
  if (current === "settings") renderSettings();
}
async function updCheck(btn) {
  await busy(btn, async () => {
    const c = await api("/api/update/check", "POST");
    UPD.info = { ...UPD.info, lastCheck: c };
    paintUpdBadge();
    if (c.ok) toast(c.incomingTotal ? `새 커밋 ${c.incomingTotal}개가 있어요` : "최신 버전이에요");
  });
  renderSettings();
}
async function updApply(btn) {
  await busy(btn, async () => { UPD.info.job = (await api("/api/update/apply", "POST")).job; });
  loadUpdate();
}
async function updSet(values) {
  try { UPD.info.settings = (await api("/api/update/settings", "PUT", values)).settings; } catch (e) { toast(e.message, true); }
  renderSettings();
}
function updRestart() {
  const working = (UPD.info && UPD.info.busy) || [];
  const fire = async when => {
    const boot = UPD.info.boot;
    try { await api("/api/update/restart", "POST", { when }); } catch (e) { return toast(e.message, true); }
    UPD.wait = { boot, when };
    renderSettings();
    updWaitTick();
  };
  if (!working.length) return fire("idle");
  dialog({ title: "재시작", body: el("div", { class: "col" }, el("p", { class: "sup", text: `지금 일하는 중: ${working.join(", ")}` }), el("p", { class: "sup", text: "작업이 끝난 뒤 재시작하거나, 지금 끊고 재시작할 수 있어요. 끊긴 요청은 다시 켜질 때 이어서 보내요." })), actions: [
    { label: "작업이 끝나면", onclick: c => { c(); fire("idle"); } },
    { label: "지금 재시작", kind: "pri", onclick: c => { c(); fire("now"); } }] });
}
async function updWaitTick() {
  if (!UPD.wait) return;
  const info = await fetch("/api/update", { cache: "no-store" }).then(r => r.ok ? r.json() : null, () => null);
  if (info && info.boot !== UPD.wait.boot) {
    UPD.wait = null;
    UPD.info = info;
    paintUpdBadge();
    toast(`다시 시작했어요 · 지금 버전 ${info.running && info.running.commit ? info.running.commit.short : "?"}`);
    if (current === "settings") renderSettings();
    return;
  }
  if (info) { UPD.info = info; paintUpdBadge(); if (current === "settings") renderSettings(); }
  setTimeout(updWaitTick, 2000);
}
function updateSection() {
  const i = UPD.info;
  const li = (title, sub, ...trail) => el("div", { class: "li" }, el("span", { class: "lead" }, icon("download")), el("span", { class: "tx" }, el("div", { class: "hd", text: title }), sub ? el("div", { class: "sup", text: sub }) : null), ...trail);
  const head = el("div", { class: "sec" }, "업데이트", updAvailable() ? el("span", { class: "tag warn upd-new", text: "새 버전" }) : null);
  if (!i || i.error) return [head, el("div", { class: "list" }, li("dotz 버전", i ? i.error : "불러오는 중…"))];
  const { running: run, disk, job, settings: s } = i;
  const jobRunning = job && job.status === "running";
  const { pending, c } = updState(i);
  const off = jobRunning || UPD.wait ? { disabled: true } : {};
  const rows = [li("dotz 버전", `실행 중 ${updVer(run)}`, el("button", { class: "btn tonal", type: "button", ...off, onclick: ev => updCheck(ev.currentTarget) }, "확인"))];
  if (c && !c.ok) rows.push(el("div", { class: "upd-box err" }, el("div", { class: "hd", text: c.error.reason }), el("div", { class: "sup" }, ...updCode(c.error.fix)), c.error.detail ? el("div", { class: "upd-detail", text: c.error.detail }) : null));
  else if (c && !c.incomingTotal) rows.push(li("최신 버전이에요", `${c.upstream} · 확인 ${updWhen(c.at)}${c.ahead.length ? ` · ${c.upstream}에 없는 로컬 커밋 ${c.ahead.length}개 (아직 올리지 않음)` : ""}${c.dirty.length ? ` · 커밋 안 한 변경 ${c.dirty.length}개` : ""}`));
  else if (c) {
    const more = c.incomingTotal - c.incoming.slice(0, 8).length;
    rows.push(el("div", { class: "upd-box" },
      el("div", { class: "hd", text: `새 커밋 ${c.incomingTotal}개 · ${c.upstream}` }),
      el("ul", { class: "upd-log" }, ...c.incoming.slice(0, 8).map(x => el("li", {}, el("code", { text: x.short }), el("span", { text: x.subject, title: x.subject }))), more > 0 ? el("li", { class: "dim" }, el("span", { text: `외 ${more}개` })) : null),
      c.blocked.length ? el("div", { class: "upd-block" }, ...c.blocked.map(b => el("div", { text: b })), el("ul", { class: "upd-log" }, ...c.dirty.slice(0, 8).map(d => el("li", {}, el("code", { text: d.slice(0, 2).trim() || "?" }), el("span", { text: d.slice(3) }))), ...c.ahead.slice(0, 8).map(a => el("li", {}, el("code", { text: a.short }), el("span", { text: a.subject }))))) : null,
      el("div", { class: "upd-act" }, el("button", { class: "btn", type: "button", ...(c.blocked.length || pending ? { disabled: true } : off), onclick: ev => updApply(ev.currentTarget) }, "지금 업데이트"), el("span", { class: "sup", text: "fast-forward → 테스트 → 재시작. 테스트가 실패하면 그대로 있어요." }))));
  }
  if (jobRunning) rows.push(li(`업데이트 중 · ${job.phase}`, job.message, el("span", { class: "dot pri", "aria-hidden": "true" })));
  else if (job && job.status !== "current" && !(job.status === "updated" && !pending)) rows.push(el("div", { class: `upd-box ${job.status === "updated" ? "ok" : "err"}` }, el("div", { class: "upd-msg", text: job.message })));
  if (UPD.wait) rows.push(li("재시작 기다리는 중", UPD.wait.when === "now" ? "곧 다시 켜져요. 이 화면은 자동으로 다시 연결돼요." : `작업이 끝나면 다시 켜져요${i.busy.length ? ` (${i.busy.join(", ")})` : ""}. 이 화면은 자동으로 다시 연결돼요.`, el("span", { class: "dot pri", "aria-hidden": "true" })));
  else if (pending) rows.push(li(`새 버전 ${disk.commit.short} 받음`, "재시작하면 적용돼요", el("button", { class: "btn", type: "button", onclick: () => updRestart() }, "재시작")));
  rows.push(el("div", { class: "li" }, el("span", { class: "lead" }, icon("bell")), el("span", { class: "tx" }, el("div", { class: "hd", text: "매일 자동 확인" }), el("div", { class: "sup", text: "새 버전이 있으면 알림만 보내요. 적용은 직접 해요." })),
    s.auto_check ? el("input", { class: "upd-at", type: "time", value: s.at, "aria-label": "확인 시각", onchange: ev => updSet({ at: ev.currentTarget.value }) }) : null,
    el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(s.auto_check), "aria-label": "매일 자동 확인", onclick: () => updSet({ auto_check: !s.auto_check }) })));
  return [head, el("div", { class: "list" }, ...rows)];
}

function renderSettings() {
  const box = $("#settings");
  if (box.contains(document.activeElement) && openMenu) return;
  const om = M && M.orchestrator;
  const connected = P ? P.providers.filter(isConnected).length : null;
  const row = (ic, title, sub, onclick, trail) => el("button", { class: "li tap", type: "button", onclick: ev => onclick(ev.currentTarget) }, el("span", { class: "lead" }, icon(ic)), el("span", { class: "tx" }, el("div", { class: "hd", text: title })), sub ? el("span", { class: "sup", text: sub }) : null, trail === undefined ? icon("chev", "lead") : trail);
  const d = S && S.discord;
  clear(box).append(el("div", { class: "list" },
    row("model", "모델 · 폴백", om ? `${modelName(om.model)} · ${om.thinking}` : "", () => openModels("orchestrator")),
    row("key", "공급자", connected != null ? `${connected}개 연결` : "", () => go("providers")),
    row("usage", "사용량", "", () => go("usage")),
    row("context", "컨텍스트", "", () => go("context")),
    row("harness", "구성", "시스템 지도", () => go("harness")),
    row(themeIc(), "화면 모드", themeIs() === "dark" ? "다크" : "라이트", () => toggleTheme(), null),
    d && d.enabled ? el("div", { class: "li" }, el("span", { class: "lead" }, icon("discord")), el("span", { class: "tx" }, el("div", { class: "hd", text: "Discord" })), el("span", { class: `tag ${d.connected ? "ok" : "warn"}`, text: d.connected ? "연결됨" : "연결 중" })) : null),
    ...pushSection(), ...updateSection(), ...accountSection(), ...rtSection());
}
