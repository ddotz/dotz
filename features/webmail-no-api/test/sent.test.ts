import { expect, test } from "bun:test";
import { sentList, withPaging } from "../lib/adapter.ts";
import { capture, captureSent } from "../lib/capture.ts";
import type { Ctx } from "../lib/config.ts";
import type { SiteSpec } from "../lib/spec.ts";
import { runSent } from "../bin/mail.ts";
import { startFakeServer, mkMail, mkSent } from "./fakeserver.ts";

const ctxOf = (srv: ReturnType<typeof startFakeServer>): Ctx => ({ fetch: (...a) => fetch(...a), cookieHeader: srv.cookieHeader, now: () => 1_700_000_000_000, sleep: async () => {}, log: () => {} });
const sentSpec = (srv: ReturnType<typeof startFakeServer>, over: Partial<NonNullable<SiteSpec["sent"]>> = {}): SiteSpec => ({
	...srv.spec,
	sent: { path: "/mail/mboxes/{mailbox}/mails", params: { page: "{page}" }, mailbox: "200", listPath: "mails", fields: { id: "id", to: "to", subject: "subject", time: "date" }, ...over },
});

test("the sent folder is walked page by page until an empty page, and the limit cuts it", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		srv.setSent([1, 2, 3, 4, 5].map(mkSent), { pageSize: 2 });
		expect((await sentList(ctxOf(srv), sentSpec(srv))).map((m) => m.id)).toEqual(["1", "2", "3", "4", "5"]);
		expect(srv.sentPages).toEqual([1, 2, 3, 4]);
		expect((await sentList(ctxOf(srv), sentSpec(srv), 3)).map((m) => m.id)).toEqual(["1", "2", "3"]);
	} finally {
		srv.close();
	}
});

test("a site that answers the first page whatever the page stops at the repeat; a call with no {page} is one page", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		srv.setSent([1, 2, 3].map(mkSent), { pageSize: 2, ignorePage: true });
		expect((await sentList(ctxOf(srv), sentSpec(srv))).map((m) => m.id)).toEqual(["1", "2"]);
		expect(srv.sentPages).toEqual([1, 1]);
		srv.sentPages.length = 0;
		expect(await sentList(ctxOf(srv), sentSpec(srv, { params: {} }))).toHaveLength(2);
		expect(srv.sentPages).toEqual([1]);
	} finally {
		srv.close();
	}
});

test("a first-page call with no page param gets the param the site really pages on; a one-page folder and a call with {page} stay as they are", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		srv.setSent([1, 2, 3].map(mkSent), { pageSize: 2, pageParam: "currentPage" });
		const bare = sentSpec(srv, { params: {} });
		const paged = await withPaging(ctxOf(srv), bare);
		expect(paged?.params).toEqual({ currentPage: "{page}" });
		expect((await sentList(ctxOf(srv), { ...bare, sent: paged })).map((m) => m.id)).toEqual(["1", "2", "3"]);
		const asked = srv.sentPages.length;
		const has = sentSpec(srv);
		expect(await withPaging(ctxOf(srv), has)).toBe(has.sent);
		expect(srv.sentPages).toHaveLength(asked);
		srv.setSent([mkSent(1)], { pageSize: 2, pageParam: "currentPage" });
		expect(await withPaging(ctxOf(srv), bare)).toBe(bare.sent);
	} finally {
		srv.close();
	}
});

test("mail.ts sent prints one JSON line per mail with its receiver, time and body, and sends nothing", async () => {
	const srv = startFakeServer([mkMail(1)]);
	try {
		srv.setSent([mkSent(3), mkSent(4)]);
		const out = await runSent(ctxOf(srv), sentSpec(srv));
		expect(out.code).toBe(0);
		expect(out.lines.map((l) => JSON.parse(l))).toEqual([3, 4].map((n) => ({ id: String(n), to: `rcpt${n}@example.test`, subject: `Re: subject ${n}`, at: Date.parse(`2026-10-22T0${n}:00:00Z`), body: `reply ${n} 가능해요.\n> question ${n}인가요?` })));
		expect(srv.sent).toEqual([]);
	} finally {
		srv.close();
	}
});

test("captureSent keeps the list template, changes only the mailbox, and is nothing for the inbox again", async () => {
	const srv = startFakeServer([mkMail(2), mkMail(1)]);
	try {
		srv.setSent([mkSent(7), mkSent(8)]);
		const get = async (path: string) => {
			const r = await fetch(srv.origin + path, { headers: { cookie: "session=good" } });
			return { url: srv.origin + path, method: "GET", status: r.status, contentType: r.headers.get("content-type") ?? "", responseBody: await r.text() };
		};
		const inbox = await get("/mail/mboxes/100/mails");
		const spec = capture("w", [inbox, await get("/mail/mails/2")]).spec!;
		expect(captureSent(spec, [inbox])).toBeUndefined();
		expect(captureSent(spec, [])).toBeUndefined();
		expect(captureSent(spec, [await get("/mail/mboxes/200/mails?page=1")])).toEqual({ path: spec.list.path, params: { page: "{page}" }, mailbox: "200", listPath: "mails", fields: { id: "id", from: "from", to: "to", subject: "subject", time: "date", read: "read" } });
	} finally {
		srv.close();
	}
});
