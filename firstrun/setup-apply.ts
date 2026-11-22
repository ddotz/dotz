import { ACCESS_MODES, type Answers, CONNECT_KEYS, priorOf } from "./answers.ts";
import { validateWithModels } from "./models.ts";
import { linkOmp, serveTailnet, type Env, writeConfig, writeSecrets } from "./apply.ts";
import { harness } from "../onboard/harness.ts";
import { requestPermissions } from "../onboard/permissions.ts";
import { realHost, realUiBlocked } from "../onboard/selfserve.ts";
import { readFirstRun } from "./first-run.ts";
import { fill, type JobIO } from "./setup-jobs.ts";

// "저장하고 적용": everything setup.ts does after the answers, run from the draft. The secrets were written to secrets/ when they were entered,
// so the draft never held them; what is left here is the shared firstrun/apply.ts code with its lines going to the scrubbed stream.

export type ApplyDeps = { dir: string; home: string; pkg: string; permissionsDone: () => boolean; installed: (runtime: string) => Promise<boolean> };
export type ApplyOutcome = { ok: true; access: "local" | "tailscale"; url: string; why: string; owner: string; connect: string[] } | { ok: false; error: string };

const MAC = process.platform === "darwin";
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const present = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined)) as Partial<T>;

/** The draft of the wizard as answers; what the owner left empty takes the earlier run's value or the default (firstrun/answers.ts). */
export function draftAnswers(draft: Record<string, unknown>): Partial<Answers> {
	const identity = present({ name: str(draft.name), character: str(draft.character), tone: str(draft.tone), notices: str(draft.notices), address: str(draft.address), avatar: str(draft.avatar), language: str(draft.lang) });
	const access = ACCESS_MODES.find(m => m === draft.access);
	const asked: unknown[] = Array.isArray(draft.connect) ? draft.connect : [];
	return {
		...present({ runtime: str(draft.runtime), machine_name: str(draft.machine_name), orchestrator_model: str(draft.orchestrator_model), lane_model: str(draft.lane_model), cloudflare_hostname: access === "cloudflare" ? str(draft.cloudflare_hostname) : "" }),
		identity: identity as Answers["identity"],
		...(access ? { access } : {}),
		...(Array.isArray(draft.connect) ? { connect: CONNECT_KEYS.filter(k => asked.includes(k)) } : {}),
		...(Array.isArray(draft.allow_logins) ? { allow_logins: draft.allow_logins.map(str).filter(Boolean) } : {}),
		...(num(draft.web_port) ? { web_port: num(draft.web_port)! } : {}),
		...(num(draft.tailscale_https_port) ? { tailscale_https_port: num(draft.tailscale_https_port)! } : {}),
	};
}

export async function runApply(d: ApplyDeps, io: JobIO): Promise<ApplyOutcome> {
	const { text } = io;
	const env: Env = { dir: d.dir, home: d.home, pkg: d.pkg, say: io.line };
	const prior = priorOf(d.dir);
	const checked = await validateWithModels(draftAnswers(readFirstRun(d.dir)?.draft ?? {}), prior, d.home);
	if (!checked.ok) return { ok: false, error: checked.errors.join(", ") };
	const a = checked.answers;
	if (!(await d.installed(a.runtime))) return { ok: false, error: fill(text.owner.missing, harness(a.runtime)?.label ?? a.runtime) };

	io.line(text.steps.secrets);
	writeSecrets(env, a);
	if (a.runtime === "omp") io.line(`${a.orchestrator_model} / ${a.lane_model}`);
	const wantServe = a.access === "tailscale" && a.allow_logins.length > 0;
	if (wantServe) io.line(text.steps.tailnet);
	const serve = await serveTailnet(env, a, wantServe);
	const access = a.access === "tailscale" && serve.ok ? "tailscale" : "local";
	const why = a.access === "tailscale" && !a.allow_logins.length ? text.notes.noLogins : wantServe && !serve.ok ? fill(text.notes.stayLocal, serve.reason) : "";
	if (why) io.line(why);
	io.line(text.steps.config);
	writeConfig(env, a, prior, a.access === "cloudflare" ? undefined : access);
	if (await linkOmp(env)) io.line(text.steps.plugin);

	let owner = "";
	if (MAC && !realUiBlocked() && !d.permissionsDone()) {
		io.line(text.steps.permissions);
		const steps: string[] = [];
		const left = await requestPermissions(process.execPath, () => "", realHost, false, (line, ownerStep) => (ownerStep ? steps.push(line) : io.line(line)));
		if (left.length) owner = steps[0] ?? "";
	}
	io.line(text.steps.finish);
	const host = serve.tsNow?.host;
	const url = access === "tailscale" && host ? `https://${host}${a.tailscale_https_port === 443 ? "" : `:${a.tailscale_https_port}`}/` : `http://127.0.0.1:${a.web_port}/`;
	const connect: string[] = [...a.connect, ...(a.access === "cloudflare" ? ["web-access"] : [])];
	return { ok: true, access, url, why, owner, connect };
}
