// Dotz hub entry: bun hub/main.ts. Owns Discord, lanes and the event bus; serves the web app + API on
// 127.0.0.1 only. Tailnet access goes through `tailscale serve`, which adds the Tailscale-User-Login header.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, HUB_TOKEN, log, NAME, now, OMP, paths, PORT, TZ, tzLabel, writeAtomic } from "./config.ts";
import "./lock.ts"; // must stay right after config.ts: takes the single-instance lock before the other modules load
import { compactTarget, ControlError, contextView, ForceRequired, looksLikeCommand, modelsView, parseCommand, providersView, runCommand, setFallback, setGatewayRestart, setModel } from "./control.ts";
import { subagentDetail, subagentLists, transcriptItems } from "./activity.ts";
import * as discord from "./discord.ts";
import * as livestatus from "./livestatus.ts";
import { authRoute } from "./auth.ts";
import { isNote, msg } from "./i18n.ts";
import { activityItems, answeredIds, emit, historyEvents, recentEvents, sseResponse } from "./events.ts";
import { startLaneHygiene, startOrphanReaper, startWorktreeCleanup } from "./hygiene.ts";
import { startMemoryGuard } from "./memguard.ts";
import { abortLane, approvesBudget, budgetLine, budgetVerdict, claimPrefix, estimateOf, isExpensive, laneBusy, laneJustification, lanes, laneList, laneSummary, launch, restartLane, restoreLanes, resumeByName, sendToLane, setIdleHandler as setLaneIdleHandler, setNoticeHandler as setLaneNoticeHandler, setProgressHandler, setReportHandler, shutdownLanes, stopLane, turnHeader, verifyLane } from "./lanes.ts";
import { abort as abortOrchestrator, deliver as deliverToOrchestrator, orch, restart as restartOrchestrator, setAlertHandler, setAnswerHandlers, setIdleHandler as setOrchIdleHandler, setNoticeHandler as setOrchNoticeHandler, setTurnHeader, start as startOrchestrator, steer as steerOrchestrator, stop as stopOrchestrator } from "./orchestrator.ts";
import { drain, enqueue, queueItems, queuedTargets, restore, take } from "./queue.ts";
import { createPrompts } from "./prompts.ts";
import { createSendLedger } from "./sendlog.ts";
import { createRestartGate } from "./restart.ts";
import { createLaneRelay } from "./lanerelay.ts";
import { cancelLogin, completeLogin, loginStatus, logoutProvider, quota, saveProviderKey, startLogin } from "./providers.ts";
import { inOrder, localize, withTurnLanguage } from "./outlang.ts";
import { parseTone } from "./tone.ts";
import { lanePlace, replyRef } from "./threads.ts";
import { startReflection } from "./reflect.ts";
import { featureCatalog, syncFeatureWatches } from "./features.ts";
import { harnessGraph, readHarnessFile } from "./harness.ts";
import { addSchedule, listSchedules, removeSchedule, startSchedules, stopSchedules } from "./schedule.ts";
import { startOmpUpdate } from "./update.ts";
import { channelContext, clearChannel, listSetups, setupChannel } from "./workchannels.ts";
import { clearTrackedTimers, runShutdown } from "./shutdown.ts";
import { addWatch, allWatches, approveWatch, listWatches, removeWatch, startWatches, stopWatches } from "./watch.ts";
import { startTokenAudit } from "./token-audit.ts";
import { startZele } from "./zele.ts";
import { lastReport, RUNTIME_IDS, runtimesView, startVerify, UseRefused, useRuntime, verifyState, type UseRole } from "./runtime/verify.ts";
import { startHostSweep } from "./runtime/omo-hosts.ts";

const WEB = join(import.meta.dir, "..", "web", "index.html");
const ALLOW = new Set((cfg.web?.allow_logins ?? []).map(s => s.toLowerCase()));
const terminals = new Map<string, { cwd?: string; at: string }>();
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
const sends = createSendLedger({
	file: UNSENT,
	send: (target, text, ref, opts) => discord.send(target, text, ref, opts),
	retryable: discord.isRetryable,
	onDelivered: item => queue.markAnswered(item.answers),
	onGiveUp: (item, reason) => log(`send to ${item.target} dropped unsent: ${reason} (${item.text.slice(0, 80)})`),
	persist: items => writeAtomic(UNSENT, `${JSON.stringify(items, null, 2)}\n`),
	log,
});
const send = (target: string, text: string, ref?: string) => sends.submit(target, text, ref);
const queue = createPrompts({
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
});
// `owner` marks the owner's own message (it leads with the what-runs-now line); schedules, watches and mail carry a target but are not.
function deliver(text: string, reply?: { target: string; replyTo?: string; owner?: boolean }): void {
	if (reply) discord.typing(reply.target);
	queue.deliver(text, reply);
}

const isLocal = (target: string) => target === "web" || target === "terminal";
// The newest owner message per target (threads.ts replyRef: a thread answer carries a reply reference only when it is not to that one).
const lastOwner = new Map<string, string>();
async function out(target: string, text: string, replyTo?: string, extra: Record<string, unknown> = {}): Promise<{ delivered: boolean; reason?: string }> {
	// Gateway notices (rate-limit hold, command and limits replies) reply to a message without answering its request.
	const answers = extra.source === undefined || extra.source === "orchestrator" ? replyTo : undefined;
	const sent = await inOrder(target, async () => {
		const t = await localize(text, target, typeof extra.source === "string" ? extra.source : "orchestrator");
		emit("outbox", { ts: now(), kind: "out", source: "orchestrator", target, text: t, reply_to: replyTo ?? null, ...extra });
		return t;
	});
	if (isLocal(target)) {
		queue.markAnswered(answers);
		return { delivered: true };
	}
	return sends.submit(target, sent, replyRef(target, replyTo, lastOwner.get(target)), answers);
}

// While an owner message waits for its answer the owner sees 👀, typing and, for long work, one progress message edited in
// place (livestatus.ts). Nothing is sent before the answer is ready (owner 2026-10-20: "답변은 준비되고 해야해. 먼저하면
// 안됨"), so the gateway no longer steers the orchestrator into posting a note after 60 s.
function expectReply(target: string): void {
	if (isLocal(target)) return;
	livestatus.begin(target, "orchestrator");
}

// The final answer of a turn goes to every channel that asked and did not already get a dotz_send reply.
setAnswerHandlers(queue.onPrompt, queue.onAnswer);
setTurnHeader(turnHeader);

// Chat is the hub over every work channel: each chat turn carries a short directory so the orchestrator can route the
// work into the channel it belongs to (or split a growing thread of work into a new one).
function workDirectory(): string {
	const setups = new Map(listSetups().map(s => [s.channel, s.purpose]));
	const list = Object.entries(discord.channels.work).slice(0, 20).map(([id, name]) => `#${name} ch:${id}${setups.has(id) ? ` (${setups.get(id)!.slice(0, 60)})` : ""}`);
	return msg().workChannels(list);
}

function inboxText(e: Record<string, any>): string {
	return withTurnLanguage(inboxBody(e));
}

function inboxBody(e: Record<string, any>): string {
	const m = msg();
	if (e.kind === "lane_report") return `${m.inboxLaneReport(e.lane)}\n${e.text}`;
	if (e.kind === "watch") {
		const ch = e.channels?.[0];
		if (!ch) return `${m.inboxWatchNoChannel(e.watch, e.reason)}\n${e.text}`;
		return `${m.inboxWatch(e.watch, e.reason, ch)}\n${e.text}\n${channelContext(ch)}`;
	}
	if (e.kind === "mail") return `${m.inboxMail(e.channel_id)}\n${e.text}\n${channelContext(e.channel_id)}`;
	if (e.kind === "schedule") return `${m.inboxSchedule(e.id, e.every, e.channel)}\n${e.text}`;
	const where = e.thread_name ? m.inboxThread(e.thread_name, e.parent_name) : e.channel_name ? ` #${e.channel_name}` : "";
	const lines = [`[dotz inbox] ${e.channel}${where}${e.message_id ? ` msg=${e.message_id}` : ""} from ${e.author ?? "owner"}`];
	if (e.first) lines.push(m.inboxFirst(e.channel_name));
	const parts: Record<string, any>[] = e.parts ?? [e];
	if (parts.length > 1) lines.push(m.inboxBurst(parts.length));
	for (const p of parts) {
		if (p.reply) lines.push(m.replyingTo(p.reply.author, p.reply.content));
		for (const a of p.attachments ?? []) lines.push(`[attachment] ${a.name}${a.type ? ` (${a.type})` : ""} ${a.url}`);
		lines.push(p.text);
	}
	const home = e.parent?.startsWith("ch:") ? e.parent : e.channel;
	const ctx = home?.startsWith("ch:") ? channelContext(home.slice(3)) : "";
	if (ctx) lines.push(ctx);
	if (["chat", "dm", "web", "worklog", "alert"].includes(e.channel)) lines.push(workDirectory());
	return lines.join("\n");
}

// Owners often send one thought as several short messages. Messages from the same channel that arrive within
// COALESCE_MS of each other (at most COALESCE_MAX_MS after the first) become one turn, the way 오모냥's inbox monitor
// batched lines that arrived together.
const COALESCE_MS = Number((cfg as any).gateway?.coalesce_ms ?? 4000);
const COALESCE_MAX_MS = 20_000;
const bursts = new Map<string, { events: Record<string, any>[]; replyTo?: string; first: number; timer?: ReturnType<typeof setTimeout> }>();

function intake(event: Record<string, any>, target: string, replyTo?: string): void {
	let b = bursts.get(target);
	if (!b) {
		discord.typing(target);
		b = { events: [], first: Date.now() };
		bursts.set(target, b);
	}
	clearTimeout(b.timer);
	b.events.push(event);
	b.replyTo = replyTo ?? b.replyTo;
	b.timer = setTimeout(() => flush(target), Math.max(0, Math.min(COALESCE_MS, b.first + COALESCE_MAX_MS - Date.now())));
}

function flush(target: string): void {
	const b = bursts.get(target);
	if (!b) return;
	bursts.delete(target);
	const head = b.events[0];
	if (b.events.length === 1 && LIMITS_ASK.test(String(head.text)) && !head.attachments?.length) return void limitsAnswer(target, b.replyTo);
	rateLimitNotice(target, b.replyTo);
	const merged = b.events.length > 1 ? { ...head, message_id: b.events.at(-1)!.message_id, parts: b.events } : head;
	deliver(inboxText(merged), { target, replyTo: b.replyTo, owner: true });
	expectReply(target);
}

function alert(text: string): void {
	emit("outbox", { ts: now(), kind: "out", source: "gateway", target: "alert", text });
	void send("alert", text).catch(e => log(`alert send failed: ${e}`));
}
setAlertHandler(alert);

function rateLimitNotice(target: string, replyTo?: string): void {
	if (orch.status !== "rate-limited") return;
	const until = new Date(orch.rateLimitedUntil);
	const at = Number.isNaN(until.getTime()) ? "한도가 풀리면" : `${until.toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" })}쯤`;
	const text = orch.pauseKind === "owner" ? "지금 모델 제공자 결제/인증 문제로 멈춰 있어요. 해결되면 받은 메시지부터 이어서 처리할게요." : `지금 사용량 한도로 멈춰 있어요. ${at} 이어서 처리할게요.`;
	void out(target, text, replyTo, { source: "gateway" }).catch(() => undefined);
}

// Slash/bang commands (/model, /restart, ...) are answered by the gateway itself, never by the orchestrator.
async function answerCommand(target: string, text: string, replyTo?: string): Promise<void> {
	const output = await runCommand(text).catch(e => `error: ${(e as Error).message}`);
	await out(target, output, replyTo, { source: "gateway" }).catch(e => log(`command reply to ${target} failed: ${e}`));
}

// "한도" is answered by the gateway from `omp usage` (as 오모냥's `limits --short`), without waking the orchestrator.
const LIMITS_ASK = /^\s*(한도|사용량|limits?)\s*[?？]?\s*$/i;
async function limitsAnswer(target: string, replyTo?: string): Promise<void> {
	const r = await Bun.$`${OMP} usage -p anthropic`.nothrow().quiet();
	const lines = r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(l => /●\s+Claude/.test(l)).map(l => l.replace(/^\s*●\s*/, "").replace(/\s*[█░]+\s*/, "  "));
	const text = r.exitCode === 0 && lines.length ? `\`\`\`\n${lines.join("\n")}\n\`\`\`` : `사용량을 읽지 못했어요 (omp usage exit ${r.exitCode}).`;
	await out(target, text, replyTo, { source: "gateway" }).catch(e => log(`limits reply failed: ${e}`));
}

async function progress(target: string, key: string, text: string, replyTo?: string): Promise<{ delivered: boolean; reason?: string; edited?: boolean }> {
	const sent = await inOrder(target, async () => {
		let t = await localize(text, target, "orchestrator");
		// The label goes in after the status marker ([done] becomes the leading emoji) and after localize (a rewrite must not touch it).
		if (target === "worklog" && key.startsWith("lane:")) {
			const prefix = claimPrefix(key.slice(5));
			const rest = parseTone(t).text;
			if (prefix) t = `${t.slice(0, t.length - rest.length)}${prefix}${rest}`;
		}
		emit("outbox", { ts: now(), kind: "out", source: "orchestrator", target, text: t, update_key: key });
		return t;
	});
	if (isLocal(target)) return { delivered: true };
	// One evolving status per asking channel: every progress key there edits the same message the gateway's live report
	// uses (worklog and alert keep their per-key entries, e.g. one per lane).
	return discord.progress(target, target === "worklog" || target === "alert" ? key : "progress", sent, replyTo);
}

function authorized(req: Request): boolean {
	if (req.headers.get("x-dotz-token") === HUB_TOKEN) return true;
	const login = (req.headers.get("tailscale-user-login") ?? "").toLowerCase();
	if (login && ALLOW.has(login)) return true;
	const seen = [...req.headers.keys()].filter(k => k.startsWith("tailscale-")).map(k => `${k}=${req.headers.get(k)}`).join(" ");
	log(`denied ${new URL(req.url).pathname} ${seen || "(no tailscale identity headers)"}`);
	return false;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const body = async (req: Request) => {
	try {
		return (await req.json()) as Record<string, any>;
	} catch {
		return {};
	}
};

// Lanes are the expensive work, and the omp budget gate only sees task-tool workers, so lane launches check the quota here.
// Every decision (go / blocked / forced / unknown) leaves exactly one hub.log line.
async function budgetProblem(name: string, est: number, force: boolean): Promise<string | undefined> {
	if (force) {
		log(budgetLine(name, est, undefined, undefined, "forced"));
		return undefined;
	}
	const r = await Bun.$`${OMP} usage --json -p anthropic`.nothrow().quiet().catch(() => undefined);
	if (!r || r.exitCode !== 0) {
		log(budgetLine(name, est, undefined, undefined, "unknown"));
		return undefined;
	}
	let five: number | undefined;
	let week: number | undefined;
	try {
		type Limit = { id: string; amount?: { remaining?: number } };
		const parsed = JSON.parse(r.stdout.toString()) as { reports?: { provider?: string; limits?: Limit[] }[] };
		const limits = parsed.reports?.find(x => x.provider === "anthropic")?.limits ?? [];
		five = limits.find(l => l.id === "anthropic:5h")?.amount?.remaining;
		week = limits.find(l => l.id === "anthropic:7d")?.amount?.remaining;
	} catch {
		log(budgetLine(name, est, undefined, undefined, "unknown"));
		return undefined;
	}
	// The 5h window gates (est % assumed use, default 15, and 10% kept); the week is shown, never gates.
	const verdict = budgetVerdict(five, week, est);
	log(budgetLine(name, est, five, week, verdict ? "blocked" : typeof five === "number" ? "go" : "unknown"));
	return verdict;
}

const laneRelay = createLaneRelay({ busy: () => orch.status === "working", deliver: text => deliver(text), lead: n => msg().inboxLaneReports(n), steer: text => steerOrchestrator(msg().laneReportSteer(text)) });
setReportHandler((lane, text) => {
	const event = { ts: now(), kind: "lane_report", source: `lane:${lane.name}`, lane: lane.name, text };
	emit("inbox", event);
	const how = laneRelay.report(lane.name, text, join(paths.lanes, lane.name, "report.md"), lane.orchAsked === false);
	if (how === "relayed" || how === "held" || how === "steered") lane.orchAsked = false;
	if (how === "steered") log(`lane ${lane.name} report steered into the orchestrator's turn`);
	else log(`lane ${lane.name} report ${how === "disk" ? "kept on disk (routine progress)" : how === "owner" ? "kept on disk (answer to the owner in the lane channel)" : "dropped (same as the last one)"}`);
	if (how === "held") log(`lane ${lane.name} report held for the orchestrator's next idle point`);
	const channel = `lane:${lane.name}`;
	// A [run] report is progress: it edits the lane's one progress message. Results, questions and failures are real messages.
	const running = parseTone(text).tone === "run";
	void inOrder(channel, () => localize(text.slice(0, 1800), channel, "lane"))
		.then(async shown => {
			if (running) return void (await discord.progress(channel, "progress", shown));
			if ((await send(channel, shown)).delivered) await discord.clearProgress(channel);
		})
		.catch(e => log(`lane report send failed: ${e}`));
});

// Mid-turn lane text: an [ask], [fail] or [done] line is something the owner must see and keep, so it is a real message;
// anything else edits the lane channel's one progress message.
setProgressHandler((lane, text) => {
	const channel = `lane:${lane.name}`;
	const tone = parseTone(text).tone;
	const real = tone === "ask" || tone === "fail" || tone === "done";
	void inOrder(channel, async () => {
		const local = await localize(text.slice(0, real ? 1800 : 900), channel, "lane");
		const shown = real || tone === "run" ? local : `[run] ${local}`;
		emit("outbox", { ts: now(), kind: "out", source: channel, target: channel, text: shown, ...(real ? {} : { update_key: "progress" }) });
		return shown;
	})
		.then(shown => (real ? send(channel, shown) : discord.progress(channel, "progress", shown)))
		.catch(e => log(`lane progress send failed: ${e}`));
});

// A model fallback of a lane (and its task workers) is one plain line in the lane's channel, the orchestrator's task workers' one in worklog (the orchestrator's own goes to the alert channel). None wakes the orchestrator.
setOrchNoticeHandler(text => void out(discord.status.enabled ? "worklog" : "web", text, undefined, { source: "gateway" }).catch(e => log(`model fallback notice failed: ${e}`)));
setLaneNoticeHandler((lane, text) => {
	const channel = `lane:${lane.name}`;
	void inOrder(channel, async () => {
		const shown = await localize(text, channel, "lane");
		emit("outbox", { ts: now(), kind: "out", source: channel, target: channel, text: shown });
		return shown;
	})
		.then(shown => send(channel, shown))
		.catch(e => log(`lane model fallback notice failed: ${e}`));
});

discord.setChannelGoneHandler(id => {
	if (clearChannel(id)) log(`work channel ${id} is gone; its logins and monitors were released`);
});

discord.connect(m => {
	discord.ack(m.ackChannelId, m.id);
	const target = typeof m.channel === "string" ? m.channel : "lane" in m.channel ? `lane:${m.channel.lane}` : "work" in m.channel ? `ch:${m.channel.work}` : `th:${m.channel.thread}`;
	lastOwner.set(target, m.id);
	const event = { ts: now(), source: "discord", channel: target, message_id: m.id, author: m.author, text: m.content, attachments: m.attachments, reply: m.replyTo };
	if (parseCommand(m.content)) {
		emit("inbox", { ...event, kind: "message" });
		void answerCommand(target, m.content, m.id);
		return;
	}
	if (typeof m.channel === "object" && "thread" in m.channel) {
		const info = discord.threadInfo(m.channel.thread);
		const threadEvent = { ...event, channel: `th:${m.channel.thread}`, kind: "message", thread_name: m.channel.name, parent: info?.parentTarget, parent_name: info?.parentName };
		emit("inbox", threadEvent);
		intake(threadEvent, threadEvent.channel, m.id);
		return;
	}
	if (typeof m.channel === "object" && "work" in m.channel) {
		const workEvent = { ...event, kind: "message", channel_name: m.channel.name, ...(m.channel.first ? { first: true } : {}) };
		emit("inbox", workEvent);
		intake(workEvent, target, m.id);
		return;
	}
	if (typeof m.channel === "object") {
		const lane = m.channel.lane;
		emit("inbox", { ...event, kind: "lane_message", lane });
		const extra = [m.replyTo ? msg().replyingTo(m.replyTo.author, m.replyTo.content) : "", ...m.attachments.map(a => `[attachment] ${a.name} ${a.url}`)].filter(Boolean).join("\n");
		try {
			if (approvesBudget(lane, m.content)) sendToLane(lane, "/budget-ok");
			const busy = lanes.get(lane) ? laneBusy(lanes.get(lane)!) : false;
			sendToLane(lane, [`[owner via Discord] ${m.content}`, extra].filter(Boolean).join("\n"));
			livestatus.begin(target, `lane:${lane}`);
			// A busy lane answers when its current step allows; until then the owner sees at once that the message reached it,
			// in the lane's one progress message (no answer is sent before it is ready).
			if (busy) void discord.progress(target, "progress", "📨 받았어요. 하던 작업에 바로 넣었고, 답이 준비되면 여기로 올게요.").catch(e => log(`lane receipt note failed: ${e}`));
		} catch (error) {
			void send(target, `레인 ${lane}을(를) 이어갈 수 없어요 (${(error as Error).message}). 대화 채널에서 다시 맡겨 주세요.`, m.id);
		}
		return;
	}
	emit("inbox", { ...event, kind: "message" });
	intake({ ...event, kind: "message" }, target, m.id);
});
await discord.ensureChannels().catch(e => {
	discord.status.error = String(e);
	log(`ensureChannels failed: ${e}`);
});
void discord.syncProfile().catch(e => log(`syncProfile failed: ${e}`));

void startZele({
	alert,
	mail: (channel, text) => {
		const event = { ts: now(), kind: "mail", source: "zele", channel_id: channel, text };
		emit("inbox", event);
		deliver(inboxText(event), { target: `ch:${channel}` });
	},
	brief: text => {
		const target = discord.status.enabled ? "chat" : "web";
		const event = { ts: now(), kind: "schedule", source: "zele", id: "zele", channel: target, text };
		emit("inbox", event);
		deliver(inboxText(event), { target });
	},
	mailChannel: async () => {
		if (!discord.status.enabled) return undefined;
		const mailName = msg().channelNames.mail;
		const found = Object.entries(discord.channels.work).find(([, n]) => n === mailName)?.[0];
		const id = found ?? (await discord.createWorkChannel(mailName)).id;
		if (!found) setupChannel({ channel: id, purpose: "메일 수신함 (zele): 새 메일은 메일마다 스레드로 요약, 답장은 주인 OK 후" }, mailName, "");
		return id;
	},
});

// First start of a fresh install: the bot speaks first (greeting) and offers the read-only onboarding, once.
const GREETED = join(DATA_DIR, ".greeted");
const restarted = existsSync(GREETED);
if (!restarted) {
	writeFileSync(GREETED, `${now()}\n`);
	const target = discord.status.enabled ? "chat" : "web";
	deliver(msg().firstStart(target), { target });
}

// Sends one web message the way the composer's modes mean it. "default" (no mode): the main assistant takes it as the next
// message, a working lane gets it steered in; "steer": into the running turn now; "interrupt": abort, then new prompt.
type WebSend = { lane?: string; channel: "web" | "terminal"; text: string; mode: "default" | "steer" | "interrupt"; login: string };
async function sendWeb(s: WebSend): Promise<void> {
	const extra = s.mode === "default" ? {} : { mode: s.mode };
	if (s.lane) {
		const name = s.lane;
		emit("inbox", { ts: now(), kind: "lane_message", source: "web", author: s.login, lane: name, text: s.text, ...extra });
		if (approvesBudget(name, s.text)) sendToLane(name, "/budget-ok");
		if (s.mode === "interrupt" && lanes.get(name)?.status === "working") {
			abortLane(name);
			// Let the aborted turn end first, or the message would be steered into it.
			for (let i = 0; i < 50 && lanes.get(name)?.status === "working"; i++) await Bun.sleep(200);
		}
		sendToLane(name, `[owner via web] ${s.text}`);
		return;
	}
	const event = { ts: now(), kind: "message", source: s.channel, channel: s.channel, author: s.login, text: s.text, ...extra };
	emit("inbox", event);
	if (parseCommand(event.text) || looksLikeCommand(event.text)) void answerCommand(s.channel, event.text);
	else if (s.mode === "steer" && orch.status === "working") {
		steerOrchestrator(inboxText(event));
		expectReply(s.channel);
	} else {
		if (s.mode === "interrupt" && orch.status === "working") abortOrchestrator();
		intake(event, s.channel);
	}
}

// Web messages queued while their target works (see queue.ts) go out when that target is idle again: oldest first, as
// one message through the normal path (main: intake, which merges messages of one burst into one turn; lane: one prompt).
const QUEUE_SWEEP_MS = 5000;
function flushQueue(target: string): void {
	const lane = target.startsWith("lane:") ? target.slice(5) : undefined;
	const status = lane ? lanes.get(lane)?.status : orch.status;
	if (lane && !lanes.has(lane)) {
		const gone = drain(target);
		void out("web", `레인 ${lane}이(가) 없어서 대기 중이던 메시지 ${gone.length}개를 전달하지 못했어요:\n${gone.map(i => i.text).join("\n---\n")}`, undefined, { source: "gateway" }).catch(() => undefined);
		return;
	}
	if (status !== "idle") return;
	const items = drain(target);
	if (!items.length) return;
	try {
		if (lane) {
			for (const i of items) emit("inbox", { ts: now(), kind: "lane_message", source: "web", author: i.author ?? "local", lane, text: i.text });
			for (const i of items) if (approvesBudget(lane, i.text)) sendToLane(lane, "/budget-ok");
			sendToLane(lane, `[owner via web] ${items.map(i => i.text).join("\n\n")}`);
		} else {
			for (const i of items) {
				const event = { ts: now(), kind: "message", source: "web", channel: "web", author: i.author ?? "local", text: i.text };
				emit("inbox", event);
				intake(event, "web");
			}
		}
	} catch (error) {
		log(`queued web messages for ${target} not sent: ${(error as Error).message}`);
		restore(items);
	}
}
setOrchIdleHandler(() => {
	queue.redeliverSteered();
	laneRelay.flush();
	flushQueue("main");
});
setLaneIdleHandler(name => flushQueue(`lane:${name}`));
// Safety net for what the idle hooks miss: items kept over a gateway restart, a lane that went idle without a turn end.
setInterval(() => queuedTargets().forEach(flushQueue), QUEUE_SWEEP_MS);

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (!authorized(req)) return new Response("forbidden", { status: 403 });
		const parts = url.pathname.split("/").filter(Boolean);
		const authResponse = authRoute(req, url);
		if (authResponse) return authResponse;
		if (req.method === "GET" && url.pathname === "/") return new Response(Bun.file(WEB), { headers: { "Content-Type": "text/html; charset=utf-8" } });
		if (url.pathname === "/api/health") return json({ ok: true });
		if (req.method === "POST" && url.pathname === "/api/gateway/restart") return json({ ok: true, output: restartGateway() });
		if (url.pathname === "/api/state")
			return json({ name: NAME, discord: discord.status, channels: discord.channels, orchestrator: { ...orch, lastText: orch.lastText.slice(0, 600) }, terminals: Object.fromEntries(terminals), lanes: laneSummary(), schedules: listSchedules(), events: recentEvents(Number(url.searchParams.get("limit") ?? 100)) });
		if (url.pathname === "/api/events") return sseResponse();
		if (req.method === "GET" && url.pathname === "/api/history") {
			const target = url.searchParams.get("target") ?? "main";
			if (target !== "main" && !target.startsWith("lane:")) return json({ error: "target must be main or lane:<name>" }, 400);
			const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 150) || 150, 500));
			return json({ target, events: historyEvents(target, limit) });
		}
		if (req.method === "POST" && url.pathname === "/api/attach") {
			const b = await body(req);
			if (b.detach) terminals.delete(String(b.session));
			else terminals.set(String(b.session), { cwd: b.cwd, at: now() });
			return json({ ok: true });
		}
		if (req.method === "POST" && url.pathname === "/api/message") {
			const b = await body(req);
			if (!b.text) return json({ error: "text required" }, 400);
			const text = String(b.text);
			const login = req.headers.get("tailscale-user-login") ?? "local";
			// mode: none (main takes it as the next message, a working lane is steered), "steer" (into the running turn
			// now), "interrupt" (abort the running turn, then send as a new prompt), "queue" (a working target gets it
			// when its turn ends, see queue.ts; an idle target gets it now).
			const mode = b.mode === "steer" || b.mode === "interrupt" || b.mode === "queue" ? b.mode : "default";
			const lane = b.lane ? String(b.lane) : undefined;
			const channel = b.channel === "terminal" ? "terminal" : "web";
			if (mode === "queue" && (lane ? lanes.has(lane) : !parseCommand(text) && !looksLikeCommand(text)) && (lane ? lanes.get(lane)?.status === "working" : orch.status === "working")) {
				const item = enqueue(lane ? `lane:${lane}` : "main", text, login);
				return json({ ok: true, queued: item });
			}
			try {
				await sendWeb({ lane, channel, text, mode: mode === "queue" ? "default" : mode, login });
			} catch (error) {
				return json({ error: (error as Error).message }, 409);
			}
			return json({ ok: true });
		}
		if (url.pathname === "/api/queue" && req.method === "GET") return json({ items: queueItems() });
		if (parts[0] === "api" && parts[1] === "queue" && parts.length >= 3) {
			const id = decodeURIComponent(parts[2]);
			if (req.method === "DELETE" && parts.length === 3) {
				const item = take(id);
				return item ? json({ text: item.text }) : json({ error: "not queued (already sent)" }, 404);
			}
			if (req.method === "POST" && parts[3] === "send" && parts.length === 4) {
				const item = take(id);
				if (!item) return json({ error: "not queued (already sent)" }, 404);
				try {
					await sendWeb({ lane: item.target.startsWith("lane:") ? item.target.slice(5) : undefined, channel: "web", text: item.text, mode: "steer", login: item.author ?? "local" });
				} catch (error) {
					restore([item]);
					return json({ error: (error as Error).message }, 409);
				}
				return json({ ok: true });
			}
		}
		if (req.method === "POST" && url.pathname === "/api/send") {
			const b = await body(req);
			const target = String(b.target ?? "chat");
			if (b.update_key) {
				try {
					return json(await progress(target, String(b.update_key), String(b.text ?? ""), b.reply_to));
				} catch (error) {
					return json({ delivered: false, reason: (error as Error).message }, 502);
				}
			}
			// Answer only when it is ready: an early text to the asking channel waits for the turn's final answer.
			if (queue.holdEarly(target, String(b.text ?? ""), b.reply_to ? String(b.reply_to) : undefined))
				return json({ delivered: true, held: true, note: "held: it goes out together with your final answer for this request; do not send it again" });
			queue.sent(target, String(b.text ?? ""), b.reply_to ? String(b.reply_to) : undefined);
			try {
				return json(await out(target, String(b.text ?? ""), b.reply_to));
			} catch (error) {
				return json({ delivered: false, reason: (error as Error).message }, 502);
			}
		}
		const fail = (error: unknown) =>
			error instanceof ForceRequired
				? json({ error: error.message, requires_force: true, context_tokens: error.contextTokens }, error.status)
				: json({ error: (error as Error).message }, error instanceof ControlError ? error.status : 400);
		if (req.method === "GET" && parts[0] === "api" && parts[1] === "harness") {
			try {
				if (parts.length === 2) return json(await harnessGraph({ terminals: terminals.size }));
				if (parts[2] === "file" && parts.length > 3) return json(readHarnessFile(decodeURIComponent(parts.slice(3).join("/"))));
			} catch (error) {
				return fail(error);
			}
		}
		if (req.method === "GET" && parts[0] === "api" && parts[1] === "features" && parts.length === 2) {
			try {
				return json(await featureCatalog());
			} catch (error) {
				return fail(error);
			}
		}
		if (req.method === "GET" && url.pathname === "/api/models") return json(await modelsView());
		if (req.method === "PUT" && url.pathname === "/api/models") {
			const b = await body(req);
			try {
				return json(await setModel(String(b.target ?? ""), b.model ? String(b.model) : undefined, b.thinking ? String(b.thinking) : undefined, b.force === true));
			} catch (error) {
				return fail(error);
			}
		}
		if (req.method === "PUT" && url.pathname === "/api/fallbacks") {
			const b = await body(req);
			try {
				return json(await setFallback(String(b.target ?? ""), Array.isArray(b.chain) ? b.chain : []));
			} catch (error) {
				return fail(error);
			}
		}
		if (parts[0] === "api" && parts[1] === "runtimes") {
			if (req.method === "GET" && parts.length === 2) return json(await runtimesView(url.searchParams.get("refresh") === "1"));
			const id = parts[2];
			if (!RUNTIME_IDS.includes(id as never)) return json({ error: `알 수 없는 실행 하네스예요: ${id}` }, 404);
			if (req.method === "GET" && parts.length === 3) return json({ id, report: lastReport(id) ?? null, state: verifyState(id) ?? null });
			if (req.method === "POST" && parts[3] === "verify" && parts.length === 4) {
				const b = await body(req);
				return json({ ok: true, state: startVerify(id as never, b.model ? { model: String(b.model) } : {}) }, 202);
			}
			if (req.method === "POST" && parts[3] === "use" && parts.length === 4) {
				const b = await body(req);
				const roles = (Array.isArray(b.roles) ? b.roles : ["orchestrator", "lanes"]).map(String) as UseRole[];
				try {
					const done = await useRuntime(id, roles);
					log(`runtime ${id} selected for ${done.join(", ")}`);
					return json({ ok: true, runtime: id, roles: done, applies: "오케스트레이터와 레인을 다시 시작하면 적용돼요. 지금 돌고 있는 프로세스는 그대로예요." });
				} catch (error) {
					if (error instanceof UseRefused) return json({ error: error.message, runtime: id }, 409);
					throw error;
				}
			}
		}
		if (req.method === "GET" && url.pathname === "/api/context") return json(contextView());
		if (req.method === "POST" && url.pathname === "/api/compact") {
			try {
				const r = compactTarget(String((await body(req)).target ?? ""));
				return json({ ok: true, target: r.target, state: r.compaction.state, message: r.message });
			} catch (error) {
				return fail(error);
			}
		}
		if (req.method === "GET" && url.pathname === "/api/subagents") return json({ sources: subagentLists() });
		if (req.method === "GET" && parts[0] === "api" && parts[1] === "subagents" && parts.length === 3) {
			const detail = await subagentDetail(url.searchParams.get("source") ?? "orchestrator", decodeURIComponent(parts[2]));
			return detail ? json(detail) : json({ error: "no such subagent (finished ones are kept 10 minutes)" }, 404);
		}
		if (req.method === "GET" && url.pathname === "/api/activity") {
			const source = url.searchParams.get("source") ?? "orchestrator";
			if (source !== "orchestrator" && !source.startsWith("lane:")) return json({ error: "source must be orchestrator or lane:<name>" }, 400);
			const limit = Number(url.searchParams.get("limit") ?? 300) || 300;
			const live = activityItems(source, limit);
			// After a gateway restart or for a lane that has exited, the live buffer is empty: show the lane's saved
			// transcript instead, so the owner can see where it stopped before resuming it.
			const lane = source.startsWith("lane:") ? lanes.get(source.slice(5)) : undefined;
			if (!live.length && lane?.sessionFile) return json({ source, history: true, items: await transcriptItems(lane.sessionFile, limit) });
			return json({ source, items: live });
		}
		if (req.method === "GET" && url.pathname === "/api/quota") return json(await quota());
		if (req.method === "POST" && url.pathname === "/api/command") {
			const text = String((await body(req)).text ?? "").trim();
			if (!text) return json({ error: "text required" }, 400);
			try {
				return json({ ok: true, output: await runCommand(/^[/!]/.test(text) ? text : `/${text}`) });
			} catch (error) {
				return fail(error);
			}
		}
		if (parts[0] === "api" && parts[1] === "providers") {
			try {
				if (req.method === "GET" && parts.length === 2) return json(await providersView());
				if (req.method === "POST" && parts.length === 2) {
					const b = await body(req);
					const provider = String(b.provider ?? "").trim();
					return json({ ok: true, provider, masked: await saveProviderKey(provider, String(b.key ?? "")) });
				}
				if (req.method === "DELETE" && parts.length === 3) {
					await logoutProvider(decodeURIComponent(parts[2]));
					return json({ ok: true });
				}
				if (parts.length >= 4 && parts[3] === "login") {
					const provider = decodeURIComponent(parts[2]);
					if (req.method === "POST" && parts.length === 4) return json({ ok: true, ...(await startLogin(provider)) });
					if (req.method === "POST" && parts.length === 5 && parts[4] === "complete") {
						const b = await body(req);
						return json({ ok: true, ...(await completeLogin(provider, String(b.login_id ?? ""), String(b.code ?? ""))) });
					}
					if (req.method === "GET" && parts.length === 4) return json(loginStatus(provider, url.searchParams.get("login_id") ?? ""));
					if (req.method === "DELETE" && parts.length === 4) {
						await cancelLogin(provider);
						return json({ ok: true });
					}
				}
				if (req.method === "POST" && parts.length === 4 && parts[3] === "logout") {
					await logoutProvider(decodeURIComponent(parts[2]));
					return json({ ok: true });
				}
			} catch (error) {
				return fail(error);
			}
		}
		if (req.method === "POST" && parts[0] === "api" && parts[1] === "orchestrator" && (parts[2] === "restart" || parts[2] === "abort")) {
			try {
				if (parts[2] === "restart") restartOrchestrator();
				else abortOrchestrator();
				return json({ ok: true });
			} catch (error) {
				return fail(error);
			}
		}
		if (parts[0] === "api" && parts[1] === "channels") {
			try {
				if (req.method === "GET") return json({ work_channels: Object.entries(discord.channels.work).map(([id, name]) => ({ channel: `ch:${id}`, name })), setups: listSetups() });
				if (req.method === "POST" && parts[2] === "create") {
					const c = await discord.createWorkChannel(String((await body(req)).name ?? ""));
					return json({ ok: true, channel: `ch:${c.id}`, name: c.name });
				}
				if (req.method === "POST" && parts[2] === "thread_status") {
					const b = await body(req);
					const state = String(b.status);
					if (state !== "working" && state !== "waiting" && state !== "done") return json({ error: "status must be working, waiting or done" }, 400);
					return json({ ok: true, name: await discord.threadStatus(String(b.thread ?? ""), state) });
				}
				if (req.method === "POST" && parts[2] === "thread") {
					const b = await body(req);
					// The first paragraph is the parent-channel message the thread hangs from; the rest goes inside the thread.
					const text = String(b.text ?? "").trim();
					const cut = text.indexOf("\n\n");
					const starter = cut < 0 ? text : text.slice(0, cut);
					const rest = cut < 0 ? "" : text.slice(cut + 2).trim();
					const t = await discord.createThread(String(b.channel ?? "chat"), String(b.name ?? "").trim(), starter || undefined);
					if (rest) await out(`th:${t.id}`, rest, undefined, { source: "orchestrator" });
					return json({ ok: true, thread: `th:${t.id}`, name: t.name });
				}
				if (req.method === "POST" && parts[2] === "setup") {
					const b = await body(req);
					const id = String(b.channel ?? "").replace(/^ch:/, "");
					const name = discord.channels.work[id];
					if (!name) return json({ error: `ch:${id} is not a work channel (only channels under the ${NAME} category)` }, 400);
					const setup = setupChannel(b, name, existsSync(paths.rules) ? readFileSync(paths.rules, "utf8") : "");
					const kept = [setup.logins.length ? `로그인 유지: ${setup.logins.join(", ")}` : "", setup.monitors.length ? `감시 ${setup.monitors.length}개` : "", setup.standing ? `자동 처리: ${setup.standing}` : ""].filter(Boolean).join(" · ");
					void out(`ch:${id}`, `이 채널 자동 관리: ${setup.purpose}${kept ? `\n${kept}` : ""}`, undefined, { source: "gateway" }).catch(e => log(`setup note failed: ${e}`));
					return json({ ok: true, setup });
				}
				if (req.method === "DELETE" && parts[2]) return json({ ok: clearChannel(parts[2]) });
			} catch (error) {
				return json({ error: (error as Error).message }, 400);
			}
		}
		if (parts[0] === "api" && parts[1] === "watches") {
			try {
				if (req.method === "GET") return json(listWatches());
				if (req.method === "POST" && parts[2] && parts[3] === "approve") return json({ ok: true, watch: approveWatch(parts[2]) });
				if (req.method === "POST") return json({ ok: true, watch: addWatch(await body(req), existsSync(paths.rules) ? readFileSync(paths.rules, "utf8") : "") });
				if (req.method === "DELETE" && parts[2]) {
					const owned = allWatches().find(w => (w.id === parts[2] || w.name === parts[2]) && w.channels?.length);
					if (owned) return json({ error: `watch ${owned.name} belongs to a work channel setup (${owned.channels!.map(c => `ch:${c}`).join(", ")}); change that setup instead` }, 409);
					return json({ ok: removeWatch(parts[2]) });
				}
			} catch (error) {
				return json({ error: (error as Error).message }, 400);
			}
		}
		if (parts[0] === "api" && parts[1] === "schedules") {
			try {
				if (req.method === "GET") return json(listSchedules());
				if (req.method === "POST") return json({ ok: true, schedule: addSchedule(await body(req)) });
				if (req.method === "DELETE" && parts[2]) return json({ ok: removeSchedule(parts[2]) });
			} catch (error) {
				return json({ error: (error as Error).message }, 400);
			}
		}
		if (parts[0] === "api" && parts[1] === "lanes") {
			try {
				if (req.method === "GET" && parts.length === 2) return json(laneList());
				if (req.method === "POST" && parts.length === 2) {
					const b = await body(req);
					const asked = Boolean(b.owner_asked_for_fable);
					const dear = [b.model, b.worker_model].filter(m => m && isExpensive(String(m)));
					if (dear.length && !asked) return json({ error: `Fable and max/xhigh-effort models (${dear.join(", ")}) run only when the owner explicitly asks for them. Use the defaults, or relaunch with owner_asked_for_fable=true after they ask.` }, 409);
					const unjustified = laneJustification(b.why, b.hours, Boolean(b.owner_asked_for_lane));
					if (unjustified) {
						log(`lane ${String(b.name)} refused: ${unjustified}`);
						return json({ error: unjustified }, 409);
					}
					const est = estimateOf(b.est, String(b.brief ?? ""));
					const tight = await budgetProblem(String(b.name), est, Boolean(b.force));
					if (tight) return json({ error: `budget gate: ${tight}. Ask the owner (now / after reset / smaller); relaunch with force=true only after they say now, or with a smaller est.` }, 409);
					const home = b.home ? String(b.home) : undefined;
					if (home && discord.status.enabled) discord.homeChannel(home);
					const asking = queue.current();
					const place = lanePlace({ home, asking: asking?.target, askingMessage: asking?.replyTo, isWork: id => Boolean(discord.channels.work[id]), threadParent: id => discord.channels.threads[id]?.parent });
					const lane = launch(String(b.name), String(b.cwd), String(b.brief ?? ""), b.model, b.worker_model ? String(b.worker_model) : undefined, asked);
					// The goal line of the brief ("목표...: ...") is the thread's starter message in the home channel.
					const goal = /^(?:목표|Goal)[^:：]*[:：]\s*(.+)$/im.exec(String(b.brief ?? ""))?.[1]?.slice(0, 300);
					const starter = goal ? `[run] ${b.title ? String(b.title) : lane.name}: ${goal}` : undefined;
					const channel = await discord.laneChannel(lane.name, b.title ? String(b.title) : undefined, place, starter, goal).catch(e => {
						log(`lane channel failed: ${e}`);
						return undefined;
					});
					// Work started from a work channel or a thread is answered in the lane's thread, where its reports will come.
					if (channel && place.kind !== "channel" && asking?.target) queue.retarget(asking.target, `lane:${lane.name}`);
					log(`lane ${lane.name} why (${b.owner_asked_for_lane ? "owner asked" : `${Number(b.hours)}h`}): ${String(b.why).trim().slice(0, 300)}`);
					emit("outbox", { ts: now(), kind: "lane_start", source: "hub", lane: lane.name, text: `lane ${lane.name} started in ${lane.cwd}` });
					return json({ ok: true, lane: lane.name, channel });
				}
				if (req.method === "POST" && parts[3] === "send") {
					sendToLane(parts[2], String((await body(req)).text ?? ""));
					return json({ ok: true });
				}
				if (req.method === "POST" && parts[3] === "restart") {
					await restartLane(parts[2]);
					return json({ ok: true });
				}
				if (req.method === "POST" && parts[3] === "resume") {
					const text = String((await body(req)).text ?? "").trim();
					resumeByName(parts[2], text || undefined);
					return json({ ok: true });
				}
				if (req.method === "POST" && parts[3] === "verify") {
					verifyLane(parts[2], String((await body(req)).text ?? ""));
					return json({ ok: true });
				}
				if (req.method === "POST" && parts[3] === "abort") {
					abortLane(parts[2]);
					return json({ ok: true });
				}
				if (req.method === "DELETE" && parts.length === 3) {
					stopLane(parts[2]);
					void discord.releaseLane(parts[2]).catch(e => log(`lane ${parts[2]} thread release failed: ${e}`));
					return json({ ok: true });
				}
			} catch (error) {
				return json({ error: (error as Error).message }, 400);
			}
		}
		return new Response("not found", { status: 404 });
	},
});

let replayed = 0;
if (process.env.DOTZ_NO_ORCHESTRATOR !== "1") {
	startOrchestrator();
	replayed = replayPending();
}
sends.resume();
const resumedLanes = restoreLanes();
for (const name of resumedLanes) void send(`lane:${name}`, "게이트웨이가 재시작돼서 멈췄던 작업을 이어서 하고 있어요.").catch(e => log(`lane resume notice failed: ${e}`));
// Every start after the first one says so in worklog (a self-run system event, not a chat answer), with what it picked
// back up, so a restart is never silent; failures to start go to alert elsewhere.
if (restarted) {
	const at = new Date().toLocaleTimeString("ko-KR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
	const picked = [replayed ? `답 못 한 메시지 ${replayed}개 다시 처리 중` : "", resumedLanes.length ? `이어서 하는 레인: ${resumedLanes.join(", ")}` : ""].filter(Boolean);
	void out(discord.status.enabled ? "worklog" : "web", `게이트웨이 재시작했어요 (${at} ${tzLabel()}).${picked.length ? `\n- ${picked.join("\n- ")}` : " 끊긴 작업은 없어요."}`, undefined, { source: "gateway" }).catch(e => log(`restart notice failed: ${e}`));
}
startLaneHygiene();
startWorktreeCleanup();
startMemoryGuard((key, text) => {
	if (key === "orchestrator") return alert(`${NAME}: ${text}`);
	void send(key, text).catch(e => log(`memory guard notice to ${key} failed: ${e}`));
});
startOrphanReaper();
startHostSweep();
startSchedules(s => {
	const channel = discord.status.enabled ? "chat" : "web";
	const event = { ts: now(), kind: "schedule", source: "schedule", channel, id: s.id, every: s.every_minutes, text: s.text };
	emit("inbox", event);
	deliver(inboxText(event), { target: channel });
});
startReflection(text => deliver(text), () => orch.sessionFile);
startOmpUpdate(text => void out("worklog", text, undefined, { source: "gateway" }).catch(e => log(`omp update post failed: ${e}`)), restartGateway);
startTokenAudit(alert);
startWatches((w, reason, output) => {
	if (w.to === "orchestrator") {
		const event = { ts: now(), kind: "watch", source: `watch:${w.name}`, watch: w.name, channels: w.channels, reason, text: output };
		emit("inbox", event);
		if (!w.channels?.length) return deliver(inboxText(event));
		const [first, ...others] = w.channels;
		for (const c of others) void out(`ch:${c}`, `[${w.name}] ${reason} (처리는 #${discord.channels.work[first] ?? first} 에서)\n${output}`.slice(0, 1900), undefined, { source: "gateway" }).catch(() => undefined);
		return deliver(inboxText(event), { target: `ch:${first}` });
	}
	void out(w.to, `[${w.name}] ${reason}\n${output}`.slice(0, 1900), undefined, { source: "gateway" }).catch(e => log(`watch ${w.name} send failed: ${e}`));
});
syncFeatureWatches();
writeAtomic(paths.pid, String(process.pid));
log(`hub listening on 127.0.0.1:${server.port} as ${NAME} (discord ${discord.status.enabled ? "on" : "off"})`);
for (const sig of ["SIGTERM", "SIGINT"] as const)
	process.on(sig, () => {
		log(`hub ${sig}`);
		void shutdown();
	});

// Fixed order, one overall 10 s deadline (see shutdown.ts). Messages still coalescing go into the ledger before exit, so
// the next start replays them; the orchestrator's session file is saved as it runs, stop() only keeps it from respawning.
function shutdown(): Promise<never> {
	return runShutdown([
		{ name: "block new input", run: () => (server.stop(), discord.stopIntake()) },
		{
			name: "save state",
			run: () => {
				for (const target of [...bursts.keys()]) flush(target);
				shutdownLanes();
				stopOrchestrator();
			},
		},
		{ name: "discord connection", run: () => discord.disconnect() },
		{ name: "watch and schedule timers", run: () => (stopWatches(), stopSchedules(), clearTrackedTimers()) },
		{ name: "others", run: () => void 0 },
	]);
}

// Prompts that were delivered but never answered (the gateway stopped mid-turn) are delivered again on start.
// Returns how many prompts were replayed.
function replayPending(): number {
	const open = unanswered;
	unanswered = [];
	return queue.replay(open, text => (isNote(text, "replayLead") ? text : `${msg().replay}\n${text}`));
}

// Restart the gateway the way 오모냥's herdr-restart does: wait until the orchestrator and every lane are idle, task
// workers included, then exit; launchd (KeepAlive) starts the new code. Called during an orchestrator turn, it waits for
// that turn to end, so the answer goes out first. restart.ts: a busy lane is never killed, requests are coalesced.
const restartGate = createRestartGate({
	busy: () => [orch.status === "working" || orch.status === "starting" ? "orchestrator" : "", ...[...lanes.values()].filter(laneBusy).map(l => `lane ${l.name}`)].filter(Boolean),
	collecting: () => bursts.size > 0,
	startedAt: Date.now(),
	minGapMs: Number(process.env.DOTZ_RESTART_MIN_GAP_MS ?? 5 * 60_000),
	noticeAfterMs: 20 * 60_000,
	notice: text => void out(discord.status.enabled ? "worklog" : "web", text, undefined, { source: "gateway" }).catch(e => log(`restart wait notice failed: ${e}`)),
	log,
	exit: () => void shutdown(),
});
function restartGateway(): string {
	return restartGate.request();
}
setGatewayRestart(restartGateway);
