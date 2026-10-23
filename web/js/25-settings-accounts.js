/* ---------- settings: 계정 (/api/accounts: aliases, current account and why, switch rules, script) ---------- */
let ACC = null;
const ACC_DAYS = [["mon", "월"], ["tue", "화"], ["wed", "수"], ["thu", "목"], ["fri", "금"], ["sat", "토"], ["sun", "일"]];
const ACC_COND = [["", "없음"], ["five_hour_left_below", "5시간 남은 % 밑"], ["seven_day_left_below", "주간 남은 % 밑"], ["rate_limited", "한도 걸림"], ["auth_error", "로그인 풀림"], ["unavailable", "특정 계정 못 씀"]];
const ACC_DO = [["pin", "계정 고정"], ["prefer", "순서대로 우선"], ["auto", "자동"]];
async function loadAccounts() {
  try { ACC = await api("/api/accounts"); } catch { ACC = null; }
  if (current === "settings") renderSettings();
}
const accLabel = id => { const a = ACC && ACC.accounts.find(x => x.name === id || x.alias === id); return a ? a.label || a.alias || a.name : id; };
const accMut = (btn, call, msg, close) => busy(btn, async () => { ACC = await call(); if (close) close(); if (msg) toast(msg); renderSettings(); if (current === "usage") loadQuota(); });
async function accCopy(text) { try { await navigator.clipboard.writeText(text); toast("복사했어요"); } catch { toast("복사하지 못했어요", true); } }
function accTags(a, pin) {
  const t = [];
  // a.current: the account requests really use (OmO skips a blocked one); blocked_tag: "한도 걸림 · 01:00까지"
  // 고정: the fixed account (pin) carries the badge instead
  if (pin ? a.name === pin : a.current) t.push([pin ? "사용 중 · 고정" : "사용 중", "pri"]);
  if (a.blocked) t.push([a.blocked_tag || "쓸 수 없음", a.blocked === "rate_limit" ? "warn" : "err"]);
  else if (!(pin ? a.name === pin : a.current)) t.push(["쓸 수 있음", "ok"]);
  return t;
}
function accountSection() {
  if (!ACC) return [];
  const dec = ACC.decision, sc = ACC.script, lines = ACC.rules_text || [], pct = n => `${Math.round(n)}%`;
  const tx = (hd, ...sup) => el("span", { class: "tx" }, hd ? el("div", { class: "hd", text: hd }) : null, sup.length ? el("div", { class: "sup" }, ...sup) : null);
  // two modes: 자동 전환 (rules, and a switch when the account is blocked) or 고정 (one account, requests never move to another)
  const pinned = ACC.mode === "pinned", ch = ACC.chosen, pin = pinned && ch ? ch.name : "";
  const setMode = (btn, body, msg) => accMut(btn, () => api("/api/accounts/mode", "PUT", body), msg);
  // the order is the fallback order of 자동 전환: the first usable account by number takes over when the current one is blocked
  const move = (btn, i, d) => { const names = ACC.accounts.map(x => x.name); [names[i], names[i + d]] = [names[i + d], names[i]]; accMut(btn, () => api("/api/accounts/order", "PUT", { order: names })); };
  const rows = ACC.accounts.map((a, i, all) => {
    const label = a.label || a.alias || a.name;
    const sub = [a.name !== label ? a.name : "", a.five_hour_left != null ? `5시간 ${pct(a.five_hour_left)} 남음` : "", a.seven_day_left != null ? `주간 ${pct(a.seven_day_left)} 남음` : ""].filter(Boolean).join(" · ");
    // 고정: tapping a row fixes that account; 자동 전환: tapping it opens its name and details
    const onclick = ev => pinned ? (a.name !== pin && setMode(ev.currentTarget, { mode: "pinned", account: a.name }, "고정 계정을 바꿨어요")) : accDialog(a);
    const mv = (d, t, name) => el("button", { class: "acc-mv", type: "button", "aria-label": `${label} ${name}`, disabled: i + d < 0 || i + d >= all.length, onclick: ev => move(ev.currentTarget, i, d), text: t });
    return el("div", { class: `li acc${pinned && a.name === pin ? " on" : ""}` },
      el("button", { class: "acc-main", type: "button", ...(pinned ? { role: "radio", "aria-checked": String(a.name === pin) } : {}), onclick },
        el("span", { class: "lead acc-no", text: String(a.order || i + 1) }), tx(label, sub), ...accTags(a, pin).map(([t, tone]) => el("span", { class: `tag ${tone}`, text: t }))),
      pinned ? el("button", { class: "acc-mv", type: "button", "aria-label": `${label} 이름 바꾸기`, onclick: () => accDialog(a) }, icon("chev", "lead")) : el("span", { class: "acc-mvs" }, mv(-1, "↑", "위로"), mv(1, "↓", "아래로")));
  });
  const caption = pinned ? (ch && ch.blocked ? `${ch.text}.` : `${ch ? ch.label : "고른 계정"}만 써요. 한도에 걸리면 풀릴 때까지 멈추고, 다른 계정으로 넘어가지 않아요.`) : "규칙과 한도에 따라 계정을 골라요. 쓰던 계정이 막히면 다른 계정으로 넘어가요.";
  // on = 자동 전환, off = 고정 (the account to fix is the row tapped below)
  rows.unshift(el("div", { class: "li" }, tx("자동 전환", caption),
    el("button", { type: "button", class: "hs-sw", role: "switch", "aria-checked": String(!pinned), "aria-label": "자동 전환", onclick: ev => setMode(ev.currentTarget, { mode: pinned ? "auto" : "pinned" }, pinned ? "자동 전환으로 바꿨어요" : "고정했어요") })));
  if (!pinned) {
    rows.push(el("div", { class: "li" }, tx("전환 규칙", lines.length ? "" : "규칙이 없어요. 계정이 막힐 때만 자동으로 바꿔요."), el("button", { class: "btn tonal", type: "button", onclick: () => rulesDialog() }, "편집")));
    for (const [i, r] of lines.entries()) rows.push(el("div", { class: "li" }, el("span", { class: "lead", text: String(i + 1) }), tx(r.text)));
  }
  const run = sc && [sc.timeout_ms ? `${Math.round(sc.timeout_ms / 1000)}초 안에 끝나요` : "", sc.every_minutes ? `${sc.every_minutes}분마다` : ""].filter(Boolean).join(" · ");
  if (!pinned && sc && sc.path) rows.push(el("button", { class: "li tap", type: "button", onclick: () => accCopy(sc.path) }, tx("스크립트", el("code", { text: sc.path }), run ? ` · ${run}` : "")));
  const last = sc && sc.last;
  if (!pinned && last) rows.push(el("div", { class: "li" }, tx(last.error || last.error_text ? "마지막 실행이 실패했어요" : `마지막 결과 · ${last.label || (last.account ? accLabel(last.account) : "고르지 않음")}`, [last.error_text || last.reason, last.at ? kstStamp(Date.parse(last.at)) : ""].filter(Boolean).join(" · "))));
  return [el("div", { class: "sec", text: "계정" }), el("div", { class: "list" }, ...rows)];
}
function accDialog(a) {
  const label = a.label || a.alias || a.name;
  const inp = el("input", { class: "fi", type: "text", value: a.alias || "", maxlength: "40", autocomplete: "off", placeholder: "별칭 (예: 회사, 개인)", "aria-label": "별칭" });
  const alias = (v, msg) => (btn, close) => accMut(btn, () => api("/api/accounts/alias", "PUT", { key: a.name, alias: v }), msg, close);
  const d = dialog({ classic: true, title: label, body: el("div", { class: "col" }, a.name !== label ? el("div", { class: "sup" }, "계정 ", el("code", { text: a.name })) : null, el("div", {}, el("div", { class: "lbl", style: "margin:0 0 6px", text: "별칭" }), inp)), actions: [
    a.alias ? { label: "지우기", kind: "danger", onclick: (c, b) => alias("", "별칭을 지웠어요")(b, c) } : null,
    { label: "이 계정으로 고정", kind: "tonal", disabled: ACC.mode === "pinned" && ACC.chosen && ACC.chosen.name === a.name, onclick: (c, b) => accMut(b, () => api("/api/accounts/mode", "PUT", { mode: "pinned", account: a.name }), `${label}로 고정했어요`, c) },
    { label: "저장", kind: "pri", onclick: (c, b) => alias(inp.value.trim(), inp.value.trim() ? "별칭을 저장했어요" : "별칭을 지웠어요")(b, c) }].filter(Boolean) });
  inp.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); d.node.querySelector(".dact .btn:last-child").click(); } });
  inp.focus();
}
function rulesDialog() {
  const accts = ACC.accounts;
  let R = JSON.parse(JSON.stringify(ACC.rules || {})), json = false;
  const list = () => (Array.isArray(R.rules) ? R.rules : (R.rules = []));
  const clean = o => {
    const c = JSON.parse(JSON.stringify(o));
    if (Array.isArray(c.rules)) { for (const r of c.rules) { if (!r.name) delete r.name; if (r.when && !Object.keys(r.when).length) delete r.when; } if (!c.rules.length) delete c.rules; }
    return c;
  };
  const acctPairs = cur => { const p = accts.map(a => [a.name, a.label || a.alias || a.name]); if (cur && !p.some(([v]) => v === cur)) p.push([cur, accLabel(cur)]); return p; };
  const select = (pairs, cur, label, onchange) => { const s = el("select", { class: "fi", "aria-label": label }, ...pairs.map(([v, t]) => el("option", { value: v, text: t, selected: v === cur }))); s.addEventListener("change", () => onchange(s.value)); return s; };
  const field = (label, ...ctrl) => el("div", {}, el("div", { class: "lbl", style: "margin:0 0 6px", text: label }), el("div", { class: "row", style: "flex-wrap:wrap" }, ...ctrl));
  const ta = el("textarea", { class: "fi hs-ta hs-mono", rows: 14, spellcheck: "false", "aria-label": "규칙 JSON" });
  const box = el("div", { class: "col" });
  const move = (i, to) => { const l = list(); [l[i], l[to]] = [l[to], l[i]]; paint(); };
  function card(r, i, n) {
    r.do = r.do || { auto: true };
    const w = r.when || {}, cond = ACC_COND.find(([k]) => k && k in w), ck = cond ? cond[0] : "";
    const set = (k, v) => { r.when = r.when || {}; if (v === "" || v == null) delete r.when[k]; else r.when[k] = v; };
    const nm = el("input", { class: "fi", type: "text", style: "flex:1 1 200px", value: r.name || "", maxlength: "40", placeholder: `규칙 ${i + 1} 이름 (선택)`, "aria-label": "규칙 이름" });
    nm.addEventListener("input", () => { r.name = nm.value; });
    const time = (k, label) => { const t = el("input", { class: "fi", type: "time", value: w[k] || "", "aria-label": label, style: "flex:1;min-width:96px" }); t.addEventListener("change", () => set(k, t.value)); return t; };
    const days = ACC_DAYS.map(([k, t]) => { const on = (w.days || []).includes(k); return el("button", { type: "button", class: `chip${on ? " on" : ""}`, "aria-pressed": String(on), text: t, onclick: () => { const s = new Set(w.days || []); on ? s.delete(k) : s.add(k); set("days", ACC_DAYS.map(([x]) => x).filter(x => s.has(x))); if (!(r.when.days || []).length) delete r.when.days; paint(); } }); });
    const condCtl = [select(ACC_COND, ck, "조건", v => {
      if (ck) delete r.when[ck];
      if (v === "five_hour_left_below" || v === "seven_day_left_below") set(v, 20);
      else if (v === "rate_limited" || v === "auth_error") set(v, true);
      else if (v === "unavailable") set(v, accts[0] ? accts[0].name : "");
      paint();
    })];
    if (ck === "five_hour_left_below" || ck === "seven_day_left_below") {
      const num = el("input", { class: "fi", type: "number", min: "0", max: "100", value: String(w[ck]), "aria-label": "남은 %", style: "width:96px;flex:none" });
      num.addEventListener("input", () => { if (num.value !== "") r.when[ck] = Number(num.value); });
      condCtl.push(num, el("span", { class: "sup", text: "% 밑" }));
    } else if (ck === "unavailable") condCtl.push(select(acctPairs(w.unavailable), w.unavailable, "계정", v => { r.when.unavailable = v; }));
    const dk = "pin" in r.do ? "pin" : "prefer" in r.do ? "prefer" : "auto";
    const doCtl = [select(ACC_DO, dk, "동작", v => { r.do = v === "pin" ? { pin: accts[0] ? accts[0].name : "" } : v === "prefer" ? { prefer: [] } : { auto: true }; paint(); })];
    if (dk === "pin") doCtl.push(select(acctPairs(r.do.pin), r.do.pin, "계정", v => { r.do.pin = v; }));
    if (dk === "prefer") {
      const pref = Array.isArray(r.do.prefer) ? r.do.prefer : (r.do.prefer = []);
      for (const [v, t] of acctPairs()) { const at = pref.indexOf(v); doCtl.push(el("button", { type: "button", class: `chip${at >= 0 ? " on" : ""}`, "aria-pressed": String(at >= 0), text: at >= 0 ? `${at + 1} ${t}` : t, onclick: () => { at >= 0 ? pref.splice(at, 1) : pref.push(v); paint(); } })); }
    }
    const many = Object.keys(w).filter(k => ACC_COND.some(([c]) => c === k)).length > 1;
    return el("div", { class: "list" }, el("div", { class: "li", style: "flex-direction:column;align-items:stretch;gap:12px" },
      el("div", { class: "row", style: "flex-wrap:wrap" }, nm,
        el("button", { type: "button", class: "btn text", disabled: i === 0, onclick: () => move(i, i - 1) }, "위로"),
        el("button", { type: "button", class: "btn text", disabled: i === n - 1, onclick: () => move(i, i + 1) }, "아래로"),
        el("button", { type: "button", class: "btn danger", onclick: () => { list().splice(i, 1); paint(); } }, "삭제")),
      field("요일 (선택)", ...days),
      field("시간 (선택)", time("from", "시작"), el("span", { class: "sup", text: "~" }), time("to", "끝")),
      field("조건", ...condCtl), many ? el("div", { class: "sup", text: "조건이 여러 개예요. 모두 보려면 JSON으로 편집해 주세요." }) : null,
      field("동작", ...doCtl)));
  }
  function paint() {
    clear(box);
    if (json) { box.append(ta); return; }
    const l = Array.isArray(R.rules) ? R.rules : [];
    if (!l.length) box.append(el("div", { class: "sup", text: "규칙이 없어요. 계정이 막힐 때만 자동으로 바꿔요." }));
    l.forEach((r, i) => box.append(card(r, i, l.length)));
    box.append(el("div", {}, el("button", { type: "button", class: "btn tonal", onclick: () => { list().push({ do: { auto: true } }); paint(); } }, "규칙 추가")));
  }
  const parse = () => { let o; try { o = JSON.parse(ta.value || "{}"); } catch { throw new Error("JSON 모양이 맞지 않아요"); } if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("JSON 모양이 맞지 않아요"); return o; };
  const toggle = () => {
    if (!json) { ta.value = JSON.stringify(clean(R), null, 2); json = true; }
    else { try { R = parse(); } catch (e) { return toast(e.message, true); } json = false; }
    d.setActions(acts()); paint();
  };
  const acts = () => [
    { label: "취소", onclick: c => c() },
    { label: json ? "폼으로 보기" : "JSON으로 편집", onclick: toggle },
    { label: "저장", kind: "pri", onclick: (c, b) => accMut(b, () => api("/api/accounts/rules", "PUT", { rules: json ? parse() : clean(R) }), "규칙을 저장했어요", c) }];
  const d = dialog({ classic: true, title: "전환 규칙", body: box, wide: true, actions: acts() });
  paint();
}
