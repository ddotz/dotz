// One-shot webmail watch: the gateway runs it every poll_minutes. It makes one conditional request, prints one line per new
// mail (the orchestrator opens a thread per line) and nothing when the inbox is unchanged, so an idle inbox costs no tokens.
// Logout is recovered once with a silent background tab load, then reported to the owner; `DOTZ_FAIL webmail-login` /
// `DOTZ_FAIL network` make the gateway raise it as an issue. State lives in the per-watch dir the gateway sets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadSpec, liveCtx } from "../lib/config.ts";
import { cookieHeaderFromAside } from "../lib/cookies.ts";
import { endpointUrl } from "../lib/spec.ts";
import { initialState, pollOnce, type WatchState } from "../lib/watchkit.ts";

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

async function main(): Promise<number> {
	const spec = loadSpec(SITE);
	const config = loadConfig(SITE);
	if (!spec || !config) {
		console.log("DOTZ_FAIL setup");
		console.log(`webmail site "${SITE}" is not set up (no spec.json/config.json)`);
		return 1;
	}
	const ctx = liveCtx(cookieHeaderFromAside);
	const f = stateFile();
	const state = loadState(f);
	const recover = () => recoverViaAside(spec.origin);
	const res = await pollOnce(ctx, spec, config, state, recover);
	saveState(f, res.state);
	for (const line of res.lines) console.log(line);
	ctx.log(`watch ${SITE}: ${res.note} (${endpointUrl(spec.origin, spec.list, { mailbox: spec.list.mailbox })})`);
	if (res.fail) {
		console.log(res.fail);
		return 1;
	}
	return 0;
}

if (import.meta.main) main().then((code) => process.exit(code));
