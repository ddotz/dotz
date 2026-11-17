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
	{
		id: "omp",
		label: "omp (oh-my-pi)",
		bin: process.env.DOTZ_OMP ?? "omp",
		adapter: true,
		install: ["bun", "add", "-g", "@oh-my-pi/pi-coding-agent"],
		installHint: "bun add -g @oh-my-pi/pi-coding-agent",
		loginHint: "터미널에서 omp login 을 실행해 로그인해요.",
	},
	{ id: "claude", label: "Claude Code", bin: process.env.DOTZ_CLAUDE ?? "claude", adapter: true, installHint: "curl -fsSL https://claude.ai/install.sh | bash", loginHint: "터미널에서 claude 를 실행하고 /login 으로 로그인해요." },
	{ id: "codex", label: "Codex", bin: process.env.DOTZ_CODEX ?? "codex", adapter: false, installHint: "dotz 는 아직 Codex 로 돌릴 수 없어요", loginHint: "" },
];

export const harness = (id: string) => HARNESSES.find(h => h.id === id);
const DEFAULT_HARNESS: HarnessId = "omo";

export type Detected = Harness & { found: DetectResult };

export async function detectHarnesses(): Promise<Detected[]> {
	return Promise.all(HARNESSES.map(async h => ({ ...h, found: await detectBinary(h.bin) })));
}

export async function harnessInstalled(id: string): Promise<boolean> {
	const h = harness(id);
	return h ? (await detectBinary(h.bin)).installed : false;
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
