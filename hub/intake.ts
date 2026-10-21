// Inbound path of the hub: inbox text, burst coalescing (intake/flush), web sends and the queued-message sweep. Split out of main.ts.
import { cfg, COALESCE_MAX_MS, DEFAULTS, log, now } from "./config.ts";
import { kdbConfig, mailThreadNote } from "./kdb.ts";
import { limitsCard, looksLikeCommand, parseCommand, runCommand } from "./control.ts";
import * as discord from "./discord.ts";
import * as livestatus from "./livestatus.ts";
import { msg } from "./i18n.ts";
import { emit, emitDelivery } from "./events.ts";
import { attachmentLines, type Upload } from "./files.ts";
import { abortLane, approvesBudget, lanes, ownerNotes, sendToLane } from "./lanes.ts";
import { accountView, readPool } from "./account-sticky.ts";
import { readAliases } from "./account-alias.ts";
import { accountAnswer, accountAsk } from "./accounts-api.ts";
import { abort as abortOrchestrator, orch } from "./orchestrator.ts";
import { drain, restore } from "./queue.ts";
import { anthropicUsage } from "./providers.ts";
import { withTurnLanguage } from "./outlang.ts";
import { channelContext, listSetups } from "./workchannels.ts";
import { deliver, awaiting, refOf, newMid, laneFailed, out, expectReply, rateLimitNotice } from "./outbound.ts";

// Chat is the hub over every work channel: each chat turn carries a short directory so the orchestrator can route the
// work into the channel it belongs to (or split a growing thread of work into a new one).
function workDirectory(): string {
	const setups = new Map(listSetups().map(s => [s.channel, s.purpose]));
	const list = Object.entries(discord.channels.work).slice(0, 20).map(([id, name]) => `#${name} ch:${id}${setups.has(id) ? ` (${setups.get(id)!.slice(0, 60)})` : ""}`);
	return msg().workChannels(list);
}

export function inboxText(e: Record<string, any>): string {
	return withTurnLanguage(inboxBody(e));
}

const kdb = kdbConfig((cfg as any).kdb);

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
	const lines = [`[dotz inbox] ${e.channel}${where}${e.message_id ?? e.mid ? ` msg=${e.message_id ?? e.mid}` : ""} from ${e.author ?? "owner"}`];
	if (e.first) lines.push(m.inboxFirst(e.channel_name));
	const parts: Record<string, any>[] = e.parts ?? [e];
	if (parts.length > 1) lines.push(m.inboxBurst(parts.length));
	for (const p of parts) {
		if (p.reply) lines.push(m.replyingTo(p.reply.author, p.reply.content));
		for (const a of p.attachments ?? []) lines.push(`[attachment] ${a.name}${a.type ? ` (${a.type})` : ""} ${a.url}`);
		lines.push(p.text);
	}
	if (kdb && e.kdb_mail !== undefined) lines.push(mailThreadNote(kdb, e.kdb_mail));
	const home = e.parent?.startsWith("ch:") ? e.parent : e.channel;
	const ctx = home?.startsWith("ch:") ? channelContext(home.slice(3)) : "";
	if (ctx) lines.push(ctx);
	if (["chat", "dm", "web", "worklog", "alert", "brief"].includes(e.channel)) lines.push(workDirectory());
	return lines.join("\n");
}

// Owners often send one thought as several short messages. Messages from the same channel that arrive within
// COALESCE_MS of each other (at most COALESCE_MAX_MS after the first) become one turn, the way 오모냥's inbox monitor
// batched lines that arrived together.
const COALESCE_MS = Number((cfg as any).gateway?.coalesce_ms ?? DEFAULTS.coalesce_ms);
export const bursts = new Map<string, { events: Record<string, any>[]; replyTo?: string; first: number; timer?: ReturnType<typeof setTimeout> }>();

export function intake(event: Record<string, any>, target: string, replyTo?: string): void {
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

export function flush(target: string): void {
	const b = bursts.get(target);
	if (!b) return;
	bursts.delete(target);
	const head = b.events[0];
	if (b.events.length === 1 && LIMITS_ASK.test(String(head.text)) && !head.attachments?.length) return void limitsAnswer(target, b.replyTo);
	const ask = b.events.length === 1 && !head.attachments?.length ? accountAsk(String(head.text ?? ""), readPool()?.names ?? [], readAliases()) : undefined;
	if (ask) return void accountChatAnswer(target, ask, b.replyTo);
	rateLimitNotice(target, b.replyTo);
	const merged = b.events.length > 1 ? { ...head, message_id: refOf(b.events.at(-1)!), parts: b.events } : head;
	const how = orch.status === "working" ? "steered" : orch.status === "rate-limited" ? "held" : "received";
	deliver(inboxText(merged), { target, replyTo: b.replyTo, owner: true });
	expectReply(target);
	const refs = b.events.flatMap(e => refOf(e) ?? []);
	for (const ref of refs) emitDelivery(target, ref, how);
	if (refs.length) awaiting.set(target, [...(awaiting.get(target) ?? []), ...refs]);
	// A project's web chat gets the same receipt and progress line as its Discord channel.
	if (b.events.some(e => e.source === "web") && target.startsWith("ch:")) {
		livestatus.begin(target, "orchestrator", true);
	}
}

// Slash/bang commands (/model, /restart, ...) are answered by the gateway itself, never by the orchestrator.
export async function answerCommand(target: string, text: string, replyTo?: string): Promise<void> {
	const card = await runCommand(text);
	await out(target, card.text, replyTo, { source: "gateway", card }).catch(e => log(`command reply to ${target} failed: ${e}`));
}

// "한도" is answered by the gateway without waking the orchestrator, from the account the orchestrator really runs on
// (hub/usage-account.ts: OmO's pinned/pool account under OmO, omp's login otherwise), named in the answer.
const LIMITS_ASK = /^\s*(한도|사용량|limits?)\s*[?？]?\s*$/i;
async function limitsAnswer(target: string, replyTo?: string): Promise<void> {
	const r = await anthropicUsage("orchestrator").catch(() => undefined);
	const last = accountView(1).switches[0];
	const card = limitsCard(r, last);
	await out(target, card.text, replyTo, { source: "gateway", card }).catch(e => log(`limits reply failed: ${e}`));
}

// "계정 바꿔줘", "회사 계정으로", "지금 무슨 계정이야?": answered here too (hub/accounts-api.ts accountAsk), never by the orchestrator.
async function accountChatAnswer(target: string, ask: Parameters<typeof accountAnswer>[0], replyTo?: string): Promise<void> {
	const text = await accountAnswer(ask).catch(e => (e as Error).message);
	await out(target, text, replyTo, { source: "gateway" }).catch(e => log(`account reply failed: ${e}`));
}

// Sends one web message the way the composer's modes mean it. "default" (no mode): the main assistant takes it as the next
// message, a working lane gets it steered in; "steer": into the running turn now; "interrupt": abort, then new prompt.
// `files` are uploads (files.ts): the chat shows them as chips, the agent gets one [attachment] line per file with its path.
// `project` (projectchat.ts) sends to a project's orchestrator: the message arrives as one in that work channel would.
type WebSend = { lane?: string; project?: { target: string; name: string }; channel: "web" | "terminal"; text: string; mode: "default" | "steer" | "interrupt"; login: string; files?: Upload[]; replyTo?: string; decision?: string };
export async function sendWeb(s: WebSend): Promise<void> {
	const mid = newMid();
	// replyTo: the asking message of a decision answer; decision: its notice, which that answer settles alone (notices.ts ownerReplied).
	const extra = { mid, ...(s.mode === "default" ? {} : { mode: s.mode }), ...(s.files?.length ? { files: s.files } : {}), ...(s.replyTo ? { reply_to: s.replyTo } : {}), ...(s.decision ? { decision: s.decision } : {}) };
	if (s.lane) {
		const name = s.lane;
		const channel = `lane:${name}`;
		emit("inbox", { ts: now(), kind: "lane_message", source: "web", author: s.login, lane: name, text: s.text, ...extra });
		if (s.mode === "interrupt" && lanes.get(name)?.status === "working") {
			abortLane(name);
			// Let the aborted turn end first, or the message would be steered into it.
			for (let i = 0; i < 50 && lanes.get(name)?.status === "working"; i++) await Bun.sleep(200);
		}
		// The state of this message shows in its meta line at once (hub/events.ts emitDelivery); a refusal comes back as a
		// gateway message in the session's chat, not only as the request's error.
		try {
			if (approvesBudget(name, s.text)) sendToLane(name, "/budget-ok");
			const how = sendToLane(name, [`[owner via web] ${s.text}`, s.files?.length ? attachmentLines(s.files) : ""].filter(Boolean).join("\n"), mid);
			emitDelivery(channel, mid, how);
			// The web shows the receipt as the message's delivery state only (no canned receipt message, owner 2026-10-17).
			livestatus.begin(channel, channel, true);
		} catch (error) {
			laneFailed(channel, name, mid, error);
			throw error;
		}
		return;
	}
	const to = s.project?.target ?? s.channel;
	const event = { ts: now(), kind: "message", source: s.channel, channel: to, ...(s.project ? { channel_name: s.project.name } : {}), author: s.login, text: s.text, ...extra, ...(s.files?.length ? { attachments: s.files.map(f => ({ name: f.name, type: f.type, url: f.path })) } : {}) };
	emit("inbox", event);
	if (parseCommand(event.text) || looksLikeCommand(event.text)) void answerCommand(to, event.text);
	else if (s.mode === "steer" && orch.status === "working") {
		// Through the prompt queue, which steers it in as a note now: raw inbox text admitted mid-turn read as a new prompt
		// and unpaired the running turn, so its answer went nowhere (2026-10-20 19:43 KST, the 19:36 and 19:38 web messages).
		deliver(inboxText(event), { target: to, replyTo: mid, owner: true });
		expectReply(to);
		emitDelivery(to, mid, "steered");
		awaiting.set(to, [...(awaiting.get(to) ?? []), mid]);
	} else {
		if (s.mode === "interrupt" && orch.status === "working") abortOrchestrator();
		intake(event, to, mid);
	}
}

// Web messages queued while their target works (see queue.ts) go out when that target is idle again: oldest first, as
// one message through the normal path (main: intake, which merges messages of one burst into one turn; lane: one prompt).
export const QUEUE_SWEEP_MS = 5000;
const queueFailed = new Set<string>();
export function flushQueue(target: string): void {
	const lane = target.startsWith("lane:") ? target.slice(5) : undefined;
	const status = lane ? lanes.get(lane)?.status : orch.status;
	if (lane && !lanes.has(lane)) {
		const gone = drain(target);
		void out("web", `세션 ${lane}이(가) 없어서 대기 중이던 메시지 ${gone.length}개를 전달하지 못했어요:\n${gone.map(i => i.text).join("\n---\n")}`, undefined, { source: "gateway" }).catch(() => undefined);
		return;
	}
	if (status !== "idle") return;
	const items = drain(target);
	if (!items.length) return;
	try {
		if (lane) {
			for (const i of items) if (approvesBudget(lane, i.text)) sendToLane(lane, "/budget-ok");
			const how = sendToLane(lane, `[owner via web] ${items.map(i => i.text).join("\n\n")}`, items[0].id);
			for (const i of items.slice(1)) ownerNotes.asked(lane, i.id);
			queueFailed.delete(target);
			// The messages waited for the session's turn to end and went in as one: "queued" unless the stopped session had to be resumed.
			for (const i of items) {
				emit("inbox", { ts: now(), kind: "lane_message", source: "web", author: i.author ?? "local", lane, text: i.text, mid: i.id });
				emitDelivery(target, i.id, how === "received" ? "queued" : how);
			}
			livestatus.begin(target, target, true);
		} else {
			for (const i of items) {
				const event = { ts: now(), kind: "message", source: "web", channel: "web", author: i.author ?? "local", text: i.text, mid: i.id };
				emit("inbox", event);
				intake(event, "web", i.id);
			}
		}
	} catch (error) {
		log(`queued web messages for ${target} not sent: ${(error as Error).message}`);
		// Said once in the session's chat; the messages stay queued and are tried again.
		if (lane && !queueFailed.has(target)) {
			queueFailed.add(target);
			laneFailed(target, lane, undefined, error);
		}
		restore(items);
	}
}
