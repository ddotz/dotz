// The gateway sends an approved draft itself (owner 2026-10-31, from a user's log of 2026-10-31: 28 comment replies + mails, and after each
// 보내기 the next card came only after a whole model turn sent, re-checked and wrote it, 1-2 minutes per item). When the owner picks
// 1) 보내기 (or 답글만 / 메일만 보내기) on a card whose ref is a draft the gateway knows, the pick is recorded in the inbox as usual (the CLIs' own
// approval check, hub/draft-approval.ts draftVerdict, reads it there), no model turn starts, the queue shows the next card at once, and the
// send runs here in the background through the same CLI the bot would run (its gate and its claim, hub/draft-claim.ts, still guard every
// send). Sends to one place (a comment site, a mail account) go one at a time in the order approved; different places run side by side.
// A failure stops nothing else; it is reported once.
//
// Restarts (owner rule: a restart never sends twice, a failure is always seen): the queued and sending jobs are kept in one small file (`store`) on every
// state change. On boot a job still `queued` is queued again (the owner's pick is in the inbox and the CLI's gate checks it). A job that was `sending` is never run
// again by itself: `look` tells whether its draft is sent (then it is marked sent), its sender still runs (it is checked again later), or neither (it ends failed
// with a text that says the mail may have gone out; only the owner's 다시 보내기 sends it again).
//
// Refs the gateway does not know (a card the bot wrote by hand, a KakaoTalk draft, a 직접 입력 pick) still go to the bot as before.
import { join } from "node:path";
import { draftActionOf } from "./draft-approval.ts";

export type SendKind = "comment" | "mail";
/** What the gateway knows of a ref: which CLI sends it, and the place it goes to (sends to one place stay in order). */
export type SendTarget = { kind: SendKind; lane: string };
export type SendAction = "send" | "send-main" | "send-mail" | "send-as-is";
/** `retry`: the owner pressed 다시 보내기 (the mail CLI then takes over a claim a dead sender left, features/reply-drafts/lib/flow.ts sendDraft). */
export type SendJob = { ref: string; conv: string; action: SendAction; title: string; retry?: true };
/** What is known of a job that was sending when the gateway stopped. */
export type SendLook = { state: "sent" } | { state: "alive" } | { state: "failed"; text: string };
type Kept = SendJob & { state: "queued" | "sending" };
export type SendResult = { ref: string; conv: string; title: string; state: "queued" | "sending" | "sent" | "failed"; text: string; at: number };

const ROOT = join(import.meta.dir, "..");

/** The send action a picked label asks the gateway for, or undefined when the bot has to read it (고치기, 보내지 않기, 직접 입력). */
export function sendActionOf(label: string): SendAction | undefined {
	const a = draftActionOf(label);
	return a === "send" || a === "send-main" || a === "send-mail" || a === "send-as-is" ? a : undefined;
}

/** The ref in a decision question's trailing "(<ref>)". */
export const refOfQuestion = (q: string): string | undefined => /\(([A-Za-z0-9][A-Za-z0-9_.:-]{1,63})\)\s*$/.exec(q)?.[1];

/** The command that sends draft `ref` (a comment reply draft, a mail draft of features/reply-drafts), or undefined. */
export function sendArgv(kind: SendKind, ref: string, action: SendAction, bun = process.execPath, retry = false): string[] | undefined {
	if (kind === "comment") return [bun, join(ROOT, "features/comments/bin/comments.ts"), "send", ref, ...(action === "send-main" ? ["--only", "reply"] : action === "send-mail" ? ["--only", "mail"] : action === "send-as-is" ? ["--as-is"] : [])];
	// A mail draft has one body; 답글만 / 메일만 belong to a comment card. Both 보내기 and 이대로 보내기 run the same send: it reads the owner's pick.
	return action === "send" || action === "send-as-is" ? [bun, join(ROOT, "features/reply-drafts/bin/draft.ts"), "send", ref, ...(retry ? ["--retry"] : [])] : undefined;
}

export type SenderDeps = {
	/** Which store knows `ref` (undefined = the gateway cannot send it). */
	kind: (ref: string) => SendTarget | undefined;
	run: (argv: string[]) => Promise<{ code: number; out: string }>;
	/** The state of one job changed (marks the card; a failure is reported once by the caller). */
	report: (r: SendResult) => void;
	log: (line: string) => void;
	now?: () => number;
	/** Where the queued and sending jobs are kept between runs (a JSON array); without it a restart forgets them. */
	store?: { load: () => unknown[]; save: (body: string) => void };
	/** Judges a job that was sending when the gateway stopped (default: it may have gone out). */
	look?: (j: SendJob) => SendLook;
};

export const MAY_HAVE_GONE_OUT = "게이트웨이가 멈추면서 보내던 중이었어요. 이미 나갔을 수 있으니 보낸 것을 확인한 뒤, 안 나갔을 때만 다시 보내기를 눌러 주세요";

const KEEP = 200;

export function createApprovalSender(deps: SenderDeps) {
	const now = deps.now ?? Date.now;
	// One queue per place; a place's runner exists while it has work.
	const lanes = new Map<string, { jobs: (SendJob & { kind: SendKind })[]; run: Promise<void> }>();
	const results = new Map<string, SendResult>();
	// The jobs that are queued or sending now: what the file keeps. `saved` is the file's body, so a change that leaves it as it is writes nothing.
	const kept = new Map<string, Kept>();
	let saved = "[]";
	const persist = () => {
		if (!deps.store) return;
		const body = JSON.stringify([...kept.values()]);
		if (body === saved) return;
		try {
			deps.store.save(body);
			saved = body;
		} catch (e) {
			deps.log(`approved sends: the job file was not written: ${(e as Error).message}`);
		}
	};
	// Jobs left sending by an earlier run whose sender may still be running: checked again by `recheck`.
	const orphans = new Map<string, SendJob>();
	const set = (j: SendJob, state: SendResult["state"], text = "") => {
		if (state === "queued" || state === "sending") kept.set(j.ref, { ref: j.ref, conv: j.conv, action: j.action, title: j.title, ...(j.retry ? { retry: true as const } : {}), state });
		else kept.delete(j.ref);
		persist();
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
			const argv = sendArgv(j.kind, j.ref, j.action, process.execPath, j.retry === true)!;
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

	const look = (j: SendJob): SendLook => deps.look?.(j) ?? { state: "failed", text: MAY_HAVE_GONE_OUT };
	function settleLeft(j: SendJob): void {
		const l = look(j);
		if (l.state === "alive") {
			orphans.set(j.ref, j);
			set(j, "sending");
		} else {
			orphans.delete(j.ref);
			set(j, l.state === "sent" ? "sent" : "failed", l.state === "sent" ? "" : l.text);
		}
	}
	let recovered = false;

	return {
		can,
		enqueue,
		/** Once, on boot: takes up the jobs the file kept (see the top of this file). */
		recover: () => {
			if (recovered || !deps.store) return;
			recovered = true;
			let left: Kept[];
			try {
				left = deps.store.load().filter((x): x is Kept => !!x && typeof x === "object" && typeof (x as Kept).ref === "string" && typeof (x as Kept).conv === "string" && typeof (x as Kept).title === "string" && ["send", "send-main", "send-mail", "send-as-is"].includes((x as Kept).action) && ((x as Kept).state === "queued" || (x as Kept).state === "sending"));
			} catch (e) {
				deps.log(`approved sends: the job file is unreadable: ${(e as Error).message}`);
				return;
			}
			// All of them stay in the file until each is settled, so a stop in the middle of this loop loses none.
			for (const k of left) kept.set(k.ref, k);
			saved = JSON.stringify(left);
			for (const { state, ...j } of left) {
				if (state === "sending") settleLeft(j);
				else if (look(j).state === "sent") set(j, "sent");
				else if (!enqueue(j)) set(j, "failed", "보내기로 한 초안을 더 이상 보낼 수 없어요. 이미 처리됐는지 확인해 주세요");
			}
		},
		/** Checks again the jobs a boot found still running. */
		recheck: () => {
			for (const j of [...orphans.values()]) settleLeft(j);
		},
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
	const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, DOTZ_GATEWAY_SEND: "1" } });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out: `${out}\n${err}`.slice(-4000) };
}
