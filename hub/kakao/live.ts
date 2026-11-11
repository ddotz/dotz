// Live updates for the per-room KakaoTalk web view: fs.watch on the KakaoTalk database folder (db and -wal files) and on drafts.json,
// a ~250 ms debounce, and at most one query in flight, for the watched rooms only. Events carry ids only.
// Measured 2026-10-23: fs.watch gets no event at all for KakaoTalk's container files (the -wal file grows and its mtime moves, nothing is delivered),
// so while a page is connected a cheap stat of the db and -wal files (two syscalls, no query) every statPollMs tells the same thing; a query runs only when they changed.
// With no web page connected the query is skipped and the last seen logId stays where it was, so the next query catches up.
import { mkdirSync, readFileSync, statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { type KakaoDb, maxLogId, newInChats, watermarkSignatures } from "./db.ts";
import type { KakaoConfig, KakaoPaths } from "./types.ts";

export type Watcher = { close(): void };
export type LiveDeps = {
	paths: KakaoPaths;
	readConfig: () => KakaoConfig | undefined;
	openDb: (config: KakaoConfig) => Promise<KakaoDb>;
	subscribers: () => number;
	broadcast: (event: Record<string, unknown>) => void;
	watchDir?: (dir: string, onFile: (name: string | null) => void) => Watcher;
	timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
	debounceMs?: number;
	// Stat polling of the database files while a page is connected (off when undefined). Idle (no page) it only re-checks for a page every STAT_IDLE_MS.
	statPollMs?: number;
	statSig?: (files: string[]) => string;
	statTimers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
	log?: (line: string) => void;
};

const STAT_IDLE_MS = 5000;

const fileSig = (files: string[]) =>
	files
		.map(f => {
			try {
				const s = statSync(f);
				return `${s.size}:${s.mtimeMs}`;
			} catch {
				return "-";
			}
		})
		.join(",");

const PAGE = 500;

const fsWatchDir = (dir: string, onFile: (name: string | null) => void): Watcher => {
	const w = watch(dir, { persistent: false }, (_event, name) => onFile(name === null ? null : String(name)));
	w.on("error", () => w.close());
	return w;
};

export function createLive(deps: LiveDeps) {
	const watchDir = deps.watchDir ?? fsWatchDir;
	const timers = deps.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
	const debounceMs = deps.debounceMs ?? 250;
	const statSig = deps.statSig ?? fileSig;
	const statTimers = deps.statTimers ?? { set: (fn: () => void, ms: number) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }, clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
	let key = "";
	let chats: string[] = [];
	let config: KakaoConfig | undefined;
	let last: string | undefined;
	let running = false;
	let again = false;
	let watchers: Watcher[] = [];
	let dbTimer: unknown;
	let draftTimer: unknown;
	let statTimer: unknown;
	let dbSig: string | undefined;
	let draftSigs = new Map<string, string>();
	// Per watched room, the raw read positions of its members (NTChatRoom.watermarkValues); a change = someone read more.
	let markSigs: Map<string, string> | undefined;

	const draftSignatures = (): Map<string, string> => {
		const sigs = new Map<string, string[]>();
		try {
			const raw = JSON.parse(readFileSync(deps.paths.drafts, "utf8"));
			for (const d of Array.isArray(raw) ? raw : []) if (d && typeof d.chatId === "string" && typeof d.code === "string") sigs.set(d.chatId, [...(sigs.get(d.chatId) ?? []), `${d.code}:${d.status}`]);
		} catch {}
		return new Map([...sigs].map(([chatId, list]) => [chatId, list.join(",")]));
	};

	const closeWatchers = () => {
		for (const w of watchers) w.close();
		watchers = [];
		if (dbTimer !== undefined) timers.clear(dbTimer);
		if (draftTimer !== undefined) timers.clear(draftTimer);
		dbTimer = draftTimer = undefined;
		if (statTimer !== undefined) statTimers.clear(statTimer);
		statTimer = undefined;
		dbSig = undefined;
	};

	// One stat look: with a page connected and the files changed since the last look, query now (the 500 ms tick is the debounce).
	const statTick = () => {
		statTimer = undefined;
		if (!config?.dbPath || !deps.statPollMs) return;
		let next = STAT_IDLE_MS;
		if (deps.subscribers() > 0) {
			next = deps.statPollMs;
			const sig = statSig([config.dbPath, `${config.dbPath}-wal`]);
			// The first look after a page connected also queries: rows may have landed while nobody listened.
			if (sig !== dbSig) {
				dbSig = sig;
				void poll();
			}
		} else dbSig = undefined;
		statTimer = statTimers.set(statTick, next);
	};

	// The new rows of the watched rooms since the last seen logId; one event per room with its newest logId.
	const pollOnce = async () => {
		if (!config || !chats.length || deps.subscribers() === 0) return;
		const db = await deps.openDb(config);
		if (last === undefined) {
			last = await maxLogId(db);
			markSigs = await watermarkSignatures(db, chats);
			return;
		}
		await pollNew(db, last);
		await pollMarks(db);
	};

	// One event per watched room whose read positions changed since the last look (ids only).
	const pollMarks = async (db: KakaoDb) => {
		const next = await watermarkSignatures(db, chats);
		if (!next.size) return;
		const prev = markSigs;
		markSigs = next;
		if (!prev) return;
		for (const [chatId, sig] of next) if (prev.has(chatId) && prev.get(chatId) !== sig) deps.broadcast({ kind: "kakao_read", chatId });
	};

	const pollNew = async (db: KakaoDb, from: string) => {
		last = from;
		for (;;) {
			const rows = await newInChats(db, last, chats, PAGE);
			if (!rows.length) return;
			const newest = new Map<string, string>();
			for (const r of rows) {
				newest.set(r.chatId, r.logId);
				if (BigInt(r.logId) > BigInt(last)) last = r.logId;
			}
			for (const [chatId, logId] of newest) deps.broadcast({ kind: "kakao", chatId, logId });
			if (rows.length < PAGE) return;
		}
	};

	const poll = async () => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			do {
				again = false;
				try {
					await pollOnce();
				} catch (e) {
					deps.log?.(`kakao live: query failed (${(e as Error).message.slice(0, 80)})`);
				}
			} while (again);
		} finally {
			running = false;
		}
	};

	const pollDrafts = () => {
		const next = draftSignatures();
		const changed = new Set<string>();
		for (const chatId of new Set([...next.keys(), ...draftSigs.keys()])) if (next.get(chatId) !== draftSigs.get(chatId)) changed.add(chatId);
		draftSigs = next;
		if (deps.subscribers() === 0) return;
		for (const chatId of changed) if (chats.includes(chatId)) deps.broadcast({ kind: "kakao_draft", chatId });
	};

	const onDbFile = (name: string | null) => {
		const base = config?.dbPath ? basename(config.dbPath) : "";
		if (name !== null && name !== base && name !== `${base}-wal`) return;
		if (dbTimer !== undefined) timers.clear(dbTimer);
		dbTimer = timers.set(() => {
			dbTimer = undefined;
			void poll();
		}, debounceMs);
	};
	const onDraftFile = (name: string | null) => {
		if (name !== null && name !== basename(deps.paths.drafts)) return;
		if (draftTimer !== undefined) timers.clear(draftTimer);
		draftTimer = timers.set(() => {
			draftTimer = undefined;
			pollDrafts();
		}, debounceMs);
	};

	const stop = () => {
		closeWatchers();
		key = "";
		chats = [];
		config = undefined;
		last = undefined;
		markSigs = undefined;
		draftSigs = new Map();
	};

	// (Re)reads the config: starts, restarts or stops the watchers. Called at gateway start and whenever the watched list changes.
	const sync = async () => {
		const next = deps.readConfig();
		const list = next?.enabled === true && next.dbPath ? (next.watch_chats ?? []) : [];
		if (!next || !list.length) return stop();
		const nextKey = `${next.dbPath}|${[...list].sort().join(",")}`;
		if (nextKey === key) return;
		closeWatchers();
		key = nextKey;
		config = next;
		chats = list;
		last = undefined;
		markSigs = undefined;
		draftSigs = draftSignatures();
		try {
			const draftDir = dirname(deps.paths.drafts);
			mkdirSync(draftDir, { recursive: true, mode: 0o700 });
			watchers = [watchDir(dirname(next.dbPath!), onDbFile), watchDir(draftDir, onDraftFile)];
		} catch (e) {
			deps.log?.(`kakao live: could not watch (${(e as Error).message.slice(0, 80)})`);
		}
		if (deps.statPollMs) statTimer = statTimers.set(statTick, deps.statPollMs);
		try {
			const db = await deps.openDb(next);
			last = await maxLogId(db);
			markSigs = await watermarkSignatures(db, list);
		} catch {
			last = undefined;
		}
	};

	return { sync, stop, poll, pollDrafts, onDbFile, onDraftFile, statTick };
}
