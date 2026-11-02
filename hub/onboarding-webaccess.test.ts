import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOnboarding, type OnboardDeps, onboardingRoute, type OnboardView } from "./onboarding.ts";

const TOKEN = "cfTUNNELtoken0123456789abcdefABCDEF0123456789";

type ExecResult = { code: number; out: string };
type FakeExec = { calls: string[][]; exec: (argv: string[]) => Promise<ExecResult>; execLines?: (argv: string[], onLine: (line: string) => void) => Promise<ExecResult> };
type FakeBrowser = { calls: { action: string; arg?: Record<string, unknown> }[]; run: (action: string, arg?: Record<string, unknown>) => Promise<{ ok: boolean; value?: string; waiting?: string }> };

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
};

function execOf(table: Record<string, ExecResult | ExecResult[]>, calls: string[][] = []): FakeExec {
	const queues = new Map<string, ExecResult[]>();
	const one = async (argv: string[]): Promise<ExecResult> => {
		calls.push(argv);
		const key = argv.join(" ");
		const hit = table[key];
		if (!hit) return { code: 1, out: `command not found: ${key}` };
		if (Array.isArray(hit)) {
			const queue = queues.get(key) ?? [...hit];
			queues.set(key, queue);
			return queue.length > 1 ? queue.shift()! : queue[0]!;
		}
		return hit;
	};
	return { calls, exec: one };
}

function browserOf(queue: Record<string, { ok: boolean; value?: string; waiting?: string }[]> = {}): FakeBrowser {
	const calls: FakeBrowser["calls"] = [];
	return {
		calls,
		async run(action, arg) {
			calls.push({ action, ...(arg ? { arg } : {}) });
			return queue[action]?.shift() ?? { ok: false };
		},
	};
}

const tunnel = (name = "dotz") => JSON.stringify([{ id: "t-1", name, created_at: "2026-01-01" }]);
const table = (extra: Record<string, ExecResult | ExecResult[]> = {}): Record<string, ExecResult | ExecResult[]> => ({
	"which cloudflared": { code: 0, out: "/opt/homebrew/bin/cloudflared\n" },
	"cloudflared tunnel list --output json": { code: 0, out: tunnel() },
	"cloudflared tunnel route dns dotz dotz.example.com": { code: 0, out: "Added CNAME dotz.example.com" },
	"cloudflared tunnel token dotz": { code: 0, out: `${TOKEN}\n` },
	"cloudflared tunnel info dotz": { code: 0, out: "NAME: dotz\nID: t-1\nCONNECTIONS: 1\n" },
	...extra,
});

function cert(home: string): void {
	mkdirSync(join(home, ".cloudflared"), { recursive: true });
	writeFileSync(join(home, ".cloudflared", "cert.pem"), "cert\n", { mode: 0o600 });
	chmodSync(join(home, ".cloudflared", "cert.pem"), 0o600);
}

async function runStart(svc: ReturnType<typeof createOnboarding>): Promise<OnboardView> {
	svc.start("web-access");
	await svc.idle("web-access");
	return svc.view("web-access");
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(path));
		else out.push(path);
	}
	return out;
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("web access onboarding", () => {
	test("cloudflare: reuses the dotz tunnel, stores the token only at secrets/cloudflared-tunnel-token 0600, and returns the URL", async () => {
		const dir = tempDir("wa-dir-");
		const home = tempDir("wa-home-");
		cert(home);
		const fakeExec = execOf(table());
		const fakeBrowser = browserOf({ "cloudflare-zone": [{ ok: true, value: "example.com" }] });
		const applied: { mode: string; hostname?: string; token?: string }[] = [];
		const tokenFile = join(dir, "secrets", "cloudflared-tunnel-token");
		let atApply: { mode: number; token: string } | undefined;
		const deps: OnboardDeps = {
			dir,
			fetch: (async () => {
				throw new Error("no network in this test");
			}) as typeof fetch,
			browser: fakeBrowser,
			exec: fakeExec.exec,
			restart: async () => {},
			home,
			applyWebAccess: async input => {
				applied.push(input);
				atApply = { mode: statSync(tokenFile).mode & 0o777, token: readFileSync(tokenFile, "utf8").trim() };
			},
		};
		const svc = createOnboarding(deps);
		const view = await runStart(svc);

		expect(view.state).toBe("done");
		expect(view.url).toBe("https://dotz.example.com");
		expect(view.owner).toBeNull();
		expect(applied).toEqual([{ mode: "cloudflare", hostname: "dotz.example.com", token: TOKEN }]);
		expect(atApply).toEqual({ mode: 0o600, token: TOKEN });
		expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
		expect(readFileSync(tokenFile, "utf8").trim()).toBe(TOKEN);
		expect(fakeExec.calls).toEqual([
			["which", "cloudflared"],
			["cloudflared", "tunnel", "list", "--output", "json"],
			["cloudflared", "tunnel", "route", "dns", "dotz", "dotz.example.com"],
			["cloudflared", "tunnel", "token", "dotz"],
			["cloudflared", "tunnel", "info", "dotz"],
		]);
		expect(fakeBrowser.calls.map(c => c.action)).toEqual(["cloudflare-zone"]);
		const state = join(dir, "onboarding", "web-access.json");
		expect(statSync(state).mode & 0o777).toBe(0o600);
		expect(readFileSync(state, "utf8")).not.toContain(TOKEN);
		expect(JSON.stringify(view)).not.toContain(TOKEN);
		for (const file of walk(dir)) {
			if (file === tokenFile) continue;
			expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
		}
		expect(readFileSync(state, "utf8")).toContain('"attempt": 0');
		const route = await onboardingRoute(new Request("http://hub/api/onboarding/web-access"), new URL("http://hub/api/onboarding/web-access"), svc);
		expect(route!.status).toBe(200);
		expect(await route!.json()).toMatchObject({ key: "web-access", state: "done", url: "https://dotz.example.com" });
		const local = svc.markDone("web-access");
		expect(local).toMatchObject({ key: "web-access", state: "done", owner: null, url: null });
	});

	test("login: one owner step opens the Cloudflare URL, and continue finishes once cert.pem exists", async () => {
		const dir = tempDir("wa-dir-");
		const home = tempDir("wa-home-");
		const loginUrl = "https://dash.cloudflare.com/argotunnel?callback=abc123secret";
		const fakeExec = execOf(table({ "cloudflared tunnel login": { code: 0, out: `Please open ${loginUrl} in a browser` } }));
		const fakeBrowser = browserOf({ "cloudflare-zone": [{ ok: true, value: "example.com" }] });
		const applied: { mode: string; hostname?: string; token?: string }[] = [];
		const svc = createOnboarding({
			dir,
			fetch: (async () => {
				throw new Error("no network in this test");
			}) as typeof fetch,
			browser: fakeBrowser,
			exec: fakeExec.exec,
			restart: async () => {},
			home,
			applyWebAccess: async input => {
				applied.push(input);
			},
		});

		const waiting = await runStart(svc);
		expect(waiting.state).toBe("waiting");
		expect(waiting.step?.id).toBe("login");
		expect(waiting.owner?.label).toBe("Cloudflare 승인");
		expect(fakeBrowser.calls).toEqual([{ action: "cloudflare-login", arg: { url: loginUrl } }]);
		expect(existsSync(join(dir, "secrets", "cloudflared-tunnel-token"))).toBe(false);
		expect(readFileSync(join(dir, "onboarding", "web-access.json"), "utf8")).not.toContain("argotunnel");

		cert(home);
		svc.continue("web-access");
		await svc.idle("web-access");
		const done = svc.view("web-access");
		expect(done.state).toBe("done");
		expect(done.url).toBe("https://dotz.example.com");
		expect(applied).toEqual([{ mode: "cloudflare", hostname: "dotz.example.com", token: TOKEN }]);
		expect(fakeBrowser.calls.map(c => c.action)).toEqual(["cloudflare-login", "cloudflare-zone"]);
	});

	test("a missing cloudflared whose install fails leaves exactly one owner step and writes nothing", async () => {
		const dir = tempDir("wa-dir-");
		const home = tempDir("wa-home-");
		const fakeExec = execOf({
			"which cloudflared": { code: 1, out: "" },
			"brew install cloudflared": { code: 1, out: "Error: homebrew is not installed" },
		});
		const view = await runStart(
			createOnboarding({
				dir,
				fetch: (async () => {
					throw new Error("no network in this test");
				}) as typeof fetch,
				browser: browserOf(),
				exec: fakeExec.exec,
				restart: async () => {},
				home,
				applyWebAccess: async () => {},
			}),
		);

		expect(view.state).toBe("failed");
		expect(view.step?.id).toBe("cloudflared");
		expect(view.owner).not.toBeNull();
		expect(Object.keys(view.owner!).sort()).toEqual(["hint", "label"]);
		expect(view.owner!.hint.length).toBeGreaterThan(0);
		expect(view.error).toContain("cloudflared");
		expect(fakeExec.calls).toEqual([
			["which", "cloudflared"],
			["brew", "install", "cloudflared"],
			["which", "cloudflared"],
		]);
		expect(existsSync(join(dir, "secrets"))).toBe(false);
	});

	test("a missing applyWebAccess fails with a clear Korean line and no token in the view or the state file", async () => {
		const dir = tempDir("wa-dir-");
		const home = tempDir("wa-home-");
		cert(home);
		const deps: OnboardDeps = {
			dir,
			fetch: (async () => {
				throw new Error("no network in this test");
			}) as typeof fetch,
			browser: browserOf({ "cloudflare-zone": [{ ok: true, value: "example.com" }] }),
			exec: execOf(table()).exec,
			restart: async () => {},
			home,
		};
		const view = await runStart(createOnboarding(deps));
		expect(view.state).toBe("failed");
		expect(view.step?.id).toBe("token");
		expect(view.error).toContain("웹 접속");
		expect(view.owner).not.toBeNull();
		expect(JSON.stringify(view)).not.toContain(TOKEN);
		expect(readFileSync(join(dir, "onboarding", "web-access.json"), "utf8")).not.toContain(TOKEN);
		expect(readFileSync(join(dir, "secrets", "cloudflared-tunnel-token"), "utf8").trim()).toBe(TOKEN);
	});

	test("a saved hostname is reused instead of asking the dashboard", async () => {
		const dir = tempDir("wa-dir-");
		const home = tempDir("wa-home-");
		cert(home);
		writeFileSync(join(dir, "web-access.json"), `${JSON.stringify({ mode: "cloudflare", hostname: "dotz.saved.test" })}\n`, { mode: 0o600 });
		const fakeExec = execOf(table({ "cloudflared tunnel route dns dotz dotz.saved.test": { code: 0, out: "ok" } }));
		const fakeBrowser = browserOf();
		const applied: { mode: string; hostname?: string; token?: string }[] = [];
		const svc = createOnboarding({
			dir,
			fetch: (async () => {
				throw new Error("no network in this test");
			}) as typeof fetch,
			browser: fakeBrowser,
			exec: fakeExec.exec,
			restart: async () => {},
			home,
			applyWebAccess: async input => {
				applied.push(input);
			},
		});
		const view = await runStart(svc);
		expect(view.state).toBe("done");
		expect(view.url).toBe("https://dotz.saved.test");
		expect(fakeBrowser.calls).toEqual([]);
		expect(applied[0]!.hostname).toBe("dotz.saved.test");
	});
});
