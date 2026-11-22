/* ---------- uploads: POST /api/upload with progress (fetch has none), and the composer's running uploads by conversation ---------- */
const UP_RING_MS = 700;   // an upload done sooner shows the plain chip all along: no ring that blinks past
const UP_STALL_MS = 30000;
let upLive = 0;   // requests under way, of every caller; a page closed now would lose them
const upRun = new Set(), upCut = new Set();
const upGuard = ev => { ev.preventDefault(); ev.returnValue = ""; };
const upBytes = n => n >= 10485760 ? `${Math.round(n / 1048576)}MB` : fsize(n);
// The hub's own words (hub/files.ts), said before a byte goes. Empty until the first /api/state: the hub still refuses then.
const upTooBig = n => S && S.upload_max && n > S.upload_max ? TX("chat.upload.too_big", { size: Math.ceil(n / 1048576), max: Math.round(S.upload_max / 1048576) }) : "";
// One request: done gives the hub's record, or null when abort() ended it. The form holds the File as a handle: the browser reads the disk as it sends.
function uploadXhr(f, name, onProgress) {
  const x = new XMLHttpRequest(), form = new FormData();
  form.append("file", f, name);
  let stalled = false, idle = 0;
  const rec = { name, hid: document.visibilityState === "hidden", last: Date.now(), retry: null, stall: () => { stalled = true; x.abort(); } };
  const watch = () => { rec.last = Date.now(); clearTimeout(idle); idle = setTimeout(rec.stall, UP_STALL_MS); };
  const done = new Promise((ok, no) => {
    const end = fn => v => { clearTimeout(idle); upRun.delete(rec); if (!--upLive) removeEventListener("beforeunload", upGuard); fn(v); };
    const fine = end(ok), bad = end(no);
    const lost = () => { if (rec.hid) { upCut.add(rec); upNoteSoon(); } bad(new Error(TX("chat.upload.lost"))); };
    x.upload.onprogress = ev => { rec.hid = false; watch(); if (onProgress && ev.lengthComputable) onProgress(f.size * ev.loaded / ev.total); };
    x.onload = () => {
      pairGate(x.status, x.getResponseHeader("x-dotz-pair"));
      let d = {};
      try { d = JSON.parse(x.responseText); } catch { /* a proxy's error page: the status says it below */ }
      if (x.status >= 200 && x.status < 300 && d.files) fine(d.files[0]);
      else bad(new Error(d.error || TX("chat.upload.failed", { status: x.status })));
    };
    x.onerror = lost;
    x.onabort = () => (stalled ? lost() : fine(null));
    if (!upLive++) addEventListener("beforeunload", upGuard);
    upRun.add(rec);
    x.open("POST", "/api/upload");
    x.send(form);
    watch();
  });
  return { done, abort: () => x.abort(), rec };
}
const UP_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "image/avif": "avif", "application/pdf": "pdf", "video/mp4": "mp4", "video/quicktime": "mov" };
const upSniff = async f => {
  const b = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  const at = (s, o = 0) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (at("\x89PNG")) return "image/png";
  if (at("GIF8")) return "image/gif";
  if (at("RIFF") && at("WEBP", 8)) return "image/webp";
  return at("%PDF") ? "application/pdf" : "";
};
async function upNamed(f) {
  if (/\.[A-Za-z0-9]{1,6}$/.test(f.name || "")) return f;
  let type = f.type;
  if (!UP_EXT[type] && (!type || type === "application/octet-stream")) type = await upSniff(f);
  const ext = UP_EXT[type];
  return ext ? new File([f], `${f.name || TX("chat.att.pasted").replace(/\.[^.]*$/, "")}.${ext}`, { type, lastModified: f.lastModified }) : f;
}
async function uploadFile(f) {
  if (upTooBig(f.size)) throw new Error(upTooBig(f.size));
  return uploadXhr(f, f.name).done;
}
function upNote() {
  const cut = [...upCut];
  upCut.clear();
  if (!cut.length) return;
  const retry = cut.filter(r => r.retry);
  toast(cut.length === 1 ? TX("chat.upload.cut_one", { name: cut[0].name }) : TX("chat.upload.cut_many", { n: cut.length }), true,
    retry.length ? { label: TX("chat.upload.cut_retry"), onclick: () => retry.forEach(r => r.retry()) } : undefined, 12000);
}
const upNoteSoon = () => { if (document.visibilityState === "visible") setTimeout(upNote, 400); };
const upHidden = () => { for (const r of upRun) r.hid = true; };
function upBack() {
  for (const r of upRun) if (r.hid && Date.now() - r.last > UP_STALL_MS) r.stall();
  upNoteSoon();
}
document.addEventListener("visibilitychange", () => (document.visibilityState === "hidden" ? upHidden() : upBack()));
addEventListener("pagehide", upHidden);
addEventListener("pageshow", upBack);
const drfBase64 = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = () => no(r.error); r.readAsDataURL(f); });
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
  up.rec.retry = () => { if (upJob(t, a.id) === job && job.error) { upStart(t, a, true); if (t === target) renderAtt(); } };
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
    ? el("button", { class: "fi-ic up-retry", type: "button", title: TX("chat.upload.retry"), "aria-label": TX("chat.upload.retry_aria", { name: a.name }), onpointerdown: ev => ev.preventDefault(), onclick: () => { upStart(target, a, true); renderAtt(); } }, icon("refresh"))
    : el("span", { class: "pring", role: "progressbar", "aria-label": TX("chat.upload.progress", { name: a.name }), "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), style: `--p:${pct}`, text: `${pct}%` }));
  return c;
}
