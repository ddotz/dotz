// One look at this computer for the web onboarding's first screen (and nothing else): what is installed and signed in, so a step that is
// already ready is skipped (owner rule 11-02). Read-only; never asks for credentials.
import { asideState } from "./aside.ts";
import { detectHarnesses, loginState } from "./harness.ts";
import { tailscaleState } from "./tailscale.ts";

const MAC = process.platform === "darwin";

/** Accounts zele is signed in with; none when zele is missing. */
export async function zeleAccounts(): Promise<string[]> {
	if (!Bun.which("zele")) return [];
	const out = (await Bun.$`zele whoami`.nothrow().quiet()).stdout.toString();
	return /not authenticated/i.test(out) ? [] : [...new Set(out.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])];
}

export async function scanMachine() {
	const [found, aside, ts, zele] = await Promise.all([detectHarnesses(), asideState(), tailscaleState(), zeleAccounts()]);
	const harnesses = await Promise.all(
		found.map(async d => {
			const login = await loginState(d);
			return { id: d.id, label: d.label, adapter: d.adapter, installed: d.found.installed, version: d.found.version ?? "", login_checked: login.checked, login_ready: login.ready, accounts: login.accounts };
		}),
	);
	const tailscale = { installed: Boolean(ts.bin), running: ts.running, login: ts.login, host: ts.host };
	return {
		mac: MAC,
		brew: Boolean(Bun.which("brew")),
		harnesses,
		aside: { app: aside.app, cli: Boolean(aside.cli), signed_in: aside.signedIn, account: aside.account },
		tailscale,
		zele: { installed: Boolean(Bun.which("zele")), accounts: zele },
		ready: {
			"install-omo": harnesses.some(h => h.id === "omo" && h.installed),
			"aside-app": !MAC || aside.app,
			"aside-cli": !MAC || Boolean(aside.cli),
			tailscale: tailscale.installed,
			"tailscale-start": tailscale.running,
			zele: Boolean(Bun.which("zele")),
		},
	};
}

export type Scan = Awaited<ReturnType<typeof scanMachine>>;
