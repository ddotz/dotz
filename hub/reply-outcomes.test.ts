// What happened to the replies the owner approved (hub/reply-outcomes.ts): the failed / sent / stops of GET /api/replies and the retry of POST /api/approvals/failed.
// Pure inputs and a fake CLI runner: nothing reads a store, nothing sleeps, and nothing leaves this machine.
import { expect, test } from "bun:test";
import type { SourceConfig } from "./comments/contract.ts";
import { ruleRefusal } from "./comments/contract.ts";
import type { Draft, Reply } from "./comments/store.ts";
import { createApprovalSender, type SendJob } from "./approval-send.ts";
import { DRAFT_DROP, DRAFT_EDIT, DRAFT_ONLY_MAIN, DRAFT_SEND } from "./draft-approval.ts";
import { collectOutcomes, localMidnight, type NoticeLike, type OutcomeInputs, pickedSend, retryFailed, SENT_CAP, type RetryDeps } from "./reply-outcomes.ts";

const NOW = new Date(2026, 10, 4, 15, 0, 0).getTime();
const SINCE = localMidnight(NOW);
const iso = (at: number) => new Date(at).toISOString();
const OPTIONS = [DRAFT_SEND, DRAFT_EDIT, DRAFT_DROP, DRAFT_ONLY_MAIN].map((label, i) => ({ n: i + 1, label }));

// A send-approval card whose gateway send is in `state`; `answer` is the text the inbox settled it with.
const notice = (ref: string, o: { state: "queued" | "sending" | "sent" | "failed"; answer?: string; why?: string; at?: number; attempts?: number; to?: string; who?: string; title?: string }): NoticeLike => ({
	title: o.title ?? `${o.who ?? "김철수"}에게 답장 (${ref})`,
	decision: {
		to: o.to ?? "mail:work",
		state: "answered",
		...(o.answer === undefined ? {} : { answer: o.answer }),
		options: OPTIONS,
		draft: { ref, to: o.who ?? "김철수", body: `${ref} 본문` },
		send: { state: o.state, ...(o.why ? { text: o.why } : {}), at: iso(o.at ?? NOW - 60_000), ...(o.attempts ? { attempts: o.attempts } : {}) },
	},
});
const src = (key: string, autoSend?: SourceConfig["autoSend"]) => ({ key, kind: "instagram", label: key, watch: [], autoDraft: true, ...(autoSend ? { autoSend } : {}) }) as unknown as SourceConfig;
const draft = (code: string, o: Partial<Draft> = {}) => ({ code, commentId: `c-${code}`, source: "s1", thread: "t", text: "초안", status: "pending", created: NOW, changes: [], clean: true, notes: [], ...o }) as Draft;
const reply = (id: string, o: Partial<Reply> & Pick<Reply, "state" | "draft">) => ({ commentId: `c-${o.draft}`, source: "s1", thread: "t", text: "답글", at: NOW - 1000, via: "owner", collector: "test", id, ...o }) as Reply;
const comment = (id: string, text = "안녕하세요") => ({ id, author: "영희", text, postTitle: "신상 안내" });

const inputs = (o: Partial<OutcomeInputs> = {}): OutcomeInputs => ({
	notices: [],
	sendKind: ref => (ref.startsWith("R") ? "mail" : undefined),
	appOf: ref => (ref.startsWith("R") ? "mail" : undefined),
	comments: { sources: { s1: { src: src("s1"), app: "insta" } }, drafts: [], replies: [], comments: [] },
	kakao: { sends: [], drafts: {} },
	since: SINCE,
	now: NOW,
	...o,
});

test("failed has one row per approved send that failed, from each source, newest first", () => {
	const r = collectOutcomes(
		inputs({
			notices: [notice("RMAIL01", { state: "failed", why: "smtp refused", at: NOW - 3000, attempts: 2 })],
			comments: {
				sources: { s1: { src: src("s1"), app: "insta" } },
				drafts: [draft("D1")],
				replies: [reply("send:D1", { state: "failed", draft: "D1", reason: "토큰이 만료됐어요", at: NOW - 2000, attempts: 3 })],
				comments: [comment("c-D1")],
			},
			kakao: {
				sends: [{ id: "k1", chatId: "42", text: "내일 봐요", state: "failed", reason: "창이 닫혀 있어요", at: NOW - 1000, draft: "K1" }],
				drafts: { K1: { status: "pending", room: "가족방" } },
			},
		}),
	);
	expect(r.failed.map(f => [f.key, f.kind, f.app, f.who, f.what, f.why, f.attempts])).toEqual([
		["kakao:k1", "kakao", "kakao", "가족방", "카카오톡 답장", "창이 닫혀 있어요", undefined],
		["comment:send:D1", "comment", "insta", "영희", "신상 안내", "토큰이 만료됐어요", 3],
		["mail:RMAIL01", "mail", "mail", "김철수", "김철수에게 답장", "smtp refused", 2],
	]);
	expect(r.failed[0]).toMatchObject({ ref: "K1", conv: "kakao:42", sendId: "k1", chatId: "42", text: "내일 봐요" });
	expect(r.failed[1]).toMatchObject({ ref: "D1", sendId: "send:D1", original: { who: "영희", text: "안녕하세요" } });
	expect(r.failed[2]).toMatchObject({ ref: "RMAIL01", conv: "mail:work", text: "RMAIL01 본문" });
});

test("failed leaves out what cannot be sent any more: a draft the stores no longer know, a kakao draft that is not pending", () => {
	const r = collectOutcomes(
		inputs({
			notices: [notice("XGONE01", { state: "failed", why: "x" })],
			comments: { sources: { s1: { src: src("s1"), app: "insta" } }, drafts: [], replies: [reply("send:D9", { state: "failed", draft: "D9" })], comments: [] },
			kakao: { sends: [{ id: "k1", chatId: "42", text: "t", state: "failed", at: NOW, draft: "K1" }], drafts: { K1: { status: "sent", room: "방" } } },
		}),
	);
	expect(r.failed).toEqual([]);
});

test("a failure the notice and the comment store both record is one row, the store's; two cards of one draft show once; a kakao retry chain shows its last failure", () => {
	const r = collectOutcomes(
		inputs({
			notices: [
				notice("D1", { state: "failed", why: "notice side", to: "mail:work" }),
				notice("RTWICE1", { state: "failed", why: "older", at: NOW - 9000 }),
				notice("RTWICE1", { state: "failed", why: "newer", at: NOW - 5000 }),
			],
			sendKind: ref => (ref === "D1" ? "comment" : "mail"),
			comments: { sources: { s1: { src: src("s1"), app: "insta" } }, drafts: [draft("D1")], replies: [reply("send:D1", { state: "failed", draft: "D1", reason: "store side" })], comments: [comment("c-D1")] },
			kakao: {
				sends: [
					{ id: "k1", chatId: "42", text: "t", state: "failed", reason: "first", at: NOW - 3000, draft: "K1", retried: "k2" },
					{ id: "k2", chatId: "42", text: "t", state: "failed", reason: "second", at: NOW - 2000, draft: "K1" },
				],
				drafts: { K1: { status: "pending", room: "방" } },
			},
		}),
	);
	expect(r.failed.map(f => [f.key, f.why, f.attempts])).toEqual([
		["comment:send:D1", "store side", undefined],
		["kakao:k2", "second", 2],
		["mail:RTWICE1", "newer", undefined],
	]);
});

test("a row without a recorded reason has no why at all", () => {
	const r = collectOutcomes(
		inputs({
			notices: [notice("RMAIL01", { state: "failed" })],
			comments: { sources: { s1: { src: src("s1"), app: "insta" } }, drafts: [draft("D1")], replies: [reply("send:D1", { state: "failed", draft: "D1", at: NOW - 5000 })], comments: [] },
			kakao: { sends: [{ id: "k1", chatId: "42", text: "t", state: "failed", at: NOW - 6000, draft: "K1" }], drafts: { K1: { status: "pending", room: "방" } } },
		}),
	);
	expect(r.failed).toHaveLength(3);
	for (const f of r.failed) expect(Object.hasOwn(f, "why")).toBe(false);
});

test("sent keeps today's replies only, newest first, at most SENT_CAP", () => {
	const sends = Array.from({ length: SENT_CAP + 20 }, (_, i) => ({ id: `k${i}`, chatId: "42", text: `t${i}`, state: "sent", at: SINCE + 1000 + i, draft: "K1" }));
	sends.push({ id: "old", chatId: "42", text: "어제", state: "sent", at: SINCE - 1, draft: "K1" });
	const r = collectOutcomes(inputs({ kakao: { sends, drafts: { K1: { status: "pending", room: "방" } } } }));
	expect(r.sent).toHaveLength(SENT_CAP);
	expect(r.sent[0]!.key).toBe(`kakao:k${SENT_CAP + 19}`);
	expect(r.sent.at(-1)!.key).toBe("kakao:k20");
	expect(r.sent.every(s => s.at >= SINCE)).toBe(true);
	expect(r.sent.some(s => s.key === "kakao:old")).toBe(false);
});

test("sent says how it went out: the owner's pick, a rule, or a second try", () => {
	const r = collectOutcomes(
		inputs({
			notices: [notice("RMAIL01", { state: "sent", at: NOW - 4000 }), notice("RMAIL02", { state: "sent", at: NOW - 3000, attempts: 2 }), notice("RYEST01", { state: "sent", at: SINCE - 5000 })],
			comments: {
				sources: { s1: { src: src("s1"), app: "insta" } },
				drafts: [],
				replies: [reply("send:D1", { state: "sent", draft: "D1", at: NOW - 2000, via: "rule" }), reply("send:D2", { state: "sent", draft: "D2", at: NOW - 1000, attempts: 2 }), reply("send:D3", { state: "sent", draft: "D3", at: SINCE - 1 })],
				comments: [],
			},
		}),
	);
	expect(r.sent.map(s => [s.key, s.how])).toEqual([
		["comment:send:D2", "retry"],
		["comment:send:D1", "rule"],
		["mail:RMAIL02", "retry"],
		["mail:RMAIL01", "owner"],
	]);
});

test("a comment send that went out is not also listed as the mail card that carried its approval", () => {
	const r = collectOutcomes(
		inputs({
			notices: [notice("D1", { state: "sent" })],
			comments: { sources: { s1: { src: src("s1"), app: "insta" } }, drafts: [], replies: [reply("send:D1", { state: "sent", draft: "D1" })], comments: [] },
		}),
	);
	expect(r.sent.map(s => s.key)).toEqual(["comment:send:D1"]);
});

test("stops tells, per pending comment draft, why a rule that is on did not send it; no rule on, no entry", () => {
	const rule = { on: true, match: ["가격"], max_per_day: 1 };
	const facts = (replies: Reply[]) => ({
		sources: { s1: { src: src("s1", rule), app: "insta" }, s0: { src: src("s0"), app: "insta" } },
		drafts: [draft("D1"), draft("D2"), draft("D3", { clean: false }), draft("D5", { source: "s0" })],
		replies,
		comments: [comment("c-D1", "가격이 얼마예요"), comment("c-D2", "안녕하세요"), comment("c-D3", "가격 문의"), comment("c-D5", "가격이 얼마예요")],
	});
	const d = (code: string) => facts([]).drafts.find(x => x.code === code)!;
	const text = (code: string) => facts([]).comments.find(c => c.id === `c-${code}`)!.text;

	const free = collectOutcomes(inputs({ comments: facts([]) })).stops;
	expect(Object.keys(free).sort()).toEqual(["D2", "D3"]);
	expect(free.D2).toBe(ruleRefusal(src("s1", rule), text("D2"), d("D2"), [], NOW)!);
	expect(free.D3).toBe(ruleRefusal(src("s1", rule), text("D3"), d("D3"), [], NOW)!);
	expect(free.D2).not.toBe(free.D3);

	const used = [reply("send:X", { state: "sent", draft: "X", via: "rule", at: NOW - 3_600_000 })];
	const capped = collectOutcomes(inputs({ comments: facts(used) })).stops;
	expect(Object.keys(capped).sort()).toEqual(["D1", "D2", "D3"]);
	expect(capped.D1).toBe(ruleRefusal(src("s1", rule), text("D1"), d("D1"), used, NOW)!);
	expect(capped.D1).not.toBe(capped.D2);
});

// The fake gateway: the notice list is what the route reads, `can` / `enqueue` are the sender's.
function gateway(notices: NoticeLike[], over: Partial<RetryDeps> = {}) {
	const enqueued: SendJob[] = [];
	const deps: RetryDeps = { notices, can: () => true, enqueue: j => (enqueued.push(j), true), drop: async () => ({ ok: true }), commentFailed: () => false, ...over };
	return { deps, enqueued };
}
const retry = (g: ReturnType<typeof gateway>, ref: string, to = "mail:work") => retryFailed([{ ref, to }], g.deps)[0]!;

test("pickedSend reads the send the owner picked from the answer every path writes, and nothing else", () => {
	const of = (answer: string | undefined) => pickedSend(notice("RMAIL01", { state: "failed", ...(answer === undefined ? {} : { answer }) }).decision!);
	expect(of(`1) ${DRAFT_SEND}`)).toBe("send");
	expect(of(`4) ${DRAFT_ONLY_MAIN}`)).toBe("send-main");
	expect(of(`2) ${DRAFT_EDIT}`)).toBeUndefined();
	expect(of(`3) ${DRAFT_DROP}`)).toBeUndefined();
	expect(of(DRAFT_SEND)).toBeUndefined();
	expect(of(`2) ${DRAFT_SEND}`)).toBeUndefined();
	expect(of(`결정 답: 초안 (RMAIL01): 1) ${DRAFT_SEND}`)).toBeUndefined();
	expect(of(undefined)).toBeUndefined();
});

test("retry is refused for a send that did not fail, a card nobody picked 보내기 on, and a card it cannot find", () => {
	for (const state of ["queued", "sending", "sent"] as const) {
		const g = gateway([notice("RMAIL01", { state, answer: `1) ${DRAFT_SEND}` })]);
		expect(retry(g, "RMAIL01").ok).toBe(false);
		expect(g.enqueued).toEqual([]);
	}
	for (const answer of [undefined, `2) ${DRAFT_EDIT}`, "그냥 보내 주세요"]) {
		const g = gateway([notice("RMAIL01", { state: "failed", ...(answer === undefined ? {} : { answer }) })]);
		const r = retry(g, "RMAIL01");
		expect(r).toMatchObject({ ref: "RMAIL01", ok: false });
		expect(r.reason).toBeTruthy();
		expect(g.enqueued).toEqual([]);
	}
	const g = gateway([notice("RMAIL01", { state: "failed", answer: `1) ${DRAFT_SEND}` })]);
	expect(retry(g, "RNOPE01").ok).toBe(false);
	expect(retry(g, "RMAIL01", "mail:other").ok).toBe(false);
	expect(retry(g, "RMAIL01", "lane:build").ok).toBe(false);
	expect(retryFailed([{ ref: "RMAIL01" }, null, 7], g.deps).map(r => r.ok)).toEqual([false, false, false]);
	expect(gateway([notice("RMAIL01", { state: "failed", answer: `1) ${DRAFT_SEND}` })], { can: () => false }).enqueued).toEqual([]);
	expect(g.enqueued).toEqual([]);
});

test("retry of a failed send hands the owner's own pick back to the sender, once per item", () => {
	const g = gateway([
		notice("RMAIL01", { state: "failed", answer: `1) ${DRAFT_SEND}`, title: "김철수에게 답장 (RMAIL01)" }),
		notice("D1", { state: "failed", answer: `4) ${DRAFT_ONLY_MAIN}`, to: "ch:7", title: "댓글 답장 (D1)" }),
	]);
	const res = retryFailed([{ ref: "RMAIL01", to: "mail:work" }, { ref: "D1", to: "ch:7" }], g.deps);
	expect(res).toEqual([{ ref: "RMAIL01", ok: true }, { ref: "D1", ok: true }]);
	expect(g.enqueued).toEqual([
		{ ref: "RMAIL01", conv: "mail:work", action: "send", title: "김철수에게 답장 (RMAIL01)", retry: true },
		{ ref: "D1", conv: "ch:7", action: "send-main", title: "댓글 답장 (D1)", retry: true },
	]);
});

test("retry of a comment whose reply is posted and whose mail failed sends only the mail; with no mail left it is refused", () => {
	const card = () => [notice("CD0000", { state: "failed", answer: `1) ${DRAFT_SEND}`, to: "ch:7", title: "댓글 답장 (CD0000)" })];
	const g = gateway(card(), { posted: () => "pending" });
	expect(retryFailed([{ ref: "CD0000", to: "ch:7" }], g.deps)).toEqual([{ ref: "CD0000", ok: true }]);
	expect(g.enqueued).toEqual([{ ref: "CD0000", conv: "ch:7", action: "send-mail", title: "댓글 답장 (CD0000)", retry: true }]);
	const gone = gateway(card(), { posted: () => "gone" });
	const r = retryFailed([{ ref: "CD0000", to: "ch:7" }], gone.deps)[0]!;
	expect(r).toMatchObject({ ref: "CD0000", ok: false });
	expect(r.reason).toBeTruthy();
	expect(gone.enqueued).toEqual([]);
});

test("through the real sender: a retried draft runs its CLI once, and a ref that already went out is not sent again", async () => {
	const argvs: string[][] = [];
	const marks: string[] = [];
	const sender = createApprovalSender({
		kind: ref => (ref === "RMAIL01" ? { kind: "mail", lane: "mail:work" } : undefined),
		run: async argv => (argvs.push(argv), { code: 0, out: "보냈어요" }),
		report: r => void marks.push(`${r.ref}:${r.state}`),
		log: () => {},
		now: () => NOW,
	});
	const notices = [notice("RMAIL01", { state: "failed", answer: `1) ${DRAFT_SEND}` })];
	const deps: RetryDeps = { notices, can: (ref, a) => sender.can(ref, a), enqueue: j => sender.enqueue(j), drop: async () => ({ ok: true }), commentFailed: () => false };

	expect(retryFailed([{ ref: "RMAIL01", to: "mail:work" }], deps)[0]).toEqual({ ref: "RMAIL01", ok: true });
	await sender.idle();
	expect(argvs).toHaveLength(1);
	expect(argvs[0]!.slice(-3)).toEqual(["send", "RMAIL01", "--retry"]);
	expect(marks).toEqual(["RMAIL01:queued", "RMAIL01:sending", "RMAIL01:sent"]);

	// The page still lists the old failure (its snapshot is a moment old) and the owner taps again: nothing runs.
	retryFailed([{ ref: "RMAIL01", to: "mail:work" }], deps);
	await sender.idle();
	expect(argvs).toHaveLength(1);

	// A draft the stores no longer know is refused before anything is queued.
	expect(retryFailed([{ ref: "RGONE01", to: "mail:work" }], deps)[0]!.ok).toBe(false);
	expect(argvs).toHaveLength(1);
});
