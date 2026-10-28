/* ---------- element picker: tap an element of the page (or of an app's frame) and send it with the message ---------- */
// Picks belong to the conversation open now; another conversation's wait in its ts(t).pick, like its files (13-data.js setTarget).
// A pick never calls the element's own handler: every pointer event of the pick is taken in the capture phase and cancelled.
let PICK = [];   // [{id, n, tag, sel, text, html, view, title, node, doc, frame}]
let PICKING = false;
const PK_UI = "#composer, #pick-box, #pick-pill, #pick-marks";
const PK_FIELD = /^(input|textarea|select)$/;
const PK_MARKS = new Map();   // pick id -> marker element
let pkTouchAt = 0, pkRaf = 0;
const pkFlat = s => String(s ?? "").replace(/\s+/g, " ").trim();
const pkItems = () => PICK.map(p => ({ n: p.n, tag: p.tag, sel: p.sel, text: p.text, html: p.html, view: p.view, title: p.title }));
const pkCount = () => PICK.length;

const pkBox = el("div", { id: "pick-box", class: "pk-box", "aria-hidden": "true", hidden: true }, el("span", { class: "pk-lab" }));
const pkMarks = el("div", { id: "pick-marks", "aria-hidden": "true" });
const pkPill = el("div", { id: "pick-pill", role: "status", hidden: true },
  el("span", { class: "pk-dot" }),
  el("span", { class: "pk-msg", text: "요소 고르는 중" }),
  el("button", { class: "pk-end", type: "button", text: "끝내기", onclick: () => pkSet(false) }));
document.body.append(pkBox, pkMarks, pkPill);

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
function pkLoop() {
  pkRaf = 0;
  if (!PICK.length) return;
  pkPlace();
  pkRaf = requestAnimationFrame(pkLoop);
}
const pkKick = () => { if (!pkRaf && PICK.length) pkRaf = requestAnimationFrame(pkLoop); };

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
  if (!PICKING || !n) return;
  if (PICK.length >= 10) { toast("요소는 한 번에 10개까지 보낼 수 있어요", true); return; }
  PICK.push({ id: Math.random().toString(36).slice(2), n: PICK.length + 1, tag: n.tagName.toLowerCase(), sel: pkSel(n, doc), text: pkText(n), html: pkHtml(n), view: pkView(doc, frame), title: String(doc.title || ""), node: n, doc, frame: frame || null });
  pkHover(null);
  renderPicks();
}
// Every pointer and click event of a pick is cancelled in the capture phase: the element's own handler never runs.
function pkStop(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
}
function pkTouchHit(ev, doc) {
  const t = (ev.changedTouches && ev.changedTouches[0]) || (ev.touches && ev.touches[0]);
  if (!t) return null;
  let n = null;
  try { n = doc.elementFromPoint(t.clientX, t.clientY); } catch {}
  return n && n.nodeType === 1 ? n : null;
}
function pkBind(doc, frame) {
  if (!doc || doc.__pkBound) return;
  doc.__pkBound = true;
  const inUI = ev => !!(ev.target && ev.target.closest && ev.target.closest(PK_UI));
  const hit = ev => {
    const n = ev.target && ev.target.nodeType === 1 ? ev.target : ev.target && ev.target.parentElement;
    return n && n.isConnected && n !== doc.body && n !== doc.documentElement && !n.closest(PK_UI) ? n : null;
  };
  doc.addEventListener("pointermove", ev => { if (PICKING && !inUI(ev)) pkHover(hit(ev) || null, frame); }, true);
  doc.addEventListener("pointerdown", ev => { if (!PICKING || inUI(ev)) return; pkStop(ev); pkHover(hit(ev) || pkTouchHit(ev, doc), frame); }, { capture: true, passive: false });
  doc.addEventListener("mousedown", ev => { if (PICKING && !inUI(ev)) pkStop(ev); }, true);
  doc.addEventListener("mouseup", ev => { if (PICKING && !inUI(ev)) pkStop(ev); }, true);
  doc.addEventListener("click", ev => {
    if (!PICKING || inUI(ev)) return;
    pkStop(ev);
    if (Date.now() - pkTouchAt < 400) return;   // the click the browser makes after a touch pick is not a second pick
    const n = hit(ev) || pkTouchHit(ev, doc);
    if (n) pkDo(n, doc, frame);
  }, true);
  doc.addEventListener("touchstart", ev => { if (!PICKING || inUI(ev)) return; pkStop(ev); const n = pkTouchHit(ev, doc); if (n) pkHover(n, frame); }, { capture: true, passive: false });
  doc.addEventListener("touchend", ev => { if (!PICKING || inUI(ev)) return; pkStop(ev); const n = pkTouchHit(ev, doc); if (n) { pkTouchAt = Date.now(); pkDo(n, doc, frame); } }, { capture: true, passive: false });
  doc.addEventListener("scroll", pkKick, true);
}
function pkFrame(f) {
  try {
    const d = f.contentDocument;
    if (!d) return;
    d.defaultView.location.pathname;   // a cross-origin frame throws here and is skipped
    pkBind(d, f);
  } catch {}
}
function pkSet(on) {
  PICKING = !!on;
  const b = $("#c-pick");
  b.setAttribute("aria-pressed", PICKING ? "true" : "false");
  b.classList.toggle("on", PICKING);
  pkPill.hidden = !PICKING;
  document.body.classList.toggle("picking", PICKING);
  if (PICKING) for (const f of document.querySelectorAll("iframe")) pkFrame(f);
  else pkHover(null);
}

$("#c-pick").append(icon("pick"));
$("#c-pick").onclick = () => pkSet(!PICKING);
pkBind(document, null);
addEventListener("keydown", ev => {
  if (!PICKING || (ev.key !== "Escape" && ev.key !== "Esc")) return;
  pkStop(ev);
  pkSet(false);
}, true);
addEventListener("resize", pkKick);
document.addEventListener("load", ev => { const t = ev.target; if (t && t.tagName === "IFRAME") pkFrame(t); }, true);
new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.tagName === "IFRAME") pkFrame(n);
    else if (n.querySelectorAll) for (const f of n.querySelectorAll("iframe")) pkFrame(f);
  }
}).observe(document.body, { childList: true, subtree: true });
