// 설정 → 웹 접속: how the web app is reached (GET/PUT /api/web-access, hub/web-access.ts; POST /api/web-access/onboard,
// hub/routes.ts). Tailscale is the default and keeps the plain PUT; Cloudflare and 이 컴퓨터만 start the onboarding flow.
// The manual hostname/team/aud/token and the tunnel status live in the closed "직접 입력" disclosure.
const WA_MODES = [["tailscale", "Tailscale"], ["cloudflare", "Cloudflare"], ["local", TX("connect.wa.local")]];
const WA_HELP = {
  tailscale: TX("connect.wa.tailscale_sub"),
  cloudflare: TX("connect.wa.cloudflare_sub"),
  local: TX("connect.wa.local_sub")
};
const WA = { data: null, draft: null, fail: "", asked: false, advOpen: false };
const waLabel = m => (WA_MODES.find(x => x[0] === m) || [m, m])[1];

async function loadWebAccess() {
  WA.asked = true;
  try { WA.data = await api("/api/web-access"); WA.fail = ""; } catch (e) { WA.data = null; WA.fail = e.message; }
  if (WA.data && !WA.draft) waReset();
  if (current === "webaccess") renderWebAccess();
  if (inSettings()) renderSettings();
}
function waReset() {
  const d = WA.data;
  WA.draft = { mode: d.mode, hostname: d.hostname, team: d.team, aud: d.aud, token: "" };
}
function waDirty() {
  const d = WA.data, f = WA.draft;
  return !!d && !!f && (f.hostname.trim() !== d.hostname || f.team.trim() !== d.team || f.aud.trim() !== d.aud || f.token.trim() !== "");
}
function webAccessRow(row) {
  return row("open", TX("connect.wa.title"), WA.data ? waLabel(WA.data.mode) : "", () => go("webaccess"));
}

function waTunnel(d) {
  const t = d.tunnel || { state: "off" };
  const [text, tone] = t.state === "running" ? [TX("connect.state.on"), "ok"] : t.state === "starting" ? [TX("connect.state.connecting"), "warn"] : t.state === "error" ? [TX("settings.prov.not_connected"), "err"] : [TX("settings.fb.sw_off"), ""];
  const hint = !d.cloudflared_found ? TX("connect.wa.no_tunnel_hint")
    : t.error || (t.state === "running" ? TX("connect.wa.tunnel_open") : "");
  return el("div", { class: "li", "data-wa-tunnel": t.state },
    el("span", { class: "lead" }, el("span", { class: `dot ${tone}`, "aria-hidden": "true" })),
    el("span", { class: "tx" }, el("div", { class: "hd", text: TX("connect.wa.tunnel") }), hint ? el("div", { class: tone === "err" || !d.cloudflared_found ? "sup dcs-err" : "sup", text: hint }) : null),
    liEnd(el("span", { class: `tag ${tone}`, text })));
}

// Choosing Cloudflare or 이 컴퓨터만 starts the auto path at once; the flow itself asks for the one owner action.
async function waOnboard(mode) {
  if (!WA.draft) return;
  const hostname = WA.draft.hostname.trim();
  WA.draft = { ...WA.draft, mode };
  renderWebAccess();
  try { obApply("web-access", await api("/api/web-access/onboard", "POST", mode === "cloudflare" && hostname ? { mode, hostname } : { mode })); }
  catch (e) { toast(e.message, true); }
}
async function waPickTailscale(btn) {
  if (!WA.draft) return;
  await busy(btn, async () => {
    WA.data = await api("/api/web-access", "PUT", { mode: "tailscale" });
    waReset();
    if (current === "webaccess") renderWebAccess();
    if (inSettings()) renderSettings();
    loadDevices();
  });
}
function waAdvanced(d, f) {
  const field = (label, key, opts, hint) => el("div", {}, textField(label, input({ value: f[key], name: `wa-${key}`, ...opts, oninput: ev => { f[key] = ev.target.value; waSync(); } })), hint ? el("div", { class: "sup", text: hint }) : null);
  const out = el("div", {}, el("div", { class: "list" }, el("div", { class: "li dcs-form" },
    field(TX("connect.wa.host"), "hostname", { placeholder: "dotz.example.com", inputmode: "url" }, TX("connect.wa.host_help")),
    field(TX("connect.wa.team"), "team", { placeholder: "myteam" }, TX("connect.wa.team_help")),
    field(TX("connect.wa.aud"), "aud", {}, TX("connect.wa.aud_help")),
    el("div", {}, textField(TX("connect.wa.token"), input({ type: "password", autocomplete: "new-password", name: "wa-token", placeholder: d.token_set ? TX("connect.paste_new") : "eyJ…", oninput: ev => { f.token = ev.target.value; waSync(); } })),
      d.token_set ? el("div", { class: "tag ok dcs-saved", "data-wa-token-set": "1", text: TX("connect.saved_tag") }) : null,
      el("div", { class: "sup", text: TX("connect.wa.token_help") })),
    el("div", { class: "dcs-acts" },
      el("button", { type: "button", class: "btn", "data-wa-save": "1", disabled: !waDirty(), onclick: ev => waSave(ev.currentTarget), text: TX("common.save") }),
      waDirty() ? el("button", { type: "button", class: "btn tonal", "data-wa-cancel": "1", onclick: () => { waReset(); renderWebAccess(); }, text: TX("connect.revert") }) : null))));
  return out;
}
function waSync() { const b = document.querySelector("#webaccess [data-wa-save]"); if (b) b.disabled = !waDirty(); }

function renderWebAccess() {
  const box = $("#webaccess");
  if (!WA.data || !WA.draft) { clear(box).append(WA.asked && WA.fail ? emptyNode(TX("connect.wa.load_failed")) : emptyNode(TX("connect.loading"))); return; }
  const d = WA.data, f = WA.draft, cf = f.mode === "cloudflare";
  const modes = el("div", { class: "list", role: "radiogroup", "aria-label": TX("connect.wa.mode") },
    ...WA_MODES.map(([v, t]) => el("button", { type: "button", role: "radio", "aria-checked": String(v === f.mode), class: "li tap", "data-v": v, onclick: ev => v === "tailscale" ? waPickTailscale(ev.currentTarget) : waOnboard(v) },
      el("span", { class: "tx" }, el("div", { class: "hd", text: t }), el("div", { class: "sup", "data-wa-help": v, text: WA_HELP[v] })),
      el("span", { class: "li-end" }, v === f.mode ? icon("check") : null))));
  const nodes = [el("div", { class: "sec", text: TX("connect.wa.mode") }), modes,
    el("div", { class: "sec", text: TX("connect.onb.title") }), onboardingPanel("web-access")];
  if (cf) nodes.push(el("div", { class: "sec", text: TX("connect.wa.status") }), el("div", { class: "list" }, waTunnel(d),
    el("button", { type: "button", class: "li tap", "data-wa-devices": "1", onclick: () => go("devices") },
      el("span", { class: "lead" }, icon("key")), el("span", { class: "tx" }, el("div", { class: "hd", text: TX("connect.wa.devices") }), el("div", { class: "sup", text: TX("connect.wa.devices_sub") })),
      el("span", { class: "li-end" }, el("span", { class: "tag", text: TX("connect.dev.count", { n: d.devices }) }), icon("chev", "chev")))));
  if (cf) nodes.push(el("div", { class: "list" }, el("div", { class: "li" }, el("span", { class: "tx" },
    el("div", { class: "sup", "data-wa-plain": "1", text: TX("connect.wa.plain_note") })))));
  if (cf && !d.cloudflared_found) nodes.push(el("div", { class: "list" }, el("div", { class: "li" }, el("span", { class: "tx" },
    el("div", { class: "hd", text: TX("connect.wa.no_tunnel") }), el("div", { class: "sup dcs-err", "data-wa-cf-missing": "1", text: TX("connect.wa.install_hint") })))));
  // The toggle event arrives after a redraw can already have replaced the element, so read the live state.
  const prev = box.querySelector("details[data-wa-advanced]");
  if (prev) WA.advOpen = prev.open;
  const det = msAdvanced("data-wa-advanced", WA.advOpen, () => waAdvanced(d, f));
  det.addEventListener("toggle", () => { WA.advOpen = det.open; });
  nodes.push(det);
  clear(box).append(...nodes);
}

async function waSave(btn) {
  const d = WA.data, f = WA.draft;
  if (!d || !f) return;
  if (d.mode === "cloudflare" && !f.hostname.trim() && f.hostname.trim() !== d.hostname) return toast(TX("connect.wa.need_host"), true);
  const put = { mode: d.mode };
  if (f.hostname.trim() !== d.hostname) put.hostname = f.hostname.trim();
  if (f.team.trim() !== d.team) put.team = f.team.trim();
  if (f.aud.trim() !== d.aud) put.aud = f.aud.trim();
  if (f.token.trim()) put.token = f.token.trim();
  let saved = false;
  await busy(btn, async () => {
    WA.data = await api("/api/web-access", "PUT", put);
    waReset();
    saved = true;
    if (current === "webaccess") renderWebAccess();
    loadDevices();
  });
  if (saved) stFlash("#webaccess [data-wa-save]");
}
