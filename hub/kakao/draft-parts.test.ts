import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDraftPrompt, contextLines, draftParts, MAX_PARTS, parseDraftReply } from "./draft.ts";
import { createDraft, forgetWarm, listDrafts, sendDraft } from "./send.ts";
import { kakaoPaths, type Msg } from "./types.ts";
import { fakeScreen } from "./ui.fixture.ts";

// A reply may be several KakaoTalk messages: the model answers every open point of the grouped new messages, as parts separated by a blank
// line; the approval card shows one bubble per part and one 보내기 sends them in order, each part once even across retries.
describe("the draft call", () => {
	test("the output contract has a parts list, and the context reaches back further than the last four lines", () => {
		const { system } = buildDraftPrompt({ lines: ["가나: 내일 몇 시?", "가나: 장소는 어디로 해?"] });
		expect(system).toContain('"parts"');
		const recent: Msg[] = Array.from({ length: 12 }, (_, i) => ({ logId: String(i + 1), chatId: "1", authorId: i % 2 ? "me" : "u", sender: i % 2 ? "나" : "가나", text: `line ${i}`, type: 1, sentAt: i, fromMe: i % 2 === 1 }));
		expect(contextLines(recent, recent.slice(-2)).length).toBe(8);
	});

	test("parts come back as one draft text, a blank line between parts; a one-line answer stays one part; at most MAX_PARTS", () => {
		const two = parseDraftReply('{"action":"draft","parts":["내일 7시 괜찮아", "장소는 강남역 어때?"],"summary":"s"}');
		expect(two).toMatchObject({ action: "draft", body: "내일 7시 괜찮아\n\n장소는 강남역 어때?" });
		expect(draftParts(two!.body)).toEqual(["내일 7시 괜찮아", "장소는 강남역 어때?"]);
		expect(draftParts(parseDraftReply('{"action":"draft","body":"ㅇㅋ","summary":""}')!.body)).toEqual(["ㅇㅋ"]);
		expect(draftParts("첫 줄\n같은 메시지 둘째 줄\n\n  \n\n다음 메시지")).toEqual(["첫 줄\n같은 메시지 둘째 줄", "다음 메시지"]);
		const many = parseDraftReply(JSON.stringify({ action: "draft", parts: Array.from({ length: 9 }, (_, i) => `p${i}`), summary: "" }));
		expect(draftParts(many!.body)).toHaveLength(MAX_PARTS);
	});
});

describe("sending a draft of several parts", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kk-parts-"));
		mkdirSync(join(dir, "kakao"), { recursive: true });
		forgetWarm();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const T0 = Date.parse("2026-10-26T00:00:00.000Z");

	test("one approval sends every part in order as its own message; a failed part is retried alone and no part is ever sent twice", async () => {
		const paths = kakaoPaths(dir, dir);
		let fail = false;
		const s = fakeScreen([{ id: "chat_room", title: "스터디방", window: { title: "스터디방" } }], { axSend: () => (fail ? { ok: false, why: "busy" } : { ok: true }) });
		const d = await createDraft({ chatId: "100", roomName: "스터디방", text: "내일 7시 괜찮아\n\n장소는 강남역 어때?\n\n늦으면 연락할게", basisLogId: "500" }, { paths, runner: s.runner, now: () => T0 });
		const deps = { paths, runner: s.runner, now: () => T0 + 1000, latestIncoming: async () => "500", ownerApproved: true };
		// the second part's send fails once (KakaoTalk's input box had unsent text)
		const failSecond: typeof s.runner = async (argv, o) => {
			if (o?.stdin?.includes('"action":"send"')) fail = s.sends.length === 1;
			return s.runner(argv, o);
		};
		const first = await sendDraft(d.code, { ...deps, runner: failSecond });
		expect(first.ok).toBe(false);
		expect(s.sends.map(x => x[2])).toEqual(["내일 7시 괜찮아", "장소는 강남역 어때?"]);
		expect((await listDrafts({ paths, runner: s.runner }))[0]).toMatchObject({ status: "pending", sentParts: 1 });
		fail = false;
		const again = await sendDraft(d.code, deps);
		expect(again.ok).toBe(true);
		expect(s.sends.map(x => x[2])).toEqual(["내일 7시 괜찮아", "장소는 강남역 어때?", "장소는 강남역 어때?", "늦으면 연락할게"]);
		expect((await listDrafts({ paths, runner: s.runner }))[0]).toMatchObject({ status: "sent", sentParts: 3 });
		expect((await sendDraft(d.code, deps)).ok).toBe(false);
		expect(s.sends).toHaveLength(4);
	});
});
