/* ---------- 빠른 처리: many waiting send approvals of one app instance, answered fast (hub/approval-wire.ts, docs/layers.md section 5) ---------- */
// The UI adapts to the workload: with `triageMin` (web.triage_min, default 3) or more waiting cards in one group (an app instance: a mail
// category, a comment source), a banner offers 빠른 처리 and opening one of those cards opens it here instead of the one-card sheet.
// One item fills the view (what it answers, the lines above the draft, the draft and its mail, files, rule), the draft text is edited in
// place, and 보내기 / 고치기 / 건너뛰기 answer it and move on at once: the answer goes out in the background (POST /api/approvals) and the
// gateway sends it itself; each card's progress comes back as approval_send events. 목록 shows every card of the group with its whole draft
// and a pick per card; 확인한 것 보내기 answers the picked ones together. Nothing is sent that was not picked one by one.
const TR = { groups: [], min: 3, results: {}, t: 0, h: null, key: "", label: "", items: [], i: 0, list: false, picks: {}, edits: {}, notes: {}, done: {}, org: {}, open: {}, noting: false };
const trK = c => `${c.to}|${c.ref}`;
const trQ = c => String(c.question || "").replace(/\s*\([^()]*\)\s*$/, "");

async function trLoad() {
  let r;
  // A failed refresh keeps what was shown (the next notice event tries again); a failed answer is reported where it was made.
  try { r = await api("/api/approvals"); } catch { return; }
  TR.groups = Array.isArray(r.groups) ? r.groups : [];
  TR.min = Number(r.triageMin) > 0 ? Number(r.triageMin) : 3;
  for (const x of r.results || []) TR.results[x.ref] = x;
  trBanner();
  if (TR.h) trMerge();
}
const trSoon = () => { clearTimeout(TR.t); TR.t = setTimeout(trLoad, 300); };
const trBig = () => TR.groups.filter(g => g.count >= TR.min);
/** The group a waiting card is in, when it is one the triage view takes (big enough). */
const trGroupFor = ref => trBig().find(g => g.cards.some(c => c.ref === ref));

function trBanner() {
  const b = $("#trban");
  if (!b) return;
  const big = trBig(), g = big[0];
  b.hidden = !g || !!TR.h;
  if (!g) return;
  clear(b).append(icon("list"), el("span", { class: "tx", text: `${g.label} 대기 ${g.count}건${big.length > 1 ? ` · 외 ${big.length - 1}곳` : ""}` }), el("span", { class: "go", text: "빠르게 처리" }));
  b.onclick = () => trOpen(g.key);
}

function trOpen(key, ref) {
  const g = TR.groups.find(x => x.key === key);
  if (!g || !g.cards.length) { toast("처리할 카드가 없어요"); return; }
  if (TR.h) TR.h.close(false);
  Object.assign(TR, { key, label: g.label, items: g.cards.slice(), list: false, picks: {}, edits: {}, notes: {}, done: {}, open: {}, noting: false });
  TR.i = Math.max(0, ref ? TR.items.findIndex(c => c.ref === ref) : 0);
  const h = fsOpen({ label: `${g.label} 빠른 처리`, cls: "tall tr", onClose: () => { if (TR.h === h) TR.h = null; document.removeEventListener("keydown", trKey); trBanner(); } });
  TR.h = h;
  document.addEventListener("keydown", trKey);
  trPaint();
  trBanner();
  h.box.focus({ preventScroll: true });
}

// New cards of the group join at the end; a card answered elsewhere (another window, Discord, the bot) is marked so, not dropped.
function trMerge() {
  const g = TR.groups.find(x => x.key === TR.key), now = new Set((g ? g.cards : []).map(trK));
  let changed = false;
  for (const c of g ? g.cards : []) if (!TR.items.some(x => trK(x) === trK(c))) { TR.items.push(c); changed = true; }
  for (const c of TR.items) if (!now.has(trK(c)) && !TR.done[trK(c)]) { TR.done[trK(c)] = { state: "gone" }; changed = true; }
  if (changed) trPaint();
}

// What a card's send is doing now: the local answer first, then the gateway's own progress (approval_send).
function trState(c) {
  const d = TR.done[trK(c)];
  if (!d) return null;
  if (d.state === "send") {
    const r = TR.results[c.ref];
    return r && r.at >= d.at - 5000 ? { state: r.state, text: r.text } : { state: c.sendable ? "queued" : "bot" };
  }
  return d;
}
const TR_ST = { queued: "보낼 차례를 기다려요", sending: "보내는 중…", sent: "보냈어요", failed: "보내지 못했어요", bot: "봇이 보내요", edit: "봇이 고치는 중이에요", gone: "다른 곳에서 처리됐어요", err: "답을 보내지 못했어요" };
const trChip = c => {
  const s = trState(c);
  return s ? el("span", { class: `tr-st ${s.state}`, "data-trst": trK(c), title: s.text || null, text: TR_ST[s.state] || s.state }) : el("span", { class: "tr-st", "data-trst": trK(c), hidden: true });
};
function trLive(e) {
  if (!e || !e.ref) return;
  TR.results[e.ref] = e;
  if (!TR.h) return;
  for (const c of TR.items) if (c.ref === e.ref) {
    const n = TR.h.box.querySelector(`[data-trst="${CSS.escape(trK(c))}"]`), next = trChip(c);
    if (n) n.replaceWith(next);
  }
  if (TR.i >= TR.items.length) trPaint();
}

function trNext() {
  TR.noting = false;
  const j = TR.items.findIndex((c, i) => i > TR.i && !TR.done[trK(c)]);
  TR.i = j < 0 ? TR.items.length : j;
  trPaint();
}

async function trPost(items) {
  const r = await api("/api/approvals", "POST", { items });
  if (r && r.error) throw new Error(r.error);
  return r;
}
// The owner's own words replace the draft's text before it is sent (POST /api/drafts/<ref>/body).
async function trSaveEdits(c) {
  const k = trK(c), e = TR.edits[k] || {}, d = c.draft || {};
  if (e.reply != null && e.reply.trim() && e.reply.trim() !== String(d.body || "").trim()) await api(`/api/drafts/${enc(c.ref)}/body`, "POST", { text: e.reply });
  if (d.mail && e.mail != null && e.mail.trim() && e.mail.trim() !== String(d.mail.body || "").trim()) await api(`/api/drafts/${enc(c.ref)}/body`, "POST", { text: e.mail, part: "mail" });
}
// Answers one card and moves on at once; the request runs behind (a failure is marked on that card, with a retry).
function trAnswer(c, n, note) {
  const k = trK(c);
  if (TR.done[k] && TR.done[k].state !== "err") return;
  TR.done[k] = { state: n === 1 ? "send" : "edit", at: Date.now() };
  trNext();
  (async () => {
    try {
      if (n === 1) await trSaveEdits(c);
      await trPost([{ ref: c.ref, to: c.to, n, ...(note ? { note } : {}) }]);
    } catch (err) {
      TR.done[k] = { state: "err", text: err.message };
      if (TR.h) trPaint();
      toast(`${trQ(c) || "카드"}: ${err.message}`, true);
    }
  })();
}
const trSkip = () => { const c = TR.items[TR.i]; if (c) TR.picks[trK(c)] = 3; trNext(); };
const trPrev = () => { const j = [...TR.items.keys()].reverse().find(i => i < TR.i); if (j != null) { TR.i = j; TR.noting = false; trPaint(); } };

function trKey(ev) {
  if (!TR.h || FS[FS.length - 1] !== TR.h || document.querySelector("dialog[open]")) return;
  const typing = ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement;
  const c = TR.items[TR.i];
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
    ev.preventDefault();
    if (TR.list) trSendPicked();
    else if (c && TR.noting) trEditSubmit(c);
    else if (c) trAnswer(c, 1);
    return;
  }
  if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === "l") { ev.preventDefault(); TR.list = !TR.list; trPaint(); }
  else if (TR.list) return;
  else if (k === "e" && c && !TR.done[trK(c)]) { ev.preventDefault(); TR.noting = true; trPaint(); }
  else if (k === "arrowright" || k === "j") { ev.preventDefault(); trSkip(); }
  else if (k === "arrowleft" || k === "k") { ev.preventDefault(); trPrev(); }
}

function trEditSubmit(c) {
  const note = (TR.notes[trK(c)] || "").trim();
  if (!note) { toast("무엇을 고칠지 적어 주세요", true); return; }
  trAnswer(c, 2, note);
}

/* ---- drawing ---- */
function trPaint() {
  if (!TR.h) return;
  const box = TR.h.box, n = TR.items.length, handled = TR.items.filter(c => TR.done[trK(c)]).length;
  const bar = el("div", { class: "tr-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(n), "aria-valuenow": String(handled), "aria-label": "처리한 카드" }, el("span", { style: `width:${n ? (handled / n) * 100 : 0}%` }));
  const pos = TR.i < n ? `${TR.i + 1}/${n}` : `${n}/${n}`;
  const head = fsHead([el("span", { class: "fs-ey" }, `${TR.label} · 빠른 처리`), el("h2", { class: "fs-t tr-pos" }, TR.list ? `목록 ${n}건` : pos, el("span", { class: "tr-sum", text: ` · 처리 ${handled}건` })), bar], { close: () => TR.h && TR.h.close() });
  const tog = el("button", { class: "btn text sm tr-tog", type: "button", "aria-pressed": String(TR.list), onclick: () => { TR.list = !TR.list; trPaint(); } }, icon("list"), el("span", { text: TR.list ? "한 장씩" : "목록" }));
  $(".fs-hb", head).prepend(tog);
  if (TR.list) clear(box).append(head, ...trListView());
  else if (TR.i >= n) clear(box).append(head, ...trDoneView());
  else clear(box).append(head, ...trOneView(TR.items[TR.i]));
  const t = $(".tr-note", box) || null;
  if (t && TR.noting) t.focus({ preventScroll: true });
}

function trOriginal(c) {
  const k = c.ref, o = TR.org[k];
  if (o === undefined) {
    TR.org[k] = null;
    api(`/api/drafts/${enc(c.ref)}/original`).then(r => { TR.org[k] = r && !r.error ? r : false; }, () => { TR.org[k] = false; }).then(() => { if (TR.h && TR.items[TR.i] && TR.items[TR.i].ref === k && !TR.list) trPaint(); });
    return el("div", { class: "tr-org muted", text: "원문을 불러오는 중…" });
  }
  if (!o) return null;
  const who = o.kind === "mail" ? [o.from, o.subject].filter(Boolean).join(" · ") : [o.author, o.post && o.post.title].filter(Boolean).join(" · ");
  return el("div", { class: "tr-org" }, el("div", { class: "tr-k", text: o.kind === "mail" ? "받은 메일" : "원댓글" }), who ? el("div", { class: "tr-who", text: who }) : null, el("div", { class: "tr-otx", text: String(o.text || "").slice(0, 2000) }));
}

const trFiles = files => (files && files.length ? el("div", { class: "tr-files" }, ...files.map(f => el("span", { class: "tr-file", text: f.size ? `${f.name} (${f.size})` : f.name }))) : null);

function trOneView(c) {
  const k = trK(c), d = c.draft || {}, st = trState(c), locked = !!st && st.state !== "err";
  const e = (TR.edits[k] ||= {});
  const area = (part, value) => el("textarea", { class: "tr-ta", rows: "6", "aria-label": part === "mail" ? "함께 보낼 메일 본문" : "보낼 글", disabled: locked, oninput: ev => { e[part] = ev.target.value; trSendLabel(c); } }, value);
  const body = el("div", { class: "fs-body tr-body", tabindex: "-1" },
    el("div", { class: "tr-q" }, el("span", { text: trQ(c) || "이대로 보낼까요?" }), trChip(c)),
    el("div", { class: "tr-meta" }, d.toLabel ? el("span", { class: "tr-to" }, el("b", { text: d.toLabel }), ` ${d.to || ""}`) : null, d.subject ? el("span", { class: "tr-to" }, el("b", { text: "제목" }), ` ${d.subject}`) : null, d.rule ? el("span", { class: "tr-rule", text: `규칙: ${d.rule}` }) : null, !c.sendable ? el("span", { class: "tr-rule", text: "봇이 보내요" }) : null),
    trOriginal(c),
    c.info && c.info.length ? el("ul", { class: "tr-info" }, ...c.info.map(l => el("li", { text: l }))) : null,
    d.warning ? el("div", { class: "tr-warn", text: d.warning }) : null,
    el("label", { class: "tr-k", text: d.mail ? "답글" : "보낼 글" }), area("reply", e.reply ?? d.body ?? ""), trFiles(d.attachments),
    d.mail ? el("div", { class: "tr-mail" }, el("div", { class: "tr-k", text: "함께 보낼 메일" }), el("div", { class: "tr-meta" }, el("span", { class: "tr-to" }, el("b", { text: "받는이" }), ` ${d.mail.to || ""}`), d.mail.subject ? el("span", { class: "tr-to" }, el("b", { text: "제목" }), ` ${d.mail.subject}`) : null), area("mail", e.mail ?? d.mail.body ?? ""), trFiles(d.mail.attachments)) : null,
    st && st.state === "err" ? el("div", { class: "tr-warn", text: `${TR_ST.err}: ${st.text || ""}` }) : null);
  const foot = el("div", { class: "fs-ft tr-ft" });
  if (TR.noting && !locked) {
    foot.append(el("textarea", { class: "dc-note tr-note", rows: "3", placeholder: "어떻게 고칠까요? 봇이 고쳐서 다시 물어봐요", "aria-label": "어떻게 고칠지", oninput: ev => { TR.notes[k] = ev.target.value; } }, TR.notes[k] || ""),
      el("div", { class: "tr-acts" }, el("button", { class: "dc-act alt tr-b", type: "button", onclick: () => { TR.noting = false; trPaint(); } }, "취소"), el("button", { class: "dc-act main tr-b tr-go", type: "button", onclick: () => trEditSubmit(c) }, "고치기 보내기")));
  } else {
    foot.append(el("div", { class: "tr-acts" },
      el("button", { class: "dc-act alt tr-b", type: "button", onclick: trSkip }, "건너뛰기"),
      el("button", { class: "dc-act alt tr-b", type: "button", disabled: locked, onclick: () => { TR.noting = true; trPaint(); } }, "고치기 …"),
      el("button", { class: "dc-act main tr-b tr-go", type: "button", disabled: locked, onclick: () => trAnswer(c, 1) }, trSendText(c))),
      el("div", { class: "tr-keys", text: "⌘↵ 보내기 · E 고치기 · → 건너뛰기 · ← 이전 · L 목록" }));
  }
  return [body, foot];
}
const trEdited = c => {
  const e = TR.edits[trK(c)] || {}, d = c.draft || {};
  return (e.reply != null && e.reply.trim() !== String(d.body || "").trim()) || (!!d.mail && e.mail != null && e.mail.trim() !== String(d.mail.body || "").trim());
};
const trSendText = c => (trEdited(c) ? "고쳐서 보내기" : "보내기");
function trSendLabel(c) { const b = TR.h && $(".tr-go", TR.h.box); if (b) b.textContent = trSendText(c); }

function trDoneView() {
  const by = s => TR.items.filter(c => { const x = trState(c); return x && x.state === s; }).length;
  const skipped = TR.items.filter(c => !TR.done[trK(c)]).length;
  const rows = [["보냈어요", by("sent")], ["보내는 중", by("queued") + by("sending")], ["보내지 못했어요", by("failed") + by("err")], ["봇이 고치거나 보내요", by("edit") + by("bot")], ["건너뛰었어요", skipped]].filter(([, v]) => v);
  const body = el("div", { class: "fs-body tr-body tr-empty" }, el("div", { class: "tr-done-t", text: skipped ? "끝까지 봤어요" : "모두 답했어요" }), el("ul", { class: "tr-sumlist" }, ...rows.map(([t, v]) => el("li", {}, el("span", { text: t }), el("b", { text: `${v}건` })))));
  const foot = el("div", { class: "fs-ft tr-ft" }, el("div", { class: "tr-acts" },
    skipped ? el("button", { class: "dc-act alt tr-b", type: "button", onclick: () => { TR.i = TR.items.findIndex(c => !TR.done[trK(c)]); trPaint(); } }, "건너뛴 것 다시 보기") : null,
    el("button", { class: "dc-act main tr-b", type: "button", onclick: () => TR.h && TR.h.close() }, "닫기")));
  return [body, foot];
}

const TR_PICK = [[1, "보내기"], [2, "고치기"], [3, "건너뛰기"]];
function trListView() {
  const picked = TR.items.filter(c => !TR.done[trK(c)] && (TR.picks[trK(c)] === 1 || (TR.picks[trK(c)] === 2 && (TR.notes[trK(c)] || "").trim()))).length;
  const body = el("div", { class: "fs-body tr-body tr-list" }, ...TR.items.map((c, i) => {
    const k = trK(c), d = c.draft || {}, st = trState(c), locked = !!st && st.state !== "err", p = TR.picks[k] || 3;
    return el("div", { class: `tr-row${locked ? " locked" : ""}` },
      el("button", { class: "tr-rh", type: "button", onclick: () => { TR.i = i; TR.list = false; trPaint(); } }, el("span", { class: "tr-n", text: String(i + 1) }), el("span", { class: "tr-rq", text: [d.to, trQ(c)].filter(Boolean).join(" · ") }), trChip(c)),
      el("div", { class: `tr-rb${p === 1 || TR.open[k] ? " open" : ""}`, title: "눌러서 전체 보기", onclick: ev => { TR.open[k] = ev.currentTarget.classList.toggle("open"); }, text: (TR.edits[k] && TR.edits[k].reply) ?? d.body ?? "" }),
      d.mail ? el("div", { class: `tr-rb mail${p === 1 || TR.open[k] ? " open" : ""}`, onclick: ev => { TR.open[k] = ev.currentTarget.classList.toggle("open"); }, text: `함께 보낼 메일 → ${d.mail.to || ""}${d.mail.subject ? ` · ${d.mail.subject}` : ""}\n${(TR.edits[k] && TR.edits[k].mail) ?? d.mail.body ?? ""}` }) : null,
      locked ? null : el("div", { class: "tr-seg", role: "radiogroup", "aria-label": `${i + 1}번 카드` }, ...TR_PICK.map(([n, t]) => el("button", { class: `tr-sg${p === n ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(p === n), onclick: () => { TR.picks[k] = n; trPaint(); } }, t))),
      !locked && p === 2 ? el("input", { class: "tr-rn", type: "text", placeholder: "어떻게 고칠까요?", value: TR.notes[k] || "", "aria-label": `${i + 1}번 고칠 내용`, oninput: ev => { TR.notes[k] = ev.target.value; trListCount(); } }) : null);
  }));
  const foot = el("div", { class: "fs-ft tr-ft" }, el("div", { class: "tr-acts" }, el("button", { class: "dc-act main tr-b tr-batch", type: "button", disabled: !picked, onclick: trSendPicked }, `확인한 것 보내기${picked ? ` (${picked})` : ""}`)), el("div", { class: "tr-keys", text: "카드마다 보내기·고치기·건너뛰기를 골라요. 고르지 않은 카드는 그대로 남아요" }));
  return [body, foot];
}
function trListCount() {
  const b = TR.h && $(".tr-batch", TR.h.box);
  if (!b) return;
  const n = TR.items.filter(c => !TR.done[trK(c)] && (TR.picks[trK(c)] === 1 || (TR.picks[trK(c)] === 2 && (TR.notes[trK(c)] || "").trim()))).length;
  b.disabled = !n;
  b.textContent = `확인한 것 보내기${n ? ` (${n})` : ""}`;
}

async function trSendPicked() {
  const go = TR.items.filter(c => !TR.done[trK(c)] && (TR.picks[trK(c)] === 1 || (TR.picks[trK(c)] === 2 && (TR.notes[trK(c)] || "").trim())));
  if (!go.length) return;
  const at = Date.now();
  for (const c of go) TR.done[trK(c)] = { state: TR.picks[trK(c)] === 1 ? "send" : "edit", at };
  trPaint();
  try {
    for (const c of go) if (TR.picks[trK(c)] === 1) await trSaveEdits(c);
    const r = await trPost(go.map(c => ({ ref: c.ref, to: c.to, n: TR.picks[trK(c)], ...(TR.picks[trK(c)] === 2 ? { note: TR.notes[trK(c)].trim() } : {}) })));
    toast(`${go.length}건 답했어요${r.sending ? ` · ${r.sending}건 보내는 중` : ""}`);
  } catch (err) {
    for (const c of go) TR.done[trK(c)] = { state: "err", text: err.message };
    trPaint();
    toast(`보내지 못했어요: ${err.message}`, true);
  }
}
