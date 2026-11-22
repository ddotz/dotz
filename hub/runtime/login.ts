import type { RuntimeId } from "./types.ts";

export type LoginState = { checked: boolean; ready: boolean; accounts: number };

const UNCHECKED: LoginState = { checked: false, ready: false, accounts: 0 };
const CHECK_TIMEOUT_MS = 20_000;

/** Parses `omo auth check --json`: an account pool with at least one account counts as signed in. */
export function parseOmoAuth(out: string): LoginState {
	try {
		const j = JSON.parse(out.trim().split("\n").filter(l => l.startsWith("{")).pop() ?? "");
		const accounts = Array.isArray(j.accounts) ? j.accounts.length : 0;
		return { checked: true, ready: j.status === "ready" || accounts > 0, accounts };
	} catch {
		return UNCHECKED;
	}
}

export function parseClaudeAuth(out: string): LoginState {
	try {
		const j = JSON.parse(out.slice(out.indexOf("{")));
		return { checked: true, ready: j.loggedIn === true, accounts: j.loggedIn === true ? 1 : 0 };
	} catch {
		return UNCHECKED;
	}
}

/** Parses `omp auth export` ({"version":1,"credentials":[...]}): a store with at least one credential counts as signed in. */
export function parseOmpAuth(out: string): LoginState {
	try {
		const j = JSON.parse(out.slice(out.indexOf("{")));
		const accounts = Array.isArray(j.credentials) ? j.credentials.length : 0;
		return { checked: true, ready: accounts > 0, accounts };
	} catch {
		return UNCHECKED;
	}
}

const CHECKS: Partial<Record<RuntimeId, { args: string[]; parse: (out: string) => LoginState; stderr: boolean }>> = {
	omo: { args: ["auth", "check", "--provider", "anthropic-subscription", "--json", "--no-refresh"], parse: parseOmoAuth, stderr: true },
	claude: { args: ["auth", "status"], parse: parseClaudeAuth, stderr: true },
	omp: { args: ["auth", "export"], parse: parseOmpAuth, stderr: false },
};

/** The login state of a runtime whose CLI is at `path`; never throws (a missing CLI, a runtime without a check or a failed run is unchecked). */
export async function loginOf(id: RuntimeId, path: string | undefined): Promise<LoginState> {
	const check = CHECKS[id];
	if (!check || !path) return UNCHECKED;
	try {
		const p = Bun.spawn([path, ...check.args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS, killSignal: "SIGKILL" });
		const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
		return check.parse(check.stderr ? out + err : out);
	} catch {
		return UNCHECKED;
	}
}

/** The command line that signs the runtime in, to run in a terminal. OmO has no login command: `omo` opens its terminal UI, where /login does it. */
export function loginCommand(id: RuntimeId): string {
	switch (id) {
		case "omp":
			return "omp login";
		case "claude":
			return "claude auth login";
		case "omo":
			return "omo";
		default:
			return "";
	}
}
