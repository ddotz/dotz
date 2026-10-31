/* ---------- a mail's original: its HTML body in a sandboxed frame, else its text laid out ---------- */
// GET /api/mail/<key>/body is the HTML the hub kept and already reduced to a safe subset (hub/mailhtml.ts). It is drawn here in an iframe whose sandbox
// has no allow-scripts and no allow-same-origin, whose CSP is default-src 'none' (images only from data:, and from http(s) after 이미지 보기), and whose links
// open in a new tab with rel=noopener. A frame like that cannot be measured from outside, so a hidden twin of it (sandbox allow-same-origin, still no
// scripts) is loaded first, only to read the height; the visible frame gets that height. Heights and fetched bodies are cached per mail, so a redraw
// of the timeline does not fetch or measure again.
const MB = { cache: new Map(), max: 12, img: 20, imgBytes: 4_000_000 };
const MB_LINK = /^(?:https?:|mailto:|tel:)/i;
// No scrollbar of its own at all (owner 2026-10-27: the original shows whole): the frame is always exactly as tall as this document (mbMeasure),
// so the page's one scroll moves it, and a table wider than the frame is scaled down to the frame's width (mbFitCss) instead of scrolling sideways.
const MB_CSS = "html{color-scheme:light;overflow:hidden}body{margin:0;padding:14px 16px;background:#fff;color:#1b1f24;font:15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;overflow-wrap:anywhere;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}.mb-wide{max-width:100%;overflow:hidden}a{color:#1a5fd0}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a}pre{white-space:pre-wrap}";
const mbPut = (k, v) => { MB.cache.delete(k); MB.cache.set(k, v); while (MB.cache.size > MB.max) MB.cache.delete(MB.cache.keys().next().value); return v; };

async function mbDataUrl(src) {
  const r = await fetch(pqLink(src), { cache: "force-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.blob();
  if (b.size > MB.imgBytes || !/^image\//.test(b.type)) throw new Error("not an image");
  return await new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(String(f.result)); f.onerror = () => rej(f.error); f.readAsDataURL(b); });
}
// The stored HTML as the frame's body text: a second sanitizing pass (scripts, frames, handlers, odd links), the hub's own inline images turned into data: URLs
// (the frame has no login of its own), and the remote ones either kept back (remote false) or switched on. Returns { body, held: how many are kept back }.
async function mbPrepare(html, remote) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const n of doc.querySelectorAll("script,style,iframe,frame,object,embed,form,link,meta,base,svg,math,video,audio,noscript,template")) n.remove();
  let held = 0, inlined = 0;
  const jobs = [];
  for (const n of doc.body.querySelectorAll("*")) {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
    if (n.localName === "a") {
      const h = n.getAttribute("href") || "";
      if (MB_LINK.test(h.trim())) { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); } else n.removeAttribute("href");
    } else if (n.localName === "img") {
      const s = n.getAttribute("src") || "", rs = n.getAttribute("data-rsrc") || "";
      if (s.startsWith("/api/mail/")) {
        n.removeAttribute("src");
        if (inlined++ < MB.img) jobs.push(mbDataUrl(s).then(u => n.setAttribute("src", u), () => {}));
      } else if (s && !/^data:image\//i.test(s)) n.removeAttribute("src");
      if (rs) { if (remote && MB_LINK.test(rs)) n.setAttribute("src", rs); else held++; }
      n.removeAttribute("srcset");
    }
  }
  // Every top-level table sits in its own box, numbered: one wider than the frame is scaled to fit it once measured (mbMeasure, mbFitCss).
  let wi = 0;
  for (const t of doc.body.querySelectorAll("table")) {
    if (t.parentElement && t.parentElement.closest("table")) continue;
    const w = doc.createElement("div");
    w.className = "mb-wide";
    w.dataset.wi = String(wi++);
    t.replaceWith(w);
    w.append(t);
  }
  await Promise.all(jobs);
  return { body: doc.body.innerHTML, held };
}
const mbDoc = (body, remote, fit = "") => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:${remote ? " https: http:" : ""}; style-src 'unsafe-inline'"><base target="_blank"><style>${MB_CSS}${fit}</style></head><body>${body}</body></html>`;
// The scale of each table box that is wider than the frame, as CSS: the table keeps its full width and is scaled down to exactly the box's
// width, and the box takes the scaled height (a transform does not change layout), so it shows whole with nothing to scroll.
const mbFitCss = fits => fits.map(f => `.mb-wide[data-wi="${f.i}"]{height:${Math.ceil(f.h * f.z)}px}.mb-wide[data-wi="${f.i}"]>table{width:${f.w}px;max-width:none;transform:scale(${f.z.toFixed(4)});transform-origin:0 0}`).join("");
// The height of a document at a width, read from a hidden frame that is thrown away. The frame's load event already waits for its images, but
// a late font or a decoded image can still change the layout by a pixel: measure once more on the next frames. The visible frame itself is
// sandboxed without allow-same-origin, so it cannot be observed from here; measuring the same document offscreen is the only way.
function mbMeasure(srcdoc, width) {
  return new Promise(res => {
    const f = el("iframe", { sandbox: "allow-same-origin", tabindex: "-1", "aria-hidden": "true", style: `position:fixed;left:-99999px;top:0;width:${width}px;height:10px;border:0;visibility:hidden` });
    let settled = false;
    let fits = () => [];
    // a remote picture that finished and has no size did not load (an address only an intranet or a signed-in browser can open)
    const broken = () => { try { return [...f.contentDocument.images].filter(i => /^https?:/i.test(i.getAttribute("src") || "") && i.complete && !i.naturalWidth).length; } catch { return 0; } };
    const done = h => { const fit = fits(), bad = broken(); settled = true; clearTimeout(t); f.remove(); res({ h, fits: fit, broken: bad }); };
    const t = setTimeout(() => { if (!settled) done(0); }, 8000);
    const read = () => {
      try {
        const d = f.contentDocument, b = d && d.body;
        if (!d || !b) return 0;
        // the tallest of what the document says: an image still loading adds no height until it has one, so scrollHeight is enough once loaded
        return Math.ceil(Math.max(d.documentElement.scrollHeight, b.scrollHeight, b.getBoundingClientRect().height));
      } catch { return 0; }
    };
    // Table boxes whose table is wider than the box: the zoom that makes it fit.
    fits = () => {
      try {
        return [...f.contentDocument.querySelectorAll(".mb-wide")].flatMap(w => {
          const t = w.firstElementChild, have = w.clientWidth, need = t ? Math.ceil(Math.max(w.scrollWidth, t.scrollWidth, t.getBoundingClientRect().width)) : 0;
          if (!(need > have + 1 && have > 0)) return [];
          // its height when laid out at its full width, which is what gets scaled
          t.style.maxWidth = "none"; t.style.width = `${need}px`;
          return [{ i: w.dataset.wi, z: have / need, w: need, h: t.offsetHeight }];
        });
      } catch { return []; }
    };
    f.onload = () => {
      let frames = 0, stable = 0, last = -1;
      const settle = () => {
        if (settled) return;
        frames++;
        const d = (() => { try { return f.contentDocument; } catch { return null; } })();
        const busy = !d || [...d.images].some(i => !i.complete);
        const h = read();
        // the same height on three quiet frames (images done, fonts settled): that is the document's height
        if (!busy && h > 0) {
          if (h === last) stable++; else { stable = 0; last = h; }
          if (stable >= 2) { settled = true; done(h); return; }
        }
        if (frames > 120) { settled = true; done(h || last || 0); return; }
        requestAnimationFrame(settle);
      };
      settle();
    };
    f.srcdoc = srcdoc;
    document.body.append(f);
  });
}

function mailHtmlNode(key) {
  const st = MB.cache.get(key) || mbPut(key, { html: null, remote: false, prep: new Map(), h: 0, w: 0 });
  const bar = el("div", { class: "mb-bar", hidden: true }), note = el("span", { class: "mb-note" }), tog = el("button", { class: "btn text", type: "button" });
  bar.append(note, tog);
  const frame = el("iframe", { class: "mb-frame", sandbox: "allow-popups allow-popups-to-escape-sandbox", title: "메일 원문", referrerpolicy: "no-referrer" });
  const host = el("div", { class: "mb" }, bar, frame);
  let seq = 0, shownW = 0;
  const show = async () => {
    const my = ++seq, w = Math.floor(host.clientWidth), remote = st.remote;
    if (!w) return;
    try {
      if (st.html === null) {
        const r = await fetch(pqLink(`/api/mail/${enc(key)}/body`), { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        st.html = await r.text();
      }
      const pk = remote ? "r" : "n";
      let p = st.prep.get(pk);
      if (!p) { p = await mbPrepare(st.html, remote); st.prep.set(pk, p); }
      if (my !== seq) return;
      const base = mbDoc(p.body, remote);
      bar.hidden = !(p.held || remote);
      const paint = () => { note.textContent = !remote ? `바깥 이미지 ${p.held}개를 막았어요` : st.broken ? `바깥 이미지 ${st.broken}개는 이 기기에서 열리지 않아요` : "바깥 이미지를 보고 있어요"; };
      paint();
      tog.textContent = remote ? "이미지 숨기기" : "이미지 보기";
      const known = st.h && st.w === w && st.base === base;
      if (known) frame.style.height = `${st.h}px`;
      const first = known ? st.doc : base;
      if (frame.srcdoc !== first) frame.srcdoc = first;
      if (!known) {
        // Measured at this width; a table wider than the frame is then scaled to fit and the scaled document measured again.
        let m = await mbMeasure(base, w), doc = base;
        if (my !== seq) return;
        if (m.fits.length) {
          doc = mbDoc(p.body, remote, mbFitCss(m.fits));
          m = await mbMeasure(doc, w);
          if (my !== seq) return;
        }
        // a pixel of slack so a rounded-up line never turns into the frame's own scrollbar
        Object.assign(st, { h: m.h ? m.h + 1 : st.h || 200, w, base, doc, broken: remote ? m.broken | 0 : 0 });
        if (frame.srcdoc !== doc) frame.srcdoc = doc;
        frame.style.height = `${st.h}px`;
        paint();
      }
      shownW = w;
    } catch {
      if (my === seq) { clear(host); host.append(el("div", { class: "mb-fail", text: "원문을 불러오지 못했어요" })); }
    }
  };
  tog.onclick = () => { st.remote = !st.remote; st.h = 0; show(); };
  let raf = 0;
  new ResizeObserver(() => { const w = Math.floor(host.clientWidth); if (w && w !== shownW && !raf) raf = requestAnimationFrame(() => { raf = 0; show(); }); }).observe(host);
  return host;
}

// The original of one mail: the HTML frame when the hub kept an HTML body, else the text.
const mailBodyNode = (key, html, raw) => html ? mailHtmlNode(key) : mailTextNode(raw);
