/* ---------- decision card: a question that waits on the owner, docked above the composer ---------- */
// Choice block (MODE.md "Message layout"): `**1) name** ← 추천`, then one description line; a `결정:` line titles a block.
// Several blocks = several decisions: the card walks them one at a time and sends the numbers as "1-2".
const CH_OPT = /^\s*(?:\*\*)?\s*(\d+)\)\s*(.+?)\s*(?:\*\*)?\s*(←\s*(?:추천|recommended)|\(\s*(?:추천|recommended)\s*\))?\s*(?:\*\*)?\s*$/i;
const CH_HEAD = /^\s*(?:\*\*)?\s*(?:결정|decision(?: needed)?)(?:\s*#?\d{1,2})?\s*[:：]\s*(.*?)\s*(?:\*\*)?\s*$/i;
const CH_CLOSE = /번호(?:로|를).*(?:답|알려)/;
// An option that needs detail (tap opens a text field; the answer goes out as `n) label - <text>`): the bot marks it with a trailing ` …` on the name
// (stripped from the label), or it is guessed from a negative / edit label or a description that asks for text. Mirrors hub/choices.ts detailOf.
const DETAIL_MARK = /\s*…\s*$/, DETAIL_LABEL = /^(?:안\s*됨|안\s*돼|아니|아냐|고치기|수정|다른)/, DETAIL_DESC = /(?:적어|알려|써|말해)\s*(?:주|줘|달라|세요)|내용.*(?:적|알려|써)/;
const detailOf = o => !!o.detail || DETAIL_LABEL.test(o.label) || DETAIL_DESC.test(o.desc || "");
const isDescLine = nx => nx !== undefined && !!nx.trim() && !CH_OPT.test(nx) && !CH_HEAD.test(nx) && !CH_CLOSE.test(nx);
// The message text without its option lines (and their description lines): the buttons show them, so the body must not repeat them.
function stripChoices(text) {
  const lines = String(text ?? "").split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CH_OPT.test(lines[i])) { out.push(lines[i]); continue; }
    if (isDescLine(lines[i + 1])) i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
function parseChoices(text) {
  const OPT = CH_OPT, HEAD = CH_HEAD;
  const lines = String(text ?? "").replace(/^\s*\[[^\]\n]+\][ \t]*/, "").split("\n");
  let i = 0, question = "", cur = null;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && !OPT.test(lines[i]) && !HEAD.test(lines[i])) question = lines[i++].trim();
  const blocks = [];
  for (; i < lines.length; i++) {
    const h = HEAD.exec(lines[i]);
    if (h) { cur = { title: h[1].trim(), options: [], headed: true }; blocks.push(cur); continue; }
    const m = OPT.exec(lines[i]);
    if (!m) continue;
    const n = Number(m[1]);
    if (!cur || (cur.options.length && n <= cur.options[cur.options.length - 1].n)) { cur = { title: "", options: [] }; blocks.push(cur); }
    let desc = "";
    const nx = lines[i + 1];
    if (isDescLine(nx)) { desc = nx.trim(); i++; }
    const raw = m[2].replace(/^\*+|\*+$/g, "").trim();
    cur.options.push({ n, label: raw.replace(DETAIL_MARK, "").trim(), desc, rec: !!m[3], ...(DETAIL_MARK.test(raw) ? { detail: true } : {}) });
  }
  return { question, blocks: blocks.filter(b => b.options.length) };
}
// Buttons for a message with the [ask] marker, or with any other marker (or none) when it holds a "결정:" choice block of 2+ options
// (same rule as hub/notices.ts decisionsOf): a plain reply with a bare "1)" list stays text. The gateway's own alert keeps its looser rule.
const isChoiceMsg = pc => pc.blocks.some(b => b.options.length > 1);
const isHeadedChoice = pc => pc.blocks.some(b => b.headed && b.options.length > 1);
const choiceAsks = (e, tone, pc) => tone === "ask" || isHeadedChoice(pc) || (e.kind === "out" && e.source === "gateway" && e.target === "alert" && isChoiceMsg(pc));
const DC = { cur: null, picks: {}, step: {}, fold: {}, st: {}, edit: {}, note: {} };
// A draft waiting for send approval (hub/draft-approval.ts): the notice carries it, the sheet shows it above 보내기 / 고치기 / 보내지 않기.
const DRAFT_EDIT = "고치기";
const hashOf = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
// What the target waits on: a session's pendingAsk, else its last bot message when that is an [ask] with a choice block and no
// owner message came after it. Null when nothing waits (so the card goes away once the answer lands).
function decisionOf(t) {
  if (!S) return null;
  const info = targetInfo(t), s = ts(t);
  if (isLaneT(t) && info.known && !info.alive && !info.resumable) return null;
  let raw = "", at = "";
  if (info.ask) { raw = String(info.ask.text); at = info.ask.at || ""; }
  else {
    for (let k = s.msgs.length - 1; k >= 0; k--) {
      const e = s.msgs[k];
      if (OWNER.has(e.kind)) return null;
      // An alert or worklog post is not part of the conversation: it never cancels a question that still waits (the real case: a token-audit
      // alert and the night worklog landed after a decision, the card went away and the buttons greyed while the notice still held it open).
      if ((e.kind !== "out" && e.kind !== "lane_report") || e.update_key) continue;
      const p = parseTone(noHandoff(String(e.text ?? ""))), choice = choiceAsks(e, p.tone, parseChoices(p.text));
      // In 알림 / 작업 기록 an ordinary post is not a reply: it never cancels a question that still waits above it.
      if (isFixedT(t) && p.tone !== "ask" && !choice) continue;
      // A session's own message in its chat counts only as a choice block; its [ask] is the session's pendingAsk (above).
      if (typeof e.source === "string" && e.source.startsWith("lane:") && !(isLaneT(t) && p.tone !== "ask" && choice)) continue;
      if (p.tone !== "ask" && !choice) return null;
      raw = String(e.text ?? ""); at = e.ts; break;
    }
    if (!raw) return null;
  }
  const pt = parseTone(noHandoff(raw)), body = pt.text, pc = parseChoices(body);
  if (!info.ask && !pc.blocks.length) return null;
  if (at && s.msgs.some(e => OWNER.has(e.kind) && msOf(e.ts) > msOf(at))) return null;
  const sig = hashOf(body.trim());
  // A status message ([done] ...) that ends in a choice block: its first line is the status, so the block's own title is the question.
  const question = !info.ask && pt.tone !== "ask" && pc.blocks.length === 1 && pc.blocks[0].title ? pc.blocks[0].title : pc.question;
  return { key: `${t}|${sig}`, t, sig, at, question, blocks: pc.blocks };
}
async function answerDecision(dc, text, opt, note) {
  const t = dc.t, lane = isLaneT(t) ? laneOf(t) : "";   // the card's own conversation: the notice sheet may answer for one that is not on screen
  DC.st[dc.key] = "sending"; paintDecision();
  try {
    // A card with one block whose question is a decision notice answers through the notice path (30-notices.js), so both stay in step.
    const nd = opt && dc.blocks.length === 1 ? ntFor(t, dc.at, opt) : null;
    if (nd) await ntPost(nd, opt.n, note);
    // The agent gets the question with each chosen option and the asking message (hub/intake.ts decisionLines); the bubble stays short.
    const pk = DC.picks[dc.key] || [], picks = dc.blocks.flatMap((b, i) => (pk[i] ? [{ q: b.title || dc.question || "", n: pk[i].n, label: pk[i].label, ...(pk[i].note && !dc.draft ? { note: pk[i].note } : {}) }] : []));
    const r = nd ? null : await api("/api/message", "POST", { text, ...(picks.length ? { picks } : {}), ...(dc.at ? { reply_to: dc.at } : {}), ...(lane ? { lane } : {}), ...(isProjT(t) ? { project: projOf(t) } : {}), ...(isMailT(t) ? { mail: mailOf(t) } : {}), ...(isFixedT(t) ? { conv: t } : {}), ...(isWorking(t) ? { mode: "steer" } : {}) });
    if (r && r.queued) { QUEUE = QUEUE.filter(i => i.id !== r.queued.id).concat(r.queued); renderQueue(); }
    DC.st[dc.key] = "sent"; delete DC.edit[dc.key]; delete DC.note[dc.key];
    if (t === target) { chatStick = true; scrollChat(true); }
  } catch (e) { delete DC.st[dc.key]; toast(e.message, true); }   // the picks stay, so a retry does not start the card over
  paintDecision();
}
// A draft asks for text on 고치기 only; any other decision on an option that needs detail (안 됨 …): what to change / why is typed first, nothing is sent before.
const needsNote = (dc, opt) => (dc.draft ? opt.label === DRAFT_EDIT : detailOf(opt));
const pickSay = o => `${o.n}) ${o.label}${o.note ? ` - ${o.note}` : ""}`;
function pickOption(dc, bi, opt, note) {
  if (DC.st[dc.key]) return;
  if (dc.draft && (dc.draft.warning || (dc.draft.attachments || []).length) && opt.label === "보내기" && !opt.sure) { drfSure(dc.draft, dc.t).then(ok => { if (ok) pickOption(dc, bi, { ...opt, sure: true }, note); }); return; }
  if (!note && needsNote(dc, opt)) { DC.edit[dc.key] = { bi, opt }; paintDecision(); return; }
  const p = DC.picks[dc.key] || [];
  DC.picks[dc.key] = p;
  p[bi] = note ? { ...opt, note } : opt;
  delete DC.edit[dc.key]; delete DC.note[dc.key];
  const next = dc.blocks.findIndex((_, i) => !p[i]);
  if (next >= 0) { DC.step[dc.key] = next; paintDecision(); return; }
  answerDecision(dc, dc.blocks.length === 1 ? pickSay(p[0]) : `결정 답: ${dc.blocks.map((_, i) => pickSay(p[i])).join(" · ")}`, dc.blocks.length === 1 ? p[0] : undefined, dc.blocks.length === 1 ? note : undefined);
}
// The files a draft sends along (hub/draft-approval.ts `> 첨부:` lines): one row per file, the row opens the file that will go out
// (GET /api/drafts/<ref>/files/<n>, hub/draft-files.ts; through the peer proxy for a peer's draft). `첨부 없음` = the mail it answers had
// files and this reply carries none; `warning` = the text says it sends a file but none is set (it goes away once a file is added).
// A mail reply draft of reply-drafts can change its files here (hub/draft-attach.ts): 파일 추가 = a file of this device or of the mail
// app's 첨부 파일 폴더, x = take one off. The live list (DRF.st) replaces the one written in the message. o.t = the draft's conversation
// (a peer's draft is changed on its own computer), o.edit false = read only, o.warn = a box the warning is drawn into instead of under the files.
const DR_IMG = /\.(png|jpe?g|gif|webp|avif|heic)$/i;
const DRF = { st: {}, pc: {}, menu: {}, lib: {}, busy: {} };
const DRF_WIRE_MAX = 10 * 1024 * 1024;
const drfPath = (ref, tail) => `/api/drafts/${enc(ref)}/${tail}`;
const drfNone = { files: [], canAttach: false, library: false, editable: false, failed: true };
async function drfLoad(ref) { try { const r = await api(drfPath(ref, "files")); DRF.st[ref] = r && Array.isArray(r.files) ? r : drfNone; } catch { DRF.st[ref] = drfNone; } }
async function drfWrite(ref, body) {
  const r = await api(drfPath(ref, "files"), "POST", body);
  DRF.st[ref] = { files: r.files, canAttach: r.canAttach, library: r.library, editable: r.editable };
}
const drfBase64 = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = () => no(r.error); r.readAsDataURL(f); });
async function drfUpload(ref, f) {
  if (DRF.pc[ref]) {
    if (f.size > DRF_WIRE_MAX) throw new Error("다른 컴퓨터의 초안에는 10MB 이하 파일만 붙일 수 있어요");
    return drfWrite(ref, { name: f.name, data: await drfBase64(f) });
  }
  const form = new FormData();
  form.append("file", f, f.name);
  const r = await fetch("/api/upload", { method: "POST", body: form }), d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `올리지 못했어요 (HTTP ${r.status})`);
  return drfWrite(ref, { upload: d.files[0] });
}
// 보내기 on a draft whose mail account cannot send files: the owner is asked once more (resolves true to go on).
async function drfSure(d, t) {
  const ref = d.ref;
  if (!ref || d.toLabel !== "받는이") return true;
  if (!DRF.st[ref]) { DRF.pc[ref] = t ? pqPc(t) : null; await drfLoad(ref); }
  const st = DRF.st[ref];
  if (st.tracked === false && (d.attachments || []).length) return ask("첨부파일을 확인하지 못했어요", "이 초안의 파일은 dotz가 붙인 파일이 아니라서, 실제로 함께 가는지 확인하지 못했어요. 그래도 보낼까요?", "그래도 보내기");
  return !(st.editable && !st.canAttach && (st.files.length || d.warning)) || ask("첨부파일 없이 보낼까요?", "이 메일 계정은 첨부파일을 보낼 수 없어요. 본문만 보내져요.", "그래도 보내기");
}
function draftFilesNode(d, o = {}) {
  const ref = d.ref, box = el("div", { class: "dr-files" });
  if (ref) DRF.pc[ref] = o.t ? pqPc(o.t) : null;
  const pickers = el("input", { type: "file", multiple: true, hidden: true, "aria-label": "파일 고르기" });
  const run = async job => {
    DRF.busy[ref] = true; paint();
    try { await job(); } catch (e) { toast(e instanceof TypeError ? "연결이 끊겨 처리하지 못했어요" : e.message, true); }
    DRF.busy[ref] = false; paint();
  };
  pickers.onchange = () => { const list = [...pickers.files]; pickers.value = ""; run(async () => { for (const f of list) await drfUpload(ref, f); DRF.menu[ref] = ""; }); };
  const openLib = async () => {
    DRF.menu[ref] = DRF.menu[ref] === "lib" ? "" : "lib"; paint();
    if (DRF.menu[ref] !== "lib" || DRF.lib[ref]) return;
    try { DRF.lib[ref] = (await api(drfPath(ref, "library"))).items; } catch (e) { DRF.lib[ref] = []; toast(e.message, true); }
    paint();
  };
  function paint() {
    const st = ref ? DRF.st[ref] : null, live = !!st && !st.failed && st.tracked !== false;
    // Files named in the message that dotz did not stage itself: shown, with a line saying it could not check they go out.
    const unchecked = !!st && st.tracked === false && Array.isArray(d.attachments) && d.attachments.length > 0;
    const fl = live ? st.files : Array.isArray(d.attachments) ? d.attachments : [];
    const can = live && st.editable && o.edit !== false, busy = !!DRF.busy[ref];
    const warn = d.warning && !fl.length;
    const noSend = live && st.editable && !st.canAttach && (fl.length || d.warning);
    const warns = [
      warn ? el("div", { class: "dr-warn", role: "alert" }, icon("clip"), el("span", { class: "dr-wt" }, el("span", { text: d.warning }), d.note ? el("span", { class: "dr-wn", text: d.note }) : null)) : null,
      noSend ? el("div", { class: "dr-none" }, icon("clip"), el("span", { text: "이 메일 계정은 첨부파일을 보낼 수 없어요 · 본문만 보내져요" })) : null,
      unchecked ? el("div", { class: "dr-warn", role: "alert" }, icon("clip"), el("span", { class: "dr-wt" }, el("span", { text: "첨부파일이 실제로 붙었는지 확인하지 못했어요" }), el("span", { class: "dr-wn", text: "dotz가 붙인 파일이 아니에요. 보내기 전에 확인해 주세요" }))) : null];
    const rows = fl.map((f, i) => {
      const ext = (String(f.name).match(/\.([A-Za-z0-9]{1,5})$/) || [0, ""])[1].toUpperCase(), meta = [ext, f.size].filter(Boolean).join(" · ");
      const kids = [el("span", { class: "dr-fi" }, icon(DR_IMG.test(f.name) ? "image" : "file")), el("span", { class: "dr-fn", text: f.name }), meta ? el("span", { class: "dr-fm", text: meta }) : null];
      const link = ref ? el("a", { class: "dr-att", href: pqLink(drfPath(ref, `files/${i}`)), target: "_blank", rel: "noopener", title: `${f.name} 열기`, "aria-label": `${f.name} 열기${f.size ? ` (${f.size})` : ""}` }, ...kids, icon("open")) : el("div", { class: "dr-att" }, ...kids);
      return can ? el("div", { class: "dr-ar" }, link, el("button", { class: "dr-x", type: "button", disabled: busy, title: "첨부에서 빼기", "aria-label": `${f.name} 빼기`, onclick: () => run(() => drfWrite(ref, { remove: i })) }, icon("close"))) : link;
    });
    const items = DRF.lib[ref] || [];
    const lib = can && DRF.menu[ref] === "lib" ? el("div", { class: "dr-lib", role: "list" }, ...(items.length ? items.map(it => el("button", { class: "dr-li", type: "button", role: "listitem", disabled: busy, title: it.rel, onclick: () => run(async () => { await drfWrite(ref, { library: it.rel }); DRF.menu[ref] = ""; }) },
      el("span", { class: "dr-fn", text: it.rel }), it.match ? el("span", { class: "dr-hit", text: "맞음" }) : null, el("span", { class: "dr-fm", text: it.size }))) : [el("div", { class: "dr-none", text: DRF.lib[ref] ? "폴더가 비어 있어요" : "불러오는 중…" })])) : null;
    const menu = can && DRF.menu[ref] === "menu" ? el("div", { class: "dr-menu" },
      el("button", { class: "btn tonal", type: "button", onclick: () => pickers.click() }, "이 기기에서 고르기"),
      st.library ? el("button", { class: "btn tonal", type: "button", onclick: openLib }, "첨부 파일 폴더에서 고르기") : null) : null;
    const add = can && st.canAttach ? el("button", { class: "dr-add", type: "button", disabled: busy, "aria-expanded": String(!!DRF.menu[ref]), onclick: () => { if (!st.library) pickers.click(); else { DRF.menu[ref] = DRF.menu[ref] ? "" : "menu"; paint(); } } }, icon("clip"), el("span", { text: busy ? "붙이는 중…" : "파일 추가" })) : null;
    if (o.warn) { clear(o.warn).append(...warns.filter(Boolean)); o.warn.hidden = !warns.some(Boolean); }
    // A mail draft always shows its 첨부 row, files or 없음, so the owner can tell a missing file from a hidden one (owner 2026-10-26).
    const mailDraft = d.toLabel === "받는이";
    clear(box).append(...[fl.length ? el("div", { class: "dr-fh", text: `첨부 ${fl.length}개` }) : null, ...rows,
      !fl.length && (d.noAttachments || mailDraft) ? el("div", { class: "dr-none" }, icon("clip"), el("span", { text: "첨부: 없음" })) : null,
      add, menu, lib, ...(o.warn ? [] : warns), pickers].filter(Boolean));
    box.hidden = !box.querySelector(".dr-fh, .dr-none, .dr-warn, .dr-add");
  }
  paint();
  if (ref && o.edit !== false && d.toLabel === "받는이" && !DRF.st[ref]) drfLoad(ref).then(paint);
  return box;
}
/* ---------- 받는 사람·참조 of a mail reply draft (hub/draft-recipients.ts) ---------- */
// The rows above a mail draft's body: 답장 | 전체 답장, the 받는이 chips and the 참조 chips, a tap to edit one, its x to take it off, one add field
// per row. Only a pending draft is editable (o.edit false = read only, a sent draft keeps the lines it went with). The live list is
// GET /api/drafts/<ref>/recipients and each change is one POST to the same path - through the peer proxy for a draft of the other computer -
// and the hub rewrites the approval notice, so the card in every view shows the same list. o.t = the draft's conversation.
const DRR = { st: {}, pc: {}, busy: {}, add: {}, edit: {} };
const DRR_NONE = { to: [], cc: [], mode: "reply", editable: false, reply: false, failed: true };
const drrPath = ref => `/api/drafts/${enc(ref)}/recipients`;
const drrSplit = s => String(s || "").split(/\s*,\s*/).map(a => a.trim()).filter(Boolean);
async function drrLoad(ref) { try { const r = await api(drrPath(ref)); DRR.st[ref] = r && Array.isArray(r.to) ? r : DRR_NONE; } catch { DRR.st[ref] = DRR_NONE; } }
async function drrWrite(ref, body) {
  const r = await api(drrPath(ref), "POST", body);
  DRR.st[ref] = { to: r.to || [], cc: r.cc || [], mode: r.mode || "reply", editable: !!r.editable, reply: !!r.reply };
  DRR.add[ref] = ""; DRR.edit[ref] = "";
  return DRR.st[ref];
}
function draftToNode(d, o = {}) {
  const ref = d.ref;
  // Which computer holds the draft: a peer's rows change there (the same map the 첨부 줄 uses for its own requests).
  if (ref && o.t !== undefined) DRF.pc[ref] = DRR.pc[ref] = o.t ? pqPc(o.t) : null;
  const box = el("div", { class: "dr-recv" });
  const busy = () => !!DRR.busy[ref];
  const run = async job => {
    if (!ref || DRR.busy[ref]) return;
    DRR.busy[ref] = true; paint();
    try { const st = await job(); Object.assign(d, { to: st.to.join(", ") }); if (st.cc.length) d.cc = st.cc; else delete d.cc; d.mode = st.mode; }
    catch (e) { toast(e instanceof TypeError ? "연결이 끊겨 바꾸지 못했어요" : e.message, true); }
    DRR.busy[ref] = false; paint();
  };
  const change = (row, list) => run(() => drrWrite(ref, { [row]: list }));
  const field = (label, value, done) => {
    const i = el("input", { class: "dr-rc-in", type: "email", inputmode: "email", autocomplete: "off", placeholder: label, "aria-label": label, disabled: busy() });
    i.value = value || "";
    const go = () => { const v = i.value.trim(); if (v) done(v); };
    i.onkeydown = ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); go(); } };
    return { i, go };
  };
  const editor = (label, value, done) => {
    const f = field(label, value, done);
    return el("span", { class: "dr-rc-edit" }, f.i, el("button", { class: "btn text dr-rc-go", type: "button", disabled: busy(), text: "확인", onclick: f.go }),
      el("button", { class: "btn text", type: "button", disabled: busy(), text: "취소", onclick: () => { DRR.add[ref] = ""; DRR.edit[ref] = ""; paint(); } }));
  };
  const row = (name, label, list, editable) => {
    const editing = String(DRR.edit[ref] || "");
    const chips = list.map((a, i) => (editing === `${name}:${i}`
      ? editor(name === "to" ? "받는 사람 주소" : "참조 주소", a, v => change(name, list.map((x, n) => (n === i ? v : x))))
      : el("span", { class: "dr-chip dr-rc" },
        editable ? el("button", { class: "dr-rc-t", type: "button", title: "고치기", "aria-label": `${a} 고치기`, disabled: busy(), text: a, onclick: () => { DRR.add[ref] = ""; DRR.edit[ref] = `${name}:${i}`; paint(); } }) : el("span", { class: "dr-rc-t", text: a }),
        editable ? el("button", { class: "dr-rc-x", type: "button", title: "빼기", "aria-label": `${a} 빼기`, disabled: busy(), onclick: () => change(name, list.filter((_, n) => n !== i)) }, icon("close")) : null)));
    if (editable && DRR.add[ref] === name) chips.push(editor(name === "to" ? "메일 주소 추가" : "참조 주소 추가", "", v => change(name, [...list, v])));
    else if (editable) chips.push(el("button", { class: "dr-rc-add", type: "button", "aria-label": `${label} 추가`, disabled: busy(), onclick: () => { DRR.edit[ref] = ""; DRR.add[ref] = name; paint(); } }, icon("add"), el("span", { text: "추가" })));
    return el("div", { class: "dr-to dr-rcrow", "data-row": name }, el("span", { class: "dr-k", text: label }), chips.length ? el("div", { class: "dr-rc-list" }, ...chips) : el("span", { class: "dr-k", text: "-" }));
  };
  function paint() {
    const st = ref ? DRR.st[ref] : null;
    const live = st && !st.failed ? st : { to: drrSplit(d.to), cc: Array.isArray(d.cc) ? d.cc : [], mode: d.mode || "reply", editable: !!ref && o.edit !== false, reply: !!d.mode };
    const editable = live.editable && o.edit !== false, off = busy();
    const seg = live.reply ? el("div", { class: "seg dr-seg", role: "group", "aria-label": "답장 범위" },
      ...[['reply', '답장'], ['all', '전체 답장']].map(([k, text]) => el("button", { class: live.mode === k ? "on" : "", type: "button", "data-k": `mode-${k}`, "aria-pressed": String(live.mode === k), disabled: off || !editable, text, onclick: () => { if (editable && !off && live.mode !== k) run(() => drrWrite(ref, { mode: k })); } }))) : null;
    const ccRow = live.cc.length || (live.reply && editable) ? row("cc", "참조", live.cc, editable) : null;
    clear(box).append(...[seg, live.reply || live.to.length ? row("to", "받는이", live.to, editable) : null, ccRow].filter(Boolean));
    box.hidden = !box.querySelector(".dr-rcrow");
  }
  paint();
  if (ref && o.edit !== false && !DRR.st[ref]) drrLoad(ref).then(paint);
  return box;
}
// "댓글 답글에 이어서" (+ the comment's link): a draft made as the follow-up of an approved action says where it came from (hub/draft-approval.ts 이어서).
function draftOriginNode(d) {
  const o = d.origin;
  if (!o || !o.text) return null;
  return el("div", { class: "dr-origin" }, icon("open"), o.link ? el("a", { href: o.link, target: "_blank", rel: "noopener", text: o.text }) : el("span", { text: o.text }));
}
// The mail that goes out right after a comment reply, in the same card (hub/draft-approval.ts "함께 보낼 메일"): recipient, subject, files, body.
function draftMailNode(m) {
  if (!m) return null;
  return el("div", { class: "dr-mailpart" },
    el("div", { class: "dr-mh" }, icon("mail"), el("span", { text: "함께 보낼 메일" })),
    el("div", { class: "dc-dr-h" }, el("span", { class: "dc-dr-k", text: m.toLabel || "받는이" }), el("span", { class: "dc-dr-v", text: m.to || "-" })),
    m.subject ? el("div", { class: "dc-dr-h" }, el("span", { class: "dc-dr-k", text: "제목" }), el("span", { class: "dc-dr-v sub", text: m.subject })) : null,
    el("div", { class: "dc-dr-b", tabindex: "0", role: "region", "aria-label": "함께 보낼 메일 내용", text: m.body }),
    draftFilesNode(m, { edit: false }));
}
function draftNode(d, o) {
  return el("div", { class: "dc-draft" },
    !d.toLabel || d.toLabel === "받는이" ? draftToNode(d, o) : el("div", { class: "dc-dr-h" }, el("span", { class: "dc-dr-k", text: d.toLabel }), el("span", { class: "dc-dr-v", text: d.to || "-" })),
    d.subject ? el("div", { class: "dc-dr-h" }, el("span", { class: "dc-dr-k", text: "제목" }), el("span", { class: "dc-dr-v", text: d.subject })) : null,
    draftOriginNode(d),
    el("div", { class: "dc-dr-b", tabindex: "0", role: "region", "aria-label": "보낼 내용", text: d.body }), draftFilesNode(d, o), draftMailNode(d.mail));
}
// What the status line says after an answer: a 고치기 on a draft is the bot rewriting it.
const dcStText = (dc, st) => (dc.draft && ((DC.picks[dc.key] || [])[0] || {}).label === DRAFT_EDIT ? "고치는 중…" : st === "sending" ? "보내는 중…" : "보냈어요 · 답을 기다려요");
// 고치기 on a draft, or an option that needs detail (안 됨 …): the owner types the change / reason, then the answer goes out with it.
// 고치기 on a draft asks "어떻게 고칠까요?" and the bot rewrites it; 직접 수정 (ed.manual) is the owner's own text, sent as the change "이 내용으로 고쳐 주세요: ...".
const DRAFT_HINT = "더 짧게, 존댓말로, 견적서도 첨부한다고 써 줘", MANUAL_LEAD = "이 내용으로 고쳐 주세요: ";
function editNode(dc, ed, st) {
  const opt = ed.opt, drf = !!dc.draft, man = !!ed.manual;
  const ta = el("textarea", { class: "dc-note", rows: man ? "7" : "2", maxlength: man ? "6000" : "500", placeholder: drf ? (man ? "보낼 내용을 직접 고쳐 주세요" : DRAFT_HINT) : "이유나 내용을 적어 주세요", "aria-label": man ? "직접 수정" : drf ? "고칠 내용" : "자세한 내용", disabled: !!st, oninput: () => { DC.note[dc.key] = ta.value; go.disabled = !ta.value.trim(); } });
  ta.value = DC.note[dc.key] ?? (man ? dc.draft.body : "");
  const go = el("button", { class: "dc-go", type: "button", disabled: !!st || !ta.value.trim(), onclick: () => { const note = ta.value.trim(); if (note) pickOption(dc, ed.bi, opt, man ? MANUAL_LEAD + note : note); } }, man ? "이 내용으로 고치기" : drf ? "고쳐 달라고 하기" : "내용 보내기");
  const back = el("button", { class: "dc-back", type: "button", disabled: !!st, onclick: () => { delete DC.edit[dc.key]; paintDecision(); } }, "돌아가기");
  return el("div", { class: "dc-edit" }, el("div", { class: "dc-ctx" }, el("span", { class: "dc-key", text: String(opt.n) }), el("span", { class: "dc-lb", text: man ? "직접 수정" : drf ? "어떻게 고칠까요?" : opt.label })), ta, el("div", { class: "dc-eb" }, back, go));
}
// A decision in the full-screen overlay (30-notices.js dkOpen, 38-overlay.js): header = what it is, body = the draft or the question, sticky footer = the choices.
// A draft waiting for send approval shows who and what in the header and 보내기 / 고치기 / 보내지 않기 in the footer. Only the body scrolls.
function renderSheet(box, dc, picks, step) {
  const st = DC.st[dc.key] || "", d = dc.draft, edit = DC.edit[dc.key] && !st.startsWith("sent") ? DC.edit[dc.key] : null;
  const old = $(".fs-body", box), top = old && box.dataset.key === dc.key ? old.scrollTop : 0;
  const oldNote = $(".dc-note", box), refocus = !!oldNote && document.activeElement === oldNote, caret = refocus ? oldNote.selectionStart : 0;
  const qText = d ? ((dc.blocks[0] && dc.blocks[0].title) || "").replace(/\s*\([^()]*\)\s*$/, "") : dc.question;
  const head = fsHead(d ? [
    el("span", { class: "fs-ey", text: qText || "보내기 전에 확인해요" }),
    el("div", { class: "dc-dh" }, el("span", { class: "dc-dr-k", text: d.toLabel || "받는이" }), el("span", { class: "dc-dr-v", text: [d.to || "-", ...(d.cc || []).map(a => `참조 ${a}`)].join(" · ") })),
    d.subject ? el("div", { class: "dc-dh" }, el("span", { class: "dc-dr-k", text: "제목" }), el("span", { class: "dc-dr-v sub", text: d.subject })) : null]
    : [el("span", { class: "fs-ey", text: dc.blocks.length ? "결정이 필요해요" : "답변이 필요해요" })], { ignore: dc.ignore, close: dc.close });
  const warnBox = el("div", { class: "dr-warnbox", hidden: true });
  const body = d ? el("div", { class: "fs-body panel", tabindex: "0", role: "region", "aria-label": "보낼 내용" }, (!d.toLabel || d.toLabel === "받는이" ? draftToNode(d, { t: dc.t, edit: !st }) : null), draftOriginNode(d), el("div", { class: "dc-dr-b", text: d.body }), draftFilesNode(d, { t: dc.t, edit: !st, warn: warnBox }), draftMailNode(d.mail))
    : qText ? el("div", { class: "fs-body panel fit" }, mdNode(qText, "md dc-q")) : null;
  // 원문 보기 (10-draft-original.js): the original is its own panel beside the draft (a toggle on a phone); the draft side (body + footer) is the one that slides.
  box.classList.remove("od-host", "od-on");
  const col = d && d.ref && body && (d.toLabel === "대상" || (d.toLabel === "받는이" && !d.mail)) ? el("div", { class: "od-draftcol" }) : null;
  const org = col ? orgNodes(d, dc.t, box, col) : null;
  const foot = el("div", { class: "fs-ft" });
  foot.append(warnBox);
  if (edit) foot.append(editNode(dc, edit, st));
  else if (d) {
    // One compact row: the first choice (보내기) filled, 고치기 tonal, the rest as text, and 직접 수정 as a small link at the end.
    const opts = dc.blocks[0].options, oe = opts.find(o => o.label === DRAFT_EDIT);
    const btns = opts.map((o, i) => el("button", { class: `dc-act${i === 0 ? " main" : o.label === DRAFT_EDIT ? " alt" : ""}${picks[0] && picks[0].n === o.n ? " on" : ""}`, type: "button", disabled: !!st, onclick: () => pickOption(dc, 0, o) }, o.label));
    const man = oe && !st ? el("button", { class: "dc-manual", type: "button", title: "직접 수정", "aria-label": "직접 수정", onclick: () => { delete DC.note[dc.key]; DC.edit[dc.key] = { bi: 0, opt: oe, manual: true }; paintDecision(); } }, icon("pencil"), el("span", { text: "직접 수정" })) : null;
    foot.append(el("div", { class: "dc-acts" }, ...btns, ...(man ? [man] : [])));
  } else {
    if (dc.blocks.length > 1) foot.append(el("div", { class: "dc-steps", role: "group", "aria-label": "결정 단계" }, ...dc.blocks.map((b, i) =>
      el("button", { class: `dc-chip${i === step ? " on" : ""}${picks[i] ? " got" : ""}`, type: "button", disabled: !!st, "aria-pressed": String(i === step), onclick: () => { DC.step[dc.key] = i; paintDecision(); } }, `${picks[i] ? "✓ " : ""}${b.title || `결정 ${i + 1}`}`))));
    const blk = dc.blocks[step];
    if (blk) {
      if (blk.title && dc.blocks.length > 1) foot.append(el("div", { class: "dc-sub", text: blk.title }));
      for (const o of blk.options) foot.append(choiceRow(dc, step, o, picks, st));
    }
  }
  if (st) foot.append(el("div", { class: "dc-st", role: "status", text: dcStText(dc, st) }));
  if (org) { col.append(body, foot); clear(box).append(head, org.bar, el("div", { class: "od-stage" }, org.orig, col)); }
  else clear(box).append(head, ...(body ? [body] : []), foot);
  if (body) body.scrollTop = top;
  const nn = $(".dc-note", box);
  if (nn && (refocus || (edit && !oldNote))) { nn.focus({ preventScroll: true }); nn.setSelectionRange(caret || nn.value.length, caret || nn.value.length); }
}
function choiceRow(dc, step, o, picks, st) {
  return el("button", { class: `dc-row${o.rec ? " rec" : ""}${picks[step] && picks[step].n === o.n ? " on" : ""}`, type: "button", disabled: !!st, onclick: () => pickOption(dc, step, o) },
    el("span", { class: "dc-key", text: String(o.n) }),
    el("span", { class: "dc-tx" }, el("span", { class: "dc-lb" }, o.label, o.rec ? el("span", { class: "dc-tag", text: "추천" }) : null), o.desc ? el("span", { class: "dc-ds", text: o.desc }) : null));
}
function renderDecision(box, dc, picks, step) {
  if (dc.close) { renderSheet(box, dc, picks, step); return; }
  const hadNote = !!$(".dc-note", box);
  const st = DC.st[dc.key] || "", fold = !!DC.fold[dc.key], old = $(".dc-body", box), top = old && box.dataset.key === dc.key ? old.scrollTop : 0;
  // A draft message starts with its quoted draft, so the question is the block's own title without the draft's id.
  const qText = dc.draft ? ((dc.blocks[0] && dc.blocks[0].title) || "").replace(/\s*\([^()]*\)\s*$/, "") : dc.question;
  const head = el("div", { class: "dc-hd" }, el("div", { class: "dc-tt" },
    el("span", { class: "dc-ey", text: dc.blocks.length ? "결정이 필요해요" : "답변이 필요해요" }),
    qText ? mdNode(qText, "md dc-q") : null),
    el("div", { class: "dc-hb" },
      el("button", { class: "dc-fold", type: "button", "aria-expanded": String(!fold), "aria-label": fold ? "펼치기" : "접기", onclick: () => { DC.fold[dc.key] = !fold; paintDecision(); } }, icon("drop"))));
  const kids = [head];
  if (!fold) {
    const body = el("div", { class: "dc-body" });
    if (dc.draft) body.append(draftNode(dc.draft, { t: dc.t, edit: !st }));
    if (DC.edit[dc.key] && !st.startsWith("sent")) { body.append(editNode(dc, DC.edit[dc.key], st)); kids.push(body); }
    else {
    if (dc.blocks.length > 1) body.append(el("div", { class: "dc-steps", role: "group", "aria-label": "결정 단계" }, ...dc.blocks.map((b, i) =>
      el("button", { class: `dc-chip${i === step ? " on" : ""}${picks[i] ? " got" : ""}`, type: "button", disabled: !!st, "aria-pressed": String(i === step), onclick: () => { DC.step[dc.key] = i; paintDecision(); } }, `${picks[i] ? "✓ " : ""}${b.title || `결정 ${i + 1}`}`))));
    const blk = dc.blocks[step];
    if (blk) {
      if (blk.title && dc.blocks.length > 1) body.append(el("div", { class: "dc-sub", text: blk.title }));
      for (const o of blk.options) body.append(el("button", { class: `dc-row${o.rec ? " rec" : ""}${picks[step] && picks[step].n === o.n ? " on" : ""}`, type: "button", disabled: !!st, onclick: () => pickOption(dc, step, o) },
        el("span", { class: "dc-key", text: String(o.n) }),
        el("span", { class: "dc-tx" }, el("span", { class: "dc-lb" }, o.label, o.rec ? el("span", { class: "dc-tag", text: "추천" }) : null), o.desc ? el("span", { class: "dc-ds", text: o.desc }) : null)));
    }
    kids.push(body);
    }
  }
  if (st) kids.push(el("div", { class: "dc-st", role: "status", text: dcStText(dc, st) }));
  clear(box).append(...kids);
  box.classList.toggle("fold", fold);
  const nb = $(".dc-body", box); if (nb) nb.scrollTop = top;
  const nn = $(".dc-note", box); if (nn && !hadNote) nn.focus({ preventScroll: true });   // the field a tap just opened takes the focus
}
// In-message rows follow the same state: tappable only while their question is the pending one.
// Otherwise they follow the message's own decision notice (hub/notices.ts keeps it open until answered, however much was posted
// after the message): open = tappable, answered = greyed with the chosen row marked.
const dcNoticeAt = at => (at ? NT.items.find(n => ntIsDec(n) && n.decision.to === target && n.decision.group === 1 && n.decision.reply_to === at) || null : null);
const dcSending = new Set();
function syncInlineChoices() {
  const dc = DC.cur;
  for (const n of document.querySelectorAll(".dcm:not(.mon-dc)")) {
    const mine = !!dc && dc.sig === n.dataset.sig, nt = mine ? null : dcNoticeAt(n.dataset.at);
    const live = mine ? !DC.st[dc.key] : !!nt && nt.decision.state === "open" && !dcSending.has(nt.id), p = mine ? DC.picks[dc.key] || [] : [];
    const said = nt && nt.decision.state === "answered" ? String(nt.decision.answer || "") : "";
    for (const b of n.querySelectorAll(".dcm-row")) {
      b.disabled = !live;
      b.classList.toggle("on", mine ? !!p[b.dataset.b] && p[b.dataset.b].n === Number(b.dataset.n) : !!said && said.startsWith(`${b.dataset.n})`));
    }
  }
}
// A tap on a message that is no longer the pending card: answered through the notice path, so the notice and the buttons settle together.
async function answerInline(nd, opt) {
  // An option that needs detail opens the notice sheet with its text field; nothing is sent from the row.
  if (!nd.decision.draft && ntNeedsNote(nd, opt)) { await noticeSheetOpen(nd.pc ? nd : nd.id); ntAnswer(nd, opt); return; }
  dcSending.add(nd.id); syncInlineChoices();
  try { await ntPost(nd, opt.n); dcAnswerToast(nd, opt); } catch (e) { toast(e.message, true); }
  dcSending.delete(nd.id); syncInlineChoices();
}
// What a draft answered in place did, with the next step: 보냈어요 · 메일 열기 (the mail it answered), 보내지 않았어요 · 되돌리기 (the draft waits again).
function dcAnswerToast(nd, opt) {
  const to = String(nd.decision.to || "");
  if (!nd.decision.draft) return;
  if (opt.label === "보내기") toast("보냈어요", false, to.startsWith("mail:") ? { label: "메일 열기", onclick: () => go("monitoring", `c:${to}`) } : null);
  else if (opt.label === "보내지 않기") toast("보내지 않았어요", false, { label: "되돌리기", onclick: () => dcReopen(nd) });
}
async function dcReopen(nd) {
  try {
    if (nd.pc) await pqNotice(nd, "notice", { op: "reopen", id: String(nd.id) });
    else { const r = await api("/api/notices/reopen", "POST", { ids: [String(nd.id)] }); ntApply(null, r.unread); await loadNotices(); }
    toast("초안을 되돌렸어요");
  } catch (e) { toast(e.message, true); }
}
function choicesNode(sig, pc, at) {
  const box = el("div", { class: isFixedT(target) ? "dcm fx" : "dcm", "data-sig": sig, "data-at": at || null });
  pc.blocks.forEach((b, bi) => {
    if (b.title && pc.blocks.length > 1) box.append(el("div", { class: "dcm-sub", text: b.title }));
    for (const o of b.options) box.append(el("button", { class: `dcm-row${o.rec ? " rec" : ""}`, type: "button", disabled: true, "data-b": bi, "data-n": o.n, onclick: () => { const dc = DC.cur; if (dc && dc.sig === sig) pickOption(dc, bi, o); else { const nd = pc.blocks.length === 1 ? dcNoticeAt(at) : null; if (nd && nd.decision.state === "open" && !dcSending.has(nd.id)) answerInline(nd, o); } } },
      el("span", { class: "dc-key", text: String(o.n) }),
      el("span", { class: "dc-tx" }, el("span", { class: "dc-lb" }, o.label, o.rec ? el("span", { class: "dc-tag", text: "추천" }) : null), o.desc ? el("span", { class: "dc-ds", text: o.desc }) : null)));
  });
  return box;
}
function paintDecision() {
  const box = $("#dcard");
  if (!box) return;
  // 알림 / 작업내역 never dock the question: a decision there opens as the sheet (30-notices.js), whichever way the conversation was entered.
  const dc = isFixedT(target) ? null : decisionOf(target), had = !!DC.cur;
  DC.cur = dc;
  if (!dc) { box.hidden = true; delete box.dataset.sig; delete box.dataset.key; clear(box); }
  else {
    const picks = DC.picks[dc.key] || [], step = DC.step[dc.key] ?? Math.max(0, dc.blocks.findIndex((_, i) => !picks[i]));
    const sig = dcSig(dc, picks, step);
    box.hidden = false;
    if (box.dataset.sig !== sig) { renderDecision(box, dc, picks, step); box.dataset.sig = sig; box.dataset.key = dc.key; }
  }
  syncInlineChoices();
  dkPaint();
  if (had !== !!dc) updateComposerMeta();
}
// What a decision card shows; the card (docked or in the sheet) is redrawn only when this changes. A redraw replaces the reason field, and on
// a phone the keyboard closes and reopens while the owner types (owner 2026-10-22), so a live update that changes none of it leaves the card alone.
function dcSig(dc, picks, step) {
  const dr = dc.draft ? [dc.draft.to, (dc.draft.cc || []).join(","), dc.draft.mode || ""] : 0;
  return JSON.stringify([dc.key, dc.question, picks.map(o => o && o.n), step, !!DC.fold[dc.key], DC.st[dc.key] || "", DC.edit[dc.key] ? DC.edit[dc.key].opt.n + (DC.edit[dc.key].manual ? "m" : "") : 0, dr]);
}
