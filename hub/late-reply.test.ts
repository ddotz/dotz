import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settleWaiting } from "./awaiting.ts";
import { buildPayloads } from "./discord-format.ts";
import { emit, ownerMessage } from "./events.ts";
import { createPrompts } from "./prompts.ts";
import { isLate, lateQuote, lateRequestId, LATE_MS, replyRef, snowflakeTime, withQuote } from "./threads.ts";

const SNOW = "1561565203714408448";
const snowAt = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString();

test("a web short id resolves to the owner message it names", () => {
	emit("inbox", { ts: "2026-10-23T07:22:48.000Z", kind: "message", source: "web", channel: "ch:1", author: "hyuns", text: "계정 고정 스위치 만들어 줘", mid: "cbfba25d" });
	expect(ownerMessage("cbfba25d")).toEqual({ text: "계정 고정 스위치 만들어 줘", ts: "2026-10-23T07:22:48.000Z", author: "hyuns" });
	expect(ownerMessage("00000000")).toBeUndefined();
});

test("a Discord id carries message_reference, and a late answer pings the owner through it", () => {
	const plain = buildPayloads("[done] 끝", SNOW)[0]!;
	expect(plain.message_reference).toEqual({ message_id: SNOW, fail_if_not_exists: false });
	expect(plain.allowed_mentions).toEqual({ parse: [] });
	const late = buildPayloads("[done] 끝", SNOW, undefined, "42")[0]!;
	expect(late.message_reference?.message_id).toBe(SNOW);
	expect(late.allowed_mentions).toEqual({ parse: [], replied_user: true });
	expect(late.content).not.toContain("<@");
});

test("a late answer to a web message has no reference to send, so it mentions the owner and quotes the request after the marker", () => {
	const quote = lateQuote({ text: "계정 고정\n스위치", ts: "2026-10-23T07:22:48.000Z" }, "Asia/Seoul");
	expect(quote).toContain("10. 23.");
	expect(quote).toContain("\"계정 고정 스위치\"");
	const body = buildPayloads(withQuote("[done] 바꿨어요", quote), "cbfba25d", undefined, "42")[0]!;
	expect(body.message_reference).toBeUndefined();
	expect(body.content.startsWith("<@42> ✅ 원본 메시지(")).toBe(true);
	expect(body.content).toContain("바꿨어요");
	expect(body.allowed_mentions).toEqual({ parse: [], users: ["42"] });
	expect(withQuote("그냥 답", "")).toBe("그냥 답");
});

test("an answer is late when the owner wrote newer or the request is over two minutes old", () => {
	const now = Date.parse("2026-10-23T07:40:00Z");
	expect(isLate("a", "a", now - 10_000, now)).toBe(false);
	expect(isLate("a", "b", now - 10_000, now)).toBe(true);
	expect(isLate("a", "a", now - LATE_MS - 1, now)).toBe(true);
	expect(isLate(undefined, "b", 0, now)).toBe(false);
	expect(snowflakeTime(snowAt(now))).toBe(now);
	expect(replyRef("th:700", SNOW, SNOW)).toBeUndefined();
	expect(replyRef("th:700", SNOW, SNOW, true)).toBe(SNOW);
});

test("a post that names no request gets the late request of the turn or the deferred prompt in that conversation", () => {
	const now = Date.parse("2026-10-23T07:40:00Z");
	const old = now - 15 * 60_000;
	const at = () => old;
	expect(lateRequestId("ch:1", { target: "ch:1", replyTo: "r1" }, [], "r2", at, now)).toBe("r1");
	expect(lateRequestId("ch:1", undefined, [{ target: "ch:2", replyTo: "x" }, { target: "ch:1", replyTo: "r1" }], "r1", at, now)).toBe("r1");
	expect(lateRequestId("ch:1", undefined, [{ target: "ch:1", replyTo: "r1" }], "r1", () => now - 5_000, now)).toBeUndefined();
	expect(lateRequestId("ch:1", { target: "ch:1", replyTo: "r1", done: true }, [], "r1", at, now)).toBe(undefined);
	expect(lateRequestId("ch:9", undefined, [], "r1", at, now)).toBeUndefined();
});

test("an answer to one request does not mark an older waiting request answered", () => {
	const open = [{ ref: "cbfba25d", by: "cbfba25d" }, { ref: "907d13a8", by: "5f483c2a" }, { ref: "5f483c2a", by: "5f483c2a" }];
	const r = settleWaiting(open, "5f483c2a", false);
	expect(r.done.map(w => w.ref)).toEqual(["907d13a8", "5f483c2a"]);
	expect(r.keep.map(w => w.ref)).toEqual(["cbfba25d"]);
	expect(settleWaiting(open, "5f483c2a", true).keep).toEqual([]);
	expect(settleWaiting(open, undefined, false).keep).toEqual([]);
});

const reply = readFileSync(join(import.meta.dir, "..", "web", "js", "39-reply.js"), "utf8");
const part = (name: string) => reply.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))![0];
type Node = { cls: string; kids: unknown[]; click?: () => void };
const el = (_tag: string, p: { class?: string; text?: string; onclick?: () => void } | null, ...kids: unknown[]): Node => ({ cls: p?.class ?? "", kids: p?.text !== undefined ? [p.text, ...kids] : kids, click: p?.onclick });
const quoteOf = (msgs: Record<string, unknown>[]) =>
	new Function("el", "ts", "target", "rpJump", `const RP_QUOTE = 300;\n${part("rpText")}\n${part("rpAsked")}\n${part("rpQuote")}\nreturn rpQuote;`)(el, () => ({ msgs }), "ch:1", () => {}) as (e: Record<string, unknown>) => Node | null;
const texts = (n: Node): string[] => n.kids.map(k => (typeof k === "string" ? k : (k as Node).kids[0] as string));

test("the web draws a bot message that replies to an owner message with the same quote block, from the hub's reply or from the loaded message", () => {
	const rpQuote = quoteOf([{ kind: "message", mid: "cbfba25d", author: "hyuns", text: "계정 고정 만들어 줘" }]);
	const sent = rpQuote({ kind: "out", reply_to: "cbfba25d", reply: { id: "cbfba25d", author: "hyuns", content: "계정 고정 만들어 줘" } })!;
	expect(sent.cls).toBe("rpq");
	expect(texts(sent)).toEqual(["나", "계정 고정 만들어 줘"]);
	const old = rpQuote({ kind: "out", reply_to: "cbfba25d" })!;
	expect(texts(old)).toEqual(["나", "계정 고정 만들어 줘"]);
	expect(rpQuote({ kind: "out", reply_to: "ffffffff" })).toBeNull();
	expect(rpQuote({ kind: "out" })).toBeNull();
});

test("a turn that ends with [later] leaves its request waiting until a real answer, and the woken run answers that request alone", async () => {
	const posts: { target: string; text: string; replyTo?: string }[] = [];
	const q = createPrompts({
		deliver: () => {},
		steer: () => true,
		working: () => false,
		note: () => "",
		isNote: () => false,
		post: async (target, text, replyTo) => (posts.push({ target, text, replyTo }), { delivered: true }),
		clearProgress: () => {},
		persist: () => {},
		log: () => {},
	});
	q.deliver("[dotz inbox] ch:1 msg=a1111111\n계정 고정", { target: "ch:1", replyTo: "a1111111", owner: true });
	q.deliver("[dotz inbox] ch:1 msg=b2222222\n다른 일", { target: "ch:1", replyTo: "b2222222", owner: true });
	q.onPrompt("[dotz inbox] ch:1 msg=a1111111\n계정 고정");
	q.onAnswer("[later]");
	q.settleTurn();
	expect(posts).toEqual([]);
	expect(q.isAnswered("a1111111")).toBe(false);
	expect(q.deferredOpen().map(d => d.replyTo)).toEqual(["a1111111"]);
	q.onAnswer("[done] 바꿨어요");
	await Promise.resolve();
	await Promise.resolve();
	expect(posts).toEqual([{ target: "ch:1", text: "[done] 바꿨어요", replyTo: "a1111111" }]);
	expect(q.isAnswered("b2222222")).toBe(false);
});
