/* ---------- 모니터링 > 앱 > 유튜브 / 인스타그램 / 웹사이트 댓글: choose what to follow, one conversation per post ---------- */
// API: docs/comments-api.md. Shown instead of the notice timeline of an app entry only while the owner has comment replies on for that
// app (CM.apps). It reuses the KakaoTalk pane's layout and classes (30-kakao.js, 17-kakao.css). Live updates: comment / comment_draft /
// comment_sources events (99-boot.js -> cmLive). Nothing is posted without a click on a draft's 보내기 (its queue card); text only
// goes through el({text}), never innerHTML.
// A request that did not get through reads as a sentence about what did not load, never the bare transport word ('offline'); 다시 시도 stands under it, the same in every empty or failed place of the kakao and comment panes.
const appFail = (e, what) => { const m = String((e && e.message) || ""); return !m || /^(offline|failed to fetch|load failed|networkerror.*)$/i.test(m) ? TX("mon.cm.fail_net", { what }) : m; };
const appRetry = fn => el("button", { class: "btn tonal sm", type: "button", "data-k": "retry", text: TX("appset.retry"), onclick: fn });
const CM = { apps: new Set(), sources: [], local: { sources: [], apps: new Set() }, pc: null, vis: false, app: "", threads: [], loaded: false, error: "", open: null, view: null, loading: false, viewErr: "", seq: 0, rseq: 0,
  drafting: new Set(), raMiss: "", pickD: null, tab: "comments", posts: new Map(), timer: 0, intgT: 0, readSent: "", roomsSig: "", chatSig: "" };
// An app item "i:<instance id>" opens the comment pane when one of its sources is followed. A source carries the instance that owns it (`app`: the
// default instance of its app, or an added one such as site-mapia); an older gateway sends none, then the app of its kind.
const cmAppOfKind = k => (k === "website" ? "site" : k);
const cmOwner = s => s.app || cmAppOfKind(s.kind);
// The same app on another computer ("p:<url>|i:<instance>~<hash>", 34-peer-monitoring.js) is the comment pane too: its sources, threads and actions are
// that computer's (cmApi), so the pane works the same whichever computer holds the comments.
const cmBases = new Set(["youtube", "instagram", "site"]);
const cmAppOf = key => {
  const m = /^(?:p:[^|]+\|)?i:([^~|]+)(?:~[a-z0-9]+)?$/.exec(String(key || ""));
  if (!m) return "";
  const inst = m[1];
  return CM.local.apps.has(inst) || cmBases.has(inst.split("-")[0]) ? inst : "";
};
// Every call of the pane: this computer's own comments routes, or the comments of the computer the pane shows (a GET through /api/peer/proxy, a change
// through /api/peer/act - pqRoute/pqAct pick it up from CM.pc, 34-peer-monitoring.js).
function cmApi(path, method = "GET", body) {
  if (!CM.pc) return api(path, method, body);
  return api(method === "GET" ? pqProxy(CM.pc, pqBare(path)) : path, method, body);
}

const cmRooms = el("div", { class: "kk-rooms", id: "cm-rooms", "aria-label": TX("mon.cm.rooms_aria") });
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
// The sources of a settings app: this computer's ("youtube"), or a peer's ("youtube~<computer>") while the pane shows that computer (CM.pc).
const cmSrcOf = app => (app.includes("~") === !!CM.pc ? CM.sources.filter(s => cmOwner(s) === app.split("~")[0]) : []);
const cmWatchWord = srcs => { const w = srcs.flatMap(s => s.watch || []); return w.includes("*") ? TX("mon.cm.all") : w.length ? TX("mon.cm.watch_n", { n: w.length }) : TX("settings.none"); };

async function cmLoadSources() {
  try {
    const r = await cmApi("/api/comments/sources");
    CM.sources = r.on === false ? [] : Array.isArray(r.sources) ? r.sources : [];
  } catch { return; }
  if (!CM.pc) CM.local.sources = CM.sources;   // this computer's own, for the app rows that are not a peer's
  await dmLoadList();
  const apps = new Set(CM.sources.filter(s => (s.watch || []).length).map(cmOwner));
  if (!CM.pc && DM.on && DM.connected) apps.add(DM_APP);
  const changed = apps.size !== CM.apps.size || [...apps].some(a => !CM.apps.has(a));
  CM.apps = apps;
  if (!CM.pc) CM.local.apps = new Set(apps);
  if (changed && typeof monSchedule === "function") monSchedule();
  if (CM.vis) cmPaintRooms();
  cmPickPaint(); asPaint();
}
async function cmLoad() {
  const seq = ++CM.rseq;
  await cmLoadSources();
  if (CM.tab === "dm") { cmPaintRooms(); return; }
  try {
    const r = await cmApi(`/api/comments/threads?app=${enc(CM.app)}`);
    if (seq !== CM.rseq) return;
    CM.threads = Array.isArray(r.threads) ? r.threads : []; CM.error = ""; CM.loaded = true;
  } catch (e) {
    if (seq !== CM.rseq) return;
    CM.threads = []; CM.loaded = true; CM.error = TX("mon.cm.list_fail");
  }
  cmPaintRooms();
}

/* ---- choose what to follow ---- */
async function cmUpdate(s, patch) {
  try {
    await cmApi(`/api/comments/sources/${enc(s.key)}`, "PUT", patch);
    await cmLoadSources();
    if (patch.watch) CM.posts.delete(s.key);
    if (CM.vis) cmLoad();
    cmIntgSoon();
  } catch (e) { toast(e.message, true); cmLoadSources(); }
}
async function cmPosts(s) {
  if (CM.posts.has(s.key)) return;
  CM.posts.set(s.key, { loading: true, list: [] });
  cmPickPaint();
  try {
    const r = await cmApi(`/api/comments/sources/${enc(s.key)}/posts`);
    CM.posts.set(s.key, { list: Array.isArray(r.posts) ? r.posts : [], error: r.error || "" });
  } catch (e) { CM.posts.set(s.key, { list: [], error: e.message }); }
  cmPickPaint();
}
function cmSourceNode(s) {
  const watch = s.watch || [], all = watch.includes("*"), p = CM.posts.get(s.key);
  const node = el("div", { class: "kk-pick-src", "data-src": s.key },
    el("div", { class: "kk-pr" }, el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: s.label }), s.error ? el("span", { class: "cv-p", role: "status", text: TX("mon.cm.read_fail", { error: s.error }) }) : null),
      kkSwitch(all, TX("mon.cm.watch_all", { label: s.label }), "all", v => cmUpdate(s, { watch: v ? ["*"] : [] }))),
    el("div", { class: "sec", text: TX("common.settings") }),
    el("div", { class: "kk-pr" }, el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: TX("mon.cm.auto") })),
      kkSwitch(!!s.autoDraft, TX("mon.cm.auto_aria", { label: s.label }), "auto", v => cmUpdate(s, { autoDraft: v }), true)),
    // Config-only: the mail app (`mailApp`) is set in the source config (docs/comments-api.md); without it the card says no mail was made.
    el("div", { class: "kk-pr" }, el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: TX("mon.cm.filemail") })),
      kkSwitch(!!s.autoMail, TX("mon.cm.filemail_aria", { label: s.label }), "mail", v => cmUpdate(s, { autoMail: v }), true)),
    el("button", { class: "li tap", type: "button", "data-k": "posts", onclick: () => cmPosts(s) }, el("span", { class: "tx" }, el("div", { class: "hd", text: TX("mon.cm.pick") })), el("span", { class: "li-end" }, icon("chev", "chev"))));
  if (p) {
    if (p.loading) node.append(el("div", { class: "kk-note", text: TX("common.loading") }));
    else if (p.error && !p.list.length) node.append(el("div", { class: "kk-note", role: "status", text: p.error }));
    else for (const post of p.list) node.append(el("div", { class: "kk-pr", "data-post": post.id }, el("span", { class: "cv-b" }, el("span", { class: "cv-n", title: post.title, text: post.title })),
      kkSwitch(all || !!post.watched, post.title, "post", v => cmUpdate(s, { watch: v ? [...watch.filter(x => x !== "*"), post.id] : watch.filter(x => x !== post.id && x !== "*").concat(all ? p.list.filter(x => x.id !== post.id).map(x => x.id) : []) }), true)));
  }
  return node;
}
// The picker: the side sheet of KakaoTalk's 지켜볼 대화방, opened from the app's settings row (asPickRow) or the empty list.
function cmPickPaint() {
  const d = CM.pickD;
  if (!d) return;
  const srcs = cmSrcOf(d.dataset.app);
  clear(d.querySelector(".kk-pd-b")).append(...(srcs.length ? [el("div", { class: "kk-hint", text: TX("mon.cm.tokens") }), el("div", { class: "sec", text: TX("mon.cm.channels") }), ...srcs.map(cmSourceNode)] : [el("div", { class: "kk-note", text: TX("mon.cm.none_on") })]));
}
function cmPickOpen(app) {
  if (CM.pickD) return;
  const d = CM.pickD = el("dialog", { class: "kk-pd kk-add", id: "cm-pick", "data-app": app, "aria-label": TX("mon.cm.posts_watch") },
    el("div", { class: "kk-pd-in" },
      fsHead([el("h2", { class: "fs-t", text: TX("mon.cm.posts_watch") })], { close: () => d.close() }),
      el("div", { class: "kk-pd-b" })));
  cmPickPaint();
  d.addEventListener("click", ev => { if (ev.target === d) d.close(); });
  document.body.append(d); d.showModal(); dialogHist(d);
  d.addEventListener("close", () => { if (CM.pickD === d) CM.pickD = null; d.remove(); });
}
// A post's row carries one marker, the most urgent: a failed mail > comments nobody answered > drafts waiting. The rest is in the opened post, on each comment (cmProgress).
function cmMark(t) {
  const failed = t.mails ? t.mails.failed : 0;
  if (failed) return el("span", { class: "tag err", "data-mark": "failed", "aria-label": TX("mon.cm.mail_fail_aria", { n: failed }), text: TX("mon.cm.failed_n", { n: failed }) });
  if (t.unreplied) { const m = unrepCount(t.unreplied); m.dataset.mark = "unreplied"; return m; }
  if (t.drafts) return el("span", { class: "nb drafted", "data-mark": "draft", "aria-label": TX("mon.cm.drafts_aria", { n: t.drafts }), text: TX("mon.cm.drafts_n", { n: t.drafts }) });
  return null;
}
function cmRow(t) {
  const on = CM.open && CM.open.source === t.source && CM.open.thread === t.thread, n = t.unread + t.drafts, mark = cmMark(t);
  return el("button", { class: `cv-row pv kk-row${n ? " unread" : ""}${on ? " on" : ""}`, type: "button", "data-thread": t.thread, "aria-current": on ? "true" : null, onclick: () => cmOpen(t) },
    cmThumb(t.title, t.thumb),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", title: t.title, text: t.title }), el("span", { class: "cv-p", text: `${t.lastAuthor}: ${t.lastText}` })),
    el("span", { class: "cv-m" }, el("span", { class: "kk-t", text: kkListTime(t.lastAt) }), mark ? el("span", { class: "kk-rmeta" }, mark) : null));
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
const cmOpenWord = kind => (kind === "youtube" ? TX("mon.cm.open_video") : TX("mon.cm.open_post"));
// DM is this computer's own (one DM state, /api/ig-dm here): another computer's Instagram shows no DM tab, never this computer's DMs under its name.
const cmHasTabs = () => !CM.pc && DM.on && DM.connected && CM.app === DM_APP && cmSources().some(s => (s.watch || []).length);
function cmTabs() {
  if (!cmHasTabs()) return null;
  const b = (id, text) => el("button", { type: "button", class: `cchip mr-f${CM.tab === id ? " on" : ""}`, role: "tab", "data-tab": id, "aria-selected": String(CM.tab === id), text, onclick: () => cmTab(id) });
  return el("div", { class: "mr-filter cm-tabs", role: "tablist", "aria-label": TX("mon.cm.view_aria") }, b("comments", TX("mon.cm.comments")), b("dm", "DM"));
}
function cmTab(id) {
  if (CM.tab === id) return;
  CM.tab = id; CM.open = null; DM.open = null; CM.seq++; DM.seq++;
  cmPaintAll(); bkCmSync();
  if (id === "dm") dmRefresh(); else cmLoad();
}
function cmPaintRooms() {
  if (!CM.vis) return;
  if (CM.tab === "dm") { dmPaintRooms(); return; }
  const top = cmRooms.scrollTop, srcs = cmSources();
  const sig = JSON.stringify([CM.app, CM.threads, srcs, CM.open && [CM.open.source, CM.open.thread], CM.loaded, CM.error, cmHasTabs()]);
  if (sig === CM.roomsSig) {   // nothing changed: only the relative times move, in place
    for (const t of CM.threads) { const n = cmRooms.querySelector(`[data-thread="${CSS.escape(t.thread)}"] .kk-t`); if (n && n.textContent !== kkListTime(t.lastAt)) n.textContent = kkListTime(t.lastAt); }
    return;
  }
  CM.roomsSig = sig;
  const list = el("section", { class: "kk-watch", "aria-label": TX("mon.cm.posts_aria") });
  if (CM.loaded) {
    list.append(el("div", { class: "cv-gh", role: "presentation", text: TX("mon.cm.posts") }));
    if (CM.error) list.append(el("div", { class: "kk-note", role: "status", text: CM.error }), el("button", { class: "btn tonal sm", type: "button", "data-k": "retry", text: TX("appset.retry"), onclick: () => cmLoad() }));
    else if (CM.threads.length) list.append(...CM.threads.map(cmRow));
    else if (!srcs.length) list.append(el("div", { class: "kk-note", id: "cm-empty", text: TX("mon.cm.none_on") }));
    else list.append(el("div", { class: "kk-note", id: "cm-empty", text: TX("mon.cm.empty") }), el("button", { class: "btn tonal sm", type: "button", "data-k": "pick-open", text: TX("mon.cm.pick"), onclick: () => cmPickOpen(CM.pc ? pqApp(CM.app, CM.pc) : CM.app) }));
  } else list.append(el("div", { class: "kk-note", role: "status", text: TX("common.loading") }));
  const tabs = cmTabs();
  clear(cmRooms).append(...(tabs ? [tabs] : []), list);
  cmRooms.scrollTop = top;
}

/* ---- one post's conversation ---- */
const cmUrl = t => `/api/comments/thread/${enc(t.source)}/${enc(t.thread)}`;
async function cmOpen(t) {
  const seq = ++CM.seq;
  CM.open = { source: t.source, thread: t.thread, title: t.title }; CM.view = null; CM.loading = true; CM.viewErr = "";
  cmPaintAll(); bkCmSync();
  await cmReload(seq, true);
}
async function cmReload(seq = CM.seq, scroll = false) {
  const t = CM.open;
  if (!t) return;
  try {
    const v = await cmApi(cmUrl(t));
    if (seq !== CM.seq) return;
    CM.view = v; CM.loading = false; CM.viewErr = "";
  } catch (e) {
    if (seq !== CM.seq) return;
    CM.loading = false; CM.viewErr = appFail(e, TX("mon.cm.fail"));
  }
  cmPaintChat(scroll);
  cmMarkRead();
}
function cmClose() { CM.open = null; CM.view = null; CM.seq++; CM.loading = false; cmPaintAll(); convTitle(); bkCmSync(); }
function cmBack() {
  if (!(CM.vis && (CM.tab === "dm" ? DM.open : CM.open) && current === "monitoring" && !MON.list)) return false;
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
  cmApi(`${cmUrl(t)}/read`, "POST", {}).then(() => { v.read = last; cmIntgSoon(); cmLoad(); }).catch(() => {});
}
// A comment is a row (the prototype's list row), not a chat bubble: avatar, name · time, the text, then what the comment set going (cmProgress) and the
// actions still open. `nested`: drawn under the comment it answers (cmThreadNodes), so the row does not repeat who it answers; his own are marked 나 / 내 답글.
const cmNative = c => c.id.split(":").slice(2).join(":");
// The follow-up of one comment as short tracks of steps, from what the hub returns for it (hub/comments/engine.ts threadView): its pending draft (drafts),
// the send records of the last 24 hours (sends: sending / sent / failed + reason), the mail that rides on the reply (comment.mail, draft.mail) and his own reply in the
// thread (answered on the platform). Step state: done · busy (on its way) · ask (waits for him) · err · todo (not yet). What the hub does not return stays unshown.
function cmFlow(c, v) {
  if (c.mine) return [];
  const step = (text, st) => ({ text, st }), out = [];
  const d = v.drafts.find(x => x.commentId === c.id), s = v.sends.filter(x => x.commentId === c.id).sort((p, q) => p.at - q.at).at(-1);
  let reply = null;
  if (s && s.state === "sending") reply = [step(TX("common.draft"), "done"), step(TX("mon.cm.st.check"), "done"), step(TX("mon.cm.st.sending"), "busy")];
  else if (s && s.state === "unsure") reply = [step(TX("common.draft"), "done"), step(TX("mon.cm.st.check"), "done"), step(TX("mon.tag.need"), "ask")];
  else if (d) reply = [step(TX("common.draft"), "done"), step(TX("mon.mail.pending"), "ask"), step(TX("mon.dr.st.send"), "todo")];
  else if (s && s.state === "sent") reply = [step(TX("common.draft"), "done"), step(TX("mon.cm.st.check"), "done"), step(s.via === "rule" ? TX("mon.cm.st.auto") : TX("mon.dr.st.send"), "done")];
  else if (s && s.state === "failed") reply = [step(TX("common.draft"), "done"), step(TX("mon.cm.st.check"), "done"), step(`${TX("mon.tag.fail")}${s.reason ? ` · ${s.reason}` : ""}`, "err")];
  else if (v.comments.some(x => x.mine && x.parent && x.parent === cmNative(c))) reply = [step(TX("mon.cm.st.reply_sent"), "done")];
  else if (CM.drafting.has(c.id)) reply = [step(TX("mon.cm.st.drafting"), "busy"), step(TX("mon.cm.st.check"), "todo"), step(TX("mon.dr.st.send"), "todo")];
  else if (c.needsReply) reply = [step(TX("mon.cm.st.need_draft"), "ask"), step(TX("mon.cm.st.check"), "todo"), step(TX("mon.dr.st.send"), "todo")];
  if (reply) out.push({ key: "reply", name: TX("mon.cm.reply"), steps: reply });
  const m = c.mail || (d && d.mail ? { state: "drafted", label: TX("mon.cm.mail_drafted") } : null);
  if (m) out.push({ key: "mail", name: TX("common.mail"), steps: m.state === "failed" ? [step(TX("common.draft"), "done"), step(m.label, "err")] : m.state === "sent" ? [step(TX("common.draft"), "done"), step(TX("mon.dr.st.send"), "done")] : [step(TX("common.draft"), "done"), step(TX("mon.cm.st.with_reply"), "todo")] });
  return out;
}
function cmProgress(c, v) {
  const tracks = cmFlow(c, v);
  if (!tracks.length) return null;
  return el("div", { class: "cm-pg" }, ...tracks.map(t => el("div", { class: "cm-tr", "data-track": t.key, role: "group", "aria-label": `${t.name}: ${t.steps.map(x => x.text).join(" → ")}` },
    el("span", { class: "cm-tn", text: t.name }), ...t.steps.map(x => el("span", { class: "cm-st", "data-s": x.st, text: x.text })))));
}
function cmNoReply(ev, c) {
  const btn = ev.currentTarget, row = btn.closest(".cm-c"), pill = row && row.querySelector(".tag.unreplied");
  const hidden = [btn, pill].filter(Boolean);
  hidden.forEach(n => { n.hidden = true; });
  cmApi(`/api/comments/comment/${enc(c.id)}/no-reply`, "POST", {}).then(() => { toast(TX("mail.fyi.done")); cmReload(); cmLoad(); cmIntgSoon(); },
    e => { hidden.forEach(n => { n.hidden = false; }); toast(e.message, true); });
}
function cmCommentNode(c, v, by, nested) {
  const parent = c.parent ? by.get(c.parent) : null, draft = v.drafts.some(d => d.commentId === c.id);
  const pill = !c.mine && c.unreplied ? unrepPill() : null;
  const hd = el("div", { class: "cm-hd" }, c.mine ? el("span", { class: "cm-mine", text: c.parent ? TX("mon.cm.my_reply") : TX("mon.cm.me") }) : el("span", { class: "kk-name", text: c.author }), el("span", { class: "kk-time", text: kkTime(c.at) }), pill);
  const make = !c.mine && c.needsReply && !draft ? el("button", { class: "btn tonal sm", type: "button", "data-k": "draft", disabled: CM.drafting.has(c.id), onclick: () => cmMakeDraft(c),
    text: CM.drafting.has(c.id) ? TX("mon.cm.drafting_dots") : TX("mon.cm.reply_draft") }) : null;
  const no = pill ? el("button", { class: "btn text sm cm-no", type: "button", text: TX("mail.fyi.title"), onclick: ev => cmNoReply(ev, c) }) : null;
  return el("div", { class: `kk-m cm-c${c.mine ? " mine" : ""}`, "data-id": c.id }, c.mine ? el("span", { class: "kk-av cm-me", "aria-hidden": "true", text: TX("mon.cm.me") }) : kkAvatar(c.author),
    el("div", { class: "kk-mb" }, hd, parent && !nested ? el("div", { class: "kk-reply", text: `↳ ${parent.author}` }) : null, el("div", { class: "kk-bub", text: c.text }), cmProgress(c, v),
      make || no ? el("div", { class: "cm-acts" }, make, no) : null));
}
// A reply on its way, failed or unsure stays under its comment as a bubble with its state; what to do about it is the queue card's (답장 대기).
function cmSendNode(s) {
  const failed = s.state === "failed", unsure = s.state === "unsure", st = failed ? `${TX("mon.tag.fail")}${s.reason ? ` · ${s.reason}` : ""}` : unsure ? `${TX("mon.tag.need")}${s.reason ? ` · ${s.reason}` : ""}` : s.state === "sent" ? TX("mon.dr.st.send") : TX("mon.cm.st.sending");
  return el("div", { class: `kk-m me pend ${s.state} first`, "data-send": s.id }, el("div", { class: "kk-line" }, el("div", { class: "kk-bub", text: s.text })),
    el("div", { class: "kk-st", role: failed || unsure ? "alert" : "status" }, s.state === "sent" ? rqSentNode() : el("span", { class: "kk-state", text: st })));
}
function cmPaintChat(stick) {
  if (CM.tab === "dm") { dmPaintChat(); return; }
  const open = CM.open, v = CM.view;
  cmFoot.hidden = true; dmRo.hidden = true;   // drafts sit under the comment they answer (cmThreadNodes), not pinned here
  const sig = open ? `${open.source}/${open.thread}/${open.title}/${v && v.thread.title}/${v && v.thread.thumb}` : "";
  if (sig !== CM.headSig) {
    CM.headSig = sig; clear(cmHead);
    if (open) cmHead.append(cmThumb(open.title, v && v.thread.thumb), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: open.title }),
      v && v.thread.link ? el("a", { class: "cv-p", href: v.thread.link, target: "_blank", rel: "noopener noreferrer", text: cmOpenWord(v.source.kind) }) : el("span", { class: "cv-p", text: TX("mon.cm.comments") })));
  }
  const csig = JSON.stringify([open, CM.loading, CM.viewErr, v && { ...v, read: null }, [...CM.drafting], v && v.sends.some(x => x.state === "sent" && Date.now() - x.at < 120000) ? Math.floor(Date.now() / 20000) : 0]);
  if (!stick && csig === CM.chatSig) return;
  CM.chatSig = csig;
  if (!open) { clear(cmIn).append(el("div", { class: "kk-note", text: TX("mon.cm.pick_post") })); return; }
  if (CM.loading) { clear(cmIn).append(el("div", { class: "kk-note", text: TX("common.loading") })); return; }
  if (CM.viewErr || !v) { clear(cmIn).append(el("div", { class: "kk-note", role: "status", text: CM.viewErr }), appRetry(() => { CM.loading = true; CM.viewErr = ""; cmPaintChat(false); cmReload(); })); return; }
  // A repaint while he types what to change (the queue card's 고치기 field) draws a new field: give it the focus and the caret the old one had.
  const a = document.activeElement, typing = a && a.matches(".rq-edit input") && cmIn.contains(a) ? [a.selectionStart, a.selectionEnd, a.selectionDirection] : null;
  const nodes = [cmPostCard(v.thread, v.source.kind), ...cmThreadNodes(v)];
  const keep = cmTl.scrollTop;
  if (!paintKeep(cmIn, nodes, () => { CM.chatSig = ""; cmPaintChat(); })) return;
  cmTl.scrollTop = stick && !typing ? cmTl.scrollHeight : keep;
  const inp = typing && $(".rq-edit input", cmIn);
  if (inp) { inp.focus({ preventScroll: true }); inp.setSelectionRange(...typing); }
  clear(cmDrafts);
  cmDrafts.hidden = true;
}
// Reply-style thread: each top-level comment with the replies under it (his own and others', indented), and a draft or a reply on its way
// right under the comment it answers. A reply whose parent is not in the thread stands as a top-level comment.
function cmThreadNodes(v) {
  const native = c => c.id.split(":").slice(2).join(":");
  const by = new Map(v.comments.map(c => [native(c), c]));
  const rootOf = c => { let r = c; for (let n = 0; n < 8 && r.parent && by.get(r.parent); n++) r = by.get(r.parent); return r; };
  const groups = new Map();
  for (const c of v.comments) {
    const r = rootOf(c), g = groups.get(r.id) || { root: r, replies: [] };
    groups.set(r.id, g);
    if (c !== r) g.replies.push(c);
  }
  const ids = new Set(v.comments.map(c => c.id));
  const sends = v.sends.filter(s => s.state !== "sent" || Date.now() - s.at < 120000);
  const under = c => [...v.drafts.filter(d => d.commentId === c.id).map(cmQueueCard).filter(Boolean), ...sends.filter(s => s.commentId === c.id).map(cmSendNode)];
  const nodes = []; let day = null;
  for (const { root, replies } of groups.values()) {
    if (day === null || kkDay(day) !== kkDay(root.at)) nodes.push(el("div", { class: "kk-date", text: kkDate(root.at) }));
    day = root.at;
    const kids = [...under(root)];
    for (const r of replies) kids.push(cmCommentNode(r, v, by, true), ...under(r));
    nodes.push(el("div", { class: "cm-th", "data-root": root.id }, cmCommentNode(root, v, by, false), kids.length ? el("div", { class: "cm-replies" }, ...kids) : null));
  }
  nodes.push(...v.drafts.filter(d => !ids.has(d.commentId)).map(cmQueueCard).filter(Boolean), ...sends.filter(s => !ids.has(s.commentId)).map(cmSendNode));
  return nodes;
}
function cmPaintAll() {
  cmPane.classList.toggle("chat-open", !!(CM.tab === "dm" ? DM.open : CM.open));
  cmPaintRooms(); cmPaintChat(true);
}

/* ---- drafts: made on request, then 보내기 / 고치기 / 보내지 않기 ---- */
async function cmMakeDraft(c) {
  if (CM.drafting.has(c.id)) return;
  CM.drafting.add(c.id); cmPaintChat(false);
  setTimeout(() => { if (CM.drafting.delete(c.id)) { cmPaintChat(false); toast(TX("mon.cm.draft_late"), true); } }, 120000);
  try { await cmApi(`/api/comments/comment/${enc(c.id)}/draft`, "POST", {}); }
  catch (e) { CM.drafting.delete(c.id); cmPaintChat(false); toast(e.message, true); }
}
// The thread's draft is its item of the one reply queue, drawn as that card (rqItemCard) right under the comment it answers, with 답글 / 메일 for a 고치기
// when a mail rides along. A draft the queue does not list yet (just made) has the queue read once more and the thread drawn again.
function cmQueueCard(d) {
  const qi = raItems().find(i => i.ref === d.code);
  if (qi) return el("div", { class: "od-cwrap" }, rqItemCard(qi, { bare: true, part: !!d.mail }));
  if (CM.raMiss !== d.code) { CM.raMiss = d.code; raLoad().then(() => { CM.chatSig = ""; cmPaintChat(false); }); }
  return null;
}

/* ---- live and mode ---- */
function cmLive(e) {
  cmIntgSoon();
  if (e.kind === "comment_draft") rqSoon();
  if (CM.pc) return;   // the stream is this computer's; the peer's comments are read again by the timer
  if (e.kind === "comment_sources") { cmLoadSources(); return; }
  if (e.kind === "comment_draft" && e.error) toast(e.error, true);
  if (e.kind === "comment_draft") for (const id of [...CM.drafting]) CM.drafting.delete(id);
  if (!CM.vis) return;
  cmLoad();
  if (CM.open && CM.open.source === e.source && CM.open.thread === e.thread) cmReload();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && CM.vis) { cmLoad(); cmReload(); } });
// renderMonitoring (30-monitoring.js): `app` = the selected app entry has comment replies on; `shown` = its pane is on screen (not behind the phone's list).
function cmMode(app, shown, pc) {
  const swap = (CM.pc ? CM.pc.url : "") !== (pc ? pc.url : "");
  if (app) $("#v-monitoring").classList.add("kk-on");
  cmPane.hidden = !app;
  if (swap) {   // another computer's comments: start from an empty pane (this computer's sources stay for its app rows)
    Object.assign(CM, { vis: false, sources: [], apps: new Set(), threads: [], loaded: false, open: null, view: null, headSig: "", roomsSig: "", chatSig: "", error: "" }); CM.seq++; clearInterval(CM.timer);
  }
  CM.pc = app ? pc || null : null;
  if (shown && (!CM.vis || CM.app !== app)) {
    // The DM tab is this computer's Instagram app only; another computer's comment app starts on its comments.
    const dm = !CM.pc && DM.on && DM.connected && app === DM_APP && !CM.sources.some(s => cmOwner(s) === app && (s.watch || []).length);
    Object.assign(CM, { vis: true, app, threads: [], loaded: false, open: null, view: null, headSig: "", roomsSig: "", chatSig: "", tab: dm ? "dm" : "comments" }); CM.seq++;
    Object.assign(DM, { open: null, view: null }); DM.seq++;
    cmPaintAll(); cmLoad();
    if (CM.tab === "dm") dmRefresh();
    clearInterval(CM.timer);
    // A peer's comments do not stream here (its events are its own), so its pane is read again on a short timer.
    CM.timer = setInterval(() => { if (document.visibilityState === "visible") { cmLoad(); if (CM.open) cmReload(); } }, CM.pc ? 15000 : 60000);
  } else if (!shown && CM.vis) {
    CM.vis = false; CM.open = null; DM.open = null; CM.seq++; DM.seq++; clearInterval(CM.timer);
  }
  bkCmSync();
}
cmLoadSources();
