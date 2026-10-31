import { expect, test } from "bun:test";
import { ASK_PREFIX, askComponents, askComponentsFor, askInteraction, parseAskId } from "./askbuttons.ts";
import type { Interaction } from "./discord.ts";
import { buildPayloads } from "./discord-format.ts";

const ASK = "[ask] 시작 설정\n\n**1) 지금 고치기** ← 추천\n재부팅 뒤에도 켜져요\n**2) 그대로 두기**\n다음 재부팅까지는 괜찮아요";

test("one button per option, recommended primary, others secondary", () => {
	const rows = askComponentsFor("lane:fix", ASK) as { type: number; components: { style: number; label: string; custom_id: string; disabled: boolean }[] }[];
	expect(rows).toHaveLength(1);
	expect(rows[0]!.components.map(c => [c.label, c.style, c.custom_id, c.disabled])).toEqual([
		["지금 고치기", 1, `${ASK_PREFIX}:lane:fix:1`, false],
		["그대로 두기", 2, `${ASK_PREFIX}:lane:fix:2`, false],
	]);
});

test("rows of 5, label cut to 80, at most 25 buttons", () => {
	const options = Array.from({ length: 7 }, (_, i) => ({ n: i + 1, label: "가".repeat(100), recommended: false }));
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

test("custom_id round trip keeps targets with colons", () => {
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

test("a failed delivery leaves the buttons enabled and tells the owner", async () => {
	const h = harness();
	await h.run(click("owner-1", `${ASK_PREFIX}:lane:fix:2`), true);
	expect(h.replies.map(r => [r.type, r.data.flags])).toEqual([[4, 64]]);
});
