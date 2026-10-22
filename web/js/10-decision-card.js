/* ---------- decision card: a question that waits on the owner, docked above the composer ---------- */
// Choice block (MODE.md "Message layout"): `**1) name** ← 추천`, then one description line; a `결정:` line titles a block.
// Several blocks = several decisions: the card walks them one at a time and sends the numbers as "1-2".
const CH_OPT = /^\s*(?:\*\*)?\s*(\d+)\)\s*(.+?)\s*(?:\*\*)?\s*(←\s*(?:추천|recommended)|\(\s*(?:추천|recommended)\s*\))?\s*(?:\*\*)?\s*$/i;
const CH_HEAD = /^\s*(?:\*\*)?\s*(?:결정|decision(?: needed)?)\s*[:：]\s*(.*?)\s*(?:\*\*)?\s*$/i;
const CH_CLOSE = /번호(?:로|를).*(?:답|알려)/;
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
    if (h) { cur = { title: h[1].trim(), options: [] }; blocks.push(cur); continue; }
    const m = OPT.exec(lines[i]);
    if (!m) continue;
    const n = Number(m[1]);
    if (!cur || (cur.options.length && n <= cur.options[cur.options.length - 1].n)) { cur = { title: "", options: [] }; blocks.push(cur); }
    let desc = "";
    const nx = lines[i + 1];
    if (isDescLine(nx)) { desc = nx.trim(); i++; }
    cur.options.push({ n, label: m[2].replace(/^\*+|\*+$/g, "").trim(), desc, rec: !!m[3] });
  }
  return { question, blocks: blocks.filter(b => b.options.length) };
}
// Buttons only for a message that carries the [ask] marker (same rule as hub/notices.ts decisionsOf): a plain reply with a "1)" list stays text.
// The one exception is the gateway's own alert, whose issue reports end in a choice block (2+ options) without a marker.
const isChoiceMsg = pc => pc.blocks.some(b => b.options.length > 1);
const choiceAsks = (e, tone, pc) => tone === "ask" || (e.kind === "out" && e.source === "gateway" && e.target === "alert" && isChoiceMsg(pc));
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
  const body = parseTone(noHandoff(raw)).text, pc = parseChoices(body);
  if (!info.ask && !pc.blocks.length) return null;
  if (at && s.msgs.some(e => OWNER.has(e.kind) && msOf(e.ts) > msOf(at))) return null;
  const sig = hashOf(body.trim());
  return { key: `${t}|${sig}`, t, sig, at, question: pc.question, blocks: pc.blocks };
}
async function answerDecision(dc, text, opt, note) {
  const t = dc.t, lane = isLaneT(t) ? laneOf(t) : "";   // the card's own conversation: the notice sheet may answer for one that is not on screen
  DC.st[dc.key] = "sending"; paintDecision();
  try {
    // A card with one block whose question is a decision notice answers through the notice path (30-notices.js), so both stay in step.
    const nd = opt && dc.blocks.length === 1 ? ntFor(t, dc.at, opt) : null;
    if (nd) await ntPost(nd, opt.n, note);
    // The agent gets the question with each chosen option and the asking message (hub/intake.ts decisionLines); the bubble stays short.
    const pk = DC.picks[dc.key] || [], picks = dc.blocks.flatMap((b, i) => (pk[i] ? [{ q: b.title || dc.question || "", n: pk[i].n, label: pk[i].label }] : []));
    const r = nd ? null : await api("/api/message", "POST", { text, ...(picks.length ? { picks } : {}), ...(dc.at ? { reply_to: dc.at } : {}), ...(lane ? { lane } : {}), ...(isProjT(t) ? { project: projOf(t) } : {}), ...(isFixedT(t) ? { conv: t } : {}), ...(isWorking(t) ? { mode: "steer" } : {}) });
    if (r && r.queued) { QUEUE = QUEUE.filter(i => i.id !== r.queued.id).concat(r.queued); renderQueue(); }
    DC.st[dc.key] = "sent"; delete DC.edit[dc.key]; delete DC.note[dc.key];
    if (t === target) { chatStick = true; scrollChat(true); }
  } catch (e) { delete DC.st[dc.key]; delete DC.picks[dc.key]; toast(e.message, true); }
  paintDecision();
}
function pickOption(dc, bi, opt) {
  if (DC.st[dc.key]) return;
  if (dc.draft && opt.label === DRAFT_EDIT) { DC.edit[dc.key] = opt; paintDecision(); return; }   // what to change is typed first
  const p = DC.picks[dc.key] || [];
  DC.picks[dc.key] = p;
  p[bi] = opt;
  const next = dc.blocks.findIndex((_, i) => !p[i]);
  if (next >= 0) { DC.step[dc.key] = next; paintDecision(); return; }
  answerDecision(dc, dc.blocks.length === 1 ? `${opt.n}) ${opt.label}` : `결정 답: ${dc.blocks.map((_, i) => `${p[i].n}) ${p[i].label}`).join(" · ")}`, dc.blocks.length === 1 ? opt : undefined);
}
function draftNode(d) {
  return el("div", { class: "dc-draft" },
    el("div", { class: "dc-dr-h" }, el("span", { class: "dc-dr-k", text: d.toLabel || "받는이" }), el("span", { class: "dc-dr-v", text: d.to || "-" })),
    d.subject ? el("div", { class: "dc-dr-h" }, el("span", { class: "dc-dr-k", text: "제목" }), el("span", { class: "dc-dr-v", text: d.subject })) : null,
    el("div", { class: "dc-dr-b", tabindex: "0", role: "region", "aria-label": "보낼 내용", text: d.body }));
}
// 고치기 on a draft: the owner types the change, then the answer goes out with it.
function editNode(dc, opt, st) {
  const ta = el("textarea", { class: "dc-note", rows: "3", maxlength: "500", placeholder: "어떻게 고칠까요?", "aria-label": "고칠 내용", disabled: !!st, oninput: () => { DC.note[dc.key] = ta.value; go.disabled = !ta.value.trim(); } });
  ta.value = DC.note[dc.key] || "";
  const go = el("button", { class: "dc-go", type: "button", disabled: !!st || !ta.value.trim(), onclick: () => { const note = ta.value.trim(); if (note) answerDecision(dc, `${opt.n}) ${opt.label} - ${note}`, opt, note); } }, "고칠 내용 보내기");
  const back = el("button", { class: "dc-back", type: "button", disabled: !!st, onclick: () => { delete DC.edit[dc.key]; paintDecision(); } }, "돌아가기");
  return el("div", { class: "dc-edit" }, ta, el("div", { class: "dc-eb" }, back, go));
}
function renderDecision(box, dc, picks, step) {
  const st = DC.st[dc.key] || "", fold = !dc.close && !!DC.fold[dc.key], old = $(".dc-body", box), top = old && box.dataset.key === dc.key ? old.scrollTop : 0;
  // A draft message starts with its quoted draft, so the question is the block's own title without the draft's id.
  const qText = dc.draft ? ((dc.blocks[0] && dc.blocks[0].title) || "").replace(/\s*\([^()]*\)\s*$/, "") : dc.question;
  const head = el("div", { class: "dc-hd" }, el("div", { class: "dc-tt" },
    el("span", { class: "dc-ey", text: dc.blocks.length ? "결정이 필요해요" : "답변이 필요해요" }),
    qText ? mdNode(qText, "md dc-q") : null),
    // In the notice sheet (30-notices.js, dc.close) the corner button closes it instead of folding the card.
    dc.close ? el("button", { class: "dc-fold", type: "button", "aria-label": "닫기", onclick: () => dc.close() }, icon("close"))
      : el("button", { class: "dc-fold", type: "button", "aria-expanded": String(!fold), "aria-label": fold ? "펼치기" : "접기", onclick: () => { DC.fold[dc.key] = !fold; paintDecision(); } }, icon("drop")));
  const kids = [head];
  if (!fold) {
    const body = el("div", { class: "dc-body" });
    if (dc.draft) body.append(draftNode(dc.draft));
    if (dc.draft && DC.edit[dc.key] && !st.startsWith("sent")) { body.append(editNode(dc, DC.edit[dc.key], st)); kids.push(body); }
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
  if (st) kids.push(el("div", { class: "dc-st", role: "status", text: st === "sending" ? "보내는 중…" : "보냈어요 · 답을 기다려요" }));
  clear(box).append(...kids);
  box.classList.toggle("fold", fold);
  const nb = $(".dc-body", box); if (nb) nb.scrollTop = top;
}
// In-message rows follow the same state: tappable only while their question is the pending one.
// Otherwise they follow the message's own decision notice (hub/notices.ts keeps it open until answered, however much was posted
// after the message): open = tappable, answered = greyed with the chosen row marked.
const dcNoticeAt = at => (at ? NT.items.find(n => ntIsDec(n) && n.decision.to === target && n.decision.group === 1 && n.decision.reply_to === at) || null : null);
const dcSending = new Set();
function syncInlineChoices() {
  const dc = DC.cur;
  for (const n of document.querySelectorAll(".dcm")) {
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
  dcSending.add(nd.id); syncInlineChoices();
  try { await ntPost(nd, opt.n); } catch (e) { toast(e.message, true); }
  dcSending.delete(nd.id); syncInlineChoices();
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
  const dc = decisionOf(target), had = !!DC.cur;
  DC.cur = dc;
  if (!dc) { box.hidden = true; delete box.dataset.sig; delete box.dataset.key; clear(box); }
  else {
    const picks = DC.picks[dc.key] || [], step = DC.step[dc.key] ?? Math.max(0, dc.blocks.findIndex((_, i) => !picks[i]));
    const sig = JSON.stringify([dc.key, dc.question, picks.map(o => o && o.n), step, !!DC.fold[dc.key], DC.st[dc.key] || ""]);
    box.hidden = false;
    if (box.dataset.sig !== sig) { renderDecision(box, dc, picks, step); box.dataset.sig = sig; box.dataset.key = dc.key; }
  }
  syncInlineChoices();
  dkPaint();
  if (had !== !!dc) updateComposerMeta();
}
