// A completed, isolated dotz install for the load-qa runs: config.json with web access "local", no Discord, push, peers,
// tunnel or self-update, zele on (served by the fake shim), the first-run marker closed, and a fake subscription login in the
// fake HOME so the model-call readiness check (hub/model-runner.ts) passes. Only generated fake values.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type InstallOpts = {
	port: number;
	/** The zele mail accounts (addresses); the fake zele serves their mail. */
	accounts: string[];
	scale: "small" | "large";
	/** The fake HOME of the run; default <dirname(dataDir)>/home (the layout of sandbox.ts launch()). */
	home?: string;
};

export function writeInstall(dataDir: string, o: InstallOpts): void {
	if (!/^\/(private\/)?tmp\/load-qa\//.test(dataDir)) throw new Error(`refused: a load-qa install must live under /tmp/load-qa, got ${dataDir}`);
	const home = o.home ?? join(dirname(dataDir), "home");
	const config = {
		identity: { name: "dotz", language: "ko", timezone: "Asia/Seoul", address: "" },
		runtime: "omo",
		discord: { token_file: "secrets/discord-bot-token", owner_id: "", guild: "" },
		web: { port: o.port, tailscale_https_port: 0, allow_logins: [], access: "local", machine_name: "load-qa", peers: [], peer_discovery: false },
		lanes: { nightly_at: "off" },
		zele: { enabled: true, poll_sec: 60 },
		self_update: { auto_check: false, auto_apply: false },
		omp_update: { mode: "off" },
		token_audit_at: "off",
		reflect_at: "off",
		load_qa: { scale: o.scale },
	};
	mkdirSync(join(dataDir, "onboarding"), { recursive: true });
	// seed.ts writes mail.keep / mail.own_addresses into config.json: whichever of seed and install runs second keeps the other's `mail` section.
	const file = join(dataDir, "config.json");
	const prior = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { mail?: unknown }) : {};
	writeFileSync(file, `${JSON.stringify({ ...config, ...(prior.mail ? { mail: prior.mail } : {}) }, null, 2)}\n`);
	const done = { status: "done", token_sha256: "", token_expires_at: 0, cookie_sha256: "", step: "done", draft: {}, intro: "seen" };
	writeFileSync(join(dataDir, "onboarding", "first-run.json"), `${JSON.stringify(done, null, 2)}\n`, { mode: 0o600 });
	const agent = join(home, ".omo", "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "auth.json"), `${JSON.stringify({ "anthropic-subscription": { accounts: [{ name: "load-qa", access: "fake-token-not-a-secret" }] } }, null, 2)}\n`);
	const mailFile = join(dirname(dataDir), "zele-mail.json");
	if (!existsSync(mailFile)) writeFileSync(mailFile, `${JSON.stringify({ accounts: o.accounts, mails: [], events: [] })}\n`);
}

/** The one-time browser login URL of a running install (web.access "local"): open it once in the browser, it sets the session cookie and lands on /. */
export async function loginLink(dataDir: string, port: number): Promise<string> {
	const token = readFileSync(join(dataDir, "secrets", "hub-token"), "utf8").trim();
	const res = await fetch(`http://127.0.0.1:${port}/api/web-access/login-link`, { method: "POST", headers: { "x-dotz-token": token } });
	if (!res.ok) throw new Error(`login link refused: ${res.status}`);
	return ((await res.json()) as { url: string }).url;
}
