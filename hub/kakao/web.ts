// Web side of the per-room KakaoTalk integration (contract: docs/kakao-rooms-api.md). Only rooms the owner chose (config watch_chats)
// are readable, sendable and shown. Everything is injected (database, runner, clock, paths, broadcast) so tests run without the app.
// Events carry ids only: never a body or a room name. Sends go only through send.ts (kmsg UI automation).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivate } from "./creds.ts";
import { type KakaoDb, memberLabel, messages, rooms, sentAtMs, TEXT_TYPE } from "./db.ts";
import { dropDraft, type Draft, listDrafts, markStale, newer, sendDraft, sendText, type SendResult } from "./send.ts";
import type { KakaoConfig, KakaoPaths, Room, Runner } from "./types.ts";

export type WebDeps = {
	paths: KakaoPaths;
	runner: Runner;
	now: () => number;
	openDb: (config: KakaoConfig) => Promise<KakaoDb>;
	broadcast: (event: Record<string, unknown>) => void;
	// The watched list changed (live.ts re-reads the config).
	onWatchChange?: () => void;
	kmsg?: string;
};

export type SendRecord = { id: string; chatId: string; text: string; state: "sending" | "sent" | "failed"; reason?: string; at: number; draft?: string };

const ROOMS_TTL_MS = 30_000;
const MAX_TEXT = 1000;
const MAX_SENDS = 200;
const SEND_WINDOW_MS = 24 * 3600 * 1000;
const OFF = { error: "카톡 연동이 꺼져 있어요" };
const LOST = "게이트웨이가 다시 시작돼서 결과를 확인하지 못했어요";

export function readConfig(paths: KakaoPaths): KakaoConfig | undefined {
	try {
		return JSON.parse(readFileSync(paths.config, "utf8"));
	} catch {
		return undefined;
	}
}

function writeConfig(paths: KakaoPaths, config: KakaoConfig): void {
	mkdirSync(dirname(paths.config), { recursive: true });
	const tmp = `${paths.config}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 1)}\n`);
	renameSync(tmp, paths.config);
}

const readJsonFile = <T>(file: string, fallback: T): T => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
};

const json = (data: unknown, status = 200) => Response.json(data, { status });
const digits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

export function createKakaoWeb(deps: WebDeps) {
	const { paths, now } = deps;
	const sendsFile = join(paths.dataDir, "kakao", "sends.json");
	const readsFile = join(paths.dataDir, "kakao", "reads.json");
	const pending = new Set<Promise<unknown>>();
	const inflight = new Set<string>();
	let dbCache: { path: string; db: KakaoDb } | undefined;
	let roomsCache: { at: number; all: Room[]; names: Map<string, string> } | undefined;

	const getDb = async (config: KakaoConfig) => {
		if (!config.dbPath) throw new Error("no database path");
		if (dbCache?.path !== config.dbPath) dbCache = { path: config.dbPath, db: await deps.openDb(config) };
		return dbCache.db;
	};

	// Rooms of the database, cached 30 s. Display names: a room without a name gets its members' names (display only).
	const allRooms = async (config: KakaoConfig, fresh = false) => {
		if (!fresh && roomsCache && now() - roomsCache.at < ROOMS_TTL_MS) return roomsCache;
		const db = await getDb(config);
		const all = await rooms(db);
		const names = new Map<string, string>();
		let looked = 0;
		for (const r of all) {
			if (r.name !== "(unknown)" || (r.kind !== "direct" && r.kind !== "group") || looked >= 10) continue;
			looked++;
			names.set(r.chatId, (await memberLabel(db, r.chatId, config.userId ?? "").catch(() => undefined)) ?? "이름 없는 방");
		}
		return (roomsCache = { at: now(), all, names });
	};
	const eligible = (all: Room[]) => all.filter(r => r.kind === "direct" || r.kind === "group");

	const storedSends = () => readJsonFile<SendRecord[]>(sendsFile, []);
	// A "sending" record nobody is working on (the gateway restarted meanwhile) is shown as failed.
	const sendList = (): SendRecord[] => storedSends().map(s => (s.state === "sending" && !inflight.has(s.id) ? { ...s, state: "failed", reason: LOST } : s));
	const saveSends = (list: SendRecord[]) => writePrivate(sendsFile, `${JSON.stringify(list.slice(-MAX_SENDS), null, 1)}\n`);

	const latestIncoming = async (config: KakaoConfig, chatId: string) =>
		(await messages(await getDb(config), chatId, 50, config.userId ?? "")).findLast(m => m.type === TEXT_TYPE && !m.fromMe)?.logId;

	// Runs a send in the background (the gateway-wide queue lives in send.ts) and records sending -> sent | failed.
	const start = (rec: SendRecord, job: () => Promise<SendResult>) => {
		saveSends([...storedSends(), rec]);
		deps.broadcast({ kind: "kakao_send", chatId: rec.chatId, id: rec.id, state: "sending" });
		inflight.add(rec.id);
		const run = (async () => {
			let r: SendResult;
			try {
				r = await job();
			} catch {
				r = { ok: false, reason: "보내는 중 오류가 났어요" };
			}
			inflight.delete(rec.id);
			const state = r.ok ? "sent" : "failed";
			const reason = r.ok ? undefined : (r.reason ?? "보내지 못했어요");
			saveSends(storedSends().map(s => (s.id === rec.id ? { ...s, state, ...(reason ? { reason } : {}) } : s)));
			deps.broadcast({ kind: "kakao_send", chatId: rec.chatId, id: rec.id, state, ...(reason ? { reason } : {}) });
			if (rec.draft) deps.broadcast({ kind: "kakao_draft", chatId: rec.chatId });
		})();
		pending.add(run);
		void run.finally(() => pending.delete(run));
	};
	const newRecord = (chatId: string, text: string, draft?: string): SendRecord => ({ id: `S${now().toString(36)}${randomBytes(3).toString("hex")}`, chatId, text, state: "sending", at: now(), ...(draft ? { draft } : {}) });

	async function route(req: Request, url: URL, parts: string[]): Promise<Response | undefined> {
		if (parts[0] !== "api" || parts[1] !== "kakao") return undefined;
		const config = readConfig(paths);
		const on = config?.enabled === true;
		const watched = new Set(config?.watch_chats ?? []);
		const area = parts[2];
		const method = req.method;
		const body = async (): Promise<Record<string, any>> => ((await req.json().catch(() => ({}))) as Record<string, any>) ?? {};

		if (area === "rooms" && parts.length === 3 && method === "GET") {
			if (!on) return json({ on: false, rooms: [] });
			try {
				const cache = await allRooms(config!);
				const list = eligible(cache.all)
					.sort((a, b) => b.lastAt - a.lastAt)
					.map(r => ({ chatId: r.chatId, name: cache.names.get(r.chatId) ?? r.name, kind: r.kind, watched: watched.has(r.chatId), unread: r.unread, lastAt: sentAtMs(r.lastAt) }));
				return json({ on: true, rooms: list });
			} catch {
				return json({ on: true, rooms: [], error: "카톡 데이터를 읽지 못했어요. 전체 디스크 접근 권한과 카카오톡 로그인을 확인해 주세요" });
			}
		}
		if (area === "rooms" && parts.length === 4 && method === "PUT") {
			if (!on) return json(OFF, 409);
			const chatId = decodeURIComponent(parts[3]!);
			const b = await body();
			if (!digits(chatId) || typeof b.watched !== "boolean") return json({ error: "watched (true/false) is required" }, 400);
			const current = config!.watch_chats ?? [];
			const next = b.watched ? [...new Set([...current, chatId])] : current.filter(c => c !== chatId);
			writeConfig(paths, { ...config!, watch_chats: next });
			deps.broadcast({ kind: "kakao_rooms" });
			deps.onWatchChange?.();
			return json({ ok: true, watched: next });
		}

		if (area === "chat" && parts.length >= 4) {
			if (!on) return json(OFF, 409);
			const chatId = decodeURIComponent(parts[3]!);
			if (!watched.has(chatId)) return json({ error: "이 대화방은 보고 있지 않아요" }, 403);
			const sub = parts[4];

			if (parts.length === 4 && method === "GET") {
				const limit = Math.max(1, Math.min(Math.trunc(Number(url.searchParams.get("limit") ?? 80)) || 80, 200));
				const before = url.searchParams.get("before") ?? undefined;
				const after = url.searchParams.get("after") ?? undefined;
				if ((before !== undefined && !digits(before)) || (after !== undefined && !digits(after))) return json({ error: "before / after must be a logId" }, 400);
				try {
					const room = eligible((await allRooms(config!)).all).find(r => r.chatId === chatId);
					if (!room) return json({ error: "대화방을 찾지 못했어요" }, 404);
					const list = await messages(await getDb(config!), chatId, limit, config!.userId ?? "", after !== undefined ? { after } : before !== undefined ? { before } : {});
					const since = now() - SEND_WINDOW_MS;
					return json({
						room: { chatId, name: roomsCache?.names.get(chatId) ?? room.name, kind: room.kind, group: room.kind === "group" },
						// Only text bodies are shown; the body of a photo or file message is an attachment record, not text.
						messages: list.map(m => ({ logId: m.logId, authorId: m.authorId, sender: m.sender, text: m.type === TEXT_TYPE ? m.text : "", type: m.type, sentAt: sentAtMs(m.sentAt), fromMe: m.fromMe })),
						read: readJsonFile<Record<string, string>>(readsFile, {})[chatId] ?? null,
						kakaoUnread: room.unread,
						drafts: (await listDrafts({ paths, runner: deps.runner }))
							.filter(d => d.chatId === chatId && d.status === "pending")
							.map(d => ({ code: d.code, text: d.text, basisLogId: d.basisLogId, created: d.created })),
						sends: sendList()
							.filter(s => s.chatId === chatId && s.at >= since)
							.map(({ id, text, state, reason, at, draft }) => ({ id, text, state, ...(reason ? { reason } : {}), at, ...(draft ? { draft } : {}) })),
					});
				} catch {
					return json({ error: "카톡 데이터를 읽지 못했어요" }, 502);
				}
			}

			if (sub === "read" && parts.length === 5 && method === "POST") {
				const b = await body();
				if (!digits(b.logId)) return json({ error: "logId is required" }, 400);
				const reads = readJsonFile<Record<string, string>>(readsFile, {});
				if (!reads[chatId] || BigInt(b.logId) > BigInt(reads[chatId])) writePrivate(readsFile, `${JSON.stringify({ ...reads, [chatId]: b.logId }, null, 1)}\n`);
				return json({ ok: true });
			}

			if (sub === "send" && parts.length === 5 && method === "POST") {
				const text = String((await body()).text ?? "");
				if (!text.trim() || [...text].length > MAX_TEXT) return json({ error: `글은 1자에서 ${MAX_TEXT}자 사이여야 해요` }, 400);
				const rec = newRecord(chatId, text);
				start(rec, async () => {
					const cache = await allRooms(config!, true);
					const room = cache.all.find(r => r.chatId === chatId);
					if (!room) return { ok: false, reason: "대화방을 찾지 못했어요" };
					return sendText({ chatId, roomName: room.name, text }, { paths, runner: deps.runner, now, kmsg: deps.kmsg, roomNames: async () => cache.all.map(({ chatId, name }) => ({ chatId, name })) });
				});
				return json({ id: rec.id, state: "sending" }, 202);
			}
			return undefined;
		}

		if (area === "drafts" && parts.length === 5 && method === "POST" && (parts[4] === "send" || parts[4] === "drop")) {
			if (!on) return json(OFF, 409);
			const code = decodeURIComponent(parts[3]!);
			const draft: Draft | undefined = (await listDrafts({ paths, runner: deps.runner })).find(d => d.code === code);
			if (!draft) return json({ error: "그 초안을 찾지 못했어요" }, 404);
			if (!watched.has(draft.chatId)) return json({ error: "이 대화방은 보고 있지 않아요" }, 403);
			if (parts[4] === "drop") {
				const r = dropDraft(code, { paths });
				if (!r.ok) return json({ error: r.reason }, 409);
				deps.broadcast({ kind: "kakao_draft", chatId: draft.chatId });
				return json({ ok: true });
			}
			if (draft.status !== "pending") return json({ error: "이 초안은 더 이상 보낼 수 없어요" }, 409);
			const edited = (await body()).text;
			if (edited !== undefined && (typeof edited !== "string" || !edited.trim() || [...edited].length > MAX_TEXT)) return json({ error: `글은 1자에서 ${MAX_TEXT}자 사이여야 해요` }, 400);
			let latest: string | undefined;
			try {
				latest = await latestIncoming(config!, draft.chatId);
			} catch {
				return json({ error: "새 메시지가 왔는지 확인하지 못했어요" }, 502);
			}
			if (latest && newer(latest, draft.basisLogId)) {
				markStale(paths, code);
				deps.broadcast({ kind: "kakao_draft", chatId: draft.chatId });
				return json({ error: "그사이 새 메시지가 와서 초안이 낡았어요" }, 409);
			}
			const rec = newRecord(draft.chatId, edited ?? draft.text, code);
			start(rec, async () => {
				const cache = await allRooms(config!, true);
				return sendDraft(code, {
					paths,
					runner: deps.runner,
					now,
					kmsg: deps.kmsg,
					ownerApproved: true,
					...(edited !== undefined ? { text: edited } : {}),
					latestIncoming: id => latestIncoming(config!, id),
					roomNames: async () => cache.all.map(({ chatId, name }) => ({ chatId, name })),
				});
			});
			return json({ id: rec.id, state: "sending" }, 202);
		}
		return undefined;
	}

	// Resolves when every background send has finished (tests; shutdown).
	const idle = async () => {
		while (pending.size) await Promise.all([...pending]);
	};
	return { route, idle };
}
