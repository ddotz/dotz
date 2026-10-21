// Throwaway dotz sessions (tests, runtime probes, a copy of the orchestrator someone started by hand) must not reach the
// owner's real Discord or write the live state: on 2026-10-20 such a copy posted a second [done] to 작업로그 and wrote a
// made-up entry into state.json. Pure helpers, shared by the gateway (hub/discord.ts: a gateway on a temp data dir does
// not connect) and the dotz extension (its gateway calls go to a dry-run sink and its writes into the live data dir are
// refused). DOTZ_ALLOW_LIVE=1 lets a deliberate end-to-end run through.
import { appendFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const TEMP_PATH = /^\/(private\/)?(tmp|var\/folders)\//;
const isTempPath = (p: string): boolean => TEMP_PATH.test(resolve(p) + "/") || resolve(p).startsWith(resolve(tmpdir()) + "/");
const allowLive = (env: Record<string, string | undefined> = process.env): boolean => env.DOTZ_ALLOW_LIVE === "1";
const dryRunFile = (): string => join(tmpdir(), "dotz-dry-run.jsonl");

// Why a gateway on this data dir runs without Discord, or undefined for a live one.
export function gatewayDryRun(dataDir: string, env: Record<string, string | undefined> = process.env): string | undefined {
	if (allowLive(env)) return undefined;
	if (env.DOTZ_DRY_RUN === "1") return "DOTZ_DRY_RUN=1";
	if (isTempPath(dataDir)) return `temp data dir ${dataDir}`;
	return undefined;
}

export const hubPid = (dataDir: string): number | undefined => {
	try {
		const n = Number(readFileSync(join(dataDir, "hub.pid"), "utf8").trim());
		return n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
};

// Why this extension process is a throwaway, or undefined for the owner's live orchestrator or lane. The gateway starts
// those itself (the process's parent is the pid in hub.pid); an orchestrator or lane process with another parent is a
// copy. A terminal session (neither role) is the owner's own and is never treated as one.
export function throwawayReason(o: { env?: Record<string, string | undefined>; ppid?: number; hubPid?: number } = {}): string | undefined {
	const env = o.env ?? process.env;
	if (allowLive(env)) return undefined;
	if (env.DOTZ_DRY_RUN === "1") return "DOTZ_DRY_RUN=1";
	if (env.DOTZ_LANE === "probe") return "a runtime probe";
	const role = env.DOTZ_ORCHESTRATOR === "1" ? "orchestrator" : env.DOTZ_LANE ? `lane ${env.DOTZ_LANE}` : undefined;
	if (!role) return undefined;
	const ppid = o.ppid ?? process.ppid;
	if (o.hubPid === undefined) return `a ${role} process with no live gateway (no hub.pid)`;
	if (ppid !== o.hubPid) return `a ${role} process the live gateway did not start (parent ${ppid}, gateway ${o.hubPid})`;
	return undefined;
}

// The live data dir a throwaway must not write: the default ~/.dotz, or DOTZ_DIR unless that is a temp one.
export const liveDataDir = (dataDir: string): string | undefined => (isTempPath(dataDir) ? undefined : resolve(dataDir));
export const defaultDataDir = (): string => join(homedir(), ".dotz");

// A write/edit into the live data dir, or a shell command that names it and writes (redirect, tee, sed -i, mv, cp, rm).
export function liveWrite(event: any, liveDirs: string[]): string | undefined {
	const tool = String(event?.toolName ?? "");
	const input = event?.input ?? {};
	const dirs = liveDirs.map(d => resolve(d));
	const under = (p: string) => dirs.find(d => resolve(p.replace(/^~(?=\/)/, homedir())) === d || resolve(p.replace(/^~(?=\/)/, homedir())).startsWith(`${d}/`));
	if (tool === "write" || tool === "edit") {
		const p = String(input.path ?? input.file_path ?? "");
		const d = p && under(p);
		return d ? `${tool} ${p} (inside the live data dir ${d})` : undefined;
	}
	if (tool !== "bash" && tool !== "eval") return undefined;
	const text = String(input.command ?? input.code ?? "");
	const named = dirs.find(d => text.includes(d) || (d === resolve(defaultDataDir()) && /~\/\.dotz\b|\$HOME\/\.dotz\b/.test(text)));
	if (!named || !/(>>?|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|writeFile|appendFile)/.test(text)) return undefined;
	return `a ${tool} command that writes into the live data dir ${named}`;
}

// What a throwaway's gateway call does instead: one line in the dry-run sink, and an answer saying nothing was sent.
export function dryRun(path: string, init: { method?: string; body?: unknown }, reason: string, file = dryRunFile()): Record<string, unknown> {
	appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), reason, method: init.method ?? "GET", path, body: typeof init.body === "string" ? init.body.slice(0, 2000) : undefined })}\n`);
	const why = `dry run: ${reason}; nothing was sent or changed (logged to ${file}). Set DOTZ_ALLOW_LIVE=1 for a deliberate live run.`;
	return { ok: false, delivered: false, dryRun: true, reason: why, error: why };
}
