// Phone composer vs. keyboard: publish the visual viewport as CSS vars (--vvh = its height, --kb = the keyboard's inset) so the composer
// stays inside it. Updates only on visualViewport resize/scroll, at most one per animation frame; nothing is positioned from script.
(() => {
  const root = document.documentElement, vv = window.visualViewport;
  if (!vv) return;
  // The keyboard inset is measured against 100dvh, the height .app itself uses (12-composer-phone.css), not window.innerHeight: the two can
  // differ for a frame while the keyboard moves, and a gap counted on top of a page that already shrank would resize the composer twice.
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:100dvh;visibility:hidden;pointer-events:none";
  document.documentElement.append(probe);
  let raf = 0, lastH = -1, lastKb = -1;
  const apply = () => {
    raf = 0;
    const h = Math.round(vv.height), kb = vv.scale > 1.01 ? 0 : Math.max(0, Math.round(probe.offsetHeight - vv.height));
    if (h !== lastH) { lastH = h; root.style.setProperty("--vvh", h + "px"); }
    if (kb !== lastKb) { lastKb = kb; root.style.setProperty("--kb", kb + "px"); }
  };
  const queue = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener("resize", queue);
  vv.addEventListener("scroll", queue);
  apply();
})();
