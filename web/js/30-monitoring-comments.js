/* ---------- 모니터링 > 앱 > 유튜브 / 인스타그램 / 웹사이트 댓글: choose what to follow, one conversation per post ---------- */
// API: docs/comments-api.md. Shown instead of the notice timeline of an app entry only while the owner has comment replies on for that
// app (CM.apps). It reuses the KakaoTalk pane's layout and classes (30-kakao.js, 17-kakao.css). Live updates: comment / comment_draft /
// comment_send / comment_sources events (99-boot.js -> cmLive). Nothing is posted without a click on a draft's 보내기; text only
// goes through el({text}), never innerHTML.
const CM = { apps: new Set(), sources: [], vis: false, app: "", threads: [], loaded: false, error: "", open: null, view: null, loading: false, viewErr: "", seq: 0, rseq: 0,
  drafting: new Set(), revising: "", pick: null, tab: "comments", posts: new Map(), timer: 0, intgT: 0, readSent: "" };
// An app item "i:<instance id>" opens the comment pane when one of its sources is followed. A source carries the instance that owns it (`app`: the
// default instance of its app, or an added one such as site-mapia); an older gateway sends none, then the app of its kind.
const cmAppOfKind = k => (k === "website" ? "site" : k);
const cmOwner = s => s.app || cmAppOfKind(s.kind);
const cmAppOf = key => (key.startsWith("i:") && CM.apps.has(key.slice(2)) ? key.slice(2) : "");

const cmRooms = el("div", { class: "kk-rooms", id: "cm-rooms", "aria-label": "댓글을 지켜보는 글" });
const cmHead = el("div", { class: "kk-head", id: "cm-head" });
const cmIn = el("div", { class: "kk-in", id: "cm-in" });
const cmTl = el("div", { class: "kk-tl", id: "cm-tl" }, cmIn);
const cmDrafts = el("div", { class: "kk-drafts", id: "cm-drafts" });
const cmFoot = el("div", { class: "composer kk-composer", id: "cm-foot" }, cmDrafts);
const cmChat = el("div", { class: "kk-chat", id: "cm-chat" }, cmHead, el("div", { class: "kk-box" }, cmTl), cmFoot);
const cmPane = el("div", { class: "kk cm", id: "cm", hidden: true }, cmRooms, cmChat);
$("#v-monitoring").append(cmPane);

const cmIntgSoon = () => { clearTimeout(CM.intgT); CM.intgT = setTimeout(loadIntegrations, 500); };
const cmSources = () => CM.sources.filter(s => cmOwner(s) === CM.app);

async function cmLoadSources() {
  try {
    const r = await api("/api/comments/sources");
    CM.sources = r.on === false ? [] : Array.isArray(r.sources) ? r.sources : [];
  } catch { return; }
  await dmLoadList();
  const apps = new Set(CM.sources.filter(s => (s.watch || []).length).map(cmOwner));
  if (DM.on && DM.connected) apps.add(DM_APP);
  const changed = apps.size !== CM.apps.size || [...apps].some(a => !CM.apps.has(a));
  CM.apps = apps;
  if (changed && typeof monSchedule === "function") monSchedule();
  if (CM.vis) cmPaintRooms();
}
async function cmLoad() {
  const seq = ++CM.rseq;
  await cmLoadSources();
  if (CM.tab === "dm") { cmPaintRooms(); return; }
  try {
    const r = await api(`/api/comments/threads?app=${enc(CM.app)}`);
    if (seq !== CM.rseq) return;
    CM.threads = Array.isArray(r.threads) ? r.threads : []; CM.error = ""; CM.loaded = true;
  } catch (e) {
    if (seq !== CM.rseq) return;
    CM.threads = []; CM.loaded = true; CM.error = "댓글 목록을 불러오지 못했어요";
  }
  cmPaintRooms();
}

/* ---- choose what to follow ---- */
async function cmUpdate(s, patch) {
  try {
    await api(`/api/comments/sources/${enc(s.key)}`, "PUT", patch);
    await cmLoadSources();
    if (patch.watch) CM.posts.delete(s.key);
    cmLoad(); cmIntgSoon();
  } catch (e) { toast(e.message, true); cmLoadSources(); }
}
async function cmPosts(s) {
  if (CM.posts.has(s.key)) return;
  CM.posts.set(s.key, { loading: true, list: [] });
  cmPaintRooms();
  try {
    const r = await api(`/api/comments/sources/${enc(s.key)}/posts`);
    CM.posts.set(s.key, { list: Array.isArray(r.posts) ? r.posts : [], error: r.error || "" });
  } catch (e) { CM.posts.set(s.key, { list: [], error: e.message }); }
  cmPaintRooms();
}
function cmSourceNode(s) {
  const watch = s.watch || [], all = watch.includes("*"), p = CM.posts.get(s.key);
  const node = el("div", { class: "kk-pick-src", "data-src": s.key },
    el("div", { class: "kk-pr" }, el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: s.label }), s.error ? el("span", { class: "cv-p", role: "status", text: `읽지 못했어요 · ${s.error}` }) : null),
      kkSwitch(all, `${s.label} 전부 지켜보기`, "all", v => cmUpdate(s, { watch: v ? ["*"] : [] }))),
    el("div", { class: "kk-pr" }, el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: "자동 초안" })),
      kkSwitch(!!s.autoDraft, `${s.label} 자동 초안`, "auto", v => cmUpdate(s, { autoDraft: v }), true)),
    el("button", { class: "btn text", type: "button", "data-k": "posts", text: "지켜볼 글 고르기", onclick: () => cmPosts(s) }));
  if (p) {
    if (p.loading) node.append(el("div", { class: "kk-note", text: "불러오는 중…" }));
    else if (p.error && !p.list.length) node.append(el("div", { class: "kk-note", role: "status", text: p.error }));
    else for (const post of p.list) node.append(el("div", { class: "kk-pr", "data-post": post.id }, el("span", { class: "cv-b" }, el("span", { class: "cv-n", title: post.title, text: post.title })),
      kkSwitch(all || !!post.watched, post.title, "post", v => cmUpdate(s, { watch: v ? [...watch.filter(x => x !== "*"), post.id] : watch.filter(x => x !== post.id && x !== "*").concat(all ? p.list.filter(x => x.id !== post.id).map(x => x.id) : []) }), true)));
  }
  return node;
}
function cmRow(t) {
  const on = CM.open && CM.open.source === t.source && CM.open.thread === t.thread, n = t.unread + t.drafts;
  return el("button", { class: `cv-row pv kk-row${n ? " unread" : ""}${on ? " on" : ""}`, type: "button", "data-thread": t.thread, "aria-current": on ? "true" : null, onclick: () => cmOpen(t) },
    cmThumb(t.title, t.thumb),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", title: t.title, text: t.title }), el("span", { class: "cv-p", text: `${t.lastAuthor}: ${t.lastText}` })),
    el("span", { class: "cv-m" }, el("span", { class: "kk-t", text: kkListTime(t.lastAt) }), n ? el("span", { class: "nb", "aria-label": t.drafts ? `답장 확인 ${t.drafts}건` : `읽지 않은 댓글 ${t.unread}개`, text: t.drafts ? `초안 ${t.drafts}` : String(t.unread > 99 ? "99+" : t.unread) }) : null, t.unreplied ? el("span", { class: "nb unreplied", "aria-label": `미답장 ${t.unreplied}개`, text: `미답장 ${t.unreplied}` }) : null));
}
// The picture of a post: its thumbnail when the source gave one (it falls back to the title's initial when the picture does not load).
function cmThumb(title, thumb) {
  const av = kkAvatar(title);
  if (!thumb) return av;
  const img = el("img", { class: "kk-av kk-thumb", src: thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => img.replaceWith(av), { once: true });
  return img;
}
// The post at the top of its conversation (the head above it is hidden on a phone): thumbnail, title, link to the original.
function cmPostCard(thread, kind) {
  return el("div", { class: "cm-post" }, cmThumb(thread.title, thread.thumb),
    el("span", { class: "cv-b" }, el("span", { class: "cm-pt", text: thread.title }),
      thread.link ? el("a", { class: "cm-pl", href: thread.link, target: "_blank", rel: "noopener noreferrer", text: cmOpenWord(kind) }) : null));
}
const cmOpenWord = kind => (kind === "youtube" ? "영상 열기" : "원본 글 열기");
function cmTabs() {
  if (!(DM.on && DM.connected && CM.app === DM_APP && cmSources().some(s => (s.watch || []).length))) return null;
  const b = (id, text) => el("button", { type: "button", class: CM.tab === id ? "on" : "", "data-tab": id, "aria-pressed": CM.tab === id ? "true" : "false", text, onclick: () => cmTab(id) });
  return el("div", { class: "seg cm-tabs", role: "group", "aria-label": "보기" }, b("comments", "댓글"), b("dm", "DM"));
}
function cmTab(id) {
  if (CM.tab === id) return;
  CM.tab = id; CM.open = null; DM.open = null; CM.seq++; DM.seq++;
  cmPaintAll();
  if (id === "dm") dmRefresh(); else cmLoad();
}
function cmPaintRooms() {
  if (!CM.vis) return;
  if (CM.tab === "dm") { dmPaintRooms(); return; }
  const top = cmRooms.scrollTop, srcs = cmSources(), expanded = CM.pick === null ? !CM.threads.length : CM.pick;
  const pick = el("section", { class: "kk-pick", "aria-label": "지켜볼 글 고르기" },
    el("button", { class: "kk-ph", id: "cm-pick-btn", type: "button", "aria-expanded": expanded ? "true" : "false", onclick: () => { CM.pick = !expanded; cmPaintRooms(); } },
      el("span", { class: "kk-pt", text: "지켜볼 글" }), el("span", { class: "kk-cnt", text: "" }), icon("drop", "kk-chev")));
  if (expanded) {
    if (!srcs.length) pick.append(el("div", { class: "kk-note", text: "켜 둔 곳이 없어요. 채팅에서 댓글 답글을 켜 달라고 요청해 주세요" }));
    else pick.append(el("div", { class: "kk-hint", text: "자동 초안은 새 댓글마다 답글 초안을 만들어서 토큰이 들어요." }), ...srcs.map(cmSourceNode));
  }
  const list = el("section", { class: "kk-watch", "aria-label": "댓글이 있는 글" });
  if (CM.loaded) {
    list.append(el("div", { class: "cv-gh", role: "presentation", text: "글" }));
    if (CM.error) list.append(el("div", { class: "kk-note", role: "status", text: CM.error }));
    else if (CM.threads.length) list.append(...CM.threads.map(cmRow));
    else list.append(el("div", { class: "kk-note", id: "cm-empty", text: "아직 받은 댓글이 없어요" }));
  }
  const tabs = cmTabs();
  clear(cmRooms).append(...(tabs ? [tabs] : []), pick, list);
  cmRooms.scrollTop = top;
}

/* ---- one post's conversation ---- */
const cmUrl = t => `/api/comments/thread/${enc(t.source)}/${enc(t.thread)}`;
async function cmOpen(t) {
  const seq = ++CM.seq;
  CM.open = { source: t.source, thread: t.thread, title: t.title }; CM.view = null; CM.loading = true; CM.viewErr = ""; CM.revising = "";
  cmPaintAll();
  await cmReload(seq, true);
}
async function cmReload(seq = CM.seq, scroll = false) {
  const t = CM.open;
  if (!t) return;
  try {
    const v = await api(cmUrl(t));
    if (seq !== CM.seq) return;
    CM.view = v; CM.loading = false; CM.viewErr = "";
  } catch (e) {
    if (seq !== CM.seq) return;
    CM.loading = false; CM.viewErr = e.message || "댓글을 불러오지 못했어요";
  }
  cmPaintChat(scroll);
  cmMarkRead();
}
function cmClose() { CM.open = null; CM.view = null; CM.seq++; CM.loading = false; CM.revising = ""; cmPaintAll(); convTitle(); }
function cmBack() {
  if (!(CM.vis && (CM.tab === "dm" ? DM.open : CM.open) && narrowChat() && current === "monitoring" && !MON.list)) return false;
  if (CM.tab === "dm") { dmClose(); return true; }
  cmClose();
  return true;
}
function cmMarkRead() {
  const t = CM.open, v = CM.view;
  if (!t || !v || document.visibilityState !== "visible" || cmTl.offsetParent === null) return;
  const last = Math.max(0, ...v.comments.map(c => c.at));
  if (!last || CM.readSent === `${t.source}/${t.thread}/${last}` || (v.read != null && v.read >= last)) return;
  CM.readSent = `${t.source}/${t.thread}/${last}`;
  api(`${cmUrl(t)}/read`, "POST", {}).then(() => { v.read = last; cmIntgSoon(); cmLoad(); }).catch(() => {});
}
function cmCommentNode(c, by, first) {
  const parent = c.parent ? by.get(c.parent) : null;
  const bub = el("div", { class: "kk-bub" }, parent ? el("div", { class: "kk-reply", text: `↳ ${parent.author}` }) : null, el("span", { text: c.text }));
  const mark = c.needsReply ? el("button", { class: "cchip kk-dbtn", type: "button", "data-k": "draft", disabled: CM.drafting.has(c.id) || CM.view.drafts.some(d => d.commentId === c.id), onclick: () => cmMakeDraft(c),
    text: CM.drafting.has(c.id) ? "초안 만드는 중…" : "답글 초안" }) : null;
  if (c.mine) return el("div", { class: `kk-m me${first ? " first" : ""}`, "data-id": c.id }, el("div", { class: "kk-line" }, el("span", { class: "kk-time", text: kkTime(c.at) }), bub));
  return el("div", { class: `kk-m in${first ? " first" : ""}`, "data-id": c.id }, first ? kkAvatar(c.author) : el("span", { class: "kk-av sp", "aria-hidden": "true" }),
    el("div", { class: "kk-mb" }, first ? el("div", { class: "kk-name", text: c.author }) : null, el("div", { class: "kk-line" }, bub, el("span", { class: "kk-time", text: kkTime(c.at) })), mark, c.unreplied ? el("div", { class: "kk-line" }, unrepPill(), unrepNo(`/api/comments/comment/${encodeURIComponent(c.id)}/no-reply`)) : null));
}
function cmSendNode(s) {
  const failed = s.state === "failed", st = failed ? `실패${s.reason ? ` · ${s.reason}` : ""}` : s.state === "sent" ? "보냄" : "보내는 중";
  return el("div", { class: `kk-m me pend ${s.state} first`, "data-send": s.id }, el("div", { class: "kk-line" }, el("div", { class: "kk-bub", text: s.text })),
    el("div", { class: "kk-st", role: failed ? "alert" : "status" }, el("span", { class: "kk-state", text: st })));
}
function cmPaintChat(stick) {
  if (CM.tab === "dm") { dmPaintChat(); return; }
  const open = CM.open, v = CM.view;
  cmFoot.hidden = !open || CM.loading || !!CM.viewErr || !v;
  const sig = open ? `${open.source}/${open.thread}/${open.title}/${v && v.thread.title}/${v && v.thread.thumb}` : "";
  if (sig !== CM.headSig) {
    CM.headSig = sig; clear(cmHead);
    if (open) cmHead.append(cmThumb(open.title, v && v.thread.thumb), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: open.title }),
      v && v.thread.link ? el("a", { class: "cv-p", href: v.thread.link, target: "_blank", rel: "noopener noreferrer", text: cmOpenWord(v.source.kind) }) : el("span", { class: "cv-p", text: "댓글" })));
  }
  if (!open) { clear(cmIn).append(el("div", { class: "kk-note", text: "글을 골라 주세요" })); return; }
  if (CM.loading) { clear(cmIn).append(el("div", { class: "kk-note", text: "불러오는 중…" })); return; }
  if (CM.viewErr || !v) { clear(cmIn).append(el("div", { class: "kk-note", role: "status", text: CM.viewErr })); return; }
  const by = new Map(v.comments.map(c => [c.id.split(":").slice(2).join(":"), c]));
  const nodes = [cmPostCard(v.thread, v.source.kind)]; let prev = null;
  for (const c of v.comments) {
    if (!prev || kkDay(prev.at) !== kkDay(c.at)) nodes.push(el("div", { class: "kk-date", text: kkDate(c.at) }));
    nodes.push(cmCommentNode(c, new Map([...by].map(([k, x]) => [k, x])), !prev || prev.author !== c.author || prev.mine !== c.mine || kkDay(prev.at) !== kkDay(c.at)));
    prev = c;
  }
  nodes.push(...v.sends.filter(s => s.state !== "sent" || Date.now() - s.at < 120000).map(cmSendNode));
  const keep = cmTl.scrollTop;
  clear(cmIn).append(...nodes);
  cmTl.scrollTop = stick ? cmTl.scrollHeight : keep;
  clear(cmDrafts).append(...v.drafts.map(cmDraftCard));
  cmDrafts.hidden = !cmDrafts.firstChild;
}
function cmPaintAll() {
  cmPane.classList.toggle("chat-open", !!(CM.tab === "dm" ? DM.open : CM.open));
  cmPaintRooms(); cmPaintChat(true);
}

/* ---- drafts: made on request, then 보내기 / 고치기 / 버리기 ---- */
async function cmMakeDraft(c) {
  if (CM.drafting.has(c.id)) return;
  CM.drafting.add(c.id); cmPaintChat(false);
  setTimeout(() => { if (CM.drafting.delete(c.id)) { cmPaintChat(false); toast("초안이 아직 오지 않았어요", true); } }, 120000);
  try { await api(`/api/comments/comment/${enc(c.id)}/draft`, "POST", {}); }
  catch (e) { CM.drafting.delete(c.id); cmPaintChat(false); toast(e.message, true); }
}
function cmDraftCard(d) {
  const run = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, true); cmReload(); } finally { btn.disabled = false; } };
  const sending = CM.view.sends.some(s => s.commentId === d.commentId && s.state === "sending");
  const edit = CM.revising === d.code;
  const input = el("input", { class: "kk-ta", type: "text", placeholder: "어떻게 고칠까요? (예: 더 짧게)", "aria-label": "고칠 내용" });
  return el("div", { class: "kk-draft", "data-code": d.code },
    el("div", { class: "kk-dh", text: "답글 초안" }),
    el("div", { class: "kk-dt", text: d.text }),
    d.notes && d.notes.length ? el("div", { class: "kk-note", role: "status", text: d.notes.join(" / ") }) : null,
    edit ? el("div", { class: "btns" }, input,
      el("button", { class: "btn", type: "button", "data-k": "rewrite", text: "다시 쓰기", onclick: ev => run(ev.currentTarget, async () => { await api(`/api/comments/drafts/${enc(d.code)}/revise`, "POST", { change: input.value }); CM.revising = ""; await cmReload(); }) }),
      el("button", { class: "btn text", type: "button", text: "취소", onclick: () => { CM.revising = ""; cmPaintChat(false); } }))
    : el("div", { class: "btns" },
      el("button", { class: "btn", type: "button", "data-k": "send", disabled: sending, text: "보내기", onclick: ev => run(ev.currentTarget, async () => { await api(`/api/comments/drafts/${enc(d.code)}/send`, "POST", {}); await cmReload(CM.seq, true); }) }),
      el("button", { class: "btn tonal", type: "button", "data-k": "edit", text: "고치기", onclick: () => { CM.revising = d.code; cmPaintChat(false); } }),
      el("button", { class: "btn text", type: "button", "data-k": "drop", text: "버리기", onclick: ev => run(ev.currentTarget, async () => { await api(`/api/comments/drafts/${enc(d.code)}/drop`, "POST", {}); await cmReload(); }) })));
}

/* ---- live and mode ---- */
function cmLive(e) {
  cmIntgSoon();
  if (e.kind === "comment_sources") { cmLoadSources(); return; }
  if (e.kind === "comment_draft" && e.error) toast(e.error, true);
  if (e.kind === "comment_draft") for (const id of [...CM.drafting]) CM.drafting.delete(id);
  if (!CM.vis) return;
  cmLoad();
  if (CM.open && CM.open.source === e.source && CM.open.thread === e.thread) cmReload();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && CM.vis) { cmLoad(); cmReload(); } });
// renderMonitoring (30-monitoring.js): `app` = the selected app entry has comment replies on; `shown` = its pane is on screen (not behind the phone's list).
function cmMode(app, shown) {
  if (app) $("#v-monitoring").classList.add("kk-on");
  cmPane.hidden = !app;
  if (shown && (!CM.vis || CM.app !== app)) {
    Object.assign(CM, { vis: true, app, threads: [], loaded: false, open: null, view: null, pick: null, headSig: "", tab: CM.sources.some(s => cmOwner(s) === app && (s.watch || []).length) || !(DM.on && DM.connected && app === DM_APP) ? "comments" : "dm" }); CM.seq++;
    Object.assign(DM, { open: null, view: null }); DM.seq++;
    cmPaintAll(); cmLoad();
    if (CM.tab === "dm") dmRefresh();
    clearInterval(CM.timer);
    CM.timer = setInterval(() => { if (document.visibilityState === "visible") cmLoad(); }, 60000);
  } else if (!shown && CM.vis) {
    CM.vis = false; CM.open = null; DM.open = null; CM.seq++; DM.seq++; clearInterval(CM.timer);
  }
}
cmLoadSources();
