import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, writeAtomic } from "./config.ts";
import type { Adapter, AdapterStatus, DeliverResult, OutMsg, Settings, SettingsPut, TestResult } from "./messenger.ts";
import { SettingsError } from "./messenger.ts";

// Slack as a built-in messenger, over the Web API only: one bot token sent as a bearer header (never in a URL or a body), and one channel id
// per message kind. Lean on purpose: no inbound (Slack needs a public request URL for events), no threads, no message edits. The token and the
// channel ids live in <DATA_DIR>/messengers/slack.json (0600); the token never leaves this module in a response or a log line.

export type SlackKind = "main" | "project" | "alert" | "worklog";
export type SlackChannel = { id: string; name: string; kind: SlackKind; project?: string };
export type SlackConfig = { enabled: boolean; token: string; channels: SlackChannel[]; allow: string[] };

export const slackConfigPath = (dataDir: string = DATA_DIR) => join(dataDir, "messengers", "slack.json");
export const SLACK_SCOPES = "chat:write, channels:read, users:read";

const KINDS: readonly string[] = ["main", "project", "alert", "worklog"];
const CHANNEL_ID = /^[A-Za-z0-9_-]{4,64}$/;
const VALUE_KEYS = ["token", "main", "alert", "worklog"] as const;
const TEST_TEXT = "dotz 연결 테스트예요";
const HELP = [
	"Slack 앱에서 봇 토큰(xoxb-)을 발급하고, 봇을 알림을 받을 채널에 초대해 주세요",
	`필요한 스코프: ${SLACK_SCOPES}`,
	"채널 ID는 Slack 채널 링크의 마지막 C… 값이에요. 없으면 메인 채널로 보내요",
];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map(x => x.trim()) : []);

function normalize(raw: unknown): SlackConfig {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
	const channels: SlackChannel[] = [];
	const seen = new Set<string>();
	for (const c of Array.isArray(o.channels) ? o.channels : []) {
		if (!c || typeof c.id !== "string" || !CHANNEL_ID.test(c.id) || seen.has(c.id) || !KINDS.includes(c.kind)) continue;
		const project = typeof c.project === "string" && c.project ? c.project : undefined;
		if (c.kind === "project" && !project) continue;
		seen.add(c.id);
		channels.push({ id: c.id, name: typeof c.name === "string" && c.name ? c.name : c.id, kind: c.kind as SlackKind, ...(project ? { project } : {}) });
	}
	return { enabled: o.enabled === true, token: typeof o.token === "string" ? o.token.trim() : "", channels, allow: [...new Set(strings(o.allow))] };
}

/** The config; a missing or broken file is a disabled, unconfigured Slack. */
export function loadSlackConfig(dataDir: string = DATA_DIR): SlackConfig {
	try {
		return normalize(JSON.parse(readFileSync(slackConfigPath(dataDir), "utf8")));
	} catch {
		return normalize(undefined);
	}
}

/** Writes the config (the bot token is a secret) with mode 0600. */
export function saveSlackConfig(cfg: SlackConfig, dataDir: string = DATA_DIR): SlackConfig {
	const next = normalize(cfg);
	mkdirSync(join(dataDir, "messengers"), { recursive: true });
	writeAtomic(slackConfigPath(dataDir), `${JSON.stringify(next, null, 2)}\n`, 0o600);
	chmodSync(slackConfigPath(dataDir), 0o600);
	return next;
}

/** An error line that never carries the token (a fetch error can quote the request). */
const scrub = (e: unknown, token = ""): string => {
	let s = e instanceof Error ? e.message : typeof e === "string" ? e : "Slack 오류";
	if (token) s = s.split(token).join("***");
	return s.replace(/xox[baprs]-[A-Za-z0-9-]+/g, "***").replace(/\s+/g, " ").trim().slice(0, 200) || "Slack 오류";
};

type Reply = { ok: boolean; status: number; error?: string };

export function createSlackAdapter(dataDir: string = DATA_DIR, opts: { fetch?: typeof fetch } = {}): Adapter {
	const cfg = () => loadSlackConfig(dataDir);
	const doFetch = () => opts.fetch ?? fetch;

	// Slack's Web API takes a form body; the token rides in the Authorization header so it is never in a body, a URL or a log.
	async function call(token: string, method: string, body: Record<string, unknown>): Promise<{ reply: Reply; json: any }> {
		const form = new URLSearchParams();
		for (const [k, v] of Object.entries(body)) if (v !== undefined) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
		const res = await doFetch()(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", Accept: "application/json" },
			body: form.toString(),
			signal: AbortSignal.timeout(15_000),
		});
		const json = await res.json().catch(() => undefined);
		return { reply: { ok: res.ok && json?.ok === true, status: res.status, ...(typeof json?.error === "string" ? { error: json.error } : {}) }, json };
	}

	const replyError = (r: Reply): string => r.error ?? `HTTP ${r.status}`;

	async function deliver(msg: OutMsg): Promise<DeliverResult> {
		const s = cfg();
		if (!s.token) return { delivered: false, reason: "no token" };
		let dests = s.channels.filter(ch => ch.kind === msg.kind && (msg.kind !== "project" || ch.project === msg.target));
		// A project with no channel of its own talks in the main channel.
		if (!dests.length && msg.kind === "project") dests = s.channels.filter(ch => ch.kind === "main");
		if (!dests.length) return { delivered: false, reason: "no channel" };
		const ids: string[] = [];
		let failed: unknown;
		for (const ch of dests) {
			try {
				const r = await call(s.token, "chat.postMessage", { channel: ch.id, text: msg.link ? `${msg.text}\n\n<${msg.link.replace(/[<>|\s]/g, encodeURIComponent)}|웹에서 보기>` : msg.text, unfurl_links: "false" });
				if (!r.reply.ok) throw new Error(`${ch.id}: ${replyError(r.reply)}`);
				if (typeof r.json?.ts === "string") ids.push(r.json.ts);
			} catch (e) {
				failed ??= e;
			}
		}
		if (!ids.length) return { delivered: false, reason: scrub(failed, s.token) };
		return { delivered: true, ids };
	}

	/** The screen's view of the config: the token only as set/unset, the channel ids as plain text fields. */
	function settings(): Settings {
		const s = cfg();
		const idOf = (kind: SlackKind) => s.channels.find(ch => ch.kind === kind)?.id ?? "";
		return {
			enabled: s.enabled,
			help: HELP,
			fields: [
				{ key: "token", label: "Slack 봇 토큰", type: "secret", set: s.token !== "", hint: `스코프: ${SLACK_SCOPES}` },
				{ key: "main", label: "메인 채널 ID", type: "text", value: idOf("main"), hint: "C로 시작하는 채널 ID" },
				{ key: "alert", label: "알림 채널 ID", type: "text", value: idOf("alert"), hint: "비우면 메인 채널은 그대로예요" },
				{ key: "worklog", label: "작업내역 채널 ID", type: "text", value: idOf("worklog") },
			],
			allow: { label: "말을 걸 수 있는 사람", hint: "Slack 멤버 ID(U…)", items: s.allow },
			projects: [],
		};
	}

	/** Validates the whole body first, then writes once: a refused body changes nothing. */
	function apply(body: SettingsPut): void {
		const s = cfg();
		const next: SlackConfig = { enabled: s.enabled, token: s.token, channels: s.channels.map(ch => ({ ...ch })), allow: [...s.allow] };
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
			if (token && !/^xox[baprs]-/.test(token)) throw new SettingsError("Slack 봇 토큰은 xoxb-로 시작해요");
			next.token = token;
		}
		const setChannel = (kind: SlackKind, raw: unknown) => {
			if (raw === undefined) return;
			const id = String(raw).trim();
			if (id && !CHANNEL_ID.test(id)) throw new SettingsError(`${kind} 채널 ID가 올바르지 않아요`);
			const i = next.channels.findIndex(ch => ch.kind === kind);
			if (!id) next.channels = next.channels.filter(ch => ch.kind !== kind);
			else if (i >= 0) next.channels[i] = { ...next.channels[i]!, id };
			else next.channels.push({ id, name: id, kind });
		};
		setChannel("main", v.main);
		setChannel("alert", v.alert);
		setChannel("worklog", v.worklog);
		if (body.allow !== undefined) {
			if (!Array.isArray(body.allow) || body.allow.some(x => typeof x !== "string")) throw new SettingsError("allow must be a list of strings");
			next.allow = [...new Set(strings(body.allow))];
		}
		saveSlackConfig(next, dataDir);
	}

	/** auth.test, then one short line to the main channel when one is configured. Never the token in the result. */
	async function test(): Promise<TestResult> {
		const s = cfg();
		const results: TestResult["results"] = [];
		if (!s.token) return { results: [{ id: "auth", name: "Slack 인증", ok: false, error: "봇 토큰이 없어요" }] };
		try {
			const r = await call(s.token, "auth.test", {});
			results.push({ id: "auth", name: "Slack 인증", ok: r.reply.ok, status: r.reply.status, ...(r.reply.ok ? {} : { error: replyError(r.reply) }) });
		} catch (e) {
			results.push({ id: "auth", name: "Slack 인증", ok: false, error: scrub(e, s.token) });
		}
		const main = s.channels.find(ch => ch.kind === "main");
		if (main) {
			try {
				const r = await call(s.token, "chat.postMessage", { channel: main.id, text: TEST_TEXT });
				results.push({ id: main.id, name: main.name, ok: r.reply.ok, status: r.reply.status, ...(r.reply.ok ? {} : { error: replyError(r.reply) }) });
			} catch (e) {
				results.push({ id: main.id, name: main.name, ok: false, error: scrub(e, s.token) });
			}
		}
		return { results };
	}

	const a: Adapter = {
		id: "slack",
		ownsLink: true,
		label: "Slack",
		canEdit: false,
		canButtons: false,
		status: { state: "off" } as AdapterStatus,
		enabled: () => {
			const s = cfg();
			return s.enabled && s.token !== "" && s.channels.length > 0;
		},
		configured: () => cfg().token !== "",
		async start() {
			const s = cfg();
			if (!s.enabled || !s.token) {
				a.status = { state: "off" };
				return;
			}
			try {
				const r = await call(s.token, "auth.test", {});
				if (!r.reply.ok) throw new Error(replyError(r.reply));
				a.status = { state: "ok" };
			} catch (e) {
				a.status = { state: "error", error: scrub(e, s.token) };
			}
		},
		stop() {
			a.status = { state: "off" };
		},
		deliver,
		settings,
		saveSettings: body => {
			apply(body);
			return settings();
		},
		test,
	};
	return a;
}
