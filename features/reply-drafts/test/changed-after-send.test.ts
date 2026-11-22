// qa-clean-3 H1 replayed on the real gates: the owner presses 보내기 on v1, a session rewrites the draft inside the undo window, the gateway's
// queue refuses `changed`, and then an agent runs `draft.ts send` itself. The CLI must send nothing, in the window and after it, even once the
// text is put back to v1; only a new 보내기 on the version shown now sends.
import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { appendSealed } from "../../../hub/approval-seal.ts";
import { createApprovalSender, type SendJob, type SendResult } from "../../../hub/approval-send.ts";
import { DRAFT_UNDO, SEND_GATE, SPENT_REFUSED, WAITING_REFUSED } from "../../../hub/draft-approval.ts";
import { reasonOf } from "../../../hub/reply-reasons.ts";
import { clock } from "../../../hub/runtime/test-clock.ts";
import { runDraft } from "../bin/draft.ts";
import { paths } from "../lib/settings.ts";
import { addDraft, claimFile, getDraft, patchDraft } from "../lib/store.ts";
import { mailHash } from "../lib/view.ts";
import { enable, setupEnv } from "./helpers.ts";

const env = setupEnv();
enable(env);
afterAll(env.cleanup);

const ID = "RRACE01";
const TITLE = `이 답장 보낼까요? (${ID})`;
const V1 = "First version the owner read.";
const V2 = "Second version written by a session after the press.";
// A sealed answer as the gateway writes it: hub/reply-wire.ts recordPick (a 보내기 with its hash) and revokeSend (보내기 취소), each after the last.
let answered = Date.now();
const seal = (label: string, hash?: string, until?: number, title = TITLE) => appendSealed(paths.inbox(), { ts: new Date((answered += 1000)).toISOString(), kind: "message", source: "web", channel: "mail:k-race", author: "owner", text: label, picks: [{ q: title, n: label === DRAFT_UNDO ? 0 : 1, label, ...(hash ? { hash } : {}), ...(until !== undefined ? { until } : {}) }] });
// The sender's marks as hub/reply-wire.ts markSend writes them.
const markSeal = (j: SendJob, mark: "spent" | "go") => appendSealed(paths.inbox(), { ts: new Date((answered += 1000)).toISOString(), kind: SEND_GATE, source: "gateway", text: "", ref: j.ref, mark, ...(mark === "go" ? { id: `go-${answered}`, action: j.action, hash: j.hash } : {}) });

test("H1: a 보내기 on v1 never lets the CLI send v2, before or after the gateway refuses it `changed`; a new 보내기 on v2 sends v2 once", async () => {
	addDraft({ id: ID, kind: "mail", app: "mail", source: "zele", mailId: "m-race", ref: "k-race", to: "kim@example.com", subject: "Re: 일정", body: V1, status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { text: "hi", from: "Kim <kim@example.com>" } } as never);
	const sent: string[] = [];
	const deps = { send: async (rec: { body: string }) => (sent.push(rec.body), { ok: true as const, message: "sent (fake)" }), hub: { post: async () => ({ status: 200 }) } };
	const cli = () => runDraft(["send", ID], "", deps as never);

	// 1. The owner's 보내기 on v1: the pick and the queued job carry v1's hash; the job waits out the undo window.
	const v1 = mailHash(getDraft(ID)!);
	seal("보내기", v1);
	let clock = Date.now();
	const timers: (() => void)[] = [];
	const ended: SendResult[] = [];
	const ran: string[][] = [];
	const sender = createApprovalSender({
		kind: () => ({ kind: "mail", lane: "mail:zele" }),
		fingerprint: async ref => (d => d && mailHash(d))(getDraft(ref)),
		run: async argv => (ran.push(argv), { code: 0, out: "" }),
		undoMs: () => 10_000,
		after: (_ms, fn) => void timers.push(fn),
		now: () => clock,
		revoke: () => seal(DRAFT_UNDO),
		report: r => void ended.push(r),
		log: () => undefined,
	});
	expect(sender.enqueue({ ref: ID, conv: "mail:k-race", action: "send", title: TITLE, hash: v1, by: "owner" })).toBe(true);

	// 2. Inside the window a session writes v2 to the store. A CLI run now is refused by the version check alone.
	patchDraft(ID, { body: V2 });
	const early = await cli();
	expect([early.code, early.lines[0]]).toEqual([1, reasonOf("changed").text]);

	// 3. The window ends: the queue's gate refuses `changed`, runs nothing and takes the pick back.
	clock += 10_001;
	for (const fn of timers.splice(0)) fn();
	await sender.idle();
	expect([ended.at(-1)?.state, ended.at(-1)?.reason?.code, ran]).toEqual(["failed", "changed", []]);

	// 4. The agent runs the CLI afterwards (QA's reproduction): refused, nothing sent, the draft still waits.
	expect((await cli()).code).toBe(1);
	// Even with the text put back to v1, the taken-back pick sends nothing.
	patchDraft(ID, { body: V1 });
	expect((await cli()).code).toBe(1);
	expect([sent, getDraft(ID)?.status]).toEqual([[], "pending"]);

	// 5. The owner reads v2 and presses 보내기 on it: that version goes out, once.
	patchDraft(ID, { body: V2 });
	seal("보내기", mailHash(getDraft(ID)!));
	expect((await cli()).code).toBe(0);
	expect([sent, getDraft(ID)?.status]).toEqual([[V2], "sent"]);
});

// qa-clean-7 N13 on the real gate: the owner's sealed 보내기 carries the end of its undo window; the CLI an agent runs (what `bun --cwd … draft send`
// runs) is refused `waiting` until the gateway's own sender seals `go` right before its run, and after 되돌리기; that run sends once. A run that
// failed spends the pick: the agent's CLI cannot re-send on it; only the owner's 다시 보내기 (a new pick) sends. qa-clean-8: the gateway down across
// the window's end lets no CLI send, and a run killed mid-send leaves no `go` a `--retry` takeover can use. `boot` is a gateway (re)start on the same
// job file. The clock is the test preload's fake one (hub/runtime/test-clock.ts).
function world(id: string, o: { failFirst?: true; hang?: true } = {}) {
	const title = `이 답장 보낼까요? (${id})`;
	addDraft({ id, kind: "mail", app: "mail", source: "zele", mailId: `m-${id}`, ref: `k-${id}`, to: "kim@example.com", subject: "Re: 일정", body: V1, status: "pending", created: new Date(Date.now() - 60_000).toISOString(), changes: [], questions: [], item: { text: "hi", from: "Kim <kim@example.com>" } } as never);
	const sent: string[] = [];
	let failing = o.failFirst === true;
	let hang = o.hang === true;
	let tries = 0;
	// `started`: the transport was reached (a hanging one never answers: the gateway is killed while it runs).
	let reached: () => void = () => undefined;
	const started = new Promise<void>(r => void (reached = r));
	const deps = {
		send: async (rec: { body: string }) => {
			tries++;
			reached();
			if (hang) return new Promise<never>(() => undefined);
			if (failing) return (failing = false), { ok: false as const, message: "smtp 550", sent: "no" as const, code: "not_approved" as const };
			return sent.push(rec.body), { ok: true as const, message: "sent (fake)" };
		},
		hub: { post: async () => ({ status: 200 }) },
	};
	const cli = (...more: string[]) => runDraft(["send", id, ...more], "", deps as never);
	const timers: (() => void)[] = [];
	const ended: SendResult[] = [];
	let file = "[]";
	const store = { load: () => JSON.parse(file) as unknown[], save: (body: string) => void (file = body) };
	// The gateway's sender runs the same CLI in-process; a refusal or failure is told the way the CLI tells it (DOTZ_SEND, surely not sent).
	const boot = () =>
		createApprovalSender({
			kind: () => ({ kind: "mail", lane: `mail:${id}` }),
			fingerprint: async ref => (d => d && mailHash(d))(getDraft(ref)),
			run: async argv => {
				const r = await runDraft(argv.slice(2), "", deps as never);
				return r.code === 0 ? { code: 0, out: "" } : { code: 1, out: `DOTZ_SEND ${JSON.stringify({ sent: "no", code: "not_approved" })}` };
			},
			undoMs: () => 10_000,
			after: (_ms, fn) => void timers.push(fn),
			revoke: () => seal(DRAFT_UNDO, undefined, undefined, title),
			mark: markSeal,
			report: r => void ended.push(r),
			log: () => undefined,
			store,
		});
	const w = {
		sent, cli, ended, started,
		tries: () => tries,
		unhang: () => void (hang = false),
		sender: boot(),
		/** The gateway stops (its timers die with it) and starts again on the same job file. */
		restart: () => {
			timers.length = 0;
			w.sender = boot();
			w.sender.recover();
		},
		// The owner's 보내기 as hub/reply-actions.ts sendPicked writes it: the pick with the hash and the window's end the sender hands over.
		press: (j: Partial<SendJob> = {}) => w.sender.enqueue({ ref: id, conv: `mail:k-${id}`, action: "send", title, hash: mailHash(getDraft(id)!), by: "owner", ...j }, until => seal("보내기", mailHash(getDraft(id)!), until, title)),
		windowEnds: async (o: { wait?: false } = {}) => {
			clock.now += 10_000;
			for (const fn of timers.splice(0)) fn();
			if (o.wait !== false) await w.sender.idle();
		},
	};
	return w;
}

test("N13: inside the undo window the CLI is refused `waiting`, after 되돌리기 it is refused, and at the window's end the gateway sends once", async () => {
	const w = world("RWAIT01");
	expect(w.press()).toBe(true);
	const early = await w.cli();
	expect([early.code, early.lines[0], w.sent]).toEqual([1, WAITING_REFUSED, []]);

	// 되돌리기: nothing went out, so it holds; the CLI is still refused, also once the window would have ended.
	expect(w.sender.cancel("RWAIT01")).toBe("cancelled");
	expect((await w.cli()).code).toBe(1);
	clock.now += 10_001;
	expect((await w.cli()).code).toBe(1);
	expect([w.sent, getDraft("RWAIT01")?.status]).toEqual([[], "pending"]);

	// A new 보내기: refused `waiting` again inside its own window; at its end the gateway's own run sends it, once.
	expect(w.press()).toBe(true);
	expect((await w.cli()).lines[0]).toBe(WAITING_REFUSED);
	await w.windowEnds();
	expect([w.ended.at(-1)?.state, w.sent, getDraft("RWAIT01")?.status]).toEqual(["sent", [V1], "sent"]);
	expect((await w.cli()).code).toBe(1);
	expect(w.sent).toEqual([V1]);
});

test("N13: a run that failed spends its 보내기: the CLI cannot re-send on it, and only the owner's 다시 보내기 sends, once", async () => {
	const w = world("RSPENT1", { failFirst: true });
	expect(w.press()).toBe(true);
	await w.windowEnds();
	expect([w.ended.at(-1)?.state, w.sent]).toEqual(["failed", []]);

	const again = await w.cli();
	expect([again.code, again.lines[0], w.sent, getDraft("RSPENT1")?.status]).toEqual([1, SPENT_REFUSED, [], "pending"]);

	// 다시 보내기: a new pick with no window, run by the gateway at once.
	expect(w.press({ retry: true })).toBe(true);
	await w.sender.idle();
	expect([w.ended.at(-1)?.state, w.sent, getDraft("RSPENT1")?.status]).toEqual(["sent", [V1], "sent"]);
});

test("N14: the gateway down across the window's end: the agent's CLI is refused `waiting`; the restart holds the job back as before, and the next 보내기 sends once", async () => {
	const w = world("RDOWN01");
	expect(w.press()).toBe(true);
	// The gateway stops inside the window; its timer never fires. The clock passes the window's end.
	clock.now += 10_001;
	const late = await w.cli();
	expect([late.code, late.lines[0], w.tries()]).toEqual([1, WAITING_REFUSED, 0]);

	w.restart();
	expect([w.ended.at(-1)?.state, (await w.cli()).code, w.sent, getDraft("RDOWN01")?.status]).toEqual(["back", 1, [], "pending"]);

	expect(w.press()).toBe(true);
	expect((await w.cli()).lines[0]).toBe(WAITING_REFUSED);
	await w.windowEnds();
	expect([w.ended.at(-1)?.state, w.sent, w.tries()]).toEqual(["sent", [V1], 1]);
});

test("N15: a gateway killed mid-send leaves no `go` an agent's `--retry` can use; after the restart only the owner's 다시 보내기 runs again", async () => {
	const w = world("RKILL01", { hang: true });
	expect(w.press()).toBe(true);
	await w.windowEnds({ wait: false });
	await w.started;
	// The gateway dies holding the claim: the claim names a process that has exited.
	const gone = Bun.spawn(["true"]);
	await gone.exited;
	writeFileSync(claimFile("RKILL01"), String(gone.pid));
	const takeover = await w.cli("--retry");
	expect([takeover.code, takeover.lines[0], (await w.cli()).code, w.tries()]).toEqual([1, SPENT_REFUSED, 1, 1]);

	// The restart finds the run unsure; the old `go` still sends nothing, and the owner's 다시 보내기 (force) is one new run.
	w.restart();
	w.unhang();
	expect([w.ended.at(-1)?.state, (await w.cli("--retry")).code, w.tries()]).toEqual(["unsure", 1, 1]);
	expect(w.press({ force: true })).toBe(true);
	await w.sender.idle();
	expect([w.ended.at(-1)?.state, w.sent, w.tries()]).toEqual(["sent", [V1], 2]);
});
