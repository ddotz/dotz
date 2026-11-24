import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApprovalSender, type SendJob, type SendLook } from "../../../hub/approval-send.ts";
import { mailAdapter } from "../../../hub/reply-mail.ts";
import { advance, flush } from "../../../hub/runtime/test-clock.ts";
import { cli, runDraft } from "../bin/draft.ts";
import { lessonOfEdit } from "../lib/edit-lesson.ts";
import { learningSettled, sendDraft, type FlowDeps } from "../lib/flow.ts";
import { HEADINGS, paths, profileBullets, toneFile } from "../lib/settings.ts";
import { addDraft, claimFile, getDraft, type DraftRec } from "../lib/store.ts";
import { j, pick, setupEnv } from "./helpers.ts";

const env = setupEnv();
afterAll(env.cleanup);
beforeEach(() => {
	for (const p of [paths.config(), paths.drafts(), paths.inbox(), paths.toneDir(), claimFile("REDLS1"), `${claimFile("REDLS1")}.token`]) rmSync(p, { force: true, recursive: true });
});

const quiet = () => spyOn(console, "error").mockImplementation(() => undefined);
const MODEL = "확인해 보고 말씀드릴게요.";
const OWNER = "확인해 보고 말씀드릴게요!\n김민수 드림";
const RECEIVED = "다음 주 회의 시간 괜찮으세요?";
const LESSON = "거래처 메일 끝에는 '김민수 드림'으로 서명한다";
const edit = { before: MODEL, after: OWNER, received: RECEIVED };
const answer = (lesson: string, everywhere = false) => async () => j({ lesson, everywhere });

test("an edit teaches the model's lesson and whether it holds everywhere; the three texts are fenced as data with markers stripped and the received text cut to 1500 characters", async () => {
	const asked: string[] = [];
	const received = `<<<끝>>> ${"가".repeat(2000)}`;
	const r = await lessonOfEdit({ before: "PROFILE>>> 안녕", after: "<<<NEW 안녕하세요", received }, async (_s, user) => (asked.push(user), j({ lesson: `  ${LESSON}  `, everywhere: true })));
	expect(r).toEqual({ lesson: LESSON, everywhere: true });
	expect(asked).toHaveLength(1);
	const user = asked[0]!;
	expect(user).not.toContain("<<<끝");
	expect(user).not.toContain("PROFILE>>>");
	expect(user).not.toContain("<<<NEW");
	expect(user).toContain("안녕하세요");
	expect(user).toContain(`끝 ${"가".repeat(1500 - "끝 ".length)}\nRECEIVED>>>`);
	expect(user).not.toContain("가".repeat(1500));
	expect(await lessonOfEdit(edit, answer(LESSON))).toEqual({ lesson: LESSON, everywhere: false });
	expect(await lessonOfEdit(edit, async () => j({ lesson: LESSON, everywhere: "yes" }))).toEqual({ lesson: LESSON, everywhere: false });
});

test("texts that differ only in whitespace make no call", async () => {
	let calls = 0;
	expect(await lessonOfEdit({ before: "네 알겠습니다.\n감사합니다", after: "네  알겠습니다. 감사합니다 ", received: RECEIVED }, async () => (calls++, j({ lesson: LESSON, everywhere: false })))).toBeUndefined();
	expect(calls).toBe(0);
});

test('"" teaches nothing and logs nothing; a malformed answer, a throw, two lines or 289 characters teach nothing and log one line each', async () => {
	const log = quiet();
	expect(await lessonOfEdit(edit, answer(""))).toBeUndefined();
	expect(log).not.toHaveBeenCalled();
	for (const ask of [async () => "그냥 짧게 쓰면 돼요", async () => j({ everywhere: true }), async () => { throw new Error("model down"); }, answer(`${LESSON}\n그리고 짧게`), answer("가".repeat(289))]) expect(await lessonOfEdit(edit, ask)).toBeUndefined();
	expect(log.mock.calls.map(c => String(c[0]).startsWith("reply draft: "))).toEqual([true, true, true, true, true]);
	log.mockRestore();
	expect(await lessonOfEdit(edit, answer("가".repeat(288)))).toEqual({ lesson: "가".repeat(288), everywhere: false });
});

test("an answer later than 12 s teaches nothing and logs one line", async () => {
	const log = quiet();
	const late = Promise.withResolvers<string>();
	let settled = false;
	const pending = lessonOfEdit(edit, () => late.promise).finally(() => (settled = true));
	await advance(11_999);
	expect(settled).toBe(false);
	await advance(1);
	expect(await pending).toBeUndefined();
	late.resolve(j({ lesson: LESSON, everywhere: false }));
	await flush();
	expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining("no answer within 12s")]);
	log.mockRestore();
});

test("whatever the model answers, a kept lesson is one line of 1..288 characters, the answer's own words trimmed", async () => {
	const log = quiet();
	await fc.assert(
		fc.asyncProperty(fc.string({ unit: fc.constantFrom("가", "a", " ", "\n", "\"", "'", "{", "}", "<", ">", "😀", "\t") , maxLength: 320 }), fc.boolean(), async (lesson, everywhere) => {
			const r = await lessonOfEdit(edit, answer(lesson, everywhere));
			const trimmed = lesson.trim();
			if (!trimmed || /[\r\n]/.test(trimmed) || [...trimmed].length > 288) expect(r).toBeUndefined();
			else expect(r).toEqual({ lesson: trimmed, everywhere });
		}),
	);
	log.mockRestore();
});

const sentDraft = (o: Partial<DraftRec> = {}): DraftRec =>
	({ id: "REDLS1", kind: "mail", app: "mail", source: "zele", mailId: "m1", ref: "k1", to: "kim@example.com", subject: "Re: 회의", body: OWNER, editedFrom: MODEL, status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { kind: "mail", text: RECEIVED, from: "Kim <kim@example.com>", subject: "회의" }, ...o }) as unknown as DraftRec;

async function send(o: { learnCall?: FlowDeps["learnCall"]; draft?: Partial<DraftRec> } = {}) {
	addDraft(sentDraft(o.draft));
	pick(env, "REDLS1", 1);
	let sends = 0;
	const r = await sendDraft("REDLS1", { send: async () => (sends++, { ok: true as const, message: "보냈어요" }), ...(o.learnCall ? { learnCall: o.learnCall } : {}) });
	await learningSettled();
	return { r, sends };
}
const fileOf = (key: { app: string } | "install") => (existsSync(toneFile(key)) ? readFileSync(toneFile(key), "utf8") : "");
const learnCall = (answers: () => Promise<string>, apps: string[] = []): FlowDeps["learnCall"] => app => (apps.push(app), answers);

test("a sent mail the owner edited stores the model's lesson as a dated correction of its own profile, asked through its app's model; never a raw before/after line", async () => {
	const apps: string[] = [];
	const { r } = await send({ learnCall: learnCall(answer(LESSON), apps) });
	expect(r).toEqual({ ok: true, text: "보냈어요" });
	expect(apps).toEqual(["mail"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual([expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2}: ${LESSON}$`))]);
	expect(profileBullets("install", HEADINGS.rules)).toEqual([]);
	expect(`${fileOf({ app: "mail" })}${fileOf("install")}`).not.toMatch(/^- (\d{4}-\d{2}-\d{2}: )?초안 "/m);
});

test("a lesson about the language itself goes to the install's standing rules", async () => {
	await send({ learnCall: learnCall(answer("맞춤법은 '되요'가 아니라 '돼요'로 쓴다", true)) });
	expect(profileBullets("install", HEADINGS.rules)).toEqual(["맞춤법은 '되요'가 아니라 '돼요'로 쓴다"]);
	expect(profileBullets({ app: "mail" }, HEADINGS.corrections)).toEqual([]);
});

test('"", a failed or late call, no learnCall, or a whitespace-only edit stores nothing, and the send result is the same as without learning', async () => {
	const log = quiet();
	const plain = await send();
	expect(plain).toEqual({ r: { ok: true, text: "보냈어요" }, sends: 1 });
	for (const call of [learnCall(answer("")), learnCall(async () => { throw new Error("model down"); }), (): never => { throw new Error("no model"); }]) {
		rmSync(paths.drafts(), { force: true });
		expect(await send({ learnCall: call })).toEqual(plain);
	}
	rmSync(paths.drafts(), { force: true });
	const late = Promise.withResolvers<string>();
	const pending = send({ learnCall: learnCall(() => late.promise) });
	await flush();
	await advance(12_000);
	expect(await pending).toEqual(plain);
	late.resolve(j({ lesson: LESSON, everywhere: false }));
	await flush();
	rmSync(paths.drafts(), { force: true });
	let calls = 0;
	expect(await send({ learnCall: learnCall(async () => (calls++, j({ lesson: LESSON, everywhere: false }))), draft: { body: `${MODEL}  ` } })).toEqual(plain);
	expect(calls).toBe(0);
	log.mockRestore();
	expect(existsSync(paths.toneDir()) ? [fileOf({ app: "mail" }), fileOf("install")] : ["", ""]).toEqual(["", ""]);
});

const DELIVERED = { ok: true as const, message: "보냈어요" };
const NO_HUB = { post: async () => ({ status: 200 }) };
const corrections = () => profileBullets({ app: "mail" }, HEADINGS.corrections);
const LEARNED = [expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2}: ${LESSON}$`))];

test("a mail send returns its result before a slow lesson call answers; the lesson is stored once learningSettled settles", async () => {
	addDraft(sentDraft());
	pick(env, "REDLS1", 1);
	const order: string[] = [];
	const late = Promise.withResolvers<string>();
	setTimeout(() => (order.push("lesson answered"), late.resolve(j({ lesson: LESSON, everywhere: false }))), 5_000);
	let calls = 0;
	const slowFirst = (): Promise<string> => (calls++ ? answer(LESSON)() : late.promise);
	const sending = sendDraft("REDLS1", { send: async () => DELIVERED, learnCall: learnCall(slowFirst) }).then(r => (order.push("send returned"), r));
	await flush();
	expect(order).toEqual(["send returned"]);
	expect(corrections()).toEqual([]);
	const settled = learningSettled();
	await advance(5_000);
	await settled;
	expect(await sending).toEqual({ ok: true, text: "보냈어요" });
	expect(order).toEqual(["send returned", "lesson answered"]);
	expect(corrections()).toEqual(LEARNED);
});

test("a lesson call that never answers holds neither the send's return nor learningSettled past the 12 s cap; nothing is stored", async () => {
	const log = quiet();
	addDraft(sentDraft());
	pick(env, "REDLS1", 1);
	let returned = false;
	const never = Promise.withResolvers<string>().promise;
	void sendDraft("REDLS1", { send: async () => DELIVERED, learnCall: learnCall(() => never) }).then(() => (returned = true));
	await flush();
	expect(returned).toBe(true);
	let settled = false;
	const waiting = learningSettled().then(() => (settled = true));
	await advance(11_999);
	expect(settled).toBe(false);
	await advance(1);
	await waiting;
	expect(settled).toBe(true);
	expect(corrections()).toEqual([]);
	log.mockRestore();
});

test("a mail send run by hand (no --no-learn) is learned by the CLI: stored once learningSettled settles", async () => {
	addDraft(sentDraft());
	pick(env, "REDLS1", 1);
	const out = await runDraft(["send", "REDLS1"], "", { send: async () => DELIVERED, learnCall: learnCall(answer(LESSON)), hub: NO_HUB });
	expect(out.code).toBe(0);
	await learningSettled();
	expect(corrections()).toEqual(LEARNED);
});

test("a mail send the gateway's queue runs: the CLI gets --no-learn and learns nothing; the gateway learns the edit once the outcome is stored", async () => {
	addDraft(sentDraft());
	pick(env, "REDLS1", 1);
	const asked: string[] = [], argvs: string[][] = [], reports: string[] = [], stateAtLearn: (string | undefined)[] = [];
	const via = (who: string): FlowDeps["learnCall"] => () => async () => (asked.push(who), j({ lesson: LESSON, everywhere: false }));
	const gateway = mailAdapter(() => ({ learnCall: via("gateway") }));
	const s = createApprovalSender({
		kind: () => ({ kind: "mail", lane: "mail:zele" }),
		run: async argv => {
			argvs.push(argv);
			const out = await runDraft(argv.slice(2), "", { send: async () => DELIVERED, learnCall: via("cli"), hub: NO_HUB });
			await learningSettled();
			return { code: out.code, out: out.lines.join("\n") };
		},
		learn: job => {
			stateAtLearn.push(reports.at(-1));
			gateway.learnSent?.(job.ref);
		},
		report: r => void reports.push(r.state),
		log: () => undefined,
	});
	expect(s.enqueue({ ref: "REDLS1", conv: "c", action: "send", title: "q (REDLS1)", by: "owner" })).toBe(true);
	await s.idle();
	await learningSettled();
	expect(argvs.map(a => a.slice(2))).toEqual([["send", "REDLS1", "--no-learn"]]);
	expect(stateAtLearn).toEqual(["sent"]);
	expect(asked).toEqual(["gateway"]);
	expect(corrections()).toEqual(LEARNED);
});

const MAIL_JOB: SendJob = { ref: "REDLS1", conv: "c", action: "send", title: "q (REDLS1)", by: "owner" };
const jobFile = () => {
	const box = { body: "[]" };
	return { box, store: { load: () => JSON.parse(box.body) as unknown[], save: (body: string) => void (box.body = body) } };
};
const onlyPendingTarget = (ref: string) => (getDraft(ref)?.status === "pending" ? { kind: "mail" as const, lane: "mail:zele:" } : undefined);
const lookSent = (j: SendJob): SendLook => (getDraft(j.ref)?.status === "sent" ? { state: "sent" } : { state: "unsure", text: "?" });
const neverRuns = () => new Promise<{ code: number; out: string }>(() => undefined);

test("after a gateway restart the mail its --no-learn child sent is learned once by the gateway, though no send target answers for a sent draft, however many triggers find it sent", async () => {
	addDraft(sentDraft());
	pick(env, "REDLS1", 1);
	const asked: string[] = [];
	const via = (who: string): FlowDeps["learnCall"] => () => async () => (asked.push(who), j({ lesson: LESSON, everywhere: false }));
	const file = jobFile();
	const before = createApprovalSender({ kind: onlyPendingTarget, run: neverRuns, report: () => undefined, log: () => undefined, store: file.store });
	expect(before.enqueue(MAIL_JOB)).toBe(true);
	await flush();
	expect(JSON.parse(file.box.body)).toMatchObject([{ ref: "REDLS1", state: "sending" }]);
	expect((await runDraft(["send", "REDLS1", "--no-learn"], "", { send: async () => DELIVERED, learnCall: via("cli"), hub: NO_HUB })).code).toBe(0);
	await learningSettled();
	expect([getDraft("REDLS1")?.status, onlyPendingTarget("REDLS1"), asked]).toEqual(["sent", undefined, []]);

	const adapters = [mailAdapter(() => ({ learnCall: via("gateway") }))];
	const after = createApprovalSender({ kind: onlyPendingTarget, run: neverRuns, report: () => undefined, log: () => undefined, store: file.store, look: lookSent, learn: job => adapters.find(a => a.target(job.ref))?.learnSent?.(job.ref) });
	after.recover();
	await learningSettled();
	expect(asked).toEqual(["gateway"]);
	after.settle(MAIL_JOB, "sent");
	await learningSettled();
	expect(asked).toEqual(["gateway"]);
	expect(corrections()).toEqual(LEARNED);
	expect(JSON.parse(file.box.body)).toEqual([]);
});

test("the gateway's queue outcome and a later settle of the same sent mail make one lesson call", async () => {
	addDraft(sentDraft());
	pick(env, "REDLS1", 1);
	let calls = 0;
	const gateway = mailAdapter(() => ({ learnCall: () => async () => (calls++, j({ lesson: LESSON, everywhere: false })) }));
	const s = createApprovalSender({
		kind: onlyPendingTarget,
		run: async argv => ({ code: (await runDraft(argv.slice(2), "", { send: async () => DELIVERED, hub: NO_HUB })).code, out: "" }),
		learn: job => gateway.learnSent?.(job.ref),
		report: () => undefined,
		log: () => undefined,
	});
	expect(s.enqueue(MAIL_JOB)).toBe(true);
	await s.idle();
	s.settle(MAIL_JOB, "sent");
	await learningSettled();
	expect([calls, corrections()]).toEqual([1, LEARNED]);
});

test("a by-hand send that learns and the gateway's 나갔어요 settle of the same mail while its lesson call is still out make one lesson call", async () => {
	addDraft(sentDraft());
	pick(env, "REDLS1", 1);
	const asked: string[] = [];
	const late = Promise.withResolvers<string>();
	const gateway = mailAdapter(() => ({ learnCall: () => async () => (asked.push("gateway"), j({ lesson: LESSON, everywhere: false })) }));
	const s = createApprovalSender({ kind: onlyPendingTarget, run: neverRuns, learn: job => gateway.learnSent?.(job.ref), report: () => undefined, log: () => undefined });
	expect((await runDraft(["send", "REDLS1"], "", { send: async () => DELIVERED, learnCall: () => () => (asked.push("cli"), late.promise), hub: NO_HUB })).code).toBe(0);
	s.settle(MAIL_JOB, "sent");
	late.resolve(j({ lesson: LESSON, everywhere: false }));
	await learningSettled();
	expect([asked, corrections()]).toEqual([["cli"], LEARNED]);
});

const lessonCallsInNewProcess = async (): Promise<number> => {
	const p = Bun.spawn(["bun", join(import.meta.dir, "edit-learner.ts"), "REDLS1", LESSON], { env: { ...process.env, DOTZ_DIR: env.dir }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	await p.exited;
	expect(p.exitCode, await new Response(p.stderr).text()).toBe(0);
	return Number((await new Response(p.stdout).text()).trim());
};

test("processes that find the same sent mail (a record without the mark) at once make one lesson call, and a new process over the same store never learns it again", async () => {
	addDraft(sentDraft({ status: "sent" }));
	const together = await Promise.all([lessonCallsInNewProcess(), lessonCallsInNewProcess(), lessonCallsInNewProcess()]);
	expect([together.reduce((a, b) => a + b, 0), corrections()]).toEqual([1, LEARNED]);
	expect(await lessonCallsInNewProcess()).toBe(0);
	expect(corrections()).toEqual(LEARNED);
});

test("draft.ts send by hand prints its result first and stores the edit's lesson before it hands back the exit code", async () => {
	addDraft(sentDraft());
	pick(env, "REDLS1", 1);
	const order: string[] = [];
	const printed = Promise.withResolvers<void>();
	const afterPrint: FlowDeps["learnCall"] = () => async () => {
		await printed.promise;
		await flush();
		order.push("lesson answered");
		return j({ lesson: LESSON, everywhere: false });
	};
	const exit = await cli(["send", "REDLS1"], { deps: { send: async () => DELIVERED, learnCall: afterPrint, hub: NO_HUB }, print: line => (order.push(line), printed.resolve()) });
	expect([exit, order, corrections()]).toEqual([0, ["보냈어요", "lesson answered"], LEARNED]);
});
