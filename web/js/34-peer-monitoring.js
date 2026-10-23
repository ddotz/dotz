/* ---------- 모니터링 across computers: the other gateways' items beside the local ones (docs/peer-monitoring.md) ---------- */
// Data: GET /api/monitoring/peers (hub/peer-monitor.ts) -> [{name, url, online, stale, items: {monitors, notices, integrations, conversations} | null}].
// It loads when 모니터링 opens, on peer_counts / peer_notice frames (debounced) and on the minute timer; a render only reads PQ.list.
// Peer rows carry pc = {name, url}; nothing of a peer item runs here: its conversation is read and answered through /api/peer/proxy.
const PQ = { list: [], loaded: false, busy: false, again: false, at: 0, t: 0, conv: null };

const pqSelf = () => (prSelf() || {}).name || (MN.info || {}).name || "";
// The small muted machine name next to a detail title: the peer's for a peer item, this computer's otherwise.
const pqLabel = it => { const n = it && it.pc ? it.pc.name : pqSelf(); return n ? el("span", { class: "mon-pc", text: n }) : null; };
const pqSig = sel => [pqSelf(), sel.pc ? sel.pc.name : "", sel.convs || 0, PQ.conv && PQ.conv.key === sel.key ? [PQ.conv.t, PQ.conv.state, PQ.conv.events] : 0];
// A KakaoTalk room target (kakao:<chatId>) reads and sends through the owner's /api/kakao routes (hub/peer-monitor.ts act "kakao").
const pqKakao = t => String(t).startsWith("kakao:") ? String(t).slice(6) : "";
const pqUrl = (pc, path) => `/api/peer/proxy?pc=${enc(pc.url)}&p=${enc(path)}`;

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
  monSchedule();
}
const pqSoon = () => { clearTimeout(PQ.t); PQ.t = setTimeout(pqLoad, 1000); };
const pqOpen = () => { if (Date.now() - PQ.at > 5000) pqLoad(); };
setInterval(() => { if ((current === "monitoring" || monCtx) && !document.hidden) pqLoad(); }, 60_000);

// Peer rows into monItems(): apps after the local apps, monitors after the local monitors, watch reports into 감시 소식.
function pqMerge(items) {
  const peers = PQ.list.filter(p => p && p.url);
  if (!peers.length) return items;
  const apps = [], plain = [], off = [], news = [];
  for (const p of peers) {
    const pc = { name: p.name, url: p.url }, s = p.items, key = k => `p:${p.url}|${k}`;
    if (!s) { off.push({ key: key("off"), group: MON_GROUP.plain, name: `${p.name} · 연결 안 됨`, ic: "activity", notices: [], mails: [], convs: [], unread: 0, hint: "", at: "", pc, off: true }); continue; }
    const chips = [[p.name, ""], ...(p.online ? [] : [["연결 안 됨", "warn"]])], sn = (s.notices || []).map(n => ({ ...n, pc })), shown = new Set();
    for (const it of s.integrations || []) {
      if (it.iconPath && !ICONS[it.icon]) ICONS[it.icon] = it.iconPath;
      const notices = (it.notices || []).map(id => sn.find(n => String(n.id) === String(id))).filter(n => n && monMine(n, it));
      const convs = (s.conversations || []).filter(c => (it.conv || []).some(x => String(c.target).startsWith(x)));
      for (const n of notices) shown.add(n.id);
      const needs = it.needs || { drafts: 0, unread: it.unread | 0, sentToday: 0 };
      const at = [...notices.map(monNoticeAt), ...convs.map(c => (c.last || {}).ts || "")].sort().pop() || "";
      apps.push({ key: key(`i:${it.key}`), group: MON_GROUP.app, name: it.label, ic: it.icon, notices, mails: [], convs, app: true, unread: needs.drafts || needs.unread, hint: monNeedLine(needs), at, pc, chips });
    }
    const mons = (s.monitors || []).slice().sort((a, b) => (b.last_result === "fail") - (a.last_result === "fail") || (Date.parse(a.next_run) || Infinity) - (Date.parse(b.next_run) || Infinity));
    for (const m of mons) {
      const notices = sn.filter(n => monHas(m, n)), last = monNewest(notices);
      for (const n of notices) shown.add(n.id);
      const fresh = last && (!m.last_run || ntAt(last) >= Date.parse(m.last_run) - 60_000);
      plain.push({ key: key(`m:${m.name}`), group: MON_GROUP.plain, name: monTitle(m), raw: monRaw(m), ic: "activity", notices, mails: [], convs: [], mon: m, unread: 0,
        hint: fresh ? monStrip(monLine(last), monNames(m)) : monRunLine(m), at: m.last_run || (last ? monNoticeAt(last) : ""),
        badge: m.last_result === "fail" ? ["실패", "err"] : m.kind === "schedule" ? [MON_KIND.schedule, ""] : null, pc, chips });
    }
    news.push(...sn.filter(n => n.kind === "watch" && !n.app && !shown.has(n.id)));
  }
  const feed = items.find(i => i.key === "notice");
  if (feed && news.length) {
    feed.notices = [...feed.notices, ...news];
    const l = monNewest(feed.notices);
    if (l.pc) { feed.hint = `${l.pc.name} · ${monLine(l)}`; feed.at = monNoticeAt(l); }
  }
  const grp = g => items.filter(i => i.group === g);
  return [...grp(""), ...grp(MON_GROUP.app), ...apps, ...grp(MON_GROUP.plain), ...plain, ...off];
}

/* ---- the detail of a peer item (from the cached snapshot) ---- */
// A peer's report is a plain card with the machine chip; a question of its own is answered on that computer, never here.
function pqNoticeNode(n) {
  const node = monCard(ntPlain(n.title) || "알림", n.updated || n.ts, monStrip(String(n.text || ""), [ntPlain(n.title)]), n.tone);
  if (!node) return null;
  node.querySelector(".rc-src").after(el("span", { class: "tag", text: n.pc.name }));
  return node;
}
function pqConvNode(it, c) {
  const m = c.mail || {}, last = c.last || {}, n = c.unread | 0;
  return resultCard({ src: mailSender(m.from) || it.name, at: last.ts || m.at, title: m.subject || last.text || "", text: "", tag: n ? el("span", { class: "tag warn", text: `안 읽음 ${n}` }) : null,
    actions: [el("button", { class: "btn tonal", type: "button", onclick: () => pqConvOpen(it, c), text: "대화 읽기" })] });
}

/* ---- a peer conversation: history read through the proxy, a small reply box ---- */
async function pqConvLoad(c) {
  try {
    const kk = pqKakao(c.t);
    const r = await api(pqUrl(c.pc, kk ? `/api/kakao/chat/${enc(kk)}?limit=50` : `/api/history?target=${enc(c.t)}&limit=50`));
    c.events = kk ? (r.messages || []).filter(m => m && m.text).map(m => ({ ts: new Date(m.sentAt).toISOString(), text: String(m.text), in: !m.fromMe }))
      : (r.events || []).filter(e => e && e.text).map(e => ({ ts: e.ts, text: String(e.text), in: !!convIncoming(e) }));
    c.state = "ok";
  } catch { c.state = "err"; }
  if (PQ.conv === c) monSchedule();
}
function pqConvOpen(it, conv) {
  const c = PQ.conv = { key: it.key, t: conv.target, pc: it.pc, events: null, state: "loading", draft: "" };
  monSchedule();
  pqConvLoad(c);
}
async function pqSend(c, ta, btn) {
  const text = ta.value.trim();
  if (!text) return;
  btn.disabled = true;
  try {
    const r = await fetch(pqUrl(c.pc, "/api/peer/act"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pqKakao(c.t) ? { action: "kakao", args: { op: "send", chatId: pqKakao(c.t), text } } : { action: "message", args: { target: c.t, text } }) });
    if (r.status === 503) toast("이 컴퓨터에서는 읽기만 돼요", true);
    else if (r.status === 502) toast("연결 안 됨", true);
    else if (!r.ok) toast(((await r.json().catch(() => null)) || {}).error || `HTTP ${r.status}`, true);
    else { c.draft = ta.value = ""; toast("보냈어요"); pqConvLoad(c); }
  } catch { toast("연결 안 됨", true); }
  btn.disabled = false;
}
function pqConvView(c) {
  const back = el("button", { class: "btn tonal pm-back", type: "button", onclick: () => { PQ.conv = null; monSchedule(); }, text: "목록으로" });
  const ta = el("textarea", { class: "fi pm-ta", rows: 2, placeholder: "답장 쓰기", "aria-label": "답장", oninput: () => { c.draft = ta.value; } });
  ta.value = c.draft;
  const send = el("button", { class: "btn pri", type: "button", onclick: () => pqSend(c, ta, send), text: "보내기" });
  const body = c.state === "loading" ? [el("div", { class: "empty", text: "불러오는 중…" })] : c.state === "err" ? [el("div", { class: "empty", text: "연결 안 됨" })]
    : c.events.length ? c.events.map(e => el("div", { class: `bm pm-msg${e.in ? "" : " me"}` }, el("div", { class: "mt", text: rcWhen(e.ts) }), mdNode(e.text))) : [el("div", { class: "empty", text: "대화가 아직 없어요" })];
  return [back, ...body, el("div", { class: "pm-reply" }, ta, send)];
}
// The peer part of monTimeline: its open conversation, or the note of a computer that has nothing cached; null = the usual timeline.
function pqTimeline(it) {
  if (PQ.conv && PQ.conv.key === it.key) return pqConvView(PQ.conv);
  return it.off ? [el("div", { class: "empty", text: "연결 안 됨" })] : null;
}
