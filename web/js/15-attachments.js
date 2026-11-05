/* ---------- attachments: + button, drag-drop, paste -> POST /api/upload; sent as `files` with the message ---------- */
// The composer's files of the conversation open now; another conversation's wait in its ts(t).att (13-data.js setTarget swaps them).
let ATT = [];   // [{id, name, type, size, url (local preview), file (server record once uploaded)}]
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|heic)$/i;
// pc: the file is an upload of that other computer (a file sent to its conversation), read there through the peer proxy (hub/routes.ts /api/peer/file).
const fileUrl = (p, dl, pc) => pc ? pqProxy(pc, `/api/peer/file?path=${enc(p)}${dl ? "&download=1" : ""}`) : `/api/file?path=${enc(p)}${dl ? "&download=1" : ""}`;
// The small picture of a file in the timeline; the lightbox alone loads the original. A peer's file comes through the proxy as it is.
const thumbUrl = (p, pc) => pc ? fileUrl(p, false, pc) : `${fileUrl(p)}&thumb=1`;
const fsize = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
const extOf = n => (String(n).match(/\.([A-Za-z0-9]{1,6})$/) || [0, ""])[1].toUpperCase();
$("#c-attach").append(icon("add"));
// A touch device first asks 사진 (the photo library / gallery) or 파일; desktop opens the file picker directly.
// A tap on 첨부 while its menu is open closes it (showMenu toggles on the same anchor).
$("#c-attach").onclick = () => {
  if (!matchMedia("(pointer: coarse)").matches) { $("#c-file").click(); return; }
  showMenu($("#c-attach"), [{ value: "photo", label: "사진" }, { value: "file", label: "파일" }], { sheet: matchMedia("(max-width: 639px)").matches, onPick: v => $(v === "photo" ? "#c-photo" : "#c-file").click() });
};
for (const id of ["#c-file", "#c-photo"]) $(id).onchange = ev => { addFiles([...ev.target.files]); ev.target.value = ""; };
async function addFiles(list) {
  if (!list.length) return;
  if (isRelayT(target)) { toast("이 대화에는 파일을 붙일 수 없어요", true); return; }
  for (const f of list) if (upTooBig(f.size)) toast(`${f.name}: ${upTooBig(f.size)}`, true);
  list = list.filter(f => !upTooBig(f.size));
  if (!list.length) return;
  if (ATT.length + list.length > 10) { toast("한 번에 10개까지 보낼 수 있어요", true); list = list.slice(0, Math.max(0, 10 - ATT.length)); }
  const items = list.map(f => ({ id: Math.random().toString(36).slice(2), name: f.name || "붙여넣은 이미지.png", type: f.type, size: f.size, url: /^image\//.test(f.type) ? URL.createObjectURL(f) : "", raw: f }));
  for (const a of items) { a.no = atkLabel(a, items); if (a.url) atkThumb(a); }
  ATT = ATT.concat(items); renderAtt(); ta.focus();
  atkInsert(items.map(a => `[${a.no}]`).join(" "));
  for (const a of items) upStart(target, a);
}
// Taken off the tray: the token leaves the text too, as an edit the browser can undo, so the file waits among the gone ones (atkSync); one
// not on the hub yet is really over, its upload stopped.
function dropAtt(id) {
  const a = ATT.find(x => x.id === id) || atkGone().find(x => x.id === id);
  if (!a) return;
  const forever = !a.file;
  upCancel(target, id);
  ATT = ATT.filter(x => x !== a);
  if (forever) { ts(target).gone = atkGone().filter(x => x !== a); atkRevoke(a); } else if (!atkGone().includes(a)) atkGone().push(a);
  const tok = `[${a.no}]`;
  for (let at = ta.value.indexOf(tok); at >= 0; at = ta.value.indexOf(tok)) atkEdit(at, at + tok.length, "");
  renderAtt();
}
/* ---------- inline tokens: the composer text holds `[이미지1]` (or `[파일1]`) where the file was put ----------
   A real textarea keeps the text (Korean IME, phone keyboards, undo, autocorrect stay the browser's); an overlay above it paints an opaque chip
   exactly over each token's raw text, the same width because it repeats that text. OmO's editor keeps `[Image #1]` in its text the same way. */
const ATK_RE = /\[((?:이미지|파일)\d{1,3})\]/g;
const ATK = { v: "", at: 0, comp: false, busy: false };   // v: the text at the last sync; at: the last caret; comp: an IME composition is open; busy: atkSync's own edit
const atkLay = el("div", { class: "ta-tok", "aria-hidden": "true", hidden: true });
ta.after(atkLay);
const atkGone = () => ts(target).gone || (ts(target).gone = []);   // files whose token left the text: undo or a paste brings them back
const atkRevoke = a => { if (/^blob:/.test(a.url)) URL.revokeObjectURL(a.url); };
function atkForget() { for (const a of atkGone()) { upCancel(target, a.id); atkRevoke(a); } ts(target).gone = []; }
// The next free number of the kind. A number never moves while its file waits, so the words already written about 이미지2 stay true.
function atkLabel(a, fresh) {
  const kind = a.url ? "이미지" : "파일", used = [...ATT, ...atkGone(), ...fresh].filter(x => x.no && x.no.startsWith(kind)).map(x => Number(x.no.slice(kind.length)));
  return `${kind}${Math.max(0, ...used) + 1}`;
}
// A small decoded copy for the tray and the chip, so ten phone photos do not stay decoded at full size; the original stays as a File for the lightbox.
async function atkThumb(a) {
  try {
    const bmp = await createImageBitmap(a.raw, { resizeWidth: 112, resizeQuality: "medium" }), c = el("canvas", { width: bmp.width, height: bmp.height });
    c.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
    const b = await new Promise(ok => c.toBlob(ok, "image/webp", .8));
    if (!b || !ATT.concat(atkGone()).includes(a)) return;
    atkRevoke(a); a.url = URL.createObjectURL(b); renderAtt();
  } catch {}   // a type this browser cannot decode here (HEIC on desktop) keeps its full preview
}
// One edit the browser's undo can take back; without focus (a tap on × with the keyboard down) it is a plain text change.
function atkEdit(a, b, txt) {
  if (document.activeElement === ta) {
    ta.setSelectionRange(a, b);
    if (document.execCommand(txt ? "insertText" : "delete", false, txt)) return;
  }
  ta.setRangeText(txt, a, b, "end");
  ta.dispatchEvent(new Event("input"));
}
function atkInsert(s) {
  const a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
  atkEdit(a, b, `${a && !/\s/.test(v[a - 1]) ? " " : ""}${s}${/\s/.test(v[b] ?? "") ? "" : " "}`);
}
// The live tokens of a text, as [start, end, label].
const atkSpans = v => { const live = new Set(ATT.map(a => a.no)); return [...v.matchAll(ATK_RE)].filter(m => live.has(m[1])).map(m => [m.index, m.index + m[0].length, m[1]]); };
// A keyboard that deleted past the guard below (Android during composition) leaves half a token: the half goes too.
function atkRepair() {
  const prev = ATK.v, v = ta.value;
  if (prev === v) return;
  let p = 0, s = 0;
  while (p < prev.length && p < v.length && prev[p] === v[p]) p++;
  while (s < prev.length - p && s < v.length - p && prev[prev.length - 1 - s] === v[v.length - 1 - s]) s++;
  const end = prev.length - s, cut = [];
  for (const [a, b] of atkSpans(prev)) {
    if (end <= a || p >= b || (a >= p && b <= end)) continue;
    if (b > end) cut.push([v.length - s, v.length - s + b - end]);
    if (a < p) cut.push([a, p]);
  }
  ATK.busy = true;
  for (const [a, b] of cut.sort((x, y) => y[0] - x[0])) atkEdit(a, b, "");
  ATK.busy = false;
}
// After each change of the text: a token gone means its file is gone, a token back (undo, a paste of a cut token) brings the file back.
function atkSync(ev) {
  if (ATK.busy || ATK.comp || (ev && ev.isComposing)) return;
  const gone = atkGone();
  if (!ATT.length && !gone.length) return;
  if (!/^history/.test((ev && ev.inputType) || "")) atkRepair();
  const has = new Set([...ta.value.matchAll(ATK_RE)].map(m => m[1])), back = gone.filter(a => has.has(a.no)), out = ATT.filter(a => !has.has(a.no));
  if (!back.length && !out.length) return;
  ts(target).gone = gone.filter(a => !back.includes(a)).concat(out);
  ATT = ATT.filter(a => has.has(a.no)).concat(back);
  renderAtt();
}
// Backspace or Delete next to a token takes the whole token, as one undo step. beforeinput, not keydown: a phone keyboard names no key.
ta.addEventListener("beforeinput", ev => {
  if (ev.isComposing || !ATT.length || !/^delete.*(Backward|Forward)$/.test(ev.inputType) || ta.selectionStart !== ta.selectionEnd) return;
  const i = ta.selectionStart - (ev.inputType.endsWith("Backward") ? 1 : 0), tok = atkSpans(ta.value).find(([a, b]) => i >= a && i < b);
  if (!tok) return;
  ev.preventDefault();
  atkEdit(tok[0], tok[1], "");
});
ta.addEventListener("compositionstart", () => { ATK.comp = true; });
ta.addEventListener("compositionend", () => { ATK.comp = false; atkSync(); atkPaint(); });
// The caret never rests inside a token: it steps over it, the way it came.
document.addEventListener("selectionchange", () => {
  if (!ATT.length || ATK.comp || document.activeElement !== ta) return;
  const p = ta.selectionStart;
  if (p === ta.selectionEnd) {
    const tok = atkSpans(ta.value).find(([a, b]) => p > a && p < b);
    if (tok) { const to = ATK.at <= tok[0] ? tok[1] : tok[0]; ta.setSelectionRange(to, to); ATK.at = to; return; }
  }
  ATK.at = p;
});
function atkInner(no, url, attrs = {}, tag = "span") {
  return el(tag, { class: "atk-in", ...attrs }, url ? el("img", { src: url, alt: "", loading: "lazy" }) : icon("file"), el("span", { text: no }));
}
// Runs on every keystroke through autosize: nothing at all without a waiting file, and the chips are kept nodes so their pictures do not reload.
function atkPaint() {
  const v = ta.value;
  if (!ATK.comp) ATK.v = v;
  const tok = ATT.length && v.includes("[") ? atkSpans(v) : [];
  if (!tok.length) { if (!atkLay.hidden) { atkLay.hidden = true; clear(atkLay); } return; }
  const cs = getComputedStyle(ta), parts = [];
  for (const k of ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "textIndent", "wordBreak"]) atkLay.style[k] = cs[k];   // longhands: WebKit computes the `font` shorthand empty
  atkLay.style.width = `${ta.clientWidth}px`; atkLay.style.height = cs.height;
  const seen = new Set();
  let at = 0;
  for (const [a, b, no] of tok) {
    const f = ATT.find(x => x.no === no);
    let chip = !seen.has(no) && f.chip;
    if (!chip || chip.dataset.url !== f.url) {
      chip = el("span", { class: "atk", "data-url": f.url }, `[${no}]`, atkInner(no, f.url, { title: f.name, onclick: () => atkOpen(f) }));
      if (!seen.has(no)) f.chip = chip;
    }
    seen.add(no);
    parts.push(v.slice(at, a), chip);
    at = b;
  }
  parts.push(v.slice(at), "\n");
  atkLay.hidden = false;
  clear(atkLay).append(...parts);
  atkLay.scrollTop = ta.scrollTop;
}
// A waiting file opens in the lightbox: once uploaded by its path, before that from the File itself, which the viewer maps only while it shows it.
function atkOpen(a) {
  const imgs = ATT.filter(x => x.url);
  if (imgs.includes(a)) lightboxAt(imgs.map(x => x.file ? { path: x.file.path, name: x.name } : { raw: x.raw, name: x.name }), imgs.indexOf(a));
  else if (a.file) openPath(a.file.path);
}
// Files stay in a draft across a reload: the uploads are on the hub, so their records are enough.
const ATT_KEY = t => `dotz-draft-att:${t}`;
function atkStore(t, list) {
  try {
    const keep = list.filter(a => a.file).map(({ id, name, type, size, no, file }) => ({ id, name, type, size, no, file }));
    if (keep.length) localStorage.setItem(ATT_KEY(t), JSON.stringify(keep)); else localStorage.removeItem(ATT_KEY(t));
  } catch {}
}
function atkLoad(t) {
  try { return (JSON.parse(localStorage.getItem(ATT_KEY(t)) || "[]")).map(a => ({ ...a, url: a.no.startsWith("이미지") ? thumbUrl(a.file.path) : "" })); } catch { return []; }
}
// The text of a sent bubble with its tokens as the same chips. Only tokens of this message's own files: `[이미지3]` typed by hand stays text.
function atkParts(text, files, e) {
  const labelled = (Array.isArray(files) ? files : []).filter(f => f.label);
  if (!labelled.length) return [text];
  const pc = pqPc(eventTarget(e) || ""), imgs = labelled.filter(f => IMG_RE.test(f.name || f.path)).map(f => ({ ...f, pc })), parts = [];
  let at = 0;
  for (const m of text.matchAll(ATK_RE)) {
    const f = labelled.find(x => x.label === m[1]);
    if (!f) continue;
    const img = IMG_RE.test(f.name || f.path);
    parts.push(text.slice(at, m.index), atkInner(m[1], img ? thumbUrl(f.path, pc) : "", { type: "button", title: f.name, "aria-label": `${m[1]} ${f.name} 크게 보기`, onclick: () => (img ? lightbox(f.path, f.name, pc, imgs) : openPath(f.path, pc)) }, "button"));
    at = m.index + m[0].length;
  }
  parts.push(text.slice(at));
  return parts;
}
// A message of files alone has nothing to say in a bubble: the thumbnails above it already show them.
const atkOnly = (text, files) => Array.isArray(files) && files.some(f => f.label) && !text.replace(ATK_RE, "").trim();
// extra.row: an answer's file row. A link or a button cannot start a text selection, so the row is a plain element that opens the file itself,
// unless the click ends a selection inside it.
function fileChipRow(name, meta, extra) {
  const open = extra.onclick || (() => window.open(extra.href, "_blank", "noopener"));
  const row = el("div", { class: "fatt", role: extra.href ? "link" : "button", tabindex: "0", title: `${name} · 열기`,
    onclick: () => { const sel = getSelection(); if (sel.isCollapsed || !sel.containsNode(row, true)) open(); },
    onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } } }, ...fileChipKids(name, meta));
  return row;
}
const fileChipKids = (name, meta) => [el("span", { class: "fi-ic" }, icon("file")), el("span", { class: "fi-t" }, el("span", { class: "fi-n", text: name }), el("span", { class: "fi-m", text: meta }))];
function fileChip(name, meta, extra = {}) {
  if (extra.row) return fileChipRow(name, meta, extra);
  return el(extra.href ? "a" : extra.onclick ? "button" : "div", { class: `fatt${extra.cls ? ` ${extra.cls}` : ""}`, ...(extra.href ? { href: extra.href, target: "_blank", rel: "noopener", title: `${name} · 열기` } : extra.onclick ? { type: "button", onclick: extra.onclick, title: `${name} · 열기` } : { title: name }) },
    ...fileChipKids(name, meta), extra.x || null);
}
function renderAtt() {
  const box = $("#atray");
  $("#send").classList.toggle("has-att", ATT.length > 0);
  box.hidden = !ATT.length;
  // Each file carries the name its token has in the text, so the tray and the words read the same.
  clear(box).append(...ATT.map(a => {
    const job = upJob(target, a.id);
    const x = el("button", { class: "ax", type: "button", "aria-label": `${a.name} ${job ? "올리기 취소" : "빼기"}`, onpointerdown: ev => ev.preventDefault(), onclick: () => dropAtt(a.id) }, icon("close"));
    const th = job && job.ring ? upChip(a, job, x) : a.url
      ? el("div", { class: "fatt img", title: a.name }, el("button", { class: "fatt-v", type: "button", "aria-label": `${a.no} 크게 보기`, onclick: () => atkOpen(a) }, el("img", { src: a.url, alt: a.name })), x)
      : fileChip(a.name, [extOf(a.name), fsize(a.size)].filter(Boolean).join(" · "), { x });
    return el("div", { class: "fatt-n" }, th, imgNo(a.no));
  }));
  atkStore(target, ATT);
  atkPaint();
  if (typeof renderPicks === "function") renderPicks();   // the tray holds the picked elements next to the files (15-picker.js)
}
ta.addEventListener("paste", ev => {
  const files = [...(ev.clipboardData && ev.clipboardData.files || [])];
  if (!files.length) return;
  ev.preventDefault();
  addFiles(files);
});
{
  const zone = $("#v-chat"), comp = $("#composer");
  let depth = 0;
  const hasFiles = ev => [...(ev.dataTransfer && ev.dataTransfer.types || [])].includes("Files");
  zone.addEventListener("dragenter", ev => { if (!hasFiles(ev)) return; ev.preventDefault(); depth++; comp.classList.add("dropping"); });
  zone.addEventListener("dragover", ev => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; } });
  zone.addEventListener("dragleave", ev => { if (hasFiles(ev) && --depth <= 0) { depth = 0; comp.classList.remove("dropping"); } });
  zone.addEventListener("drop", ev => { if (!hasFiles(ev)) return; ev.preventDefault(); depth = 0; comp.classList.remove("dropping"); if (!ta.disabled) addFiles([...ev.dataTransfer.files]); });
}
// Files in a message: image thumbnails open the lightbox, an HTML file of this computer opens in the 캔버스 (30-canvas.js), other files open the read-only preview in a new tab; each has a
// one-click download (Content-Disposition: attachment, so iOS Safari saves it too). `check` files (an agent's [file] line)
// are asked with HEAD first: the size fills in, and one /api/file refuses (outside the roots, secret, missing) turns into a
// disabled chip.
const fileNote = (r, fallback) => { try { return decodeURIComponent(r.headers.get("x-file-note") || "") || fallback; } catch { return fallback; } };
const refusedNote = r => fileNote(r, r.status === 404 ? "원본이 지워졌어요" : "열 수 없는 파일이에요");
const fileMeta = (name, size) => [extOf(name), size ? fsize(size) : ""].filter(Boolean).join(" · ");
const VIEW_RE = /\.(md|markdown|txt|log|json|ya?ml|csv|tsv)$/i;   // opens in the reader below, the rest in a tab (pdf) or as a download
const offChip = (f, why) => fileChip(f.name, why, { cls: "off" });
const imgNo = n => el("span", { class: "tag img-no", text: typeof n === "number" ? `이미지 ${n}` : n });
// sibs: the images of the same message, the lightbox pages through them.
function fileItem(f, n = 0, sibs = null) {
  const img = IMG_RE.test(f.name || f.path);
  const main = img
    ? el("button", { class: "thumb", type: "button", "aria-label": `${f.name} 크게 보기`, onclick: () => lightbox(f.path, f.name, f.pc, sibs) }, el("img", { src: thumbUrl(f.path, f.pc), alt: f.name, loading: "lazy", decoding: "async" }))
    : fileChip(f.name, fileMeta(f.name, f.size), { row: f.row, ...(VIEW_RE.test(f.name) ? { onclick: () => viewer(f.path, f.name, f.pc) } : !f.pc && canvasIsHtml(f.name) ? { onclick: () => canvasOpen(f.path, f.name) } : { href: fileUrl(f.path, false, f.pc) }) });
  const item = el("div", { class: "fitem" }, el("div", { class: "fbox" }, main, el("a", { class: "fdl", href: fileUrl(f.path, true, f.pc), download: f.name, title: `${f.name} 다운로드`, "aria-label": `${f.name} 다운로드` }, icon("download"))), n ? imgNo(n) : null, img && f.label ? null : pathCopy(f.path));   // an image with its token is named by the chip; the viewer keeps the path
  if (!f.check) return item;
  const off = why => { if (item.isConnected || item.parentNode) item.replaceWith(offChip(f, why)); };
  // A broken thumbnail waits for the HEAD answer, so the chip says why (원본이 지워졌어요) rather than a generic refusal.
  const head = fetch(fileUrl(f.path, false, f.pc), { method: "HEAD" });
  if (img) main.querySelector("img").onerror = () => head.then(r => off(r.ok ? "열 수 없는 파일이에요" : refusedNote(r)), () => off("확인하지 못했어요"));
  head.then(r => {
    if (!r.ok) return off(refusedNote(r));
    const n = Number(r.headers.get("content-length") || 0), m = !img && main.querySelector(".fi-m");
    if (m && n) m.textContent = fileMeta(f.name, n);
  }, () => off("확인하지 못했어요"));
  return item;
}
// A path as one readable line (owner 2026-10-26: the full absolute path under a file wrapped over three lines): the home folder as ~,
// the last folder and the file name (`~/…/2026-10-26/<id>…신청.xlsx`), and a long name cut in the middle so the extension stays.
// The full path stays in the element's title and in the copy.
const SHORT_PATH_NAME = 18, SHORT_PATH_MAX = 34;
function shortPath(p) {
  const s = String(p ?? "").trim();
  if (!s) return "";
  const home = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(s), tilde = !home && /^~(?=\/|$)/.test(s);
  const parts = (home ? s.slice(home[0].length) : tilde ? s.slice(1) : s).split("/").filter(Boolean);
  if (!parts.length) return home || tilde ? "~" : s;
  let name = parts.pop();
  if (name.length > SHORT_PATH_NAME) {
    const dot = name.lastIndexOf("."), ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
    const stem = ext ? name.slice(0, dot) : name, keep = Math.max(6, SHORT_PATH_NAME - ext.length - 1), head = Math.ceil(keep / 2), tail = keep - head;
    name = `${stem.slice(0, head)}…${tail ? stem.slice(-tail) : ""}${ext}`;
  }
  const dir = parts.length ? parts[parts.length - 1] : "", pre = `${home || tilde ? "~/" : "/"}${parts.length > 1 ? "…/" : ""}`;
  const withDir = `${pre}${dir ? `${dir}/` : ""}${name}`;
  if (withDir.length <= SHORT_PATH_MAX) return withDir;
  return `${pre}${name}`.length <= SHORT_PATH_MAX ? `${pre}${name}` : `…/${name}`;
}
// The short path under a file, as written by the agent: the title holds the full path and a tap copies it (Finder, terminal, another app).
function pathCopy(p, cls = "fpath") {
  return el("button", { class: cls, type: "button", title: p, "aria-label": `경로 복사: ${p}`, text: shortPath(p),
    onclick: async ev => { ev.stopPropagation(); const ok = await copyText(p); toast(ok ? "경로를 복사했어요" : "복사하지 못했어요", !ok); } });
}
// `numbered` (the owner's own message): a file carries its token's name; an older message with two or more images gets "이미지 N" in send order.
function filesNode(files, numbered = false) {
  if (!files || !files.length) return null;
  const isImg = f => IMG_RE.test(f.name || f.path), imgs = files.filter(isImg), count = numbered ? imgs.length : 0;
  let n = 0;
  return el("div", { class: "mfiles" }, ...files.map(f => fileItem(f, f.label || (count > 1 && isImg(f) ? ++n : 0), imgs.length > 1 ? imgs : null)));
}
// `[file] /abs/path` lines (outside a ``` block) leave the text and show as file chips, as they become attachments on
// Discord (hub/discord.ts fileLines).
function fileLines(text) {
  const files = [], kept = [];
  let fence = false;
  for (const line of String(text ?? "").split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = fence ? null : /^\s*\[file\]\s+`?(.+?)`?\s*$/.exec(line);
    if (m) files.push(m[1]); else kept.push(line);
  }
  return { text: kept.join("\n"), files: files.slice(0, 10).map(p => ({ path: p, name: p.split("/").pop() || p, check: true })) };
}
// Markdown plus the file chips of its [file] lines (log rows).
function mdFiles(src) {
  const { text, files } = fileLines(src);
  return [text.trim() ? mdNode(text) : null, filesNode(files)].filter(Boolean);
}
// Markdown renders, other text shows as it is; a big file shows its first 200KB and offers the download.
async function viewer(path, name, pc) {
  const body = el("div", { class: "tv-body md", tabindex: "-1", autofocus: true }, el("p", { class: "tv-st", text: "불러오는 중…" }));
  const d = el("dialog", { class: "tbox", "aria-label": name },
    el("div", { class: "tv-in" },
      el("div", { class: "tv-bar" }, el("span", { class: "tv-n", text: name }),
        el("a", { href: fileUrl(path, true, pc), download: name }, "다운로드"),
        el("button", { class: "x", type: "button", "aria-label": "닫기", onclick: () => d.close() }, icon("close"))),
      pathCopy(path, "tv-p"),
      body));
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", ev => { if (ev.target === d) d.close(); });
  document.body.append(d); d.showModal(); dialogHist(d);
  try {
    const r = await fetch(fileUrl(path, false, pc));
    if (!r.ok) throw refusedNote(r);
    let t = await r.text();
    const cut = t.length > 200000;
    if (cut) t = t.slice(0, 200000);
    clear(body).append(/\.(md|markdown)$/i.test(name) ? mdNode(t, "md") : el("pre", { text: t }));
    if (cut) body.append(el("p", { class: "tv-st", text: "앞부분만 보여요. 전체는 다운로드해 주세요" }));
  } catch (e) { clear(body).append(el("p", { class: "tv-st", text: typeof e === "string" ? e : "열 수 없어요" })); }
}
function lightbox(path, name, pc, list) {
  const items = list || [{ path, name, pc }];
  lightboxAt(items, Math.max(0, items.findIndex(f => f.path === path)));
}
// items: {path, name, pc} or, for a file not uploaded yet, {raw, name}. Only the image on screen is loaded; the original of a raw File is mapped
// only while it shows. Esc is the dialog's own, the back gesture is dialogHist's.
function lightboxAt(items, start) {
  const many = items.length > 1, title = el("span", { class: "lb-n" }), tab = el("a", { target: "_blank", rel: "noopener" }, "새 탭"), dl = el("a", {}, "다운로드"), where = el("div");
  const img = el("img", { draggable: "false" }), pts = new Map(), navs = [];
  let i = 0, blob = "", z = 1, x = 0, y = 0, pinch = null, drag = null, tapAt = 0;
  const box = el("div", { class: "lb-img", tabindex: "-1", autofocus: true, onclick: ev => { if (ev.target === ev.currentTarget) d.close(); } }, img);
  const zoom = (nz, nx = 0, ny = 0) => { z = nz; x = z > 1 ? nx : 0; y = z > 1 ? ny : 0; img.style.transform = z > 1 ? `translate(${x}px, ${y}px) scale(${z})` : ""; box.classList.toggle("zoomed", z > 1); };
  const show = n => {
    i = (n + items.length) % items.length;
    const f = items[i];
    if (blob) URL.revokeObjectURL(blob);
    blob = f.raw ? URL.createObjectURL(f.raw) : "";
    img.src = blob || fileUrl(f.path, false, f.pc); img.alt = f.name;
    title.textContent = many ? `${f.name} · ${i + 1}/${items.length}` : f.name;
    tab.href = img.src; dl.href = blob || fileUrl(f.path, true, f.pc); dl.download = f.name;
    where.replaceChildren(...(f.path ? [pathCopy(f.path, "lb-p")] : []));
    zoom(1);
  };
  if (many) for (const [k, label, ic, step] of [["prev", "이전 이미지", "back", -1], ["next", "다음 이미지", "chev", 1]]) navs.push(el("button", { class: `lb-nav ${k}`, type: "button", "data-k": k, "aria-label": label, onclick: () => show(i + step) }, icon(ic)));
  box.append(...navs);
  const gap = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  img.addEventListener("pointerdown", ev => {
    img.setPointerCapture(ev.pointerId);
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pts.size === 2) { pinch = { d: gap(), z }; drag = null; } else drag = { x: ev.clientX, y: ev.clientY, ox: x, oy: y };
  });
  img.addEventListener("pointermove", ev => {
    if (!pts.has(ev.pointerId)) return;
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && pts.size === 2) zoom(Math.min(5, Math.max(1, pinch.z * gap() / pinch.d)), x, y);
    else if (drag && z > 1) zoom(z, drag.ox + ev.clientX - drag.x, drag.oy + ev.clientY - drag.y);
  });
  const lift = ev => {
    if (!pts.delete(ev.pointerId)) return;
    pinch = null;
    if (!drag) return;
    const dx = ev.clientX - drag.x, still = Math.abs(dx) < 8 && Math.abs(ev.clientY - drag.y) < 8;
    drag = null;
    if (z === 1 && many && Math.abs(dx) > 48) return show(i + (dx < 0 ? 1 : -1));
    if (!still || ev.pointerType === "mouse") return;
    if (ev.timeStamp - tapAt < 300) { zoom(z > 1 ? 1 : 2.5); tapAt = 0; } else tapAt = ev.timeStamp;
  };
  img.addEventListener("pointerup", lift);
  img.addEventListener("pointercancel", lift);
  img.addEventListener("dblclick", () => zoom(z > 1 ? 1 : 2.5));
  const d = el("dialog", { class: "lbox", "aria-label": items[start].name },
    el("div", { class: "lb-in" },
      el("div", { class: "lb-bar" }, title, tab, dl, el("button", { class: "x", type: "button", "aria-label": "닫기", onclick: () => d.close() }, icon("close"))),
      where, box));
  d.addEventListener("keydown", ev => { if (many && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) { ev.preventDefault(); show(i + (ev.key === "ArrowLeft" ? -1 : 1)); } });
  d.addEventListener("close", () => { if (blob) URL.revokeObjectURL(blob); img.removeAttribute("src"); d.remove(); });
  show(start);
  document.body.append(d); d.showModal(); dialogHist(d);
}
// A path an agent writes in a reply (`code.path`) opens as a preview when the gateway allows it; images show inline.
// pc: the conversation belongs to the other computer, so the path is a file there (read through the peer proxy).
async function openPath(p, pc) {
  const r = await fetch(fileUrl(p, false, pc), { method: "HEAD" }).catch(() => null);
  if (!r || !r.ok) { toast(r ? refusedNote(r) : "확인하지 못했어요", true); return; }
  if (IMG_RE.test(p)) lightbox(p, p.split("/").pop(), pc); else window.open(fileUrl(p, false, pc), "_blank", "noopener");
}
function pathFiles(md, pc) {
  const imgs = [];
  for (const c of md.querySelectorAll("code.path")) {
    const p = c.textContent.replace(/:\d+(-\d+)?$/, "");
    if (!/^(~\/|\/)[^\s]+\.[A-Za-z0-9]{1,6}$/.test(p)) continue;
    c.classList.add("fp"); c.title = "미리보기"; c.onclick = () => openPath(p, pc);
    if (IMG_RE.test(p) && imgs.length < 4 && !imgs.some(f => f.path === p)) imgs.push({ path: p, name: p.split("/").pop(), pc });
  }
  const n = imgs.length ? filesNode(imgs) : null;
  if (n) for (const img of n.querySelectorAll("img")) img.onerror = () => img.closest(".fitem").remove();
  return n;
}
setInterval(() => { if ((current === "chat" || current === "activity") && !document.hidden) loadContext(true).then(renderCtxRing); }, 15000);
// A reload lands on the conversation it left: its draft and waiting files come back (a microtask: the later modules of this one script must exist first).
queueMicrotask(() => {
  try { if (!ta.value) ta.value = ts(target).draft = localStorage.getItem(DRAFT_KEY(target)) || ""; } catch {}
  if (!ATT.length) ATT = atkLoad(target);
  renderAtt(); autosize();
});
