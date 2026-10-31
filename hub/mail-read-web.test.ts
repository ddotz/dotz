// Reading a mail marks it read in dotz itself (owner 2026-10-27): opening a mail's conversation and leaving it - 뒤로가기, or closing the page -
// leaves it read in the list, the 안 읽음 chip and its filter, and after a reload; a newer message of that mail makes it unread again. The read
// position is dotz's own (POST /api/read, hub/reads.ts), never the real mailbox's flag. A peer's mail is read on the computer that holds it
// (one forwarded read, /api/peer/act), and nothing is posted here. Headless (Bun.WebView) against a fake hub.
// Screenshots go to MAIL_READ_SHOTS (default /tmp/dotz-mail-read): the list before and after reading at 390 and 1280.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sseResponse } from "./events.ts";
import { appAsset, indexPage } from "./webapp.ts";

const SHOTS = process.env.MAIL_READ_SHOTS ?? "/tmp/dotz-mail-read";
mkdirSync(SHOTS, { recursive: true });
const MINI = "http://mini.test";
const json = (v: unknown) => Response.json(v);
const iso = (h: number) => new Date(Date.UTC(2026, 9, 27, h, 0)).toISOString();

// The local mail: two mails, the first unread. Reading is a position this fake hub keeps (like reads.json), and the unread count follows it.
type Mail = { key: string; subject: string; from: string; unread: number; at: string };
const mails: Mail[] = [
	{ key: "fx-a", subject: "견적 요청", from: "Kim <kim@example.com>", unread: 1, at: iso(9) },
	{ key: "fx-b", subject: "회의록 공유", from: "Lee <lee@example.com>", unread: 0, at: iso(8) },
];
const card = (m: Mail) => ({ subject: m.subject, from: m.from, source: "kdb", at: m.at, summary: `${m.subject}에 대한 내용이에요.` });
// A mail long enough to scroll: it opens at its top, so being on screen - not being at the bottom - is what reading it means.
const BODY = Array.from({ length: 80 }, (_, i) => `본문 ${i + 1}번째 문단입니다. 견적과 일정을 확인해 주세요.`).join("\n\n");
const history = (m: Mail) => [{ kind: "mail", ts: m.at, conv: `mail:${m.key}`, target: `mail:${m.key}`, subject: m.subject, from: m.from, source: "kdb", html: false, text: `[mail] ${m.subject}\n\n${BODY}\n\n감사합니다.` }];
const readPosts: { target: string; ts: string }[] = [];
const acts: { action: string; args: Record<string, unknown> }[] = [];

// The other computer's mail, seen from this page as a peer item.
const PEER_T = "mail:px-1";
const peerMail = { key: "px-1", subject: "견적 문의", from: "Lee <lee@example.com>", source: "kdb", at: iso(7), summary: "이번 주까지 견적을 받고 싶어요." };
const app = (unread: number) => ({ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], unread, needs: { drafts: 0, unread, sentToday: 0, unreplied: 0 } });
let peers: unknown[] = [];
const peer = () => ({ name: "맥미니", url: MINI, online: true, stale: false, items: peerItems() });
const peerItems = () => ({ name: "맥미니", rev: "p1", monitors: [], notices: [], available: [], integrations: [app(1)],
	conversations: [{ target: PEER_T, unread: 1, read: null, mail: peerMail, last: { ts: peerMail.at, text: peerMail.subject, from: "bot" } }] });
const unreadLocal = () => mails.reduce((c, m) => c + m.unread, 0);
// Each test starts from the same mail set (the fake hub keeps no state between them).
const reset = (list: Mail[] = [
	{ key: "fx-a", subject: "견적 요청", from: "Kim <kim@example.com>", unread: 1, at: iso(9) },
	{ key: "fx-b", subject: "회의록 공유", from: "Lee <lee@example.com>", unread: 0, at: iso(8) },
]) => { mails.splice(0, mails.length, ...list); readPosts.length = 0; acts.length = 0; peers = []; };

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url), p = url.pathname;
		if (p === "/") return indexPage(req);
		const asset = appAsset(req, p);
		if (asset) return asset;
		if (p === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
		if (p === "/api/state") return json({ name: "dotz", orchestrator: { status: "idle" }, lanes: [], terminals: {}, channels: { work: [] }, discord: {}, notices_unread: 0 });
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/monitors") return json({ items: [] });
		if (p === "/api/machine") return json({ name: "맥북", custom: "", default: "맥북" });
		if (p === "/api/peers") return json([{ name: "맥북", url: `http://127.0.0.1:${server.port}`, self: true, online: true }]);
		if (p === "/api/monitoring/peers") return json(peers);
		if (p === "/api/integrations") return json({ items: [app(unreadLocal())], available: [] });
		if (p === "/api/conversations") return json({ items: mails.map(m => ({ target: `mail:${m.key}`, unread: m.unread, read: null, mail: card(m), last: { ts: m.at, text: m.subject, from: "bot" } })) });
		if (p === "/api/history") {
			const t = url.searchParams.get("target") ?? "", m = mails.find(x => `mail:${x.key}` === t);
			return json({ target: t, events: m ? history(m) : [] });
		}
		if (p === "/api/activity") return json({ items: [] });
		if (p === "/api/read" && req.method === "POST") {
			const b = (await req.json()) as { target: string; ts: string };
			readPosts.push(b);
			const m = mails.find(x => `mail:${x.key}` === b.target);
			if (m && Date.parse(b.ts) >= Date.parse(m.at)) m.unread = 0;
			return json({ ok: true, target: b.target, ts: b.ts, moved: true });
		}
		if (p === "/api/peer/proxy") {
			const pp = url.searchParams.get("p") ?? "";
			if (req.method === "POST") { acts.push((await req.json()) as (typeof acts)[number]); return json({ ok: true }); }
			if (pp.startsWith("/api/history")) return json({ target: PEER_T, events: [{ kind: "mail", ts: peerMail.at, conv: PEER_T, target: PEER_T, subject: peerMail.subject, from: peerMail.from, source: "kdb", text: `[mail] ${peerMail.subject}\n\n${BODY}` }] });
			return json({});
		}
		return p.startsWith("/api/") ? json({}) : new Response("not found", { status: 404 });
	},
});

type View = InstanceType<typeof Bun.WebView>;
const views: View[] = [];
afterAll(() => { for (const v of views) v.close(); server.stop(true); });
const waitFor = (v: View, expr: string, ms = 10_000) =>
	v.evaluate(`new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + ${JSON.stringify(expr)})), ${ms}); const tick = () => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearTimeout(t); res(true); } else requestAnimationFrame(tick); }; tick(); })`);
const q = async <T = unknown>(v: View, code: string): Promise<T> => JSON.parse((await v.evaluate(`JSON.stringify((() => { ${code} })())`)) as string) as T;
const run = (v: View, code: string) => v.evaluate(`(() => { ${code} })(), 0`);
// A bounded wait for an answer the page posts to the fake hub (no fixed sleep decides anything).
const until = async (ok: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error("timeout waiting for the hub"); await Bun.sleep(20); } };

async function boot(width: number, height: number, key: string): Promise<View> {
	const v = new Bun.WebView({ width, height });
	views.push(v);
	await v.navigate(`http://127.0.0.1:${server.port}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && S`);
	await run(v, `if (dotzTheme.get() === "dark") dotzTheme.toggle()`);
	await waitFor(v, `typeof INTG !== "undefined" && INTG.items.length === 1 && CONV.has("mail:fx-b") && PQ.loaded`);
	await run(v, `go("monitoring", ${JSON.stringify(key)})`);
	return v;
}
const openMail = async (v: View, subject: string) => {
	await waitFor(v, `[...document.querySelectorAll("#mon-tl .mr .rc-title")].some(t => t.textContent === ${JSON.stringify(subject)})`);
	await run(v, `[...document.querySelectorAll("#mon-tl .mr")].find(r => r.querySelector(".rc-title").textContent === ${JSON.stringify(subject)}).click()`);
};
// The list as the owner sees it: the filter chips, each row's tags and the filter's rows.
const seen = (v: View) => q<{ chips: string[]; states: Record<string, string>; rows: string[]; empty: string }>(v, `return {
	chips: [...document.querySelectorAll("#mon-tl .mr-f")].map(b => b.textContent),
	states: Object.fromEntries([...document.querySelectorAll("#mon-tl .mr")].map(r => [r.querySelector(".rc-title").textContent, [...r.querySelectorAll(".rc-hd .tag")].map(t => t.textContent).join("|")])),
	rows: [...document.querySelectorAll("#mon-tl .mr .rc-title")].map(t => t.textContent),
	empty: document.querySelector("#mon-tl .empty")?.textContent ?? "" }`);
const pick = async (v: View, f: string) => {
	await run(v, `document.querySelector('#mon-tl .mr-f[data-filter="${f}"]').click()`);
	await waitFor(v, `document.querySelector('#mon-tl .mr-f.on').dataset.filter === ${JSON.stringify(f)}`);
};
const backToList = async (v: View, key: string) => {
	await run(v, `go("monitoring", ${JSON.stringify(key)})`);
	await waitFor(v, `current === "monitoring" && document.querySelectorAll("#mon-tl .mr").length > 0`);
};

describe.each([[390, 844], [1280, 900]] as const)("reading a mail at %ipx", (width, height) => {
	test("opening it marks it read here: back shows 읽음, the chip and the filter follow, and it stays read after a reload", async () => {
		reset();
		const v = await boot(width, height, "i:mail");
		await waitFor(v, `document.querySelectorAll("#mon-tl .mr").length === 2`);
		const before = await seen(v);
		expect(before.chips).toEqual(["전체", "안 읽음1", "답장 필요", "확인 대기", "답장함", "보낸 메일"]);
		expect(before.states["견적 요청"]).toBe("안 읽음");
		await Bun.write(join(SHOTS, `list-before-${width}.png`), await v.screenshot());

		await openMail(v, "견적 요청");
		await waitFor(v, `current === "chat" && target === "mail:fx-a" && CV.placed`);
		// the page posted the read position once, for this mail, at its newest message
		await until(() => readPosts.length > 0);
		expect(readPosts).toEqual([{ target: "mail:fx-a", ts: iso(9) }]);
		await waitFor(v, `ts("mail:fx-a").unread === 0`);

		await backToList(v, "i:mail");
		const after = await seen(v);
		expect(after.states["견적 요청"]).toBe("");
		expect(after.chips).toEqual(["전체", "안 읽음", "답장 필요", "확인 대기", "답장함", "보낸 메일"]);
		expect(await q<boolean>(v, `return document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
		await pick(v, "unread");
		expect(await q<string[]>(v, `return [...document.querySelectorAll("#mon-tl .mr .rc-title")].map(t => t.textContent)`)).toEqual([]);
		await Bun.write(join(SHOTS, `list-after-${width}.png`), await v.screenshot());

		// a reload starts from what the hub holds (reads.json): still read
		const again = await boot(width, height, "i:mail");
		await waitFor(again, `document.querySelectorAll("#mon-tl .mr").length === 2`);
		expect((await seen(again)).states["견적 요청"]).toBe("");
		expect((await seen(again)).chips).toContain("안 읽음");
		expect(readPosts).toHaveLength(1);
	}, 30_000);
});

test("a newer message of that mail makes it unread again", async () => {
	reset([{ key: "fx-a", subject: "견적 요청", from: "Kim <kim@example.com>", unread: 0, at: iso(9) },
		{ key: "fx-b", subject: "회의록 공유", from: "Lee <lee@example.com>", unread: 0, at: iso(8) }]);
	const v = await boot(390, 844, "i:mail");
	await waitFor(v, `document.querySelectorAll("#mon-tl .mr").length === 2`);
	expect((await seen(v)).states["견적 요청"]).toBe("");

	// the mail's thread got a newer mail (a reply to it): the position stays, the new message sits after it
	mails[0] = { key: "fx-a", subject: "Re: 견적 요청", from: "Kim <kim@example.com>", unread: 1, at: iso(11) };
	const next = await boot(390, 844, "i:mail");
	await waitFor(next, `document.querySelectorAll("#mon-tl .mr").length === 2`);
	expect((await seen(next)).states["Re: 견적 요청"]).toBe("안 읽음");
	expect((await seen(next)).chips).toContain("안 읽음1");
}, 30_000);

test("a peer's mail is read on the computer that holds it, once, and this page never posts the read itself", async () => {
	reset();
	peers = [peer()];
	const v = await boot(390, 844, `p:${MINI}|i:mail`);
	await waitFor(v, `document.querySelectorAll("#mon-tl .mr").length === 1`);
	expect((await seen(v)).states).toEqual({ "견적 문의": "안 읽음" });
	expect((await seen(v)).chips).toContain("안 읽음1");

	await openMail(v, "견적 문의");
	await waitFor(v, `current === "chat" && target === ${JSON.stringify(PEER_T)} && CV.placed`);
	await until(() => acts.length > 0);
	expect(acts).toEqual([{ action: "read", args: { target: "mail:px-1", ts: iso(7) } }]);
	expect(readPosts).toEqual([]);
	await waitFor(v, `ts(${JSON.stringify(PEER_T)}).unread === 0`);

	await backToList(v, `p:${MINI}|i:mail`);
	const after = await seen(v);
	expect(after.states["견적 문의"]).not.toBe("안 읽음");
	expect(after.chips).toContain("안 읽음");
}, 30_000);
