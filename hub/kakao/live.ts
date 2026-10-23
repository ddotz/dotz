// Live updates for the per-room KakaoTalk web view. No polling: fs.watch on the KakaoTalk database folder (db and -wal files) and on
// drafts.json, a ~250 ms debounce, and at most one query in flight, for the watched rooms only. Events carry ids only.
// With no web page connected the query is skipped and the last seen logId stays where it was, so the next query catches up.
import { mkdirSync, readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { type KakaoDb, maxLogId, newInChats } from "./db.ts";
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
	log?: (line: string) => void;
};

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
	let key = "";
	let chats: string[] = [];
	let config: KakaoConfig | undefined;
	let last: string | undefined;
	let running = false;
	let again = false;
	let watchers: Watcher[] = [];
	let dbTimer: unknown;
	let draftTimer: unknown;
	let draftSigs = new Map<string, string>();

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
	};

	// The new rows of the watched rooms since the last seen logId; one event per room with its newest logId.
	const pollOnce = async () => {
		if (!config || !chats.length || deps.subscribers() === 0) return;
		const db = await deps.openDb(config);
		if (last === undefined) {
			last = await maxLogId(db);
			return;
		}
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
		draftSigs = draftSignatures();
		try {
			const draftDir = dirname(deps.paths.drafts);
			mkdirSync(draftDir, { recursive: true, mode: 0o700 });
			watchers = [watchDir(dirname(next.dbPath!), onDbFile), watchDir(draftDir, onDraftFile)];
		} catch (e) {
			deps.log?.(`kakao live: could not watch (${(e as Error).message.slice(0, 80)})`);
		}
		try {
			last = await maxLogId(await deps.openDb(next));
		} catch {
			last = undefined;
		}
	};

	return { sync, stop, poll, pollDrafts, onDbFile, onDraftFile };
}
