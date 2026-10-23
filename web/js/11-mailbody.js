/* ---------- a mail's original: its HTML body in a sandboxed frame, else its text laid out ---------- */
// GET /api/mail/<key>/body is the HTML the hub kept and already reduced to a safe subset (hub/mailhtml.ts). It is drawn here in an iframe whose sandbox
// has no allow-scripts and no allow-same-origin, whose CSP is default-src 'none' (images only from data:, and from http(s) after 이미지 보기), and whose links
// open in a new tab with rel=noopener. A frame like that cannot be measured from outside, so a hidden twin of it (sandbox allow-same-origin, still no
// scripts) is loaded first, only to read the height; the visible frame gets that height. Heights and fetched bodies are cached per mail, so a redraw
// of the timeline does not fetch or measure again.
const MB = { cache: new Map(), max: 12, img: 20, imgBytes: 4_000_000 };
const MB_LINK = /^(?:https?:|mailto:|tel:)/i;
const MB_CSS = "html{color-scheme:light}body{margin:0;padding:14px 16px;background:#fff;color:#1b1f24;font:15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;overflow-wrap:anywhere;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}a{color:#1a5fd0}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a}pre{white-space:pre-wrap}";
const mbPut = (k, v) => { MB.cache.delete(k); MB.cache.set(k, v); while (MB.cache.size > MB.max) MB.cache.delete(MB.cache.keys().next().value); return v; };

async function mbDataUrl(src) {
  const r = await fetch(src, { cache: "force-cache" });
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
  await Promise.all(jobs);
  return { body: doc.body.innerHTML, held };
}
const mbDoc = (body, remote) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:${remote ? " https: http:" : ""}; style-src 'unsafe-inline'"><base target="_blank"><style>${MB_CSS}</style></head><body>${body}</body></html>`;
// The height of a document at a width, read from a hidden frame that is thrown away.
function mbMeasure(srcdoc, width) {
  return new Promise(res => {
    const f = el("iframe", { sandbox: "allow-same-origin", tabindex: "-1", "aria-hidden": "true", style: `position:fixed;left:-99999px;top:0;width:${width}px;height:10px;border:0;visibility:hidden` });
    const done = h => { clearTimeout(t); f.remove(); res(h); };
    const t = setTimeout(() => done(0), 8000);
    f.onload = () => { let h = 0; try { h = Math.ceil(f.contentDocument.documentElement.scrollHeight); } catch {} done(h); };
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
        const r = await fetch(`/api/mail/${enc(key)}/body`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        st.html = await r.text();
      }
      const pk = remote ? "r" : "n";
      let p = st.prep.get(pk);
      if (!p) { p = await mbPrepare(st.html, remote); st.prep.set(pk, p); }
      if (my !== seq) return;
      const doc = mbDoc(p.body, remote);
      bar.hidden = !(p.held || remote);
      note.textContent = remote ? "바깥 이미지를 보고 있어요" : `바깥 이미지 ${p.held}개를 막았어요`;
      tog.textContent = remote ? "이미지 숨기기" : "이미지 보기";
      if (st.h && st.w === w && st.doc === doc) frame.style.height = `${st.h}px`;
      if (frame.srcdoc !== doc) frame.srcdoc = doc;
      if (st.w !== w || st.doc !== doc || !st.h) {
        const h = await mbMeasure(doc, w);
        if (my !== seq) return;
        Object.assign(st, { h: h || st.h || 200, w, doc });
        frame.style.height = `${st.h}px`;
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

/* ---- the text fallback: paragraphs, links, quotes and pipe tables ---- */
const MB_URL = /\bhttps?:\/\/[^\s<>"']+/g;
function mbInline(parent, line) {
  let last = 0;
  for (const m of line.matchAll(MB_URL)) {
    const url = m[0].replace(/[.,;:!?)\]}]+$/, "");
    parent.append(line.slice(last, m.index), el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: url }));
    last = m.index + url.length;
  }
  parent.append(line.slice(last));
}
const mbIsRow = l => /\s\|\s/.test(l) || /^\s*\|.*\|\s*$/.test(l);
function mailTextNode(raw) {
  const out = el("div", { class: "mb-txt" });
  const lines = String(raw ?? "").replace(/\r/g, "").split("\n");
  let para = [], quote = [], rows = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = el("p");
    para.forEach((l, i) => { if (i) p.append(el("br")); mbInline(p, l); });
    out.append(p); para = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const q = el("blockquote");
    quote.forEach((l, i) => { if (i) q.append(el("br")); mbInline(q, l); });
    out.append(q); quote = [];
  };
  const flushRows = () => {
    if (rows.length >= 2) out.append(mdNode(rcRawMd(rows.join("\n"))));
    else para.push(...rows);
    rows = [];
  };
  for (const l of lines) {
    const t = l.trimEnd();
    if (mbIsRow(t)) { flushPara(); flushQuote(); rows.push(t); continue; }
    flushRows();
    if (/^\s*>/.test(t)) { flushPara(); quote.push(t.replace(/^(\s*>)+\s?/, "")); continue; }
    flushQuote();
    if (!t.trim()) flushPara(); else para.push(t);
  }
  flushRows(); flushPara(); flushQuote();
  return out;
}
// The original of one mail: the HTML frame when the hub kept an HTML body, else the text.
const mailBodyNode = (key, html, raw) => html ? mailHtmlNode(key) : mailTextNode(raw);
