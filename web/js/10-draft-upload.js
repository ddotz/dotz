const DRU = { open: {} };
const drfSize = n => mailSize(n) || "0B";
const drfKept = n => String(n).replace(/\\/g, "/").split("/").pop().normalize("NFC").replace(/[\u0000-\u001f\u007f]+/g, "_").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
const drfNamed = (name, at) => { const kept = drfKept(name), dot = kept.lastIndexOf("."), stem = dot > 0 ? kept.slice(0, dot) : kept, ext = dot > 0 ? kept.slice(dot) : ""; return at === kept || (at.startsWith(`${stem} (`) && at.endsWith(`)${ext}`) && /^\d+$/.test(at.slice(stem.length + 2, at.length - ext.length - 1))); };
function drfLanded(was, now, f) {
  const left = was.map(x => `${x.name}\n${x.size}`);
  return now.some(x => { const k = left.indexOf(`${x.name}\n${x.size}`); if (k >= 0) { left.splice(k, 1); return false; } return x.size === drfSize(f.size) && drfNamed(f.name, x.name); });
}
async function drfUpload(ref, f) {
  const pending = DRU.open[ref] && DRU.open[ref].f === f ? DRU.open[ref] : null;
  if (pending) {
    drfStale(ref);
    await drfLoad(ref);
    const st = DRF.st[ref];
    if (!st || st.failed) throw new TypeError(TX("chat.upload.lost"));
    if (drfLanded(pending.was, st.files, f)) { delete DRU.open[ref]; return; }
  } else {
    if (!DRF.st[ref]) await drfLoad(ref);
    DRU.open[ref] = { f, was: ((DRF.st[ref] || drfNone).files || []).map(x => ({ name: x.name, size: x.size })) };
  }
  if (DRF.pc[ref]) {
    if (f.size > DRF_WIRE_MAX) throw new Error(TX("decision.file.peer_max"));
    await drfWrite(ref, { name: f.name, data: await drfBase64(f) });
  } else await drfWrite(ref, { upload: await uploadFile(f) });
  delete DRU.open[ref];
}
