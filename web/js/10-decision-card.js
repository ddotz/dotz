/* ---------- decision card: a question that waits on the owner, docked above the composer ---------- */
// Choice block (MODE.md "Message layout"): `**1) name** ← 추천`, then one description line; a `결정:` line titles a block.
// Several blocks = several decisions: the card walks them one at a time and sends the numbers as "1-2".
function parseChoices(text) {
  const OPT = /^\s*(?:\*\*)?\s*(\d+)\)\s*(.+?)\s*(?:\*\*)?\s*(←\s*(?:추천|recommended)|\(\s*(?:추천|recommended)\s*\))?\s*(?:\*\*)?\s*$/i;
  const HEAD = /^\s*(?:\*\*)?\s*(?:결정|decision(?: needed)?)\s*[:：]\s*(.*?)\s*(?:\*\*)?\s*$/i;
  const CLOSE = /번호(?:로|를).*(?:답|알려)/;
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
    if (nx !== undefined && nx.trim() && !OPT.test(nx) && !HEAD.test(nx) && !CLOSE.test(nx)) { desc = nx.trim(); i++; }
    cur.options.push({ n, label: m[2].replace(/^\*+|\*+$/g, "").trim(), desc, rec: !!m[3] });
  }
  return { question, blocks: blocks.filter(b => b.options.length) };
}
const DC = { cur: null, picks: {}, step: {}, fold: {}, st: {} };
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
      if ((e.kind !== "out" && e.kind !== "lane_report") || e.update_key || (typeof e.source === "string" && e.source.startsWith("lane:"))) continue;
      if (parseTone(noHandoff(String(e.text ?? ""))).tone !== "ask") return null;
      raw = String(e.text ?? ""); at = e.ts; break;
    }
    if (!raw) return null;
  }
  const body = parseTone(noHandoff(raw)).text, pc = parseChoices(body);
  if (!info.ask && !pc.blocks.length) return null;
  if (at && s.msgs.some(e => OWNER.has(e.kind) && msOf(e.ts) > msOf(at))) return null;
  const sig = hashOf(body.trim());
  return { key: `${t}|${sig}`, sig, question: pc.question, blocks: pc.blocks };
}
async function answerDecision(dc, text) {
  const t = target, lane = isLaneT(t) ? laneOf(t) : "";
  DC.st[dc.key] = "sending"; paintDecision();
  try {
    const r = await api("/api/message", "POST", { text, ...(lane ? { lane } : {}), ...(isProjT(t) ? { project: projOf(t) } : {}), ...(isWorking(t) ? { mode: "steer" } : {}) });
    if (r && r.queued) { QUEUE = QUEUE.filter(i => i.id !== r.queued.id).concat(r.queued); renderQueue(); }
    DC.st[dc.key] = "sent"; chatStick = true; scrollChat(true);
  } catch (e) { delete DC.st[dc.key]; delete DC.picks[dc.key]; toast(e.message, true); }
  paintDecision();
}
function pickOption(dc, bi, opt) {
  if (DC.st[dc.key]) return;
  const p = DC.picks[dc.key] || [];
  DC.picks[dc.key] = p;
  p[bi] = opt;
  const next = dc.blocks.findIndex((_, i) => !p[i]);
  if (next >= 0) { DC.step[dc.key] = next; paintDecision(); return; }
  answerDecision(dc, dc.blocks.length === 1 ? `${opt.n}) ${opt.label}` : dc.blocks.map((_, i) => p[i].n).join("-"));
}
function renderDecision(box, dc, picks, step) {
  const st = DC.st[dc.key] || "", fold = !!DC.fold[dc.key], old = $(".dc-body", box), top = old && box.dataset.key === dc.key ? old.scrollTop : 0;
  const head = el("div", { class: "dc-hd" }, el("div", { class: "dc-tt" },
    el("span", { class: "dc-ey", text: dc.blocks.length ? "결정이 필요해요" : "답변이 필요해요" }),
    dc.question ? mdNode(dc.question, "md dc-q") : null),
    el("button", { class: "dc-fold", type: "button", "aria-expanded": String(!fold), "aria-label": fold ? "펼치기" : "접기", onclick: () => { DC.fold[dc.key] = !fold; paintDecision(); } }, icon("drop")));
  const kids = [head];
  if (!fold) {
    const body = el("div", { class: "dc-body" });
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
  if (st) kids.push(el("div", { class: "dc-st", role: "status", text: st === "sending" ? "보내는 중…" : "보냈어요 · 답을 기다려요" }));
  clear(box).append(...kids);
  box.classList.toggle("fold", fold);
  const nb = $(".dc-body", box); if (nb) nb.scrollTop = top;
}
// In-message rows follow the same state: tappable only while their question is the pending one.
function syncInlineChoices() {
  const dc = DC.cur;
  for (const n of document.querySelectorAll(".dcm")) {
    const live = !!dc && dc.sig === n.dataset.sig && !DC.st[dc.key], p = live || (dc && dc.sig === n.dataset.sig) ? DC.picks[dc.key] || [] : [];
    for (const b of n.querySelectorAll(".dcm-row")) {
      b.disabled = !live;
      b.classList.toggle("on", !!p[b.dataset.b] && p[b.dataset.b].n === Number(b.dataset.n));
    }
  }
}
function choicesNode(sig, pc) {
  const box = el("div", { class: "dcm", "data-sig": sig });
  pc.blocks.forEach((b, bi) => {
    if (b.title && pc.blocks.length > 1) box.append(el("div", { class: "dcm-sub", text: b.title }));
    for (const o of b.options) box.append(el("button", { class: `dcm-row${o.rec ? " rec" : ""}`, type: "button", disabled: true, "data-b": bi, "data-n": o.n, onclick: () => { const dc = DC.cur; if (dc && dc.sig === sig) pickOption(dc, bi, o); } },
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
  if (had !== !!dc) updateComposerMeta();
}
