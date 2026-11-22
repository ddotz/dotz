import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { blockText } from "./limit-alert.ts";
import { fakeHub, idleState, json, on } from "./test-web.ts";

const SHOTS = process.env.LOGIN_OPEN_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const AT = new Date(Date.now() - 600_000).toISOString();
const STOP = `땃쥐: ${blockText("auth", "anthropic", "anthropic", 1_800_000)}`;
const alert = (id: string, text: string, extra: object = {}) => ({ id, kind: "alert", tone: "", cls: "alert", title: "알림", text, open: "alert", src: "alert", by: "gateway", read: false, ts: AT, updated: AT, at: AT, handled: null, ...extra });
const calls: string[] = [];

const hub = fakeHub({
	state: () => idleState({ notices_unread: 2 }),
	api: (req, url) => {
		if (url.pathname === "/api/notices") return json({ unread: 1, items: [alert("stop", STOP, { waits: "login", login: "anthropic" }), alert("done", STOP, { read: true, handled: AT })] });
		if (url.pathname === "/api/providers") return json({ providers: [{ id: "anthropic", name: "Anthropic", auth: "none", in_use: false, can_login: true }], addable: [] });
		if (url.pathname === "/api/providers/anthropic/login") {
			calls.push(req.method);
			return req.method === "POST" ? json({ login_id: "l1", url: "https://example.com/oauth" }) : json({});
		}
	},
});
afterAll(() => hub.stop());

const settled = `document.getAnimations().every(a => a.playState !== "running")`;
for (const width of [390, 1280]) {
	test(`${width}px: the stop of a provider whose login dropped opens a sheet whose 로그인 열기 starts that provider's login`, async () => {
		calls.length = 0;
		const view = await hub.view({ width, height: 844 }, "/#notices");
		const { waitFor, ev, run } = on(view);
		await waitFor(`NT.loaded && $('#v-notices .nsc-r[data-nid="stop"] .nsc-tx')`);
		await run(`$('#v-notices .nsc-r[data-nid="stop"] .nsc-tx').click();`);
		await waitFor(`document.querySelector('.fs-ft [data-k="login"]')`);
		expect(await ev<string>(`document.querySelector('.fs-ft [data-k="login"]').textContent`)).toBe("로그인 열기");
		expect(await ev<string>(`document.querySelector(".fs-body").textContent`)).not.toContain("/login");
		await waitFor(settled);
		if (SHOTS) await Bun.write(join(SHOTS, `login-sheet-${width}.png`), await view.screenshot());
		await run(`document.querySelector('.fs-ft [data-k="login"]').click();`);
		await waitFor(`document.querySelector("dialog[open] a[href='https://example.com/oauth']")`);
		expect(calls).toContain("POST");
		await waitFor(settled);
		if (SHOTS) await Bun.write(join(SHOTS, `login-dialog-${width}.png`), await view.screenshot());
		hub.release();
	}, 30_000);
}

test("a stop that was handled opens the conversation, with no login button", async () => {
	const view = await hub.view({ width: 390, height: 844 }, "/#notices");
	const { waitFor, ev, run } = on(view);
	await waitFor(`NT.loaded`);
	await run(`noticeOpen(NT.items.find(n => n.id === "done"));`);
	await waitFor(`current === "chat"`);
	expect(await ev<number>(`document.querySelectorAll('.fs-ft [data-k="login"]').length`)).toBe(0);
	hub.release();
}, 30_000);
