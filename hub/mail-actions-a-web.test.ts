import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { advanceTimers, ev, fakeHub, inbox, json, run, waitFor, type View } from "./test-web.ts";

const SHOTS = process.env.MAIL_A_SHOTS ?? "";
const CAN = ["read", "unread", "archive", "unarchive", "trash", "star", "unstar"];
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

type Mail = { key: string; subject: string; from: string; at: string; read: boolean; archived?: boolean; starred?: boolean; can: string[] };
const fresh = (): Mail[] => [
	{ key: "fx-a", subject: "sample-1 보고서", from: "Sample One <one@example.com>", at: ago(1), read: false, can: CAN },
	{ key: "fx-b", subject: "sample-2 일정", from: "Sample Two <two@example.com>", at: ago(2), read: false, can: CAN },
	{ key: "fx-c", subject: "sample-3 견적", from: "Sample Three <three@example.com>", at: ago(3), read: false, can: CAN },
	{ key: "fx-x", subject: "sample-4 안내", from: "Sample Four <four@example.com>", at: ago(4), read: false, can: CAN },
	{ key: "fx-dz", subject: "sample-5 회사", from: "Sample Five <five@example.com>", at: ago(5), read: true, can: [] },
];
const APPLY: Record<string, (m: Mail) => void> = {
	read: m => { m.read = true; }, unread: m => { m.read = false; }, archive: m => { m.archived = true; }, unarchive: m => { m.archived = false; },
	star: m => { m.starred = true; }, unstar: m => { m.starred = false; }, trash: m => { mails = mails.filter(x => x !== m); },
};
const REFUSED = "메일함이 거절했어요";
const UNSYNCED = "메일함에 반영하지 못했어요 · dotz에서만 바뀌었어요";
let mails = fresh();
type Post = { path: string; body: unknown };
let posts = inbox<Post>();
let refuse: Record<string, string[]> = {};
let unsynced = new Set<string>();
let convAsks = inbox<string>();
type Gate = { p: Promise<void>; open: () => void };
const gateOf = (): Gate => { const { promise, resolve } = Promise.withResolvers<void>(); return { p: promise, open: resolve }; };
let gate: Gate | null = null;
let convHold: Gate | null = null;

const answer = (key: string, action: string) => {
	if (refuse[key]?.includes(action)) return { ok: false, synced: false, note: REFUSED };
	const m = mails.find(x => x.key === key);
	if (!m) return { ok: false, synced: false, note: "이 메일을 찾지 못했어요" };
	APPLY[action]!(m);
	return unsynced.has(key) ? { ok: true, synced: false, note: UNSYNCED } : { ok: true, synced: m.can.length > 0 };
};
const hub = fakeHub({
	slowTimers: true,
	api: async (req, url) => {
		const p = url.pathname;
		if (p === "/api/notices") return json({ items: [], unread: 0 });
		if (p === "/api/integrations") return json({ items: [{ key: "mail", label: "메일", icon: "mail", kind: "app", conv: ["mail:"], notices: [], unread: mails.filter(m => !m.read).length, needs: { drafts: 0, unread: 0, sentToday: 0, unreplied: 0 } }], available: [] });
		if (p === "/api/conversations") {
			convAsks.push(url.search);
			if (convHold) await convHold.p;
			return json({ items: mails.map(m => ({ target: `mail:${m.key}`, unread: m.read ? 0 : 1, read: null, mail: { subject: m.subject, from: m.from, source: "acme", at: m.at, summary: m.subject, read: m.read, archived: !!m.archived, starred: !!m.starred, can: m.can }, last: { ts: m.at, text: m.subject, from: "bot" } })) });
		}
		const one = /^\/api\/mail\/([^/]+)\/action$/.exec(p);
		if (one && req.method === "POST") {
			const body = (await req.json()) as { action: string }; posts.push({ path: p, body });
			if (gate) await gate.p;
			const r = answer(one[1]!, body.action);
			return r.ok ? json(r) : json({ error: r.note }, 404);
		}
		if (p === "/api/mail/actions" && req.method === "POST") {
			const body = (await req.json()) as { keys: string[]; action: string }; posts.push({ path: p, body });
			if (gate) await gate.p;
			return json({ ok: true, results: body.keys.map(key => ({ key, ...answer(key, body.action) })) });
		}
	},
});
afterAll(() => hub.stop());
beforeEach(() => { mails = fresh(); posts = inbox<Post>(); refuse = {}; unsynced = new Set(); convAsks = inbox<string>(); gate = null; convHold = null; });
afterEach(() => { gate?.open(); convHold?.open(); hub.release(); });

const rowJs = (title: string) => `[...document.querySelectorAll("#mon-tl > .mr")].find(r => r.querySelector(".rc-title").textContent === ${JSON.stringify(title)})`;
const tick = (v: View, title: string) => run(v, `${rowJs(title)}.querySelector(".mr-chk").click()`);
const pickBar = (v: View, label: string) => run(v, `[...document.querySelectorAll("#mbox-bar .mbox-b")].find(b => b.getAttribute("aria-label").startsWith(${JSON.stringify(label)})).click()`);
const snack = (v: View) => ev<{ text: string; act: string } | null>(v, `(() => { const n = document.querySelector(".snack"); return n ? { text: n.querySelector("span").textContent, act: n.querySelector(".sa")?.textContent ?? "" } : null; })()`);
const snackSays = (v: View, text: string) => waitFor(v, `document.querySelector(".snack span")?.textContent === ${JSON.stringify(text)}`);
const noSnack = (v: View) => run(v, `document.querySelectorAll(".snack").forEach(n => n.remove())`);
const sent = (n: number, what: string) => posts.until(p => p.length === n, 8000, what);
const settled = (v: View) => waitFor(v, `!document.getAnimations().some(a => a.playState === "running" && a.effect.getTiming().iterations !== Infinity)`);
const shot = async (v: View, name: string) => { if (!SHOTS) return; await settled(v); mkdirSync(SHOTS, { recursive: true }); await Bun.write(`${SHOTS}/${name}.png`, await v.screenshot()); };
const titles = (v: View) => ev<string[]>(v, `[...document.querySelectorAll("#mon-tl > .mr .rc-title")].map(t => t.textContent)`);
const SIZES = [[390, 844], [1280, 800]] as const;

async function openList(width: number, height: number): Promise<View> {
	const v = await hub.view({ width, height });
	await v.navigate(`${hub.origin}/`);
	await waitFor(v, `typeof NT !== "undefined" && NT.loaded && typeof NM !== "undefined" && NM.loaded && S && typeof INTG !== "undefined" && INTG.items.length === 1 && CONV.has("mail:fx-a")`);
	await run(v, `MON.mailFilter = "all"; MON.land = "i:mail"; go("monitoring")`);
	await waitFor(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]')`);
	await run(v, `document.querySelector('#mon-side .cv-row[data-k="i:mail"]').click()`);
	await waitFor(v, `document.querySelector("#mon-tl .mr") && document.querySelector("#mbox-bar")`);
	return v;
}

describe("되돌리기 of an action on several mails", () => {
	for (const [width, height] of SIZES) test(`3개를 보관했어요 · 되돌리기 sends 받은편지함으로 for all three and brings them back at ${width}`, async () => {
		const v = await openList(width, height);
		for (const t of ["sample-1 보고서", "sample-2 일정", "sample-3 견적"]) await tick(v, t);
		await pickBar(v, "보관");
		await snackSays(v, "3개를 보관했어요");
		await waitFor(v, `!${rowJs("sample-1 보고서")} && !${rowJs("sample-3 견적")}`);
		expect((await snack(v))!.act).toBe("되돌리기");
		await shot(v, `archive-3-undo-${width}`);
		await run(v, `document.querySelector(".snack .sa").click()`);
		await sent(2, "the undo request");
		expect(posts[1]).toEqual({ path: "/api/mail/actions", body: { keys: ["fx-a", "fx-b", "fx-c"], action: "unarchive" } });
		await waitFor(v, `${rowJs("sample-1 보고서")} && ${rowJs("sample-2 일정")} && ${rowJs("sample-3 견적")}`);
	}, 30_000);

	test("2개를 읽음으로 표시했어요 · 되돌리기 marks both unread again", async () => {
		const v = await openList(1280, 800);
		await tick(v, "sample-1 보고서"); await tick(v, "sample-2 일정");
		await pickBar(v, "읽음으로 표시");
		await snackSays(v, "2개를 읽음으로 표시했어요");
		await run(v, `document.querySelector(".snack .sa").click()`);
		await sent(2, "the undo request");
		expect(posts[1]).toEqual({ path: "/api/mail/actions", body: { keys: ["fx-a", "fx-b"], action: "unread" } });
		expect(mails.filter(m => !m.read).map(m => m.key)).toEqual(["fx-a", "fx-b", "fx-c", "fx-x"]);
	}, 30_000);

	test("a refusal of one of three puts back that one only", async () => {
		refuse = { "fx-x": ["read"] };
		const v = await openList(1280, 800);
		for (const t of ["sample-1 보고서", "sample-4 안내", "sample-2 일정"]) await tick(v, t);
		convHold = gateOf();
		await pickBar(v, "읽음으로 표시");
		await snackSays(v, REFUSED);
		expect(await ev<Record<string, [boolean, number]>>(v, `Object.fromEntries(["fx-a", "fx-x", "fx-b"].map(k => [k, [MAILS.get("mail:" + k).read, ts("mail:" + k).unread]]))`)).toEqual({ "fx-a": [true, 0], "fx-x": [false, 1], "fx-b": [true, 0] });
	}, 30_000);
});

describe("a refusal rolls back only what that action changed", () => {
	test("읽음 refused while a later 별표 went through: the star stays, the mail is unread again", async () => {
		refuse = { "fx-x": ["read"] };
		const v = await openList(1280, 800);
		await tick(v, "sample-4 안내");
		gate = gateOf();
		await pickBar(v, "읽음으로 표시");
		await sent(1, "the read request");
		await run(v, `${rowJs("sample-4 안내")}.querySelector(".mr-star").click()`);
		await sent(2, "the star request");
		convHold = gateOf();
		gate.open();
		await waitFor(v, `MAILS.get("mail:fx-x").starred === true && MAILS.get("mail:fx-x").read === false && ts("mail:fx-x").unread === 1`);
	}, 30_000);
});

describe("별표", () => {
	test("a refusal and a mailbox that did not follow each say one line; a star that went through says nothing", async () => {
		refuse = { "fx-x": ["star"] };
		unsynced = new Set(["fx-b"]);
		const v = await openList(1280, 800);
		await run(v, `${rowJs("sample-4 안내")}.querySelector(".mr-star").click()`);
		await snackSays(v, REFUSED);
		await waitFor(v, `MAILS.get("mail:fx-x").starred === false`);
		await noSnack(v);
		await run(v, `${rowJs("sample-2 일정")}.querySelector(".mr-star").click()`);
		await snackSays(v, UNSYNCED);
		await noSnack(v);
		const asked = convAsks.length;
		await run(v, `${rowJs("sample-1 보고서")}.querySelector(".mr-star").click()`);
		await convAsks.until(a => a.length > asked, 8000, "the reload after the star");
		await waitFor(v, `MAILS.get("mail:fx-a").starred === true`);
		expect(await snack(v)).toBeNull();
	}, 30_000);
});

describe("a mailbox that did not follow keeps 되돌리기", () => {
	for (const [width, height] of SIZES) test(`3개 중 1개는 메일함에 반영하지 못했어요 · 되돌리기 at ${width}`, async () => {
		unsynced = new Set(["fx-b"]);
		const v = await openList(width, height);
		for (const t of ["sample-1 보고서", "sample-2 일정", "sample-3 견적"]) await tick(v, t);
		await pickBar(v, "보관");
		await snackSays(v, "3개 중 1개는 메일함에 반영하지 못했어요");
		expect((await snack(v))!.act).toBe("되돌리기");
		await shot(v, `archive-unsynced-undo-${width}`);
		await run(v, `document.querySelector(".snack .sa").click()`);
		await sent(2, "the undo request");
		expect(posts[1]).toEqual({ path: "/api/mail/actions", body: { keys: ["fx-a", "fx-b", "fx-c"], action: "unarchive" } });
	}, 30_000);

	test("one mail: the hub's line with 되돌리기", async () => {
		unsynced = new Set(["fx-b"]);
		const v = await openList(1280, 800);
		await tick(v, "sample-2 일정");
		await pickBar(v, "읽음으로 표시");
		await snackSays(v, UNSYNCED);
		expect((await snack(v))!.act).toBe("되돌리기");
	}, 30_000);

	for (const [width, height] of SIZES) test(`a mailbox with no actions of its own: 2개를 보관했어요 and no mailbox note at ${width}`, async () => {
		const v = await openList(width, height);
		await tick(v, "sample-1 보고서"); await tick(v, "sample-5 회사");
		await pickBar(v, "보관");
		await snackSays(v, "2개를 보관했어요");
		expect((await snack(v))!.act).toBe("되돌리기");
		await shot(v, `archive-stayed-${width}`);
		await noSnack(v);
		await tick(v, "sample-2 일정");
		await pickBar(v, "보관");
		await snackSays(v, "보관했어요");
	}, 30_000);

	test("one mail whose mailbox has no actions: 안 읽음으로 표시했어요 and no mailbox note", async () => {
		const v = await openList(1280, 800);
		await tick(v, "sample-5 회사");
		await pickBar(v, "안 읽음으로 표시");
		await snackSays(v, "안 읽음으로 표시했어요");
		expect((await snack(v))!.act).toBe("되돌리기");
	}, 30_000);
});

describe("삭제", () => {
	for (const [width, height] of SIZES) test(`two 삭제 within the 6 s make one toast whose 되돌리기 brings both back, and one send at ${width}`, async () => {
		const v = await openList(width, height);
		await tick(v, "sample-1 보고서"); await pickBar(v, "삭제");
		await waitFor(v, `!${rowJs("sample-1 보고서")}`);
		await tick(v, "sample-2 일정"); await pickBar(v, "삭제");
		await snackSays(v, "2개를 삭제했어요");
		expect((await snack(v))!.text).not.toMatch(/원본|메일함/);
		expect((await snack(v))!.act).toBe("되돌리기");
		expect(await ev<number>(v, `document.querySelectorAll(".snack").length`)).toBe(1);
		await shot(v, `delete-merged-${width}`);
		await run(v, `document.querySelector(".snack .sa").click()`);
		await waitFor(v, `${rowJs("sample-1 보고서")} && ${rowJs("sample-2 일정")}`);
		await advanceTimers(v, 7000);
		expect([...posts]).toEqual([]);
		await tick(v, "sample-1 보고서"); await pickBar(v, "삭제");
		await waitFor(v, `!${rowJs("sample-1 보고서")}`);
		await tick(v, "sample-2 일정"); await pickBar(v, "삭제");
		await snackSays(v, "2개를 삭제했어요");
		await advanceTimers(v, 6000);
		await sent(1, "the trash request");
		await advanceTimers(v, 6000);
		expect([...posts]).toEqual([{ path: "/api/mail/actions", body: { keys: ["fx-a", "fx-b"], action: "trash" } }]);
		expect(await titles(v)).not.toContain("sample-1 보고서");
	}, 30_000);

	for (const [width, height] of SIZES) test(`삭제하는 중이에요 stays after the 되돌리기 time while the hub has not answered at ${width}`, async () => {
		const v = await openList(width, height);
		await tick(v, "sample-1 보고서"); await pickBar(v, "삭제");
		await snackSays(v, "삭제했어요");
		gate = gateOf();
		await advanceTimers(v, 6000);
		await sent(1, "the trash request");
		await snackSays(v, "삭제하는 중이에요");
		await advanceTimers(v, 30_000);
		await settled(v);
		expect((await snack(v))?.text).toBe("삭제하는 중이에요");
		await shot(v, `delete-waiting-${width}`);
		gate.open();
		await waitFor(v, `!document.querySelector(".snack")`);
	}, 30_000);

	test("삭제하는 중이에요 after the confirm stays past a plain toast's time until the hub answers; neither the confirm nor the toast says the mailbox keeps it", async () => {
		const v = await openList(1280, 800);
		await tick(v, "sample-5 회사"); await pickBar(v, "삭제");
		await waitFor(v, `document.querySelector("dialog[open] .btn.danger")`);
		expect(await ev<string>(v, `document.querySelector("dialog[open] .dbody").textContent`)).toBe("이 메일을 목록에서 지워요.");
		gate = gateOf();
		await run(v, `document.querySelector("dialog[open] .btn.danger").click()`);
		await sent(1, "the trash request");
		await snackSays(v, "삭제하는 중이에요");
		await advanceTimers(v, 10_000);
		await settled(v);
		expect((await snack(v))?.text).toBe("삭제하는 중이에요");
		gate.open();
		await snackSays(v, "삭제했어요");
		expect((await snack(v))!.text).not.toMatch(/원본|메일함/);
	}, 30_000);
});
