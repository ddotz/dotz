// Dotz mode extension; behaviour depends on which session loads it:
// - gateway orchestrator (DOTZ_ORCHESTRATOR=1): dotz_send / dotz_lane / dotz_schedule / dotz_auth tools, recall after compaction.
// - lane session (DOTZ_LANE set): dotz_auth tool; 5-minute prompt cache (1h is for the orchestrator only; idle warming covers waits).
// - an OmO task worker of a lane or the orchestrator (DOTZ_LANE or DOTZ_ORCHESTRATOR=1, + OMO_SENPI_TASK_DEPTH): owner rules,
//   output caps, 5-minute cache only.
// - any other session: "<name>모드 켜" (dotz_mode tool, /dotz on) makes this terminal a thin client of the
//   gateway: typed input is forwarded to the gateway orchestrator instead of the local model, replies addressed to
//   the terminal are shown here. "<name>모드 꺼" or /dotz off stops forwarding. No terminal needs to stay open.
// - orchestrator, lanes and their workers: the thinking of finished turns kept across a compaction is left out of
//   later requests (compact-kept.ts).
// - every session above also gets the worker guard (guard.ts) and the /doctor, /handover, /token-audit commands (harness-tools.ts);
//   config key `guard`, see README. Each skips itself when the owner's original ~/.omp extension of that name is installed.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { baseLanguage, detectLanguage, languageName } from "../hub/language.ts";
import { blockedByFeatures, featurePrompt } from "../hub/featuredirs.ts";
import { runWithReceipt, summarize } from "../hub/receipts.ts";
import { systemDeny } from "../hub/systemdeny.ts";
import { installCompactKept } from "./compact-kept.ts";
import { defaultDataDir, dryRun, hubPid, liveDataDir, liveWrite, throwawayReason } from "../hub/live-guard.ts";
import { dropLongTtl, installGuard } from "./guard.ts";
import { installHarnessTools } from "./harness-tools.ts";
import { installOutputCap } from "./output-cap.ts";
import { jsonZod, params } from "./schema.ts";

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

// The text a deny line is matched against: omp's `bash` command, or the code of OmO's `eval` cell (OmO has no bash
// tool; shell commands run inside eval as Bun.$ / subprocess / tool.bash, so the whole cell is checked).
export function shellText(event: any): string | undefined {
	const tool = String(event?.toolName ?? "");
	if (tool === "bash") return String(event?.input?.command ?? "");
	if (tool === "eval") return String(event?.input?.code ?? "");
	return undefined;
}

// A test, probe or hand-started copy (hub/live-guard.ts): read once per call, since hub.pid changes with the gateway.
const throwaway = () => throwawayReason({ hubPid: hubPid(DATA) });

function enforceRules(pi: any): void {
	pi.on("tool_call", (event: any) => {
		const copy = throwaway();
		const live = copy ? liveWrite(event, [...new Set([liveDataDir(DATA), defaultDataDir()].filter((d): d is string => Boolean(d)))]) : undefined;
		if (live) return { block: true, reason: `Blocked by dotz: this session is a throwaway (${copy}) and may not change the owner's live state: ${live}. Set DOTZ_ALLOW_LIVE=1 for a deliberate live run.` };
		const command = shellText(event);
		if (command === undefined) return;
		const system = systemDeny(command);
		if (system) return { block: true, reason: `Blocked by dotz: ${system}.` };
		const file = join(DATA, "RULES.md");
		const reason = existsSync(file) ? blockedBy(command, readFileSync(file, "utf8")) : undefined;
		if (reason) return { block: true, reason: `Blocked by the owner's rule (${file}): ${reason}. Do not work around it; report it if the task needs it.` };
		const feature = blockedByFeatures(DATA, command);
		if (feature) return { block: true, reason: `Blocked by the owner's feature (${join(DATA, "features", feature.id, "feature.md")}): ${feature.reason}. Do not work around it; report it if the task needs it.` };
	});
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
	const copy = (init.method ?? "GET") !== "GET" ? throwaway() : undefined;
	if (copy) return dryRun(path, init as { method?: string; body?: unknown }, copy);
	const r = await fetch(h.url + path, { ...init, headers: { "x-dotz-token": h.token, "Content-Type": "application/json", ...(init.headers ?? {}) } });
	const text = await r.text();
	const data = text ? JSON.parse(text) : {};
	if (!r.ok) throw Object.assign(new Error(data.error ?? data.reason ?? `${r.status}`), { status: r.status });
	return data;
}

type AuthParams = { site: string; kind: "secret" | "otp" | "approve"; fields?: string[]; purpose: string; target?: string; timeout_minutes?: number };

// Web-login credentials from the owner via Discord (buttons + modal). The submitted value goes only to the gateway: the
// secret kind lands in a 0600 file, the otp kind is fetched once with `take`; this tool never sees or returns a value.
function authTool(pi: any, lane?: string): void {
	const z = pi.zod;
	const where = lane ? `It is posted to this lane's Discord channel.` : `target: chat (default), alert, lane:<name>, ch:<id>, th:<id>.`;
	pi.registerTool({
		name: "dotz_auth",
		label: "Dotz auth",
		description: `Ask the owner for a web-login credential through Discord: the gateway posts a message with buttons, the owner presses one and types the value into a Discord modal, and the value never enters the prompt, logs or chat. Use it when a login needs a password, an OTP code, or a push/FIDO approval, or when the account has no stored credentials. Asking through this tool is the owner's OK for the second factor (still trigger it only once, never retry). kind=secret {fields? [username,password] (default both; or any of username|password|code)}: stored as a JSON object {field: value} in a 0600 file under the secrets dir, whose path is returned. kind=otp: a one-time code you fetch once with the returned command. kind=approve: the owner confirms they approved the push/FIDO prompt on their device. site = a short key [a-z0-9._-] naming the service (the secrets file name). purpose = one line shown to the owner saying what it is for. ${where} timeout_minutes 1-30 (default 10). The call waits until the owner answers, cancels, or it times out; do the login step after it returns.`,
		parameters: z.object({
			site: z.string(),
			kind: z.enum(["secret", "otp", "approve"]),
			fields: z.array(z.enum(["username", "password", "code"])).optional(),
			purpose: z.string(),
			...(lane ? {} : { target: z.string().optional() }),
			timeout_minutes: z.number().min(1).max(30).optional(),
		}),
		async execute(_id: string, p: AuthParams, signal?: AbortSignal) {
			const text = (t: string) => ({ content: [{ type: "text", text: t }] });
			const body: Record<string, unknown> = { site: p.site, kind: p.kind, purpose: p.purpose, target: lane ? `lane:${lane}` : (p.target ?? "chat") };
			if (p.fields) body.fields = p.fields;
			if (p.timeout_minutes) body.timeout_minutes = p.timeout_minutes;
			const { id }: { id: string } = await call("/api/auth", { method: "POST", body: JSON.stringify(body), signal });
			const cancel = async () => {
				await call(`/api/auth/${id}`, { method: "DELETE" }).catch(() => undefined);
				return text(`Auth request for ${p.site} cancelled (this call was aborted).`);
			};
			for (;;) {
				if (signal?.aborted) return cancel();
				let r: { status: string; path?: string; take?: string };
				try {
					r = await call(`/api/auth/${id}?wait=50`, { signal });
				} catch (e: unknown) {
					if (signal?.aborted) return cancel();
					if (e instanceof Error && "status" in e && e.status === 404) return text(`Auth request for ${p.site} was lost (the gateway restarted). Ask again if it is still needed.`);
					throw e;
				}
				if (r.status === "pending") continue;
				if (r.status === "entered" && p.kind !== "otp") {
					const fields = (p.fields ?? (p.kind === "secret" ? ["username", "password"] : [])).join(", ");
					return text(`The owner entered the ${p.site} credentials. Stored at ${r.path} as a JSON object {${fields}}, mode 0600. Read it at run time; never put the values in prompts, briefs, reports or logs.`);
				}
				if (r.status === "entered") {
					const h = hub();
					return text(`The owner entered the ${p.site} OTP code. Take it once, within 5 minutes, and pipe it straight into the consumer without printing it: curl -s -H "x-dotz-token: $(cat ${join(DATA, "secrets", "hub-token")})" ${h?.url ?? ""}${r.take ?? `/api/auth/${id}/take`}`);
				}
				return text(`Auth request for ${p.site}: ${r.status}.`);
			}
		},
	});
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
	const mode = file(chain.find(existsSync) ?? join(PKG, "MODE.md"), 30000);
	const features = featurePrompt(DATA, "orchestrator");
	const parts = { identity: file(join(DATA, "identity", "IDENTITY.md"), 3000), rules: file(join(DATA, "RULES.md"), 12000) + (features ? `\n\n${features}` : ""), lessons: file(join(DATA, "LESSONS.md"), 3000), setups: file(join(DATA, "channel-setups.json"), 3000), state: file(join(DATA, "state.json"), 4000) || "{}" };
	if (base === "ko") return `[dotz] 컨텍스트 압축 뒤 계약을 다시 읽어요:\n\n정체성:\n${parts.identity}\n\n${mode}\n\n오너 규칙:\n${parts.rules}\n\n교훈:\n${parts.lessons}\n\n작업 채널 설정 (자세한 건 dotz_channel list):\n${parts.setups || "(없음)"}\n\n현재 state.json:\n${parts.state}`;
	const reply = base === "en" ? "" : `\n\nReply to the owner in ${languageName(code)} (${code}).`;
	return `[dotz] Contract re-read after compaction:\n\nIdentity:\n${parts.identity}\n\n${mode}\n\nOwner rules:\n${parts.rules}\n\nLessons:\n${parts.lessons}\n\nWork channel setups (dotz_channel list for details):\n${parts.setups || "(none)"}\n\nCurrent state.json:\n${parts.state}${reply}`;
}

// Re-running a Done-when command on an unchanged checkout is wasted time: a stored pass for the same command, HEAD,
// uncommitted state and env is returned instead of running it again. A failure always re-runs.
function verifyTool(pi: any): void {
	const z = pi.zod;
	pi.registerTool({
		name: "dotz_verify",
		label: "Dotz verify",
		description: "Run a verification command with a receipt. Use it when re-running a lane's Done-when command (or any check you would repeat): if the same command passed on exactly this git checkout (same HEAD, same uncommitted changes, same env) within the last 6 hours, the stored result is returned with reused instead of running again; any commit or edit, a previous failure, or a folder outside git runs it for real. Only for checks whose result depends on the checkout (tests, build, lint); never for live external state (curl, gh pr view, a service's status), which a receipt cannot see change. {command (run with bash -lc, killed after 15 min), cwd (the lane's worktree or project folder), env? (names of env vars whose values affect the result)}. Returns `receipt <key> reused|ran exit=N head=<sha7>` and the output tail.",
		parameters: z.object({ command: z.string(), cwd: z.string(), env: z.array(z.string()).optional() }),
		async execute(_id: string, p: { command: string; cwd: string; env?: string[] }) {
			const r = await runWithReceipt(p);
			return { content: [{ type: "text", text: summarize(r) }] };
		},
	});
}

function orchestratorTools(pi: any): void {
	const z = pi.zod;
	verifyTool(pi);
	authTool(pi);
	pi.on("session_compact", (_e: any, ctx: any) => {
		if (isMain(ctx)) pi.sendMessage({ customType: "dotz-mode", content: recall(), display: false }, { deliverAs: "nextTurn" });
	});
	pi.registerTool({
		name: "dotz_send",
		label: "Dotz send",
		description: `Send a message as ${NAME} to a channel other than the one that asked, or the one progress note (update_key) mid-turn. Your final answer is already delivered to the asking channel; text you send there before it is held and goes out with it, so answer only when it is ready. target: chat, dm, worklog, alert, lane:<name>, ch:<id> (a work channel), th:<id> (a thread), web, terminal. reply_to = a Discord msg id. update_key (e.g. "progress") = one evolving status message per target and key, edited in place on each call instead of posting again (not counted as your answer). A \`[file] /absolute/path\` line in text attaches that file (too big: a download link). Never include secrets.`,
		parameters: z.object({ target: z.string(), text: z.string(), reply_to: z.string().optional(), update_key: z.string().optional() }),
		async execute(_id: string, p: any) {
			const r = await call("/api/send", { method: "POST", body: JSON.stringify(p) });
			return { content: [{ type: "text", text: r.delivered ? `sent to ${p.target}` : `not delivered: ${r.reason}` }] };
		},
	});
	pi.registerTool({
		name: "dotz_lane",
		label: "Dotz lane",
		description: "Project lanes: one headless omp orchestrator per project folder, each with its own Discord channel; its reports come back as inbox turns. A stopped lane whose session another runtime wrote cannot be resumed (send refuses it); continue it with action=handover {name, text?}: a fresh session of the same lane, handed the previous session's recent exchanges, its brief and last report. A lane is only for multi-hour, multi-step project work: anything under an hour you do yourself or with task subagents (their results come back into your own session), never a lane for a 10-20 minute job. A lane plans and reviews on its own model and runs implementation, tests, renders and grind work as task workers on a cheaper worker model. action=launch {why (why this needs a lane rather than you or a task subagent: the hours and steps involved), hours (expected duration; under 1 is refused), owner_asked_for_lane? (true only when the owner asked for a lane; skips the hours check), name [a-z0-9-] (internal key), title (the lane's Discord channel name, or its thread name when home is given, read by the owner: 2-3 plain words in the owner's main language saying what the work is, e.g. 게이트웨이-화면, never a repo or project codename), cwd absolute, brief (must contain a 'Done when:' line, <= 8000 chars, paths not contents), model? (Fable or max/xhigh effort only with owner_asked_for_fable=true, when the owner explicitly asked for it; the same applies to worker_model), home? (ch:<id> of a work channel. Default: a lane launched for a request from a work channel works in a thread on the owner's message there, one launched from a thread takes that thread over, one from chat gets a new channel; stop archives a thread and never deletes the channel), worker_model? (provider/model[:thinking] for this lane's task workers; default is lanes.worker_model from the config), est? (percent of the 5h usage window this job is expected to use, 0-100; default 15; the gate refuses when under 10% would remain, so give a realistic number: small fix ~5, big build ~30), force? (only after the owner OKs a budget-gate warning)}; list; send {name, text} (also resumes a stopped lane's session); stop {name}; verify {name, text: evidence} (after you checked the lane's Done-when yourself: what you ran and the result; works only while the lane's last report was [done], i.e. its claim is reported, and marks it verified, which the worklog entry then shows).",
		parameters: z.object({ action: z.enum(["launch", "list", "send", "handover", "stop", "verify"]), why: z.string().optional(), hours: z.number().optional(), owner_asked_for_lane: z.boolean().optional(), name: z.string().optional(), title: z.string().optional(), kind: z.string().optional(), home: z.string().optional(), cwd: z.string().optional(), brief: z.string().optional(), text: z.string().optional(), model: z.string().optional(), worker_model: z.string().optional(), est: z.number().min(0).max(100).optional(), force: z.boolean().optional(), owner_asked_for_fable: z.boolean().optional() }),
		async execute(_id: string, p: any) {
			const out =
				p.action === "launch" ? await call("/api/lanes", { method: "POST", body: JSON.stringify({ why: p.why, hours: p.hours, owner_asked_for_lane: p.owner_asked_for_lane, name: p.name, title: p.title, kind: p.kind, home: p.home, cwd: p.cwd, brief: p.brief, model: p.model, worker_model: p.worker_model, est: p.est, force: p.force, owner_asked_for_fable: p.owner_asked_for_fable }) })
				: p.action === "list" ? await call("/api/lanes")
				: p.action === "send" ? await call(`/api/lanes/${p.name}/send`, { method: "POST", body: JSON.stringify({ text: p.text }) })
				: p.action === "handover" ? await call(`/api/lanes/${p.name}/handover`, { method: "POST", body: JSON.stringify({ text: p.text }) })
				: p.action === "verify" ? await call(`/api/lanes/${p.name}/verify`, { method: "POST", body: JSON.stringify({ text: p.text }) })
				: await call(`/api/lanes/${p.name}`, { method: "DELETE" });
			return { content: [{ type: "text", text: JSON.stringify(out).slice(0, 4000) }] };
		},
	});
	pi.registerTool({
		name: "dotz_channel",
		label: "Dotz work channel",
		description: "Work channels: the owner hands out work by Discord channel (any channel under the bot's category). action=setup {channel (ch:<id> from the inbox header), purpose, logins? [{session_url (a page that only loads when logged in), expect? (regex on that page), host?, profile? (another Aside browser: `aside host list` / `aside host profiles`)}] (kept alive with no model calls while the setup exists; shared across channels), monitors? [{command, every_minutes, on: change|match|fail, pattern?}] (gateway-run checks that wake you in this channel only when something happens), standing? (actions to take on your own when a monitor fires) + basis (the owner's words that asked for them, verbatim; required with standing)} - setup replaces the channel's previous setup; list (with login health); clear {channel}; create {name} (a new work channel under the category); thread {channel (chat or ch:<id>), name (short title), text (its first paragraph is posted in the channel and the thread hangs from that message, so make it say what the thread is about; the rest goes inside the thread)} (opens a thread named with plain words of what it is, e.g. the mail subject with its sender; returns th:<id>); thread_status {channel: th:<id>, status: working|waiting|done} (shown as a reaction on the parent message the thread hangs from: working 🟡, waiting 🔴, done 🟢; the name never changes; done archives the thread an hour later, working/waiting cancel that). Set it up yourself when a channel's work needs a login kept or something checked over time.",
		parameters: z.object({ action: z.enum(["setup", "list", "clear", "create", "thread", "thread_status"]), status: z.enum(["working", "waiting", "done"]).optional(), channel: z.string().optional(), name: z.string().optional(), kind: z.string().optional(), text: z.string().optional(), purpose: z.string().optional(), standing: z.string().optional(), basis: z.string().optional(), logins: z.array(z.object({ session_url: z.string(), expect: z.string().optional(), host: z.string().optional(), profile: z.string().optional() })).optional(), monitors: z.array(z.object({ command: z.string(), every_minutes: z.number().optional(), on: z.enum(["change", "match", "fail"]).optional(), pattern: z.string().optional() })).optional() }),
		async execute(_id: string, p: any) {
			const out =
				p.action === "setup" ? await call("/api/channels/setup", { method: "POST", body: JSON.stringify(p) })
				: p.action === "create" ? await call("/api/channels/create", { method: "POST", body: JSON.stringify({ name: p.name }) })
				: p.action === "thread" ? await call("/api/channels/thread", { method: "POST", body: JSON.stringify({ channel: p.channel, name: p.name, kind: p.kind, text: p.text }) })
				: p.action === "thread_status" ? await call("/api/channels/thread_status", { method: "POST", body: JSON.stringify({ thread: p.channel, status: p.status }) })
				: p.action === "list" ? await call("/api/channels")
				: await call(`/api/channels/${String(p.channel ?? "").replace(/^ch:/, "")}`, { method: "DELETE" });
			return { content: [{ type: "text", text: JSON.stringify(out).slice(0, 4000) }] };
		},
	});
	pi.registerTool({
		name: "dotz_watch",
		label: "Dotz watch",
		description: "Monitoring that costs no model turns: the gateway runs a shell check command every N minutes and reports only when something happens. action=add {name [a-z0-9-], command (exit 0 = healthy; keep it cheap: curl, a CLI status, a file check, a script), every_minutes (>=1, default 10), on: change (output differs from last run) | match {pattern regex} | fail (only failures), to: orchestrator (default; you get an inbox turn) | alert | chat | lane:<name> (posted directly, no model), cwd?}; list; remove {name}. 2 failures in a row -> one alert per 12h, plus a recovery note. Same name replaces. Use it for 'watch X / tell me when Y'. Login keeping: add {name, session_url (an https page that only loads when logged in, e.g. the account or inbox page), expect? (regex the logged-in page contains), refresh_hours? (default 6)} instead of command: checks every 30 min in the owner's Aside browser with no model call, renews cookies with a short background tab load, and wakes you once per 12h if the login is lost. Robustness (add): timeout_seconds (default 120; the whole process group is SIGKILLed then); a failing check may print a line `DOTZ_FAIL <kind>` and retry {<kind>: [minutes per consecutive failure, last repeats]} sets its own wait ([] = stop until the owner approves); approval_minutes N gates a human step (2FA push): the check gets DOTZ_APPROVED=1 while the owner's approval is younger than N minutes, prints DOTZ_APPROVAL_USED once the step went out, and `DOTZ_FAIL approval` wakes you once to ask the owner; on their yes call action=approve {name}.",
		parameters: z.object({ action: z.enum(["add", "list", "remove", "approve"]), timeout_seconds: z.number().optional(), retry: z.record(z.string(), z.array(z.number())).optional(), approval_minutes: z.number().optional(), name: z.string().optional(), command: z.string().optional(), every_minutes: z.number().optional(), on: z.enum(["change", "match", "fail"]).optional(), pattern: z.string().optional(), to: z.string().optional(), cwd: z.string().optional(), session_url: z.string().optional(), expect: z.string().optional(), refresh_hours: z.number().optional(), host: z.string().optional(), profile: z.string().optional() }),
		async execute(_id: string, p: any) {
			const out =
				p.action === "add" ? await call("/api/watches", { method: "POST", body: JSON.stringify(p) })
				: p.action === "list" ? await call("/api/watches")
				: p.action === "approve" ? await call(`/api/watches/${p.name}/approve`, { method: "POST" })
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

// Lanes and their workers write the 5-minute prompt cache (they inherit PI_CACHE_RETENTION=long from the gateway).
function shortCache(pi: any): void {
	pi.on("before_provider_request", (event: any, ctx: any) => {
		if (ctx?.agent?.kind !== "main" || !event?.payload) return;
		const payload = structuredClone(event.payload);
		return dropLongTtl(payload) ? payload : undefined;
	});
}

function laneSession(pi: any): void {
	verifyTool(pi);
	authTool(pi, process.env.DOTZ_LANE);
	shortCache(pi);
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

// A fallback entry that bills through its own API key runs as a provider of its own (hub/fallback.ts keyEnv): the gateway
// describes it in DOTZ_KEY_PROVIDER (no secret) and hands the key over in DOTZ_KEY_VALUE. The key is registered as a literal
// and both variables leave the environment at once, so no tool command or task worker this process starts can read it.
function keyProvider(pi: any): void {
	const raw = process.env.DOTZ_KEY_PROVIDER;
	const key = process.env.DOTZ_KEY_VALUE;
	delete process.env.DOTZ_KEY_PROVIDER;
	delete process.env.DOTZ_KEY_VALUE;
	if (!raw || !key) return;
	const { id, baseUrl, api, models } = JSON.parse(raw);
	pi.registerProvider(id, { baseUrl, api, apiKey: key, models });
}

import { isMain } from "./guard-config.ts";

export { isMain };

// OmO (senpi) gives extensions no zod and takes plain JSON Schema tool parameters: the same tool definitions are built
// with the JSON Schema builder there (schema.ts).
function compatHost(pi: any): any {
	if (pi.zod) return pi;
	const register = pi.registerTool.bind(pi);
	return Object.assign(Object.create(pi), { zod: jsonZod, registerTool: (tool: any) => register({ ...tool, parameters: params(tool.parameters) }) });
}

export default function dotz(host: any) {
	const pi = compatHost(host);
	// An OmO task worker of a lane or of the orchestrator (a child process with its parent's environment, hub/runtime/omo.ts
	// WORKER_TASK; OmO sets OMO_SENPI_TASK_DEPTH): the owner's rules, the output caps and the 5-minute cache, none of the
	// parent's tools or commands (as before, no prompt growth).
	if ((process.env.DOTZ_LANE || process.env.DOTZ_ORCHESTRATOR === "1") && process.env.OMO_SENPI_TASK_DEPTH) {
		enforceRules(pi);
		installOutputCap(pi);
		installCompactKept(pi);
		return shortCache(pi);
	}
	keyProvider(pi);
	// Worker guard and harness commands run in every session (interactive, orchestrator, lane), each skipping itself when the
	// owner's original ~/.omp extension of the same name is installed (guard-config.ts installedOriginal).
	installGuard(pi);
	installHarnessTools(pi);
	if (process.env.DOTZ_LANE) {
		enforceRules(pi);
		installOutputCap(pi);
		installCompactKept(pi);
		return laneSession(pi);
	}
	// Action methods such as setLabel only work once the session is bound (OmO throws during extension loading).
	// OmO's setLabel(entryId, label) labels a transcript entry, so the one-argument call failed there on every start
	// ("Entry Dotz mode not found" in the terminal view); OmO names the session with setSessionName instead.
	pi.on("session_start", () => (process.env.DOTZ_RUNTIME === "omo" ? pi.setSessionName?.("Dotz mode") : pi.setLabel?.("Dotz mode")));
	if (process.env.DOTZ_ORCHESTRATOR === "1") {
		enforceRules(pi);
		installCompactKept(pi);
		orchestratorTools(pi);
	}
	else terminalClient(pi);
}
