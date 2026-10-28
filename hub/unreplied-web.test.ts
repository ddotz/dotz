import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeHub, json, waitFor, run, type View } from "./test-web.ts";

// 미답장 in the web app: an orange pill on the item rows and an orange count next to the unread count on the app rows, the app header and the home
// 답변 필요 list, apart from the read/unread badge. Headless (Bun.WebView) against a fake hub. UNREPLIED_SHOTS=<dir> keeps the screenshots.
const SHOTS = process.env.UNREPLIED_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const at = (d: number, h: number, m: number) => Date.UTC(2026, 9, d, h, m);
const iso = (d: number) => new Date(Date.UTC(2026, 9, d, 1, 0)).toISOString();

const YOUTUBE = { key: "youtube", label: "유튜브", icon: "youtube", kind: "app", conv: [], notices: [], unread: 2, unreplied: 2, needs: { drafts: 0, unread: 2, sentToday: 0, unreplied: 2 } };
const MAIL = { key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], unread: 3, unreplied: 1, needs: { drafts: 0, unread: 3, sentToday: 0, unreplied: 1 } };
const KAKAO = { key: "kakao", label: "카카오톡", icon: "kakao", kind: "app", conv: [], notices: [], unread: 0, unreplied: 1, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 1 } };
const mailCard = (unreplied: boolean) => ({ subject: "견적 문의드립니다", from: "민수 <m@example.com>", source: "mail", at: iso(22), summary: "다음 주 견적을 받을 수 있을까요?", suggest: { kind: "reply-draft", label: "답장 초안", ref: "d1", state: "draft" }, ...(unreplied ? { reply: "draft", unreplied: true } : {}) });
const COMMENTS = [
	{ id: "cm:youtube:c1", parent: null, author: "가나", text: "영상 잘 봤어요! 자막은 언제 나와요?", at: at(22, 1, 0), mine: false, needsReply: true, unreplied: true },
	{ id: "cm:youtube:c2", parent: null, author: "다라", text: "다음 영상도 기대할게요", at: at(22, 1, 30), mine: false, needsReply: true, unreplied: true },
	{ id: "cm:youtube:c3", parent: "c1", author: "나", text: "다음 주에 올릴게요", at: at(22, 2, 0), mine: true, needsReply: false, unreplied: false },
];
const PEER = {
	name: "맥미니", url: "http://mini.test", online: true, stale: false,
	items: {
		name: "맥미니", rev: "r1", monitors: [], notices: [], available: [],
		integrations: [{ ...MAIL, unread: 0, unreplied: 2, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 2 } }],
		conversations: [{ target: "mail:peer-1", unread: 0, read: null, mail: mailCard(true), last: { ts: iso(22), text: "견적 문의드립니다", from: "bot" } }],
	},
};

type Req = { method: string; path: string; body?: unknown };
let reqs: Req[] = [];
let waiters: { pred: (r: Req) => boolean; res: (r: Req) => void }[] = [];
beforeEach(() => { reqs = []; waiters = []; });
const record = (r: Req) => { reqs.push(r); waiters = waiters.filter(w => (w.pred(r) ? (w.res(r), false) : true)); };
const expectReq = (pred: (r: Req) => boolean, ms = 4000): Promise<Req> => {
	const have = reqs.find(pred);
	if (have) return Promise.resolve(have);
	return new Promise((res, rej) => {
		const t = setTimeout(() => rej(new Error(`no matching request; got ${JSON.stringify(reqs)}`)), ms);
		waiters.push({ pred, res: r => { clearTimeout(t); res(r); } });
	});
};
const hub = fakeHub({
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/peers") return json([{ name: "맥북", url: `${hub.origin}`, self: true, online: true }, { name: PEER.name, url: PEER.url, self: false, online: true }]);
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/monitoring/peers") return json([PEER]);
		if (p === "/api/integrations") return json({ items: [YOUTUBE, MAIL, KAKAO], available: [] });
		if (p === "/api/conversations") return json({ items: [{ target: "mail:loc-1", unread: 3, read: null, mail: mailCard(true), last: { ts: iso(22), text: "견적 문의드립니다", from: "bot" } }] });
		if (p === "/api/kakao/rooms") return json({ on: true, rooms: [{ chatId: "c1", name: "가족", kind: "group", watched: true, autoDraft: false, unread: 0, unreplied: true, lastAt: at(22, 2, 0) }] });
		if (p === "/api/comments/sources") return json({ on: true, sources: [{ key: "youtube", kind: "youtube", label: "유튜브 댓글", watch: ["*"], autoDraft: false, autoSend: false, error: null, ranAt: at(22, 3, 0) }] });
		if (p === "/api/comments/threads") return json({ threads: [{ source: "youtube", thread: "v1", title: "첫 번째 영상", link: "https://video.example/v1", lastAt: at(22, 2, 0), lastText: "다음 주에 올릴게요", lastAuthor: "나", unread: 2, drafts: 0, unreplied: 2 }] });
		if (p === "/api/comments/thread/youtube/v1") return json({ source: { key: "youtube", kind: "youtube", label: "유튜브 댓글" }, thread: { id: "v1", title: "첫 번째 영상", link: "https://video.example/v1" }, comments: COMMENTS, read: null, drafts: [], sends: [] });
		if (req.method !== "GET") { record({ method: req.method, path: p, ...(p === "/api/peer/proxy" ? { body: await req.json().catch(() => null) } : {}) }); return json({ ok: true }); }
	},
});

const open = (width: number, height: number): Promise<View> => hub.view({ width, height });
afterAll(() => hub.stop());
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const shot = async (v: View, name: string) => { if (SHOTS) await Bun.write(join(SHOTS, name), await v.screenshot()); };
const boot = async (v: View, theme: "light" | "dark", hash: string) => {
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await run(v, `if (dotzTheme.get() !== ${JSON.stringify(theme)}) dotzTheme.toggle()`);
	await waitFor(v, `typeof INTG !== "undefined" && INTG.items.length === 3 && typeof PQ !== "undefined"`);
	await run(v, `${hash}`);
};
const bg = (v: View, sel: string) => q<string>(v, `return getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor`);

for (const [width, height] of [[390, 844], [1280, 800]] as const) {
	describe(`app list at ${width}px`, async () => {
		const v = await open(width, height);
		test("each app row shows the unread count and the orange 미답장 count apart; an app with only 미답장 has no unread badge", async () => {
			await boot(v, "light", `go("monitoring")`);
			await waitFor(v, `current === "monitoring" && document.querySelector('#mon-side .cv-row[data-k="i:youtube"]') && document.querySelector('#mon-side .cv-row[data-k^="p:"]')`);
			const rows = await q<Record<string, { nb: string[]; unreplied: string[] }>>(v, `const out = {}; for (const r of document.querySelectorAll("#mon-side .cv-row[data-k]")) out[r.dataset.k.replace(/^p:.*\\|/, "peer:")] = { nb: [...r.querySelectorAll(".nb:not(.unreplied)")].map(n => n.textContent), unreplied: [...r.querySelectorAll(".nb.unreplied")].map(n => n.textContent) }; return out;`);
			expect(rows["i:youtube"]).toEqual({ nb: ["2"], unreplied: ["미답장 2"] });
			expect(rows["i:mail"]).toEqual({ nb: ["3"], unreplied: ["미답장 1"] });
			expect(rows["i:kakao"]).toEqual({ nb: [], unreplied: ["미답장 1"] });
			expect(rows["peer:i:mail"]!.unreplied).toEqual(["미답장 2"]);
			expect(await bg(v, '#mon-side .nb.unreplied')).toBe("rgb(194, 65, 12)");
			expect(await q<boolean>(v, `return document.documentElement.scrollWidth <= ${width}`)).toBe(true);
			await shot(v, `app-list-${width}-light.png`);
		});
		test("dark theme keeps both badges apart and readable", async () => {
			await boot(v, "dark", `go("monitoring")`);
			await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:youtube"] .nb.unreplied')`);
			expect(await bg(v, '#mon-side .nb.unreplied')).toBe("rgb(255, 154, 77)");
			expect(await bg(v, '#mon-side .cv-row[data-k="i:youtube"] .nb:not(.unreplied)')).not.toBe("rgb(255, 154, 77)");
			await shot(v, `app-list-${width}-dark.png`);
		});
	});

	describe(`comments list at ${width}px`, async () => {
		const v = await open(width, height);
		test("the post row has the unread count and 미답장; the app header and the comment bubbles show the pill and 답장 안 함", async () => {
			await boot(v, "light", `go("monitoring", "i:youtube")`);
			await waitFor(v, `!$("#cm").hidden && CM.loaded && document.querySelector("#cm .kk-row")`);
			const row = await q<{ nb: string; unreplied: string }>(v, `const r = document.querySelector("#cm .kk-row"); return { nb: r.querySelector(".nb:not(.unreplied)").textContent, unreplied: r.querySelector(".nb.unreplied").textContent }`);
			expect(row).toEqual({ nb: "2", unreplied: "미답장 2" });
			expect(await q<string>(v, `return document.querySelector("#mon-head .tag.unreplied").textContent`)).toBe("미답장 2");
			await shot(v, `comments-list-${width}-light.png`);

			await run(v, `document.querySelector("#cm .kk-row").click()`);
			await waitFor(v, `CM.open && !CM.loading && document.querySelectorAll("#cm .kk-m.in .tag.unreplied").length === 2`);
			expect(await q<string[]>(v, `return [...document.querySelectorAll("#cm .kk-m .unrep-no")].map(b => b.textContent)`)).toEqual(["답장 안 함", "답장 안 함"]);
			expect(await q<number>(v, `return document.querySelectorAll("#cm .kk-m.me .tag.unreplied").length`)).toBe(0);
			await shot(v, `comments-thread-${width}-light.png`);

			// the pill and the button leave at the tap, before the request answers
			expect(await q<boolean>(v, `const b = document.querySelector("#cm .unrep-no"); b.click(); return b.hidden`)).toBe(true);
			await expectReq(r => r.method === "POST" && decodeURIComponent(r.path) === "/api/comments/comment/cm:youtube:c1/no-reply");
		});
	});
}

describe("home and the peer's mail", async () => {
	const v = await open(390, 844);
	test("the home 답변 필요 list counts 미답장 apart from unread", async () => {
		await boot(v, "light", `go("home")`);
		await waitFor(v, `current === "home" && PQ.loaded && document.querySelectorAll("#home-now .hr .hs.unreplied").length === 4`);
		const t = await q<{ head: string; rows: string[] }>(v, `return { head: document.querySelector("#home-now .hn-h .tag.unreplied").textContent, rows: [...document.querySelectorAll("#home-now .hr .hs.unreplied")].map(n => n.textContent) }`);
		expect(t.head).toBe("미답장 6");
		expect(t.rows).toEqual(["미답장 2", "미답장 1", "미답장 1", "미답장 2"]);
		await shot(v, "home-390-light.png");
	});
	test("a peer's mail card carries the pill, and 답장 안 함 goes to that computer", async () => {
		await boot(v, "light", `go("monitoring")`);
		await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k^="p:"][data-k$="i:mail"]')`);
		await run(v, `document.querySelector('#mon-side .cv-row[data-k^="p:"][data-k$="i:mail"]').click()`);
		await waitFor(v, `document.querySelector("#mon-tl .mr .tag.unreplied")`);
		// 초안 작성 sits beside 답장 안 함 and asks the computer that holds the mail for the draft
		await run(v, `document.querySelector("#mon-tl .mr .mr-draft").click()`);
		const asked = await expectReq(r => r.method === "POST" && r.path === "/api/peer/proxy" && (r.body as { action?: string })?.action === "mail-draft");
		expect(asked.body).toMatchObject({ action: "mail-draft", args: { key: "peer-1" } });
		await run(v, `document.querySelector('#mon-tl .mr [data-k="mail-no"]').click()`);
		const sent = await expectReq(r => r.method === "POST" && r.path === "/api/peer/proxy" && (r.body as { action?: string })?.action === "fyi");
		expect(sent.body).toMatchObject({ action: "fyi", args: { key: "peer-1", on: true } });
	});
});
