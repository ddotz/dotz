import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteDb } from "./kakao/db.ts";
import type { ModelReply, StyleHint } from "./kakao/draft.ts";
import { makeFixtureDb, OWNER, ROOM } from "./kakao/fixture.ts";
import { makeDraft, type MakeDraftCtx } from "./kakao/make-draft.ts";
import { listDrafts } from "./kakao/send.ts";
import { type KakaoConfig, kakaoPaths } from "./kakao/types.ts";
import { generateChatReply, generateReply, type ModelCall, type ReplyItem, type ReplyStyle, reviseReply } from "./reply-draft.ts";
import type { JudgeAsk } from "./style-judge.ts";

type Answer = "clean" | "lint" | "unparsable" | "skip" | "ask" | "thrown" | "lessonFirst" | "lessonRetry";
const json = (o: object) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
const d = (body: string, extra: object = {}) => json({ action: "draft", reason: "r", to: "kim@example.com", subject: "Re: 회의 일정 문의", body, questions: [], ...extra });
const FIRST_LESSON = { lesson: "L1", forbid: [], everywhere: false };
const RETRY_LESSON = { lesson: "L2", forbid: ["안녕히"], everywhere: true };
const timedOut = new Error("model call timed out after 45s");
const mailAnswer: Record<Answer, string | Error> = {
	clean: d("네 확인했어요"),
	lint: d("네 수고하세요"),
	unparsable: "nope",
	skip: json({ action: "skip", reason: "no need" }),
	ask: json({ action: "ask", reason: "r", question: "갈까?", choices: ["가", "안 가"], to: "", body: "", questions: [] }),
	thrown: timedOut,
	lessonFirst: d("네 수고하세요", FIRST_LESSON),
	lessonRetry: d("네 확인했어요", RETRY_LESSON),
};
const mail: ReplyItem = { kind: "mail", from: "Kim <kim@example.com>", self: ["me@example.net"], subject: "회의 일정 문의", text: "다음 주 회의 일정을 알려 주실 수 있을까요?" };
const chat: ReplyItem = { kind: "chat", app: "kakao", from: "Alex", text: "내일 3시 괜찮아?" };
const plain: ReplyStyle = { samples: [], rules: [], corrections: [], forbidden: ["수고하세요"] };
const CHANGE = "'안녕히' 쓰지 마";

type Entry = "generateReply" | "generateChatReply" | "reviseReply";
async function mailRun(entry: Entry, seq: Answer[], judge?: JudgeAsk) {
	let calls = 0;
	const call: ModelCall = async () => {
		const a = mailAnswer[seq[Math.min(calls++, seq.length - 1)]!];
		if (a instanceof Error) throw a;
		return a;
	};
	const p = entry === "generateReply" ? generateReply(mail, plain, call, judge) : entry === "generateChatReply" ? generateChatReply(chat, plain, call, judge) : reviseReply(mail, plain, { to: "kim@example.com", body: "old" }, CHANGE, call, judge);
	const result = await p.then(
		r => r,
		(e: Error) => ({ threw: e.message }),
	);
	return { result, calls };
}

const kd = (body: string, extra: object = {}): ModelReply => ({ text: JSON.stringify({ action: "draft", body, summary: "", ...extra }) });
const kakaoAnswer: Record<Answer, ModelReply | Error> = {
	clean: kd("네 확인했어요"),
	lint: kd("네 수고하세요"),
	unparsable: { text: "nope" },
	skip: { text: JSON.stringify({ action: "skip", body: "", summary: "" }) },
	ask: { text: JSON.stringify({ action: "ask", body: "", summary: "", question: "갈까?", choices: ["가", "안 가"] }) },
	thrown: timedOut,
	lessonFirst: kd("네 수고하세요", FIRST_LESSON),
	lessonRetry: kd("네 확인했어요", RETRY_LESSON),
};
const kHint: StyleHint = { rules: [], corrections: [], forbidden: ["수고하세요"], samples: [] };
const quiet = async () => ({ code: 0, stdout: "", stderr: "" });

async function kakaoRun(revise: boolean, seq: Answer[], judge: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "kakao-equiv-"));
	const paths = kakaoPaths(dir, dir);
	const dbPath = join(dir, "k.sqlite");
	makeFixtureDb(dbPath).close();
	const db = sqliteDb(dbPath);
	let calls = 0;
	const judged = { calls: 0 };
	const onRevise: unknown[] = [];
	const asks: unknown[] = [];
	const room = { chatId: String(ROOM.direct), name: "Alex", type: 1, kind: "direct" as const, unread: 0, lastAt: 1 };
	const ctx: MakeDraftCtx = {
		deps: {
			paths,
			runner: quiet,
			now: () => 1,
			openDb: async () => db,
			broadcast: () => {},
			draftStyle: () => kHint,
			onRevise: (_chatId, l) => void onRevise.push(l),
			draftModel: async () => {
				const a = kakaoAnswer[seq[Math.min(calls++, seq.length - 1)]!];
				if (a instanceof Error) throw a;
				return a;
			},
			...(judge ? { judgeModel: async () => (judged.calls++, { text: JSON.stringify({ violations: [] }) }) } : {}),
		},
		paths,
		now: () => 1,
		getDb: async () => db,
		allRooms: async () => ({ all: [room] }),
		eligible: r => r,
		setAsk: (_chatId, ask) => void asks.push(ask),
		storedAsks: () => ({}),
	};
	const config: KakaoConfig = { enabled: true, dbPath, userId: OWNER, watch_chats: [String(ROOM.direct)] };
	try {
		const made = await makeDraft(ctx, config, String(ROOM.direct), undefined, revise ? { code: "old", draft: "옛 초안", change: CHANGE } : undefined);
		const drafts = (await listDrafts({ paths, runner: quiet })).filter(x => x.status === "pending").map(x => [x.text, x.notes ?? []]);
		return { made: made.ok ? { ok: true, stored: !!made.code, ...(made.learned ? { learned: made.learned } : {}) } : made, onRevise, asks, drafts, calls, judged: judged.calls };
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

const FORBIDDEN = "it uses the forbidden expression '수고하세요'";
const DRAFT_FAILED = "초안을 만들지 못했어요. 잠시 뒤에 다시 눌러 주세요";
const NO_REPLY = "답할 내용이 없어서 초안을 만들지 않았어요";
const mailDraft = (body: string, warnings: string[], tries: number, calls: number, extra: object = {}) => ({ result: { action: "draft", draft: { to: "kim@example.com", subject: "Re: 회의 일정 문의", body }, questions: [], warnings, tries, ...extra }, calls });
const fixed = (tries: number) => mailDraft("네 확인했어요", [], tries, tries);
const flagged = mailDraft("네 수고하세요", [FORBIDDEN], 2, 2);
const skipped = (calls: number) => ({ result: { action: "skip", reason: "no need" }, calls });
const asked = (calls: number) => ({ result: { action: "ask", question: "갈까?", choices: ["가", "안 가"] }, calls });
const unusable = { result: { threw: "the model did not return a usable JSON object" }, calls: 2 };
const CHANGE_LESSON = { line: CHANGE, forbid: [], everywhere: false };
const kakao = (made: object, calls: number, o: { drafts?: unknown[]; learned?: object; asks?: unknown[] } = {}) => ({ made, onRevise: o.learned ? [o.learned] : [], asks: o.asks ?? [], drafts: o.drafts ?? [], calls, judged: 0 });
const kStored = (text: string, notes: string[], calls: number, learned?: object) => kakao({ ok: true, stored: true, ...(learned ? { learned } : {}) }, calls, { drafts: [[text, notes]], ...(learned ? { learned } : {}) });
const kClean = (calls: number, learned?: object) => kStored("네 확인했어요", [], calls, learned);
const kFlagged = (learned?: object) => kStored("네 수고하세요", [`확인: ${FORBIDDEN}`], 2, learned);
const kFailed = (error: string, calls: number) => kakao({ ok: false, error }, calls);
const kAsked = (calls: number) => kakao({ ok: true, stored: false }, calls, { asks: [{ question: "갈까?", choices: ["가", "안 가"], basisLogId: "9007199254740993", created: 1 }] });

type Want = Record<Entry | "kakao draft" | "kakao revise", unknown>;
const same = (mailResult: unknown, kakaoDraft: unknown, kakaoRevise: unknown): Want => ({ generateReply: mailResult, generateChatReply: mailResult, reviseReply: mailResult, "kakao draft": kakaoDraft, "kakao revise": kakaoRevise });
const MAIN: [string, Answer[], Want][] = [
	["clean draft", ["clean"], same(fixed(1), kClean(1), kClean(1, CHANGE_LESSON))],
	["lint failure then clean", ["lint", "clean"], same(fixed(2), kClean(2), kClean(2, CHANGE_LESSON))],
	["lint failure twice", ["lint", "lint"], same(flagged, kFlagged(), kFlagged(CHANGE_LESSON))],
	["unparsable then draft", ["unparsable", "clean"], same(fixed(2), kFailed(DRAFT_FAILED, 1), kFailed(DRAFT_FAILED, 1))],
	["draft then unparsable", ["lint", "unparsable"], same(flagged, kFlagged(), kFlagged(CHANGE_LESSON))],
	["lint failure then thrown", ["lint", "thrown"], same(flagged, kFailed(DRAFT_FAILED, 2), kFailed(DRAFT_FAILED, 2))],
	["skip", ["skip"], same(skipped(1), kFailed(NO_REPLY, 1), kFailed(NO_REPLY, 1))],
	["lint failure then skip", ["lint", "skip"], same(skipped(2), kFailed(NO_REPLY, 2), kFailed(NO_REPLY, 2))],
	["chat ask", ["ask"], { ...same(unusable, kAsked(1), kFailed(DRAFT_FAILED, 1)), generateChatReply: asked(1) }],
	["lint failure then ask", ["lint", "ask"], { ...same(flagged, kAsked(2), kFailed(DRAFT_FAILED, 2)), generateChatReply: asked(2) }],
	["lint retry with a different lesson", ["lessonFirst", "lessonRetry"], same(mailDraft("네 확인했어요", [], 2, 2, RETRY_LESSON), kClean(2), kClean(2, { line: "L2", forbid: ["안녕히"], everywhere: true }))],
];

for (const [name, seq, want] of MAIN) {
	for (const entry of ["generateReply", "generateChatReply", "reviseReply"] as const) {
		test(`${entry} without a judge, or with one on a style without conditions, returns what main returns: ${name}`, async () => {
			expect<unknown>(await mailRun(entry, seq)).toEqual(want[entry]);
			let judged = 0;
			const judge: JudgeAsk = async () => (judged++, json({ violations: [] }));
			expect<unknown>(await mailRun(entry, seq, judge)).toEqual(want[entry]);
			expect(judged).toBe(0);
		});
	}
	for (const revise of [false, true]) {
		const key = revise ? "kakao revise" : "kakao draft";
		test(`KakaoTalk ${revise ? "revise" : "draft"} without a judge, or with one on a style without conditions, stores what main stores: ${name}`, async () => {
			expect<unknown>(await kakaoRun(revise, seq, false)).toEqual(want[key]);
			expect<unknown>(await kakaoRun(revise, seq, true)).toEqual(want[key]);
		});
	}
}
