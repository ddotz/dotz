/* ---------- 메일함: one mail app, accounts inside it, mailboxes under each account (docs/mailbox.md, prototype s-mailbox.js) ---------- */
// monItems() folds every mail instance into one item (mxMerge); renderMonitoring() hands the open item to mxScope (the box filter and the one pass that counts),
// mxPaint draws what sits outside the timeline (the pane, the account chip), mxTop what sits at its head. The rows stay `.mr` of monConvNode / mbRow, so the
// partial redraw, the off-screen skipping and the paging of 30-mail-box.js work as before. Data comes with GET /api/integrations (a mail item carries
// `boxes` and `account`) and `mail.box` / `mail.boxWhy` of the conversation card: nothing here polls or fetches on its own.
// MX.acct: "all" or an instance; MX.box: "all", a box id or "n:<name>" (the boxes of one name in every account). Both are part of the address (mxHash, mxRoute).
// Settings and 메일함 추가 are another screen: the buttons call mxOpenSet(boxId) / mxOpenNew() where those exist.
ICONS.folder ??= ICONS.projects;
ICONS.sliders ??= "M4 7h9M17 7h3M4 17h3M11 17h9M13 5v4M9 15v4";
ICONS.users ??= "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19a5.5 5.5 0 0 1 11 0M16 5.4a3 3 0 0 1 0 5.2M17.5 14a5.5 5.5 0 0 1 3 5";
ICONS.tag ??= "M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0zM8 8h.01";
const MX = { key: "", acct: "all", box: "all", scr: "", show: 0, mark: false, it: null, of: new Map(), nof: new Map(), accts: new Map(), pane: "", chip: "", slot: new Map(), teach: null };
const MX_MODE = { auto: "자동 초안", ask: "확인 먼저", notify: "알림만", quiet: "조용히 모으기" };
const MX_ZERO = { live: 0, unread: 0, needs: 0 };
const MX_STOP = new Set(["re", "fw", "fwd", "회신", "답장", "전달", "안내", "확인", "문의", "요청", "관련", "공지", "the", "and", "for", "with", "your", "from", "this", "that", "mail"]);
const mxModeOf = b => MX_MODE[b.mode] || "기본 방식";
const mxIc = n => icon(ICONS[n] ? n : "mail");
const mxDec = s => { try { return decodeURIComponent(s); } catch { return s; } };
const mxGroup = id => id.startsWith("n:");
const mxMail = () => INTG.items.filter(x => x.app === "mail");
// The one item's key: `i:mail`, or the first mail instance when `mail` is gone. Any mail instance opens it.
const mxKeyOf = inst => (mxMail().some(x => x.key === inst) ? `i:${(mxMail().find(x => x.key === "mail") || mxMail()[0]).key}` : `i:${inst}`);
// The address: `monitoring/i%3Amail/<account>/<box>`; the box is encoded twice so a name with a slash stays one part. Without a suffix the item opens as it was.
const mxHash = sel => (sel === MX.key && (MX.acct !== "all" || MX.box !== "all" || MX.scr) ? `/${enc(MX.acct)}/${enc(enc(MX.box))}${MX.scr ? `/${MX.scr}` : ""}` : "");
function mxRoute(tgt) {
  const m = /^(i:[^/]+)(?:\/([^/]*)\/([^/]*)(?:\/([^/]*))?)?$/.exec(tgt || "");
  if (!m) return tgt;
  const key = mxKeyOf(m[1].slice(2));
  MX.scr = m[4] === "set" || m[4] === "new" ? m[4] : "";
  if (m[2] !== undefined) { MX.acct = mxDec(m[2]); MX.box = mxDec(m[3]); } else if (key !== m[1]) { MX.acct = m[1].slice(2); MX.box = "all"; }
  return key;
}
const mxSync = () => { MON.sig = ""; const box = $("#mon-timeline"); if (box) box.scrollTop = 0; routeReplace(monHash()); monSchedule(); };
// A box picked in the panel beside an open mail (30-mailboxes.js mxTwo) goes back to that box's list; on the list it filters it in place.
const mxBox = id => { MX.box = id; MX.scr = ""; if (current === "chat") { MON.sig = ""; MON.tlTop = 0; go("monitoring", MON.sel); } else mxSync(); };
const mxPick = a => { MX.acct = a; MX.box = "all"; MX.scr = ""; mxSync(); };
const mxNew = () => { if (typeof mxOpenNew === "function") mxOpenNew(); };
const mxSet = id => { if (typeof mxOpenSet === "function") mxOpenSet(id); };

/* ---- the one app ---- */
// Every `app === "mail"` instance of monItems becomes one: mails and notices together, the counts added, `inst` the first one's. A peer's mail is not here (pqMerge adds it later).
function mxMerge(items) {
  MX.of = new Map(); MX.nof = new Map(); MX.accts = new Map(); MX.key = "";
  const mine = items.filter(i => i.app && mxMail().some(x => x.key === i.inst));
  if (!mine.length) return;
  const top = mine.find(i => i.inst === "mail") || mine[0], first = s => [...String(s || "")][0] || "";
  const same = new Set(mine.map(i => first(i.name))).size < mine.length;
  const accts = mine.map((i, n) => {
    const g = INTG.items.find(x => x.key === i.inst), boxes = Array.isArray(g.boxes) && g.boxes.length ? g.boxes : [{ id: "base", name: "일반", icon: "mail", base: true }];
    const a = { key: i.inst, n, label: i.name, account: g.account || "", boxes, byId: new Map(boxes.map(b => [b.id, b])), base: boxes.find(b => b.base) || boxes[0], conn: !!i.conn, hint: i.hint, needs: { drafts: i.drafts | 0, unread: i.unread | 0, unreplied: i.unreplied | 0 }, owned: i.owned || [], mk: same ? first(g.account).toUpperCase() || String(n + 1) : first(i.name) };
    MX.accts.set(a.key, a);
    for (const t of i.mails) MX.of.set(t, a.key);
    for (const n of i.notices) MX.nof.set(n.id, a.key);
    return a;
  });
  const sum = f => mine.reduce((c, i) => c + (i[f] | 0), 0), down = accts.filter(a => a.conn);
  MX.key = top.key;
  Object.assign(top, { accounts: accts, mails: mine.flatMap(i => i.mails), notices: mine.flatMap(i => i.notices), drafts: sum("drafts"), unread: sum("unread"), unreplied: sum("unreplied") });
  if (accts.length > 1) Object.assign(top, { name: "메일", conn: false, owned: mine.flatMap(i => i.owned || []), msig: mine.map(i => i.msig).join("|"), at: mine.map(i => i.at).sort().pop(),
    hint: down.length ? down[0].hint : monNeedLine({ drafts: top.drafts, unreplied: top.unreplied, unread: top.unread }, false), badge: down.length ? ["연결 끊김", "err"] : mine.map(i => i.badge).find(Boolean) || null });
  for (const i of mine) if (i !== top) items.splice(items.indexOf(i), 1);
}
const mxBoxOf = t => { const a = MX.accts.get(MX.of.get(t)), m = MAILS.get(t); return a ? a.byId.get(m && m.box) || a.base : null; };
const mxIn = t => { if (MX.box === "all") return true; const b = mxBoxOf(t); return !!b && (mxGroup(MX.box) ? b.name === MX.box.slice(2) : b.id === MX.box); };
const mxCanMove = t => { const a = MX.accts.get(MX.of.get(t)); return !!a && a.boxes.length > 1; };
// The entries of the pane and the chips: the boxes of the open account; in 모든 계정 the boxes of one name are one entry (`n:<name>`), the base box last.
function mxEntries(it) {
  const a = it.accounts.find(x => x.key === MX.acct) || (it.accounts.length === 1 ? it.accounts[0] : null), out = [];
  if (a) for (const b of a.boxes) out.push({ id: b.id, b, k: `${a.key}|${b.id}`, n: 0 });
  else {
    const by = new Map();
    for (const x of it.accounts) for (const b of x.boxes) by.set(b.name, [...(by.get(b.name) || []), { x, b }]);
    for (const l of by.values()) out.push(l.length === 1 && !l[0].b.base ? { id: l[0].b.id, b: l[0].b, k: `${l[0].x.key}|${l[0].b.id}`, n: 0 } : { id: `n:${l[0].b.name}`, b: l[0].b, k: `n:${l[0].b.name}`, n: l.length });
    out.sort((p, q) => (p.n > 0) - (q.n > 0));
  }
  return out.sort((p, q) => !!p.b.base - !!q.b.base);
}
const mxNoticeMail = n => { const to = String((n.decision && n.decision.to) || ""); return to.startsWith("mail:") ? to : n.src || n.open || ""; };
// The open mail item, narrowed to the chosen account and box: mails, and the notices of those mails (the 확인 대기 drafts), before any mail filter runs. The one pass over the
// mails also gives every count the pane, the chips and the head line show: Map key -> {live, unread, needs}.
function mxScope(it) {
  if (!it || !it.accounts) return it;
  if (MX.acct !== "all" && !it.accounts.some(a => a.key === MX.acct)) MX.acct = "all";
  const ents = mxEntries(it);
  if (MX.box !== "all" && !ents.some(e => e.id === MX.box)) MX.box = "all";
  if (MX.scr === "set" && (MX.acct === "all" || MX.box === "all")) MX.scr = "";
  const cnt = new Map(), mails = [], ok = new Set(), cut = MX.acct !== "all" || MX.box !== "all";
  for (const t of it.mails) {
    const m = MAILS.get(t), at = MX.of.get(t);
    if (!m || !at) { if (!cut) mails.push(t); continue; }
    if (MX.acct !== "all" && at !== MX.acct) continue;
    const b = mxBoxOf(t), live = m.dir !== "out" && !m.archived;
    for (const k of ["all", `${at}|${b.id}`, `n:${b.name}`]) {
      const c = cnt.get(k) || cnt.set(k, { live: 0, unread: 0, needs: 0 }).get(k);
      if (live) { c.live++; if (mailUnread(t, m)) c.unread++; if (mailOwed(m)) c.needs++; }
    }
    if (mxIn(t)) { mails.push(t); ok.add(t); }
  }
  MX.show = MX.box === "all" ? 2 : mxGroup(MX.box) ? 1 : 0;
  MX.mark = it.accounts.length > 1 && MX.acct === "all";
  const sc = MX.acct === "all" ? it.accounts : it.accounts.filter(a => a.key === MX.acct), all = cnt.get("all") || MX_ZERO;
  const line = [it.accounts.length > 1 ? (MX.acct === "all" ? `계정 ${it.accounts.length}개` : sc[0].account || sc[0].label) : "", `안 읽음 ${all.unread}`, `메일함 ${sc.reduce((c, a) => c + a.boxes.length, 0)}개`].filter(Boolean).join(" · ");
  const rows = ents.map(e => ({ ...e, c: cnt.get(mxGroup(e.id) ? e.id : e.k) || MX_ZERO }));
  // listed: the app has stored mail, so a box with none of it still draws as a mail list.
  return { ...it, listed: !!MX.scr || it.mails.some(t => MAILS.has(t)), mails: MX.scr ? [] : mails, notices: MX.scr ? [] : cut ? it.notices.filter(n => (MX.box === "all" ? MX.nof.get(n.id) === MX.acct : ok.has(mxNoticeMail(n)))) : it.notices, mxk: `|${MX.acct}|${MX.box}|${MX.scr}`, mxLine: it.conn ? "" : line, all, rows,
    esig: JSON.stringify([MX.acct, MX.box, all, rows.map(e => [e.id, e.b.name, e.b.icon, !!e.b.base, e.b.mode, e.n, e.c]), it.accounts.map(a => [a.key, a.label, a.mk])]) };
}

/* ---- the pane and the chips ---- */
const mxMark = a => el("span", { class: `mx-am t-${a.n % 4}`, title: `${a.label} 계정`, text: a.mk });
const mxDot = c => (c.needs ? el("span", { class: "dot warn", title: "답장 필요" }) : c.unread ? el("span", { class: "dot pri", title: "안 읽음" }) : null);
const mxSub = e => (e.n ? `계정 ${e.n}개` : mxModeOf(e.b));
const mxAcctMark = (it, e) => (MX.mark && !e.n ? mxMark(it.accounts.find(a => e.k.startsWith(`${a.key}|`))) : null);
function mxPaneRow(id, name, sub, icn, c, extra) {
  const on = MX.box === id;
  return el("button", { class: `mx-pr${on ? " on" : ""}`, type: "button", "aria-current": on ? "true" : null, onclick: () => mxBox(id) },
    el("span", { class: "av" }, mxIc(icn)), el("span", { class: "tx" }, el("span", { class: "hd" }, name, ...extra), el("span", { class: "sup", text: sub })),
    el("span", { class: "mx-pn" }, mxDot(c), el("span", { text: String(c.live) })));
}
const mxPaneNodes = it => [el("div", { class: "list" }, mxPaneRow("all", "전체", `안 읽음 ${it.all.unread}`, "mail", it.all, [])),
  el("div", { class: "list" }, ...it.rows.map(e => mxPaneRow(e.id, e.b.name, mxSub(e), e.b.icon, e.c, [e.b.base ? el("span", { class: "tag mx-base", text: "기본" }) : null, mxAcctMark(it, e)]))),
  el("button", { class: "btn text sm mx-add", type: "button", onclick: mxNew }, icon("add"), "메일함 추가")];
function mxPane(it) {
  const pane = $("#mx-pane");
  if (!pane || it.esig === MX.pane) return;
  MX.pane = it.esig;
  const top = pane.scrollTop;
  clear(pane).append(...mxPaneNodes(it));
  pane.scrollTop = top;
}
// The chip row of a phone: the first node of the timeline, kept (its sideways scroll too) until what it shows changes.
function mxTabs(it) {
  const s = MX.slot.get("tabs");
  if (s && s.sig === it.esig) return s.node;
  const tab = (id, name, c, extra) => el("button", { class: `mx-tab${MX.box === id ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(MX.box === id), onclick: () => mxBox(id) }, name, extra, mxDot(c), el("span", { text: String(c.live) }));
  const node = segKeep(el("div", { class: "mx-tabs", role: "tablist", "aria-label": "메일함" }, tab("all", "전체", it.all, null), ...it.rows.map(e => tab(e.id, e.b.name, e.c, mxAcctMark(it, e))),
    el("button", { class: "mx-tab", type: "button", "aria-label": "메일함 추가", onclick: mxNew }, icon("add"))));
  MX.slot.set("tabs", { sig: it.esig, node });
  return node;
}
const mxTitle = it => {
  const multi = it.accounts.length > 1, a = it.accounts.find(x => x.key === MX.acct);
  const set = id => el("button", { class: "btn tonal sm mx-setb", type: "button", onclick: () => mxSet(id) }, icon("sliders"), el("span", { text: "메일함 설정" }));
  if (MX.box === "all") return el("div", { class: "mx-bh" }, el("h2", { text: "전체" }), el("span", { class: "meta", text: !multi ? "메일함을 나눠도 모든 메일이 여기 보여요" : a ? a.account || a.label : "모든 계정의 메일을 모아서 보여요" }));
  const e = it.rows.find(x => x.id === MX.box);
  if (mxGroup(MX.box)) return el("div", { class: "mx-bh" }, el("h2", { text: e.b.name }), el("span", { class: "meta", text: `계정 ${e.n}개를 합쳐서 보여요` }), set(e.b.id));
  return el("div", { class: "mx-bh" }, el("h2", { text: e.b.name }), mxAcctMark(it, e), el("span", { class: "tag", text: mxModeOf(e.b) }), set(e.b.id));
};
const mxNote = it => { const e = it.rows.find(x => x.id === MX.box); return e && e.b.base ? el("div", { class: "mx-note" }, el("div", { text: e.n ? "계정마다 어느 메일함에도 맞지 않는 메일이 여기로 와요." : "어느 메일함에도 맞지 않는 메일은 여기로 와요." })) : null; };
// An account whose login is gone says so above the list, with the app's own way to connect again (monRecheckApp). With one account the head's banner does it.
const mxDown = it => it.accounts.length < 2 ? [] : it.accounts.filter(a => a.conn && (MX.acct === "all" || MX.acct === a.key)).map(a => {
  const names = a.owned.map(m => m.watch).filter(Boolean);
  return el("div", { class: "mx-exp down", "data-acct": a.key }, el("span", { class: "dot warn" }), el("span", { class: "tx" }, el("b", { text: `${a.label} 계정 로그인이 풀렸어요` }), el("span", { text: "받은 메일은 그대로 있어요. 다시 연결하면 새 메일도 들어와요." })),
    names.length ? el("button", { class: "btn tonal sm", type: "button", text: "다시 연결", onclick: ev => monRecheckApp(ev.currentTarget, { key: `i:${a.key}` }, names) }) : null);
});
const mxTop = it => (it.accounts ? [mxTabs(it), mxTitle(it), ...mxDown(it), mxNote(it)].filter(Boolean) : []);

/* ---- the account chip of the app bar ---- */
const mxTone = a => (a.conn || a.needs.drafts || a.needs.unreplied ? "warn" : a.needs.unread ? "pri" : undefined);
function mxChip(it) {
  const old = $("#appbar .mx-acc"), multi = !!it && it.accounts.length > 1, sig = multi ? JSON.stringify([MX.acct, it.accounts.map(a => [a.key, a.label, a.mk, mxTone(a), a.conn])]) : "";
  if (sig === MX.chip && (old || !multi)) return;
  MX.chip = sig;
  if (old) old.remove();
  if (!multi) return;
  const a = it.accounts.find(x => x.key === MX.acct), hid = it.accounts.filter(x => x.conn || (a && x !== a)), tone = hid.some(x => x.conn) ? "warn" : hid.map(mxTone).includes("warn") ? "warn" : hid.map(mxTone).includes("pri") ? "pri" : "";
  $("#appbar").insertBefore(el("button", { class: "mx-acc", type: "button", "aria-haspopup": "menu", "aria-label": "메일 계정 바꾸기", onclick: ev => mxAcctPop(ev.currentTarget) },
    a ? mxMark(a) : null, el("span", { class: "mx-ac-t", text: a ? a.label : "모든 계정" }), tone ? el("span", { class: `dot ${tone}` }) : null, icon("drop")), $("#cmdk"));
}
function mxAcctPop(btn) {
  const it = MX.it;
  if (!it) return;
  const n = f => it.accounts.reduce((c, a) => c + a.needs[f], 0);
  showMenu(btn, [{ value: "all", label: "모든 계정", sub: `안 읽음 ${n("unread")} · 답장 필요 ${n("drafts") + n("unreplied")}` },
    ...it.accounts.map(a => ({ value: a.key, label: el("span", { class: "mx-al" }, mxMark(a), a.label), sub: a.conn ? "로그인이 풀렸어요" : a.account, tone: mxTone(a) })), { value: "+", label: "계정 추가" }],
  { value: MX.acct, sheet: matchMedia("(max-width: 639px)").matches, onPick: v => (v === "+" ? asAddSheet() : mxPick(v)) });
}
// The panel of the mail app beside an open mail on a wide window: the chat view that draws the mail takes the panel as its side column (the app frame, 20-monitoring.css .app-two).
function mxTwo() {
  if (!monCtx || !isMailT(target) || narrowChat() || $("#v-chat").classList.contains("in-pane")) return null;
  const sel = monItems().find(i => i.key === MON.sel);
  return sel && sel.accounts ? mxScope(sel) : null;
}
function mxPaint(sel) {
  const on = !!(sel && sel.accounts) && !MON.list;
  $("#v-monitoring").classList.toggle("mx-on", on);
  $("#v-monitoring").classList.toggle("app-two", on && !MX.scr);
  $("#v-monitoring").classList.toggle("mx-scr", on && !!MX.scr);
  MX.it = on ? sel : null;
  if (on) mxPane(sel); else mxTeachClose();
  mxChip(on ? sel : null);
}

/* ---- a row ---- */
// After the sender: the account's mark and the box's name, where the list mixes boxes (전체) or accounts; before ⋯: the folder button.
const mxSender = t => {
  const b = MX.show && MX.of.has(t) ? mxBoxOf(t) : null;
  return b ? [MX.mark ? mxMark(MX.accts.get(MX.of.get(t))) : null, MX.show === 2 ? el("span", { class: "mx-bt", text: b.name }) : null].filter(Boolean) : [];
};
const mxMoveBtn = t => (MX.of.has(t) && mxCanMove(t) ? el("button", { class: "ib mr-mv", type: "button", "data-k": "mail-move", title: "메일함 옮기기", "aria-label": "메일함 옮기기",
  onclick: ev => { ev.stopPropagation(); mxMoveOpen(ev.currentTarget, [t]); }, onkeydown: ev => ev.stopPropagation() }, icon("folder")) : null);
// What mbRow's signature adds: what the row draws of its box and account.
const mxSig = t => { const b = MX.of.has(t) ? mxBoxOf(t) : null; return b ? [MX.show, MX.mark, b.name, MX.accts.get(MX.of.get(t)).mk, mxCanMove(t)] : 0; };

/* ---- moving ---- */
const mxAddr = keys => {
  const f = keys.map(t => mailAddrList((MAILS.get(t) || {}).from)[0] || {});
  return f[0] && f[0].addr && f.every(x => x.addr === f[0].addr) ? { addr: f[0].addr, who: f[0].name || f[0].addr } : null;
};
// The longest word of the subject that has two letters and is not a stopword (a verb ending such as ~합니다, ~해요 is no keyword either).
const mxKw = s => (String(s || "").match(/[\p{L}\p{N}]+/gu) || []).filter(w => (w.match(/\p{L}/gu) || []).length >= 2 && !MX_STOP.has(w.toLowerCase()) && !/(니다|세요|어요|아요|해요)$/.test(w)).reduce((b, w) => (w.length > b.length ? w : b), "");
function mxMoveOpen(anchor, keys) {
  keys = keys.filter(t => MAILS.has(t) && MX.of.has(t));
  if (!keys.length) return;
  const accts = [...new Set(keys.map(t => MX.of.get(t)))], sheet = matchMedia("(max-width: 639px)").matches;
  if (accts.length > 1) { showMenu(anchor, [{ header: "여러 계정의 메일이 섞여 있어요" }, { header: "계정마다 따로 골라서 옮겨 주세요" }], { onPick: () => {}, sheet }); return; }
  const a = MX.accts.get(accts[0]), froms = new Set(keys.map(t => mxBoxOf(t).id));
  showMenu(anchor, [{ header: "어느 메일함으로 옮길까요?" }, ...(MX.accts.size > 1 ? [{ header: `${a.label} 계정 안에서만 옮길 수 있어요` }] : []),
    ...a.boxes.filter(b => froms.size > 1 || !froms.has(b.id)).map(b => ({ value: b.id, label: b.name, sub: mxModeOf(b) }))], { onPick: id => mxPut(keys, id), sheet });
}
// Rows the move takes out of the list leave first; the rest of the list is drawn again without them.
function mxRowsOut(keys) {
  const rows = [...document.querySelectorAll("#mon-tl > .mr[data-t]")].filter(r => keys.includes(r.dataset.t) && !mxIn(r.dataset.t));
  for (const r of rows) MBOX.rows.delete(r.dataset.t);
  return rows.length ? Promise.all(rows.map(r => motionOut(r))) : null;
}
// POST /api/mailbox/move: the card changes at once (box, why) and goes back when the hub refuses. Resolves the hub's answer ({moved, was}), null on failure.
async function mxMove(keys, to) {
  const was = new Map();
  for (const t of keys) { const m = MAILS.get(t); if (m) { was.set(t, [m.box, m.boxWhy]); m.box = to; m.boxWhy = { kind: "moved" }; } }
  const out = mxRowsOut(keys);
  if (out) out.then(mbRefresh); else mbRefresh();
  try {
    const r = await api("/api/mailbox/move", "POST", { keys: keys.map(mbKey), box: to });
    for (const k of r.moved || []) { const m = MAILS.get(`mail:${k}`); if (m) { m.box = to; m.boxWhy = { kind: "moved" }; } }   // the rest of the conversation went with it
    Promise.allSettled([convLoad(), loadIntegrations()]);
    return r;
  } catch (e) {
    for (const [t, [b, w]] of was) { const m = MAILS.get(t); if (m) { m.box = b; m.boxWhy = w; } }
    mbRefresh();
    toast((e && e.data && e.data.error) || (e && e.message) || "옮기지 못했어요", true);
    return null;
  }
}
async function mxPut(keys, id) {
  const a = MX.accts.get(MX.of.get(keys[0])), from = keys.every(t => mxBoxOf(t).id === mxBoxOf(keys[0]).id) ? mxBoxOf(keys[0]) : null, who = mxAddr(keys), kw = keys.length === 1 ? mxKw(MAILS.get(keys[0]).subject) : "";
  const r = await mxMove(keys, id);
  if (!r) return;
  MBOX.sel.clear(); mbPaintBar();
  MX.teach = { keys, to: a.byId.get(id), from, who, kw, was: r.was || {}, done: "" };
  mxTeachShow();
}
// 되돌리기: every moved conversation goes back to the mailbox it came from (the hub's `was`), and nothing is taught.
async function mxUndo() {
  const t = MX.teach, by = new Map();
  mxTeachClose();
  for (const [k, b] of Object.entries(t.was)) by.set(b, [...(by.get(b) || []), `mail:${k}`]);
  if (!by.size && t.from) by.set(t.from.id, t.keys);
  for (const [b, ks] of by) await mxMove(ks, b);
}

/* ---- the small box after a move: 앞으로는 어떻게 할까요? ---- */
const mxTeachClose = () => { const el0 = $(".mx-teach"); MX.teach = null; if (el0) el0.remove(); };
// Picking one teaches it (POST /api/mailbox/learn); 이 메일만, 닫기 and picking nothing teach nothing.
function mxLearn(k, label) {
  const t = MX.teach, body = k === "ex" ? { box: t.from.id, kind: "not", value: t.who.addr } : k === "from" ? { box: t.to.id, kind: "from", value: t.who.addr } : { box: t.to.id, kind: "subj", value: t.kw };
  api("/api/mailbox/learn", "POST", body).then(() => { if (MX.teach === t) { t.done = label; mxTeachShow(); } }, e => toast((e && e.data && e.data.error) || (e && e.message) || "기억해 두지 못했어요", true));
}
function mxTeachShow() {
  const t = MX.teach;
  if (!t) return;
  const one = t.keys.length === 1, base = !!t.to.base, opts = [["only", one ? "이 메일만" : "이 메일들만"]];
  if (base) { if (t.who && t.from && !t.from.base) opts.push(["ex", `${t.who.who} 메일은 ${t.from.name}에 넣지 않기`]); }
  else { if (t.who) opts.push(["from", `${t.who.who} 메일은 앞으로 여기로`]); if (t.kw) opts.push(["subj", `제목에 ‘${t.kw}’ 들어가면 앞으로 여기로`]); }
  const n = Object.keys(t.was).length;
  let box = $(".mx-teach");
  if (!box) { box = el("div", { class: "mx-teach", role: "status" }); document.body.append(box); motionIn(box, "rise", 220); }
  clear(box).append(el("div", { class: "mx-tt" }, el("b", { text: `${t.to.name}에 넣었어요` }), n > t.keys.length ? el("span", { class: "meta", text: `같은 대화 ${n}통이 함께 옮겨졌어요` }) : null,
    el("button", { class: "ib", type: "button", "aria-label": "닫기", onclick: mxTeachClose }, icon("close"))),
  t.done ? el("div", { class: "mx-tq", text: `기억해 뒀어요 · ${t.done}` }) : el("div", { class: "mx-tq", text: "앞으로는 어떻게 할까요?" }),
  ...(t.done ? [] : [el("div", { class: "mx-to", role: "radiogroup" }, ...opts.map(([k, label]) => el("button", { type: "button", role: "radio", "aria-checked": "false", "data-k": k, onclick: () => (k === "only" ? mxTeachClose() : mxLearn(k, label)) }, el("span", { class: "mx-rd" }), label))),
    el("div", { class: "mx-tf" }, el("button", { class: "btn text sm", type: "button", "data-k": "undo", text: "되돌리기", onclick: mxUndo }))]));
}
