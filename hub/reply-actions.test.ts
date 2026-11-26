// The one reply-action module against fake adapters and the real send queue (design 1.6, 3.1): one case per row of the action table.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalEntries } from "../features/reply-drafts/lib/curate.ts";
import { HEADINGS, paths, profileBullets } from "../features/reply-drafts/lib/settings.ts";
import { approvalHash, createApprovalSender, type SendJob } from "./approval-send.ts";
import { createReplyActions, openRefsOf, setReplies, type ActCtx, type ActInput, type OpenCard, type ReplyDeps } from "./reply-actions.ts";
import { replyLearning } from "./reply-mail.ts";
import { reasonOf } from "./reply-reasons.ts";
import { flush } from "./runtime/test-clock.ts";
import type { DraftView, Lesson, ReplyAdapter, ReplyItem } from "./reply-types.ts";

const owner: ActCtx = { surface: "web", login: "me" };
const agent: ActCtx = { surface: "cli", agent: true };

/** `held`: the revise waits on it; `askThrows`: drawing a card throws; `cards`: the open cards. */
function world(o: { outcome?: string; reviseFails?: boolean; lesson?: string; forbid?: string[]; everywhere?: boolean; forbidFails?: boolean; editLint?: string[]; undoMs?: number; sameRef?: boolean; held?: Promise<void>; askThrows?: boolean; cards?: OpenCard[]; cardConv?: string; pattern?: string; inGood?: string[]; patternFails?: boolean; same?: string; replaced?: string[]; recordFails?: boolean; learning?: ReplyDeps["learning"] } = {}) {
	const log: string[] = [];
	const calls = { edit: 0, drop: 0 };
	const picks: Parameters<ReplyDeps["recordPick"]>[0][] = [];
	let onAsk: ((ref: string) => Promise<void>) | undefined;
	const reported: { state: string; conv: string }[] = [];
	const drafts = new Map<string, DraftView>();
	const view = (ref: string, text: string, state: DraftView["draft"]["state"] = "pending"): DraftView => ({ item: "mail:k1", ref, kind: "mail", app: "mail", label: "메일", conv: "mail:k1", at: 0, can: { send: true, revise: true, edit: true, drop: true, restore: true }, draft: { state, toLabel: "받는이", to: "kim@example.com", text } });
	drafts.set("RAAAAAA", view("RAAAAAA", "확인해 보고 말씀드릴게요."));
	const set = (ref: string, p: Partial<DraftView["draft"]>) => drafts.set(ref, { ...drafts.get(ref)!, draft: { ...drafts.get(ref)!.draft, ...p } });
	const adapter: ReplyAdapter = {
		kind: "mail",
		get: async ref => drafts.get(ref),
		list: async () => [...drafts.values()],
		target: () => ({ kind: "mail", lane: "mail:x" }),
		revise: async (ref, change) => {
			log.push(`model ${change}`);
			await o.held;
			if (o.reviseFails) return { ok: false, reason: reasonOf("revise_failed") };
			if (o.sameRef) return (set(ref, { text: "같은 자리에 고친 글" }), { ok: true, ref, replaces: ref });
			drafts.set("RBBBBBB", { ...view("RBBBBBB", "목요일까지 보내드릴게요."), draft: { ...view("RBBBBBB", "목요일까지 보내드릴게요.").draft, replaces: { ref, text: drafts.get(ref)!.draft.text } } });
			set(ref, { state: "stale" });
			log.push("stored RBBBBBB");
			const lesson: Lesson | undefined = o.lesson !== undefined || o.forbid ? { keys: { channel: { app: "mail" } }, words: o.lesson ?? "", proposal: { scope: o.everywhere ? "everywhere" : "channel", ...(o.forbid ? { forbid: o.forbid } : {}) }, evidence: { draft: drafts.get(ref)!.draft.text, change } } : undefined;
			return { ok: true, ref: "RBBBBBB", replaces: ref, ...(lesson ? { lesson } : {}) };
		},
		edit: async (ref, text, _part, subject) => {
			calls.edit++;
			if (o.editLint) return { ok: false, reason: reasonOf("forbidden_word", { word: "무조건" }), lint: o.editLint };
			set(ref, { text, edited: true, ...(subject !== undefined ? { subject } : {}) });
			return { ok: true };
		},
		drop: async ref => (calls.drop++, set(ref, { state: "dropped" }), { ok: true }),
		restore: async ref => (set(ref, { state: "pending" }), { ok: true }),
		markSent: async ref => (set(ref, { state: "sent" }), { ok: true }),
		ask: async (ref, headline) => {
			await onAsk?.(ref);
			if (o.askThrows) throw new Error("card text failed");
			return `[ask] ${headline ?? "카드"} (${ref})`;
		},
		question: ref => `이 답장 보낼까요? (${ref})`,
	};
	const ran: string[][] = [];
	// Every card drawn anew: the ref it shows now and the version hash it keeps.
	const drawn: [string, string | undefined][] = [];
	const texts: string[] = [];
	// Every card posted again (a confirm card): its ref, the text it shows and the version hash it keeps.
	const reposts: [string, string | undefined, string | undefined][] = [];
	// The clock and the timers (the cancel window, code's own retries) move only when the test says so.
	let clock = 1_000_000;
	const timers: (() => void)[] = [];
	const sender = createApprovalSender({
		kind: ref => (drafts.has(ref) ? { kind: "mail", lane: "mail:x" } : undefined),
		fingerprint: async ref => (drafts.has(ref) ? approvalHash(drafts.get(ref)!) : undefined),
		run: async argv => (ran.push(argv), { code: o.outcome ? 1 : 0, out: o.outcome ?? "보냈어요" }),
		report: r => void (log.push(`send ${r.ref} ${r.state}`), reported.push({ state: r.state, conv: r.conv })),
		log: () => undefined,
		now: () => clock,
		undoMs: () => o.undoMs ?? 0,
		after: (_ms, fn) => void timers.push(fn),
	});
	const deps: ReplyDeps = {
		adapters: [adapter],
		sender,
		recordPick: p => void (picks.push(p), log.push(`pick ${p.label}${p.note ? ` - ${p.note}` : ""}`)),
		recordText: (_c, t) => void log.push(`text ${t}`),
		say: (conv, ref, text) => void log.push(`say ${conv} ${ref} ${text}`),
		learning: o.learning ?? {
			learn: async i => {
				log.push(`learn ${i.keys.channel.app} ${i.proposal?.scope ?? "channel"} ${i.words}`);
				if (o.recordFails) throw new Error("disk full");
				return { ref: i.ref, state: "remembered", line: i.words, scope: i.proposal?.scope ?? "channel", scopeLabel: "이 앱", scopes: ["channel", "everywhere"], text: `기억했어요: "${i.words}" · 범위: 이 앱` };
			},
			shown: () => undefined,
			flip: async () => undefined,
		},
		cards: { open: () => o.cards ?? [], convOf: () => o.cardConv, replace: (a, b, text, hash) => void (drawn.push([b, hash]), log.push(`cards ${a}->${b}`), texts.push(text)), rewrite: (ref, _t, hash) => void (drawn.push([ref, hash]), log.push(`rewrite ${ref}`)), repost: async (ref, text, hash) => void reposts.push([ref, text, hash]), close: ref => void log.push(`close ${ref}`) },
		toBot: async (conv, text) => void log.push(`bot ${conv} ${text}`),
		emit: e => void log.push(`event ${e.ref}${e.next ? `->${e.next}` : ""}${e.revising ? " revising" : ""}${e.why ? ` ${e.why}` : ""}`),
		log: () => undefined,
	};
	const replies = createReplyActions(deps);
	const linesOf = (prefix: string) => log.filter(l => l.startsWith(prefix));
	/** Time passes by `ms` and every timer that was set runs (one approval in the window, or code's next attempt). */
	const fire = async (ms = 0) => {
		clock += ms;
		for (const fn of timers.splice(0)) fn();
		await sender.idle();
	};
	const last = () => sender.results().at(-1);
	// The version the owner is shown now (a web card names it with its 보내기).
	const seen = (ref: string) => approvalHash(drafts.get(ref)!);
	return { replies, sender, log, texts, ran, drafts, seen, drawn, reposts, linesOf, picks, set, fire, last, timers, calls, onAsk: (fn: typeof onAsk) => void (onAsk = fn), reported };
}

test("send: the owner's pick is written before the send is queued, and a second send of the same draft sends nothing", async () => {
	const w = world();
	const r = await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner);
	expect(r.status).toBe(200);
	expect(w.log.slice(0, 2)).toEqual(["pick 보내기", "send RAAAAAA queued"]);
	await w.sender.idle();
	expect(w.ran).toHaveLength(1);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner)).body).toMatchObject({ ok: false, code: "already_sent" });
});

test("a send whose card was already answered reports to the card's conversation, not the draft's send lane, and so does its retry", async () => {
	const w = world({ outcome: 'DOTZ_SEND {"sent":"no","code":"rejected"}', cardConv: "ch:card" });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner)).status).toBe(200);
	await w.sender.idle();
	expect((await w.replies.act({ ref: "RAAAAAA", action: "retry", hash: w.seen("RAAAAAA") }, owner)).status).toBe(200);
	await w.sender.idle();
	expect(w.reported.filter(r => r.state === "failed")).toEqual([{ state: "failed", conv: "ch:card" }, { state: "failed", conv: "ch:card" }]);
	expect(w.reported.every(r => r.conv === "ch:card")).toBe(true);
});

/** Every job the actions queue, in order (the sender keeps no retry flag once a job ends). */
function spy(sender: ReturnType<typeof createApprovalSender>): SendJob[] {
	const jobs: SendJob[] = [];
	const enqueue = sender.enqueue;
	sender.enqueue = (j, approved) => (jobs.push(j), enqueue(j, approved));
	return jobs;
}

// Every press is a fresh 보내기 (Dt8pq3b below); what differs is what the CLI is asked to do with it.
test("다시 보내기 of a send that failed for want of a fresh approval (mail_gone) sends it as a new one; a plain failure's 다시 보내기 is a retry of the same send", async () => {
	for (const [code, retried] of [["mail_gone", false], ["quota", true]] as const) {
		const o: { outcome?: string } = { outcome: `DOTZ_SEND {"sent":"no","code":"${code}"}` };
		const w = world(o);
		const jobs = spy(w.sender);
		await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner);
		await w.sender.idle();
		expect((await w.replies.list())[0]!.send).toMatchObject({ state: "failed", reason: { code } });
		o.outcome = undefined;
		expect((await w.replies.act({ ref: "RAAAAAA", action: "retry", hash: w.seen("RAAAAAA") }, owner)).status).toBe(200);
		await w.sender.idle();
		expect(w.linesOf("pick")).toEqual(["pick 보내기", "pick 보내기"]);
		expect(w.last()).toMatchObject({ state: "sent" });
		expect(jobs.map(j => j.retry ?? false)).toEqual([false, retried]);
	}
});

test("revise: 202 at once; the model runs, the new draft is stored, then the lesson goes to the learning entry, then the cards move and one event names the new ref", async () => {
	const w = world({ lesson: "마감은 넉넉히 잡아서 쓴다" });
	const r = await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "마감을 목요일로" }, owner);
	expect(r.status).toBe(202);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "또" }, owner)).body).toMatchObject({ code: "revising" });
	await w.replies.idle();
	expect(w.log).toEqual(["pick 고치기 - 마감을 목요일로", "event RAAAAAA revising", "model 마감을 목요일로", "stored RBBBBBB", "learn mail channel 마감은 넉넉히 잡아서 쓴다", "cards RAAAAAA->RBBBBBB", "event RAAAAAA->RBBBBBB"]);
});

test("revise: the new draft cannot be sent until its cards moved; a revise that keeps the same ref is a failed revise", async () => {
	const w = world();
	const early: unknown[] = [];
	w.onAsk(async ref => void early.push((await w.replies.act({ ref, action: "send", hash: w.seen(ref) }, owner)).body));
	await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, owner);
	await w.replies.idle();
	expect(early).toEqual([expect.objectContaining({ ok: false, code: "revising" })]);
	expect(w.sender.results()).toEqual([]);

	const same = world({ sameRef: true });
	await same.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, owner);
	await same.replies.idle();
	expect(same.linesOf("event").at(-1)).toStartWith("event RAAAAAA 고치지 못했어요");
	expect(same.linesOf("rewrite")).toEqual([]);
});

test("a revise that fails leaves the old draft pending, learns nothing and says why on the card", async () => {
	const w = world({ reviseFails: true, lesson: "x" });
	await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, owner);
	await w.replies.idle();
	expect(w.drafts.get("RAAAAAA")!.draft.state).toBe("pending");
	expect(w.linesOf("learn")).toEqual([]);
	expect(w.linesOf("event").at(-1)).toBe("event RAAAAAA 고치지 못했어요 - 고친 초안을 만들지 못했어요");
});

test("a 고치기 pressed on a Discord card that fails says why once in that conversation; the web's says it on the card only", async () => {
	const discord: ActCtx = { surface: "discord", login: "owner" };
	for (const [o, said] of [[{ reviseFails: true }, "say mail:k1 RAAAAAA 고치지 못했어요 - 고친 초안을 만들지 못했어요 (RAAAAAA)"], [{ askThrows: true }, "say mail:k1 RAAAAAA 고친 초안을 카드에 올리지 못했어요 (RAAAAAA)"]] as const) {
		const w = world(o);
		await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, discord);
		await w.replies.idle();
		expect(w.linesOf("say")).toEqual([said]);
	}
	const w = world({ reviseFails: true });
	await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, owner);
	await w.replies.idle();
	expect(w.linesOf("say")).toEqual([]);
	const ok = world();
	await ok.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, discord);
	await ok.replies.idle();
	expect(ok.linesOf("say")).toEqual([]);
});

test("D3e2ymp: 직접 고치기 saves only (its one pick, no send, a body with send is 400); a 보내기 picked before a change cannot send the changed text", async () => {
	const w = world({ undoMs: 10_000 });
	const both = await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "제가 쓴 그대로예요", send: true } as ActInput, owner);
	expect(both).toMatchObject({ status: 400, body: { ok: false, code: "bad_request" } });
	expect(w.drafts.get("RAAAAAA")!.draft.text).toBe("확인해 보고 말씀드릴게요.");

	const r = await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "제가 쓴 그대로예요" }, owner);
	expect(r.status).toBe(200);
	expect(w.drafts.get("RAAAAAA")!.draft.text).toBe("제가 쓴 그대로예요");
	expect(w.linesOf("pick")).toEqual(["pick 직접 고치기"]);
	expect(w.sender.results()).toEqual([]);

	// 보내기 on the saved version; while it waits nothing may edit it, and a change made under it anyway voids it.
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner)).status).toBe(200);
	expect(w.picks.at(-1)).toMatchObject({ label: "보내기", hash: approvalHash(w.drafts.get("RAAAAAA")!) });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "또 고침" }, owner)).body).toMatchObject({ code: "already_sending" });
	w.set("RAAAAAA", { text: "그사이 바뀐 글" });
	await w.fire(10_000);
	expect(w.ran).toEqual([]);
	expect(w.last()).toMatchObject({ state: "failed", reason: { code: "changed" } });
	expect((await w.replies.list())[0]!.send).toMatchObject({ state: "failed", safeToAuto: false, actions: ["retry", "redraft", "drop"] });
});

test("Dt8pq3b: after a failed send, 다시 보내기 and 보내기 are fresh owner picks on the version shown now, and that version goes", async () => {
	const w = world({ outcome: 'DOTZ_SEND {"sent":"no","code":"mail_gone"}' });
	await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner);
	await w.sender.idle();
	expect(w.last()).toMatchObject({ state: "failed", reason: { code: "mail_gone" } });
	// The card without its mail (the comment engine strips it and re-stamps mailAt): another version than the one first approved.
	w.set("RAAAAAA", { text: "답글만 올려요" });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "retry", hash: w.seen("RAAAAAA") }, owner)).status).toBe(200);
	await w.sender.idle();
	expect(w.ran).toHaveLength(2);
	expect(w.picks.map(p => [p.n, p.label])).toEqual([[1, "보내기"], [1, "보내기"]]);
	expect(w.picks[1]!.hash).toBe(approvalHash(w.drafts.get("RAAAAAA")!));
	expect(w.picks[1]!.hash).not.toBe(w.picks[0]!.hash);
	// 보내기 on a failed send is no pick-less retry either.
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send", asIs: true, hash: w.seen("RAAAAAA") }, owner)).status).toBe(200);
	await w.sender.idle();
	expect(w.picks.at(-1)).toMatchObject({ n: 4, label: "이대로 보내기" });
	expect(w.ran).toHaveLength(3);
});

test("code's own retry: an edit cancels it; a draft changed under it ends `changed` and sends nothing", async () => {
	const offline = 'DOTZ_SEND {"sent":"no","code":"offline"}';
	const w = world({ outcome: offline });
	await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner);
	await w.sender.idle();
	expect(w.last()).toMatchObject({ state: "failed", safeToAuto: true });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "고친 글" }, owner)).status).toBe(200);
	await w.fire(60_000);
	expect(w.ran).toHaveLength(1);
	expect((await w.replies.list())[0]!.send).toBeUndefined();

	const v = world({ outcome: offline });
	await v.replies.act({ ref: "RAAAAAA", action: "send", hash: v.seen("RAAAAAA") }, owner);
	await v.sender.idle();
	v.set("RAAAAAA", { text: "그사이 바뀐 글" });
	await v.fire(60_000);
	expect(v.ran).toHaveLength(1);
	expect(v.last()).toMatchObject({ state: "failed", reason: { code: "changed" }, safeToAuto: false });
	expect(v.timers).toEqual([]);
});

test("an edit the owner-text lint refuses answers 422 with the lines and sends nothing", async () => {
	const w = world({ editLint: ["쓰지 않기로 한 표현 '무조건'이(가) 있어요"] });
	const r = await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "무조건 드릴게요" }, owner);
	expect(r).toMatchObject({ status: 422, body: { ok: false, code: "forbidden_word", lint: ["쓰지 않기로 한 표현 '무조건'이(가) 있어요"] } });
	expect(w.ran).toEqual([]);
});

test("unsure: a second send answers needs_resolve; 나갔어요 closes it as sent; 다시 보내기 is the owner's force", async () => {
	const maybe = 'DOTZ_SEND {"sent":"maybe","code":"net_cut"}';
	const w = world({ outcome: maybe });
	await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner);
	await w.sender.idle();
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner)).body).toMatchObject({ code: "needs_resolve" });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "drop" }, owner)).body).toMatchObject({ code: "needs_resolve" });
	const item = (await w.replies.list())[0]!;
	expect(item.send).toMatchObject({ state: "unsure", reason: { code: "net_cut" }, actions: ["resolve_sent", "open_channel", "resolve_retry"] });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "resolve", as: "retry", hash: w.seen("RAAAAAA") }, owner)).status).toBe(200);
	await w.sender.idle();
	expect(w.ran).toHaveLength(2);
	expect(w.ran[1]!.slice(-2)).toEqual(["--retry", "--no-learn"]);

	const v = world({ outcome: maybe });
	await v.replies.act({ ref: "RAAAAAA", action: "send", hash: v.seen("RAAAAAA") }, owner);
	await v.sender.idle();
	expect((await v.replies.act({ ref: "RAAAAAA", action: "resolve", as: "sent" }, owner)).status).toBe(200);
	expect(v.drafts.get("RAAAAAA")!.draft.state).toBe("sent");
	expect(v.linesOf("text")).toEqual(["text 나갔어요"]);
	expect(v.ran).toHaveLength(1);
});

test("undo inside the window cancels the send; drop and restore move the draft and close the card", async () => {
	const w = world();
	const sender = createApprovalSender({ kind: () => ({ kind: "mail", lane: "m" }), run: async () => ({ code: 0, out: "" }), report: () => undefined, log: () => undefined, undoMs: () => 10_000, after: () => undefined });
	const replies = createReplyActions({ adapters: [], sender, recordPick: () => undefined, learning: { learn: async i => ({ ref: i.ref, state: "once", line: "", scope: "channel", scopeLabel: "이 앱", scopes: ["channel"], text: "이번만 반영했어요" }), shown: () => undefined, flip: async () => undefined }, cards: { open: () => [], replace: () => undefined, rewrite: () => undefined, close: () => undefined }, toBot: async () => undefined, emit: () => undefined, log: () => undefined });
	expect((await replies.act({ ref: "RAAAAAA", action: "undo" }, owner)).status).toBe(404);
	const job: SendJob = { ref: "RAAAAAA", conv: "c", action: "send", title: "q (RAAAAAA)" };
	sender.enqueue(job);
	expect(sender.cancel("RAAAAAA")).toBe("cancelled");

	expect((await w.replies.act({ ref: "RAAAAAA", action: "drop" }, owner)).status).toBe(200);
	expect(w.linesOf("pick")).toEqual(["pick 보내지 않기"]);
	expect(w.linesOf("close")).toEqual(["close RAAAAAA"]);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "restore" }, owner)).status).toBe(200);
	expect(w.drafts.get("RAAAAAA")!.draft.state).toBe("pending");
});

test("an agent caller may only revise: it writes no pick, and send and everything else is 403", async () => {
	const w = world();
	for (const action of ["send", "edit", "drop", "resolve", "undo", "retry", "restore"]) expect((await w.replies.act({ ref: "RAAAAAA", action, text: "x" }, agent)).body).toMatchObject({ ok: false, code: "owner_only" });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, agent)).status).toBe(202);
	await w.replies.idle();
	expect((await w.replies.act({ ref: "RBBBBBB", action: "send" }, agent)).status).toBe(403);
	expect(w.ran).toEqual([]);
	expect(w.linesOf("pick")).toEqual([]);
});

test("a hand-written card goes to the bot as its numbered answer and closes on 보내기 or 보내지 않기, not on 고치기; a batch sends one message per conversation", async () => {
	const w = world();
	let cards = [{ ref: "X1", conv: "ch:1", notice: "n1", title: "이 답글 올릴까요? (X1)" }, { ref: "X2", conv: "ch:1", notice: "n2", title: "이 답글 올릴까요? (X2)" }, { ref: "X3", conv: "ch:1", notice: "n3", title: "이 답장 보낼까요? (X3)" }];
	const log: string[] = [];
	const close = (ref: string) => void (log.push(`close ${ref}`), (cards = cards.filter(c => c.ref !== ref)));
	const replies = createReplyActions({ adapters: [], sender: w.sender, recordPick: () => undefined, learning: { learn: async i => ({ ref: i.ref, state: "once", line: "", scope: "channel", scopeLabel: "이 앱", scopes: ["channel"], text: "이번만 반영했어요" }), shown: () => undefined, flip: async () => undefined }, cards: { open: () => cards, replace: () => undefined, rewrite: () => undefined, close }, toBot: async (c, t) => void log.push(`${c}|${t}`), emit: () => undefined, log: () => undefined });
	const r = await replies.batch([{ ref: "X1", action: "send" }, { ref: "X2", action: "revise", change: "더 짧게" }, { ref: "NOPE", action: "send" }], owner);
	expect(r.body).toMatchObject({ results: [{ ref: "X1", ok: true }, { ref: "X2", ok: true }, { ref: "NOPE", ok: false, code: "unknown_ref" }] });
	expect(log).toEqual(["ch:1|결정 답: 이 답글 올릴까요? (X1) → 1) 보내기\n결정 답: 이 답글 올릴까요? (X2) → 2) 고치기 - 더 짧게", "close X1"]);
	// The owner's 보내지 않기 closes the card: the model's marker on it again reaches the bot no more (one card once went to the bot three times).
	log.length = 0;
	expect((await replies.act({ ref: "X3", action: "drop" }, owner)).status).toBe(200);
	expect((await replies.act({ ref: "X3", action: "drop" }, owner)).body).toMatchObject({ ok: false, code: "unknown_ref" });
	expect(log).toEqual(["ch:1|결정 답: 이 답장 보낼까요? (X3) → 3) 보내지 않기", "close X3"]);
	expect(replies.open("ch:1").map(c => c.ref)).toEqual(["X2"]);
});

test("the model's own [drop] marker on a hand-written card, carrying the owner's words, closes the card and sends the bot no 결정 답 line to read as his press again", async () => {
	const w = world();
	let cards = [{ ref: "X1", conv: "ch:1", notice: "n1", title: "이 답장 보낼까요? (X1)" }];
	const log: string[] = [];
	const close = (ref: string) => void (log.push(`close ${ref}`), (cards = cards.filter(c => c.ref !== ref)));
	const replies = createReplyActions({ adapters: [], sender: w.sender, recordPick: () => undefined, learning: { learn: async i => ({ ref: i.ref, state: "once", line: "", scope: "channel", scopeLabel: "이 앱", scopes: ["channel"], text: "이번만 반영했어요" }), shown: () => undefined, flip: async () => undefined }, cards: { open: () => cards, replace: () => undefined, rewrite: () => undefined, close }, toBot: async (c, t) => void log.push(`${c}|${t}`), emit: () => undefined, log: () => undefined });
	expect((await replies.act({ ref: "X1", action: "drop" }, { surface: "chat", owner: { mid: "m1", text: "그건 보내지 마" } })).status).toBe(200);
	expect(log).toEqual(["close X1"]);
});

test("the model's own [revise] marker on a hand-written card reaches the bot as the agent's line, so the page never shows it as the owner's message", async () => {
	const w = world();
	const cards = [{ ref: "X1", conv: "ch:1", notice: "n1", title: "이 답장 보낼까요? (X1)" }];
	const sent: [string, boolean][] = [];
	const replies = createReplyActions({ adapters: [], sender: w.sender, recordPick: () => undefined, learning: { learn: async i => ({ ref: i.ref, state: "once", line: "", scope: "channel", scopeLabel: "이 앱", scopes: ["channel"], text: "이번만 반영했어요" }), shown: () => undefined, flip: async () => undefined }, cards: { open: () => cards, replace: () => undefined, rewrite: () => undefined, close: () => undefined }, toBot: async (_c, t, agent) => void sent.push([t, agent]), emit: () => undefined, log: () => undefined });
	expect((await replies.act({ ref: "X1", action: "revise", change: "더 짧게" }, { surface: "chat", owner: { mid: "m1", text: "더 짧게 고쳐" } })).status).toBe(200);
	expect((await replies.act({ ref: "X1", action: "revise", change: "존댓말로" }, owner)).status).toBe(200);
	expect(sent).toEqual([["결정 답: 이 답장 보낼까요? (X1) → 2) 고치기 - 더 짧게", true], ["결정 답: 이 답장 보낼까요? (X1) → 2) 고치기 - 존댓말로", false]]);
});

test("a hand-written send card lists with the recipient, subject, body and files its own lines carry, so the 답장 확인 sheet shows what 보내기 sends", async () => {
	const w = world();
	const draft = { toLabel: "받는이", to: "A <a@example.com>", subject: "제목A", body: "본문A", attachments: [{ name: "파일A.xlsx", size: "12 KB" }] };
	const cards = [{ ref: "X1", conv: "ch:1", notice: "n1", title: "이 답장 보낼까요? (X1)", draft }, { ref: "X2", conv: "ch:1", notice: "n2", title: "이 답글 올릴까요? (X2)" }];
	const replies = createReplyActions({ adapters: [], sender: w.sender, recordPick: () => undefined, learning: { learn: async i => ({ ref: i.ref, state: "once", line: "", scope: "channel", scopeLabel: "이 앱", scopes: ["channel"], text: "이번만 반영했어요" }), shown: () => undefined, flip: async () => undefined }, cards: { open: () => cards, replace: () => undefined, rewrite: () => undefined, close: () => undefined }, toBot: async () => undefined, emit: () => undefined, log: () => undefined });
	const items = await replies.list();
	expect(items.find(i => i.ref === "X1")?.draft).toEqual({ state: "pending", toLabel: "받는이", to: "A <a@example.com>", subject: "제목A", text: "본문A", attachments: [{ name: "파일A.xlsx", size: "12 KB" }] });
	expect(items.find(i => i.ref === "X2")?.draft).toEqual({ state: "pending", toLabel: "", to: "", text: "" });
});

test("D7: a send names the version it showed; another one is refused `changed` with the fresh item, nothing picked or queued, and the cards redrawn", async () => {
	const w = world();
	const shown = (await w.replies.list())[0]!;
	expect(shown.draft.hash).toBe(approvalHash(w.drafts.get("RAAAAAA")!));
	w.set("RAAAAAA", { text: "다른 기기에서 바뀐 글" });
	const now = approvalHash(w.drafts.get("RAAAAAA")!);
	for (const input of [{ action: "send" }, { action: "send", asIs: true }, { action: "retry" }, { action: "resolve", as: "retry" }] as const) {
		const r = await w.replies.act({ ref: "RAAAAAA", ...input, hash: shown.draft.hash }, owner);
		expect([r.status, r.body]).toEqual([409, expect.objectContaining({ ok: false, code: "changed", item: expect.objectContaining({ draft: expect.objectContaining({ text: "다른 기기에서 바뀐 글", hash: now }) }) })]);
	}
	expect(w.picks).toEqual([]);
	expect(w.sender.results()).toEqual([]);
	expect(w.drawn).toEqual(Array(4).fill(["RAAAAAA", now]));
	// The fresh item's hash sends; a resolve as sent carries no version check.
	expect((await w.replies.act({ ref: "RAAAAAA", action: "resolve", as: "sent", hash: shown.draft.hash }, owner)).body).toMatchObject({ code: "not_pending" });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send", hash: now }, owner)).status).toBe(200);
	expect(w.picks.map(p => [p.label, p.hash])).toEqual([["보내기", now]]);
});

test("A1: a refused send tells every surface; a send naming no version (typed chat) is checked against the version its card was drawn with", async () => {
	const card: OpenCard = { ref: "RAAAAAA", conv: "ch:1", notice: "n1", title: "이 답장 보낼까요? (RAAAAAA)" };
	const w = world({ cards: [card] });
	card.hash = approvalHash(w.drafts.get("RAAAAAA")!);
	w.set("RAAAAAA", { text: "다른 기기에서 바뀐 글" });
	const r = await w.replies.act({ ref: "RAAAAAA", action: "send" }, { surface: "chat" });
	expect([r.status, r.body]).toEqual([409, expect.objectContaining({ ok: false, code: "changed" })]);
	expect(w.linesOf("event")).toEqual(["event RAAAAAA"]);
	expect([w.picks, w.sender.results()]).toEqual([[], []]);
	card.hash = approvalHash(w.drafts.get("RAAAAAA")!);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send" }, { surface: "chat" })).status).toBe(200);
});

test("a send naming no version from a card that recorded none, with no card, or with \"\" is refused `changed`: nothing picked or queued, the card drawn anew with the store's version", async () => {
	const card: OpenCard = { ref: "RAAAAAA", conv: "ch:1", notice: "n1", title: "이 답장 보낼까요? (RAAAAAA)" };
	const w = world({ cards: [card] });
	const now = w.seen("RAAAAAA");
	for (const [input, ctx] of [[{ action: "send" }, { surface: "chat" }], [{ action: "send", hash: "" }, { surface: "discord" }], [{ action: "send", asIs: true }, owner]] as const) {
		const r = await w.replies.act({ ref: "RAAAAAA", ...input }, ctx);
		expect([r.status, r.body]).toEqual([409, expect.objectContaining({ ok: false, code: "changed" })]);
	}
	const bare = world();
	expect((await bare.replies.act({ ref: "RAAAAAA", action: "send" }, owner)).body).toMatchObject({ ok: false, code: "changed" });
	expect([w.picks, w.sender.results(), bare.picks, bare.sender.results()]).toEqual([[], [], [], []]);
	expect(w.drawn).toEqual(Array(3).fill(["RAAAAAA", now]));
	// The card drawn anew keeps that version (hub/notices-drafts.ts redrawDraftCards): the next pick from it sends.
	card.hash = w.drawn[0]![1];
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send" }, { surface: "chat" })).status).toBe(200);
	expect(w.picks.map(p => [p.label, p.hash])).toEqual([["보내기", now]]);
});

test("A3: while a revise replaces the draft, drop and edit are refused `revising` and reach no store; after it, the new draft drops", async () => {
	let release!: () => void;
	const w = world({ held: new Promise<void>(r => (release = r)) });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, owner)).status).toBe(202);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "drop" }, owner)).body).toMatchObject({ ok: false, code: "revising" });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "제가 쓴 글" }, owner)).body).toMatchObject({ ok: false, code: "revising" });
	expect(w.calls).toEqual({ edit: 0, drop: 0 });
	release();
	await w.replies.idle();
	expect((await w.replies.act({ ref: "RBBBBBB", action: "drop" }, owner)).status).toBe(200);
	expect(w.calls.drop).toBe(1);
});

test("A4: a hand edit the store refuses writes no pick and leaves code's own retry armed", async () => {
	const w = world({ outcome: 'DOTZ_SEND {"sent":"no","code":"offline"}', editLint: ["무조건"] });
	await w.replies.act({ ref: "RAAAAAA", action: "send", hash: w.seen("RAAAAAA") }, owner);
	await w.sender.idle();
	expect((await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "무조건 드릴게요" }, owner)).status).toBe(422);
	expect(w.picks.map(p => p.label)).toEqual(["보내기"]);
	expect(w.last()).toMatchObject({ state: "failed", safeToAuto: true });
	await w.fire(60_000);
	expect(w.ran).toHaveLength(2);
});

test("A5: an edit names the version its field opened on; another one is refused `changed` and saves nothing; no version (an older page) is accepted", async () => {
	const w = world({ cards: [{ ref: "RAAAAAA", conv: "ch:1", notice: "n1", title: "q", hash: "0000000000000000" }] });
	const opened = approvalHash(w.drafts.get("RAAAAAA")!);
	w.set("RAAAAAA", { text: "다른 기기에서 바뀐 글" });
	const r = await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "제가 쓴 글", hash: opened }, owner);
	expect([r.status, r.body]).toEqual([409, expect.objectContaining({ ok: false, code: "changed" })]);
	expect([w.calls.edit, w.picks]).toEqual([0, []]);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "제가 쓴 글", hash: approvalHash(w.drafts.get("RAAAAAA")!) }, owner)).status).toBe(200);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "또 쓴 글" }, owner)).status).toBe(200);
	expect(w.calls.edit).toBe(2);
});

test("A7: a revised draft whose card cannot be drawn ends 고치는 중 with a reason on the event and settles the run", async () => {
	const w = world({ askThrows: true });
	await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, owner);
	await w.replies.idle();
	expect(w.linesOf("event").at(-1)).toStartWith("event RAAAAAA->RBBBBBB ");
	expect((await w.replies.view("RBBBBBB"))!.draft.revising).toBeUndefined();
	expect((await w.replies.act({ ref: "RBBBBBB", action: "drop" }, owner)).status).toBe(200);
});

test("edit with a subject saves it on a mail draft and redraws the cards with the saved version's hash; a subject on a KakaoTalk draft is 400", async () => {
	const w = world();
	const r = await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "제가 쓴 글이에요", subject: "Re: 다음 주 일정" }, owner);
	const saved = w.drafts.get("RAAAAAA")!;
	expect([r.status, saved.draft.subject, saved.draft.text]).toEqual([200, "Re: 다음 주 일정", "제가 쓴 글이에요"]);
	expect(r.body).toMatchObject({ ok: true, item: { draft: { hash: approvalHash(saved) } } });
	expect(w.drawn).toEqual([["RAAAAAA", approvalHash(saved)]]);
	w.drafts.set("KAAAAAA", { ...saved, ref: "KAAAAAA", kind: "kakao" });
	expect((await w.replies.act({ ref: "KAAAAAA", action: "edit", text: "네", subject: "제목" }, owner)).body).toMatchObject({ ok: false, code: "bad_request" });
	expect(w.drafts.get("KAAAAAA")!.draft.text).toBe("제가 쓴 글이에요");
});

test("revise: the cards move to the new draft with its hash", async () => {
	const w = world();
	await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "마감을 목요일로" }, owner);
	await w.replies.idle();
	expect(w.drawn).toEqual([["RBBBBBB", approvalHash(w.drafts.get("RBBBBBB")!)]]);
});

test("amend (Discord's 고치기 form with changed text): text alone only saves; with words it saves, then revises the saved text; a failed save revises nothing", async () => {
	const saveOnly = world();
	expect((await saveOnly.replies.amend({ ref: "RAAAAAA", text: "제가 쓴 글이에요" }, owner)).status).toBe(200);
	expect([saveOnly.linesOf("pick"), saveOnly.linesOf("model"), saveOnly.drafts.get("RAAAAAA")!.draft.text]).toEqual([["pick 직접 고치기"], [], "제가 쓴 글이에요"]);

	const both = world();
	expect((await both.replies.amend({ ref: "RAAAAAA", text: "제가 쓴 글이에요", change: "더 공손하게" }, owner)).status).toBe(202);
	await both.replies.idle();
	expect(both.log.slice(0, 5)).toEqual(["pick 직접 고치기", "rewrite RAAAAAA", "event RAAAAAA", "pick 고치기 - 더 공손하게", "event RAAAAAA revising"]);
	expect(both.linesOf("model")).toEqual(["model 더 공손하게"]);
	expect(both.drafts.get("RBBBBBB")!.draft.replaces?.text).toBe("제가 쓴 글이에요");

	const refused = world({ editLint: ["무조건"] });
	expect((await refused.replies.amend({ ref: "RAAAAAA", text: "무조건 됩니다", change: "더 짧게" }, owner)).status).toBe(422);
	expect(refused.linesOf("model")).toEqual([]);
});

// B2 (server.md S3): the store keeps the draft in mail:k1, its card was posted in "web": a typed answer and the model's marker look there.
test("a draft with an open card is listed in the card's conversation with its notice, and its ref is open there before any list", async () => {
	const w = world({ cards: [{ ref: "RAAAAAA", conv: "web", notice: "n1", title: "이 답장 보낼까요? (RAAAAAA)" }] });
	setReplies(w.replies);
	try {
		expect([openRefsOf("web"), openRefsOf("mail:k1")]).toEqual([["RAAAAAA"], []]);
		const [it] = await w.replies.list();
		expect([it!.conv, it!.notice, it!.kind]).toEqual(["web", "n1", "mail"]);
	} finally {
		setReplies(undefined);
	}
});

// B5: the model's marker on a hand-written card is its 2) 고치기 answer to the bot, not a refusal.
test("an agent's revise of a hand-written card goes to the bot once as its 고치기 line; its send is still refused", async () => {
	const w = world({ cards: [{ ref: "X9", conv: "ch:1", notice: "n9", title: "이 답글 올릴까요? (X9)" }] });
	expect((await w.replies.act({ ref: "X9", action: "revise", change: "더 짧게" }, agent)).status).toBe(200);
	expect((await w.replies.act({ ref: "X9", action: "send" }, agent)).body).toMatchObject({ ok: false, code: "owner_only" });
	expect(w.linesOf("bot")).toEqual(["bot ch:1 결정 답: 이 답글 올릴까요? (X9) → 2) 고치기 - 더 짧게"]);
});

// The reply intent design, option (i): a send the model read from the owner's words never sends.
const fromOwner = (text: string, mid = "m1"): ActCtx => ({ surface: "chat", owner: { mid, text } });

test("confirm: a model-read send posts the card again headed 보낼까요? with the version it shows, picks and queues nothing; only the owner's 보내기 of that version sends", async () => {
	const w = world({ cards: [{ ref: "RAAAAAA", conv: "ch:1", notice: "n1", title: "이 답장 보낼까요? (RAAAAAA)" }] });
	const r = await w.replies.confirm({ ref: "RAAAAAA" }, fromOwner("보내"));
	const hash = (r.body as { item: ReplyItem }).item.draft.hash;
	expect([r.status, w.reposts, w.picks, w.sender.results(), w.linesOf("event")]).toEqual([200, [["RAAAAAA", '[ask] 보낼까요? → 받는이 kim@example.com: "확인해 보고 말씀드릴게요." (RAAAAAA)', hash]], [], [], ["event RAAAAAA"]]);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send", hash: "other" }, owner)).body).toMatchObject({ ok: false, code: "changed" });
	expect(w.sender.results()).toEqual([]);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send", hash }, owner)).status).toBe(200);
	expect(w.picks.map(p => [p.label, p.hash])).toEqual([["보내기", hash]]);
});

test("confirm refuses as a send would and posts nothing: a draft being revised, one whose send waits, one already sent, an unknown ref", async () => {
	const revising = world({ held: new Promise(() => undefined) });
	await revising.replies.act({ ref: "RAAAAAA", action: "revise", change: "짧게" }, owner);
	const waiting = world({ undoMs: 10_000 });
	await waiting.replies.act({ ref: "RAAAAAA", action: "send", hash: waiting.seen("RAAAAAA") }, owner);
	const sent = world();
	await sent.replies.act({ ref: "RAAAAAA", action: "send", hash: sent.seen("RAAAAAA") }, owner);
	await sent.sender.idle();
	const codes: string[] = [];
	for (const w of [revising, waiting, sent]) codes.push(((await w.replies.confirm({ ref: "RAAAAAA" }, fromOwner("보내"))).body as { code: string }).code);
	codes.push(((await sent.replies.confirm({ ref: "RGONE00" }, fromOwner("보내"))).body as { code: string }).code);
	expect([codes, [revising, waiting, sent].map(w => w.reposts.length)]).toEqual([["revising", "already_sending", "already_sent", "unknown_ref"], [0, 0, 0]]);
});

test("confirm on a hand-written card posts it again as it is and tells its bot nothing", async () => {
	const w = world({ cards: [{ ref: "X9", conv: "ch:1", notice: "n9", title: "이 답글 올릴까요? (X9)", hash: "h9" }] });
	const r = await w.replies.confirm({ ref: "X9" }, fromOwner("보내"));
	expect([r.status, w.reposts, w.linesOf("bot")]).toEqual([200, [["X9", undefined, "h9"]], []]);
});

test("a drop or a revise the model read from the owner's words is his pick naming his message; the agent's own revise writes none", async () => {
	const d = world();
	expect((await d.replies.act({ ref: "RAAAAAA", action: "drop" }, fromOwner("보내지 마"))).status).toBe(200);
	const v = world();
	await v.replies.act({ ref: "RAAAAAA", action: "revise", change: "짧게" }, fromOwner("짧게", "m2"));
	const a = world();
	await a.replies.act({ ref: "RAAAAAA", action: "revise", change: "짧게" }, agent);
	await Promise.all([v.replies.idle(), a.replies.idle()]);
	expect([d.picks.map(p => [p.n, p.label, p.from?.mid]), d.calls.drop, v.picks.map(p => [p.n, p.note, p.from?.mid]), a.picks]).toEqual([[[3, "보내지 않기", "m1"]], 1, [[2, "짧게", "m2"]], []]);
});
