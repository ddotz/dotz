import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (f: string) => readFileSync(join(import.meta.dir, "..", "web", "js", f), "utf8");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Blocks = { isShellBlock: (lang: string, text: string) => boolean; shellCommand: (text: string) => string; codeBlockHtml: (lang: string, code: string) => string };
const blocks = new Function("esc", "document", "el", "navigator", "window", `${web("35-code-blocks.js")}\nreturn { isShellBlock, shellCommand, codeBlockHtml };`)(esc, { addEventListener() {} }, () => null, {}, {}) as Blocks;

type Shell = {
	isPasswordPrompt: (line: string) => boolean;
	termNew: () => unknown;
	termFeed: (m: unknown, text: string) => void;
	termText: (m: unknown) => string;
};
const shell = new Function("ICONS", `${web("36-shell.js")}\nreturn { isPasswordPrompt, termNew, termFeed, termText };`)({}) as Shell;
const screen = (...chunks: string[]) => { const m = shell.termNew(); for (const c of chunks) shell.termFeed(m, c); return shell.termText(m); };

describe("shell-like code block detection", () => {
	test.each([
		["sh", "sudo killall trustd"],
		["bash", "brew install jq\nbrew upgrade"],
		["zsh", "echo hi"],
		["console", "$ ls -la"],
		["", "sudo killall trustd"],
		["", "$ git status"],
		["", "FOO=1 bun test"],
		["", "./install.sh --yes"],
		["", "# 먼저 캐시를 비워요\nlaunchctl kickstart -k system/com.apple.trustd"],
		["BASH", "pkill -f dotz"],
	])("%j block %j is shell-like", (lang, text) => {
		expect(blocks.isShellBlock(lang, text)).toBe(true);
	});

	test.each([
		["json", '{"a": 1}'],
		["ts", "const a = 1"],
		["python", "print('hi')"],
		["sh", ""],
		["sh", "# only a comment"],
		["", '{"a": 1}'],
		["", "[1, 2, 3]"],
		["", "<div>hi</div>"],
		["", "이건 그냥 설명하는 문장이에요"],
		["", "Error: something failed"],
		["yaml", "sudo: true"],
	])("%j block %j is not shell-like", (lang, text) => {
		expect(blocks.isShellBlock(lang, text)).toBe(false);
	});

	test("the text sent to the terminal has no $ prompts or trailing blank lines", () => {
		expect(blocks.shellCommand("$ sudo killall trustd\n\n")).toBe("sudo killall trustd");
		expect(blocks.shellCommand("  $ ls\n$ pwd  \n")).toBe("  ls\npwd");
		expect(blocks.shellCommand("echo $HOME")).toBe("echo $HOME");
	});
});

describe("code block markup", () => {
	test("every block with code gets a copy button; shell-like blocks also get the run button; the code is escaped", () => {
		const sh = blocks.codeBlockHtml("bash", "echo '<b>' && ls");
		expect(sh).toContain('data-cb="copy"');
		expect(sh).toContain('data-cb="run"');
		expect(sh).toContain("echo &#39;&lt;b&gt;&#39; &amp;&amp; ls");
		const json = blocks.codeBlockHtml("json", '{"a":1}');
		expect(json).toContain('data-cb="copy"');
		expect(json).not.toContain('data-cb="run"');
	});

	test("the button texts are CSS (data-label), so a copied message never carries them", () => {
		const html = blocks.codeBlockHtml("sh", "ls");
		expect(html.replace(/<[^>]*>/g, "")).toBe("ls");
	});

	test("an empty block stays a plain pre; the language tag cannot inject markup", () => {
		expect(blocks.codeBlockHtml("sh", "  \n")).toBe("<pre><code>  </code></pre>");
		expect(blocks.codeBlockHtml('"><img src=x onerror=1>', "ls")).not.toContain("<img");
	});
});

describe("password prompt detection", () => {
	test.each([
		"Password:",
		"[sudo] password for hyuns: ",
		"hyuns@mac.local's password:",
		"Enter passphrase for key '/Users/hyuns/.ssh/id_ed25519':",
		"암호:",
		"[sudo] hyuns의 암호:",
		"비밀번호를 입력하세요:",
		"Password for hyuns@host: ",
		"Enter Password：",
	])("%j is a password prompt", line => {
		expect(shell.isPasswordPrompt(line)).toBe(true);
	});

	test.each(["", "$ ", "hyuns@mac ~ % ls", "Password updated.", "the password is rotated daily", "Last login: Thu Oct 22", "x".repeat(300) + " password:"])("%j is not", line => {
		expect(shell.isPasswordPrompt(line)).toBe(false);
	});
});

describe("terminal screen model", () => {
	test("a line editor's redraw (backspace, cursor moves, colors, OSC) ends as the typed line", () => {
		expect(screen("\x1b]1337;CurrentDir=/Users/h\x07$ e\becho hi\b\b\b\b\b\b\b\x1b[32mecho\x1b[39m\x1b[3C\r\n")).toBe("$ echo hi\n");
	});

	test("carriage return overwrites the line; CR LF starts the next", () => {
		expect(screen("abc\rX")).toBe("Xbc");
		expect(screen("one\r\ntwo\r\n[sudo] password for h: ")).toBe("one\ntwo\n[sudo] password for h:");
	});

	test("an escape sequence split across two chunks is not shown", () => {
		expect(screen("a\x1b[3", "1mb\x1b", "[0mc")).toBe("abc");
		expect(screen("x\x1b]0;title", "\x07y")).toBe("xy");
	});

	test("erase to end of line and clear screen", () => {
		expect(screen("hello\r\x1b[K")).toBe("");
		expect(screen("hello\x1b[2Jbye")).toBe("bye");
	});

	test("the last line is what the prompt detector reads", () => {
		const m = shell.termNew();
		shell.termFeed(m, "$ sudo killall trustd\r\n[sudo] password for test: ");
		expect(shell.isPasswordPrompt(shell.termText(m).split("\n").at(-1)!)).toBe(true);
	});
});
