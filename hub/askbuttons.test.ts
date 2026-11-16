import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEscalations, escalations, setEscalationsForTest } from "./escalate.ts";
import { ASK_PREFIX, askComponents, askComponentsFor, askInteraction, parseAskId } from "./askbuttons.ts";
import type { Interaction } from "./discord.ts";
import { buildPayloads } from "./discord-format.ts";
import { draftApprovalBlock } from "./draft-approval.ts";
import { setReplies } from "./reply-actions.ts";

const ASK = "[ask] 시작 설정\n\n**1) 지금 고치기**\n재부팅 뒤에도 켜져요\n**2) 그대로 두기**\n다음 재부팅까지는 괜찮아요";

test("one button per option, all secondary", () => {
	const rows = askComponentsFor("lane:fix", ASK) as { type: number; components: { style: number; label: string; custom_id: string; disabled: boolean }[] }[];
	expect(rows).toHaveLength(1);
	expect(rows[0]!.components.map(c => [c.label, c.style, c.custom_id, c.disabled])).toEqual([
		["지금 고치기", 2, `${ASK_PREFIX}:lane:fix:1`, false],
		["그대로 두기", 2, `${ASK_PREFIX}:lane:fix:2`, false],
	]);
});

test("rows of 5, label cut to 80, at most 25 buttons", () => {
	const options = Array.from({ length: 7 }, (_, i) => ({ n: i + 1, label: "가".repeat(100) }));
	const rows = askComponents("chat", options) as { components: { label: string }[] }[];
	expect(rows.map(r => r.components.length)).toEqual([5, 2]);
	expect(rows[0]!.components[0]!.label).toHaveLength(80);
});

test("no buttons without [ask], without a choice block, or when the id would be too long", () => {
	expect(askComponentsFor("chat", ASK.replace("[ask]", "[done]"))).toEqual([]);
	expect(askComponentsFor("chat", "[ask] 이거 해도 돼요?")).toEqual([]);
	expect(askComponentsFor(`lane:${"x".repeat(100)}`, ASK)).toEqual([]);
});

test("buttons only on a part that still holds every option", () => {
	expect(askComponentsFor("chat", ASK, "**2) 그대로 두기**")).toEqual([]);
	expect(askComponentsFor("chat", ASK, ASK)).not.toEqual([]);
	expect(askComponentsFor("chat", ASK, buildPayloads(ASK)[0]!.content)).not.toEqual([]);
	expect(askComponentsFor("chat", ASK, ASK.slice(ASK.indexOf("**1)")))).toEqual([]);
});

test("custom_id round trip keeps targets with colons, and a form's draft hash", () => {
	expect(parseAskId(`${ASK_PREFIX}:ch:123:2:0123456789abcdef`)).toEqual({ target: "ch:123", n: 2, hash: "0123456789abcdef" });
	expect(parseAskId(`${ASK_PREFIX}:lane:fix:2`)).toEqual({ target: "lane:fix", n: 2 });
	expect(parseAskId(`${ASK_PREFIX}:ch:123:12`)).toEqual({ target: "ch:123", n: 12 });
	expect(parseAskId("dz-auth:abc:approve")).toBeUndefined();
});

function click(user: string, customId: string, content = ASK): Interaction {
	return { id: "i1", token: "t", type: 3, member: { user: { id: user } }, message: { content }, data: { custom_id: customId } };
}

function harness(owner = "owner-1") {
	const replies: { type: number; data?: any }[] = [];
	const answers: [string, string][] = [];
	return {
		replies,
		answers,
		run: (d: Interaction, fail = false) =>
			askInteraction(d, {
				owner,
				reply: async (_d, type, data) => void replies.push({ type, data }),
				answer: (target, text) => {
					if (fail) throw new Error("nope");
					answers.push([target, text]);
				},
			}),
	};
}

test("the owner's click answers like typed text and disables every button on the message", async () => {
	const h = harness();
	await h.run(click("owner-1", `${ASK_PREFIX}:lane:fix:1`));
	expect(h.answers).toEqual([["lane:fix", "1) 지금 고치기"]]);
	expect(h.replies).toHaveLength(1);
	expect(h.replies[0]!.type).toBe(7);
	const buttons = h.replies[0]!.data.components[0].components;
	expect(buttons.map((b: any) => b.disabled)).toEqual([true, true]);
	expect(buttons.map((b: any) => b.custom_id)).toEqual([`${ASK_PREFIX}:lane:fix:1`, `${ASK_PREFIX}:lane:fix:2`]);
});

test("another user is refused and nothing is delivered", async () => {
	const h = harness();
	await h.run(click("intruder", `${ASK_PREFIX}:lane:fix:1`));
	expect(h.answers).toEqual([]);
	expect(h.replies.map(r => [r.type, r.data.flags])).toEqual([[4, 64]]);
});

test("an unknown option or a message without choices is answered ephemerally", async () => {
	const h = harness();
	await h.run(click("owner-1", `${ASK_PREFIX}:lane:fix:9`));
	await h.run(click("owner-1", `${ASK_PREFIX}:lane:fix:1`, "no choices here"));
	expect(h.answers).toEqual([]);
	expect(h.replies.map(r => [r.type, r.data.flags])).toEqual([[4, 64], [4, 64]]);
});

test("a click on a stronger-model card acts on the proposal, in a session channel and in the main chat", async () => {
	const dir = mkdtempSync(join(tmpdir(), "askbuttons-escalate-"));
	const cards: string[] = [];
	const launched: string[] = [];
	setEscalationsForTest(
		createEscalations({
			file: join(dir, "escalations.json"),
			now: Date.now,
			post: (_target, text) => void cards.push(text),
			launch: async req => (launched.push(req.session), { lane: `${req.name}` }),
			tell: () => {},
			stop: () => {},
		}),
	);
	try {
		const e = escalations()!;
		const ask = { cwd: "/home/user/repo", current: "acme/mid-model:medium", offer: "acme/mid-model:high", step: "rewrite the parser", reason: "three tries failed", est: 5 };
		await e.propose({ ...ask, asker: "lane:parser" });
		await e.propose({ ...ask, asker: "main" });
		const h = harness();
		await h.run(click("owner-1", `${ASK_PREFIX}:lane:parser:1`, cards[0]));
		await h.run(click("owner-1", `${ASK_PREFIX}:chat:1`, cards[1]));
		expect(launched).toEqual(["lane:parser", "main"]);
		expect(h.answers.map(a => a[0])).toEqual(["lane:parser", "chat"]);
	} finally {
		setEscalationsForTest(undefined);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("A6: a pick the reply flow refuses is answered ephemerally with its reason, once, and the message (its buttons) is left as is", async () => {
	const replies: { type: number; data?: any }[] = [];
	const refusal = "refused-reason";
	await askInteraction(click("owner-1", `${ASK_PREFIX}:lane:fix:1`), { owner: "owner-1", reply: async (_d, type, data) => void replies.push({ type, data }), answer: async () => refusal });
	expect(replies.map(r => [r.type, r.data.flags, r.data.content])).toEqual([[4, 64, refusal]]);
});

test("a failed delivery leaves the buttons enabled and tells the owner", async () => {
	const h = harness();
	await h.run(click("owner-1", `${ASK_PREFIX}:lane:fix:2`), true);
	expect(h.replies.map(r => [r.type, r.data.flags])).toEqual([[4, 64]]);
});

// A reply draft's card (the reply clarity design, amendment A): 보내기 · 고치기 · 보내지 않기, and 고치기 opens one form with the draft's text
// and optional words for the AI.
describe("a reply draft's 고치기 form", () => {
	const CARD = `[ask] 답장 초안을 만들었어요\n${draftApprovalBlock({ to: "kim@example.com", body: "확인해 보고 말씀드릴게요.", ref: "RAAAAAA", question: "이 답장 보낼까요?" })}`;
	let shown = "확인해 보고 말씀드릴게요.";
	// The version the store holds now, as ReplyItem draft.hash would name it.
	const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
	beforeEach(() => {
		shown = "확인해 보고 말씀드릴게요.";
		setReplies({ view: async (ref: string) => (ref === "RAAAAAA" ? { draft: { text: shown, hash: hashOf(shown) } } : undefined) } as never);
	});
	afterEach(() => setReplies(undefined));
	const draftHarness = () => {
		const replies: { type: number; data?: any }[] = [];
		const answers: { text: string; picks: unknown[]; edit?: string }[] = [];
		const run = (d: Interaction) => askInteraction(d, { owner: "owner-1", reply: async (_d, type, data) => void replies.push({ type, data }), answer: (_t, text, picks, edit) => void answers.push({ text, picks, ...(edit !== undefined ? { edit } : {}) }) });
		return { replies, answers, run };
	};
	const submit = (fields: Record<string, string>, opened = shown): Interaction => ({ id: "i2", token: "t", type: 5, member: { user: { id: "owner-1" } }, message: { content: CARD }, data: { custom_id: `${ASK_PREFIX}:chat:2:${hashOf(opened)}`, components: Object.entries(fields).map(([custom_id, value]) => ({ type: 1, components: [{ type: 4, custom_id, value }] })) } } as Interaction);
	const fix = { q: "결정: 이 답장 보낼까요? (RAAAAAA)", n: 2, label: "고치기" };

	test("the buttons are 보내기 · 고치기 · 보내지 않기", () => {
		const rows = askComponentsFor("chat", CARD) as { components: { label: string }[] }[];
		expect(rows[0]!.components.map(c => c.label)).toEqual(["보내기", "고치기", "보내지 않기"]);
	});

	test("고치기 opens the form: the draft's text prefilled, then optional words; a text over 4000 characters leaves only the words", async () => {
		const h = draftHarness();
		await h.run(click("owner-1", `${ASK_PREFIX}:chat:2`, CARD));
		shown = "가".repeat(4001);
		await h.run(click("owner-1", `${ASK_PREFIX}:chat:2`, CARD));
		expect(h.replies.map(r => r.data.custom_id)).toEqual([`${ASK_PREFIX}:chat:2:${hashOf("확인해 보고 말씀드릴게요.")}`, `${ASK_PREFIX}:chat:2:${hashOf(shown)}`]);
		const fields = h.replies.map(r => [r.type, r.data.components.map((row: any) => [row.components[0].custom_id, row.components[0].value, row.components[0].required])]);
		expect(fields).toEqual([
			[9, [["text", "확인해 보고 말씀드릴게요.", true], ["note", undefined, false]]],
			[9, [["note", undefined, false]]],
		]);
		expect(h.answers).toEqual([]);
	});

	test("submit: changed text only is an edit, words only a revise, both an edit then a revise, neither nothing", async () => {
		const h = draftHarness();
		await h.run(submit({ text: "내일 오전까지 보내드릴게요.", note: "" }));
		await h.run(submit({ text: "확인해 보고 말씀드릴게요.", note: "더 공손하게" }));
		await h.run(submit({ text: "내일 오전까지 보내드릴게요.", note: "더 공손하게" }));
		await h.run(submit({ text: "확인해 보고 말씀드릴게요.\n", note: "  " }));
		await h.run(submit({ note: "더 짧게" }));
		expect(h.answers).toEqual([
			{ text: "2) 고치기", picks: [fix], edit: "내일 오전까지 보내드릴게요." },
			{ text: "2) 고치기 - 더 공손하게", picks: [{ ...fix, note: "더 공손하게" }] },
			{ text: "2) 고치기 - 더 공손하게", picks: [{ ...fix, note: "더 공손하게" }], edit: "내일 오전까지 보내드릴게요." },
			{ text: "2) 고치기 - 더 짧게", picks: [{ ...fix, note: "더 짧게" }] },
		]);
		expect(h.replies.map(r => [r.type, r.data.flags])).toEqual([[7, undefined], [7, undefined], [7, undefined], [4, 64], [7, undefined]]);
	});

	test("a form opened on an older version does nothing on submit: no edit, no revise, the buttons stay", async () => {
		const h = draftHarness();
		const opened = shown;
		shown = "다음 주에 다시 연락드릴게요.";
		await h.run(submit({ text: opened, note: "더 공손하게" }, opened));
		await h.run(submit({ text: "내일 오전까지 보내드릴게요.", note: "" }, opened));
		await h.run({ ...submit({ note: "더 짧게" }), data: { ...submit({ note: "더 짧게" }).data, custom_id: `${ASK_PREFIX}:chat:2` } } as Interaction);
		expect(h.answers).toEqual([]);
		expect(h.replies.map(r => [r.type, r.data.flags, r.data.components])).toEqual([[4, 64, undefined], [4, 64, undefined], [4, 64, undefined]]);
	});
});
