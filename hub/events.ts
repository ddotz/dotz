import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
