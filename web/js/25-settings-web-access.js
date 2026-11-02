// 설정 → 웹 접속: how the web app is reached (GET/PUT /api/web-access, hub/web-access.ts). Off by default (Tailscale); the owner turns Cloudflare on here and the
// gateway switches live, no restart and no config file. The tunnel token is write-only: the page only learns whether one is stored ("저장됨").
const WA_MODES = [["tailscale", "Tailscale"], ["cloudflare", "Cloudflare"], ["local", "이 컴퓨터만"]];
const WA_HELP = {
  tailscale: "Tailscale로 연결한 내 기기에서 열어요. 기본값이에요.",
  cloudflare: "Cloudflare 터널로 고정 주소를 열어요. 처음 쓰는 기기는 패스키로 연결해야 해요.",
  local: "이 컴퓨터에서만 열어요. 다른 기기에서는 열리지 않아요."
};
const WA = { data: null, draft: null, fail: "", asked: false };
const waLabel = m => (WA_MODES.find(x => x[0] === m) || [m, m])[1];

async function loadWebAccess() {
  WA.asked = true;
  try { WA.data = await api("/api/web-access"); WA.fail = ""; } catch (e) { WA.data = null; WA.fail = e.message; }
  if (WA.data && !WA.draft) waReset();
  if (current === "webaccess") renderWebAccess();
  if (current === "settings") renderSettings();
}
function waReset() {
  const d = WA.data;
  WA.draft = { mode: d.mode, hostname: d.hostname, team: d.team, aud: d.aud, token: "" };
}
function waDirty() {
  const d = WA.data, f = WA.draft;
  return !!d && !!f && (f.mode !== d.mode || f.hostname.trim() !== d.hostname || f.team.trim() !== d.team || f.aud.trim() !== d.aud || f.token.trim() !== "");
}
/* the 설정 row */
function webAccessRow(row) {
  return row("open", "웹 접속", WA.data ? waLabel(WA.data.mode) : "", () => go("webaccess"));
}

function waTunnel(d) {
  const t = d.tunnel || { state: "off" };
  const [text, tone] = t.state === "running" ? ["연결됨", "ok"] : t.state === "starting" ? ["연결 중", "warn"] : t.state === "error" ? ["연결 안 됨", "err"] : ["꺼짐", ""];
  const hint = !d.cloudflared_found ? "cloudflared가 없어요. 터미널에서 brew install cloudflared 를 실행해 주세요."
    : t.error || (t.state === "running" ? "터널이 열려 있어요" : "");
  return el("div", { class: "li", "data-wa-tunnel": t.state },
    el("span", { class: "tx" }, el("div", { class: "hd", text: "터널" }), hint ? el("div", { class: tone === "err" || !d.cloudflared_found ? "sup dcs-err" : "sup", text: hint }) : null),
    el("span", { class: "dcs-trail" }, el("span", { class: `dot ${tone}`, "aria-hidden": "true" }), el("span", { class: `tag ${tone}`, text: text })));
}

function renderWebAccess() {
  const box = $("#webaccess");
  if (!WA.data || !WA.draft) { clear(box).append(WA.asked && WA.fail ? emptyNode("웹 접속 설정을 불러오지 못했어요") : emptyNode("불러오는 중")); return; }
  const d = WA.data, f = WA.draft, cf = f.mode === "cloudflare";
  const sync = () => { const b = box.querySelector("[data-wa-save]"); if (b) b.disabled = !waDirty(); };
  const field = (label, key, opts, hint) => el("div", {}, textField(label, input({ value: f[key], name: `wa-${key}`, ...opts, oninput: ev => { f[key] = ev.target.value; sync(); } })), hint ? el("div", { class: "sup", text: hint }) : null);
  const seg = el("div", { class: "tf" }, el("div", { class: "seg", role: "radiogroup", "aria-label": "접속 방식" },
    ...WA_MODES.map(([v, t]) => el("button", { type: "button", role: "radio", "aria-checked": String(v === f.mode), class: v === f.mode ? "on" : "", "data-v": v, onclick: () => { f.mode = v; renderWebAccess(); } }, t))));
  const nodes = [el("div", { class: "sec", text: "접속 방식" }),
    el("div", { class: "list" }, el("div", { class: "li dcs-form" }, seg, el("div", { class: "sup", "data-wa-help": f.mode, text: WA_HELP[f.mode] })))];
  if (cf) nodes.push(el("div", { class: "sec", text: "Cloudflare" }), el("div", { class: "list" }, el("div", { class: "li dcs-form" },
    field("주소", "hostname", { placeholder: "dotz.example.com", inputmode: "url" }, "터널의 Public Hostname이에요. 주소를 바꾸면 기기를 다시 연결해야 해요."),
    field("팀 이름 (선택)", "team", { placeholder: "myteam" }, "Cloudflare Access로 한 번 더 확인할 때만 적어요. AUD와 함께 적어요."),
    field("AUD (선택)", "aud", {}, "Access 애플리케이션의 Audience Tag예요."),
    el("div", {}, textField("터널 토큰", input({ type: "password", autocomplete: "new-password", name: "wa-token", placeholder: d.token_set ? "바꾸려면 새로 붙여 넣기" : "eyJ…", oninput: ev => { f.token = ev.target.value; sync(); } })),
      d.token_set ? el("div", { class: "tag ok dcs-saved", "data-wa-token-set": "1", text: "저장됨" }) : null,
      el("div", { class: "sup", text: "저장하면 이 컴퓨터에만 보관하고, 화면에는 다시 보여 주지 않아요." })))));
  if (d.mode === "cloudflare") {
    nodes.push(el("div", { class: "sec", text: "상태" }), el("div", { class: "list" }, waTunnel(d),
      el("button", { type: "button", class: "li tap", "data-wa-devices": "1", onclick: () => go("devices") },
        el("span", { class: "lead" }, icon("key")), el("span", { class: "tx" }, el("div", { class: "hd", text: "연결된 기기 (패스키)" })),
        el("span", { class: "sup", text: `${d.devices}대` }), icon("chev", "lead"))));
  }
  nodes.push(el("div", { class: "list ms-add" }, el("div", { class: "li dcs-form" }, el("div", { class: "dcs-acts" },
    el("button", { type: "button", class: "btn pri", "data-wa-save": "1", disabled: !waDirty(), onclick: ev => waSave(ev.currentTarget), text: "저장" }),
    waDirty() ? el("button", { type: "button", class: "btn tonal", "data-wa-cancel": "1", onclick: () => { waReset(); renderWebAccess(); }, text: "되돌리기" }) : null))));
  clear(box).append(...nodes);
}

async function waSave(btn) {
  const d = WA.data, f = WA.draft;
  if (f.mode === "cloudflare" && !f.hostname.trim()) return toast("주소를 적어 주세요", true);
  if (f.mode === "cloudflare" && !d.token_set && !f.token.trim()) return toast("터널 토큰을 붙여 넣어 주세요", true);
  if (f.mode === "cloudflare" && d.mode !== "cloudflare" && !(await ask("Cloudflare로 바꿀까요?", "저장하면 지금 쓰는 주소(Tailscale)로는 더 열리지 않아요. 새 주소로 들어가 메신저로 받은 코드로 이 기기를 연결해야 해요. 되돌리려면 연결한 기기에서 이 화면을 열어 Tailscale로 바꿔요.", "바꾸기", true))) return;
  const put = { mode: f.mode };
  if (f.mode === "cloudflare" || f.hostname.trim() !== d.hostname) put.hostname = f.hostname.trim();
  if (f.team.trim() !== d.team) put.team = f.team.trim();
  if (f.aud.trim() !== d.aud) put.aud = f.aud.trim();
  if (f.token.trim()) put.token = f.token.trim();
  await busy(btn, async () => {
    WA.data = await api("/api/web-access", "PUT", put);
    waReset();
    toast("저장했어요");
    renderWebAccess();
    loadDevices();
  });
}
