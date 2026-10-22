import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { paths } from "./config.ts";
import { fileLinePaths } from "./files.ts";

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

const emitListeners = new Set<(event: HubEvent) => void>();
export const onEmit = (fn: (event: HubEvent) => void) => void emitListeners.add(fn);

export function emit(box: "inbox" | "outbox", event: HubEvent): void {
	appendFileSync(box === "inbox" ? paths.inbox : paths.outbox, `${JSON.stringify(event)}\n`);
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
	if (ref) emit("outbox", { ts: new Date().toISOString(), kind: "delivery", source: "gateway", target, ref, state, text });
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

export function broadcast(event: unknown): void {
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

// Which conversation an event belongs to: "main" (owner <-> the assistant), "lane:<name>", a project's "ch:<id>" or one of the two
// fixed conversations "alert" / "worklog" (the gateway's alerts and watch wake events, and the answers to the owner's questions
// asked there, sent as target "web:alert" / "web:worklog"). The web app mirrors this rule for live events, so keep the two in step.
const FIXED_CONV = /^(?:web:)?(alert|worklog)$/;
export function eventTarget(e: HubEvent): string | undefined {
	if (e.kind === "activity" || e.kind === "subagents" || e.kind === "notice" || e.kind === "notice_read" || e.kind === "notice_dismiss" || e.kind === "read") return undefined;
	const lane = typeof e.lane === "string" ? e.lane : [e.source, e.target, e.channel].find(v => typeof v === "string" && v.startsWith("lane:"))?.slice(5);
	if (lane) return `lane:${lane}`;
	// A project's work channel is its own conversation (hub/projectchat.ts): the owner's message there and the answers to it.
	const project = [e.channel, e.target].find((v): v is string => typeof v === "string" && /^ch:\d+$/.test(v));
	if (project) return project;
	for (const v of [e.channel, e.target]) {
		const fixed = typeof v === "string" ? FIXED_CONV.exec(v) : null;
		if (fixed) return fixed[1];
	}
	return e.kind === "watch" ? "alert" : "main";
}

// Last HISTORY_TAIL bytes of a jsonl file, parsed; a cut first line is dropped.
const HISTORY_TAIL = 4 * 1024 * 1024;
export function tailEvents(file: string): HubEvent[] {
	if (!existsSync(file)) return [];
	const size = statSync(file).size;
	const start = Math.max(0, size - HISTORY_TAIL);
	const buf = Buffer.alloc(size - start);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}
	const lines = buf.toString("utf8").split("\n");
	if (start > 0) lines.shift();
	const out: HubEvent[] = [];
	for (const line of lines) {
		try {
			out.push(JSON.parse(line));
		} catch {
			continue;
		}
	}
	return out;
}

// Ids of the owner messages the outbox log shows as answered (reply_to of the orchestrator's `out` events; a gateway
// notice replying to a message did not answer it), from its tail.
export function answeredIds(): string[] {
	return tailEvents(paths.outbox).flatMap(e => (e.kind === "out" && e.source === "orchestrator" && typeof e.reply_to === "string" && e.reply_to ? [e.reply_to] : []));
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
	const size = existsSync(paths.outbox) ? statSync(paths.outbox).size : 0;
	if (sentCache?.size === size) return sentCache.paths;
	const found = new Set<string>();
	for (const e of tailEvents(paths.outbox)) if (typeof e.text === "string" && e.text.includes("[file]")) for (const p of fileLinePaths(e.text)) found.add(p);
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
