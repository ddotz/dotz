import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { setupEnv } from "../features/reply-drafts/test/helpers.ts";
import { cfg, HUB_TOKEN } from "./config.ts";
import { conversationPage, type ConvRow } from "./conversations-page.ts";
import { emit } from "./events.ts";
import { allNotices, dropChannelNotices } from "./notices.ts";
import * as mailModule from "./mail.ts";
import { postMail, type MailDeps } from "./mail.ts";
import { makeRoute } from "./routes.ts";

// GET /api/conversations decides the page from the cheap fields of a mail and builds the full card (mailCard) only for the rows that go out:
// the page, and the owed mails older than it. A list of thousands of mails must not cost a card per mail on every call (L04, the hub answers one request at a time).
const env = setupEnv();
const mailCfg = (cfg as unknown as { mail?: { keep: number } }).mail;
afterAll(async () => {
	(cfg as unknown as { mail?: { keep: number } }).mail = { keep: 50 };
	clock = Date.now();
	await postMail({ source: "work", id: "cd-trim", subject: "정리", from: "Kim <kim@example.com>" }, deps);   // the hub trims to the keep setting when a mail is filed: the next test file starts without these mails
	(cfg as unknown as { mail?: { keep: number } }).mail = mailCfg;
	// Trimming the mailbox leaves the notice of each mail behind; the store is shared with the next test file and holds only NOTICE_CAP of the newest, so these would push out its own notices.
	for (const src of new Set(allNotices().map(n => n.src).filter((s): s is string => !!s?.match(/^mail:(work|home)-cd/)))) dropChannelNotices(src);
	env.cleanup();
});
const route = makeRoute({ busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
const call = (path: string) => route(new Request(`http://hub.test${path}`, { headers: { "x-dotz-token": HUB_TOKEN } }));
type Answer = { items: ConvRow[]; page?: { limit: number; more: boolean; next?: string }; counts?: unknown };
const list = async (query = ""): Promise<Answer> => (await call(`/api/conversations${query}`)).json() as Promise<Answer>;
const isMail = (r: ConvRow) => r.target.startsWith("mail:");

// Enough to be many pages (a page is 100 rows, at most 500) and to have owed mails older than the first page; every mail filed costs a write of the mailbox, so more only makes the seed slow.
const MAILS = 1000, T0 = Date.now() - MAILS * 1000;
let clock = T0, others = 0;
const deps: MailDeps = { createThread: async () => ({ id: "143000000000000001" }), send: async () => undefined, mailChannel: async () => undefined, discordOn: false, emit: e => emit("inbox", e as never), wake: () => undefined, now: () => new Date(clock).toISOString() };
const cards = spyOn(mailModule, "mailCard");

describe("대화 목록의 메일 카드는 나가는 행만 만들어요", () => {
	test("seeds a long mailbox, some mails owing a reply", async () => {
		others = (await list("?all=1")).items.filter(isMail).length;
		(cfg as unknown as { mail: { keep: number } }).mail = { keep: others + MAILS + 100 };
		for (let i = 0; i < MAILS; i++) {
			clock = T0 + i * 1000;
			await postMail({ source: i % 3 === 0 ? "work" : "home", id: `cd${i}`, subject: `긴 목록 ${i}`, from: `Kim${i} <kim${i}@example.com>`, needsReply: i % 200 === 0 }, deps);
		}
		cards.mockClear();
		expect((await list("?all=1")).items.filter(isMail).length).toBe(others + MAILS);
		expect(cards).toHaveBeenCalledTimes(others + MAILS);
	}, 120_000);

	test("the first page builds a card only for the rows it sends, and answers what the full-card path answered", async () => {
		const full = await list("?all=1");
		cards.mockClear();
		const first = await list();
		const sent = first.items.filter(isMail).length;
		expect(sent).toBeGreaterThan(100);
		expect(sent).toBeLessThan(150);
		expect(cards.mock.calls.length).toBeLessThanOrEqual(sent);
		const old = conversationPage(full.items, new URLSearchParams()).body as Answer;
		expect(first.items).toEqual(old.items);
		expect(first.page).toEqual(old.page);
		expect(first.counts).toEqual(old.counts);
	}, 120_000);

	test("a later page and a single row build only what they send, and the same rows as before", async () => {
		const full = await list("?all=1");
		const first = await list();
		cards.mockClear();
		const next = await list(`?before=${encodeURIComponent(first.page!.next!)}`);
		expect(cards.mock.calls.length).toBeLessThanOrEqual(next.items.length);
		expect(next.items).toEqual((conversationPage(full.items, new URLSearchParams({ before: first.page!.next! })).body as Answer).items);
		const one = full.items.filter(isMail).at(-1)!;
		cards.mockClear();
		const asked = await list(`?target=${encodeURIComponent(one.target)}`);
		expect(cards).toHaveBeenCalledTimes(1);
		expect(asked.items).toEqual([one]);
	}, 120_000);

	test("all=1 still answers every row with its card", async () => {
		cards.mockClear();
		const all = await list("?all=1");
		expect(cards).toHaveBeenCalledTimes(others + MAILS);
		expect(all.items.filter(isMail).filter(r => (r.mail as { subject?: string } | undefined)?.subject?.startsWith("긴 목록 ")).length).toBe(MAILS);
		expect(all.page).toEqual({ limit: all.items.length, more: false });
	}, 120_000);
});
