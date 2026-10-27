// One-shot webmail watch: the gateway runs it every poll_minutes. It makes one conditional request, posts each new mail to the
// gateway (POST /api/mail: its own thread and web conversation, one orchestrator turn), prints a line only for a mail the
// gateway did not take (the orchestrator then opens the thread itself) and nothing when the inbox is unchanged, so an idle inbox costs no tokens.
// Logout is recovered once with a silent background tab load, then reported to the owner; `DOTZ_FAIL webmail-login` /
// `DOTZ_FAIL network` make the gateway raise it as an issue. State lives in the per-watch dir the gateway sets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadSpec, liveCtx, paths, writeJson } from "../lib/config.ts";
import { cookieHeaderFromAside } from "../lib/cookies.ts";
import { endpointUrl } from "../lib/spec.ts";
import { liveGateway } from "../lib/gateway.ts";
import { initialState, pollOnce, postToGateway, type WatchState } from "../lib/watchkit.ts";
import { describeMail } from "../lib/adapter.ts";
import { loginViaRepl } from "../lib/login.ts";
import { loadOnboard } from "../lib/onboard.ts";

const SITE = process.env.WEBMAIL_SITE ?? process.argv[2] ?? "";

function stateFile(): string {
	const dir = process.env.DOTZ_WATCH_STATE_DIR ?? "/tmp/webmail-watch";
	mkdirSync(dir, { recursive: true });
	return join(dir, "state.json");
}
const loadState = (f: string): WatchState => (existsSync(f) ? { ...initialState(), ...JSON.parse(readFileSync(f, "utf8")) } : initialState());
const saveState = (f: string, s: WatchState) => writeFileSync(f, `${JSON.stringify(s)}\n`, { mode: 0o600 });

// A single safe recovery attempt: load the site's origin in a background Aside tab (never focused, closed at once). This
// renews a soft-expired session from refresh cookies without sending any second factor; a hard logout stays logged out and
// is reported to the owner.
async function recoverViaAside(origin: string): Promise<boolean> {
	const code = `const t = await openTab(${JSON.stringify(origin)}); await new Promise(r => setTimeout(r, 2500)); await closeTab(t); console.log('WEBMAIL_RECOVER_DONE');`;
	const proc = Bun.spawn(["aside", "repl", code], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(9), 30_000);
	const out = await new Response(proc.stdout).text().catch(() => "");
	await proc.exited;
	clearTimeout(timer);
	return out.includes("WEBMAIL_RECOVER_DONE");
}

// The full sign-in the owner approved (DOTZ_APPROVED=1 from the gateway's approval gate): the onboarding login in a background tab with
// the browser's saved password, waiting for the second factor (a push he approves on his phone). One yes is one attempt, so
// DOTZ_APPROVAL_USED is printed before it starts; 다시 연결 pressed again while it waits makes the gateway cancel this run and start over.
async function signInApproved(url: string): Promise<boolean> {
	console.log("DOTZ_APPROVAL_USED");
	const repl = async (code: string, ms: number) => {
		const proc = Bun.spawn(["aside", "repl", code], { stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill(9), ms);
		const out = await new Response(proc.stdout).text().catch(() => "");
		await proc.exited;
		clearTimeout(timer);
		return out;
	};
	return (await loginViaRepl(repl, url, true)) === "in";
}

async function main(): Promise<number> {
	const spec = loadSpec(SITE);
	const config = loadConfig(SITE);
	if (!spec || !config) {
		console.log("DOTZ_FAIL setup");
		console.log(`"${SITE}" 메일은 아직 연결 전이에요 (onboard.ts로 연결하면 생겨요)`);
		return 1;
	}
	const ctx = liveCtx(cookieHeaderFromAside);
	const f = stateFile();
	const state = loadState(f);
	const recover = () => recoverViaAside(spec.origin);
	const approved = process.env.DOTZ_APPROVED === "1";
	const res = await pollOnce(ctx, spec, config, state, recover, approved ? () => signInApproved(loadOnboard(SITE)?.url ?? spec.origin) : undefined);
	saveState(f, res.state);
	const newCount = res.mails.length;
	writeJson(paths.status(SITE), { lastRun: new Date(ctx.now()).toISOString(), lastOk: res.state.lastOk, loggedOut: res.state.loggedOut, failing: res.fail ?? null, ...(newCount ? { lastNewAt: new Date(ctx.now()).toISOString(), lastNewCount: newCount } : {}) }, 0o644);
	for (const line of await postToGateway(liveGateway, SITE, res, ctx.log, (m) => describeMail(ctx, spec, m.id))) console.log(line);
	ctx.log(`watch ${SITE}: ${res.note} (${endpointUrl(spec.origin, spec.list, { mailbox: spec.list.mailbox })})`);
	if (res.fail) {
		console.log(res.fail);
		return 1;
	}
	return 0;
}

if (import.meta.main) main().then((code) => process.exit(code));
