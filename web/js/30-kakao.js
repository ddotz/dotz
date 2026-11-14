/* ---------- 모니터링 > 앱 > 카카오톡: choose the rooms to watch, and a KakaoTalk-style chat per chosen room ---------- */
// API: docs/kakao-rooms-api.md. The item (30-monitoring.js, key "i:kakao") shows this pane instead of the notice timeline: renderMonitoring calls
// kkMode(). Wide screens put the room column beside the chat; below 1100px they are two screens (KK.open picks which; the app bar's back
// arrow, kkBack(), leaves the chat). Live updates arrive on the event stream as kakao / kakao_draft / kakao_rooms / kakao_read (99-boot.js -> kkLive).
// Each message carries `unread` (KakaoTalk's yellow number: members who have not read it yet); kakao_read -> /reads refreshes the numbers without bodies.
// Nothing is ever sent without a click: a typed message, a draft's 보내기 or an edited draft's 보내기 is the owner's own action.
// Message text only ever goes through el({text}) / textContent, never innerHTML.
const KK_KEY = "i:kakao";
const kkItem = it => !!it && (it.key === KK_KEY || !!it.kk);   // a peer's Kakao item (34-peer-monitoring.js) shows this same pane, its rooms read through the proxy (KK.pc)
// The kakao item the pane shows: this computer's, or the peer's while KK.pc names it.
const kkItemNow = () => monItems().find(i => kkItem(i) && (KK.pc ? !!i.pc && i.pc.url === KK.pc.url : !i.pc)) || null;
const KK_PAGE = 50;
const KK = {
  vis: false, on: true, error: "", rooms: [], loaded: false, failed: false, dsig: [], droom: "", adding: null,   // adding: the 지켜볼 대화방 dialog while it is open
  open: "", seq: 0, loading: false, roomErr: "", room: null, msgs: [], gaps: new Set(), more: false, read: null, div: "", drafts: [], sends: [], ask: null, hidden: new Set(),
  stick: true, pill: false, pin: "", placed: false, readSent: "", sending: false, drafting: "", draftT: 0, tailing: false, again: false,
  view: "all", typed: new Map(), headSig: "", rseq: 0, timer: 0, intgT: 0, pc: null, reading: false, readAgain: false, q: "",
  peerT: 0, peerBusy: false, peerHead: "", lp: new Map(), olderBusy: false, olderAgain: false,
};

/* ---- small helpers ---- */
const kkBig = s => { try { return BigInt(s); } catch { return 0n; } };
const kkGt = (a, b) => kkBig(a) > kkBig(b);
const kkDay = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const kkTime = t => new Date(t).toLocaleTimeString(TX_LOCALE, { hour: "numeric", minute: "2-digit" });
const kkDate = t => { const now = new Date(), y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); return kkDay(t) === kkDay(now) ? TX("apps.kk.today") : kkDay(t) === kkDay(y) ? TX("apps.kk.yesterday") : new Date(t).toLocaleDateString(TX_LOCALE, { year: "numeric", month: "long", day: "numeric", weekday: "long" }); };
function kkListTime(t) {
  if (!t) return "";
  const d = new Date(t), now = new Date(), y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1), thisYear = d.getFullYear() === now.getFullYear();
  if (kkDay(t) === kkDay(now)) return kkTime(t);
  if (kkDay(t) === kkDay(y)) return TX("apps.kk.yesterday");
  return I18N_LANG !== "ko" ? d.toLocaleDateString(TX_LOCALE, thisYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" }) : thisYear ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}
const kkHue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
const kkInitial = s => [...String(s ?? "").trim()][0] || "?";
function kkAvatar(name, cls = "") {
  const n = el("span", { class: `kk-av ${cls}`.trim(), "aria-hidden": "true", text: kkInitial(name) });
  n.style.setProperty("--h", String(kkHue(name)));
  return n;
}
// What a message that is not plain text says (KakaoTalk's type codes). A reply (26) carries its own text.
const KK_TYPE = { 2: TX("apps.kk.type.photo"), 27: TX("apps.kk.type.photo"), 3: TX("apps.kk.type.video"), 4: TX("apps.kk.type.voice"), 5: TX("apps.kk.type.voice"), 12: TX("apps.kk.type.sticker"), 20: TX("apps.kk.type.sticker"), 25: TX("apps.kk.type.sticker"), 18: TX("apps.kk.type.file"), 16: TX("apps.kk.type.location") };
const KK_OTHER = TX("apps.kk.type.other");
// A JSON record in the message column (an attachment of a type this build does not draw) is not words: never show it.
const kkRecord = s => {
  if (!/^\s*[\[{]/.test(String(s))) return false;
  try { const v = JSON.parse(String(s)); return !!v && typeof v === "object"; } catch { return false; }
};
// The text of a message (the server sends it for text, replies, feed lines and unknown types); else the placeholder of its type.
function kkBody(m) {
  const type = Number(m.type), text = String(m.text ?? "");
  const words = type === 0 ? kkSysText(text) : type === 1 || type === 26 || !kkRecord(text) ? text : "";
  if (words) return { text: words, ph: false };
  return { text: KK_TYPE[type] || KK_OTHER, ph: true };
}
// The one line a room row shows under its name (the same rule as the hub's room list).
const kkHint = m => { const chars = [...kkBody(m).text.replace(/\s+/g, " ").trim()]; return chars.length > 32 ? `${chars.slice(0, 31).join("").trimEnd()}…` : chars.join(""); };
const kkSys = m => Number(m.type) === 0;
// A system line (type 0) whose text is KakaoTalk's own feed record ({"feedType":..}) reads as words, never as JSON: a hidden message, people who came
// in or left; a record of any other kind is not drawn (better nothing than a guess).
function kkSysText(text) {
  const s = String(text ?? "").trim();
  if (!kkRecord(s)) return s;
  let v;
  try { v = JSON.parse(s); } catch { return ""; }
  if (!v || typeof v !== "object" || v.feedType === undefined) return "";
  if (v.hidden) return TX("apps.kk.sys.hidden");
  const names = (Array.isArray(v.members) ? v.members : []).map(x => x && (x.nickName || x.nickname)).filter(Boolean).join(", ");
  if (!names) return "";
  const ft = Number(v.feedType);
  return ft === 1 || ft === 4 ? TX("apps.kk.sys.joined", { names }) : ft === 2 ? TX("apps.kk.sys.left", { names }) : ft === 6 ? TX("apps.kk.sys.removed", { names }) : "";
}

/* ---- links in a message: the address itself is a link, and a lazy preview card under the bubble (GET /api/link-preview) ---- */
const KK_URL = /\bhttps?:\/\/[^\s<>"'`]+/gu;
const kkTrimUrl = u => u.replace(/[.,!?;:)\]]+$/u, "");
// Up to three addresses of a message text, without duplicates and trailing punctuation.
const kkUrls = text => [...new Set((String(text).match(KK_URL) || []).map(kkTrimUrl).filter(Boolean))].slice(0, 3);
// The text with each address as an anchor; everything else stays text (never innerHTML).
function kkLinkText(text) {
  const out = document.createDocumentFragment();
  let at = 0;
  for (const m of String(text).matchAll(KK_URL)) {
    const raw = m[0], url = kkTrimUrl(raw);
    if (m.index > at) out.append(document.createTextNode(text.slice(at, m.index)));
    out.append(el("a", { class: "kk-link", href: url, target: "_blank", rel: "noopener noreferrer", text: url }));
    if (raw.length > url.length) out.append(document.createTextNode(raw.slice(url.length)));
    at = m.index + raw.length;
  }
  if (at < String(text).length) out.append(document.createTextNode(String(text).slice(at)));
  return out;
}
const kkLpCard = url => el("a", { class: "kk-lp", href: url, target: "_blank", rel: "noopener noreferrer", "data-url": url }, el("span", { class: "kk-lp-ph", text: TX("apps.kk.link_preview") }));
// One request per address for the whole pane (the hub caches 24 h as well); a failed preview disappears, the plain link stays.
// The map holds the pending request too, so cards of the same address share one answer.
async function kkLpLoad(card) {
  const url = card.dataset.url;
  let p = KK.lp.get(url);
  if (p === undefined) {
    p = api(`/api/link-preview?url=${enc(url)}`).catch(() => ({ ok: false }));
    KK.lp.set(url, p);
  }
  p = await p;
  KK.lp.set(url, p);
  if (!card.isConnected) return;
  if (!p || !p.ok) { card.remove(); return; }
  clear(card);
  if (p.image) card.append(el("img", { src: p.image, alt: "", loading: "lazy", decoding: "async", draggable: "false" }));
  card.append(el("span", { class: "kk-lp-b" },
    p.site ? el("span", { class: "kk-lp-s", text: p.site }) : null,
    p.title ? el("span", { class: "kk-lp-t", text: p.title }) : null,
    p.description ? el("span", { class: "kk-lp-d", text: p.description }) : null));
}
let kkLpIO = null;
let kkTopIO = null;
// The top of the room loads the older page by itself (one at a time), the button stays as the fallback.
function kkTopWatch() {
  kkTopIO?.disconnect();
  const top = $("#kk-top", kkIn);
  if (top && kkTopIO) kkTopIO.observe(top);
}
function kkLpWatch() {
  for (const c of kkIn.querySelectorAll(".kk-lp[data-url]")) if (kkLpIO) kkLpIO.observe(c); else kkLpLoad(c);
}

/* ---- photos, videos, voice, files, replies, locations: built from m.media (the server sends no URL; bytes come from /api/kakao/media/...) ---- */
const KK_GONE = TX("apps.kk.gone");
// A peer's room (KK.pc) is read through /api/peer/proxy like every other Kakao GET (34-peer-monitoring.js pqLink).
const kkMediaUrl = (m, i, v) => pqLink(`/api/kakao/media/${enc(KK.open)}/${enc(m.logId)}?i=${i | 0}&v=${v}`);
const kkFileUrl = m => pqLink(`/api/kakao/media/${enc(KK.open)}/${enc(m.logId)}/file`);
const kkNum = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
function kkSize(n) {
  n = kkNum(n);
  if (!n) return "";
  return n < 1024 ? `${n}B` : n < 1048576 ? `${Math.round(n / 1024)}KB` : `${(n / 1048576).toFixed(1)}MB`;
}
function kkDur(sec) {
  sec = Math.round(kkNum(sec) / (kkNum(sec) > 3600 * 10 ? 1000 : 1));
  return sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : "";
}
const kkGoneCard = () => el("div", { class: "kk-bub card gone", role: "status", text: KK_GONE });
// A lazy image from the media route; when it cannot be fetched (expired, gone) its box says so.
function kkImg(m, i, v, alt, box) {
  return el("img", { src: kkMediaUrl(m, i, v), alt, loading: "lazy", decoding: "async", draggable: "false", onerror: ev => {
    ev.currentTarget.remove();
    box.classList.add("gone");
    if (v === "thumb" && box.dataset.k === "video") return;
    box.append(el("span", { class: "kk-gonet", text: KK_GONE }));
  } });
}
function kkRatio(box, w, h, max) {
  w = kkNum(w) || 4; h = kkNum(h) || 3;
  box.style.setProperty("--ar", `${w} / ${h}`);
  box.style.setProperty("--pw", `${Math.min(kkNum(w) > 20 ? w : max, max)}px`);
}
function kkPhotoBtn(m, md, i, alt) {
  const b = el("button", { class: "kk-photo", type: "button", "data-k": "photo", "aria-label": TX("apps.kk.enlarge", { alt }), onclick: () => kkViewer(m, md, i) });
  b.append(kkImg(m, i, "thumb", alt, b));
  return b;
}
function kkPhotoNode(m, md) {
  if (md.expired) return kkGoneCard();
  const count = Math.max(1, md.count | 0);
  if (count === 1) {
    const b = kkPhotoBtn(m, md, 0, TX("apps.kk.photo"));
    kkRatio(b, md.w, md.h, 240);
    return el("div", { class: "kk-media" }, b);
  }
  const cols = count >= 5 ? 3 : 2, shown = Math.min(count, 6), grid = el("div", { class: `kk-media kk-album c${cols}`, "data-count": String(count) });
  for (let i = 0; i < shown; i++) {
    const b = kkPhotoBtn(m, md, i, TX("apps.kk.photo_n", { n: i + 1 }));
    if (i === shown - 1 && count > shown) b.append(el("span", { class: "kk-more-n", text: `+${count - shown + 1}` }));
    grid.append(b);
  }
  return grid;
}
function kkVideoNode(m, md) {
  if (md.expired) return kkGoneCard();
  const b = el("button", { class: "kk-photo kk-video", type: "button", "data-k": "video", "aria-label": TX("apps.kk.play"), onclick: () => kkViewer(m, md, 0) });
  kkRatio(b, md.w, md.h, 240);
  b.append(kkImg(m, 0, "thumb", TX("apps.kk.video"), b), el("span", { class: "kk-play", "aria-hidden": "true" }));
  if (kkDur(md.d)) b.append(el("span", { class: "kk-dur", text: kkDur(md.d) }));
  return el("div", { class: "kk-media" }, b);
}
function kkVoiceNode(m, md) {
  if (md.expired) return kkGoneCard();
  return el("div", { class: "kk-bub card voice" },
    el("audio", { controls: true, preload: "none", src: kkMediaUrl(m, 0, "full") }),
    kkDur(md.d) ? el("span", { class: "kk-sub", text: kkDur(md.d) }) : null);
}
function kkFileNode(m, md) {
  const sub = [kkSize(md.size), md.local ? "" : md.expired ? KK_GONE : ""].filter(Boolean).join(" · ");
  return el("div", { class: `kk-bub card file${md.local ? "" : " off"}` },
    icon("file", "kk-fi"),
    el("span", { class: "kk-fb" }, el("span", { class: "kk-fn", title: md.name, text: md.name }), sub ? el("span", { class: "kk-sub", text: sub }) : null),
    md.local ? el("a", { class: "btn tonal inrow kk-open", href: kkFileUrl(m), target: "_blank", rel: "noopener", download: md.name, text: TX("apps.kk.open") }) : el("span", { class: "kk-sub kk-nopc", text: TX("apps.kk.not_on_pc") }));
}
// Like KakaoTalk: "<author of the original>에게 답장" over the quoted original, then the reply's own text. The quote is a button that jumps to
// the original (kkJump), when the attachment names its logId.
function kkReplyNode(m, md) {
  const { text } = kkBody(m);
  return el("div", { class: "kk-bub reply" },
    el("button", { class: `kk-quote${md.srcLogId ? " kk-qjump" : ""}`, type: "button", disabled: !md.srcLogId, "data-src": md.srcLogId || null, "aria-label": md.srcLogId ? TX("apps.kk.go_original") : null, onclick: ev => { ev.stopPropagation(); kkJump(md.srcLogId, ev.currentTarget); } },
      el("span", { class: "kk-qn" }, el("span", { text: md.quoteSender ? TX("apps.kk.reply_to", { name: md.quoteSender }) : TX("apps.kk.reply") }), md.srcLogId ? el("span", { class: "kk-qgo", text: TX("apps.kk.see_original") }) : null), el("span", { class: "kk-qt", text: md.quote })),
    el("div", { class: "kk-rt", text }));
}
// The original message of a quote: scroll it into view and flash it briefly. When the page does not hold it, the server sends the page
// around that logId (?around=); a logId the room does not have says so with a toast.
// The original stays marked a few seconds with an "원래 메시지" label over it, and a pill takes the owner back to the reply he came from.
const kkFlash = (node, label = TX("apps.kk.original")) => {
  node.classList.remove("kk-hl");
  void node.offsetWidth;
  node.classList.add("kk-hl");
  node.dataset.hl = label;
  clearTimeout(node._hlT);
  node._hlT = setTimeout(() => node.classList.remove("kk-hl"), 3200);
};
let kkBackPill = null;
function kkReturnPill(from) {
  if (kkBackPill) kkBackPill.remove();
  const log = from && from.closest("[data-log]") ? from.closest("[data-log]").dataset.log : "";
  if (!log) return;
  const pill = kkBackPill = el("button", { class: "kk-backpill", type: "button", "data-k": "kk-back-reply", onclick: () => {
    pill.remove(); kkBackPill = null;
    const n = [...kkTl.querySelectorAll("[data-log]")].find(x => x.dataset.log === log);
    if (n) { n.scrollIntoView({ block: "center" }); kkFlash(n, TX("apps.kk.reply")); }
  } }, icon("back"), TX("apps.kk.back_to_reply"));
  kkTl.parentElement.append(pill);
  setTimeout(() => { if (kkBackPill === pill) { pill.remove(); kkBackPill = null; } }, 12000);
}
function kkJump(src, from) {
  src = String(src || "").trim();
  if (!src || !KK.open) return;
  const find = () => [...kkTl.querySelectorAll("[data-log]")].find(n => n.dataset.log === src);
  let node = find();
  if (!node) {
    const id = KK.open;
    // The original is on an older page: the quote says it is looking until the page around it arrives.
    if (from) { from.classList.add("busy"); from.dataset.wait = TX("apps.kk.finding"); }
    api(`/api/kakao/chat/${enc(id)}?limit=${KK_PAGE}&around=${enc(src)}`).then(d => {
      if (KK.open !== id) return;
      // The page around the original is merged into what the room already shows (a jump never drops the current view). Messages between
      // that page and the rest are not loaded: the place is marked as a gap (kkGapNode) instead of drawing the two pages as adjacent.
      const got = Array.isArray(d.messages) ? d.messages : [];
      kkMergeGap(got);
      if (d.room) KK.room = d.room;
      if (Array.isArray(d.drafts)) { KK.drafts = d.drafts; KK.ask = kkAskOf(d); }
      if (Array.isArray(d.sends)) KK.sends = d.sends;
      if (d.read !== undefined) KK.read = d.read;
      kkPaintTl(false);
      const hit = find();
      if (from) from.classList.remove("busy");
      if (!hit) { toast(TX("apps.kk.orig_missing"), true); return; }
      hit.scrollIntoView({ block: "center" });
      kkFlash(hit);
      kkReturnPill(from);
      kkSyncStick();
    }, e => { if (from) from.classList.remove("busy"); toast(e.message, true); });
    return;
  }
  node.scrollIntoView({ block: "center" });
  kkFlash(node);
  kkReturnPill(from);
  kkSyncStick();
}
const kkByLog = (a, b) => (kkGt(a.logId, b.logId) ? 1 : kkGt(b.logId, a.logId) ? -1 : 0);
// Merges a page that may not touch what is shown (a quote jump, a gap fill). A page sharing no message with the view leaves a gap on each
// side that has shown messages; a gap the page reaches into is closed. KK.gaps holds the logId each gap follows. `closes`: the gap this
// page fills from below (its lower side is contiguous by construction).
function kkMergeGap(got, closes) {
  if (!got.length) return;
  const have = new Set(KK.msgs.map(x => x.logId)), fresh = got.filter(x => !have.has(x.logId)), page = [...got].sort(kkByLog);
  const lo = page[0].logId, hi = page[page.length - 1].logId, touches = fresh.length < got.length;
  if (closes) KK.gaps.delete(closes);
  if (!touches) {
    const above = KK.msgs.find(x => kkGt(x.logId, hi)), below = KK.msgs.filter(x => kkGt(lo, x.logId)).pop();
    if (above) KK.gaps.add(hi);
    if (below && !closes) KK.gaps.add(below.logId);
  }
  KK.msgs = [...KK.msgs, ...fresh].sort(kkByLog);
}
// The messages after a gap, one page at a time; the gap closes once the page reaches what is shown after it.
async function kkFillGap(after) {
  const id = KK.open;
  if (!id || KK.gapBusy) return;
  KK.gapBusy = true;
  try {
    const d = await api(`/api/kakao/chat/${enc(id)}?limit=${KK_PAGE}&after=${enc(after)}`);
    if (KK.open !== id) return;
    kkMergeGap(Array.isArray(d.messages) ? d.messages : [], after);
    kkPaintTl(false);
  } catch (e) { toast(e.message, true); }
  finally { KK.gapBusy = false; }
}
const kkGapNode = after => el("div", { class: "kk-gap", role: "separator", "aria-label": TX("apps.kk.gap_aria") },
  el("button", { class: "btn text", type: "button", "data-k": "gap", text: TX("apps.kk.gap"), onclick: () => kkFillGap(after) }));
// A sticker: its image from the media route when the server has one (md.image), else (or when it cannot be fetched) one chip with its name.
// The text written with it sits in a bubble under it.
const kkEmoChip = md => el("div", { class: "kk-bub ph kk-emo-chip", text: md.alt || TX("apps.kk.sticker") });
function kkEmoticonNode(m, md) {
  const sticker = md.image
    ? el("div", { class: "kk-sticker" }, el("img", { src: kkMediaUrl(m, 0, "full"), alt: md.alt || TX("apps.kk.sticker"), loading: "lazy", decoding: "async", draggable: "false", onerror: ev => ev.currentTarget.parentNode.replaceWith(kkEmoChip(md)) }))
    : kkEmoChip(md);
  const words = String(md.text ?? "").trim();
  return words ? el("div", { class: "kk-emo" }, sticker, el("div", { class: "kk-bub kk-emo-t", text: words })) : sticker;
}
function kkLocationNode(md) {
  const href = `https://map.kakao.com/link/map/${enc(md.label)},${Number(md.lat)},${Number(md.lng)}`;
  return el("a", { class: "kk-bub card loc", href, target: "_blank", rel: "noopener" }, el("span", { class: "kk-fn", text: TX("apps.kk.loc", { label: md.label }) }), el("span", { class: "kk-sub", text: TX("apps.kk.map") }));
}
function kkMediaNode(m, md) {
  switch (md.kind) {
    case "photo": return kkPhotoNode(m, md);
    case "video": return kkVideoNode(m, md);
    case "voice": return kkVoiceNode(m, md);
    case "file": return kkFileNode(m, md);
    case "emoticon": return kkEmoticonNode(m, md);
    case "reply": return kkReplyNode(m, md);
    case "location": return kkLocationNode(md);
    default: return null;
  }
}
// The full-screen viewer (the lightbox dialog of 15-attachments.js): a photo (an album pages with the arrows) or a video with controls.
function kkViewer(m, md, start) {
  const count = md.kind === "photo" ? Math.max(1, md.count | 0) : 1;
  let i = Math.min(Math.max(start | 0, 0), count - 1);
  const title = el("span", { class: "lb-n" }), body = el("div", { class: "lb-img kk-vw", tabindex: "-1", autofocus: true, onclick: ev => { if (ev.target === ev.currentTarget) d.close(); } });
  const prev = el("button", { class: "x", type: "button", "data-k": "prev", "aria-label": TX("apps.kk.prev"), onclick: () => go(i - 1) }, icon("back"));
  const next = el("button", { class: "x", type: "button", "data-k": "next", "aria-label": TX("apps.kk.next"), onclick: () => go(i + 1) }, icon("chev"));
  const d = el("dialog", { class: "lbox kk-vwd", "aria-label": md.kind === "video" ? TX("apps.kk.view_video") : TX("apps.kk.view_photo") },
    el("div", { class: "lb-in" }, el("div", { class: "lb-bar" }, title, prev, next, el("button", { class: "x", type: "button", "data-k": "close", "aria-label": TX("common.close"), onclick: () => d.close() }, icon("close"))), body));
  const gone = ev => ev.currentTarget.replaceWith(el("p", { class: "tv-st", role: "status", text: KK_GONE }));
  const paint = () => {
    title.textContent = md.kind === "video" ? TX("apps.kk.video") : count > 1 ? TX("apps.kk.photo_of", { i: i + 1, count }) : TX("apps.kk.photo");
    prev.hidden = i <= 0; next.hidden = i >= count - 1;
    const src = kkMediaUrl(m, i, "full");
    clear(body).append(md.kind === "video" ? el("video", { src, controls: true, autoplay: true, playsinline: true, onerror: gone }) : el("img", { src, alt: title.textContent, onerror: gone }));
  };
  const go = n => { if (n >= 0 && n < count) { i = n; paint(); } };
  d.addEventListener("keydown", ev => { if (ev.key === "ArrowLeft") go(i - 1); else if (ev.key === "ArrowRight") go(i + 1); });
  d.addEventListener("close", () => d.remove());
  paint();
  document.body.append(d); d.showModal(); dialogHist(d);
  return d;
}
const kkWho = m => (m.fromMe ? "me" : String(m.authorId ?? m.sender ?? ""));

/* ---- 사용자별 분석: a sender's avatar or name opens the panel (GET/POST /api/kakao/person/...) ---- */
const kkMin = ms => (ms === undefined || ms === null ? "" : ms < 60000 ? TX("apps.kk.sec", { n: Math.max(1, Math.round(ms / 1000)) }) : ms < 3600000 ? TX("apps.kk.min", { n: Math.round(ms / 60000) }) : TX("apps.kk.hour", { n: (ms / 3600000).toFixed(1) }));
function kkBars(values, labels, title) {
  const max = Math.max(1, ...values);
  return el("div", { class: "kk-hist" }, ...values.map((v, i) => el("span", { class: "kk-hb", title: title(labels ? labels[i] : i, v), style: `height:${Math.max(2, Math.round((v / max) * 100))}%` })));
}
function kkPerson(uid) {
  uid = String(uid || "");
  const id = KK.open;
  if (!uid || !id) return;
  const who = KK.msgs.find(m => !m.fromMe && String(m.authorId) === uid);
  const name = who ? who.sender || TX("apps.kk.other") : TX("apps.kk.other");
  const body = el("div", { class: "kk-pd-b" }, el("div", { class: "kk-note", role: "status", text: TX("common.loading") }));
  const d = el("dialog", { class: "kk-pd", "data-uid": uid, "aria-label": TX("apps.kk.person_aria", { name }) },
    el("div", { class: "kk-pd-in" },
      el("div", { class: "kk-pd-h" }, kkAvatar(name), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: name }), el("span", { class: "cv-p", text: TX("apps.kk.person") })), el("button", { class: "ib fs-x", type: "button", "data-k": "close", "aria-label": TX("common.close"), onclick: () => d.close() }, icon("close"))),
      body));
  d.addEventListener("click", ev => { if (ev.target === d) d.close(); });
  document.body.append(d); d.showModal(); dialogHist(d);
  d.addEventListener("close", () => d.remove());
  api(`/api/kakao/person/${enc(uid)}?room=${enc(id)}`).then(r => { if (d.isConnected) kkPersonPaint(d, body, r); }, e => { if (d.isConnected) clear(body).append(el("div", { class: "kk-note", role: "status", text: e.message })); });
}
function kkPersonPaint(d, body, r) {
  const s = (r && r.stats) || {}, row = (k, v) => el("div", { class: "kk-prow" }, el("span", { class: "kk-pk", text: k }), el("span", { class: "kk-pv", text: v }));
  const span = [s.firstAt ? kstStamp(s.firstAt) : "", s.lastAt ? kstStamp(s.lastAt) : ""].filter(Boolean).join(" ~ ");
  const reply = [s.replyToOwnerMs !== undefined ? TX("apps.kk.reply_to_me", { t: kkMin(s.replyToOwnerMs) }) : "", s.ownerReplyMs !== undefined ? TX("apps.kk.me_to_other", { t: kkMin(s.ownerReplyMs) }) : ""].filter(Boolean).join(" · ") || TX("apps.kk.not_yet");
  const unanswered = Array.isArray(s.recentUnanswered) ? s.recentUnanswered : [];
  const sum = el("div", { class: "kk-sum" });
  const paintSum = a => clear(sum).append(...[
    a && a.text ? el("div", { class: "kk-dh", text: TX("apps.kk.summary") }) : null,
    a && a.text ? el("div", { class: "kk-dt", text: a.text }) : null,
    a && a.at ? el("div", { class: "kk-sub", text: TX("apps.kk.summary_at", { at: kstStamp(a.at) }) }) : null,
    el("button", { class: "btn tonal", type: "button", "data-k": "analyze", text: a ? TX("apps.kk.reanalyze") : TX("apps.kk.analyze"), onclick: ev => kkAnalyze(d, ev.currentTarget, paintSum) }),
  ].filter(Boolean));
  paintSum(r && r.analysis);
  // A section whose numbers are all 0 is not drawn: no empty charts, no "0개 · 0개 (0곳)".
  const some = a => Array.isArray(a) && a.some(v => v > 0), wd = [TX("apps.kk.wd.sun"), TX("apps.kk.wd.mon"), TX("apps.kk.wd.tue"), TX("apps.kk.wd.wed"), TX("apps.kk.wd.thu"), TX("apps.kk.wd.fri"), TX("apps.kk.wd.sat")];
  const rows = [
    (s.roomMessages | 0) || (s.watchedMessages | 0) ? row(TX("apps.kk.stat.messages"), TX("apps.kk.stat.messages_v", { room: s.roomMessages | 0, watched: s.watchedMessages | 0, n: s.watchedRooms | 0 })) : null,
    span ? row(TX("apps.kk.stat.span"), span) : null,
    s.replyToOwnerMs !== undefined || s.ownerReplyMs !== undefined ? row(TX("apps.kk.stat.reply", { n: s.windowDays || 30 }), reply) : null,
    s.mentions | 0 ? row(TX("apps.kk.stat.mentions"), TX("apps.kk.stat.mentions_v", { pct: Math.round((s.mentionShare || 0) * 100), n: s.mentions | 0 })) : null,
  ].filter(Boolean);
  clear(body).append(...[
    rows.length ? el("div", { class: "kk-psec" }, ...rows) : null,
    some(s.hours) ? el("div", { class: "kk-psec" }, el("div", { class: "kk-dh", text: TX("apps.kk.active_hours") }), kkBars(s.hours, Array.from({ length: 24 }, (_, i) => String(i)), (h, v) => TX("apps.kk.hist_hour", { h, v })),
      el("div", { class: "kk-hax" }, ...[0, 6, 12, 18, 24].map(h => el("span", { text: TX("apps.kk.hour_mark", { h }) })))) : null,
    some(s.weekdays) ? el("div", { class: "kk-psec" }, el("div", { class: "kk-dh", text: TX("apps.kk.weekday") }), kkBars(s.weekdays, wd, (d, v) => TX("apps.kk.hist_day", { d, v })),
      el("div", { class: "kk-hax kk-hax7" }, ...wd.map(t => el("span", { text: t })))) : null,
    el("div", { class: "kk-psec" }, el("div", { class: "kk-dh", text: TX("apps.kk.waiting") }),
      ...(unanswered.length ? unanswered.map(m => el("div", { class: "kk-pun" }, el("span", { class: "kk-sub", text: kstStamp(m.at) }), el("span", { class: "kk-put", text: m.text }))) : [el("div", { class: "kk-sub", text: TX("apps.kk.none") })])),
    sum].filter(Boolean));
}
async function kkAnalyze(d, btn, paint) {
  const id = KK.open, uid = d.getAttribute("data-uid");
  if (!id || !uid) return;
  btn.disabled = true; btn.textContent = TX("apps.kk.analyzing");
  try {
    const r = await api(`/api/kakao/person/${enc(uid)}/analyze`, "POST", { room: id });
    if (!d.isConnected) return;
    if (r && r.error) throw new Error(r.error);
    paint(r.analysis);
  } catch (e) {
    if (d.isConnected) { btn.disabled = false; btn.textContent = TX("apps.kk.analyze"); }
    toast(e.message, true);
  }
}

const kkSame = (a, b) => !kkSys(a) && !kkSys(b) && kkWho(a) === kkWho(b) && Math.floor(a.sentAt / 60000) === Math.floor(b.sentAt / 60000);
const kkKindLine = r => (r.kind === "group" || r.kind === "multi" ? TX("apps.kk.kind.group") : r.kind === "direct" || r.kind === "dm" ? TX("apps.kk.kind.direct") : r.kind === "open" ? TX("apps.kk.kind.open") : "");
// Under a room's name: the hub's hint (the newest message, else the member count); a room without one says its kind.
// The group mark sits after the name (the prototype's "단체"); a room without a last line says what kind it is.
const kkTag = r => (r.kind === "group" || r.kind === "multi" ? TX("apps.kk.tag.group") : r.kind === "open" ? TX("apps.kk.kind.open") : "");
const kkSubLine = r => r.hint || (kkTag(r) ? "" : kkKindLine(r));
const kkRoom = id => KK.rooms.find(r => r.chatId === id) || null;
// Room search: a case-insensitive substring of the name; a query made only of consonants (ㄱㄴㄷ…) also matches the name's initial consonants.
const KK_CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const kkCho = s => [...s].map(c => { const n = c.codePointAt(0) - 0xac00; return n >= 0 && n < 11172 ? KK_CHO[Math.floor(n / 588)] : c; }).join("");
function kkMatch(name, q) {
  q = q.trim().toLowerCase();
  if (!q) return true;
  const n = String(name ?? "").toLowerCase();
  return n.includes(q) || (/^[ㄱ-ㅎ]+$/.test(q) && kkCho(n).includes(q));
}
const kkSeen = () => document.visibilityState === "visible" && kkTl.offsetParent !== null && kkTl.clientHeight > 0;
const kkWide = () => !narrowChat();
const kkCoarse = () => matchMedia("(pointer: coarse), (max-width: 639px)").matches;

/* ---- the pane ---- */
const kkRooms = el("div", { class: "kk-rooms", id: "kk-rooms", "aria-label": TX("apps.kk.rooms_aria") });
const kkHead = el("div", { class: "kk-head", id: "kk-head" });
const kkIn = el("div", { class: "kk-in", id: "kk-in" });
const kkTl = el("div", { class: "kk-tl", id: "kk-tl" }, kkIn);
const kkPill = el("button", { class: "btn kk-pill", id: "kk-pill", type: "button", hidden: true, onclick: () => kkToBottom() }, icon("down"), el("span", { text: TX("apps.kk.new_msg") }));
const kkDrafts = el("div", { class: "kk-drafts", id: "kk-drafts" });
// The bar under the chat window is a request to the assistant (kkAskBot): it revises the open draft or writes a new one, and the reply card below asks for 보내기.
const KK_ASK = TX("apps.kk.ask_ph"), KK_REVISE = TX("apps.kk.revise_ph");
const kkTa = el("textarea", { id: "kk-text", rows: "1", autocomplete: "off", maxlength: "500", placeholder: KK_ASK, "aria-label": TX("apps.kk.ask_aria") });
const kkSendBtn = el("button", { class: "ib pri", id: "kk-send-btn", type: "submit", "aria-label": TX("apps.kk.send_req"), title: TX("apps.kk.send_req") }, icon("send"));
const kkDraftBtn = el("button", { class: "cchip kk-dbtn", id: "kk-draft-btn", type: "button", onclick: () => kkMakeDraft() }, icon("spark"), el("span", { text: TX("apps.kk.draft_reply") }));
// 직접 보내기 (owner 2026-11-04): what is typed goes to the room as it is, past the assistant. It shows only with text, and never on another computer's room.
const kkDirectBtn = el("button", { class: "cchip kk-dbtn", id: "kk-direct-btn", type: "button", hidden: true, onclick: () => kkSendDirect() }, icon("send"), el("span", { text: TX("apps.kk.send_direct") }));
const kkDirectSync = () => { kkDirectBtn.hidden = !kkTa.value.trim() || !!KK.pc; };
kkTa.addEventListener("input", kkDirectSync);
const kkForm = el("form", { class: "sendrow kk-send", id: "kk-form", onsubmit: ev => { ev.preventDefault(); kkSend(); } }, kkTa, el("div", { class: "cbar" }, kkDraftBtn, kkDirectBtn), kkSendBtn);
// The room's reply card sits right under the chat it answers, above the request bar.
const kkFoot = el("div", { class: "composer kk-composer", id: "kk-foot" }, kkDrafts, kkForm);
// 자동 초안 of the open room: the one two-value switch of this screen (the watch toggles are eyes). Built once; kkPaintAuto only flips it.
const kkAutoSw = el("button", { class: "kk-sw", type: "button", role: "switch", "aria-checked": "false", "aria-label": TX("apps.kk.auto"), "data-k": "auto", onclick: () => { const r = kkRoom(KK.open); if (r) kkSetRoom(r, { autoDraft: !r.autoDraft }); } }, el("span", { class: "kk-knob" }));
const kkAuto = el("span", { class: "kk-auto", id: "kk-auto", hidden: true }, el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: TX("apps.kk.auto") })), kkAutoSw);
// The one line under the room head: 미답장 (with 답장 안 함 while no draft card carries it) on the left, 자동 초안 on the right. Its left part is rebuilt only when what it shows changes.
const kkOwedL = el("span", { class: "kk-owed-l" });
const kkOwed = el("div", { class: "kk-owed", id: "kk-owed", hidden: true }, kkOwedL, kkAuto);
let kkOwedSig = "";
function kkPaintAuto() {
  const r = KK.open ? kkRoom(KK.open) : null, show = !!r && !!r.watched, owed = !!r && kkWatching() && !!r.unreplied, bare = owed && !KK.drafts.length, sig = `${KK.open}|${owed}|${bare}`;
  kkAuto.hidden = !show;
  if (show) { kkAutoSw.classList.toggle("on", !!r.autoDraft); kkAutoSw.setAttribute("aria-checked", r.autoDraft ? "true" : "false"); }
  if (sig !== kkOwedSig) { kkOwedSig = sig; clear(kkOwedL).append(...(owed ? [unrepPill(), ...(bare ? [kkNoReply(r)] : [])] : [])); }
  kkOwed.hidden = !show && !owed;
}
// A room that is not watched opens read-only: this bar (at every width) says so in place of the composer and starts watching it.
const kkRo = el("div", { class: "kk-ro", id: "kk-ro", role: "status", hidden: true });
const kkChat = el("div", { class: "kk-chat", id: "kk-chat" }, kkHead, kkOwed, el("div", { class: "kk-box" }, kkTl, kkPill), kkRo, kkFoot);
const kkPane = el("div", { class: "kk", id: "kk", hidden: true }, kkRooms, kkChat);
$("#v-monitoring").append(kkPane);
// Tapping a sender's avatar or name in a room opens his 사용자별 분석 panel.
kkTl.addEventListener("click", ev => {
  const t = ev.target.closest && ev.target.closest(".kk-name, .kk-av:not(.sp)");
  const m = t && t.closest("[data-log][data-author]");
  if (m && m.dataset.author) kkPerson(m.dataset.author);
});
// Preview cards load when they come near the visible timeline (one request per address, kkLpLoad).
if (typeof IntersectionObserver === "function") {
  kkLpIO = new IntersectionObserver(list => { for (const e of list) if (e.isIntersecting) { kkLpIO.unobserve(e.target); kkLpLoad(e.target); } }, { root: kkTl, rootMargin: "300px 0px" });
  kkTopIO = new IntersectionObserver(list => { if (list.some(e => e.isIntersecting)) kkOlder(); }, { root: kkTl, rootMargin: "200px 0px 0px 0px" });
}

const kkAutosize = () => { kkTa.style.height = "auto"; kkTa.style.height = `${Math.min(kkTa.scrollHeight, 140)}px`; };
kkTa.addEventListener("input", () => { kkAutosize(); if (KK.open) KK.typed.set(KK.open, kkTa.value); });
// Enter sends on a desktop; Shift+Enter, and Enter on a phone or a narrow screen, is a new line. The IME's own Enter (isComposing) never sends.
kkTa.addEventListener("keydown", ev => {
  if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing || ev.keyCode === 229 || kkCoarse()) return;
  ev.preventDefault();
  kkSend();
});
// A tap on send must not take focus from the textarea: the phone keyboard would close and the click would not land (same as the chat composer).
kkSendBtn.addEventListener("pointerdown", ev => ev.preventDefault());
kkTl.addEventListener("scroll", () => kkSyncStick(), { passive: true });
for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) kkTl.addEventListener(ev, () => { KK.pin = ""; }, { passive: true });
// The pane resizes when the keyboard opens or the composer grows: a view at the bottom stays there.
let kkH = 0;
new ResizeObserver(() => {
  const h = kkTl.clientHeight, grew = kkH && h !== kkH;
  kkH = h;
  if (!h || !KK.open || KK.loading) return;
  if (grew && KK.stick && kkTl.scrollHeight - kkTl.scrollTop - h > 1) kkTl.scrollTop = kkTl.scrollHeight;
  else if (!KK.placed) kkPlace();
}).observe(kkTl);
// The content grows after it is painted (an image box, a font, a bubble that wraps): a view at the bottom keeps the newest message in sight.
new ResizeObserver(() => {
  if (KK.open && !KK.loading && KK.placed && KK.stick && kkTl.scrollHeight - kkTl.scrollTop - kkTl.clientHeight > 1) kkTl.scrollTop = kkTl.scrollHeight;
}).observe(kkIn);

/* ---- rooms: choose which to watch, and the watched ones as conversation rows ---- */
async function kkLoadRooms() {
  const seq = ++KK.rseq;
  try {
    const r = await api("/api/kakao/rooms");
    if (seq !== KK.rseq) return;
    KK.on = r.on !== false; KK.error = typeof r.error === "string" ? r.error : ""; KK.rooms = Array.isArray(r.rooms) ? r.rooms : [];
    KK.loaded = true; KK.failed = false;
  } catch (e) {
    if (seq !== KK.rseq) return;
    KK.failed = true; KK.loaded = true; KK.rooms = []; KK.error = TX("apps.kk.err_rooms");
  }
  // A room that is not watched stays open (read-only); only a room gone from the list closes.
  if (KK.open && !kkRoom(KK.open) && !KK.failed) kkClose();
  kkPaintRooms();
  if (KK.open) kkPaintChat();
  convSig = ""; convSchedule();   // the 채팅 list's 메일 · 카카오톡 card
}
function kkSwitch(on, label, key, change, small) {
  return el("button", { class: `kk-sw${on ? " on" : ""}${small ? " sm" : ""}`, type: "button", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label, "data-k": key, onclick: ev => { ev.stopPropagation(); change(!on); } }, el("span", { class: "kk-knob" }));
}
async function kkSetRoom(r, patch) {
  const was = { watched: r.watched, autoDraft: r.autoDraft };
  Object.assign(r, patch);
  if (patch.watched === false) r.autoDraft = false;
  kkPaintRooms();
  try {
    await api(`/api/kakao/rooms/${enc(r.chatId)}`, "PUT", patch);
    if (patch.watched !== undefined && KK.open === r.chatId) {
      if (KK.room) KK.room.watched = patch.watched;
      if (!patch.watched) r.unreplied = false;
      kkPaintChat();
      kkTail();
    }
    kkIntgSoon();
  } catch (e) {
    Object.assign(r, was);
    kkPaintRooms();
    toast(e.message, true);
  }
}
const kkSearch = el("input", { id: "kk-q", type: "search", placeholder: TX("apps.kk.search"), "aria-label": TX("apps.kk.search"), autocomplete: "off", enterkeyhint: "search" });
// Typing refilters only the list: the input itself stays in place (it keeps focus and the IME composition).
kkSearch.addEventListener("input", () => { KK.q = kkSearch.value; const pl = $("#kk-pl"); if (pl) clear(pl).append(...kkPickRows()); });
const kkLine1 = (r, name) => el("span", { class: "kk-l1" }, name, kkTag(r) ? el("span", { class: "kk-grp", text: kkTag(r) }) : null);
// The 지켜볼 대화방 list: every room, and a tap on the row adds it to the watched ones or takes it off again. A watched row is the list's selected row with a check; never a switch (the one switch is the room's 자동 초안 card).
const kkPickRow = r => el("button", { class: `pl-row kk-pr${r.watched ? " on" : ""}`, type: "button", role: "checkbox", "aria-checked": r.watched ? "true" : "false", "data-chat": r.chatId, onclick: () => kkSetRoom(r, { watched: !r.watched }) },
  kkAvatar(r.name),
  el("span", { class: "cv-b" }, kkLine1(r, el("span", { class: "cv-n", title: r.name, text: r.name })), kkSubLine(r) ? el("span", { class: "cv-p", text: kkSubLine(r) }) : null),
  r.watched ? icon("check", "kk-ck") : null);
function kkPickRows() {
  const list = KK.rooms.filter(r => kkMatch(r.name, KK.q));
  return list.length ? list.map(kkPickRow) : [el("div", { class: "kk-note", id: "kk-nomatch", role: "status", text: TX("apps.kk.no_match") })];
}
function kkAddOpen() {
  if (KK.adding) return;
  KK.q = ""; kkSearch.value = "";
  const d = el("dialog", { class: "kk-pd kk-add", id: "kk-add", "aria-label": TX("apps.kk.add_title") },
    el("div", { class: "kk-pd-in", tabindex: "-1", autofocus: true },
      fsHead([el("h2", { class: "fs-t", text: TX("apps.kk.add_title") })], { close: () => d.close() }),
      el("div", { class: "kk-pd-b" }, el("label", { class: "pl-search kk-search" }, icon("search"), kkSearch), el("div", { class: "pl-list kk-pl", id: "kk-pl" }, ...kkPickRows()))));
  KK.adding = d;
  d.addEventListener("click", ev => { if (ev.target === d) d.close(); });
  document.body.append(d); d.showModal(); dialogHist(d);
  d.addEventListener("close", () => { if (KK.adding === d) KK.adding = null; d.remove(); });
}
function kkRow(r) {
  const on = KK.open === r.chatId, sub = kkSubLine(r), time = r.lastAt ? el("span", { class: "kk-t", text: kkListTime(r.lastAt) }) : null;
  const owed = r.unreplied && kkViewOf()[0] !== "unreplied";   // inside the 미답장 filter every row is one, so the word is not repeated; the unread number stays
  return el("button", { class: `cv-row pv kk-row${r.unread ? " unread" : ""}${on ? " on" : ""}`, type: "button", "data-chat": r.chatId, "aria-current": on ? "true" : null, onclick: () => kkOpen(r.chatId) },
      kkAvatar(r.name),
      el("span", { class: "cv-b" }, kkLine1(r, el("span", { class: "cv-n", title: r.name, text: r.name })), sub ? el("span", { class: "cv-p", text: sub }) : null),
      // The row end like every list: the time on top, 미답장 and the unread count under it.
      time || r.unread || owed ? el("span", { class: "cv-m" }, time, r.unread || owed ? el("span", { class: "kk-rmeta" },
        owed ? unrepPill() : null,
        r.unread ? el("span", { class: "nb", "aria-label": TX("apps.kk.unread_aria", { n: r.unread }), text: r.unread > 99 ? "99+" : String(r.unread) }) : null) : null) : null);
}
function kkPaintRooms() {
  const top = kkRooms.scrollTop, watched = KK.rooms.filter(r => r.watched).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const note = !KK.loaded ? TX("common.loading") : !KK.on ? TX("apps.kk.off") : KK.error, ready = KK.loaded && !note;
  const shown = watched.filter(kkViewOf()[2]);
  const head = el("div", { class: "kk-lh" }, ...(ready && watched.length ? [kkViewBar(watched)] : [el("span", { class: "kk-pt", text: TX("apps.kk.watched") }), el("span", { class: "kk-cnt", text: ready ? TX("apps.kk.zero") : "" })]),
    ready && KK.rooms.length ? el("button", { class: "btn tonal sm kk-add-btn", id: "kk-add-btn", type: "button", onclick: () => kkAddOpen() }, icon("add"), el("span", { text: TX("apps.kk.add") })) : null);
  const list = el("section", { class: "pl-list kk-watch", "aria-label": TX("apps.kk.watched") });
  if (note) list.append(el("div", { class: "kk-note", role: "status", text: note }), ...(KK.failed ? [appRetry(() => kkLoadRooms())] : []));
  else if (shown.length) list.append(...shown.map(kkRow));
  else list.append(el("div", { class: "kk-note", id: "kk-empty", text: watched.length ? kkViewOf()[3] : KK.rooms.length ? TX("apps.kk.add_prompt") : TX("apps.kk.no_rooms") }));
  // The status of the watches the app owns (its new-message check, a login keeper) is at the top of the pane, on this computer and on the other alike.
  const own = (kkItemNow() || {}).owned || [];
  clear(kkRooms).append(...[own.length ? el("section", { class: "kk-own", "aria-label": TX("apps.kk.status_aria") }, ...own.map(monStatNode)) : null, head, list].filter(Boolean));
  kkRooms.scrollTop = top;
  // The choice list repaints in place: a row with the keyboard focus keeps it.
  const pl = KK.adding && $("#kk-pl");
  if (pl) {
    const had = pl.contains(document.activeElement) && document.activeElement.dataset.chat;
    clear(pl).append(...kkPickRows());
    if (had) { const n = [...pl.children].find(x => x.dataset.chat === had); if (n) n.focus({ preventScroll: true }); }
  }
  kkPaintAuto();
}

/* ---- the chat ---- */
function kkPaintAll() {
  kkPane.classList.toggle("chat-open", !!KK.open);
  kkPaintRooms(); kkPaintChat();
}
function kkPaintChat() {
  const open = !!KK.open, room = kkRoom(KK.open), info = KK.room || room || {};
  kkFoot.hidden = !open || KK.loading || !!KK.roomErr;
  kkPill.hidden = !(open && KK.pill);
  const app = monSettingsApp(kkItemNow()), watching = kkWatching(), owed = watching && !!(room && room.unreplied), sig = `${KK.open}|${info.name}|${info.group}|${app}|${!!AS.by[app]}|${owed}|${watching}`;
  const readOnly = open && !KK.loading && !KK.roomErr && !watching;
  kkFoot.hidden = kkFoot.hidden || !watching;
  kkRo.hidden = !readOnly;
  kkPaintAuto();
  if (readOnly) clear(kkRo).append(el("span", { class: "kk-ro-t", text: TX("apps.kk.readonly") }), room ? el("button", { class: "btn tonal sm", type: "button", "data-k": "watch", text: TX("apps.kk.watch_start"), onclick: () => kkSetRoom(room, { watched: true }) }) : null);
  if (sig !== KK.headSig) {
    KK.headSig = sig;
    clear(kkHead);
    if (open) kkHead.append(kkAvatar(info.name), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: info.name || "" }), el("span", { class: "cv-p", text: kkKindLine(info) || (info.group ? TX("apps.kk.kind.group") : TX("apps.kk.kind.direct")) })), ...asEntry(app));
    monSchedule();   // the item's head gives the gear to the room head while a room is open
  }
  if (!open) { clear(kkIn).append(el("div", { class: "kk-note", text: TX("apps.kk.pick_room") })); return; }
  if (KK.loading) { clear(kkIn).append(el("div", { class: "kk-note", text: TX("common.loading") })); return; }
  if (KK.roomErr) { clear(kkIn).append(el("div", { class: "kk-note", role: "status", text: KK.roomErr }), appRetry(() => kkOpen(KK.open))); return; }
  kkPaintTl(KK.stick);
  kkPaintFoot();
}
// Whether the open room is watched (drafts, sending, 미답장): the room list's flag, else what the chat answer said.
function kkWatching() {
  const r = kkRoom(KK.open);
  return r ? !!r.watched : !!(KK.room && KK.room.watched !== false);
}
// 답장 안 함 of the open room: the pill leaves the header and the room row at the tap; a failed request puts it back.
function kkNoReply(r) {
  return el("button", { class: "cchip unrep-no", type: "button", "data-k": "no-reply", text: TX("apps.kk.no_reply"), onclick: ev => {
    ev.stopPropagation();
    r.unreplied = false;
    kkPaintRooms(); kkPaintChat();
    api(`/api/kakao/chat/${enc(r.chatId)}/no-reply`, "POST", {}).then(() => { toast(TX("apps.kk.no_reply_done")); loadIntegrations(); }, e => {
      r.unreplied = true;
      kkPaintRooms(); kkPaintChat();
      toast(e.message, true);
    });
  } });
}
const kkDateNode = t => el("div", { class: "kk-date", text: kkDate(t) });
const kkMarkNode = () => el("div", { class: "kk-new", role: "separator", "aria-label": TX("apps.kk.unread_from") }, el("span", { text: TX("apps.kk.read_upto") }));
function kkMsgNode(m, first, last) {
  if (kkSys(m)) { const line = kkSysText(m.text); return line ? el("div", { class: "kk-sys", role: "note", "data-log": m.logId, text: line }) : null; }
  const group = m.group ?? !!(KK.room && KK.room.group), { text, ph } = kkBody(m);
  // Plain words with an address: the address is a link and each one gets a preview card under the bubble.
  const urls = !m.media && !ph ? kkUrls(text) : [];
  const bub = (m.media && kkMediaNode(m, m.media)) || el("div", { class: `kk-bub${ph ? " ph" : ""}${urls.length ? " kk-lb" : ""}` }, urls.length ? kkLinkText(text) : text);
  const previews = urls.length ? el("div", { class: "kk-lps" }, ...urls.map(kkLpCard)) : null;
  // On the time side of the bubble: KakaoTalk's yellow number (members who have not read it yet) above the time; nothing when 0.
  const n = m.unread | 0, meta = n > 0 || last ? el("span", { class: "kk-meta" }, n > 0 ? el("span", { class: "kk-rd", "aria-label": TX("apps.kk.unread_people", { n }), text: String(n) }) : null, last ? el("span", { class: "kk-time", text: kkTime(m.sentAt) }) : null) : null;
  if (m.fromMe) return el("div", { class: `kk-m me${first ? " first" : ""}`, "data-log": m.logId }, el("div", { class: "kk-line" }, meta, bub), previews);
  return el("div", { class: `kk-m in${first ? " first" : ""}`, "data-log": m.logId, "data-author": m.authorId || null },
    group ? (first ? kkAvatar(m.sender) : el("span", { class: "kk-av sp", "aria-hidden": "true" })) : null,
    el("div", { class: "kk-mb" }, first ? el("div", { class: "kk-name", text: m.sender || TX("apps.kk.unknown") }) : null, el("div", { class: "kk-line" }, bub, meta), previews));
}
// Sends of this room that are not (yet) a message of the room: sending, failed, or just sent and not read back from the database yet.
function kkPending() {
  return KK.sends.filter(s => {
    if (KK.hidden.has(s.id)) return false;
    if (s.state === "failed") return true;
    // A draft of several messages is in the room once its last message is.
    const last = String(s.text).split(/\n[ \t]*\n/).map(p => p.trim()).filter(Boolean).pop();
    if (KK.msgs.some(m => m.fromMe && (m.text === s.text || m.text === last) && m.sentAt >= s.at - 60000)) return false;
    return s.state !== "sent" || Date.now() - s.at < 120000;
  });
}
function kkSendNode(s) {
  const failed = s.state === "failed", st = failed ? (s.reason ? TX("apps.kk.send.failed_why", { reason: s.reason }) : TX("apps.kk.send.failed")) : s.state === "sent" ? TX("apps.kk.send.sent") : TX("apps.kk.send.sending");
  return el("div", { class: `kk-m me pend ${s.state} first`, "data-send": s.id },
    el("div", { class: "kk-line" }, el("div", { class: "kk-bub", text: s.text })),
    el("div", { class: "kk-st", role: failed ? "alert" : "status" }, s.state === "sent" ? rqSentNode() : el("span", { class: "kk-state", text: st })));
}
function kkTimeline() {
  const out = [], msgs = KK.msgs;
  if (KK.more) out.push(el("div", { class: "kk-top", id: "kk-top" }, el("button", { class: "btn text kk-more", type: "button", text: TX("apps.kk.older"), onclick: () => kkOlder() })));
  let prev = null;
  msgs.forEach((m, i) => {
    const newDay = !prev || kkDay(prev.sentAt) !== kkDay(m.sentAt), mark = !!KK.div && m.logId === KK.div, next = msgs[i + 1], gapBefore = !!prev && KK.gaps.has(prev.logId);
    if (newDay) out.push(kkDateNode(m.sentAt));
    if (mark) out.push(kkMarkNode());
    // Name and avatar once per run of one sender (like KakaoTalk); the time once per same-minute run.
    const cont = !!prev && !newDay && !mark && !gapBefore && !kkSys(prev) && kkWho(prev) === kkWho(m);
    const nextCont = !!next && !KK.gaps.has(m.logId) && kkDay(next.sentAt) === kkDay(m.sentAt) && !(KK.div && next.logId === KK.div) && kkSame(m, next);
    const node = kkMsgNode(m, !cont, !nextCont);
    // A row with nothing visible in it (an empty body, a record this build does not draw) leaves no blank space.
    if (node && (node.textContent.trim() || node.querySelector("img, audio, video, button, a"))) out.push(node);
    if (next && KK.gaps.has(m.logId)) out.push(kkGapNode(m.logId));
    prev = m;
  });
  out.push(...kkPending().map(kkSendNode));
  if (!out.length) out.push(el("div", { class: "kk-note", text: TX("apps.kk.no_msgs") }));
  return out;
}
function kkPaintTl(stick) {
  const keep = kkTl.scrollTop;
  kkLpIO?.disconnect();
  kkTopIO?.disconnect();
  clear(kkIn).append(...kkTimeline());
  kkTl.scrollTop = stick ? kkTl.scrollHeight : keep;
  kkTopWatch();
  kkLpWatch();
  kkSyncStick();
}
// Where the unread line goes (it is drawn, the view still opens at the newest message): before the first message after the web's read position; never opened: KakaoTalk's own unread count says how many of the newest are unread.
function kkMarker(msgs, read, unread) {
  if (read != null) { const m = msgs.find(x => !x.fromMe && kkGt(x.logId, read)); return m ? m.logId : ""; }
  if (unread > 0) { const tail = msgs.filter(x => !x.fromMe).slice(-unread); return tail.length ? tail[0].logId : ""; }
  return "";
}
// A room opens at its newest message, like KakaoTalk.
function kkPlace() {
  if (!kkTl.clientHeight) return;
  kkTl.scrollTop = kkTl.scrollHeight;
  KK.placed = true;
  kkSyncStick();
}
function kkSyncStick() {
  KK.stick = kkTl.scrollTop + kkTl.clientHeight >= kkTl.scrollHeight - 40;
  if (KK.stick && KK.pill) { KK.pill = false; kkPill.hidden = true; }
  kkMaybeRead();
}
function kkToBottom() { KK.pill = false; kkPill.hidden = true; kkTl.scrollTop = kkTl.scrollHeight; kkSyncStick(); }

async function kkOpen(id) {
  const r = kkRoom(id);
  if (!r) return;
  if (KK.open) KK.typed.set(KK.open, kkTa.value);
  const seq = ++KK.seq;
  Object.assign(KK, { open: id, room: { chatId: id, name: r.name, kind: r.kind, group: r.kind === "group" || r.kind === "multi" || r.kind === "open", watched: !!r.watched }, msgs: [], gaps: new Set(), more: false, read: null, div: "", drafts: [], sends: [], ask: null, hidden: new Set(),
    loading: true, roomErr: "", pill: false, stick: true, pin: "", placed: false, readSent: "", drafting: "" });
  kkTa.value = KK.typed.get(id) || ""; kkAutosize();
  kkPaintAll(); convTitle(); bkKkSync();
  try {
    const d = await api(`/api/kakao/chat/${enc(id)}?limit=${KK_PAGE}`);
    if (seq !== KK.seq) return;
    KK.room = d.room || KK.room; KK.msgs = Array.isArray(d.messages) ? d.messages : []; KK.read = d.read ?? null;
    KK.ask = kkAskOf(d); KK.drafts = Array.isArray(d.drafts) ? d.drafts : []; KK.sends = Array.isArray(d.sends) ? d.sends : [];
    KK.more = KK.msgs.length >= KK_PAGE; KK.div = kkMarker(KK.msgs, KK.read, d.kakaoUnread | 0);
    KK.loading = false; KK.pin = "bottom";
    kkPaintAll(); convTitle();
    kkPlace();
  } catch (e) {
    if (seq !== KK.seq) return;
    KK.loading = false; KK.roomErr = appFail(e, TX("apps.kk.err_chat"));
    kkPaintAll();
  }
}
function kkClose() {
  if (KK.open) KK.typed.set(KK.open, kkTa.value);
  KK.open = ""; KK.seq++; KK.loading = false; KK.roomErr = "";
  kkPaintAll(); convTitle(); bkKkSync();
}
// The app bar's back arrow leaves an open room for the room column first, at every width (04-state.js #back); a wide screen gives the room no history step (histFlat).
function kkBack() {
  if (!(KK.vis && KK.open && current === "monitoring" && !MON.list)) return false;
  kkClose();
  return true;
}
// The older page, one load in flight at a time (an auto-load at the top and the fallback button share it). The message that was at the top
// of the view keeps its offset: the content added above it never moves the reader.
async function kkOlder() {
  const id = KK.open, first = KK.msgs[0];
  if (!id || !first) return;
  if (KK.olderBusy) { KK.olderAgain = true; return; }
  KK.olderBusy = true;
  const edge = kkTl.getBoundingClientRect().top;
  const shown = [...kkTl.querySelectorAll("[data-log]")];
  const anchor = shown.find(n => n.getBoundingClientRect().bottom > edge + 1) || shown[0];
  const anchorId = anchor ? anchor.dataset.log : first.logId;
  const before = anchor ? anchor.getBoundingClientRect().top - edge : 0;
  try {
    const d = await api(`/api/kakao/chat/${enc(id)}?limit=${KK_PAGE}&before=${enc(first.logId)}`);
    if (KK.open !== id) return;
    const got = Array.isArray(d.messages) ? d.messages : [], have = new Set(KK.msgs.map(m => m.logId));
    KK.msgs = [...got.filter(m => !have.has(m.logId)), ...KK.msgs]; KK.more = got.length >= KK_PAGE; KK.pin = "";
    const h = kkTl.scrollHeight;
    kkLpIO?.disconnect();
    kkTopIO?.disconnect();
    clear(kkIn).append(...kkTimeline());
    const now = kkTl.querySelector(`[data-log="${anchorId}"]`);
    kkTl.scrollTop += now ? now.getBoundingClientRect().top - edge - before : kkTl.scrollHeight - h;
    kkTopWatch();
    kkLpWatch();
    kkSyncStick();
  } catch (e) { toast(e.message, true); }
  finally {
    KK.olderBusy = false;
    if (KK.olderAgain) {
      KK.olderAgain = false;
      const top = $("#kk-top", kkIn);
      if (top && KK.more && top.getBoundingClientRect().bottom > kkTl.getBoundingClientRect().top) kkOlder();
    }
  }
}
// New messages after the last one we hold; also refreshes the room's drafts and sends (the answer carries both).
async function kkTail() {
  const id = KK.open;
  if (!id || KK.loading || KK.roomErr) return;
  if (KK.tailing) { KK.again = true; return; }
  KK.tailing = true;
  try {
    do {
      KK.again = false;
      // Pages of rows after the newest one we hold: a full page means more wait behind it (a burst of more than KK_PAGE).
      for (let fresh = KK_PAGE; fresh >= KK_PAGE;) {
        const last = KK.msgs.length ? KK.msgs[KK.msgs.length - 1].logId : "";
        const d = await api(`/api/kakao/chat/${enc(id)}?limit=${KK_PAGE}${last ? `&after=${enc(last)}` : ""}`);
        if (KK.open !== id) return;
        fresh = kkApply(d);
      }
      // A row can land below the newest logId we hold (a late sync): the newest page is read again and merged in logId order.
      const d = await api(`/api/kakao/chat/${enc(id)}?limit=${KK_PAGE}`);
      if (KK.open !== id) return;
      kkApply(d);
    } while (KK.again);
  } catch { /* the next event or the minute timer asks again */ } finally { KK.tailing = false; }
}
function kkApply(d) {
  const have = new Set(KK.msgs.map(m => m.logId)), fresh = (Array.isArray(d.messages) ? d.messages : []).filter(m => !have.has(m.logId));
  if (Array.isArray(d.drafts)) {
    KK.drafts = d.drafts; KK.ask = kkAskOf(d);
    // A peer's room gets no draft event: its old draft going away is the new one landing.
  }
  if (Array.isArray(d.sends)) KK.sends = d.sends;
  if (d.room) KK.room = d.room;
  if (fresh.length) KK.msgs = [...KK.msgs, ...fresh].sort((a, b) => (kkGt(a.logId, b.logId) ? 1 : kkGt(b.logId, a.logId) ? -1 : 0));
  const stick = KK.stick || fresh.some(m => m.fromMe);
  if (fresh.some(m => !m.fromMe) && !stick) { KK.pill = true; kkPill.hidden = false; }
  if (stick) KK.pin = "bottom";
  // The open room's own row follows the same rows just appended (one source of truth per room).
  const row = kkRoom(KK.open), last = KK.msgs[KK.msgs.length - 1];
  if (fresh.length && row && last) {
    row.hint = kkHint(last); row.lastAt = last.sentAt;
    row.unread = stick ? 0 : (row.unread | 0) + fresh.filter(m => !m.fromMe).length;
    kkPaintRooms();
  }
  kkPaintTl(stick);
  kkPaintFoot();
  return fresh.length;
}
function kkMaybeRead() {
  if (!KK.open || !KK.placed || !KK.stick || KK.loading || !kkSeen()) return;
  const last = KK.msgs.length ? KK.msgs[KK.msgs.length - 1].logId : "";
  if (!last || (KK.readSent && !kkGt(last, KK.readSent))) return;
  const id = KK.open, prev = KK.readSent;
  KK.readSent = last;
  api(`/api/kakao/chat/${enc(id)}/read`, "POST", { logId: last }).then(() => {
    const r = kkRoom(id);
    if (r && r.unread) { r.unread = 0; kkPaintRooms(); }
    kkIntgSoon();
  }, () => { if (KK.readSent === last) KK.readSent = prev; });
}
// KakaoTalk's read counters changed: ask for the numbers of the shown messages (no bodies) and repaint when any changed.
async function kkReads() {
  const id = KK.open, first = KK.msgs[0];
  if (!id || !first || KK.loading || KK.roomErr) return;
  if (KK.reading) { KK.readAgain = true; return; }
  KK.reading = true;
  try {
    do {
      KK.readAgain = false;
      const d = await api(`/api/kakao/chat/${enc(id)}/reads?from=${enc(KK.msgs[0].logId)}`);
      if (KK.open !== id) return;
      const counts = d && d.counts || {};
      let changed = false;
      for (const m of KK.msgs) if (m.logId in counts && (m.unread | 0) !== counts[m.logId]) { m.unread = counts[m.logId]; changed = true; }
      if (changed) kkPaintTl(KK.stick);
    } while (KK.readAgain);
  } catch { /* the next event or the minute timer asks again */ } finally { KK.reading = false; }
}
const kkIntgSoon = () => { clearTimeout(KK.intgT); KK.intgT = setTimeout(loadIntegrations, 500); };

/* ---- sending ---- */
function kkAddSend(r, text) {
  if (r && r.id && !KK.sends.some(s => s.id === r.id)) KK.sends.push({ id: r.id, text, state: r.state || "sending", at: Date.now() });
}
// text = what the owner wrote, sent to the room as typed.
async function kkSendText(text) {
  const id = KK.open;
  if (!id || !text || KK.sending) return;
  KK.sending = true;
  try {
    const r = await api(`/api/kakao/chat/${enc(id)}/send`, "POST", { text });
    if (KK.open === id) {
      kkAddSend(r, text);
      KK.stick = true; KK.pin = "bottom";
      kkPaintTl(true); kkPaintFoot();
    }
    return true;
  } catch (e) {
    toast(e.message, true);
    kkTail();
    return false;
  } finally { KK.sending = false; }
}
// The request bar under the chat window: what the owner types goes to the assistant, never straight to the room. With a draft waiting it is the change to make
// (the queue's revise of the newest draft, raAct), else it says what the new message is (POST .../draft { intent }); the reply card then asks for 보내기, and the
// draft is split into the natural messages the existing flow already makes (d.parts).
function kkAskBot(text) {
  const id = KK.open;
  if (KK.drafting === id) { toast(TX("apps.kk.drafting_wait"), true); return; }
  // The other computer's queue takes a revise but its gateway not a new message's intent (34-peer-monitoring.js kakao draft): say so instead of making an unrelated draft there.
  if (KK.pc && !KK.drafts.length) { toast(TX("apps.kk.peer_revise"), true); return; }
  const ts = x => (typeof x === "number" ? x : Date.parse(x) || 0), d = KK.drafts.slice().sort((a, b) => ts(b.created) - ts(a.created))[0];
  kkTa.value = ""; KK.typed.delete(id); kkAutosize(); kkDirectSync();
  const it = d && kkQueueItem(d);
  if (it) raAct(it, "revise", { change: text.slice(0, 500) }); else if (d) toast(TX("reply.act_fail"), true); else kkComposeMake(text);
  if (kkWide()) kkTa.focus();
}
async function kkSendDirect() {
  const text = kkTa.value.trim(), id = KK.open;
  if (!id || !text || KK.sending) return;
  kkTa.value = ""; KK.typed.delete(id); kkAutosize(); kkDirectSync();
  const ok = await kkSendText(text);
  if (!ok && KK.open === id && !kkTa.value) { kkTa.value = text; kkAutosize(); kkDirectSync(); }
}
async function kkSend() {
  const text = kkTa.value.trim();
  if (!KK.open || !text || KK.sending) return;
  kkAskBot(text);
}

/* ---- drafts ---- */
// The room's open question (the draft model found that the last message needs the owner's decision): { question, choices } or null.
const kkAskOf = d => (d && d.ask && typeof d.ask.question === "string" && Array.isArray(d.ask.choices) && d.ask.choices.length ? d.ask : null);
// The question with one button per choice: a pick makes the draft for it (one model call, then the normal 보내기 / 고치기 / 버리기 card); 직접 쓸게 forgets the question and opens the composer.
function kkAskCard() {
  const a = KK.ask, id = KK.open;
  if (!a || KK.drafting === id) return null;
  const own = async ev => {
    ev.currentTarget.disabled = true;
    try { await api(`/api/kakao/chat/${enc(id)}/ask/drop`, "POST", {}); } catch (e) { toast(e.message, true); }
    if (KK.open !== id) return;
    KK.ask = null; kkPaintFoot(); kkTa.focus();
  };
  return el("div", { class: "kk-draft kk-ask" },
    el("div", { class: "kk-dh", text: TX("apps.kk.choose_first") }),
    el("div", { class: "kk-dt", text: a.question }),
    el("div", { class: "btns kk-choices" },
      ...a.choices.map((c, i) => el("button", { class: "btn tonal", type: "button", "data-k": "pick", "data-i": String(i), text: c, onclick: () => kkMakeDraft(c) })),
      el("button", { class: "btn text", type: "button", "data-k": "own", text: TX("apps.kk.write_own"), onclick: own })));
}
// A draft of several KakaoTalk messages shows one bubble per message in its queue card (rqItemCard); 고치기, 직접 수정 and 보내기 are the queue's.
const kkQueueItem = d => raItems().find(i => i.ref === d.code) || null;
function kkPaintFoot() {
  const ask = kkAskCard(), hadRv = document.activeElement && document.activeElement.classList.contains("kk-rv");
  const making = !!KK.open && KK.drafting === KK.open;
  // A new draft on its way (no card to say "고치는 중…" yet): the place where its card will be says so.
  const wait = making ? [el("div", { class: "kk-mk", role: "status", text: TX("apps.kk.making_reply") })] : [];
  const drawn = paintKeep(kkDrafts, [...(ask ? [ask] : []), ...wait, ...KK.drafts.map(kkQueueItem).filter(Boolean).map(it => rqItemCard(it, { bare: true }))], kkPaintFoot);
  // A draft the queue does not list yet (it was just made): the queue is read once more and the foot drawn again.
  const miss = KK.drafts.filter(d => !kkQueueItem(d)).map(d => d.code).join();
  if (miss && miss !== KK.raMiss) raLoad().then(kkPaintFoot);
  KK.raMiss = miss;
  kkDrafts.hidden = !kkDrafts.firstChild;
  // A draft that lands while the room is open (the owner's request came back) is brought into view: the card sits under the request bar, below the chat window.
  const codes = KK.drafts.map(d => d.code);
  if (drawn && KK.droom === KK.open && codes.some(c => !KK.dsig.includes(c))) requestAnimationFrame(() => kkDrafts.scrollIntoView({ block: "nearest" }));
  if (drawn) { KK.dsig = codes; KK.droom = KK.open; }
  if (hadRv) { const i = $(".kk-rv", kkDrafts); if (i) i.focus({ preventScroll: true }); }
  kkDraftBtn.disabled = making;
  kkPaintAuto();
  kkDraftBtn.lastChild.textContent = making ? TX("apps.kk.making") : TX("apps.kk.draft_reply");
  // The bar is the request to the assistant: the change to the waiting draft, or a new message.
  kkTa.placeholder = KK.drafts.length ? KK_REVISE : KK_ASK;
  const label = TX("apps.kk.send_req");
  kkSendBtn.setAttribute("aria-label", label); kkSendBtn.title = label;
}
// A new message the owner asked for in his own words (kkAskBot with no draft waiting); the same draft call (POST .../draft { intent }) writes it in his voice.
async function kkComposeMake(intent) {
  const id = KK.open, text = String(intent || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!id || !text || KK.drafting === id) return;
  KK.drafting = id;
  kkPaintFoot();
  clearTimeout(KK.draftT);
  KK.draftT = setTimeout(() => { if (KK.drafting === id) { KK.drafting = ""; kkPaintFoot(); toast(TX("apps.kk.draft_late"), true); } }, 120000);
  try {
    const r = await api(`/api/kakao/chat/${enc(id)}/draft`, "POST", { intent: text });
    if (r && typeof r.error === "string" && r.error) throw new Error(r.error);
  } catch (e) {
    clearTimeout(KK.draftT);
    if (KK.drafting === id) KK.drafting = "";
    kkPaintFoot();
    toast(e.message, true);
  }
}
// Drafts are made only on demand (or by a room's 자동 초안): the request starts it, and the kakao_draft event for this room says it is done.
async function kkMakeDraft(choice) {
  const id = KK.open;
  if (!id || KK.drafting === id) return;
  KK.drafting = id; kkPaintFoot();
  clearTimeout(KK.draftT);
  KK.draftT = setTimeout(() => { if (KK.drafting === id) { KK.drafting = ""; kkPaintFoot(); toast(TX("apps.kk.draft_late"), true); } }, 120000);
  try {
    const r = await api(`/api/kakao/chat/${enc(id)}/draft`, "POST", choice ? { choice } : {});
    if (r && typeof r.error === "string" && r.error) throw new Error(r.error);
  } catch (e) {
    clearTimeout(KK.draftT);
    if (KK.drafting === id) KK.drafting = "";
    kkPaintFoot();
    toast(e.message, true);
  }
}

/* ---- live ---- */
// The newest line of one room, from the hub (logId, preview, time, unread): a room row follows the database without re-reading the whole list.
async function kkRoomLatest(chatId) {
  if (!kkRoom(chatId)) { kkLoadRooms(); return; }
  try {
    const d = await api(`/api/kakao/rooms/${enc(chatId)}/latest`);
    if (KK.vis) kkSetRow(chatId, d);
  } catch { kkLoadRooms(); }
}
function kkSetRow(chatId, d) {
  const r = kkRoom(chatId);
  if (!r || !d) return;
  if (typeof d.text === "string" && d.text) r.hint = d.text;
  if (d.at) r.lastAt = d.at;
  if (typeof d.unread === "number") r.unread = d.unread;
  kkPaintRooms();
}
// The event stream (99-boot.js): ids only, so the bodies are fetched here.
function kkLive(e) {
  if (e.kind === "kakao_draft") rqSoon();   // the 답장 대기 screen (30-replies.js) reads this computer's drafts again
  if (KK.pc) return;   // the stream is this computer's; a peer's room is refreshed by the timer
  if (e.kind === "kakao_read") { if (KK.vis && e.chatId === KK.open) kkReads(); return; }
  if (e.kind === "kakao_rooms" || e.kind === "kakao_unreplied") { if (KK.vis || current === "chat") kkLoadRooms(); kkIntgSoon(); return; }
  kkIntgSoon();
  if (!KK.vis) return;
  const open = e.chatId === KK.open;
  if (e.kind === "kakao") { if (open) kkTail(); else kkRoomLatest(e.chatId); }
  else if (e.kind === "kakao_draft" && open) {
    if (KK.drafting === e.chatId) {
      KK.drafting = ""; clearTimeout(KK.draftT); kkPaintFoot();
      if (typeof e.error === "string" && e.error) toast(e.error, true);
    }
    kkTail();
  }
}
// A peer's room gets no stream events here (the stream is this computer's): while it is open, ask its owner for the room's newest logId every ~2 s
// (GET .../head: one small read, none while the owner's database files do not change) and fetch rows only when that moved. An owner without /head: tail directly.
const KK_PEER_MS = 2000;
async function kkPeerPoll() {
  const id = KK.open;
  if (!KK.pc || !KK.vis || !id || KK.loading || KK.roomErr || KK.peerBusy || document.visibilityState !== "visible") return;
  KK.peerBusy = true;
  try {
    const d = await api(`/api/kakao/chat/${enc(id)}/head`);
    if (KK.open !== id) return;
    const head = d && d.logId ? String(d.logId) : "", last = KK.msgs.length ? KK.msgs[KK.msgs.length - 1].logId : "";
    if (head && `${id}:${head}` !== KK.peerHead && (!last || kkGt(head, last))) await kkTail();
    if (KK.open === id) KK.peerHead = `${id}:${head}`;
  } catch { await kkTail(); } finally { KK.peerBusy = false; }
}
// After a stream reconnect or coming back to the page: ask again.
function kkResync() { if (!KK.vis) return; kkLoadRooms(); kkTail(); kkReads(); kkMaybeRead(); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kkResync(); });

/* ---- the 모니터링 item ---- */
// renderMonitoring (30-monitoring.js): `item` = the kakao item is the selected one; `shown` = its pane is on screen (not behind the phone's list).
function kkMode(item, shown, pc) {
  if (KK.vis && (KK.pc ? KK.pc.url : "") !== (pc ? pc.url : "")) {   // the other computer's rooms: start from an empty pane
    Object.assign(KK, { vis: false, open: "", rooms: [], loaded: false, failed: false, error: "", roomErr: "", room: null, msgs: [], drafts: [], ask: null, sends: [], rseq: KK.rseq + 1 });
    if (KK.adding) KK.adding.close();
    KK.seq++; clearInterval(KK.timer); clearInterval(KK.peerT);
  }
  KK.pc = item ? pc || null : null;
  $("#v-monitoring").classList.toggle("kk-on", item);
  kkPane.hidden = !item;
  if (shown && !KK.vis) {
    KK.vis = true; KK.open = ""; KK.seq++;
    kkPaintAll();
    kkLoadRooms();
    clearInterval(KK.timer);
    KK.timer = setInterval(() => { if (document.visibilityState === "visible") kkResync(); }, 60000);
    clearInterval(KK.peerT);
    if (KK.pc) KK.peerT = setInterval(kkPeerPoll, KK_PEER_MS);
  } else if (!shown && KK.vis) {
    KK.vis = false; KK.open = ""; KK.seq++; clearInterval(KK.timer); clearInterval(KK.peerT);
  }
  bkKkSync();
}
