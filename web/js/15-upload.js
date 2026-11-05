/* ---------- uploads: POST /api/upload with progress (fetch has none), and the composer's running uploads by conversation ---------- */
const UP_RING_MS = 700;   // an upload done sooner shows the plain chip all along: no ring that blinks past
let upLive = 0;   // requests under way, of every caller; a page closed now would lose them
const upGuard = ev => { ev.preventDefault(); ev.returnValue = ""; };
const upBytes = n => n >= 10485760 ? `${Math.round(n / 1048576)}MB` : fsize(n);
// The hub's own words (hub/files.ts), said before a byte goes. Empty until the first /api/state: the hub still refuses then.
const upTooBig = n => S && S.upload_max && n > S.upload_max ? `파일이 너무 커요 (${Math.ceil(n / 1048576)}MB, 최대 ${Math.round(S.upload_max / 1048576)}MB)` : "";
// One request: done gives the hub's record, or null when abort() ended it. The form holds the File as a handle: the browser reads the disk as it sends.
function uploadXhr(f, name, onProgress) {
  const x = new XMLHttpRequest(), form = new FormData();
  form.append("file", f, name);
  const done = new Promise((ok, no) => {
    const end = fn => v => { if (!--upLive) removeEventListener("beforeunload", upGuard); fn(v); };
    const fine = end(ok), bad = end(no);
    x.upload.onprogress = ev => { if (onProgress && ev.lengthComputable) onProgress(f.size * ev.loaded / ev.total); };
    x.onload = () => {
      pairGate(x.status, x.getResponseHeader("x-dotz-pair"));
      let d = {};
      try { d = JSON.parse(x.responseText); } catch { /* a proxy's error page: the status says it below */ }
      if (x.status >= 200 && x.status < 300 && d.files) fine(d.files[0]);
      else bad(new Error(d.error || `올리지 못했어요 (HTTP ${x.status})`));
    };
    x.onerror = () => bad(new Error("연결이 끊겼어요"));
    x.onabort = () => fine(null);
    if (!upLive++) addEventListener("beforeunload", upGuard);
    x.open("POST", "/api/upload");
    x.send(form);
  });
  return { done, abort: () => x.abort() };
}
// target -> { attachment id: job }: the uploads of the composer. The tray only paints from here, so a repaint or a move to another conversation
// and back finds the live numbers. A job's attachment waits in ATT or ts(t).att, whichever holds that conversation's files now.
const UPS = {};
const upJob = (t, id) => (UPS[t] || {})[id];
function upStart(t, a, ring = false) {
  const job = (UPS[t] = UPS[t] || {})[a.id] = { id: a.id, size: a.size, sent: 0, at: Date.now(), ring, error: "" };
  const up = uploadXhr(a.raw, a.name, sent => {
    job.sent = sent;
    if (!job.ring && Date.now() - job.at >= UP_RING_MS) { job.ring = true; if (t === target) renderAtt(); }
    else upPaint(t, job);
  });
  job.abort = up.abort;
  up.done.then(rec => {
    if (!rec) return;
    a.file = rec;
    delete UPS[t][a.id];
    atkStore(t, t === target ? ATT : ts(t).att || []);   // on the conversation it came from, wherever the owner is now: a reload finds it in the draft
    if (t === target) renderAtt();
  }, e => {
    job.error = e.message; job.ring = true; job.abort = null;
    if (t === target) renderAtt(); else toast(`${a.name}: ${e.message}`, true);
  });
}
function upCancel(t, id) {
  const job = upJob(t, id);
  if (!job) return;
  delete UPS[t][id];
  if (job.abort) job.abort();
}
const upPct = job => Math.min(100, Math.floor(job.sent / job.size * 100));
const upMeta = job => `${upBytes(job.sent)} / ${upBytes(job.size)}`;
// Between repaints a progress event touches its own ring and sub line only.
function upPaint(t, job) {
  const c = t === target && job.ring && $(`#atray [data-up="${job.id}"]`);
  if (!c) return;
  const r = c.querySelector(".pring"), pct = upPct(job);
  if (!r) return;
  r.style.setProperty("--p", pct); r.textContent = `${pct}%`; r.setAttribute("aria-valuenow", pct);
  c.querySelector(".fi-m").textContent = upMeta(job);
}
// The tray's chip of a long or failed upload, an image too: its square has no line for the sizes or the reason.
function upChip(a, job, x) {
  const c = fileChip(a.name, job.error || upMeta(job), { cls: job.error ? "fail" : "", x }), pct = upPct(job);
  c.dataset.up = job.id;
  c.querySelector(".fi-ic").replaceWith(job.error
    ? el("button", { class: "fi-ic up-retry", type: "button", title: "다시 올리기", "aria-label": `${a.name} 다시 올리기`, onpointerdown: ev => ev.preventDefault(), onclick: () => { upStart(target, a, true); renderAtt(); } }, icon("refresh"))
    : el("span", { class: "pring", role: "progressbar", "aria-label": `${a.name} 올리는 중`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), style: `--p:${pct}`, text: `${pct}%` }));
  return c;
}
