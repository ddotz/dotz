/* ---------- the mailbox of the mail app: read / unread, star, 완료(보관), 삭제 on one mail or a selection, the floating 메일 쓰기 and the inline reply ---------- */
// The page asks the hub, never the mail account: POST /api/mail/<key>/action {action} -> {ok, synced, note?} for one mail and POST /api/mail/actions {keys, action}
// -> {ok, results:[{key, ok, synced, note?}]} for a selection (action = read | unread | archive | unarchive | trash | star | unstar). Every action is optimistic:
// the row changes at once and goes back when the hub says ok:false (or cannot be reached); the hub's note is told once.
// A mail card says what its mailbox can do in `can` (GET /api/conversations items[].mail); an action it does not list is a disabled button with one short line.
// A card with no `can` at all (a hub that does not know the field) can only be deleted, through the old DELETE /api/mail/<key>.
// Nothing here sends a mail: 메일 쓰기 and the inline reply save a draft (POST /api/mail/compose) and the owner's 보내기 stays on its approval card.
ICONS.star = "M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z";
ICONS.archive = "M4 6.5h16V10H4zM5.5 10v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-8M10 13.5h4";
ICONS.minus = "M6 12h12";
ICONS.inbox = "M4 13l2.2-7h11.6L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 13h4.5l1 2h5l1-2H20";
ICONS.forward = "M15 7l5 5-5 5M20 12h-9a7 7 0 0 0-7 7";
const MB = { sel: new Set(), vis: [], boxes: new Map(), cs: null };
const mbKey = t => t.slice(5);
const MB_NOTE = { read: "이 메일함은 읽음 표시를 지원하지 않아요", unread: "이 메일함은 읽음 표시를 지원하지 않아요", archive: "이 메일함은 보관을 지원하지 않아요", unarchive: "이 메일함은 보관을 지원하지 않아요", trash: "이 메일함은 삭제를 지원하지 않아요", star: "이 메일함은 별표를 지원하지 않아요", unstar: "이 메일함은 별표를 지원하지 않아요" };
// What the mail's mailbox can do. `can` lists it; without the field only 삭제 works (the old route).
const mailCan = (t, a) => { const m = MAILS.get(t); return !!m && (Array.isArray(m.can) ? m.can.includes(a) : a === "trash"); };
// Unread: the hub's read flag when the card has one (the real mailbox's, two-way); else dotz's own read position (ts(t).unread). A sent mail is never unread.
const mailUnread = (t, m = MAILS.get(t)) => !!m && m.dir !== "out" && (typeof m.read === "boolean" ? !m.read : (ts(t).unread | 0) > 0);
const mbRefresh = () => { MON.sig = ""; MON.side = ""; monSchedule(); mbPaintBar(); };

// The change an action makes to the page's copy of the mail; the returned function puts it back.
function mbApply(t, a) {
  const m = MAILS.get(t);
  if (!m) return () => {};
  const was = { read: m.read, archived: m.archived, starred: m.starred }, unread = ts(t).unread, conv = CONV.get(t);
  if (a === "read") { m.read = true; ts(t).unread = 0; }
  else if (a === "unread") m.read = false;
  else if (a === "archive" || a === "unarchive") m.archived = a === "archive";
  else if (a === "star" || a === "unstar") m.starred = a === "star";
  else if (a === "trash") { MAILS.delete(t); CONV.delete(t); MB.sel.delete(t); }
  return () => { Object.assign(m, was); ts(t).unread = unread; if (a === "trash") { MAILS.set(t, m); if (conv) CONV.set(t, conv); } };
}
const MB_DONE = { read: "읽음으로 표시했어요", unread: "안 읽음으로 표시했어요", archive: "보관했어요", unarchive: "받은편지함으로 옮겼어요", trash: "삭제했어요", star: "별표를 달았어요", unstar: "별표를 뺐어요" };
const MB_BACK = { archive: "unarchive", unarchive: "archive", read: "unread", unread: "read", star: "unstar", unstar: "star" };
// Runs one action on `keys` (mail targets). Resolves the keys that went through.
async function mbRun(keys, action, quiet = false) {
  keys = keys.filter(t => mailCan(t, action));
  if (!keys.length) return [];
  const legacy = action === "trash" && keys.some(t => !Array.isArray(MAILS.get(t).can));
  const undo = new Map(keys.map(t => [t, mbApply(t, action)]));
  mbRefresh();
  let res;
  try {
    if (legacy) { res = []; for (const t of keys) { await api(`/api/mail/${mbKey(t)}`, "DELETE"); res.push({ key: t, ok: true, synced: false }); } }
    else if (keys.length === 1) { const r = await api(`/api/mail/${mbKey(keys[0])}/action`, "POST", { action }); res = [{ ...r, key: keys[0] }]; }
    else {
      const r = await api("/api/mail/actions", "POST", { keys: keys.map(mbKey), action });
      const by = new Map((r && r.results || []).map(x => [String(x.key).startsWith("mail:") ? x.key : `mail:${x.key}`, x]));
      res = keys.map(t => by.get(t) || { key: t, ok: !!(r && r.ok !== false) });
    }
  } catch (e) { res = keys.map(t => ({ key: t, ok: false, note: e && /^HTTP 404/.test(e.message) ? "서버가 아직 이 작업을 지원하지 않아요" : (e && e.message) || "처리하지 못했어요" })); }
  const done = res.filter(x => x.ok !== false).map(x => x.key);
  for (const x of res) if (x.ok === false && undo.has(x.key)) undo.get(x.key)();
  mbRefresh();
  const note = (res.find(x => x.ok === false && x.note) || res.find(x => x.note) || {}).note;
  if (!quiet && note) toast(note, res.some(x => x.ok === false));
  else if (!quiet && res.some(x => x.ok === false)) toast("처리하지 못했어요", true);
  else if (!quiet && done.length && MB_DONE[action]) toast(done.length > 1 ? `${done.length}개를 ${MB_DONE[action]}` : MB_DONE[action], false, MB_BACK[action] && action !== "trash" && !/star$/.test(action) ? { label: "되돌리기", onclick: () => mbRun(done, MB_BACK[action]) } : undefined);
  if (legacy) for (const t of done) PQ.of.delete(t);
  Promise.allSettled([convLoad(), loadIntegrations()]);
  return done;
}
// 삭제 asks first. A mail whose mailbox lists no `can` is only dropped from dotz (the real mailbox keeps it), as before.
async function mbTrash(keys) {
  keys = keys.filter(t => mailCan(t, "trash"));
  if (!keys.length) return [];
  const real = keys.every(t => Array.isArray(MAILS.get(t).can));
  if (!await ask("메일 삭제", real ? `메일 ${keys.length}개를 삭제할까요? 실제 메일함에서도 휴지통으로 가요` : `${keys.length > 1 ? `메일 ${keys.length}개를` : "이 메일을"} 목록에서 지울까요? 실제 메일함의 메일은 그대로 있어요`, "삭제", true)) return [];
  const done = await mbRun(keys, "trash");
  mbLeave(keys);
  return done;
}
// An action on the open mail takes the owner back to the list (like the mailbox does) when the mail left it.
const mbLeave = keys => { if (monCtx && keys.includes(monCtx) && current === "chat" && !MAILS.has(monCtx)) go("monitoring", MON.sel); };

/* ---------- the row: checkbox, star, the bold of an unread mail ---------- */
const mbBtn = (label, ic, onclick, o = {}) => el("button", { class: `mb-b${o.cls ? ` ${o.cls}` : ""}`, type: "button", "data-k": o.k, title: label, "aria-label": label, disabled: !!o.off, onclick }, icon(ic), el("span", { class: "mb-bt", text: label }));
// Star: a button while the mailbox has stars, else a quiet mark that only shows the state.
function mbStar(t) {
  const m = MAILS.get(t) || {}, on = !!m.starred, can = mailCan(t, on ? "unstar" : "star");
  const mark = icon("star", on ? "on" : "");
  if (!can) return el("span", { class: `mr-star${on ? " on" : ""}`, "data-k": "mail-star", role: "img", "aria-label": on ? "별표 있음" : "별표 없음" }, mark);
  return el("button", { class: `mr-star${on ? " on" : ""}`, type: "button", "data-k": "mail-star", "aria-pressed": String(on), "aria-label": on ? "별표 빼기" : "별표 달기", title: on ? "별표 빼기" : "별표 달기",
    onclick: ev => { ev.stopPropagation(); mbRun([t], on ? "unstar" : "star", true).then(() => {}); }, onkeydown: ev => ev.stopPropagation() }, mark);
}
// The leading cells of a mail row's header: ☐ and ☆. Ticking a row repaints the bar only, never the list.
function mbLead(t, title) {
  const chk = el("input", { class: "mr-chk", type: "checkbox", "data-k": "mail-select", "aria-label": `${title} 선택`, checked: MB.sel.has(t),
    onclick: ev => ev.stopPropagation(), onkeydown: ev => ev.stopPropagation(), onchange: ev => { if (ev.target.checked) MB.sel.add(t); else MB.sel.delete(t); const row = ev.target.closest(".mr"); if (row) row.classList.toggle("sel", ev.target.checked); mbPaintBar(); } });
  return el("span", { class: "mr-lead" }, chk, mbStar(t));
}

/* ---------- the bar above the list: select all, and the actions of the selection ---------- */
const mbBar = () => el("div", { class: "mb-bar", id: "mb-bar" });
function mbPaintBar() {
  const bar = document.getElementById("mb-bar");
  if (!bar) return;
  const keys = [...MB.sel].filter(t => MAILS.has(t)), all = MB.vis.length > 0 && MB.vis.every(t => MB.sel.has(t));
  const chk = el("input", { class: "mb-all", type: "checkbox", "aria-label": "모두 선택", "data-k": "mail-select-all", checked: all, disabled: !MB.vis.length, onchange: ev => {
    if (ev.target.checked) MB.vis.forEach(t => MB.sel.add(t)); else MB.sel.clear();
    document.querySelectorAll("#mon-tl .mr .mr-chk").forEach(c => { c.checked = ev.target.checked; c.closest(".mr").classList.toggle("sel", ev.target.checked); });
    mbPaintBar();
  } });
  chk.indeterminate = !all && keys.length > 0;
  if (!keys.length) { clear(bar).append(chk, el("span", { class: "mb-n", text: MB.vis.length ? `메일 ${MB.vis.length}개` : "" })); bar.classList.remove("on"); return; }
  const arch = mailFilterOf()[0] === "archived", can = a => keys.every(t => mailCan(t, a));
  const acts = [["read", "읽음으로 표시", "check"], ["unread", "안읽음으로 표시", "mail"], arch ? ["unarchive", "받은편지함으로", "inbox"] : ["archive", "완료(보관)", "archive"], ["trash", "삭제", "trash"]];
  const off = acts.find(([a]) => !can(a));
  bar.classList.add("on");
  clear(bar).append(chk, el("span", { class: "mb-n", "aria-live": "polite", text: `${keys.length}개 선택` }),
    ...acts.map(([a, label, ic]) => mbBtn(label, ic, () => (a === "trash" ? mbTrash(keys) : mbRun(keys, a)).then(() => mbPaintBar()), { off: !can(a), k: `mail-${a}` })),
    el("button", { class: "mb-b mb-x", type: "button", "aria-label": "선택 해제", title: "선택 해제", onclick: () => { MB.sel.clear(); document.querySelectorAll("#mon-tl .mr.sel").forEach(r => { r.classList.remove("sel"); const c = r.querySelector(".mr-chk"); if (c) c.checked = false; }); mbPaintBar(); } }, icon("close")),
    off ? el("div", { class: "mb-note", role: "status", text: MB_NOTE[off[0]] }) : null);
}
// The visible mails of the list (select all) and the bar itself, at the head of the rows.
function mbList(vis) {
  MB.vis = vis;
  for (const t of [...MB.sel]) if (!vis.includes(t)) MB.sel.delete(t);
  const bar = mbBar();
  queueMicrotask(mbPaintBar);
  return bar;
}

/* ---------- the open mail: the same actions in its head ---------- */
function mailOpenBar(t) {
  const m = MAILS.get(t) || {}, unread = mailUnread(t, m), arch = !!m.archived;
  const acts = [m.dir === "out" ? null : unread ? ["read", "읽음으로 표시", "check"] : ["unread", "안읽음으로 표시", "mail"], arch ? ["unarchive", "받은편지함으로", "inbox"] : ["archive", "완료(보관)", "archive"], ["trash", "삭제", "trash"]].filter(Boolean);
  const off = acts.find(([a]) => !mailCan(t, a));
  return el("div", { class: "mb-open", role: "group", "aria-label": "메일 처리" },
    ...acts.map(([a, label, ic]) => mbBtn(label, ic, ev => {
      const b = ev.currentTarget;
      busy(b, async () => {
        const done = a === "trash" ? await mbTrash([t]) : await mbRun([t], a);
        if (done.length && a !== "trash" && a !== "read") { MB.sel.delete(t); if (monCtx === t && current === "chat") go("monitoring", MON.sel); }
      });
    }, { off: !mailCan(t, a), k: `mail-open-${a}` })),
    off ? el("div", { class: "mb-note", role: "status", text: MB_NOTE[off[0]] }) : null);
}

/* ---------- 메일 쓰기: the floating button and its sheet ---------- */
const mbFab = () => el("button", { class: "mb-fab", type: "button", "data-k": "mail-compose", "aria-label": "메일 쓰기", title: "메일 쓰기", onclick: () => mbCompose() }, icon("pencil"), el("span", { class: "mb-fab-t", text: "메일 쓰기" }));
const mbSize = f => mailSize(f.size) || "";
// The attachments as chips: name and size, a × to take one off. `files` is the draft's own list, so the chips survive a failed save and a reopen.
function mbChips(files, onRemove, busyNames = []) {
  return el("div", { class: "mb-files", "aria-label": "첨부파일" }, ...files.map((f, i) => el("span", { class: "mb-chip", "data-name": f.name, title: f.name },
    icon("clip"), el("span", { class: "mb-cn", text: f.name }), mbSize(f) ? el("span", { class: "mb-cs", text: mbSize(f) }) : null,
    el("button", { class: "mb-cx", type: "button", "aria-label": `${f.name} 빼기`, onclick: () => onRemove(i) }, icon("close")))),
    ...busyNames.map(n => el("span", { class: "mb-chip wait", title: n }, icon("clip"), el("span", { class: "mb-cn", text: n }), el("span", { class: "mb-cs", text: "올리는 중…" }))));
}
// A form state {to, cc, subject, body, files, up:[names being uploaded]} painted into `host`; the fields write straight into the state, so a repaint keeps them.
function mbForm(st, host, o) {
  const field = (k, label, ph, extra = {}) => el("label", { class: `mb-f mb-f-${k}` }, el("span", { class: "mb-fk", text: label }),
    el("input", { class: "mb-in", type: "text", value: st[k], placeholder: ph, "data-k": `mail-${k}`, "aria-label": label, autocomplete: "off", spellcheck: "false", oninput: ev => { st[k] = ev.target.value; }, ...extra }));
  const picker = el("input", { type: "file", multiple: true, hidden: true, "aria-label": "파일 고르기" });
  const files = el("div", { class: "mb-fw" });
  const paintFiles = () => clear(files).append(mbChips(st.files, i => { st.files.splice(i, 1); paintFiles(); }, st.up));
  const add = async list => {
    for (const f of list) {
      st.up.push(f.name); paintFiles();
      try { const u = await uploadFile(f); st.files.push({ name: u.name, path: u.path, size: u.size, type: u.type }); }
      catch (e) { toast(e.message || "올리지 못했어요", true); }
      st.up.splice(st.up.indexOf(f.name), 1); paintFiles();
    }
  };
  picker.onchange = () => { const list = [...picker.files]; picker.value = ""; add(list); };
  const body = el("textarea", { class: "mb-ta fi", rows: o.rows || "7", placeholder: o.placeholder || "내용", "data-k": "mail-body", "aria-label": "내용", oninput: ev => { st.body = ev.target.value; } });
  body.value = st.body;
  const ccRow = field("cc", "참조", "참조 (쉼표로 나눠요)");
  ccRow.hidden = !st.cc && !st.showCc;
  const ccBtn = el("button", { class: "mb-cc", type: "button", "aria-label": "참조 추가", onclick: () => { st.showCc = true; ccRow.hidden = false; ccBtn.hidden = true; ccRow.querySelector("input").focus(); } }, "참조");
  ccBtn.hidden = !ccRow.hidden;
  const to = field("to", "받는 사람", "받는 사람 (쉼표로 나눠요)");
  to.append(ccBtn);
  paintFiles();
  clear(host).append(to, ccRow, field("subject", "제목", "제목"), body, o.quote || null, files, picker);
  return { pick: () => picker.click(), body, files: paintFiles };
}
const mbPayload = (st, extra = {}) => ({ to: st.to.trim(), cc: st.cc.trim(), subject: st.subject.trim(), body: st.body, attachments: st.files.map(f => ({ name: f.name, path: f.path, size: f.size })), ...extra });
const mbEmpty = st => !st.to.trim() && !st.cc.trim() && !st.subject.trim() && !st.body.trim() && !st.files.length;
async function mbSave(st, extra, btn) {
  if (!st.to.trim()) { toast("받는 사람을 적어 주세요", true); return null; }
  if (st.up.length) { toast("파일을 올리는 중이에요. 끝나면 다시 눌러 주세요", true); return null; }
  let r = null;
  await busy(btn, async () => {
    try { r = await api("/api/mail/compose", "POST", mbPayload(st, extra)); }
    catch (e) { toast(e && /^HTTP 404/.test(e.message) ? "서버가 아직 새 메일 초안을 지원하지 않아요" : (e && e.message) || "초안을 만들지 못했어요", true); }
  });
  if (r && r.error) { toast(r.error, true); return null; }
  if (r) { toast("초안을 만들었어요. 보내기는 승인 카드에서 눌러 주세요"); loadNotices(); }
  return r;
}
// The floating sheet: docked at the bottom right of a wide screen (minimize / close), the whole screen on a phone. Closing a sheet with text asks first.
function mbCompose(init = {}) {
  if (MB.cs && MB.cs.node.isConnected) { MB.cs.node.classList.remove("min"); MB.cs.node.querySelector(".mb-in").focus(); return; }
  const st = { to: "", cc: "", subject: "", body: "", files: [], up: [], showCc: false, ...init };
  const host = el("div", { class: "mb-sb" });
  const form = mbForm(st, host, { rows: "10" });
  const node = el("div", { class: "mb-sheet", role: "dialog", "aria-label": "새 메일" });
  const close = async () => { if (!mbEmpty(st) && !await ask("작성 중인 메일", "쓰던 내용을 버릴까요?", "버리기", true)) return; node.remove(); MB.cs = null; };
  const save = ev => mbSave(st, {}, ev.currentTarget).then(r => { if (r) { node.remove(); MB.cs = null; } });
  node.append(
    el("div", { class: "mb-sh" }, el("span", { class: "mb-st", text: "새 메일" }),
      el("button", { class: "ib mb-min", type: "button", "aria-label": "최소화", title: "최소화", onclick: () => node.classList.toggle("min") }, icon("minus")),
      el("button", { class: "ib mb-close", type: "button", "aria-label": "닫기", title: "닫기", onclick: close }, icon("close"))),
    host,
    el("div", { class: "mb-sf" }, el("button", { class: "btn pri mb-save", type: "button", "data-k": "mail-compose-save", onclick: save }, "초안 만들기"),
      el("button", { class: "ib mb-attach", type: "button", "aria-label": "파일 붙이기", title: "파일 붙이기", onclick: () => form.pick() }, icon("clip")),
      el("span", { class: "mb-hint", text: "보내기는 승인 카드에서 해요" })));
  document.body.append(node);
  MB.cs = { node, st };
  node.querySelector(".mb-in").focus();
}

/* ---------- the inline reply at the bottom of the open mail ---------- */
const MB_MODES = [["reply", "답장", "reply"], ["all", "전체답장", "reply"], ["forward", "전달", "forward"]];
const mbRe = (p, s) => (new RegExp(`^\\s*${p}\\s*:`, "i").test(s) ? s : `${p}: ${s}`);
const mbAddrs = v => mailAddrList(v).map(a => a.addr || a.name);
// To / Cc / subject of a mode, from the mail's card.
function mbDefaults(t, mode) {
  const m = MAILS.get(t) || {}, subj = m.subject || "";
  if (mode === "forward") return { to: "", cc: "", subject: mbRe("Fwd", subj) };
  const to = m.dir === "out" ? mbAddrs(m.to) : mbAddrs(m.from);
  const cc = mode === "all" ? [...mbAddrs(m.dir === "out" ? "" : m.to), ...mbAddrs(m.cc)].filter(a => !to.includes(a)) : [];
  return { to: to.join(", "), cc: [...new Set(cc)].join(", "), subject: mbRe("Re", subj) };
}
// The original, as the quote under the reply: the 원문 of the mail's first message the page holds.
function mbQuoteText(t) {
  const e = ts(t).msgs.find(x => x.kind === "mail"), raw = String(e ? e.text : "");
  const at = raw.indexOf("\n원문\n");
  return (at >= 0 ? raw.slice(at + 4) : raw.split("\n").slice(1).join("\n")).trim();
}
function mbBox(t) {
  let b = MB.boxes.get(t);
  if (!b) { b = { open: false, mode: "reply", st: null }; MB.boxes.set(t, b); }
  return b;
}
function mbOpenReply(t, mode) {
  const b = mbBox(t), m = MAILS.get(t) || {};
  const keep = b.st ? { body: b.st.body, files: b.st.files } : { body: "", files: [] };
  b.open = true; b.mode = mode;
  b.st = { ...mbDefaults(t, mode), showCc: mode === "all", up: [], ...keep };
  if (mode === "forward" && !b.st.body) b.st.body = `\n\n---------- 전달한 메일 ----------\n보낸 사람: ${m.from || ""}\n제목: ${m.subject || ""}\n\n${mbQuoteText(t)}`;
  mbReplyPaint(true);
}
function mbReplyPaint(force) {
  if (typeof tl === "undefined" || !tl) return;
  const t = target, ok = current === "chat" && isMailT(t) && MAILS.has(t) && !!tl.querySelector(".mhd-wrap");
  let slot = tl.querySelector(":scope > .mb-reply");
  if (!ok) { if (slot) slot.remove(); return; }
  const b = mbBox(t), sig = JSON.stringify([t, b.open, b.mode]);
  if (slot && slot.dataset.sig === sig && !force && slot.isConnected && slot === tl.lastElementChild) return;
  if (slot) slot.remove();
  slot = el("section", { class: `mb-reply${b.open ? " open" : ""}`, "aria-label": "답장 쓰기", "data-sig": sig });
  if (!b.open) {
    slot.append(el("div", { class: "mb-modes" }, ...MB_MODES.map(([k, label, ic]) => el("button", { class: "cchip mb-mode", type: "button", "data-mode": k, onclick: () => mbOpenReply(t, k) }, icon(ic), label))));
  } else {
    const host = el("div", { class: "mb-rb" }), quote = mbQuoteText(t);
    const q = quote ? el("details", { class: "mb-quote" }, el("summary", { text: "이전 메일 보기" }), el("pre", { class: "mb-qt", text: quote })) : null;
    const form = mbForm(b.st, host, { rows: "6", placeholder: "답장 내용", quote: q });
    slot.append(
      el("div", { class: "mb-modes" }, ...MB_MODES.map(([k, label, ic]) => el("button", { class: `cchip mb-mode${k === b.mode ? " on" : ""}`, type: "button", "data-mode": k, "aria-pressed": String(k === b.mode), onclick: () => mbOpenReply(t, k) }, icon(ic), label))),
      host,
      el("div", { class: "mb-sf" },
        el("button", { class: "btn pri mb-save", type: "button", "data-k": "mail-reply-save", onclick: ev => mbSave(b.st, { reply_to: mbKey(t), mode: b.mode }, ev.currentTarget).then(r => { if (r) { MB.boxes.delete(t); mbReplyPaint(true); } }) }, "초안 만들기"),
        el("button", { class: "ib mb-attach", type: "button", "aria-label": "파일 붙이기", title: "파일 붙이기", onclick: () => form.pick() }, icon("clip")),
        el("button", { class: "btn text sm mb-cancel", type: "button", onclick: () => { b.open = false; mbReplyPaint(true); } }, "접기"),
        el("span", { class: "mb-hint", text: "보내기는 승인 카드에서 해요" })));
  }
  tl.append(slot);
}
