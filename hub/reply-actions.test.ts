// The one reply-action module against fake adapters and the real send queue (design 1.6, 3.1): one case per row of the action table.
import { expect, test } from "bun:test";
import { createApprovalSender, type SendJob } from "./approval-send.ts";
import { createReplyActions, type ActCtx, type ReplyDeps } from "./reply-actions.ts";
import { reasonOf } from "./reply-reasons.ts";
import type { DraftView, Lesson, ReplyAdapter } from "./reply-types.ts";

const owner: ActCtx = { surface: "web", login: "me" };
const agent: ActCtx = { surface: "cli", agent: true };

function world(o: { outcome?: string; reviseFails?: boolean; lesson?: string; editLint?: string[] } = {}) {
	const log: string[] = [];
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
			if (o.reviseFails) return { ok: false, reason: reasonOf("revise_failed") };
			drafts.set("RBBBBBB", { ...view("RBBBBBB", "목요일까지 보내드릴게요."), draft: { ...view("RBBBBBB", "목요일까지 보내드릴게요.").draft, replaces: { ref, text: drafts.get(ref)!.draft.text } } });
			set(ref, { state: "stale" });
			log.push("stored RBBBBBB");
			const lesson: Lesson | undefined = o.lesson ? { key: { app: "mail" }, line: o.lesson } : undefined;
			return { ok: true, ref: "RBBBBBB", replaces: ref, ...(lesson ? { lesson } : {}) };
		},
		edit: async (ref, text) => {
			if (o.editLint) return { ok: false, reason: reasonOf("forbidden_word", { word: "무조건" }), lint: o.editLint };
			set(ref, { text, edited: true });
			return { ok: true };
		},
		drop: async ref => (set(ref, { state: "dropped" }), { ok: true }),
		restore: async ref => (set(ref, { state: "pending" }), { ok: true }),
		markSent: async ref => (set(ref, { state: "sent" }), { ok: true }),
		ask: async ref => `[ask] 카드 (${ref})`,
		question: ref => `이 답장 보낼까요? (${ref})`,
	};
	const ran: string[][] = [];
	const sender = createApprovalSender({
		kind: ref => (drafts.has(ref) ? { kind: "mail", lane: "mail:x" } : undefined),
		run: async argv => (ran.push(argv), { code: o.outcome ? 1 : 0, out: o.outcome ?? "보냈어요" }),
		report: r => void log.push(`send ${r.ref} ${r.state}`),
		log: () => undefined,
	});
	const deps: ReplyDeps = {
		adapters: [adapter],
		sender,
		recordPick: p => void log.push(`pick ${p.label}${p.note ? ` - ${p.note}` : ""}`),
		recordText: (_c, t) => void log.push(`text ${t}`),
		learning: { record: async (_k, line) => void log.push(`learn ${line}`), refine: async () => void log.push("refine") },
		cards: { open: () => [], replace: (a, b) => void log.push(`cards ${a}->${b}`), rewrite: ref => void log.push(`rewrite ${ref}`), close: ref => void log.push(`close ${ref}`) },
		toBot: async (conv, text) => void log.push(`bot ${conv} ${text}`),
		emit: e => void log.push(`event ${e.ref}${e.next ? `->${e.next}` : ""}${e.revising ? " revising" : ""}${e.why ? ` ${e.why}` : ""}`),
		log: () => undefined,
	};
	const replies = createReplyActions(deps);
	const only = (prefix: string) => log.filter(l => l.startsWith(prefix));
	return { replies, sender, log, ran, drafts, only };
}

test("send: the owner's pick is written before the send is queued, and a second send of the same draft sends nothing", async () => {
	const w = world();
	const r = await w.replies.act({ ref: "RAAAAAA", action: "send" }, owner);
	expect(r.status).toBe(200);
	expect(w.log.slice(0, 2)).toEqual(["pick 보내기", "send RAAAAAA queued"]);
	await w.sender.idle();
	expect(w.ran).toHaveLength(1);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send" }, owner)).body).toMatchObject({ ok: false, code: "already_sent" });
});

test("revise: 202 at once; the model runs, the new draft is stored, then the lesson is learned and refined, then the cards move and one event names the new ref", async () => {
	const w = world({ lesson: "마감은 넉넉히 잡아서 쓴다" });
	const r = await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "마감을 목요일로" }, owner);
	expect(r.status).toBe(202);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "또" }, owner)).body).toMatchObject({ code: "revising" });
	await w.replies.idle();
	expect(w.log).toEqual(["pick 고치기 - 마감을 목요일로", "event RAAAAAA revising", "model 마감을 목요일로", "stored RBBBBBB", "learn 마감은 넉넉히 잡아서 쓴다", "refine", "cards RAAAAAA->RBBBBBB", "event RAAAAAA->RBBBBBB"]);
});

test("a revise that fails leaves the old draft pending, learns nothing and says why on the card", async () => {
	const w = world({ reviseFails: true, lesson: "x" });
	await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, owner);
	await w.replies.idle();
	expect(w.drafts.get("RAAAAAA")!.draft.state).toBe("pending");
	expect(w.only("learn")).toEqual([]);
	expect(w.only("event").at(-1)).toBe("event RAAAAAA 고치지 못했어요 - 고친 초안을 만들지 못했어요");
});

test("edit: a 고치기 pick first, the text saved as written, and edit-and-send writes a fresh 이대로 보내기 after it", async () => {
	const w = world();
	const r = await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "제가 쓴 그대로예요", send: true }, owner);
	expect(r.status).toBe(200);
	expect(w.drafts.get("RAAAAAA")!.draft.text).toBe("제가 쓴 그대로예요");
	expect(w.only("pick")).toEqual(["pick 고치기 - 직접 수정", "pick 이대로 보내기"]);
	await w.sender.idle();
	expect(w.ran[0]).toContain("RAAAAAA");
});

test("an edit the owner-text lint refuses answers 422 with the lines and sends nothing", async () => {
	const w = world({ editLint: ["쓰지 않기로 한 표현 '무조건'이(가) 있어요"] });
	const r = await w.replies.act({ ref: "RAAAAAA", action: "edit", text: "무조건 드릴게요", send: true }, owner);
	expect(r).toMatchObject({ status: 422, body: { ok: false, code: "forbidden_word", lint: ["쓰지 않기로 한 표현 '무조건'이(가) 있어요"] } });
	expect(w.ran).toEqual([]);
});

test("unsure: a second send answers needs_resolve; 나갔어요 closes it as sent; 다시 보내기 is the owner's force", async () => {
	const maybe = 'DOTZ_SEND {"sent":"maybe","code":"net_cut"}';
	const w = world({ outcome: maybe });
	await w.replies.act({ ref: "RAAAAAA", action: "send" }, owner);
	await w.sender.idle();
	expect((await w.replies.act({ ref: "RAAAAAA", action: "send" }, owner)).body).toMatchObject({ code: "needs_resolve" });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "drop" }, owner)).body).toMatchObject({ code: "needs_resolve" });
	const item = (await w.replies.list())[0]!;
	expect(item.send).toMatchObject({ state: "unsure", reason: { code: "net_cut" }, actions: ["resolve_sent", "open_channel", "resolve_retry"] });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "resolve", as: "retry" }, owner)).status).toBe(200);
	await w.sender.idle();
	expect(w.ran).toHaveLength(2);
	expect(w.ran[1]!.at(-1)).toBe("--retry");

	const v = world({ outcome: maybe });
	await v.replies.act({ ref: "RAAAAAA", action: "send" }, owner);
	await v.sender.idle();
	expect((await v.replies.act({ ref: "RAAAAAA", action: "resolve", as: "sent" }, owner)).status).toBe(200);
	expect(v.drafts.get("RAAAAAA")!.draft.state).toBe("sent");
	expect(v.only("text")).toEqual(["text 나갔어요"]);
	expect(v.ran).toHaveLength(1);
});

test("undo inside the window cancels the send; drop and restore move the draft and close the card", async () => {
	const w = world();
	const sender = createApprovalSender({ kind: () => ({ kind: "mail", lane: "m" }), run: async () => ({ code: 0, out: "" }), report: () => undefined, log: () => undefined, undoMs: () => 10_000, after: () => undefined });
	const replies = createReplyActions({ adapters: [], sender, recordPick: () => undefined, learning: { record: async () => undefined, refine: async () => undefined }, cards: { open: () => [], replace: () => undefined, rewrite: () => undefined, close: () => undefined }, toBot: async () => undefined, emit: () => undefined, log: () => undefined });
	expect((await replies.act({ ref: "RAAAAAA", action: "undo" }, owner)).status).toBe(404);
	const job: SendJob = { ref: "RAAAAAA", conv: "c", action: "send", title: "q (RAAAAAA)" };
	sender.enqueue(job);
	expect(sender.cancel("RAAAAAA")).toBe("cancelled");

	expect((await w.replies.act({ ref: "RAAAAAA", action: "drop" }, owner)).status).toBe(200);
	expect(w.only("pick")).toEqual(["pick 보내지 않기"]);
	expect(w.only("close")).toEqual(["close RAAAAAA"]);
	expect((await w.replies.act({ ref: "RAAAAAA", action: "restore" }, owner)).status).toBe(200);
	expect(w.drafts.get("RAAAAAA")!.draft.state).toBe("pending");
});

test("an agent caller may revise and run a send the owner picked, writes no pick, and gets 403 for everything else", async () => {
	const w = world();
	for (const action of ["edit", "drop", "resolve", "undo", "retry", "restore"]) expect((await w.replies.act({ ref: "RAAAAAA", action, text: "x" }, agent)).body).toMatchObject({ ok: false, code: "owner_only" });
	expect((await w.replies.act({ ref: "RAAAAAA", action: "revise", change: "더 짧게" }, agent)).status).toBe(202);
	await w.replies.idle();
	expect((await w.replies.act({ ref: "RBBBBBB", action: "send" }, agent)).status).toBe(200);
	await w.sender.idle();
	expect(w.only("pick")).toEqual([]);
});

test("a hand-written card goes to the bot as its numbered answer; a batch sends one message per conversation", async () => {
	const w = world();
	const cards = [{ ref: "X1", conv: "ch:1", notice: "n1", title: "이 답글 올릴까요? (X1)" }, { ref: "X2", conv: "ch:1", notice: "n2", title: "이 답글 올릴까요? (X2)" }];
	const log: string[] = [];
	const replies = createReplyActions({ adapters: [], sender: w.sender, recordPick: () => undefined, learning: { record: async () => undefined, refine: async () => undefined }, cards: { open: () => cards, replace: () => undefined, rewrite: () => undefined, close: () => undefined }, toBot: async (c, t) => void log.push(`${c}|${t}`), emit: () => undefined, log: () => undefined });
	const r = await replies.batch([{ ref: "X1", action: "send" }, { ref: "X2", action: "revise", change: "더 짧게" }, { ref: "NOPE", action: "send" }], owner);
	expect(r.body).toMatchObject({ results: [{ ref: "X1", ok: true }, { ref: "X2", ok: true }, { ref: "NOPE", ok: false, code: "unknown_ref" }] });
	expect(log).toEqual(["ch:1|결정 답: 이 답글 올릴까요? (X1) → 1) 보내기\n결정 답: 이 답글 올릴까요? (X2) → 2) 고치기 - 더 짧게"]);
});
