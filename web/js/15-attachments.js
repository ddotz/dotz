/* ---------- attachments: + button, drag-drop, paste -> POST /api/upload; sent as `files` with the message ---------- */
let ATT = [];   // [{id, name, type, size, url (local preview), file (server record once uploaded)}]
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|heic)$/i;
const fileUrl = (p, dl) => `/api/file?path=${enc(p)}${dl ? "&download=1" : ""}`;
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
  if (ATT.length + list.length > 10) { toast("한 번에 10개까지 보낼 수 있어요", true); list = list.slice(0, Math.max(0, 10 - ATT.length)); }
  const items = list.map(f => ({ id: Math.random().toString(36).slice(2), name: f.name || "붙여넣은 이미지.png", type: f.type, size: f.size, url: /^image\//.test(f.type) ? URL.createObjectURL(f) : "", raw: f }));
  ATT = ATT.concat(items); renderAtt(); ta.focus();
  await Promise.all(items.map(async a => {
    const form = new FormData();
    form.append("file", a.raw, a.name);
    try {
      const r = await fetch("/api/upload", { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `올리지 못했어요 (HTTP ${r.status})`);
      a.file = d.files[0];
    } catch (e) { toast(`${a.name}: ${e instanceof TypeError ? "연결이 끊겨 올리지 못했어요" : e.message}`, true); dropAtt(a.id); }
    renderAtt();
  }));
}
function dropAtt(id) { const a = ATT.find(x => x.id === id); if (a && a.url) URL.revokeObjectURL(a.url); ATT = ATT.filter(x => x.id !== id); renderAtt(); }
function fileChip(name, meta, extra = {}) {
  return el(extra.href ? "a" : extra.onclick ? "button" : "div", { class: `fatt${extra.cls ? ` ${extra.cls}` : ""}`, ...(extra.href ? { href: extra.href, target: "_blank", rel: "noopener", title: `${name} · 열기` } : extra.onclick ? { type: "button", onclick: extra.onclick, title: `${name} · 열기` } : { title: name }) },
    el("span", { class: "fi-ic" }, icon("file")), el("span", { class: "fi-t" }, el("span", { class: "fi-n", text: name }), el("span", { class: "fi-m", text: meta })), extra.x || null);
}
function renderAtt() {
  const box = $("#atray");
  $("#send").classList.toggle("has-att", ATT.length > 0);
  box.hidden = !ATT.length;
  clear(box).append(...ATT.map(a => {
    const x = el("button", { class: "ax", type: "button", "aria-label": `${a.name} 빼기`, onclick: () => dropAtt(a.id) }, icon("close"));
    if (a.url) return el("div", { class: `fatt img${a.file ? "" : " up"}`, title: a.name }, el("img", { src: a.url, alt: a.name }), x);
    return fileChip(a.name, a.file ? [extOf(a.name), fsize(a.size)].filter(Boolean).join(" · ") : "올리는 중…", { cls: a.file ? "" : "up", x });
  }));
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
// Files in a message: image thumbnails open the lightbox, other files open the read-only preview in a new tab; each has a
// one-click download (Content-Disposition: attachment, so iOS Safari saves it too). `check` files (an agent's [file] line)
// are asked with HEAD first: the size fills in, and one /api/file refuses (outside the roots, secret, missing) turns into a
// disabled chip.
const fileNote = (r, fallback) => { try { return decodeURIComponent(r.headers.get("x-file-note") || "") || fallback; } catch { return fallback; } };
const fileMeta = (name, size) => [extOf(name), size ? fsize(size) : ""].filter(Boolean).join(" · ");
const VIEW_RE = /\.(md|markdown|txt|log|json|ya?ml|csv|tsv)$/i;   // opens in the reader below, the rest in a tab (pdf) or as a download
const offChip = (f, why) => fileChip(f.name, why, { cls: "off" });
function fileItem(f) {
  const img = IMG_RE.test(f.name || f.path);
  const main = img
    ? el("button", { class: "thumb", type: "button", "aria-label": `${f.name} 크게 보기`, onclick: () => lightbox(f.path, f.name) }, el("img", { src: fileUrl(f.path), alt: f.name, loading: "lazy" }))
    : fileChip(f.name, fileMeta(f.name, f.size), VIEW_RE.test(f.name) ? { onclick: () => viewer(f.path, f.name) } : { href: fileUrl(f.path) });
  const item = el("div", { class: "fitem" }, el("div", { class: "fbox" }, main, el("a", { class: "fdl", href: fileUrl(f.path, true), download: f.name, title: `${f.name} 다운로드`, "aria-label": `${f.name} 다운로드` }, icon("download"))), pathCopy(f.path));
  if (!f.check) return item;
  const off = why => { if (item.isConnected || item.parentNode) item.replaceWith(offChip(f, why)); };
  if (img) main.querySelector("img").onerror = () => off("열 수 없는 파일이에요");
  fetch(fileUrl(f.path), { method: "HEAD" }).then(r => {
    if (!r.ok) return off(fileNote(r, r.status === 404 ? "파일이 지워졌어요" : "열 수 없는 파일이에요"));
    const n = Number(r.headers.get("content-length") || 0), m = !img && main.querySelector(".fi-m");
    if (m && n) m.textContent = fileMeta(f.name, n);
  }, () => off("확인하지 못했어요"));
  return item;
}
// The full path under a file, as written by the agent: a tap copies it (Finder, terminal, another app), the chip above opens the file.
function pathCopy(p, cls = "fpath") {
  return el("button", { class: cls, type: "button", title: "경로 복사", "aria-label": `경로 복사: ${p}`, text: p,
    onclick: async ev => { ev.stopPropagation(); const ok = await copyText(p); toast(ok ? "경로를 복사했어요" : "복사하지 못했어요", !ok); } });
}
function filesNode(files) {
  if (!files || !files.length) return null;
  return el("div", { class: "mfiles" }, ...files.map(fileItem));
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
async function viewer(path, name) {
  const body = el("div", { class: "tv-body md", tabindex: "-1", autofocus: true }, el("p", { class: "tv-st", text: "불러오는 중…" }));
  const d = el("dialog", { class: "tbox", "aria-label": name },
    el("div", { class: "tv-in" },
      el("div", { class: "tv-bar" }, el("span", { class: "tv-n", text: name }),
        el("a", { href: fileUrl(path, true), download: name }, "다운로드"),
        el("button", { class: "x", type: "button", "aria-label": "닫기", onclick: () => d.close() }, icon("close"))),
      pathCopy(path, "tv-p"),
      body));
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", ev => { if (ev.target === d) d.close(); });
  document.body.append(d); d.showModal(); dialogHist(d);
  try {
    const r = await fetch(fileUrl(path));
    if (!r.ok) throw fileNote(r, r.status === 404 ? "파일이 지워졌어요" : "열 수 없는 파일이에요");
    let t = await r.text();
    const cut = t.length > 200000;
    if (cut) t = t.slice(0, 200000);
    clear(body).append(/\.(md|markdown)$/i.test(name) ? mdNode(t, "md") : el("pre", { text: t }));
    if (cut) body.append(el("p", { class: "tv-st", text: "앞부분만 보여요. 전체는 다운로드해 주세요" }));
  } catch (e) { clear(body).append(el("p", { class: "tv-st", text: typeof e === "string" ? e : "열 수 없어요" })); }
}
function lightbox(path, name) {
  const d = el("dialog", { class: "lbox", "aria-label": name },
    el("div", { class: "lb-in" },
      el("div", { class: "lb-bar" }, el("span", { class: "lb-n", text: name }),
        el("a", { href: fileUrl(path), target: "_blank", rel: "noopener" }, "새 탭"),
        el("a", { href: fileUrl(path, true), download: name }, "다운로드"),
        el("button", { class: "x", type: "button", "aria-label": "닫기", onclick: () => d.close() }, icon("close"))),
      pathCopy(path, "lb-p"),
      el("div", { class: "lb-img", tabindex: "-1", autofocus: true, onclick: ev => { if (ev.target === ev.currentTarget) d.close(); } }, el("img", { src: fileUrl(path), alt: name }))));
  d.addEventListener("close", () => d.remove());
  document.body.append(d); d.showModal(); dialogHist(d);
}
// A path an agent writes in a reply (`code.path`) opens as a preview when the gateway allows it; images show inline.
async function openPath(p) {
  const r = await fetch(fileUrl(p), { method: "HEAD" }).catch(() => null);
  if (!r || !r.ok) { toast(r ? fileNote(r, r.status === 404 ? "파일이 지워졌어요" : "열 수 없는 파일이에요") : "확인하지 못했어요", true); return; }
  if (IMG_RE.test(p)) lightbox(p, p.split("/").pop()); else window.open(fileUrl(p), "_blank", "noopener");
}
function pathFiles(md) {
  const imgs = [];
  for (const c of md.querySelectorAll("code.path")) {
    const p = c.textContent.replace(/:\d+(-\d+)?$/, "");
    if (!/^(~\/|\/)[^\s]+\.[A-Za-z0-9]{1,6}$/.test(p)) continue;
    c.classList.add("fp"); c.title = "미리보기"; c.onclick = () => openPath(p);
    if (IMG_RE.test(p) && imgs.length < 4 && !imgs.some(f => f.path === p)) imgs.push({ path: p, name: p.split("/").pop() });
  }
  const n = imgs.length ? filesNode(imgs) : null;
  if (n) for (const img of n.querySelectorAll("img")) img.onerror = () => img.closest(".fitem").remove();
  return n;
}
setInterval(() => { if (current === "chat" || current === "activity") loadContext(true).then(renderCtxRing); }, 15000);
