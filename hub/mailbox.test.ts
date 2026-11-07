// Mailboxes (docs/mailbox.md): the store and its caps, the placing rules, a conversation staying in one box, quiet boxes, moving a conversation,
// deleting a box, and an install without mailboxes.json staying exactly as it was.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreadOf } from "./conversations.ts";
import { emit } from "./events.ts";
import { mailByKey, mailCard, mailKey, mailTarget, postMail, setMailSuggest, type MailDeps } from "./mail.ts";
import { boxesOf, boxOfConv, cleanBox, CONV_MAX, loadMailboxes, MAX_BOXES, MAX_LIST, MAX_PINS, pickBox, setPin, trackBox, type Box } from "./mailbox.ts";
import { boxPass, instanceOf, mailboxRoute, placeByJudge, placeMail, SUGGEST_MAX, withBoxes } from "./routes-mailbox.ts";

const dir = mkdtempSync(join(tmpdir(), "mailbox-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0, clock = Date.parse("2031-01-01T00:00:00Z");
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;
const stamp = () => new Date((clock += 60_000)).toISOString();
const file = join(dir, "custom", "mailboxes.json");
const put = (v: unknown) => {
	mkdirSync(join(dir, "custom"), { recursive: true });
	writeFileSync(file, JSON.stringify({ rev: ++seq, ...(v as object) }));
};
const apps = (v: unknown) => writeFileSync(join(dir, "custom", "apps.json"), JSON.stringify(v));
beforeEach(() => {
	rmSync(file, { force: true });
	rmSync(join(dir, "custom", "apps.json"), { force: true });
});

function fakes() {
	const calls = { events: [] as Record<string, any>[], wakes: 0, offers: 0, threads: 0 };
	const deps: MailDeps = {
		createThread: async () => (calls.threads++, { id: "143000000000000001" }),
		send: async () => undefined,
		mailChannel: async () => "1500000000001908448",
		discordOn: true,
		threadOn: () => true,
		emit: e => (calls.events.push(e), emit("inbox", e as Parameters<typeof emit>[1])),
		wake: () => void calls.wakes++,
		offerDraft: () => void calls.offers++,
		placeMail: placeMail(dir),
		now: stamp,
	};
	return { deps, calls };
}
const post = (deps: MailDeps, source: string, id: string, extra: Record<string, unknown> = {}) =>
	postMail({ source, id, subject: "안녕하세요", from: "Kim <kim@example.org>", summary: "내용", messageId: `m-${id}`, ...extra }, deps);
const call = async (method: string, path: string, b: unknown) => {
	const res = await mailboxRoute(new Request(`http://hub${path}`, { method, body: JSON.stringify(b) }), new URL(`http://hub${path}`), dir);
	return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const team = { id: "b-team", name: "문서 요청", conds: { from: ["@team.example.org"], subj: ["문서"] }, not: { from: ["spam@team.example.org"] } };

describe("an install without mailboxes.json", () => {
	test("has only the implicit base box and no record gets a box field", async () => {
		const boxes = boxesOf(dir, "mail");
		expect(boxes.map(b => [b.id, b.name, b.icon, b.base, b.mode])).toEqual([["base", "일반", "mail", true, undefined]]);
		const { deps, calls } = fakes(), source = uid("plain");
		await post(deps, source, "1", { wake: true, subject: "문서 보내주세요", from: "x@team.example.org" });
		const rec = mailByKey(mailKey(source, "1"))!;
		expect(Object.keys(rec).filter(k => k === "mbox" || k === "mwhy")).toEqual([]);
		expect(calls.events[0]!.incoming).toBe(true);
		expect(calls.wakes).toBe(1);
		expect(calls.offers).toBe(1);
		expect(boxPass(dir)(rec)).toEqual({ box: "base" });
	});

	test("a broken file is no boxes, and one extra field of an item is not a box", () => {
		mkdirSync(join(dir, "custom"), { recursive: true });
		writeFileSync(file, "{ not json");
		expect(boxesOf(dir, "mail").map(b => b.id)).toEqual(["base"]);
		put({ accounts: { mail: { boxes: [{ name: "id가 없어요" }, team] } } });
		expect(boxesOf(dir, "mail").map(b => b.id)).toEqual(["base", "b-team"]);
	});
});

describe("limits", () => {
	test("boxes, list entries, pins and strings are cut to their caps", () => {
		const many = Array.from({ length: MAX_BOXES + 10 }, (_, i) => ({ id: `b-${i}`, name: `함 ${i}`, conds: { from: Array.from({ length: MAX_LIST + 20 }, (_, n) => `a${n}@x.org`) } }));
		put({ accounts: { mail: { boxes: many } } });
		const stored = loadMailboxes(dir).accounts.mail!.boxes;
		expect(stored).toHaveLength(MAX_BOXES);
		expect(stored[0]!.conds.from).toHaveLength(MAX_LIST);
		expect(cleanBox({ id: "b-x", name: "가".repeat(500) })!.name).toHaveLength(40);
		expect(cleanBox({ id: "has space", name: "x" })).toBeUndefined();
		const store = loadMailboxes(dir);
		for (let i = 0; i < MAX_PINS + 3; i++) setPin(store, "mail", "s", `c${i}`, "b-1");
		expect(Object.keys(store.pins)).toHaveLength(MAX_PINS);
		expect(store.pins["mail|s-c0"]).toBeUndefined();
		expect(store.pins[`mail|s-c${MAX_PINS + 2}`]).toBe("b-1");
	});
});

test("the conversation map stops at its cap and forgets the oldest", () => {
	const source = uid("cap");
	for (let i = 0; i <= CONV_MAX; i++) trackBox({ source, id: `${i}`, mbox: "b" });
	expect(boxOfConv(source, "0")).toBeUndefined();
	expect(boxOfConv(source, "1")).toBe("b");
	expect(boxOfConv(source, `${CONV_MAX}`)).toBe("b");
});

describe("pickBox", () => {
	const mk = (b: Partial<Box> & { id: string; conds?: Partial<Box["conds"]>; not?: Box["not"] }) => cleanBox({ name: b.id, ...b })!;
	const facts = { src: "zele", from: "Kim <Kim@Team.Example.org>", subj: "5월 문서", body: "첨부를 봐주세요" };
	test("source, address, @domain, subject and body each place a mail, lowercased", () => {
		const base = cleanBox({ id: "base", name: "일반" })!;
		const pick = (c: Partial<Box["conds"]>, f = facts) => pickBox(f, [base, mk({ id: "b", conds: c })]);
		expect(pick({ src: ["ZELE"] })).toMatchObject({ box: { id: "b" }, why: { kind: "src" } });
		expect(pick({ from: ["kim@team.example.org"] })).toMatchObject({ box: { id: "b" }, why: { kind: "from", value: "kim@team.example.org" } });
		expect(pick({ from: ["@TEAM.example.org"] })).toMatchObject({ box: { id: "b" }, why: { kind: "from" } });
		expect(pick({ from: ["@example.org"] }).box.id).toBe("base");
		expect(pick({ subj: ["문서"] })).toMatchObject({ box: { id: "b" }, why: { kind: "subj", value: "문서" } });
		expect(pick({ body: ["첨부"] })).toMatchObject({ box: { id: "b" }, why: { kind: "body" } });
		expect(pick({ subj: ["회의"], body: ["영수증"] })).toEqual({ box: base });
	});
	test("not.from vetoes the box, the next box in order is tried", () => {
		const a = mk({ id: "a", conds: { subj: ["문서"] }, not: { from: ["@team.example.org"] } }), c = mk({ id: "c", conds: { subj: ["문서"] } });
		expect(pickBox(facts, [a, c]).box.id).toBe("c");
		expect(pickBox({ ...facts, from: "lee@other.org" }, [a, c]).box.id).toBe("a");
	});
});

describe("where a new mail goes", () => {
	test("a rule places it with its reason, and the record keeps both", async () => {
		put({ accounts: { mail: { boxes: [team] } } });
		const { deps } = fakes(), source = uid("rule");
		await post(deps, source, "1", { from: "Lee <lee@team.example.org>", subject: "회의" });
		await post(deps, source, "2", { from: "spam@team.example.org", subject: "문서" });
		await post(deps, source, "3", { subject: "새 문서 부탁해요" });
		const rec = (id: string) => mailByKey(mailKey(source, id))!;
		expect([rec("1").mbox, rec("1").mwhy]).toEqual(["b-team", { kind: "from", value: "@team.example.org" }]);
		expect(rec("2").mbox).toBeUndefined();
		expect([rec("3").mbox, rec("3").mwhy]).toEqual(["b-team", { kind: "subj", value: "문서" }]);
		expect(mailCard(rec("3"), false, false, { place: boxPass(dir) })).toMatchObject({ box: "b-team", boxWhy: { kind: "subj" } });
	});

	test("a message of the same conversation stays in its box, `.N` ids included", async () => {
		put({ accounts: { mail: { boxes: [team] } } });
		const { deps } = fakes(), source = uid("thr");
		await post(deps, source, "900.1", { from: "lee@team.example.org" });
		await post(deps, source, "900.2", { from: "someone@else.org", subject: "답장이에요" });
		const second = mailByKey(mailKey(source, "900.2"))!;
		expect([second.mbox, second.mwhy]).toEqual(["b-team", { kind: "thread" }]);
		await post(deps, source, "901.1", { from: "someone@else.org", subject: "다른 대화" });
		expect(mailByKey(mailKey(source, "901.1"))!.mbox).toBeUndefined();
	});

	test("a conversation that began in base stays there when a later message would match a box", async () => {
		put({ accounts: { mail: { boxes: [team] } } });
		const { deps } = fakes(), source = uid("base");
		await post(deps, source, "910.1", { from: "someone@else.org", subject: "안부" });
		await post(deps, source, "910.2", { from: "lee@team.example.org" });
		expect(mailByKey(mailKey(source, "910.2"))!.mbox).toBeUndefined();
	});

	test("a judge hit leaves a mail the owner already moved", async () => {
		put({ accounts: { mail: { boxes: [team, { id: "b-other", name: "다른 함" }] } } });
		const { deps } = fakes(), source = uid("jdg");
		await post(deps, source, "920");
		const key = mailKey(source, "920");
		await call("POST", "/api/mailbox/move", { keys: [key], box: "b-other" });
		expect(placeByJudge(key, "b-team")).toBe(false);
		expect(mailByKey(key)!.mbox).toBe("b-other");
	});

	test("a source rule reads old mail with no box, and base mail stays base", async () => {
		const { deps } = fakes(), source = uid("old");
		await post(deps, source, "1");
		put({ accounts: { mail: { boxes: [{ id: "b-src", name: "출처", conds: { src: [source] } }] } } });
		const rec = mailByKey(mailKey(source, "1"))!;
		expect(rec.mbox).toBeUndefined();
		expect(mailCard(rec, false, false, { place: boxPass(dir) })).toMatchObject({ box: "b-src", boxWhy: { kind: "src", value: source } });
		expect(mailCard(rec).box).toBeUndefined();
	});
});

describe("quiet", () => {
	const quietBox = { id: "b-quiet", name: "조용히", mode: "quiet", conds: { subj: ["광고"] } };
	test("quiet mode records the mail unread and holds back the notice, thread, wake and draft", async () => {
		put({ accounts: { mail: { boxes: [quietBox] } } });
		const { deps, calls } = fakes(), source = uid("q");
		const res = await post(deps, source, "1", { subject: "광고 메일", wake: true });
		expect(res.thread).toBeUndefined();
		expect(calls).toMatchObject({ wakes: 0, offers: 0, threads: 0 });
		expect(calls.events).toHaveLength(1);
		expect(calls.events[0]!.incoming).toBeUndefined();
		expect(mailByKey(mailKey(source, "1"))!.mbox).toBe("b-quiet");
		expect(unreadOf(mailTarget(mailKey(source, "1")))).toBe(1);
	});

	test("notify:false mutes only the notice: the draft and the thread follow the mode", async () => {
		put({ accounts: { mail: { boxes: [{ id: "b-mute", name: "알림 없이", mode: "auto", notify: false, conds: { subj: ["소식"] } }] } } });
		const { deps, calls } = fakes(), source = uid("m");
		await post(deps, source, "1", { subject: "소식지", wake: true });
		expect(calls.events[0]!.incoming).toBeUndefined();
		expect(calls).toMatchObject({ offers: 1, threads: 1, wakes: 1 });
		expect(unreadOf(mailTarget(mailKey(source, "1")))).toBe(1);
	});
});

describe("moving", () => {
	const twoAccounts = () => {
		apps({ "mail-2": { app: "mail", label: "개인", filter: { conv: ["mail:other-"] } } });
		put({ accounts: { mail: { boxes: [team] }, "mail-2": { boxes: [{ id: "b-two", name: "둘째", conds: {} }] } } });
	};

	test("a move across accounts is refused, nothing changes", async () => {
		twoAccounts();
		const { deps } = fakes(), a = uid("a");
		await post(deps, a, "1");
		expect(instanceOf(dir, mailKey(a, "1"))).toBe("mail");
		expect(instanceOf(dir, mailKey("other", "x"))).toBe("mail-2");
		const other = await call("POST", "/api/mailbox/move", { keys: [mailKey(a, "1")], box: "b-two" });
		expect(other.status).toBe(400);
		expect(mailByKey(mailKey(a, "1"))!.mbox).toBeUndefined();
		expect(loadMailboxes(dir).pins).toEqual({});
	});

	test("two accounts in one call are refused", async () => {
		twoAccounts();
		const { deps } = fakes(), a = uid("a"), id = uid("o");
		await post(deps, a, "1");
		await post(deps, "other", id);
		const res = await call("POST", "/api/mailbox/move", { keys: [mailKey(a, "1"), mailKey("other", id)], box: "b-team" });
		expect(res.status).toBe(400);
	});

	test("moves whole conversations, pins them, leaves the draft's mail record alone, and the same call restores", async () => {
		put({ accounts: { mail: { boxes: [team] } } });
		const { deps } = fakes(), source = uid("mv");
		await post(deps, source, "7.1");
		await post(deps, source, "7.2", { messageId: "m-second" });
		const k1 = mailKey(source, "7.1"), k2 = mailKey(source, "7.2");
		setMailSuggest(k1, { kind: "reply-draft", label: "초안", ref: "d-1", state: "draft" });
		const before = { ...mailByKey(k1)! }, instance = instanceOf(dir, k1);

		const res = await call("POST", "/api/mailbox/move", { keys: [k1], box: "b-team" });
		expect(res.json).toEqual({ ok: true, moved: expect.arrayContaining([k1, k2]), was: { [k1]: "base", [k2]: "base" } });
		expect(res.json.moved).toHaveLength(2);
		const after = mailByKey(k1)!;
		expect(after).toEqual({ ...before, mbox: "b-team", mwhy: { kind: "moved" } });
		expect([after.suggest, after.reply, after.source, after.id, after.account]).toEqual([before.suggest, before.reply, before.source, before.id, before.account]);
		expect(instanceOf(dir, k1)).toBe(instance);
		expect(mailByKey(k2)!.mbox).toBe("b-team");
		expect(loadMailboxes(dir).pins[`mail|${source}-7`]).toBe("b-team");

		await post(deps, source, "7.3", { from: "z@else.org" });
		expect(mailByKey(mailKey(source, "7.3"))!.mbox).toBe("b-team");

		const back = await call("POST", "/api/mailbox/move", { keys: [k1], box: res.json.was[k1] });
		expect(back.json.ok).toBe(true);
		expect(mailByKey(k1)).toEqual(before);
		expect(mailByKey(k2)!.mbox).toBeUndefined();
		await post(deps, source, "7.4", { from: "z@else.org" });
		expect(mailByKey(mailKey(source, "7.4"))!.mbox).toBeUndefined();
	});

	test("learn adds a condition to the named box", async () => {
		put({ accounts: { mail: { boxes: [team] } } });
		expect((await call("POST", "/api/mailbox/learn", { box: "b-team", kind: "from", value: "New@Sender.org" })).json).toMatchObject({ ok: true, added: true });
		expect((await call("POST", "/api/mailbox/learn", { box: "b-team", kind: "not", value: "x@y.org" })).status).toBe(200);
		const box = boxesOf(dir, "mail").find(b => b.id === "b-team")!;
		expect([box.conds.from.at(-1), box.not.from.at(-1)]).toEqual(["new@sender.org", "x@y.org"]);
		expect((await call("POST", "/api/mailbox/learn", { box: "base", kind: "from", value: "a@b.org" })).status).toBe(400);
		expect((await call("POST", "/api/mailbox/learn", { box: "b-none", kind: "from", value: "a@b.org" })).status).toBe(404);
	});
});

describe("boxes", () => {
	test("PUT creates with a server id and updates, the base box is stored when edited", async () => {
		const made = await call("PUT", "/api/mailbox/box", { app: "mail", box: { name: "새 함", mode: "ask" } });
		expect(made.json.box.id).toMatch(/^b-[0-9a-f]{8}$/);
		const edited = await call("PUT", "/api/mailbox/box", { app: "mail", box: { ...made.json.box, name: "바뀐 이름" } });
		expect(edited.json.box.id).toBe(made.json.box.id);
		await call("PUT", "/api/mailbox/box", { app: "mail", box: { id: "base", name: "받은 편지", mode: "notify" } });
		expect(boxesOf(dir, "mail").map(b => [b.id, b.name])).toEqual([["base", "받은 편지"], [made.json.box.id, "바뀐 이름"]]);
		expect((await call("PUT", "/api/mailbox/box", { app: "nope", box: { name: "x" } })).status).toBe(404);
		expect((await call("DELETE", "/api/mailbox/box", { app: "mail", id: "base" })).status).toBe(400);
	});

	test("deleting a box sends its mail back to base and never deletes mail", async () => {
		put({ accounts: { mail: { boxes: [team] } } });
		const { deps } = fakes(), source = uid("del");
		await post(deps, source, "1", { from: "a@team.example.org" });
		await post(deps, source, "2", { subject: "무관" });
		const key = mailKey(source, "1");
		await call("POST", "/api/mailbox/move", { keys: [mailKey(source, "2")], box: "b-team" });
		expect(mailByKey(key)!.mbox).toBe("b-team");
		expect((await call("DELETE", "/api/mailbox/box", { app: "mail", id: "b-team" })).json).toEqual({ ok: true });
		for (const k of [key, mailKey(source, "2")]) {
			expect(mailByKey(k)).toBeDefined();
			expect(mailByKey(k)!.mbox).toBeUndefined();
			expect(boxPass(dir)(mailByKey(k)!)).toEqual({ box: "base" });
		}
		expect(Object.keys(loadMailboxes(dir).pins)).toEqual([]);
		expect(boxesOf(dir, "mail").map(b => b.id)).toEqual(["base"]);
	});

	test("removing the file restores base for everything, the records stay where they are", async () => {
		put({ accounts: { mail: { boxes: [team] } } });
		const { deps } = fakes(), source = uid("rm");
		await post(deps, source, "1", { from: "a@team.example.org" });
		const rec = mailByKey(mailKey(source, "1"))!;
		expect(boxPass(dir)(rec).box).toBe("b-team");
		rmSync(file);
		expect(boxPass(dir)(rec)).toEqual({ box: "base" });
		expect(boxesOf(dir, "mail").map(b => b.id)).toEqual(["base"]);
		expect(withBoxes({ key: "mail", app: "mail" }, dir)).toMatchObject({ boxes: [{ id: "base" }] });
	});

	test("integration items of other apps are left as they are", () => {
		const item = { key: "kakao", app: "kakao" };
		expect(withBoxes(item, dir)).toBe(item);
	});
});

describe("suggest and tone", () => {
	const get = async (path: string) => {
		const res = await mailboxRoute(new Request(`http://hub${path}`), new URL(`http://hub${path}`), dir);
		return { status: res.status, json: (await res.json()) as Record<string, any> };
	};

	test("suggest groups the mail still in base by sender domain, bounded, without free-mail domains or mail already in a box", async () => {
		const { deps } = fakes(), source = uid("sg"), tag = uid("t");
		put({ accounts: { mail: { boxes: [{ id: "b-boxed", name: "나눈 함", conds: { from: [`@boxed-${tag}.com`] } }] } } });
		let n = 0;
		const send = async (from: string, times: number) => { for (let i = 0; i < times; i++) await post(deps, source, String(++n), { from, subject: `s${n}` }); };
		await send(`Big <a@big-${tag}.com>`, 30);
		for (let i = 0; i < SUGGEST_MAX + 4; i++) await send(`m@g${i}-${tag}.com`, 2);
		await send(`one@one-${tag}.com`, 1);
		await send("a@gmail.com", 3);
		await send("b@naver.com", 3);
		await send(`c@boxed-${tag}.com`, 3);
		const res = await get("/api/mailbox/suggest?app=mail");
		const groups = res.json.groups as { domain: string; label: string; count: number; senders: string[]; keys: string[] }[];
		expect(res.status).toBe(200);
		expect(groups).toHaveLength(SUGGEST_MAX);
		expect(groups.map(g => g.count)).toEqual([...groups.map(g => g.count)].sort((a, b) => b - a));
		expect(groups.every(g => g.count >= 2)).toBe(true);
		const domains = groups.map(g => g.domain);
		for (const free of ["@gmail.com", "@naver.com", `@boxed-${tag}.com`, `@one-${tag}.com`]) expect(domains).not.toContain(free);
		const big = groups.find(g => g.domain === `@big-${tag}.com`)!;
		expect([big.count, big.label, big.senders, big.keys]).toEqual([30, `big-${tag}`, ["Big"], expect.any(Array)]);
		expect(big.keys).toHaveLength(30);
		expect((await get("/api/mailbox/suggest?app=nope")).status).toBe(404);
	});

	test("tone reads the box's own file: the summary, the corrections, and whether the box has a file of its own", async () => {
		put({ accounts: { mail: { boxes: [team, { id: "b-plain", name: "조용한 함" }] } } });
		{
			mkdirSync(join(dir, "custom", "reply-drafts", "tone", "mail"), { recursive: true });
			writeFileSync(join(dir, "custom", "reply-drafts", "tone", "mail", "b-team.md"), "## 정체성\n\n- 정중하게 써요\n\n## 고친 점\n\n- 2031-01-01: 더 짧게\n");
			expect((await get("/api/mailbox/tone?app=mail&box=b-team")).json).toMatchObject({ ok: true, own: true, summary: "정중하게 써요", corrections: ["2031-01-01: 더 짧게"] });
			expect((await get("/api/mailbox/tone?app=mail&box=b-plain")).json).toMatchObject({ ok: true, own: false, summary: "", corrections: [] });
			expect((await get("/api/mailbox/tone?app=mail&box=b-none")).status).toBe(404);
		}
	});
});
