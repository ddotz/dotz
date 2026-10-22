/* ---------- code blocks: a copy button on every block, "터미널에서 실행" on shell-like ones ---------- */
// The bar's texts are CSS (data-label), so they never end up in a copied or measured message text.
const CB_SHELL_LANGS = new Set(["sh", "bash", "zsh", "fish", "shell", "console", "terminal", "shell-session", "shellsession", "shellscript"]);
const CB_COMMANDS = new Set(["sudo", "brew", "bun", "bunx", "npm", "npx", "pnpm", "yarn", "git", "gh", "cd", "ls", "cat", "killall", "pkill", "kill", "launchctl", "defaults", "open", "curl", "wget", "ssh", "scp", "rsync", "python", "python3", "pip", "pip3", "node", "tailscale", "wrangler", "chmod", "chown", "mkdir", "rm", "cp", "mv", "ln", "touch", "echo", "printf", "export", "source", "ps", "lsof", "grep", "rg", "find", "tail", "head", "sed", "awk", "xattr", "codesign", "spctl", "security", "pmset", "diskutil", "networksetup", "scutil", "mdfind", "softwareupdate", "systemctl", "apt", "apt-get", "docker", "make", "cargo", "go", "dotz", "omo", "senpi", "aside", "pbcopy", "pbpaste", "say", "osascript", "caffeinate", "tmux", "which", "whoami", "uname", "df", "du", "top", "nc", "dig", "ping", "tar", "unzip", "zip", "env", "man", "mas", "dscacheutil", "plutil", "killall"]);
const CB_PROMPT = /^\$\s+/;

const cbLines = text => String(text ?? "").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
// First word of a command line, past a "$ " prompt and leading VAR=value assignments.
function cbWord(line) {
  return line.replace(CB_PROMPT, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").split(/\s+/)[0] || "";
}
// Shell-like: a shell language tag; or no tag and the first command line starts with a known command, a path, or a "$ " prompt.
function isShellBlock(lang, text) {
  const l = String(lang ?? "").trim().split(/\s+/)[0].toLowerCase(), lines = cbLines(text);
  if (!lines.length) return false;
  if (CB_SHELL_LANGS.has(l)) return true;
  if (l) return false;
  if (lines.length > 12 || /^[{\[<]/.test(lines[0])) return false;
  const w = cbWord(lines[0]);
  return CB_PROMPT.test(lines[0]) || CB_COMMANDS.has(w) || /^(?:\.{1,2}\/|~\/|\/)[\w.\/~-]+$/.test(w);
}
// What the terminal gets: the block without "$ " prompts and trailing blank space (comments stay: the owner reads them there).
const shellCommand = text => String(text ?? "").split("\n").map(l => l.replace(/^(\s*)\$\s+/, "$1").replace(/\s+$/, "")).join("\n").replace(/^\n+|\n+$/g, "");

function codeBlockHtml(lang, code) {
  const text = String(code ?? "").replace(/\n$/, ""), l = String(lang ?? "").trim().split(/\s+/)[0].toLowerCase().replace(/[^\w.+#-]/g, "").slice(0, 16);
  const pre = `<pre><code>${esc(text)}</code></pre>`;
  if (!text.trim()) return pre;
  const run = isShellBlock(l, text) ? '<button type="button" class="cb-btn run" data-cb="run" data-label="터미널에서 실행" aria-label="터미널에서 실행"></button>' : "";
  return `<div class="cb"><div class="cb-bar"${l ? ` data-lang="${esc(l)}"` : ""}><button type="button" class="cb-btn" data-cb="copy" data-label="복사" aria-label="코드 복사"></button>${run}</div>${pre}</div>`;
}

/* ---------- clipboard ---------- */
// navigator.clipboard needs a secure context (https or localhost) and a user gesture; the hidden-textarea copy covers a plain-http tailnet address and older browsers.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  const ta = el("textarea", { readonly: "", "aria-hidden": "true", tabindex: "-1", style: "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px" });
  ta.value = text;
  (document.querySelector("dialog[open]") || document.body).append(ta);
  let ok = false;
  try { ta.focus({ preventScroll: true }); ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

/* ---------- buttons (one capture listener: the message bubbles have their own click handlers) ---------- */
const CB_FLASH_MS = 1600;
function cbFlash(btn, label) {
  if (btn.dataset.label0 === undefined) btn.dataset.label0 = btn.dataset.label;
  btn.dataset.label = label;
  btn.classList.add("done");
  clearTimeout(btn._cbT);
  btn._cbT = setTimeout(() => { btn.dataset.label = btn.dataset.label0; delete btn.dataset.label0; btn.classList.remove("done"); }, CB_FLASH_MS);
}
function cbClick(ev) {
  const btn = ev.target.closest && ev.target.closest(".cb-btn");
  const code = btn && btn.closest(".cb") && btn.closest(".cb").querySelector("pre code");
  if (!code) return;
  ev.preventDefault(); ev.stopPropagation();
  const text = code.textContent;
  if (btn.dataset.cb === "run") openShell({ command: shellCommand(text) });
  else copyText(text).then(ok => cbFlash(btn, ok ? "복사했어요" : "복사하지 못했어요"));
}
document.addEventListener("click", cbClick, true);
