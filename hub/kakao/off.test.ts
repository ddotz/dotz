// Off by default: on a fresh data dir nothing but setup does anything, and nothing touches the runner or the gateway.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ctx, run } from "./cli.ts";
import { OFF_LINE } from "./onboard.ts";
import { kakaoPaths } from "./types.ts";

function fresh() {
	const root = mkdtempSync(join(tmpdir(), "kk-off-"));
	const log = { runs: [] as string[][], hub: [] as string[], out: [] as string[], spawned: [] as string[][] };
	const boom = async () => {
		throw new Error("must not be called");
	};
	const ctx: Ctx = {
		paths: kakaoPaths(join(root, "data"), join(root, "home")),
		runner: async argv => {
			log.runs.push(argv);
			return { code: 0, stdout: "", stderr: "" };
		},
		hub: {
			post: async path => (log.hub.push(`POST ${path}`), { status: 200, json: {} }),
			get: async path => (log.hub.push(`GET ${path}`), { status: 200, json: [] }),
			patch: async path => (log.hub.push(`PATCH ${path}`), { status: 200, json: {} }),
			del: async path => (log.hub.push(`DELETE ${path}`), { status: 200, json: {} }),
		},
		ports: {
			hasKmsg: boom as any,
			appInstalled: boom,
			accessibilityGranted: boom,
			hasCredentials: boom,
			importAuthFile: boom,
			clearCredentials: boom,
			login: boom,
			resumeAfterConfirm: boom,
			derive: boom,
			readCounts: boom,
		},
		out: line => log.out.push(line),
		stdin: boom as any,
		repo: join(import.meta.dir, "..", ".."),
		execPath: "/fake/bin/bun",
		brew: "brew",
		spawnSetup: args => log.spawned.push(args),
		reader: boom as any,
		drafts: boom as any,
		sleep: async () => {},
		now: () => 0,
		pid: 1,
		isAlive: () => false,
	};
	return { ctx, log };
}

test("a fresh data dir: status says off and exits 0, touching nothing", async () => {
	const { ctx, log } = fresh();
	expect(await run(["status"], ctx)).toBe(0);
	expect(log.out).toEqual([OFF_LINE]);
	expect(await run(["status", "--json"], ctx)).toBe(0);
	expect(JSON.parse(log.out[1]!)).toEqual({ 연결: "꺼짐" });
	expect(log.runs).toEqual([]);
	expect(log.hub).toEqual([]);
});

test("login, read, draft and send refuse with the off line and make zero runner or gateway calls", async () => {
	const { ctx, log } = fresh();
	for (const argv of [["login"], ["read", "--chat", "1"], ["draft", "--chat", "1"], ["send", "--draft", "KABCDE"]]) expect(await run(argv, ctx)).toBe(1);
	expect(log.out).toEqual(Array(4).fill(OFF_LINE));
	expect(log.runs).toEqual([]);
	expect(log.hub).toEqual([]);
	expect(log.runs.filter(a => ["osascript", "open", "/bin/ls"].includes(a[0]!))).toEqual([]);
});

test("off on a fresh data dir changes nothing and registers no watch", async () => {
	const { ctx, log } = fresh();
	expect(await run(["off"], ctx)).toBe(0);
	expect(log.hub).toEqual([]);
	expect(log.runs).toEqual([]);
});
