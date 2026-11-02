// 연결 자동 설정 패널 (hub/onboarding.ts, /api/onboarding/<key>): every messenger screen and 웹 접속 share it. Start runs the
// automatic steps; the panel names the one owner action while it waits and offers continue/cancel. It polls GET while the
// flow runs, and only ever draws what the view holds: no token, no error the API did not send.
const OB = {};
const OB_POLL_MS = 1500;
const OB_AUTO_MS = 4000;
const OB_AUTO_MAX = 15;
const obKeyOk = key => key === "web-access" || key === "discord" || key === "jandi" || key === "slack" || key === "telegram";
const obVisible = key => key === "web-access" ? current === "webaccess" : current === key;
const obLine = v => v.state === "waiting" ? "내가 할 일이 하나 남았어요." : v.state === "running" ? "자동으로 연결하는 중이에요." : v.state === "done" ? "연결했어요." : v.state === "failed" ? "연결하지 못했어요." : "아직 시작하지 않았어요.";
function obPaint(key) {
  if (key === "web-access") { if (current === "webaccess") renderWebAccess(); return; }
  if (current !== key) return;
  key === "discord" ? renderDiscord() : renderMessenger(key);
}
function obStop(o) { if (o && o.timer) clearTimeout(o.timer); if (o) o.timer = 0; }
function obAutoStop(o) { if (o && o.autoTimer) clearTimeout(o.autoTimer); if (o) o.autoTimer = 0; }
// Waiting is an owner action the flow can finish by itself once done: continue every 4 s, at most 15 times, and never
// after the panel left the screen or the flow moved on.
function obAuto(key) {
  const o = OB[key];
  if (!o || o.state !== "waiting" || !obVisible(key)) { obAutoStop(o); return; }
  if (o.autoTries >= OB_AUTO_MAX) return;
  if (o.autoTimer || o.autoBusy) return;
  o.autoTimer = setTimeout(async () => {
    const cur = OB[key];
    if (!cur || cur.state !== "waiting" || !obVisible(key) || cur.autoBusy) { if (cur) cur.autoTimer = 0; return; }
    cur.autoTimer = 0;
    cur.autoBusy = true;
    cur.autoTries++;
    try { obApply(key, await api(`/api/onboarding/${enc(key)}/continue`, "POST")); }
    catch { obAutoStop(cur); }
    finally {
      const now = OB[key];
      if (now) { now.autoBusy = false; if (now.state === "waiting" && now.autoTries < OB_AUTO_MAX) obAuto(key); }
    }
  }, OB_AUTO_MS);
}
function obApply(key, next) {
  const before = OB[key] || {};
  const was = before.state;
  const sameWait = next.state === "waiting" && was === "waiting";
  obStop(before);
  if (!sameWait) obAutoStop(before);
  OB[key] = { ...before, ...next, timer: 0, ...(sameWait ? { autoTimer: before.autoTimer || 0 } : { autoTimer: 0 }) };
  if (next.state === "waiting" && !sameWait) { OB[key].autoTries = 0; OB[key].autoBusy = false; }
  obPaint(key);
  obPoll(key);
  if (next.state === "waiting" && !sameWait) obAuto(key);
  if (next.state === "done" && was && was !== "done" && !before.doneHandled) {
    OB[key].doneHandled = true;
    obAfterDone(key);
  }
}
// A finished flow reloads the index and the screen it belongs to, so the header and switches show the new state.
function obAfterDone(key) {
  loadMessengerIndex();
  if (key === "web-access") { WA.draft = null; loadWebAccess(); return; }
  if (key === "discord") { loadDiscord(); return; }
  loadMessengerSettings(key);
}
async function loadOnboarding(key) {
  if (!obKeyOk(key)) return;
  try { obApply(key, await api(`/api/onboarding/${enc(key)}`)); }
  catch { obPaint(key); }
}
async function obStart(key, btn) {
  if (OB[key]) obAutoStop(OB[key]);
  delete OB[key];
  await busy(btn, async () => { obApply(key, await api(`/api/onboarding/${enc(key)}/start`, "POST")); });
}
async function obAct(key, action, btn) {
  await busy(btn, async () => { obApply(key, await api(`/api/onboarding/${enc(key)}/${action}`, "POST")); });
}
function obPoll(key) {
  const o = OB[key];
  if (!o || (o.state !== "running" && o.state !== "waiting")) { obStop(o); return; }
  if (!obVisible(key)) { obStop(o); obAutoStop(o); return; }
  if (o.timer) return;
  o.timer = setTimeout(async () => {
    o.timer = 0;
    if (OB[key] !== o || !obVisible(key)) { obStop(o); obAutoStop(o); return; }
    try { obApply(key, await api(`/api/onboarding/${enc(key)}`)); }
    catch { obPoll(key); }
  }, OB_POLL_MS);
}
// The panel: state, current step, error (only when the API sent one), the single owner line, and its actions.
function onboardingPanel(key) {
  const v = OB[key] || { state: "idle", step: null, owner: null, error: null, url: null };
  const waiting = v.state === "waiting", failed = v.state === "failed", running = v.state === "running";
  const rows = [el("div", { class: "li" }, el("span", { class: "lead" }, icon("spark")), el("span", { class: "tx" },
    el("div", { class: "hd", text: "자동 연결" }), el("div", { class: "sup", "data-onb-line": "1", text: obLine(v) })))];
  if (v.step) rows.push(el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "hd", text: v.step.title }), el("div", { class: "sup", text: v.step.detail }))));
  if (v.error) rows.push(el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "dcs-err", role: "alert", "data-onb-error": "1", text: v.error }))));
  if ((waiting || failed) && v.owner) rows.push(el("div", { class: "li", "data-onb-owner": v.owner.label },
    el("span", { class: "tx" }, el("div", { class: "hd", text: v.owner.label }), el("div", { class: "sup", text: v.owner.hint }))));
  if (v.url) rows.push(el("div", { class: "li" }, el("span", { class: "tx" }, el("a", { class: "btn tonal", href: v.url, target: "_blank", rel: "noopener noreferrer", "data-onb-url": "1", text: v.url }))));
  const acts = [
    ...(waiting || failed ? [el("button", { type: "button", class: "btn", "data-onb-continue": "1", onclick: ev => obAct(key, "continue", ev.currentTarget) }, "계속")] : []),
    ...(running || waiting ? [el("button", { type: "button", class: "btn text", "data-onb-cancel": "1", onclick: ev => obAct(key, "cancel", ev.currentTarget) }, "취소")] : []),
    ...(failed ? [el("button", { type: "button", class: "btn tonal", "data-onb-start": "1", onclick: ev => obStart(key, ev.currentTarget) }, "다시 시작")] : []),
  ];
  if (acts.length) rows.push(el("div", { class: "li ms-onb-acts" }, ...acts));
  return el("div", { class: "list ms-onb", "data-onb": key, "data-onb-state": v.state }, ...rows);
}
// The closed disclosure that keeps manual fields out of the default view: its body is built only when opened.
function msAdvanced(attr, open, body) {
  const box = el("div", { class: "ms-adv-body" });
  const d = el("details", { class: "ms-adv", [attr]: "1", ...(open ? { open: true } : {}) }, el("summary", { class: "ms-adv-sum", text: "직접 입력" }), box);
  let built = false;
  const fill = () => { if (!built) { built = true; box.append(body()); } };
  d.addEventListener("toggle", () => { d.dataset.open = d.open ? "1" : ""; if (d.open) fill(); });
  d.dataset.open = open ? "1" : "";
  if (open) fill();
  return d;
}
