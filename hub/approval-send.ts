// The gateway sends an approved draft itself (owner 2026-10-31, from a user's log of 2026-10-31: 28 comment replies + mails, and after each
// 보내기 the next card came only after a whole model turn sent, re-checked and wrote it, 1-2 minutes per item). When the owner picks
// 1) 보내기 (or 답글만 / 메일만 보내기) on a card whose ref is a draft the gateway knows, the pick is recorded in the inbox as usual (the CLIs' own
// approval check, hub/draft-approval.ts draftVerdict, reads it there), no model turn starts, the queue shows the next card at once, and the
// send runs here in the background through the same CLI the bot would run (its gate and its claim, hub/draft-claim.ts, still guard every
// send). Sends to one place (a comment site, a mail account) go one at a time in the order approved; different places run side by side.
// A failure stops nothing else; it is reported once.
//
// Refs the gateway does not know (a card the bot wrote by hand, a KakaoTalk draft, a 직접 입력 pick) still go to the bot as before.
import { join } from "node:path";
import { draftActionOf } from "./draft-approval.ts";

export type SendKind = "comment" | "mail";
/** What the gateway knows of a ref: which CLI sends it, and the place it goes to (sends to one place stay in order). */
export type SendTarget = { kind: SendKind; lane: string };
export type SendAction = "send" | "send-main" | "send-mail";
export type SendJob = { ref: string; conv: string; action: SendAction; title: string };
export type SendResult = { ref: string; conv: string; title: string; state: "queued" | "sending" | "sent" | "failed"; text: string; at: number };

const ROOT = join(import.meta.dir, "..");

/** The send action a picked label asks the gateway for, or undefined when the bot has to read it (고치기, 보내지 않기, 직접 입력). */
export function sendActionOf(label: string): SendAction | undefined {
	const a = draftActionOf(label);
	return a === "send" || a === "send-main" || a === "send-mail" ? a : undefined;
}

/** The ref in a decision question's trailing "(<ref>)". */
export const refOfQuestion = (q: string): string | undefined => /\(([A-Za-z0-9][A-Za-z0-9_.:-]{1,63})\)\s*$/.exec(q)?.[1];

/** The command that sends draft `ref` (a comment reply draft, a mail draft of features/reply-drafts), or undefined. */
export function sendArgv(kind: SendKind, ref: string, action: SendAction, bun = process.execPath): string[] | undefined {
	if (kind === "comment") return [bun, join(ROOT, "features/comments/bin/comments.ts"), "send", ref, ...(action === "send-main" ? ["--only", "reply"] : action === "send-mail" ? ["--only", "mail"] : [])];
	// A mail draft has one body; 답글만 / 메일만 belong to a comment card.
	return action === "send" ? [bun, join(ROOT, "features/reply-drafts/bin/draft.ts"), "send", ref] : undefined;
}

export type SenderDeps = {
	/** Which store knows `ref` (undefined = the gateway cannot send it). */
	kind: (ref: string) => SendTarget | undefined;
	run: (argv: string[]) => Promise<{ code: number; out: string }>;
	/** The state of one job changed (marks the card; a failure is reported once by the caller). */
	report: (r: SendResult) => void;
	log: (line: string) => void;
	now?: () => number;
};

const KEEP = 200;

export function createApprovalSender(deps: SenderDeps) {
	const now = deps.now ?? Date.now;
	// One queue per place; a place's runner exists while it has work.
	const lanes = new Map<string, { jobs: (SendJob & { kind: SendKind })[]; run: Promise<void> }>();
	const results = new Map<string, SendResult>();
	const set = (j: SendJob, state: SendResult["state"], text = "") => {
		const r: SendResult = { ref: j.ref, conv: j.conv, title: j.title, state, text, at: now() };
		results.delete(j.ref);
		results.set(j.ref, r);
		if (results.size > KEEP) results.delete(results.keys().next().value!);
		deps.report(r);
	};

	/** Can the gateway send this pick itself? */
	const can = (ref: string, action: SendAction | undefined): boolean => {
		const t = action ? deps.kind(ref) : undefined;
		return !!t && !!sendArgv(t.kind, ref, action!);
	};

	/** Queues one approved send; false when the gateway cannot send it or the same draft is already queued, sending or sent. */
	function enqueue(j: SendJob): boolean {
		const t = deps.kind(j.ref);
		if (!t || !sendArgv(t.kind, j.ref, j.action)) return false;
		const st = results.get(j.ref)?.state;
		if (st === "queued" || st === "sending" || st === "sent") {
			deps.log(`approved send ${j.ref} in ${j.conv} is already ${st}; the second approval sends nothing`);
			return true;
		}
		set(j, "queued");
		const lane = lanes.get(t.lane);
		if (lane) lane.jobs.push({ ...j, kind: t.kind });
		else {
			const l = { jobs: [{ ...j, kind: t.kind }], run: Promise.resolve() };
			lanes.set(t.lane, l);
			l.run = drain(t.lane, l.jobs);
		}
		return true;
	}

	// The lane is dropped in the same tick its last job is taken, so a job queued later always starts a new runner.
	async function drain(key: string, jobs: (SendJob & { kind: SendKind })[]): Promise<void> {
		for (let j = jobs.shift(); j; j = jobs.shift() ?? (lanes.delete(key), undefined)) {
			const argv = sendArgv(j.kind, j.ref, j.action)!;
			set(j, "sending");
			let r: { code: number; out: string };
			try {
				r = await deps.run(argv);
			} catch (e) {
				r = { code: 1, out: (e as Error).message };
			}
			const line = r.out.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
			deps.log(`approved send ${j.ref} in ${j.conv}: exit ${r.code}${line ? ` (${line.slice(0, 200)})` : ""}`);
			set(j, r.code === 0 ? "sent" : "failed", line.slice(0, 500));
		}
	}

	return {
		can,
		enqueue,
		/** The latest state of each recent job (in `conv`, or everywhere), oldest first. */
		results: (conv?: string) => [...results.values()].filter(r => conv === undefined || r.conv === conv),
		/** Resolves when every queued send is done (tests, shutdown). */
		idle: async () => {
			while (lanes.size) await Promise.all([...lanes.values()].map(l => l.run));
		},
	};
}

/** Runs one CLI with the gateway's environment; stdout and stderr together, bounded. */
export async function runCli(argv: string[]): Promise<{ code: number; out: string }> {
	// `env` is passed on purpose: without it Bun hands the child the environment the process started with, not process.env as it is now
	// (the data folder a test or the gateway set at run time would be lost, and the CLI would read another install's drafts).
	const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env } });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out: `${out}\n${err}`.slice(-4000) };
}
