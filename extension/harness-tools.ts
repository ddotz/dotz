// Harness-management commands for an omp session the user drives directly (ported from the owner's harness-tools extension):
//   /token-audit [hours]  token-leak audit over omp sessions (report only; extension/token-audit.ts)
//   /doctor [fix]         session health: context, session file size, model/default role, last 429, quota, open workers
//                         and patches, worker-guard health over this project's last 7 days of sessions, orphaned omp RPC
//                         processes (`fix` kills the orphans)
//   /handover [note]      fresh session with a handover (recent reports, git status, open worker state)
// The orchestrator can run the first two itself through the harness_doctor and harness_token_audit tools. When the omp
// version changed since the last main session, the guard health check runs once and reports problems.
// The owner's expensive-model rule (guard.ask_before_expensive) adds a line to /doctor and a finding to the audit.
// Config: `guard` in <DOTZ_DIR>/config.json (guard-config.ts). When the owner's original harness-tools.ts is installed in
// the agent directory, installHarnessTools() leaves everything to it and logs once.

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentDir, dataDir, installedOriginal, loadGuardConfig, logOnce, stateDir, statePath } from "./guard-config.ts";
import { expensiveModel } from "./guard.ts";
import { runTokenAudit } from "./token-audit.ts";

const HOME = homedir();
const OMP_BIN = /(^|\/)(bun|node)$/.test(process.execPath) ? "omp" : process.execPath;
const ROTATE_BYTES = 50e6;
const ORPHAN_MIN_AGE_MIN = 10;
const GUARD_WINDOW_MS = 7 * 24 * 3600_000;
const GUARD_MARKER = "[orchestrator-guard]";
const WRITING_AGENTS = new Set(["task", "sonic"]);
const GUARD_TASK_RESULT = /<task-result\b[^>]*\bid="([^"]+)"[^>]*\bstatus="([^"]+)"[^>]*>/g;
const GUARD_PATCH_LINE = /changes captured at `([^`]+\.patch)`/g;

// The host `pi` object, for the agent directory (sessions, worker state).
let host: unknown;
const versionFile = () => join(dataDir(), "last-omp-version");

function run(cmd: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<{ ok: boolean; out: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; out: string }>();
	execFile(cmd, args, { cwd: options.cwd, timeout: options.timeout ?? 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
		resolve({ ok: !error, out: `${stdout}${error ? stderr : ""}` }),
	);
	return promise;
}

function readTail(file: string, bytes: number): any[] {
	let text = "";
	try {
		const buf = readFileSync(file);
		text = buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8");
	} catch {
		return [];
	}
	const out: any[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			continue;
		}
	}
	return out;
}

function lastReports(entries: any[], count: number, cap: number): string {
	const texts: string[] = [];
	for (const e of entries) {
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const content = Array.isArray(e.message.content) ? e.message.content : [];
		const text = content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim();
		if (text.length > 200) texts.push(`(${e.timestamp})\n${text}`);
	}
	return texts.slice(-count).join("\n\n=====\n\n").slice(-cap);
}

function orchestratorState(cwd: string): string[] {
	try {
		const state = JSON.parse(readFileSync(statePath(stateDir(host), cwd, process.env.DOTZ_LANE || undefined), "utf8"));
		return Object.entries(state.workers ?? {}).map(([id, w]: [string, any]) =>
			w.status === "running" ? `${id}: running - ${w.brief}` : `${id}: ${w.status}${w.patch && !w.applied ? `, patch NOT applied: ${w.patch}` : ""} - ${w.brief}`,
		);
	} catch {
		return [];
	}
}

async function anthropicLimits(): Promise<string> {
	const r = await run(OMP_BIN, ["usage", "--json", "-p", "anthropic"], { timeout: 20_000 });
	if (!r.ok) return "quota: lookup failed";
	try {
		const limits = JSON.parse(r.out).reports?.find((x: any) => x.provider === "anthropic")?.limits ?? [];
		const show = (id: string, label: string) => {
			const l = limits.find((x: any) => x.id === id);
			if (!l?.amount) return undefined;
			const reset = l.window?.resetsAt ? new Date(l.window.resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
			return `${label} ${l.amount.remaining}% left (reset ${reset})`;
		};
		return `quota: ${[show("anthropic:5h", "5h"), show("anthropic:7d", "7d")].filter(Boolean).join(", ") || "no data"}`;
	} catch {
		return "quota: unreadable";
	}
}

export function guardHealth(sessionDir: string, now = Date.now()): { problems: string[]; info: string } {
	const counts = { items: 0, marked: 0, writers: 0, isolated: 0, results: 0, parsed: 0, patchMentions: 0, patchParsed: 0 };
	let files: string[] = [];
	try {
		files = readdirSync(sessionDir).filter(f => f.endsWith(".jsonl")).map(f => join(sessionDir, f)).filter(f => statSync(f).mtimeMs >= now - GUARD_WINDOW_MS);
	} catch {
		files = [];
	}
	for (const file of files) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.includes('"name":"task"') && !line.includes("task-result")) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const content = entry.message?.content;
			const blocks: any[] = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
			for (const block of blocks) {
				if (block?.type === "toolCall" && block.name === "task" && entry.message?.role === "assistant") {
					for (const item of block.arguments?.tasks ?? []) {
						counts.items++;
						if (String(item?.task ?? "").includes(GUARD_MARKER)) counts.marked++;
						if (WRITING_AGENTS.has(String(item?.agent ?? "task"))) {
							counts.writers++;
							if (item?.isolated === true) counts.isolated++;
						}
					}
				}
				const text = typeof block?.text === "string" ? block.text : "";
				if (!text.includes("<task-result")) continue;
				counts.results += text.split("<task-result").length - 1;
				counts.parsed += [...text.matchAll(GUARD_TASK_RESULT)].length;
				for (const summary of text.match(/<merge-summary>[\s\S]*?<\/merge-summary>/g) ?? []) {
					counts.patchMentions += (summary.match(/\.patch\b/g) ?? []).length;
					counts.patchParsed += [...summary.matchAll(GUARD_PATCH_LINE)].length;
				}
			}
		}
	}
	const problems: string[] = [];
	if (counts.marked < counts.items) problems.push(`the worker guard did not process ${counts.items - counts.marked} of ${counts.items} worker briefs (extension not loaded, or omp changed how tool input revisions are stored)`);
	if (counts.isolated < counts.writers) problems.push(`${counts.writers - counts.isolated} of ${counts.writers} writing workers ran without isolation (they edited the real checkout)`);
	if (counts.parsed < counts.results) problems.push(`omp task-result format changed: the guard parses ${counts.parsed} of ${counts.results} results, so output trimming and worker state tracking are partly off`);
	if (counts.patchParsed < counts.patchMentions) problems.push(`omp merge-summary format changed: ${counts.patchMentions - counts.patchParsed} patch paths are not recognised, so unapplied patches are not tracked`);
	return { problems, info: `guard: ${counts.items} briefs, ${counts.results} results, ${counts.patchMentions} patches checked in ${files.length} session file(s) from the last 7 days` };
}

type Orphan = { pid: number; age: string; command: string };
async function orphans(): Promise<Orphan[]> {
	const r = await run("ps", ["-axo", "pid=,ppid=,etime=,tty=,command="]);
	const minutes = (et: string) => {
		const [d, hms] = et.includes("-") ? et.split("-") : ["0", et];
		const p = hms.split(":").map(Number);
		while (p.length < 3) p.unshift(0);
		return Number(d) * 1440 + p[0] * 60 + p[1];
	};
	const found: Orphan[] = [];
	for (const line of r.out.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
		if (!m || m[2] !== "1" || !/(^|\/)omp(\s|$)/.test(m[5].split(" ")[0] + " ")) continue;
		if (!/--mode rpc|rpc-host|--internal-rpc/.test(m[5]) || minutes(m[3]) < ORPHAN_MIN_AGE_MIN) continue;
		found.push({ pid: Number(m[1]), age: m[3], command: m[5].slice(0, 120) });
	}
	return found;
}

function bigSessions(): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory() && depth > 0) walk(p, depth - 1);
			else if (e.name.endsWith(".jsonl")) {
				const size = statSync(p).size;
				if (size > ROTATE_BYTES) out.push(`${p.replace(HOME, "~")} ${Math.round(size / 1e6)}MB`);
			}
		}
	};
	walk(join(agentDir(host), "sessions"), 2);
	return out;
}

function lastRateLimit(entries: any[]): string | undefined {
	const last = entries.filter(e => e.type === "message" && e.message?.role === "assistant").at(-1);
	const msg = String(last?.message?.errorMessage ?? "");
	if (last?.message?.stopReason !== "error" || !/429|rate_limit|usage limit|overloaded/i.test(msg)) return undefined;
	const retry = Number(msg.match(/retry-after-ms:\s*(\d+)/)?.[1] ?? 0);
	const at = retry ? new Date(Date.parse(last.timestamp) + retry).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "unknown";
	return `last turn ended on a rate limit (${msg.slice(0, 80)}); retry after ${at}`;
}

async function tokenAuditReport(hours: number): Promise<{ text: string; flags: number; ok: boolean }> {
	try {
		const config = loadGuardConfig();
		const result = await runTokenAudit({ hours, sessionsDir: join(agentDir(host), "sessions"), expensiveModels: config.ask_before_expensive ? config.expensive_models : [] });
		return { text: result.text, flags: result.flags, ok: true };
	} catch (error) {
		return { text: `token-audit failed: ${error instanceof Error ? error.message : String(error)}`, flags: 0, ok: false };
	}
}

// Which worker guard is in effect: this repo's copy, the owner's installed original, or none.
function guardMode(pi: unknown): string {
	const config = loadGuardConfig();
	if (!config.enabled) return "guard: off (guard.enabled is false)";
	const installed = config.defer_to_installed ? installedOriginal(pi, "orchestrator-guard") : undefined;
	return installed ? `guard: the installed original ${installed.replace(HOME, "~")} is in effect; dotz's copy is deferred` : "guard: dotz's copy is in effect";
}

async function doctorReport(ctx: any, fix: boolean): Promise<{ text: string; problems: number }> {
	const file: string | undefined = ctx.sessionManager?.getSessionFile?.();
	const entries = file ? readTail(file, 400_000) : [];
	const usage = ctx.getContextUsage?.();
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "?";
	const [quota, orphanList, defaultRole] = await Promise.all([
		anthropicLimits(),
		orphans(),
		run(OMP_BIN, ["config", "get", "modelRoles", "--json"]).then(r => {
			try {
				return String(JSON.parse(r.out).value?.default ?? "");
			} catch {
				return "";
			}
		}),
	]);
	const problems: string[] = [];
	const info: string[] = [];
	info.push(`context: ${usage ? `${Math.round(usage.tokens / 1000)}K / ${Math.round(usage.contextWindow / 1000)}K (${usage.percent?.toFixed?.(1) ?? "?"}%)` : "?"}`);
	const fileSize = file && existsSync(file) ? statSync(file).size : 0;
	info.push(`session file: ${fileSize ? `${(fileSize / 1e6).toFixed(1)}MB` : "none (ephemeral)"}`);
	if (fileSize > ROTATE_BYTES) problems.push(`session file ${Math.round(fileSize / 1e6)}MB > 50MB: compaction never shrinks it; run /handover for a fresh session`);
	info.push(`model: ${model}${defaultRole ? ` (default role ${defaultRole})` : ""}`);
	const dear = expensiveModel(model, loadGuardConfig());
	if (dear) problems.push(`running on an expensive model (${dear}): guard.ask_before_expensive says only when the owner explicitly asked`);
	else if (defaultRole && !defaultRole.startsWith(model)) problems.push(`model differs from the default role (${defaultRole}); if this is a fallback, switch back with /compact-switch ${defaultRole}`);
	const rl = lastRateLimit(entries);
	if (rl) problems.push(rl);
	info.push(quota);
	const open = orchestratorState(String(ctx.cwd ?? process.cwd()));
	if (open.length) problems.push(`open workers/patches:\n    ${open.join("\n    ")}`);
	info.push(guardMode(host));
	if (file) {
		const health = guardHealth(dirname(file));
		problems.push(...health.problems);
		info.push(health.info);
	}
	for (const big of bigSessions()) if (!file || !big.startsWith(file.replace(HOME, "~"))) info.push(`large session file: ${big}`);
	if (orphanList.length) {
		const list = orphanList.map(o => `${o.pid} (${o.age}) ${o.command}`).join("\n    ");
		if (fix) {
			await run("kill", orphanList.map(o => String(o.pid)));
			const left = await orphans();
			info.push(`orphaned omp RPC processes killed: ${orphanList.length - left.length}/${orphanList.length}`);
		} else problems.push(`orphaned omp RPC processes (ppid 1, >${ORPHAN_MIN_AGE_MIN} min); run doctor with fix to kill them:\n    ${list}`);
	}
	return { text: [`doctor: ${problems.length ? `${problems.length} issue(s)` : "healthy"}`, ...problems.map(p => `- ${p}`), ...info.map(i => `  ${i}`)].join("\n"), problems: problems.length };
}

export function installHarnessTools(pi: any): void {
	const config = loadGuardConfig();
	if (!config.harness_tools) return;
	const installed = config.defer_to_installed ? installedOriginal(pi, "harness-tools") : undefined;
	if (installed) {
		logOnce(pi, "harness-deferred", `dotz harness tools: ${installed} is installed, so dotz's /doctor, /handover, /token-audit and their tools stay off (the names would collide). Set guard.defer_to_installed to false in <DOTZ_DIR>/config.json to run them anyway.`);
		return;
	}
	host = pi;
	const z = pi.zod;

	pi.on("session_start", async (_event: any, ctx: any) => {
		if (ctx?.agent?.kind !== "main") return;
		const version = (await run(OMP_BIN, ["--version"])).out.trim();
		let previous = "";
		try {
			previous = readFileSync(versionFile(), "utf8").trim();
		} catch {
			previous = "";
		}
		if (!version || version === previous) return;
		mkdirSync(dirname(versionFile()), { recursive: true });
		writeFileSync(versionFile(), `${version}\n`);
		if (!previous) return;
		const file: string | undefined = ctx.sessionManager?.getSessionFile?.();
		const health = file ? guardHealth(dirname(file)) : { problems: [], info: "guard: no session history to check" };
		ctx.ui?.notify?.(
			[`harness-tools: omp updated ${previous} -> ${version}.`, ...(health.problems.length ? health.problems.map(p => `- ${p}`) : ["guard health OK."]), `  ${health.info}`].join("\n"),
			health.problems.length ? "warning" : "info",
		);
	});

	pi.registerCommand("token-audit", {
		description: "Token-leak audit over omp sessions (report only): /token-audit [hours, default 24]",
		handler: async (args: unknown, ctx: any) => {
			const hours = Number(String(args ?? "").trim()) || 24;
			ctx.ui.notify(`token-audit: scanning the last ${hours}h...`, "info");
			const report = await tokenAuditReport(hours);
			ctx.ui.notify(report.text, !report.ok ? "error" : report.flags ? "warning" : "info");
		},
	});

	pi.registerTool({
		name: "harness_token_audit",
		label: "Token audit",
		description: "Token-leak audit over this machine's omp sessions (report only, no LLM calls): unexplained cache busts, idle wakes, error streaks, oversized context, expensive-model/fallback use, repeated calls, big workers, spikes. Use when the user asks to check token usage, leaks or costs.",
		parameters: z.object({ hours: z.number().optional() }),
		async execute(_id: string, params: any) {
			const report = await tokenAuditReport(Number(params?.hours) || 24);
			return { content: [{ type: "text", text: report.text }], details: { flags: report.flags, ok: report.ok } };
		},
	});

	pi.registerTool({
		name: "harness_doctor",
		label: "Harness doctor",
		description: "Health check of this omp session and harness: context, session file size, model vs default role, last rate limit, quota, open workers and unapplied patches, worker-guard health, orphaned omp RPC processes. Use when the user asks to check or inspect the setup. fix=true also kills the orphaned processes.",
		parameters: z.object({ fix: z.boolean().optional() }),
		async execute(_id: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
			const report = await doctorReport(ctx, params?.fix === true);
			return { content: [{ type: "text", text: report.text }], details: { problems: report.problems } };
		},
	});

	pi.registerCommand("doctor", {
		description: "Session/harness health check: /doctor [fix]  (fix = kill orphaned omp RPC processes)",
		handler: async (args: unknown, ctx: any) => {
			const report = await doctorReport(ctx, String(args ?? "").trim() === "fix");
			ctx.ui.notify(report.text, report.problems ? "warning" : "info");
		},
	});

	pi.registerCommand("handover", {
		description: "Start a fresh session with a handover (recent reports, git status, open workers): /handover [note]",
		handler: async (args: unknown, ctx: any) => {
			const note = String(args ?? "").trim();
			const file: string | undefined = ctx.sessionManager?.getSessionFile?.();
			const cwd = String(ctx.cwd ?? process.cwd());
			const entries = file ? readTail(file, 6_000_000) : [];
			const recent = lastReports(entries, 3, 8000);
			const git = await run("git", ["status", "--short"], { cwd });
			const status = git.ok ? git.out.split("\n").slice(0, 40).join("\n").trim() : "";
			const open = orchestratorState(cwd);
			const handover = [
				`[handover] Continuing from previous session ${file ?? "(ephemeral)"}${note ? ` - note: ${note}` : ""}.`,
				"There is no conversation context: continue from the recent reports below and the state on disk (git). Read only the tail of the previous session file if you need more.",
				"Commit, push and external sends need the same approval as in the previous session.",
				"",
				"--- recent reports from the previous session ---",
				recent || "(none)",
				...(status ? ["", "--- git status --short ---", status] : []),
				...(open.length ? ["", "--- open workers / unapplied patches ---", ...open] : []),
			].join("\n");
			const result = await ctx.newSession(file ? { parentSession: file } : undefined);
			if (result?.cancelled) return ctx.ui.notify("handover: new session was cancelled", "warning");
			pi.sendUserMessage(handover);
		},
	});
}
