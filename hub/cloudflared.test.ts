import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTunnel, stopTunnel, tunnelStatus } from "./cloudflared.ts";
import { advance, flush } from "./runtime/test-clock.ts";

const TOKEN = "tunnel-secret-0123456789";
const dir = mkdtempSync(join(tmpdir(), "dotz-cf-"));
const tokenFile = join(dir, "token");
writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
const login = { team: "acme", aud: "aud-tag", allow: ["owner@example.com"] };

function fakeSpawn() {
	const runs: { argv: string[]; env?: Record<string, string | undefined>; exit: (code: number) => void; killed: boolean }[] = [];
	const spawn = ((argv: string[], o?: { env?: Record<string, string | undefined> }) => {
		let exit!: (code: number) => void;
		const exited = new Promise<number>(r => (exit = r));
		const run = { argv, env: o?.env, exit, killed: false };
		runs.push(run);
		return { exited, stderr: undefined, kill: () => ((run.killed = true), exit(143)) };
	}) as unknown as typeof Bun.spawn;
	return { runs, spawn };
}

afterEach(() => stopTunnel());

test("without Cloudflare Access settings the tunnel is not started", () => {
	for (const bad of [{ ...login, team: "" }, { ...login, aud: " " }, { ...login, allow: [] }]) {
		const f = fakeSpawn();
		startTunnel({ tokenFile, login: bad, bin: "/bin/cloudflared", spawn: f.spawn });
		expect(f.runs).toEqual([]);
		expect(tunnelStatus().state).toBe("error");
	}
});

test("the token is read by cloudflared from its file, never passed on argv or env; an exit restarts it and stop kills it", async () => {
	const f = fakeSpawn();
	startTunnel({ tokenFile, login, bin: "/bin/cloudflared", spawn: f.spawn });
	expect(f.runs).toHaveLength(1);
	expect(f.runs[0]!.argv).toEqual(["/bin/cloudflared", "tunnel", "--no-autoupdate", "run", "--token-file", tokenFile]);
	expect(JSON.stringify(f.runs[0])).not.toContain(TOKEN);
	expect(tunnelStatus().state).toBe("running");
	f.runs[0]!.exit(1);
	await flush();
	expect(tunnelStatus().state).toBe("error");
	await advance(2_000);
	expect(f.runs).toHaveLength(2);
	await stopTunnel();
	expect(f.runs[1]!.killed).toBe(true);
	expect(tunnelStatus().state).toBe("off");
});
