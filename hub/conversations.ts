import { eventTarget, onEmit, tailEvents, type HubEvent } from "./events.ts";
import { paths } from "./config.ts";
import { readOf, unreadFrom } from "./reads.ts";
import { parseTone, stripHandoff } from "./tone.ts";

// The messenger overview: one row per conversation (the main chat, each project channel, each session) with its newest real
// message. Built once from the inbox/outbox tail, then kept current by onEmit; a request never rescans the files.
// The web mirrors the "real message" rule (web/js/31-conversations.js), so keep the two in step.
export type ConversationLast = { ts: string; text: string; from: "owner" | "bot" | "session" };
// `read`: where the owner has read up to (hub/reads.ts), `unread`: real messages after it that are not the owner's own.
export type Conversation = { target: string; last: ConversationLast | null; read: string | null; unread: number };

const PREVIEW_MAX = 120;
// Kinds that show as a message in a conversation. Not here: delivery states, activity, progress notes (`out` with an
// update_key), lane_start, and the bell's notice / notice_read.
const OWNER_KINDS = new Set(["message", "lane_message"]);
const MESSAGE_KINDS = new Set([...OWNER_KINDS, "out", "lane_report", "result", "mail", "schedule", "watch"]);

export function isRealMessage(e: HubEvent): boolean {
	if (!MESSAGE_KINDS.has(e.kind)) return false;
	return !(e.kind === "out" && e.update_key);
}

// First meaningful line of a message as plain text: the handoff block, the [done]-style marker, code fences and markdown
// decoration are dropped.
export function previewOf(raw: string): string {
	const text = parseTone(stripHandoff(raw)).text;
	let fence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		const plain = line
			.replace(/^\s*-#\s+/, "")
			.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/[*_~`]+/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!plain) continue;
		return plain.length > PREVIEW_MAX ? `${plain.slice(0, PREVIEW_MAX - 1)}…` : plain;
	}
	return "";
}

function lastOf(e: HubEvent): ConversationLast | undefined {
	if (!isRealMessage(e)) return undefined;
	const card = e.card && typeof e.card === "object" ? (e.card as { title?: unknown }).title : undefined;
	const hasFiles = Array.isArray(e.files) && e.files.length > 0;
	const text = previewOf(String(e.text ?? "")) || previewOf(typeof card === "string" ? card : "") || (hasFiles ? "파일" : "");
	if (!text) return undefined;
	const from = OWNER_KINDS.has(e.kind) ? "owner" : e.kind === "lane_report" || (typeof e.source === "string" && e.source.startsWith("lane:")) ? "session" : "bot";
	return { ts: e.ts, text, from };
}

const known = new Map<string, ConversationLast | null>([["main", null]]);
let loaded = false;
let sorted: { target: string; last: ConversationLast | null }[] | undefined;

// The newest messages that can be unread, per target: event key -> ts. The load from the log tail and the live event of the
// same message meet here, so the key keeps it counted once.
const UNREAD_KEEP = 500;
const incoming = new Map<string, Map<string, string>>();
const cleanRestart = (e: HubEvent) => e.kind === "out" && e.source === "gateway" && /^게이트웨이 재시작했어요/.test(String(e.text ?? "")) && /끊긴 작업은 없어요/.test(String(e.text ?? ""));

function countIncoming(target: string, e: HubEvent, last: ConversationLast): void {
	if (last.from === "owner" || cleanRestart(e)) return;
	let bucket = incoming.get(target);
	if (!bucket) incoming.set(target, (bucket = new Map()));
	bucket.set(`${e.ts}|${e.kind}|${String(e.text ?? "").slice(0, 60)}`, e.ts);
	if (bucket.size > UNREAD_KEEP) bucket.delete(bucket.keys().next().value as string);
}

export function unreadOf(target: string): number {
	const read = unreadFrom(target);
	let n = 0;
	for (const ts of incoming.get(target)?.values() ?? []) if (!read || ts > read) n++;
	return n;
}

function note(e: HubEvent): void {
	if (typeof e.ts !== "string") return;
	const target = eventTarget(e);
	const last = target ? lastOf(e) : undefined;
	if (!target || !last) return;
	countIncoming(target, e, last);
	const prev = known.get(target);
	if (prev && prev.ts > last.ts) return;
	known.set(target, last);
	sorted = undefined;
}

onEmit(note);

function load(): void {
	if (loaded) return;
	loaded = true;
	// Oldest first, so the tail never overwrites a newer live event already noted.
	for (const e of [...tailEvents(paths.inbox), ...tailEvents(paths.outbox)].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) note(e);
}

// `live`: the targets that exist right now (live sessions, project channels); they are listed even before their first message.
export function conversationList(live: readonly string[] = []): Conversation[] {
	load();
	for (const t of live) if (!known.has(t)) known.set(t, null);
	if (!sorted || sorted.length !== known.size) {
		sorted = [...known].map(([target, last]) => ({ target, last })).sort((a, b) => (b.last?.ts ?? "").localeCompare(a.last?.ts ?? ""));
	}
	return sorted.map(c => ({ ...c, read: readOf(c.target), unread: unreadOf(c.target) }));
}
