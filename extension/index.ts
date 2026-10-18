// Dotz mode extension; behaviour depends on which session loads it:
// - gateway orchestrator (DOTZ_ORCHESTRATOR=1): dotz_send / dotz_lane / dotz_schedule tools, recall after compaction.
// - lane session (DOTZ_LANE set): 5-minute prompt cache (1h is for the orchestrator only; idle warming covers waits).
// - any other session: "<name>모드 켜" (dotz_mode tool, /dotz on) makes this terminal a thin client of the
//   gateway: typed input is forwarded to the gateway orchestrator instead of the local model, replies addressed to
//   the terminal are shown here. "<name>모드 꺼" or /dotz off stops forwarding. No terminal needs to stay open.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { baseLanguage, detectLanguage, languageName } from "../hub/language.ts";

const DATA = process.env.DOTZ_DIR ?? join(homedir(), ".dotz");
const PKG = join(import.meta.dir, "..");
const NAME = (() => {
	try {
		return String(JSON.parse(readFileSync(join(DATA, "config.json"), "utf8")).identity?.name ?? "").trim() || "dotz";
	} catch {
		return "dotz";
	}
})();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
const OFF = new RegExp(`^\\s*((${escape(NAME)}|dotz)\\s*모드\\s*(꺼|끄기|종료|off)|\\/dotz\\s+off)\\s*$`, "i");

export function blockedBy(command: string, rulesText: string): string | undefined {
	const section = rulesText.split(/^## Blocked commands\s*$/m)[1]?.split(/^## /m)[0] ?? "";
	for (const m of section.matchAll(/^- deny:\s*(.+)\s+\|\s+(.+?)\s*$/gm)) {
		try {
			if (new RegExp(m[1], "i").test(command)) return m[2].trim();
		} catch {
			continue;
		}
	}
	return undefined;
}

// Always refused, whatever RULES.md says: pattern kills reach the live gateway (a test hub shares its command line),
// and kickstarting it cuts the orchestrator and every lane mid-turn. Test hubs are stopped by their own PID;
// gateway restarts go through /api/gateway/restart, which waits for idle.
const SYSTEM_DENY: [RegExp, string][] = [
	[/\b(pkill|killall)\b[^;&|\n]*(hub\/main|dotz)/i, "a pattern kill also hits the live dotz gateway; stop a test hub by the PID you started"],
	[/\blaunchctl\s+(kickstart|stop|kill|bootout|unload|remove)\b[^;&|\n]*dev\.dotz\.gateway/i, "restarting the gateway cuts every session short; use /restart gateway (POST /api/gateway/restart)"],
];

function enforceRules(pi: any): void {
	pi.on("tool_call", (event: any) => {
		if (String(event?.toolName ?? "") !== "bash") return;
		const command = String(event?.input?.command ?? "");
		const system = SYSTEM_DENY.find(([re]) => re.test(command));
		if (system) return { block: true, reason: `Blocked by dotz: ${system[1]}.` };
		const file = join(DATA, "RULES.md");
		if (!existsSync(file)) return;
		const reason = blockedBy(command, readFileSync(file, "utf8"));
		if (reason) return { block: true, reason: `Blocked by the owner's rule (${file}): ${reason}. Do not work around it; report it if the task needs it.` };
	});
}

function dropLongTtl(value: any): number {
	if (Array.isArray(value)) return value.reduce((n, item) => n + dropLongTtl(item), 0);
	if (!value || typeof value !== "object") return 0;
	let dropped = 0;
	if (value.cache_control?.ttl === "1h") {
		delete value.cache_control.ttl;
		dropped++;
	}
	for (const key of Object.keys(value)) if (key !== "cache_control") dropped += dropLongTtl(value[key]);
	return dropped;
}

function hub(): { url: string; token: string } | undefined {
	try {
		const cfg = JSON.parse(readFileSync(join(DATA, "config.json"), "utf8"));
		return { url: `http://127.0.0.1:${process.env.DOTZ_PORT ?? cfg.web?.port ?? 7420}`, token: readFileSync(join(DATA, "secrets", "hub-token"), "utf8").trim() };
	} catch {
		return undefined;
	}
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
	const h = hub();
	if (!h) throw new Error("dotz is not set up yet: run `bun <plugin>/setup.ts`");
	const r = await fetch(h.url + path, { ...init, headers: { "x-dotz-token": h.token, "Content-Type": "application/json", ...(init.headers ?? {}) } });
	const text = await r.text();
	const data = text ? JSON.parse(text) : {};
	if (!r.ok) throw new Error(data.error ?? data.reason ?? `${r.status}`);
	return data;
}

async function ensureGateway(): Promise<void> {
	try {
		await call("/api/health");
		return;
	} catch {
		spawn("bun", [join(PKG, "hub", "main.ts")], { detached: true, stdio: "ignore", env: process.env }).unref();
	}
	for (let i = 0; i < 60; i++) {
		await Bun.sleep(250);
		if (await call("/api/health").then(() => true, () => false)) return;
	}
	throw new Error("gateway did not start (see ~/.dotz/hub.log)");
}

// Same language and MODE file chain as hub/i18n.ts (that module has gateway side effects, so only the pure helpers are shared).
function language(): string {
	try {
		const id = JSON.parse(readFileSync(join(DATA, "config.json"), "utf8")).identity ?? {};
		if (typeof id.language === "string" && id.language.trim()) return id.language.trim();
		const text = [id.character, id.tone, id.notices, id.address].filter(s => typeof s === "string").join("\n");
		const identityFile = join(DATA, "identity", "IDENTITY.md");
		return detectLanguage(text.trim() || !existsSync(identityFile) ? text : readFileSync(identityFile, "utf8"));
	} catch {
		return "en";
	}
}

function recall(): string {
	const file = (p: string, max: number) => (existsSync(p) ? readFileSync(p, "utf8").slice(0, max) : "");
	const code = language();
	const base = baseLanguage(code);
	const chain = [...(base === "en" ? [] : [join(DATA, `MODE.${base}.md`), join(PKG, `MODE.${base}.md`)]), join(DATA, "MODE.md"), join(PKG, "MODE.md")];
	const mode = file(chain.find(existsSync) ?? join(PKG, "MODE.md"), 20000);
	const parts = { identity: file(join(DATA, "identity", "IDENTITY.md"), 3000), rules: file(join(DATA, "RULES.md"), 6000), lessons: file(join(DATA, "LESSONS.md"), 3000), setups: file(join(DATA, "channel-setups.json"), 3000), state: file(join(DATA, "state.json"), 4000) || "{}" };
	if (base === "ko") return `[dotz] 컨텍스트 압축 뒤 계약을 다시 읽어요:\n\n정체성:\n${parts.identity}\n\n${mode}\n\n오너 규칙:\n${parts.rules}\n\n교훈:\n${parts.lessons}\n\n작업 채널 설정 (자세한 건 dotz_channel list):\n${parts.setups || "(없음)"}\n\n현재 state.json:\n${parts.state}`;
	const reply = base === "en" ? "" : `\n\nReply to the owner in ${languageName(code)} (${code}).`;
	return `[dotz] Contract re-read after compaction:\n\nIdentity:\n${parts.identity}\n\n${mode}\n\nOwner rules:\n${parts.rules}\n\nLessons:\n${parts.lessons}\n\nWork channel setups (dotz_channel list for details):\n${parts.setups || "(none)"}\n\nCurrent state.json:\n${parts.state}${reply}`;
}

function orchestratorTools(pi: any): void {
	const z = pi.zod;
	pi.on("session_compact", (_e: any, ctx: any) => {
		if (ctx?.agent?.kind === "main") pi.sendMessage({ customType: "dotz-mode", content: recall(), display: false }, { deliverAs: "nextTurn" });
	});
	pi.registerTool({
		name: "dotz_send",
		label: "Dotz send",
		description: `Send a message as ${NAME} to a channel other than the one that asked, or a progress note mid-turn. Your final answer is already delivered to the asking channel, so do not use this for the reply itself. target: chat, dm, worklog, alert, lane:<name>, ch:<id> (a work channel), th:<id> (a thread), web, terminal. reply_to = a Discord msg id. update_key (e.g. "progress") = one evolving status message per target and key, edited in place on each call instead of posting again (not counted as your answer). Never include secrets.`,
		parameters: z.object({ target: z.string(), text: z.string(), reply_to: z.string().optional(), update_key: z.string().optional() }),
		async execute(_id: string, p: any) {
			const r = await call("/api/send", { method: "POST", body: JSON.stringify(p) });
			return { content: [{ type: "text", text: r.delivered ? `sent to ${p.target}` : `not delivered: ${r.reason}` }] };
		},
	});
	pi.registerTool({
		name: "dotz_lane",
		label: "Dotz lane",
		description: "Project lanes: one headless omp orchestrator per project folder, each with its own Discord channel; its reports come back as inbox turns. A lane plans and reviews on its own model and runs implementation, tests, renders and grind work as task workers on a cheaper worker model. action=launch {name [a-z0-9-] (internal key), title (the lane's Discord channel name, read by the owner: 2-3 plain words in the owner's main language saying what the work is, e.g. 게이트웨이-화면, never a repo or project codename), cwd absolute, brief (must contain a 'Done when:' line, <= 8000 chars, paths not contents), model? (Fable or max/xhigh effort only with owner_asked_for_fable=true, when the owner explicitly asked for it; the same applies to worker_model), worker_model? (provider/model[:thinking] for this lane's task workers; default is lanes.worker_model from the config), est? (percent of the 5h usage window this job is expected to use, 0-100; default 15; the gate refuses when under 10% would remain, so give a realistic number: small fix ~5, big build ~30), force? (only after the owner OKs a budget-gate warning)}; list; send {name, text} (also resumes a stopped lane's session); stop {name}.",
		parameters: z.object({ action: z.enum(["launch", "list", "send", "stop"]), name: z.string().optional(), title: z.string().optional(), cwd: z.string().optional(), brief: z.string().optional(), text: z.string().optional(), model: z.string().optional(), worker_model: z.string().optional(), est: z.number().min(0).max(100).optional(), force: z.boolean().optional(), owner_asked_for_fable: z.boolean().optional() }),
		async execute(_id: string, p: any) {
			const out =
				p.action === "launch" ? await call("/api/lanes", { method: "POST", body: JSON.stringify({ name: p.name, title: p.title, cwd: p.cwd, brief: p.brief, model: p.model, worker_model: p.worker_model, est: p.est, force: p.force, owner_asked_for_fable: p.owner_asked_for_fable }) })
				: p.action === "list" ? await call("/api/lanes")
				: p.action === "send" ? await call(`/api/lanes/${p.name}/send`, { method: "POST", body: JSON.stringify({ text: p.text }) })
				: await call(`/api/lanes/${p.name}`, { method: "DELETE" });
			return { content: [{ type: "text", text: JSON.stringify(out).slice(0, 4000) }] };
		},
	});
	pi.registerTool({
		name: "dotz_channel",
		label: "Dotz work channel",
		description: "Work channels: the owner hands out work by Discord channel (any channel under the bot's category). action=setup {channel (ch:<id> from the inbox header), purpose, logins? [{session_url (a page that only loads when logged in), expect? (regex on that page), host?, profile? (another Aside browser: `aside host list` / `aside host profiles`)}] (kept alive with no model calls while the setup exists; shared across channels), monitors? [{command, every_minutes, on: change|match|fail, pattern?}] (gateway-run checks that wake you in this channel only when something happens), standing? (actions to take on your own when a monitor fires) + basis (the owner's words that asked for them, verbatim; required with standing)} - setup replaces the channel's previous setup; list (with login health); clear {channel}; create {name} (a new work channel under the category); thread {channel (chat or ch:<id>), name, text} (opens a thread there and posts text; returns th:<id>); thread_status {channel: th:<id>, status: working|waiting|done} (name prefix [working]/[waiting]/[done]; done archives the thread). Set it up yourself when a channel's work needs a login kept or something checked over time.",
		parameters: z.object({ action: z.enum(["setup", "list", "clear", "create", "thread", "thread_status"]), status: z.enum(["working", "waiting", "done"]).optional(), channel: z.string().optional(), name: z.string().optional(), text: z.string().optional(), purpose: z.string().optional(), standing: z.string().optional(), basis: z.string().optional(), logins: z.array(z.object({ session_url: z.string(), expect: z.string().optional(), host: z.string().optional(), profile: z.string().optional() })).optional(), monitors: z.array(z.object({ command: z.string(), every_minutes: z.number().optional(), on: z.enum(["change", "match", "fail"]).optional(), pattern: z.string().optional() })).optional() }),
		async execute(_id: string, p: any) {
			const out =
				p.action === "setup" ? await call("/api/channels/setup", { method: "POST", body: JSON.stringify(p) })
				: p.action === "create" ? await call("/api/channels/create", { method: "POST", body: JSON.stringify({ name: p.name }) })
				: p.action === "thread" ? await call("/api/channels/thread", { method: "POST", body: JSON.stringify({ channel: p.channel, name: p.name, text: p.text }) })
				: p.action === "thread_status" ? await call("/api/channels/thread_status", { method: "POST", body: JSON.stringify({ thread: p.channel, status: p.status }) })
				: p.action === "list" ? await call("/api/channels")
				: await call(`/api/channels/${String(p.channel ?? "").replace(/^ch:/, "")}`, { method: "DELETE" });
			return { content: [{ type: "text", text: JSON.stringify(out).slice(0, 4000) }] };
		},
	});
	pi.registerTool({
		name: "dotz_watch",
		label: "Dotz watch",
		description: "Monitoring that costs no model turns: the gateway runs a shell check command every N minutes and reports only when something happens. action=add {name [a-z0-9-], command (exit 0 = healthy; keep it cheap: curl, a CLI status, a file check, a script), every_minutes (>=1, default 10), on: change (output differs from last run) | match {pattern regex} | fail (only failures), to: orchestrator (default; you get an inbox turn) | alert | chat | lane:<name> (posted directly, no model), cwd?}; list; remove {name}. 2 failures in a row -> one alert per 12h, plus a recovery note. Same name replaces. Use it for 'watch X / tell me when Y'. Login keeping: add {name, session_url (an https page that only loads when logged in, e.g. the account or inbox page), expect? (regex the logged-in page contains), refresh_hours? (default 6)} instead of command: checks every 30 min in the owner's Aside browser with no model call, renews cookies with a short background tab load, and wakes you once per 12h if the login is lost.",
		parameters: z.object({ action: z.enum(["add", "list", "remove"]), name: z.string().optional(), command: z.string().optional(), every_minutes: z.number().optional(), on: z.enum(["change", "match", "fail"]).optional(), pattern: z.string().optional(), to: z.string().optional(), cwd: z.string().optional(), session_url: z.string().optional(), expect: z.string().optional(), refresh_hours: z.number().optional(), host: z.string().optional(), profile: z.string().optional() }),
		async execute(_id: string, p: any) {
			const out =
				p.action === "add" ? await call("/api/watches", { method: "POST", body: JSON.stringify(p) })
				: p.action === "list" ? await call("/api/watches")
				: await call(`/api/watches/${p.name}`, { method: "DELETE" });
			return { content: [{ type: "text", text: JSON.stringify(out).slice(0, 3000) }] };
		},
	});
	pi.registerTool({
		name: "dotz_schedule",
		label: "Dotz schedule",
		description: "Reminders and recurring jobs: at the time, the text comes back to you as an inbox turn to act on. action=add {text, at (ISO with offset, e.g. 2026-10-17T09:00:00+09:00) or in_minutes, every_minutes? (>=5)}; list; remove {id}. Use it when the owner says remind me / tell me when / every day.",
		parameters: z.object({ action: z.enum(["add", "list", "remove"]), text: z.string().optional(), at: z.string().optional(), in_minutes: z.number().optional(), every_minutes: z.number().optional(), id: z.string().optional() }),
		async execute(_id: string, p: any) {
			const out =
				p.action === "add" ? await call("/api/schedules", { method: "POST", body: JSON.stringify(p) })
				: p.action === "list" ? await call("/api/schedules")
				: await call(`/api/schedules/${p.id}`, { method: "DELETE" });
			return { content: [{ type: "text", text: JSON.stringify(out).slice(0, 3000) }] };
		},
	});
}

function laneSession(pi: any): void {
	pi.on("before_provider_request", (event: any, ctx: any) => {
		if (ctx?.agent?.kind !== "main" || !event?.payload) return;
		const payload = structuredClone(event.payload);
		return dropLongTtl(payload) ? payload : undefined;
	});
}

function terminalClient(pi: any): void {
	const z = pi.zod;
	let stream: AbortController | undefined;
	let sessionKey = "";

	const show = (text: string) => pi.sendMessage({ customType: "dotz", content: text, display: true });
	const subscribe = async () => {
		const h = hub()!;
		const controller = new AbortController();
		stream = controller;
		const r = await fetch(`${h.url}/api/events`, { headers: { "x-dotz-token": h.token }, signal: controller.signal });
		const reader = r.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		void (async () => {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let cut: number;
					while ((cut = buffer.indexOf("\n\n")) >= 0) {
						const data = buffer.slice(0, cut).split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
						buffer = buffer.slice(cut + 2);
						if (!data) continue;
						const e = JSON.parse(data);
						if (e.kind === "out" && (e.target === "terminal" || e.target === "alert")) show(`${NAME}${e.target === "alert" ? " (알림)" : ""}: ${e.text}`);
					}
				}
			} catch (error) {
				if (!controller.signal.aborted) show(`${NAME} 연결이 끊겼습니다 (${String(error)}). "${NAME}모드 켜"로 다시 연결하세요.`);
			}
		})();
	};
	const on = async (ctx: any) => {
		await ensureGateway();
		sessionKey = ctx.sessionManager?.getSessionId?.() ?? `pid-${process.pid}`;
		await call("/api/attach", { method: "POST", body: JSON.stringify({ session: sessionKey, cwd: ctx.cwd }) });
		stream?.abort();
		await subscribe();
		const s = await call("/api/state?limit=0");
		return `${NAME}모드 켜짐: 이 터미널은 게이트웨이의 ${NAME}와(과) 연결됐습니다. 입력은 ${NAME}에게 전달되고 답은 여기에 표시됩니다 ("${NAME}모드 꺼"로 해제). 오케스트레이터 ${s.orchestrator.status}, 디스코드 ${s.discord.enabled ? (s.discord.connected ? "연결됨" : "연결 중") : "미설정"}, 레인 ${s.lanes.length}개.`;
	};
	const off = async () => {
		stream?.abort();
		stream = undefined;
		await call("/api/attach", { method: "POST", body: JSON.stringify({ session: sessionKey, detach: true }) }).catch(() => undefined);
		return `${NAME}모드 꺼짐: 이 터미널은 다시 일반 omp 세션입니다. 게이트웨이와 ${NAME}는(은) 계속 동작합니다.`;
	};

	pi.on("input", async (event: any) => {
		if (!stream || event?.source !== "interactive") return;
		const text = String(event.text ?? "").trim();
		if (!text) return;
		if (OFF.test(text)) {
			show(await off());
			return { handled: true };
		}
		if (text.startsWith("/") || text.startsWith("!")) return;
		await call("/api/message", { method: "POST", body: JSON.stringify({ text, channel: "terminal" }) });
		return { handled: true };
	});
	pi.on("session_shutdown", () => stream?.abort());

	pi.registerCommand("dotz", {
		description: `${NAME}모드: /dotz on|off|status`,
		handler: async (args: unknown, ctx: any) => {
			const a = String(args ?? "").trim() || "status";
			const out = a === "on" ? await on(ctx) : a === "off" ? await off() : JSON.stringify((await call("/api/state?limit=0").catch((e: Error) => ({ error: e.message }))), null, 1).slice(0, 1500);
			ctx.ui.notify(out, "info");
		},
	});
	pi.registerTool({
		name: "dotz_mode",
		label: "Dotz mode",
		description: `${NAME}모드 (dotz mode). Call action=on when the user says ${NAME}모드 켜 / dotz on: this terminal then forwards the user's input to the always-on ${NAME} gateway orchestrator. action=off stops it; status shows the gateway state.`,
		parameters: z.object({ action: z.enum(["on", "off", "status"]) }),
		async execute(_id: string, p: any, _s: unknown, _u: unknown, ctx: any) {
			const out = p.action === "on" ? await on(ctx) : p.action === "off" ? await off() : JSON.stringify(await call("/api/state?limit=0"), null, 1).slice(0, 1500);
			return { content: [{ type: "text", text: `${out}\n(Reply to the user in one short sentence; do not repeat this text.)` }] };
		},
	});
}

export default function dotz(pi: any) {
	if (process.env.DOTZ_LANE) {
		enforceRules(pi);
		return laneSession(pi);
	}
	pi.setLabel?.("Dotz mode");
	if (process.env.DOTZ_ORCHESTRATOR === "1") {
		enforceRules(pi);
		orchestratorTools(pi);
	}
	else terminalClient(pi);
}
