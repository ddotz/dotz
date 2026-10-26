// Web side of the per-room KakaoTalk integration (contract: docs/kakao-rooms-api.md). Only rooms the owner chose (config watch_chats)
// are readable, sendable and shown. Everything is injected (database, runner, clock, paths, broadcast) so tests run without the app.
// Events carry ids only: never a body or a room name. Sends go only through send.ts (Accessibility UI automation).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { createLinkPreview, type Resolver } from "../linkpreview.ts";
import { featureEnabled } from "../app-feature-flags.ts";
import { addOnce, dispatchSend, type Lease, messageId } from "./contract.ts";
import { writePrivate } from "./creds.ts";
import { owedMessage } from "./address.ts";
import { hasWords, type KakaoDb, lastLines, memberLabels, messageById, ownerNames, peopleNames, roomKinds, roomShown, messages, ownTextCounts, ownTexts, roomHead, rooms, sentAtMs, TEXT_TYPE, unreadCount, watermarks } from "./db.ts";
import { basisOf, buildDraftPrompt, chatLines, contextLines, type DraftModel, draftParts, estimateTokens, ownPairs, ownSamples, parseDraftReply, registerOf, type StyleHint, sinceOwnLast, type VoiceSource } from "./draft.ts";
import { fetchMedia, mediaOf, mediaTarget, replySource, serveLocalFile, showsText } from "./media.ts";
import type { AxStep, Focus } from "./room.ts";
import { createDraft, draftTextError, dropDraft, type Draft, listDrafts, markStale, newer, type SendMs, type SendResult } from "./send.ts";
import type { KakaoConfig, KakaoPaths, Room, Runner } from "./types.ts";
import { kakaoUnreplied } from "../unreplied.ts";

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
	// The reply-drafts tone profile of a room (optional extra for the prompt).
	draftStyle?: (chatId: string) => StyleHint | undefined;
	// Learns (first draft) or refreshes (every 200 own lines) the owner's voice profile of the room and the global one, before the prompt is built.
	// It gets the room's messages (read once to write the profile) and counts of the owner's own lines.
	learnVoice?: (src: VoiceSource) => Promise<void>;
	// The owner sent a draft with his own edit (고치기): the draft text and the text he sent, for the room's tone profile.
	onCorrection?: (chatId: string, draft: string, sent: string) => void;
	// The owner asked for a change of a draft ("더 짧게"): recorded in the room's tone profile (draft.ts correct), the draft is rewritten right away.
	onRevise?: (chatId: string, change: string) => void;
	// The fetch behind GET /api/kakao/media/... and GET /api/link-preview (default: the global fetch).
	fetch?: typeof fetch;
	// How link previews resolve host names (default: dns.lookup); tests pass their own.
	previewResolve?: Resolver;
	previewAllowHosts?: string[];
};

export type SendRecord = { id: string; chatId: string; text: string; state: "sending" | "sent" | "failed"; reason?: string; at: number; draft?: string; collector?: string; ms?: SendMs; ax?: AxStep[]; focus?: Focus };

const ROOMS_TTL_MS = 30_000;
const CHAT_PAGE = 50;
// How far back 미답장 looks for a message addressed to the owner (a busy group or open room has chatter after it).
const OWED_READ = 50;
const HINT_MAX = 32;
// A room with no name and no message of anyone else to name it by: what kind of room it is, with its size.
const fallbackName = (r: Room): string => (r.kind === "direct" ? "1:1 대화방" : r.kind === "open" ? "오픈채팅방" : `단체 대화방${r.members ? ` ${r.members}명` : ""}`);
const MAX_TEXT = 1000;
const MAX_SENDS = 200;
const SEND_WINDOW_MS = 24 * 3600 * 1000;
const OFF = { error: "카톡 연동이 꺼져 있어요" };
const LOST = "게이트웨이가 다시 시작돼서 결과를 확인하지 못했어요";
const REVISE_MAX = 500;
const STUCK_MS = 60_000;
const STUCK = "60초가 지나도 끝나지 않아서 실패로 처리했어요";
const NO_REPLY = "답할 내용이 없어서 초안을 만들지 않았어요";
const DRAFT_FAILED = "초안을 만들지 못했어요. 잠시 뒤에 다시 눌러 주세요";
const DRAFT_READ = 300;
const VOICE_ROOMS = 8;
const READS_MAX = 500;
// A cached room head is trusted this long even when the database files look unchanged.
const HEAD_TTL_MS = 10_000;

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

const readJsonText = (file: string): string | undefined => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
};

const json = (data: unknown, status = 200) => Response.json(data, { status });
const digits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

export function createKakaoWeb(deps: WebDeps) {
	const { paths, now } = deps;
	const later = deps.later ?? ((fn: () => void, ms: number) => (setTimeout(fn, ms) as { unref?: () => void }).unref?.());
	const collector = deps.collector ?? hostname();
	const summaryFile = (chatId: string) => join(paths.dataDir, "kakao", "summaries", `${chatId}.md`);
	const drafting = new Set<string>();
	const sendsFile = join(paths.dataDir, "kakao", "sends.json");
	const asksFile = join(paths.dataDir, "kakao", "asks.json");
	const readsFile = join(paths.dataDir, "kakao", "reads.json");
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
	const hintOf = (r: Room, hints: Map<string, string>) => {
		const chars = [...(hints.get(r.chatId) ?? "")];
		return chars.length ? (chars.length > HINT_MAX ? `${chars.slice(0, HINT_MAX - 1).join("").trimEnd()}…` : chars.join("")) : `${r.members ?? 0}명`;
	};

	const storedSends = () => readJsonFile<SendRecord[]>(sendsFile, []);
	// A "sending" record nobody is working on (the gateway restarted meanwhile) is shown as failed.
	// A "sending" record older than the watchdog time is shown as failed even when the timer is gone.
	const sendList = (): SendRecord[] =>
		storedSends().map(s => (s.state !== "sending" ? s : !inflight.has(s.id) ? { ...s, state: "failed", reason: LOST } : now() - s.at > STUCK_MS ? { ...s, state: "failed", reason: STUCK } : s));
	const saveSends = (list: SendRecord[]) => writePrivate(sendsFile, `${JSON.stringify(list.slice(-MAX_SENDS), null, 1)}\n`);

	// 미답장 (hub/unreplied.ts): per watched room the logId of the message that waits for the owner (address.ts owedMessage: in a 1:1 room the other
	// person's newest, in a group or open room only one addressed to him) that no reply followed (his own message in the database, or a send of
	// ours that finished after it, ends it). 답장 안 함 keeps the logId he waved off in kakao/unreplied.json. Cached like the room list.
	const unrepliedFile = join(paths.dataDir, "kakao", "unreplied.json");
	const waved = () => readJsonFile<Record<string, string>>(unrepliedFile, {});
	let waiting: { at: number; rooms: Map<string, string> } | undefined;
	const waitingRooms = async (config: KakaoConfig, fresh = false): Promise<Map<string, string>> => {
		if (!fresh && waiting && now() - waiting.at < ROOMS_TTL_MS) return waiting.rooms;
		const out = new Map<string, string>();
		const db = await getDb(config);
		const sends = sendList().filter(s => s.state === "sent");
		const dismissed = waved();
		const me = String(config.userId ?? "");
		const kinds = (config.watch_chats ?? []).length ? await roomKinds(db) : new Map<string, Room["kind"]>();
		for (const chatId of config.watch_chats ?? []) {
			const kind = kinds.get(chatId) ?? "other";
			const many = kind === "group" || kind === "open";
			const owed = owedMessage(await messages(db, chatId, many ? OWED_READ : 10, me), kind, { id: me, names: many ? await ownerNames(db, chatId, me) : [] });
			if (!owed) continue;
			const sentAt = sentAtMs(owed.sentAt);
			if (sends.some(s => s.chatId === chatId && s.at >= sentAt)) continue;
			if (kakaoUnreplied({ logId: owed.logId, fromMe: false, sentAt }, dismissed[chatId], now())) out.set(chatId, owed.logId);
		}
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
		// Watchdog: a send still "sending" after STUCK_MS is failed for the owner (a late result of the job still replaces it).
		later(() => {
			if (storedSends().find(s => s.id === rec.id)?.state !== "sending") return;
			saveSends(storedSends().map(s => (s.id === rec.id ? { ...s, state: "failed", reason: STUCK } : s)));
			deps.broadcast({ kind: "kakao_send", chatId: rec.chatId, id: rec.id, state: "failed", reason: STUCK });
		}, STUCK_MS);
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

	// The one model call of a draft request (never per incoming message). Never rejects: every outcome is a kakao_draft event.
	// With `choice` (the owner's pick of the room's open question) the call writes the reply for that pick instead of deciding again.
	// With `revise` (a pending draft and the owner's change request) the call rewrites that draft; createDraft marks the old one stale only when the new one is stored.
	async function makeDraft(config: KakaoConfig, chatId: string, choice?: string, revise?: { code: string; draft: string; change: string }): Promise<void> {
		const done = (error?: string) => deps.broadcast({ kind: "kakao_draft", chatId, ...(error ? { error } : {}) });
		try {
			const room = eligible((await allRooms(config, true)).all, config).find(r => r.chatId === chatId);
			if (!room) return done("대화방을 찾지 못했어요");
			const recent = await messages(await getDb(config), chatId, DRAFT_READ, config.userId ?? "");
			const self = room.kind === "self";
			const window = sinceOwnLast(recent, self);
			const basis = basisOf(window, self);
			if (!basis) return done(NO_REPLY);
			if (deps.learnVoice) {
				try {
					const db = await getDb(config);
					const me = config.userId ?? "";
					const all = (await allRooms(config)).all;
					const excluded = new Set(config.exclude_chats ?? []);
					const recentRooms = all.filter(r => (r.kind === "direct" || r.kind === "group") && !excluded.has(r.chatId)).sort((a, b) => b.lastAt - a.lastAt).slice(0, VOICE_ROOMS).map(r => r.chatId);
					await deps.learnVoice({ chatId, ownCounts: ids => ownTextCounts(db, ids, me), ownTexts: (id, limit) => ownTexts(db, id, me, limit), messages: (id, limit) => messages(db, id, limit, me), ask: deps.draftModel, recentRooms: async () => recentRooms });
				} catch {}
			}
			let style: StyleHint | undefined;
			try {
				style = deps.draftStyle?.(chatId);
			} catch {}
			const ownLines = recent.filter(m => m.fromMe && m.type === TEXT_TYPE).map(m => m.text);
			const { system, user } = buildDraftPrompt({ lines: chatLines(window), context: contextLines(recent, window), summary: readJsonText(summaryFile(chatId)), pairs: ownPairs(recent), samples: ownSamples(recent), register: registerOf(ownLines.slice(-80)), style, ...(choice ? { choice } : {}), ...(revise ? { revise: { draft: revise.draft, change: revise.change } } : {}) });
			const reply = await deps.draftModel!(system, user, chatId);
			const parsed = parseDraftReply(reply.text);
			if (!parsed) return done(DRAFT_FAILED);
			if (parsed.action === "ask" && !choice && !revise) {
				if (parsed.summary) writePrivate(summaryFile(chatId), `${parsed.summary}\n`);
				setAsk(chatId, { question: parsed.question!, choices: parsed.choices!, basisLogId: basis, created: now() });
				return done();
			}
			if (parsed.action !== "draft" || !parsed.body) return done(parsed.action === "skip" ? NO_REPLY : DRAFT_FAILED);
			const reported = (reply.inputTokens ?? 0) > 0 || (reply.outputTokens ?? 0) > 0;
			const tokens = reported ? { in: reply.inputTokens ?? 0, out: reply.outputTokens ?? 0 } : { in: estimateTokens(system.length + user.length), out: estimateTokens(reply.text.length), estimated: true as const };
			try {
				await createDraft({ chatId, roomName: room.name, text: parsed.body, basisLogId: basis, tokens }, { paths, runner: deps.runner, now });
			} catch (e) {
				return done(e instanceof Error ? e.message : DRAFT_FAILED);
			}
			if (parsed.summary) writePrivate(summaryFile(chatId), `${parsed.summary}\n`);
			if (storedAsks()[chatId]) setAsk(chatId, undefined);
			done();
		} catch {
			done(DRAFT_FAILED);
		}
	}

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
		if (area === "rooms" && parts.length === 4 && method === "PUT") {
			if (!on) return json(OFF, 409);
			const chatId = decodeURIComponent(parts[3]!);
			const b = await body();
			const bad = (v: unknown) => v !== undefined && typeof v !== "boolean";
			if (!digits(chatId) || (b.watched === undefined && b.autoDraft === undefined) || bad(b.watched) || bad(b.autoDraft)) return json({ error: "watched / autoDraft (true/false) is required" }, 400);
			const current = config!.watch_chats ?? [];
			const next = b.watched === undefined ? current : b.watched ? [...new Set([...current, chatId])] : current.filter(c => c !== chatId);
			let nextAuto = (config!.auto_draft_chats ?? []).filter(c => b.watched !== false || c !== chatId);
			if (b.autoDraft === true) {
				if (!next.includes(chatId)) return json({ error: "먼저 이 대화방을 보기로 켜 주세요" }, 409);
				nextAuto = [...new Set([...nextAuto, chatId])];
			} else if (b.autoDraft === false) nextAuto = nextAuto.filter(c => c !== chatId);
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
					return json({
						// `group`: senders are named above their messages (a group or an open chat room, like KakaoTalk). `watched`: drafts and sending are on.
						room: { chatId, name: found.name, kind: room.kind, group: room.kind === "group" || room.kind === "open", watched: isWatched },
						// The body of a photo or file message is an attachment record, not text: it goes out as a safe `media` object (no URL, no local path).
						messages: list.map(m => {
							const media = mediaOf(m, now(), names);
							return { id: messageId(m), collector, logId: m.logId, authorId: m.authorId, sender: m.sender, text: showsText(m.type) ? m.text : "", type: m.type, sentAt: sentAtMs(m.sentAt), fromMe: m.fromMe, unread: unreadCount(marks, m.logId, m.authorId, config!.userId ?? ""), ...(media ? { media } : {}) };
						}),
						read: readJsonFile<Record<string, string>>(readsFile, {})[chatId] ?? null,
						kakaoUnread: room.unread,
						drafts: (isWatched ? await listDrafts({ paths, runner: deps.runner }) : [])
							.filter(d => d.chatId === chatId && d.status === "pending")
							// `parts`: the messages the draft sends, in order (one bubble each in the card); `sentParts` of them are already in the room.
							.map(d => ({ code: d.code, text: d.text, parts: draftParts(d.text), ...(d.sentParts ? { sentParts: d.sentParts } : {}), basisLogId: d.basisLogId, created: d.created })),
						...(ask ? { ask } : {}),
						sends: sendList()
							.filter(s => s.chatId === chatId && s.at >= since)
							.map(({ id, text, state, reason, at, draft, collector: by }) => ({ id, text, state, ...(reason ? { reason } : {}), at, ...(draft ? { draft } : {}), ...(by ? { collector: by } : {}) })),
					});
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
				if (!text.trim() || [...text].length > MAX_TEXT) return json({ error: `글은 1자에서 ${MAX_TEXT}자 사이여야 해요` }, 400);
				const rec = newRecord(chatId, text);
				start(rec, async () => {
					const cache = await allRooms(config!, true);
					const room = cache.all.find(r => r.chatId === chatId);
					if (!room) return { ok: false, reason: "대화방을 찾지 못했어요" };
					return dispatchSend({ kind: "text", chatId, roomName: room.name, text }, { paths, runner: deps.runner, now, lease: deps.lease, roomNames: async () => cache.all.map(({ chatId, name, kind, members }) => ({ chatId, name, kind, members })) });
				});
				return json({ id: rec.id, state: "sending" }, 202);
			}

			// The owner's delete of a failed (or lost) send: the record leaves sends.json for good, so the room, every web and every peer stop showing it. A send still running cannot be taken back.
			if (sub === "send" && parts.length === 6 && method === "DELETE") {
				const sendId = decodeURIComponent(parts[5]!);
				const rec = storedSends().find(s => s.id === sendId && s.chatId === chatId);
				if (!rec) return json({ ok: true, removed: false });
				if (rec.state === "sent" || inflight.has(rec.id)) return json({ error: "이 메시지는 지울 수 없어요" }, 409);
				saveSends(storedSends().filter(s => s.id !== sendId));
				deps.broadcast({ kind: "kakao_send", chatId, id: sendId, state: "deleted" });
				return json({ ok: true, removed: true });
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
				// A change request for a pending draft of this room (web 고치기): { revise: { code, change } }.
				const rv = draftBody.revise as { code?: unknown; change?: unknown } | undefined;
				let revise: { code: string; draft: string; change: string } | undefined;
				if (rv !== undefined) {
					const change = typeof rv?.change === "string" ? rv.change.replace(/\s+/g, " ").trim().slice(0, REVISE_MAX) : "";
					if (!change) return json({ error: "무엇을 고칠지 적어 주세요" }, 400);
					const old = (await listDrafts({ paths, runner: deps.runner })).find(d => d.code === rv?.code);
					if (!old || old.chatId !== chatId || old.status !== "pending") return json({ error: "고칠 초안을 찾지 못했어요" }, 409);
					revise = { code: old.code, draft: old.text, change };
					try {
						deps.onRevise?.(chatId, change);
					} catch {}
				}
				drafting.add(chatId);
				const run = makeDraft(config!, chatId, choice, revise).finally(() => drafting.delete(chatId));
				pending.add(run);
				void run.finally(() => pending.delete(run));
				return json({ state: "drafting" }, 202);
			}
			return undefined;
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
			if (edited !== undefined && (typeof edited !== "string" || draftTextError(edited))) return json({ error: typeof edited === "string" ? draftTextError(edited) : "답장 글이 비어 있어요" }, 400);
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
			if (typeof edited === "string" && edited.trim() !== draft.text.trim()) {
				try {
					deps.onCorrection?.(draft.chatId, draft.text, edited);
				} catch {}
			}
			const rec = newRecord(draft.chatId, edited ?? draft.text, code);
			start(rec, async () => {
				const cache = await allRooms(config!, true);
				return dispatchSend({ kind: "draft", code, ownerApproved: true, ...(edited !== undefined ? { text: edited } : {}) }, {
					paths,
					runner: deps.runner,
					now,
					lease: deps.lease,
					latestIncoming: id => latestIncoming(config!, id),
					roomNames: async () => cache.all.map(({ chatId, name, kind, members }) => ({ chatId, name, kind, members })),
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
	return { route, idle, unrepliedCount, draftFacts };
}
