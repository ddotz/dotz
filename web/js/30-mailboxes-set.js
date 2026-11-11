/* ---------- 메일함 설정과 메일함 추가: the two screens of the mail app that replace the list in the same view (docs/mailbox.md "Web", prototype s-mailbox.js) ---------- */
// MX.scr ("", "set", "new") is part of the address: `monitoring/i%3Amail/<account>/<box>/set` (30-mailboxes.js mxRoute, mxHash). In a screen mxScope hands the timeline no mails, so
// its signature stays put and the one node MXS.root is drawn by mxsPaint only when something here changes; a live mail update never redraws a field being typed in.
// A change saves at once with PUT /api/mailbox/box (the whole box, so `alone`, `rules` and the source conditions the hub keeps come back unchanged), optimistic: the box object of
// INTG is changed first and put back from the last answer the hub gave when a save fails. Nothing here polls; the tone and the suggestions are read when their item or screen opens.
const MXS = { root: null, open: "", more: new Set(), add: "", blank: 0, reply: "", note: "", tone: new Map(), ack: new Map(), q: Promise.resolve(), d: null, sug: null, sugFor: "" };
const MXS_MODES = { auto: [TX("mail.mode.auto"), TX("mail.mode.auto_desc")], ask: [TX("mail.mode.ask"), TX("mail.mode.ask_desc")], notify: [TX("mail.mode.notify"), TX("mail.mode.notify_desc")], quiet: [TX("mail.mode.quiet"), TX("mail.mode.quiet_desc")] };
const MXS_KINDS = [["from", TX("mail.cond.from"), TX("mail.cond.addr_ph")], ["subj", TX("decision.subject"), TX("mail.cond.subj_ph")], ["body", TX("mail.cond.body"), TX("mail.cond.body_ph")]];
const MXS_ICONS = [["mail", TX("mail.icon.mail")], ["folder", TX("mail.icon.folder")], ["file", TX("mail.icon.file")], ["tag", TX("mail.icon.tag")], ["users", TX("mail.icon.users")], ["bell", TX("mail.icon.bell")]];
const MXS_CAP = 4, MXS_FIX = 2;
const mxsErr = e => (e && e.data && e.data.error) || (e && e.message) || TX("mail.set.save_failed");
const mxsFind = (app, id) => { const a = MX.accts.get(app); return a ? a.byId.get(id) : undefined; };
const mxsList = (o, path) => path.split(".").reduce((x, k) => x[k], o);
const mxsMails = (a, b) => [...MX.of].filter(([t, k]) => k === a.key && mxBoxOf(t) === b).map(([t]) => t);
const mxsBlank = acct => ({ acct, step: "start", name: "", icon: "folder", mode: "ask", conds: { from: [], subj: [], body: [] }, judge: { on: false, text: "" }, how: "", greets: [], folders: [], bans: [], keys: [], count: 0, bring: false, copied: "", busy: false });
// The address of the screen the state says; the box list is the same address without the last part.
const mxsGo = scr => go("monitoring", `${MX.key}/${enc(MX.acct)}/${enc(MX.box)}${scr ? `/${scr}` : ""}`);
// The browser's back from a screen lands on the box list (32-history-nav.js routeChain).
const mxChain = hash => (MX.scr && MON.sel === MX.key ? [hash.slice(0, hash.lastIndexOf("/")), hash] : [hash]);
// The screens name the app bar (monName) and its back arrow returns to the box list (#back, 04-state.js).
const mxsName = () => (MON.sel === MX.key && MX.scr ? (MX.scr === "set" ? TX("mail.box.settings") : TX("mail.box.add")) : "");
const mxsBack = () => { if (current !== "monitoring" || !MX.it || !MX.scr) return false; MX.scr = ""; mxsGo(""); return true; };
function mxsEnter(scr, note = "") { MXS.note = note; MXS.open = ""; MXS.add = ""; MXS.blank = 0; MXS.reply = ""; MXS.more.clear(); MXS.tone.clear(); MXS.d = null; MXS.sug = null; MXS.sugFor = ""; mxsGo(scr); }
// box "n:<name>" (the merged entry) opens the first account's box of that name.
function mxOpenSet(id) {
  const name = mxGroup(id) ? id.slice(2) : "", merged = !!name || (MX.acct === "all" && MX.accts.size > 1);
  for (const a of MX.accts.values()) {
    const b = name ? a.boxes.find(x => x.name === name) : (MX.acct === "all" || MX.acct === a.key) && a.byId.get(id);
    if (!b) continue;
    MX.acct = a.key; MX.box = b.id;
    mxsEnter("set", merged ? TX("mail.set.merged_note", { name: a.label }) : "");
    return;
  }
}
function mxOpenNew() { mxsEnter("new"); }

/* ---- saving ---- */
// Changes the box (`change`, on the live object), draws it again unless `paint` is false (a text field keeps its focus), and sends the whole box. The saves go one after another;
// a refused one puts the box back to the last state the hub confirmed and says why.
function mxsSave(app, id, change, paint = true) {
  const k = `${app}|${id}`, b = mxsFind(app, id);
  if (!b) return;
  if (!MXS.ack.has(k)) MXS.ack.set(k, structuredClone(b));
  change(b);
  if (paint) mxsPaint();
  monSchedule();
  MXS.q = MXS.q.then(async () => {
    try { MXS.ack.set(k, structuredClone((await api("/api/mailbox/box", "PUT", { app, box: mxsFind(app, id) })).box)); } catch (e) {
      const now = mxsFind(app, id);
      if (now) { for (const key of Object.keys(now)) delete now[key]; Object.assign(now, structuredClone(MXS.ack.get(k))); }
      toast(mxsErr(e), true); mxsPaint(); monSchedule();
    }
  });
}
const mxsSetApply = (app, id) => (fn, paint = true) => mxsSave(app, id, fn, paint);
const mxsNewApply = () => (fn, paint = true) => { fn(MXS.d); if (paint) mxsPaint(); };

/* ---- parts both screens use ---- */
const mxsSw = (on, label, onclick, off) => el("button", { class: "hs-sw", type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, disabled: off ? true : null, onclick });
const mxsRow = (head, sup, end) => el("div", { class: "li" }, el("span", { class: "tx" }, el("span", { class: "hd", text: head }), sup ? el("span", { class: "sup", text: sup }) : null), end ? liEnd(end) : null);
const mxsHead = (b, sup) => el("div", { class: "mxs-hd" }, el("span", { class: "av" }, mxIc(b.icon)), el("span", { class: "tx" }, el("span", { class: "hd" }, b.name, b.base ? el("span", { class: "tag", text: TX("mail.default_tag") }) : null), el("span", { class: "sup", text: sup })),
  el("button", { class: "btn tonal sm", type: "button", text: TX("mail.set.view_mail"), onclick: mxsBack }));
const mxsSec = text => el("div", { class: "sec", text });
function mxsTiles(cur, pick) {
  return el("div", { class: "mxs-modes", role: "radiogroup", "aria-label": TX("mail.set.mode") }, ...Object.entries(MXS_MODES).map(([k, [l, t]]) => el("button", { class: `mxs-mode${cur === k ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(cur === k), "data-m": k, onclick: () => pick(k) },
    el("span", { class: "mxs-mt" }, el("span", { text: l }), cur === k ? icon("check") : null), el("span", { class: "mxs-md", text: t }))));
}
// A list of short texts as chips: each one has an x, an input opens at the end (Enter adds and stays, Esc closes), more than MXS_CAP fold.
function mxsChips(o, path, add, ph, apply) {
  const l = mxsList(o, path), more = MXS.more.has(path), shown = more ? l : l.slice(0, MXS_CAP);
  const input = () => el("input", { class: "fi mxs-ci", "data-mxs-add": path, placeholder: ph, "aria-label": add, onkeydown: ev => {
    if (ev.key === "Escape") { MXS.add = ""; mxsPaint(); } else if (ev.key === "Enter") { ev.preventDefault(); mxsChipAdd(path, ev.target.value, apply); }
  } });
  return el("div", { class: "mxs-chips" }, ...shown.map(v => el("span", { class: "chip mxs-c" }, el("span", { class: "tx", text: v }), el("button", { class: "mxs-cx", type: "button", "aria-label": TX("mail.remove_named", { name: v }), onclick: () => apply(x => { const q = mxsList(x, path), at = q.indexOf(v); if (at >= 0) q.splice(at, 1); }) }, icon("close")))),
    l.length > shown.length ? el("button", { class: "chip", type: "button", onclick: () => { MXS.more.add(path); mxsPaint(); } }, TX("mail.more_n", { n: l.length - shown.length })) : null,
    MXS.add === path ? input() : el("button", { class: "chip mxs-c2", type: "button", onclick: () => { MXS.add = path; mxsPaint(); mxsFocus(); } }, icon("add"), add));
}
const mxsFocus = () => { const i = MXS.root && MXS.root.querySelector("[data-mxs-add]"); if (i) i.focus(); };
function mxsChipAdd(path, raw, apply) {
  const v = raw.trim();
  MXS.more.add(path);
  if (v) apply(x => { const q = mxsList(x, path); if (!q.includes(v)) q.push(v); });
  mxsFocus();
}
function mxsConds(o, apply) {
  return [...MXS_KINDS.map(([k, l, ph]) => el("div", { class: "mxs-kv" }, el("div", { class: "mxs-k", text: l }), mxsChips(o, `conds.${k}`, TX("mail.add"), ph, apply))),
    ...(o.not ? [el("div", { class: "mxs-kv" }, el("div", { class: "mxs-k", text: TX("mail.cond.not_from") }), mxsChips(o, "not.from", TX("mail.add"), TX("mail.cond.addr_ph"), apply))] : [])];
}
const mxsJudge = (o, apply) => [el("div", { class: "mxs-jr" }, mxsSw(o.judge.on, TX("mail.judge.switch"), () => apply(x => { x.judge.on = !x.judge.on; }))),
  o.judge.on ? el("input", { class: "fi", value: o.judge.text, placeholder: TX("mail.judge.ph"), "aria-label": TX("mail.judge.aria"), onchange: ev => apply(x => { x.judge.text = ev.target.value.trim(); }, false) }) : null];
const mxsIcons = (o, apply) => el("div", { class: "mxs-ig" }, el("div", { class: "mxs-h", text: TX("mail.icon.label") }), el("div", { class: "mxs-chips", role: "radiogroup", "aria-label": TX("mail.icon.label") }, ...MXS_ICONS.map(([n, label]) => el("button", { class: `chip mxs-ic${o.icon === n ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(o.icon === n), "aria-label": label, onclick: () => apply(x => { x.icon = n; }) }, mxIc(n)))));
function mxsGreets(o, apply) {
  const row = (g, i) => el("div", { class: "mxs-g" }, el("div", { class: "tx" }, el("input", { class: "mxs-in", value: g.who, placeholder: TX("mail.name"), "aria-label": TX("mail.name") }), el("input", { class: "mxs-in s", value: g.addr, placeholder: TX("mail.cond.addr_ph"), "aria-label": TX("mail.greet.addr") })),
    el("input", { class: "fi", value: g.hello, placeholder: TX("mail.greet.hello"), "aria-label": TX("mail.greet.hello") }), el("button", { class: "ib", type: "button", "aria-label": TX("mail.remove"), onclick: () => { if (i < o.greets.length) apply(x => { x.greets.splice(i, 1); }); else { MXS.blank--; mxsPaint(); } } }, icon("close")));
  const rows = [...o.greets, ...Array.from({ length: MXS.blank }, () => ({ who: "", addr: "", hello: "" }))].map(row);
  // A row is saved as a whole when any of its fields changes; an empty row stays on screen only until it gets a text.
  rows.forEach((r, i) => r.addEventListener("change", () => {
    const [who, addr, hello] = [...r.querySelectorAll("input")].map(x => x.value.trim());
    if (i >= o.greets.length) { if (!(who || addr || hello)) return; MXS.blank--; }
    apply(x => { if (i < x.greets.length) x.greets[i] = { who, addr, hello }; else x.greets.push({ who, addr, hello }); }, false);
  }));
  return [el("div", { class: "mxs-gl" }, ...rows), el("button", { class: "chip mxs-c2", type: "button", onclick: () => { MXS.blank++; mxsPaint(); const f = MXS.root.querySelectorAll(".mxs-g .mxs-in:not(.s)"); if (f.length) f[f.length - 1].focus(); } }, icon("add"), TX("mail.greet.add"))];
}

/* ---- the settings screen ---- */
function mxsItem(key, label, sum, body) {
  const open = MXS.open === key;
  return el("div", { class: `mxs-ac${open ? " open" : ""}` }, el("button", { class: "mxs-ah", type: "button", "aria-expanded": String(open), "data-k": key, onclick: () => mxsToggle(key) }, el("span", { class: "mxs-al", text: label }), el("span", { class: "mxs-av", text: open ? "" : sum }), icon("drop")),
    open ? el("div", { class: "mxs-ab" }, ...body()) : null);
}
const mxsToneUrl = (app, box) => `/api/mailbox/tone?app=${enc(app)}&box=${enc(box)}`;
function mxsToggle(key) {
  MXS.open = MXS.open === key ? "" : key; MXS.add = "";
  mxsPaint();
  if (MXS.open !== "tone") return;
  const a = MX.accts.get(MX.acct), k = `${a.key}|${MX.box}`;
  MXS.tone.set(k, { busy: true });
  api(mxsToneUrl(a.key, MX.box)).then(r => MXS.tone.set(k, r), e => { MXS.tone.set(k, { failed: true }); toast(mxsErr(e), true); }).then(mxsPaint);
}
// 말투 of a mailbox among several: where its voice comes from, what 다시 배우기 and 예시 보기 reach (docs/mailbox.md "Voice").
const mxsVoiceText = v => ({
  own: TX("mail.voice.own", { n: v.texts }),
  kept: TX("mail.voice.kept"),
  ready: TX("mail.voice.ready", { n: v.count }),
  few: TX("mail.voice.few", { n: v.count, need: v.need }),
})[v.state];
const MXS_LEARNT = { learned: TX("mail.voice.learned"), few: TX("mail.voice.learn_few"), busy: TX("mail.voice.learn_busy"), empty: TX("mail.voice.learn_empty") };
async function mxsRelearn(a, b) {
  const k = `${a.key}|${b.id}`, was = MXS.tone.get(k);
  MXS.tone.set(k, { ...was, learning: true }); mxsPaint();
  try {
    const r = await api("/api/mailbox/relearn", "POST", { app: a.key, box: b.id });
    MXS.tone.set(k, await api(mxsToneUrl(a.key, b.id)));
    toast(MXS_LEARNT[r.result]);
  } catch (e) { MXS.tone.set(k, was); toast(mxsErr(e), true); }
  mxsPaint();
}
async function mxsExamples(a, b) {
  let list;
  try { list = (await api(`/api/mailbox/examples?app=${enc(a.key)}&box=${enc(b.id)}`)).examples; } catch (e) { toast(mxsErr(e), true); return; }
  const h = fsOpen({ label: TX("mail.voice.examples"), cls: "mid" });
  h.box.append(fsHead([el("div", { class: "fs-t", text: TX("mail.voice.examples") })], { close: () => h.close() }), el("div", { class: "mxs-ex" }, ...list.map(x => el("div", { class: "mxs-exi" }, el("div", { class: "mxs-k", text: TX("mail.voice.ex_received") }), el("div", { class: "mxs-h", text: x.received }), el("div", { class: "mxs-k", text: TX("mail.voice.ex_reply") }), el("div", { class: "mxs-sum", text: x.reply })))));
}
function mxsVoiceRow(a, b, t) {
  const v = t.voice;
  return [el("div", { class: "mxs-rowb" }, el("span", { class: "mxs-h", text: t.learning ? TX("mail.voice.learning") : mxsVoiceText(v) }),
    el("span", { class: "mxs-vb" }, el("button", { class: "btn tonal sm mxs-vx", type: "button", disabled: !v.count, onclick: () => mxsExamples(a, b) }, TX("mail.voice.examples")),
      el("button", { class: "btn tonal sm mxs-vl", type: "button", disabled: !!t.learning, onclick: () => mxsRelearn(a, b) }, TX("mail.voice.relearn")))),
    b.how ? el("div", { class: "mxs-h", text: TX("mail.voice.how_first") }) : null];
}
function mxsToneBody(a, b) {
  const t = MXS.tone.get(`${a.key}|${b.id}`) || { busy: true }, more = MXS.more.has("fix");
  if (t.busy) return [el("div", { class: "mxs-h", text: TX("mail.set.loading") })];
  if (t.failed) return [el("div", { class: "mxs-h", text: TX("mail.voice.failed") })];
  const fixes = more ? t.corrections : t.corrections.slice(0, MXS_FIX);
  // No tone yet: say how one comes to exist (the sent mails are read by themselves); a single mailbox has no voice row, so 다시 배우기 comes with the line.
  return [t.summary ? el("div", { class: "mxs-sum", text: t.summary }) : el("div", { class: "mxs-h", text: TX("mail.voice.none") }),
    !t.summary && t.voice.state === "single" ? el("button", { class: "btn tonal sm mxs-vl", type: "button", disabled: !!t.learning, onclick: () => mxsRelearn(a, b) }, TX("mail.voice.relearn")) : null,
    ...(t.voice.state !== "single" ? mxsVoiceRow(a, b, t) : [t.own || !t.summary ? null : el("div", { class: "mxs-h", text: TX("mail.voice.no_own") })]),
    t.corrections.length ? el("div", { class: "mxs-k", text: TX("mail.voice.fixes") }) : null, t.corrections.length ? el("ul", { class: "mxs-fx" }, ...fixes.map(f => el("li", { text: f }))) : null,
    t.corrections.length > MXS_FIX && !more ? el("button", { class: "chip mxs-c2", type: "button", onclick: () => { MXS.more.add("fix"); mxsPaint(); } }, TX("mail.more_n", { n: t.corrections.length - MXS_FIX })) : null];
}
const mxsCondSum = b => [...MXS_KINDS.filter(([k]) => b.conds[k].length).map(([k, l]) => `${l} ${b.conds[k].length}`), b.not.from.length ? TX("mail.cond.excluded", { n: b.not.from.length }) : ""].filter(Boolean).join(" · ") || TX("mail.cond.none");
const mxsFirst = (l, none = TX("mail.none")) => (l.length ? (l.length > 1 ? TX("mail.first_more", { first: l[0], n: l.length - 1 }) : l[0]) : none);
function mxsSetNodes() {
  const a = MX.accts.get(MX.acct), b = a && a.byId.get(MX.box);
  if (!b) return [el("div", { class: "empty", text: TX("mail.set.gone") })];
  const ap = mxsSetApply(a.key, b.id), mails = mxsMails(a, b), unread = mails.filter(t => mailUnread(t, MAILS.get(t))).length, drafts = !b.mode || b.mode === "auto" || b.mode === "ask";
  const text = (get, set, ph, label, rows) => el(rows ? "textarea" : "input", { class: `fi${rows ? " mxs-ta" : ""}`, ...(rows ? { rows } : { value: get }), placeholder: ph, "aria-label": label, onchange: ev => ap(x => set(x, ev.target.value.trim()), false) }, rows ? get : null);
  const nameBody = () => [el("input", { class: "fi", value: b.name, "aria-label": TX("mail.box.name"), onchange: ev => {
    const v = ev.target.value.trim();
    if (v) ap(x => { x.name = v; }, false); else { ev.target.value = b.name; toast(TX("mail.set.name_empty"), true); }
  } }), mxsIcons(b, ap)];
  const tt = MXS.tone.get(`${a.key}|${b.id}`), toneSum = tt && tt.voice ? (tt.summary ? TX("mail.set.has") : TX("mail.none")) : TX("mail.set.view");
  const reply = [["tone", TX("mail.voice.title"), toneSum, () => mxsToneBody(a, b)], ["how", TX("mail.how.title"), b.how ? b.how.slice(0, 24) : TX("mail.none"), () => [text(b.how, (x, v) => { x.how = v; }, TX("mail.how.ph"), TX("mail.how.title"), 3)]],
    ["greet", TX("mail.greet.title"), b.greets.length ? TX("mail.people_n", { n: b.greets.length }) : TX("mail.none"), () => mxsGreets(b, ap)],
    ["files", TX("mail.folders.title"), mxsFirst(b.folders), () => [mxsChips(b, "folders", TX("mail.folders.add"), TX("mail.folders.ph"), ap)]],
    ["bans", TX("mail.bans.title"), b.bans.length ? TX("mail.items_n", { n: b.bans.length }) : TX("mail.none"), () => [mxsChips(b, "bans", TX("mail.bans.add"), TX("mail.bans.ph"), ap)]]];
  const quiet = b.mode === "quiet", srcs = b.conds.src.length;
  const match = b.base ? mxsRow(TX("mail.cond.title"), (MX.accts.size > 1 ? TX("mail.cond.base_note_acct", { name: a.label }) : TX("mail.cond.base_note")), el("span", { class: "tag", text: TX("mail.default_tag") }))
    : mxsItem("match", TX("mail.cond.title"), mxsCondSum(b), () => [...mxsConds(b, ap), srcs ? el("div", { class: "mxs-h", text: TX("mail.cond.builtin", { n: srcs }) }) : null]);
  return [mxsHead(b, [TX("mail.emails_n", { n: mails.length }), TX("mail.unread_n", { n: unread })].join(" · ")), MXS.note ? el("div", { class: "mxs-note", text: MXS.note }) : null,
    mxsSec(TX("mail.set.mode")), mxsTiles(b.mode, m => ap(x => { if (x.mode === "quiet" && m !== "quiet") x.notify = true; x.mode = m; })),
    b.base && b.mode ? el("button", { class: "btn text sm mxs-inh", type: "button", onclick: () => ap(x => { delete x.mode; }) }, TX("mail.set.inherit")) : null,
    mxsSec(TX("mail.set.this")), el("div", { class: "list" }, MX.accts.size > 1 ? mxsRow(TX("mail.account"), a.account ? TX("mail.set.reply_from", { addr: a.account }) : "", el("span", { class: "mxs-am2" }, mxMark(a), a.label)) : null, mxsItem("name", TX("mail.name"), b.name, nameBody), match,
      b.base ? null : mxsItem("judge", TX("mail.judge.title"), b.judge.on ? b.judge.text || TX("mail.on") : TX("mail.off"), () => mxsJudge(b, ap))),
    mxsSec(TX("mail.set.replying")), drafts || MXS.reply === b.id ? el("div", { class: "list" }, ...reply.map(([k, l, s, body]) => mxsItem(k, l, s, body)))
      : el("div", { class: "list" }, el("button", { class: "li", type: "button", onclick: () => { MXS.reply = b.id; mxsPaint(); } }, el("span", { class: "tx" }, el("span", { class: "hd", text: TX("mail.set.tone_how") }), el("span", { class: "sup", text: TX("mail.set.folded", { mode: MXS_MODES[b.mode][0] }) })), icon("drop"))),
    mxsSec(TX("common.alerts")), el("div", { class: "list" }, mxsRow(TX("mail.set.notify"), quiet ? TX("mail.set.quiet_note") : "", mxsSw(!quiet && b.notify !== false, TX("mail.set.notify"), () => ap(x => { x.notify = x.notify === false; }), quiet))),
    b.base ? null : el("div", { class: "mxs-del" }, el("button", { class: "btn danger sm", type: "button", onclick: () => mxsDelete(a, b) }, TX("mail.box.delete")))];
}
async function mxsDelete(a, b) {
  const n = mxsMails(a, b).length;
  if (!(await ask(TX("mail.box.delete_named", { name: b.name }), n ? TX("mail.box.delete_body_n", { n }) : TX("mail.box.delete_body"), TX("common.delete"), true))) return;
  try { await api("/api/mailbox/box", "DELETE", { app: a.key, id: b.id }); } catch (e) { toast(mxsErr(e), true); return; }
  await Promise.allSettled([loadIntegrations(), convLoad()]);
  MX.box = a.base.id;
  MX.scr = "";
  mxsGo("");
  toast(TX("mail.box.deleted", { name: b.name }));
}

/* ---- 메일함 추가 ---- */
function mxsSuggest(app) {
  if (MXS.sugFor === app) return;
  MXS.sugFor = app; MXS.sug = null;
  api(`/api/mailbox/suggest?app=${enc(app)}`).then(r => r.groups || [], e => { toast(mxsErr(e), true); return []; }).then(g => { if (MXS.sugFor === app) { MXS.sug = g; mxsPaint(); } });
}
const mxsStart = (d, patch) => { Object.assign(d, patch, { step: "setup" }); mxsPaint(); };
const mxsAcctRow = d => { const a = MX.accts.get(d.acct); return MX.accts.size > 1 && a ? [mxsSec(TX("mail.account")), el("div", { class: "list" }, mxsRow(a.label, a.account, el("button", { class: "btn text sm", type: "button", onclick: () => { d.acct = ""; d.step = "start"; MXS.sugFor = ""; mxsPaint(); } }, TX("mail.change"))))] : []; };
function mxsPickNodes(d) {
  return [mxsSec(TX("mail.new.which_acct")), el("div", { class: "list" }, ...[...MX.accts.values()].map(a => a.conn ? mxsRow(a.label, [a.account, TX("mail.signed_out")].join(" · ")) : el("button", { class: "li", type: "button", onclick: () => { d.acct = a.key; mxsPaint(); } },
    el("span", { class: "tx" }, el("span", { class: "hd", text: a.label }), el("span", { class: "sup", text: [a.account, TX("mail.boxes_n", { n: a.boxes.length })].join(" · ") })), icon("chev"))))];
}
function mxsStartNodes(d) {
  mxsSuggest(d.acct);
  const groups = MXS.sug, row = (title, sup, onclick, n) => el("button", { class: n ? "li mxs-sg" : "li", type: "button", onclick }, el("span", { class: "tx" }, el("span", { class: "hd", text: title }), el("span", { class: "sup", text: sup })), n ? liEnd(el("span", { class: "mxs-cnt", text: n }), icon("chev")) : icon("chev"));
  const copyable = [...MX.accts.values()].flatMap(a => a.boxes.filter(b => !b.base).map(b => ({ a, b })));
  return [...mxsAcctRow(d), mxsSec(TX("mail.new.groups")), el("div", { class: "list" }, ...(groups === null ? [el("div", { class: "empty", text: TX("mail.new.groups_loading") })] : groups.length ? groups.map(g => row(g.label, `${g.domain} · ${g.senders.join(", ")}`,
    () => mxsStart(d, { name: g.label, conds: { from: [g.domain], subj: [], body: [] }, keys: g.keys, count: g.count }), TX("mail.emails_n", { n: g.count }))) : [el("div", { class: "empty", text: TX("mail.new.groups_none") })])),
  mxsSec(TX("mail.new.own")), el("div", { class: "list" }, row(TX("mail.new.blank"), TX("mail.new.blank_sub"), () => mxsStart(d, {})),
    copyable.length ? row(TX("mail.new.copy"), TX("mail.new.copy_sub"), () => { d.step = "copy"; mxsPaint(); }) : null)];
}
function mxsCopyNodes(d) {
  return [...mxsAcctRow(d), mxsSec(TX("mail.new.copy_which")), el("div", { class: "list" }, ...[...MX.accts.values()].flatMap(a => a.boxes.filter(b => !b.base).map(b => el("button", { class: "li", type: "button", onclick: () => mxsStart(d, structuredClone({ name: b.name, icon: b.icon, mode: b.mode || "ask", conds: { from: b.conds.from, subj: b.conds.subj, body: b.conds.body }, judge: b.judge, how: b.how, greets: b.greets, folders: b.folders, bans: b.bans, copied: b.name })) },
    el("span", { class: "tx" }, el("span", { class: "hd", text: b.name }), el("span", { class: "sup", text: `${MX.accts.size > 1 ? `${a.label} · ` : ""}${b.mode ? MXS_MODES[b.mode][0] : TX("mail.mode.default")} · ${mxsCondSum(b)}` })), icon("chev"))))),
  el("div", { class: "mxs-h", text: TX("mail.new.copy_note") })];
}
function mxsSetupNodes(d) {
  const ap = mxsNewApply(), base = MX.accts.get(d.acct).base.name, fix = (node, f) => node.addEventListener("input", f);
  const name = el("input", { class: "fi", value: d.name, placeholder: TX("mail.new.name_ph"), "aria-label": TX("mail.box.name") });
  fix(name, () => { d.name = name.value; const go0 = MXS.root.querySelector("[data-mxs-go]"); if (go0) go0.disabled = !d.name.trim() || d.busy; });
  return [...mxsAcctRow(d), mxsSec(TX("mail.name")), el("div", { class: "list mxs-pad" }, name, mxsIcons(d, ap)), mxsSec(TX("mail.set.mode")), mxsTiles(d.mode, m => ap(x => { x.mode = m; })),
    mxsSec(TX("mail.cond.title")), el("div", { class: "list mxs-pad" }, ...mxsConds(d, ap), ...mxsJudge(d, ap)),
    d.keys.length ? mxsSec(TX("mail.new.existing")) : null, d.keys.length ? el("div", { class: "list" }, mxsRow(TX("mail.new.bring_n", { n: d.keys.length }), d.count > d.keys.length ? TX("mail.new.bring_recent", { total: d.count, n: d.keys.length }) : TX("mail.new.bring_off"), mxsSw(d.bring, TX("mail.new.bring_aria"), () => ap(x => { x.bring = !x.bring; })))) : null,
    el("div", { class: "mxs-h", text: d.copied ? TX("mail.new.note_copied", { from: d.copied, base }) : TX("mail.new.note", { base }) }),
    el("div", { class: "mxs-foot" }, el("button", { class: "btn text", type: "button", onclick: () => { MXS.d = mxsBlank(d.acct); mxsPaint(); } }, TX("common.cancel")), el("button", { class: "btn", type: "button", "data-mxs-go": "", disabled: d.name.trim() && !d.busy ? null : true, onclick: mxsCreate }, TX("mail.new.create")))];
}
async function mxsCreate() {
  const d = MXS.d, name = d.name.trim();
  if (!name || d.busy) return;
  d.busy = true; mxsPaint();
  let made;
  try { made = (await api("/api/mailbox/box", "PUT", { app: d.acct, box: { name, icon: d.icon, mode: d.mode, notify: d.mode !== "quiet", conds: d.conds, judge: d.judge, how: d.how, greets: d.greets, folders: d.folders, bans: d.bans } })).box; } catch (e) { d.busy = false; toast(mxsErr(e), true); mxsPaint(); return; }
  let moved = true;
  if (d.bring && d.keys.length) try { await api("/api/mailbox/move", "POST", { keys: d.keys, box: made.id }); } catch (e) { moved = false; toast(TX("mail.new.made_not_moved", { name }), true); }
  await Promise.allSettled([loadIntegrations(), convLoad()]);
  MX.acct = d.acct; MX.box = made.id; MX.scr = "";
  mxsGo("");
  if (moved) toast(TX("mail.new.made", { name }));
}
function mxsNewNodes() {
  const d = MXS.d ??= mxsBlank(MX.acct !== "all" ? MX.acct : MX.accts.size === 1 ? [...MX.accts.keys()][0] : "");
  if (d.acct && !MX.accts.has(d.acct)) d.acct = "";
  return [...(!d.acct ? mxsPickNodes(d) : d.step === "setup" ? mxsSetupNodes(d) : d.step === "copy" ? mxsCopyNodes(d) : mxsStartNodes(d))];
}

/* ---- the node in the timeline ---- */
function mxsPaint() {
  if (!MXS.root || !MX.scr) return;
  clear(MXS.root).append(...(MX.scr === "set" ? mxsSetNodes() : mxsNewNodes()).filter(Boolean));
}
function mxScreen() {
  MXS.root ??= el("div", { class: "mxs" });
  mxsPaint();
  return [MXS.root];
}
