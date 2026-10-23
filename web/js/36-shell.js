/* ---------- web terminal (셸): the shell of the computer this page is served from ---------- */
// A real terminal emulator (xterm.js, web/vendor): the owner types in the terminal itself and every keystroke goes straight to
// the PTY. Output: GET /api/pty/stream (SSE). Input: POST /api/pty/input (in order, batched while a request is in flight).
// Size: POST /api/pty/resize whenever the box changes. Each computer serves its own page, so "the computer whose chat this is"
// is simply the origin; there is no host to pick. Nothing typed here is stored; a password goes by the 암호 box, which is
// cleared before its request leaves.
ICONS.shell = "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 10l3 2-3 2M12 15h5";

// A password prompt: the last line of output ends in a colon and names a password, passphrase or 암호.
const SH_PW_RE = /(?:password|passphrase|암호|비밀번호|패스워드)[^\n]{0,60}[:：]\s*$/i;
const isPasswordPrompt = line => { const t = String(line ?? "").replace(/\s+$/, ""); return t.length > 0 && t.length <= 160 && SH_PW_RE.test(t); };

/* ---------- ui ---------- */
// The slim key row for a touch screen, which has no Ctrl, Esc, Tab or arrow keys. Ctrl is sticky: it turns the next letter into its control code.
const SH_KEYS = [["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl", "ctrl"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["^C", "\x03"], ["^D", "\x04"]];
const SH = { dlg: null, term: null, fit: null, ro: null, ctl: null, alive: false, ctrl: false, pend: "", sendBuf: "", sending: false, pwRaf: 0, ui: null };
const shTouch = () => !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);

let shLibP = null;
// xterm.js loads when the terminal first opens, not with the app.
function shLib() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  const add = (tag, attrs) => new Promise((res, rej) => { const n = el(tag, { ...attrs, onload: res, onerror: () => rej(new Error("터미널 구성요소를 불러오지 못했어요")) }); document.head.append(n); });
  return (shLibP ||= (async () => {
    if (!document.querySelector("link[data-sh]")) document.head.append(el("link", { rel: "stylesheet", href: "/vendor/xterm.css", "data-sh": "1" }));
    await add("script", { src: "/vendor/xterm.js" });
    await add("script", { src: "/vendor/addon-fit.js" });
  })().catch(e => { shLibP = null; throw e; }));
}
const shCss = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function shTheme() {
  return { background: shCss("--tb") || "#101012", foreground: shCss("--tf") || "#e6e6ea", cursor: shCss("--tac") || "#a9a9ff", cursorAccent: shCss("--tb") || "#101012", selectionBackground: "rgba(169,169,255,.35)",
    black: "#2b2b30", red: "#ff7b7b", green: "#4ade80", yellow: "#f5c451", blue: "#7aa2ff", magenta: "#d7a3ff", cyan: "#5ed3e0", white: "#d4d4da",
    brightBlack: "#6b6b75", brightRed: "#ff9d9d", brightGreen: "#7ef0a3", brightYellow: "#ffd97a", brightBlue: "#a3bdff", brightMagenta: "#e6c2ff", brightCyan: "#8fe6ef", brightWhite: "#ffffff" };
}

function shShowPw(on) {
  const u = SH.ui;
  if (!u) return;
  u.pw.hidden = !on;
  if (!on) { u.pwIn.value = ""; if (SH.term) SH.term.focus(); } else u.pwIn.focus({ preventScroll: true });
}
function shStatus(text, tone) {
  const u = SH.ui;
  if (!u) return;
  u.st.textContent = text;
  u.st.dataset.tone = tone || "";
}
// The prompt line under the cursor: a password prompt lights the 암호 button (the box itself is the owner's to open).
function shWatchPw() {
  SH.pwRaf = 0;
  const t = SH.term, u = SH.ui;
  if (!t || !u) return;
  const b = t.buffer.active, line = b.getLine(b.baseY + b.cursorY);
  u.pwBtn.classList.toggle("hot", !!(SH.alive && line && isPasswordPrompt(line.translateToString(true))));
}
const shSchedulePw = () => { if (!SH.pwRaf) SH.pwRaf = requestAnimationFrame(shWatchPw); };
function shNote(text) { if (SH.term) SH.term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`); }
function shFrame(raw) {
  let ev = "", data = "";
  for (const l of raw.split("\n")) { if (l.startsWith("event:")) ev = l.slice(6).trim(); else if (l.startsWith("data:")) data += l.slice(5).trim(); }
  if (!ev || !data || !SH.term) return;
  let d;
  try { d = JSON.parse(data); } catch { return; }
  if (ev === "reset") {
    SH.term.reset(); SH.term.write(d.data || "", shSchedulePw);
    SH.alive = d.alive !== false;
    shStatus(SH.alive ? "연결됨" : "셸이 꺼져 있어요", SH.alive ? "ok" : "err");
    if (!SH.alive) shNote("셸이 꺼져 있어요. Enter를 누르면 다시 시작해요.");
    else if (SH.pend) { const c = SH.pend; SH.pend = ""; shSend(c); }
  } else if (ev === "out") SH.term.write(d.data || "", shSchedulePw);
  else if (ev === "exit") { SH.alive = false; shShowPw(false); shStatus("셸이 끝났어요", "err"); shNote("셸이 끝났어요. Enter를 누르면 다시 시작해요."); }
}
async function shConnect() {
  shDisconnect();
  const t = SH.term;
  if (!t) return;
  const ctl = new AbortController();
  SH.ctl = ctl;
  shStatus("연결 중…");
  try {
    const r = await fetch(`/api/pty/stream?cols=${t.cols}&rows=${t.rows}`, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rd = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) { shFrame(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if (SH.ctl === ctl) { SH.alive = false; shStatus("연결이 끊겼어요", "err"); shNote("연결이 끊겼어요. Enter를 누르면 다시 연결해요."); }
  } catch (e) {
    if (SH.ctl === ctl && e.name !== "AbortError") { SH.alive = false; shStatus("연결하지 못했어요", "err"); shNote("연결하지 못했어요. Enter를 누르면 다시 연결해요."); }
  }
}
function shDisconnect() { if (SH.ctl) { SH.ctl.abort(); SH.ctl = null; } }

// Keystrokes leave in order: while one request is in flight the next ones wait and go out together.
const SH_CHUNK = 16000;
async function shPost(data, secret) {
  try { await api("/api/pty/input", "POST", secret ? { data, secret: true } : { data }); return true; }
  catch (e) { toast(e.message, true); return false; }
}
async function shSend(data) {
  SH.sendBuf += data;
  if (SH.sending) return;
  SH.sending = true;
  try {
    while (SH.sendBuf) { const part = SH.sendBuf.slice(0, SH_CHUNK); SH.sendBuf = SH.sendBuf.slice(part.length); if (!(await shPost(part))) SH.sendBuf = ""; }
  } finally { SH.sending = false; }
}
async function shRestart() {
  try { await api("/api/pty/restart", "POST", {}); } catch (e) { toast(e.message, true); return; }
  shConnect();
}
// What the terminal produced from the keyboard, paste or the key row.
function shInput(data) {
  if (!SH.alive) { if (/[\r\n]/.test(data)) shConnect(); return; }
  if (SH.ctrl) {
    SH.ctrl = false; shCtrlPaint();
    const c = data.length === 1 ? data.toUpperCase().charCodeAt(0) : 0;
    if (c >= 64 && c <= 95) { shSend(String.fromCharCode(c - 64)); return; }
  }
  shSend(data);
}
function shCtrlPaint() { const b = SH.ui && SH.ui.keys && SH.ui.keys.querySelector("[data-k=ctrl]"); if (b) { b.classList.toggle("on", SH.ctrl); b.setAttribute("aria-pressed", String(SH.ctrl)); } }
async function shSendPw() {
  const u = SH.ui;
  if (!u || !u.pwIn.value) return;
  const secret = u.pwIn.value;
  u.pwIn.value = "";
  shShowPw(false);
  await shPost(secret, true);
}
// The size of the box goes to the PTY, so full-screen programs (vim, htop) and line wrapping match what the owner sees.
function shResize() {
  if (!SH.term || !SH.ui || !SH.ui.host.clientWidth) return;
  try { SH.fit.fit(); } catch {}
}
function shSetCommand(command) {
  if (command == null || command === "") return;
  if (SH.alive) shSend(command); else SH.pend = command;
  toast("명령을 입력해 뒀어요. Enter를 누르면 실행돼요");
  if (SH.term) SH.term.focus();
}

async function openShell({ command } = {}) {
  if (SH.dlg && SH.dlg.node.isConnected) { shSetCommand(command); return; }
  const host = el("div", { class: "sh-term", "aria-label": "터미널" });
  const st = el("span", { class: "sh-st", role: "status", "aria-live": "polite" });
  const pwIn = el("input", { class: "sh-pw-in", type: "password", name: "dz-shell-secret", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "암호", placeholder: "암호", "data-lpignore": "true", "data-1p-ignore": "true", "data-bwignore": "true", "data-form-type": "other" });
  const pw = el("div", { class: "sh-pw", hidden: true },
    el("div", { class: "sh-pw-t", text: "암호를 입력해요. 화면에 보이지도, 저장되지도 않아요." }),
    el("div", { class: "sh-pw-r" }, pwIn, el("button", { type: "button", class: "btn sh-pw-send", onclick: shSendPw }, "보내기"), el("button", { type: "button", class: "btn text", onclick: () => shShowPw(false) }, "닫기")));
  const keys = shTouch() ? el("div", { class: "sh-keys", role: "toolbar", "aria-label": "특수 키" },
    ...SH_KEYS.map(([label, seq]) => el("button", { type: "button", class: "btn tonal sh-k", "data-k": seq === "ctrl" ? "ctrl" : seq,
      // pointerdown keeps the terminal focused, so the soft keyboard stays up while a key is pressed
      onpointerdown: ev => ev.preventDefault(),
      onclick: () => { if (seq === "ctrl") { SH.ctrl = !SH.ctrl; shCtrlPaint(); } else { shInput(seq); } if (SH.term) SH.term.focus(); } }, label))) : null;
  const body = el("div", { class: "sh-wrap" }, host, pw, keys);
  const name = (typeof prSelf === "function" && prSelf() && prSelf().name) || "이 컴퓨터";
  const h = dialog({ title: `터미널 · ${name}`, body, wide: true, onclose: () => {
    shDisconnect(); if (SH.ro) SH.ro.disconnect();
    if (SH.term) SH.term.dispose();
    Object.assign(SH, { dlg: null, term: null, fit: null, ro: null, ui: null, ctrl: false, pend: "", sendBuf: "", alive: false });
  } });
  h.node.classList.add("shell");
  // header: connection state, the small 암호 action, and the menu that holds 셸 다시 시작
  const pwBtn = el("button", { type: "button", class: "ib sh-k-pw", title: "암호 입력", "aria-label": "암호 입력", onclick: () => shShowPw(pw.hidden) }, icon("shell"), el("span", { class: "sh-k-t", text: "암호" }));
  const more = el("button", { type: "button", class: "ib sh-more", title: "더 보기", "aria-label": "더 보기", text: "⋯" });
  more.onclick = () => showMenu(more, [{ value: "restart", label: "셸 다시 시작" }], { onPick: v => { if (v === "restart") shRestart(); } });
  const hb = h.node.querySelector(".fs-hb");
  if (hb) hb.prepend(st, pwBtn, more);
  SH.dlg = h; SH.ui = { host, st, pw, pwIn, pwBtn, keys };
  pwIn.addEventListener("keydown", ev => { if (ev.isComposing || ev.keyCode === 229) return; if (ev.key === "Enter") { ev.preventDefault(); shSendPw(); } });
  shStatus("불러오는 중…");
  try { await shLib(); } catch (e) { shStatus(e.message, "err"); return; }
  if (SH.dlg !== h) return;
  const touch = shTouch();
  const t = new Terminal({ cursorBlink: true, scrollback: 5000, fontFamily: shCss("--mono") || "monospace", fontSize: touch ? 14 : 13, lineHeight: 1.2, theme: shTheme(), allowProposedApi: false, macOptionIsMeta: true });
  const fit = new FitAddon.FitAddon();
  t.loadAddon(fit);
  t.open(host);
  SH.term = t; SH.fit = fit;
  fit.fit();
  t.onData(shInput);
  t.onResize(({ cols, rows }) => { if (SH.alive) api("/api/pty/resize", "POST", { cols, rows }).catch(() => {}); });
  SH.ro = new ResizeObserver(() => shResize());
  SH.ro.observe(host);
  host.addEventListener("pointerdown", () => { if (!pw.hidden) return; t.focus(); });
  if (command) SH.pend = command;
  t.focus();
  shConnect();
}
