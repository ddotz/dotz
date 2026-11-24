import { expect, test } from "bun:test";
import { approvalHash, createApprovalSender, type SenderDeps } from "./approval-send.ts";
import { createReplyActions, type ActCtx, type OpenCard, type ReplyDeps } from "./reply-actions.ts";
import { replyRoute, sinceMidnight } from "./reply-route.ts";
import type { DraftView, ReplyAdapter, ReplyItem, SendOutcome } from "./reply-types.ts";

const owner: ActCtx = { surface: "web", login: "me" };
const REF = "KAAAA";
type World = { kind: "kakao" | "comment" | "mail"; outcome?: SendOutcome; cli?: { code: number; out: string }; afterRun?: (d: Map<string, DraftView>) => void; cards?: OpenCard[]; now?: () => number };

function world(w: World) {
	const drafts = new Map<string, DraftView>();
	const mk = (ref: string): DraftView => ({ item: `${w.kind}:${ref}`, ref, kind: w.kind, app: w.kind, label: w.kind, conv: `${w.kind}:room`, at: 0, can: { send: true, revise: true, edit: true, drop: true, restore: false }, draft: { state: "pending", toLabel: "x", to: "y", text: "안녕하세요" } });
	drafts.set(REF, mk(REF));
	const setState = (ref: string, state: DraftView["draft"]["state"], sent?: DraftView["sent"]) => {
		const d = drafts.get(ref)!, pending = state === "pending";
		drafts.set(ref, { ...d, can: { ...d.can, send: pending, revise: pending, edit: pending, drop: pending }, draft: { ...d.draft, state }, ...(sent ? { sent } : {}) });
	};
	const settles: number[] = [], argvs: string[][] = [];
	const adapter: ReplyAdapter = {
		kind: w.kind,
		get: async ref => drafts.get(ref),
		list: async () => [...drafts.values()].filter(d => d.draft.state === "pending" || (d.sent && sinceMidnight(d.sent.at, w.now?.()))),
		target: ref => (drafts.has(ref) ? { kind: w.kind, lane: `${w.kind}:x` } : undefined),
		...(w.outcome ? { run: async () => (w.afterRun?.(drafts), w.outcome!) } : {}),
		revise: async () => ({ ok: false, reason: { code: "revise_failed", text: "x" } }),
		edit: async () => ({ ok: true }),
		drop: async () => ({ ok: true }),
		restore: async () => ({ ok: true }),
		markSent: async ref => (setState(ref, "sent"), { ok: true }),
		prove: async () => "unknown",
		ask: async ref => `[ask] (${ref})`,
		question: ref => `보낼까요? (${ref})`,
	};
	const deps: SenderDeps = {
		kind: ref => (drafts.has(ref) ? { kind: w.kind, lane: `${w.kind}:x` } : undefined),
		fingerprint: async ref => (drafts.has(ref) ? approvalHash(drafts.get(ref)!) : undefined),
		run: async argv => (argvs.push(argv), w.afterRun?.(drafts), w.cli ?? { code: 0, out: "" }),
		runJob: j => (w.outcome && j.kind === "kakao" ? adapter.run!(j) : undefined),
		report: () => undefined,
		log: () => undefined,
		undoMs: () => 0,
		after: () => undefined,
		...(w.now ? { now: w.now } : {}),
	};
	const sender = createApprovalSender(deps);
	const replyDeps: ReplyDeps = {
		adapters: [adapter],
		sender,
		recordPick: () => undefined,
		recordText: () => undefined,
		learning: { record: async () => ({ kind: "correction" as const, stored: true, replaced: [] }), refine: async () => undefined, forbid: async () => undefined },
		cards: { open: () => w.cards ?? [], convOf: () => undefined, replace: () => undefined, rewrite: () => undefined, repost: async () => undefined, close: () => undefined },
		toBot: async () => undefined,
		emit: () => undefined,
		log: () => undefined,
		settle: () => void settles.push(1),
		...(w.now ? { now: w.now } : {}),
	};
	return { acts: createReplyActions(replyDeps), sender, drafts, setState, settles, argvs };
}
const sentNow = (d: Map<string, DraftView>) => d.set(REF, { ...d.get(REF)!, draft: { ...d.get(REF)!.draft, state: "sent" } });
const sentMailLeft = (d: Map<string, DraftView>) => d.set(REF, { ...d.get(REF)!, draft: { ...d.get(REF)!.draft, state: "sent" }, mailLeft: true });
const NOON = new Date(2026, 10, 19, 12).getTime();
const DAY = 86_400_000;
const row = async (acts: { list: () => Promise<ReplyItem[]> }, ref = REF) => (await acts.list()).find(i => i.ref === ref);

test("CS-1 a KakaoTalk send pressed but not seen in the room keeps its queue row, unsure, with 나갔어요 and 다시 보내기", async () => {
	const w = world({ kind: "kakao", outcome: { sent: "maybe", code: "press_unconfirmed" } });
	expect((await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner)).status).toBe(200);
	await w.sender.idle();
	const listed = await row(w.acts);
	expect(listed?.send?.state).toBe("unsure");
	expect(listed?.send?.actions).toEqual(expect.arrayContaining(["resolve_sent", "resolve_retry"]));
});

test("CS-1 a comment reply posted whose mail failed keeps its queue row with what failed, as state only: the mail is the row that can be sent again", async () => {
	const out = 'DOTZ_SEND {"sent":"yes"}\nDOTZ_SEND {"sent":"no","code":"rejected","detail":"smtp refused"}';
	const w = world({ kind: "comment", cli: { code: 1, out }, afterRun: sentMailLeft });
	await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
	await w.sender.idle();
	const listed = await row(w.acts);
	expect(["failed", "unsure"]).toContain(listed?.send?.state ?? "none");
	expect(listed?.send?.actions).toEqual([]);
	expect(listed?.why).toBeTruthy();
});

test("U4-4 a sent draft the queue has no record of (a restart) is a sent row from the store's time; a live record wins over it", async () => {
	const w = world({ kind: "mail", now: () => NOON });
	w.setState(REF, "sent", { at: NOON - 1000, how: "rule" });
	expect((await row(w.acts))?.send).toEqual({ state: "sent", at: NOON - 1000, how: "rule", today: true, actions: [] });
	const fresh = world({ kind: "mail", now: () => NOON, cli: { code: 0, out: 'DOTZ_SEND {"sent":"yes"}' }, afterRun: d => d.set(REF, { ...d.get(REF)!, draft: { ...d.get(REF)!.draft, state: "sent" }, sent: { at: 1, how: "owner" } }) });
	await fresh.acts.act({ ref: REF, action: "send", hash: approvalHash(fresh.drafts.get(REF)!) }, owner);
	await fresh.sender.idle();
	const live = fresh.sender.results().findLast(r => r.ref === REF)!;
	expect((await row(fresh.acts))?.send).toMatchObject({ state: "sent", at: live.at });
});

test("U4-6 보내기 typed in a chat on a sent draft the queue lists is refused already_sent and queues nothing", async () => {
	const w = world({ kind: "mail" });
	w.setState(REF, "sent", { at: Date.now(), how: "owner" });
	expect((await row(w.acts))?.draft.state).toBe("sent");
	const r = await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, { surface: "chat" });
	expect(r.status).toBe(409);
	expect(r.body).toMatchObject({ ok: false, code: "already_sent" });
	expect(w.sender.results()).toEqual([]);
});

test("CS-2 an open card of a sent or dropped draft is listed as that draft without 보내기, never as a hand-written card, and asks for one settle pass", async () => {
	for (const state of ["sent", "dropped"] as const) {
		const w = world({ kind: "mail", cards: [{ ref: REF, conv: "main", notice: "n1", title: `보낼까요? (${REF})` }] });
		w.setState(REF, state);
		const listed = await row(w.acts);
		expect(listed).toMatchObject({ kind: "mail", conv: "main", notice: "n1", draft: { state }, can: { send: false } });
		expect(w.settles).toHaveLength(1);
		expect((await w.acts.act({ ref: REF, action: "send", hash: listed!.draft.hash! }, owner)).body).toMatchObject({ ok: false, code: state === "sent" ? "already_sent" : "not_pending" });
	}
});

test("CS-2 an open card of a waiting draft asks for no settle pass; a card no adapter knows stays a hand-written card", async () => {
	const w = world({ kind: "mail", cards: [{ ref: REF, conv: "main", notice: "n1", title: `보낼까요? (${REF})` }, { ref: "HAND01", conv: "main", notice: "n2", title: "보낼까요? (HAND01)" }] });
	const all = await w.acts.list();
	expect(all.map(i => [i.ref, i.kind])).toEqual([[REF, "mail"], ["HAND01", "card"]]);
	expect(w.settles).toEqual([]);
});

const REJECTED = { code: 1, out: 'DOTZ_SEND {"sent":"no","code":"rejected","detail":"refused"}' };

test("a failed send whose draft was closed elsewhere (dropped or stale, not sent) is no 실패 row; the settle pass clears its record, not list", async () => {
	for (const state of ["dropped", "stale"] as const) {
		const w = world({ kind: "mail", cli: REJECTED });
		await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
		await w.sender.idle();
		expect((await row(w.acts))?.send?.state).toBe("failed");
		expect(w.settles).toEqual([]);
		w.setState(REF, state);
		expect(await w.acts.list()).toEqual([]);
		expect(w.settles).toHaveLength(1);
		expect(w.sender.results().map(r => r.state)).toEqual(["failed"]);
		expect(await w.acts.settleOwed()).toBe(1);
		expect(w.sender.results()).toEqual([]);
		expect(await w.acts.settleOwed()).toBe(0);
	}
});

test("a failed send of a draft that is still waiting stays a row and the settle pass leaves its record", async () => {
	const w = world({ kind: "mail", cli: REJECTED });
	await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
	await w.sender.idle();
	expect(await w.acts.settleOwed()).toBe(0);
	expect((await row(w.acts))?.send?.state).toBe("failed");
	expect(w.settles).toEqual([]);
});

test("a failed or unsure send of a draft that went out with no mail left is no row and cannot be retried or resolved again; the settle pass clears its record", async () => {
	for (const [cli, state, as] of [[REJECTED, "failed", undefined], [{ code: 1, out: 'DOTZ_SEND {"sent":"maybe","code":"unknown"}' }, "unsure", "retry"]] as const) {
		const w = world({ kind: "comment", cli, afterRun: sentNow });
		await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
		await w.sender.idle();
		expect(w.sender.results().map(r => r.state)).toEqual([state]);
		expect((await row(w.acts))?.send).toBeUndefined();
		expect(w.settles).toHaveLength(1);
		w.argvs.length = 0;
		const again = await w.acts.act({ ref: REF, action: state === "failed" ? "retry" : "resolve", ...(as ? { as } : {}), hash: approvalHash(w.drafts.get(REF)!) }, owner);
		expect(again.body).toMatchObject({ ok: false, code: "already_sent" });
		await w.sender.idle();
		expect(w.argvs).toEqual([]);
		expect(await w.acts.settleOwed()).toBe(1);
		expect(w.sender.results()).toEqual([]);
	}
});

test("a failed or unsure send of a comment reply whose mail is still owed stays a row with no buttons; the settle pass clears its record once the mail no longer waits", async () => {
	for (const [cli, state] of [[REJECTED, "failed"], [{ code: 1, out: 'DOTZ_SEND {"sent":"maybe","code":"unknown"}' }, "unsure"]] as const) {
		const w = world({ kind: "comment", cli, afterRun: sentMailLeft });
		await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
		await w.sender.idle();
		const listed = await row(w.acts);
		expect(listed?.send?.state).toBe(state);
		expect(listed?.send?.actions).toEqual([]);
		expect(await w.acts.settleOwed()).toBe(0);
		expect(w.settles).toEqual([]);
		const mailGone = { ...w.drafts.get(REF)! };
		delete mailGone.mailLeft;
		w.drafts.set(REF, mailGone);
		expect(await row(w.acts)).toBeUndefined();
		expect(w.settles).toHaveLength(1);
		expect(await w.acts.settleOwed()).toBe(1);
		expect(w.sender.results()).toEqual([]);
	}
});

test("CS-1 a comment reply posted whose mail still waits offers no 다시 보내기 on the reply's row, and pressing one posts nothing again", async () => {
	const w = world({ kind: "comment", cli: REJECTED, afterRun: sentMailLeft });
	await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
	await w.sender.idle();
	const listed = await row(w.acts);
	expect(listed?.send?.actions).toEqual([]);
	w.argvs.length = 0;
	const again = await w.acts.act({ ref: REF, action: "retry", hash: listed!.draft.hash! }, owner);
	expect([again.status, (again.body as { code?: string }).code]).toEqual([409, "already_sent"]);
	await w.sender.idle();
	expect(w.argvs).toEqual([]);
});

const SENT_UNSURE = { code: 1, out: 'DOTZ_SEND {"sent":"maybe","code":"unknown"}' };
const queue = async (acts: ReturnType<typeof world>["acts"]) => (await (await replyRoute(new Request("http://x/api/reply/queue"), new URL("http://x/api/reply/queue"), { replies: acts, login: "me" }))!.json()) as { items: ReplyItem[]; counts: Record<string, number> };

test("a failed or unsure send whose draft was answered by hand or dropped is no row and none of retry, resolve, drop, edit, revise, undo reaches the sender or succeeds", async () => {
	for (const [state, cli] of [["closed", REJECTED], ["dropped", REJECTED], ["closed", SENT_UNSURE], ["dropped", SENT_UNSURE]] as const) {
		const w = world({ kind: "mail", cli });
		await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
		await w.sender.idle();
		w.setState(REF, state);
		expect(await row(w.acts)).toBeUndefined();
		w.argvs.length = 0;
		for (const [action, extra] of [["retry", {}], ["resolve", { as: "retry" }], ["drop", {}], ["edit", { text: "x" }], ["revise", { change: "y" }], ["undo", {}]] as const) {
			const r = await w.acts.act({ ref: REF, action, hash: approvalHash(w.drafts.get(REF)!), ...extra }, owner);
			await w.sender.idle();
			expect([state, action, r.status]).toEqual([state, action, 409]);
		}
		expect(w.argvs).toEqual([]);
		const { counts } = await queue(w.acts);
		expect([counts.failed, counts.unsure]).toEqual([0, 0]);
	}
});

test("an unsure send whose draft went out by another path is no row and 다시 보내기 is refused", async () => {
	const w = world({ kind: "mail", cli: SENT_UNSURE });
	await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
	await w.sender.idle();
	w.setState(REF, "sent", { at: Date.now(), how: "owner" });
	expect((await row(w.acts))?.send).toMatchObject({ state: "sent", actions: [] });
	w.argvs.length = 0;
	const r = await w.acts.act({ ref: REF, action: "resolve", as: "retry", hash: approvalHash(w.drafts.get(REF)!) }, owner);
	await w.sender.idle();
	expect(r.status).toBe(409);
	expect(w.argvs).toEqual([]);
	expect((await queue(w.acts)).counts.unsure).toBe(0);
});

test("a send the sender already gave up on (gone) is forgotten in memory when its draft leaves pending, by the settle pass and not by list", async () => {
	const w = world({ kind: "mail", cli: { code: 1, out: 'DOTZ_SEND {"sent":"no","code":"gone"}' } });
	await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
	await w.sender.idle();
	expect((await queue(w.acts)).counts.failed).toBe(1);
	w.setState(REF, "closed");
	expect((await queue(w.acts)).counts.failed).toBe(0);
	expect(w.sender.results().map(r => r.state)).toEqual(["failed"]);
	expect(await w.acts.settleOwed()).toBe(1);
	expect(w.sender.results()).toEqual([]);
});

test("a send finished a moment after midnight is today by the one clock the list and the counts share, whichever of the store and the queue stamped it first", async () => {
	const M = new Date(2026, 10, 19).getTime();
	for (const [stored, finished, expected] of [[M - 300, M + 200, 1], [M + 1000, M - 100, 0]] as const) {
		let t = Math.min(stored, finished) - 100;
		const w = world({ kind: "mail", now: () => t, cli: { code: 0, out: 'DOTZ_SEND {"sent":"yes"}' }, afterRun: d => (d.set(REF, { ...d.get(REF)!, draft: { ...d.get(REF)!.draft, state: "sent" }, sent: { at: stored, how: "owner" } }), void (t = finished)) });
		await w.acts.act({ ref: REF, action: "send", hash: approvalHash(w.drafts.get(REF)!) }, owner);
		await w.sender.idle();
		t = M + 5000;
		const q = await queue(w.acts);
		expect(q.items.filter(i => i.send?.state === "sent")).toHaveLength(expected);
		expect(q.counts.sentToday).toBe(expected);
	}
});

test("the server says which sent rows are today, in the gateway's own time zone", async () => {
	const before = process.env.TZ;
	const at = Date.parse("2026-11-18T11:00:00Z"), now = Date.parse("2026-11-19T00:00:00Z");
	try {
		for (const [tz, today] of [["Asia/Seoul", false], ["America/Los_Angeles", true]] as const) {
			process.env.TZ = tz;
			const w = world({ kind: "mail", now: () => now });
			w.setState(REF, "sent", { at, how: "owner" });
			const q = await queue(w.acts);
			expect([tz, q.items.filter(i => i.send?.state === "sent" && i.send.today).length, q.counts.sentToday]).toEqual([tz, today ? 1 : 0, today ? 1 : 0]);
		}
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
});
