import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { log, now, paths, writeAtomic } from "./config.ts";
import { broadcast, emit, type HubEvent, onEmit } from "./events.ts";
import { parseTone, stripHandoff } from "./tone.ts";

// The web notification store: every worklog / alert / session result / watch / schedule post, kept in notices.json so the
// bell survives a restart. Fed by what the hub already emits (onEmit), so main.ts only wires the API and the resolver.
export type NoticeKind = "result" | "alert" | "worklog" | "watch";
export type NoticeTone = "done" | "run" | "ask" | "fail" | "";
export type Notice = {
	id: string;
	ts: string;
	updated: string;
	kind: NoticeKind;
	tone: NoticeTone;
	title: string;
	text: string;
	// The conversation to open on tap: "main", "lane:<name>" or "ch:<id>".
	open: string;
	// The source message: the conversation it lives in ("main", "lane:<name>", "ch:<id>") and its event ts, which the web finds
	// on the rendered message (data-ts). Older items have neither: the web falls back to open + updated.
	src?: string;
	at?: string;
	key?: string;
	read: boolean;
	// Swiped away / x in the bell: kept (so a session's next progress line does not bring it back) but never listed or counted.
	dismissed?: boolean;
};

export const NOTICE_CAP = 300;
const TEXT_MAX = 1500;
const LOUD = new Set<NoticeTone>(["done", "fail", "ask"]);
const RESTART_PREFIX = "게이트웨이 재시작했어요";

const load = (): Notice[] => {
	if (!existsSync(paths.notices)) return [];
	try {
		const parsed = JSON.parse(readFileSync(paths.notices, "utf8"));
		return Array.isArray(parsed) ? parsed.filter((n): n is Notice => typeof n?.id === "string" && typeof n.text === "string") : [];
	} catch (e) {
		log(`notices.json unreadable, starting empty: ${e}`);
		return [];
	}
};
let items: Notice[] = load();

const save = () => writeAtomic(paths.notices, `${JSON.stringify(items, null, 1)}\n`);
export const unreadCount = () => items.reduce((n, i) => n + (i.read || i.dismissed ? 0 : 1), 0);

// The Korean title of a session (never its code name); main.ts passes lanes.get(name)?.title.
let laneTitleOf: (name: string) => string | undefined = () => undefined;
export const setLaneTitleResolver = (fn: (name: string) => string | undefined) => void (laneTitleOf = fn);
const laneTitle = (name: string) => laneTitleOf(name)?.trim() || "세션";

// Oldest read item goes first; when everything is unread, the oldest one.
function trim(): void {
	while (items.length > NOTICE_CAP) {
		const oldest = (list: Notice[]) => list.reduce((a, b) => (b.updated < a.updated ? b : a));
		const pool = items.filter(i => i.read);
		const drop = oldest(pool.length ? pool : items);
		items = items.filter(i => i !== drop);
	}
}

type Input = { kind: NoticeKind; tone: NoticeTone; title: string; text: string; open: string; key?: string; read?: boolean; unread?: boolean; src?: string; at?: string };

function upsert(i: Input): Notice {
	const at = i.at ?? now();
	const old = i.key ? items.find(n => n.key === i.key) : undefined;
	let item: Notice;
	if (old) {
		const reopened = (LOUD.has(i.tone) && i.tone !== old.tone) || (i.kind === "result" && i.text !== old.text) || i.unread === true;
		old.kind = i.kind;
		old.tone = i.tone;
		old.title = i.title;
		old.text = i.text;
		old.open = i.open;
		old.src = i.src ?? i.open;
		old.at = at;
		old.updated = at;
		if (i.read) old.read = true;
		else if (reopened) {
			old.read = false;
			delete old.dismissed;
		}
		item = old;
	} else {
		item = { id: randomBytes(4).toString("hex"), ts: at, updated: at, kind: i.kind, tone: i.tone, title: i.title, text: i.text, open: i.open, src: i.src ?? i.open, at, ...(i.key ? { key: i.key } : {}), read: i.read === true };
		items.push(item);
		trim();
	}
	save();
	broadcast({ ts: at, kind: "notice", source: "gateway", item, unread: unreadCount() });
	return item;
}

const clean = (raw: unknown) => {
	const p = parseTone(stripHandoff(String(raw ?? "")));
	return { tone: (p.tone ?? "") as NoticeTone, text: p.text.trim().slice(0, TEXT_MAX) };
};

// Gateway jobs that post on their own get their own title; everything else is a plain worklog / alert entry.
function systemTitle(text: string, fallback: string): string {
	if (/^토큰 (누수 )?점검/.test(text)) return "토큰 점검";
	if (text.includes("야간 정리")) return "야간 정리";
	return fallback;
}

function fromOutbox(e: HubEvent): void {
	const target = String(e.target ?? "");
	const key = typeof e.update_key === "string" && e.update_key ? e.update_key : undefined;
	if (key === "progress") return;
	const { tone, text } = clean(e.text);
	if (!text) return;
	const restart = text.startsWith(RESTART_PREFIX);
	if (target === "worklog" || (restart && target === "web" && e.source === "gateway")) {
		if (key?.startsWith("lane:")) {
			const name = key.slice(5);
			return void upsert({ kind: "result", tone, title: laneTitle(name), text, open: key, key, at: e.ts });
		}
		return void upsert({ kind: "worklog", tone, title: systemTitle(text, "작업 기록"), text, open: "main", key, read: restart, at: e.ts });
	}
	if (target === "alert") return void upsert({ kind: "alert", tone, title: systemTitle(text, "알림"), text, open: "main", key, at: e.ts });
	const watch = /^ch:\d+$/.test(target) && e.source === "gateway" ? /^\[([^\]\n]+)\]\s*/.exec(text) : null;
	if (watch) upsert({ kind: "watch", tone, title: watch[1]!, text: text.slice(watch[0].length) || text, open: target, key, at: e.ts });
}

function fromInbox(e: HubEvent): void {
	if (e.kind === "lane_report") {
		const name = String(e.lane ?? "");
		const { tone, text } = clean(e.text);
		if (!name || !text || !LOUD.has(tone)) return;
		return void upsert({ kind: "result", tone, title: laneTitle(name), text, open: `lane:${name}`, key: `lane:${name}`, at: e.ts });
	}
	if (e.kind === "watch") {
		const ch = Array.isArray(e.channels) ? e.channels[0] : undefined;
		const body = [e.reason, e.text].filter(v => typeof v === "string" && v.trim()).join("\n");
		return void upsert({ kind: "watch", tone: "", title: String(e.watch ?? "감시"), text: clean(body).text || "알림이 왔어요", open: ch ? `ch:${ch}` : "main", at: e.ts });
	}
	if (e.kind === "schedule") {
		const ch = typeof e.channel === "string" && /^ch:\d+$/.test(e.channel) ? e.channel : "main";
		upsert({ kind: "watch", tone: "", title: "예약", text: clean(e.text).text || "예약한 일이 시작됐어요", open: ch, at: e.ts });
	}
}

onEmit(e => {
	try {
		if (e.kind === "out") fromOutbox(e);
		else fromInbox(e);
	} catch (err) {
		log(`notice feed failed: ${err}`);
	}
});

// A session's work was checked by the orchestrator: its result item turns unread "done" and, once, a compact card goes into
// the main chat (a [done] that is only reported, not yet verified, stays in the bell).
export function laneVerified(name: string, fallbackText: string): void {
	const key = `lane:${name}`;
	const title = laneTitle(name);
	const prior = items.find(n => n.key === key);
	const text = ((prior?.tone === "done" ? prior.text : clean(fallbackText).text) || "확인을 마쳤어요").slice(0, 600);
	// The notice points at the compact card in the main chat, which carries the same ts.
	const at = now();
	upsert({ kind: "result", tone: "done", title, text, open: key, key, unread: true, src: "main", at });
	emit("outbox", { ts: at, kind: "result", source: "gateway", target: "web", session: name, title, tone: "done", verified: true, text: summary(text), open: key });
}

// First three meaningful lines (no blank lines, rules or fences).
export function summary(text: string): string {
	return text
		.split("\n")
		.map(l => l.trim())
		.filter(l => l && !/^(?:[-*_=]{3,}|```.*)$/.test(l))
		.slice(0, 3)
		.map(l => (l.length > 160 ? `${l.slice(0, 159)}…` : l))
		.join("\n");
}

// Unread first, then the most recently updated.
export function listNotices(limit = 100): { items: Notice[]; unread: number } {
	const n = Math.max(1, Math.min(Math.floor(limit) || 100, NOTICE_CAP));
	const shown = items.filter(i => !i.dismissed);
	const order = new Map(shown.map((i, idx) => [i, idx]));
	const sorted = [...shown].sort((a, b) => Number(a.read) - Number(b.read) || b.updated.localeCompare(a.updated) || order.get(b)! - order.get(a)!);
	return { items: sorted.slice(0, n), unread: unreadCount() };
}

// Swipe / x in the bell: read and gone from every list and count, on every open tab (a notice_dismiss frame).
export function dismissNotice(id: unknown): { ok: boolean; unread: number } {
	const item = items.find(i => i.id === String(id));
	if (!item) return { ok: false, unread: unreadCount() };
	if (!item.dismissed) {
		item.dismissed = true;
		item.read = true;
		save();
		broadcast({ ts: now(), kind: "notice_dismiss", source: "gateway", id: item.id, unread: unreadCount() });
	}
	return { ok: true, unread: unreadCount() };
}

export function markNoticesRead(sel: { ids?: unknown; all?: unknown }): { unread: number } {
	const ids = Array.isArray(sel.ids) ? new Set(sel.ids.map(String)) : new Set<string>();
	const all = sel.all === true;
	const hit = items.filter(i => !i.read && !i.dismissed && (all || ids.has(i.id)));
	if (hit.length) {
		for (const i of hit) i.read = true;
		save();
		broadcast({ ts: now(), kind: "notice_read", source: "gateway", ...(all ? { all: true } : { ids: hit.map(i => i.id) }), unread: unreadCount() });
	}
	return { unread: unreadCount() };
}
