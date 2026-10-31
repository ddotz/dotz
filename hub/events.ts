import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { paths } from "./config.ts";
import { fileLinePaths, snapshotSent } from "./files.ts";
import { mailByThread, mailTarget } from "./mail.ts";

export type HubEvent = { ts: string; kind: string; source: string; text: string; [key: string]: unknown };

const recent: HubEvent[] = [];
const subscribers = new Set<ReadableStreamDefaultController<string>>();

for (const file of [paths.inbox, paths.outbox]) {
	if (!existsSync(file)) continue;
	for (const line of readFileSync(file, "utf8").split("\n").slice(-150)) {
		try {
			recent.push(JSON.parse(line));
		} catch {
			continue;
		}
	}
}
recent.sort((a, b) => a.ts.localeCompare(b.ts));

// Pages connected to /api/events right now; background watchers skip their work when it is 0.
export const subscriberCount = (): number => subscribers.size;

const emitListeners = new Set<(event: HubEvent) => void>();
export const onEmit = (fn: (event: HubEvent) => void) => void emitListeners.add(fn);

export function emit(box: "inbox" | "outbox", event: HubEvent): void {
	appendFileSync(box === "inbox" ? paths.inbox : paths.outbox, `${JSON.stringify(event)}\n`);
	if (typeof event.text === "string" && event.text.includes("[file]")) snapshotSent(event.text);
	recent.push(event);
	if (recent.length > 300) recent.shift();
	broadcast(event);
	for (const fn of emitListeners) {
		try {
			fn(event);
		} catch (e) {
			console.error(`emit listener failed: ${e}`);
		}
	}
}

// Delivery state of an owner message (2026-10-21), the same on web and Discord: sent -> received (steered into the running
// step / received by an idle session / queued until it is idle / resumed a stopped session) -> answered; or failed. One
// "delivery" event per change, in the conversation of `target` ("lane:<name>", "ch:<id>", "web"), `ref` = the owner event's
// `mid` (or a Discord message id). The web shows the latest state in that message's meta line.
type DeliveryState = "steered" | "received" | "queued" | "held" | "resumed" | "answered" | "failed";
export function emitDelivery(target: string, ref: string | undefined, state: DeliveryState, text = ""): void {
	if (!ref) return;
	// A web message in a mail conversation travels as one in the mail's thread: its state shows in that conversation.
	const mail = target.startsWith("th:") ? mailByThread(target.slice(3)) : undefined;
	emit("outbox", { ts: new Date().toISOString(), kind: "delivery", source: "gateway", target, ref, state, text, ...(mail ? { conv: mailTarget(mail.key) } : {}) });
}

// Live-only activity (what an omp process is doing): streamed over SSE and kept in a per-source ring buffer, never
// written to inbox/outbox jsonl or to /api/state's recent events.
export type Activity = {
	ts: string;
	kind: "activity";
	source: string;
	type: "turn_start" | "turn_end" | "thinking" | "text" | "tool_call" | "tool_result" | "error" | "status";
	text: string;
	tool?: string;
	call_id?: string;
	args?: string;
	intent?: string;
	is_error?: boolean;
};
const ACTIVITY_MAX = 300;
const activity = new Map<string, Activity[]>();

// Every frame carries an id "<boot>-<seq>"; the last REPLAY_MAX frames are kept so a client that reconnects with
// Last-Event-ID gets only what it missed. A different boot (gateway restarted) or a gap older than the ring cannot be
// replayed: the client is told to reload ("reset").
const BOOT = Date.now().toString(36);
const REPLAY_MAX = 2000;
const frames: { seq: number; frame: string }[] = [];
let seq = 0;

export function replayAfter(lastId: string | null | undefined): string[] | null {
	const m = /^([0-9a-z]+)-(\d+)$/.exec(lastId ?? "");
	if (!m || m[1] !== BOOT) return null;
	const n = Number(m[2]);
	if (n > seq) return null;
	if (n === seq) return [];
	if (!frames.length || frames[0].seq > n + 1) return null;
	return frames.filter(f => f.seq > n).map(f => f.frame);
}

export const lastEventId = (): string => `${BOOT}-${seq}`;

// Listeners of the page-only frames (a notice answered, a conversation read): the push layer takes back notifications they settle (hub/push.ts).
const broadcastTaps: ((event: Record<string, unknown>) => void)[] = [];
export const onBroadcast = (fn: (event: Record<string, unknown>) => void): void => void broadcastTaps.push(fn);
export function broadcast(event: unknown): void {
	for (const tap of broadcastTaps) {
		try {
			tap(event as Record<string, unknown>);
		} catch (e) {
			console.error(`broadcast listener failed: ${(e as Error).message}`);
		}
	}
	seq++;
	const frame = `id: ${BOOT}-${seq}\ndata: ${JSON.stringify(event)}\n\n`;
	frames.push({ seq, frame });
	if (frames.length > REPLAY_MAX) frames.shift();
	for (const sub of subscribers) {
		try {
			sub.enqueue(frame);
		} catch {
			subscribers.delete(sub);
		}
	}
}

export function emitActivity(event: Activity): void {
	let ring = activity.get(event.source);
	if (!ring) activity.set(event.source, (ring = []));
	ring.push(event);
	if (ring.length > ACTIVITY_MAX) ring.shift();
	broadcast(event);
}

export function activityItems(source: string, limit = ACTIVITY_MAX): Activity[] {
	return (activity.get(source) ?? []).slice(-Math.max(1, Math.min(limit, ACTIVITY_MAX)));
}

export function recentEvents(limit = 150): HubEvent[] {
	return limit > 0 ? recent.slice(-limit) : []; // slice(-0) is the whole list, and the page asks /api/state for limit=0 meaning none
}

// The text of the assistant message posted at `ts` (the message a decision answer replies to): the live ring first, then the outbox tail.
export function askedText(ts: string): string | undefined {
	const find = (list: HubEvent[]) => list.findLast(e => e.ts === ts && (e.kind === "out" || e.kind === "lane_report") && typeof e.text === "string");
	return (find(recent) ?? find(tailEvents(paths.outbox)))?.text;
}

// Which conversation an event belongs to: "main" (owner <-> the assistant), "lane:<name>", a project's "ch:<id>" or one of the two
// fixed conversations "alert" / "worklog" (the gateway's alerts, and the answers to the owner's questions asked there, sent as target
// "web:alert" / "web:worklog"). A watch wake event is in no chat conversation: its report is a notice of the 모니터링 tab (hub/notices.ts,
// web/js/30-monitoring.js), never a message of 알림. The web app mirrors this rule for live events, so keep the two in step.
const FIXED_CONV = /^(?:web:)?(alert|worklog)$/;
export function eventTarget(e: HubEvent): string | undefined {
	if (e.kind === "activity" || e.kind === "subagents" || e.kind === "notice" || e.kind === "notice_read" || e.kind === "notice_dismiss" || e.kind === "read") return undefined;
	// A mail is its own conversation (hub/mail.ts): stamped `conv` on its thread's messages, or the web-only target itself.
	const mail = [e.conv, e.channel, e.target].find((v): v is string => typeof v === "string" && v.startsWith("mail:"));
	if (mail) return mail;
	const settings = [e.conv, e.channel, e.target].find((v): v is string => typeof v === "string" && v.startsWith("settings:"));
	if (settings) return settings;
	const lane = typeof e.lane === "string" ? e.lane : [e.source, e.target, e.channel].find(v => typeof v === "string" && v.startsWith("lane:"))?.slice(5);
	if (lane) return `lane:${lane}`;
	// A project's work channel is its own conversation (hub/projectchat.ts): the owner's message there and the answers to it.
	const project = [e.channel, e.target].find((v): v is string => typeof v === "string" && /^ch:\d+$/.test(v));
	if (project) return project;
	for (const v of [e.channel, e.target]) {
		const fixed = typeof v === "string" ? FIXED_CONV.exec(v) : null;
		if (fixed) return fixed[1];
	}
	return e.kind === "watch" ? undefined : "main";
}

// Last HISTORY_TAIL bytes of a jsonl file, parsed; a cut first line is dropped.
// History pages, the conversation list, decision cards and file checks all ask for it, so what was parsed is kept per file and only
// the bytes appended since are read (the logs only grow by appendFileSync; a smaller size or another inode is a rewrite: read afresh).
// Each kept line remembers its byte offset, so the window moves exactly as a fresh read of the last HISTORY_TAIL bytes would.
const HISTORY_TAIL = 4 * 1024 * 1024;
type Tail = { ino: number; size: number; mtime: number; lines: { start: number; event: HubEvent }[] };
const tails = new Map<string, Tail>();
const parsed = (text: string): HubEvent | undefined => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};
export function tailEvents(file: string): HubEvent[] {
	if (!existsSync(file)) {
		tails.delete(file);
		return [];
	}
	const { size, ino, mtimeMs } = statSync(file);
	const windowStart = Math.max(0, size - HISTORY_TAIL);
	const kept = (start: number) => windowStart === 0 || start > windowStart;
	let tail = tails.get(file);
	const rewritten = tail && (tail.ino !== ino || size < tail.size || (size === tail.size && mtimeMs !== tail.mtime));
	if (!tail || rewritten || tail.size < windowStart) tail = { ino, size: windowStart, mtime: mtimeMs, lines: [] };
	tail.mtime = mtimeMs;
	tails.set(file, tail);
	let partial: HubEvent | undefined;
	if (size > tail.size) {
		const from = tail.size;
		const buf = Buffer.alloc(size - from);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buf, 0, buf.length, from);
		} finally {
			closeSync(fd);
		}
		let at = 0;
		for (let nl = buf.indexOf(10); nl !== -1; at = nl + 1, nl = buf.indexOf(10, at)) {
			if (!kept(from + at)) continue;
			const event = parsed(buf.toString("utf8", at, nl));
			if (event) tail.lines.push({ start: from + at, event });
		}
		// A line still being written is not kept (its end may not be there yet); it is read again once its newline lands.
		tail.size = from + at;
		if (at < buf.length && kept(from + at)) partial = parsed(buf.toString("utf8", at));
	}
	const drop = tail.lines.findIndex(l => kept(l.start));
	if (drop !== 0) tail.lines.splice(0, drop === -1 ? tail.lines.length : drop);
	const out = tail.lines.map(l => l.event);
	if (partial) out.push(partial);
	return out;
}

// Ids of the owner messages the outbox log shows as answered, from its tail: the `answered` delivery state of a message (what
// the owner sees, also for the other messages of a burst or ones a reply_to-less answer settled) and the reply_to of the
// orchestrator's `out` events (a gateway notice replying to a message did not answer it).
export function answeredIds(): string[] {
	return tailEvents(paths.outbox).flatMap(e => {
		if (e.kind === "delivery" && e.state === "answered" && typeof e.ref === "string" && e.ref) return [e.ref];
		return e.kind === "out" && e.source === "orchestrator" && typeof e.reply_to === "string" && e.reply_to ? [e.reply_to] : [];
	});
}

// The owner message with this id (a web `mid` or a Discord message id): the live ring first, then the inbox tail. A reply_to
// names it, so a late answer can quote it (hub/outbound.ts).
export function ownerMessage(id: string): { text: string; ts: string; author?: string } | undefined {
	const is = (e: HubEvent) => (e.kind === "message" || e.kind === "lane_message") && (e.mid === id || e.message_id === id);
	const e = recent.findLast(is) ?? tailEvents(paths.inbox).findLast(is);
	return e ? { text: String(e.text ?? ""), ts: e.ts, ...(typeof e.author === "string" ? { author: e.author } : {}) } : undefined;
}

// Did the orchestrator answer in `target` after `at` (ms)? A stored prompt without a message id counts as answered then.
export function answeredSince(target: string, at: number): boolean {
	return tailEvents(paths.outbox).some(e => e.kind === "out" && e.source === "orchestrator" && e.target === target && !e.update_key && Date.parse(String(e.ts)) > at);
}

// The owner's messages in the inbox log tail (oldest first), for an answer that has no prompt after a restart (prompts.ts).
// A slash/bang command is answered by the gateway itself and is no work for the orchestrator.
export function recentOwnerMessages(): { target: string; replyTo?: string; at: number }[] {
	return tailEvents(paths.inbox).flatMap(e => {
		const at = Date.parse(String(e.ts));
		if (e.kind !== "message" || typeof e.channel !== "string" || Number.isNaN(at) || /^\s*[/!]/.test(String(e.text ?? ""))) return [];
		return [{ target: e.channel, replyTo: typeof (e.message_id ?? e.mid) === "string" ? (e.message_id ?? e.mid) : undefined, at }];
	});
}

// The paths written in [file] lines of the messages the gateway sent (the outbox log tail, the window history shows; newer
// than the cached size is rescanned). The file route serves these to the web even outside the lanes' folders (files.ts).
let sentCache: { size: number; paths: Set<string> } | undefined;
export function sentFiles(): ReadonlySet<string> {
	const size = [paths.outbox, paths.inbox].reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0);
	if (sentCache?.size === size) return sentCache.paths;
	const found = new Set<string>();
	for (const e of [...tailEvents(paths.outbox), ...tailEvents(paths.inbox)]) if (typeof e.text === "string" && e.text.includes("[file]")) for (const p of fileLinePaths(e.text)) found.add(p);
	sentCache = { size, paths: found };
	return found;
}

// `before` (an ISO ts) pages backwards: the newest `limit` events older than it.
export function historyEvents(target: string, limit: number, before?: string): HubEvent[] {
	let all = [...tailEvents(paths.inbox), ...tailEvents(paths.outbox)].filter(e => typeof e.ts === "string" && eventTarget(e) === target && (!before || e.ts < before));
	all.sort((a, b) => a.ts.localeCompare(b.ts));
	// A post edited in place (update_key, e.g. a lane's worklog line) shows once, as its newest version.
	if (target === "alert" || target === "worklog") {
		const last = new Map<string, HubEvent>();
		for (const e of all) if (e.kind === "out" && typeof e.update_key === "string" && e.update_key) last.set(e.update_key, e);
		all = all.filter(e => !(e.kind === "out" && typeof e.update_key === "string" && e.update_key) || last.get(e.update_key) === e);
	}
	return all.slice(-limit);
}

export function sseResponse(lastId?: string | null): Response {
	let controller: ReadableStreamDefaultController<string>;
	const stream = new ReadableStream<string>({
		start(c) {
			controller = c;
			const missed = lastId ? replayAfter(lastId) : null;
			if (missed) for (const f of missed) c.enqueue(f);
			else c.enqueue(`id: ${lastEventId()}\nevent: reset\ndata: {}\n\n`);
			subscribers.add(c);
		},
		cancel() {
			subscribers.delete(controller);
		},
	});
	return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

setInterval(() => {
	for (const sub of subscribers) {
		try {
			sub.enqueue(": ping\n\n");
		} catch {
			subscribers.delete(sub);
		}
	}
}, 25_000);
