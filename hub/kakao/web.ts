// Web side of the per-room KakaoTalk integration (contract: docs/kakao-rooms-api.md). Only rooms the owner chose (config watch_chats)
// are readable, sendable and shown. Everything is injected (database, runner, clock, paths, broadcast) so tests run without the app.
// Events carry ids only: never a body or a room name. Sends go only through send.ts (Accessibility UI automation).
import type { useReplies } from "../reply-actions.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { createLinkPreview, type Resolver } from "../linkpreview.ts";
import { featureEnabled } from "../app-feature-flags.ts";
import { addOnce, dispatchSend, type Lease } from "./contract.ts";
import { writePrivate } from "./creds.ts";
import { hasWords, type KakaoDb, lastLines, memberLabels, messageById, ownerNames, peopleNames, readText, roomShown, messages, roomHead, rooms, sentAtMs, unreadCount, watermarks } from "./db.ts";
import { type DraftModel, draftParts, type StyleHint, type VoiceSource } from "./draft.ts";
import { makeDraft } from "./make-draft.ts";
import { buildPersonPrompt, personStats, type PersonStats } from "./person.ts";
import { fetchMedia, mediaTarget, replySource, serveLocalFile } from "./media.ts";
import { type AxStep, type Focus, sameText } from "./room.ts";
import { createDraft, type Draft, listDrafts, markStale, newer, readDrafts, type SendMs, type SendResult } from "./send.ts";
import type { KakaoConfig, KakaoPaths, Room, Runner } from "./types.ts";
import { chatView, clip, owedRooms, pendingRow, watchLists, withSummary } from "./web-shape.ts";
import { json } from "../routes-util.ts";

export type WebDeps = {
	paths: KakaoPaths;
	runner: Runner;
	now: () => number;
	openDb: (config: KakaoConfig) => Promise<KakaoDb>;
	broadcast: (event: Record<string, unknown>) => void;
	// The watched list changed (live.ts re-reads the config).
	onWatchChange?: () => void;
	// How a send watchdog is scheduled (tests pass their own; the default is an unref'd timer).
	later?: (fn: () => void, ms: number) => void;
	// This machine's name, stamped on every message and send record (default: the host name).
	collector?: string;
	// Whether this machine may send into a chat right now (contract.ts dispatchSend). Default: always.
	lease?: Lease;
	// The one cheap model call behind POST /api/kakao/chat/<id>/draft. Without it the route answers 503.
	draftModel?: DraftModel;
	// The live reply flow (hub/reply-wire.ts): a typed message becomes the owner's own draft and is sent through it; absent (a surface built alone in a test) = this file's own path.
	replies?: typeof useReplies;
	// The reply-drafts tone profile of a room (optional extra for the prompt).
	draftStyle?: (chatId: string) => StyleHint | undefined;
	// Learns (first draft) or refreshes (every 200 own lines) the owner's voice profile of the room and the global one, before the prompt is built.
	// It gets the room's messages (read once to write the profile) and counts of the owner's own lines.
	learnVoice?: (src: VoiceSource) => Promise<void>;
	// A revise of a draft ("더 짧게") was stored: what it teaches beyond this draft (the model's lesson) goes into the room's tone profile.
	onRevise?: (chatId: string, lesson: string) => void;
	// The fetch behind GET /api/kakao/media/... and GET /api/link-preview (default: the global fetch).
	fetch?: typeof fetch;
	// How link previews resolve host names (default: dns.lookup); tests pass their own.
	previewResolve?: Resolver;
	previewAllowHosts?: string[];
};

// retried: the id of the send that 다시 보내기 started for this failed one (this record is kept for its attempts, no longer listed).
export type SendRecord = { id: string; chatId: string; text: string; state: "sending" | "sent" | "failed"; reason?: string; at: number; draft?: string; collector?: string; ms?: SendMs; ax?: AxStep[]; focus?: Focus; retried?: string };

const ROOMS_TTL_MS = 30_000;
const CHAT_PAGE = 50;
// How far back 미답장 looks for a message addressed to the owner (a busy group or open room has chatter after it).
const HINT_MAX = 32;
// A room with no name and no message of anyone else to name it by: what kind of room it is, with its size.
const fallbackName = (r: Room): string => (r.kind === "direct" ? "1:1 대화방" : r.kind === "open" ? "오픈채팅방" : `단체 대화방${r.members ? ` ${r.members}명` : ""}`);
const MAX_TEXT = 1000;
const MAX_SENDS = 200;
const SEND_WINDOW_MS = 24 * 3600 * 1000;
const OFF = { error: "카톡 연동이 꺼져 있어요" };
const LOST = "게이트웨이가 다시 시작돼서 결과를 확인하지 못했어요";
const INTENT_MAX = 300;
const STUCK_MS = 60_000;
// A model error that is the subscription limit (or its 429), shown to the owner as is.
const LIMIT_ERROR = /구독 한도|구독 계정|limit|quota|429|rate/i;
const STUCK = "60초가 지나도 끝나지 않아서 실패로 처리했어요";
const READS_MAX = 500;
// A cached room head is trusted this long even when the database files look unchanged.
const HEAD_TTL_MS = 10_000;
const PERSON_TTL_MS = 60_000;
const PERSON_READ = 200;

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


const digits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

export function createKakaoWeb(deps: WebDeps) {
	// One answer shape for every route that acts through the one reply flow: the old keys plus the item.
	const viaReplies = async (input: Record<string, unknown>): Promise<Response | undefined> => {
		const replies = deps.replies?.();
		if (!replies) return undefined;
		const r = await replies.act(input as Parameters<typeof replies.act>[0], { surface: "web" });
		return r.body.ok ? json({ ok: true, ...(r.body.item ? { item: r.body.item, state: r.body.item.send?.state ?? "drafting" } : {}) }, r.status) : json({ error: r.body.error, code: r.body.code, ...(r.body.lint ? { lint: r.body.lint } : {}) }, r.status);
	};
	const { paths, now } = deps;
	const later = deps.later ?? ((fn: () => void, ms: number) => (setTimeout(fn, ms) as { unref?: () => void }).unref?.());
	const collector = deps.collector ?? hostname();
	const drafting = new Set<string>();
	const sendsFile = join(paths.dataDir, "kakao", "sends.json");
	const asksFile = join(paths.dataDir, "kakao", "asks.json");
	const readsFile = join(paths.dataDir, "kakao", "reads.json");
	const personFile = join(paths.dataDir, "kakao", "person-summaries.json");
	let personCache: { key: string; at: number; stats: PersonStats } | undefined;
	const pending = new Set<Promise<unknown>>();
	const inflight = new Set<string>();
	const linkPreview = createLinkPreview({ dir: paths.dataDir, now, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.previewResolve ? { resolve: deps.previewResolve } : {}), ...(deps.previewAllowHosts ? { allowHosts: deps.previewAllowHosts } : {}) });
	let dbCache: { path: string; db: KakaoDb } | undefined;
	let roomsCache: { at: number; all: Room[]; names: Map<string, string>; hints: Map<string, string> } | undefined;
	// Newest logId per room for GET .../head (a peer's viewer asks every ~2 s). While the database files do not change, the answer comes from here and no query runs.
	let headCache: { sig: string; at: number; heads: Map<string, string> } | undefined;

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
		for (const r of all) {
			// The memo chat has no name in the database; KakaoTalk lists and finds it under the owner's own nickname.
			if (r.kind === "self" && r.name === "(unknown)") {
				const own = (await db.query("SELECT nickName FROM NTUser WHERE userId = ? AND linkId = 0 LIMIT 1", [String(config.userId ?? "")]).catch(() => []))[0]?.nickName;
				if (typeof own === "string" && own.trim()) r.name = own.trim();
				names.set(r.chatId, "나와의 채팅");
				continue;
			}
		}
		// Every other room without a name: its members (KakaoTalk's own way), else what kind of room it is; never "(unknown)". One query for all.
		const unnamed = all.filter(r => r.name === "(unknown)" && r.kind !== "self");
		const labels = await memberLabels(db, unnamed, config.userId ?? "").catch(() => new Map<string, string>());
		for (const r of unnamed) names.set(r.chatId, labels.get(r.chatId) ?? fallbackName(r));
		const hints = await lastLines(db, all.map(r => r.chatId)).catch(() => new Map<string, string>());
		return (roomsCache = { at: now(), all, names, hints });
	};
	const eligible = (all: Room[], config: KakaoConfig) => all.filter(r => r.kind === "self" || roomShown(r.kind, config));
	// One room of the list and its display name, for opening it: from the cached list when it is fresh, else that room's own row (one small query,
	// so opening a room never re-reads the whole list).
	const findRoom = async (config: KakaoConfig, chatId: string): Promise<{ room: Room; name: string } | undefined> => {
		const cached = roomsCache && now() - roomsCache.at < ROOMS_TTL_MS ? roomsCache : undefined;
		const room = cached ? cached.all.find(r => r.chatId === chatId) : (await rooms(await getDb(config), chatId))[0];
		if (!room || !eligible([room], config).length) return undefined;
		const known = roomsCache?.names.get(chatId);
		if (known || room.name !== "(unknown)") return { room, name: known ?? room.name };
		if (room.kind === "self") return { room, name: "나와의 채팅" };
		const label = (await memberLabels(await getDb(config), [room], config.userId ?? "").catch(() => new Map<string, string>())).get(chatId);
		return { room, name: label ?? fallbackName(room) };
	};
	// Under the name in the list: the newest message, else the member count, so two rooms of the same name can be told apart.
	const hintOf = (r: Room, hints: Map<string, string>) => clip(hints.get(r.chatId) ?? "", HINT_MAX) || `${r.members ?? 0}명`;

	const storedSends = () => readJsonFile<SendRecord[]>(sendsFile, []);
	// A "sending" record nobody is working on (the gateway restarted meanwhile) is shown as failed.
	// A send whose job still runs here stays "sending" however long it takes (its ladder may still press; see the watchdog in start).
	const sendList = (): SendRecord[] => storedSends().map(s => (s.state !== "sending" || inflight.has(s.id) ? s : { ...s, state: "failed", reason: LOST }));
	const saveSends = (list: SendRecord[]) => writePrivate(sendsFile, `${JSON.stringify(list.slice(-MAX_SENDS), null, 1)}\n`);

	// 미답장 (hub/unreplied.ts): per watched room the logId of the message that waits for the owner (address.ts owedMessage: in a 1:1 room the other
	// person's newest, in a group or open room only one addressed to him) that no reply followed (his own message in the database, or a send of
	// ours that finished after it, ends it). 답장 안 함 keeps the logId he waved off in kakao/unreplied.json. Cached like the room list.
	const unrepliedFile = join(paths.dataDir, "kakao", "unreplied.json");
	const waved = () => readJsonFile<Record<string, string>>(unrepliedFile, {});
	let waiting: { at: number; rooms: Map<string, string> } | undefined;
	const waitingRooms = async (config: KakaoConfig, fresh = false): Promise<Map<string, string>> => {
		if (!fresh && waiting && now() - waiting.at < ROOMS_TTL_MS) return waiting.rooms;
		const db = await getDb(config);
		const out = await owedRooms(db, config, sendList().filter(s => s.state === "sent"), waved(), now);
		waiting = { at: now(), rooms: out };
		return out;
	};
	const draftFacts = {
		drafts: async () => (await listDrafts({ paths, runner: deps.runner })).map(d => ({ code: d.code, chatId: d.chatId, status: d.status, created: d.created })),
		waiting: async (chatId: string): Promise<boolean | undefined> => {
			const config = readConfig(paths);
			if (config?.enabled !== true || !(config.watch_chats ?? []).includes(chatId)) return undefined;
			return (await waitingRooms(config).catch(() => undefined))?.has(chatId);
		},
	};
	// The pending reply drafts of the watched rooms for the one 답장 확인 queue (GET /api/kakao/drafts): the draft, its room's name and the message it
	// answers (one row read per draft, never the whole room). `skip`: codes a send-approval notice already shows (hub/draft-approval.ts ref).
	const pendingOf = (config: KakaoConfig | undefined, skip: ReadonlySet<string> = new Set()) =>
		config?.enabled === true ? readDrafts(paths).filter(d => d.status === "pending" && (config.watch_chats ?? []).includes(d.chatId) && !skip.has(d.code)) : [];
	const pendingDrafts = async (skip?: ReadonlySet<string>) => {
		const config = readConfig(paths), list = pendingOf(config, skip);
		const db = list.length ? await getDb(config!).catch(() => undefined) : undefined;
		return Promise.all(list.map(d => pendingRow(d, db, config!.userId ?? "", roomsCache?.names.get(d.chatId) ?? d.roomName)));
	};
	/** How many reply drafts wait in the watched rooms (the app row's 답장 확인 count): the drafts file only, no database read. */
	const pendingCount = (skip?: ReadonlySet<string>): number => pendingOf(readConfig(paths), skip).length;
	let lastCount = 0;
	// Only rooms that are still watched count (a room taken off the list mid-cache must not keep the number up).
	const owedIn = (rooms: Map<string, string>, config: KakaoConfig) => [...rooms.keys()].filter(id => (config.watch_chats ?? []).includes(id)).length;
	// The count the app row shows: answered from the last look so the integration list never waits on the database; a stale look refreshes in the background.
	const unrepliedCount = (): number => {
		const config = readConfig(paths);
		if (config?.enabled !== true) return 0;
		if (!waiting || now() - waiting.at >= ROOMS_TTL_MS)
			void waitingRooms(config, true).then(r => {
				const n = owedIn(r, config);
				if (n !== lastCount) deps.broadcast({ kind: "kakao_unreplied" });
				lastCount = n;
			}, () => {});
		return waiting ? owedIn(waiting.rooms, config) : lastCount;
	};

	const latestIncoming = async (config: KakaoConfig, chatId: string) =>
		(await messages(await getDb(config), chatId, 50, config.userId ?? "")).findLast(m => hasWords(m) && !m.fromMe)?.logId;

	// Runs a send in the background (the gateway-wide queue lives in send.ts) and records sending -> sent | failed.
	const start = (rec: SendRecord, job: () => Promise<SendResult>) => {
		saveSends(addOnce(storedSends(), rec));
		deps.broadcast({ kind: "kakao_send", chatId: rec.chatId, id: rec.id, state: "sending" });
		inflight.add(rec.id);
		// Watchdog: a send still "sending" after STUCK_MS is failed for the owner, but never while its job still runs in this process: a send
		// whose ladder can still press must not read "failed" (the owner would send again and the message would go twice). It looks again then.
		const watch = () => {
			if (storedSends().find(s => s.id === rec.id)?.state !== "sending") return;
			if (inflight.has(rec.id)) return later(watch, STUCK_MS);
			saveSends(storedSends().map(s => (s.id === rec.id ? { ...s, state: "failed", reason: STUCK } : s)));
			deps.broadcast({ kind: "kakao_send", chatId: rec.chatId, id: rec.id, state: "failed", reason: STUCK });
		};
		later(watch, STUCK_MS);
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
			saveSends(storedSends().map(s => (s.id === rec.id ? { ...s, state, ...(reason ? { reason } : {}), ...(r.ms ? { ms: r.ms } : {}), ...(r.ax ? { ax: r.ax } : {}), ...(r.focus ? { focus: r.focus } : {}) } : s)));
			deps.broadcast({ kind: "kakao_send", chatId: rec.chatId, id: rec.id, state, ...(reason ? { reason } : {}) });
			if (rec.draft) deps.broadcast({ kind: "kakao_draft", chatId: rec.chatId });
		})();
		pending.add(run);
		void run.finally(() => pending.delete(run));
	};
	const newRecord = (chatId: string, text: string, draft?: string): SendRecord => ({ id: `S${now().toString(36)}${randomBytes(3).toString("hex")}`, chatId, text, state: "sending", at: now(), collector, ...(draft ? { draft } : {}) });

	// The open question of a room (the model found that the last message needs the owner's decision): one per room, shown as choice buttons.
	const storedAsks = () => readJsonFile<Record<string, StoredAsk>>(asksFile, {});
	const setAsk = (chatId: string, ask: StoredAsk | undefined) => {
		const { [chatId]: _old, ...rest } = storedAsks();
		writePrivate(asksFile, `${JSON.stringify(ask ? { ...rest, [chatId]: ask } : rest, null, 1)}\n`);
	};
	// The room's open question, unless a newer incoming message has made it stale (then it is forgotten).
	const openAsk = async (config: KakaoConfig, chatId: string) => {
		const a = storedAsks()[chatId];
		if (!a) return undefined;
		const latest = await latestIncoming(config, chatId).catch(() => undefined);
		if (latest && newer(latest, a.basisLogId)) return void setAsk(chatId, undefined);
		return { question: a.question, choices: a.choices };
	};

	const draftCtx = { deps, paths, now, getDb, allRooms, eligible, setAsk, storedAsks };

	async function route(req: Request, url: URL, parts: string[]): Promise<Response | undefined> {
		if (parts[0] === "api" && parts[1] === "link-preview") return linkPreview.route(req, url, parts);
		if (parts[0] !== "api" || parts[1] !== "kakao") return undefined;
		const config = readConfig(paths);
		const on = config?.enabled === true;
		const watched = new Set(config?.watch_chats ?? []);
		const auto = new Set(config?.auto_draft_chats ?? []);
		const area = parts[2];
		const method = req.method;
		const body = async (): Promise<Record<string, any>> => ((await req.json().catch(() => ({}))) as Record<string, any>) ?? {};
		// A typed send of exactly a pending draft's text (an older web's 다시 보내기) without the reply flow: part by part from its first unsent part
		// (send.ts sendClaimed), never as one joined message.
		const sendDraftNow = async (draft: Draft): Promise<Response> => {
			if (draft.status !== "pending") return json({ error: draft.status === "sent" ? "이미 보낸 초안이에요" : "이 초안은 더 이상 보낼 수 없어요" }, 409);
			let latest: string | undefined;
			try {
				latest = await latestIncoming(config!, draft.chatId);
			} catch {
				return json({ error: "새 메시지가 왔는지 확인하지 못했어요" }, 502);
			}
			if (latest && newer(latest, draft.basisLogId)) {
				markStale(paths, draft.code);
				deps.broadcast({ kind: "kakao_draft", chatId: draft.chatId });
				return json({ error: "그사이 새 메시지가 와서 초안이 낡았어요" }, 409);
			}
			const rec = newRecord(draft.chatId, draft.text, draft.code);
			start(rec, async () => {
				const cache = await allRooms(config!, true);
				return dispatchSend({ kind: "draft", code: draft.code, ownerApproved: true }, {
					paths,
					runner: deps.runner,
					now,
					lease: deps.lease,
					latestIncoming: id => latestIncoming(config!, id),
					roomNames: async () => cache.all.map(({ chatId, name, kind, members }) => ({ chatId, name, kind, members })),
				});
			});
			return json({ id: rec.id, state: "sending" }, 202);
		};

		if (area === "rooms" && parts.length === 3 && method === "GET") {
			if (!on) return json({ on: false, rooms: [] });
			try {
				const cache = await allRooms(config!);
				const owed = await waitingRooms(config!).catch(() => new Map<string, string>());
				const list = eligible(cache.all, config!)
					.sort((a, b) => b.lastAt - a.lastAt)
					.map(r => ({ chatId: r.chatId, name: cache.names.get(r.chatId) ?? r.name, hint: hintOf(r, cache.hints), kind: r.kind, watched: watched.has(r.chatId), autoDraft: watched.has(r.chatId) && auto.has(r.chatId), unread: r.unread, unreplied: watched.has(r.chatId) && owed.has(r.chatId), lastAt: sentAtMs(r.lastAt) }));
				return json({ on: true, rooms: list });
			} catch {
				return json({ on: true, rooms: [], error: "카톡 데이터를 읽지 못했어요. 전체 디스크 접근 권한과 카카오톡 로그인을 확인해 주세요" });
			}
		}
		// The newest message of one room: what a room row's preview, time and unread number become on a kakao event, without re-reading the whole list.
		if (area === "rooms" && parts.length === 5 && parts[4] === "latest" && method === "GET") {
			if (!on) return json(OFF, 409);
			const chatId = decodeURIComponent(parts[3]!);
			if (!digits(chatId)) return json({ error: "chatId must be a number" }, 400);
			try {
				const found = (await rooms(await getDb(config!), chatId))[0];
				if (!found || !eligible([found], config!).length) return json({ error: "대화방을 찾지 못했어요" }, 404);
				const db = await getDb(config!);
				const m = (await messages(db, chatId, 1, config!.userId ?? ""))[0];
				if (!m) return json({ logId: "", text: "", at: 0, unread: 0 });
				return json({ logId: m.logId, text: clip(readText(m).replace(/\s+/g, " ").trim(), HINT_MAX), at: sentAtMs(m.sentAt), unread: found.unread });
			} catch {
				return json({ error: "카톡 데이터를 읽지 못했어요" }, 502);
			}
		}
		if (area === "rooms" && parts.length === 4 && method === "PUT") {
			if (!on) return json(OFF, 409);
			const chatId = decodeURIComponent(parts[3]!);
			const b = await body();
			const bad = (v: unknown) => v !== undefined && typeof v !== "boolean";
			if (!digits(chatId) || (b.watched === undefined && b.autoDraft === undefined) || bad(b.watched) || bad(b.autoDraft)) return json({ error: "watched / autoDraft (true/false) is required" }, 400);
			const lists = watchLists(config!, chatId, b);
			if (!lists) return json({ error: "먼저 이 대화방을 보기로 켜 주세요" }, 409);
			const { next, nextAuto } = lists;
			writeConfig(paths, { ...config!, watch_chats: next, auto_draft_chats: nextAuto });
			// A room taken off the list leaves 미답장 at once; a room put on it is looked at again on the next read.
			if (b.watched === false && waiting?.rooms.delete(chatId)) {
				lastCount = owedIn(waiting.rooms, { ...config!, watch_chats: next });
				deps.broadcast({ kind: "kakao_unreplied" });
			} else if (b.watched === true) waiting = undefined;
			deps.broadcast({ kind: "kakao_rooms" });
			if (b.watched !== undefined) deps.onWatchChange?.();
			return json({ ok: true, watched: next, autoDraft: nextAuto });
		}

		if (area === "chat" && parts.length >= 4) {
			if (!on) return json(OFF, 409);
			const chatId = decodeURIComponent(parts[3]!);
			const sub = parts[4];
			// Any room of the list can be read (messages, read counters, its head, the web's read position); sending, drafts and 미답장 are for watched rooms only.
			const isWatched = watched.has(chatId);
			const reading = (method === "GET" && (parts.length === 4 || (parts.length === 5 && (sub === "reads" || sub === "head")))) || (method === "POST" && parts.length === 5 && sub === "read");
			if (!isWatched && !reading) return json({ error: "이 대화방은 보고 있지 않아요" }, 403);
			const listed = isWatched || !digits(chatId) ? undefined : await findRoom(config!, chatId).catch(() => undefined);
			if (!isWatched && !listed) return json({ error: "대화방을 찾지 못했어요" }, 404);

			if (parts.length === 4 && method === "GET") {
				const limit = Math.max(1, Math.min(Math.trunc(Number(url.searchParams.get("limit") ?? CHAT_PAGE)) || CHAT_PAGE, 200));
				const before = url.searchParams.get("before") ?? undefined;
				const after = url.searchParams.get("after") ?? undefined;
				const around = url.searchParams.get("around") ?? undefined;
				if ((before !== undefined && !digits(before)) || (after !== undefined && !digits(after)) || (around !== undefined && !digits(around))) return json({ error: "before / after / around must be a logId" }, 400);
				try {
					const found = listed ?? (await findRoom(config!, chatId));
					if (!found) return json({ error: "대화방을 찾지 못했어요" }, 404);
					const { room } = found;
					const db = await getDb(config!);
					// `around`: the page that holds a replied-to message (a quote tap): up to `limit` up to and including it, plus the `limit` after it.
					const list = around !== undefined
						? [
							...(await messages(db, chatId, limit, config!.userId ?? "", { before: String(BigInt(around) + 1n) })),
							...(await messages(db, chatId, limit, config!.userId ?? "", { after: around })),
						]
						: await messages(db, chatId, limit, config!.userId ?? "", after !== undefined ? { after } : before !== undefined ? { before } : {});
					const since = now() - SEND_WINDOW_MS;
					const ask = isWatched ? await openAsk(config!, chatId) : undefined;
					const marks = await watermarks(db, chatId);
					const names = new Map<string, string>([[String(config!.userId ?? ""), "나"]]);
					for (const m of list) if (m.sender && !m.fromMe) names.set(m.authorId, m.sender);
					// A reply to a message older than this page: its author's name is read for it (one query for the page).
					const missing = list.map(replySource).filter((id): id is string => !!id && !names.has(id));
					if (missing.length) for (const [id, name] of await peopleNames(db, chatId, missing).catch(() => new Map<string, string>())) names.set(id, name);
					return json(chatView({ chatId, name: found.name, room, isWatched, list, names, marks, ownerId: config!.userId ?? "", now, collector, read: readJsonFile<Record<string, string>>(readsFile, {})[chatId] ?? null, since,
						drafts: isWatched ? await listDrafts({ paths, runner: deps.runner }) : [], ask, sends: sendList() }));
				} catch {
					return json({ error: "카톡 데이터를 읽지 못했어요" }, 502);
				}
			}

			// KakaoTalk's read counters for the messages from `from` on (inclusive, at most READS_MAX), without their bodies.
			if (sub === "reads" && parts.length === 5 && method === "GET") {
				const from = url.searchParams.get("from");
				if (!digits(from)) return json({ error: "from must be a logId" }, 400);
				try {
					const db = await getDb(config!);
					const list = await messages(db, chatId, READS_MAX, config!.userId ?? "", { after: String(BigInt(from) - 1n) });
					const marks = await watermarks(db, chatId);
					return json({ counts: Object.fromEntries(list.map(m => [m.logId, unreadCount(marks, m.logId, m.authorId, config!.userId ?? "")])) });
				} catch {
					return json({ error: "카톡 데이터를 읽지 못했어요" }, 502);
				}
			}

			// The newest logId of the room, nothing else: what a viewer on another computer polls to learn whether to fetch rows.
			if (sub === "head" && parts.length === 5 && method === "GET") {
				try {
					const sig = fileSig([config!.dbPath ?? "", `${config!.dbPath ?? ""}-wal`]);
					if (headCache?.sig !== sig || now() - headCache.at >= HEAD_TTL_MS) headCache = { sig, at: now(), heads: new Map() };
					let logId = headCache.heads.get(chatId);
					if (logId === undefined) headCache.heads.set(chatId, (logId = await roomHead(await getDb(config!), chatId)));
					return json({ logId });
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

			if (sub === "no-reply" && parts.length === 5 && (method === "POST" || method === "DELETE")) {
				const { [chatId]: _old, ...rest } = waved();
				const logId = method === "POST" ? (await waitingRooms(config!, true).catch(() => new Map<string, string>())).get(chatId) : undefined;
				writePrivate(unrepliedFile, `${JSON.stringify(logId ? { ...rest, [chatId]: logId } : rest, null, 1)}\n`);
				waiting = undefined;
				deps.broadcast({ kind: "kakao_unreplied" });
				return json({ ok: true });
			}

			if (sub === "send" && parts.length === 5 && method === "POST") {
				const text = String((await body()).text ?? "");
				// The text of a draft of several messages is that draft (an older web's 다시 보내기 posts it here): it goes out part by part from its
				// first unsent part. A draft whose parts already went out partly and that can no longer be sent is refused: the joined text would
				// repeat them in the room.
				const drafts = (await listDrafts({ paths, runner: deps.runner })).filter(d => d.chatId === chatId && draftParts(d.text).length > 1 && sameText(d.text, text));
				const own = drafts.findLast(d => d.status === "pending");
				if (own) return sendDraftNow(own);
				const partial = drafts.findLast(d => (d.sentParts ?? 0) > 0);
				if (partial) return json({ error: `이 글은 초안 ${draftParts(partial.text).length}개 메시지 중 ${partial.sentParts}개를 이미 보낸 글이에요. 통째로 다시 보내면 같은 말이 두 번 가서 보내지 않았어요` }, 409);
				if (!text.trim() || [...text].length > MAX_TEXT) return json({ error: `글은 1자에서 ${MAX_TEXT}자 사이여야 해요` }, 400);
				// The owner's own words become his own draft (own: true, its basis the room's newest message) and go through the one queue like any draft.
				if (deps.replies?.()) {
					const room = (await allRooms(config!, true)).all.find(r => r.chatId === chatId);
					if (!room) return json({ error: "대화방을 찾지 못했어요" }, 404);
					let basis: string | undefined;
					try {
						basis = await latestIncoming(config!, chatId);
					} catch {
						return json({ error: "새 메시지가 왔는지 확인하지 못했어요" }, 502);
					}
					let draft: Draft;
					try {
						draft = await createDraft({ chatId, roomName: room.name, text, basisLogId: basis ?? "0", own: true }, { paths, runner: deps.runner, now });
					} catch (e) {
						return json({ error: (e as Error).message }, 400);
					}
					deps.broadcast({ kind: "kakao_draft", chatId });
					return (await viaReplies({ ref: draft.code, action: "send" }))!;
				}
				const rec = newRecord(chatId, text);
				start(rec, async () => {
					const cache = await allRooms(config!, true);
					const room = cache.all.find(r => r.chatId === chatId);
					if (!room) return { ok: false, reason: "대화방을 찾지 못했어요" };
					return dispatchSend({ kind: "text", chatId, roomName: room.name, text }, { paths, runner: deps.runner, now, lease: deps.lease, roomNames: async () => cache.all.map(({ chatId, name, kind, members }) => ({ chatId, name, kind, members })) });
				});
				return json({ id: rec.id, state: "sending" }, 202);
			}

			// 직접 쓸게: the owner writes the reply himself, the open question goes away.
			if (sub === "ask" && parts.length === 6 && parts[5] === "drop" && method === "POST") {
				setAsk(chatId, undefined);
				deps.broadcast({ kind: "kakao_draft", chatId });
				return json({ ok: true });
			}

			if (sub === "draft" && parts.length === 5 && method === "POST") {
				if (!deps.draftModel) return json({ error: "초안 만들기를 쓸 수 없어요" }, 503);
				if (!featureEnabled(paths.dataDir, "kakao", "reply_draft")) return json({ error: "카카오톡 답장 초안이 꺼져 있어요. 카카오톡 설정에서 켜 주세요" }, 409);
				if (drafting.has(chatId)) return json({ error: "이 대화방은 초안을 만드는 중이에요" }, 409);
				// A pick of the room's open question (web card button): only one of the stored choices.
				const draftBody = await body();
				const picked = draftBody.choice;
				const choice = typeof picked === "string" ? picked.trim() : undefined;
				if (picked !== undefined && (!choice || !storedAsks()[chatId]?.choices.includes(choice))) return json({ error: "그 선택지는 더 이상 없어요" }, 409);
				// A message the owner wants to send (메시지 만들어 줘): { intent } instead of a reply to the room's last message.
				const intentRaw = draftBody.intent;
				let intent: string | undefined;
				if (intentRaw !== undefined) {
					if (typeof intentRaw !== "string") return json({ error: "intent must be a string" }, 400);
					intent = intentRaw.replace(/\s+/g, " ").trim().slice(0, INTENT_MAX);
					if (!intent) return json({ error: "어떤 메시지를 만들지 적어 주세요" }, 400);
				}
				drafting.add(chatId);
				// A 자동 초안 room (watch.ts asks with { auto: true }): its new draft is announced as a reply item, so the card shows where KakaoTalk cards go.
				const auto = draftBody.auto === true;
				const run = makeDraft(draftCtx, config!, chatId, choice, undefined, intent)
					.then(m => (auto && m.ok && m.code && deps.broadcast({ kind: "reply", ref: m.code }), m))
					.finally(() => drafting.delete(chatId));
				pending.add(run);
				void run.finally(() => pending.delete(run));
				return json({ state: "drafting" }, 202);
			}
			return undefined;
		}

		// 사용자별 분석 of one person: the counted numbers of a room and the watched rooms (GET), and the model's short summary (POST .../analyze).
		if (area === "person" && (parts.length === 4 || (parts.length === 5 && parts[4] === "analyze"))) {
			if (!on) return json(OFF, 409);
			const userId = decodeURIComponent(parts[3]!);
			if (!digits(userId)) return json({ error: "userId must be a number" }, 400);
			const analyze = parts[4] === "analyze";
			if (analyze !== (method === "POST") || (!analyze && method !== "GET")) return json({ error: analyze ? "POST only" : "GET only" }, 405);
			const b = analyze ? await body() : {};
			const roomRaw = (analyze ? b.room ?? url.searchParams.get("room") : url.searchParams.get("room")) ?? undefined;
			if (roomRaw !== undefined && !digits(roomRaw)) return json({ error: "room must be a chatId" }, 400);
			const room = roomRaw === undefined ? undefined : String(roomRaw);
			if (analyze && !room) return json({ error: "room is required" }, 400);
			try {
				const found = room ? await findRoom(config!, room) : undefined;
				if (room && !found) return json({ error: "대화방을 찾지 못했어요" }, 404);
				const db = await getDb(config!);
				const key = `${userId}|${room ?? ""}|${(config!.watch_chats ?? []).join(",")}|${(config!.exclude_chats ?? []).join(",")}`;
				let stats: PersonStats;
				if (!analyze && personCache?.key === key && now() - personCache.at < PERSON_TTL_MS) stats = personCache.stats;
				else {
					stats = await personStats(db, { userId, ...(room ? { room } : {}), watched: config!.watch_chats ?? [], ownerId: String(config!.userId ?? ""), now: now(), ownerNames: room ? await ownerNames(db, room, config!.userId ?? "").catch(() => []) : [] });
					personCache = { key, at: now(), stats };
				}
				const summaries = readJsonFile<Record<string, { text: string; at: number }>>(personFile, {});
				const summaryKey = `${room}:${userId}`;
				if (!analyze) return json({ stats, ...(summaries[summaryKey] ? { analysis: summaries[summaryKey] } : {}) });
				if (!deps.draftModel) return json({ error: "요약 분석을 쓸 수 없어요" }, 503);
				const recent = await messages(db, room!, PERSON_READ, config!.userId ?? "");
				const lines = recent.map(m => { const c = [...readText(m).replace(/\s+/g, " ").trim()]; return `${m.fromMe ? "나" : m.sender || "상대"}: ${c.length > 240 ? `${c.slice(0, 239).join("")}…` : c.join("")}`; });
				const { system, user } = buildPersonPrompt({ name: stats.name ?? "상대", roomName: found!.name, lines, stats });
				let reply: Awaited<ReturnType<DraftModel>>;
				try {
					reply = await deps.draftModel(system, user, room);
				} catch (e) {
					// A spent subscription says so with its reset time (model-runner.ts); it is not a database failure.
					const why = e instanceof Error ? e.message : "";
					if (LIMIT_ERROR.test(why)) return json({ error: why }, 429);
					return json({ error: "요약을 만들지 못했어요" }, 502);
				}
				const text = String(reply.text ?? "").replace(/```[\s\S]*?```/g, " ").trim().slice(0, 2000);
				if (!text) return json({ error: "요약을 만들지 못했어요" }, 502);
				const analysis = { text, at: now() };
				const all = withSummary(summaries, summaryKey, analysis);
				writePrivate(personFile, `${JSON.stringify(all, null, 1)}\n`);
				return json({ analysis });
			} catch {
				return json({ error: "카톡 데이터를 읽지 못했어요" }, 502);
			}
		}

		// Media of a message of a watched room: /media/<chatId>/<logId>?i=<index>&v=thumb|full proxies the stored kakaocdn.net URL, /media/<chatId>/<logId>/file serves the downloaded file.
		if (area === "media" && (parts.length === 5 || (parts.length === 6 && parts[5] === "file")) && method === "GET") {
			if (!on) return json(OFF, 409);
			const chatId = decodeURIComponent(parts[3]!), logId = decodeURIComponent(parts[4]!);
			if (!digits(chatId) || !digits(logId)) return json({ error: "chatId / logId must be numbers" }, 400);
			if (!watched.has(chatId) && !(await findRoom(config!, chatId).catch(() => undefined))) return json({ error: "이 대화방은 보고 있지 않아요" }, 403);
			let msg;
			try {
				msg = await messageById(await getDb(config!), chatId, logId, config!.userId ?? "");
			} catch {
				return json({ error: "카톡 데이터를 읽지 못했어요" }, 502);
			}
			if (!msg) return json({ error: "그 메시지를 찾지 못했어요" }, 404);
			if (parts.length === 6) return serveLocalFile(msg);
			const i = Number(url.searchParams.get("i") ?? 0), v = url.searchParams.get("v") === "thumb" ? "thumb" : "full";
			if (!Number.isInteger(i) || i < 0 || i > 999) return json({ error: "i must be an index" }, 400);
			const target = mediaTarget(msg, i, v, now());
			if (!target.ok) return json({ error: target.error }, target.status);
			return fetchMedia(target.url, deps.fetch ?? fetch);
		}

		if (area === "drafts" && parts.length === 3 && method === "GET") {
			if (!on) return json({ items: [] });
			return json({ items: await pendingDrafts() });
		}
		return undefined;
	}

	// Resolves when every background send has finished (tests; shutdown).
	const idle = async () => {
		while (pending.size) await Promise.all([...pending]);
	};
	// The kit of the one reply flow's KakaoTalk adapter (hub/kakao/reply-adapter.ts): a revise through this room's model call, and one send's deps.
	const replyKit = {
		paths,
		// The message a draft answers, for the card's quote (the same read as the chat screen's pending row).
		original: async (d: Draft) => {
			const config = readConfig(paths);
			if (!config?.enabled || !d.basisLogId) return undefined;
			const db = await getDb(config).catch(() => undefined);
			return db ? (await pendingRow(d, db, config.userId ?? "", d.roomName)).original : undefined;
		},
		revise: async (chatId: string, revise: { code: string; draft: string; change: string }) => {
			const config = readConfig(paths);
			if (!config?.enabled || !deps.draftModel) return { ok: false as const, error: "카카오톡 초안 만들기를 쓸 수 없어요" };
			return makeDraft(draftCtx, config, chatId, undefined, revise, undefined, { learn: false });
		},
		sendDeps: async () => {
			const config = readConfig(paths)!;
			const cache = await allRooms(config, true);
			return { paths, runner: deps.runner, now, lease: deps.lease, latestIncoming: (id: string) => latestIncoming(config, id), roomNames: async () => cache.all.map(({ chatId, name, kind, members }) => ({ chatId, name, kind, members })) };
		},
	};
	return { route, idle, unrepliedCount, draftFacts, pendingDrafts, pendingCount, replyKit };
}
