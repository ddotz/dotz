/* ---------- a mail's people (보낸 사람 / 받는 사람 / 참조) and the same-sender thread (20-mail-thread.css) ---------- */
// Every mail view names them: the card of the mail conversation (11-todo-strip.js "mail"), the draft sheet's original (10-draft-original.js), and the
// original next to it. A header list ("Kim <kim@example.com>, Lee <lee@example.com>") is parsed to name + address; a long list shows two and "외 N명",
// and a tap opens the rest.
//
// The thread: when the mail has earlier or later mail with the same counterpart (its sender, or a sent mail's recipients), a wide screen
// (>= 1024px) shows them in a panel beside the conversation, newest first, the open one marked; a phone shows one row "이 사람과 주고받은 메일 N"
// under the mail's own header that opens the same list. Everything comes from the MAILS map (GET /api/conversations mail cards), so no extra route.
var MT_READY = false;
const MT_MAX = 20;

// Header lists: split on , or ; outside quotes and <>, then "Name <addr>" | "addr" | "Name".
function mailAddrList(v) {
  const s = String(v ?? "").replace(/\r?\n/g, " ");
  const parts = [];
  let cur = "", quote = false, angle = 0;
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    else if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    if ((ch === "," || ch === ";") && !quote && !angle) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean).map(p => {
    const m = /^(.*?)<([^<>]+)>\s*$/.exec(p);
    const addr = (m ? m[2] : p).trim(), mail = /@/.test(addr);
    // a name with no address ("김경모", a list view's cut-off "Lee (KR - A") is still who it is: shown as the name, not dropped
    const name = m ? m[1].trim().replace(/^["']|["']$/g, "").trim() : mail ? "" : p.replace(/^["']|["']$/g, "").trim();
    return { name, addr: mail ? addr : "", raw: p };
  }).filter(a => a.addr || a.name);
}

// One list of addresses: name in the text colour, the address in grey; two at most, then "외 N명" (a tap opens all, another folds them).
function mailAddrNode(list, max = 2) {
  const box = el("span", { class: "mhd-v" });
  const paint = open => {
    clear(box);
    const shown = open ? list : list.slice(0, max);
    shown.forEach((a, i) => {
      if (i) box.append(", ");
      box.append(el("span", { class: "mhd-n", text: a.name || a.addr }));
      if (a.name && a.addr) box.append(el("span", { class: "mhd-a", text: ` <${a.addr}>` }));
    });
    if (list.length > shown.length) {
      box.append(" ", el("button", { class: "mhd-more", type: "button", onclick: () => paint(true), text: `외 ${list.length - shown.length}명` }));
    } else if (open && list.length > max) {
      box.append(" ", el("button", { class: "mhd-more", type: "button", onclick: () => paint(false), text: "접기" }));
    }
  };
  paint(false);
  return box;
}

// The mail's header block: who sent it, who it is for, and 참조 when there is one. `m` = a mail card (MAILS) or a draft's original payload.
function mailHeadNode(m) {
  const src = m || {};
  const from = mailAddrList(src.from), to = mailAddrList(src.to), cc = mailAddrList(src.cc);
  const row = (k, list) => el("div", { class: "mhd-r" }, el("span", { class: "mhd-k", text: k }), list.length ? mailAddrNode(list) : el("span", { class: "mhd-v mhd-none", text: "-" }));
  return el("div", { class: "mhd", role: "group", "aria-label": "보낸 사람과 받는 사람" }, row("보낸 사람", from), row("받는 사람", to), cc.length ? row("참조", cc) : null);
}

// A mail list row's one-line version: two names then 외 N명, no buttons inside the row (the whole row opens the mail).
function mailToText(m) {
  const fmt = list => {
    const shown = list.slice(0, 2).map(a => (a.name && a.addr ? `${a.name} <${a.addr}>` : a.name || a.addr)).join(", ");
    return list.length > 2 ? `${shown} 외 ${list.length - 2}명` : shown;
  };
  const to = mailAddrList(m && m.to), cc = mailAddrList(m && m.cc);
  return [to.length ? `받는 사람 ${fmt(to)}` : "", cc.length ? `참조 ${fmt(cc)}` : ""].filter(Boolean).join(" · ");
}

// The other side of a mail: its sender, or for a mail the owner sent (dir "out") its recipients. Addresses, lowered.
const mailPeers = m => new Set((m.dir === "out" ? mailAddrList(m.to) : mailAddrList(m.from)).map(a => (a.addr || a.name).toLowerCase()).filter(Boolean));
// The label "이 사람과 주고받은 메일": every mail with the same counterpart (received from them or sent to them), newest first, the open one included.
function mailRelated(t) {
  const cur = MAILS.get(t);
  if (!cur) return [];
  const peers = mailPeers(cur);
  const out = [];
  for (const [k, m] of MAILS) {
    if (!m) continue;
    const same = k === t || [...mailPeers(m)].some(p => peers.has(p));
    if (same) out.push({ t: k, m });
  }
  if (out.length < 2) return out;
  out.sort((a, b) => String(b.m.at || "").localeCompare(String(a.m.at || "")) || a.t.localeCompare(b.t));
  return out.slice(0, MT_MAX);
}

// Opening a mail of the thread from the mail's own view: keep 모니터링's context when the open mail lives there, else the chat.
function mailThreadOpen(t) {
  const mon = !!monCtx;
  go(mon ? "monitoring" : "chat", mon ? `c:${t}` : t);
}

function mailThreadRows(t, rel) {
  return rel.map(({ t: k, m }) => {
    const cur = k === t, brief = mailBrief(m, k), [state, tone] = mailStateOf(m, 0);
    // the same state tag as the mail list's row (30-monitoring.js monConvNode): filled 미답장 colour while the mail is unreplied, else its tone
    const tag = state ? (m.unreplied ? unrepPill(state) : el("span", { class: `tag${tone ? ` ${tone}` : ""}`, text: state })) : null;
    return el("li", {},
      el("button", { class: `mth-row${cur ? " on" : ""}`, type: "button", "aria-current": cur ? "true" : null, "data-t": k, onclick: cur ? null : () => mailThreadOpen(k) },
        el("span", { class: "mth-top" }, tag, el("span", { class: "mth-when", text: rcWhen(m.at) || "" })),
        el("span", { class: "mth-subj", text: m.subject || "(제목 없음)" }),
        brief ? el("span", { class: "mth-sum", text: brief }) : null));
  });
}

// Phone (and any window under 1024px): one row under the mail header that opens the list.
function mailThreadMobile(t) {
  const rel = mailRelated(t);
  if (rel.length < 2) return null;
  const list = el("ol", { class: "mth-list", hidden: true }, ...mailThreadRows(t, rel));
  const b = el("button", { class: "mth-mb", type: "button", "aria-expanded": "false", onclick: () => { const open = list.hidden; list.hidden = !open; b.setAttribute("aria-expanded", String(open)); b.classList.toggle("open", open); } },
    icon("mail"), el("span", { class: "mth-mt", text: `이 사람과 주고받은 메일 ${rel.length}` }), icon("drop", "mth-ch"));
  return el("div", { class: "mth-m" }, b, list);
}

// The mail card's own block: the header plus, under 1024px, the thread row.
function mailMetaNode(t, e) {
  const base = MAILS.get(t) || {};
  const m = { from: base.from || (e && e.from), to: base.to || (e && e.to), cc: base.cc || (e && e.cc), dir: base.dir || (e && e.dir) };
  return el("div", { class: "mhd-wrap" }, mailHeadNode(m), mailThreadMobile(t));
}

// The wide panel, beside the conversation (see the CSS): it sits in the chat box and only shows for a mail with related mail.
const mailThrEl = $("#v-chat .chatbox") ? el("aside", { id: "mail-thread", class: "mth", hidden: true, "aria-label": "같은 사람과 주고받은 메일" }) : null;
if (mailThrEl) $("#v-chat .chatbox").append(mailThrEl);
let mthKey = "", mthSig = "";
function mailThreadSync() {
  if (!mailThrEl) return;
  const on = current === "chat" && isMailT(target);
  const rel = on ? mailRelated(target) : [];
  const show = on && rel.length > 1;
  $("#v-chat").classList.toggle("mail-open", show);
  mailThrEl.hidden = !show;
  if (!show) { mthKey = ""; mthSig = ""; return; }
  const sig = rel.map(r => `${r.t}|${r.m.at}|${r.m.reply || ""}|${r.m.suggest && r.m.suggest.state || ""}|${r.m.subject || ""}`).join("\n");
  if (sig === mthSig && mthKey === target) return;
  mthKey = target; mthSig = sig;
  clear(mailThrEl).append(
    el("div", { class: "mth-h" }, el("span", { class: "mth-ht", text: "이 사람과 주고받은 메일" }), el("span", { class: "mth-n", text: String(rel.length) })),
    el("ol", { class: "mth-list" }, ...mailThreadRows(target, rel)));
}
MT_READY = true;
