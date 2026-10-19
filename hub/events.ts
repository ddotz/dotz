import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { paths } from "./config.ts";

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

export function emit(box: "inbox" | "outbox", event: HubEvent): void {
	appendFileSync(box === "inbox" ? paths.inbox : paths.outbox, `${JSON.stringify(event)}\n`);
	recent.push(event);
	if (recent.length > 300) recent.shift();
	broadcast(event);
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

export function broadcast(event: unknown): void {
	for (const sub of subscribers) {
		try {
			sub.enqueue(`data: ${JSON.stringify(event)}\n\n`);
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
	return recent.slice(-limit);
}

// Which conversation an event belongs to: "main" (owner <-> the assistant) or "lane:<name>". The web app mirrors this rule
// for live events, so keep the two in step.
export function eventTarget(e: HubEvent): string | undefined {
	if (e.kind === "activity" || e.kind === "subagents") return undefined;
	const lane = typeof e.lane === "string" ? e.lane : [e.source, e.target, e.channel].find(v => typeof v === "string" && v.startsWith("lane:"))?.slice(5);
	return lane ? `lane:${lane}` : "main";
}

// Last HISTORY_TAIL bytes of a jsonl file, parsed; a cut first line is dropped.
const HISTORY_TAIL = 4 * 1024 * 1024;
function tailEvents(file: string): HubEvent[] {
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

export function historyEvents(target: string, limit: number): HubEvent[] {
	const all = [...tailEvents(paths.inbox), ...tailEvents(paths.outbox)].filter(e => typeof e.ts === "string" && eventTarget(e) === target);
	all.sort((a, b) => a.ts.localeCompare(b.ts));
	return all.slice(-limit);
}

export function sseResponse(): Response {
	let controller: ReadableStreamDefaultController<string>;
	const stream = new ReadableStream<string>({
		start(c) {
			controller = c;
			subscribers.add(c);
			c.enqueue(": connected\n\n");
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
