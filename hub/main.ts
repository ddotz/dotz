// Dotz hub entry: bun hub/main.ts. Owns Discord, lanes and the event bus; serves the web app + API on
// 127.0.0.1 only. Tailnet access goes through `tailscale serve`, which adds the Tailscale-User-Login header.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, DATA_DIR, HUB_TOKEN, log, NAME, now, OMP, paths, PORT } from "./config.ts";
import { compactTarget, ControlError, contextView, ForceRequired, looksLikeCommand, modelsView, parseCommand, providersView, runCommand, setGatewayRestart, setModel } from "./control.ts";
import { subagentDetail, subagentLists, transcriptItems } from "./activity.ts";
import * as discord from "./discord.ts";
import { activityItems, emit, historyEvents, recentEvents, sseResponse } from "./events.ts";
import { abortLane, approvesBudget, laneBusy, lanes, laneSummary, launch, restartLane, restoreLanes, resumeByName, sendToLane, setProgressHandler, setReportHandler, shutdownLanes, stopLane } from "./lanes.ts";
import { abort as abortOrchestrator, deliver as deliverToOrchestrator, orch, restart as restartOrchestrator, setAlertHandler, setAnswerHandlers, start as startOrchestrator, steer as steerOrchestrator } from "./orchestrator.ts";
import { cancelLogin, completeLogin, loginStatus, logoutProvider, quota, saveProviderKey, startLogin } from "./providers.ts";
import { startReflection } from "./reflect.ts";
import { addSchedule, listSchedules, removeSchedule, startSchedules } from "./schedule.ts";
import { channelContext, clearChannel, listSetups, setupChannel } from "./workchannels.ts";
import { addWatch, allWatches, listWatches, removeWatch, startWatches } from "./watch.ts";
import { startZele } from "./zele.ts";

const WEB = join(import.meta.dir, "..", "web", "index.html");
const ALLOW = new Set((cfg.web?.allow_logins ?? []).map(s => s.toLowerCase()));
const terminals = new Map<string, { cwd?: string; at: string }>();
// Every delivered prompt remembers where its answer goes; prompts are matched back by their text as omp starts them
// (FIFO, so identical texts still pair in order). Unanswered prompts are kept on disk (오모냥's `last_handled`: a
// message counts as handled when it is answered, not when it arrives), so a restart mid-turn replays them on boot.
type Prompt = { key: string; text: string; at: number; target?: string; replyTo?: string; sent: { target: string; text: string }[]; done?: boolean };
const prompts: Prompt[] = [];
let current: Prompt | undefined;
const PENDING = join(DATA_DIR, "pending.json");
const REPLAY = "[dotz gateway] The gateway restarted before you answered this. Handle it now; it may be partly done already, so check before repeating an action.";
// Read before anything in this process delivers (and rewrites the file); replayed once the orchestrator starts.
let unanswered: { text: string; at?: number; target?: string; replyTo?: string }[] = [];
try {
	if (existsSync(PENDING)) unanswered = JSON.parse(readFileSync(PENDING, "utf8"));
} catch {}
function savePending(): void {
	const open = [...(current && !current.done ? [current] : []), ...prompts].map(({ text, at, target, replyTo }) => ({ text, at, target, replyTo }));
	writeFileSync(PENDING, `${JSON.stringify(open, null, 2)}\n`);
}

function deliver(text: string, reply?: { target: string; replyTo?: string }): void {
	if (reply) discord.typing(reply.target);
	prompts.push({ key: text.slice(0, 300), text, at: Date.now(), target: reply?.target, replyTo: reply?.replyTo, sent: [] });
	if (prompts.length > 200) prompts.splice(0, prompts.length - 200);
	savePending();
	deliverToOrchestrator(text);
}

const isLocal = (target: string) => target === "web" || target === "terminal";
function out(target: string, text: string, replyTo?: string, extra: Record<string, unknown> = {}): Promise<{ delivered: boolean; reason?: string }> {
	emit("outbox", { ts: now(), kind: "out", source: "orchestrator", target, text, reply_to: replyTo ?? null, ...extra });
	lastPost.set(target, Date.now());
	if (isLocal(target)) return Promise.resolve({ delivered: true });
	return discord.send(target, text, replyTo);
}

// No owner message goes unanswered for long (owner 2026-10-17: "대답 누락하면 안되는데"). If nothing was posted to the
// asking channel REPLY_WAIT_MS after a message, a working orchestrator is steered to post a progress note there now.
// A lane message gets no gateway notice (owner 2026-10-17: no canned "받았어요 ... 끝나는 대로" replies): the eyes
// reaction is the receipt and the lane answers it in its turn's report.
const REPLY_WAIT_MS = 60_000;
const lastPost = new Map<string, number>();
function expectReply(target: string): void {
	if (isLocal(target)) return;
	const since = Date.now();
	setTimeout(() => {
		if ((lastPost.get(target) ?? 0) >= since) return;
		steerOrchestrator(`[dotz gateway] The owner has waited ${REPLY_WAIT_MS / 1000}s in ${target} with nothing posted there. Post a short progress note in ${target} now (dotz_send update_key "progress": what you are doing, when the answer comes), then carry on.`);
	}, REPLY_WAIT_MS);
}

// The final answer of a turn goes to every channel that asked and did not already get a dotz_send reply.
setAnswerHandlers(
	text => {
		const i = prompts.findIndex(p => text.includes(p.key));
		current = i >= 0 ? prompts.splice(i, 1)[0] : undefined;
		savePending();
	},
	text => {
		const p = current;
		if (p && !p.done) {
			p.done = true;
			savePending();
		}
		const t = text.trim();
		// Parts sent early with dotz_send do not replace the answer; skip it only when it repeats something already sent.
		if (!p?.target || t === "-" || p.sent.some(s => s.target === p.target && s.text.includes(t))) return;
		p.sent.push({ target: p.target, text: t });
		void out(p.target, text, p.replyTo, { auto: true }).catch(e => log(`reply to ${p.target} failed: ${e}`));
	},
);

// Chat is the hub over every work channel: each chat turn carries a short directory so the orchestrator can route the
// work into the channel it belongs to (or split a growing thread of work into a new one).
function workDirectory(): string {
	const setups = new Map(listSetups().map(s => [s.channel, s.purpose]));
	const list = Object.entries(discord.channels.work).slice(0, 20).map(([id, name]) => `#${name} ch:${id}${setups.has(id) ? ` (${setups.get(id)!.slice(0, 60)})` : ""}`);
	return `(work channels: ${list.length ? list.join("; ") : "none yet"})`;
}

function inboxText(e: Record<string, any>): string {
	if (e.kind === "lane_report") return `[dotz inbox] lane report from ${e.lane}:\n${e.text}`;
	if (e.kind === "watch") {
		const ch = e.channels?.[0];
		if (!ch) return `[dotz inbox] watch ${e.watch} ${e.reason} (no one is waiting for this turn; tell the owner with dotz_send only if it matters):\n${e.text}`;
		return `[dotz inbox] watch ${e.watch} ${e.reason} for work channel ch:${ch} (your final answer goes there; reply "-" alone to post nothing):\n${e.text}\n${channelContext(ch)}`;
	}
	if (e.kind === "mail") return `[dotz inbox] new mail for work channel ch:${e.channel_id} (your final answer goes there; open one thread per mail titled "<sender> - <subject>" with dotz_channel thread and put the summary there; if a person wants something from the owner, brief them with a suggested reply; read or act with zele, sending only after the owner's OK; reply "-" alone to post nothing):\n${e.text}\n${channelContext(e.channel_id)}`;
	if (e.kind === "schedule") return `[dotz inbox] scheduled (${e.id}${e.every ? `, every ${e.every} min` : ""}) - do it now; your final answer goes to ${e.channel}:\n${e.text}`;
	const where = e.thread_name ? ` (thread "${e.thread_name}" in #${e.parent_name}; your answer goes into the thread)` : e.channel_name ? ` #${e.channel_name}` : "";
	const lines = [`[dotz inbox] ${e.channel}${where}${e.message_id ? ` msg=${e.message_id}` : ""} from ${e.author ?? "owner"}`];
	if (e.first) lines.push(`(new work channel #${e.channel_name}: the owner hands out work by channel. Keep this channel's work and reports here. If its work needs a login kept alive or something checked over time, set that up for this channel with dotz_channel setup yourself.)`);
	const parts: Record<string, any>[] = e.parts ?? [e];
	if (parts.length > 1) lines.push(`(sent as ${parts.length} messages in a row; read them together as one request)`);
	for (const p of parts) {
		if (p.reply) lines.push(`(replying to ${p.reply.author}: "${p.reply.content}")`);
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
	deliver(inboxText(merged), { target, replyTo: b.replyTo });
	expectReply(target);
}

function alert(text: string): void {
	emit("outbox", { ts: now(), kind: "out", source: "gateway", target: "alert", text });
	void discord.send("alert", text).catch(e => log(`alert send failed: ${e}`));
}
setAlertHandler(alert);

function rateLimitNotice(target: string, replyTo?: string): void {
	if (orch.status !== "rate-limited") return;
	const until = new Date(orch.rateLimitedUntil);
	const at = Number.isNaN(until.getTime()) ? "한도가 풀리면" : `${until.toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" })}쯤`;
	void out(target, `지금 사용량 한도로 멈춰 있어요. ${at} 이어서 처리할게요.`, replyTo, { source: "gateway" }).catch(() => undefined);
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

// One evolving status per (channel, key) is a single message edited in place (Dori: grow one message only when it is one
// evolving answer). A progress note is not the answer, so the final reply to that channel still goes out.
const progressIds = new Map<string, string>();
async function progress(target: string, key: string, text: string, replyTo?: string): Promise<{ delivered: boolean; reason?: string; edited?: boolean }> {
	const k = `${target}|${key}`;
	emit("outbox", { ts: now(), kind: "out", source: "orchestrator", target, text, update_key: key });
	if (isLocal(target)) return { delivered: true };
	const prev = progressIds.get(k);
	if (prev) return { ...(await discord.edit(target, prev, text)), edited: true };
	const r = await discord.send(target, text, replyTo, { single: true });
	if (r.ids?.[0]) progressIds.set(k, r.ids[0]);
	return r;
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
async function budgetProblem(): Promise<string | undefined> {
	const r = await Bun.$`${OMP} usage --json -p anthropic`.nothrow().quiet().catch(() => undefined);
	if (!r || r.exitCode !== 0) return undefined;
	try {
		const limits: { id: string; amount?: { remaining?: number } }[] = JSON.parse(r.stdout.toString()).reports?.find((x: any) => x.provider === "anthropic")?.limits ?? [];
		const five = limits.find(l => l.id === "anthropic:5h")?.amount?.remaining;
		const week = limits.find(l => l.id === "anthropic:7d")?.amount?.remaining;
		// Same rule as 오모냥: the 5h window gates (15% assumed use, 10% kept); the week blocks only when nearly gone.
		if (typeof five === "number" && five < 25) return `5h window ${five}% left`;
		if (typeof week === "number" && week < 3) return `7d window ${week}% left`;
	} catch {
		return undefined;
	}
	return undefined;
}

setReportHandler((lane, text) => {
	const event = { ts: now(), kind: "lane_report", source: `lane:${lane.name}`, lane: lane.name, text: text.slice(0, 1500) };
	emit("inbox", event);
	deliver(inboxText(event));
	lastPost.set(`lane:${lane.name}`, Date.now());
	void discord.send(`lane:${lane.name}`, text.slice(0, 1800)).catch(e => log(`lane report send failed: ${e}`));
});

setProgressHandler((lane, text) => {
	emit("outbox", { ts: now(), kind: "out", source: `lane:${lane.name}`, target: `lane:${lane.name}`, text: `진행 중: ${text.slice(0, 900)}` });
	lastPost.set(`lane:${lane.name}`, Date.now());
	void discord.send(`lane:${lane.name}`, `진행 중: ${text.slice(0, 900)}`).catch(e => log(`lane progress send failed: ${e}`));
});

discord.setChannelGoneHandler(id => {
	if (clearChannel(id)) log(`work channel ${id} is gone; its logins and monitors were released`);
});

discord.connect(m => {
	discord.ack(m.channelId, m.id);
	const target = typeof m.channel === "string" ? m.channel : "lane" in m.channel ? `lane:${m.channel.lane}` : "work" in m.channel ? `ch:${m.channel.work}` : `th:${m.channel.thread}`;
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
		const extra = [m.replyTo ? `(replying to ${m.replyTo.author}: "${m.replyTo.content}")` : "", ...m.attachments.map(a => `[attachment] ${a.name} ${a.url}`)].filter(Boolean).join("\n");
		try {
			if (approvesBudget(lane, m.content)) sendToLane(lane, "/budget-ok");
			sendToLane(lane, [`[owner via Discord] ${m.content}`, extra].filter(Boolean).join("\n"));
		} catch (error) {
			void discord.send(target, `레인 ${lane}을(를) 이어갈 수 없어요 (${(error as Error).message}). 대화 채널에서 다시 맡겨 주세요.`, m.id);
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
		const found = Object.entries(discord.channels.work).find(([, n]) => n === "메일")?.[0];
		const id = found ?? (await discord.createWorkChannel("메일")).id;
		if (!found) setupChannel({ channel: id, purpose: "메일 수신함 (zele): 새 메일은 메일마다 스레드로 요약, 답장은 주인 OK 후" }, "메일", "");
		return id;
	},
});

// First start of a fresh install: the bot speaks first (greeting) and offers the read-only onboarding, once.
const GREETED = join(DATA_DIR, ".greeted");
const restarted = existsSync(GREETED);
if (!restarted) {
	writeFileSync(GREETED, `${now()}\n`);
	const target = discord.status.enabled ? "chat" : "web";
	deliver(`[dotz gateway] First start of this install. Speak first in ${target}: greet the owner in a few short messages as ${NAME} (who you are, what you can do: channels per project, monitoring, lanes, schedules). Then ask once whether you may learn their setup, read-only: Aside's memory of them (aside memory list / search: who they are, people, projects, sites) and the sites they are signed in to, coding agent sessions and their projects, tools and CLIs in use, logs and schedules on this machine. On yes, do it with read-only workers, keep one progress message updated in place (dotz_send update_key "onboarding"), record what you learn in memory as you go, and end with a short summary of what you learned and what is still missing. On no, just say how to start.`, { target });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (!authorized(req)) return new Response("forbidden", { status: 403 });
		const parts = url.pathname.split("/").filter(Boolean);
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
			const login = req.headers.get("tailscale-user-login") ?? "local";
			// mode: "queue" (default: main waits for its current turn, a working lane is steered), "steer" (into the running
			// turn now), "interrupt" (abort the running turn, then send as a new prompt).
			const mode = b.mode === "steer" || b.mode === "interrupt" ? b.mode : "queue";
			if (b.lane) {
				const name = String(b.lane);
				emit("inbox", { ts: now(), kind: "lane_message", source: "web", author: login, lane: name, text: b.text, ...(mode === "queue" ? {} : { mode }) });
				try {
					if (approvesBudget(name, String(b.text ?? ""))) sendToLane(name, "/budget-ok");
					if (mode === "interrupt" && lanes.get(name)?.status === "working") {
						abortLane(name);
						// Let the aborted turn end first, or the message would be steered into it.
						for (let i = 0; i < 50 && lanes.get(name)?.status === "working"; i++) await Bun.sleep(200);
					}
					sendToLane(name, `[owner via web] ${b.text}`);
				} catch (error) {
					return json({ error: (error as Error).message }, 409);
				}
				return json({ ok: true });
			}
			const channel = b.channel === "terminal" ? "terminal" : "web";
			const event = { ts: now(), kind: "message", source: channel, channel, author: login, text: String(b.text), ...(mode === "queue" ? {} : { mode }) };
			emit("inbox", event);
			if (parseCommand(event.text) || looksLikeCommand(event.text)) void answerCommand(channel, event.text);
			else if (mode === "steer" && orch.status === "working") {
				steerOrchestrator(inboxText(event));
				expectReply(channel);
			} else {
				if (mode === "interrupt" && orch.status === "working") abortOrchestrator();
				intake(event, channel);
			}
			return json({ ok: true });
		}
		if (req.method === "POST" && url.pathname === "/api/send") {
			const b = await body(req);
			const target = String(b.target ?? "chat");
			if (b.update_key) {
				lastPost.set(target, Date.now());
				try {
					return json(await progress(target, String(b.update_key), String(b.text ?? ""), b.reply_to));
				} catch (error) {
					return json({ delivered: false, reason: (error as Error).message }, 502);
				}
			}
			current?.sent.push({ target, text: String(b.text ?? "").trim() });
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
		if (req.method === "GET" && url.pathname === "/api/models") return json(await modelsView());
		if (req.method === "PUT" && url.pathname === "/api/models") {
			const b = await body(req);
			try {
				return json(await setModel(String(b.target ?? ""), b.model ? String(b.model) : undefined, b.thinking ? String(b.thinking) : undefined, b.force === true));
			} catch (error) {
				return fail(error);
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
					const t = await discord.createThread(String(b.channel ?? "chat"), String(b.name ?? "").trim() || "thread");
					if (b.text) await out(`th:${t.id}`, String(b.text), undefined, { source: "orchestrator" });
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
				if (req.method === "GET" && parts.length === 2) return json(laneSummary());
				if (req.method === "POST" && parts.length === 2) {
					const b = await body(req);
					if (/fable/i.test(String(b.model ?? "")) && !b.owner_asked_for_fable) return json({ error: "Fable lanes run only when the owner explicitly asks for Fable. Use the default model, or relaunch with owner_asked_for_fable=true after they ask." }, 409);
					const tight = b.force ? undefined : await budgetProblem();
					if (tight) return json({ error: `budget gate: ${tight}. Ask the owner (now / after reset / smaller); relaunch with force=true only after they say now.` }, 409);
					const lane = launch(String(b.name), String(b.cwd), String(b.brief ?? ""), b.model, b.worker_model ? String(b.worker_model) : undefined);
					const channel = await discord.laneChannel(lane.name, b.title ? String(b.title) : undefined).catch(e => {
						log(`lane channel failed: ${e}`);
						return undefined;
					});
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
				if (req.method === "POST" && parts[3] === "abort") {
					abortLane(parts[2]);
					return json({ ok: true });
				}
				if (req.method === "DELETE" && parts.length === 3) {
					stopLane(parts[2]);
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
const resumedLanes = restoreLanes();
for (const name of resumedLanes) void discord.send(`lane:${name}`, "게이트웨이가 재시작돼서 멈췄던 작업을 이어서 하고 있어요.").catch(e => log(`lane resume notice failed: ${e}`));
// Every start after the first one says so in chat, with what it picked back up, so a restart is never silent.
if (restarted) {
	const at = new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" });
	const picked = [replayed ? `답 못 한 메시지 ${replayed}개 다시 처리 중` : "", resumedLanes.length ? `이어서 하는 레인: ${resumedLanes.join(", ")}` : ""].filter(Boolean);
	void out(discord.status.enabled ? "chat" : "web", `게이트웨이 재시작했어요 (${at} KST).${picked.length ? `\n- ${picked.join("\n- ")}` : " 끊긴 작업은 없어요."}`, undefined, { source: "gateway" }).catch(e => log(`restart notice failed: ${e}`));
}
startLaneHygiene();
startSchedules(s => {
	const channel = discord.status.enabled ? "chat" : "web";
	const event = { ts: now(), kind: "schedule", source: "schedule", channel, id: s.id, every: s.every_minutes, text: s.text };
	emit("inbox", event);
	deliver(inboxText(event), { target: channel });
});
startReflection(text => deliver(text), () => orch.sessionFile);
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
writeFileSync(paths.pid, String(process.pid));
log(`hub listening on 127.0.0.1:${server.port} as ${NAME} (discord ${discord.status.enabled ? "on" : "off"})`);
for (const sig of ["SIGTERM", "SIGINT"] as const)
	process.on(sig, () => {
		log(`hub ${sig}`);
		shutdown();
	});

// Messages still coalescing go into the ledger before exit, so the next start replays them.
function shutdown(): never {
	for (const target of [...bursts.keys()]) flush(target);
	shutdownLanes();
	process.exit(0);
}

// Prompts that were delivered but never answered (the gateway stopped mid-turn) are delivered again on start.
// Returns how many prompts were replayed.
function replayPending(): number {
	const fresh = unanswered.filter(p => p.text && Date.now() - (p.at ?? 0) < 12 * 3600_000);
	unanswered = [];
	if (fresh.length) log(`replaying ${fresh.length} unanswered prompt(s) from before the restart`);
	for (const p of fresh) deliver(p.text.startsWith(REPLAY) ? p.text : `${REPLAY}\n${p.text}`, p.target ? { target: p.target, replyTo: p.replyTo } : undefined);
	return fresh.length;
}

// Restart the gateway the way 오모냥's herdr-restart does: wait until the orchestrator and every lane are idle, task
// workers included (at most 20 min), then exit; launchd (KeepAlive) starts the new code. Called during an orchestrator
// turn, it waits for that turn to end, so the answer goes out first.
let draining = false;
function restartGateway(): string {
	if (draining) return "gateway restart is already waiting for idle";
	draining = true;
	const until = Date.now() + 20 * 60_000;
	const busy = () => [orch.status === "working" || orch.status === "starting" ? "orchestrator" : "", ...[...lanes.values()].filter(laneBusy).map(l => `lane ${l.name}`)].filter(Boolean);
	const tick = () => {
		const b = busy();
		if ((b.length || bursts.size) && Date.now() < until) return void setTimeout(tick, 2000);
		log(`gateway restart${b.length ? ` (still busy after 20 min: ${b.join(", ")})` : ""}`);
		shutdown();
	};
	setTimeout(tick, 2000);
	const waiting = busy();
	return waiting.length ? `gateway restarts when idle (waiting for: ${waiting.join(", ")}; at most 20 min)` : "gateway restarting";
}
setGatewayRestart(restartGateway);
