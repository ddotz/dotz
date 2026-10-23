// Dotz hub entry: bun hub/main.ts. Owns Discord, lanes and the event bus; serves the web app + API on
// 127.0.0.1 only. Tailnet access goes through `tailscale serve`, which adds the Tailscale-User-Login header.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, HOST, log, NAME, now, paths, PORT, TZ, tzLabel, writeAtomic } from "./config.ts";
import "./lock.ts"; // must stay right after config.ts: takes the single-instance lock before the other modules load
import { parseCommand, setGatewayRestart } from "./control.ts";
import * as discord from "./discord.ts";
import * as livestatus from "./livestatus.ts";
import { setAskAnswer } from "./askbuttons.ts";
import { startPeerStreams } from "./peer-stream.ts";
import { notify as pushNotify, startPush } from "./push.ts";
import { msg } from "./i18n.ts";
import { broadcast, emit, emitDelivery, sentFiles } from "./events.ts";
import { startDataCleanup, startLaneHygiene, startOrphanReaper, startWorktreeCleanup } from "./hygiene.ts";
import { startLaneIdleStop } from "./laneidle.ts";
import { startMemoryGuard } from "./memguard.ts";
import { setTrashChannels } from "./lanetrash.ts";
import { resolveAllowed } from "./files.ts";
import { approvesBudget, laneBusy, lanes, restoreLanes, sendToLane, setIdleHandler as setLaneIdleHandler, shutdownLanes, startLaneQueue } from "./lanes.ts";
import { setUsageSource, tick as accountTick } from "./account-rules.ts";
import { onSwitch as onAccountSwitch } from "./account-sticky.ts";
import { announceUsedChanges } from "./accounts-api.ts";
import { runtimeFor } from "./runtime/index.ts";
import { applyAccountChange as holdOrchestratorKeepalive, orch, orchBusy, setIdleHandler as setOrchIdleHandler, start as startOrchestrator, stop as stopOrchestrator } from "./orchestrator.ts";
import { queuedTargets } from "./queue.ts";
import { createRestartGate, RESTART_NOTICE_MS } from "./restart.ts";
import { forgetAccountUsage, usageSnapshot } from "./providers.ts";
import { backfillNotices, dropChannelNotices, setConvNameResolver, setLaneTitleResolver, setOrchestratorAvailable, setWatchLabelResolver, updateAvailable, updateResolved } from "./notices.ts";
import { startReflection } from "./reflect.ts";
import { syncFeatureWatches } from "./features.ts";
import { startSchedules, stopSchedules } from "./schedule.ts";
import { syncRoutineSchedules } from "./custom.ts";
import { startHarnessUpdate } from "./update.ts";
import { onUpdateResolved, startSelfUpdate } from "./selfupdate.ts";
import { clearChannel, setupChannel, watchLabel, watchWakeEvent } from "./workchannels.ts";
import { watchLine } from "./watchtext.ts";
import { clearTrackedTimers, runShutdown } from "./shutdown.ts";
import { addWatch, allWatches, approveWatch, isWatchIssue, startWatches, stopWatches, watchChoice } from "./watch.ts";
import { loadPlugins, pluginClaim, pluginThread, startPlugins } from "./plugins.ts";
import { startTokenAudit } from "./token-audit.ts";
import { startZele } from "./zele.ts";
import { mailByKey, mailByThread, mailTarget, postMail, type MailDeps } from "./mail.ts";
import { offerMailDraft } from "../features/reply-drafts/lib/offer.ts";
import { readMailBody } from "../features/reply-drafts/lib/senders.ts";
import { realRunner } from "../features/reply-drafts/lib/tone.ts";
import { startHostSweep } from "./runtime/omo-hosts.ts";
import { compressResponse } from "./compress.ts";
import { sends, send, queue, deliver, lastOwner, receiptNote, laneFailed, out, alert, fileRoots, replayPending, installDelivery, replies } from "./outbound.ts";
import { timeoutMs as outlangTimeoutMs } from "./outlang.ts";
import { inboxText, bursts, intake, flush, answerCommand, QUEUE_SWEEP_MS, flushQueue } from "./intake.ts";
import { laneRelay, installLaneHandlers } from "./lanewire.ts";
import { makeRoute } from "./routes.ts";
import { setFormLink } from "./auth.ts";

installDelivery();
setLaneTitleResolver(name => lanes.get(name)?.title);
setWatchLabelResolver(watchLabel);
setOrchestratorAvailable(() => orch.status !== "stopped" && orch.status !== "rate-limited");
setConvNameResolver(conv => (conv === "main" ? NAME : conv.startsWith("ch:") ? discord.channels.work[conv.slice(3)] ?? discord.channels.threads[conv.slice(3)]?.name : conv.startsWith("mail:") ? mailByKey(conv.slice(5))?.subject : undefined));
// An empty bell on the first start with the store: fill it once from the persisted outbox / inbox (no-op when notices.json has items).
backfillNotices();
installLaneHandlers();

// Result files ([file] lines, discord.ts) go out only when GET /api/file would serve them (inside the roots, or named in a [file] line of a sent message); a file too big to attach goes
// out as that route's download link on the tailnet address (config web.public_url, else tailscale's name + HTTPS port).
discord.setFileResolver(p => resolveAllowed(p, fileRoots(), sentFiles()));
let webBase: string | undefined = (cfg.web as { public_url?: string } | undefined)?.public_url?.replace(/\/+$/, "");
if (!webBase && cfg.web?.tailscale_https_port) {
	const port = cfg.web.tailscale_https_port;
	void (async () => {
		for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
			const dns = await Bun.$`${bin} status --json`.quiet().json().then(s => String(s?.Self?.DNSName ?? "").replace(/\.$/, ""), () => "");
			if (!dns) continue;
			webBase = `https://${dns}${port === 443 ? "" : `:${port}`}`;
			if (cfg.web?.allow_logins?.length) await ensureServe(bin, port, cfg.web.port);
			return;
		}
		log("files: no tailnet address found (set web.public_url); files too big to attach are named, not linked");
	})();
}
// The web app is reachable only through `tailscale serve`. Setup sets it up once, but an upgrade, a scripted install or a
// skipped step left the port with no proxy (2026-10-20, a second Mac). The gateway restores it on start, and never takes
// over a port another service already serves.
async function ensureServe(bin: string, httpsPort: number, localPort: number): Promise<void> {
	const st = await Bun.$`${bin} serve status --json`.quiet().json().catch(() => undefined) as { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | undefined;
	if (!st) return log("web: tailscale serve status unreadable; not touching the serve config");
	if (st.TCP?.[String(httpsPort)]) {
		const proxy = Object.entries(st.Web ?? {}).find(([k]) => k.endsWith(`:${httpsPort}`))?.[1]?.Handlers?.["/"]?.Proxy ?? "";
		if (!new RegExp(`:${localPort}/?$`).test(proxy)) log(`web: tailnet port ${httpsPort} already serves ${proxy || "something else"}; set web.tailscale_https_port to a free port`);
		return;
	}
	const r = await Bun.$`${bin} serve --bg --https=${httpsPort} http://127.0.0.1:${localPort}`.nothrow().quiet();
	log(r.exitCode === 0 ? `web: tailscale serve was missing; opened port ${httpsPort} -> ${localPort}` : `web: tailscale serve failed: ${`${r.stdout}${r.stderr}`.trim().slice(0, 300)}`);
}
setFormLink(() => webBase);
discord.setFileLink(p => (webBase ? `${webBase}/api/file?path=${encodeURIComponent(p)}&dl=1` : undefined));
// Apple's push service rejects a VAPID subject it cannot parse as a contact: the app's own https URL is one.
startPush({ subject: () => webBase ?? "mailto:dotz@example.com" });
startPeerStreams();

setTrashChannels({ take: discord.takeLaneChannel, put: discord.putLaneChannel, remove: discord.deleteChannel });
discord.setLaneReleaseHandler((id, deleted) => void dropChannelNotices(`ch:${id}`, !deleted));
discord.setChannelGoneHandler(id => {
	dropChannelNotices(`ch:${id}`);
	if (clearChannel(id)) log(`work channel ${id} is gone; its logins and monitors were released`);
});

await loadPlugins(DATA_DIR, log);
const onOwner = (m: discord.Incoming) => {
	if (m.id) discord.ack(m.ackChannelId, m.id);
	const target = typeof m.channel === "string" ? m.channel : "lane" in m.channel ? `lane:${m.channel.lane}` : "work" in m.channel ? `ch:${m.channel.work}` : `th:${m.channel.thread}`;
	if (m.id) lastOwner.set(target, m.id);
	const event = { ts: now(), source: "discord", channel: target, message_id: m.id, author: m.author, text: m.content, attachments: m.attachments, reply: m.replyTo };
	if (parseCommand(m.content)) {
		emit("inbox", { ...event, kind: "message" });
		void answerCommand(target, m.content, m.id);
		return;
	}
	if (typeof m.channel === "object" && "thread" in m.channel) {
		const info = discord.threadInfo(m.channel.thread);
		const extra = pluginThread({ thread: m.channel.thread, text: m.content });
		const mail = mailByThread(m.channel.thread);
		const threadEvent = { ...event, channel: `th:${m.channel.thread}`, kind: "message", thread_name: m.channel.name, parent: info?.parentTarget, parent_name: extra?.parentName ?? info?.parentName, ...(mail ? { conv: mailTarget(mail.key) } : {}) };
		emit("inbox", threadEvent);
		intake(extra?.note ? { ...threadEvent, plugin_note: extra.note } : threadEvent, threadEvent.channel, m.id);
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
		const ref = m.id || undefined;
		emit("inbox", { ...event, kind: "lane_message", lane, mid: ref });
		const extra = [m.replyTo ? msg().replyingTo(m.replyTo.author, m.replyTo.content) : "", ...m.attachments.map(a => `[attachment] ${a.name} ${a.url}`)].filter(Boolean).join("\n");
		try {
			if (approvesBudget(lane, m.content)) sendToLane(lane, "/budget-ok");
			const busy = lanes.get(lane) ? laneBusy(lanes.get(lane)!) : false;
			const how = sendToLane(lane, [`[owner via Discord] ${m.content}`, extra].filter(Boolean).join("\n"), ref);
			emitDelivery(target, ref, how);
			livestatus.begin(target, `lane:${lane}`);
			// A busy lane answers when its current step allows; until then the owner sees at once that the message reached it,
			// in the lane's one progress message (no answer is sent before it is ready).
			const receipt = receiptNote(busy && how === "received" ? "steered" : how);
			if (receipt) void discord.progress(target, "progress", receipt).catch(e => log(`lane receipt note failed: ${e}`));
		} catch (error) {
			laneFailed(target, lane, ref, error, m.id);
		}
		return;
	}
	emit("inbox", { ...event, kind: "message" });
	intake({ ...event, kind: "message" }, target, m.id);
};
discord.setClaimHandler(pluginClaim);
discord.connect(onOwner);
// A click on a decision button (hub/askbuttons.ts) is the owner typing the answer in that channel: the same inbound path.
setAskAnswer((target, content) => {
	const id = target.slice(target.indexOf(":") + 1);
	const channel = target.startsWith("lane:") ? { lane: id } : target.startsWith("ch:") ? { work: id, name: discord.channels.work[id] ?? id, first: false } : target.startsWith("th:") ? { thread: id, name: discord.channels.threads[id]?.name ?? id } : (target as "chat");
	onOwner({ id: "", channelId: "", ackChannelId: "", channel, author: "owner", content, attachments: [] });
});
await discord.ensureChannels().catch(e => {
	discord.status.error = String(e);
	log(`ensureChannels failed: ${e}`);
});
void discord.syncProfile().catch(e => log(`syncProfile failed: ${e}`));

// Each mail is a conversation (hub/mail.ts): zele here and outside posters through POST /api/mail (hub/routes.ts) share these.
let mailChannelId: string | undefined;
const mailDeps = (): MailDeps => ({
	createThread: discord.createThread,
	send: (target, text) => discord.send(target, text),
	mailChannel: async () => {
		if (!discord.status.enabled) return undefined;
		if (mailChannelId && discord.channels.work[mailChannelId]) return mailChannelId;
		const mailName = msg().channelNames.mail;
		const found = Object.entries(discord.channels.work).find(([, n]) => n === mailName)?.[0];
		const id = found ?? (await discord.createWorkChannel(mailName)).id;
		if (!found) setupChannel({ channel: id, purpose: "메일 수신함: 메일마다 스레드 하나(웹에서는 대화 하나), 답장은 확인받은 뒤에만" }, mailName, "");
		return (mailChannelId = id);
	},
	discordOn: discord.status.enabled,
	emit: event => emit("inbox", event as Parameters<typeof emit>[1]),
	wake: (event, target) => deliver(inboxText(event), { target }),
	offerDraft: m =>
		void offerMailDraft(m, { send: (target, text) => out(target, text), readBody: (source, id) => readMailBody(source, id, realRunner), log }).then(r => r === "failed" && log(`mail ${m.key}: reply draft not offered`)),
});

void startZele({
	alert,
	mail: async m => {
		await postMail({ source: "zele", id: m.id, from: m.from, to: m.to, subject: m.subject.trim() || "(제목 없음)", summary: m.snippet, wake: true }, mailDeps()).catch(e => log(`zele: mail ${m.id} not posted: ${(e as Error).message}`));
	},
	brief: text => {
		const target = !discord.status.enabled ? "web" : discord.channels.brief ? "brief" : "chat";
		const event = { ts: now(), kind: "schedule", source: "zele", id: "zele", channel: target, text };
		emit("inbox", event);
		deliver(inboxText(event), { target });
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

setOrchIdleHandler(() => {
	queue.settleTurn();
	queue.redeliverSteered();
	laneRelay.flush();
	flushQueue("main");
});
setLaneIdleHandler(name => flushQueue(`lane:${name}`));
// Safety net for what the idle hooks miss: items kept over a gateway restart, a lane that went idle without a turn end.
setInterval(() => queuedTargets().forEach(flushQueue), QUEUE_SWEEP_MS);

const route = makeRoute({ busyNow, restartGateway, restartGatewayNow, mailDeps });
// Page, script, styles and JSON answers go out gzipped (hub/compress.ts); /api/file keeps its exact bytes and Content-Length.
const server = Bun.serve({
	hostname: HOST,
	port: PORT,
	idleTimeout: 0,
	async fetch(req) {
		const res = await route(req);
		return new URL(req.url).pathname === "/api/file" ? res : compressResponse(req, res);
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
	const picked = [replayed ? `답하지 못한 메시지 ${replayed}개를 다시 처리하고 있어요` : "", resumedLanes.length ? `이어서 하는 세션: ${resumedLanes.join(", ")}` : ""].filter(Boolean);
	if (picked.length) void out(discord.status.enabled ? "worklog" : "web", `게이트웨이를 다시 시작했어요 (${at} ${tzLabel()}).\n- ${picked.join("\n- ")}`, undefined, { source: "gateway" }).catch(e => log(`restart notice failed: ${e}`));
	else log(`restart at ${at}: nothing interrupted, worklog notice skipped`);
}
// One Claude account for the orchestrator and its lanes (hub/account-sticky.ts, the owner's rules in hub/account-rules.ts).
// A switch needs no restart: every running OmO process (workers included) asks POST /api/accounts/check at the start of its
// next turn and pins the answer in its own environment. Checked each minute, so a limit or a rule's time window is followed
// without waiting for a turn.
onAccountSwitch(s => {
	forgetAccountUsage(s.to);
	if (runtimeFor("orchestrator").id === "omo") holdOrchestratorKeepalive();
});
// The account requests really use changed (a limit, the OmO pin, a rule): one alert saying from which to which and why; the
// owner's own pick in the web stays quiet.
announceUsedChanges();
setUsageSource(usageSnapshot);
void accountTick().catch(e => log(`account check failed: ${(e as Error).message}`));
setInterval(() => void accountTick().catch(e => log(`account check failed: ${(e as Error).message}`)), 60_000);
startLaneHygiene();
startWorktreeCleanup();
startDataCleanup();
startMemoryGuard((key, text) => {
	if (key === "orchestrator") return alert(`${NAME}: ${text}`);
	void send(key, text).catch(e => log(`memory guard notice to ${key} failed: ${e}`));
});
startLaneIdleStop();
startLaneQueue();
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
startHarnessUpdate(text => void out("worklog", text, undefined, { source: "gateway" }).catch(e => log(`harness update post failed: ${e}`)), restartGateway, alert);
startTokenAudit(alert);
// Settings → 업데이트: the daily check announces a new dotz version (push + a toast on open pages + one bell item); with self_update.auto_apply
// on it applies it instead (worklog on success, alert with a choice block otherwise) and restarts through the idle restart gate.
onUpdateResolved(updateResolved);
void startSelfUpdate(text => {
	updateAvailable(text);
	pushNotify({ kind: "update", title: "dotz 업데이트", body: text, url: "/#settings", tag: "update" });
	broadcast({ ts: now(), kind: "update_available", source: "gateway", text });
}, undefined, {
	worklog: text => void out("worklog", text, undefined, { source: "gateway" }).catch(e => log(`self-update worklog post failed: ${e}`)),
	alert,
	restartIdle: restartGateway,
}).catch(e => log(`self-update start failed: ${e}`));
startWatches((w, reason, output) => {
	if (w.to === "orchestrator") {
		const event = watchWakeEvent(w, reason, output);
		emit("inbox", event);
		if (!w.channels?.length) return deliver(inboxText(event));
		const [first, ...others] = w.channels;
		for (const c of others) void out(`ch:${c}`, watchLine(event.label, reason, output, { note: `(처리는 #${discord.channels.work[first] ?? first}에서)` }).slice(0, 1900), undefined, { source: "gateway" }).catch(() => undefined);
		return deliver(inboxText(event), { target: `ch:${first}` });
	}
	// A failing, stopped or unapproved check is an issue: it goes to alert with a choice block, whatever `to` the watch has.
	const issue = isWatchIssue(reason);
	const label = watchLabel(w.name);
	void out(issue ? "alert" : w.to, watchLine(label, reason, output).slice(0, issue ? 1500 : 1900) + (issue ? `\n${watchChoice(label)}` : ""), undefined, { source: "gateway" }).catch(e => log(`watch ${w.name} send failed: ${e}`));
});
syncFeatureWatches();
startPlugins({
	dataDir: DATA_DIR,
	log,
	postTo: discord.postTo,
	ack: discord.ack,
	ensureWatch: spec => {
		if (allWatches().find(w => w.name === spec.name)?.command !== String(spec.command ?? "").trim()) addWatch(spec, existsSync(paths.rules) ? readFileSync(paths.rules, "utf8") : "");
	},
	approveWatch: name => void approveWatch(name),
});
writeAtomic(paths.pid, String(process.pid));
log(`hub listening on 127.0.0.1:${server.port} as ${NAME} (discord ${discord.status.enabled ? "on" : discord.dryRunReason ? `off, dry run: ${discord.dryRunReason}; DOTZ_ALLOW_LIVE=1 connects` : "off"})`);
for (const sig of ["SIGTERM", "SIGINT"] as const)
	process.on(sig, () => {
		log(`hub ${sig}`);
		void shutdown();
	});

// Fixed order, one overall 10 s deadline (see shutdown.ts), longer by one output-language timeout while a reply is still in its
// rewrite. Messages still coalescing go into the ledger before exit, so the next start replays them; the orchestrator's session file is saved as it runs, stop() only keeps it from respawning.
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
		// A reply still in its rewrite is waited for, then lands with the original text in the outbox or the unsent ledger.
		{ name: "pending replies", run: async () => void (await replies.flush(outlangTimeoutMs() + 1000)) },
		{ name: "discord connection", run: () => discord.disconnect() },
		{ name: "watch and schedule timers", run: () => (stopWatches(), stopSchedules(), clearTrackedTimers()) },
		{ name: "others", run: () => void 0 },
	], 10_000 + (replies.size() ? outlangTimeoutMs() + 2000 : 0));
}

// Restart the gateway the way 오모냥's herdr-restart does: wait until the orchestrator and every lane are idle, task
// workers included, then exit; launchd (KeepAlive) starts the new code. Called during an orchestrator turn, it waits for
// that turn to end, so the answer goes out first. restart.ts: a busy lane is never killed, requests are coalesced.
function busyNow(): string[] {
	// The orchestrator's background task workers die with its process: a request deferred to one ([later]) holds the restart.
	const workers = queue.waitingOnWorkers() ? "orchestrator background workers" : "";
	return [orchBusy() ?? "", workers, replies.size() ? "reply" : "", ...[...lanes.values()].filter(laneBusy).map(l => `lane ${l.name}`)].filter(Boolean);
}
const restartGate = createRestartGate({
	busy: busyNow,
	collecting: () => bursts.size > 0,
	startedAt: Date.now(),
	minGapMs: Number(process.env.DOTZ_RESTART_MIN_GAP_MS ?? 5 * 60_000),
	noticeAfterMs: RESTART_NOTICE_MS,
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
