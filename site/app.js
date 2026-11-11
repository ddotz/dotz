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
