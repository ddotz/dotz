import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "../../../..");
export const RUNS = join(REPO, ".omp/verify/runs");
export const OWNER_PORT = 7420;

export type Run = {
	runId: string;
	dir: string;
	data: string;
	home: string;
	port: number;
	url: string;
	pid: number;
	pgid: number;
	hubToken: string;
	loginCookie: string;
	commit: string;
	tree: "worktree" | "head";
	code: string;
	dirty: number;
	startedAt: string;
};

export const runDir = (runId: string): string => {
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId)) throw new Error(`bad run id ${JSON.stringify(runId)}`);
	return join(RUNS, runId);
};

export function readRun(runId: string): Run {
	const file = join(runDir(runId), "run.json");
	if (!existsSync(file)) throw new Error(`no run.json for run ${runId}: launch it first (bun .omp/skills/verify-dotz/scripts/launch.ts ${runId})`);
	const run = JSON.parse(readFileSync(file, "utf8")) as Run;
	if (run.port === OWNER_PORT) throw new Error(`run ${runId} names port ${OWNER_PORT}, the owner's gateway: refused`);
	return run;
}

export const ownerHeaders = (run: Run): Record<string, string> => ({ cookie: `dotz_local=${run.loginCookie}` });
export const tokenHeaders = (run: Run): Record<string, string> => ({ "x-dotz-token": run.hubToken, "content-type": "application/json" });

export async function call(run: Run, path: string, init: RequestInit & { as: "owner" | "agent" }): Promise<Response> {
	if (run.port === OWNER_PORT) throw new Error("refused: port 7420");
	const headers = { ...(init.as === "owner" ? ownerHeaders(run) : tokenHeaders(run)), ...(init.headers as Record<string, string> | undefined) };
	return fetch(`${run.url}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
}

export const sh = (argv: string[], cwd = REPO): string => {
	const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	return r.stdout.toString().trim();
};

export const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
