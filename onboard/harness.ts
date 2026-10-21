// The agent harness step of onboarding: which coding-agent CLI runs the orchestrator and the lanes. OmO is the default
// (hub/runtime/index.ts); omp and Claude Code have adapters too; Codex is detected but has no adapter yet, so it is listed
// and cannot be picked. Detection is one `<bin> --version` run each (hub/runtime/detect.ts). The login check never asks
// for credentials: `omo auth check` without --credentials and `claude auth status` print readiness and account names only.
import { detectBinary } from "../hub/runtime/detect.ts";
import type { DetectResult } from "../hub/runtime/types.ts";

type HarnessId = "omo" | "omp" | "claude" | "codex";
export type Harness = {
	id: HarnessId;
	label: string;
	bin: string;
	adapter: boolean;
	/** Command setup may run to install it (only OmO, the default, is installed by setup). */
	install?: string[];
	installHint: string;
	loginHint: string;
};

export const HARNESSES: Harness[] = [
	{
		id: "omo",
		label: "OmO (oh-my-openagent)",
		bin: process.env.DOTZ_OMO ?? "omo",
		adapter: true,
		install: ["bun", "add", "-g", "--trust", "omo-ai"],
		installHint: "bun add -g --trust omo-ai",
		loginHint: "터미널에서 omo 를 실행하고 /login 으로 Claude 구독 계정에 로그인해요. 계정을 더 붙이려면 /login 을 한 번 더 하면 계정 풀에 들어가요.",
	},
	{ id: "omp", label: "omp (oh-my-pi)", bin: "omp", adapter: true, installHint: "omp 를 먼저 설치해 주세요 (omp 문서의 설치 방법)", loginHint: "터미널에서 omp 를 실행하고 /login 으로 로그인해요." },
	{ id: "claude", label: "Claude Code", bin: process.env.DOTZ_CLAUDE ?? "claude", adapter: true, installHint: "curl -fsSL https://claude.ai/install.sh | bash", loginHint: "터미널에서 claude 를 실행하고 /login 으로 로그인해요." },
	{ id: "codex", label: "Codex", bin: process.env.DOTZ_CODEX ?? "codex", adapter: false, installHint: "dotz 는 아직 Codex 로 돌릴 수 없어요", loginHint: "" },
];

export const harness = (id: string) => HARNESSES.find(h => h.id === id);
const DEFAULT_HARNESS: HarnessId = "omo";

export type Detected = Harness & { found: DetectResult };

export async function detectHarnesses(): Promise<Detected[]> {
	return Promise.all(HARNESSES.map(async h => ({ ...h, found: await detectBinary(h.bin) })));
}

/** The harness the wizard offers as Enter: the one config.json already names (when dotz can run it), else OmO. */
export function defaultHarness(prior: string | undefined): HarnessId {
	const h = prior ? harness(prior) : undefined;
	return h?.adapter ? h.id : DEFAULT_HARNESS;
}

export function harnessLine(d: Detected, isDefault: boolean): string {
	const state = d.found.installed ? `설치됨${d.found.version ? ` ${d.found.version}` : ""}` : "설치 안 됨";
	const note = !d.adapter ? " (dotz 어댑터가 아직 없어서 고를 수 없어요)" : "";
	return `${d.label}  ${state}${note}${isDefault ? "  [기본]" : ""}`;
}

type LoginState = { checked: boolean; ready: boolean; accounts: number };

/** Parses `omo auth check --json`: an account pool with at least one account counts as signed in. */
export function parseOmoAuth(out: string): LoginState {
	try {
		const j = JSON.parse(out.trim().split("\n").filter(l => l.startsWith("{")).pop() ?? "");
		const accounts = Array.isArray(j.accounts) ? j.accounts.length : 0;
		return { checked: true, ready: j.status === "ready" || accounts > 0, accounts };
	} catch {
		return { checked: false, ready: false, accounts: 0 };
	}
}

export function parseClaudeAuth(out: string): LoginState {
	try {
		const j = JSON.parse(out.slice(out.indexOf("{")));
		return { checked: true, ready: j.loggedIn === true, accounts: j.loggedIn === true ? 1 : 0 };
	} catch {
		return { checked: false, ready: false, accounts: 0 };
	}
}

export async function loginState(d: Detected): Promise<LoginState> {
	if (!d.found.installed || !d.found.path) return { checked: false, ready: false, accounts: 0 };
	const run = async (args: string[]) => {
		const p = Bun.spawn([d.found.path!, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL" });
		return (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
	};
	if (d.id === "omo") return parseOmoAuth(await run(["auth", "check", "--provider", "anthropic-subscription", "--json", "--no-refresh"]));
	if (d.id === "claude") return parseClaudeAuth(await run(["auth", "status"]));
	return { checked: false, ready: false, accounts: 0 };
}
