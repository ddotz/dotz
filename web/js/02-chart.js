/* ---------- in-message charts: a ```chart fence (hub/chart.ts draws it) ---------- */
// SPEC_HTML.Chart leaves an empty figure holding the spec; when it reaches the page the gateway draws it in both themes and the figure shows the one the app
// uses (css: .ans-chart). Each drawing is its own <img>, so two charts never share SVG ids. A spec the gateway refuses becomes the JSON as code with its note.
const chartDrawn = new Map();
// Drawn at the width the figure has (40 px steps; 0 while hidden, which the gateway draws at full size) so its text stays readable on a phone.
function chartDraw(spec, width) {
  const k = `${Math.round(width / 40)}:${spec}`;
  let p = chartDrawn.get(k);
  if (!p) {
    p = fetch("/api/chart", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec, width: width || undefined }) })
      .then(r => r.json())
      // a failed request is not kept: the next time the message is drawn it asks again
      .catch(() => (chartDrawn.delete(k), { ok: false, note: "차트를 불러오지 못했어요" }));
    chartDrawn.set(k, p);
  }
  return p;
}
const chartImg = (svg, theme, label) => `<img class="ans-chart-${theme}" alt="${esc(label)}" src="${URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))}">`;
async function chartFill(fig) {
  fig.dataset.drawing = "1";
  const spec = fig.dataset.chart, label = fig.getAttribute("aria-label") || "차트", r = await chartDraw(spec, fig.clientWidth);
  if (!fig.isConnected) return;
  if (r && r.ok) {
    fig.innerHTML = chartImg(r.light, "light", label) + chartImg(r.dark, "dark", label);
    // the image keeps its decoded picture, so the blob is freed once it has loaded
    for (const img of fig.querySelectorAll("img")) img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
  } else fig.outerHTML = `${codeBlockHtml("json", spec)}<p class="meta">${esc((r && r.note) || "차트를 그리지 못했어요")}</p>`;
}
function chartsIn(node) {
  if (node.nodeType !== 1) return;
  const figs = node.matches(".ans-chart[data-chart]") ? [node] : node.querySelectorAll(".ans-chart[data-chart]:not([data-drawing])");
  for (const f of figs) if (!f.dataset.drawing) chartFill(f);
}
if (typeof document !== "undefined" && document.body && typeof MutationObserver !== "undefined") {
  new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) chartsIn(n); }).observe(document.body, { childList: true, subtree: true });
}
