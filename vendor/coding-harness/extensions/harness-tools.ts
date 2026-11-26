import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { harnessDir, isHostCopy } from "../harness/agent-home.ts";
import { loadState, patchDiscarded } from "../harness/guard/state.ts";
import { type NoticeLanguage, type NoticeText, noticeLanguage, say } from "../harness/notice.ts";

const HOME = homedir();
const AUDIT_SCRIPT = join(harnessDir(), "token-audit.ts");
const SESSIONS = join(HOME, ".omp", "agent", "sessions");
const BUN = existsSync(join(HOME, ".bun", "bin", "bun")) ? join(HOME, ".bun", "bin", "bun") : "bun";
const OMP_BIN = /(^|\/)(bun|node)$/.test(process.execPath) ? "omp" : process.execPath;
const ROTATE_BYTES = 50e6;
const VERSION_FILE = join(harnessDir(), "last-omp-version");
const ORPHAN_MIN_AGE_MIN = 10;
const GUARD_WINDOW_MS = 7 * 24 * 3600_000;
const GUARD_MARKER = "[orchestrator-guard]";
const WRITING_AGENTS = new Set(["task", "sonic"]);
const RESULT_TOOLS = new Set(["task", "wait"]);
const GUARD_TASK_RESULT = /<task-result\b[^>]*\bid="([^"]+)"[^>]*\bstatus="([^"]+)"[^>]*>/g;
const GUARD_PATCH_LINE = /changes captured at `([^`]+\.patch)`/g;
const SETUP_FILE = join(harnessDir(), ".setup-version");
const readSetupVersion = () => (existsSync(SETUP_FILE) ? readFileSync(SETUP_FILE, "utf8").trim() : "");
const LOADED_SETUP = readSetupVersion();

/** The doctor's harness line from the commit this process loaded and the one deployed now; a deploy the session has not restarted into is a problem. `t` picks the language of each line (English by default). */
export function setupStatus(loaded: string, deployed: string, t: (text: NoticeText) => string = text => text.en): { info?: string; problem?: string } {
	if (!deployed) return { problem: t({ en: `the harness on this machine was not set up from the harness-foundation repo (no ${SETUP_FILE}); have an agent follow SETUP.md of that repo, which ends with a check that the machine matches it`, ko: `이 기기의 하네스는 harness-foundation 저장소로 설치되지 않았습니다(${SETUP_FILE} 없음). 에이전트에게 그 저장소의 SETUP.md를 따르게 하세요. 마지막 단계가 기기와 저장소가 맞는지 확인합니다` }) };
	if (!loaded || loaded === deployed) return { info: t({ en: `harness setup: ${deployed.slice(0, 7)}`, ko: `하네스 설치: ${deployed.slice(0, 7)}` }) };
	return {
		info: t({ en: `harness setup: ${deployed.slice(0, 7)} (this session runs ${loaded.slice(0, 7)})`, ko: `하네스 설치: ${deployed.slice(0, 7)} (이 세션은 ${loaded.slice(0, 7)}로 실행 중)` }),
		problem: t({ en: `the deployed harness ${deployed.slice(0, 7)} is not loaded: this session still runs ${loaded.slice(0, 7)}; call session_restart`, ko: `배포된 하네스 ${deployed.slice(0, 7)}가 실리지 않았습니다. 이 세션은 아직 ${loaded.slice(0, 7)}로 실행 중이니 session_restart를 부르세요` }),
	};
}

interface TextBlock {
	type?: string;
	text?: unknown;
	name?: string;
	arguments?: { tasks?: { task?: unknown; agent?: unknown; isolated?: unknown }[] };
}

interface LogEntry {
	type?: string;
	timestamp?: string;
	message?: { role?: string; toolName?: string; content?: TextBlock[] | string; errorMessage?: string; stopReason?: string };
}

interface Limit {
	id?: string;
	amount?: { remaining?: number };
	window?: { resetsAt?: string | number };
}

type Level = "info" | "warning" | "error";

interface Ctx {
	cwd?: string;
	agent?: { kind?: string };
	model?: { provider: string; id: string };
	sessionManager?: { getSessionFile?(): string | undefined };
	getContextUsage?(): { tokens: number; contextWindow: number; percent?: number } | undefined;
	ui: { notify(text: string, level: Level): void };
	newSession(options?: { parentSession: string }): Promise<{ cancelled?: boolean } | undefined>;
}

interface Schema {
	optional(): Schema;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

interface Api {
	zod: { object(shape: Record<string, Schema>): Schema; number(): Schema; boolean(): Schema };
	setLabel?(label: string): void;
	on(event: "session_start", handler: (event: unknown, ctx: Ctx) => Promise<void>): void;
	registerCommand(name: string, command: { description: string; handler(args: unknown, ctx: Ctx): Promise<void> }): void;
	registerTool<P>(tool: {
		name: string;
		label: string;
		description: string;
		parameters: Schema;
		execute(id: string, params: P | undefined, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<ToolResult>;
	}): void;
	sendUserMessage(text: string): void;
}

function run(cmd: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<{ ok: boolean; out: string }> {
	return new Promise(resolve => {
		execFile(cmd, args, { cwd: options.cwd, timeout: options.timeout ?? 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
			resolve({ ok: !error, out: `${stdout}${error ? stderr : ""}` }),
		);
	});
}

function readTail(file: string, bytes: number): LogEntry[] {
	let text = "";
	try {
		const buf = readFileSync(file);
		text = buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8");
	} catch {
		return [];
	}
	const out: LogEntry[] = [];
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

function lastReports(entries: LogEntry[], count: number, cap: number): string {
	const texts: string[] = [];
	for (const e of entries) {
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const content = Array.isArray(e.message.content) ? e.message.content : [];
		const text = content.filter(c => c?.type === "text").map(c => c.text).join("\n").trim();
		if (text.length > 200) texts.push(`(${e.timestamp})\n${text}`);
	}
	return texts.slice(-count).join("\n\n=====\n\n").slice(-cap);
}

function orchestratorState(cwd: string): string[] {
	return Object.entries(loadState(cwd).workers)
		.filter(([, w]) => w.status === "running" || !patchDiscarded(w))
		.map(([id, w]) => (w.status === "running" ? `${id}: running - ${w.brief}` : `${id}: ${w.status}${w.patch && !w.applied ? `, patch NOT applied: ${w.patch}` : ""} - ${w.brief}`));
}

async function anthropicLimits(): Promise<string> {
	const r = await run(OMP_BIN, ["usage", "--json", "-p", "anthropic"], { timeout: 20_000 });
	if (!r.ok) return "quota: lookup failed";
	try {
		const reports: { provider?: string; limits?: Limit[] }[] | undefined = JSON.parse(r.out).reports;
		const limits = reports?.find(x => x.provider === "anthropic")?.limits ?? [];
		const show = (id: string, label: string) => {
			const l = limits.find(x => x.id === id);
			if (!l?.amount) return undefined;
			const reset = l.window?.resetsAt ? new Date(l.window.resetsAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
			return `${label} ${l.amount.remaining}% left (reset ${reset})`;
		};
		return `quota: ${[show("anthropic:5h", "5h"), show("anthropic:7d", "7d")].filter(Boolean).join(", ") || "no data"}`;
	} catch {
		return "quota: unreadable";
	}
}

/** What the session files of the last 7 days in `sessionDir` show about the guard: briefs it did not process, parallel writers without isolation, task-result and merge-summary formats it no longer parses. `t` picks the language of each line (English by default). */
export function guardHealth(sessionDir: string, t: (text: NoticeText) => string = text => text.en): { problems: string[]; info: string } {
	const counts = { items: 0, marked: 0, writers: 0, isolated: 0, results: 0, parsed: 0, patchMentions: 0, patchParsed: 0 };
	let files: string[] = [];
	try {
		files = readdirSync(sessionDir).filter(f => f.endsWith(".jsonl")).map(f => join(sessionDir, f)).filter(f => statSync(f).mtimeMs >= Date.now() - GUARD_WINDOW_MS);
	} catch {
		files = [];
	}
	for (const file of files) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.includes('"name":"task"') && !line.includes("task-result")) continue;
			let entry: LogEntry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const content = entry.message?.content;
			const blocks: TextBlock[] = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
			for (const block of blocks) {
				if (block?.type === "toolCall" && block.name === "task" && entry.message?.role === "assistant") {
					const items = block.arguments?.tasks ?? [];
					const writers = items.filter(item => WRITING_AGENTS.has(String(item?.agent ?? "task")));
					counts.items += items.length;
					counts.marked += items.filter(item => String(item?.task ?? "").includes(GUARD_MARKER)).length;
					// A lone writer runs in place by design; only writers of a parallel call (two or more) must be isolated.
					if (writers.length > 1) {
						counts.writers += writers.length;
						counts.isolated += writers.filter(item => item?.isolated === true).length;
					}
				}
				const text = typeof block?.text === "string" ? block.text : "";
				if (!text.includes("<task-result") || entry.message?.role !== "toolResult" || !RESULT_TOOLS.has(String(entry.message.toolName))) continue;
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
	if (counts.marked < counts.items) problems.push(t({ en: `orchestrator-guard did not process ${counts.items - counts.marked} of ${counts.items} worker briefs (extension not loaded, or omp changed how tool input revisions are stored)`, ko: `orchestrator-guard가 워커 지시문 ${counts.items}개 중 ${counts.items - counts.marked}개를 처리하지 못했습니다(확장이 안 실렸거나 omp의 도구 입력 저장 방식이 바뀜)` }));
	if (counts.isolated < counts.writers) problems.push(t({ en: `${counts.writers - counts.isolated} of ${counts.writers} parallel writing workers ran without isolation (they edited the real checkout side by side)`, ko: `병렬 쓰기 워커 ${counts.writers}개 중 ${counts.writers - counts.isolated}개가 격리 없이 돌았습니다(실제 체크아웃을 나란히 고침)` }));
	if (counts.parsed < counts.results) problems.push(t({ en: `omp task-result format changed: the guard parses ${counts.parsed} of ${counts.results} results, so output trimming and worker state tracking are partly off`, ko: `omp task-result 형식이 바뀌었습니다: 가드가 결과 ${counts.results}개 중 ${counts.parsed}개만 읽어 출력 줄이기와 워커 상태 추적이 일부 꺼졌습니다` }));
	if (counts.patchParsed < counts.patchMentions) problems.push(t({ en: `omp merge-summary format changed: ${counts.patchMentions - counts.patchParsed} patch paths are not recognised, so unapplied patches are not tracked`, ko: `omp merge-summary 형식이 바뀌었습니다: 패치 경로 ${counts.patchMentions - counts.patchParsed}개를 알아보지 못해 미적용 패치를 추적하지 못합니다` }));
	return { problems, info: t({ en: `guard: ${counts.items} briefs, ${counts.results} results, ${counts.patchMentions} patches checked in ${files.length} session file(s) from the last 7 days`, ko: `가드: 최근 7일 세션 파일 ${files.length}개에서 지시문 ${counts.items}개, 결과 ${counts.results}개, 패치 ${counts.patchMentions}개를 확인했습니다` }) };
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
		let entries: import("node:fs").Dirent[] = [];
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
	walk(SESSIONS, 2);
	return out;
}

function lastRateLimit(entries: LogEntry[]): string | undefined {
	const last = entries.filter(e => e.type === "message" && e.message?.role === "assistant").at(-1);
	const msg = String(last?.message?.errorMessage ?? "");
	if (last?.message?.stopReason !== "error" || !/429|rate_limit|usage limit|overloaded/i.test(msg)) return undefined;
	const retry = Number(msg.match(/retry-after-ms:\s*(\d+)/)?.[1] ?? 0);
	const at = retry ? new Date(Date.parse(last?.timestamp ?? "") + retry).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "unknown";
	return `last turn ended on a rate limit (${msg.slice(0, 80)}); retry after ${at}`;
}

async function tokenAuditReport(hours: number, ifDue = false, language: NoticeLanguage = "en"): Promise<{ text: string; flags: number; ok: boolean; skipped: boolean }> {
	const t = (n: NoticeText) => n[language];
	if (isHostCopy()) return { text: t({ en: "token-audit is not available in a host copy: it reads the owner's omp sessions.", ko: "token-audit은 호스트 복사본에서 사용할 수 없습니다: 소유자의 omp 세션을 읽기 때문입니다." }), flags: 0, ok: false, skipped: false };
	const r = await run(BUN, [AUDIT_SCRIPT, "--hours", String(hours), "--lang", language, ...(ifDue ? ["--if-due"] : [])], { timeout: 120_000 });
	const lines = r.out.trim().split("\n");
	const result = lines.find(l => l.startsWith("RESULT "));
	if (!r.ok || !result) return { text: t({ en: `token-audit failed: ${r.out.trim().slice(-300)}`, ko: `token-audit이 실패했습니다: ${r.out.trim().slice(-300)}` }), flags: 0, ok: false, skipped: false };
	const parsed: { flags?: number; skipped?: boolean } = JSON.parse(result.slice(7));
	return { text: lines.filter(l => !l.startsWith("RESULT ")).join("\n"), flags: parsed.flags ?? 0, ok: true, skipped: parsed.skipped === true };
}

async function doctorReport(ctx: Ctx, fix: boolean, display = false): Promise<{ text: string; problems: number }> {
	const t = (n: NoticeText) => (display ? say(n) : n.en);
	const file: string | undefined = ctx.sessionManager?.getSessionFile?.();
	const entries = file ? readTail(file, 400_000) : [];
	const usage = ctx.getContextUsage?.();
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "?";
	const setup = setupStatus(LOADED_SETUP, readSetupVersion(), t);
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
	info.push(`${t({ en: "context", ko: "컨텍스트" })}: ${usage ? `${Math.round(usage.tokens / 1000)}K / ${Math.round(usage.contextWindow / 1000)}K (${usage.percent?.toFixed?.(1) ?? "?"}%)` : "?"}`);
	const fileSize = file && existsSync(file) ? statSync(file).size : 0;
	info.push(`${t({ en: "session file", ko: "세션 파일" })}: ${fileSize ? `${(fileSize / 1e6).toFixed(1)}MB` : t({ en: "none (ephemeral)", ko: "없음 (임시 세션)" })}`);
	if (fileSize > ROTATE_BYTES) problems.push(t({ en: `session file ${Math.round(fileSize / 1e6)}MB > 50MB: compaction never shrinks it; the user should run /handover for a fresh session`, ko: `세션 파일이 ${Math.round(fileSize / 1e6)}MB로 50MB를 넘습니다: 압축으로는 줄지 않으니 /handover로 새 세션을 여세요` }));
	info.push(`${t({ en: "model", ko: "모델" })}: ${model}${defaultRole ? ` (${t({ en: "default role", ko: "기본 역할" })} ${defaultRole})` : ""}`);
	if (defaultRole && !defaultRole.startsWith(model)) problems.push(t({ en: `model differs from the default role (${defaultRole}); if this is a fallback, switch back with /compact-switch ${defaultRole}`, ko: `모델이 기본 역할(${defaultRole})과 다릅니다. 대체 모델로 바뀐 것이면 /compact-switch ${defaultRole}로 되돌리세요` }));
	if (setup.info) info.push(setup.info);
	if (setup.problem) problems.push(setup.problem);
	const rl = lastRateLimit(entries);
	if (rl) problems.push(rl);
	info.push(quota);
	const open = orchestratorState(String(ctx.cwd ?? process.cwd()));
	if (open.length) problems.push(`${t({ en: "open workers/patches", ko: "열린 워커/패치" })}:\n    ${open.join("\n    ")}`);
	if (file) {
		const health = guardHealth(dirname(file), t);
		problems.push(...health.problems);
		info.push(health.info);
	}
	if (isHostCopy())
		info.push(
			t({
				en: "large session check skipped: the harness runs from a host copy and does not read the owner's omp sessions",
				ko: "큰 세션 검사를 건너뜁니다: 하네스가 호스트 복사본에서 실행되어 소유자의 omp 세션을 읽지 않습니다",
			}),
		);
	else for (const big of bigSessions()) if (!file || !big.startsWith(file.replace(HOME, "~"))) info.push(`${t({ en: "large session file", ko: "큰 세션 파일" })}: ${big}`);
	if (orphanList.length) {
		const list = orphanList.map(o => `${o.pid} (${o.age}) ${o.command}`).join("\n    ");
		if (fix) {
			await run("kill", orphanList.map(o => String(o.pid)));
			const left = await orphans();
			info.push(`${t({ en: "orphaned omp RPC processes killed", ko: "종료한 고아 omp RPC 프로세스" })}: ${orphanList.length - left.length}/${orphanList.length}`);
		} else problems.push(t({ en: `orphaned omp RPC processes (ppid 1, >${ORPHAN_MIN_AGE_MIN} min); run doctor with fix to kill them:\n    ${list}`, ko: `고아 omp RPC 프로세스가 있습니다(ppid 1, ${ORPHAN_MIN_AGE_MIN}분 넘음). /doctor fix로 종료하세요:\n    ${list}` }));
	}
	return {
		text: [`doctor: ${problems.length ? t({ en: `${problems.length} issue(s)`, ko: `문제 ${problems.length}건` }) : t({ en: "healthy", ko: "정상" })}`, ...problems.map(p => `- ${p}`), ...info.map(i => `  ${i}`)].join("\n"),
		problems: problems.length,
	};
}

/**
 * Registers the harness-management commands:
 * `/token-audit [hours]` runs the token-leak audit over omp sessions (report only; harness/token-audit.ts of this copy); a new main session also runs the 24h audit in the background at most once per 20 h and notifies only when it has warnings,
 * `/doctor [fix]` reports session health (context, session file size, model/fallback, last 429, quota, open workers and patches, orchestrator-guard health over this project's last 7 days of sessions, orphaned omp RPC processes; `fix` kills the orphans),
 * `/handover [note]` starts a fresh session with a handover (recent reports, git status, open worker state).
 * The orchestrator can run the first two itself through the harness_doctor and harness_token_audit tools.
 * When the omp version changed since the last main session, the guard health check runs once and reports problems.
 */
export default function harnessTools(pi: Api) {
	const z = pi.zod;
	pi.setLabel?.("Harness tools");

	pi.on("session_start", async (_event, ctx) => {
		if (ctx?.agent?.kind !== "main") return;
		if (!isHostCopy())
			void tokenAuditReport(24, true, noticeLanguage()).then(report => {
				if (report.ok && !report.skipped && report.flags) ctx.ui?.notify?.(report.text, "warning");
			});
		const version = (await run(OMP_BIN, ["--version"])).out.trim();
		let previous = "";
		try {
			previous = readFileSync(VERSION_FILE, "utf8").trim();
		} catch {
			previous = "";
		}
		if (!version || version === previous) return;
		mkdirSync(dirname(VERSION_FILE), { recursive: true });
		writeFileSync(VERSION_FILE, `${version}\n`);
		if (!previous) return;
		const file: string | undefined = ctx.sessionManager?.getSessionFile?.();
		const health = file ? guardHealth(dirname(file), say) : { problems: [], info: say({ en: "guard: no session history to check", ko: "가드: 확인할 세션 기록이 없습니다" }) };
		ctx.ui?.notify?.(
			[
				say({ en: `harness-tools: omp updated ${previous} -> ${version}.`, ko: `harness-tools: omp가 ${previous} -> ${version}(으)로 업데이트되었습니다.` }),
				...(health.problems.length ? health.problems.map(p => `- ${p}`) : [say({ en: "guard health OK.", ko: "가드 상태 정상입니다." })]),
				`  ${health.info}`,
			].join("\n"),
			health.problems.length ? "warning" : "info",
		);
	});

	pi.registerCommand("token-audit", {
		description: "Token-leak audit over omp sessions (report only): /token-audit [hours, default 24]",
		handler: async (args, ctx) => {
			const hours = Number(String(args ?? "").trim()) || 24;
			if (isHostCopy())
				return ctx.ui.notify(
					say({ en: "token-audit is not available in a host copy: it reads the owner's omp sessions.", ko: "token-audit은 호스트 복사본에서 사용할 수 없습니다: 소유자의 omp 세션을 읽기 때문입니다." }),
					"error",
				);
			ctx.ui.notify(say({ en: `token-audit: scanning the last ${hours}h...`, ko: `token-audit: 최근 ${hours}시간을 검사하는 중입니다...` }), "info");
			const report = await tokenAuditReport(hours, false, noticeLanguage());
			ctx.ui.notify(report.text, !report.ok ? "error" : report.flags ? "warning" : "info");
		},
	});

	pi.registerTool({
		name: "harness_token_audit",
		label: "Token audit",
		description: "Token-leak audit over this machine's omp sessions (report only, no LLM calls): unexplained cache busts, idle wakes, error streaks, oversized context, Fable/fallback use, repeated calls, big workers, spikes. Use when the user asks to check token usage, leaks or costs.",
		parameters: z.object({ hours: z.number().optional() }),
		async execute(_id: string, params: { hours?: number } | undefined) {
			const report = await tokenAuditReport(Number(params?.hours) || 24);
			return { content: [{ type: "text", text: report.text }], details: { flags: report.flags, ok: report.ok } };
		},
	});

	pi.registerTool({
		name: "harness_doctor",
		label: "Harness doctor",
		description: "Health check of this omp session and harness: context, session file size, model vs default role, last rate limit, quota, open workers and unapplied patches, orchestrator-guard health, orphaned omp RPC processes. Use when the user asks to check or inspect the setup. fix=true also kills the orphaned processes.",
		parameters: z.object({ fix: z.boolean().optional() }),
		async execute(_id: string, params: { fix?: boolean } | undefined, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const report = await doctorReport(ctx, params?.fix === true);
			return { content: [{ type: "text", text: report.text }], details: { problems: report.problems } };
		},
	});

	pi.registerCommand("doctor", {
		description: "Session/harness health check: /doctor [fix]  (fix = kill orphaned omp RPC processes)",
		handler: async (args, ctx) => {
			const report = await doctorReport(ctx, String(args ?? "").trim() === "fix", true);
			ctx.ui.notify(report.text, report.problems ? "warning" : "info");
		},
	});

	pi.registerCommand("handover", {
		description: "Start a fresh session with a handover (recent reports, git status, open workers): /handover [note]",
		handler: async (args, ctx) => {
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
				"Commit, push and external sends follow the usual rules (ask first).",
				"",
				"--- recent reports from the previous session ---",
				recent || "(none)",
				...(status ? ["", "--- git status --short ---", status] : []),
				...(open.length ? ["", "--- open workers / unapplied patches ---", ...open] : []),
			].join("\n");
			const result = await ctx.newSession(file ? { parentSession: file } : undefined);
			if (result?.cancelled) return ctx.ui.notify(say({ en: "handover: new session was cancelled", ko: "handover: 새 세션 시작이 취소되었습니다" }), "warning");
			pi.sendUserMessage(handover);
		},
	});
}
