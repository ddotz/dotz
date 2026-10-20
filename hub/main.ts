// Dotz hub entry: bun hub/main.ts. Owns Discord, lanes and the event bus; serves the web app + API on
// 127.0.0.1 only. Tailnet access goes through `tailscale serve`, which adds the Tailscale-User-Login header.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, HUB_TOKEN, log, NAME, now, paths, PORT, TZ, tzLabel, writeAtomic } from "./config.ts";
import "./lock.ts"; // must stay right after config.ts: takes the single-instance lock before the other modules load
import { changeTarget, compactTarget, ControlError, contextView, targetView, ForceRequired, looksLikeCommand, modelsView, parseCommand, providersView, runCommand, setFallback, setGatewayRestart, setModel } from "./control.ts";
import { subagentDetail, subagentLists, transcriptPage } from "./activity.ts";
import * as discord from "./discord.ts";
import * as livestatus from "./livestatus.ts";
import { authRoute } from "./auth.ts";
import { notify as pushNotify, pushRoute, startPush } from "./push.ts";
import { isNote, msg } from "./i18n.ts";
import { activityItems, answeredIds, broadcast, emit, historyEvents, recentEvents, sseResponse } from "./events.ts";
import { startDataCleanup, startLaneHygiene, startOrphanReaper, startWorktreeCleanup } from "./hygiene.ts";
import { startMemoryGuard } from "./memguard.ts";
import { deleteLanes, restoreLanes as restoreTrashedLanes, setTrashChannels, trashList } from "./lanetrash.ts";
import { attachmentLines, allowedRoots, FileError, messageFiles, resolveAllowed, serveFile, type Upload, uploadsFrom } from "./files.ts";
import { abortLane, applyAccountChange as applyLaneAccount, approvesBudget, budgetLine, budgetVerdict, claimPrefix, estimateOf, handoverLane, isExpensive, LaneRuntimeMismatch, laneBusy, laneJustification, lanes, laneList, liveLanes, laneSummary, launch, restartLane, restoreLanes, resumeByName, sendToLane, setIdleHandler as setLaneIdleHandler, setNoticeHandler as setLaneNoticeHandler, setProgressHandler, setReportHandler, shutdownLanes, stopLane, turnHeader, verifyLane } from "./lanes.ts";
import { accountView, onSwitch as onAccountSwitch, stickyAccount } from "./account-sticky.ts";
import { runtimeFor } from "./runtime/index.ts";
import { abort as abortOrchestrator, applyAccountChange as applyOrchestratorAccount, deliver as deliverToOrchestrator, orch, orchBusy, restart as restartOrchestrator, setAlertHandler, setAnswerHandlers, setIdleHandler as setOrchIdleHandler, setNoticeHandler as setOrchNoticeHandler, setTurnHeader, start as startOrchestrator, steer as steerOrchestrator, stop as stopOrchestrator } from "./orchestrator.ts";
import { drain, enqueue, queueItems, queuedTargets, restore, take } from "./queue.ts";
import { createPrompts } from "./prompts.ts";
import { createSendLedger } from "./sendlog.ts";
import { createRestartGate } from "./restart.ts";
import { createLaneRelay } from "./lanerelay.ts";
import { anthropicUsage, cancelLogin, completeLogin, loginStatus, logoutProvider, quota, saveProviderKey, startLogin } from "./providers.ts";
import { limitsText } from "./usage-account.ts";
import { inOrder, localize, withTurnLanguage } from "./outlang.ts";
import { parseTone } from "./tone.ts";
import { lanePlace, replyRef } from "./threads.ts";
import { startReflection } from "./reflect.ts";
import { featureCatalog, syncFeatureWatches } from "./features.ts";
import { harnessGraph, readHarnessFile } from "./harness.ts";
import { addSchedule, listSchedules, removeSchedule, startSchedules, stopSchedules } from "./schedule.ts";
import { customRoute, syncRoutineSchedules } from "./custom.ts";
import { startOmpUpdate } from "./update.ts";
import { startSelfUpdate, updateRoute } from "./selfupdate.ts";
import { channelContext, clearChannel, listSetups, setupChannel } from "./workchannels.ts";
import { clearTrackedTimers, runShutdown } from "./shutdown.ts";
import { addWatch, allWatches, approveWatch, listWatches, removeWatch, startWatches, stopWatches } from "./watch.ts";
import { startTokenAudit } from "./token-audit.ts";
import { startZele } from "./zele.ts";
import { lastReport, RUNTIME_IDS, runtimesView, startVerify, UseRefused, useRuntime, verifyState, type UseRole } from "./runtime/verify.ts";
import { startHostSweep } from "./runtime/omo-hosts.ts";

const WEB = join(import.meta.dir, "..", "web", "index.html");
const BOOT_ID = Date.now().toString(36);
// Installable-app files next to index.html: manifest, service worker (never cached by HTTP, so an update is seen at once), icons.
const APP_FILES: Record<string, [string, string]> = {
	"/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
	"/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
	"/icons/icon-192.png": ["icons/icon-192.png", "image/png"],
	"/icons/icon-512.png": ["icons/icon-512.png", "image/png"],
	"/icons/maskable-512.png": ["icons/maskable-512.png", "image/png"],
	"/icons/apple-touch-icon.png": ["icons/apple-touch-icon.png", "image/png"],
};
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
setAnswerHandlers(queue.onPrompt, queue.onAnswer, queue.onText);
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

// "한도" is answered by the gateway without waking the orchestrator, from the account the orchestrator really runs on
// (hub/usage-account.ts: OmO's pinned/pool account under OmO, omp's login otherwise), named in the answer.
const LIMITS_ASK = /^\s*(한도|사용량|limits?)\s*[?？]?\s*$/i;
async function limitsAnswer(target: string, replyTo?: string): Promise<void> {
	const r = await anthropicUsage("orchestrator").catch(() => undefined);
	const last = accountView(1).switches[0];
	const moved = last && last.kind !== "start" ? `\n마지막 계정 전환: ${new Date(last.at).toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} ${last.from ?? "?"} → ${last.to} (${last.reason})` : "";
	const text = r ? `${limitsText(r, Date.now())}${moved}` : "사용량을 읽지 못했어요 (Anthropic 계정을 찾지 못함).";
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
	// The account lanes really run on (OmO's pinned account may not be omp's login).
	const r = await anthropicUsage("lane").catch(() => undefined);
	const five = r?.limits.find(l => l.id === "anthropic:5h")?.amount.remaining;
	const week = r?.limits.find(l => l.id === "anthropic:7d")?.amount.remaining;
	// The 5h window gates (est % assumed use, default 15, and 10% kept); the week is shown, never gates.
	const verdict = budgetVerdict(five, week, est);
	log(`${budgetLine(name, est, five, week, verdict ? "blocked" : typeof five === "number" ? "go" : "unknown")} (account ${r?.account ?? "?"}${r?.problem ? `, ${r.problem}` : ""})`);
	return verdict && r ? `${verdict} (account ${r.account})` : verdict;
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

// Result files ([file] lines, discord.ts) go out only when GET /api/file would serve them; a file too big to attach goes
// out as that route's download link on the tailnet address (config web.public_url, else tailscale's name + HTTPS port).
const fileRoots = () => allowedRoots([...lanes.values()].flatMap(l => [l.cwd, l.worktree?.path ?? ""]));
discord.setFileResolver(p => resolveAllowed(p, fileRoots()));
let webBase: string | undefined = (cfg.web as { public_url?: string } | undefined)?.public_url?.replace(/\/+$/, "");
if (!webBase && cfg.web?.tailscale_https_port) {
	const port = cfg.web.tailscale_https_port;
	void (async () => {
		for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
			const dns = await Bun.$`${bin} status --json`.quiet().json().then(s => String(s?.Self?.DNSName ?? "").replace(/\.$/, ""), () => "");
			if (dns) return void (webBase = `https://${dns}${port === 443 ? "" : `:${port}`}`);
		}
		log("files: no tailnet address found (set web.public_url); files too big to attach are named, not linked");
	})();
}
discord.setFileLink(p => (webBase ? `${webBase}/api/file?path=${encodeURIComponent(p)}&dl=1` : undefined));
// Apple's push service rejects a VAPID subject it cannot parse as a contact: the app's own https URL is one.
startPush({ subject: () => webBase ?? "mailto:dotz@example.com" });

setTrashChannels({ take: discord.takeLaneChannel, put: discord.putLaneChannel, remove: discord.deleteChannel });
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
			// A session of another runtime: the refusal itself offers the handover (answer "인계" here).
			if (error instanceof LaneRuntimeMismatch) {
				log(`lane ${lane}: owner message refused, session of ${error.from}; handover offered`);
				void send(target, error.message, m.id);
			} else void send(target, `레인 ${lane}을(를) 이어갈 수 없어요 (${(error as Error).message}). 대화 채널에서 다시 맡겨 주세요.`, m.id);
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
// `files` are uploads (files.ts): the chat shows them as chips, the agent gets one [attachment] line per file with its path.
type WebSend = { lane?: string; channel: "web" | "terminal"; text: string; mode: "default" | "steer" | "interrupt"; login: string; files?: Upload[] };
async function sendWeb(s: WebSend): Promise<void> {
	const extra = { ...(s.mode === "default" ? {} : { mode: s.mode }), ...(s.files?.length ? { files: s.files } : {}) };
	if (s.lane) {
		const name = s.lane;
		emit("inbox", { ts: now(), kind: "lane_message", source: "web", author: s.login, lane: name, text: s.text, ...extra });
		if (approvesBudget(name, s.text)) sendToLane(name, "/budget-ok");
		if (s.mode === "interrupt" && lanes.get(name)?.status === "working") {
			abortLane(name);
			// Let the aborted turn end first, or the message would be steered into it.
			for (let i = 0; i < 50 && lanes.get(name)?.status === "working"; i++) await Bun.sleep(200);
		}
		sendToLane(name, [`[owner via web] ${s.text}`, s.files?.length ? attachmentLines(s.files) : ""].filter(Boolean).join("\n"));
		return;
	}
	const event = { ts: now(), kind: "message", source: s.channel, channel: s.channel, author: s.login, text: s.text, ...extra, ...(s.files?.length ? { attachments: s.files.map(f => ({ name: f.name, type: f.type, url: f.path })) } : {}) };
	emit("inbox", event);
	if (parseCommand(event.text) || looksLikeCommand(event.text)) void answerCommand(s.channel, event.text);
	else if (s.mode === "steer" && orch.status === "working") {
		// Through the prompt queue, which steers it in as a note now: raw inbox text admitted mid-turn read as a new prompt
		// and unpaired the running turn, so its answer went nowhere (2026-10-20 19:43 KST, the 19:36 and 19:38 web messages).
		deliver(inboxText(event), { target: s.channel, owner: true });
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
	queue.settleTurn();
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
		// The install files (manifest, service worker, icons) are public and secret-free, like any app store listing: a browser
		// or OS fetch that carries no tailnet identity (icon or manifest fetch, SW update check) must still get them, or the
		// phone falls back to a plain shortcut. Everything else stays behind the identity check.
		const appFile = req.method === "GET" || req.method === "HEAD" ? APP_FILES[url.pathname] : undefined;
		if (appFile) return new Response(req.method === "HEAD" ? null : Bun.file(join(import.meta.dir, "..", "web", appFile[0])), { headers: { "Content-Type": appFile[1], "Cache-Control": url.pathname === "/sw.js" || url.pathname.endsWith(".webmanifest") ? "no-cache" : "public, max-age=86400" } });
		if (!authorized(req)) return new Response("forbidden", { status: 403 });
		const parts = url.pathname.split("/").filter(Boolean);
		const authResponse = authRoute(req, url);
		if (authResponse) return authResponse;
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") return new Response(req.method === "HEAD" ? null : Bun.file(WEB), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/custom.js") {
			const file = Bun.file(join(import.meta.dir, "..", "web", "custom.js"));
			return (await file.exists()) ? new Response(req.method === "HEAD" ? null : file, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } }) : new Response("not found", { status: 404 });
		}
		const pushResponse = await pushRoute(req, url);
		if (pushResponse) return pushResponse;
		const updateResponse = await updateRoute(req, url, { boot: BOOT_ID, busy: busyNow, restartIdle: restartGateway, restartNow: restartGatewayNow });
		if (updateResponse) return updateResponse;
		const customResponse = await customRoute(req, url, { lanes: laneSummary, channels: () => discord.channels, send: (target, text, login) => sendWeb({ ...(target === "main" ? {} : { lane: target.slice(5) }), channel: "web", text, mode: "default", login }) });
		if (customResponse) return customResponse;
		if (url.pathname === "/api/health") return json({ ok: true });
		if (req.method === "POST" && url.pathname === "/api/gateway/restart") return json({ ok: true, output: restartGateway() });
		if (url.pathname === "/api/state")
			return json({ name: NAME, discord: discord.status, channels: discord.channels, orchestrator: { ...orch, lastText: orch.lastText.slice(0, 600) }, terminals: Object.fromEntries(terminals), lanes: laneSummary(), schedules: listSchedules(), events: recentEvents(Number(url.searchParams.get("limit") ?? 100)) });
		if (url.pathname === "/api/events") return sseResponse(req.headers.get("last-event-id") ?? url.searchParams.get("last"));
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
		if (req.method === "POST" && url.pathname === "/api/upload") {
			try {
				return json({ ok: true, files: await uploadsFrom(req) });
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof FileError ? error.status : 400);
			}
		}
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/file") {
			try {
				const path = resolveAllowed(url.searchParams.get("path") ?? "", fileRoots());
				const res = serveFile(path, req, url.searchParams.get("dl") === "1" || url.searchParams.get("download") === "1");
				return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
			} catch (error) {
				return json({ error: (error as Error).message }, error instanceof FileError ? error.status : 400);
			}
		}
		if (req.method === "GET" && url.pathname === "/api/lanes/live") return json(liveLanes());
		if (url.pathname === "/api/target") {
			const fail = (error: unknown) => json({ error: (error as Error).message, ...(error instanceof ForceRequired ? { requires_force: true, context_tokens: error.contextTokens } : {}) }, error instanceof ControlError ? error.status : 400);
			try {
				if (req.method === "GET") return json(await targetView(url.searchParams.get("target") ?? "main"));
				if (req.method === "PUT") {
					const b = await body(req);
					return json(await changeTarget(String(b.target ?? "main"), { model: b.model ? String(b.model) : undefined, thinking: b.thinking ? String(b.thinking) : undefined, compact: b.compact === true, force: b.force === true }));
				}
			} catch (error) {
				return fail(error);
			}
		}
		if (req.method === "POST" && url.pathname === "/api/message") {
			const b = await body(req);
			const files = messageFiles(b.files);
			if (!b.text && !files.length) return json({ error: "text required" }, 400);
			const text = String(b.text ?? "");
			const login = req.headers.get("tailscale-user-login") ?? "local";
			// mode: none (main takes it as the next message, a working lane is steered), "steer" (into the running turn
			// now), "interrupt" (abort the running turn, then send as a new prompt), "queue" (a working target gets it
			// when its turn ends, see queue.ts; an idle target gets it now).
			const mode = b.mode === "steer" || b.mode === "interrupt" || b.mode === "queue" ? b.mode : "default";
			const lane = b.lane ? String(b.lane) : undefined;
			const channel = b.channel === "terminal" ? "terminal" : "web";
			if (mode === "queue" && (lane ? lanes.has(lane) : !parseCommand(text) && !looksLikeCommand(text)) && (lane ? lanes.get(lane)?.status === "working" : orch.status === "working")) {
				const item = enqueue(lane ? `lane:${lane}` : "main", [text, files.length ? attachmentLines(files) : ""].filter(Boolean).join("\n"), login);
				return json({ ok: true, queued: item });
			}
			try {
				await sendWeb({ lane, channel, text, mode: mode === "queue" ? "default" : mode, login, files });
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
			// One body for the whole target: model and/or thinking, and/or its ordered fallback chain (`fallback`).
			try {
				const target = String(b.target ?? "");
				const changed = b.model || b.thinking ? await setModel(target, b.model ? String(b.model) : undefined, b.thinking ? String(b.thinking) : undefined, b.force === true) : undefined;
				const fb = Array.isArray(b.fallback) ? await setFallback(target, b.fallback) : undefined;
				if (!changed && !fb) return fail(new ControlError("model, thinking or fallback required"));
				return json({ ...(changed ?? { ok: true, target, applied: fb!.applied, note: fb!.note }), ...(fb ? { fallback: fb.chain } : {}) });
			} catch (error) {
				return fail(error);
			}
		}
		// Older clients: the chain alone (same as PUT /api/models {target, fallback}).
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
			const before = url.searchParams.get("before") || undefined;
			const lane = source.startsWith("lane:") ? lanes.get(source.slice(5)) : undefined;
			const file = source === "orchestrator" ? orch.sessionFile : lane?.sessionFile;
			// Older pages ("load more" in the terminal view) come from the saved session transcript.
			if (before) return json({ source, history: true, ...(await transcriptPage(file, limit, before)) });
			// The live buffer is memory only (300 items, empty after a gateway restart): the transcript fills in everything
			// older than it, for the orchestrator and lanes alike, so the view survives restarts and can page back with `before`.
			const live = activityItems(source, limit);
			if (!file) return json({ source, items: live, more: false });
			if (live.length >= limit) return json({ source, items: live, more: true });
			const page = await transcriptPage(file, limit - live.length, live[0]?.ts);
			return json({ source, history: page.items.length > 0, items: [...page.items, ...live], more: page.more });
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
				// Ended lanes only, into the trash (lanetrash.ts); 409 when nothing could be deleted, with the reason per lane.
				if (req.method === "GET" && parts[2] === "trash" && parts.length === 3) return json({ items: trashList() });
				if (req.method === "POST" && (parts[2] === "delete" || parts[2] === "restore") && parts.length === 3) {
					const b = await body(req);
					const given = parts[2] === "delete" ? b.names : b.ids;
					const list = (Array.isArray(given) ? given : []).map(String);
					if (!list.length) return json({ error: parts[2] === "delete" ? "names required" : "ids required" }, 400);
					const results = parts[2] === "delete" ? deleteLanes(list) : restoreTrashedLanes(list);
					const ok = results.some(r => r.ok);
					return json({ ok, results, ...(ok ? {} : { error: results.map(r => (r.ok ? "" : r.error)).join("; ") }) }, ok ? 200 : 409);
				}
				if (req.method === "DELETE" && parts[3] === "data" && parts.length === 4) {
					const [r] = deleteLanes([parts[2]]);
					return r!.ok ? json(r) : json({ error: r!.error }, 409);
				}
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
				if (req.method === "POST" && parts[3] === "handover") {
					const text = String((await body(req)).text ?? "").trim();
					handoverLane(parts[2], text || undefined);
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
					void discord.releaseLane(parts[2], lanes.get(parts[2])).catch(e => log(`lane ${parts[2]} thread release failed: ${e}`));
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
// A restart that picked work back up says so in worklog (a self-run system event, not a chat answer); a quiet one
// (nothing replayed, no lane resumed) stays in hub.log and the web restart banner, since back-to-back code restarts
// flooded worklog (owner 2026-10-20). Failures to start go to alert elsewhere.
if (restarted) {
	const at = new Date().toLocaleTimeString("ko-KR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
	const picked = [replayed ? `답 못 한 메시지 ${replayed}개 다시 처리 중` : "", resumedLanes.length ? `이어서 하는 레인: ${resumedLanes.join(", ")}` : ""].filter(Boolean);
	if (picked.length) void out(discord.status.enabled ? "worklog" : "web", `게이트웨이 재시작했어요 (${at} ${tzLabel()}).\n- ${picked.join("\n- ")}`, undefined, { source: "gateway" }).catch(e => log(`restart notice failed: ${e}`));
	else log(`restart at ${at}: nothing interrupted, worklog notice skipped`);
}
// One Claude account for the orchestrator and its lanes (hub/account-sticky.ts). A switch (a limit, the owner pinning
// another account) moves each running OmO process to it at its next idle moment; checked each minute, so a limit is
// followed without waiting for the next spawn.
onAccountSwitch(() => {
	if (runtimeFor("orchestrator").id === "omo") log(`orchestrator account change: ${applyOrchestratorAccount()}`);
	if (runtimeFor("lane").id === "omo") applyLaneAccount();
});
stickyAccount();
setInterval(() => stickyAccount(), 60_000);
startLaneHygiene();
startWorktreeCleanup();
startDataCleanup();
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
syncRoutineSchedules();
startReflection(text => deliver(text), () => orch.sessionFile);
startOmpUpdate(text => void out("worklog", text, undefined, { source: "gateway" }).catch(e => log(`omp update post failed: ${e}`)), restartGateway);
startTokenAudit(alert);
// Settings → 업데이트: the daily check only announces a new dotz version (push + a toast on open pages), never applies it.
void startSelfUpdate(text => {
	pushNotify({ kind: "update", title: "dotz 업데이트", body: text, url: "/#settings", tag: "update" });
	broadcast({ ts: now(), kind: "update_available", source: "gateway", text });
}).catch(e => log(`self-update start failed: ${e}`));
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
function busyNow(): string[] {
	return [orchBusy() ?? "", ...[...lanes.values()].filter(laneBusy).map(l => `lane ${l.name}`)].filter(Boolean);
}
const restartGate = createRestartGate({
	busy: busyNow,
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
// The owner chose '지금 재시작' in settings → 업데이트: running turns are cut (unanswered prompts replay on the next start).
// The short delay lets the HTTP answer reach the page first.
function restartGatewayNow(): string {
	log(`gateway restart now (owner, settings → 업데이트; busy: ${busyNow().join(", ") || "none"})`);
	setTimeout(() => void shutdown(), 500);
	return "gateway restarting now";
}
setGatewayRestart(restartGateway);
