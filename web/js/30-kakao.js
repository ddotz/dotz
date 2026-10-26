/* ---------- 모니터링 > 앱 > 카카오톡: choose the rooms to watch, and a KakaoTalk-style chat per chosen room ---------- */
// API: docs/kakao-rooms-api.md. The item (30-monitoring.js, key "i:kakao") shows this pane instead of the notice timeline: renderMonitoring calls
// kkMode(). Wide screens put the room column beside the chat; below 1100px they are two screens (KK.open picks which; the app bar's back
// arrow, kkBack(), leaves the chat). Live updates arrive on the event stream as kakao / kakao_send / kakao_draft / kakao_rooms / kakao_read (99-boot.js -> kkLive).
// Each message carries `unread` (KakaoTalk's yellow number: members who have not read it yet); kakao_read -> /reads refreshes the numbers without bodies.
// Nothing is ever sent without a click: a typed message, a draft's 보내기 or an edited draft's 보내기 is the owner's own action.
// Message text only ever goes through el({text}) / textContent, never innerHTML.
const KK_KEY = "i:kakao";
const kkItem = it => !!it && (it.key === KK_KEY || !!it.kk);   // a peer's Kakao item (34-peer-monitoring.js) shows this same pane, its rooms read through the proxy (KK.pc)
const KK_PAGE = 50;
const KK = {
  vis: false, on: true, error: "", rooms: [], loaded: false, failed: false, pick: null,   // pick: null = open while no room is chosen
  open: "", seq: 0, loading: false, roomErr: "", room: null, msgs: [], more: false, read: null, div: "", drafts: [], sends: [], ask: null, hidden: new Set(),
  stick: true, pill: false, pin: "", placed: false, readSent: "", edit: null, sending: false, drafting: "", revise: null, reviseCode: "", draftT: 0, tailing: false, again: false,
  typed: new Map(), headSig: "", rseq: 0, timer: 0, intgT: 0, pc: null, reading: false, readAgain: false, q: "", compose: null,
  peerT: 0, peerBusy: false, peerHead: "", lp: new Map(),
};

/* ---- small helpers ---- */
const kkBig = s => { try { return BigInt(s); } catch { return 0n; } };
const kkGt = (a, b) => kkBig(a) > kkBig(b);
const kkDay = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const kkTime = t => new Date(t).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
const kkDate = t => new Date(t).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
function kkListTime(t) {
  if (!t) return "";
  const d = new Date(t), now = new Date(), y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (kkDay(t) === kkDay(now)) return kkTime(t);
  if (kkDay(t) === kkDay(y)) return "어제";
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}
const kkHue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
const kkInitial = s => [...String(s ?? "").trim()][0] || "?";
function kkAvatar(name, cls = "") {
  const n = el("span", { class: `kk-av ${cls}`.trim(), "aria-hidden": "true", text: kkInitial(name) });
  n.style.setProperty("--h", String(kkHue(name)));
  return n;
}
// What a message that is not plain text says (KakaoTalk's type codes). A reply (26) carries its own text.
const KK_TYPE = { 2: "(사진)", 27: "(사진)", 3: "(동영상)", 4: "(음성 메시지)", 5: "(음성 메시지)", 12: "(이모티콘)", 20: "(이모티콘)", 25: "(이모티콘)", 18: "(파일)", 16: "(위치)" };
// The text of a message (the server sends it for text, replies, feed lines and unknown types); else the placeholder of its type.
function kkBody(m) {
  const type = Number(m.type), text = String(m.text ?? "");
  if (text) return { text, ph: false };
  return { text: KK_TYPE[type] || "(기타 메시지)", ph: true };
}
const kkSys = m => Number(m.type) === 0;

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
const kkLpCard = url => el("a", { class: "kk-lp", href: url, target: "_blank", rel: "noopener noreferrer", "data-url": url }, el("span", { class: "kk-lp-ph", text: "링크 미리보기" }));
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
function kkLpWatch() {
  for (const c of kkIn.querySelectorAll(".kk-lp[data-url]")) if (kkLpIO) kkLpIO.observe(c); else kkLpLoad(c);
}

/* ---- photos, videos, voice, files, replies, locations: built from m.media (the server sends no URL; bytes come from /api/kakao/media/...) ---- */
const KK_GONE = "기간이 지나 볼 수 없어요";
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
  const b = el("button", { class: "kk-photo", type: "button", "data-k": "photo", "aria-label": `${alt} 크게 보기`, onclick: () => kkViewer(m, md, i) });
  b.append(kkImg(m, i, "thumb", alt, b));
  return b;
}
function kkPhotoNode(m, md) {
  if (md.expired) return kkGoneCard();
  const count = Math.max(1, md.count | 0);
  if (count === 1) {
    const b = kkPhotoBtn(m, md, 0, "사진");
    kkRatio(b, md.w, md.h, 240);
    return el("div", { class: "kk-media" }, b);
  }
  const cols = count >= 5 ? 3 : 2, shown = Math.min(count, 6), grid = el("div", { class: `kk-media kk-album c${cols}`, "data-count": String(count) });
  for (let i = 0; i < shown; i++) {
    const b = kkPhotoBtn(m, md, i, `사진 ${i + 1}`);
    if (i === shown - 1 && count > shown) b.append(el("span", { class: "kk-more-n", text: `+${count - shown + 1}` }));
    grid.append(b);
  }
  return grid;
}
function kkVideoNode(m, md) {
  if (md.expired) return kkGoneCard();
  const b = el("button", { class: "kk-photo kk-video", type: "button", "data-k": "video", "aria-label": "동영상 재생", onclick: () => kkViewer(m, md, 0) });
  kkRatio(b, md.w, md.h, 240);
  b.append(kkImg(m, 0, "thumb", "동영상", b), el("span", { class: "kk-play", "aria-hidden": "true" }));
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
    md.local ? el("a", { class: "btn tonal kk-open", href: kkFileUrl(m), target: "_blank", rel: "noopener", download: md.name, text: "열기" }) : el("span", { class: "kk-sub kk-nopc", text: "PC에 없음" }));
}
// Like KakaoTalk: "<author of the original>에게 답장" over the quoted original, then the reply's own text. The quote is a button that jumps to
// the original (kkJump), when the attachment names its logId.
function kkReplyNode(m, md) {
  const { text } = kkBody(m);
  return el("div", { class: "kk-bub reply" },
    el("button", { class: `kk-quote${md.srcLogId ? " jump" : ""}`, type: "button", disabled: !md.srcLogId, "data-src": md.srcLogId || null, "aria-label": md.srcLogId ? "원래 메시지로 이동" : null, onclick: ev => { ev.stopPropagation(); kkJump(md.srcLogId); } },
      el("span", { class: "kk-qn", text: md.quoteSender ? `${md.quoteSender}에게 답장` : "답장" }), el("span", { class: "kk-qt", text: md.quote })),
    el("div", { class: "kk-rt", text }));
}
// The original message of a quote: scroll it into view and flash it briefly. When the page does not hold it, the server sends the page
// around that logId (?around=); a logId the room does not have says so with a toast.
const kkFlash = node => {
  node.classList.remove("kk-hl");
  void node.offsetWidth;
  node.classList.add("kk-hl");
  clearTimeout(node._hlT);
  node._hlT = setTimeout(() => node.classList.remove("kk-hl"), 1800);
};
function kkJump(src) {
  src = String(src || "").trim();
  if (!src || !KK.open) return;
  const find = () => [...kkTl.querySelectorAll("[data-log]")].find(n => n.dataset.log === src);
  let node = find();
  if (!node) {
    const id = KK.open;
    api(`/api/kakao/chat/${enc(id)}?limit=${KK_PAGE}&around=${enc(src)}`).then(d => {
      if (KK.open !== id) return;
      // The page around the original is merged into what the room already shows (a jump never drops the current view).
      const have = new Set(KK.msgs.map(x => x.logId)), got = Array.isArray(d.messages) ? d.messages : [];
      KK.msgs = [...KK.msgs, ...got.filter(x => !have.has(x.logId))].sort((a, b) => (kkGt(a.logId, b.logId) ? 1 : kkGt(b.logId, a.logId) ? -1 : 0));
      if (d.room) KK.room = d.room;
      if (Array.isArray(d.drafts)) { KK.drafts = d.drafts; KK.ask = kkAskOf(d); }
      if (Array.isArray(d.sends)) KK.sends = d.sends;
      if (d.read !== undefined) KK.read = d.read;
      kkPaintTl(false);
      const hit = find();
      if (!hit) { toast("원래 메시지를 찾지 못했어요", true); return; }
      hit.scrollIntoView({ block: "center" });
      kkFlash(hit);
      kkSyncStick();
    }, e => toast(e.message, true));
    return;
  }
  node.scrollIntoView({ block: "center" });
  kkFlash(node);
  kkSyncStick();
}
// A sticker: its image from the media route when the server has one (md.image), else (or when it cannot be fetched) one chip with its name.
// The text written with it sits in a bubble under it.
const kkEmoChip = md => el("div", { class: "kk-bub ph kk-emo-chip", text: md.alt || "이모티콘" });
function kkEmoticonNode(m, md) {
  const sticker = md.image
    ? el("div", { class: "kk-sticker" }, el("img", { src: kkMediaUrl(m, 0, "full"), alt: md.alt || "이모티콘", loading: "lazy", decoding: "async", draggable: "false", onerror: ev => ev.currentTarget.parentNode.replaceWith(kkEmoChip(md)) }))
    : kkEmoChip(md);
  const words = String(md.text ?? "").trim();
  return words ? el("div", { class: "kk-emo" }, sticker, el("div", { class: "kk-bub kk-emo-t", text: words })) : sticker;
}
function kkLocationNode(md) {
  const href = `https://map.kakao.com/link/map/${enc(md.label)},${Number(md.lat)},${Number(md.lng)}`;
  return el("a", { class: "kk-bub card loc", href, target: "_blank", rel: "noopener" }, el("span", { class: "kk-fn", text: `위치: ${md.label}` }), el("span", { class: "kk-sub", text: "지도에서 보기" }));
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
  const prev = el("button", { class: "x", type: "button", "data-k": "prev", "aria-label": "이전 사진", onclick: () => go(i - 1) }, icon("back"));
  const next = el("button", { class: "x", type: "button", "data-k": "next", "aria-label": "다음 사진", onclick: () => go(i + 1) }, icon("chev"));
  const d = el("dialog", { class: "lbox kk-vwd", "aria-label": md.kind === "video" ? "동영상 보기" : "사진 보기" },
    el("div", { class: "lb-in" }, el("div", { class: "lb-bar" }, title, prev, next, el("button", { class: "x", type: "button", "data-k": "close", "aria-label": "닫기", onclick: () => d.close() }, icon("close"))), body));
  const gone = ev => ev.currentTarget.replaceWith(el("p", { class: "tv-st", role: "status", text: KK_GONE }));
  const paint = () => {
    title.textContent = md.kind === "video" ? "동영상" : count > 1 ? `사진 ${i + 1} / ${count}` : "사진";
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
const kkSame = (a, b) => !kkSys(a) && !kkSys(b) && kkWho(a) === kkWho(b) && Math.floor(a.sentAt / 60000) === Math.floor(b.sentAt / 60000);
const kkKindLine = r => (r.kind === "group" || r.kind === "multi" ? "단체 대화방" : r.kind === "direct" || r.kind === "dm" ? "1:1 대화" : r.kind === "open" ? "오픈채팅" : "");
// Under a room's name: its kind and the hub's hint (the newest message, else the member count), so rooms of the same name can be told apart.
const kkSubLine = r => [kkKindLine(r), r.hint].filter(Boolean).join(" · ");
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
const kkRooms = el("div", { class: "kk-rooms", id: "kk-rooms", "aria-label": "카카오톡 대화방" });
const kkHead = el("div", { class: "kk-head", id: "kk-head" });
const kkIn = el("div", { class: "kk-in", id: "kk-in" });
const kkTl = el("div", { class: "kk-tl", id: "kk-tl" }, kkIn);
const kkPill = el("button", { class: "btn kk-pill", id: "kk-pill", type: "button", hidden: true, onclick: () => kkToBottom() }, icon("down"), el("span", { text: "새 메시지" }));
const kkDrafts = el("div", { class: "kk-drafts", id: "kk-drafts" });
const kkEditBar = el("div", { class: "kk-edit", id: "kk-edit", hidden: true }, el("span", { text: "답장 초안을 고치는 중이에요" }), el("button", { class: "btn text", type: "button", "data-k": "cancel", text: "취소", onclick: () => kkEditCancel() }));
const kkTa = el("textarea", { id: "kk-text", rows: "1", autocomplete: "off", placeholder: "메시지 보내기", "aria-label": "카카오톡 메시지" });
const kkSendBtn = el("button", { class: "ib pri", id: "kk-send-btn", type: "submit", "aria-label": "보내기", title: "보내기" }, icon("send"));
const kkDraftBtn = el("button", { class: "cchip kk-dbtn", id: "kk-draft-btn", type: "button", onclick: () => kkMakeDraft() }, icon("spark"), el("span", { text: "답장 초안" }));
const kkNewBtn = el("button", { class: "cchip kk-dbtn", id: "kk-new-btn", type: "button", onclick: () => kkComposeOpen() }, icon("pencil"), el("span", { text: "메시지 만들어 줘" }));
const kkForm = el("form", { class: "sendrow kk-send", id: "kk-form", onsubmit: ev => { ev.preventDefault(); kkSend(); } }, kkTa, el("div", { class: "cbar" }, kkDraftBtn, kkNewBtn), kkSendBtn);
const kkIntent = el("div", { class: "kk-intent", id: "kk-intent", hidden: true });
const kkFoot = el("div", { class: "composer kk-composer", id: "kk-foot" }, kkDrafts, kkEditBar, kkIntent, kkForm);
// A room that is not watched opens read-only: this bar (at every width) says so in place of the composer and starts watching it.
const kkRo = el("div", { class: "kk-ro", id: "kk-ro", role: "status", hidden: true });
const kkChat = el("div", { class: "kk-chat", id: "kk-chat" }, kkHead, el("div", { class: "kk-box" }, kkTl, kkPill), kkRo, kkFoot);
const kkPane = el("div", { class: "kk", id: "kk", hidden: true }, kkRooms, kkChat);
$("#v-monitoring").append(kkPane);
// Preview cards load when they come near the visible timeline (one request per address, kkLpLoad).
if (typeof IntersectionObserver === "function") kkLpIO = new IntersectionObserver(list => { for (const e of list) if (e.isIntersecting) { kkLpIO.unobserve(e.target); kkLpLoad(e.target); } }, { root: kkTl, rootMargin: "300px 0px" });

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
    KK.failed = true; KK.loaded = true; KK.rooms = []; KK.error = "대화방 목록을 불러오지 못했어요";
  }
  // A room that is not watched stays open (read-only); only a room gone from the list closes.
  if (KK.open && !kkRoom(KK.open) && !KK.failed) kkClose();
  kkPaintRooms();
  if (KK.open) kkPaintChat();
}
function kkSwitch(on, label, key, change, small) {
  return el("button", { class: `kk-sw${on ? " on" : ""}${small ? " sm" : ""}`, type: "button", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label, "data-k": key, onclick: ev => { ev.stopPropagation(); change(!on); } }, el("span", { class: "kk-knob" }));
}
async function kkSetRoom(r, patch) {
  const was = { watched: r.watched, autoDraft: r.autoDraft };
  if (KK.pick === null) KK.pick = true;
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
const kkSearch = el("input", { class: "kk-q", id: "kk-q", type: "search", placeholder: "대화방 검색", "aria-label": "대화방 검색", autocomplete: "off", enterkeyhint: "search" });
// Typing refilters only the list: the input itself stays in place (it keeps focus and the IME composition).
kkSearch.addEventListener("input", () => { KK.q = kkSearch.value; const pl = $("#kk-pl"); if (pl) clear(pl).append(...kkPickRows()); });
// The name opens the room (read-only while it is not watched); the switches choose watching and 자동 초안.
const kkPickRow = r => el("div", { class: `kk-pr${KK.open === r.chatId ? " on" : ""}`, "data-chat": r.chatId },
  kkAvatar(r.name),
  el("span", { class: "cv-b" },
    el("button", { class: "cv-n kk-pn", type: "button", "data-k": "open", title: r.name, text: r.name, "aria-label": `${r.name} 열기`, onclick: () => kkOpen(r.chatId) }),
    kkSubLine(r) ? el("span", { class: "cv-p", text: kkSubLine(r) }) : null,
    r.watched ? el("span", { class: "kk-auto" }, el("span", { text: "자동 초안" }), kkSwitch(!!r.autoDraft, `${r.name} 자동 초안`, "auto", v => kkSetRoom(r, { autoDraft: v }), true)) : null),
  kkSwitch(!!r.watched, `${r.name} 지켜보기`, "watch", v => kkSetRoom(r, { watched: v })));
function kkPickRows() {
  const list = KK.rooms.filter(r => kkMatch(r.name, KK.q));
  return list.length ? list.map(kkPickRow) : [el("div", { class: "kk-note", id: "kk-nomatch", role: "status", text: "찾는 대화방이 없어요" })];
}
function kkRow(r) {
  const on = KK.open === r.chatId, hint = kkSubLine(r);
  return el("button", { class: `cv-row pv kk-row${r.unread ? " unread" : ""}${on ? " on" : ""}`, type: "button", "data-chat": r.chatId, "aria-current": on ? "true" : null, onclick: () => kkOpen(r.chatId) },
    kkAvatar(r.name),
    el("span", { class: "cv-b" }, el("span", { class: "cv-n", title: r.name, text: r.name }), hint ? el("span", { class: "cv-p", text: hint }) : null),
    el("span", { class: "cv-m" },
      r.lastAt ? el("span", { class: "kk-t", text: kkListTime(r.lastAt) }) : null,
      r.unread ? el("span", { class: "nb", "aria-label": `읽지 않은 메시지 ${r.unread}개`, text: r.unread > 99 ? "99+" : String(r.unread) }) : null,
      r.unreplied ? unrepPill() : null));
}
function kkPaintRooms() {
  const top = kkRooms.scrollTop, watched = KK.rooms.filter(r => r.watched).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const expanded = KK.pick === null ? watched.length === 0 : KK.pick;
  const note = !KK.loaded ? "불러오는 중…" : !KK.on ? "카카오톡 연동이 꺼져 있어요" : KK.error;
  const pick = el("section", { class: "kk-pick", "aria-label": "지켜볼 대화방 고르기" },
    el("button", { class: "kk-ph", id: "kk-pick-btn", type: "button", "aria-expanded": expanded ? "true" : "false", onclick: () => { KK.pick = !expanded; kkPaintRooms(); } },
      el("span", { class: "kk-pt", text: "지켜볼 대화방" }), el("span", { class: "kk-cnt", text: KK.loaded && !note ? `${watched.length}개 고름` : "" }), icon("drop", "kk-chev")));
  if (expanded) {
    if (note) pick.append(el("div", { class: "kk-note", role: "status", text: note }));
    else if (!KK.rooms.length) pick.append(el("div", { class: "kk-note", text: "고를 수 있는 대화방이 없어요" }));
    else pick.append(kkSearch, el("div", { class: "kk-hint", text: "자동 초안은 새 메시지마다 답장 초안을 만들어서 토큰이 들어요." }), el("div", { class: "kk-pl", id: "kk-pl" }, ...kkPickRows()));
  }
  const list = el("section", { class: "kk-watch", "aria-label": "지켜보는 대화방" });
  if (KK.loaded && !note) {
    list.append(el("div", { class: "cv-gh", role: "presentation", text: "대화" }));
    if (watched.length) list.append(...watched.map(kkRow));
    else list.append(el("div", { class: "kk-note", id: "kk-empty", text: "지켜볼 대화방을 골라 주세요" }));
  }
  // A peer's kakao has no settings panel here: the status of the watches it owns (a login keeper) is at the top of its pane.
  const own = KK.pc ? (monItems().find(i => i.app && i.kk && i.pc && i.pc.url === KK.pc.url) || {}).owned || [] : [];
  clear(kkRooms).append(...(own.length ? [el("section", { class: "kk-own", "aria-label": "감시 상태" }, ...own.map(monStatNode))] : []), pick, list);
  kkRooms.scrollTop = top;
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
  const watching = kkWatching(), owed = watching && !!(room && room.unreplied), sig = `${KK.open}|${info.name}|${info.group}|${!!AS.by.kakao}|${owed}|${watching}`;
  const readOnly = open && !KK.loading && !KK.roomErr && !watching;
  kkFoot.hidden = kkFoot.hidden || !watching;
  kkRo.hidden = !readOnly;
  if (readOnly) clear(kkRo).append(el("span", { class: "kk-ro-t", text: "감시하지 않는 방이에요. 읽기만 할 수 있어요" }), room ? el("button", { class: "btn tonal", type: "button", "data-k": "watch", text: "감시 시작", onclick: () => kkSetRoom(room, { watched: true }) }) : null);
  if (sig !== KK.headSig) {
    KK.headSig = sig;
    clear(kkHead);
    if (open) kkHead.append(kkAvatar(info.name), el("span", { class: "cv-b" }, el("span", { class: "cv-n", text: info.name || "" }), el("span", { class: "cv-p", text: kkKindLine(info) || (info.group ? "단체 대화방" : "1:1 대화") })), ...(owed ? [unrepPill(), kkNoReply(room)] : []), ...(KK.pc ? [] : asEntry("kakao")));
    monSchedule();   // the item's head gives the gear to the room head while a room is open
  }
  if (!open) { clear(kkIn).append(el("div", { class: "kk-note", text: "대화방을 골라 주세요" })); return; }
  if (KK.loading) { clear(kkIn).append(el("div", { class: "kk-note", text: "불러오는 중…" })); return; }
  if (KK.roomErr) { clear(kkIn).append(el("div", { class: "kk-note", role: "status", text: KK.roomErr })); return; }
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
  return el("button", { class: "cchip unrep-no", type: "button", "data-k": "no-reply", text: "답장 안 함", onclick: ev => {
    ev.stopPropagation();
    r.unreplied = false;
    kkPaintRooms(); kkPaintChat();
    api(`/api/kakao/chat/${enc(r.chatId)}/no-reply`, "POST", {}).then(() => { toast("답장 안 함으로 표시했어요"); loadIntegrations(); }, e => {
      r.unreplied = true;
      kkPaintRooms(); kkPaintChat();
      toast(e.message, true);
    });
  } });
}
const kkDateNode = t => el("div", { class: "kk-date", text: kkDate(t) });
const kkMarkNode = () => el("div", { class: "kk-new", role: "separator", "aria-label": "여기부터 읽지 않은 메시지" }, el("span", { text: "여기까지 읽었어요" }));
function kkMsgNode(m, first, last) {
  if (kkSys(m)) return String(m.text ?? "").trim() ? el("div", { class: "kk-sys", role: "note", "data-log": m.logId, text: String(m.text).trim() }) : null;
  const group = !!(KK.room && KK.room.group), { text, ph } = kkBody(m);
  // Plain words with an address: the address is a link and each one gets a preview card under the bubble.
  const urls = !m.media && !ph ? kkUrls(text) : [];
  const bub = (m.media && kkMediaNode(m, m.media)) || el("div", { class: `kk-bub${ph ? " ph" : ""}${urls.length ? " kk-lb" : ""}` }, urls.length ? kkLinkText(text) : text);
  const previews = urls.length ? el("div", { class: "kk-lps" }, ...urls.map(kkLpCard)) : null;
  // On the time side of the bubble: KakaoTalk's yellow number (members who have not read it yet) above the time; nothing when 0.
  const n = m.unread | 0, meta = n > 0 || last ? el("span", { class: "kk-meta" }, n > 0 ? el("span", { class: "kk-rd", "aria-label": `아직 안 읽은 사람 ${n}명`, text: String(n) }) : null, last ? el("span", { class: "kk-time", text: kkTime(m.sentAt) }) : null) : null;
  if (m.fromMe) return el("div", { class: `kk-m me${first ? " first" : ""}`, "data-log": m.logId }, el("div", { class: "kk-line" }, meta, bub), previews);
  return el("div", { class: `kk-m in${first ? " first" : ""}`, "data-log": m.logId, "data-author": m.authorId || null },
    group ? (first ? kkAvatar(m.sender) : el("span", { class: "kk-av sp", "aria-hidden": "true" })) : null,
    el("div", { class: "kk-mb" }, group && first ? el("div", { class: "kk-name", text: m.sender || "알 수 없음" }) : null, el("div", { class: "kk-line" }, bub, meta), previews));
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
  const failed = s.state === "failed", st = failed ? `실패${s.reason ? ` · ${s.reason}` : ""}` : s.state === "sent" ? "보냄" : "보내는 중";
  return el("div", { class: `kk-m me pend ${s.state} first`, "data-send": s.id },
    el("div", { class: "kk-line" }, el("div", { class: "kk-bub", text: s.text })),
    el("div", { class: "kk-st", role: failed ? "alert" : "status" }, el("span", { class: "kk-state", text: st }),
      failed ? el("button", { class: "btn text", type: "button", "data-k": "retry", text: "다시 보내기", onclick: () => kkRetry(s) }) : null,
      failed ? el("button", { class: "btn text", type: "button", "data-k": "dismiss", text: "지우기", onclick: () => kkDeleteSend(s) }) : null));
}
function kkTimeline() {
  const out = [], msgs = KK.msgs;
  if (KK.more) out.push(el("button", { class: "btn text kk-more", type: "button", text: "이전 메시지 더 보기", onclick: () => kkOlder() }));
  let prev = null;
  msgs.forEach((m, i) => {
    const newDay = !prev || kkDay(prev.sentAt) !== kkDay(m.sentAt), mark = !!KK.div && m.logId === KK.div, next = msgs[i + 1];
    if (newDay) out.push(kkDateNode(m.sentAt));
    if (mark) out.push(kkMarkNode());
    // Name and avatar once per run of one sender (like KakaoTalk); the time once per same-minute run.
    const cont = !!prev && !newDay && !mark && !kkSys(prev) && kkWho(prev) === kkWho(m);
    const nextCont = !!next && kkDay(next.sentAt) === kkDay(m.sentAt) && !(KK.div && next.logId === KK.div) && kkSame(m, next);
    const node = kkMsgNode(m, !cont, !nextCont);
    if (node) out.push(node);
    prev = m;
  });
  out.push(...kkPending().map(kkSendNode));
  if (!out.length) out.push(el("div", { class: "kk-note", text: "아직 받은 메시지가 없어요" }));
  return out;
}
function kkPaintTl(stick) {
  const keep = kkTl.scrollTop;
  kkLpIO?.disconnect();
  clear(kkIn).append(...kkTimeline());
  kkTl.scrollTop = stick ? kkTl.scrollHeight : keep;
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
  Object.assign(KK, { open: id, room: { chatId: id, name: r.name, kind: r.kind, group: r.kind === "group" || r.kind === "multi" || r.kind === "open", watched: !!r.watched }, msgs: [], more: false, read: null, div: "", drafts: [], sends: [], ask: null, hidden: new Set(), compose: null,
    loading: true, roomErr: "", pill: false, stick: true, pin: "", placed: false, readSent: "", edit: null, drafting: "", revise: null, reviseCode: "" });
  kkTa.value = KK.typed.get(id) || ""; kkAutosize();
  kkPaintAll(); convTitle();
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
    KK.loading = false; KK.roomErr = e.message || "대화를 불러오지 못했어요";
    kkPaintAll();
  }
}
function kkClose() {
  if (KK.open) KK.typed.set(KK.open, kkTa.value);
  KK.open = ""; KK.seq++; KK.loading = false; KK.roomErr = ""; KK.edit = null; KK.compose = null;
  kkPaintAll(); convTitle();
}
// Phone: the app bar's back arrow leaves the chat for the room list first (04-state.js #back).
function kkBack() {
  if (!(KK.vis && KK.open && narrowChat() && current === "monitoring" && !MON.list)) return false;
  kkClose();
  return true;
}
async function kkOlder() {
  const id = KK.open, first = KK.msgs[0];
  if (!id || !first) return;
  try {
    const d = await api(`/api/kakao/chat/${enc(id)}?limit=${KK_PAGE}&before=${enc(first.logId)}`);
    if (KK.open !== id) return;
    const got = Array.isArray(d.messages) ? d.messages : [], have = new Set(KK.msgs.map(m => m.logId));
    KK.msgs = [...got.filter(m => !have.has(m.logId)), ...KK.msgs]; KK.more = got.length >= KK_PAGE; KK.pin = "";
    const h = kkTl.scrollHeight;
    clear(kkIn).append(...kkTimeline());
    kkTl.scrollTop += kkTl.scrollHeight - h;
    kkSyncStick();
  } catch (e) { toast(e.message, true); }
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
    if (KK.pc && KK.drafting === KK.open && KK.reviseCode && !d.drafts.some(x => x.code === KK.reviseCode)) { KK.drafting = ""; clearTimeout(KK.draftT); }
  }
  if (Array.isArray(d.sends)) KK.sends = d.sends;
  if (d.room) KK.room = d.room;
  if (fresh.length) KK.msgs = [...KK.msgs, ...fresh].sort((a, b) => (kkGt(a.logId, b.logId) ? 1 : kkGt(b.logId, a.logId) ? -1 : 0));
  const stick = KK.stick || fresh.some(m => m.fromMe);
  if (fresh.some(m => !m.fromMe) && !stick) { KK.pill = true; kkPill.hidden = false; }
  if (stick) KK.pin = "bottom";
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
// text = what the owner wrote; edit = the draft being edited (the send then goes through the draft's route with the edited text).
async function kkSendText(text, edit) {
  const id = KK.open;
  if (!id || !text || KK.sending) return;
  KK.sending = true;
  try {
    const r = await api(edit ? `/api/kakao/drafts/${enc(edit.code)}/send` : `/api/kakao/chat/${enc(id)}/send`, "POST", { text });
    if (KK.open === id) {
      kkAddSend(r, text);
      if (edit) KK.drafts = KK.drafts.filter(d => d.code !== edit.code);
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
async function kkSend() {
  const text = kkTa.value.trim(), edit = KK.edit;
  if (!KK.open || !text || KK.sending) return;
  const id = KK.open;
  kkTa.value = ""; KK.typed.delete(id); KK.edit = null; kkAutosize(); kkPaintFoot();
  const ok = await kkSendText(text, edit);
  if (!ok && KK.open === id && !kkTa.value) { kkTa.value = text; kkAutosize(); }
  if (!kkTa.disabled && kkWide()) kkTa.focus();
}
// The failed send is deleted on the gateway (the stored record, so no other web or reload shows it again); a 404 means it is already gone.
async function kkDeleteSend(s) {
  const id = KK.open;
  try {
    await api(`/api/kakao/chat/${enc(id)}/send/${enc(s.id)}`, "DELETE");
  } catch (e) {
    toast(e.message, true);
    return false;
  }
  if (KK.open === id) { KK.sends = KK.sends.filter(x => x.id !== s.id); kkPaintTl(KK.stick); }
  return true;
}
async function kkRetry(s) {
  if (await kkDeleteSend(s)) kkSendText(s.text, null);
}
async function kkSendEvent(e) {
  const s = KK.sends.find(x => x.id === e.id);
  if (e.state === "deleted") { if (s) { KK.sends = KK.sends.filter(x => x.id !== e.id); kkPaintTl(KK.stick); } return; }
  if (!s) { kkTail(); return; }
  s.state = e.state; s.reason = e.reason;
  kkPaintTl(KK.stick);
  if (e.state === "sent") kkTail();
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
    el("div", { class: "kk-dh", text: "답장 전에 골라 주세요" }),
    el("div", { class: "kk-dt", text: a.question }),
    el("div", { class: "btns kk-choices" },
      ...a.choices.map((c, i) => el("button", { class: "btn tonal", type: "button", "data-k": "pick", "data-i": String(i), text: c, onclick: () => kkMakeDraft(c) })),
      el("button", { class: "btn text", type: "button", "data-k": "own", text: "직접 쓸게", onclick: own })));
}
// 고치기 asks what to change; the bot rewrites the draft (one model call, POST .../draft { revise }) and the old draft stays until the new one lands.
const KK_REVISE_HINT = "더 짧게, 존댓말로, 견적서도 첨부한다고 써 줘";
function kkReviseBox(d, rv) {
  const inp = el("input", { class: "kk-rv", type: "text", maxlength: "500", placeholder: KK_REVISE_HINT, "aria-label": "고칠 내용", autocomplete: "off" });
  inp.value = rv.text;
  const go = el("button", { class: "btn", type: "button", "data-k": "revise-go", text: "고쳐 줘", disabled: !rv.text.trim(), onclick: () => { const change = inp.value.trim(); if (change) { KK.revise = null; kkMakeDraft(undefined, { code: d.code, change }); } } });
  inp.oninput = () => { rv.text = inp.value; go.disabled = !inp.value.trim(); };
  inp.onkeydown = ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); go.click(); } };
  return [el("div", { class: "kk-rq", text: "어떻게 고칠까요?" }), inp,
    el("div", { class: "btns" }, go,
      el("button", { class: "btn text", type: "button", "data-k": "revise-cancel", text: "취소", onclick: () => { KK.revise = null; kkPaintFoot(); } }),
      el("button", { class: "btn text kk-manual", type: "button", "data-k": "manual", "aria-label": "직접 수정", onclick: () => { KK.revise = null; kkEdit(d); } }, icon("pencil"), el("span", { text: "직접 수정" })))];
}
// A draft of several KakaoTalk messages (d.parts) shows one bubble per message, in the order they go out; one 보내기 sends them all.
const kkDraftParts = d => (Array.isArray(d.parts) && d.parts.length ? d.parts : [d.text]);
const kkDraftHead = d => el("div", { class: "kk-dh", text: `${d.intent ? "새 메시지 초안" : "답장 초안"}${kkDraftParts(d).length > 1 ? ` · 메시지 ${kkDraftParts(d).length}개` : ""}` });
function kkDraftText(d) {
  const parts = kkDraftParts(d);
  if (parts.length < 2) return el("div", { class: "kk-dt", text: d.text });
  return el("div", { class: "kk-dt kk-dps" }, ...parts.map((p, i) => el("div", { class: `kk-dp${i < (d.sentParts | 0) ? " sent" : ""}`, text: p })));
}
function kkDraftCard(d) {
  const run = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, true); kkTail(); } finally { btn.disabled = false; } };
  const making = !!KK.open && KK.drafting === KK.open && KK.reviseCode === d.code, rv = !making && KK.revise && KK.revise.code === d.code ? KK.revise : null;
  if (making || rv) return el("div", { class: "kk-draft", "data-code": d.code },
    kkDraftHead(d),
    kkDraftText(d),
    ...(making ? [el("div", { class: "kk-st", role: "status", text: "고치는 중…" })] : kkReviseBox(d, rv)));
  return el("div", { class: "kk-draft", "data-code": d.code },
    kkDraftHead(d),
    kkDraftText(d),
    el("div", { class: "btns" },
      el("button", { class: "btn", type: "button", "data-k": "send", text: "보내기", onclick: ev => run(ev.currentTarget, async () => {
        const id = KK.open, r = await api(`/api/kakao/drafts/${enc(d.code)}/send`, "POST", {});
        if (KK.open !== id) return;
        kkAddSend(r, d.text); KK.drafts = KK.drafts.filter(x => x.code !== d.code); KK.stick = true; KK.pin = "bottom";
        kkPaintTl(true); kkPaintFoot();
      }) }),
      el("button", { class: "btn tonal", type: "button", "data-k": "edit", text: "고치기", onclick: () => { KK.revise = { code: d.code, text: "" }; kkPaintFoot(); const i = $(".kk-rv", kkDrafts); if (i) i.focus(); } }),
      el("button", { class: "btn text", type: "button", "data-k": "drop", text: "버리기", onclick: ev => run(ev.currentTarget, async () => {
        const id = KK.open;
        await api(`/api/kakao/drafts/${enc(d.code)}/drop`, "POST", {});
        if (KK.open !== id) return;
        KK.drafts = KK.drafts.filter(x => x.code !== d.code);
        if (KK.edit && KK.edit.code === d.code) kkEditCancel(); else kkPaintFoot();
      }) })));
}
function kkEdit(d) {
  KK.edit = { code: d.code };
  kkTa.value = d.text; KK.typed.set(KK.open, d.text); kkAutosize();
  kkPaintFoot();
  kkTa.focus();
}
function kkEditCancel() {
  KK.edit = null; kkTa.value = ""; KK.typed.delete(KK.open); kkAutosize();
  kkPaintFoot();
}
function kkPaintFoot() {
  const edit = KK.edit && KK.drafts.some(d => d.code === KK.edit.code) ? KK.edit : null;
  if (KK.edit && !edit) KK.edit = null;
  const ask = kkAskCard(), hadRv = document.activeElement && document.activeElement.classList.contains("kk-rv");
  if (KK.revise && !KK.drafts.some(d => d.code === KK.revise.code)) KK.revise = null;
  clear(kkDrafts).append(...(ask ? [ask] : []), ...KK.drafts.filter(d => !edit || d.code !== edit.code).map(kkDraftCard));
  kkDrafts.hidden = !kkDrafts.firstChild;
  if (hadRv) { const i = $(".kk-rv", kkDrafts); if (i) i.focus({ preventScroll: true }); }
  kkEditBar.hidden = !edit;
  const making = !!KK.open && KK.drafting === KK.open;
  kkDraftBtn.disabled = making;
  kkDraftBtn.lastChild.textContent = making ? "초안 만드는 중…" : "답장 초안";
  kkNewBtn.disabled = making;
  clear(kkIntent).append(...(KK.compose === null || !KK.open ? [] : kkIntentBox()));
  kkIntent.hidden = !kkIntent.firstChild;
}
// 메시지 만들어 줘: the owner says what to send in his own words; the same draft call (POST .../draft { intent }) writes it in his voice.
function kkComposeOpen() {
  if (!KK.open) return;
  KK.compose = "";
  kkPaintFoot();
  const i = $("#kk-intent-in");
  if (i) i.focus();
}
function kkIntentBox() {
  const inp = el("input", { class: "kk-rv", id: "kk-intent-in", type: "text", maxlength: "300", placeholder: "예: 내일 7시로 미루자고 정중하게", "aria-label": "보낼 메시지 내용", autocomplete: "off" });
  inp.value = KK.compose || "";
  const go = el("button", { class: "btn", type: "button", "data-k": "compose-go", text: "만들기", disabled: !inp.value.trim(), onclick: () => kkComposeMake(inp.value) });
  inp.oninput = () => { KK.compose = inp.value; go.disabled = !inp.value.trim(); };
  inp.onkeydown = ev => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); if (inp.value.trim()) kkComposeMake(inp.value); } };
  return [el("div", { class: "kk-rq", text: "어떤 메시지를 보낼까요?" }), inp,
    el("div", { class: "btns" }, go, el("button", { class: "btn text", type: "button", "data-k": "compose-cancel", text: "취소", onclick: () => { KK.compose = null; kkPaintFoot(); } }))];
}
async function kkComposeMake(intent) {
  const id = KK.open, text = String(intent || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!id || !text || KK.drafting === id) return;
  KK.compose = null; KK.drafting = id; KK.reviseCode = "";
  kkPaintFoot();
  clearTimeout(KK.draftT);
  KK.draftT = setTimeout(() => { if (KK.drafting === id) { KK.drafting = ""; kkPaintFoot(); toast("초안이 아직 오지 않았어요", true); } }, 120000);
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
// `revise` = { code, change }: rewrite that draft with the owner's change instead of making a new one.
async function kkMakeDraft(choice, revise) {
  const id = KK.open;
  if (!id || KK.drafting === id) return;
  KK.drafting = id; KK.reviseCode = revise ? revise.code : ""; kkPaintFoot();
  clearTimeout(KK.draftT);
  KK.draftT = setTimeout(() => { if (KK.drafting === id) { KK.drafting = ""; kkPaintFoot(); toast("초안이 아직 오지 않았어요", true); } }, 120000);
  try {
    const r = await api(`/api/kakao/chat/${enc(id)}/draft`, "POST", revise ? { revise } : choice ? { choice } : {});
    if (r && typeof r.error === "string" && r.error) throw new Error(r.error);
  } catch (e) {
    clearTimeout(KK.draftT);
    if (KK.drafting === id) KK.drafting = "";
    kkPaintFoot();
    toast(e.message, true);
  }
}

/* ---- live ---- */
function kkBump(chatId) {
  const r = kkRoom(chatId);
  if (!r) { kkLoadRooms(); return; }
  r.unread = (r.unread | 0) + 1; r.lastAt = Date.now();
  kkPaintRooms();
}
// The event stream (99-boot.js): ids only, so the bodies are fetched here.
function kkLive(e) {
  if (KK.pc) return;   // the stream is this computer's; a peer's room is refreshed by the timer
  if (e.kind === "kakao_read") { if (KK.vis && e.chatId === KK.open) kkReads(); return; }
  if (e.kind === "kakao_rooms" || e.kind === "kakao_unreplied") { if (KK.vis) kkLoadRooms(); kkIntgSoon(); return; }
  kkIntgSoon();
  if (!KK.vis) return;
  const open = e.chatId === KK.open;
  if (e.kind === "kakao") { if (open) kkTail(); else kkBump(e.chatId); }
  else if (e.kind === "kakao_send") { if (open) kkSendEvent(e); }
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
    Object.assign(KK, { vis: false, open: "", rooms: [], loaded: false, failed: false, error: "", roomErr: "", room: null, msgs: [], drafts: [], ask: null, sends: [], pick: null, rseq: KK.rseq + 1 });
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
}
