/* ---------- 캔버스: an HTML page the bot made, opened from its file chip in the chat ---------- */
// The page is read from GET /api/canvas?path=... (hub/files.ts canvasRoute, the sandboxed page 새 탭 opens) and shown as the frame's srcdoc:
// same origin, so Cmd+click picks its elements like an app's (15-picker.js, iframe.apps-frame). A sandbox without scripts would also stop
// the picker's own listeners, so the page's script is taken out instead (canvasDoc) and a script-src 'none' policy blocks what is left. It uses the 앱 screen's header and frame (30-apps.js, 20-apps.css):
// file mark, name, path, the pick hint, 새 탭, close. From 1100px it sits beside the conversation, so a pick's chip shows in the composer
// next to it; below that it is a full-screen sheet with a back button. Picks stay with the conversation when the canvas closes.
const CVS = { path: "", name: "", narrow: null };
const canvasPane = el("section", { id: "canvas", class: "cvs-pane apps-pane", "aria-label": "캔버스", hidden: true });
$("#v-chat").append(canvasPane);
const canvasUrl = p => `/api/canvas?path=${enc(p)}`;
const canvasIsHtml = name => /\.html?$/i.test(String(name || ""));
const CANVAS_CSP = "default-src 'none'; script-src 'none'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:";
const CANVAS_URL_ATTR = /^(href|src|action|formaction|xlink:href|poster|background)$/;
// The page without anything that runs: script and plugin elements, on* handlers, javascript: / vbscript: / data:text/html links, a
// refresh. Links open a new tab, so the frame never leaves the page (and the picker never loses it).
function canvasDoc(html) {
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  for (const n of doc.querySelectorAll("script, iframe, frame, frameset, object, embed, applet, base, meta[http-equiv], link[rel~='import' i], portal")) n.remove();
  for (const n of doc.querySelectorAll("*")) for (const a of [...n.attributes]) {
    const k = a.name.toLowerCase(), v = a.value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
    if (k.startsWith("on") || k === "srcdoc" || (CANVAS_URL_ATTR.test(k) && /^(javascript|vbscript|data:text\/html)/.test(v))) n.removeAttribute(a.name);
  }
  doc.head.prepend(Object.assign(doc.createElement("meta"), { httpEquiv: "Content-Security-Policy", content: CANVAS_CSP }), Object.assign(doc.createElement("base"), { target: "_blank" }));
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function canvasHeader() {
  const narrow = narrowChat();
  return el("header", { class: "apps-hd" },
    narrow ? el("button", { class: "ib", type: "button", "aria-label": "캔버스 닫기", title: "닫기", onclick: canvasClose }, icon("back")) : null,
    el("span", { class: "cv-av app-av", "aria-hidden": "true" }, icon("file")),
    el("div", { class: "apps-hb" }, el("h2", { class: "apps-n", text: CVS.name }), el("p", { class: "apps-p", title: CVS.path, text: `HTML · ${shortPath(CVS.path)}` }), narrow ? pkHint() : null),
    narrow ? null : pkHint(),
    el("a", { class: "ib", href: canvasUrl(CVS.path), target: "_blank", rel: "noopener", "aria-label": "새 탭에서 열기", title: "새 탭에서 열기" }, icon("open")),
    narrow ? null : el("button", { class: "ib", type: "button", "aria-label": "캔버스 닫기", title: "닫기", onclick: canvasClose }, icon("close")));
}
// The header follows the width (back on a phone, close on a wide screen); the frame is kept, so the page and its markers stay.
function canvasHead() {
  if (!CVS.path) return;
  CVS.narrow = narrowChat();
  const old = $(".apps-hd", canvasPane), head = canvasHeader();
  if (old) old.replaceWith(head); else canvasPane.prepend(head);
}
function canvasOpen(path, name) {
  if (typeof current === "string" && current !== "chat") go("chat");
  const same = CVS.path === path && !canvasPane.hidden;
  CVS.path = path; CVS.name = name || path.split("/").pop() || path;
  canvasPane.hidden = false;
  $("#v-chat").classList.add("canvas-open");
  if (same) return;
  clear(canvasPane);
  canvasHead();
  const frame = el("iframe", { class: "apps-frame cvs-frame", title: CVS.name, referrerpolicy: "same-origin" });
  canvasPane.append(frame);
  fetch(canvasUrl(path)).then(async r => {
    if (!r.ok) throw new Error(fileNote(r, "열 수 없는 파일이에요"));
    const html = await r.text();
    if (CVS.path === path && frame.isConnected) frame.srcdoc = canvasDoc(html);
  }).catch(e => { if (CVS.path === path && frame.isConnected) frame.replaceWith(el("div", { class: "apps-card" }, el("p", { class: "apps-note", text: e instanceof TypeError ? "연결이 끊겨 열지 못했어요" : e.message }))); });
}
function canvasClose() {
  CVS.path = ""; CVS.name = "";
  canvasPane.hidden = true;
  $("#v-chat").classList.remove("canvas-open");
  clear(canvasPane);
}
addEventListener("resize", () => { if (CVS.path && CVS.narrow !== narrowChat()) canvasHead(); });
