// Outbound path of the hub: the owner's messages out (out, progress, alert), the send ledger, the prompt queue and the shared delivery state.
// Split out of main.ts; it owns the one instance of that state and the other hub modules import it.
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, log, now, paths, TZ, writeAtomic } from "./config.ts";
import * as discord from "./discord.ts";
import * as livestatus from "./livestatus.ts";
import { isNote, msg } from "./i18n.ts";
import { asksPersonalInChat } from "./personal-ask.ts";
import { answeredIds, answeredSince, emit, emitDelivery, ownerMessage, recentOwnerMessages } from "./events.ts";
import { settleWaiting, type Waiting } from "./awaiting.ts";
import { outEvent } from "./projectchat.ts";
import { mailByThread, mailTarget } from "./mail.ts";
import { allowedRoots } from "./files.ts";
import { claimPrefix, LaneRuntimeMismatch, lanes, type LaneDelivery, turnHeader } from "./lanes.ts";
import { deliver as deliverToOrchestrator, orch, setAlertHandler, setAnswerHandlers, setTurnHeader, steer as steerOrchestrator } from "./orchestrator.ts";
import { createBgWork } from "./bgwork.ts";
import { createPrompts } from "./prompts.ts";
import { createSendLedger } from "./sendlog.ts";
import { createInflight } from "./inflight.ts";
import { inOrder, localize } from "./outlang.ts";
import { splitTone, stripHandoff } from "./tone.ts";
import { isLate, isSnowflake, lateQuote, lateRequestId, replyRef, snowflakeTime, withQuote } from "./threads.ts";
import { orchestratorAnswered } from "./notices.ts";
import { recheckAnswered } from "./watch-recheck.ts";
import { discordPosts } from "./discord-post.ts";
import { repeatAlert } from "./alert-gate.ts";

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
export const bgWork = createBgWork({ sessionFile: () => orch.sessionFile, deferred: queue.deferredOpen, turn: queue.turnAt });
// `owner` marks the owner's own message (it leads with the what-runs-now line); schedules, watches and mail carry a target but are not.
export function deliver(text: string, reply?: { target: string; replyTo?: string; owner?: boolean }): void {
	if (reply) discord.typing(reply.target);
	queue.deliver(text, reply);
}

// "web:alert" / "web:worklog": the answer to a question the owner asked in that web conversation (hub/intake.ts sendWeb).
// "mail:<key>": a mail with no Discord thread (hub/mail.ts) lives in the web only.
const isLocal = (target: string) => target === "web" || target === "terminal" || target === "web:alert" || target === "web:worklog" || target.startsWith("mail:") || target.startsWith("settings:");
// The work channel a Discord thread hangs from: its sends show in that project's web chat (projectchat.ts outEvent).
const threadHome = (thread: string): string | undefined => {
	const parent = discord.channels.threads[thread]?.parent;
	return parent && discord.channels.work[parent] ? parent : undefined;
};
const threadMail = (thread: string): string | undefined => {
	const m = mailByThread(thread);
	return m && mailTarget(m.key);
};
// The newest owner message per target (threads.ts replyRef: a thread answer carries a reply reference only when it is not to that one).
export const lastOwner = new Map<string, string>();
// Delivery state of owner messages (hub/events.ts emitDelivery): the owner events' ids per orchestrator target, until its answer.
export const awaiting = new Map<string, Waiting[]>();
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
// The web draws a bot message that replies to an owner message with that message quoted, as it does for the owner's own replies.
const replyQuote = (id?: string) => {
	const m = id ? ownerMessage(id) : undefined;
	return id && m?.text.trim() ? { reply: { id, author: m.author ?? "", content: m.text.trim().slice(0, 300) } } : {};
};
const emitOut = (j: OutJob, t: string) => emit("outbox", outEvent({ ts: now(), kind: "out", source: "orchestrator", target: j.target, text: t, reply_to: j.replyTo ?? null, ...replyQuote(j.replyTo), ...j.extra }, threadHome, threadMail));
const askedAtMs = (id: string): number | undefined => {
	if (isSnowflake(id)) return snowflakeTime(id);
	const at = Date.parse(ownerMessage(id)?.ts ?? "");
	return Number.isNaN(at) ? undefined : at;
};
const lateFor = (target: string, replyTo: string | undefined) => isLate(replyTo, lastOwner.get(target), replyTo ? askedAtMs(replyTo) : undefined);
const lateRequest = (target: string) => lateRequestId(target, queue.current(), queue.deferredOpen(), lastOwner.get(target), askedAtMs);
// Everything after the text is final: the delivery states, then the web is done or the send ledger (kept on disk) takes over.
function handOver(j: OutJob, sent: string): Promise<{ delivered: boolean; reason?: string }> {
	// An answer (not a progress note, not a gateway notice) settles the owner messages waiting in this conversation.
	if ((j.extra.source === undefined || j.extra.source === "orchestrator") && !j.extra.update_key) {
		const { done, keep } = settleWaiting(awaiting.get(j.target) ?? [], j.replyTo, isLocal(j.target));
		awaiting.set(j.target, keep);
		// One truth: a message shown as answered is answered for the prompt queue too (deferred wait, pending.json, restart replay).
		// An answer that names the last message of a burst (`by`) leaves the burst's other prompts open otherwise.
		for (const w of done) {
			emitDelivery(j.target, w.ref, "answered");
			queue.markAnswered(w.ref);
			queue.markAnswered(w.by);
		}
		recheckAnswered(j.target);
	}
	// Web only: a web conversation, a kind the owner switched off for Discord (hub/discord-post.ts), or a gateway alert that repeats one Discord already has.
	if (isLocal(j.target) || j.extra.repeat === true || !discordPosts(j.target, j.replyTo)) {
		queue.markAnswered(jobAnswers(j));
		return Promise.resolve({ delivered: true });
	}
	// Late: the owner wrote something newer meanwhile or the request is old. Discord shows it as a reply that pings him; a web
	// message has no Discord message to reference, so the request is quoted in the text instead.
	const answers = jobAnswers(j);
	const late = answers !== undefined && lateFor(j.target, answers);
	const original = late && answers && !isSnowflake(answers) ? ownerMessage(answers) : undefined;
	const text = original ? withQuote(sent, lateQuote(original, TZ)) : sent;
	return sends.submit(j.target, text, replyRef(j.target, j.replyTo, lastOwner.get(j.target), late), answers, late);
}
// Posts still in the output-language rewrite: the restart gate waits for them, shutdown lands what is left with the original text.
export const replies = createInflight<OutJob>(j => {
	emitOut(j, j.text);
	void handOver(j, j.text).catch(e => log(`reply to ${j.target} failed at shutdown: ${e}`));
	log(`reply to ${j.target} landed untranslated at shutdown (${j.text.length} chars)`);
});
export async function out(target: string, text: string, replyTo?: string, extra: Record<string, unknown> = {}): Promise<{ delivered: boolean; reason?: string }> {
	// Gateway notices (rate-limit hold, command and limits replies) reply to a message without answering its request.
	const answersOwner = extra.source === undefined || extra.source === "orchestrator";
	// A gateway post to the alert conversation (a failing watch) is gated like alert() below.
	if (target === "alert" && extra.source === "gateway" && !extra.update_key && repeatAlert(text)) extra = { ...extra, repeat: true };
	const job: OutJob = { target, text: stripHandoff(text), replyTo: replyTo ?? (answersOwner && !extra.update_key ? lateRequest(target) : undefined), extra };
	let landed = false;
	replies.begin(job);
	let sent: string;
	try {
		sent = await inOrder(target, async () => {
			const t = await localize(job.text, target, typeof extra.source === "string" ? extra.source : "orchestrator");
			if (asksPersonalInChat(t)) {
				log(`personal-data ask in chat to ${target}: the form (dotz_auth) is the only way to ask`);
				steerOrchestrator(msg().personalAskNote);
			}
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

// The same alert again (hub/alert-gate.ts) is marked on its event (the bell rewrites the first one, no push) and not posted to Discord again.
export function alert(text: string): void {
	const repeat = repeatAlert(text);
	emit("outbox", { ts: now(), kind: "out", source: "gateway", target: "alert", text, ...(repeat ? { repeat: true } : {}) });
	if (discordPosts("alert") && !repeat) void send("alert", text).catch(e => log(`alert send failed: ${e}`));
}

// Said once per conversation per pause (a pause is known by when it began being announced): the owner's 2nd and 3rd message
// in the same stoppage get no repeat of it (owner 2026-10-26: 멈춤 알림은 한 번만).
const pauseToldIn = new Set<string>();
let pauseToldFor = "";
export function rateLimitNotice(target: string, replyTo?: string): void {
	if (orch.status !== "rate-limited") {
		pauseToldIn.clear();
		pauseToldFor = "";
		return;
	}
	const episode = orch.pauseKind ?? "";
	if (episode !== pauseToldFor) {
		pauseToldIn.clear();
		pauseToldFor = episode;
	}
	if (pauseToldIn.has(target)) return;
	pauseToldIn.add(target);
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
			const { head, rest } = splitTone(t);
			if (prefix) t = `${head}${prefix}${rest}`;
		}
		emit("outbox", outEvent({ ts: now(), kind: "out", source: "orchestrator", target, text: t, update_key: key }, threadHome, threadMail));
		return t;
	});
	if (isLocal(target) || !discordPosts(target, replyTo)) return { delivered: true };
	// One evolving status per asking channel: every progress key there edits the same message the gateway's live report
	// uses (worklog and alert keep their per-key entries, e.g. one per lane).
	return discord.progress(target, target === "worklog" || target === "alert" ? key : "progress", sent, replyTo);
}

export const fileRoots = () => allowedRoots([...lanes.values()].flatMap(l => [l.cwd, l.worktree?.path ?? ""]));

// Prompts that were delivered but never answered (the gateway stopped mid-turn) are delivered again on start.
// Returns how many prompts were replayed.
const replayWrap = (text: string) => (isNote(text, "replayLead") ? text : `${msg().replay}\n${text}`);
export function replayPending(): number {
	const open = unanswered;
	unanswered = [];
	return queue.replay(open, replayWrap);
}

// After an orchestrator restart (orchestrator.ts): the prompts still open in this process go in again, once, oldest first.
export const replayOpen = () => queue.reopen(replayWrap);

// Registrations main.ts makes at the same point of its start (kept out of import time).
export function installDelivery(): void {
	livestatus.setWebProgress(webNote);
	// The final answer of a turn goes to every channel that asked and did not already get a dotz_send reply.
	setAnswerHandlers(
		queue.onPrompt,
		text => {
			// The request this answer is for: only a [done] / [fail] to the same request can close an earlier question about it (notices.ts).
			orchestratorAnswered(text, queue.current()?.replyTo);
			queue.onAnswer(text);
		},
		queue.onText,
	);
	setTurnHeader(turnHeader);
	setAlertHandler(alert);
}
