/* ---------- 화면 안내 (docs/web-onboarding.md): a spotlight over the real menus, shown once after the web onboarding ---------- */
// The gateway remembers whether it was seen (GET/POST /api/intro, firstrun/first-run.ts), so another browser does not show it again.
// introStart() runs once the boot has settled and asks at most once per tab session; 설정 → 화면 안내 다시 보기 calls introOpen().
const INTRO_SEEN = "dotz-intro-seen";
const introTouch = () => matchMedia("(hover: none) and (pointer: coarse)").matches;
const introStops = () => {
  const apps = navTabs().some(n => n[0] === "apps");
  const stops = [
    { tab: "home", t: TX("misc.intro.home_t"), b: TX("misc.intro.home_b") },
    { tab: "chat", t: TX("misc.intro.chat_t"), b: TX("misc.intro.chat_b") },
    { tab: "projects", t: TX("misc.intro.proj_t"), b: TX("misc.intro.proj_b") },
    { tab: "monitoring", t: TX("misc.intro.mon_t"), b: TX("misc.intro.mon_b") },
    { tab: "settings", t: TX("misc.intro.set_t"), b: TX(apps ? "misc.intro.set_b_apps" : "misc.intro.set_b") },
  ];
  return introTouch() ? stops : [...stops, { keys: true, t: TX("misc.intro.keys_t") }];
};
// The keys come from the code that handles them: the palette button, MOD_KEYS and the tab numbers (04-state.js), the pane keys (43-panes-keys.js).
const introKeys = () => {
  const mod = isMac ? "⌘" : "Ctrl+", tabs = navTabs();
  return [[$("#cmdk kbd").textContent, TX("misc.intro.key_cmdk")], ...MOD_KEYS.filter(modKeyWide).map(k => [mod + k.key, k.label]), [`${navKeyHint(tabs[0][0])} ~ ${navKeyHint(tabs.at(-1)[0])}`, TX("misc.intro.key_tabs")], ...paneTourKeys()];
};
let introEl = null, introAt = 0, introFrom = null;

function introDraw() {
  const stops = introStops(), s = stops[introAt], last = introAt === stops.length - 1;
  const r = s.tab && $(`#nav .ni[data-view="${s.tab}"]`)?.getBoundingClientRect(), hit = !!r && r.width > 0;
  const bar = el("div", { class: "bar" }, el("i"));
  bar.firstChild.style.width = `${((introAt + 1) / stops.length) * 100}%`;
  const go1 = n => () => { introAt += n; introDraw(); };
  const tip = el("div", { class: `intro-tip${hit ? "" : " mid"}` },
    el("div", { class: "intro-n", text: `${introAt + 1}/${stops.length}` }), bar,
    el("h2", { id: "intro-h", text: s.t }),
    s.b ? el("p", { class: "intro-b", text: s.b }) : null,
    s.keys ? el("div", { class: "intro-keys" }, introKeys().map(([k, d]) => el("div", { class: "intro-key" }, el("kbd", { text: k }), el("span", { text: d })))) : null,
    el("div", { class: "intro-ft" },
      el("button", { class: "btn text intro-skip", type: "button", text: TX("misc.intro.skip"), onclick: introDone }),
      introAt ? el("button", { class: "btn tonal", type: "button", text: TX("misc.intro.prev"), onclick: go1(-1) }) : null,
      el("button", { class: "btn", type: "button", text: last ? TX("misc.intro.start") : TX("misc.intro.next"), onclick: last ? introDone : go1(1) })));
  const spot = el("div", { class: `intro-spot${hit ? "" : " none"}` });
  if (hit) Object.assign(spot.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
  introEl.replaceChildren(spot, tip);
  if (hit && matchMedia("(min-width: 1024px)").matches) {
    tip.style.left = `${r.right + 16}px`;
    tip.style.top = `${Math.max(16, Math.min(r.top - 8, innerHeight - tip.offsetHeight - 16))}px`;
  } else if (hit) tip.style.bottom = `${innerHeight - r.top + 8}px`;   // a phone: the tip sits above the tab bar
  motionIn(tip, "rise");
  tip.lastChild.lastChild.focus();
}
function introKey(ev) {
  const to = { ArrowRight: 1, ArrowLeft: -1 }[ev.key], next = introAt + (to ?? 0);
  if (ev.key === "Escape") introDone();
  else if (to) { if (next >= 0 && next < introStops().length) { introAt = next; introDraw(); } }
  else if (ev.key === "Tab") {
    const b = [...introEl.querySelectorAll("button")], at = b.indexOf(document.activeElement), n = b.length;
    b[(at + (ev.shiftKey ? n - 1 : 1)) % n].focus();
  } else if (!ev.metaKey && !ev.ctrlKey) return;   // Enter and Space press the focused button
  ev.preventDefault(); ev.stopPropagation();
}
function introOpen() {
  if (introEl) return;
  introAt = 0; introFrom = document.activeElement;
  introEl = el("div", { class: "intro", role: "dialog", "aria-modal": "true", "aria-labelledby": "intro-h" });
  document.body.append(introEl);
  document.addEventListener("keydown", introKey, true);
  addEventListener("resize", introDraw);
  introDraw();
}
function introDone() {
  document.removeEventListener("keydown", introKey, true);
  removeEventListener("resize", introDraw);
  introEl.remove(); introEl = null;
  try { sessionStorage.setItem(INTRO_SEEN, "1"); } catch { /* storage blocked: the gateway still remembers */ }
  api("/api/intro", "POST", { intro: "seen" }).catch(() => { /* the session flag already hides it here; the next visit asks the gateway again */ });
  go("home");
  if (introFrom?.isConnected) introFrom.focus();
}
function introStart() {
  try { if (sessionStorage.getItem(INTRO_SEEN)) return; } catch { /* storage blocked: ask */ }
  setTimeout(() => api("/api/intro").then(r => {
    if (r.intro === "pending") { if (!document.querySelector("dialog[open]")) introOpen(); return; }
    try { sessionStorage.setItem(INTRO_SEEN, "1"); } catch { /* ask again next time */ }
  }, () => {}), 1500);
}
