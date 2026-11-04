import { asideState, installApp, installCli } from "../onboard/aside.ts";
import { lineRunner } from "../onboard/exec.ts";
import { detectHarnesses, harness } from "../onboard/harness.ts";
import { requestPermissions } from "../onboard/permissions.ts";
import { realHost, realUiBlocked } from "../onboard/selfserve.ts";
import { installTailscale, type Run, startTailscale, tailscaleState } from "../onboard/tailscale.ts";
import { scrubText } from "./onboarding.ts";
import type { Catalog } from "./i18n-en.ts";

// The long jobs of the web onboarding: a fixed server-side list (docs/web-onboarding.md "API 계약"), each one an existing onboard/ function run without
// a terminal. A line reaches the stream only through scrubText; the log (deps.log) gets step names and outcomes, never the lines.

export const JOB_IDS = ["install-omo", "aside-app", "aside-cli", "tailscale", "zele", "tailscale-start", "permissions", "apply"] as const;
export type JobId = (typeof JOB_IDS)[number];
export const isJobId = (s: string): s is JobId => (JOB_IDS as readonly string[]).includes(s);
export type SetupText = Catalog["setup"];
export type Row = { id: JobId; state: "idle" | "running" | "done" | "failed"; detail: string; owner: string };
export type JobIO = { line: (text: string) => void; run: Run; owner: (text: string) => void; text: SetupText };
export type JobResult = { ok: boolean; detail?: string; owner?: string };
export type JobFn = (io: JobIO) => Promise<JobResult>;

export const fill = (template: string, name: string): string => template.replaceAll("{name}", name);
const MAC = process.platform === "darwin";

// A fresh bun global bin folder is often not on PATH yet (bun add -g only warns about it).
async function bunGlobalOnPath(): Promise<void> {
	const globalBin = (await Bun.$`bun pm bin -g`.nothrow().quiet()).stdout.toString().trim();
	if (globalBin && !(process.env.PATH ?? "").split(":").includes(globalBin)) process.env.PATH = `${globalBin}:${process.env.PATH ?? ""}`;
}
const missing = (io: JobIO, what: string): JobResult => ({ ok: false, owner: fill(io.text.owner.missing, what) });
const sudo = (io: JobIO, cmd: string): JobResult => ({ ok: false, owner: fill(io.text.owner.sudo, cmd) });

export const DEFAULT_JOBS: Record<Exclude<JobId, "apply">, JobFn> = {
	"install-omo": async io => {
		const install = harness("omo")?.install;
		if (!install || !(await io.run(install))) return { ok: false, owner: fill(io.text.owner.sudo, "bun add -g --trust omo-ai") };
		await bunGlobalOnPath();
		return (await detectHarnesses()).some(d => d.id === "omo" && d.found.installed) ? { ok: true } : missing(io, "OmO");
	},
	"aside-app": async io => {
		if (!MAC) return { ok: true, detail: io.text.states.skipped };
		if (!Bun.which("brew")) return { ok: false, owner: `${io.text.owner.noBrew} ${io.text.owner.asideDownload}` };
		if (!(await installApp(io.run))) return sudo(io, "brew install --cask aside");
		return (await asideState()).app ? { ok: true } : missing(io, "Aside");
	},
	"aside-cli": async io => {
		if (!(await installCli(io.run))) return sudo(io, "curl -fsSL https://releases.aside.com/install.sh | bash");
		return (await asideState()).cli ? { ok: true } : missing(io, "Aside CLI");
	},
	tailscale: async io => {
		if (MAC && !Bun.which("brew")) return { ok: false, owner: `${io.text.owner.noBrew} ${io.text.owner.tailscaleDownload}` };
		if (!(await installTailscale(io.run))) return sudo(io, MAC ? "brew install --cask tailscale-app" : "curl -fsSL https://tailscale.com/install.sh | sh");
		return (await tailscaleState()).bin ? { ok: true } : missing(io, "Tailscale");
	},
	zele: async io => {
		if (!(await io.run(["bun", "add", "-g", "zele"]))) return sudo(io, "bun add -g zele");
		await bunGlobalOnPath();
		return Bun.which("zele") ? { ok: true } : missing(io, "zele");
	},
	"tailscale-start": async io => {
		const s = await tailscaleState();
		if (!s.bin) return { ok: false, owner: io.text.owner.tailscaleDownload };
		if (s.running) return { ok: true };
		if (!MAC) return { ok: false, owner: io.text.owner.tailscaleUp };
		await startTailscale(s.bin, io.run);
		return (await tailscaleState()).running ? { ok: true } : { ok: false, owner: io.text.owner.tailscaleLogin };
	},
	permissions: async io => {
		if (!MAC || realUiBlocked()) return { ok: true, detail: io.text.states.skipped };
		const owner: string[] = [];
		const left = await requestPermissions(process.execPath, () => "", realHost, false, (line, ownerStep) => (ownerStep ? owner.push(line) : io.line(line)));
		return left.length ? { ok: false, owner: owner[0] } : { ok: true };
	},
};

type JobsDeps = { text: () => SetupText; secrets: () => string[]; log: (line: string) => void; jobs?: Partial<Record<JobId, JobFn>> };
export type SetupEvent = { type: "line"; job: JobId; text: string } | { type: "state"; row: Row };

/** Rows and listeners of the running jobs. One job of an id at a time; a second request while it runs gets the first one's result. */
export function createJobs(deps: JobsDeps) {
	const rows = new Map<JobId, Row>(JOB_IDS.map(id => [id, { id, state: "idle", detail: "", owner: "" }]));
	const running = new Map<JobId, Promise<Row>>();
	const listeners = new Set<(e: SetupEvent) => void>();
	const emit = (e: SetupEvent) => listeners.forEach(fn => fn(e));
	const set = (id: JobId, patch: Partial<Row>): Row => {
		const row = { ...rows.get(id)!, ...patch };
		rows.set(id, row);
		emit({ type: "state", row });
		return row;
	};
	const scrub = (text: string): string => scrubText(text, deps.secrets());

	function start(id: JobId, fn: JobFn | undefined = deps.jobs?.[id] ?? DEFAULT_JOBS[id as Exclude<JobId, "apply">]): Promise<Row> {
		const live = running.get(id);
		if (live) return live;
		const text = deps.text();
		set(id, { state: "running", detail: text.states.running, owner: "" });
		deps.log(`setup: ${id} started`);
		const line = (t: string): void => {
			const clean = scrub(t);
			if (clean) emit({ type: "line", job: id, text: clean });
		};
		const io: JobIO = { line, run: lineRunner(line), owner: t => void set(id, { owner: scrub(t) }), text };
		const job = fn!(io)
			.catch((error): JobResult => ({ ok: false, detail: scrub(error), owner: "" }))
			.then(r => {
				deps.log(`setup: ${id} ${r.ok ? "done" : "failed"}`);
				return set(id, { state: r.ok ? "done" : "failed", detail: scrub(r.detail ?? (r.ok ? text.states.done : text.states.failed)), owner: scrub(r.owner ?? "") });
			})
			.finally(() => void running.delete(id));
		running.set(id, job);
		return job;
	}

	return {
		start,
		snapshot: (): Row[] => [...rows.values()],
		subscribe(fn: (e: SetupEvent) => void): () => void {
			listeners.add(fn);
			return () => void listeners.delete(fn);
		},
		busy: (): boolean => running.size > 0,
	};
}
export type Jobs = ReturnType<typeof createJobs>;
