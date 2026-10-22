// Phone composer vs. keyboard: publish the visual viewport as CSS vars (--vvh = its height, --kb = the keyboard's inset) so the composer
// stays inside it. Updates only on visualViewport resize/scroll, at most one per animation frame; nothing is positioned from script.
(() => {
  const root = document.documentElement, vv = window.visualViewport;
  if (!vv) return;
  let raf = 0, lastH = -1, lastKb = -1;
  const apply = () => {
    raf = 0;
    const h = Math.round(vv.height), kb = vv.scale > 1.01 ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height));
    if (h !== lastH) { lastH = h; root.style.setProperty("--vvh", h + "px"); }
    if (kb !== lastKb) { lastKb = kb; root.style.setProperty("--kb", kb + "px"); }
  };
  const queue = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener("resize", queue);
  vv.addEventListener("scroll", queue);
  apply();
})();
