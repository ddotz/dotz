/* ---------- web terminal (셸): the shell of the computer this page is served from ---------- */
// Output: GET /api/pty/stream (SSE). Input: POST /api/pty/input. Each computer serves its own page, so "the computer whose
// chat this is" is simply the origin; there is no host to pick. Nothing typed here is stored: the command box is cleared
// when sent, and a password is cleared from its field before the request leaves.
ICONS.shell = "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 10l3 2-3 2M12 15h5";

// A password prompt: the last line of output ends in a colon and names a password, passphrase or 암호.
const SH_PW_RE = /(?:password|passphrase|암호|비밀번호|패스워드)[^\n]{0,60}[:：]\s*$/i;
const isPasswordPrompt = line => { const t = String(line ?? "").replace(/\s+$/, ""); return t.length > 0 && t.length <= 160 && SH_PW_RE.test(t); };

// Terminal screen model: the text a PTY prints, with the cursor moves a line editor uses (\r, \b, ESC[nC/D/G/K/J) applied to
// the current line and every other escape sequence dropped.
const SH_MAX_LINES = 2000;
const termNew = () => ({ lines: [""], col: 0, pend: "" });
function termPut(m, ch) {
  let line = m.lines[m.lines.length - 1];
  if (m.col > line.length) line = line.padEnd(m.col, " ");
  m.lines[m.lines.length - 1] = line.slice(0, m.col) + ch + line.slice(m.col + 1);
  m.col++;
}
function termCsi(m, final, params) {
  const n = parseInt(params, 10), last = m.lines.length - 1, line = m.lines[last];
  if (/^[?>=]/.test(params)) return;
  if (final === "C") m.col += n || 1;
  else if (final === "D") m.col = Math.max(0, m.col - (n || 1));
  else if (final === "G") m.col = Math.max(0, (n || 1) - 1);
  else if (final === "K") m.lines[last] = n === 2 ? "" : n === 1 ? " ".repeat(Math.min(m.col, line.length)) + line.slice(m.col) : line.slice(0, m.col);
  else if (final === "J") { if (n === 2 || n === 3) { m.lines = [""]; m.col = 0; } else m.lines[last] = line.slice(0, m.col); }
}
function termFeed(m, text) {
  const s = m.pend + String(text); m.pend = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\x1b") {
      const rest = s.slice(i + 1);
      if (!rest) { m.pend = "\x1b"; break; }
      if (rest[0] === "[") {
        const mm = /^\[([0-?]*)[ -\/]*([@-~])/.exec(rest);
        if (!mm) { if (rest.length < 40) { m.pend = s.slice(i); break; } continue; }
        termCsi(m, mm[2], mm[1]);
        i += mm[0].length;
      } else if (rest[0] === "]") {
        const end = /\x07|\x1b\\/.exec(rest);
        if (!end) { if (rest.length < 600) { m.pend = s.slice(i); break; } continue; }
        i += end.index + end[0].length;
      } else i += /[()*+#]/.test(rest[0]) ? 2 : 1;
    } else if (c === "\r") m.col = 0;
    else if (c === "\n") { m.lines.push(""); m.col = 0; if (m.lines.length > SH_MAX_LINES) m.lines.splice(0, SH_MAX_LINES / 4); }
    else if (c === "\b") m.col = Math.max(0, m.col - 1);
    else if (c === "\t") { for (let k = 8 - (m.col % 8); k > 0; k--) termPut(m, " "); }
    else if (c >= " " && c !== "\x7f") termPut(m, c);
  }
}
const termText = m => m.lines.map(l => l.replace(/\s+$/, "")).join("\n");
const termLast = m => m.lines[m.lines.length - 1];

/* ---------- ui ---------- */
const SH_KEYS = [["Ctrl+C", "\x03"], ["Ctrl+D", "\x04"], ["Tab", "\t"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["Esc", "\x1b"]];
const SH = { dlg: null, model: termNew(), ctl: null, alive: false, pwKey: "", pwDismiss: "", pwAuto: false, raf: 0, ui: null };

function shShowPw(on, auto) {
  const u = SH.ui;
  if (!u) return;
  u.pw.hidden = !on;
  SH.pwAuto = on && !!auto;
  if (!on) u.pwIn.value = "";
  else u.pwIn.focus({ preventScroll: true });
}
function shPaint() {
  SH.raf = 0;
  const u = SH.ui;
  if (!u) return;
  const near = u.out.scrollHeight - u.out.scrollTop - u.out.clientHeight < 48;
  u.out.textContent = termText(SH.model);
  if (near) u.out.scrollTop = u.out.scrollHeight;
  const last = termLast(SH.model), key = `${SH.model.lines.length}:${last}`;
  if (SH.alive && isPasswordPrompt(last)) {
    if (key !== SH.pwDismiss && u.pw.hidden) shShowPw(true, true);
    SH.pwKey = key;
  } else if (SH.pwAuto && !u.pw.hidden) shShowPw(false);
}
const shSchedule = () => { if (!SH.raf) SH.raf = requestAnimationFrame(shPaint); };
function shStatus(text, tone) {
  const u = SH.ui;
  if (!u) return;
  u.st.textContent = text;
  u.st.dataset.tone = tone || "";
  u.run.textContent = SH.alive ? "실행" : "다시 시작";
}
function shFrame(raw) {
  let ev = "", data = "";
  for (const l of raw.split("\n")) { if (l.startsWith("event:")) ev = l.slice(6).trim(); else if (l.startsWith("data:")) data += l.slice(5).trim(); }
  if (!ev || !data) return;
  let d;
  try { d = JSON.parse(data); } catch { return; }
  if (ev === "reset") { SH.model = termNew(); termFeed(SH.model, d.data || ""); SH.alive = d.alive !== false; shStatus(SH.alive ? "연결됨" : "셸이 꺼져 있어요", SH.alive ? "ok" : "err"); }
  else if (ev === "out") termFeed(SH.model, d.data || "");
  else if (ev === "exit") { SH.alive = false; shShowPw(false); shStatus("셸이 끝났어요", "err"); }
  shSchedule();
}
function shCharBox(out) {
  const probe = el("span", { class: "sh-probe", text: "M".repeat(20) });
  out.append(probe);
  const w = probe.getBoundingClientRect().width / 20 || 8;
  probe.remove();
  return { cols: Math.max(20, Math.floor((out.clientWidth - 24) / w)), rows: Math.max(8, Math.floor(out.clientHeight / 18)) };
}
async function shConnect() {
  shDisconnect();
  const u = SH.ui;
  if (!u) return;
  const ctl = new AbortController(), { cols, rows } = shCharBox(u.out);
  SH.ctl = ctl;
  shStatus("연결 중…");
  try {
    const r = await fetch(`/api/pty/stream?cols=${cols}&rows=${rows}`, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rd = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) { shFrame(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if (SH.ctl === ctl) { SH.alive = false; shStatus("연결이 끊겼어요", "err"); }
  } catch (e) {
    if (SH.ctl === ctl && e.name !== "AbortError") { SH.alive = false; shStatus("연결하지 못했어요", "err"); }
  }
}
function shDisconnect() { if (SH.ctl) { SH.ctl.abort(); SH.ctl = null; } }

async function shSend(data, secret) {
  try { await api("/api/pty/input", "POST", secret ? { data, secret: true } : { data }); return true; }
  catch (e) { toast(e.message, true); return false; }
}
async function shRestart() {
  try { await api("/api/pty/restart", "POST", {}); } catch (e) { toast(e.message, true); return; }
  shConnect();
}
async function shRun() {
  const u = SH.ui;
  if (!u) return;
  if (!SH.alive) { shConnect(); return; }
  const text = u.cmd.value.replace(/\n+$/, "");
  u.cmd.value = ""; shAutosize(); u.hint.hidden = true;
  await shSend(text.replace(/\r?\n/g, "\r") + "\r");
}
async function shSendPw() {
  const u = SH.ui;
  if (!u || !u.pwIn.value) return;
  const secret = u.pwIn.value;
  u.pwIn.value = "";
  SH.pwDismiss = SH.pwKey;
  shShowPw(false);
  await shSend(secret, true);
}
function shAutosize() {
  const t = SH.ui && SH.ui.cmd;
  if (!t) return;
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
}
function shSetCommand(command) {
  const u = SH.ui;
  if (!u || command == null) return;
  u.cmd.value = command;
  shAutosize();
  u.hint.hidden = !command;
  u.cmd.scrollIntoView({ block: "nearest" });
}

function openShell({ command } = {}) {
  if (SH.dlg && SH.dlg.node.isConnected) { shSetCommand(command); return; }
  const out = el("pre", { class: "sh-out", tabindex: "0", "aria-label": "터미널 출력" });
  const st = el("span", { class: "sh-st", role: "status", "aria-live": "polite" });
  const hint = el("div", { class: "sh-hint", text: "명령을 확인하고 ‘실행’을 눌러요. 자동으로 실행되지 않아요.", hidden: true });
  const cmd = el("textarea", { class: "sh-cmd", rows: 1, placeholder: "명령어", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "터미널 명령" });
  const run = el("button", { type: "button", class: "btn sh-run", onclick: shRun }, "실행");
  const pwIn = el("input", { class: "sh-pw-in", type: "password", name: "dz-shell-secret", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "암호", placeholder: "암호", "data-lpignore": "true", "data-1p-ignore": "true", "data-bwignore": "true", "data-form-type": "other" });
  const pwSend = el("button", { type: "button", class: "btn sh-pw-send", onclick: shSendPw }, "암호 보내기");
  const pw = el("div", { class: "sh-pw", hidden: true },
    el("div", { class: "sh-pw-t", text: "암호를 입력해요. 화면에 보이지도, 저장되지도 않아요." }),
    el("div", { class: "sh-pw-r" }, pwIn, pwSend, el("button", { type: "button", class: "btn text", onclick: () => { SH.pwDismiss = SH.pwKey; shShowPw(false); } }, "닫기")));
  const keys = el("div", { class: "sh-keys" },
    el("button", { type: "button", class: "btn tonal sh-k sh-k-pw", onclick: () => shShowPw(pw.hidden, false) }, icon("shell"), "암호"),
    ...SH_KEYS.map(([label, seq]) => el("button", { type: "button", class: "btn tonal sh-k", onclick: () => shSend(seq) }, label)),
    el("button", { type: "button", class: "btn tonal sh-k", onclick: shRestart }, "셸 다시 시작"));
  const body = el("div", { class: "sh-wrap" }, el("div", { class: "sh-top" }, st), out, pw, hint, el("div", { class: "sh-in" }, cmd, run), keys);
  const name = (typeof prSelf === "function" && prSelf() && prSelf().name) || "이 컴퓨터";
  const h = dialog({ title: `터미널 · ${name}`, body, wide: true, onclose: () => { shDisconnect(); SH.dlg = null; SH.ui = null; SH.pwDismiss = ""; shShowPw(false); } });
  h.node.classList.add("shell");
  SH.dlg = h; SH.ui = { out, st, hint, cmd, run, pw, pwIn };
  cmd.addEventListener("input", () => { shAutosize(); hint.hidden = true; });
  cmd.addEventListener("keydown", ev => { if (ev.isComposing || ev.keyCode === 229) return; if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); shRun(); } });
  pwIn.addEventListener("keydown", ev => { if (ev.isComposing || ev.keyCode === 229) return; if (ev.key === "Enter") { ev.preventDefault(); shSendPw(); } });
  shSetCommand(command);
  shConnect();
}
