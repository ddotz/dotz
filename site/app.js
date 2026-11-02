const copyButton = document.querySelector("[data-copy]");
const copyLabel = copyButton ? copyButton.querySelector(".copy-label") : null;
const copyStatus = document.getElementById("copy-status");

if (copyButton && copyLabel && copyStatus) {
  let resetTimer;

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copyButton.dataset.copy);
    } catch {
      copyStatus.textContent = "복사하지 못했습니다. 명령을 직접 선택해 주세요.";
      return;
    }

    copyLabel.textContent = "복사됨";
    copyButton.dataset.copied = "true";
    copyStatus.textContent = "설치 명령을 복사했습니다.";

    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copyLabel.textContent = "복사";
      delete copyButton.dataset.copied;
    }, 2400);
  });
}
