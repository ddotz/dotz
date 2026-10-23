// Watch check for the dotz gateway (dotz_watch script, runs every minute): prints one line per room with new text messages
// and nothing when there are none. Lines carry ids and times only, never bodies or names. Failures print `DOTZ_FAIL <kind>`
// plus one plain line and exit 1. State lives in $DOTZ_WATCH_STATE_DIR: sig (db file stat), last-id, held.json.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDraftCandidate, maxLogId, newSince, ownUserId, roomKind, roomTypes, sentAtMs, sqlcipherDb, TEXT_TYPE, type KakaoDb } from "./db.ts";
import { defaultRunner, type KakaoConfig, kakaoPaths } from "./types.ts";

export type WatchDeps = {
	db: KakaoDb;
	config?: KakaoConfig;
	stateDir: string;
	now: () => number;
	dbFiles?: string[];
};
export type WatchResult = { lines: string[]; code: number };

const FETCH_LIMIT = 500;
// A message older than this is never reported: a room switched to 자동 초안 later must not wake the bot for old talk.
const MAX_AGE_MS = 30 * 60 * 1000;

const readText = (file: string) => {
	try {
		return readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
};

const writeAtomic = (file: string, text: string) => {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
};

const signature = (files: string[]) =>
	files
		.map((f) => {
			try {
				const s = statSync(f);
				return `${s.size}:${s.mtimeMs}`;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return "-";
				throw err;
			}
		})
		.join(",");

export async function runWatch(deps: WatchDeps): Promise<WatchResult> {
	const { db, config, stateDir, now } = deps;
	if (!config?.enabled) return { lines: ["DOTZ_FAIL off", "카톡 연동이 꺼져 있어요."], code: 1 };
	mkdirSync(stateDir, { recursive: true });
	const file = (name: string) => join(stateDir, name);
	// Held rooms need another run even when the database did not change.
	const held: Record<string, string> = JSON.parse(readText(file("held.json")) ?? "{}");
	const lastText = readText(file("last-id"))?.trim();

	const sig = deps.dbFiles ? signature(deps.dbFiles) : undefined;
	if (sig !== undefined && lastText !== undefined && Object.keys(held).length === 0 && readText(file("sig")) === sig) return { lines: [], code: 0 };

	if (lastText === undefined) {
		writeAtomic(file("held.json"), "{}");
		writeAtomic(file("last-id"), await maxLogId(db));
		if (sig !== undefined) writeAtomic(file("sig"), sig);
		return { lines: [], code: 0 };
	}

	// Only rooms that are chosen AND on 자동 초안 can wake the bot; with none, the database is not read at all.
	const auto = new Set((config.auto_draft_chats ?? []).filter((c) => config.watch_chats?.includes(c)));
	if (auto.size === 0) return { lines: [], code: 0 };

	const lastId = BigInt(lastText);
	const heldFirst = Object.values(held).map((v) => BigInt(v));
	const fetchFrom = heldFirst.reduce((lo, v) => (v - 1n < lo ? v - 1n : lo), lastId);
	const fetched = await newSince(db, String(fetchFrom), FETCH_LIMIT);
	const truncated = fetched.length >= FETCH_LIMIT;
	let newLast = lastId;
	const candidates = fetched.filter((r) => {
		const id = BigInt(r.logId);
		if (id > newLast) newLast = id;
		const heldFrom = held[r.chatId];
		return id > lastId || (heldFrom !== undefined && id >= BigInt(heldFrom));
	});

	let rows = candidates.filter((r) => r.type === TEXT_TYPE && auto.has(r.chatId) && now() - sentAtMs(r.sentAt) <= MAX_AGE_MS);
	if (rows.length > 0) {
		const me = config.userId !== undefined ? String(config.userId) : await ownUserId(db);
		rows = rows.filter((r) => r.authorId !== me);
	}
	if (rows.length > 0) {
		const types = await roomTypes(db);
		rows = rows.filter((r) => {
			const type = types.get(r.chatId);
			return type !== undefined && isDraftCandidate({ chatId: r.chatId, kind: roomKind(type) }, config);
		});
	}

	const batches = new Map<string, typeof rows>();
	for (const r of rows) batches.set(r.chatId, [...(batches.get(r.chatId) ?? []), r]);

	const settleMs = (config.settle_seconds ?? 20) * 1000;
	const maxPerRun = config.max_per_run ?? 10;
	const nextHeld: Record<string, string> = {};
	const lines: string[] = [];
	for (const [chatId, batch] of batches) {
		const first = batch[0]?.logId as string;
		const newest = Math.max(...batch.map((r) => sentAtMs(r.sentAt)));
		const settled = chatId in held || now() - newest >= settleMs;
		if (!settled || lines.length >= maxPerRun) {
			nextHeld[chatId] = first;
			continue;
		}
		const last = batch[batch.length - 1]?.logId as string;
		lines.push(`kakao chat=${chatId} new=${batch.length} from=${first} to=${last} at=${new Date(newest).toISOString()}`);
	}

	writeAtomic(file("held.json"), JSON.stringify(nextHeld));
	writeAtomic(file("last-id"), String(newLast));
	const pending = truncated || Object.keys(nextHeld).length > 0;
	if (sig !== undefined && !pending) writeAtomic(file("sig"), sig);
	return { lines, code: 0 };
}

class WatchFailure extends Error {
	constructor(
		readonly kind: "nokey" | "db" | "fda",
		message: string,
	) {
		super(message);
	}
}

const loadConfig = (file: string): KakaoConfig | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

// The key is fetched only when the database actually has to be read. The module path is a variable so a build of this
// script does not need creds.ts to exist.
const CREDS_MODULE = "./creds.ts";
type GetSecret = (name: string, ctx: { paths: ReturnType<typeof kakaoPaths>; runner: typeof defaultRunner }) => Promise<string | undefined>;
const lazyDb = (config: KakaoConfig, paths: ReturnType<typeof kakaoPaths>): KakaoDb => {
	let inner: KakaoDb | undefined;
	return {
		async query(sql, params) {
			if (!inner) {
				if (!config.dbPath) throw new WatchFailure("db", "카톡 설정에 DB 위치가 없어요. 설정을 다시 이어서 해 주세요.");
				const { getSecret } = (await import(CREDS_MODULE)) as { getSecret: GetSecret };
				const key = await getSecret("dbkey", { paths, runner: defaultRunner });
				if (!key) throw new WatchFailure("nokey", "카톡 DB 키가 저장돼 있지 않아요. 설정을 다시 이어서 해 주세요.");
				inner = sqlcipherDb(config.dbPath, key, defaultRunner);
			}
			return inner.query(sql, params);
		},
	};
};

const failureOf = (err: unknown): { kind: string; message: string } => {
	if (err instanceof WatchFailure) return { kind: err.kind, message: err.message };
	const message = err instanceof Error ? err.message : String(err);
	const code = (err as NodeJS.ErrnoException)?.code;
	if (code === "EPERM" || code === "EACCES" || /operation not permitted|EPERM/i.test(message))
		return { kind: "fda", message: "전체 디스크 접근 권한이 없어서 카톡 DB를 못 읽어요." };
	return { kind: "db", message: `카톡 DB를 읽지 못했어요: ${message.slice(0, 200)}` };
};

if (import.meta.main) {
	const stateDir = process.env.DOTZ_WATCH_STATE_DIR;
	if (!stateDir) {
		console.error("DOTZ_WATCH_STATE_DIR is required; run it as a dotz_watch script.");
		process.exit(2);
	}
	const paths = kakaoPaths(process.env.DOTZ_DIR ?? join(homedir(), ".dotz"));
	const config = loadConfig(paths.config);
	let result: WatchResult;
	try {
		result = await runWatch({
			db: config ? lazyDb(config, paths) : ({ query: async () => [] } satisfies KakaoDb),
			config,
			stateDir,
			now: Date.now,
			dbFiles: config?.dbPath ? [config.dbPath, `${config.dbPath}-wal`] : undefined,
		});
	} catch (err) {
		const { kind, message } = failureOf(err);
		result = { lines: [`DOTZ_FAIL ${kind}`, message], code: 1 };
	}
	if (result.lines.length > 0) console.log(result.lines.join("\n"));
	process.exit(result.code);
}
