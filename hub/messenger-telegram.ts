import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";
import type { MessageSpec } from "./message-spec.ts";
import { specOf } from "./message-spec-of.ts";
import { telegramParts } from "./spec-telegram.ts";
import { parseTone, TONE_EMOJI, toneText } from "./tone.ts";
import { type Adapter, type AdapterStatus, type DeliverResult, type MessengerCtx, type OutMsg, type Settings, type SettingsPut, SettingsError, type TestResult } from "./messenger.ts";

// Telegram as a built-in messenger, over the Bot API: long polling with getUpdates (a 5 s timer, offset kept in the config) for the owner's
// messages, sendMessage for ours. The bot token lives in <DATA_DIR>/messengers/telegram.json (0600); it is part of the API URL, so every error
// line is scrubbed before it reaches a status, a log or a response.

export type TelegramKind = "main" | "project" | "alert" | "worklog";
export type TelegramChat = { id: string; name: string; kind: TelegramKind; project?: string };
export type TelegramConfig = { enabled: boolean; token: string; chats: TelegramChat[]; allow: string[]; cursor?: number };

export const telegramConfigPath = (dataDir: string = DATA_DIR) => join(dataDir, "messengers", "telegram.json");
export const POLL_MS = 5000;

const KINDS: readonly string[] = ["main", "project", "alert", "worklog"];
const VALUE_KEYS = ["token", "main", "alert", "worklog"] as const;
const CHAT_ID = /^[A-Za-z0-9@_-]{2,64}$/;
const TEST_TEXT = "dotz 연결 테스트예요";
const HELP = [
	"BotFather에서 봇을 만들고 토큰을 받아요",
	"봇과 대화를 연 뒤 채팅 ID를 넣어요 (@userinfobot 같은 봇으로 확인)",
	"허용 목록에는 명령을 내릴 수 있는 사람의 숫자 Telegram ID만 넣어요. 목록에 없으면 무시해요",
];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map(x => x.trim()) : []);

function normalize(raw: unknown): TelegramConfig {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
	const chats: TelegramChat[] = [];
	const seen = new Set<string>();
	for (const c of Array.isArray(o.chats) ? o.chats : []) {
		if (!c || typeof c.id !== "string" || !CHAT_ID.test(c.id) || seen.has(c.id) || !KINDS.includes(c.kind)) continue;
		const project = typeof c.project === "string" && c.project ? c.project : undefined;
		if (c.kind === "project" && !project) continue;
		seen.add(c.id);
		chats.push({ id: c.id, name: typeof c.name === "string" && c.name ? c.name : c.id, kind: c.kind as TelegramKind, ...(project ? { project } : {}) });
	}
	const cursor = Number(o.cursor);
	return { enabled: o.enabled === true, token: typeof o.token === "string" ? o.token.trim() : "", chats, allow: [...new Set(strings(o.allow))], ...(Number.isFinite(cursor) && cursor > 0 ? { cursor } : {}) };
}

/** The config; a missing or broken file is a disabled, unconfigured Telegram. */
export function loadTelegramConfig(dataDir: string = DATA_DIR): TelegramConfig {
	try {
		return normalize(JSON.parse(readFileSync(telegramConfigPath(dataDir), "utf8")));
	} catch {
		return normalize(undefined);
	}
}

/** Writes the config (the bot token is a secret) with mode 0600. */
export function saveTelegramConfig(cfg: TelegramConfig, dataDir: string = DATA_DIR): TelegramConfig {
	const next = normalize(cfg);
	mkdirSync(join(dataDir, "messengers"), { recursive: true });
	writeAtomic(telegramConfigPath(dataDir), `${JSON.stringify(next, null, 2)}\n`, 0o600);
	chmodSync(telegramConfigPath(dataDir), 0o600);
	return next;
}

/** An error line that never carries the token (the Bot API puts it in the URL, and fetch errors quote the URL). */
const scrub = (e: unknown, token = ""): string => {
	let s = e instanceof Error ? e.message : typeof e === "string" ? e : "Telegram 오류";
	if (token) s = s.split(token).join("***");
	return s.replace(/\d{5,}:[A-Za-z0-9_-]{10,}/g, "***").replace(/\s+/g, " ").trim().slice(0, 200) || "Telegram 오류";
};

const targetOf = (c: TelegramChat): string | undefined => (c.kind === "main" ? "main" : c.kind === "project" ? c.project : c.kind);

type Reply = { ok: boolean; status: number; error?: string; result?: any };

export type TelegramAdapter = Adapter & { pollNow(): Promise<void> };

export function createTelegramAdapter(dataDir: string = DATA_DIR, opts: { fetch?: typeof fetch; pollMs?: number; spec?: (body: string) => MessageSpec | null } = {}): TelegramAdapter {
	let ctx: MessengerCtx | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = true;
	let busy = false;
	const pollMs = opts.pollMs ?? POLL_MS;
	const cfg = () => loadTelegramConfig(dataDir);
	const doFetch = () => opts.fetch ?? fetch;

	async function call(token: string, method: string, body: Record<string, unknown>): Promise<Reply> {
		const res = await doFetch()(`https://api.telegram.org/bot${token}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(20_000),
		});
		const json = await res.json().catch(() => undefined);
		return { ok: res.ok && json?.ok === true, status: res.status, ...(typeof json?.description === "string" ? { error: json.description } : {}), ...(json?.result !== undefined ? { result: json.result } : {}) };
	}

	const replyError = (r: Reply): string => r.error ?? `HTTP ${r.status}`;

	function schedule(): void {
		if (stopped || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			void poll().finally(schedule);
		}, pollMs);
	}

	/** One getUpdates round: allow-listed authors' text messages enter ctx.receive; the offset is saved after the newest update. */
	async function poll(): Promise<void> {
		if (busy || stopped) return;
		const s = cfg();
		if (!s.enabled || !s.token) return;
		busy = true;
		const before = s.cursor ?? 0;
		try {
			const r = await call(s.token, "getUpdates", { limit: 100, timeout: 0, ...(before > 0 ? { offset: before } : {}) });
			if (!r.ok) throw new Error(replyError(r));
			const updates = Array.isArray(r.result) ? r.result : [];
			let cursor = before;
			for (const u of updates) {
				const id = Number(u?.update_id);
				if (Number.isFinite(id)) cursor = Math.max(cursor, id + 1);
				const m = u?.message;
				if (!m || typeof m.text !== "string" || !m.text.trim()) continue;
				const author = m.from?.id !== undefined ? String(m.from.id) : "";
				const chatId = m.chat?.id !== undefined ? String(m.chat.id) : "";
				if (!author || !chatId || !s.allow.includes(author)) continue;
				const chat = s.chats.find(c => c.id === chatId);
				const target = chat && targetOf(chat);
				if (!target) continue;
				const quoted = m.forward_origin || m.forward_date ? m.text : (m.quote?.text ?? m.reply_to_message?.text);
				ctx?.receive({ adapter: "telegram", target, text: m.text.trim(), author, ...(m.message_id !== undefined ? { messageId: String(m.message_id) } : {}), ...(quoted ? { quoted } : {}) });
			}
			if (cursor > before) {
				try {
					saveTelegramConfig({ ...s, cursor }, dataDir);
				} catch (e) {
					ctx?.log(`telegram cursor save failed: ${scrub(e, s.token)}`);
				}
			}
		} catch (e) {
			ctx?.log(`telegram poll failed: ${scrub(e, s.token)}`);
		} finally {
			busy = false;
		}
	}

	/** A spec answer as HTML messages, the keyboard on the last and the reply on the first. A 400 means Telegram could not parse the markup: that part goes again as plain text, once. */
	async function sendParts(token: string, chatId: string, parts: { html: string; plain: string }[], msg: OutMsg): Promise<string[]> {
		const ids: string[] = [];
		for (const [i, part] of parts.entries()) {
			const extra = { ...(i === parts.length - 1 && msg.link ? { reply_markup: { inline_keyboard: [[{ text: "웹에서 보기", url: msg.link }]] } } : {}), ...(i === 0 && msg.replyTo ? { reply_to_message_id: Number(msg.replyTo) || undefined } : {}) };
			let r = await call(token, "sendMessage", { chat_id: chatId, text: part.html, parse_mode: "HTML", ...extra });
			if (!r.ok && r.status === 400) r = await call(token, "sendMessage", { chat_id: chatId, text: part.plain, ...extra });
			if (!r.ok) throw new Error(`${chatId}: ${replyError(r)}`);
			if (r.result?.message_id !== undefined) ids.push(String(r.result.message_id));
		}
		return ids;
	}

	async function deliver(msg: OutMsg): Promise<DeliverResult> {
		const s = cfg();
		if (!s.token) return { delivered: false, reason: "no token" };
		let dests = s.chats.filter(c => c.kind === msg.kind && (msg.kind !== "project" || c.project === msg.target));
		// A project with no chat of its own talks in the main chat.
		if (!dests.length && msg.kind === "project") dests = s.chats.filter(c => c.kind === "main");
		if (!dests.length) return { delivered: false, reason: "no chat" };
		const text = toneText(msg.text);
		if (!text) return { delivered: false, reason: "internal" };
		const { tone, text: body } = parseTone(msg.text);
		const spec = (opts.spec ?? specOf)(body.trim());
		const parts = spec ? telegramParts(spec, tone ? { emoji: TONE_EMOJI[tone] } : {}) : [];
		const ids: string[] = [];
		let failed: unknown;
		for (const chat of dests) {
			try {
				if (parts.length) {
					ids.push(...(await sendParts(s.token, chat.id, parts, msg)));
					continue;
				}
				const r = await call(s.token, "sendMessage", { chat_id: chat.id, text, ...(msg.link ? { reply_markup: { inline_keyboard: [[{ text: "웹에서 보기", url: msg.link }]] } } : {}), ...(msg.replyTo ? { reply_to_message_id: Number(msg.replyTo) || undefined } : {}) });
				if (!r.ok) throw new Error(`${chat.id}: ${replyError(r)}`);
				if (r.result?.message_id !== undefined) ids.push(String(r.result.message_id));
			} catch (e) {
				failed ??= e;
			}
		}
		if (!ids.length) return { delivered: false, reason: scrub(failed, s.token) };
		return { delivered: true, ids };
	}

	/** The screen's view of the config: the token only as set/unset, the chat ids as plain text fields. */
	function settings(): Settings {
		const s = cfg();
		const idOf = (kind: TelegramKind) => s.chats.find(c => c.kind === kind)?.id ?? "";
		return {
			enabled: s.enabled,
			help: HELP,
			fields: [
				{ key: "token", label: "Telegram 봇 토큰", type: "secret", set: s.token !== "", hint: "BotFather가 준 토큰이에요" },
				{ key: "main", label: "메인 채팅 ID", type: "text", value: idOf("main"), hint: "이 채팅에 답해요" },
				{ key: "alert", label: "알림 채팅 ID", type: "text", value: idOf("alert"), hint: "비우면 메인 채팅은 그대로예요" },
				{ key: "worklog", label: "작업내역 채팅 ID", type: "text", value: idOf("worklog") },
			],
			allow: { label: "말을 걸 수 있는 사람", hint: "숫자 Telegram ID", items: s.allow },
			projects: [],
		};
	}

	/** Validates the whole body first, then writes once: a refused body changes nothing. */
	function apply(body: SettingsPut): void {
		const s = cfg();
		const next: TelegramConfig = { enabled: s.enabled, token: s.token, chats: s.chats.map(c => ({ ...c })), allow: [...s.allow], ...(s.cursor ? { cursor: s.cursor } : {}) };
		if (body.enabled !== undefined) {
			if (typeof body.enabled !== "boolean") throw new SettingsError("enabled must be true or false");
			next.enabled = body.enabled;
		}
		const v = body.values ?? {};
		const unknown = Object.keys(v).find(k => !(VALUE_KEYS as readonly string[]).includes(k));
		if (unknown) throw new SettingsError(`unknown value ${unknown}`);
		for (const k of VALUE_KEYS) if (v[k] !== undefined && typeof v[k] !== "string") throw new SettingsError(`${k} must be a string`);
		if (typeof v.token === "string") {
			const token = v.token.trim();
			if (token && !/^\d{5,}:[A-Za-z0-9_-]{10,}$/.test(token)) throw new SettingsError("봇 토큰은 123456:ABC… 처럼 생겼어요");
			next.token = token;
		}
		const setChat = (kind: TelegramKind, raw: unknown) => {
			if (raw === undefined) return;
			const id = String(raw).trim();
			if (id && !CHAT_ID.test(id)) throw new SettingsError(`${kind} 채팅 ID가 올바르지 않아요`);
			const i = next.chats.findIndex(c => c.kind === kind);
			if (!id) next.chats = next.chats.filter(c => c.kind !== kind);
			else if (i >= 0) next.chats[i] = { ...next.chats[i]!, id };
			else next.chats.push({ id, name: id, kind });
		};
		setChat("main", v.main);
		setChat("alert", v.alert);
		setChat("worklog", v.worklog);
		if (body.allow !== undefined) {
			if (!Array.isArray(body.allow) || body.allow.some(x => typeof x !== "string")) throw new SettingsError("allow must be a list of strings");
			next.allow = [...new Set(strings(body.allow))];
		}
		saveTelegramConfig(next, dataDir);
	}

	const a: TelegramAdapter = {
		id: "telegram",
		ownsLink: true,
		label: "Telegram",
		canEdit: false,
		canButtons: false,
		status: { state: "off" } as AdapterStatus,
		enabled: () => {
			const s = cfg();
			return s.enabled && s.token !== "" && s.chats.length > 0;
		},
		configured: () => cfg().token !== "",
		async start(c) {
			ctx = c;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			stopped = false;
			const s = cfg();
			if (!s.enabled || !s.token || !s.chats.length) {
				stopped = true;
				a.status = { state: "off" };
				return;
			}
			try {
				const r = await call(s.token, "getMe", {});
				if (!r.ok) throw new Error(replyError(r));
				a.status = { state: "ok" };
			} catch (e) {
				a.status = { state: "error", error: scrub(e, s.token) };
				stopped = true;
				return;
			}
			schedule();
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			ctx = undefined;
			a.status = { state: "off" };
		},
		deliver,
		settings,
		saveSettings: body => {
			apply(body);
			return settings();
		},
		async test(): Promise<TestResult> {
			const s = cfg();
			if (!s.token) return { results: [{ id: "bot", name: "Telegram 봇", ok: false, error: "봇 토큰이 없어요" }] };
			try {
				const r = await call(s.token, "getMe", {});
				return { results: [{ id: "bot", name: "Telegram 봇", ok: r.ok, status: r.status, ...(r.ok ? {} : { error: replyError(r) }) }] };
			} catch (e) {
				return { results: [{ id: "bot", name: "Telegram 봇", ok: false, error: scrub(e, s.token) }] };
			}
		},
		pollNow: poll,
	};
	return a;
}
