import { afterAll, describe, expect, test } from "bun:test";
import { parseDecisions } from "../../../hub/choices.ts";
import { ASK_EXIT, runDraft } from "../bin/draft.ts";
import { fakeModel, j, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);

const ask = j({ action: "ask", reason: "needs his call", question: "티켓 취소할까?", choices: ["취소해", "다른 날 물어봐", "그냥 가자"], to: "", body: "", questions: [] });
const reply = (body: string) => j({ action: "draft", reason: "r", to: "room", body, questions: [] });
const chat = ["new", "--mail", "k-1", "--app", "kakao", "--kind", "chat", "--from", "room"];
const MSG = "티켓 취소 도와드리냐고 하는데 걍 취소 ㄱㄱ 하까";

describe("a chat message that needs the owner's decision", () => {
	test("exits 4 with the choice block on stdout and drafts nothing", async () => {
		const m = fakeModel([ask]);
		const out = await runDraft(chat, MSG, { call: m.call });
		expect(out.code).toBe(ASK_EXIT);
		expect(ASK_EXIT).toBe(4);
		expect(m.calls).toHaveLength(1);
		expect(m.calls[0]!.system).toContain('"action":"ask"');
		const text = out.lines.join("\n");
		expect(text.split("\n")[0]).toBe("결정: 티켓 취소할까?");
		const { blocks } = parseDecisions(text);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.options.map(o => o.label)).toEqual(["취소해", "다른 날 물어봐", "그냥 가자", "직접 쓸게"]);
		expect(blocks[0]!.options.map(o => !!o.detail)).toEqual([false, false, false, true]);
	});

	test("--choice writes the reply for that pick (exit 0) from a prompt that carries the decision and has no decision step", async () => {
		const m = fakeModel([reply("ㅇㅇ 걍 취소하자")]);
		const out = await runDraft([...chat, "--choice", "취소해"], MSG, { call: m.call });
		expect(out).toMatchObject({ code: 0, lines: ["ㅇㅇ 걍 취소하자"] });
		expect(m.calls).toHaveLength(1);
		expect(m.calls[0]!.user).toContain('"취소해"');
		expect(m.calls[0]!.system).not.toContain('"action":"ask"');
	});

	test("a model that asks again after a pick is retried once and then fails; a mail never gets a question", async () => {
		const again = fakeModel([ask]);
		await expect(runDraft([...chat, "--choice", "취소해"], MSG, { call: again.call })).rejects.toThrow();
		expect(again.calls).toHaveLength(2);
		const mail = fakeModel([ask]);
		await expect(runDraft(["new", "--mail", "m-9", "--from", "kim@example.com", "--subject", "문의"], "일정이 어때요?", { call: mail.call })).rejects.toThrow();
		expect(mail.calls[0]!.system).not.toContain('"action":"ask"');
	});

	test("a message that needs no decision is still drafted as before (exit 0), and a skip still exits 3", async () => {
		expect(await runDraft(chat, "밥 먹었어?", { call: fakeModel([reply("ㅇㅇ 먹음")]).call })).toMatchObject({ code: 0, lines: ["ㅇㅇ 먹음"] });
		expect(await runDraft(chat, "ㅋㅋ", { call: fakeModel([j({ action: "skip", reason: "no answer", to: "", body: "", questions: [] })]).call })).toMatchObject({ code: 3 });
	});
});
