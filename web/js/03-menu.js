/* ---------- menu: the single dropdown component ---------- */
let openMenu = null;
function closeMenu(restore = true) {
  if (!openMenu) return;
  const m = openMenu; openMenu = null;
  m.node.remove();
  for (const [t, f, o] of m.listeners) t.removeEventListener(f.type, f.fn, o);
  m.anchor.setAttribute("aria-expanded", "false");
  if (restore && m.anchor.isConnected) m.anchor.focus();
}
// items: [{value, label, sub?}] or [{header}]. onPick(value) runs after the menu closes.
// sheet: a bottom sheet across the screen above the anchor (the phone tab bar), instead of a dropdown at the anchor.
function showMenu(anchor, items, { value, onPick, sheet }) {
  if (openMenu && openMenu.anchor === anchor) { closeMenu(); return; }
  closeMenu(false);
  const node = el("div", { class: sheet ? "menu msheet" : "menu", role: "listbox", tabindex: "-1" });
  const opts = [];
  // An item with `fold` (a list of items) is a "더 보기" row that expands in place.
  const mk = it => {
    if (it.header != null) return [el("div", { class: "mh", role: "presentation", text: it.header }), null];
    if (it.fold) {
      const b = el("button", { type: "button", class: "mi more", tabindex: "-1", onclick: ev => {
        ev.stopPropagation();
        let at = opts.indexOf(b); const first = at; opts.splice(at, 1);
        for (const x of it.fold) { const [n, o] = mk(x); node.insertBefore(n, b); if (o) opts.splice(at++, 0, o); }
        b.remove(); place(); focusAt(first);
      } }, el("span", { class: "ck" }), el("span", { class: "ml", text: it.label }), icon("drop"));
      b._label = String(it.label).toLowerCase();
      return [b, b];
    }
    const on = it.value === value;
    const b = el("button", { type: "button", role: "option", class: `mi${on ? " sel-on" : ""}`, "aria-selected": on ? "true" : "false", tabindex: "-1", onclick: () => { closeMenu(); onPick(it.value); } },
      on ? icon("check", "ck") : el("span", { class: "ck" }),
      it.tone != null ? el("span", { class: `dot ${it.tone}` }) : null,
      el("span", { class: "ml" }, it.label, it.sub ? el("small", { text: it.sub }) : null),
      it.flag ? el("span", { class: "sb warn", text: it.flag }) : null,
      it.badge ? el("span", { class: "nb", text: String(it.badge) }) : null);
    b._label = String(it.label).toLowerCase();
    return [b, b];
  };
  for (const it of items) { const [n, o] = mk(it); node.append(n); if (o) opts.push(o); }
  const host = anchor.closest("dialog") || document.body;
  host.append(node);
  const place = () => {
    const r = anchor.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
    if (sheet) {
      node.style.left = "8px"; node.style.width = `${vw - 16}px`;
      // an anchor with no box (the tab bar hides while typing) puts the sheet at the screen's bottom edge
      const top = r.height ? r.top : vh;
      node.style.bottom = `${vh - top + 8}px`;
      node.style.maxHeight = `${Math.max(160, Math.min(vh * 0.6, top - 16))}px`;
      return;
    }
    node.style.minWidth = `${Math.max(112, r.width)}px`;
    node.style.maxWidth = `${vw - 16}px`;
    const below = vh - r.bottom - 12, above = r.top - 12;
    const up = below < 220 && above > below;
    node.style.maxHeight = `${Math.min(400, up ? above : below)}px`;
    const w = node.offsetWidth, h = node.offsetHeight;
    let left = r.left;
    if (left + w > vw - 8) left = Math.max(8, r.right - w);
    node.style.left = `${left}px`;
    node.style.top = `${Math.max(8, up ? r.top - h - 4 : r.bottom + 4)}px`;
  };
  place();
  anchor.setAttribute("aria-expanded", "true");
  const focusAt = i => { const o = opts[Math.max(0, Math.min(opts.length - 1, i))]; if (o) { o.focus(); o.scrollIntoView({ block: "nearest" }); } };
  const start = opts.findIndex(o => o.getAttribute("aria-selected") === "true");
  focusAt(start < 0 ? 0 : start);
  const sel = opts[start]; if (sel) node.scrollTop = Math.max(0, sel.offsetTop - node.clientHeight / 2);
  let typed = "", typedTimer;
  const keydown = ev => {
    const cur = opts.indexOf(document.activeElement);
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenu(); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); focusAt(cur + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); focusAt(cur < 0 ? 0 : cur - 1); }
    else if (ev.key === "Home") { ev.preventDefault(); focusAt(0); }
    else if (ev.key === "End") { ev.preventDefault(); focusAt(opts.length - 1); }
    else if (ev.key === "Tab") closeMenu(false);
    else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      clearTimeout(typedTimer); typed += ev.key.toLowerCase(); typedTimer = setTimeout(() => { typed = ""; }, 700);
      const i = opts.findIndex(o => o._label.startsWith(typed));
      if (i >= 0) focusAt(i);
    }
  };
  const outside = ev => { if (!node.contains(ev.target) && !anchor.contains(ev.target)) closeMenu(false); };
  const onScroll = ev => { if (!node.contains(ev.target)) closeMenu(false); };
  const onResize = () => closeMenu(false);
  const L = [[document, { type: "keydown", fn: keydown }, true], [document, { type: "pointerdown", fn: outside }, true], [window, { type: "scroll", fn: onScroll }, true], [window, { type: "resize", fn: onResize }, false]];
  for (const [t, f, o] of L) t.addEventListener(f.type, f.fn, o);
  openMenu = { node, anchor, listeners: L };
}
function selectField(label, text, items, value, onPick) {
  const b = el("button", { type: "button", class: "sel", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": `${label}: ${text}` },
    el("span", { class: "val", text }), icon("drop"));
  b.addEventListener("click", () => showMenu(b, typeof items === "function" ? items() : items, { value, onPick }));
  return el("div", { class: "tf" }, el("span", { class: "lb", text: label }), b);
}
function textField(label, input) {
  return el("div", { class: "tf" }, el("label", { text: label, for: input.id }), input);
}
let fieldSeq = 0;
const input = (opts = {}) => el("input", { id: `f${++fieldSeq}`, class: "fi", autocomplete: "off", autocapitalize: "off", spellcheck: "false", ...opts });
