import { afterAll, describe, expect, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { HUB_TOKEN } from "./config.ts";
import { emit } from "./events.ts";
import { postMail, type MailDeps } from "./mail.ts";
import { makeRoute } from "./routes.ts";

// GET /api/conversations answers one page of the mail rows (the newest first) with a cursor for the older ones, and the counts of every row.
// The sessions and project channels are few and always come with the first page; `all=1` is the way to ask for every row at once.
// A mail that waits for a reply (or holds a draft) is on the first page wherever it sits in the order: the 메일 · 카카오톡 card is drawn from it.
// Only the newest 5 such rows older than the page ride along on the first page (the card shows 5 at most); the later pages are the plain cursor walk, so such a row may come twice.
const env = setupEnv();
afterAll(env.cleanup);
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const call = (method: string, path: string, body?: unknown) =>
	route(new Request(`http://hub.test${path}`, { method, headers: { "x-dotz-token": HUB_TOKEN, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

type Row = { target: string; unread: number; last: { ts: string } | null; mail?: { dir?: string; archived?: true; read?: boolean; reply?: string; unreplied?: true; source: string } };
type Answer = { items: Row[]; page?: { limit: number; more: boolean; next?: string }; counts?: { rows: number; mail: { total: number; unread: number; filters: Record<string, number>; sources: Record<string, { total: number; unread: number }> } }; error?: string };
const list = async (query = ""): Promise<Answer> => (await call("GET", `/api/conversations${query}`)).json() as Promise<Answer>;
const isMail = (r: Row) => r.target.startsWith("mail:");
// What the web's 메일 · 카카오톡 card keeps (web/js/31-conversations.js convWaiting).
const owes = (r: Row) => r.mail?.dir !== "out" && !r.mail?.archived && (r.mail?.reply === "draft" || r.mail?.unreplied === true);

const MAILS = 130, T0 = Date.now() + 3_600_000;
let clock = T0;
const deps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: e => emit("inbox", e as never), wake: () => undefined, now: () => new Date(clock).toISOString() };

describe("대화 목록 페이지", () => {
	test("seeds mails across two sources, some read", async () => {
		for (let i = 0; i < MAILS; i++) {
			clock = T0 + i * 60_000;
			await postMail({ source: i % 3 === 0 ? "work" : "home", id: `pg${i}`, subject: `안내 ${i}`, from: `Kim${i} <kim${i}@example.com>`, needsReply: i % 40 === 0 }, deps);
		}
		const all = await list("?all=1");
		const read = all.items.filter(isMail).filter((_, i) => i % 5 === 0);
		for (const r of read) expect((await call("POST", "/api/read", { target: r.target, ts: r.last!.ts })).status).toBe(200);
		const after = (await list("?all=1")).items.filter(isMail);
		expect(after.length).toBe(MAILS);
		expect(after.some(r => r.unread > 0) && after.some(r => r.unread === 0)).toBe(true);
	});

	test("the default answer is one bounded page of mails, with a cursor for the older ones", async () => {
		const a = await list();
		const oldOwed = (await list("?all=1")).items.filter(isMail).slice(100).filter(owes).length;
		expect(oldOwed).toBe(1);
		expect(a.items.filter(isMail).length).toBe(100 + oldOwed);
		expect(a.page?.more).toBe(true);
		expect(typeof a.page?.next).toBe("string");
		const small = await list("?limit=40");
		const smallOwed = (await list("?all=1")).items.filter(isMail).slice(40).filter(owes).length;
		expect(small.items.filter(isMail).length).toBe(40 + smallOwed);
		expect(small.page).toMatchObject({ limit: 40, more: true });
	});

	test("a mail that owes a reply stays on the first page however many newer mails there are", async () => {
		const all = (await list("?all=1")).items.filter(isMail);
		const oldest = all[all.length - 1]!;
		expect(all.length).toBeGreaterThan(100 + 1);
		expect(owes(oldest)).toBe(true);
		expect(all.filter(r => !owes(r)).length).toBeGreaterThan(100);
		const first = await list();
		const got = first.items.filter(isMail).map(r => r.target);
		for (const r of all.filter(owes)) expect(got).toContain(r.target);
		expect(got).toContain(oldest.target);
		expect(new Set(got).size).toBe(got.length);
		// only the owed rows are added: nothing else older than the page comes along
		expect(got.length).toBe(all.slice(0, 100).length + all.slice(100).filter(owes).length);
	});

	test("the cursor walks every mail row at least once, newest first, and a later page is the plain walk", async () => {
		const full = (await list("?all=1")).items.filter(isMail).map(r => r.target);
		const seen: string[] = [], later: string[] = [];
		let a = await list("?limit=40");
		seen.push(...a.items.filter(isMail).map(r => r.target));
		let pages = 1;
		while (a.page?.more) {
			a = await list(`?limit=40&before=${encodeURIComponent(a.page.next!)}`);
			expect(a.items.every(isMail)).toBe(true);
			expect(a.items.length).toBeLessThanOrEqual(40);
			later.push(...a.items.map(r => r.target));
			pages++;
		}
		expect(pages).toBe(Math.ceil(MAILS / 40));
		expect(later.length).toBe(MAILS - 40);
		expect(new Set(later).size).toBe(later.length);
		expect([...new Set([...seen, ...later])].sort()).toEqual([...full].sort());
		const stamps = (await list("?all=1")).items.filter(isMail).map(r => r.last?.ts ?? "");
		expect(stamps).toEqual([...stamps].sort().reverse());
	});

	test("the counts of the first page equal the counts of the full list, and later pages carry none", async () => {
		const first = await list("?limit=40");
		const all = await list("?all=1");
		const mails = all.items.filter(isMail);
		expect(all.page?.more).toBe(false);
		expect(first.counts).toEqual(all.counts);
		const c = first.counts!;
		expect(c.rows).toBe(all.items.length);
		expect(c.mail.total).toBe(MAILS);
		expect(c.mail.unread).toBe(mails.reduce((s, r) => s + r.unread, 0));
		expect(c.mail.filters.unread).toBe(mails.filter(r => r.unread > 0).length);
		expect(c.mail.filters.owed).toBe(mails.filter(r => r.mail?.reply === "needs" || r.mail?.reply === "draft").length);
		expect(c.mail.filters.all).toBe(mails.filter(r => r.mail?.dir !== "out" && !r.mail?.archived).length);
		for (const s of ["work", "home"]) {
			const of = mails.filter(r => r.mail?.source === s);
			expect(c.mail.sources[s]).toEqual({ total: of.length, unread: of.reduce((n, r) => n + r.unread, 0) });
		}
		const next = await list(`?limit=40&before=${encodeURIComponent(first.page!.next!)}`);
		expect(next.counts).toBeUndefined();
	});

	test("one row can be asked for by its key, wherever it sits in the list", async () => {
		const all = (await list("?all=1")).items.filter(isMail);
		const oldest = all[all.length - 1]!;
		expect(all.length).toBe(MAILS);
		const one = await list(`?target=${encodeURIComponent(oldest.target)}`);
		expect(one.items.map(r => r.target)).toEqual([oldest.target]);
		expect(one.items[0]!.mail?.source).toBe(oldest.mail?.source);
	});

	test("a bad cursor or limit is refused or clamped, never a server error", async () => {
		const bad = await call("GET", "/api/conversations?before=nope");
		expect(bad.status).toBe(400);
		expect((await list("?limit=100000")).items.filter(isMail).length).toBeLessThanOrEqual(500);
		expect((await list("?limit=abc")).items.filter(isMail).length).toBe(101);   // the default 100, and the one older owed mail
	});
});

// The first page must stay small however many mails owe a reply: 5 extras at most, the newest ones. Seeded last, the tests above count the 130 mails.
describe("hundreds of owed mails older than the first page", () => {
	const OLD = 300;
	test("seeds 300 owed mails older than the newest 100", async () => {
		for (let i = 0; i < OLD; i++) {
			clock = T0 - (i + 1) * 60_000;
			await postMail({ source: "home", id: `ow${i}`, subject: `밀린 ${i}`, from: `Old${i} <old${i}@example.com>`, needsReply: true }, deps);
		}
		const mails = (await list("?all=1")).items.filter(isMail);
		expect(mails.length).toBe(MAILS + OLD);
		expect(mails.slice(100).filter(owes).length).toBe(OLD + 1);
	}, 60_000);

	test("the first page has at most 100 + 5 mail rows, and the 5 extras are the newest owed ones", async () => {
		const all = (await list("?all=1")).items.filter(isMail);
		const first = await list();
		const got = first.items.filter(isMail).map(r => r.target), page = all.slice(0, 100).map(r => r.target);
		expect(got.length).toBeLessThanOrEqual(100 + 5);
		for (const t of page) expect(got).toContain(t);
		const extras = got.filter(t => !page.includes(t));
		expect(extras).toEqual(all.slice(100).filter(owes).slice(0, 5).map(r => r.target));
		expect(extras.length).toBe(5);
		expect(first.page?.more).toBe(true);
		expect(first.counts?.mail.total).toBe(MAILS + OLD);
	});

	test("the cursor walk from the first page meets every mail row at least once, and the later pages are plain", async () => {
		const full = (await list("?all=1")).items.filter(isMail).map(r => r.target);
		let a = await list();
		const seen = new Set(a.items.filter(isMail).map(r => r.target)), later: string[] = [];
		let pages = 1;
		while (a.page?.more) {
			expect(pages).toBeLessThan(20);
			a = await list(`?before=${encodeURIComponent(a.page.next!)}`);
			expect(a.items.length).toBeLessThanOrEqual(100);
			later.push(...a.items.map(r => r.target));
			pages++;
		}
		for (const t of later) seen.add(t);
		expect(pages).toBe(Math.ceil(full.length / 100));
		expect(later.length).toBe(full.length - 100);
		expect(new Set(later).size).toBe(later.length);
		expect([...seen].sort()).toEqual([...full].sort());
	});
});
