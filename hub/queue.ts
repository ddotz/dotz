// Web messages sent while their target (the orchestrator or a lane) is mid-turn wait here instead of being steered into
// the turn; when that target's turn ends, main.ts sends the target's items oldest-first as one combined message. The
// queue is kept on disk (`web-queue.json`), so a gateway restart loses nothing; every change is broadcast over SSE.
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, log, now, writeAtomic } from "./config.ts";
import { broadcast } from "./events.ts";

export type QueueItem = { id: string; target: string; text: string; ts: string; author?: string };

const FILE = join(DATA_DIR, "web-queue.json");
const MAX_ITEMS = 100;
let items: QueueItem[] = [];
try {
	if (existsSync(FILE)) {
		const raw = JSON.parse(readFileSync(FILE, "utf8"));
		if (Array.isArray(raw)) items = raw.filter(i => i && typeof i.id === "string" && typeof i.target === "string" && typeof i.text === "string");
	}
} catch (error) {
	log(`web queue unreadable (${error}); starting empty`);
}

function changed(): void {
	writeAtomic(FILE, `${JSON.stringify(items, null, 2)}\n`);
	broadcast({ ts: now(), kind: "queue", items });
}

export const queueItems = (): QueueItem[] => items;
export const hasQueued = (target: string): boolean => items.some(i => i.target === target);
export const queuedTargets = (): string[] => [...new Set(items.map(i => i.target))];

export function enqueue(target: string, text: string, author?: string): QueueItem {
	const item: QueueItem = { id: randomUUID(), target, text, ts: now(), ...(author ? { author } : {}) };
	items.push(item);
	if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
	changed();
	return item;
}

// Puts items back (a send that failed), keeping the queue oldest-first.
export function restore(back: QueueItem[]): void {
	items = [...items, ...back].sort((a, b) => a.ts.localeCompare(b.ts));
	changed();
}

// Removes and returns one item (take back, send now); undefined when it is already gone (sent, or taken by another tab).
export function take(id: string): QueueItem | undefined {
	const i = items.findIndex(x => x.id === id);
	if (i < 0) return undefined;
	const [item] = items.splice(i, 1);
	changed();
	return item;
}

// Removes and returns every item of one target, oldest first.
export function drain(target: string): QueueItem[] {
	const mine = items.filter(i => i.target === target);
	if (!mine.length) return mine;
	items = items.filter(i => i.target !== target);
	changed();
	return mine;
}
