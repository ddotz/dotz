// 설정 → 연결된 기기 (패스키): the browsers paired for web.access = "cloudflare" (hub/devices.ts: GET /api/devices, PATCH/DELETE /api/devices/<id>,
// POST /api/devices/code). The settings entry shows only when that list answers, which it does only in cloudflare mode; other installs never see it.
// A row opens a dialog to rename or unpair the device; "새 기기 연결" explains the /pair flow and can make a code right here.
const DEV = { items: null, fail: "", asked: false };
const dvDate = iso => { const t = Date.parse(iso || ""); return isNaN(t) ? "" : new Date(t).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }); };
const dvUsed = d => d.last_used ? `마지막 사용 ${msAgo(Date.parse(d.last_used))}` : "아직 쓰지 않음";

async function loadDevices() {
  DEV.asked = true;
  try { const v = await api("/api/devices"); DEV.items = Array.isArray(v) ? v : null; DEV.fail = ""; } catch (e) { DEV.items = null; DEV.fail = e.message; }
  if (current === "devices") renderDevices();
  if (current === "settings") renderSettings();
}
/* the 설정 row: only where the gateway keeps paired devices */
function devicesRow(row) {
  if (!DEV.items) return null;
  return row("key", "연결된 기기 (패스키)", `${DEV.items.length}대`, () => go("devices"));
}

function renderDevices() {
  const box = $("#devices");
  if (!DEV.items) { clear(box).append(DEV.asked && DEV.fail ? emptyNode("연결된 기기를 불러오지 못했어요") : emptyNode("불러오는 중")); return; }
  const row = d => el("button", { type: "button", class: "li tap", "data-dev": d.id, onclick: () => dvOpen(d) },
    el("span", { class: "lead" }, el("span", { class: `dot ${d.last_used && Date.now() - Date.parse(d.last_used) < 864e5 ? "ok" : ""}`, "aria-hidden": "true" })),
    el("span", { class: "tx" }, el("div", { class: "hd", text: d.name }), el("div", { class: "sup", text: `${dvDate(d.created)} 연결 · ${dvUsed(d)}` })),
    el("span", { class: "dcs-trail" }, d.current ? el("span", { class: "tag ok", "data-current": "1", text: "이 기기" }) : null, icon("chev", "lead")));
  const self = DEV.items.some(d => d.current);
  // the add action lives in the section header (docs/ui-spec.md 설정 행); a browser without a passkey gets one more row in the list
  const addSelf = el("button", { type: "button", class: "li tap", "data-dev-self": "1", onclick: () => dvNew(true) },
    el("span", { class: "lead" }, icon("add")), el("span", { class: "tx" }, el("div", { class: "hd", text: "이 기기에 패스키 추가" }), el("div", { class: "sup", text: "이 브라우저는 패스키 없이 들어왔어요" })));
  clear(box).append(
    el("div", { class: "sec sec-act" }, el("span", { text: "이 웹앱을 쓸 수 있는 기기" }), el("button", { type: "button", class: "btn tonal sm", "data-dev-new": "1", onclick: () => dvNew(false), text: "새 기기 연결" })),
    el("div", { class: "list" }, ...(DEV.items.length ? DEV.items.map(row) : [el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: "연결된 기기가 없어요" })))]), self ? null : addSelf));
}

/* ---------- one device: rename, unpair ---------- */
function dvOpen(d) {
  const name = input({ value: d.name, maxlength: "60", name: "dev-name" });
  const body = el("div", { class: "col" }, textField("기기 이름", name),
    el("div", { class: "sup", text: `${dvDate(d.created)} 연결 · ${dvUsed(d)}` }),
    d.current ? el("div", { class: "tag ok dcs-saved", text: "지금 쓰고 있는 기기" }) : null);
  dialog({ title: d.name, body, actions: [
    { label: "해제", kind: "danger", onclick: async (c, b) => {
      const text = d.current
        ? "지금 쓰고 있는 이 기기를 해제해요. 바로 로그아웃되고, 다시 쓰려면 메신저로 받은 코드로 새로 연결해야 해요."
        : `${d.name}의 로그인이 바로 끊겨요. 다시 쓰려면 코드로 새로 연결해야 해요.`;
      if (!(await ask("기기 해제", text, "해제", true))) return;
      await busy(b, async () => {
        await api(`/api/devices/${enc(d.id)}`, "DELETE");
        c();
        if (d.current) return location.replace("/pair");
        toast("기기를 해제했어요");
        await loadDevices();
      });
    } },
    { label: "닫기", onclick: c => c() },
    { label: "저장", kind: "pri", onclick: async (c, b) => {
      const v = name.value.trim();
      if (!v) return toast("이름을 적어 주세요", true);
      if (v === d.name) return c();
      await busy(b, async () => { await api(`/api/devices/${enc(d.id)}`, "PATCH", { name: v }); c(); toast("저장했어요"); await loadDevices(); });
    } }] });
}

/* ---------- a new device (or this one) ---------- */
function dvNew(self) {
  const res = el("div", { class: "dcs-res" });
  const steps = self
    ? ["아래에서 코드를 만들어요.", "'연결 화면 열기'를 눌러 코드와 이 기기 이름을 넣어요.", "패스키(Face ID, 지문, Windows Hello 등)로 확인하면 끝나요."]
    : ["새 기기의 브라우저에서 이 웹앱 주소를 열어요. '기기 연결' 화면이 나와요.", "'코드 받기'를 누르면 6자리 코드가 메신저 알림으로 와요. 메신저를 볼 수 없으면 아래에서 바로 만들 수 있어요.", "코드와 기기 이름을 넣고 패스키(Face ID, 지문, Windows Hello 등)로 확인하면 끝나요."];
  const make = btn => busy(btn, async () => {
    const o = await api("/api/devices/code", "POST", {});
    const addr = input({ value: o.url, readonly: true, name: "dev-url", onfocus: ev => ev.target.select() });
    clear(res).append(
      el("div", { class: "dv-code", "data-dev-code": o.code, text: o.code }),
      el("div", { class: "sup", text: `${o.minutes}분 동안 한 번만 쓸 수 있어요. 새 코드를 만들면 이 코드는 사라져요.` }),
      el("div", { class: "tf" }, el("label", { text: "연결 화면 주소", for: addr.id }), el("div", { class: "ms-copy" }, addr,
        self ? el("a", { class: "btn tonal", href: o.url, target: "_blank", rel: "noopener", text: "연결 화면 열기" })
          : el("button", { type: "button", class: "btn tonal", onclick: () => { try { navigator.clipboard.writeText(o.url); } catch {} toast("복사했어요"); }, text: "복사" }))));
  });
  const body = el("div", { class: "col" },
    el("ol", { class: "steps" }, ...steps.map(s => el("li", { text: s }))),
    el("div", { class: "sup", text: "코드는 10분 동안 한 번만 쓸 수 있고, 메신저와 이 화면을 합쳐 한 시간에 3번까지 만들 수 있어요." }),
    el("div", { class: "dcs-acts" }, el("button", { type: "button", class: "btn tonal", "data-dev-make": "1", onclick: ev => make(ev.currentTarget), text: "여기서 코드 만들기" })),
    res);
  dialog({ title: self ? "이 기기에 패스키 추가" : "새 기기 연결", body, onclose: () => loadDevices(), actions: [{ label: "닫기", onclick: c => c() }] });
}
