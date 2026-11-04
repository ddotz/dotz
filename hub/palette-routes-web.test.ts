// Walks the whole command palette and the old and unknown addresses at phone and desktop width. Once the page has loaded no data request is
// answered (the page's own fetch hangs; hanging them on the server would use up the browser's connections), so a screen that stays empty until its data arrives fails here; /api/command only checks the name, so no command does anything.
import { afterAll, describe, expect, test } from "bun:test";
import { COMMANDS, parseCommand } from "./control.ts";
import { ev, fakeHub, idleState, run, waitFor, type View } from "./test-web.ts";

const STATE = idleState({ desk: { on: true }, lanes: [
	{ name: "api", status: "working", model: "anthropic/claude-opus-5-5", startedAt: "2026-11-01T00:00:00Z" },
	{ name: "old-work", status: "exited", model: "anthropic/claude-opus-5-5", startedAt: "2026-10-01T00:00:00Z" },
] });
const posted: string[] = [];
const hub = fakeHub({
	state: STATE,
	api: async (req, url) => {
		if (url.pathname === "/custom.js") return new Response("", { headers: { "Content-Type": "text/javascript" } });
		if (url.pathname === "/api/command") {
			const text = String(((await req.json()) as { text?: string }).text ?? "");
			posted.push(text);
			const title = parseCommand(text) ? "됨" : `없는 명령: ${text}`;
			return Response.json({ ok: true, output: title, card: { title, facts: [], text: title } });
		}
		if (url.pathname === "/api/state" || url.pathname === "/api/events") return undefined;
		return url.pathname.startsWith("/api/") ? Response.json({ error: "not yet" }, { status: 503 }) : undefined;
	},
});
afterAll(() => hub.stop());

const HELPERS = `const realFetch = fetch; window.fetch = (u, o) => (String(u).includes("/api/command") ? realFetch(u, o) : new Promise(() => {}));
	history.pushState = history.replaceState = () => {};   // the walk moves faster than the browser's limit of 100 calls in 10 s
	window.__errs = []; addEventListener("error", e => __errs.push(e.message));
	window.__hit = []; openScreen = () => __hit.push("screen"); openShell = o => __hit.push("shell:" + ((o && o.command) || ""));
	window.__seen = () => { const secs = [...document.querySelectorAll("#views > .view")].filter(s => !s.hidden);
		return { current, hash: location.hash, title: document.querySelector("#title").textContent.trim(), text: secs.map(s => s.innerText.trim()).join("").length, wide: document.documentElement.scrollWidth, errs: __errs }; };
	window.__palette = q => { document.querySelectorAll("dialog").forEach(d => d.open && d.close()); document.querySelectorAll("dialog.pal").forEach(d => d.remove()); openPalette();
		const i = document.querySelector(".pal-in"); i.value = q; i.dispatchEvent(new Event("input"));
		return [...document.querySelectorAll(".pal-list .pal-i")].map(n => ({ cmd: n.classList.contains("cmd"), nm: n.querySelector(".nm").textContent })); };`;
type Row = { cmd: boolean; nm: string };
type Seen = { current: string; hash: string; title: string; text: number; wide: number; errs: string[] };
const pages = new Map<number, View>();
const open = async (width: number): Promise<View> => {
	const had = pages.get(width);
	if (had) return had;
	const v = await hub.view({ width, height: 844 }, "/");
	await waitFor(v, `typeof openPalette === "function" && S && S.lanes.length === 2`);
	await run(v, HELPERS);
	pages.set(width, v);
	return v;
};
const rows = (v: View, q: string) => ev<Row[]>(v, `__palette(${JSON.stringify(q)})`);
const clickRow = (v: View, q: string, i: number) => run(v, `__palette(${JSON.stringify(q)}); document.querySelectorAll(".pal-list .pal-i")[${i}].click();`);
const seen = (v: View) => ev<Seen>(v, `__seen()`);
const expectScreen = (s: Seen, width: number, what: string) => {
	expect({ what, errs: s.errs }).toEqual({ what, errs: [] });
	expect({ what, title: s.title.length > 0, drawn: s.text > 0, fits: s.wide <= width }).toEqual({ what, title: true, drawn: true, fits: true });
};

// Old and unknown addresses, and the screen each must land on. A view not named here is covered by the palette walk.
const ROUTES: [string, string][] = [
	["", "home"], ["nosuch", "home"], ["nosuch/x", "home"], ["%E0%A4%A", "home"], ["__proto__", "home"], ["apps", "home"],
	["providers", "accounts"], ["provider", "accounts"], ["provider/anthropic", "accounts"], ["settings/accounts", "accounts"], ["accounts/nope", "accounts"],
	["lanes", "chat"], ["activity", "chat"], ["chat/nope", "chat"], ["chat/alert", "notices"], ["activity/alert", "notices"],
	["monitoring/nope", "monitoring"], ["monitoring/c:nope", "monitoring"], ["monitoring/i:kakao", "monitoring"],
	["settings/nope", "settings"], ["usage/x", "usage"], ["harness/project/nope", "harness"], ["project", "projects"],
];

for (const width of [412, 1280]) describe(`command palette at ${width}px`, () => {
	test("every 도구 row lands on the screen it names, and that screen is drawn", async () => {
		const v = await open(width);
		const list = (await rows(v, "")).filter(r => !r.cmd);
		const screens = list.filter(r => !/^(끝난 세션|터미널 열기|화면 공유 열기|.+ 모드로 전환)/.test(r.nm));
		expect(screens.length).toBeGreaterThan(15);
		for (const r of screens) {
			await clickRow(v, "", list.indexOf(r));
			const s = await seen(v);
			expect({ row: r.nm, title: await ev(v, `titles[current]`) }).toEqual({ row: r.nm, title: r.nm });
			expectScreen(s, width, r.nm);
		}
	}, 60_000);

	test("the rows that are not screens do what they say", async () => {
		const v = await open(width);
		await run(v, `__hit.length = 0`);
		const list = await rows(v, "");
		const at = (re: RegExp) => list.findIndex(r => re.test(r.nm));
		await clickRow(v, "", at(/^끝난 세션 1$/));
		expect(await ev(v, `[current, endedOpen]`)).toEqual(["chat", true]);
		await clickRow(v, "", at(/^터미널 열기$/));
		await clickRow(v, "", at(/^화면 공유 열기$/));
		expect(await ev(v, `__hit`)).toEqual(["shell:", "screen"]);
		const next = await ev<string>(v, `themeNext()`);
		await clickRow(v, "", at(/모드로 전환$/));
		expect(await ev(v, `themeNext()`)).not.toBe(next);
	}, 60_000);

	test("every command row either runs a command the gateway knows or asks for what it needs", async () => {
		const v = await open(width);
		const shown = await rows(v, "/");
		expect(shown.every(r => r.cmd)).toBe(true);
		for (const [i, r] of shown.entries()) {
			posted.length = 0;
			await clickRow(v, "/", i);
			const needs = await ev<boolean>(v, `document.querySelector(".pal-in")?.value === ${JSON.stringify(`${r.nm} `)}`);
			if (needs) { expect({ row: r.nm, posted }).toEqual({ row: r.nm, posted: [] }); continue; }
			await waitFor(v, `document.querySelector(".pal-out .pal-rt")?.textContent === "됨" || document.querySelector(".pal-out .pal-rt")?.textContent.startsWith("없는")`);
			expect({ row: r.nm, posted, title: await ev(v, `document.querySelector(".pal-out .pal-rt").textContent`) }).toEqual({ row: r.nm, posted: [r.nm], title: "됨" });
		}
	}, 60_000);

	test("old and unknown addresses land on a drawn screen", async () => {
		const v = await open(width);
		for (const [hash, view] of ROUTES) {
			await run(v, `const h = parseHash(${JSON.stringify(`#${hash}`)}); go(h.view || "home", h.t);`);
			const s = await seen(v);
			expect({ hash, view: s.current }).toEqual({ hash, view });
			expectScreen(s, width, `#${hash}`);
		}
	}, 60_000);
});

describe("command list", () => {
	test("the palette and the gateway list the same commands, and only /terminal and /screen stay in the page", async () => {
		const v = await open(1280);
		const list = await ev<string[]>(v, `CMDS.map(x => x.c)`);
		expect(new Set(list).size).toBe(list.length);
		expect(list.filter(c => !parseCommand(c)).sort()).toEqual(["/screen", "/terminal"]);
		expect(COMMANDS.filter(c => !list.includes(`/${c}`))).toEqual([]);
	}, 60_000);

	test("one row per job: no label twice, and a command a screen replaced finds that screen", async () => {
		const v = await open(1280);
		const names = (await rows(v, "")).map(r => r.nm);
		expect(new Set(names).size).toBe(names.length);
		for (const c of ["/context", "/quota", "/providers", "/terminal"]) expect(names).not.toContain(c);
		for (const [q, nm] of [["컨텍스트", "컨텍스트"], ["quota", "사용량"], ["공급자", "계정"], ["provider", "계정"], ["터미널", "터미널 열기"]] as const) expect((await rows(v, q)).map(r => r.nm)).toContain(nm);
	}, 60_000);

	test("a command that needs a choice lists the choices, and nothing runs until one is picked", async () => {
		const v = await open(412);
		posted.length = 0;
		await run(v, `__palette("/stop "); document.querySelector(".pal-in").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));`);
		expect(posted).toEqual([]);
		expect(await ev(v, `[...document.querySelectorAll(".pal-list .pal-i .nm")].map(n => n.textContent)`)).toEqual(["/stop api"]);
		await run(v, `document.querySelector(".pal-list .pal-i").click();`);
		await waitFor(v, `document.querySelector(".pal-out .pal-rt")?.textContent === "됨"`);
		expect(posted).toEqual(["/stop api"]);
	}, 60_000);

	test("a typed /terminal command opens the terminal instead of reaching the gateway", async () => {
		const v = await open(1280);
		posted.length = 0;
		await run(v, `__hit.length = 0`);
		await run(v, `__palette("/terminal ls -l"); document.querySelector(".pal-in").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));`);
		expect(await ev(v, `__hit`)).toEqual(["shell:ls -l"]);
		expect(posted).toEqual([]);
	}, 60_000);
});
