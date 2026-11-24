import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeHub, json, waitFor, run, type View } from "./test-web.ts";

type Put = { path: string; body: Record<string, unknown> };
let puts: Put[] = [];
let saved = Promise.withResolvers<void>();
let mailItems: Record<string, unknown>[] = [];
let mailApp: string | null = null;

const mailInstance = (key: string, label: string, state: "connected" | "disconnected") => ({ key, app: "mail", label, kind: "app", icon: "mail", conv: [], notices: [], unread: 0, state });
const reset = () => { puts = []; saved = Promise.withResolvers<void>(); mailItems = [mailInstance("mail", "메일", "connected"), mailInstance("mail-work", "회사 메일", "connected"), mailInstance("mail-old", "예전 메일", "disconnected")]; mailApp = null; };

const hub = fakeHub({
	stream: "fake",
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/history") return json({ target: url.searchParams.get("target"), events: [] });
		if (p === "/api/activity") return json({ items: [], more: false, history: false });
		if (p === "/api/conversations") return json({ items: [] });
		if (p === "/api/notices") return json({ unread: 0, items: [] });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/reply/queue") return json({ items: [], counts: {}, triageMin: 1, undoSec: 10 });
		if (p === "/api/integrations") return json({ items: [{ key: "youtube", app: "youtube", label: "유튜브", icon: "youtube", kind: "app", conv: [], notices: [], unread: 0, needs: { drafts: 0, unread: 0, sentToday: 0 } }, ...mailItems], available: [] });
		if (p === "/api/integrations/youtube/settings") return json({ fields: [] });
		if (p === "/api/comments/threads") return json({ threads: [] });
		if (p === "/api/comments/sources" && req.method === "GET")
			return json({ on: true, sources: [{ key: "youtube", kind: "youtube", app: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, autoSend: false, autoMail: true, mailApp, error: null, ranAt: 0 }] });
		if (p === "/api/comments/sources/youtube" && req.method === "PUT") {
			const body = (await req.json()) as Record<string, unknown>;
			puts.push({ path: p, body });
			saved.resolve();
			if (typeof body.mailApp === "string") mailApp = body.mailApp || null;
			return json({ ok: true });
		}
	},
});
afterAll(() => { hub.stop(); });
beforeEach(reset);

const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const openSheet = async (v: View) => {
	const opened = hub.nextStream();
	await v.navigate(`${hub.origin}/`);
	await opened;
	await waitFor(v, `typeof CM !== "undefined" && CM.apps.has("youtube") && INTG.loaded`);
	await run(v, `cmPickOpen("youtube")`);
	await waitFor(v, `document.querySelector('#cm-pick[open] .kk-pick-src [data-k="mail"]')`);
};
const row = (v: View) => q<{ label: string; disabled: boolean; shown: string; hint: string }>(v, `
	const r = document.querySelector('#cm-pick [data-setting="mail-app"]'), b = r.querySelector("button.sel");
	return { label: r.querySelector(".cv-n").textContent, disabled: b.disabled, shown: b.querySelector(".val").textContent, hint: (r.querySelector(".kk-note") || {}).textContent || "" }`);

describe("댓글 출처의 메일 앱", async () => {
	const v = await hub.view({ width: 390, height: 844 });

	test("picking a connected mail app saves it for the source, and the sheet shows it afterwards", async () => {
		await openSheet(v);
		expect(await row(v)).toEqual({ label: "메일 앱", disabled: false, shown: "없음", hint: "" });
		await run(v, `document.querySelector('#cm-pick [data-setting="mail-app"] button.sel').click()`);
		const items = await q<string[]>(v, `return [...document.querySelectorAll(".menu .mi .ml")].map(n => n.textContent)`);
		expect(items).toEqual(["없음", "메일", "회사 메일"]);
		await run(v, `[...document.querySelectorAll(".menu .mi")].find(n => n.textContent.includes("회사 메일")).click()`);
		await waitFor(v, `document.querySelector('#cm-pick [data-setting="mail-app"] .val').textContent === "회사 메일"`);
		await saved.promise;
		expect(puts).toEqual([{ path: "/api/comments/sources/youtube", body: { mailApp: "mail-work" } }]);
	});

	test("with no mail app connected the choice is disabled and says why, and nothing is saved", async () => {
		mailItems = [mailInstance("mail", "메일", "disconnected")];
		await openSheet(v);
		const r = await row(v);
		expect(r.disabled).toBe(true);
		expect(r.hint).toBe("연결된 메일 앱이 없어요. 메일 앱을 먼저 연결해 주세요.");
		await run(v, `document.querySelector('#cm-pick [data-setting="mail-app"] button.sel').click()`);
		expect(await q(v, `return document.querySelectorAll(".menu").length`)).toBe(0);
		expect(puts).toEqual([]);
	});

	test("another computer's source shows no mail app choice: this computer's mail apps are not that computer's", async () => {
		await openSheet(v);
		const shown = await q<{ local: boolean; peer: boolean }>(v, `
			const s = CM.sources[0], local = !!cmSourceNode(s).querySelector('[data-setting="mail-app"]');
			CM.pc = "other-pc";
			try { return { local, peer: !!cmSourceNode(s).querySelector('[data-setting="mail-app"]') }; } finally { CM.pc = null; }`);
		expect(shown).toEqual({ local: true, peer: false });
	});
});
