import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PtyHost, ptyRoute } from "./pty.ts";
import { advance } from "./runtime/test-clock.ts";
import { join } from "node:path";
import { appAsset, indexPage } from "./webapp.ts";

// A stand-in for the owner's shell: a prompt, an echo for plain commands, and a sudo that asks for a password with echo off.
const SHELL = `printf '$ '; while IFS= read -r line; do case "$line" in sudo*) printf '[sudo] password for test: '; stty -echo; IFS= read -r pw; stty echo; printf '\\n'; printf 'PW:%s\\n' "$(printf %s "$pw" | cksum | cut -d' ' -f1)";; *) printf 'RAN:%s\\n' "$line";; esac; printf '$ '; done`;
const SECRET = "s3cret-테스트-77";
const cksum = (s: string) => new TextDecoder().decode(Bun.spawnSync(["sh", "-c", `printf %s "$1" | cksum | cut -d' ' -f1`, "sh", s]).stdout).trim();
const SNAP = "/tmp/dotz-shell-test";

const host = new PtyHost({ cmd: ["/bin/sh", "-c", SHELL] });
// What the page POSTs to the PTY endpoints: the stand-in for the socket the keystrokes must reach.
const sent: { path: string; body: Record<string, unknown> }[] = [];
const wake = new Set<() => void>();
const typed = () => sent.filter(x => x.path === "/api/pty/input" && !x.body.secret).map(x => x.body.data as string).join("");
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname.startsWith("/vendor/")) return new Response(Bun.file(join(import.meta.dir, "..", "web", url.pathname)));
		if (req.method === "POST" && url.pathname.startsWith("/api/pty/")) { sent.push({ path: url.pathname, body: (await req.clone().json()) as Record<string, unknown> }); for (const f of [...wake]) f(); }
		const pty = await ptyRoute(req, url, host);
		if (pty) return pty;
		if (url.pathname === "/") return indexPage(req);
		const asset = appAsset(req, url.pathname);
		if (asset) return asset;
		return url.pathname.startsWith("/api/") ? Response.json({}) : new Response("not found", { status: 404 });
	},
});
const base = `http://127.0.0.1:${server.port}/`;
type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
const open = async (width: number, height: number): Promise<View> => {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(base);
	return v;
};
// Resolves once the page-side condition holds (checked on every DOM change); rejects after `ms`.
const waitFor = (v: View, expr: string, ms = 30_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const done = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); o.disconnect(); res(true); } }; const o = new MutationObserver(done); o.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); done(); })`);
// Terminal output can sit undelivered in the headless page until the stream's next write (seen under load: the hub's ring had
// the sudo prompt, the page had only the command's echo, and the next write brought it). In the app that next write is the
// stream's 15 s ping at the latest, so a wait that runs out moves the test clock past one ping and waits again.
const waitOut = async (v: View, expr: string) => {
	try {
		await waitFor(v, expr, 8_000);
	} catch {
		await advance(15_000);
		await waitFor(v, expr);
	}
};
// The page's POSTs arrive on the stub server; this resolves when the node-side condition holds, within a bound.
const waitUntil = (cond: () => boolean, ms = 15_000) => new Promise<void>((res, rej) => {
	const t = setTimeout(() => { wake.delete(check); rej(new Error(`timeout: ${cond}`)); }, ms);
	const check = () => { if (cond()) { clearTimeout(t); wake.delete(check); res(); } };
	wake.add(check);
	check();
});
const SAMPLE = "1번으로 갈게요. 터미널에서 아래 한 줄만 실행해 주세요.\n\n```\nsudo killall trustd\n```\n\n```json\n{\"a\": 1}\n```\n\n```bash\nls -la ~/Library && echo 'a very long line that has to scroll sideways inside the block and never widen the page'\n```";
// Draws the sample in a fixed layer, so the app's own boot re-rendering cannot take it away mid-test.
const showSample = (v: View) =>
	v.evaluate(`(() => { document.getElementById("t-host")?.remove(); document.body.append(el("div", { id: "t-host", class: "bm", style: "position:fixed;left:0;right:0;top:60px;z-index:5;background:var(--bg);padding:0 16px" }, mdNode(${JSON.stringify(SAMPLE)}))); return document.querySelectorAll("#t-host .cb").length; })()`);

// Like waitFor, and also re-checks whenever the terminal parses output or renders (xterm's own events), so a screen change that adds no DOM node still counts.
const waitTermOnce = (v: View, expr: string, ms: number) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); let hooked = null; const done = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); o.disconnect(); res(true); return; } if (typeof SH !== "undefined" && SH.term && hooked !== SH.term) { hooked = SH.term; SH.term.onWriteParsed(done); SH.term.onRender(done); } }; const o = new MutationObserver(done); o.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); done(); })`);
// Same quirk as waitOut: output can wait for the stream's next write, so one retry moves the test clock past a ping.
const waitTerm = async (v: View, expr: string) => {
	try {
		await waitTermOnce(v, expr, 8_000);
	} catch {
		await advance(15_000);
		await waitTermOnce(v, expr, 30_000);
	}
};
// A screenshot waits for the sheet's opening animation to end, so it shows the finished screen.
const settled = (v: View) => v.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => true)`);
const BUF = `(() => { const b = SH.term.buffer.active; let s = ""; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + "\\n"; return s; })()`;
// The key row is for a touch screen: the page asks (pointer: coarse), so a test answers yes before opening the terminal.
const touchOn = (v: View) => v.evaluate(`(() => { const mm = window.matchMedia.bind(window); window.matchMedia = q => /pointer:\\s*coarse/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q); })()`);
const openTerm = async (v: View) => {
	await host.restart();   // a fresh shell: a previous test may have left it at a password prompt
	await v.evaluate(`openShell({})`);
	await waitTerm(v, `typeof SH !== "undefined" && SH.alive && ${BUF}.startsWith("$")`);
};

beforeAll(() => { Bun.spawnSync(["mkdir", "-p", SNAP]); });
afterAll(() => { for (const v of views) v.close(); host.kill(); server.stop(true); });

describe("the web terminal is a real terminal, in a headless browser", () => {
	test("on a desktop width: the prompt is in the terminal, there is no command field, no run button, no key row", async () => {
		const v = await open(1280, 800);
		await openTerm(v);
		const m = JSON.parse(await v.evaluate(`JSON.stringify({
			xterm: !!document.querySelector("dialog.shell .xterm"), cmd: !!document.querySelector(".sh-cmd, .sh-run"), keys: !!document.querySelector(".sh-keys"),
			words: document.querySelector("dialog.shell").textContent.includes("명령어") || document.querySelector("dialog.shell").textContent.includes("실행"),
			dlgW: Math.round(document.querySelector("dialog.shell").getBoundingClientRect().width), dlgH: Math.round(document.querySelector("dialog.shell").getBoundingClientRect().height),
			termH: Math.round(document.querySelector(".sh-term").getBoundingClientRect().height), focused: document.activeElement === document.querySelector(".xterm-helper-textarea"),
			font: getComputedStyle(document.querySelector(".xterm-rows")).fontFamily, cols: SH.term.cols, rows: SH.term.rows, title: document.querySelector(".dtitle").textContent })`) as string);
		expect(m).toMatchObject({ xterm: true, cmd: false, keys: false, words: false, focused: true });
		expect(m.font).toMatch(/mono|Menlo|SF/i);
		expect(m.dlgW).toBeLessThanOrEqual(840);
		expect(m.termH).toBeGreaterThan(m.dlgH * 0.8);   // the terminal takes the sheet's height
		expect(m.cols).toBeGreaterThan(60);
		expect(m.title).toStartWith("터미널 ·");
		await settled(v);
		await Bun.write(`${SNAP}/terminal-desktop.png`, await v.screenshot());
	}, 90_000);

	test("keystrokes reach the PTY: typing, Enter, arrows, Ctrl+C, paste, and the shell's answer shows in the terminal", async () => {
		const v = await open(1280, 800);
		await openTerm(v);
		sent.length = 0;
		await v.evaluate(`(() => { SH.term.input("echo hi", true); SH.term.input("\\r", true); })()`);
		await waitTerm(v, `${BUF}.includes("RAN:echo hi")`);
		expect(typed()).toBe("echo hi\r");
		// keys from the keyboard itself: the helper textarea gets real key events
		sent.length = 0;
		await v.evaluate(`(() => { const t = document.querySelector(".xterm-helper-textarea"); t.focus();
			const key = (k, code, kc, extra = {}) => t.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, keyCode: kc, bubbles: true, cancelable: true, ...extra }));
			key("ArrowUp", "ArrowUp", 38); key("Tab", "Tab", 9); key("c", "KeyC", 67, { ctrlKey: true }); key("d", "KeyD", 68, { ctrlKey: true }); key("Escape", "Escape", 27); })()`);
		await waitUntil(() => typed().length >= 5);
		expect(typed()).toMatch(/^\x1b[\[O]A\t\x03\x04\x1b$/);
		// paste
		sent.length = 0;
		await v.evaluate(`(() => { const t = document.querySelector(".xterm-helper-textarea"); const dt = new DataTransfer(); dt.setData("text/plain", "echo pasted"); t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
		await waitUntil(() => typed().includes("echo pasted"));
		expect(typed()).toContain("echo pasted");
	}, 90_000);

	test("the box size goes to the PTY: a narrower terminal sends the new cols and rows", async () => {
		const v = await open(1280, 800);
		await openTerm(v);
		const cols0 = Number(await v.evaluate(`SH.term.cols`));
		sent.length = 0;
		await v.evaluate(`document.querySelector(".sh-term").style.width = "320px"`);
		await waitUntil(() => sent.some(x => x.path === "/api/pty/resize"));
		const r = sent.filter(x => x.path === "/api/pty/resize").at(-1)!.body as { cols: number; rows: number };
		expect(r.cols).toBeLessThan(cols0);
		expect(r.cols).toBe(Number(await v.evaluate(`SH.term.cols`)));
		expect(r.rows).toBeGreaterThan(4);
	}, 90_000);

	test("at 390px with a touch screen: the slim key row is there, keys reach the PTY, Ctrl is sticky, nothing overflows", async () => {
		const v = await open(390, 844);
		await touchOn(v);
		await openTerm(v);
		const m = JSON.parse(await v.evaluate(`JSON.stringify({ keys: [...document.querySelectorAll(".sh-keys .sh-k")].map(b => b.textContent), cmd: !!document.querySelector(".sh-cmd, .sh-run"), sw: document.documentElement.scrollWidth, dlgW: Math.round(document.querySelector("dialog.shell").getBoundingClientRect().width), dlgH: Math.round(document.querySelector("dialog.shell").getBoundingClientRect().height), termH: Math.round(document.querySelector(".sh-term").getBoundingClientRect().height), fits: (() => { const k = document.querySelector(".sh-keys"); return k.scrollWidth <= k.clientWidth; })(), minH: Math.min(...[...document.querySelectorAll(".sh-keys .sh-k")].map(b => b.getBoundingClientRect().height)), cols: SH.term.cols })`) as string);
		expect(m.keys).toEqual(["Esc", "Tab", "Ctrl", "↑", "↓", "←", "→", "^C", "^D"]);
		expect(m).toMatchObject({ cmd: false, dlgW: 390 });
		expect(m.sw).toBeLessThanOrEqual(390);
		expect(m.fits).toBe(true);
		expect(m.minH).toBeGreaterThanOrEqual(36);
		expect(m.termH).toBeGreaterThan(m.dlgH * 0.6);
		expect(m.cols).toBeGreaterThanOrEqual(30);
		await settled(v);
		await Bun.write(`${SNAP}/terminal-390.png`, await v.screenshot());
		sent.length = 0;
		await v.evaluate(`document.querySelector(".sh-keys .sh-k:nth-child(4)").click()`);
		await v.evaluate(`document.querySelector(".sh-keys .sh-k:nth-child(8)").click()`);
		await v.evaluate(`document.querySelector(".sh-keys .sh-k:nth-child(3)").click()`);
		expect(await v.evaluate(`SH.ctrl`)).toBe(true);
		await v.evaluate(`SH.term.input("d", true)`);
		await waitUntil(() => typed().length >= 5);
		expect(typed()).toBe("\x1b[A\x03\x04");
		expect(await v.evaluate(`SH.ctrl`)).toBe(false);
	}, 90_000);

	test("the header menu restarts the shell", async () => {
		const v = await open(1280, 800);
		await openTerm(v);
		sent.length = 0;
		await v.click(".sh-more");
		await waitFor(v, `[...document.querySelectorAll(".menu .mi")].some(b => b.textContent.includes("셸 다시 시작"))`);
		await v.evaluate(`[...document.querySelectorAll(".menu .mi")].find(b => b.textContent.includes("셸 다시 시작")).click()`);
		await waitUntil(() => sent.some(x => x.path === "/api/pty/restart"));
		await waitTerm(v, `SH.alive && ${BUF}.includes("$")`);
	}, 90_000);

	test("터미널에서 실행 types the command at the prompt without running it; the 암호 box sends a password that is not kept", async () => {
		await host.restart();
		const v = await open(390, 844);
		await showSample(v);
		await v.click("#t-host .cb .cb-btn.run");
		await waitTerm(v, `typeof SH !== "undefined" && SH.alive && ${BUF}.includes("$ sudo killall trustd")`);
		expect(await v.evaluate(`${BUF}.includes("RAN:")`)).toBe(false);
		expect(await v.evaluate(`document.querySelector("dialog.shell .dtitle").textContent.startsWith("터미널")`)).toBe(true);

		await v.evaluate(`SH.term.input("\\r", true)`);
		await waitTerm(v, `${BUF}.includes("password for test:")`);
		await waitFor(v, `document.querySelector(".sh-k-pw").classList.contains("hot")`);
		await v.click(".sh-k-pw");
		await waitFor(v, `!document.querySelector(".sh-pw").hidden && document.activeElement === document.querySelector(".sh-pw-in")`);
		const asked = JSON.parse(await v.evaluate(`JSON.stringify({ type: document.querySelector(".sh-pw-in").type, ac: document.querySelector(".sh-pw-in").autocomplete, inForm: !!document.querySelector(".sh-pw-in").closest("form"), sw: document.documentElement.scrollWidth })`) as string);
		expect(asked).toMatchObject({ type: "password", ac: "off", inForm: false });
		expect(asked.sw).toBeLessThanOrEqual(390);
		await settled(v);
		await Bun.write(`${SNAP}/terminal-password-390.png`, await v.screenshot());

		sent.length = 0;
		await v.evaluate(`document.querySelector(".sh-pw-in").value = ${JSON.stringify(SECRET)}`);
		await v.click(".sh-pw-send");
		await waitTerm(v, `${BUF}.includes("PW:")`);
		const after = JSON.parse(await v.evaluate(`JSON.stringify({ out: ${BUF}, field: document.querySelector(".sh-pw-in").value, hidden: document.querySelector(".sh-pw").hidden, inDom: document.documentElement.outerHTML.includes(${JSON.stringify(SECRET)}), inStorage: JSON.stringify([localStorage, sessionStorage]).includes(${JSON.stringify(SECRET)}) })`) as string);
		expect(after.out).toContain(`PW:${cksum(SECRET)}`);
		expect(after).toMatchObject({ field: "", hidden: true, inDom: false, inStorage: false });
		expect(after.out).not.toContain(SECRET);
		expect(typed()).not.toContain(SECRET);
		expect(sent.find(x => x.body.secret === true)?.body.data).toBe(SECRET);
		expect(host.subscribe(() => {}).backlog).not.toContain(SECRET);
	}, 120_000);

	test("closing the terminal leaves the shell running for the next open", async () => {
		const v = await open(1280, 800);
		await openTerm(v);
		await v.evaluate(`SH.dlg.close()`);
		await waitFor(v, `!document.querySelector("dialog.shell")`);
		expect(host.alive).toBe(true);
	}, 60_000);
});
