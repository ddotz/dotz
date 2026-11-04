import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { previewOf } from "./conversations.ts";
import { fakeHub, json, on } from "./test-web.ts";

// Messages from another computer's gateway (web/js/01-peer-msg.js) in a real page: the kinds hub/peer-monitor.ts writes are cards, the chat-list preview,
// a notice row and a quote read one Korean line, and every other message keeps its bubble and its text.
const INSTRUCTION = "The owner explicitly handed this work over from 맥미니. Take it as the owner's own instruction and continue it here now; do not ask whether to take it. Answer the owner here as usual.";
const handoff = `[peer handoff from 맥미니 id=abc123] ${INSTRUCTION}\n\nOwner's words (verbatim):\n맥북에서 이어서 해 \`bun test\`\n\nHandoff note:\n브랜치 \`main\`\n\n\`\`\`sh\ngit pull\n\`\`\``;
const ack = "✅ 맥미니에서 넘긴 작업을 받아 이어서 해요 (id abc123)";
const ts = (i: number) => new Date(Date.UTC(2026, 10, 4, 1, i)).toISOString();
const events = [
	{ ts: ts(0), kind: "message", source: "web", channel: "web", mid: "h1", via: "맥미니", text: handoff },
	{ ts: ts(1), kind: "message", source: "web", channel: "web", mid: "s1", via: "맥미니 땅콩", text: "[맥미니에서 넘기는 수정 요청] 고쳐 주세요\n```ts\nconst a = 1;\n```" },
	{ ts: ts(2), kind: "out", source: "orchestrator", target: "chat", text: ack },
	{ ts: ts(3), kind: "message", source: "web", channel: "web", mid: "b1", text: "[중요] 오늘 일정 알려 줘" },
	{ ts: ts(4), kind: "message", source: "web", channel: "web", mid: "b2", text: handoff },
	{ ts: ts(5), kind: "out", source: "orchestrator", target: "chat", text: "✅ 끝났어요" },
];
const hub = fakeHub({
	api: (_req, url) => {
		if (url.pathname === "/api/history") { const t = url.searchParams.get("target"); return json({ target: t, events: t === "main" ? events : [] }); }
		if (url.pathname === "/api/activity") return json({ items: [], more: false, history: false });
		return undefined;
	},
});
const view = await hub.view({ width: 412, height: 844 });
const { ev, waitFor } = on(view);
afterAll(() => hub.stop());
beforeAll(async () => {
	await view.navigate(`${hub.origin}/#chat`);
	await waitFor(`document.querySelectorAll("#tl .pmc").length === 3`);
});
const row = (t: string) => `document.querySelector('#tl [data-ts="${t}"]')`;
const card = (t: string) => ev<{ text: string; tag: string; pc: string; computer: boolean }>(`(n => ({ text: n.querySelector(".pmc-b").textContent.trim(), tag: n.querySelector(".tag").textContent, pc: n.querySelector(".mn").textContent, computer: !!n.querySelector(".pmc-hd svg") }))(${row(t)})`);

describe("peer message card", () => {
	test("a handoff shows the computer, the kind and the owner's words; the note opens with one tap and the instruction is hidden", async () => {
		expect(await card(ts(0))).toEqual({ text: "맥북에서 이어서 해 bun test", tag: "작업 넘김", pc: "맥미니", computer: true });
		expect(await ev(`${row(ts(0))}.textContent.includes("The owner explicitly")`)).toBe(false);
		expect(await ev(`${row(ts(0))}.querySelector(".pmc-b code").textContent`)).toBe("bun test");
		expect(await ev(`(d => [d.open, d.querySelector("summary").textContent, d.querySelector(".pmc-n pre").textContent.trim()])(${row(ts(0))}.querySelector("details"))`)).toEqual([false, "인계 메모", "git pull"]);
	});
	test("a dotz_peer send keeps its words and code, bracket included", async () => {
		const c = await card(ts(1));
		expect([c.tag, c.pc]).toEqual(["메시지", "맥미니 땅콩"]);
		expect(c.text).toContain("[맥미니에서 넘기는 수정 요청] 고쳐 주세요");
		expect(await ev(`${row(ts(1))}.querySelector(".pmc-b pre").textContent.trim()`)).toBe("const a = 1;");
	});
	test("an ack is a card without its id in the text", async () => {
		expect(await card(ts(2))).toEqual({ text: "넘긴 작업을 이어서 해요", tag: "작업 받음", pc: "맥미니", computer: true });
	});
	test("an ordinary message stays what it was, a bracket at the start or a pasted handoff without `via` included", async () => {
		expect(await ev(`[${row(ts(3))}.className, ${row(ts(3))}.querySelector(".ub").textContent]`)).toEqual(["um", "[중요] 오늘 일정 알려 줘"]);
		expect(await ev(`${row(ts(4))}.querySelector(".ub").textContent.startsWith("[peer handoff from 맥미니")`)).toBe(true);
		expect(await ev(`${row(ts(5))}.className.includes("pmc")`)).toBe(false);
	});
	test("the owner's own message forwarded from the other computer's page stays his: a mail or settings conversation, or a decision answer", async () => {
		const asks = [{ channel: "mail:x" }, { conv: "mail:x" }, { channel: "settings:kakao" }, { channel: "th:1" }, { channel: "web", decision: "n1" }, { channel: "web", picks: [{ q: "q", n: 1 }] }];
		expect(await ev(`${JSON.stringify(asks)}.map(a => peerMsgOf({ kind: "message", via: "맥미니", text: "보내 주세요", ...a }))`)).toEqual(asks.map(() => null));
	});
});

describe("one line for every other place", () => {
	const HANDOFF = "맥미니에서 작업을 넘겼어요", ACK = "맥미니에서 작업을 이어받았어요";
	test("the chat-list preview reads the same from the full text and from the hub's stored 120-character preview", async () => {
		const stored = [previewOf(handoff), previewOf(ack)];
		expect(await ev(`[${[handoff, ack, ...stored].map(s => `convPreview(${JSON.stringify(s)})`).join(",")}]`)).toEqual([HANDOFF, ACK, HANDOFF, ACK]);
	});
	test("a notice row and a stored quote read it too", async () => {
		expect(await ev(`[hcLine({ title: "알림", text: ${JSON.stringify(ack)} }), ntPlain(${JSON.stringify(handoff)}), ntOfEvent({ kind: "out", ts: "x", text: ${JSON.stringify(ack)} }).text]`)).toEqual([ACK, HANDOFF, ACK]);
		expect(await ev(`rpQuote({ kind: "message", reply: { id: "h1", author: "", content: ${JSON.stringify(handoff.slice(0, 300))} } })?.querySelector(".rpq-ct").textContent ?? null`)).toBe(HANDOFF);
	});
	test("quoting a handoff takes the owner's words, not the instruction", async () => {
		expect(await ev(`rpText({ kind: "message", via: "맥미니", text: ${JSON.stringify(handoff)} })`)).toBe("맥북에서 이어서 해 `bun test`");
	});
	test("any other text passes through unchanged", async () => {
		const same = ["[중요] 오늘 일정", "[peer handoff 없음", "✅ 끝났어요", "✅ 맥북에서 넘긴 작업을 받아 이어서 해요", ""];
		expect(await ev(`${JSON.stringify(same)}.map(peerMsgLine)`)).toEqual(same);
	});
});
