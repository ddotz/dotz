import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildDraftPrompt, contextLines, draftParts, MAX_CONTEXT_LINES, MAX_PARTS, parseDraftReply } from "./draft.ts";
import { createDraft, draftTextError, forgetWarm, listDrafts, sendDraft } from "./send.ts";
import { kakaoPaths, type Msg } from "./types.ts";
import { fakeScreen } from "./ui.fixture.ts";

// A reply may be several KakaoTalk messages: the model answers every open point of the grouped new messages, as parts separated by a blank
// line; the approval card shows one bubble per part and one 보내기 sends them in order, each part once even across retries.
describe("the draft call", () => {
	test("the output contract has a parts list, and the context reaches back further than the last four lines", () => {
		const { system } = buildDraftPrompt({ lines: ["가나: 내일 몇 시?", "가나: 장소는 어디로 해?"] });
		expect(system).toContain('"parts"');
		const recent: Msg[] = Array.from({ length: 20 }, (_, i) => ({ logId: String(i + 1), chatId: "1", authorId: i % 2 ? "me" : "u", sender: i % 2 ? "나" : "가나", text: `line ${i}`, type: 1, sentAt: i, fromMe: i % 2 === 1 }));
		expect(contextLines(recent, recent.slice(-2)).length).toBe(MAX_CONTEXT_LINES);
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

	test("author parts beyond MAX_PARTS are merged in order without losing a character, the longest message as short as it can be; relay and an absent mode still keep the first MAX_PARTS", () => {
		const squash = (s: string) => s.replace(/\s/g, "");
		for (let n = 1; n <= 23; n++) {
			const parts = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? `${i}번 첫 줄\n${i}번 둘째 줄` : `점 ${i} 내용`));
			const author = parseDraftReply(JSON.stringify({ action: "draft", mode: "author", parts, summary: "" }))!;
			const got = draftParts(author.body);
			expect(got.length).toBeLessThanOrEqual(MAX_PARTS);
			if (n <= MAX_PARTS) expect(got).toEqual(parts);
			expect(squash(got.join(""))).toBe(squash(parts.join("")));
			expect(author.mode).toBe("author");
		}
		const seven = Array.from({ length: 7 }, (_, i) => `p${i}`);
		expect(draftParts(parseDraftReply(JSON.stringify({ action: "draft", mode: "author", parts: seven, summary: "" }))!.body)).toEqual(["p0\np1", "p2\np3", "p4\np5", "p6"]);
		const long = ["가".repeat(600), "나".repeat(500), ...Array.from({ length: 4 }, (_, i) => String(i).repeat(100))];
		const merged = parseDraftReply(JSON.stringify({ action: "draft", mode: "author", parts: long, summary: "" }))!.body;
		expect(draftParts(merged).map(p => [...p].length)).toEqual([600, 500, 403]);
		expect(draftTextError(merged)).toBeUndefined();
		expect([draftTextError("가".repeat(3001)), draftTextError("가".repeat(1001))]).toEqual(["답장은 모두 합쳐 3000자까지예요", "메시지 하나는 1000자까지예요"]);
		const six = Array.from({ length: 6 }, (_, i) => `p${i}`);
		expect(draftParts(parseDraftReply(JSON.stringify({ action: "draft", mode: "relay", parts: six, summary: "" }))!.body)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
		expect(draftParts(parseDraftReply(JSON.stringify({ action: "draft", parts: six, summary: "" }))!.body)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
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

// A sender that died mid-way may have pressed send already: its claim file is not taken over by a plain send (hub/draft-claim.ts), only by the owner's 다시 보내기.
describe("a Kakao send whose process died holding the claim", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kk-dead-"));
		mkdirSync(join(dir, "kakao"), { recursive: true });
		forgetWarm();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("is refused with a clear message and sends nothing; the owner's retry takes it over and sends once", async () => {
		const paths = kakaoPaths(dir, dir);
		const T0 = Date.parse("2026-10-26T00:00:00.000Z");
		const s = fakeScreen([{ id: "chat_room", title: "스터디방", window: { title: "스터디방" } }]);
		const d = await createDraft({ chatId: "100", roomName: "스터디방", text: "내일 7시 괜찮아", basisLogId: "500" }, { paths, runner: s.runner, now: () => T0 });
		const claim = join(dirname(paths.drafts), "sending", d.code);
		mkdirSync(dirname(claim), { recursive: true });
		writeFileSync(claim, String(spawnSync(process.execPath, ["-e", ""]).pid));
		const deps = { paths, runner: s.runner, now: () => T0 + 1000, latestIncoming: async () => "500", ownerApproved: true };

		const plain = await sendDraft(d.code, deps);
		expect(plain.ok).toBe(false);
		expect(plain.reason).toContain("보낸 메시지가 이미 나갔을 수 있어요");
		expect(s.sends).toEqual([]);

		expect((await sendDraft(d.code, { ...deps, retry: true })).ok).toBe(true);
		expect(s.sends.map(x => x[2])).toEqual(["내일 7시 괜찮아"]);
	});
});
