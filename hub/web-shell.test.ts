import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PtyHost, ptyRoute } from "./pty.ts";
import { appAsset, indexPage } from "./webapp.ts";

// A stand-in for the owner's shell: a prompt, an echo for plain commands, and a sudo that asks for a password with echo off.
const SHELL = `printf '$ '; while IFS= read -r line; do case "$line" in sudo*) printf '[sudo] password for test: '; stty -echo; IFS= read -r pw; stty echo; printf '\\n'; printf 'PW:%s\\n' "$(printf %s "$pw" | cksum | cut -d' ' -f1)";; *) printf 'RAN:%s\\n' "$line";; esac; printf '$ '; done`;
const SECRET = "s3cret-테스트-77";
const cksum = (s: string) => new TextDecoder().decode(Bun.spawnSync(["sh", "-c", `printf %s "$1" | cksum | cut -d' ' -f1`, "sh", s]).stdout).trim();
const SNAP = "/tmp/dotz-shell-test";

const host = new PtyHost({ cmd: ["/bin/sh", "-c", SHELL] });
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
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
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const done = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); o.disconnect(); res(true); } }; const o = new MutationObserver(done); o.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); done(); })`);
const SAMPLE = "1번으로 갈게요. 터미널에서 아래 한 줄만 실행해 주세요.\n\n```\nsudo killall trustd\n```\n\n```json\n{\"a\": 1}\n```\n\n```bash\nls -la ~/Library && echo 'a very long line that has to scroll sideways inside the block and never widen the page'\n```";
// Draws the sample in a fixed layer, so the app's own boot re-rendering cannot take it away mid-test.
const showSample = (v: View) =>
	v.evaluate(`(() => { document.getElementById("t-host")?.remove(); document.body.append(el("div", { id: "t-host", class: "bm", style: "position:fixed;left:0;right:0;top:60px;z-index:5;background:var(--bg);padding:0 16px" }, mdNode(${JSON.stringify(SAMPLE)}))); return document.querySelectorAll("#t-host .cb").length; })()`);

beforeAll(() => { Bun.spawnSync(["mkdir", "-p", SNAP]); });
afterAll(() => { for (const v of views) v.close(); host.kill(); server.stop(true); });

describe("code block buttons and the terminal, in a headless browser", () => {
	test("at 390px: buttons are thumb-sized, nothing overflows, copy and run sit only where they belong", async () => {
		const v = await open(390, 844);
		expect(await showSample(v)).toBe(3);
		const m = JSON.parse(await v.evaluate(`JSON.stringify({ sw: document.documentElement.scrollWidth, blocks: [...document.querySelectorAll("#t-host .cb")].map(c => { const r = c.getBoundingClientRect(); return { right: Math.round(r.right), kinds: [...c.querySelectorAll(".cb-btn")].map(b => b.dataset.cb), minH: Math.min(...[...c.querySelectorAll(".cb-btn")].map(b => b.getBoundingClientRect().height)) }; }) })`) as string);
		expect(m.sw).toBeLessThanOrEqual(390);
		expect(m.blocks.map((b: { kinds: string[] }) => b.kinds)).toEqual([["copy", "run"], ["copy"], ["copy", "run"]]);
		for (const b of m.blocks) { expect(b.right).toBeLessThanOrEqual(390); expect(b.minH).toBeGreaterThanOrEqual(36); }
		await Bun.write(`${SNAP}/blocks-390.png`, await v.screenshot());
	}, 30_000);

	test("copy uses the clipboard API when there is one and the hidden-textarea fallback when there is not", async () => {
		const v = await open(390, 844);
		await showSample(v);
		await v.evaluate(`Object.defineProperty(navigator, "clipboard", { value: { writeText: async t => { window.__clip = t; } }, configurable: true })`);
		await v.click("#t-host .cb .cb-btn");
		await waitFor(v, `document.querySelector("#t-host .cb-btn").dataset.label === "복사했어요"`);
		expect(await v.evaluate(`window.__clip`)).toBe("sudo killall trustd");

		await v.evaluate(`(() => { Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }); window.__clip = ""; document.execCommand = c => { window.__clip = c === "copy" ? document.activeElement.value : "?"; return true; }; })()`);
		await v.click("#t-host .cb:nth-of-type(3) .cb-btn");
		await waitFor(v, `document.querySelector("#t-host .cb:nth-of-type(3) .cb-btn").dataset.label === "복사했어요"`);
		expect(await v.evaluate(`window.__clip`)).toContain("ls -la ~/Library && echo");
	}, 30_000);

	test("터미널에서 실행 puts the command in the terminal box without running it; 실행 sends it; the password prompt opens the password box; the password is not kept", async () => {
		const v = await open(390, 844);
		await showSample(v);
		await v.click("#t-host .cb .cb-btn.run");
		await waitFor(v, `SH.alive && document.querySelector(".sh-out").textContent.startsWith("$")`);
		const before = JSON.parse(await v.evaluate(`JSON.stringify({ cmd: document.querySelector(".sh-cmd").value, out: document.querySelector(".sh-out").textContent, pwHidden: document.querySelector(".sh-pw").hidden, title: document.querySelector(".dtitle").textContent })`) as string);
		expect(before.cmd).toBe("sudo killall trustd");
		expect(before.out.trim()).toBe("$");
		expect(before.pwHidden).toBe(true);
		await Bun.write(`${SNAP}/shell-pasted-390.png`, await v.screenshot());

		await v.click(".sh-run");
		await waitFor(v, `document.querySelector(".sh-out").textContent.includes("password for test:") && !document.querySelector(".sh-pw").hidden`);
		const asked = JSON.parse(await v.evaluate(`JSON.stringify({ cmd: document.querySelector(".sh-cmd").value, type: document.querySelector(".sh-pw-in").type, ac: document.querySelector(".sh-pw-in").autocomplete, focused: document.activeElement === document.querySelector(".sh-pw-in"), inForm: !!document.querySelector(".sh-pw-in").closest("form"), sw: document.documentElement.scrollWidth, dlgW: Math.round(document.querySelector("dialog.shell").getBoundingClientRect().width) })`) as string);
		expect(asked).toMatchObject({ cmd: "", type: "password", ac: "off", focused: true, inForm: false, dlgW: 390 });
		expect(asked.sw).toBeLessThanOrEqual(390);
		await Bun.write(`${SNAP}/shell-password-390.png`, await v.screenshot());

		await v.evaluate(`document.querySelector(".sh-pw-in").value = ${JSON.stringify(SECRET)}`);
		await v.click(".sh-pw-send");
		await waitFor(v, `document.querySelector(".sh-out").textContent.includes("PW:")`);
		const after = JSON.parse(await v.evaluate(`JSON.stringify({ out: document.querySelector(".sh-out").textContent, field: document.querySelector(".sh-pw-in").value, hidden: document.querySelector(".sh-pw").hidden, inDom: document.documentElement.outerHTML.includes(${JSON.stringify(SECRET)}), inStorage: JSON.stringify([localStorage, sessionStorage]).includes(${JSON.stringify(SECRET)}) })`) as string);
		expect(after.out).toContain(`PW:${cksum(SECRET)}`);
		expect(after).toMatchObject({ field: "", hidden: true, inDom: false, inStorage: false });
		expect(after.out).not.toContain(SECRET);
		expect(host.subscribe(() => {}).backlog).not.toContain(SECRET);
	}, 45_000);

	test("the password box can also be opened by its key, and closing the terminal leaves the shell running for the next open", async () => {
		const v = await open(390, 844);
		await v.evaluate(`openShell({})`);
		await waitFor(v, `SH.alive`);
		await v.click(".sh-k-pw");
		await waitFor(v, `!document.querySelector(".sh-pw").hidden`);
		await v.click(".sh-k-pw");
		await waitFor(v, `document.querySelector(".sh-pw").hidden`);
		await v.evaluate(`SH.dlg.close()`);
		await waitFor(v, `!document.querySelector("dialog.shell")`);
		expect(host.alive).toBe(true);
	}, 30_000);

	test("on a desktop width the terminal is a sheet, not full screen", async () => {
		const v = await open(1280, 800);
		await showSample(v);
		await v.click("#t-host .cb .cb-btn.run");
		await waitFor(v, `SH.alive`);
		const w = Number(await v.evaluate(`Math.round(document.querySelector("dialog.shell").getBoundingClientRect().width)`));
		expect(w).toBeLessThanOrEqual(760);
		expect(w).toBeGreaterThan(400);
		await Bun.write(`${SNAP}/shell-1280.png`, await v.screenshot());
	}, 30_000);
});
