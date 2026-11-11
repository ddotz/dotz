// Phone composer vs. keyboard: publish the visual viewport as CSS vars (--vvh = its height, --kb = the keyboard's inset) so the composer
// stays inside it. Updates only on visualViewport resize/scroll, at most one per animation frame; nothing is positioned from script.
(() => {
  const root = document.documentElement, vv = window.visualViewport;
  if (!vv) return;
  // The keyboard inset is measured against 100dvh, the height .app itself uses (12-composer-phone.css), not window.innerHeight: the two can
  // differ for a frame while the keyboard moves, and a gap counted on top of a page that already shrank would resize the composer twice.
  // Only what lies below the visual viewport's bottom edge counts: iOS Safari pans the viewport down instead of shrinking the page, and a pan
  // already shows the composer, so the offsetTop is not covered by the keyboard.
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:100dvh;visibility:hidden;pointer-events:none";
  document.documentElement.append(probe);
  // <html data-kb> says the keyboard is up, and the tab bar steps aside by it (01-tokens.css) in the same frame as --kb and --vvh, not at
  // the focus before the keyboard: there the docked card dropped by the bar's height first and rose with the keyboard after. Up means the
  // unzoomed visible height is well under the tallest seen at this page width (Android shrinks 100dvh with the keyboard, so --kb stays 0).
  let raf = 0, lastH = -1, lastKb = -1, lastUp = false, tall = 0, tallW = 0;
  const apply = () => {
    raf = 0;
    const h = Math.round(vv.height), kb = vv.scale > 1.01 ? 0 : Math.max(0, Math.round(probe.offsetHeight - (vv.offsetTop + vv.height)));
    const w = root.clientWidth, seen = vv.height * vv.scale;
    if (w !== tallW) { tallW = w; tall = 0; }
    tall = Math.max(tall, seen);
    const up = tall - seen > 150;
    if (h !== lastH) { lastH = h; root.style.setProperty("--vvh", h + "px"); }
    if (kb !== lastKb) { lastKb = kb; root.style.setProperty("--kb", kb + "px"); }
    if (up !== lastUp) { lastUp = up; root.toggleAttribute("data-kb", up); }
  };
  const queue = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener("resize", queue);
  vv.addEventListener("scroll", queue);
  apply();
})();
