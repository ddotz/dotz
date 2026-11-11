const copyStatus = document.getElementById("copy-status");

document.querySelectorAll("[data-copy]").forEach((button) => {
  const copyLabel = button.querySelector(".copy-label");
  const command = button.closest(".cmd").querySelector("code").textContent;
  const { label, copied, fail, done } = button.dataset;
  let resetTimer;

  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      copyStatus.textContent = fail;
      return;
    }

    copyLabel.textContent = copied;
    button.dataset.state = "copied";
    copyStatus.textContent = done;

    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copyLabel.textContent = label;
      delete button.dataset.state;
    }, 2400);
  });
});

const langMenu = document.querySelector(".lang details");

if (langMenu) {
  document.addEventListener("click", (event) => {
    if (!langMenu.contains(event.target)) langMenu.open = false;
  });
  langMenu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    langMenu.open = false;
    langMenu.querySelector("summary").focus();
  });
}

const root = document.documentElement;

if (root.classList.contains("rv")) {
  // Tells the head script that scroll motion is in hand; without it the head script drops the hidden start state.
  root.dataset.rv = "1";

  const items = [...document.querySelectorAll("[data-r]")];
  const show = (el) => el.classList.add("in");
  const reveal = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      show(entry.target);
      reveal.unobserve(entry.target);
    }
  });
  items.forEach((el) => reveal.observe(el));

  const header = document.querySelector(".site-header");
  const line = document.querySelector(".scroll-line");
  const shot = document.querySelector(".shot");
  const wide = matchMedia("(min-width: 861px)");
  let queued = false;

  const paint = () => {
    queued = false;
    const y = scrollY;
    const max = root.scrollHeight - innerHeight;
    line.style.transform = "scaleX(" + (max > 0 ? Math.min(y / max, 1) : 0) + ")";
    header.classList.toggle("scrolled", y > 8);
    shot.style.setProperty("--py", wide.matches ? Math.min(y * 0.08, 48) : 0);
    // At the very bottom everything is shown, whatever the observer has or has not reported.
    if (y + innerHeight >= root.scrollHeight - 4) items.forEach(show);
  };

  addEventListener("scroll", () => {
    if (!queued) { queued = true; requestAnimationFrame(paint); }
  }, { passive: true });
  paint();
}
