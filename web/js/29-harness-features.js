/* ---------- 구성: 기능 보기 (what the owner added, by implementation form; data from /api/features) ---------- */
const FC_NOTE = {
  "글 지시": TX("system.fcnote.instr"),
  "차단 명령": TX("system.fcnote.deny"),
  "기능 폴더": TX("system.fcnote.folder"),
  "스킬": TX("system.fcnote.skill"),
  "확장": TX("system.fcnote.ext"),
  "예약": TX("system.fcnote.schedule"),
  "모니터링": TX("system.fcnote.monitor"),
  "작업 채널 설정": TX("system.fcnote.channel"),
  "게이트웨이 기능": TX("system.fcnote.gateway"),
  "외부 연동": TX("system.fcnote.external"),
  "웹 맞춤": TX("system.fcnote.web"),
};
const FC_STR = { enforced: TX("system.str.enforced"), advisory: TX("system.str.advisory") };
// Extensions installed for another harness are not loaded by the one running dotz: they leave every count and stage card
// and sit in one folded "이 하네스에선 꺼짐" group at the end of the list.
function fcSplit(c) { if (c && !c.off) { c.off = c.features.filter(f => f.inactive); c.features = c.features.filter(f => !f.inactive); } return c; }
const fcHarness = () => (FC && FC.harness ? FC.harness.name : TX("system.harness"));
const fcFormLabel = form => (form === "확장" ? TX("system.ext.label", { name: fcHarness() }) : form);
const fcNote = form => (form === "확장" && FC && FC.harness ? TX("system.ext.note", { name: fcHarness(), dirs: [TX("system.ext.default"), ...FC.harness.dirs].join(", ") }) : FC_NOTE[form] || "");
const FC_FILE_NODE = { "RULES.md": "rules", "LESSONS.md": "lessons", "identity/IDENTITY.md": "identity" };
const fcOf = id => (FC ? FC.features.filter(f => f.stage === id) : []);
const fcDupText = f => (f.dup && f.dup.length ? TX(f.strength === "advisory" ? "system.dup.code" : "system.dup.text", { names: f.dup.map(d => d.name).join(", ") }) : "");

function fcBadges(ids, compact) {
  if (!hFeat || !FC || hPj()) return null;
  const set = new Set([].concat(ids)), list = FC.features.filter(f => set.has(f.stage)), e = list.filter(f => f.strength === "enforced").length, a = list.length - e;
  if (!list.length) return null;
  return el("span", { class: "hm-bd", title: TX("system.fbadge.title", { e, a }) }, e ? el("span", { class: "bd f", text: compact ? String(e) : TX("system.fbadge.enforced", { n: e }) }) : null, a ? el("span", { class: "bd a", text: compact ? String(a) : TX("system.fbadge.advisory", { n: a }) }) : null);
}

// A switch only asks: it sends "<name> 끄기/켜기 (<source>)" to the orchestrator and keeps showing the real state until
// the catalog reports the change (the "요청 보냄" tag marks the pending request). With ui.origin_view the request also
// carries its 범위 (개인/배포); a shipped feature folder is turned off by default with a personal override
// (~/.dotz/features/<id>/ with the same id), and the switch offers the shipped repo file as an explicit second choice.
const fcCfgKey = f => (/config\.json:([\w.]+)/.exec(f.source.label) || [])[1];
const fcDirId = f => (/features\/([^/]+)\/feature\.md$/.exec(f.source.label) || [])[1];
const fcCanToggle = f => f.toggleable || (hOrigin() && f.form === "기능 폴더" && !!fcDirId(f));
function fcScopeOf(f) {
  const key = fcCfgKey(f), dir = fcDirId(f);
  if (key) return { kind: "personal", where: `config.json:${key}` };
  if (dir && f.origin === "shipped") return { kind: "personal", where: `${hData()}/features/${dir}/`, override: dir };
  return { kind: f.origin === "shipped" ? "shipped" : "personal", where: f.source.label };
}
const fcAsked = new Map();
function fcSwitch(f) {
  const ask = fcAsked.get(f.id);
  if (ask && ask.to === f.enabled) fcAsked.delete(f.id);
  const pend = fcAsked.get(f.id), def = fcScopeOf(f);
  const sw = el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(f.enabled), "aria-label": TX(f.enabled ? "system.sw.aria_off" : "system.sw.aria_on", { name: f.name }), title: TX(f.enabled ? "system.sw.title_off" : "system.sw.title_on", { bot: botName }) });
  const sent = el("span", { class: "tag pri", text: pend ? TX("system.sw.sent", { at: pend.at }) : "", hidden: !pend });
  // the tag shows the short folder (shortPath), its title and the request keep the full path
  const tag = hScopeTag(def.kind, def.override ? shortPath(def.where) : def.where, true, def.where);
  if (tag && def.override) tag.title = TX("system.sw.scope_tip", { scope: hScope(def.kind, def.where) });
  const post = async choice => {
    const repo = def.override ? `features/${def.override}/feature.md` : f.source.label;
    let { kind, where } = def, text = TX(f.enabled ? "system.sw.req_off" : "system.sw.req_on", { name: f.name, src: hOrigin() && def.override ? TX("system.sw.shipped_feat", { repo }) : f.source.label });
    if (hOrigin() && def.override) {
      if (choice === "shipped") { kind = "shipped"; where = repo; text += `\n${TX("system.sw.req_shipped", { repo, on: !f.enabled })}`; }
      else text += `\n${TX("system.sw.req_override", { where, repo, on: !f.enabled })}`;
    }
    const at = await hRequest(text, hScope(kind, where));
    fcAsked.set(f.id, { to: !f.enabled, at });
    motionSwap(sent, () => { sent.textContent = TX("system.sw.sent", { at }); sent.hidden = false; });
  };
  sw.addEventListener("click", ev => {
    ev.stopPropagation();
    if (hOrigin() && def.override) {
      showMenu(sw, [{ value: "personal", label: TX("system.sw.pick_personal"), sub: def.where }, { value: "shipped", label: TX("system.sw.pick_shipped"), sub: TX("system.sw.pick_shipped_sub", { path: `features/${def.override}/feature.md` }) }], { value: "personal", onPick: v => busy(sw, () => post(v)) });
      return;
    }
    busy(sw, () => post("personal"));
  });
  return el("span", { class: "fc-sw" }, tag, sent, sw);
}

// A card opens the harness node it works in; text rules open their file editor at the line.
function fcOpenFeature(f) {
  const node = FC_FILE_NODE[f.source.file];
  if (node && f.source.line) openHSheet(node, { line: f.source.line, feature: f.id });
  else openHSheet(f.stage, { feature: f.id });
}

// What a card shows: the two-line summary in the user's language when the hub has one (its first line is the name when the
// original name is not in that language), else the original; the original text goes in the tooltip.
function fcShown(f) {
  if (!f.summary) return { name: f.name, what: f.what, tip: "" };
  const lines = f.summary.split("\n");
  return { name: f.titled ? lines[0] : f.name, what: f.titled ? lines.slice(1).join("\n") : f.summary, tip: [f.name, f.what].filter(Boolean).join("\n") };
}

function fcCard(f) {
  const node = hNode(f.stage), dup = fcDupText(f), sh = fcShown(f);
  const c = el("div", { class: `fc-card ${f.strength}${f.enabled ? "" : " off"}`, tabindex: "0", role: "button", "aria-label": `${sh.name}: ${sh.what}`, ...(sh.tip ? { title: sh.tip } : {}) },
    el("div", { class: "top" }, el("span", { class: "nm", text: sh.name }), fcCanToggle(f) ? fcSwitch(f) : null),
    sh.what ? el("div", { class: "wh", text: sh.what }) : null,
    el("div", { class: "fc-tags" },
      f.inactive ? el("span", { class: "tag", title: TX("system.ext.not_loaded_tip", { name: fcHarness() }), text: TX("system.ext.not_loaded") }) : el("span", { class: `tag st ${f.strength}`, title: f.strength === "enforced" ? TX("system.str.enforced_tip") : TX("system.str.advisory_tip"), text: FC_STR[f.strength] }),
      el("span", { class: "tag", text: f.trigger }),
      hOrigin() && f.origin ? el("span", { class: `tag${f.origin === "personal" ? " pri" : ""}`, title: f.origin === "personal" ? TX("system.origin.personal_tip") : TX("system.origin.shipped_tip"), text: FC_ORIGIN[f.origin] }) : null,
      node ? el("span", { class: "tag", text: node.label.replace(/\s*\(.*\)$/, "") }) : null,
      !f.enabled && !f.inactive ? el("span", { class: "tag", text: TX("system.state.off") }) : null,
      dup ? el("span", { class: "tag warn", title: dup, text: TX("system.dup.tag") }) : null),
    dup ? el("div", { class: "dup", text: dup }) : null,
    el("div", { class: "src", text: [f.source.label, f.added ? TX("system.src.added", { added: f.added }) : "", f.lastRun ? TX("system.src.last", { at: kstStamp(f.lastRun) }) : ""].filter(Boolean).join(" · ") }));
  c.addEventListener("click", () => fcOpenFeature(f));
  c.addEventListener("keydown", ev => { if ((ev.key === "Enter" || ev.key === " ") && ev.target === c) { ev.preventDefault(); fcOpenFeature(f); } });
  return c;
}

const fcMatch = f => {
  const q = fcFilter.q.trim().toLowerCase();
  return (!fcFilter.form || f.form === fcFilter.form) && (!fcFilter.strength || f.strength === fcFilter.strength) && (!fcFilter.trigger || f.trigger === fcFilter.trigger) && (!fcFilter.origin || FC_ORIGIN[f.origin] === fcFilter.origin)
    && (!q || `${f.name} ${f.what} ${f.summary || ""} ${f.source.label} ${f.trigger} ${f.form} ${f.extra || ""}`.toLowerCase().includes(q));
};

function fcPaintList() {
  const all = FC.features, hit = all.filter(fcMatch), filtering = !!(fcFilter.q.trim() || fcFilter.form || fcFilter.strength || fcFilter.trigger || fcFilter.origin);
  const e = hit.filter(f => f.strength === "enforced").length;
  fcCount.textContent = TX(filtering ? "system.fcount.hit" : "system.fcount.all", { hit: hit.length, n: all.length, e, a: hit.length - e });
  clear(fcList);
  if (!hit.length) { fcList.append(emptyNode(TX("system.fnone"))); return; }
  for (const form of FC.forms) {
    const items = hit.filter(f => f.form === form);
    if (!items.length) continue;
    const fe = items.filter(f => f.strength === "enforced").length, shut = !filtering && fcCollapsed.has(form);
    const head = el("button", { type: "button", class: "fc-gh", "aria-expanded": String(!shut) }, icon("drop"), el("span", { text: fcFormLabel(form) }), el("span", { class: "tag", text: TX("system.n_items", { n: items.length }) }),
      el("span", { class: "sup", text: TX("system.fsum", { e: fe, a: items.length - fe }) }), el("div", { class: "note", text: fcNote(form) }));
    head.addEventListener("click", () => { if (filtering) return; if (fcCollapsed.has(form)) fcCollapsed.delete(form); else fcCollapsed.add(form); fcPaintList(); });
    fcList.append(head);
    if (!shut) fcList.append(el("div", { class: "fc-grid" }, ...items.map(fcCard)));
  }
  const off = (FC.off || []).filter(fcMatch);
  if (off.length) {
    const shut = fcCollapsed.has("__off");
    const head = el("button", { type: "button", class: "fc-gh", "aria-expanded": String(!shut) }, icon("drop"), el("span", { text: TX("system.off_group") }), el("span", { class: "tag", text: TX("system.n_items", { n: off.length }) }));
    head.addEventListener("click", () => { if (fcCollapsed.has("__off")) fcCollapsed.delete("__off"); else fcCollapsed.add("__off"); fcPaintList(); });
    fcList.append(head);
    if (!shut) fcList.append(el("div", { class: "fc-grid" }, ...off.map(fcCard)));
  }
}

// The 기능 목록 shell (search + filters) is built once so typing is not interrupted by the 15 s refresh; only the list repaints.
function fcBuild(box) {
  const q = el("input", { class: "fi", type: "text", autocomplete: "off", spellcheck: "false", placeholder: TX("system.fsearch.ph"), "aria-label": TX("system.fsearch.aria"), value: fcFilter.q });
  q.addEventListener("input", () => { fcFilter.q = q.value; fcPaintList(); });
  const pick = (key, label, options) => selectButton({ label, items: () => [{ value: "", label: TX("system.view.all") }, ...options().map(v => ({ value: v, label: v }))], value: fcFilter[key],
    text: v => v || TX("system.view.all"), frame: t => `${label}: ${t}`, onPick: v => { fcFilter[key] = v; fcPaintList(); } });
  const seg = el("div", { class: "seg", role: "group", "aria-label": TX("system.fstrength.aria") });
  for (const [v, t] of [["", TX("system.view.all")], ["enforced", TX("system.str.enforced")], ["advisory", TX("system.str.advisory")]]) {
    const b = el("button", { type: "button", class: fcFilter.strength === v ? "on" : "", text: t });
    b.addEventListener("click", () => { fcFilter.strength = v; for (const x of seg.children) x.classList.toggle("on", x === b); fcPaintList(); });
    seg.append(b);
  }
  fcCount = el("div", { class: "sup fc-count" });
  fcList = el("div");
  box.append(el("div", { class: "sec", text: TX("system.flist") }),
    el("div", { class: "sup", text: TX("system.flist.sup") }),
    el("div", { class: "fc-bar" }, q, pick("form", TX("system.pick.form"), () => FC.forms), pick("trigger", TX("system.pick.trigger"), () => FC.triggers), hOrigin() ? pick("origin", TX("system.pick.origin"), () => Object.values(FC_ORIGIN)) : null, seg), fcCount, fcList);
}

function renderFeatures() {
  const box = hFcBox;
  if (!box) return;
  if (!FC) { clear(box); fcSig = ""; return; }
  const sig = JSON.stringify(FC.features) + (HG ? HG.nodes.map(n => n.label).join("") : "") + (hOrigin() ? "o" : "");
  if (sig === fcSig && box.firstChild) return;
  fcSig = sig;
  if (!hOrigin()) fcFilter.origin = "";
  if (fcOrig !== hOrigin()) { fcOrig = hOrigin(); clear(box); }
  if (!box.firstChild) fcBuild(box);
  fcPaintList();
}

// 상세 시트: the features that work at this node, enforced first.
function fcSheetSection(n, focusId) {
  const list = fcOf(n.id).sort((a, b) => (a.strength === b.strength ? 0 : a.strength === "enforced" ? -1 : 1));
  if (!list.length) return [];
  const e = list.filter(f => f.strength === "enforced").length;
  const rows = list.map(f => {
    const dup = fcDupText(f), jump = !!(n.file && f.source.file && f.source.line), sh = fcShown(f);
    const r = el("div", { class: `hs-ft ${f.strength}${jump ? " go" : ""}${f.id === focusId ? " on" : ""}`, "data-fid": f.id, ...(sh.tip ? { title: sh.tip } : {}) },
      el("div", { class: "top" }, el("span", { class: `tag st ${f.strength}`, text: FC_STR[f.strength] }), hOrigin() && hOwn(f) ? el("span", { class: "tag m", text: TX("system.mark.mine_feat") }) : null, el("span", { class: "nm", text: sh.name }), fcCanToggle(f) ? fcSwitch(f) : null),
      sh.what ? el("div", { class: "wh", text: sh.what }) : null,
      el("div", { class: "src", text: `${f.trigger} · ${f.source.label}` }),
      dup ? el("div", { class: "dup", text: dup }) : null);
    if (jump) r.addEventListener("click", () => hGoto && hGoto(f.source.line));
    return r;
  });
  return [el("div", { class: "sec", text: TX("system.here.sec", { e, a: list.length - e }) }), el("div", { class: "hs-fts" }, ...rows)];
}

$("#hs-close").append(icon("close"));
$("#hs-close").onclick = closeHSheet;
document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !$("#hsheet").hidden && !openMenu && !document.querySelector("dialog[open]:not([data-leaving])")) closeHSheet(); });
H_MQ.addEventListener("change", () => { if (current === "harness") renderHarness(); });
let hW = 0;
window.addEventListener("resize", () => { if (current !== "harness" || H_MQ.matches || !hDetail) return; clearTimeout(hTimer); hTimer = setTimeout(() => { const w = $("#harness").clientWidth; if (Math.abs(w - hW) > 40) { hW = w; renderHarness(); } }, 150); });
setInterval(() => { if (current === "harness" && !document.hidden && !hLoading) loadHarness(true); }, 15000);
