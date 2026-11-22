import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authRoute, storeMailCode } from "./auth.ts";
import { DATA_DIR, HUB_TOKEN, paths, PORT } from "./config.ts";
import { askMailCode, codeIn, findMailCode, mailEnv, type MailEnv, PEER_MAIL_PATH, peerMailCode, resetMailCodes } from "./mail-otp.ts";
import { save as flushNotices } from "./notices-store.ts";
import { checkPeer, peerTokenPath } from "./peer-auth.ts";
import { makeRoute } from "./routes.ts";

const RULE = "─".repeat(60);
const NOW = Date.parse("2027-01-15T08:05:00Z");
const SENDER = "Example <no-reply@example.com>";
const TS = "mini.tailnet.ts.net";
const LOOPBACK = `127.0.0.1:${PORT}`;
const PEER_TOKEN = "peer-token-for-the-mail-code-test-0123456789";
const OWNER = "owner@example.com";
const FAKE_CODE = "Q7XK29MV";
const ONCE_DIR = join(DATA_DIR, "secrets", "once");

type Msg = { from: string; date: string; body: string };
type Row = { id: string; from: string; account?: string };
const thread = (...msgs: Msg[]) =>
	["Subject: Login code", `Messages: ${msgs.length}`, ...msgs.flatMap(m => [RULE, `From: ${m.from}`, "  To: Owner <owner@example.com>", `Date: ${m.date}`, "Auth: pass", "", m.body])].join("\n");
const row = (id = "t1", from = SENDER): Row => ({ id, from, account: "owner@example.com" });

let rows: Row[] = [];
let threads: Record<string, string> = {};
let calls = { list: [] as string[][], read: [] as string[][], sleeps: [] as number[] };

function mailbox(over: Partial<MailEnv> = {}): MailEnv {
	return {
		on: () => true,
		list: async args => (calls.list.push(args), rows),
		read: async (id, account) => (calls.read.push([id, account]), threads[id] ?? ""),
		flags: () => [],
		now: () => NOW,
		sleep: async ms => void calls.sleeps.push(ms),
		peers: async () => [],
		headers: () => undefined,
		post: async () => {
			throw new Error("no network in this test");
		},
		...over,
	};
}

const realEnv = { ...mailEnv };
beforeEach(() => {
	rows = [];
	threads = {};
	calls = { list: [], read: [], sleeps: [] };
	resetMailCodes();
});
afterEach(() => void Object.assign(mailEnv, realEnv));

describe("codeIn", () => {
	test("picks the code from Korean and English mails", () => {
		expect(codeIn("[예시] 인증번호 [482913]를 입력해 주세요.\n유효시간은 3분입니다.")).toEqual({ code: "482913" });
		expect(codeIn("보안 코드는 8264 입니다. 타인에게 알려 주지 마세요.")).toEqual({ code: "8264" });
		expect(codeIn("Your verification code is 482913.\nIt expires in 10 minutes.\nSent Nov 19, 2026 at 3:30 PM. Questions? Call 1588-1234 or +82 10 1234 5678.")).toEqual({ code: "482913" });
		expect(codeIn("Your one-time passcode: K7M2Q9\nDo not share it with anyone.")).toEqual({ code: "K7M2Q9" });
	});

	test("a code on its own line under the keyword wins over the date lines around it", () => {
		expect(codeIn("안녕하세요.\n로그인 인증을 위해 아래 코드를 입력해 주세요.\n\n731905\n\n이 코드는 10분 동안 유효합니다.\n2026년 11월 19일 오후 3:30에 요청되었습니다.")).toEqual({ code: "731905" });
		expect(codeIn("결제 금액 12,000원이 승인되었습니다.\n2026-11-19 15:30\n인증번호 559120")).toEqual({ code: "559120" });
	});

	test("a year counts only right after the keyword", () => {
		expect(codeIn("인증번호는 2026 입니다")).toEqual({ code: "2026" });
		expect(codeIn("Copyright 2026 Example Inc.")).toEqual({ reason: "not-found" });
	});

	test("dates, times, phone numbers, amounts and links alone are not a code", () => {
		expect(codeIn("예약이 확정되었습니다.\n일시: 2026년 11월 19일 15:30\n장소: 서울 강남구\n문의: 010-1234-5678, 02-123-4567, 1588-1234")).toEqual({ reason: "not-found" });
		expect(codeIn("Order shipped on 2026-11-19 10:30. Call +82 10 1234 5678 or visit https://example.com/track/20261119?id=88442211")).toEqual({ reason: "not-found" });
		expect(codeIn("인증 링크: https://example.com/verify/998877\n결제 금액 15000원")).toEqual({ reason: "not-found" });
	});

	test("two different candidates are ambiguous, the same one twice is not", () => {
		expect(codeIn("인증번호: 482913\n보안 코드: 771204")).toEqual({ reason: "ambiguous" });
		expect(codeIn("인증번호: 482913\n다시 한 번, 보안 코드: 482913")).toEqual({ code: "482913" });
	});

	test("a quoted earlier mail is not read", () => {
		expect(codeIn("인증번호 482913\n\nOn Nov 18, 2026, Bob <bob@example.com> wrote:\n> 인증번호 111111")).toEqual({ code: "482913" });
		expect(codeIn("> 인증번호 111111")).toEqual({ reason: "not-found" });
	});
});

describe("findMailCode", () => {
	test("asks zele for the sender's newest threads on the chosen account and answers the code of a mail inside the window", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "2m ago", body: "Your verification code is 482913." });
		const env = mailbox();
		expect(await findMailCode({ from: "Example.com", account: "owner@example.com", minutes: 10 }, env)).toEqual({ ok: true, code: "482913" });
		expect(calls.list).toEqual([["mail", "list", "--filter", "from:example.com newer_than:1d", "--limit", "5", "--account", "owner@example.com"]]);
		expect(calls.read).toEqual([["t1", "owner@example.com"]]);
	});

	test("a mail older than the window, or with a date that cannot be placed, is ignored", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "20m ago", body: "인증번호 111111" }, { from: SENDER, date: "Jan 15, 8:00 AM", body: "인증번호 222222" });
		expect(await findMailCode({ from: "example.com", minutes: 10 }, mailbox())).toMatchObject({ ok: false, reason: "not-found" });
		expect(await findMailCode({ from: "example.com", minutes: 30 }, mailbox())).toEqual({ ok: true, code: "111111" });
	});

	test("an absolute date is placed against the clock", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "2027-01-15T07:30:00Z", body: "인증번호 111111" }, { from: SENDER, date: "2027-01-15T08:03:00Z", body: "인증번호 333333" });
		expect(await findMailCode({ from: "example.com", minutes: 10 }, mailbox())).toEqual({ ok: true, code: "333333" });
	});

	test("the newest message with a code is the one given, and a thread of another sender is skipped", async () => {
		rows = [row("t0", "Phish <x@evil.example.net>"), row("t1", `"example.com" <attacker@evil.example.net>`), row("t2")];
		threads.t0 = thread({ from: "Phish <x@evil.example.net>", date: "1m ago", body: "인증번호 999999" });
		threads.t2 = thread({ from: SENDER, date: "7m ago", body: "인증번호 111111" }, { from: "Someone <someone@evil.example.net>", date: "1m ago", body: "인증번호 888888" }, { from: SENDER, date: "3m ago", body: "인증번호 222222" });
		expect(await findMailCode({ from: "example.com" }, mailbox())).toEqual({ ok: true, code: "222222" });
		expect(calls.read.map(r => r[0])).toEqual(["t2"]);
	});

	test("a subdomain of the sender's domain counts; an address asks for exactly that address", async () => {
		rows = [row("t1", "Accounts <login@accounts.example.com>")];
		threads.t1 = thread({ from: "Accounts <login@accounts.example.com>", date: "1m ago", body: "인증번호 424242" });
		expect(await findMailCode({ from: "example.com" }, mailbox())).toEqual({ ok: true, code: "424242" });
		expect(await findMailCode({ from: "other@accounts.example.com" }, mailbox())).toMatchObject({ ok: false, reason: "not-found" });
	});

	test("the same code is given once; a second request for it is told it is taken", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "1m ago", body: "인증번호 482913" });
		expect(await findMailCode({ from: "example.com" }, mailbox())).toEqual({ ok: true, code: "482913" });
		const second = await findMailCode({ from: "example.com" }, mailbox());
		expect(second).toMatchObject({ ok: false, reason: "already-given" });
		expect(JSON.stringify(second)).not.toContain("482913");
		expect(await findMailCode({ from: "other-example.com" }, mailbox({ list: async () => [row("t1", "Other <a@other-example.com>")], read: async () => thread({ from: "Other <a@other-example.com>", date: "1m ago", body: "인증번호 482913" }) }))).toEqual({ ok: true, code: "482913" });
	});

	test("a code that arrives while looking is found on a later look, 15 seconds apart", async () => {
		let looks = 0;
		threads.t1 = thread({ from: SENDER, date: "1m ago", body: "인증번호 482913" });
		const env = mailbox({ list: async () => (++looks < 3 ? [] : [row()]) });
		expect(await findMailCode({ from: "example.com" }, env)).toEqual({ ok: true, code: "482913" });
		expect(looks).toBe(3);
		expect(calls.sleeps).toEqual([15_000, 15_000]);
	});

	test("nothing within three looks is not-found; an ambiguous mail is told at once", async () => {
		expect(await findMailCode({ from: "example.com" }, mailbox())).toMatchObject({ ok: false, reason: "not-found" });
		expect(calls.list).toHaveLength(3);
		expect(calls.sleeps).toEqual([15_000, 15_000]);
		calls = { list: [], read: [], sleeps: [] };
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "1m ago", body: "인증번호: 482913\n보안 코드: 771204" });
		expect(await findMailCode({ from: "example.com" }, mailbox())).toMatchObject({ ok: false, reason: "ambiguous" });
		expect(calls.sleeps).toEqual([]);
	});

	test("requests that overlap for one sender share one look", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "1m ago", body: "인증번호 482913" });
		const gate = Promise.withResolvers<void>();
		const env = mailbox({ list: async args => (calls.list.push(args), await gate.promise, rows) });
		const first = findMailCode({ from: "example.com" }, env);
		const second = findMailCode({ from: "EXAMPLE.com" }, env);
		gate.resolve();
		expect(await Promise.all([first, second])).toEqual([{ ok: true, code: "482913" }, { ok: true, code: "482913" }]);
		expect(calls.list).toHaveLength(1);
	});

	test("a computer without zele has no mail, and nothing is read", async () => {
		expect(await findMailCode({ from: "example.com" }, mailbox({ on: () => false }))).toMatchObject({ ok: false, reason: "no-mail" });
		expect(calls.list).toEqual([]);
	});

	test("a sender that could carry a filter operator, a quote or a space never reaches zele", async () => {
		for (const from of ["example.com OR from:boss.example.com", "-example.com", `ex"ample.com`, "a b@example.com", "{example.com}", "example", "", "example.com/path"]) {
			expect(await findMailCode({ from }, mailbox())).toMatchObject({ ok: false, reason: "error" });
		}
		expect(await findMailCode({ from: "example.com", account: "owner@example.com OR from:x" }, mailbox())).toMatchObject({ ok: false, reason: "error" });
		expect(await findMailCode({ from: "example.com", minutes: "ten" }, mailbox())).toMatchObject({ ok: false, reason: "error" });
		expect(calls.list).toEqual([]);
	});

	test("minutes is held between 1 and 60", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "50m ago", body: "인증번호 482913" });
		expect(await findMailCode({ from: "example.com", minutes: 600 }, mailbox())).toEqual({ ok: true, code: "482913" });
		resetMailCodes();
		threads.t1 = thread({ from: SENDER, date: "5m ago", body: "인증번호 482913" });
		expect(await findMailCode({ from: "example.com", minutes: 0 }, mailbox())).toMatchObject({ ok: false, reason: "not-found" });
	});

	test("a failing zele is an error that carries none of its message", async () => {
		const env = mailbox({ list: async () => Promise.reject(new Error("zele mail list: SECRET-SUBJECT-TEXT")) });
		const answer = await findMailCode({ from: "example.com" }, env);
		expect(answer).toMatchObject({ ok: false, reason: "error" });
		expect(JSON.stringify(answer)).not.toContain("SECRET");
	});
});

describe("askMailCode", () => {
	const peerUrls = ["https://a.example.test", "https://b.example.test", "https://c.example.test"];
	const asked: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
	const answering = (answers: Record<string, () => Response>, urls = peerUrls) =>
		mailbox({
			on: () => false,
			peers: async () => urls.map(url => ({ url })),
			headers: () => ({ "x-dotz-peer": "token-for-test" }),
			post: async (url, headers, body) => {
				asked.push({ url, headers, body: JSON.parse(body) });
				return answers[url]();
			},
		});
	beforeEach(() => void (asked.length = 0));

	test("with zele on here it looks in this mailbox and asks nobody", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "1m ago", body: "인증번호 482913" });
		const env = mailbox({ peers: async () => [{ url: peerUrls[0] }] });
		expect(await askMailCode({ site: "shop", from: "example.com" }, env)).toEqual({ ok: true, code: "482913" });
		expect(asked).toEqual([]);
	});

	test("without zele it asks the other gateways in turn: no-mail goes on, the first code wins and stops the asking", async () => {
		const env = answering({
			[peerUrls[0]]: () => Response.json({ ok: false, reason: "no-mail" }),
			[peerUrls[1]]: () => Response.json({ ok: true, code: "482913" }),
			[peerUrls[2]]: () => Response.json({ ok: true, code: "999999" }),
		});
		expect(await askMailCode({ site: "shop", from: "Example.com", account: "owner@example.com", minutes: 5 }, env)).toEqual({ ok: true, code: "482913" });
		expect(asked.map(a => a.url)).toEqual([peerUrls[0], peerUrls[1]]);
		expect(asked[0].body).toEqual({ from: "example.com", account: "owner@example.com", minutes: 5 });
		expect(asked[0].headers).toEqual({ "x-dotz-peer": "token-for-test" });
	});

	test("when nobody gives a code the most telling reason is returned", async () => {
		const env = answering({
			[peerUrls[0]]: () => new Response("not found", { status: 404 }),
			[peerUrls[1]]: () => Response.json({ ok: false, reason: "ambiguous", detail: "여럿이에요" }),
			[peerUrls[2]]: () => Response.json({ ok: false, reason: "not-found" }),
		});
		expect(await askMailCode({ site: "shop", from: "example.com" }, env)).toMatchObject({ ok: false, reason: "not-found" });
		const ambiguous = answering({ [peerUrls[0]]: () => Response.json({ ok: false, reason: "already-given" }), [peerUrls[1]]: () => Response.json({ ok: false, reason: "ambiguous", detail: "여럿이에요" }) }, peerUrls.slice(0, 2));
		expect(await askMailCode({ site: "shop", from: "example.com" }, ambiguous)).toEqual({ ok: false, reason: "ambiguous", detail: "여럿이에요" });
	});

	test("a peer that is down, answers garbage or offers a code of the wrong shape is skipped, not trusted", async () => {
		const env = answering({
			[peerUrls[0]]: () => {
				throw new Error("connection refused");
			},
			[peerUrls[1]]: () => Response.json({ ok: true, code: "../../etc/passwd" }),
			[peerUrls[2]]: () => new Response("<html>", { status: 200 }),
		});
		expect(await askMailCode({ site: "shop", from: "example.com" }, env)).toMatchObject({ ok: false, reason: "error" });
		expect(asked).toHaveLength(3);
	});

	test("no peer to ask, or no token for any of them, is no-mail", async () => {
		expect(await askMailCode({ site: "shop", from: "example.com" }, mailbox({ on: () => false }))).toMatchObject({ ok: false, reason: "no-mail" });
		const noToken = mailbox({ on: () => false, peers: async () => [{ url: peerUrls[0] }], headers: () => undefined });
		expect(await askMailCode({ site: "shop", from: "example.com" }, noToken)).toMatchObject({ ok: false, reason: "no-mail" });
	});
});

describe("the peer endpoint", () => {
	const peerHeaders = { "x-dotz-peer": PEER_TOKEN, "tailscale-user-login": OWNER, "content-type": "application/json" };
	const post = (headers: Record<string, string>) => new Request(`https://${TS}${PEER_MAIL_PATH}`, { method: "POST", headers, body: JSON.stringify({ from: "example.com" }) });

	test("only a request that passed the peer gates is a peer; a local or web caller is not", () => {
		expect(checkPeer(post(peerHeaders), PEER_TOKEN)).toBe("ok");
		expect(checkPeer(post({ "tailscale-user-login": OWNER }), PEER_TOKEN)).toBe("none");
		expect(checkPeer(post({ "x-dotz-token": HUB_TOKEN }), PEER_TOKEN)).toBe("none");
		expect(checkPeer(post({ ...peerHeaders, "x-dotz-peer": "not-the-token-0123456789" }), PEER_TOKEN)).toBe("denied");
		expect(checkPeer(new Request(`https://${TS}${PEER_MAIL_PATH}`, { headers: peerHeaders }), PEER_TOKEN)).toBe("denied");
	});

	test("a request that is not a peer is refused with 403 and reads no mail", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "1m ago", body: "인증번호 482913" });
		const refused = await peerMailCode(post({ "x-dotz-token": HUB_TOKEN }), false, mailbox());
		expect(refused.status).toBe(403);
		expect(await refused.text()).not.toContain("482913");
		expect(calls.list).toEqual([]);
		const answered = await peerMailCode(post(peerHeaders), true, mailbox());
		expect(await answered.json()).toEqual({ ok: true, code: "482913" });
	});

	test("an answer holds the code or a reason, and nothing else of the mail", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "1m ago", body: "제목 SECRET-BODY\n인증번호 482913" });
		const found = await (await peerMailCode(post(peerHeaders), true, mailbox())).text();
		expect(JSON.parse(found)).toEqual({ ok: true, code: "482913" });
		expect(found).not.toContain("SECRET");
		expect(found).not.toContain("example.com");
	});
});

describe("through the gateway's routes", () => {
	const route = makeRoute({ tailnetName: async () => TS, busyNow: () => [], restartGateway: () => "", restartGatewayNow: () => "" });
	const local = (path: string, method = "GET", body?: unknown, token = HUB_TOKEN) =>
		route(new Request(`http://${LOOPBACK}${path}`, { method, headers: { host: LOOPBACK, "x-dotz-token": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
	const asPeer = (body: unknown) =>
		route(new Request(`http://${TS}${PEER_MAIL_PATH}`, { method: "POST", headers: { host: TS, "x-dotz-peer": PEER_TOKEN, "tailscale-user-login": OWNER, "content-type": "application/json" }, body: JSON.stringify(body) }));
	const sizeOf = (p: string) => (existsSync(p) ? statSync(p).size : 0);
	const gained = (p: string, from: number) => (existsSync(p) ? readFileSync(p).subarray(from).toString("utf8") : "");
	const onceFiles = (site: string) => (existsSync(ONCE_DIR) ? readdirSync(ONCE_DIR).filter(n => n.startsWith(`mail-${site}-`)) : []);
	const mode = (p: string) => statSync(p).mode & 0o777;
	const tokenFile = peerTokenPath();

	beforeAll(() => {
		mkdirSync(join(DATA_DIR, "secrets"), { recursive: true });
		writeFileSync(tokenFile, PEER_TOKEN);
	});
	afterAll(() => rmSync(tokenFile, { force: true }));

	function bothComputers(): { sent: string[] } {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "1m ago", body: `인증번호 [${FAKE_CODE}]를 입력해 주세요.` });
		const receiver = mailbox();
		const sent: string[] = [];
		Object.assign(mailEnv, mailbox({
			on: () => false,
			peers: async () => [{ url: "https://mini.example.test" }],
			headers: () => ({ "x-dotz-peer": "token-for-test" }),
			post: async (url, _headers, body) => {
				sent.push(body);
				return peerMailCode(new Request(`${url}${PEER_MAIL_PATH}`, { method: "POST", body }), true, receiver);
			},
		}));
		return { sent };
	}

	test("a peer with the token reaches the endpoint; the hub token without the peer header does not", async () => {
		rows = [row()];
		threads.t1 = thread({ from: SENDER, date: "1m ago", body: `인증번호 [${FAKE_CODE}]` });
		Object.assign(mailEnv, mailbox());
		expect((await local(PEER_MAIL_PATH, "POST", { from: "example.com" })).status).toBe(403);
		expect(calls.list).toEqual([]);
		const wrongToken = await route(new Request(`http://${TS}${PEER_MAIL_PATH}`, { method: "POST", headers: { host: TS, "x-dotz-peer": "not-the-token-0123456789", "tailscale-user-login": OWNER, "content-type": "application/json" }, body: JSON.stringify({ from: "example.com" }) }));
		expect(wrongToken.status).toBe(403);
		const ok = await asPeer({ from: "example.com" });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ ok: true, code: FAKE_CODE });
	});

	test("the agent's ask needs the hub token", async () => {
		bothComputers();
		expect((await local("/api/auth/mail-code", "POST", { site: "shop", from: "example.com" }, "not-the-hub-token")).status).toBe(403);
		expect(onceFiles("shop")).toEqual([]);
	});

	test("a bad site or body is a 400, a bad sender is an answer that falls back", async () => {
		bothComputers();
		expect((await local("/api/auth/mail-code", "POST", { site: "Shop Site", from: "example.com" })).status).toBe(400);
		expect((await local("/api/auth/mail-code", "POST", ["x"])).status).toBe(400);
		const bad = await local("/api/auth/mail-code", "POST", { site: "shop", from: "example.com OR x" });
		expect(bad.status).toBe(200);
		expect(await bad.json()).toMatchObject({ ok: false, reason: "error" });
	});

	test("the code goes from the mailbox computer to a one-time file, is taken once, and is nowhere else", async () => {
		const logFrom = sizeOf(paths.log);
		bothComputers();
		const asked = await local("/api/auth/mail-code", "POST", { site: "shop-mail", from: "example.com", account: "owner@example.com", minutes: 10 });
		const askedText = await asked.text();
		expect(asked.status).toBe(200);
		const { id, take, ok } = JSON.parse(askedText) as { ok: boolean; id: string; take: string };
		expect(ok).toBe(true);
		expect(take).toBe(`/api/auth/${id}/take`);
		expect(Object.keys(JSON.parse(askedText)).sort()).toEqual(["id", "ok", "take"]);

		const [file] = onceFiles("shop-mail");
		expect(file).toBe(`mail-shop-mail-${id}`);
		expect(mode(join(ONCE_DIR, file))).toBe(0o600);
		expect(readFileSync(join(ONCE_DIR, file), "utf8")).not.toContain(FAKE_CODE);

		const view = await (await local(`/api/auth/${id}`)).text();
		expect(JSON.parse(view)).toEqual({ id, site: "shop-mail", kind: "otp", status: "entered", take });
		expect(await (await local("/api/auth/mail-code", "POST", { site: "shop-mail", from: "example.com" })).json()).toMatchObject({ ok: false, reason: "already-given" });

		expect((await local(take, "GET", undefined, "not-the-hub-token")).status).toBe(403);
		expect(onceFiles("shop-mail")).toHaveLength(1);

		const first = await local(take);
		expect(first.status).toBe(200);
		expect(await first.text()).toBe(FAKE_CODE);
		expect(onceFiles("shop-mail")).toEqual([]);
		expect((await local(take)).status).toBe(410);

		flushNotices();
		const notices = existsSync(paths.notices) ? readFileSync(paths.notices, "utf8") : "";
		const leaks = [askedText, view, gained(paths.log, logFrom), notices].join("\n");
		expect(leaks).not.toContain(FAKE_CODE);
		expect(gained(paths.log, logFrom)).toContain("mail code: example.com");
	});

	test("an untaken code is deleted after five minutes and then answers 410", async () => {
		const timers: Array<{ fn: () => void; ms: number }> = [];
		const real = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms?: number) => (timers.push({ fn, ms: ms ?? 0 }), real(() => {}, 0))) as typeof setTimeout;
		let stored: { id: string; take: string };
		try {
			stored = storeMailCode("shop-late", FAKE_CODE);
		} finally {
			globalThis.setTimeout = real;
		}
		expect(onceFiles("shop-late")).toHaveLength(1);
		const expiry = timers.find(t => t.ms === 5 * 60_000);
		expect(expiry).toBeDefined();
		expiry!.fn();
		expect(onceFiles("shop-late")).toEqual([]);
		expect((await local(stored.take)).status).toBe(410);
	});

	test("the normal otp flow still holds its value in memory and gives it once", async () => {
		const made = await authRoute(new Request("http://local/api/auth", { method: "POST", body: JSON.stringify({ site: "plain-otp", kind: "otp", purpose: "코드", target: "chat" }) }), new URL("http://local/api/auth"))!;
		const { id } = (await made.json()) as { id: string };
		const entered = await authRoute(new Request(`http://local/api/auth/${id}`, { method: "POST", body: JSON.stringify({ action: "submit", values: { code: "654321" } }) }), new URL(`http://local/api/auth/${id}`))!;
		expect(entered.status).toBe(200);
		expect(onceFiles("plain-otp")).toEqual([]);
		expect(await (await local(`/api/auth/${id}/take`)).text()).toBe("654321");
		expect((await local(`/api/auth/${id}/take`)).status).toBe(410);
	});
});
