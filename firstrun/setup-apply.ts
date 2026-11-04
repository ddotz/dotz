import { type Answers, priorOf, validateAnswers } from "./answers.ts";
import { linkOmp, serveTailnet, setupDiscord, type Env, writeConfig, writeSecrets } from "./apply.ts";
import { requestPermissions } from "../onboard/permissions.ts";
import { realHost, realUiBlocked } from "../onboard/selfserve.ts";
import { readFirstRun } from "./first-run.ts";
import { fill, type JobIO } from "./setup-jobs.ts";

// "저장하고 적용": everything setup.ts does after the answers, run from the draft. The secrets were written to secrets/ when they were entered,
// so the draft never held them; what is left here is the shared firstrun/apply.ts code with its lines going to the scrubbed stream.

export type ApplyDeps = { dir: string; home: string; pkg: string; permissionsDone: () => boolean };
export type ApplyOutcome = { ok: true; access: "local" | "tailscale"; url: string; why: string; owner: string } | { ok: false; error: string };

const MAC = process.platform === "darwin";
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const present = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined)) as Partial<T>;

/** The draft of the wizard as answers; what the owner left empty takes the earlier run's value or the default (firstrun/answers.ts). */
export function draftAnswers(draft: Record<string, unknown>): Partial<Answers> {
	const identity = present({ name: str(draft.name), character: str(draft.character), tone: str(draft.tone), notices: str(draft.notices), address: str(draft.address), avatar: str(draft.avatar), language: str(draft.lang) });
	return {
		...present({ runtime: str(draft.runtime), guild: str(draft.guild), owner_id: str(draft.owner_id), machine_name: str(draft.machine_name), orchestrator_model: str(draft.orchestrator_model), lane_model: str(draft.lane_model) }),
		identity: identity as Answers["identity"],
		...(Array.isArray(draft.allow_logins) ? { allow_logins: draft.allow_logins.map(str).filter(Boolean) } : {}),
		...(num(draft.web_port) ? { web_port: num(draft.web_port)! } : {}),
		...(num(draft.tailscale_https_port) ? { tailscale_https_port: num(draft.tailscale_https_port)! } : {}),
	};
}

export async function runApply(d: ApplyDeps, io: JobIO): Promise<ApplyOutcome> {
	const { text } = io;
	const env: Env = { dir: d.dir, home: d.home, pkg: d.pkg, say: io.line };
	const prior = priorOf(d.dir);
	const checked = validateAnswers(draftAnswers(readFirstRun(d.dir)?.draft ?? {}), prior, d.home);
	if (!checked.ok) return { ok: false, error: checked.errors.join(", ") };
	const a = checked.answers;

	io.line(text.steps.secrets);
	writeSecrets(env, a);
	const wantServe = a.allow_logins.length > 0;
	if (wantServe) io.line(text.steps.tailnet);
	const serve = await serveTailnet(env, a, wantServe);
	const access = serve.ok ? "tailscale" : "local";
	const why = wantServe && !serve.ok ? fill(text.notes.stayLocal, serve.reason) : "";
	if (why) io.line(why);
	io.line(text.steps.config);
	const config = writeConfig(env, a, prior, access);
	if (await linkOmp(env)) io.line(text.steps.plugin);

	let owner = "";
	if (MAC && !realUiBlocked() && !d.permissionsDone()) {
		io.line(text.steps.permissions);
		const steps: string[] = [];
		const left = await requestPermissions(process.execPath, () => "", realHost, false, (line, ownerStep) => (ownerStep ? steps.push(line) : io.line(line)));
		if (left.length) owner = steps[0] ?? "";
	}
	if (a.guild) {
		io.line(text.steps.discord);
		await setupDiscord(env, { a, config, prior, auto: Boolean(Bun.which("aside")), ownerStep: () => io.owner(text.owner.discord2fa) });
	}
	io.line(text.steps.finish);
	const host = serve.tsNow?.host;
	const url = access === "tailscale" && host ? `https://${host}${a.tailscale_https_port === 443 ? "" : `:${a.tailscale_https_port}`}/` : `http://127.0.0.1:${a.web_port}/`;
	return { ok: true, access, url, why, owner };
}
