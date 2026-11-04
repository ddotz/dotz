// First-run onboarding page (docs/web-onboarding.md). Served by hub/setup-gate.ts as /setup.js, apart from the app bundle. Every word comes from
// state.text.ui (hub/i18n-*.ts, "setup" block); nothing is stored in the browser: the draft and the secrets live on the gateway.
// allow: SIZE_OK — the gate serves exactly one /setup.js and there is no bundler, so the six steps, the two sheets and the glue stay in one file.
(() => {
  "use strict";
  const ORDER = ["start", "harness", "tools", "bot", "discord", "web", "review", "done"];
  const STEPS = ORDER.slice(1, 7);
  const ID = /^\d{17,20}$/;
  const PICKS = ["character", "tone", "notices"];
  const root = document.getElementById("setup");
  const V = { view: "start", skipped: {}, lines: {}, log: {}, rows: {}, dcOff: false, botMode: "", custom: {}, tokenEdit: false, peerEdit: false, applying: false, result: null, applyError: "" };
  let S, pending = {}, dirty = false, lib = null;

  /* ---------- helpers ---------- */
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const fmt = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => String(o[k] ?? ""));
  const u = () => S.text.ui;
  const D = () => S.draft;
  const qs = (s, r = root) => r.querySelector(s);
  const hz = id => S.scan.harnesses.find(z => z.id === id);
  const job = id => S.jobs.find(r => r.id === id) || { id, state: "idle", detail: "", owner: "" };
  const busy = () => S.jobs.some(r => r.state === "running");
  const furthest = () => Math.max(ORDER.indexOf(S.step === "apply" ? "review" : S.step), 0);
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const IC_CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  // the theme the app uses: the saved light/dark choice, else the system setting
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const theme = () => {
    let v = null;
    try { v = localStorage.getItem("dotz-theme"); } catch {}
    document.documentElement.dataset.theme = v === "dark" || (v !== "light" && mq.matches) ? "dark" : "light";
  };
  mq.addEventListener("change", theme);
  theme();

  async function api(path, method = "GET", body) {
    const r = await fetch(path, { method, cache: "no-store", credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 && S) throw new Error(u().errors.closed);
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const say = (text, bad) => { const m = qs("#ob-msg"); if (m) { m.textContent = text; m.className = `note ob-msg${bad ? " err" : ""}`; } };

  /* ---------- draft: saved as the owner goes, resumed from the gateway ---------- */
  async function flush() {
    if (!dirty || busy()) return;
    const values = pending;
    pending = {};
    dirty = false;
    try { await api("/api/setup/draft", "PUT", { step: S.step, values }); }
    catch (e) { pending = { ...values, ...pending }; dirty = true; throw e; }
  }
  async function save(values, target) {
    Object.assign(S.draft, values);
    Object.assign(pending, values);
    dirty = true;
    S.step = ORDER[Math.max(furthest(), ORDER.indexOf(target ?? V.view))];
    await flush();
  }
  function gather() {
    const out = {};
    for (const el of root.querySelectorAll("input[data-k]")) {
      if (el.type === "password") continue;
      const k = el.dataset.k, v = el.value.trim();
      if (k === "allow_logins") out[k] = v.split(",").map(s => s.trim()).filter(Boolean);
      else if (k === "web_port" || k === "tailscale_https_port") { if (v) out[k] = Number(v); }
      else out[k] = v;
    }
    return out;
  }
  async function refresh(all) {
    const f = await api("/api/setup/state");
    S.scan = f.scan; S.saved = f.saved; S.jobs = f.jobs;
    if (all) Object.assign(S, { text: f.text, lang: f.lang, draft: f.draft });
    if (["harness", "tools"].includes(V.view)) render();
  }

  /* ---------- rows ---------- */
  const dot = t => `<span class="dot ${t}"></span>`;
  const tag = (t, label) => `<span class="tag ${t}">${h(label)}</span>`;
  const btn = (act, label, cls = "tonal inrow", data = "") => `<button class="btn ${cls}" data-act="${act}" ${data}>${h(label)}</button>`;
  const row = ({ lead = "", title, sup = "", end = "", attrs = "" }) => `<div class="li" ${attrs}><span class="lead">${lead}</span><span class="tx"><span class="hd">${h(title)}</span>${sup ? `<span class="sup">${h(sup)}</span>` : ""}</span><span class="li-end">${end}</span></div>`;
  const pick = ({ k, i, on, title, sup = "", off = false }) => `<button class="li ob-pick${on ? " on" : ""}" role="radio" aria-checked="${on}" data-act="pick" data-k="${k}" data-i="${i}"${off ? " disabled" : ""}><span class="tx"><span class="hd">${h(title)}</span>${sup ? `<span class="sup">${h(sup)}</span>` : ""}</span><span class="li-end">${on ? IC_CHECK : ""}</span></button>`;
  const field = ({ k, label, val = "", ph = "", hint = "", type = "text", secret = "" }) =>
    `<label class="lbl" for="ob-${k}">${h(label)}</label><input class="fi" id="ob-${k}" data-k="${k}" ${secret ? `data-secret="${secret}" autocomplete="new-password" spellcheck="false"` : 'autocomplete="off"'} type="${type}" placeholder="${h(ph)}" value="${h(val)}">${hint ? `<div class="note">${h(hint)}</div>` : ""}`;
  const seg = (act, items, cur) => `<div class="seg" role="radiogroup">${items.map(([v, l]) => `<button role="radio" aria-checked="${v === cur}" class="${v === cur ? "on" : ""}" data-act="${act}" data-v="${v}">${h(l)}</button>`).join("")}</div>`;
  const group = (k, label, opts) => {
    const x = u(), cur = D()[k], custom = V.custom[k] || (cur && !opts.some(o => o.v === cur));
    return `<div class="sec">${h(label)}</div><div class="list" role="radiogroup" aria-label="${h(label)}">${opts.map((o, i) => pick({ k, i, on: !custom && cur === o.v, title: o.t, sup: o.s })).join("")}${pick({ k, i: "custom", on: custom, title: x.bot.custom })}</div>${custom ? `<input class="fi ob-gap" data-k="${k}" aria-label="${h(label)}" placeholder="${h(x.bot.customPh)}" value="${h(opts.some(o => o.v === cur) ? "" : cur)}">` : ""}`;
  };

  // A row of an install, a login or a terminal step: its state comes from the job rows the stream keeps current, and "ready" from the machine scan.
  function actionRow(key, spec) {
    V.rows[key] = spec;
    const x = u(), j = spec.job ? job(spec.job) : null, ready = spec.ready || j?.state === "done";
    const act = spec.job ? btn("job", spec.again || x.install, "tonal inrow", `data-job="${spec.job}" data-key="${key}"`) : spec.term ? btn("term", spec.again || x.login, "tonal inrow", `data-term="${spec.term}"`) : btn("login", spec.again || x.login, "tonal inrow");
    const later = btn("later", x.later, "text inrow", `data-key="${key}"`);
    let tone = "warn", sup = spec.idle, end = V.skipped[key] ? tag("", x.later) + act : act + later;
    if (spec.need) { tone = ""; sup = spec.need; end = ""; }
    else if (j?.state === "running") { tone = "pri"; sup = V.lines[spec.job] || j.detail; end = tag("pri", x.running); }
    else if (ready) { tone = "ok"; sup = spec.done || spec.idle; end = tag("ok", x.ready); }
    else if (j?.state === "failed") { tone = "err"; sup = j.owner || j.detail; end = btn("job", x.retry, "tonal inrow", `data-job="${spec.job}" data-key="${key}"`); }
    else if (V.skipped[key]) tone = "";
    return row({ lead: dot(tone), title: spec.title, sup, end, attrs: `data-key="${key}"` });
  }

  /* ---------- the steps ---------- */
  const VIEWS = {
    start() {
      const x = u(), sc = S.scan, om = hz("omo"), ts = sc.tailscale;
      const accounts = sc.zele.accounts.join(", ");
      return {
        title: x.titles.start, sup: x.sups.start,
        body: `<div class="sec">${h(x.start.found)}</div><div class="list">` +
          row({ lead: dot(om?.installed ? "ok" : "warn"), title: "OmO", sup: om?.installed ? x.start.installed : x.start.missing }) +
          (sc.mac ? row({ lead: dot(sc.aside.app && sc.aside.cli ? "ok" : "warn"), title: "Aside", sup: sc.aside.app && sc.aside.cli ? x.ready : x.start.asideMissing }) : "") +
          row({ lead: dot(ts.running ? "ok" : "warn"), title: "Tailscale", sup: ts.running ? fmt(x.start.signedInAs, { name: ts.login }) : ts.installed ? x.start.notSignedIn : x.start.missing }) +
          row({ lead: dot(sc.zele.installed ? "ok" : "warn"), title: "zele", sup: !sc.zele.installed ? x.start.missing : accounts || x.start.noAccounts }) + "</div>" +
          `<div class="sec">${h(x.start.language)}</div><div class="list"><div class="li"><span class="tx"><span class="hd">${h(x.start.languageHint)}</span></span><span class="li-end">${seg("lang", [["ko", "한국어"], ["en", "English"]], S.lang.slice(0, 2))}</span></div></div>`,
        foot: `<span class="ob-sp"></span><button class="btn" data-act="next">${h(x.start.go)}</button>`,
      };
    },
    harness() {
      const x = u(), sel = D().runtime || "omo", picked = hz(sel);
      const list = S.scan.harnesses.map(z => pick({ k: "runtime", i: z.id, on: sel === z.id, off: !z.adapter, title: z.label, sup: !z.adapter ? x.harness.noAdapter : z.installed ? [z.version, z.id === "omo" ? x.harness.defaultTag : ""].filter(Boolean).join(" · ") || x.ready : x.harness.notInstalled })).join("");
      let more = "";
      if (picked?.adapter && !picked.installed) more = sel === "omo" ? `<div class="list ob-gap">${actionRow("install-omo", { job: "install-omo", title: S.text.jobs["install-omo"], idle: "bun add -g --trust omo-ai" })}</div>` : `<div class="note ob-gap">${h(fmt(x.harness.installOwn, { name: picked.label }))}</div>`;
      else if (picked?.adapter) {
        const n = Array.isArray(picked.accounts) ? picked.accounts.length : Number(picked.accounts) || 0;
        const spec = { title: fmt(x.harness.loginTitle, { name: picked.label }), idle: sel === "omo" ? x.harness.loginSupOmo : x.harness.loginSupTerm, ready: picked.login_ready, done: n ? fmt(x.harness.accounts, { n }) : x.ready };
        more = `<div class="list ob-gap">${actionRow("login", sel === "omo" ? { ...spec, login: true } : { ...spec, term: `${sel}-login` })}</div>`;
      }
      return { title: x.titles.harness, sup: x.sups.harness, body: `<div class="list" role="radiogroup" aria-label="${h(x.steps.harness)}">${list}</div>${more}`, foot: nav("start", "next", x.next) };
    },
    tools() {
      const x = u(), t = x.tools, sc = S.scan, ts = sc.tailscale, jt = S.text.jobs;
      const cliOk = !sc.mac || sc.aside.cli;
      const off = "";
      const aside = sc.mac
        ? `<div class="sec">${h(t.secAside)}</div><div class="list">` +
          actionRow("aside-app", { job: "aside-app", title: t.asideApp, idle: t.asideAppSup, ready: sc.aside.app }) +
          actionRow("aside-cli", { job: "aside-cli", title: t.asideCli, idle: t.asideCliSup, ready: sc.aside.cli }) +
          actionRow("aside-login", { term: "aside-login", title: t.asideLogin, idle: t.asideLoginSup, ready: sc.aside.signed_in, need: cliOk ? "" : t.needFirst, again: x.login }) + "</div>"
        : off;
      const tail = `<div class="sec">Tailscale</div><div class="list">` +
        actionRow("tailscale", { job: "tailscale", title: jt.tailscale, idle: t.tsSup, ready: ts.installed }) +
        actionRow("tailscale-start", { job: "tailscale-start", title: t.tsLogin, idle: t.tsLoginSup, ready: ts.running, done: ts.login ? fmt(x.start.signedInAs, { name: ts.login }) : x.ready, again: x.login, need: ts.installed ? "" : t.needFirst }) + "</div>";
      const mail = `<div class="sec">${h(t.secMail)}</div><div class="list">` +
        actionRow("zele", { job: "zele", title: jt.zele, idle: t.zeleSup, ready: sc.zele.installed }) +
        actionRow("zele-login", { term: "zele-login", title: t.mailTitle, idle: t.mailSup, ready: sc.zele.accounts.length > 0, done: sc.zele.accounts.join(", "), again: x.connect, need: sc.zele.installed ? "" : t.needFirst }) + "</div>";
      return { title: x.titles.tools, sup: x.sups.tools, body: aside + tail + mail, foot: nav("harness", "next", x.next) };
    },
    bot() {
      const x = u(), b = x.bot;
      PICKS.forEach(k => { if (D()[k] === undefined) { D()[k] = pending[k] = b.opts[k][0].v; dirty = true; } });
      return {
        title: x.titles.bot, sup: x.sups.bot,
        body: field({ k: "name", label: b.name, val: D().name, ph: b.namePh, hint: b.nameHint }) + group("character", b.character, b.opts.character) + group("tone", b.tone, b.opts.tone) + group("notices", b.notices, b.opts.notices) +
          `<div class="note">${h(b.later)}</div>` + field({ k: "address", label: b.address, val: D().address, ph: b.addressPh, hint: b.addressHint }) + field({ k: "avatar", label: b.avatar, val: D().avatar, ph: b.avatarPh, hint: b.avatarHint }),
        foot: nav("tools", "next", x.next),
      };
    },
    discord() {
      const x = u(), d = x.discord, saved = S.saved["discord-bot-token"];
      const mode = V.botMode || (saved ? "token" : "auto");
      if (V.dcOff) return { title: x.titles.discord, sup: x.sups.discord, body: `<div class="list">${row({ lead: dot(""), title: d.offTitle, sup: d.offSup, end: btn("dc-on", d.turnOn) })}</div>`, foot: nav("bot", "next", x.next) };
      const token = saved && !V.tokenEdit && mode === "token"
        ? `<div class="list ob-gap">${row({ lead: dot("ok"), title: d.tokenSaved, end: btn("token-edit", d.replace) })}</div>`
        : mode === "token" ? field({ k: "token", label: d.token, type: "password", secret: "discord-bot-token", hint: d.tokenHint }) : "";
      return {
        title: x.titles.discord, sup: x.sups.discord,
        body: field({ k: "guild", label: d.guild, val: D().guild, ph: d.idPh, hint: d.guildHint }) + field({ k: "owner_id", label: d.owner, val: D().owner_id, ph: d.idPh, hint: d.ownerHint }) +
          `<div class="sec">${h(d.bot)}</div><div class="list"><div class="li"><span class="tx"><span class="hd">${h(d.botHow)}</span><span class="sup">${h(mode === "token" ? d.tokenSup : d.autoSup)}</span></span><span class="li-end">${seg("bot-mode", [["auto", d.auto], ["token", d.tokenWord]], mode)}</span></div></div>` + token,
        foot: nav("bot", "next", x.next, btn("dc-off", d.skip, "text")),
      };
    },
    web() {
      const x = u(), w = x.web, ts = S.scan.tailscale;
      const logins = D().allow_logins ?? (ts.running && ts.login ? [ts.login] : []);
      const peer = S.saved["peer-token"] && !V.peerEdit
        ? `<div class="list ob-gap">${row({ lead: dot("ok"), title: w.peerSaved, end: btn("peer-edit", x.discord.replace) })}</div>`
        : field({ k: "peer", label: w.peer, type: "password", secret: "peer-token", hint: w.peerHint });
      return {
        title: x.titles.web, sup: x.sups.web,
        body: field({ k: "machine_name", label: w.machine, val: D().machine_name ?? (ts.host || "").split(".")[0], hint: w.machineHint }) + field({ k: "allow_logins", label: w.logins, val: logins.join(", "), hint: w.loginsHint }) +
          `<details class="ob-more"><summary>${h(w.peerMore)}</summary>${peer}</details>` +
          `<details class="ob-more"><summary>${h(w.advanced)}</summary><div class="ob-two">${field({ k: "web_port", label: w.webPort, val: D().web_port ?? "", ph: location.port || w.default, type: "number" })}${field({ k: "tailscale_https_port", label: w.tsPort, val: D().tailscale_https_port ?? "", ph: w.default, type: "number" })}</div>${field({ k: "orchestrator_model", label: w.botModel, val: D().orchestrator_model, ph: w.default })}${field({ k: "lane_model", label: w.laneModel, val: D().lane_model, ph: w.default })}</details>`,
        foot: nav("discord", "next", x.next),
      };
    },
    review() {
      const x = u(), r = x.review, sc = S.scan, d = D();
      if (V.applying) return { title: x.titles.applying, sup: x.sups.applying, body: `<div class="list" data-apply>${applyRows()}</div>`, foot: "" };
      const line = (s, title, sup) => row({ title, sup, end: `<a class="btn text inrow" href="#${s}">${h(x.fix)}</a>` });
      const hs = hz(d.runtime || "omo");
      const ok = (v, word) => `${word} ${v ? x.ready : r.laterWord}`;
      const tools = [sc.mac ? ok(sc.aside.app && sc.aside.cli, "Aside") : "", ok(sc.tailscale.running, "Tailscale"), ok(sc.zele.installed, "zele")].filter(Boolean).join(" · ");
      const dc = d.guild && !V.dcOff ? fmt(r.discordSum, { guild: d.guild, bot: S.saved["discord-bot-token"] || V.botMode === "token" ? r.botTokenWord : r.botAutoWord }) : r.noDiscord;
      const err = (d.name || "").length < 2 ? `<div class="note err" role="alert">${h(x.errors.name)}</div>` : V.applyError ? `<div class="note err" role="alert">${h(V.applyError)}</div>` : "";
      return {
        title: x.titles.review, sup: x.sups.review,
        body: `<div class="list">${line("harness", r.harness, `${hs?.label ?? "OmO"}${hs?.login_ready ? r.loggedIn : r.loginLater}`)}${line("tools", r.tools, tools)}${line("bot", r.bot, `${d.name || r.noName} · ${(d.tone || "").split(/[.,(]/)[0].slice(0, 24)}`)}${line("discord", "Discord", dc)}${line("web", r.web, `${d.machine_name || sc.tailscale.host || "-"} · ${(d.allow_logins || []).join(", ") || r.onlyHere}`)}</div>${err}`,
        foot: nav("web", "apply", x.review.go),
      };
    },
    done() {
      const x = u(), o = V.result, d = D();
      const rows = [row({ lead: dot("ok"), title: x.done.here, sup: `http://127.0.0.1:${location.port}/`, end: tag("ok", x.done.open) })];
      if (o.access === "tailscale") rows.push(row({ lead: dot("ok"), title: x.done.phone, sup: fmt(x.done.phoneSup, { url: o.url }), end: tag("ok", x.done.open) }));
      else if (o.why) rows.push(row({ lead: dot("warn"), title: x.done.phone, sup: o.why }));
      if (d.guild) rows.push(row({ lead: dot("ok"), title: "Discord", sup: fmt(x.done.discordSup, { name: d.name || "" }), end: tag("ok", x.done.connected) }));
      if (o.owner) rows.push(row({ lead: dot("warn"), title: o.owner, end: tag("warn", x.yourTurn) }));
      return { title: fmt(x.titles.done, { name: d.name || "dotz" }), sup: "", body: `<div class="list">${rows.join("")}</div>`, foot: `<span class="ob-sp"></span><button class="btn" data-act="open-app">${h(x.done.openApp)}</button>` };
    },
  };
  const nav = (back, act, label, extra = "") => `${back ? `<a class="btn text" href="#${back}">${h(u().back)}</a>` : ""}<span class="ob-sp"></span>${extra}<button class="btn" data-act="${act}" data-next>${h(label)}</button>`;

  // The lines the apply job reports (hub/setup-apply.ts says one step line each); a line that is not a step name is the detail of the running step.
  function applyRows() {
    const x = u(), lines = V.log.apply || [], known = Object.values(S.text.steps), seen = known.filter(t => lines.includes(t)), last = lines[lines.length - 1];
    const detail = known.includes(last) ? "" : last || "";
    const rows = seen.length
      ? seen.map((t, i) => row({ lead: dot(i < seen.length - 1 ? "ok" : "pri"), title: t, sup: i === seen.length - 1 ? detail : "", end: tag(i < seen.length - 1 ? "ok" : "pri", i < seen.length - 1 ? S.text.states.done : x.running) }))
      : [row({ lead: dot("pri"), title: S.text.jobs.apply, sup: V.lines.apply || job("apply").detail, end: tag("pri", x.running) })];
    const owner = job("apply").owner;
    if (owner) rows.push(row({ lead: dot("warn"), title: owner, end: tag("warn", x.yourTurn) }));
    return rows.join("");
  }

  /* ---------- screen ---------- */
  function shell(v, view) {
    const x = u(), at = STEPS.indexOf(v), f = furthest();
    const rail = STEPS.map(s => {
      const i = ORDER.indexOf(s), st = i < f ? "ok" : s === v ? "pri" : "", cur = s === v ? ' aria-current="step"' : "";
      return i <= f && !V.applying ? `<a class="ni${s === v ? " on" : ""}" href="#${s}"${cur}>${dot(st)}<span>${h(x.steps[s])}</span></a>` : `<span class="ni off"${cur}>${dot(st)}<span>${h(x.steps[s])}</span></span>`;
    }).join("");
    const top = at < 0 ? "" : `<div class="ob-top"><span class="meta">${at + 1}/${STEPS.length} ${h(x.steps[v])}</span><div class="bar pri"><i style="width:${((at + 1) / STEPS.length) * 100}%"></i></div></div>`;
    return `<div class="ob"><aside class="ob-rail"><div class="brand"><span class="logo"></span><span>dotz</span></div><nav class="nav" aria-label="${h(x.nav)}">${rail}</nav></aside><div class="ob-main"><div class="ob-scroll">${top}<div class="ob-col"><h1 tabindex="-1">${h(view.title)}</h1>${view.sup ? `<p class="ob-sup">${h(view.sup)}</p>` : ""}<div data-ob-body>${view.body}</div></div></div><footer class="ob-ft"><div class="ob-ft-in">${view.foot}</div><div class="note ob-msg" id="ob-msg" role="status" aria-live="polite"></div></footer></div></div>`;
  }
  function render(opts = {}) {
    const keep = qs(".ob-scroll")?.scrollTop ?? 0;
    V.rows = {};
    root.innerHTML = shell(V.view, VIEWS[V.view]());
    syncNext();
    if (opts.step) qs("h1").focus({ preventScroll: true });
    else { const s = qs(".ob-scroll"); if (s) s.scrollTop = keep; if (opts.focus) qs(opts.focus)?.focus({ preventScroll: true }); }
  }
  function syncNext() {
    const b = busy();
    for (const el of root.querySelectorAll("[data-next]")) el.disabled = b;
    if (b && qs("[data-next]")) say(u().errors.waitJob);
  }
  function viewFromHash() {
    const s = location.hash.slice(1), f = furthest();
    return ORDER.includes(s) && s !== "done" && ORDER.indexOf(s) <= f ? s : ORDER[Math.min(f, ORDER.indexOf("review"))];
  }
  const goto = step => { if (location.hash.slice(1) === step) { V.view = step; render({ step: true }); } else location.hash = `#${step}`; };

  /* ---------- leaving a step ---------- */
  function validate(v, val) {
    const e = u().errors, name = val.name ?? D().name ?? "";
    if ((v === "bot" || v === "review") && (name.length < 2 || name.length > 32)) return e.name;
    if (v === "discord" && !V.dcOff && val.guild) {
      if (!ID.test(val.guild)) return e.guild;
      if (!ID.test(val.owner_id || "")) return e.owner;
      const typed = qs('[data-secret="discord-bot-token"]')?.value;
      if ((V.botMode || (S.saved["discord-bot-token"] ? "token" : "auto")) === "token" && !typed && !S.saved["discord-bot-token"]) return e.token;
    }
    if (v === "web") {
      const peer = qs('[data-secret="peer-token"]')?.value;
      if (peer && (peer.length < 16 || /\s/.test(peer))) return e.peer;
      for (const k of ["web_port", "tailscale_https_port"]) if (val[k] !== undefined && !(Number.isInteger(val[k]) && val[k] >= 1 && val[k] <= 65535)) return e.port;
    }
    return "";
  }
  // A secret goes to the gateway at once and the field is emptied before the request leaves, so it is never in the DOM, the draft or the browser afterwards.
  async function putSecret(name) {
    const el = qs(`[data-secret="${name}"]`);
    if (!el?.value) return;
    const value = el.value;
    el.value = "";
    await api("/api/setup/secret", "POST", { name, value });
    S.saved[name] = true;
  }
  async function next() {
    const v = V.view, values = gather();
    if (v === "discord" && V.dcOff) Object.assign(values, { guild: "", owner_id: "" });
    if (v === "harness") values.runtime = D().runtime || "omo";
    if (v === "start") values.lang = S.lang.slice(0, 2);
    const bad = validate(v, values);
    if (bad) { say(bad, true); return; }
    const target = ORDER[ORDER.indexOf(v) + 1];
    try {
      if (v === "discord") await putSecret("discord-bot-token");
      if (v === "web") await putSecret("peer-token");
      await save(values, target);
    } catch (e) { say(e.message, true); return; }
    V.tokenEdit = V.peerEdit = false;
    goto(target);
  }
  const leave = () => { if (["bot", "discord", "web"].includes(V.view)) { const v = gather(); Object.assign(S.draft, v); save(v).catch(() => {}); } };

  /* ---------- apply ---------- */
  async function apply() {
    const bad = validate("review", {});
    if (bad) { say(bad, true); return; }
    V.applying = true; V.applyError = "";
    render();
    try { V.result = await api("/api/setup/apply", "POST", {}); }
    catch (e) { V.applying = false; V.applyError = e.message; render(); return; }
    V.applying = false; V.view = "done";
    history.replaceState(null, "", "#done");
    render({ step: true });
  }
  async function openApp() {
    const b = qs('[data-act="open-app"]');
    b.disabled = true;
    say(u().done.opening);
    // the gateway restarts once after the apply; wait until it answers again before leaving
    for (;;) {
      const up = await fetch("/api/peer-info", { cache: "no-store" }).then(r => r.ok, () => false);
      if (up) break;
      await new Promise(r => setTimeout(r, 500));
    }
    location.href = V.result.access === "tailscale" ? V.result.url : "/";
  }

  /* ---------- sheets: the terminal and the OmO login ---------- */
  function openSheet({ title, sub = "", body, foot = "" }) {
    const opener = document.activeElement;
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="ob-scrim" data-act="sheet-close"></div><div class="sheet ob-sheet" role="dialog" aria-modal="true" aria-label="${h(title)}"><div class="sh-head"><div class="sh-t"><div class="sh-name">${h(title)}</div></div><button class="btn text" data-act="sheet-close">${h(u().close)}</button></div><div class="sh-body">${sub ? `<p class="ob-sup">${h(sub)}</p>` : ""}${body}</div>${foot ? `<div class="ob-sheet-ft">${foot}</div>` : ""}</div>`;
    document.body.append(wrap);
    root.inert = true;
    const sheet = wrap.lastElementChild;
    const api2 = { sheet, onclose: null, close() { api2.onclose?.(); wrap.remove(); root.inert = false; opener?.focus?.(); }, q: s => qs(s, sheet) };
    wrap.addEventListener("click", ev => { if (ev.target.closest('[data-act="sheet-close"]')) api2.close(); });
    qs("button", sheet).focus();
    return api2;
  }
  const loadTerm = () => (lib ||= (async () => {
    const add = (tag2, attrs) => new Promise((ok, no) => { const n = Object.assign(document.createElement(tag2), attrs, { onload: ok, onerror: () => no(new Error(u().term.lib)) }); document.head.append(n); });
    await add("link", { rel: "stylesheet", href: "/vendor/xterm.css" });
    await add("script", { src: "/vendor/xterm.js" });
    await add("script", { src: "/vendor/addon-fit.js" });
  })().catch(e => { lib = null; throw e; }));

  // Only a fixed id leaves this page (hub/setup-term.ts maps it to one command); the keys typed into the terminal answer that command's own prompts.
  async function openTerm(id) {
    const x = u().term, sh = openSheet({ title: S.text.terms[id], sub: x.sub, body: '<div class="sh-term ob-xterm"></div><div class="note" id="ob-term-st" role="status"></div>' });
    const st = sh.q("#ob-term-st"), box = sh.q(".sh-term"), ctl = new AbortController();
    let term = null, queue = Promise.resolve();
    sh.onclose = () => { ctl.abort(); term?.dispose(); refresh().catch(() => {}); };
    st.textContent = x.starting;
    try {
      await loadTerm();
      term = new Terminal({ cursorBlink: true, scrollback: 2000, fontFamily: css("--mono") || "monospace", fontSize: 13, theme: { background: css("--tb"), foreground: css("--tf"), cursor: css("--tac") } });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit); term.open(box); fit.fit();
      await api(`/api/setup/term/${id}`, "POST", { cols: term.cols, rows: term.rows });
      term.onData(data => { queue = queue.then(() => api(`/api/setup/term/${id}/input`, "POST", { data })).catch(() => {}); });
      term.onResize(({ cols, rows }) => api(`/api/setup/term/${id}/resize`, "POST", { cols, rows }).catch(() => {}));
      new ResizeObserver(() => fit.fit()).observe(box);
      term.focus();
      st.textContent = x.live;
      const r = await fetch(`/api/setup/term/${id}/stream?cols=${term.cols}&rows=${term.rows}`, { signal: ctl.signal, cache: "no-store" });
      const rd = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const m = /^event: (\w+)\ndata: (.*)$/m.exec(buf.slice(0, i));
          buf = buf.slice(i + 2);
          if (!m) continue;
          const d = JSON.parse(m[2]);
          if (m[1] === "out" || m[1] === "reset") term.write(d.data || "");
          if (m[1] === "exit") { st.textContent = x.done; return; }
        }
      }
      st.textContent = x.lost;
    } catch (e) { if (e.name !== "AbortError") { st.textContent = e.message; st.className = "note err"; } }
  }

  // "anthropic" is the Claude subscription provider the OmO accounts are made of (web/js/21-providers.js uses the same id)
  async function openLogin() {
    const x = u().login, base = "/api/setup/providers/anthropic/login";
    let r;
    try { r = await api(base, "POST", {}); } catch (e) { say(e.message, true); return; }
    let timer, finished = false;
    const sh = openSheet({ title: x.title, sub: x.intro, body: `<a class="btn tonal ob-gap" target="_blank" rel="noopener noreferrer" hidden>${h(x.open)}</a><div class="sup ob-gap" data-ask></div>${field({ k: "code", label: x.code })}<div class="note err" id="ob-login-err" role="alert"></div>`, foot: `<button class="btn" data-act="login-go">${h(x.go)}</button>` });
    const paint = v => { const a = sh.q("a"); a.hidden = !/^https?:\/\//.test(v.url || ""); if (!a.hidden) a.href = v.url; sh.q("[data-ask]").textContent = v.prompt || ""; };
    const fail = t => { sh.q("#ob-login-err").textContent = t; };
    const finish = async () => { finished = true; clearTimeout(timer); sh.close(); await refresh().catch(() => {}); };
    const poll = async () => {
      try {
        const s = await api(`${base}?login_id=${encodeURIComponent(r.login_id)}`);
        if (s.status === "done") return finish();
        if (s.status === "failed") return fail(s.error || x.fail);
      } catch {}
      if (!finished) timer = setTimeout(poll, 2000);
    };
    const submit = async () => {
      const el = sh.q("input"), code = el.value.trim();
      if (!code) { fail(x.empty); return; }
      fail(""); clearTimeout(timer);
      try {
        const s = await api(`${base}/complete`, "POST", { login_id: r.login_id, code });
        if (s.status === "waiting") { el.value = ""; paint(s); timer = setTimeout(poll, 2000); return; }
        await finish();
      } catch (e) { fail(e.message); timer = setTimeout(poll, 2000); }
    };
    sh.sheet.addEventListener("click", ev => { if (ev.target.closest('[data-act="login-go"]')) submit(); });
    sh.sheet.addEventListener("keydown", ev => { if (ev.key === "Escape") sh.close(); if (ev.key === "Enter" && ev.target.tagName === "INPUT" && !ev.isComposing) { ev.preventDefault(); submit(); } });
    sh.onclose = () => { clearTimeout(timer); if (!finished) api(base, "DELETE").catch(() => {}); };
    paint(r);
    timer = setTimeout(poll, 2000);
  }

  /* ---------- the jobs stream ---------- */
  function paintJob(id) {
    if (id === "apply") { const l = qs("[data-apply]"); if (l) l.innerHTML = applyRows(); return; }
    for (const el of root.querySelectorAll("[data-key]")) {
      const spec = V.rows[el.dataset.key];
      if (spec?.job === id && el.classList.contains("li")) el.outerHTML = actionRow(el.dataset.key, spec);
    }
    syncNext();
  }
  function listen() {
    const es = new EventSource("/api/setup/stream");
    es.addEventListener("snapshot", e => { S.jobs = JSON.parse(e.data).jobs; });
    es.addEventListener("line", e => { const d = JSON.parse(e.data); V.lines[d.job] = d.text; (V.log[d.job] ||= []).push(d.text); paintJob(d.job); });
    es.addEventListener("state", e => {
      const r = JSON.parse(e.data);
      S.jobs = S.jobs.map(j => (j.id === r.id ? r : j));
      paintJob(r.id);
      if (r.state === "running") return;
      delete V.lines[r.id];
      flush().catch(() => {});
      if (r.id !== "apply") refresh().catch(() => {});
    });
  }

  /* ---------- events ---------- */
  const ACTS = {
    next, apply, "open-app": openApp,
    async lang(el) {
      const old = u().bot.opts, v = el.dataset.v, clear = {};
      for (const k of PICKS) if (old[k].some(o => o.v === D()[k])) clear[k] = "";
      await save({ lang: v, ...clear });
      await refresh(true);
      document.documentElement.lang = S.lang;
      render({ focus: `[data-act="lang"][data-v="${v}"]` });
    },
    pick(el) {
      const k = el.dataset.k, i = el.dataset.i;
      if (k === "runtime") { save({ runtime: i }).catch(e => say(e.message, true)); return render({ focus: `[data-k="runtime"][data-i="${i}"]` }); }
      Object.assign(S.draft, gather());
      if (i === "custom") V.custom[k] = true;
      else { V.custom[k] = false; S.draft[k] = u().bot.opts[k][Number(i)].v; save({ [k]: S.draft[k] }).catch(e => say(e.message, true)); }
      render({ focus: `[data-k="${k}"][data-i="${i}"]` });
    },
    async job(el) {
      try { S.jobs = (await api(`/api/setup/run/${el.dataset.job}`, "POST", {})).jobs; } catch (e) { say(e.message, true); return; }
      paintJob(el.dataset.job);
    },
    term: el => openTerm(el.dataset.term),
    login: () => openLogin(),
    later(el) { V.skipped[el.dataset.key] = true; paintJob(V.rows[el.dataset.key]?.job); render(); },
    "dc-off"() { V.dcOff = true; Object.assign(S.draft, { guild: "", owner_id: "" }); next(); },
    "dc-on"() { V.dcOff = false; render(); },
    "bot-mode"(el) { Object.assign(S.draft, gather()); V.botMode = el.dataset.v; render({ focus: `[data-act="bot-mode"][data-v="${el.dataset.v}"]` }); },
    "token-edit"() { V.tokenEdit = true; render({ focus: "#ob-token" }); },
    "peer-edit"() { V.peerEdit = true; Object.assign(S.draft, gather()); render({ focus: "#ob-peer" }); },
  };
  document.addEventListener("click", ev => {
    const el = ev.target.closest("[data-act]");
    const run = el && ACTS[el.dataset.act];
    if (run && !el.closest(".ob-sheet")) Promise.resolve(run(el)).catch(e => say(e.message, true));
  });
  root.addEventListener("change", ev => {
    const el = ev.target.closest("input[data-k]");
    if (!el || el.type === "password" || V.view === "done") return;
    const k = el.dataset.k, v = gather();
    if (k in v) save({ [k]: v[k] }).catch(e => say(e.message, true));
  });
  addEventListener("hashchange", () => { leave(); V.view = viewFromHash(); render({ step: true }); });

  /* ---------- start ---------- */
  (async () => {
    try { S = await api("/api/setup/state"); }
    catch (e) { root.innerHTML = `<div class="ob ob-dead"><div class="ob-col"><div class="brand"><span class="logo"></span><span>dotz</span></div><h1>${h(e.message)}</h1></div></div>`; return; }
    document.documentElement.lang = S.lang;
    V.dcOff = furthest() > ORDER.indexOf("discord") && !D().guild;
    V.view = viewFromHash();
    listen();
    render({ step: true });
    if (job("apply").state === "running") apply();
  })();
})();
