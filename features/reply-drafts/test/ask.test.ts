import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { parseDecisions, replyChoiceBlock } from "../../../hub/choices.ts";
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
		expect(text.split("\n")[0]).toBe("결정: room 답장 · 티켓 취소할까?");
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
	test("the documented call (--room, no --from) names the chat by its room's name, cut so the title stays within 40 characters", async () => {
		const documented = ["new", "--app", "kakao", "--room", "1234567890", "--kind", "chat"];
		for (const [name, title] of [["민수", "민수 답장 · 티켓 취소할까?"], ["대학 동기 모임 단톡방 2026 송년회 준비위원회 공지 전용", "대학 동기 모임 단톡방 2026 송년회… 답장 · 티켓 취소할까?"]] as const) {
			const kakaoReader = async () => ({ messages: async () => [], rooms: async () => [{ chatId: "1234567890", name }] });
			const out = await runDraft(documented, MSG, { call: fakeModel([ask]).call, kakaoReader });
			expect(out.code).toBe(ASK_EXIT);
			const shown = parseDecisions(out.lines.join("\n")).blocks[0]!.title;
			expect(shown).toBe(title);
			expect([...shown].length).toBeLessThanOrEqual(40);
		}
	});
	test("a room nobody named is called by its members, or 이름 없는 방, never by the reader's placeholder", async () => {
		const documented = ["new", "--app", "kakao", "--room", "1234567890", "--kind", "chat"];
		const rooms = async () => [{ chatId: "1234567890", name: "(unknown)" }];
		const title = async (reader: object) => parseDecisions((await runDraft(documented, MSG, { call: fakeModel([ask]).call, kakaoReader: async () => ({ messages: async () => [], rooms, ...reader }) })).lines.join("\n")).blocks[0]!.title;
		expect(await title({ label: async () => "민수, 영희" })).toBe("민수, 영희 답장 · 티켓 취소할까?");
		expect(await title({})).toBe("이름 없는 방 답장 · 티켓 취소할까?");
	});

	test("a question too long to sit beside the chat's name keeps the name with 답장 in the title, cut at a word, and the whole question under it", async () => {
		const head = async (question: string) => {
			const out = await runDraft([...chat.slice(0, -1), "대학 동기 모임"], MSG, { call: fakeModel([j({ action: "ask", reason: "r", question, choices: ["응", "아니"], to: "", body: "", questions: [] })]).call });
			const lines = out.lines.join("\n").split("\n");
			return lines.slice(0, lines.findIndex(l => l.startsWith("**1)")));
		};
		const q37 = "민수가 내일 7시 저녁 약속을 취소할지 물어보는데 취소한다고 할까?", q51 = "모임 회비 3만 원을 이번 주 금요일까지 보내 달라는데 지금 보낸다고 하고 계좌를 물어볼까?", unbroken = `${"가".repeat(44)}?`;
		expect(await head("토요일 저녁 모임에 간다고 할까?")).toEqual(["결정: 대학 동기 모임 답장 · 토요일 저녁 모임에 간다고 할까?"]);
		expect(await head("민수가 내일 저녁 약속을 다음 주로 미루자는데 미룰까?")).toEqual(["결정: 대학… 답장 · 민수가 내일 저녁 약속을 다음 주로 미루자는데 미룰까?"]);
		expect(await head(q37)).toEqual(["결정: 대학 동기… 답장 · 민수가 내일 7시 저녁 약속을 취소할지 물어보는데…", q37]);
		expect(await head(q51)).toEqual(["결정: 대학… 답장 · 모임 회비 3만 원을 이번 주 금요일까지 보내 달라는데…", q51]);
		expect(await head(unbroken)).toEqual([`결정: ${"가".repeat(39)}…`, "대학 동기 모임 답장", unbroken]);
	});

	test("for any question of up to 80 characters the title stays within 40 and the card names whose chat it is", () => {
		const words = (max: number) => fc.array(fc.stringMatching(/^[가-힣a-z0-9?]{1,14}$/), { minLength: 1, maxLength: max }).map(w => w.join(" "));
		fc.assert(fc.property(words(6), words(30), (name, long) => {
			const question = [...long].slice(0, 80).join("").trim();
			const lines = replyChoiceBlock(question, ["응", "아니"], `${name} 답장`).split("\n");
			const title = parseDecisions(lines.join("\n")).blocks[0]!.title, first = [...name].slice(0, 2).join("").trim();
			expect([...title].length).toBeLessThanOrEqual(40);
			expect((title.startsWith(first) && title.includes(" 답장 · ")) || lines[1] === `${name} 답장`).toBe(true);
		}));
	});
});
