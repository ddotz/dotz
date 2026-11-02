import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";
import type { Adapter, AdapterStatus, DeliverResult, MessengerCtx, OutMsg } from "./messenger.ts";
import { splitText } from "./messenger-jandi.ts";

// Slack / Telegram (and other chat services) through the optional agent-messenger package (github.com/agent-messenger/agent-messenger).
// Transport: its TypeScript SDK when it resolves (dynamic import, so the build never needs it), else its CLI on PATH run with argv arrays only.
// Neither present: the adapter is hidden (enabled() is false). One poll loop per connection; the config is re-read only when its mtime changes.

export type ChatKind = "main" | "project" | "alert" | "worklog";
export type AgentChat = { id: string; name: string; kind: ChatKind; project?: string };
export type AgentConn = { id: string; platform: string; auth: "bot" | "user"; token: string; cookie?: string; allow: string[]; chats: AgentChat[] };
export type AgentConfig = { enabled: boolean; connections: AgentConn[] };
export type ChatStatus = { last_in?: number; last_out?: number; last_error?: string };

/** One message as the transport reports it. `quoted` is forwarded/quoted content, never an order. */
export type RawMsg = { id: string; author: string; text: string; threadId?: string; quoted?: string };
export type Polled = RawMsg & { chat: string };
export type Emoji = "eyes";

/** What the adapter needs from agent-messenger; tests inject a fake. `cursor` is opaque to the adapter; the first poll (no cursor) must only return a baseline cursor and no messages. */
export interface AgentTransport {
	listChats(conn: AgentConn): Promise<{ id: string; name: string }[]>;
	poll(conn: AgentConn, cursor?: string): Promise<{ messages: Polled[]; cursor: string }>;
	send(conn: AgentConn, chat: string, text: string, threadId?: string): Promise<string>;
	edit?(conn: AgentConn, chat: string, id: string, text: string): Promise<void>;
	react(conn: AgentConn, chat: string, id: string, emoji: Emoji): Promise<void>;
	/** Replies in a thread newer than `afterId`, oldest first (Slack: replies are not in the channel history). */
	threadReplies?(conn: AgentConn, chat: string, threadId: string, afterId?: string): Promise<RawMsg[]>;
	unread?(conn: AgentConn, chat: string): Promise<number>;
}

export const USER_TOKEN_NOTE =
	"사용자 토큰은 관리자 본인 계정으로 메시지를 보냅니다. 유료 멤버 자리를 쓰고, 그 멤버가 볼 수 있는 대화를 모두 봅니다. 봇 토큰은 자리를 쓰지 않고, 초대된 채널만 볼 수 있습니다.";

const KINDS: readonly string[] = ["main", "project", "alert", "worklog"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PLATFORM = /^[a-z]{2,20}$/;
const MAX_PART = 3500;
const POLL_MS = 5_000;
const IDLE_MS = 15_000;
const IDLE_AFTER_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;
const HOT_THREAD_MS = 30 * 60_000;
const HOT_THREADS = 3;
const LEDGER_CAP = 200;
const STATUS_CAP = 200;
const SEEN_CAP = 500;
const ASK_HINT = "번호로 답해 주세요";

export const agentConfigPath = (dataDir: string = DATA_DIR) => join(dataDir, "messengers", "agent.json");
const threadsPath = (dataDir: string) => join(dataDir, "messengers", "agent-threads.json");

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map(x => x.trim()) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function normalize(raw: unknown): AgentConfig {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
	const connections: AgentConn[] = [];
	const seen = new Set<string>();
	for (const c of Array.isArray(o.connections) ? o.connections : []) {
		if (!c || typeof c.id !== "string" || !ID.test(c.id) || seen.has(c.id) || !PLATFORM.test(str(c.platform))) continue;
		seen.add(c.id);
		const chats: AgentChat[] = [];
		const chatSeen = new Set<string>();
		for (const ch of Array.isArray(c.chats) ? c.chats : []) {
			const id = str(ch?.id).trim();
			if (!id || id.length > 128 || chatSeen.has(id) || !KINDS.includes(ch.kind)) continue;
			chatSeen.add(id);
			chats.push({ id, name: str(ch.name) || id, kind: ch.kind, ...(typeof ch.project === "string" && ch.project ? { project: ch.project } : {}) });
		}
		connections.push({
			id: c.id,
			platform: c.platform,
			auth: c.auth === "user" ? "user" : "bot",
			token: str(c.token),
			...(str(c.cookie) ? { cookie: str(c.cookie) } : {}),
			allow: strings(c.allow),
			chats,
		});
	}
	return { enabled: o.enabled === true, connections };
}

const cache = new Map<string, { stamp: string; v: AgentConfig }>();
/** The config, re-read only when the file's mtime/size changes; a missing or broken file is a disabled config. */
export function loadAgentConfig(dataDir: string = DATA_DIR): AgentConfig {
	const file = agentConfigPath(dataDir);
	let stamp: string;
	try {
		const st = statSync(file);
		stamp = `${st.mtimeMs}:${st.size}`;
	} catch {
		return normalize(undefined);
	}
	const hit = cache.get(file);
	if (hit?.stamp === stamp) return hit.v;
	let v: AgentConfig;
	try {
		v = normalize(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		v = normalize(undefined);
	}
	cache.set(file, { stamp, v });
	return v;
}

/** Writes the config (tokens are secrets) with mode 0600. */
export function saveAgentConfig(cfg: AgentConfig, dataDir: string = DATA_DIR): AgentConfig {
	const next = normalize(cfg);
	mkdirSync(join(dataDir, "messengers"), { recursive: true });
	writeAtomic(agentConfigPath(dataDir), `${JSON.stringify(next, null, 2)}\n`, 0o600);
	return next;
}

const status_ = new Map<string, ChatStatus>();
/** Per-chat last_in / last_out / last_error (epoch ms, in memory), keyed "<connection id>:<chat id>". Never holds a token. */
export const connStatus = (): Record<string, ChatStatus> => Object.fromEntries([...status_].map(([k, v]) => [k, { ...v }]));
const mark = (conn: string, chat: string, patch: ChatStatus) => void status_.set(`${conn}:${chat}`, { ...status_.get(`${conn}:${chat}`), ...patch });

/** An error message safe to show and log: the connection's secrets removed, cut short. */
function scrub(e: unknown, conn: AgentConn): string {
	let s = String((e as Error)?.message ?? e);
	for (const secret of [conn.token, conn.cookie]) if (secret) s = s.split(secret).join("***");
	return s.replace(/\s+/g, " ").slice(0, 200);
}

const targetOf = (c: AgentChat): string | undefined => (c.kind === "main" ? "main" : c.kind === "project" ? c.project : c.kind);
// Progress edits (update_key) are edited in place; without an edit they are skipped unless final: a lane's [ask]/[done]/[fail] line or a decision with options.
const isFinal = (m: OutMsg) => !!m.options?.length || /^\s*\[(ask|done|fail)\]/m.test(m.text);

// --- agent-messenger transports ---------------------------------------------------------------------------------------------------

type SlackLike = { ts: string; text?: string; user?: string; username?: string; thread_ts?: string; attachments?: unknown[] };
const SDK: Record<string, Partial<Record<"bot" | "user", [string, string]>>> = {
	slack: { bot: ["agent-messenger/slackbot", "SlackBotClient"], user: ["agent-messenger/slack", "SlackClient"] },
	telegram: { bot: ["agent-messenger/telegrambot", "TelegramBotClient"] },
};
const CLI_NAMES = ["agent-slackbot", "agent-slack", "agent-telegrambot", "agent-telegram"];

function resolvable(spec: string): boolean {
	for (const from of [import.meta.dir, process.cwd()]) {
		try {
			Bun.resolveSync(spec, from);
			return true;
		} catch {}
	}
	return false;
}
const sdkSpec = (conn: AgentConn) => SDK[conn.platform]?.[conn.auth];
const cliPath = (name: string) => Bun.which(name, { PATH: process.env.PATH ?? "" }) ?? undefined;

/** True when the SDK resolves or one of the agent-messenger CLIs is on PATH; false hides the adapter. */
// Memoized per PATH: enabled() runs on every outgoing post, and module resolution plus a PATH scan is not free.
let availMemo: { path: string; v: boolean } | undefined;
export const available = (): boolean => {
	const path = process.env.PATH ?? "";
	if (availMemo?.path !== path) availMemo = { path, v: Object.values(SDK).some(p => Object.values(p).some(s => s && resolvable(s[0]))) || CLI_NAMES.some(n => !!cliPath(n)) };
	return availMemo.v;
};

const tsNum = (s: string) => Number(s);
const json = (s: string): any => {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
};
const list = (v: any, key: string): any[] => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);

// Forwarded/shared Slack messages arrive as attachments: their text is content, never an order.
function slackQuoted(att: unknown[] | undefined): string | undefined {
	const t = (att ?? []).map(a => str((a as any)?.text) || str((a as any)?.fallback)).filter(Boolean).join("\n");
	return t || undefined;
}
const slackRaw = (m: SlackLike): RawMsg => ({
	id: m.ts,
	author: m.user ?? m.username ?? "",
	text: m.text ?? "",
	...(m.thread_ts && m.thread_ts !== m.ts ? { threadId: m.thread_ts } : {}),
	...(slackQuoted(m.attachments) ? { quoted: slackQuoted(m.attachments) } : {}),
});

/** Per-chat "newest ts seen" cursor; a chat without one is baselined (newest ts, no messages). */
async function slackPoll(conn: AgentConn, cursor: string | undefined, fetchChat: (chat: string, limit: number, oldest?: string) => Promise<SlackLike[]>) {
	const prev: Record<string, string> = (cursor && json(cursor)) || {};
	const next = { ...prev };
	const messages: Polled[] = [];
	for (const ch of conn.chats) {
		const last = prev[ch.id];
		const got = (await fetchChat(ch.id, last === undefined ? 1 : 20, last)).filter(m => m.ts).sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
		if (last === undefined) {
			next[ch.id] = got.at(-1)?.ts ?? "0";
			continue;
		}
		for (const m of got) if (tsNum(m.ts) > tsNum(last)) messages.push({ ...slackRaw(m), chat: ch.id });
		if (got.length && tsNum(got.at(-1)!.ts) > tsNum(last)) next[ch.id] = got.at(-1)!.ts;
	}
	return { messages, cursor: JSON.stringify(next) };
}
const slackReplies = (got: SlackLike[], thread: string, after?: string): RawMsg[] =>
	got.filter(m => m.ts && m.ts !== thread && (after === undefined || tsNum(m.ts) > tsNum(after))).sort((a, b) => tsNum(a.ts) - tsNum(b.ts)).map(slackRaw);

function tgRaw(m: any): Polled {
	const own = str(m.text) || str(m.caption);
	const forwarded = !!(m.forward_origin || m.forward_date);
	const quoted = forwarded ? own : str(m.quote?.text);
	return {
		chat: String(m.chat?.id),
		id: String(m.message_id),
		author: String(m.from?.id ?? ""),
		text: forwarded ? "" : own,
		...(m.reply_to_message?.message_id ? { threadId: String(m.reply_to_message.message_id) } : {}),
		...(quoted ? { quoted } : {}),
	};
}
const tgChat = (chat: string): string | number => (/^-?\d+$/.test(chat) ? Number(chat) : chat);
const EMOJI: Record<string, Record<Emoji, string>> = { slack: { eyes: "eyes" }, telegram: { eyes: "\u{1F440}" } };
const emojiFor = (conn: AgentConn, e: Emoji) => EMOJI[conn.platform]?.[e] ?? e;

/** The SDK, loaded by a dynamic import of a computed specifier so a build without the package still works. */
export function createSdkTransport(): AgentTransport {
	const clients = new Map<string, { key: string; p: Promise<any> }>();
	const client = (conn: AgentConn): Promise<any> => {
		const spec = sdkSpec(conn);
		if (!spec) return Promise.reject(new Error(`agent-messenger SDK has no ${conn.platform}/${conn.auth} client`));
		const key = `${conn.token}\0${conn.cookie ?? ""}`;
		const hit = clients.get(conn.id);
		if (hit?.key === key) return hit.p;
		const p = (async () => {
			const mod = await import(spec[0]);
			const c = new mod[spec[1]]();
			return await c.login(conn.auth === "user" && conn.cookie ? { token: conn.token, cookie: conn.cookie } : { token: conn.token });
		})();
		clients.set(conn.id, { key, p });
		p.catch(() => clients.get(conn.id)?.p === p && clients.delete(conn.id));
		return p;
	};
	const slackBot = (conn: AgentConn) => conn.platform === "slack" && conn.auth === "bot";
	return {
		async listChats(conn) {
			if (conn.platform !== "slack") return [];
			return ((await (await client(conn)).listChannels()) as { id: string; name: string }[]).map(c => ({ id: c.id, name: c.name }));
		},
		async poll(conn, cursor) {
			const c = await client(conn);
			if (conn.platform === "slack") {
				return slackPoll(conn, cursor, (chat, limit, oldest) => (slackBot(conn) ? c.getConversationHistory(chat, { limit }) : c.getMessages(chat, oldest ? { limit, oldest } : { limit })));
			}
			const updates: any[] = await c.getUpdates(cursor === undefined ? { offset: -1, limit: 1, timeout: 0, allowed_updates: ["message"] } : { offset: Number(cursor), limit: 100, timeout: 0, allowed_updates: ["message"] });
			const top = updates.reduce((n, u) => Math.max(n, u.update_id), -1);
			const next = top >= 0 ? String(top + 1) : (cursor ?? "0");
			return { messages: cursor === undefined ? [] : updates.filter(u => u.message).map(u => tgRaw(u.message)), cursor: next };
		},
		async send(conn, chat, text, threadId) {
			const c = await client(conn);
			if (conn.platform === "slack") return String((await (slackBot(conn) ? c.postMessage(chat, text, threadId ? { thread_ts: threadId } : undefined) : c.sendMessage(chat, text, threadId))).ts);
			return String((await c.sendMessage(tgChat(chat), text, threadId ? { reply_parameters: { message_id: Number(threadId) } } : undefined)).message_id);
		},
		async edit(conn, chat, id, text) {
			const c = await client(conn);
			if (conn.platform === "slack") await c.updateMessage(chat, id, text);
			else await c.editMessageText({ chat_id: tgChat(chat), message_id: Number(id) }, text);
		},
		async react(conn, chat, id, emoji) {
			const c = await client(conn);
			if (conn.platform === "slack") await c.addReaction(chat, id, emojiFor(conn, emoji));
			else await c.setMessageReaction(tgChat(chat), Number(id), [{ type: "emoji", emoji: emojiFor(conn, emoji) }]);
		},
		async threadReplies(conn, chat, threadId, afterId) {
			if (conn.platform !== "slack") return [];
			const r = await (await client(conn)).getThreadReplies(chat, threadId, { limit: 50 });
			return slackReplies(list(r, "messages"), threadId, afterId);
		},
	};
}

const CLI_TIMEOUT_MS = 20_000;
/** The CLI, one Bun.spawn argv array per call (never a shell string). Text is an argv element placed after `--`, so a leading "-" is not read as an option. It uses the CLI's own stored credentials (`auth set`). */
export function createCliTransport(): AgentTransport {
	async function run(conn: AgentConn, args: string[]): Promise<any> {
		const name = `agent-${conn.platform}${conn.auth === "bot" ? "bot" : ""}`;
		const bin = cliPath(name);
		if (!bin) throw new Error(`${name} not found on PATH`);
		const p = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env, timeout: CLI_TIMEOUT_MS });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		const j = json(out);
		if (code !== 0 || j?.error) throw new Error(`${name} ${args.slice(0, 2).join(" ")} failed: ${scrub(j?.error ?? (err || out || `exit ${code}`), conn)}`);
		return j;
	}
	const isTg = (conn: AgentConn) => conn.platform === "telegram";
	return {
		async listChats(conn) {
			if (isTg(conn)) return [];
			return list(await run(conn, ["channel", "list"]), "channels").map(c => ({ id: String(c.id), name: String(c.name ?? c.id) }));
		},
		async poll(conn, cursor) {
			if (isTg(conn)) return { messages: [], cursor: cursor ?? "0" }; // the Telegram bot CLI cannot read messages: inbound needs the SDK
			return slackPoll(conn, cursor, async (chat, limit) => list(await run(conn, ["message", "list", "--limit", String(limit), "--", chat]), "messages"));
		},
		async send(conn, chat, text, threadId) {
			const j = await run(conn, ["message", "send", ...(threadId ? [isTg(conn) ? "--reply-to" : "--thread", threadId] : []), "--", chat, text]);
			const id = j?.ts ?? j?.message?.ts ?? j?.message?.message_id ?? j?.message_id ?? j?.id;
			if (id === undefined) throw new Error("agent-messenger CLI returned no message id");
			return String(id);
		},
		async edit(conn, chat, id, text) {
			await run(conn, ["message", "edit", "--", chat, id, text]);
		},
		async react(conn, chat, id, emoji) {
			await run(conn, isTg(conn) ? ["reaction", "set", "--", chat, id, emojiFor(conn, emoji)] : ["reaction", "add", "--", chat, id, emojiFor(conn, emoji)]);
		},
		async threadReplies(conn, chat, threadId, afterId) {
			if (isTg(conn)) return [];
			return slackReplies(list(await run(conn, ["message", "replies", "--limit", "50", "--", chat, threadId]), "messages"), threadId, afterId);
		},
	};
}

/** Per connection: the SDK when its client resolves, else the CLI. */
export function createDefaultTransport(): AgentTransport {
	const sdk = createSdkTransport();
	const cli = createCliTransport();
	const pick = (conn: AgentConn) => {
		const spec = sdkSpec(conn);
		return spec && resolvable(spec[0]) ? sdk : cli;
	};
	return {
		listChats: conn => pick(conn).listChats(conn),
		poll: (conn, cursor) => pick(conn).poll(conn, cursor),
		send: (conn, chat, text, threadId) => pick(conn).send(conn, chat, text, threadId),
		edit: (conn, chat, id, text) => pick(conn).edit!(conn, chat, id, text),
		react: (conn, chat, id, emoji) => pick(conn).react(conn, chat, id, emoji),
		threadReplies: (conn, chat, threadId, afterId) => pick(conn).threadReplies!(conn, chat, threadId, afterId),
	};
}

// --- the adapter ------------------------------------------------------------------------------------------------------------------

type Thread = { conn: string; chat: string; thread: string; target: string; replyTo: string; at: number };
type Loop = { id: string; cursor?: string; timer?: ReturnType<typeof setTimeout>; busy: boolean; stopped: boolean; fails: number; active: number; seen: Map<string, true> };

export type AgentAdapter = Adapter & { pollNow(): Promise<void> };

export function createAgentAdapter(dataDir: string = DATA_DIR, opts: { transport?: AgentTransport } = {}): AgentAdapter {
	let ctx: MessengerCtx | undefined;
	let transport: AgentTransport | undefined = opts.transport;
	const tr = () => (transport ??= createDefaultTransport());
	const loops = new Map<string, Loop>();

	// Thread ledger: hub target + replyTo + chat -> the thread (root message id) the conversation lives in. Capped, persisted.
	let ledger: Map<string, Thread> | undefined;
	const ledgerKey = (conn: string, chat: string, target: string, replyTo: string) => `${conn}|${chat}|${target}|${replyTo}`;
	const threads = (): Map<string, Thread> => {
		if (!ledger) {
			ledger = new Map();
			try {
				for (const t of json(readFileSync(threadsPath(dataDir), "utf8")) ?? []) if (t?.conn && t.chat && t.thread && t.target && t.replyTo) ledger.set(ledgerKey(t.conn, t.chat, t.target, t.replyTo), { ...t, at: Number(t.at) || 0 });
			} catch {}
		}
		return ledger;
	};
	const saveThreads = () => {
		mkdirSync(join(dataDir, "messengers"), { recursive: true });
		writeAtomic(threadsPath(dataDir), `${JSON.stringify([...threads().values()])}\n`, 0o600);
	};
	const touch = (key: string, t: Thread) => {
		const l = threads();
		l.delete(key);
		l.set(key, { ...t, at: Date.now() });
	};
	const threadSeen = new Map<string, string>(); // "<conn>|<chat>|<thread>" -> newest reply id handled
	const statusMsgs = new Map<string, string>(); // "<conn>|<chat>|<updateKey>" -> the message edited in place
	const remember = <V>(m: Map<string, V>, k: string, v: V, cap: number) => {
		m.delete(k);
		m.set(k, v);
		if (m.size > cap) m.delete(m.keys().next().value as string);
	};

	const a: AgentAdapter = {
		id: "agent",
		label: "Slack / Telegram (agent-messenger)",
		canEdit: true,
		canButtons: false,
		status: { state: "off" } as AdapterStatus,
		enabled: () => {
			const c = loadAgentConfig(dataDir);
			return c.enabled && c.connections.some(x => x.chats.length > 0) && (opts.transport ? true : available());
		},
		start(c) {
			ctx = c;
			if (!a.enabled()) {
				a.status = { state: "off" };
				return;
			}
			a.canEdit = !!tr().edit;
			for (const conn of loadAgentConfig(dataDir).connections) {
				if (!conn.chats.length || loops.has(conn.id)) continue;
				const st: Loop = { id: conn.id, busy: false, stopped: false, fails: 0, active: Date.now(), seen: new Map() };
				loops.set(conn.id, st);
				schedule(st, 0);
			}
			// Delivery works without inbound; poll errors show per chat in connStatus(), not as an adapter error that would mute the fan-out.
			a.status = { state: "ok" };
		},
		stop() {
			for (const st of loops.values()) {
				st.stopped = true;
				if (st.timer) clearTimeout(st.timer);
			}
			loops.clear();
			a.status = { state: "off" };
		},
		deliver: msg => deliver(msg),
		pollNow: async () => {
			for (const st of [...loops.values()]) await tick(st);
		},
	};

	function schedule(st: Loop, ms: number) {
		if (st.stopped) return;
		st.timer = setTimeout(async () => {
			st.timer = undefined;
			await tick(st);
			schedule(st, delayFor(st));
		}, ms);
	}
	function delayFor(st: Loop): number {
		if (st.fails) return Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** st.fails);
		return Date.now() - st.active > IDLE_AFTER_MS ? IDLE_MS : POLL_MS;
	}

	async function tick(st: Loop): Promise<void> {
		if (st.busy || st.stopped) return;
		st.busy = true;
		const cfg = loadAgentConfig(dataDir);
		const conn = cfg.connections.find(c => c.id === st.id);
		if (!cfg.enabled || !conn) {
			st.stopped = true;
			st.busy = false;
			return;
		}
		try {
			await pollConn(st, conn);
			st.fails = 0;
		} catch (e) {
			st.fails++;
			const err = scrub(e, conn);
			for (const ch of conn.chats) mark(conn.id, ch.id, { last_error: err });
			if (st.fails === 1 || st.fails % 10 === 0) ctx?.log(`agent messenger ${conn.id} poll failed (${st.fails}): ${err}`);
		} finally {
			st.busy = false;
		}
	}

	async function pollConn(st: Loop, conn: AgentConn): Promise<void> {
		const t = tr();
		const r = await t.poll(conn, st.cursor);
		st.cursor = r.cursor;
		for (const m of r.messages) await handle(st, conn, m);
		if (!t.threadReplies) return;
		// Slack keeps thread replies out of the channel history: look at the few threads we opened recently.
		const hot = [...threads().entries()].filter(([, x]) => x.conn === conn.id && Date.now() - x.at < HOT_THREAD_MS).slice(-HOT_THREADS);
		for (const [, th] of hot) {
			const sk = `${conn.id}|${th.chat}|${th.thread}`;
			const after = threadSeen.get(sk);
			const replies = await t.threadReplies(conn, th.chat, th.thread, after);
			if (replies.length) remember(threadSeen, sk, replies.at(-1)!.id, LEDGER_CAP * 2);
			else if (after === undefined) remember(threadSeen, sk, th.thread, LEDGER_CAP * 2);
			if (after === undefined) continue; // a thread from an earlier run: baseline only, old replies are not replayed
			for (const m of replies) await handle(st, conn, { ...m, chat: th.chat });
		}
	}

	async function handle(st: Loop, conn: AgentConn, m: Polled): Promise<void> {
		const chat = conn.chats.find(c => c.id === m.chat);
		const target = chat && targetOf(chat);
		if (!chat || !target || !conn.allow.includes(m.author)) return; // only the owner's messages are orders
		const seenKey = `${m.chat}|${m.id}`;
		if (st.seen.has(seenKey)) return;
		remember(st.seen, seenKey, true, SEEN_CAP);
		const text = m.text.trim();
		if (!text) return; // a forward with no words of the owner's own is content, not an order
		st.active = Date.now();
		mark(conn.id, chat.id, { last_in: Date.now() });
		try {
			await tr().react(conn, chat.id, m.id, "eyes");
		} catch (e) {
			mark(conn.id, chat.id, { last_error: scrub(e, conn) });
		}
		const th = m.threadId ? [...threads().entries()].find(([, x]) => x.conn === conn.id && x.chat === chat.id && x.thread === m.threadId) : undefined;
		if (th) touch(th[0], th[1]);
		ctx?.receive({ adapter: "agent", target, text, author: m.author, ...(th ? { replyTo: th[1].replyTo } : {}), messageId: m.id, ...(m.quoted ? { quoted: m.quoted } : {}) });
	}

	async function deliver(msg: OutMsg): Promise<DeliverResult> {
		const t = tr();
		const final = isFinal(msg);
		if (msg.updateKey && !final && !t.edit) return { delivered: false, reason: "edit" };
		const dests = loadAgentConfig(dataDir).connections.flatMap(conn => conn.chats.filter(c => c.kind === msg.kind && (msg.kind !== "project" || c.project === msg.target)).map(chat => ({ conn, chat })));
		if (!dests.length) return { delivered: false, reason: "no chat" };
		const ids: string[] = [];
		let failed: unknown;
		for (const { conn, chat } of dests) {
			try {
				ids.push(...(await sendTo(t, conn, chat, msg, final)));
			} catch (e) {
				failed = new Error(`${conn.id}:${chat.id}: ${scrub(e, conn)}`);
				mark(conn.id, chat.id, { last_error: scrub(e, conn) });
			}
		}
		if (!ids.length) throw failed;
		return { delivered: true, ids };
	}

	async function sendTo(t: AgentTransport, conn: AgentConn, chat: AgentChat, msg: OutMsg, final: boolean): Promise<string[]> {
		let text = msg.text;
		if (msg.options?.length) text += `\n\n${msg.options.map(o => `${o.n}) ${o.label}`).join("\n")}\n\n${ASK_HINT}`;
		const parts = splitText(text, MAX_PART);
		const key = msg.replyTo ? ledgerKey(conn.id, chat.id, msg.target, msg.replyTo) : undefined;
		const known = key ? threads().get(key) : undefined;
		let thread = known?.thread;
		if (known && key) touch(key, known);
		const out = (id: string) => {
			mark(conn.id, chat.id, { last_out: Date.now() });
			return id;
		};

		const sk = msg.updateKey ? `${conn.id}|${chat.id}|${msg.updateKey}` : undefined;
		if (sk && !final) {
			const prev = statusMsgs.get(sk);
			if (prev) {
				try {
					await t.edit!(conn, chat.id, prev, parts[0]!);
					return [out(prev)];
				} catch {
					statusMsgs.delete(sk); // the message is gone or past its edit window: post a fresh one
				}
			}
		} else if (sk) statusMsgs.delete(sk);

		const ids: string[] = [];
		for (const [i, part] of parts.entries()) {
			const id = out(await t.send(conn, chat.id, part, thread));
			ids.push(id);
			if (i === 0 && !thread) {
				thread = id;
				if (key) {
					touch(key, { conn: conn.id, chat: chat.id, thread: id, target: msg.target, replyTo: msg.replyTo!, at: 0 });
					while (threads().size > LEDGER_CAP) threads().delete(threads().keys().next().value as string);
					remember(threadSeen, `${conn.id}|${chat.id}|${id}`, id, LEDGER_CAP * 2);
					saveThreads();
				}
			}
		}
		if (sk && !final) remember(statusMsgs, sk, ids[0]!, STATUS_CAP);
		return ids;
	}

	return a;
}

export const agentAdapter = createAgentAdapter();
