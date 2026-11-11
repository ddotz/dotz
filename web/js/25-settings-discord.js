// 설정 → Discord: the bot connection (token, server id, owner id; GET/PUT/DELETE /api/discord/connection, POST .../check, hub/discord-connection.ts)
// and what also goes to Discord by conversation (GET/PUT /api/discord/post, hub/discord-post.ts; the per-class switches are in 설정 → 앱과 알림). The web app always gets everything; a switch that is off
// keeps that kind on the web only. The switches show once Discord is enabled; the gateway reads the connection only at start, so a change
// waits for a restart (restart_needed).
const DP_KINDS = [["chat", TX("connect.dc.kind_chat"), TX("connect.dc.kind_chat_sub")], ["lanes", TX("chat.inbox.lane"), TX("connect.dc.kind_lanes_sub")], ["worklog", TX("common.worklog"), TX("connect.dc.kind_worklog_sub")], ["web_lanes", TX("connect.dc.kind_web"), TX("connect.dc.kind_web_sub")]];
const DP = { v: null };
const DCS = { v: null, fail: "", err: "", chk: null, asked: false, advOpen: false,
  guild: input({ inputmode: "numeric", placeholder: TX("connect.dc.id_ph"), name: "discord-guild" }),
  owner: input({ inputmode: "numeric", placeholder: TX("connect.dc.id_ph"), name: "discord-owner" }),
  tok: input({ type: "password", autocomplete: "new-password", name: "discord-token", placeholder: TX("connect.dc.token") }) };
for (const f of [DCS.guild, DCS.owner]) f.addEventListener("input", () => { f.dataset.dirty = "1"; });
function dcFill() {
  if (!DCS.v) return;
  if (!DCS.guild.dataset.dirty) DCS.guild.value = DCS.v.guild;
  if (!DCS.owner.dataset.dirty) DCS.owner.value = DCS.v.owner_id;
}
async function loadDiscord() {
  DCS.asked = true;
  try { DCS.v = await api("/api/discord/connection"); DCS.fail = ""; } catch (e) { DCS.v = null; DCS.fail = e.message; }
  if (DCS.v && DCS.v.enabled) { try { DP.v = await api("/api/discord/post"); } catch { DP.v = null; } }
  dcFill();
  if (current === "discord") renderDiscord();
}
async function dpSet(k, on) {
  const was = DP.v[k];
  DP.v = { ...DP.v, [k]: on }; renderDiscord();
  try { DP.v = await api("/api/discord/post", "PUT", { [k]: on }); } catch (e) { DP.v = { ...DP.v, [k]: was }; toast(e.message, true); }
  renderDiscord();
}
async function dcSave(btn) {
  const body = {}, tok = DCS.tok.value.trim(), guild = DCS.guild.value.trim(), owner = DCS.owner.value.trim();
  if (tok) body.token = tok;
  if (guild && guild !== DCS.v.guild) body.guild = guild;
  if (owner && owner !== DCS.v.owner_id) body.owner_id = owner;
  if (!Object.keys(body).length) { DCS.err = TX("connect.nothing_changed"); return renderDiscord(); }
  let saved = false;
  await busy(btn, async () => {
    try {
      DCS.v = await api("/api/discord/connection", "PUT", body);
      DCS.err = ""; DCS.chk = null; DCS.tok.value = "";
      delete DCS.guild.dataset.dirty; delete DCS.owner.dataset.dirty;
      dcFill();
      saved = true;
    } catch (e) { DCS.err = e.message; }
  });
  renderDiscord();
  if (saved) stFlash("#discord [data-ms-save]");
}
async function dcCheck(btn) {
  await busy(btn, async () => {
    DCS.chk = await api("/api/discord/connection/check", "POST", DCS.tok.value.trim() ? { token: DCS.tok.value.trim() } : {});
    if (DCS.chk.ok) DCS.v = await api("/api/discord/connection");
  });
  renderDiscord();
}
async function dcClear(btn) {
  if (!await ask(TX("connect.dc.token_delete_title"), TX("connect.dc.token_delete_body"), TX("common.delete"), true)) return;
  await busy(btn, async () => { DCS.v = await api("/api/discord/connection", "DELETE"); DCS.chk = null; DCS.err = ""; toast(TX("connect.dc.token_deleted")); });
  renderDiscord();
}
const dcRestart = btn => busy(btn, async () => {
  await api("/api/update/restart", "POST", {});
  toast(TX("connect.restart_later"));
});
function dcStatus() {
  const v = DCS.v;
  if (!v.enabled) return [TX("connect.state.unset"), "warn", v.has_token ? TX("connect.dc.half") : TX("connect.dc.not_yet")];
  if (v.connected) return [TX("connect.state.on"), "ok", v.user || ""];   // the tag says 연결됨; the line is the bot's name only
  if (v.error) return [TX("settings.prov.not_connected"), "err", v.error];
  return [TX("connect.state.connecting"), "warn", TX("connect.dc.connecting")];
}
function dcSwitch(label, on, key, onclick) {
  return el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(on), "aria-label": TX("connect.dc.also_send", { name: label }), "data-dc": key, onclick });
}
function dcSwitches() {
  const li = (title, desc, k, on) => el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "hd", text: title }), el("div", { class: "sup", text: desc })), liEnd(dcSwitch(title, on, k, () => dpSet(k, !on))));
  const hint = () => el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: TX("connect.dc.after_connect") })));
  const on = DCS.v.enabled && DP.v;
  return [
    // Which notice classes Discord gets (discord-post.json ask/alert/result/news/conv; 진행 follows the conversation switches below).
    el("div", { class: "sec", text: TX("common.alerts") }),
    el("div", { class: "list" }, ...(on ? [...notifyRows(k => DP.v[k] !== false, dpSet, ["ask", "alert", "result", "news", "conv"]),
      el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "sup", text: TX("connect.dc.direct_note") })))] : [hint()])),
    el("div", { class: "sec", text: TX("connect.dc.per_chat") }),
    el("div", { class: "list" }, ...(on ? [...DP_KINDS.map(([k, label, desc]) => li(label, desc, k, k === "web_lanes" ? DP.v[k] === true : DP.v[k] !== false))] : [hint()])),
  ];
}
function dcChecked() {
  const c = DCS.chk;
  if (!c) return null;
  if (!c.ok) return el("div", { class: "dcs-res err" }, el("div", { text: c.error || TX("connect.check_failed") }), c.intent_note ? el("div", { class: "sup", text: c.intent_note }) : null);
  return el("div", { class: "dcs-res" },
    el("div", { class: "dcs-ok", text: TX("connect.dc.bot_named", { name: c.bot_name || TX("connect.dc.unnamed") }) }),
    c.admin === true ? el("div", { class: "dcs-ok", text: TX("connect.dc.admin_ok") }) : c.invite_url ? el("div", {}, el("div", { text: TX("connect.dc.admin_no") }), el("a", { class: "btn tonal", href: c.invite_url, target: "_blank", rel: "noopener noreferrer", text: TX("connect.dc.reauth") })) : null,
    c.intent_note ? el("div", { class: "sup", text: c.intent_note }) : null);
}
function dcConnect() {
  return obStart("discord");
}
function dcAdvanced(v) {
  const rows = [el("div", { class: "li dcs-form" }, textField(TX("connect.dc.guild"), DCS.guild), textField(TX("connect.dc.owner"), DCS.owner),
    textField(v.has_token ? TX("connect.dc.token_saved") : TX("connect.dc.token"), DCS.tok),
    v.has_token ? el("div", { class: "tag ok dcs-saved", text: TX("connect.saved_tag") }) : null,
    DCS.err ? el("div", { class: "dcs-err", role: "alert", text: DCS.err }) : null,
    el("div", { class: "dcs-acts" }, el("button", { type: "button", class: "btn", "data-ms-save": "1", onclick: ev => dcSave(ev.currentTarget), text: TX("common.save") }), el("button", { type: "button", class: "btn tonal", onclick: ev => dcCheck(ev.currentTarget), text: TX("connect.check_conn") }),
      v.has_token ? el("button", { type: "button", class: "btn text", onclick: ev => dcClear(ev.currentTarget), text: TX("connect.dc.token_delete") }) : null),
    dcChecked())];
  if (v.restart_needed) rows.push(el("div", { class: "li" }, el("span", { class: "tx" }, el("div", { class: "hd", text: TX("connect.dc.restart_applies") })), liEnd(el("button", { type: "button", class: "btn inrow", onclick: ev => dcRestart(ev.currentTarget), text: TX("connect.restart") }))));
  return el("div", { class: "list" }, ...rows);
}
function renderDiscord() {
  const box = $("#discord");
  if (!DCS.v) { clear(box).append(DCS.asked && DCS.fail ? emptyNode(TX("connect.dc.load_failed")) : emptyNode(TX("connect.loading"))); return; }
  const v = DCS.v, m = msItem("discord"), line = [dcStatus()[2], msConnectedNote("discord")].filter(Boolean).join(" · ");
  const [tag, tone] = m ? msTag(m) : v.enabled ? (v.connected ? [TX("connect.state.on"), "ok"] : v.error ? [TX("settings.prov.not_connected"), "err"] : [TX("connect.state.on"), "ok"]) : [TX("connect.state.unset"), "warn"];
  const guide = v.enabled ? [] : [el("div", { class: "list" }, el("div", { class: "li", "data-dc-guide": "1" }, el("details", {}, el("summary", { class: "sup", text: TX("connect.dc.how") }), el("ol", { class: "steps" },
    el("li", { text: TX("connect.dc.how1") }),
    el("li", { text: TX("connect.dc.how2") }),
    el("li", { text: TX("connect.dc.how3") })))))];
  // The toggle event arrives after a redraw can already have replaced the element, so read the live state.
  const prev = box.querySelector("details[data-ms-advanced]");
  if (prev) DCS.advOpen = prev.open;
  const det = msAdvanced("data-ms-advanced", DCS.advOpen, () => dcAdvanced(v));
  det.addEventListener("toggle", () => { DCS.advOpen = det.open; });
  clear(box).append(el("div", { class: "sec", text: TX("connect.sec") }), el("div", { class: "list" },
    el("div", { class: "li", "data-ms-status": "discord" }, el("span", { class: "lead" }, icon("discord")), el("span", { class: "tx" }, el("div", { class: "hd", text: TX("connect.dc.bot") }), line ? el("div", { class: "sup", text: line }) : null),
      liEnd(el("span", { class: `tag ${tone}`, text: tag }), el("button", { type: "button", class: "btn tonal inrow", "data-ms-connect": "discord", disabled: OB_WAIT.has("discord"), onclick: dcConnect }, OB_WAIT.has("discord") ? TX("connect.connecting") : msConnectLabel(m))))),
  ...obSection("discord", m ? m.state === "ok" : v.connected), ...dcSwitches(), ...guide, det);
}
