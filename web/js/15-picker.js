/* ---------- element picker: Cmd+click (a phone: a long press) an element inside an app's frame and send it with the message ---------- */
// Only an inner canvas can be picked: the same-origin app frame of the 앱 screen (30-apps.js, iframe.apps-frame) or of the 캔버스 (30-canvas.js). There is no pick
// button and no pick mode. Inside the frame, holding Cmd (Ctrl off a Mac) outlines the element under the pointer and Cmd+click picks
// it; releasing Cmd hides the outline. On a phone a long press (PK_HOLD ms, no move) picks; a tap or a scroll stays the app's own.
// Outside the frame Cmd+click is the browser's. The app header says how (pkHint).
// Picks belong to the conversation open now; another conversation's wait in its ts(t).pick, like its files (13-data.js setTarget).
// A pick never calls the element's own handler: every pointer event of the pick is taken in the capture phase and cancelled.
let PICK = [];   // [{id, n, tag, sel, text, html, view, title, node, doc, frame}]
const PK_FRAME = "iframe.apps-frame";
const PK_FIELD = /^(input|textarea|select)$/;
const PK_HOLD = 500;
const PK_MARKS = new Map();   // pick id -> marker element
let pkTouchAt = 0, pkRaf = 0, pkTickT = 0;
let pkArmed = false, pkLast = null, pkPress = null;   // Cmd held; {n, frame} under the mouse in a frame; {x, y, n, doc, frame, t, done} of a touch
const pkFlat = s => String(s ?? "").replace(/\s+/g, " ").trim();
const pkItems = () => PICK.map(p => ({ n: p.n, tag: p.tag, sel: p.sel, text: p.text, html: p.html, view: p.view, title: p.title }));
const pkCount = () => PICK.length;

const pkBox = el("div", { id: "pick-box", class: "pk-box", "aria-hidden": "true", hidden: true }, el("span", { class: "pk-lab" }));
const pkMarks = el("div", { id: "pick-marks", "aria-hidden": "true" });
document.body.append(pkBox, pkMarks);

/* ---------- what a pick carries ---------- */
function pkText(n) {
  if ((n.type || "").toLowerCase() === "password") return "";
  if (PK_FIELD.test(n.tagName.toLowerCase())) return pkFlat(n.getAttribute("placeholder") || n.getAttribute("aria-label") || n.getAttribute("name") || n.type || "");
  return pkFlat(n.innerText || n.textContent || "").slice(0, 200);
}
// A class is stable enough to name an element when it is a plain word: no framework prefix, no hash, no three-digit run.
function pkClass(c) {
  if (!/^[A-Za-z][\w-]{0,40}$/.test(c)) return false;
  if (/^(css|sc|jsx|emotion|svelte)-/.test(c) || c[0] === "_") return false;
  if (/\d{3,}/.test(c)) return false;
  return !(/\d/.test(c) && /[A-Z]/.test(c) && c.length > 10);
}
function pkSel(n, doc) {
  const q = c => { try { return doc.querySelectorAll(c); } catch { return []; } };
  const esc = s => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const byId = e => e.id && q(`#${esc(e.id)}`).length === 1 ? `#${esc(e.id)}` : "";
  if (byId(n)) return byId(n);
  const parts = [];
  for (let cur = n, i = 0; cur && cur.nodeType === 1 && i < 5; cur = cur.parentElement, i++) {
    if (cur !== n) {
      if (cur === doc.body || cur === doc.documentElement) break;
      const top = byId(cur);
      if (top) { parts.unshift(top); break; }
    }
    const tag = cur.tagName.toLowerCase();
    const cls = [...cur.classList].filter(pkClass).slice(0, 2);
    let seg = tag + cls.map(c => `.${esc(c)}`).join("");
    const sibs = cur.parentElement ? [...cur.parentElement.children].filter(s => s.tagName === cur.tagName) : [];
    if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
    parts.unshift(seg);
  }
  return parts.join(" > ");
}
const pkHtml = n => pkFlat(n.outerHTML || "").replace(/\s(?:value|checked|selected)="[^"]*"/gi, "").slice(0, 600);
// dotz: the view on screen; an app's frame: the app and the page inside it.
function pkView(doc, frame) {
  if (frame) {
    const src = frame.getAttribute("src") || "";
    if (frame.classList.contains("cvs-frame")) return `canvas:${frame.title || "html"}`;
    const id = (src.match(/\/apps\/([^/?#]+)/) || [])[1] || frame.title || "app";
    let path = "/";
    try { path = doc.defaultView.location.pathname; } catch {}
    return `app:${id} ${path}`;
  }
  const sec = [...document.querySelectorAll("section.view")].find(x => !x.hidden);
  return sec ? sec.id.replace(/^v-/, "") : typeof current === "string" ? current : "dotz";
}

/* ---------- hover box, markers, chips ---------- */
function pkHover(n, frame) {
  if (!n) { pkBox.hidden = true; return; }
  const r = n.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) { pkBox.hidden = true; return; }
  const fr = frame && frame.isConnected ? frame.getBoundingClientRect() : { left: 0, top: 0 };
  const x = r.left + fr.left, y = r.top + fr.top;
  pkBox.hidden = false;
  pkBox.style.left = `${Math.round(x)}px`;
  pkBox.style.top = `${Math.round(y)}px`;
  pkBox.style.width = `${Math.round(r.width)}px`;
  pkBox.style.height = `${Math.round(r.height)}px`;
  pkBox.classList.toggle("below", y < 34);
  pkBox.firstChild.textContent = `${n.tagName.toLowerCase()} · ${pkFlat(n.innerText || n.textContent || "").slice(0, 40) || "…"}`;
}
function pkSyncMarks() {
  PICK.forEach((p, i) => { p.n = i + 1; });
  const ids = new Set(PICK.map(p => p.id));
  for (const [id, m] of PK_MARKS) if (!ids.has(id)) { m.remove(); PK_MARKS.delete(id); }
  for (const p of PICK) {
    let m = PK_MARKS.get(p.id);
    if (!m) { m = el("span", { class: "pk-mark", hidden: true }); pkMarks.append(m); PK_MARKS.set(p.id, m); }
    m.textContent = String(p.n);
  }
}
function pkPlace() {
  for (const p of PICK) {
    const m = PK_MARKS.get(p.id);
    if (!m) continue;
    let r = null;
    try { r = p.node && p.node.isConnected ? p.node.getBoundingClientRect() : null; } catch { r = null; }
    let seen = true;
    try { seen = !!p.doc.defaultView && p.doc.defaultView.getComputedStyle(p.node).visibility !== "hidden"; } catch {}
    // A frame that is off screen (its view hidden) has no box: its element keeps a box of its own, so check the frame.
    if (p.frame && !p.frame.getClientRects().length) seen = false;
    const vis = !!r && r.width > 0 && r.height > 0 && seen;
    m.hidden = !vis;
    if (!vis) continue;
    let ox = 0, oy = 0;
    try { if (p.frame && p.frame.isConnected) { const fr = p.frame.getBoundingClientRect(); ox = fr.left; oy = fr.top; } } catch {}
    // Outside the element's own text when the margin allows it (a wide screen), on its corner when it does not (a phone).
    const x = r.left + ox, y = r.top + oy;
    m.style.left = `${Math.round(x >= 30 ? x - 26 : x)}px`;
    m.style.top = `${Math.round(y)}px`;
  }
}
// One frame per scroll or resize, not one per frame: a phone in pick mode keeps its main thread.
const pkKick = () => { if (!pkRaf) pkRaf = requestAnimationFrame(() => { pkRaf = 0; pkPlace(); }); };
// A slow pass for lazy images and layout shifts; off while nothing is picked.
function pkTick() {
  if (!PICK.length) { if (pkTickT) { clearInterval(pkTickT); pkTickT = 0; } return; }
  if (pkTickT) return;
  pkTickT = setInterval(() => { if (PICK.length > 0 && document.visibilityState === "visible") pkPlace(); }, 400);
}

function pkChip(p) {
  return el("div", { class: "fatt pk-chip", title: `${p.tag} · ${p.text || p.sel}` },
    el("span", { class: "pk-n", text: String(p.n) }),
    el("span", { class: "fi-t" },
      el("span", { class: "fi-n", text: p.text || p.tag }),
      el("span", { class: "fi-m", text: [p.view, p.title].filter(Boolean).join(" · ") })),
    el("button", { class: "ax", type: "button", "aria-label": `${p.n}번 요소 빼기`, onclick: () => pkDrop(p.id) }, icon("close")));
}
function renderPicks() {
  const tray = $("#atray");
  if (!tray) return;
  for (const n of [...tray.querySelectorAll(".pk-chip")]) n.remove();
  tray.classList.toggle("has-pick", PICK.length > 0);
  if (PICK.length) tray.append(...PICK.map(pkChip));
  const total = ATT.length + PICK.length;
  tray.hidden = !total;
  $("#send").classList.toggle("has-att", total > 0);
  pkSyncMarks();
  pkPlace();
  pkKick();
  pkTick();
}
function pkDrop(id) {
  PICK = PICK.filter(p => p.id !== id);
  renderPicks();
}
function pkClear() { PICK = []; renderPicks(); }
function pkRestore(list) { if (list && list.length) { PICK = list.concat(PICK); renderPicks(); } }
function pkAssign(list) { PICK = list || []; renderPicks(); }

/* ---------- picking itself ---------- */
function pkDo(n, doc, frame) {
  if (!n) return;
  if (PICK.length >= 10) { toast("요소는 한 번에 10개까지 보낼 수 있어요", true); return; }
  PICK.push({ id: Math.random().toString(36).slice(2), n: PICK.length + 1, tag: n.tagName.toLowerCase(), sel: pkSel(n, doc), text: pkText(n), html: pkHtml(n), view: pkView(doc, frame), title: String(doc.title || ""), node: n, doc, frame: frame || null });
  pkHover(null);
  renderPicks();
}
// Every pointer and click event of a pick is cancelled in the capture phase: the element's own handler never runs, no link opens.
function pkStop(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
}
const pkMod = ev => !!ev && (isMac ? ev.metaKey : ev.ctrlKey);
const pkModKey = k => k === (isMac ? "Meta" : "Control");
// Cmd down: the element under the mouse gets the outline and the frame the crosshair; Cmd up (or the window losing focus) clears both.
function pkArm(on) {
  on = !!on;
  if (on === pkArmed) return;
  pkArmed = on;
  for (const f of document.querySelectorAll(PK_FRAME)) { try { f.contentDocument.documentElement.classList.toggle("dz-picking", on); } catch {} }
  pkHover(on && pkLast && pkLast.n.isConnected ? pkLast.n : null, pkLast && pkLast.frame);
}
function pkTouchHit(t, doc) {
  let n = null;
  try { n = doc.elementFromPoint(t.clientX, t.clientY); } catch {}
  return n && n.nodeType === 1 && n !== doc.body && n !== doc.documentElement ? n : null;
}
function pkPressEnd() { if (pkPress) clearTimeout(pkPress.t); pkPress = null; }
function pkBind(doc, frame) {
  if (!doc || doc.__pkBound) return;
  doc.__pkBound = true;
  const win = doc.defaultView;
  const hit = ev => {
    const n = ev.target && ev.target.nodeType === 1 ? ev.target : ev.target && ev.target.parentElement;
    return n && n.isConnected && n !== doc.body && n !== doc.documentElement ? n : null;
  };
  doc.addEventListener("pointermove", ev => {
    if (ev.pointerType === "touch") return;
    const n = hit(ev);
    pkLast = n ? { n, frame } : null;
    if (pkMod(ev) !== pkArmed) pkArm(pkMod(ev));   // Cmd pressed while another window had the keys
    else if (pkArmed) pkHover(n, frame);
  }, true);
  doc.documentElement.addEventListener("mouseleave", () => { pkLast = null; if (pkArmed) pkHover(null); });
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"]) doc.addEventListener(type, ev => { if (pkMod(ev) && ev.pointerType !== "touch") pkStop(ev); }, { capture: true, passive: false });
  doc.addEventListener("click", ev => {
    if (Date.now() - pkTouchAt < 600) { pkStop(ev); return; }   // the click a phone makes after a long-press pick
    if (!pkMod(ev)) return;
    pkStop(ev);
    const n = hit(ev);
    if (n) pkDo(n, doc, frame);
    if (pkArmed && pkLast) pkHover(pkLast.n, frame);   // Cmd still down: the outline stays for the next pick
  }, true);
  // A long press picks. touchstart stays passive: the page scrolls as before, and a short tap is the app's own.
  doc.addEventListener("touchstart", ev => {
    pkPressEnd();
    if (ev.touches.length !== 1) return;
    const t = ev.touches[0], n = pkTouchHit(t, doc);
    if (!n) return;
    const p = { x: t.clientX, y: t.clientY, n, done: false, t: 0 };
    p.t = setTimeout(() => {
      if (pkPress !== p || !n.isConnected) return;
      p.done = true;
      pkTouchAt = Date.now();
      try { doc.getSelection().removeAllRanges(); } catch {}
      if (navigator.vibrate) try { navigator.vibrate(10); } catch {}
      pkDo(n, doc, frame);
    }, PK_HOLD);
    pkPress = p;
  }, { capture: true, passive: true });
  doc.addEventListener("touchmove", ev => {
    const t = ev.touches[0];
    if (pkPress && !pkPress.done && t && Math.hypot(t.clientX - pkPress.x, t.clientY - pkPress.y) > 10) pkPressEnd();   // a scroll
  }, { capture: true, passive: true });
  doc.addEventListener("touchend", ev => {
    const p = pkPress;
    pkPressEnd();
    if (p && p.done) { pkTouchAt = Date.now(); pkStop(ev); }   // no click reaches the picked element
  }, { capture: true, passive: false });
  doc.addEventListener("touchcancel", pkPressEnd, { capture: true, passive: true });
  // The long press is the pick: no menu, no link preview, no text selection.
  doc.addEventListener("contextmenu", ev => { if (pkPress || Date.now() - pkTouchAt < 800) pkStop(ev); }, true);
  doc.addEventListener("selectstart", ev => { if (pkPress) pkStop(ev); }, true);
  pkKeys(win);
  doc.addEventListener("scroll", () => { pkKick(); if (pkArmed && pkLast) pkHover(pkLast.n, frame); }, true);
  doc.head.append(Object.assign(doc.createElement("style"), { textContent: "html.dz-picking, html.dz-picking * { cursor: crosshair !important; } html { -webkit-touch-callout: none; }" }));
}
// The keys reach whichever window has the focus: dotz's own, or the app's frame after a click in it.
function pkKeys(win) {
  if (!win || win.__pkKeys) return;
  win.__pkKeys = true;
  win.addEventListener("keydown", ev => { if (pkModKey(ev.key)) pkArm(true); else if (pkArmed && !pkMod(ev)) pkArm(false); }, true);
  win.addEventListener("keyup", ev => { if (pkModKey(ev.key) || !pkMod(ev)) pkArm(false); }, true);
  win.addEventListener("blur", () => pkArm(false));
}
function pkFrame(f) {
  if (!f.matches(PK_FRAME)) return;
  try {
    const d = f.contentDocument;
    if (!d || !d.head) return;
    d.defaultView.location.pathname;   // a cross-origin frame throws here and is skipped
    pkBind(d, f);
  } catch {}
}
// The app header's hint (30-apps.js appsHeader): a phone has no keys, so it says the long press.
const pkTouch = () => matchMedia("(hover: none) and (pointer: coarse)").matches;
function pkHint() {
  return el("span", { class: "pk-hint", text: pkTouch() ? "길게 눌러 요소 고르기" : isMac ? "⌘+클릭으로 요소 고르기" : "Ctrl+클릭으로 요소 고르기" });
}
pkKeys(window);
addEventListener("resize", pkKick);
document.addEventListener("load", ev => { const t = ev.target; if (t && t.tagName === "IFRAME") pkFrame(t); }, true);
// The app screen left (a tab key with Cmd still down, the back button): the outline goes with it.
const pkGone = () => { if (!pkBox.hidden && pkLast && !(pkLast.frame && pkLast.frame.getClientRects().length)) pkHover(null); };
new MutationObserver(muts => {
  pkGone();
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.tagName === "IFRAME") pkFrame(n);
    else if (n.querySelectorAll) for (const f of n.querySelectorAll("iframe")) pkFrame(f);
  }
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
