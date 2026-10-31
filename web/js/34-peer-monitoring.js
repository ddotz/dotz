/* ---------- 모니터링 across computers: the other gateways' items beside the local ones (docs/peer-monitoring.md) ---------- */
// Data: GET /api/monitoring/peers (hub/peer-monitor.ts) -> [{name, url, online, stale, items: {monitors, notices, integrations, conversations} | null}].
// It loads when 모니터링 opens, on peer_counts / peer_notice frames (debounced) and on the minute timer; a render only reads PQ.list.
// Peer rows carry pc = {name, url}. There is no peer-only renderer: a peer item is the same shape as a local one and goes through the same
// renderers (monConvNode, monNoticeNode, the chat view, the Kakao pane). Only where its data is read from differs: api() and pqLink() send the
// reads of a peer's mail, history and Kakao room through /api/peer/proxy, and the actions (reply, mark read, Kakao send) through /api/peer/act.
// of: conversation target ("mail:<key>") -> {pc, key: the list item it sits under}; seen: the last unread/read pair taken from a snapshot.
// PQ itself is declared in 08-home.js beside MAILS: api() (02) and the first monitoring paint (30) run before this file.

const pqSelf = () => (prSelf() || {}).name || (MN.info || {}).name || "";
// The small muted machine name next to a detail title: the peer's for a peer item, this computer's otherwise.
const pqLabel = it => { const n = it && it.pc ? it.pc.name : pqSelf(); return n ? el("span", { class: "mon-pc", text: n }) : null; };
const pqSig = sel => [pqSelf(), sel.pc ? sel.pc.name : ""];
// Function declarations (hoisted): api() calls pqRoute before this file's top level has run.
// The computer an item of the snapshot `p` came from, as every peer item carries it: its machine name, address and its own bot's name
// (the snapshot's `bot`, hub/peer-monitor.ts; the machine name for an older gateway without it), never this computer's bot.
function pqPcOf(p) { return { name: p.name, url: p.url, bot: (p.items && p.items.bot) || p.name }; }
function pqPc(t) { return (PQ.of.get(String(t)) || {}).pc || null; }
function pqProxy(pc, path) { return `/api/peer/proxy?pc=${enc(pc.url)}&p=${enc(path)}`; }
// An app of another computer is named `<key>~<hash of that computer>` here (its key may also be an app of this one); the computer gets the plain key.
function pqApp(inst, pc) { const h = asId(pc.url); PQ.apps.set(h, pc); return `${inst}~${h}`; }
const pqBare = s => String(s).replace(/~[a-z0-9]+(?![a-z0-9])/g, "");
// The computer a read belongs to: the mail routes and a history of a peer's conversation by their target, a Kakao route while the pane shows a peer's.
function pqFor(path) {
  let m = /^\/api\/mail\/([^/?]+)\/(?:body|files\/)/.exec(path);
  if (m) return pqPc(`mail:${decodeURIComponent(m[1])}`);
  m = /^\/api\/history\?(?:[^#]*&)?target=([^&]+)/.exec(path);
  if (m) return pqPc(decodeURIComponent(m[1]));
  m = /^\/api\/watches\/([a-z0-9-]+)\/settings/.exec(path);
  if (m) return pqPc(`settings:w:${m[1]}`);
  m = /^\/api\/integrations\/[a-z0-9._-]+~([a-z0-9]+)\/(?:settings|remove|features|retry|approve)/.exec(path);
  if (m) return PQ.apps.get(m[1]) || null;
  m = /^\/api\/drafts\/([^/?]+)\//.exec(path);
  if (m) return DRF.pc[decodeURIComponent(m[1])] || null;
  return path.startsWith("/api/kakao/") ? KK.pc : null;
}
function pqLink(path) { const pc = pqFor(path); return pc ? pqProxy(pc, pqBare(path)) : path; }
// The action a POST of the page means on the computer that owns the item (hub/peer-monitor.ts act), or null for a local one.
function pqAct(path, body) {
  const b = body || {}, k = /^\/api\/kakao\/(chat|drafts)\/([^/]+)\/(send|read|draft|drop|restore|ask\/drop)$/.exec(path);
  if (path === "/api/message" && b.mail) { const { mail, lane, project, via, ...rest } = b; return { pc: pqPc(`mail:${mail}`), action: "message", args: { target: `mail:${mail}`, ...rest } }; }
  // A monitor's conversation and switches go to the computer that owns the watch: the same message and the same settings PATCH, forwarded.
  const sp = /^\/api\/watches\/([a-z0-9-]+)\/settings$/.exec(path);
  if (sp && pqPc(`settings:w:${sp[1]}`)) return { pc: pqPc(`settings:w:${sp[1]}`), action: "watch", args: { op: "settings", name: sp[1], values: b.values } };
  // A peer app's switches, name and removal: the app's own routes on the computer that has it.
  const fp = /^\/api\/integrations\/([a-z0-9._-]+~[a-z0-9]+)\/(features|retry)$/.exec(path);
  if (fp && pqFor(path)) return { pc: pqFor(path), action: "app", args: fp[2] === "features" ? { op: "features", app: pqBare(fp[1]), id: b.id, on: b.on } : { op: "retry", app: pqBare(fp[1]), watch: b.watch } };
  const ap = /^\/api\/integrations\/([a-z0-9._-]+~[a-z0-9]+)\/approve$/.exec(path);
  if (ap && pqFor(path)) return { pc: pqFor(path), action: "answer", args: { id: b.id, n: b.n } };
  const ip = /^\/api\/integrations\/([a-z0-9._-]+~[a-z0-9]+)\/(settings|remove)$/.exec(path);
  if (ip && pqFor(path)) return { pc: pqFor(path), action: "app", args: ip[2] === "settings" ? { op: "settings", app: pqBare(ip[1]), values: b.values } : { op: "remove", app: pqBare(ip[1]), deleteData: b.deleteData === true } };
  const rn = /^\/api\/watches\/([a-z0-9-]+)\/run$/.exec(path);
  if (rn && pqPc(`settings:w:${rn[1]}`)) return { pc: pqPc(`settings:w:${rn[1]}`), action: "watch", args: { op: "run", name: rn[1] } };
  if (path === "/api/message" && b.settings && pqPc(`settings:${b.settings}`)) { const { settings, lane, project, mail, via, ...rest } = b; return { pc: pqPc(`settings:${settings}`), action: "message", args: { target: `settings:${pqBare(settings)}`, ...rest } }; }
  const df = /^\/api\/drafts\/([^/?]+)\/files$/.exec(path), dref = df && decodeURIComponent(df[1]);
  if (dref && DRF.pc[dref]) return { pc: DRF.pc[dref], action: "draft-files", args: { ref: dref, ...b } };
  // The 받는이·참조 of a peer's mail draft (hub/draft-recipients.ts) change on the computer that owns it.
  const drec = /^\/api\/drafts\/([^/?]+)\/recipients$/.exec(path), drref = drec && decodeURIComponent(drec[1]);
  if (drref && (DRR.pc[drref] || DRF.pc[drref])) return { pc: DRR.pc[drref] || DRF.pc[drref], action: "draft-recipients", args: { ref: drref, ...b } };
  const md = /^\/api\/mail\/([^/?]+)\/draft$/.exec(path);
  if (md && pqPc(`mail:${decodeURIComponent(md[1])}`)) return { pc: pqPc(`mail:${decodeURIComponent(md[1])}`), action: "mail-draft", args: { key: decodeURIComponent(md[1]), ...(body && body.instruction ? { instruction: body.instruction } : {}) } };
  const nm = /^\/api\/mail\/([^/?]+)\/no-reply$/.exec(path);
  if (nm && pqPc(`mail:${decodeURIComponent(nm[1])}`)) return { pc: pqPc(`mail:${decodeURIComponent(nm[1])}`), action: "no-reply", args: { kind: "mail", key: decodeURIComponent(nm[1]) } };
  if (path === "/api/read") return { pc: pqPc(b.target), action: "read", args: { target: pqBare(b.target), ts: b.ts } };
  // The comments pane of another computer (CM.pc, 30-monitoring-comments.js): its drafts, failed sends, drafted replies and source switches run there,
  // on the routes hub/peer-monitor.ts act "comments" forwards (once per click).
  if (CM.pc) {
    const e = v => decodeURIComponent(v), c = CM.pc, d = /^\/api\/comments\/drafts\/([^/]+)\/(send|drop|restore|revise)$/.exec(path);
    if (d) return { pc: c, action: "comments", args: { op: `draft-${d[2]}`, code: e(d[1]), ...(d[2] === "revise" ? { change: b.change, ...(b.part ? { part: b.part } : {}) } : {}) } };
    const s = /^\/api\/comments\/sends\/([^/]+)\/(retry|dismiss)$/.exec(path);
    if (s) return { pc: c, action: "comments", args: { op: `send-${s[2]}`, id: e(s[1]) } };
    const m = /^\/api\/comments\/comment\/([^/]+)\/(draft|no-reply)$/.exec(path);
    if (m) return { pc: c, action: "comments", args: m[2] === "draft" ? { op: "draft", commentId: e(m[1]) } : { op: "no-reply", commentId: e(m[1]), on: true } };
    const t = /^\/api\/comments\/thread\/([^/]+)\/([^/]+)\/read$/.exec(path);
    if (t) return { pc: c, action: "comments", args: { op: "read", source: e(t[1]), thread: e(t[2]) } };
    const k = /^\/api\/comments\/sources\/([^/]+)$/.exec(path);
    if (k) return { pc: c, action: "comments", args: { op: "source", key: e(k[1]), ...(typeof b.watch !== "undefined" ? { watch: b.watch } : {}), ...(typeof b.autoDraft !== "undefined" ? { autoDraft: b.autoDraft } : {}) } };
  }
  if (!path.startsWith("/api/kakao/") || !KK.pc) return null;
  const nk = /^\/api\/kakao\/chat\/([^/]+)\/no-reply$/.exec(path);
  if (nk) return { pc: KK.pc, action: "no-reply", args: { kind: "kakao", chatId: decodeURIComponent(nk[1]) } };
  const id = k && decodeURIComponent(k[2]);
  if (k && k[1] === "chat" && k[3] === "send") return { pc: KK.pc, action: "kakao", args: { op: "send", chatId: id, text: b.text } };
  if (k && k[1] === "chat" && k[3] === "read") return { pc: KK.pc, action: "kakao", args: { op: "read", chatId: id, logId: b.logId } };
  if (k && k[1] === "chat" && k[3] === "draft") return { pc: KK.pc, action: "kakao", args: { op: "draft", chatId: id, ...(typeof b.choice === "string" ? { choice: b.choice } : {}), ...(b.revise ? { revise: b.revise } : {}) } };
  if (k && k[1] === "chat" && k[3] === "ask/drop") return { pc: KK.pc, action: "kakao", args: { op: "ask-drop", chatId: id } };
  // 지켜보기 / 자동 초안 of a room (PUT /api/kakao/rooms/<id>): the same change on the computer that has the room.
  const rm = /^\/api\/kakao\/rooms\/([^/?]+)$/.exec(path);
  if (rm) return { pc: KK.pc, action: "kakao", args: { op: "room", chatId: decodeURIComponent(rm[1]), ...(typeof b.watched === "boolean" ? { watched: b.watched } : {}), ...(typeof b.autoDraft === "boolean" ? { autoDraft: b.autoDraft } : {}) } };
  if (k && k[1] === "drafts") return { pc: KK.pc, action: "kakao", args: { op: `draft-${k[3]}`, code: id, ...(b.text === undefined ? {} : { text: b.text }) } };
  throw new Error(`${KK.pc.name}에서 바꿔 주세요`);
}
// The files of a message to another computer's conversation: the bytes kept in the composer go to THAT computer (act "upload", one file per
// request), and its own upload paths are what the message carries; a path of this computer never goes there. Any failure throws, so the
// message is not sent without its file.
const PQ_WIRE_MAX = 50 * 1024 * 1024;
async function pqUpload(pc, atts) {
  const out = [];
  for (const a of atts) {
    if (!a.raw) throw new Error(`${a.name}: 파일을 다시 붙여 주세요`);
    if (a.raw.size > PQ_WIRE_MAX) throw new Error(`${a.name}: 다른 컴퓨터의 대화에는 50MB 이하 파일만 보낼 수 있어요`);
    let r;
    try { r = await api(pqProxy(pc, "/api/peer/act"), "POST", { action: "upload", args: { files: [{ name: a.name, type: a.type || "", data: await drfBase64(a.raw) }] } }); }
    catch (e) { throw new Error(`${pc.name}에 ${a.name}을(를) 올리지 못해서 보내지 않았어요 (${e.message})`); }
    if (!r || !Array.isArray(r.files) || !r.files[0]) throw new Error(`${pc.name}에 ${a.name}을(를) 올리지 못해서 보내지 않았어요`);
    out.push(r.files[0]);
  }
  return out;
}
// api() in 02-basic-markdown.js runs every request through here: [path, method, body] as they go to this gateway.
function pqRoute(path, method, body) {
  if (method === "GET") return [pqLink(path), method, body];
  // 감시 삭제 of a peer's monitor runs on the computer that owns the watch.
  const wd = method === "DELETE" ? /^\/api\/watches\/([a-z0-9-]+)$/.exec(path) : null;
  if (wd && pqPc(`settings:w:${wd[1]}`)) return [pqProxy(pqPc(`settings:w:${wd[1]}`), "/api/peer/act"), "POST", { action: "watch", args: { op: "delete", name: wd[1] } }];
  const del = method === "DELETE" && KK.pc ? /^\/api\/kakao\/chat\/([^/]+)\/send\/([^/?]+)$/.exec(path) : null;   // a failed send of a peer's room is deleted on its owner
  if (del) return [pqProxy(KK.pc, "/api/peer/act"), "POST", { action: "kakao", args: { op: "send-delete", chatId: decodeURIComponent(del[1]), sendId: decodeURIComponent(del[2]) } }];
  // 답장 안 함 (POST) / 답장 필요로 표시 (DELETE) and 삭제 (DELETE /api/mail/<key>) of a peer's mail run on the computer that holds it.
  const mf = /^\/api\/mail\/([^/?]+)(\/fyi)?$/.exec(path), mk = mf && decodeURIComponent(mf[1]), mpc = mk && pqPc(`mail:${mk}`);
  if (mpc && mf[2] && (method === "POST" || method === "DELETE")) return [pqProxy(mpc, "/api/peer/act"), "POST", { action: "fyi", args: { key: mk, on: method === "POST" } }];
  if (mpc && !mf[2] && method === "DELETE") return [pqProxy(mpc, "/api/peer/act"), "POST", { action: "mail-delete", args: { key: mk } }];
  const a = pqAct(path, body);
  return a && a.pc ? [pqProxy(a.pc, "/api/peer/act"), "POST", { action: a.action, args: a.args }] : [path, method, body];
}

// A peer's notice (a question, a send approval, a report) is answered, ignored and read on the computer that holds it, once, through /api/peer/act.
// That computer's answer replaces the copy in the snapshot, so the card turns at once; the next snapshot read confirms it.
function pqNoticeOf(n) {
  const p = n && n.pc && PQ.list.find(x => x && x.url === n.pc.url);
  return p && p.items ? (p.items.notices || []).find(x => String(x.id) === String(n.id)) || null : null;
}
const pqNoticeNow = n => { const raw = pqNoticeOf(n); return raw ? { ...raw, pc: n.pc } : n; };
async function pqNotice(n, action, args) {
  if (n.decision && n.decision.to) prActed(n.decision.to);
  const r = await api(pqProxy(n.pc, "/api/peer/act"), "POST", { action, args });
  const raw = pqNoticeOf(n);
  if (r && r.item) { if (raw) Object.assign(raw, r.item); Object.assign(n, r.item, { pc: n.pc }); }
  MON.sig = ""; monSchedule(); syncInlineChoices(); ntSheetPaint(); pqSoon();
  return r;
}
// Peer reports read here (seen on screen, 읽음 처리): marked read on each computer that holds them, one request per computer.
async function pqNoticesRead(list) {
  const by = new Map();
  for (const n of list) if (n.pc) by.set(n.pc.url, [...(by.get(n.pc.url) || []), n]);
  for (const ns of by.values()) {
    for (const n of ns) { n.read = true; const raw = pqNoticeOf(n); if (raw) raw.read = true; }
    await api(pqProxy(ns[0].pc, "/api/peer/act"), "POST", { action: "notice", args: { op: "read", ids: ns.map(n => String(n.id)) } });
  }
  if (by.size) { MON.sig = ""; monSchedule(); pqSoon(); }
}

async function pqLoad() {
  clearTimeout(PQ.t);
  if (PQ.busy) { PQ.again = true; return; }
  PQ.busy = true; PQ.at = Date.now();
  try {
    const r = await api("/api/monitoring/peers");
    PQ.list = Array.isArray(r) ? r : [];
    PQ.loaded = true;
  } catch {}
  PQ.busy = false;
  if (PQ.again) { PQ.again = false; pqSoon(); }
  if (!pqSelf()) await mnLoad();
  paintPause();
  monSchedule();
}
const pqSoon = () => { clearTimeout(PQ.t); PQ.t = setTimeout(pqLoad, 1000); };
const pqOpen = () => { if (Date.now() - PQ.at > 5000) pqLoad(); };
setInterval(() => { if ((current === "monitoring" || monCtx) && !document.hidden) pqLoad(); }, 60_000);

// What a peer writes into its conversations (the answer to a message sent to its monitor, a mail's gateway notice such as "the bot is paused", the held
// state) is written on that computer and never reaches this stream: the open conversation re-reads its history through the proxy, and the peer's
// bot status (the composer's pause line) comes with the monitoring snapshot.
setInterval(() => {
  if (document.hidden || !pqPc(target) || !(isSettingsT(target) || isMailT(target))) return;
  loadTarget(target, true);
  if (Date.now() - PQ.at > 15000) pqLoad();
}, 4000);

// The run state of a peer's mail conversation (the worker its request was deferred to on that computer): the snapshot's `runs`
// (hub/peer-monitor.ts). null for a local conversation, so 41-runstate.js reads /api/state instead.
function pqRuns(t) {
  const pc = pqPc(t);
  if (!pc) return null;
  const p = PQ.list.find(x => x && x.url === pc.url);
  return (p && p.items && p.items.runs && p.items.runs[t]) || null;
}

// A peer's mail as the local stores hold a mail (MAILS, CONV, the unread count), so monConvNode and the chat view draw it. A mail this computer has itself stays local.
function pqMail(c, pc, itemKey) {
  const t = String(c.target);
  if (!PQ.of.has(t) && CONV.has(t) && !intgHidden(t)) return null;
  PQ.of.set(t, { pc, key: itemKey });
  if (c.mail) MAILS.set(t, c.mail);
  if (c.last) CONV.set(t, c.last);
  const sig = `${c.unread | 0}|${c.read || ""}`;
  if (PQ.seen.get(t) !== sig) { PQ.seen.set(t, sig); ts(t).unread = c.unread | 0; READ[t] = c.read || null; }
  return t;
}

// Peer rows into monItems(): apps after the local apps, monitors after the local monitors, watch reports into 감시 소식.
function pqMerge(items) {
  const peers = PQ.list.filter(p => p && p.url);
  if (!peers.length) return items;
  const apps = [], plain = [], off = [], news = [];
  for (const p of peers) {
    const pc = pqPcOf(p), s = p.items, key = k => `p:${p.url}|${k}`;
    if (!s) { off.push({ key: key("off"), group: MON_GROUP.plain, name: `${p.name} · 연결 안 됨`, ic: "activity", notices: [], mails: [], unread: 0, hint: "", at: "", pc, off: true }); continue; }
    const chips = [[p.name, ""], ...(p.online ? [] : [["연결 안 됨", "warn"]])], sn = (s.notices || []).map(n => ({ ...n, pc })), shown = new Set();
    const owned = monOwnedBy(s.integrations || [], s.monitors || []), ownedNames = new Set([...owned.values()].flat());
    for (const it of s.integrations || []) {
      if (it.iconPath && !ICONS[it.icon]) ICONS[it.icon] = it.iconPath;
      const notices = (it.notices || []).map(id => sn.find(n => String(n.id) === String(id))).filter(n => n && monMine(n, it));
      const mails = (s.conversations || []).filter(c => isMailT(String(c.target)) && c.mail && intgHas(it, c.target)).map(c => pqMail(c, pc, key(`i:${it.key}`))).filter(Boolean);
      for (const n of notices) shown.add(n.id);
      const needs = it.needs || { drafts: 0, unread: it.unread | 0, sentToday: 0 }, conn = it.state === "disconnected";
      const at = [...notices.map(monNoticeAt), ...mails.map(t => (CONV.get(t) || {}).ts || "")].sort().pop() || "";
      PQ.of.set(`settings:${pqApp(it.key, pc)}`, { pc, key: key(`i:${it.key}`), app: true, label: it.label });   // the app's settings conversation lives on that computer
      apps.push({ key: key(`i:${it.key}`), group: MON_GROUP.app, name: it.label, ic: it.icon, notices, mails, kk: it.key === "kakao", app: true, inst: it.key, drafts: needs.drafts | 0, unread: needs.drafts || needs.unread, unreplied: needs.unreplied | 0, conn, hint: conn && it.hint ? it.hint : monNeedLine(needs, conn), at, pc, chips, owned: owned.get(it.key) || [], badge: monFail(owned.get(it.key) || []) });
    }
    const mons = (s.monitors || []).slice().sort((a, b) => (b.last_result === "fail") - (a.last_result === "fail") || (Date.parse(a.next_run) || Infinity) - (Date.parse(b.next_run) || Infinity));
    for (const m of mons) {
      const notices = sn.filter(n => monHas(m, n)), last = monNewest(notices);
      for (const n of notices) shown.add(n.id);
      if (ownedNames.has(m)) continue;
      // A peer's watch has the same settings conversation as a local one; it lives on that computer (a watch name this computer has itself stays local).
      if (m.kind === "watch" && m.watch && !NM.items.some(x => x.watch === m.watch)) PQ.of.set(`settings:w:${m.watch}`, { pc, key: key(`m:${m.name}`), mon: m });
      const fresh = last && (!m.last_run || ntAt(last) >= Date.parse(m.last_run) - 60_000);
      plain.push({ key: key(`m:${m.name}`), group: MON_GROUP.plain, name: monTitle(m), raw: monRaw(m), ic: "activity", notices, mails: [], mon: m, unread: 0,
        hint: fresh ? monStrip(monLine(last), monNames(m)) : monRunLine(m), at: m.last_run || (last ? monNoticeAt(last) : ""),
        badge: m.connection === "disconnected" ? ["연결 끊김", "err"] : m.paused ? ["꺼짐", ""] : m.last_result === "fail" ? ["실패", "err"] : m.kind === "schedule" ? [MON_KIND.schedule, ""] : null, pc, chips });
    }
    news.push(...sn.filter(n => n.kind === "watch" && !n.app && !shown.has(n.id)));
  }
  const feed = items.find(i => i.key === "notice");
  if (feed && news.length) {
    feed.notices = [...feed.notices, ...news];
    Object.assign(feed, monFeedHead(feed.notices));
  }
  const grp = g => items.filter(i => i.group === g);
  return [...grp(""), ...grp(MON_GROUP.app), ...apps, ...grp(MON_GROUP.plain), ...plain, ...off];
}
