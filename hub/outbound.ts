// Outbound path of the hub: the owner's messages out (out, progress, alert), the send ledger, the prompt queue and the shared delivery state.
// Split out of main.ts; it owns the one instance of that state and the other hub modules import it.
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, log, now, paths, TZ, writeAtomic } from "./config.ts";
import * as discord from "./discord.ts";
import * as livestatus from "./livestatus.ts";
import { isNote, msg } from "./i18n.ts";
import { answeredIds, answeredSince, emit, emitDelivery, recentOwnerMessages } from "./events.ts";
import { outEvent } from "./projectchat.ts";
import { allowedRoots } from "./files.ts";
import { claimPrefix, LaneRuntimeMismatch, lanes, type LaneDelivery, turnHeader } from "./lanes.ts";
import { deliver as deliverToOrchestrator, orch, setAlertHandler, setAnswerHandlers, setTurnHeader, steer as steerOrchestrator } from "./orchestrator.ts";
import { createBgWork } from "./bgwork.ts";
import { createPrompts } from "./prompts.ts";
import { createSendLedger } from "./sendlog.ts";
import { createInflight } from "./inflight.ts";
import { inOrder, localize } from "./outlang.ts";
import { parseTone, stripHandoff } from "./tone.ts";
import { replyRef } from "./threads.ts";

// Prompt queue: see prompts.ts. Unanswered prompts are kept on disk, so a restart mid-turn replays them on boot.
const PENDING = join(DATA_DIR, "pending.json");
// Read before anything in this process delivers (and rewrites the file); replayed once the orchestrator starts.
let unanswered: { text: string; at?: number; target?: string; replyTo?: string }[] = [];
try {
	if (existsSync(PENDING)) unanswered = JSON.parse(readFileSync(PENDING, "utf8"));
} catch {}
// Messages the owner must get go through the send ledger: kept on disk until Discord accepts them, retried through
// network outages, sent again after a restart; an answer marks its message answered only once it was delivered.
const UNSENT = join(DATA_DIR, "unsent.json");
export const sends = createSendLedger({
	file: UNSENT,
	send: (target, text, ref, opts) => discord.send(target, text, ref, opts),
	retryable: discord.isRetryable,
	onDelivered: item => queue.markAnswered(item.answers),
	onGiveUp: (item, reason) => log(`send to ${item.target} dropped unsent: ${reason} (${item.text.slice(0, 80)})`),
	persist: items => writeAtomic(UNSENT, `${JSON.stringify(items, null, 2)}\n`),
	log,
});
export const send = (target: string, text: string, ref?: string) => sends.submit(target, text, ref);
export const queue = createPrompts({
	deliver: deliverToOrchestrator,
	steer: steerOrchestrator,
	working: () => orch.status === "working",
	note: (target, replyTo, text) => msg().newMessage(target, replyTo, text),
	isNote: text => isNote(text, "newMessageLead") || isNote(text, "waitedLead") || isNote(text, "laneReportLead"),
	post: (target, text, replyTo) => out(target, text, replyTo, { auto: true }),
	clearProgress: target => void discord.clearProgress(target),
	persist: open => writeAtomic(PENDING, `${JSON.stringify(open, null, 2)}\n`),
	log,
	answered: answeredIds(),
	pending: sends.pending,
	recent: recentOwnerMessages,
	answeredSince,
	covers: target => isLocal(target),
});
// The orchestrator's background task workers (what a `[later]` turn waits for), read from OmO's task store: /api/workers, /api/state `work`.
export const bgWork = createBgWork({ sessionFile: () => orch.sessionFile, deferred: queue.deferredOpen });
// `owner` marks the owner's own message (it leads with the what-runs-now line); schedules, watches and mail carry a target but are not.
export function deliver(text: string, reply?: { target: string; replyTo?: string; owner?: boolean }): void {
	if (reply) discord.typing(reply.target);
	queue.deliver(text, reply);
}

const isLocal = (target: string) => target === "web" || target === "terminal";
// The work channel a Discord thread hangs from: its sends show in that project's web chat (projectchat.ts outEvent).
const threadHome = (thread: string): string | undefined => {
	const parent = discord.channels.threads[thread]?.parent;
	return parent && discord.channels.work[parent] ? parent : undefined;
};
// The newest owner message per target (threads.ts replyRef: a thread answer carries a reply reference only when it is not to that one).
export const lastOwner = new Map<string, string>();
// Delivery state of owner messages (hub/events.ts emitDelivery): the owner events' ids per orchestrator target, until its answer.
export const awaiting = new Map<string, string[]>();
export const refOf = (e: Record<string, any>): string | undefined => e.mid ?? e.message_id ?? undefined;
export const newMid = () => randomUUID().slice(0, 8);
// Web has no message to edit: the receipt and progress line are one "out" note per conversation (the page keeps the newest).
const webNote = (target: string, text: string) => emit("outbox", { ts: now(), kind: "out", source: "gateway", target, text, update_key: "progress" });
export const receiptNote = (how: LaneDelivery): string | undefined =>
	how === "steered" ? "📨 받았어요. 하던 작업에 바로 넣었고, 답이 준비되면 여기로 올게요." : how === "held" ? "📨 받았어요. 사용량 한도가 풀리면 바로 전달할게요." : how === "resumed" ? "📨 받았어요. 멈춰 있던 세션을 다시 시작해서 전달했어요." : undefined;
// An owner message that could not reach its session: the failed state on the message and, in that chat, a gateway message with the way forward.
export function laneFailed(target: string, lane: string, ref: string | undefined, error: unknown, replyTo?: string): void {
	const reason = (error as Error).message;
	emitDelivery(target, ref, "failed", reason.slice(0, 200));
	log(`lane ${lane}: owner message not delivered: ${reason}`);
	// A session of another runtime: the refusal itself offers the handover (answer "인계" here).
	const text = error instanceof LaneRuntimeMismatch ? error.message : `세션 ${lane}을(를) 이어갈 수 없어요 (${reason}). 대화 채널에서 다시 맡겨 주세요. 이전 보고는 ${join(paths.lanes, lane, "report.md")}에 있어요.`;
	void out(target, text, replyTo, { source: "gateway" }).catch(e => log(`lane failure notice failed: ${e}`));
}
type OutJob = { target: string; text: string; replyTo?: string; extra: Record<string, unknown> };
const jobAnswers = (j: OutJob) => (j.extra.source === undefined || j.extra.source === "orchestrator" ? j.replyTo : undefined);
const emitOut = (j: OutJob, t: string) => emit("outbox", outEvent({ ts: now(), kind: "out", source: "orchestrator", target: j.target, text: t, reply_to: j.replyTo ?? null, ...j.extra }, threadHome));
// Everything after the text is final: the delivery states, then the web is done or the send ledger (kept on disk) takes over.
function handOver(j: OutJob, sent: string): Promise<{ delivered: boolean; reason?: string }> {
	// An answer (not a progress note, not a gateway notice) settles the owner messages waiting in this conversation.
	if ((j.extra.source === undefined || j.extra.source === "orchestrator") && !j.extra.update_key) for (const ref of awaiting.get(j.target)?.splice(0) ?? []) emitDelivery(j.target, ref, "answered");
	if (isLocal(j.target)) {
		queue.markAnswered(jobAnswers(j));
		return Promise.resolve({ delivered: true });
	}
	return sends.submit(j.target, sent, replyRef(j.target, j.replyTo, lastOwner.get(j.target)), jobAnswers(j));
}
// Posts still in the output-language rewrite: the restart gate waits for them, shutdown lands what is left with the original text.
export const replies = createInflight<OutJob>(j => {
	emitOut(j, j.text);
	void handOver(j, j.text).catch(e => log(`reply to ${j.target} failed at shutdown: ${e}`));
	log(`reply to ${j.target} landed untranslated at shutdown (${j.text.length} chars)`);
});
export async function out(target: string, text: string, replyTo?: string, extra: Record<string, unknown> = {}): Promise<{ delivered: boolean; reason?: string }> {
	// Gateway notices (rate-limit hold, command and limits replies) reply to a message without answering its request.
	const job: OutJob = { target, text: stripHandoff(text), replyTo, extra };
	let landed = false;
	replies.begin(job);
	let sent: string;
	try {
		sent = await inOrder(target, async () => {
			const t = await localize(job.text, target, typeof extra.source === "string" ? extra.source : "orchestrator");
			// False: shutdown already landed this post with the original text.
			landed = replies.end(job);
			if (landed) emitOut(job, t);
			return t;
		});
	} finally {
		replies.end(job);
	}
	if (!landed) return { delivered: true };
	return handOver(job, sent);
}

// While an owner message waits for its answer the owner sees 👀, typing and, for long work, one progress message edited in
// place (livestatus.ts). Nothing is sent before the answer is ready (owner 2026-10-20: "답변은 준비되고 해야해. 먼저하면
// 안됨"), so the gateway no longer steers the orchestrator into posting a note after 60 s.
export function expectReply(target: string): void {
	if (isLocal(target)) return;
	livestatus.begin(target, "orchestrator");
}

export function alert(text: string): void {
	emit("outbox", { ts: now(), kind: "out", source: "gateway", target: "alert", text });
	void send("alert", text).catch(e => log(`alert send failed: ${e}`));
}

export function rateLimitNotice(target: string, replyTo?: string): void {
	if (orch.status !== "rate-limited") return;
	const until = new Date(orch.rateLimitedUntil);
	const at = Number.isNaN(until.getTime()) ? "한도가 풀리면" : `${until.toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" })}쯤`;
	const text = orch.pauseKind === "owner" ? "지금 모델 제공자 결제/인증 문제로 멈춰 있어요. 해결되면 받은 메시지부터 이어서 처리할게요." : `지금 사용량 한도로 멈춰 있어요. ${at} 이어서 처리할게요.`;
	void out(target, text, replyTo, { source: "gateway" }).catch(() => undefined);
}

export async function progress(target: string, key: string, text: string, replyTo?: string): Promise<{ delivered: boolean; reason?: string; edited?: boolean }> {
	const sent = await inOrder(target, async () => {
		let t = await localize(stripHandoff(text), target, "orchestrator");
		// The label goes in after the status marker ([done] becomes the leading emoji) and after localize (a rewrite must not touch it).
		if (target === "worklog" && key.startsWith("lane:")) {
			const prefix = claimPrefix(key.slice(5));
			const rest = parseTone(t).text;
			if (prefix) t = `${t.slice(0, t.length - rest.length)}${prefix}${rest}`;
		}
		emit("outbox", outEvent({ ts: now(), kind: "out", source: "orchestrator", target, text: t, update_key: key }, threadHome));
		return t;
	});
	if (isLocal(target)) return { delivered: true };
	// One evolving status per asking channel: every progress key there edits the same message the gateway's live report
	// uses (worklog and alert keep their per-key entries, e.g. one per lane).
	return discord.progress(target, target === "worklog" || target === "alert" ? key : "progress", sent, replyTo);
}

export const fileRoots = () => allowedRoots([...lanes.values()].flatMap(l => [l.cwd, l.worktree?.path ?? ""]));

// Prompts that were delivered but never answered (the gateway stopped mid-turn) are delivered again on start.
// Returns how many prompts were replayed.
export function replayPending(): number {
	const open = unanswered;
	unanswered = [];
	return queue.replay(open, text => (isNote(text, "replayLead") ? text : `${msg().replay}\n${text}`));
}

// Registrations main.ts makes at the same point of its start (kept out of import time).
export function installDelivery(): void {
	livestatus.setWebProgress(webNote);
	// The final answer of a turn goes to every channel that asked and did not already get a dotz_send reply.
	setAnswerHandlers(queue.onPrompt, queue.onAnswer, queue.onText);
	setTurnHeader(turnHeader);
	setAlertHandler(alert);
}
