/* ---------- 분할 창: keys (docs/split-panes.md 단축키) ----------
   ⌥⌘ on a Mac, Ctrl+Alt elsewhere (ev.code, because Option changes ev.key): \ splits right, 1 and 2 go to a pane, W closes the active one (two panes, side by side: owner 950d715f).
   Only on the chat tab (owner 8f7c8c3d). ⌘\ (sidebar), ⌘1..6 (tabs) and ⌘K never get here: they have no Alt.
   Ctrl+Shift+\ also splits right on every system: AltGr arrives as Ctrl+Alt on Windows, so Ctrl+Alt+\ can collide with typing \ there. */
const PANE_KEY_SIDE = { Backslash: "right" };
// The rows the screen tour lists (42-intro.js introKeys); none below 1100px, where nothing splits.
const paneTourKeys = () => {
  if (narrowChat()) return [];
  const m = isMac ? "⌥⌘" : "Ctrl+Alt+";
  return [[isMac ? "⌥⌘\\" : "Ctrl+Shift+\\", TX("misc.pk.split")], [`${m}1 · ${m}2`, TX("misc.pk.move")], [`${m}W`, TX("misc.pk.close")]];
};

// A split from the keyboard opens the main chat, or when that is open 작업내역, or the first running session that is not open yet.
function paneKeySplit(side) {
  if (paneCount() >= PANE_MAX) { toast(TX("misc.pk.max"), true); return; }
  // the drag's rule: no split that leaves a pane under 280px (43-panes-drag.js paneSplitFits)
  const box = paneDragBoxes()[0];
  if (box && !paneSplitFits(box.r)) { toast(TX("misc.pk.narrow"), true); return; }
  const here = paneHere(), shown = t => (paneCount() > 1 ? !!paneOpenIn("chat", t) : here.kind === "chat" && here.t === t);
  const { wait, run } = sessionsNow();
  const t = [MAIN, "worklog", ...[...wait, ...run].map(l => `lane:${l.name}`)].find(x => !shown(x));
  if (!t) { toast(TX("misc.pk.none"), true); return; }
  paneSplit(t, "chat", side);
}
document.addEventListener("keydown", ev => {
  const mod = isMac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
  const shiftSplit = ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey && ev.code === "Backslash";
  if (ev.isComposing || (!shiftSplit && (!ev.altKey || ev.shiftKey || !mod)) || narrowChat() || document.querySelector("dialog[open]:not([data-leaving])")) return;
  const side = shiftSplit ? "right" : PANE_KEY_SIDE[ev.code], n = /^Digit([12])$/.exec(ev.code || "")?.[1];
  if ((!side && !n && ev.code !== "KeyW") || !paneTabOk()) return;
  ev.preventDefault();
  if (side) paneKeySplit(side);
  else if (n) { const p = paneList()[n - 1]; if (p) paneFocus(p.id); }
  else if (paneCount() > 1) paneClose(PN.active);
});
