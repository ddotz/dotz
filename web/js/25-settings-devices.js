// 설정 → 연결된 기기 (패스키): the browsers paired for web.access = "cloudflare" (hub/devices.ts: GET /api/devices, PATCH/DELETE /api/devices/<id>,
// POST /api/devices/code). The settings entry shows only when that list answers, which it does only in cloudflare mode; other installs never see it.
// A row opens a dialog to rename or unpair the device; "새 기기 연결" explains the /pair flow and can make a code right here.
const DEV = { items: null, fail: "", asked: false };
// This year's date drops the year ("9월 30일") so the line under the name stays on one line on a phone; an older one keeps it.
const dvDate = iso => {
  const t = Date.parse(iso || "");
  if (isNaN(t)) return "";
  const yr = x => new Date(x).toLocaleDateString(TX_LOCALE, { ...KST, year: "numeric" });
  return new Date(t).toLocaleDateString(TX_LOCALE, { ...KST, ...(yr(t) === yr(Date.now()) ? {} : { year: "numeric" }), month: "long", day: "numeric" });
};
const dvUsed = d => d.last_used ? TX("connect.dev.last_used", { ago: msAgo(Date.parse(d.last_used)) }) : TX("connect.dev.never");

async function loadDevices() {
  DEV.asked = true;
  try { const v = await api("/api/devices"); DEV.items = Array.isArray(v) ? v : null; DEV.fail = ""; } catch (e) { DEV.items = null; DEV.fail = e.message; }
  if (current === "devices") renderDevices();
  if (inSettings()) renderSettings();
}
/* the 설정 row: only where the gateway keeps paired devices */
function devicesRow(row) {
  if (!DEV.items) return null;
  return row("desktop", TX("connect.dev.title"), TX("connect.dev.count", { n: DEV.items.length }), () => go("devices"));
}

function renderDevices() {
  const box = $("#devices");
  if (!DEV.items) { clear(box).append(DEV.asked && DEV.fail ? emptyNode(TX("connect.dev.load_failed")) : emptyNode(TX("connect.loading"))); return; }
  const row = d => el("button", { type: "button", class: "li tap", "data-dev": d.id, onclick: () => dvOpen(d) },
    el("span", { class: "lead" }, icon("desktop")),
    el("span", { class: "tx" }, el("div", { class: "hd", text: d.name }), el("div", { class: "sup", text: [TX("connect.dev.connected_on", { date: dvDate(d.created) }), dvUsed(d)].join(" · ") })),
    el("span", { class: "li-end" }, d.current ? el("span", { class: "tag ok", "data-current": "1", text: TX("settings.app.this_device") }) : null, icon("chev", "chev")));
  const self = DEV.items.some(d => d.current);
  // the add action lives in the section header (docs/ui-spec.md 설정 행); a browser without a passkey gets one more row in the list
  const addSelf = el("button", { type: "button", class: "li tap", "data-dev-self": "1", onclick: () => dvNew(true) },
    el("span", { class: "lead" }, icon("add")), el("span", { class: "tx" }, el("div", { class: "hd", text: TX("connect.dev.add_passkey") }), el("div", { class: "sup", text: TX("connect.dev.no_passkey") })));
  clear(box).append(
    el("div", { class: "sec", text: TX("connect.dev.sec") }),
    el("div", { class: "list" }, ...(DEV.items.length ? DEV.items.map(row) : [el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: TX("connect.dev.none") })))]), self ? null : addSelf,
      el("button", { type: "button", class: "li tap", "data-dev-new": "1", onclick: () => dvNew(false) },
        el("span", { class: "lead" }, icon("add")), el("span", { class: "tx" }, el("div", { class: "hd", text: TX("connect.dev.add") })))));
}

/* ---------- one device: rename, unpair ---------- */
function dvOpen(d) {
  const name = input({ value: d.name, maxlength: "60", name: "dev-name" });
  const nameErr = el("p", { class: "err-t", hidden: true, role: "alert" });   // under the field, as the login dialog does
  const err = usErr();
  const body = el("div", { class: "col" }, textField(TX("connect.dev.name"), name), nameErr,
    el("div", { class: "sup", text: [TX("connect.dev.connected_on", { date: dvDate(d.created) }), dvUsed(d)].join(" · ") }),
    d.current ? el("div", { class: "tag ok dcs-saved", text: TX("connect.dev.current") }) : null, err);
  const dlg = dialog({ title: d.name, body, mid: true, actions: acGap([
    { label: TX("connect.dev.remove"), kind: "danger", onclick: async (c, b) => {
      const text = d.current
        ? TX("connect.dev.remove_self")
        : TX("connect.dev.remove_other", { name: d.name });
      b.disabled = true;
      if (!(await ask(TX("connect.dev.remove_title"), text, TX("connect.dev.remove"), true))) { b.disabled = false; return; }
      await usRun(b, err, async () => {
        await api(`/api/devices/${enc(d.id)}`, "DELETE");
        c();
        if (d.current) { snapForget(); return location.replace("/pair"); }
        toast(TX("connect.dev.removed"));
        await motionGone(document.querySelector(`[data-dev="${CSS.escape(String(d.id))}"]`));   // the unpaired device's row folds away once the hub said yes, then the list is read again
        await loadDevices();
      });
    } },
    { label: TX("common.save"), kind: "pri", onclick: (c, b) => {
      const v = name.value.trim();
      nameErr.hidden = Boolean(v);
      if (!v) { nameErr.textContent = TX("connect.dev.need_name"); return; }
      return usRun(b, err, async () => { await api(`/api/devices/${enc(d.id)}`, "PATCH", { name: v }); c(); toast(TX("settings.saved")); await loadDevices(); });
    } }]) });
  usDirty(dlg, [name]);
}

/* ---------- a new device (or this one) ---------- */
function dvQr(q) {
  const NS = "http://www.w3.org/2000/svg", part = (name, attrs) => { const n = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const box = q.size + 8, svg = part("svg", { viewBox: `-4 -4 ${box} ${box}`, class: "dv-qr", role: "img", "aria-label": TX("connect.dev.qr"), "data-dev-qr": "1", "shape-rendering": "crispEdges" });
  svg.append(part("rect", { x: -4, y: -4, width: box, height: box, class: "dv-qr-bg" }), part("path", { d: q.path, class: "dv-qr-ink" }));
  return svg;
}
function dvNew(self) {
  const res = el("div", { class: "dcs-res" });
  const steps = o => self
    ? [TX("connect.dev.step_self"), TX("connect.dev.step_passkey")]
    : [TX("connect.dev.step_open"), o.qr ? TX("connect.dev.step_qr") : TX("connect.dev.step_code"), TX("connect.dev.step_name")];   // the QR is named only when one is drawn
  const make = btn => busy(btn, async () => {
    const o = await api("/api/devices/code", "POST", {});
    const addr = input({ value: o.url, readonly: true, name: "dev-url", onfocus: ev => ev.target.select() });
    clear(res).append(
      !self && o.qr ? dvQr(o.qr) : null,
      el("div", { class: "dv-code", "data-dev-code": o.code, text: o.code }),
      el("ol", { class: "steps" }, ...steps(o).map(s => el("li", { text: s }))),
      el("div", { class: "tf" }, el("label", { text: TX("connect.dev.addr"), for: addr.id }), el("div", { class: "ms-copy" }, addr,
        self ? el("a", { class: "btn tonal", href: o.url, target: "_blank", rel: "noopener", text: TX("connect.dev.open_page") })
          : el("button", { type: "button", class: "btn tonal", onclick: () => { try { navigator.clipboard.writeText(o.url); } catch {} toast(TX("connect.copied")); }, text: TX("connect.copy") }))));
  });
  const body = el("div", { class: "col" },
    el("div", { class: "sup", text: TX("connect.dev.code_note") }),
    el("div", { class: "dcs-acts" }, el("button", { type: "button", class: "btn", "data-dev-make": "1", onclick: ev => make(ev.currentTarget), text: TX("connect.dev.make_code") })),
    res);
  dialog({ title: self ? TX("connect.dev.add_passkey") : TX("connect.dev.add"), body, onclose: () => loadDevices(), mid: true });
}
